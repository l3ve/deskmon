//! Tauri hotkey callbacks and pasteboard ownership are coordinated on the main thread.

use core_graphics::{
    event::{CGEvent, CGEventFlags},
    event_source::{CGEventSource, CGEventSourceStateID},
};
use objc2::{runtime::NSObjectProtocol, sel, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationOptions, NSPasteboard, NSPasteboardTypeString,
    NSRunningApplication, NSWorkspace,
};
use objc2_foundation::NSString;
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const V_KEY: u32 = 9; // kVK_ANSI_V
const PASTE_INTERVAL: Duration = Duration::from_millis(200);
const SESSION_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, PartialEq)]
enum PasteShortcutAction {
    Deliver,
    Forward,
    Ignore,
}

fn paste_shortcut_action(
    active: Option<u32>,
    incoming: u32,
    state: ShortcutState,
) -> PasteShortcutAction {
    if state != ShortcutState::Pressed {
        return PasteShortcutAction::Ignore;
    }
    match active {
        Some(id) if id == incoming => PasteShortcutAction::Deliver,
        Some(_) => PasteShortcutAction::Ignore,
        None => PasteShortcutAction::Forward,
    }
}

#[cfg(test)]
mod shortcut_tests {
    use super::*;
    use tauri_plugin_global_shortcut::ShortcutState::{Pressed, Released};

    #[test]
    fn paste_key_consumes_only_current_session_pressed_events() {
        assert_eq!(
            paste_shortcut_action(Some(2), 2, Pressed),
            PasteShortcutAction::Deliver
        );
        assert_eq!(
            paste_shortcut_action(Some(2), 1, Pressed),
            PasteShortcutAction::Ignore
        );
        assert_eq!(
            paste_shortcut_action(Some(2), 2, Released),
            PasteShortcutAction::Ignore
        );
        assert_eq!(
            paste_shortcut_action(None, 2, Pressed),
            PasteShortcutAction::Forward
        );
        assert_eq!(
            paste_shortcut_action(None, 2, Released),
            PasteShortcutAction::Ignore
        );
    }
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightPostEventAccess() -> bool;
    fn CGRequestPostEventAccess() -> bool;
}

thread_local! {
    static SESSION: RefCell<Option<PasteSession>> = const { RefCell::new(None) };
    static RETURN_APP: Cell<Option<i32>> = const { Cell::new(None) };
    static NEXT_SESSION_ID: Cell<u32> = const { Cell::new(0) };
}

struct PasteSession {
    chain_id: String,
    id: u32,
    hotkey: tauri_plugin_global_shortcut::Shortcut,
    app: AppHandle,
    values: VecDeque<String>,
    pending_pastes: VecDeque<i32>,
    clipboard_revision: isize,
    delivering: bool,
    expires_at: Instant,
}

impl Drop for PasteSession {
    fn drop(&mut self) {
        // The retained pasteboard revision also covers a user copying the same text.
        let board = NSPasteboard::generalPasteboard();
        self.clear_owned_clipboard(&board);
        if let Err(error) = self.app.global_shortcut().unregister(self.hotkey) {
            eprintln!("failed to release memory-chain shortcut: {error}");
        }
    }
}

impl PasteSession {
    fn clear_owned_clipboard(&mut self, board: &NSPasteboard) {
        if self.delivering && board.changeCount() == self.clipboard_revision {
            self.clipboard_revision = board.clearContents();
        }
        self.delivering = false;
    }

    fn clipboard_changed(&self, board: &NSPasteboard) -> bool {
        board.changeCount() != self.clipboard_revision
    }
}

pub fn remember_foreground_app() {
    if let Some(pid) = foreground_pid().filter(|pid| *pid != std::process::id() as i32) {
        RETURN_APP.set(Some(pid));
    }
}

pub fn restore_foreground_app() {
    let pid = RETURN_APP.take();
    if foreground_pid() != Some(std::process::id() as i32) {
        return;
    }
    if let Some(app) = pid.and_then(NSRunningApplication::runningApplicationWithProcessIdentifier) {
        if let Some(mtm) = MainThreadMarker::new() {
            let current = NSApplication::sharedApplication(mtm);
            if current.respondsToSelector(sel!(yieldActivationToApplication:)) {
                current.yieldActivationToApplication(&app);
                app.activateFromApplication_options(
                    &NSRunningApplication::currentApplication(),
                    NSApplicationActivationOptions::empty(),
                );
                return;
            }
        }
        #[allow(deprecated)]
        app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
    }
}

pub fn start(app: AppHandle, chain_id: String, values: Vec<String>) -> Result<(), String> {
    if !unsafe { CGPreflightPostEventAccess() } && !unsafe { CGRequestPostEventAccess() } {
        return Err(
            "请在系统设置 → 隐私与安全性 → 辅助功能中允许 Deskmon，然后重新选择记忆链。".into(),
        );
    }

    cancel(None);
    let id = NEXT_SESSION_ID.with(|next| {
        let id = next.get().wrapping_add(1);
        next.set(id);
        id
    });
    let hotkey = register_hotkey(&app, id)?;
    SESSION.with_borrow_mut(|session| {
        *session = Some(PasteSession {
            chain_id,
            id,
            hotkey,
            app,
            values: values.into(),
            pending_pastes: VecDeque::new(),
            clipboard_revision: NSPasteboard::generalPasteboard().changeCount(),
            delivering: false,
            expires_at: Instant::now() + SESSION_TIMEOUT,
        });
    });
    Ok(())
}

pub fn cancel(chain_id: Option<&str>) {
    SESSION.with_borrow_mut(|session| {
        if session
            .as_ref()
            .is_some_and(|active| chain_id.is_none_or(|id| id == active.chain_id))
        {
            *session = None;
        }
    });
}

/// Check for external copies before the history recorder reads the general pasteboard.
pub fn poll_clipboard(board: &NSPasteboard) -> bool {
    SESSION.with_borrow_mut(|session| {
        if session.as_ref().is_some_and(|active| {
            active.clipboard_changed(board) || Instant::now() >= active.expires_at
        }) {
            *session = None;
        }
        session.as_ref().is_some_and(|active| active.delivering)
    })
}

fn foreground_pid() -> Option<i32> {
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|app| app.processIdentifier())
}

fn register_hotkey(
    app: &AppHandle,
    id: u32,
) -> Result<tauri_plugin_global_shortcut::Shortcut, String> {
    let hotkey = crate::global_shortcuts::registration_shortcut("Super+KeyV".parse().unwrap())?;
    app.global_shortcut()
        .on_shortcut(hotkey, move |app, _, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let app = app.clone();
            let _ = app.run_on_main_thread(move || {
                let active =
                    SESSION.with_borrow(|session| session.as_ref().map(|active| active.id));
                match paste_shortcut_action(active, id, event.state) {
                    PasteShortcutAction::Deliver | PasteShortcutAction::Forward => {
                        if let Some(pid) = foreground_pid() {
                            receive_paste(id, pid);
                        }
                    }
                    PasteShortcutAction::Ignore => {}
                }
            });
        })
        .map_err(|error| format!("无法启用记忆链的 ⌘V，请检查快捷键冲突：{error}"))?;
    Ok(hotkey)
}

fn receive_paste(id: u32, pid: i32) {
    let board = NSPasteboard::generalPasteboard();
    let Some(delivery) = paste_events() else {
        return;
    };
    SESSION.with_borrow_mut(|session| {
        let Some(active) = session.as_mut().filter(|active| active.id == id) else {
            // The OS may already have queued a hotkey event when the session ended.
            post_paste(&delivery, pid);
            return;
        };
        if active.clipboard_changed(&board) || Instant::now() >= active.expires_at {
            *session = None;
            post_paste(&delivery, pid);
            return;
        }

        if active.delivering {
            if active.pending_pastes.len() <= active.values.len() {
                active.pending_pastes.push_back(pid);
            }
            return;
        }

        let Some(value) = active.values.pop_front() else {
            *session = None;
            post_paste(&delivery, pid);
            return;
        };
        // Mark the write before any later history poll and retain only our own change count.
        active.clipboard_revision = board.clearContents();
        active.delivering = true;
        if !board.setString_forType(&NSString::from_str(&value), unsafe {
            NSPasteboardTypeString
        }) {
            *session = None;
            return;
        }
        active.clipboard_revision = board.changeCount();
        active.expires_at = Instant::now() + SESSION_TIMEOUT;
        post_paste(&delivery, pid);

        // CGEvent delivery is asynchronous. Give the target time to read this item
        // before clearing it or serving another key press.
        let app = active.app.clone();
        thread::spawn(move || {
            thread::sleep(PASTE_INTERVAL);
            let _ = app.run_on_main_thread(move || finish_paste(id));
        });
    });
}

fn finish_paste(id: u32) {
    let board = NSPasteboard::generalPasteboard();
    let (next, ordinary) = SESSION.with_borrow_mut(|session| {
        let Some(active) = session.as_mut().filter(|active| active.id == id) else {
            return (None, None);
        };
        let foreground = foreground_pid();
        let next = active
            .pending_pastes
            .drain(..)
            .filter(|pid| Some(*pid) == foreground)
            .collect::<VecDeque<_>>();
        let external_copy = active.clipboard_changed(&board);
        active.clear_owned_clipboard(&board);
        if external_copy || active.values.is_empty() {
            *session = None;
            return (None, next.front().copied());
        }
        let mut remaining = next;
        let first = remaining.pop_front();
        active.pending_pastes = remaining;
        (first, None)
    });
    if let Some(pid) = next {
        receive_paste(id, pid);
    } else if let Some((pid, events)) = ordinary.zip(paste_events()) {
        post_paste(&events, pid);
    }
}

fn paste_events() -> Option<[CGEvent; 2]> {
    let source = CGEventSource::new(CGEventSourceStateID::Private).ok()?;
    let down = CGEvent::new_keyboard_event(source.clone(), V_KEY as u16, true).ok()?;
    let up = CGEvent::new_keyboard_event(source, V_KEY as u16, false).ok()?;
    Some([down, up])
}

fn post_paste(events: &[CGEvent; 2], pid: i32) {
    for event in events {
        event.set_flags(CGEventFlags::CGEventFlagCommand);
        event.post_to_pid(pid);
    }
}

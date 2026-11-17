//! The Carbon hotkey and the general pasteboard are coordinated on the main thread.

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
    ffi::c_void,
    mem::size_of,
    ptr::{null_mut, NonNull},
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;

const V_KEY: u32 = 9; // kVK_ANSI_V
const COMMAND_KEY: u32 = 1 << 8;
const HOTKEY_EXCLUSIVE: u32 = 1;
const HOTKEY_SIGNATURE: u32 = u32::from_be_bytes(*b"DmCH");
const KEYBOARD_EVENT: u32 = u32::from_be_bytes(*b"keyb");
const HOTKEY_PRESSED: u32 = 5;
const DIRECT_OBJECT: u32 = u32::from_be_bytes(*b"----");
const HOTKEY_ID_TYPE: u32 = u32::from_be_bytes(*b"hkid");
const EVENT_NOT_HANDLED: i32 = -9874;
const PASTE_INTERVAL: Duration = Duration::from_millis(200);
const SESSION_TIMEOUT: Duration = Duration::from_secs(5 * 60);

type EventRef = *mut c_void;
type EventHandlerRef = *mut c_void;
type EventTargetRef = *mut c_void;
type EventHotKeyRef = *mut c_void;

#[repr(C)]
struct EventTypeSpec {
    event_class: u32,
    event_kind: u32,
}

#[repr(C)]
#[derive(Default)]
struct EventHotKeyId {
    signature: u32,
    id: u32,
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn GetApplicationEventTarget() -> EventTargetRef;
    fn InstallEventHandler(
        target: EventTargetRef,
        callback: unsafe extern "C" fn(*mut c_void, EventRef, *mut c_void) -> i32,
        count: u32,
        types: *const EventTypeSpec,
        user_data: *mut c_void,
        handler: *mut EventHandlerRef,
    ) -> i32;
    fn GetEventParameter(
        event: EventRef,
        name: u32,
        desired_type: u32,
        actual_type: *mut u32,
        buffer_size: usize,
        actual_size: *mut usize,
        data: *mut c_void,
    ) -> i32;
    fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        id: EventHotKeyId,
        target: EventTargetRef,
        options: u32,
        hotkey: *mut EventHotKeyRef,
    ) -> i32;
    fn UnregisterEventHotKey(hotkey: EventHotKeyRef) -> i32;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightPostEventAccess() -> bool;
    fn CGRequestPostEventAccess() -> bool;
}

thread_local! {
    static SESSION: RefCell<Option<PasteSession>> = const { RefCell::new(None) };
    static HANDLER_INSTALLED: Cell<bool> = const { Cell::new(false) };
    static RETURN_APP: Cell<Option<i32>> = const { Cell::new(None) };
    static NEXT_SESSION_ID: Cell<u32> = const { Cell::new(0) };
}

struct PasteSession {
    chain_id: String,
    id: u32,
    hotkey: NonNull<c_void>,
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
        unsafe { UnregisterEventHotKey(self.hotkey.as_ptr()) };
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
    install_handler()?;
    let id = NEXT_SESSION_ID.with(|next| {
        let id = next.get().wrapping_add(1);
        next.set(id);
        id
    });
    let hotkey = register_hotkey(id)?;
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

fn install_handler() -> Result<(), String> {
    if HANDLER_INSTALLED.get() {
        return Ok(());
    }
    let spec = EventTypeSpec {
        event_class: KEYBOARD_EVENT,
        event_kind: HOTKEY_PRESSED,
    };
    let status = unsafe {
        InstallEventHandler(
            GetApplicationEventTarget(),
            handle_hotkey,
            1,
            &spec,
            null_mut(),
            null_mut(),
        )
    };
    if status != 0 {
        return Err(format!("无法接收 ⌘V（{status}）"));
    }
    HANDLER_INSTALLED.set(true);
    Ok(())
}

fn register_hotkey(id: u32) -> Result<NonNull<c_void>, String> {
    let mut hotkey = null_mut();
    let status = unsafe {
        RegisterEventHotKey(
            V_KEY,
            COMMAND_KEY,
            EventHotKeyId {
                signature: HOTKEY_SIGNATURE,
                id,
            },
            GetApplicationEventTarget(),
            HOTKEY_EXCLUSIVE,
            &mut hotkey,
        )
    };
    if status != 0 {
        return Err(format!("无法启用记忆链的 ⌘V，请检查快捷键冲突（{status}）"));
    }
    NonNull::new(hotkey).ok_or_else(|| "无法启用记忆链的 ⌘V".into())
}

unsafe extern "C" fn handle_hotkey(_: *mut c_void, event: EventRef, _: *mut c_void) -> i32 {
    let mut id = EventHotKeyId::default();
    let status = GetEventParameter(
        event,
        DIRECT_OBJECT,
        HOTKEY_ID_TYPE,
        null_mut(),
        size_of::<EventHotKeyId>(),
        null_mut(),
        (&mut id as *mut EventHotKeyId).cast(),
    );
    if status != 0 || id.signature != HOTKEY_SIGNATURE {
        return EVENT_NOT_HANDLED;
    }
    if let Some(pid) = foreground_pid() {
        receive_paste(id.id, pid);
    }
    0
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

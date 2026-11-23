use serde::Serialize;
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Mutex,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// Carbon events can outlive unregister. Every native registration gets a unique
// ID so an old event can never resolve to a newly registered handler.
pub(crate) fn registration_shortcut(mut shortcut: Shortcut) -> Result<Shortcut, String> {
    static NEXT_ID: AtomicU32 = AtomicU32::new(1);
    shortcut.id = NEXT_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| "全局快捷键注册次数已达上限，请重启 Deskmon")?;
    Ok(shortcut)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenshotShortcutStatus {
    pub(crate) active: bool,
    pub(crate) recording: bool,
    pub(crate) error: Option<String>,
}

trait Registry {
    fn register(&mut self, shortcut: Shortcut, generation: u64) -> Result<(), String>;
    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String>;
}

#[derive(Default)]
struct Binding {
    configured: Option<Shortcut>,
    registered: Option<Shortcut>,
    generation: u64,
    recording: bool,
    error: Option<String>,
    retired: Vec<Shortcut>,
}

impl Binding {
    fn register(&mut self, shortcut: Shortcut, registry: &mut impl Registry) -> Result<(), String> {
        let registered = registration_shortcut(shortcut)?;
        self.generation = self.generation.wrapping_add(1);
        registry.register(registered, self.generation)?;
        self.registered = Some(registered);
        Ok(())
    }

    fn clean_retired(&mut self, registry: &mut impl Registry) -> Vec<String> {
        let mut errors = Vec::new();
        self.retired
            .retain(|shortcut| match registry.unregister(*shortcut) {
                Ok(()) => false,
                Err(error) => {
                    errors.push(error);
                    true
                }
            });
        errors
    }

    fn update(
        &mut self,
        new: Option<Shortcut>,
        registry: &mut impl Registry,
        persist: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let cleanup_errors = self.clean_retired(registry);
        let same_combo = match (self.registered, new) {
            (Some(old), Some(new)) => old.mods == new.mods && old.key == new.key,
            (None, None) => true,
            _ => false,
        };
        if same_combo && !self.recording {
            persist()?;
            self.configured = new;
            self.error = (!cleanup_errors.is_empty()).then(|| cleanup_errors.join("；"));
            return Ok(());
        }
        let candidate = new.map(registration_shortcut).transpose()?;
        let generation = self.generation.wrapping_add(1);
        if let Some(shortcut) = candidate {
            registry.register(shortcut, generation)?;
        }
        // Keep the old registration untouched until disk commit succeeds.
        if let Err(error) = persist() {
            let mut errors = vec![error];
            if let Some(shortcut) = candidate {
                if let Err(error) = registry.unregister(shortcut) {
                    self.retired.push(shortcut);
                    errors.push(format!("撤销候选快捷键失败：{error}"));
                }
            }
            self.error = Some(errors.join("；"));
            return Err(self.error.clone().unwrap());
        }
        let old = self.registered;
        self.registered = candidate;
        self.configured = new;
        self.generation = generation;
        self.recording = false;
        let mut errors = cleanup_errors;
        if let Some(shortcut) = old {
            if let Err(error) = registry.unregister(shortcut) {
                self.retired.push(shortcut);
                errors.push(format!("原快捷键释放待重试：{error}"));
            }
        }
        self.error = (!errors.is_empty()).then(|| errors.join("；"));
        Ok(())
    }

    fn record(&mut self, recording: bool, registry: &mut impl Registry) -> Result<(), String> {
        let errors = self.clean_retired(registry);
        if recording {
            if let Some(shortcut) = self.registered {
                registry.unregister(shortcut)?;
                self.registered = None;
            }
            self.recording = true;
        } else if self.recording {
            self.recording = false;
            if let Some(shortcut) = self.configured {
                if let Err(error) = self.register(shortcut, registry) {
                    self.error = Some(error.clone());
                    return Err(error);
                }
            }
        }
        self.error = if !errors.is_empty() {
            Some(errors.join("；"))
        } else if self.registered.is_some() || self.configured.is_none() {
            None
        } else {
            self.error.clone()
        };
        Ok(())
    }

    fn accepts(&self, native_id: u32, generation: u64, state: ShortcutState) -> bool {
        state == ShortcutState::Pressed
            && !self.recording
            && self.registered.is_some_and(|key| key.id() == native_id)
            && self.generation == generation
    }

    fn status(&self) -> ScreenshotShortcutStatus {
        ScreenshotShortcutStatus {
            active: self.registered.is_some() && !self.recording,
            recording: self.recording,
            error: self.error.clone(),
        }
    }
}

pub(crate) fn validate_screenshot_shortcut(
    value: Option<&str>,
) -> Result<Option<Shortcut>, String> {
    let Some(value) = value else { return Ok(None) };
    let shortcut: Shortcut = value.parse().map_err(|_| "快捷键格式无效".to_string())?;
    let supported_modifiers =
        Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT;
    if !shortcut
        .mods
        .intersects(Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT)
        || !(shortcut.mods - supported_modifiers).is_empty()
    {
        return Err("请包含 ⌘、⌃ 或 ⌥ 修饰键".into());
    }
    if shortcut == "Super+KeyV".parse::<Shortcut>().unwrap() {
        return Err("⌘V 已保留给记忆链，请选择其他组合".into());
    }
    let code = shortcut.key.to_string();
    let supported = (code.len() == 4
        && code.starts_with("Key")
        && code.as_bytes()[3].is_ascii_uppercase())
        || (code.len() == 6 && code.starts_with("Digit") && code.as_bytes()[5].is_ascii_digit())
        || matches!(
            code.as_str(),
            "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Space"
        )
        || code
            .strip_prefix('F')
            .and_then(|n| n.parse::<u8>().ok())
            .is_some_and(|n| (1..=12).contains(&n));
    if !supported {
        return Err("请选择字母、数字、方向键、空格或 F1–F12".into());
    }
    Ok(Some(shortcut))
}

pub(crate) struct GlobalShortcuts(Mutex<Option<Binding>>);
impl Default for GlobalShortcuts {
    fn default() -> Self {
        Self(Mutex::new(Some(Binding::default())))
    }
}

struct TauriRegistry<'a>(&'a AppHandle);
impl Registry for TauriRegistry<'_> {
    fn register(&mut self, shortcut: Shortcut, generation: u64) -> Result<(), String> {
        self.0
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                let app = app.clone();
                let handle = app.clone();
                // Tauri executes inline on the main thread, or dispatches otherwise.
                // No application locks survive either path.
                let _ = handle.run_on_main_thread(move || {
                    let allowed = app
                        .state::<GlobalShortcuts>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|binding| {
                            binding
                                .as_ref()
                                .map(|b| b.accepts(event.id, generation, event.state))
                        })
                        .unwrap_or(false);
                    if allowed {
                        crate::start_region_screenshot(&app, &app.state::<crate::AppState>());
                    }
                });
            })
            .map_err(|error| format!("无法注册截图快捷键，可能已被系统或其他应用占用：{error}"))
    }
    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|error| format!("无法释放截图快捷键：{error}"))
    }
}

// Called on the main thread. Remove the binding while making native calls, so
// neither an application lock nor a RefCell borrow survives a nested event loop.
fn with_binding<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Binding, &mut TauriRegistry<'_>) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<GlobalShortcuts>();
    let mut binding = state
        .0
        .lock()
        .map_err(|_| "快捷键状态不可用")?
        .take()
        .ok_or("快捷键正在更新")?;
    let result = f(&mut binding, &mut TauriRegistry(app));
    *state.0.lock().map_err(|_| "快捷键状态不可用")? = Some(binding);
    result
}

pub(crate) fn screenshot_shortcut_status(app: &AppHandle) -> ScreenshotShortcutStatus {
    app.state::<GlobalShortcuts>()
        .0
        .lock()
        .ok()
        .and_then(|b| b.as_ref().map(Binding::status))
        .unwrap_or(ScreenshotShortcutStatus {
            error: Some("快捷键正在更新".into()),
            ..Default::default()
        })
}

pub(crate) fn restore_screenshot_shortcut(
    app: &AppHandle,
    configured: Option<&str>,
) -> ScreenshotShortcutStatus {
    let result = validate_screenshot_shortcut(configured).and_then(|shortcut| {
        with_binding(app, |binding, registry| {
            binding.configured = shortcut;
            if let Some(shortcut) = shortcut {
                binding.register(shortcut, registry)
            } else {
                Ok(())
            }
        })
    });
    if let Err(error) = result {
        let _ = with_binding(app, |binding, _| {
            binding.error = Some(error);
            Ok(())
        });
    }
    screenshot_shortcut_status(app)
}

pub(crate) fn update_screenshot_shortcut(
    app: &AppHandle,
    new: Option<&str>,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let shortcut = validate_screenshot_shortcut(new)?;
    with_binding(app, |binding, registry| {
        binding.update(shortcut, registry, persist)
    })
}

pub(crate) fn set_screenshot_shortcut_recording(
    app: &AppHandle,
    recording: bool,
) -> Result<ScreenshotShortcutStatus, String> {
    with_binding(app, |binding, registry| binding.record(recording, registry))?;
    Ok(screenshot_shortcut_status(app))
}

pub(crate) async fn on_main_thread<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    let handle = app.clone();
    handle
        .run_on_main_thread(move || {
            let _ = tx.try_send(f(app));
        })
        .map_err(|e| e.to_string())?;
    rx.recv().await.ok_or("主线程任务已取消")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[derive(Default)]
    struct DesktopRegistry {
        registered: HashSet<u32>,
        keys: std::collections::HashMap<u32, Shortcut>,
        conflict: Option<Shortcut>,
        fail_unregister: Option<Shortcut>,
    }
    impl Registry for DesktopRegistry {
        fn register(&mut self, shortcut: Shortcut, _: u64) -> Result<(), String> {
            let same = |other: &Shortcut| other.mods == shortcut.mods && other.key == shortcut.key;
            if self.conflict.as_ref().is_some_and(same) || self.keys.values().any(same) {
                return Err("occupied".into());
            }
            self.registered.insert(shortcut.id());
            self.keys.insert(shortcut.id(), shortcut);
            Ok(())
        }
        fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String> {
            if self
                .fail_unregister
                .is_some_and(|other| other.mods == shortcut.mods && other.key == shortcut.key)
            {
                return Err("unregister failed".into());
            }
            self.registered.remove(&shortcut.id());
            self.keys.remove(&shortcut.id());
            Ok(())
        }
    }
    fn key(value: &str) -> Shortcut {
        value.parse().unwrap()
    }
    fn configured() -> (Binding, DesktopRegistry) {
        let mut state = Binding::default();
        let mut registry = DesktopRegistry::default();
        state
            .update(Some(key("Super+KeyA")), &mut registry, || Ok(()))
            .unwrap();
        (state, registry)
    }

    #[test]
    fn validates_supported_keys_and_reserves_paste_even_without_session() {
        for value in [
            "Super+KeyV",
            "Command+V",
            "Shift+KeyA",
            "KeyA",
            "Super+Escape",
            "Super+AudioVolumeUp",
            "Super+F13",
            "",
        ] {
            assert!(
                validate_screenshot_shortcut(Some(value)).is_err(),
                "{value}"
            );
        }
        assert_eq!(validate_screenshot_shortcut(None).unwrap(), None);
        assert_eq!(
            validate_screenshot_shortcut(Some("Super+Shift+KeyA")).unwrap(),
            Some(key("Super+Shift+KeyA"))
        );
    }

    #[test]
    fn native_event_ids_are_not_reused_when_the_same_combo_starts_a_new_session() {
        let first = registration_shortcut(key("Super+KeyV")).unwrap();
        let second = registration_shortcut(key("Super+KeyV")).unwrap();
        let mut native_handlers = std::collections::HashMap::from([(first.id(), "first chain")]);
        native_handlers.remove(&first.id());
        native_handlers.insert(second.id(), "second chain");
        assert_eq!(
            native_handlers.get(&first.id()),
            None,
            "an old OS event must never resolve to the new chain handler"
        );
        assert_eq!(native_handlers.get(&second.id()), Some(&"second chain"));
        assert_eq!((first.mods, first.key), (second.mods, second.key));
    }

    #[test]
    fn conflict_keeps_old_binding_and_does_not_persist() {
        let (mut state, mut registry) = configured();
        registry.conflict = Some(key("Alt+F2"));
        assert!(state
            .update(registry.conflict, &mut registry, || panic!(
                "must not persist"
            ))
            .is_err());
        assert_eq!(state.configured, Some(key("Super+KeyA")));
        assert_eq!(
            registry.registered,
            HashSet::from([state.registered.unwrap().id()])
        );
        assert!(state.accepts(
            state.registered.unwrap().id(),
            state.generation,
            ShortcutState::Pressed
        ));
    }

    #[test]
    fn disk_failure_keeps_old_binding_without_releasing_it() {
        let (mut state, mut registry) = configured();
        let old_generation = state.generation;
        let old_native_id = state.registered.unwrap().id();
        assert!(state
            .update(Some(key("Alt+F2")), &mut registry, || Err(
                "disk full".into()
            ))
            .is_err());
        assert_eq!(state.configured, Some(key("Super+KeyA")));
        assert_eq!(
            registry.registered,
            HashSet::from([state.registered.unwrap().id()])
        );
        assert!(
            state.accepts(old_native_id, old_generation, ShortcutState::Pressed),
            "original binding is kept intact until disk commit"
        );
        assert!(state.accepts(
            state.registered.unwrap().id(),
            state.generation,
            ShortcutState::Pressed
        ));
    }

    #[test]
    fn failed_candidate_cleanup_is_retained_and_retried_before_recording() {
        let (mut state, mut registry) = configured();
        registry.fail_unregister = Some(key("Alt+F2"));
        assert!(state
            .update(Some(key("Alt+F2")), &mut registry, || Err(
                "disk full".into()
            ))
            .is_err());
        registry.fail_unregister = None;
        state.record(true, &mut registry).unwrap();
        assert!(
            registry.registered.is_empty(),
            "failed candidates cannot keep stealing a global key"
        );
    }

    #[test]
    fn recording_disables_capture_and_restore_rejects_old_and_released_events() {
        let (mut state, mut registry) = configured();
        let generation = state.generation;
        let native_id = state.registered.unwrap().id();
        state.record(true, &mut registry).unwrap();
        assert!(registry.registered.is_empty());
        assert!(!state.accepts(native_id, generation, ShortcutState::Pressed));
        state.record(false, &mut registry).unwrap();
        assert!(!state.accepts(native_id, generation, ShortcutState::Pressed));
        assert!(!state.accepts(
            state.registered.unwrap().id(),
            state.generation,
            ShortcutState::Released
        ));
        assert!(state.accepts(
            state.registered.unwrap().id(),
            state.generation,
            ShortcutState::Pressed
        ));
    }

    #[test]
    fn clear_does_not_unregister_memory_chain_and_restore_failure_keeps_configuration() {
        let (mut state, mut registry) = configured();
        registry.register(key("Super+KeyV"), 0).unwrap();
        state.record(true, &mut registry).unwrap();
        registry.conflict = state.configured;
        assert!(state.record(false, &mut registry).is_err());
        assert!(!state.recording);
        assert!(state.registered.is_none());
        assert_eq!(state.configured, Some(key("Super+KeyA")));
        state.update(None, &mut registry, || Ok(())).unwrap();
        assert_eq!(state.configured, None);
        assert_eq!(registry.registered, HashSet::from([key("Super+KeyV").id()]));
    }
}

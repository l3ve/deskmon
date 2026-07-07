mod geometry;
mod remember;
mod settings;

use geometry::{
    clamp_to_visible_work_area, collect_monitors, default_activity_area, initial_pet_position,
    normalize_activity_area, pet_physical_dimensions, point_visible, Dimensions, MonitorPayload,
    Point, Rect,
};
use serde::{Deserialize, Serialize};
use settings::{load_settings, save_settings, Settings, UserPreferences};
use std::{
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItem, Submenu, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Size, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

const PET_WINDOW: &str = "pet";
const SETTINGS_WINDOW: &str = "settings";
const REMEMBER_WINDOW: &str = "remember";
const REMEMBER_WINDOW_WIDTH: f64 = 920.0;
const REMEMBER_WINDOW_HEIGHT: f64 = 620.0;
const REMEMBER_WINDOW_MIN_WIDTH: f64 = 780.0;
const REMEMBER_WINDOW_MIN_HEIGHT: f64 = 520.0;
const TRAY_ID: &str = "deskmon-tray";
const TRAY_ICON: &[u8] = include_bytes!("../assets/tray-icon.png");
const TRAY_TIMER_STATUS_ID: &str = "tray_timer_status";
const PET_TIMER_STATUS_ID: &str = "pet_timer_status";
const POSITION_SAVE_INTERVAL_MS: u64 = 5000;
const CLIPBOARD_POLL_INTERVAL_MS: u64 = 500;
const VARIABLE_CLIPBOARD_CLEANUP_SECONDS: u64 = 30;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimerState {
    duration_seconds: u64,
    ends_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimerSnapshot {
    is_running: bool,
    duration_seconds: u64,
    remaining_seconds: u64,
    ends_at_ms: Option<u64>,
}

impl TimerSnapshot {
    fn idle() -> Self {
        Self {
            is_running: false,
            duration_seconds: 0,
            remaining_seconds: 0,
            ends_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapPayload {
    settings: Settings,
    monitors: Vec<MonitorPayload>,
    activity_area: Rect,
    default_activity_area: Rect,
    pet_dimensions: Dimensions,
    pet_window_dimensions: Dimensions,
    pet_position: Point,
    timer: TimerSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowFramePayload {
    position: Point,
    size: Dimensions,
    cursor: Point,
}

#[derive(Default)]
struct AppState {
    settings: Mutex<Settings>,
    timer: Mutex<Option<TimerState>>,
    remember: Mutex<remember::RememberState>,
    menu_items: Mutex<MenuItems>,
    last_position_saved_at_ms: Mutex<u64>,
}

#[derive(Default)]
struct MenuItems {
    tray_timer_status: Option<MenuItem<tauri::Wry>>,
    pet_timer_status: Option<MenuItem<tauri::Wry>>,
}

#[tauri::command]
fn get_bootstrap(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?;
    let monitors = collect_monitors(&app)?;
    let default_activity_area = default_activity_area(&monitors);
    let pet_dimensions = settings.pet_size.logical_dimensions();
    let pet_window_dimensions =
        pet_physical_dimensions(pet_dimensions, &monitors, settings.last_position);
    settings.custom_activity_area = settings.custom_activity_area.and_then(|area| {
        normalize_activity_area(area, default_activity_area, pet_window_dimensions)
    });
    let activity_area = settings
        .custom_activity_area
        .unwrap_or(default_activity_area);
    let position = settings
        .last_position
        .filter(|point| point_visible(*point, pet_window_dimensions, &monitors))
        .unwrap_or_else(|| initial_pet_position(activity_area, pet_window_dimensions));
    settings.last_position = Some(position);
    let settings_snapshot = settings.clone();
    drop(settings);

    resize_and_place_pet_window(&app, position, pet_dimensions)?;
    save_settings(&app, &settings_snapshot)?;

    Ok(BootstrapPayload {
        settings: settings_snapshot,
        monitors,
        activity_area,
        default_activity_area,
        pet_dimensions,
        pet_window_dimensions,
        pet_position: position,
        timer: timer_snapshot(&state),
    })
}

#[tauri::command]
fn get_desktop_snapshot(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    get_bootstrap(app, state)
}

#[tauri::command]
fn get_pet_window_frame(app: AppHandle) -> Result<WindowFramePayload, String> {
    let window = app
        .get_webview_window(PET_WINDOW)
        .ok_or("pet window is not available")?;
    let position = window.outer_position().map_err(|err| err.to_string())?;
    let size = window.inner_size().map_err(|err| err.to_string())?;
    let cursor = app.cursor_position().map_err(|err| err.to_string())?;
    Ok(WindowFramePayload {
        position: Point {
            x: position.x as f64,
            y: position.y as f64,
        },
        size: Dimensions {
            width: size.width as f64,
            height: size.height as f64,
        },
        cursor: Point {
            x: cursor.x,
            y: cursor.y,
        },
    })
}

#[tauri::command]
fn move_pet_window(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    x: f64,
    y: f64,
) -> Result<Point, String> {
    let monitors = collect_monitors(&app)?;
    let logical_dimensions = {
        let settings = state
            .settings
            .lock()
            .map_err(|_| "settings lock poisoned")?;
        settings.pet_size.logical_dimensions()
    };
    let pet_window_dimensions =
        pet_physical_dimensions(logical_dimensions, &monitors, Some(Point { x, y }));
    let next = clamp_to_visible_work_area(Point { x, y }, pet_window_dimensions, &monitors);
    move_pet_window_to(&app, next)?;

    let mut settings_to_save = None;
    let now = now_ms();
    {
        let mut settings = state
            .settings
            .lock()
            .map_err(|_| "settings lock poisoned")?;
        settings.last_position = Some(next);
        let mut saved_at = state
            .last_position_saved_at_ms
            .lock()
            .map_err(|_| "position save lock poisoned")?;
        if now.saturating_sub(*saved_at) >= POSITION_SAVE_INTERVAL_MS {
            *saved_at = now;
            settings_to_save = Some(settings.clone());
        }
    }
    if let Some(settings) = settings_to_save {
        save_settings(&app, &settings)?;
    }
    Ok(next)
}

#[tauri::command]
fn set_pet_temporary_presentation(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    always_on_top: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW) {
        window
            .set_size(Size::Logical(LogicalSize::new(width, height)))
            .map_err(|err| err.to_string())?;
        window
            .set_position(Position::Physical(PhysicalPosition::new(
                x.round() as i32,
                y.round() as i32,
            )))
            .map_err(|err| err.to_string())?;
        window
            .set_always_on_top(always_on_top)
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn persist_pet_position(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .clone();
    save_settings(&app, &settings)?;
    let mut saved_at = state
        .last_position_saved_at_ms
        .lock()
        .map_err(|_| "position save lock poisoned")?;
    *saved_at = now_ms();
    Ok(())
}

#[tauri::command]
fn save_user_preferences(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    preferences: UserPreferences,
) -> Result<BootstrapPayload, String> {
    let monitors = collect_monitors(&app)?;
    let default_area = default_activity_area(&monitors);
    let pet_dimensions = preferences.pet_size.logical_dimensions();
    let pet_window_dimensions = pet_physical_dimensions(pet_dimensions, &monitors, None);
    let normalized_area = preferences
        .custom_activity_area
        .and_then(|area| normalize_activity_area(area, default_area, pet_window_dimensions));

    {
        let mut settings = state
            .settings
            .lock()
            .map_err(|_| "settings lock poisoned")?;
        settings.pet_size = preferences.pet_size;
        settings.activity_level = preferences.activity_level;
        settings.always_on_top = preferences.always_on_top;
        settings.custom_activity_area = normalized_area;
        save_settings(&app, &settings)?;
    }

    if let Some(window) = app.get_webview_window(PET_WINDOW) {
        window
            .set_always_on_top(preferences.always_on_top)
            .map_err(|err| err.to_string())?;
        window
            .set_size(Size::Logical(LogicalSize::new(
                pet_dimensions.width,
                pet_dimensions.height,
            )))
            .map_err(|err| err.to_string())?;
    }
    update_tray_menu(&app)?;
    let _ = app.emit("deskmon-settings-changed", ());
    get_bootstrap(app, state)
}

fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        &app,
        SETTINGS_WINDOW,
        WebviewUrl::App("index.html#settings".into()),
    )
    .title("Deskmon 设置")
    .inner_size(720.0, 620.0)
    .min_inner_size(620.0, 520.0)
    .center()
    .resizable(true)
    .build()
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn open_remember_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(REMEMBER_WINDOW) {
        ensure_remember_window_size(&window)?;
        return show_window_in_front(&window);
    }

    let window = WebviewWindowBuilder::new(
        &app,
        REMEMBER_WINDOW,
        WebviewUrl::App("index.html#remember".into()),
    )
    .title("记忆力")
    .inner_size(REMEMBER_WINDOW_WIDTH, REMEMBER_WINDOW_HEIGHT)
    .min_inner_size(REMEMBER_WINDOW_MIN_WIDTH, REMEMBER_WINDOW_MIN_HEIGHT)
    .center()
    .resizable(true)
    .build()
    .map_err(|err| err.to_string())?;
    show_window_in_front(&window)
}

fn ensure_remember_window_size(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_min_size(Some(Size::Logical(LogicalSize::new(
            REMEMBER_WINDOW_MIN_WIDTH,
            REMEMBER_WINDOW_MIN_HEIGHT,
        ))))
        .map_err(|err| err.to_string())?;

    let size = window.inner_size().map_err(|err| err.to_string())?;
    let scale = window.scale_factor().map_err(|err| err.to_string())?;
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;

    if width < REMEMBER_WINDOW_MIN_WIDTH
        || height < REMEMBER_WINDOW_MIN_HEIGHT
        || width > REMEMBER_WINDOW_WIDTH
        || height > REMEMBER_WINDOW_HEIGHT
    {
        window
            .set_size(Size::Logical(LogicalSize::new(
                REMEMBER_WINDOW_WIDTH,
                REMEMBER_WINDOW_HEIGHT,
            )))
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn show_window_in_front(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|err| err.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|err| err.to_string())?;

    #[cfg(target_os = "macos")]
    {
        window
            .set_always_on_top(true)
            .map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        let window = window.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(240));
            let _ = window.set_always_on_top(false);
        });
    }

    Ok(())
}

#[tauri::command]
fn show_pet_menu(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let menu = build_pet_menu(&app, &state)?;
    let window = app
        .get_webview_window(PET_WINDOW)
        .ok_or("pet window is not available")?;
    window.popup_menu(&menu).map_err(|err| err.to_string())
}

#[tauri::command]
fn get_remember_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<remember::RememberSnapshot, String> {
    let remember_state = state
        .remember
        .lock()
        .map_err(|_| "remember lock poisoned")?;
    Ok(remember::snapshot(&remember_state))
}

#[tauri::command]
fn open_remember(app: AppHandle) -> Result<(), String> {
    open_remember_window(app)
}

#[tauri::command]
fn remember_reset_clipboard(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    source: String,
    id: String,
) -> Result<remember::RememberSnapshot, String> {
    remember_reset_clipboard_inner(&app, &state, &source, &id)
}

#[tauri::command]
fn remember_save_item(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    source: String,
    id: String,
) -> Result<remember::RememberSnapshot, String> {
    let (text, truncated) = {
        let remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state
            .entry_text(&source, &id)
            .ok_or("没有找到这条记忆")?
    };

    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.save_entry(&app, text, truncated)?;
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(&app, &snapshot);
    Ok(snapshot)
}

fn remember_save_current_clipboard(app: &AppHandle, state: &tauri::State<'_, AppState>) {
    let notification_body = match arboard::Clipboard::new()
        .ok()
        .and_then(|mut clipboard| clipboard.get_text().ok())
        .and_then(|text| remember::normalize_text(&text))
    {
        Some((text, truncated)) => {
            let result = {
                let mut remember_state = match state.remember.lock() {
                    Ok(remember_state) => remember_state,
                    Err(_) => {
                        notify_remember(app, "Deskmon 暂时记不住这段文字");
                        return;
                    }
                };
                remember_state
                    .save_entry(app, text, truncated)
                    .map(|()| remember::snapshot(&remember_state))
            };

            match result {
                Ok(snapshot) => {
                    emit_remember_changed(app, &snapshot);
                    if truncated {
                        format!("Deskmon 记住了前 {} 个字", remember::TEXT_LIMIT)
                    } else {
                        "Deskmon 记住刚想到的了".to_string()
                    }
                }
                Err(error) => remember_save_error_notification(&error).to_string(),
            }
        }
        None => "Deskmon 没看到能记住的文字".to_string(),
    };

    notify_remember(app, &notification_body);
}

fn remember_save_error_notification(error: &str) -> &'static str {
    if error.contains("笔记本已经满") {
        "笔记本满啦，先忘记一些再记"
    } else if error.contains("无法解密")
        || error.contains("密钥")
        || error.contains("数据损坏")
        || error.contains("重置")
    {
        "笔记本打不开了，请到记忆力里重置"
    } else {
        "Deskmon 暂时记不住这段文字"
    }
}

fn notify_remember(app: &AppHandle, body: &str) {
    let _ = app
        .notification()
        .builder()
        .title("Deskmon")
        .body(body)
        .show();
}

#[tauri::command]
fn remember_forget_recent(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<remember::RememberSnapshot, String> {
    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.forget_recent(&id);
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
fn remember_clear_recent(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<remember::RememberSnapshot, String> {
    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.clear_recent();
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
async fn remember_forget_notebook(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<remember::RememberSnapshot, String> {
    let confirmed = confirm_dialog(
        app.clone(),
        "记忆力",
        "要让 Deskmon 忘记这条笔记本内容吗？",
        "忘记",
    )
    .await?;

    if !confirmed {
        let snapshot = get_remember_snapshot(state)?;
        restore_remember_window_focus(&app);
        return Ok(snapshot);
    }

    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.forget_notebook(&app, &id)?;
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(&app, &snapshot);
    restore_remember_window_focus(&app);
    Ok(snapshot)
}

#[tauri::command]
fn remember_set_notebook_pinned(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<remember::RememberSnapshot, String> {
    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.set_notebook_pinned(&app, &id, pinned)?;
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
async fn remember_reset_notebook(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<remember::RememberSnapshot, String> {
    let confirmed = confirm_dialog(
        app.clone(),
        "重置记忆力",
        "笔记本和变量都会被清空，这些内容无法恢复。",
        "重置",
    )
    .await?;

    if !confirmed {
        let snapshot = get_remember_snapshot(state)?;
        restore_remember_window_focus(&app);
        return Ok(snapshot);
    }

    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.reset_notebook(&app)?;
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(&app, &snapshot);
    restore_remember_window_focus(&app);
    Ok(snapshot)
}

#[tauri::command]
fn remember_create_variable(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    key: String,
    value: String,
    note: Option<String>,
) -> Result<remember::RememberSnapshot, String> {
    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.create_variable(&app, key, value, note)?;
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(&app, &snapshot);
    update_tray_menu(&app)?;
    Ok(snapshot)
}

#[tauri::command]
fn remember_update_variable(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    key: String,
    value: String,
    note: Option<String>,
) -> Result<remember::RememberSnapshot, String> {
    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.update_variable(&app, &id, key, value, note)?;
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(&app, &snapshot);
    update_tray_menu(&app)?;
    Ok(snapshot)
}

#[tauri::command]
async fn remember_delete_variable(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<remember::RememberSnapshot, String> {
    let key = {
        let remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.variable_key(&id).ok_or("没有找到这个变量")?
    };
    let confirmed = confirm_dialog(
        app.clone(),
        "删除变量",
        format!("要让 Deskmon 忘记变量“{key}”吗？"),
        "删除",
    )
    .await?;

    if !confirmed {
        let snapshot = get_remember_snapshot(state)?;
        restore_remember_window_focus(&app);
        return Ok(snapshot);
    }

    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.delete_variable(&app, &id)?;
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(&app, &snapshot);
    update_tray_menu(&app)?;
    restore_remember_window_focus(&app);
    Ok(snapshot)
}

#[tauri::command]
fn remember_copy_variable(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<remember::RememberSnapshot, String> {
    remember_copy_variable_inner(&app, &state, &id)
}

#[tauri::command]
fn remember_reveal_variable_value(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    let remember_state = state
        .remember
        .lock()
        .map_err(|_| "remember lock poisoned")?;
    remember_state
        .variable_value(&id)
        .ok_or("没有找到这个变量".into())
}

#[tauri::command]
fn remember_set_variable_clipboard_cleanup_enabled(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<remember::RememberSnapshot, String> {
    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.set_variable_clipboard_cleanup_enabled(&app, enabled)?;
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(&app, &snapshot);
    Ok(snapshot)
}

async fn confirm_dialog(
    app: AppHandle,
    title: impl Into<String>,
    message: impl Into<String>,
    confirm_label: impl Into<String>,
) -> Result<bool, String> {
    let title = title.into();
    let message = message.into();
    let confirm_label = confirm_label.into();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                confirm_label,
                "取消".into(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|err| err.to_string())
}

fn restore_remember_window_focus(app: &AppHandle) {
    let Some(window) = app.get_webview_window(REMEMBER_WINDOW) else {
        return;
    };

    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();

    #[cfg(target_os = "macos")]
    {
        let window = window.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(90));
            let _ = window.set_focus();
        });
    }
}

fn set_pet_visible_inner(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    visible: bool,
) -> Result<(), String> {
    restore_pet_window_from_settings(app, state)?;
    if let Some(window) = app.get_webview_window(PET_WINDOW) {
        if visible {
            window.show().map_err(|err| err.to_string())?;
        } else {
            window.hide().map_err(|err| err.to_string())?;
        }
    }
    {
        let mut settings = state
            .settings
            .lock()
            .map_err(|_| "settings lock poisoned")?;
        settings.pet_visible = visible;
        save_settings(app, &settings)?;
    }
    update_tray_menu(app)?;
    app.emit("deskmon-visibility-changed", visible)
        .map_err(|err| err.to_string())
}

fn restore_pet_window_from_settings(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<(), String> {
    let monitors = collect_monitors(app)?;
    let (pet_dimensions, last_position, custom_activity_area, always_on_top) = {
        let settings = state
            .settings
            .lock()
            .map_err(|_| "settings lock poisoned")?;
        (
            settings.pet_size.logical_dimensions(),
            settings.last_position,
            settings.custom_activity_area,
            settings.always_on_top,
        )
    };
    let pet_window_dimensions = pet_physical_dimensions(pet_dimensions, &monitors, last_position);
    let default_area = default_activity_area(&monitors);
    let activity_area = custom_activity_area
        .and_then(|area| normalize_activity_area(area, default_area, pet_window_dimensions))
        .unwrap_or(default_area);
    let position = last_position
        .filter(|point| point_visible(*point, pet_window_dimensions, &monitors))
        .unwrap_or_else(|| initial_pet_position(activity_area, pet_window_dimensions));
    let position = clamp_to_visible_work_area(position, pet_window_dimensions, &monitors);

    resize_and_place_pet_window(app, position, pet_dimensions)?;
    if let Some(window) = app.get_webview_window(PET_WINDOW) {
        window
            .set_always_on_top(always_on_top)
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn relocate_pet_to_activity_area(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<(), String> {
    let monitors = collect_monitors(app)?;
    let (settings_snapshot, position, pet_dimensions) = {
        let mut settings = state
            .settings
            .lock()
            .map_err(|_| "settings lock poisoned")?;
        let pet_dimensions = settings.pet_size.logical_dimensions();
        let pet_window_dimensions =
            pet_physical_dimensions(pet_dimensions, &monitors, settings.last_position);
        let default_area = default_activity_area(&monitors);
        settings.custom_activity_area = settings
            .custom_activity_area
            .and_then(|area| normalize_activity_area(area, default_area, pet_window_dimensions));
        let activity_area = settings.custom_activity_area.unwrap_or(default_area);
        let position = clamp_to_visible_work_area(
            initial_pet_position(activity_area, pet_window_dimensions),
            pet_window_dimensions,
            &monitors,
        );
        settings.pet_visible = true;
        settings.last_position = Some(position);
        (settings.clone(), position, pet_dimensions)
    };

    resize_and_place_pet_window(app, position, pet_dimensions)?;
    if let Some(window) = app.get_webview_window(PET_WINDOW) {
        window.show().map_err(|err| err.to_string())?;
    }
    save_settings(app, &settings_snapshot)?;
    update_tray_menu(app)?;
    app.emit("deskmon-visibility-changed", true)
        .map_err(|err| err.to_string())?;
    app.emit("deskmon-settings-changed", ())
        .map_err(|err| err.to_string())
}

fn start_timer_inner(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    minutes: u64,
) -> Result<TimerSnapshot, String> {
    if !matches!(minutes, 1 | 5 | 10 | 25) {
        return Err("unsupported timer duration".into());
    }
    {
        let timer = state.timer.lock().map_err(|_| "timer lock poisoned")?;
        if timer.is_some() {
            return Ok(timer_snapshot(state));
        }
    }

    let duration_seconds = minutes * 60;
    let ends_at_ms = now_ms() + duration_seconds * 1000;
    let next_timer = TimerState {
        duration_seconds,
        ends_at_ms,
    };
    {
        let mut timer = state.timer.lock().map_err(|_| "timer lock poisoned")?;
        *timer = Some(next_timer);
    }
    update_tray_menu(app)?;
    let snapshot = timer_snapshot(state);
    update_timer_menu_text(app, &snapshot)?;
    app.emit("deskmon-timer-changed", &snapshot)
        .map_err(|err| err.to_string())?;
    spawn_timer_worker(app.clone(), next_timer);
    Ok(snapshot)
}

fn spawn_timer_worker(app: AppHandle, started_timer: TimerState) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let Some(state) = app.try_state::<AppState>() else {
            break;
        };
        let current = {
            let timer = match state.timer.lock() {
                Ok(timer) => timer,
                Err(_) => break,
            };
            *timer
        };

        if current.map(|timer| timer.ends_at_ms) != Some(started_timer.ends_at_ms) {
            break;
        }

        let snapshot = timer_snapshot(&state);
        let _ = update_timer_menu_text(&app, &snapshot);
        let _ = app.emit("deskmon-timer-changed", &snapshot);

        if snapshot.remaining_seconds == 0 {
            let finished = {
                let mut timer = match state.timer.lock() {
                    Ok(timer) => timer,
                    Err(_) => break,
                };
                if timer.map(|timer| timer.ends_at_ms) == Some(started_timer.ends_at_ms) {
                    *timer = None;
                    true
                } else {
                    false
                }
            };
            if finished {
                clear_timer_menu_items(&state);
                let _ = update_tray_menu(&app);
                let _ = app
                    .notification()
                    .builder()
                    .title("Deskmon")
                    .body("计时结束啦")
                    .show();
                let _ = app.emit("deskmon-timer-finished", started_timer);
                let _ = app.emit("deskmon-timer-changed", TimerSnapshot::idle());
            }
            break;
        }
    });
}

fn spawn_clipboard_worker(app: AppHandle) {
    thread::spawn(move || {
        let mut clipboard = loop {
            match arboard::Clipboard::new() {
                Ok(clipboard) => break clipboard,
                Err(_) => thread::sleep(Duration::from_millis(CLIPBOARD_POLL_INTERVAL_MS)),
            }
        };

        let baseline = clipboard
            .get_text()
            .ok()
            .and_then(|text| remember::normalize_text(&text).map(|(text, _)| text));
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(mut remember_state) = state.remember.lock() {
                remember_state.clipboard_initialized = true;
                remember_state.last_clipboard_text = baseline;
            }
        }

        loop {
            thread::sleep(Duration::from_millis(CLIPBOARD_POLL_INTERVAL_MS));
            let text = match clipboard.get_text() {
                Ok(text) => text,
                Err(_) => continue,
            };
            let Some((text, truncated)) = remember::normalize_text(&text) else {
                continue;
            };
            let Some(state) = app.try_state::<AppState>() else {
                break;
            };
            let changed = {
                let mut remember_state = match state.remember.lock() {
                    Ok(remember_state) => remember_state,
                    Err(_) => break,
                };
                if !remember_state.clipboard_initialized {
                    remember_state.clipboard_initialized = true;
                    remember_state.last_clipboard_text = Some(text);
                    false
                } else if remember_state.last_clipboard_text.as_deref() == Some(text.as_str()) {
                    false
                } else {
                    remember_state.last_clipboard_text = Some(text.clone());
                    remember_state.push_recent(text, truncated);
                    true
                }
            };

            if changed {
                let _ = emit_current_remember_changed(&app);
            }
        }
    });
}

fn remember_reset_clipboard_inner(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    source: &str,
    id: &str,
) -> Result<remember::RememberSnapshot, String> {
    let (text, truncated) = {
        let remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state
            .entry_text(source, id)
            .ok_or("没有找到这条记忆")?
    };

    set_clipboard_text(&text)?;
    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.clipboard_initialized = true;
        remember_state.last_clipboard_text = Some(text.clone());
        remember_state.push_recent(text, truncated);
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(app, &snapshot);
    Ok(snapshot)
}

fn remember_copy_variable_inner(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    id: &str,
) -> Result<remember::RememberSnapshot, String> {
    let (key, value, cleanup_enabled) = {
        let remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        let key = remember_state.variable_key(id).ok_or("没有找到这个变量")?;
        let value = remember_state
            .variable_value(id)
            .ok_or("没有找到这个变量")?;
        (
            key,
            value,
            remember_state.variable_clipboard_cleanup_enabled,
        )
    };

    let snapshot = {
        let mut remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember_state.clipboard_initialized = true;
        remember_state.last_clipboard_text = Some(value.clone());
        remember::snapshot(&remember_state)
    };
    set_clipboard_text(&value)?;
    emit_remember_changed(app, &snapshot);
    if cleanup_enabled {
        spawn_variable_clipboard_cleanup(app.clone(), value);
    }
    notify_remember(app, &format!("已复制变量“{key}”"));
    Ok(snapshot)
}

fn spawn_variable_clipboard_cleanup(app: AppHandle, value: String) {
    thread::spawn(move || {
        let mut clipboard = match arboard::Clipboard::new() {
            Ok(clipboard) => clipboard,
            Err(_) => return,
        };
        for _ in 0..(VARIABLE_CLIPBOARD_CLEANUP_SECONDS * 1000 / CLIPBOARD_POLL_INTERVAL_MS) {
            thread::sleep(Duration::from_millis(CLIPBOARD_POLL_INTERVAL_MS));
            match clipboard.get_text() {
                Ok(current) if current == value => {}
                _ => return,
            }
        }
        if matches!(clipboard.get_text(), Ok(current) if current == value) {
            let _ = clipboard.set_text(String::new());
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut remember_state) = state.remember.lock() {
                    remember_state.clipboard_initialized = true;
                    remember_state.last_clipboard_text = None;
                }
            }
        }
    });
}

fn set_clipboard_text(text: &str) -> Result<(), String> {
    arboard::Clipboard::new()
        .map_err(|err| err.to_string())?
        .set_text(text.to_owned())
        .map_err(|err| err.to_string())
}

fn emit_current_remember_changed(app: &AppHandle) -> Result<(), String> {
    let Some(state) = app.try_state::<AppState>() else {
        return Ok(());
    };
    let snapshot = {
        let remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember::snapshot(&remember_state)
    };
    emit_remember_changed(app, &snapshot);
    Ok(())
}

fn emit_remember_changed(app: &AppHandle, snapshot: &remember::RememberSnapshot) {
    let _ = app.emit("deskmon-remember-changed", snapshot);
}

fn create_pet_window(app: &tauri::App) -> Result<(), String> {
    let settings = app
        .state::<AppState>()
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .clone();
    let pet_dimensions = settings.pet_size.logical_dimensions();
    let monitors = collect_monitors(app.handle())?;
    let default_area = default_activity_area(&monitors);
    let pet_window_dimensions =
        pet_physical_dimensions(pet_dimensions, &monitors, settings.last_position);
    let activity_area = settings.custom_activity_area.unwrap_or(default_area);
    let position = settings
        .last_position
        .filter(|point| point_visible(*point, pet_window_dimensions, &monitors))
        .unwrap_or_else(|| initial_pet_position(activity_area, pet_window_dimensions));

    WebviewWindowBuilder::new(app, PET_WINDOW, WebviewUrl::App("index.html#pet".into()))
        .title("Deskmon")
        .inner_size(pet_dimensions.width, pet_dimensions.height)
        .position(position.x, position.y)
        .transparent(true)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(settings.always_on_top)
        .visible(settings.pet_visible)
        .visible_on_all_workspaces(true)
        .shadow(false)
        .focused(false)
        .accept_first_mouse(true)
        .build()
        .map_err(|err| err.to_string())?;

    move_pet_window_to(app.handle(), position)?;

    Ok(())
}

fn create_tray(app: &tauri::App) -> Result<(), String> {
    let state = app.state::<AppState>();
    let menu = build_tray_menu(app.handle(), &state)?;
    let tray_icon = Image::from_bytes(TRAY_ICON).map_err(|err| err.to_string())?;
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Deskmon")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .icon(tray_icon)
        .icon_as_template(true);

    builder.build(app).map_err(|err| err.to_string())?;
    Ok(())
}

fn update_tray_menu(app: &AppHandle) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let Some(state) = app.try_state::<AppState>() else {
        return Ok(());
    };
    let menu = build_tray_menu(app, &state)?;
    tray.set_menu(Some(menu)).map_err(|err| err.to_string())?;
    tray.set_title(None::<&str>)
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn build_tray_menu(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<Menu<tauri::Wry>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .clone();
    let timer = timer_snapshot(state);
    let visibility_label = if settings.pet_visible {
        "隐藏宠物"
    } else {
        "显示宠物"
    };
    let pause_label = if settings.movement_paused {
        "恢复移动"
    } else {
        "暂停移动"
    };

    let mut builder = MenuBuilder::new(app)
        .text("toggle_pet", visibility_label)
        .text("toggle_pause", pause_label)
        .text("relocate_pet", "移回活动区域");

    if timer.is_running {
        let status = MenuItem::with_id(
            app,
            TRAY_TIMER_STATUS_ID,
            timer_status_label(&timer),
            false,
            None::<&str>,
        )
        .map_err(|err| err.to_string())?;
        remember_tray_timer_status(state, Some(status.clone()))?;
        builder = builder.item(&status).text("cancel_timer", "取消当前计时");
    } else {
        remember_tray_timer_status(state, None)?;
        let submenu = build_timer_submenu(app)?;
        builder = builder.item(&submenu);
    }

    builder = builder
        .separator()
        .text("open_remember", "记忆力")
        .text("remember_save_current_clipboard", "记住刚想到的")
        .separator()
        .text("open_settings", "设置")
        .text("quit", "退出");
    builder.build().map_err(|err| err.to_string())
}

fn build_pet_menu(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<Menu<tauri::Wry>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .clone();
    let timer = timer_snapshot(state);
    let pause_label = if settings.movement_paused {
        "恢复移动"
    } else {
        "暂停移动"
    };

    let mut builder = MenuBuilder::new(app);

    if timer.is_running {
        let status = MenuItem::with_id(
            app,
            PET_TIMER_STATUS_ID,
            timer_status_label(&timer),
            false,
            None::<&str>,
        )
        .map_err(|err| err.to_string())?;
        remember_pet_timer_status(state, Some(status.clone()))?;
        builder = builder
            .item(&status)
            .text("cancel_timer", "取消当前计时")
            .separator();
    } else {
        remember_pet_timer_status(state, None)?;
        let submenu = build_timer_submenu(app)?;
        builder = builder.item(&submenu).separator();
    }

    let remember_submenu = build_remember_reset_submenu(app, state)?;
    builder = builder
        .item(&remember_submenu)
        .separator()
        .text("toggle_pause", pause_label)
        .text("hide_pet", "隐藏");
    builder.build().map_err(|err| err.to_string())
}

fn build_timer_submenu(app: &AppHandle) -> Result<Submenu<tauri::Wry>, String> {
    SubmenuBuilder::new(app, "计时器")
        .text("start_timer_1", "1 分钟")
        .text("start_timer_5", "5 分钟")
        .text("start_timer_10", "10 分钟")
        .text("start_timer_25", "25 分钟")
        .build()
        .map_err(|err| err.to_string())
}

fn build_remember_reset_submenu(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<Submenu<tauri::Wry>, String> {
    let snapshot = {
        let remember_state = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember::snapshot(&remember_state)
    };
    let recent =
        build_remember_entries_submenu(app, "记忆中", "remember_recent_", &snapshot.recent)?;
    let notebook =
        build_remember_entries_submenu(app, "笔记本", "remember_notebook_", &snapshot.notebook)?;
    let variables =
        build_remember_variable_submenu(app, "变量", "remember_variable_", &snapshot.variables)?;
    SubmenuBuilder::new(app, "回忆")
        .item(&recent)
        .item(&notebook)
        .item(&variables)
        .build()
        .map_err(|err| err.to_string())
}

fn build_remember_entries_submenu(
    app: &AppHandle,
    label: &str,
    id_prefix: &str,
    entries: &[remember::RememberItemPayload],
) -> Result<Submenu<tauri::Wry>, String> {
    let mut builder = SubmenuBuilder::new(app, label);
    if entries.is_empty() {
        let item = MenuItem::with_id(
            app,
            format!("{id_prefix}empty"),
            "还没有",
            false,
            None::<&str>,
        )
        .map_err(|err| err.to_string())?;
        builder = builder.item(&item);
    } else {
        for entry in entries {
            let pinned_mark = if entry.pinned { "↑ " } else { "" };
            builder = builder.text(
                format!("{id_prefix}{}", entry.id),
                format!("{pinned_mark}{}", entry.preview),
            );
        }
    }
    builder.build().map_err(|err| err.to_string())
}

fn build_remember_variable_submenu(
    app: &AppHandle,
    label: &str,
    id_prefix: &str,
    entries: &[remember::RememberVariablePayload],
) -> Result<Submenu<tauri::Wry>, String> {
    let mut builder = SubmenuBuilder::new(app, label);
    if entries.is_empty() {
        let item = MenuItem::with_id(
            app,
            format!("{id_prefix}empty"),
            "还没有",
            false,
            None::<&str>,
        )
        .map_err(|err| err.to_string())?;
        builder = builder.item(&item);
    } else {
        for entry in entries {
            builder = builder.text(format!("{id_prefix}{}", entry.id), entry.key.clone());
        }
    }
    builder.build().map_err(|err| err.to_string())
}

fn timer_status_label(timer: &TimerSnapshot) -> String {
    format!("计时中：还剩 {}", format_remaining(timer.remaining_seconds))
}

fn remember_tray_timer_status(
    state: &tauri::State<'_, AppState>,
    item: Option<MenuItem<tauri::Wry>>,
) -> Result<(), String> {
    let mut items = state
        .menu_items
        .lock()
        .map_err(|_| "menu items lock poisoned")?;
    items.tray_timer_status = item;
    Ok(())
}

fn remember_pet_timer_status(
    state: &tauri::State<'_, AppState>,
    item: Option<MenuItem<tauri::Wry>>,
) -> Result<(), String> {
    let mut items = state
        .menu_items
        .lock()
        .map_err(|_| "menu items lock poisoned")?;
    items.pet_timer_status = item;
    Ok(())
}

fn clear_timer_menu_items(state: &tauri::State<'_, AppState>) {
    if let Ok(mut items) = state.menu_items.lock() {
        items.tray_timer_status = None;
        items.pet_timer_status = None;
    }
}

fn update_timer_menu_text(app: &AppHandle, timer: &TimerSnapshot) -> Result<(), String> {
    let Some(state) = app.try_state::<AppState>() else {
        return Ok(());
    };
    let (tray_item, pet_item) = {
        let items = state
            .menu_items
            .lock()
            .map_err(|_| "menu items lock poisoned")?;
        (
            items.tray_timer_status.clone(),
            items.pet_timer_status.clone(),
        )
    };
    let label = timer_status_label(timer);
    if let Some(item) = tray_item {
        item.set_text(&label).map_err(|err| err.to_string())?;
    }
    if let Some(item) = pet_item {
        item.set_text(&label).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn handle_menu_event(app: &AppHandle, event_id: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Some(id) = event_id.strip_prefix("remember_recent_") {
        if id != "empty" {
            let _ = remember_reset_clipboard_inner(app, &state, "recent", id);
        }
        return;
    }
    if let Some(id) = event_id.strip_prefix("remember_notebook_") {
        if id != "empty" {
            let _ = remember_reset_clipboard_inner(app, &state, "notebook", id);
        }
        return;
    }
    if let Some(id) = event_id.strip_prefix("remember_variable_") {
        if id != "empty" {
            let _ = remember_copy_variable_inner(app, &state, id);
        }
        return;
    }
    match event_id {
        "toggle_pet" => {
            let visible = state
                .settings
                .lock()
                .map(|settings| !settings.pet_visible)
                .unwrap_or(true);
            let _ = set_pet_visible_inner(app, &state, visible);
        }
        "hide_pet" => {
            let _ = set_pet_visible_inner(app, &state, false);
        }
        "toggle_pause" => {
            let paused = state
                .settings
                .lock()
                .map(|settings| !settings.movement_paused)
                .unwrap_or(false);
            {
                if let Ok(mut settings) = state.settings.lock() {
                    settings.movement_paused = paused;
                    let _ = save_settings(app, &settings);
                }
            }
            let _ = update_tray_menu(app);
            let _ = app.emit("deskmon-pause-changed", paused);
        }
        "relocate_pet" => {
            let _ = relocate_pet_to_activity_area(app, &state);
        }
        "open_settings" => {
            let _ = open_settings_window(app.clone());
        }
        "open_remember" => {
            let _ = open_remember_window(app.clone());
        }
        "remember_save_current_clipboard" => {
            remember_save_current_clipboard(app, &state);
        }
        "quit" => {
            app.exit(0);
        }
        "cancel_timer" => {
            if let Ok(mut timer) = state.timer.lock() {
                *timer = None;
            }
            clear_timer_menu_items(&state);
            let _ = update_tray_menu(app);
            let snapshot = timer_snapshot(&state);
            let _ = app.emit("deskmon-timer-changed", &snapshot);
        }
        "start_timer_1" => {
            let _ = start_timer_inner(app, &state, 1);
        }
        "start_timer_5" => {
            let _ = start_timer_inner(app, &state, 5);
        }
        "start_timer_10" => {
            let _ = start_timer_inner(app, &state, 10);
        }
        "start_timer_25" => {
            let _ = start_timer_inner(app, &state, 25);
        }
        _ => {}
    }
}

fn resize_and_place_pet_window(
    app: &AppHandle,
    position: Point,
    pet_dimensions: Dimensions,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW) {
        window
            .set_size(Size::Logical(LogicalSize::new(
                pet_dimensions.width,
                pet_dimensions.height,
            )))
            .map_err(|err| err.to_string())?;
        move_pet_window_to(app, position)?;
    }
    Ok(())
}

fn move_pet_window_to(app: &AppHandle, position: Point) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW) {
        window
            .set_position(Position::Physical(PhysicalPosition::new(
                position.x.round() as i32,
                position.y.round() as i32,
            )))
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn timer_snapshot(state: &tauri::State<'_, AppState>) -> TimerSnapshot {
    let timer = match state.timer.lock() {
        Ok(timer) => *timer,
        Err(_) => None,
    };
    timer.map_or_else(TimerSnapshot::idle, |timer| {
        let now = now_ms();
        let remaining_ms = timer.ends_at_ms.saturating_sub(now);
        TimerSnapshot {
            is_running: remaining_ms > 0,
            duration_seconds: timer.duration_seconds,
            remaining_seconds: remaining_ms.div_ceil(1000),
            ends_at_ms: Some(timer.ends_at_ms),
        }
    })
}

fn format_remaining(seconds: u64) -> String {
    let minutes = seconds / 60;
    let seconds = seconds % 60;
    format!("{minutes:02}:{seconds:02}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .setup(|app| {
            let loaded_settings = load_settings(app.handle());
            let loaded_remember = remember::load(app.handle());
            {
                let state = app.state::<AppState>();
                let mut settings = state.settings.lock().expect("settings lock poisoned");
                *settings = loaded_settings;
                let mut remember_state = state.remember.lock().expect("remember lock poisoned");
                *remember_state = loaded_remember;
            }

            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            create_pet_window(app)?;
            create_tray(app)?;

            app.on_menu_event(|app_handle, event| {
                handle_menu_event(app_handle, event.id().0.as_str());
            });

            spawn_clipboard_worker(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap,
            get_desktop_snapshot,
            get_pet_window_frame,
            move_pet_window,
            set_pet_temporary_presentation,
            persist_pet_position,
            save_user_preferences,
            show_pet_menu,
            get_remember_snapshot,
            open_remember,
            remember_reset_clipboard,
            remember_save_item,
            remember_forget_recent,
            remember_clear_recent,
            remember_forget_notebook,
            remember_set_notebook_pinned,
            remember_reset_notebook,
            remember_create_variable,
            remember_update_variable,
            remember_delete_variable,
            remember_copy_variable,
            remember_reveal_variable_value,
            remember_set_variable_clipboard_cleanup_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

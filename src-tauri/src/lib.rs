mod external_notification;
mod focus_session;
mod geometry;
mod remember;
mod screenshot;
mod settings;

use external_notification::{
    CliInstallationState, ExternalNotificationRequest, NotificationDisposition,
};
use focus_session::{
    CompletionFeedback, FocusSession, FocusSessionAction, FocusSessionConfig, FocusSessionPhase,
    FocusSessionSnapshot, TimerKind, EXTRA_SEGMENT_MINUTES,
};
use geometry::{
    clamp_to_visible_work_area, collect_monitors, default_activity_area, initial_pet_position,
    normalize_activity_area, pet_physical_dimensions, point_visible, Dimensions, MonitorPayload,
    Point, Rect,
};
use screenshot::ScreenshotCoordinator;
use serde::{Deserialize, Serialize};
use settings::{
    load_settings, normalize_focus_timer_preferences, normalize_screenshot_preferences,
    save_settings, FocusTimerPreferences, ScreenshotPreferences, Settings, UserPreferences,
};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItem, Submenu, SubmenuBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_notification::NotificationExt;

const PET_WINDOW: &str = "pet";
const SETTINGS_WINDOW: &str = "settings";
const REMEMBER_WINDOW: &str = "remember";
const SCREENSHOT_WINDOW_PREFIX: &str = "screenshot-";
const REMEMBER_WINDOW_WIDTH: f64 = 920.0;
const REMEMBER_WINDOW_HEIGHT: f64 = 620.0;
const REMEMBER_WINDOW_MIN_WIDTH: f64 = 780.0;
const REMEMBER_WINDOW_MIN_HEIGHT: f64 = 520.0;
const TRAY_ID: &str = "deskmon-tray";
const TRAY_ICON: &[u8] = include_bytes!("../assets/tray-icon.png");
const TRAY_TIMER_STATUS_ID: &str = "tray_timer_status";
const PET_TIMER_STATUS_ID: &str = "pet_timer_status";
const EXTERNAL_NOTIFICATION_EVENT: &str = "deskmon-external-notification";
const POSITION_SAVE_INTERVAL_MS: u64 = 5000;
const CLIPBOARD_POLL_INTERVAL_MS: u64 = 500;
const VARIABLE_CLIPBOARD_CLEANUP_SECONDS: u64 = 30;
#[cfg(target_os = "macos")]
const TIMER_SYSTEM_SOUND_PATH: &str = "/System/Library/Sounds/Glass.aiff";

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
    focus_session: FocusSessionSnapshot,
    screenshot_directory: String,
    cli_installation_state: CliInstallationState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowFramePayload {
    position: Point,
    size: Dimensions,
    cursor: Point,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusPresentationContext {
    monitors: Vec<MonitorPayload>,
    cursor: Point,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotCapturePayload {
    data_url: String,
    pixel_width: u32,
    pixel_height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotEditingPayload {
    owner_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotSavePayload {
    filename: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotSaveError {
    message: String,
    directory_unavailable: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotSelectionRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Default)]
struct AppState {
    settings: Mutex<Settings>,
    focus_session: Mutex<FocusSession>,
    remember: Mutex<remember::RememberState>,
    menu_items: Mutex<MenuItems>,
    last_position_saved_at_ms: Mutex<u64>,
    screenshot: ScreenshotCoordinator,
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
    let screenshot_directory = effective_screenshot_directory(&app, &settings)?;
    let settings_snapshot = settings.clone();
    drop(settings);

    let focus_session = focus_session_snapshot(&state);
    if !focus_session.phase.uses_central_presentation() {
        resize_and_place_pet_window(&app, position, pet_dimensions)?;
    }
    save_settings(&app, &settings_snapshot)?;

    Ok(BootstrapPayload {
        settings: settings_snapshot,
        monitors,
        activity_area,
        default_activity_area,
        pet_dimensions,
        pet_window_dimensions,
        pet_position: position,
        focus_session,
        screenshot_directory: screenshot_directory.to_string_lossy().into_owned(),
        cli_installation_state: external_notification::cli_installation_state(),
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
fn get_focus_presentation_context(app: AppHandle) -> Result<FocusPresentationContext, String> {
    let cursor = app.cursor_position().map_err(|err| err.to_string())?;
    Ok(FocusPresentationContext {
        monitors: collect_monitors(&app)?,
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
#[allow(clippy::too_many_arguments)]
fn set_pet_temporary_presentation(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    always_on_top: bool,
    visible: bool,
    ignore_cursor_events: Option<bool>,
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
        if let Some(ignore_cursor_events) = ignore_cursor_events {
            window
                .set_ignore_cursor_events(ignore_cursor_events)
                .map_err(|err| err.to_string())?;
        }
        if visible {
            window.show().map_err(|err| err.to_string())?;
        } else {
            window.hide().map_err(|err| err.to_string())?;
        }
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
        settings.focus_timer = normalize_focus_timer_preferences(preferences.focus_timer)?;
        settings.screenshot = normalize_screenshot_preferences(preferences.screenshot);
        settings.custom_activity_area = normalized_area;
        save_settings(&app, &settings)?;
    }

    let uses_central_presentation = state
        .focus_session
        .lock()
        .map(|session| session.phase().uses_central_presentation())
        .unwrap_or(false);
    if !uses_central_presentation {
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
    .inner_size(920.0, 720.0)
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
async fn choose_screenshot_directory(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = pick_screenshot_directory(&app)? else {
            return Ok(None);
        };
        screenshot::ensure_save_directory(&path)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn effective_screenshot_directory(app: &AppHandle, settings: &Settings) -> Result<PathBuf, String> {
    settings
        .screenshot
        .save_directory
        .as_ref()
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| app.path().desktop_dir().map_err(|error| error.to_string()))
}

fn pick_screenshot_directory(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    app.dialog()
        .file()
        .set_title("选择截图保存文件夹")
        .blocking_pick_folder()
        .map(|path| path.into_path().map_err(|error| error.to_string()))
        .transpose()
}

fn update_screenshot_directory(app: &AppHandle, directory: Option<&Path>) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or("app state is not available")?;
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?;
    settings.screenshot = ScreenshotPreferences {
        save_directory: directory.map(|path| path.to_string_lossy().into_owned()),
    };
    save_settings(app, &settings)?;
    drop(settings);
    let _ = app.emit("deskmon-settings-changed", ());
    Ok(())
}

fn start_region_screenshot(app: &AppHandle, state: &tauri::State<'_, AppState>) {
    if !screenshot::screen_capture_access_granted() {
        show_screenshot_permission_prompt(app);
        return;
    }
    if !state.screenshot.try_begin() {
        return;
    }
    let _ = app.emit("deskmon-screenshot-state-changed", true);
    if let Err(error) = create_screenshot_windows(app) {
        eprintln!("failed to create screenshot overlays: {error}");
        state.screenshot.finish();
        let _ = app.emit("deskmon-screenshot-state-changed", false);
        close_screenshot_windows(app);
        show_screenshot_failure_notification(app, &error);
    }
}

fn create_screenshot_windows(app: &AppHandle) -> Result<(), String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| error.to_string())?;
    if monitors.is_empty() {
        return Err("没有可用于截图的显示器".into());
    }
    let cursor = app.cursor_position().ok();
    let focus_index = cursor.and_then(|cursor| {
        monitors.iter().position(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            cursor.x >= position.x as f64
                && cursor.x < (position.x as f64 + size.width as f64)
                && cursor.y >= position.y as f64
                && cursor.y < (position.y as f64 + size.height as f64)
        })
    });

    for (index, monitor) in monitors.iter().enumerate() {
        let label = format!("{SCREENSHOT_WINDOW_PREFIX}{index}");
        let position = monitor.position();
        let size = monitor.size();
        let scale_factor = monitor.scale_factor();
        let logical_width = size.width as f64 / scale_factor;
        let logical_height = size.height as f64 / scale_factor;
        let window = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App(format!("index.html#screenshot?monitor={index}").into()),
        )
        .title("Deskmon 截图")
        .inner_size(logical_width, logical_height)
        .transparent(true)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .shadow(false)
        .focused(false)
        .accept_first_mouse(true)
        .content_protected(true)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;
        window
            .set_position(Position::Physical(PhysicalPosition::new(
                position.x, position.y,
            )))
            .map_err(|error| error.to_string())?;
        window
            .set_size(Size::Physical(PhysicalSize::new(size.width, size.height)))
            .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
    }

    let focus_label = format!(
        "{SCREENSHOT_WINDOW_PREFIX}{}",
        focus_index.unwrap_or_default()
    );
    if let Some(window) = app.get_webview_window(&focus_label) {
        let _ = window.set_focus();
    }
    Ok(())
}

fn close_screenshot_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(SCREENSHOT_WINDOW_PREFIX) {
            let _ = window.close();
        }
    }
}

fn finish_screenshot_task(app: &AppHandle, coordinator: &ScreenshotCoordinator) {
    coordinator.finish();
    close_screenshot_windows(app);
    let _ = app.emit("deskmon-screenshot-state-changed", false);
}

#[tauri::command]
fn screenshot_claim_selection(window_label: String, state: tauri::State<'_, AppState>) -> bool {
    window_label.starts_with(SCREENSHOT_WINDOW_PREFIX)
        && state.screenshot.claim_selection(&window_label)
}

#[tauri::command]
fn screenshot_release_selection(window_label: String, state: tauri::State<'_, AppState>) {
    state.screenshot.release_selection(&window_label);
}

#[tauri::command]
fn cancel_screenshot_task(app: AppHandle, state: tauri::State<'_, AppState>) {
    finish_screenshot_task(&app, &state.screenshot);
}

#[tauri::command]
async fn capture_screenshot_selection(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    window_label: String,
    rect: ScreenshotSelectionRect,
) -> Result<ScreenshotCapturePayload, String> {
    let coordinator = state.screenshot.clone();
    if !coordinator.is_owner(&window_label) {
        return Err("截图选区已失效".into());
    }
    let window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| "截图窗口已关闭".to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let region = screenshot::logical_capture_region(
        position.x,
        position.y,
        scale_factor,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
    )?;
    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    let event_payload = ScreenshotEditingPayload {
        owner_label: window_label.clone(),
    };
    let _ = app.emit("deskmon-screenshot-capturing", &event_payload);

    let captured = tauri::async_runtime::spawn_blocking(move || {
        screenshot::capture_region(&cache_directory, region)
    })
    .await
    .map_err(|error| error.to_string())?;

    match captured {
        Ok(captured) => {
            coordinator.mark_captured(&window_label, captured.captured_at.clone())?;
            let payload = ScreenshotCapturePayload {
                data_url: captured.data_url(),
                pixel_width: captured.pixel_width,
                pixel_height: captured.pixel_height,
            };
            let _ = app.emit("deskmon-screenshot-editing", event_payload);
            Ok(payload)
        }
        Err(error) => {
            eprintln!("failed to capture screenshot selection: {}", error.message);
            finish_screenshot_task(&app, &coordinator);
            if !screenshot::screen_capture_access_granted() {
                show_screenshot_permission_prompt(&app);
            } else {
                show_screenshot_failure_notification(&app, &error.message);
            }
            Err(error.message)
        }
    }
}

#[tauri::command]
async fn save_screenshot_png(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    png_base64: String,
) -> Result<ScreenshotSavePayload, ScreenshotSaveError> {
    let coordinator = state.screenshot.clone();
    let captured_at = coordinator
        .captured_at()
        .ok_or_else(|| ScreenshotSaveError {
            message: "截图编辑会话已失效".into(),
            directory_unavailable: false,
        })?;
    let settings = state
        .settings
        .lock()
        .map_err(|_| ScreenshotSaveError {
            message: "无法读取截图设置".into(),
            directory_unavailable: true,
        })?
        .clone();
    let directory =
        effective_screenshot_directory(&app, &settings).map_err(|message| ScreenshotSaveError {
            message,
            directory_unavailable: true,
        })?;

    let saved_path = tauri::async_runtime::spawn_blocking(move || {
        let bytes =
            screenshot::decode_png_base64(&png_base64).map_err(|message| ScreenshotSaveError {
                message,
                directory_unavailable: false,
            })?;
        screenshot::ensure_save_directory(&directory).map_err(|message| ScreenshotSaveError {
            message,
            directory_unavailable: true,
        })?;
        screenshot::write_screenshot_png(&directory, &captured_at, &bytes).map_err(|message| {
            ScreenshotSaveError {
                message,
                directory_unavailable: true,
            }
        })
    })
    .await
    .map_err(|error| ScreenshotSaveError {
        message: error.to_string(),
        directory_unavailable: false,
    })??;

    let filename = saved_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "PNG 图片".into());
    finish_screenshot_task(&app, &coordinator);
    let _ = app
        .notification()
        .builder()
        .title("截图已保存")
        .body(&filename)
        .show();
    Ok(ScreenshotSavePayload { filename })
}

#[tauri::command]
async fn repair_screenshot_directory(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    action: String,
) -> Result<Option<String>, String> {
    if !state.screenshot.is_active() {
        return Err("截图编辑会话已失效".into());
    }
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "choose" => {
            let Some(directory) = pick_screenshot_directory(&app)? else {
                return Ok(None);
            };
            screenshot::ensure_save_directory(&directory)?;
            update_screenshot_directory(&app, Some(&directory))?;
            Ok(Some(directory.to_string_lossy().into_owned()))
        }
        "desktop" => {
            update_screenshot_directory(&app, None)?;
            let state = app
                .try_state::<AppState>()
                .ok_or("app state is not available")?;
            let settings = state
                .settings
                .lock()
                .map_err(|_| "settings lock poisoned")?
                .clone();
            let directory = effective_screenshot_directory(&app, &settings)?;
            screenshot::ensure_save_directory(&directory)?;
            Ok(Some(directory.to_string_lossy().into_owned()))
        }
        _ => Err("未知的截图目录修复动作".into()),
    })
    .await
    .map_err(|error| error.to_string())?
}

fn show_screenshot_permission_prompt(app: &AppHandle) {
    let result = app
        .dialog()
        .message("Deskmon 需要屏幕录制权限才能进行区域截图。")
        .title("需要屏幕录制权限")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "打开系统设置".into(),
            "取消".into(),
        ))
        .blocking_show_with_result();
    if matches!(result, MessageDialogResult::Custom(label) if label == "打开系统设置") {
        #[cfg(target_os = "macos")]
        let _ = Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn();
    }
}

fn show_screenshot_failure_notification(app: &AppHandle, message: &str) {
    let _ = app
        .notification()
        .builder()
        .title("区域截图失败")
        .body(message)
        .show();
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

#[tauri::command]
fn focus_session_action(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    action: FocusSessionAction,
) -> Result<FocusSessionSnapshot, String> {
    perform_focus_session_action(&app, &state, action)
}

fn start_focus_round_inner(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    minutes: u64,
) -> Result<FocusSessionSnapshot, String> {
    let preferences = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .focus_timer
        .clone();
    let config = FocusSessionConfig {
        base_focus_minutes: minutes,
        break_minutes: preferences.break_minutes,
        focus_finished_message: preferences.focus_finished_message,
        break_finished_message: preferences.break_finished_message,
        break_sound_enabled: preferences.break_sound_enabled,
    };
    let (changed, snapshot, segment_id) = {
        let mut session = state
            .focus_session
            .lock()
            .map_err(|_| "focus session lock poisoned")?;
        let changed = session.start_round(config, now_ms());
        (
            changed,
            session.snapshot(now_ms()),
            session.active_segment_id(),
        )
    };
    if changed {
        publish_focus_session_change(app, state, &snapshot)?;
        if let Some(segment_id) = segment_id {
            spawn_focus_timer_worker(app.clone(), segment_id);
        }
    }
    Ok(snapshot)
}

fn perform_focus_session_action(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    action: FocusSessionAction,
) -> Result<FocusSessionSnapshot, String> {
    let (changed, snapshot, segment_id) = {
        let mut session = state
            .focus_session
            .lock()
            .map_err(|_| "focus session lock poisoned")?;
        let previous_segment_id = session.active_segment_id();
        let changed = session.apply_action(action, now_ms());
        let segment_id = session
            .active_segment_id()
            .filter(|segment_id| Some(*segment_id) != previous_segment_id);
        (changed, session.snapshot(now_ms()), segment_id)
    };
    if changed {
        publish_focus_session_change(app, state, &snapshot)?;
        if let Some(segment_id) = segment_id {
            spawn_focus_timer_worker(app.clone(), segment_id);
        }
    }
    Ok(snapshot)
}

fn publish_focus_session_change(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    snapshot: &FocusSessionSnapshot,
) -> Result<(), String> {
    clear_timer_menu_items(state);
    update_tray_menu(app)?;
    app.emit("deskmon-focus-session-changed", snapshot)
        .map_err(|err| err.to_string())
}

fn spawn_focus_timer_worker(app: AppHandle, segment_id: u64) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let Some(state) = app.try_state::<AppState>() else {
            break;
        };
        let snapshot = {
            let session = match state.focus_session.lock() {
                Ok(session) => session,
                Err(_) => break,
            };
            if session.active_segment_id() != Some(segment_id) {
                break;
            }
            session.snapshot(now_ms())
        };

        if snapshot.remaining_seconds > 0 {
            let _ = update_timer_menu_text(&app, &snapshot);
            let _ = app.emit("deskmon-focus-session-changed", &snapshot);
            continue;
        }

        let (feedback, completed_snapshot) = {
            let mut session = match state.focus_session.lock() {
                Ok(session) => session,
                Err(_) => break,
            };
            let feedback = session.complete_segment(segment_id);
            (feedback, session.snapshot(now_ms()))
        };
        if let Some(feedback) = feedback {
            let _ = publish_focus_session_change(&app, &state, &completed_snapshot);
            let _ = show_timer_finished_notification(&app, &feedback);
            play_timer_finished_sound(&feedback);
            let _ = app.emit("deskmon-focus-segment-finished", feedback.kind);
        }
        break;
    });
}

fn show_timer_finished_notification(
    app: &AppHandle,
    feedback: &CompletionFeedback,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title("Deskmon")
        .body(feedback.message.clone())
        .show()
        .map_err(|err| err.to_string())
}

fn play_timer_finished_sound(feedback: &CompletionFeedback) {
    if !feedback.play_sound {
        return;
    }

    #[cfg(target_os = "macos")]
    {
        thread::spawn(|| {
            let _ = Command::new("afplay").arg(TIMER_SYSTEM_SOUND_PATH).status();
        });
    }
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
    let focus_session = focus_session_snapshot(state);
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

    let mut builder = MenuBuilder::new(app);
    if !focus_session.phase.uses_central_presentation() {
        builder = builder
            .text("toggle_pet", visibility_label)
            .text("toggle_pause", pause_label)
            .text("relocate_pet", "移回活动区域");
    }

    builder = match focus_session.phase {
        FocusSessionPhase::Idle => {
            remember_tray_timer_status(state, None)?;
            builder.item(&build_focus_submenu(app, &settings.focus_timer)?)
        }
        FocusSessionPhase::FocusRunning | FocusSessionPhase::BreakRunning => {
            let status = MenuItem::with_id(
                app,
                TRAY_TIMER_STATUS_ID,
                timer_status_label(&focus_session),
                false,
                None::<&str>,
            )
            .map_err(|err| err.to_string())?;
            remember_tray_timer_status(state, Some(status.clone()))?;
            if focus_session.phase == FocusSessionPhase::FocusRunning {
                builder.item(&status).text("focus_cancel_round", "取消本轮")
            } else {
                builder
                    .item(&status)
                    .text("focus_finish_break_early", "提前结束休息")
                    .separator()
                    .text("end_round_and_hide", "结束本轮并隐藏宠物")
            }
        }
        FocusSessionPhase::FocusComplete => {
            remember_tray_timer_status(state, None)?;
            builder
                .text(
                    "focus_start_break",
                    format!(
                        "休息 {} 分钟",
                        focus_session
                            .break_minutes
                            .unwrap_or(settings.focus_timer.break_minutes)
                    ),
                )
                .text(
                    "focus_extend_focus",
                    format!("再专注 {EXTRA_SEGMENT_MINUTES} 分钟"),
                )
                .text("focus_end_round", "结束本轮")
                .separator()
                .text("end_round_and_hide", "结束本轮并隐藏宠物")
        }
        FocusSessionPhase::BreakComplete => {
            remember_tray_timer_status(state, None)?;
            builder
                .text(
                    "focus_resume",
                    format!(
                        "继续专注 {} 分钟",
                        focus_session.base_focus_minutes.unwrap_or(25)
                    ),
                )
                .text(
                    "focus_extend_break",
                    format!("再休息 {EXTRA_SEGMENT_MINUTES} 分钟"),
                )
                .text("focus_end_round", "结束本轮")
                .separator()
                .text("end_round_and_hide", "结束本轮并隐藏宠物")
        }
    };

    builder = builder
        .separator()
        .text("region_screenshot", "区域截图")
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
    let focus_session = focus_session_snapshot(state);
    let pause_label = if settings.movement_paused {
        "恢复移动"
    } else {
        "暂停移动"
    };

    let mut builder = MenuBuilder::new(app);

    builder = match focus_session.phase {
        FocusSessionPhase::Idle => {
            remember_pet_timer_status(state, None)?;
            builder
                .item(&build_focus_submenu(app, &settings.focus_timer)?)
                .separator()
        }
        FocusSessionPhase::FocusRunning | FocusSessionPhase::BreakRunning => {
            let status = MenuItem::with_id(
                app,
                PET_TIMER_STATUS_ID,
                timer_status_label(&focus_session),
                false,
                None::<&str>,
            )
            .map_err(|err| err.to_string())?;
            remember_pet_timer_status(state, Some(status.clone()))?;
            if focus_session.phase == FocusSessionPhase::FocusRunning {
                builder
                    .item(&status)
                    .text("focus_cancel_round", "取消本轮")
                    .separator()
            } else {
                builder
                    .item(&status)
                    .text("focus_finish_break_early", "提前结束休息")
                    .text("end_round_and_hide", "结束本轮并隐藏宠物")
                    .separator()
            }
        }
        FocusSessionPhase::FocusComplete => {
            remember_pet_timer_status(state, None)?;
            builder
                .text(
                    "focus_start_break",
                    format!(
                        "休息 {} 分钟",
                        focus_session
                            .break_minutes
                            .unwrap_or(settings.focus_timer.break_minutes)
                    ),
                )
                .text(
                    "focus_extend_focus",
                    format!("再专注 {EXTRA_SEGMENT_MINUTES} 分钟"),
                )
                .text("focus_end_round", "结束本轮")
                .text("end_round_and_hide", "结束本轮并隐藏宠物")
                .separator()
        }
        FocusSessionPhase::BreakComplete => {
            remember_pet_timer_status(state, None)?;
            builder
                .text(
                    "focus_resume",
                    format!(
                        "继续专注 {} 分钟",
                        focus_session.base_focus_minutes.unwrap_or(25)
                    ),
                )
                .text(
                    "focus_extend_break",
                    format!("再休息 {EXTRA_SEGMENT_MINUTES} 分钟"),
                )
                .text("focus_end_round", "结束本轮")
                .text("end_round_and_hide", "结束本轮并隐藏宠物")
                .separator()
        }
    };

    builder = builder.text("region_screenshot", "区域截图").separator();
    let remember_submenu = build_remember_reset_submenu(app, state)?;
    builder = builder.item(&remember_submenu).separator();
    if !focus_session.phase.uses_central_presentation() {
        builder = builder
            .text("toggle_pause", pause_label)
            .text("hide_pet", "隐藏");
    }
    builder.build().map_err(|err| err.to_string())
}

fn build_focus_submenu(
    app: &AppHandle,
    focus_timer: &FocusTimerPreferences,
) -> Result<Submenu<tauri::Wry>, String> {
    let mut builder = SubmenuBuilder::new(app, "专注计时");
    for (index, minutes) in focus_timer.focus_minutes.iter().enumerate() {
        builder = builder.text(
            format!("start_focus_timer_{index}"),
            format!("专注 {minutes} 分钟"),
        );
    }
    builder.build().map_err(|err| err.to_string())
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

fn timer_status_label(focus_session: &FocusSessionSnapshot) -> String {
    let label = match focus_session.kind {
        Some(TimerKind::Focus) => "专注中",
        Some(TimerKind::Break) => "休息中",
        None => "计时中",
    };
    format!(
        "{label}：还剩 {}",
        format_remaining(focus_session.remaining_seconds)
    )
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

fn update_timer_menu_text(
    app: &AppHandle,
    focus_session: &FocusSessionSnapshot,
) -> Result<(), String> {
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
    let label = timer_status_label(focus_session);
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
    if let Some(index) = event_id.strip_prefix("start_focus_timer_") {
        if let Ok(index) = index.parse::<usize>() {
            let minutes = state
                .settings
                .lock()
                .ok()
                .and_then(|settings| settings.focus_timer.focus_minutes.get(index).copied());
            if let Some(minutes) = minutes {
                let _ = start_focus_round_inner(app, &state, minutes);
            }
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
        "region_screenshot" => {
            start_region_screenshot(app, &state);
        }
        "quit" => {
            app.exit(0);
        }
        "focus_cancel_round" => {
            let _ = perform_focus_session_action(app, &state, FocusSessionAction::CancelRound);
        }
        "focus_start_break" => {
            let _ = perform_focus_session_action(app, &state, FocusSessionAction::StartBreak);
        }
        "focus_extend_focus" => {
            let _ = perform_focus_session_action(app, &state, FocusSessionAction::ExtendFocus);
        }
        "focus_finish_break_early" => {
            let _ = perform_focus_session_action(app, &state, FocusSessionAction::FinishBreakEarly);
        }
        "focus_resume" => {
            let _ = perform_focus_session_action(app, &state, FocusSessionAction::ResumeFocus);
        }
        "focus_extend_break" => {
            let _ = perform_focus_session_action(app, &state, FocusSessionAction::ExtendBreak);
        }
        "focus_end_round" => {
            let _ = perform_focus_session_action(app, &state, FocusSessionAction::EndRound);
        }
        "end_round_and_hide" => {
            let _ = perform_focus_session_action(app, &state, FocusSessionAction::EndRound);
            let _ = set_pet_visible_inner(app, &state, false);
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

fn focus_session_snapshot(state: &tauri::State<'_, AppState>) -> FocusSessionSnapshot {
    state
        .focus_session
        .lock()
        .map(|session| session.snapshot(now_ms()))
        .unwrap_or_else(|_| FocusSession::default().snapshot(now_ms()))
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

fn publish_external_notification(
    app: &AppHandle,
    request: ExternalNotificationRequest,
) -> Result<NotificationDisposition, String> {
    if request.text.trim().is_empty() {
        return Ok(NotificationDisposition::Ignored);
    }
    let state = app
        .try_state::<AppState>()
        .ok_or("app state is not available")?;
    let visible = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .pet_visible;
    if !visible {
        return Ok(NotificationDisposition::Ignored);
    }
    if app.get_webview_window(PET_WINDOW).is_none() {
        return Err("pet window is not available".into());
    }
    app.emit_to(PET_WINDOW, EXTERNAL_NOTIFICATION_EVENT, request)
        .map_err(|error| error.to_string())?;
    Ok(NotificationDisposition::Accepted)
}

#[tauri::command]
fn get_cli_installation_state() -> CliInstallationState {
    external_notification::cli_installation_state()
}

#[tauri::command]
async fn set_cli_installed(
    app: AppHandle,
    installed: bool,
) -> Result<CliInstallationState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if installed {
            external_notification::install_cli()
        } else {
            external_notification::uninstall_cli()
        }
    })
    .await
    .map_err(|error| error.to_string())??;

    if installed {
        let _ = publish_external_notification(
            &app,
            ExternalNotificationRequest {
                title: Some("Deskmon".into()),
                text: "命令行工具已安装".into(),
            },
        );
    }
    Ok(external_notification::cli_installation_state())
}

pub fn run_cli_if_requested() -> Option<i32> {
    external_notification::run_cli_if_requested()
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
            if let Ok(cache_directory) = app.path().app_cache_dir() {
                screenshot::cleanup_cache(&cache_directory);
            }
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

            let notification_app = app.handle().clone();
            external_notification::spawn_notification_server(move |request| {
                publish_external_notification(&notification_app, request)
            })?;

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
            get_focus_presentation_context,
            move_pet_window,
            set_pet_temporary_presentation,
            persist_pet_position,
            save_user_preferences,
            get_cli_installation_state,
            set_cli_installed,
            choose_screenshot_directory,
            screenshot_claim_selection,
            screenshot_release_selection,
            capture_screenshot_selection,
            save_screenshot_png,
            repair_screenshot_directory,
            cancel_screenshot_task,
            show_pet_menu,
            focus_session_action,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timer_status_label_matches_focus_and_break_modes() {
        let focus = FocusSessionSnapshot {
            phase: FocusSessionPhase::FocusRunning,
            is_running: true,
            kind: Some(TimerKind::Focus),
            duration_seconds: 1500,
            remaining_seconds: 754,
            ends_at_ms: Some(1),
            base_focus_minutes: Some(25),
            break_minutes: Some(5),
        };
        assert_eq!(timer_status_label(&focus), "专注中：还剩 12:34");

        let break_timer = FocusSessionSnapshot {
            phase: FocusSessionPhase::BreakRunning,
            kind: Some(TimerKind::Break),
            remaining_seconds: 62,
            ..focus
        };
        assert_eq!(timer_status_label(&break_timer), "休息中：还剩 01:02");
    }
}

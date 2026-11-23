mod countdown;
mod external_notification;
mod geometry;
mod global_shortcuts;
#[cfg(target_os = "macos")]
mod memory_chain_paste;
mod remember;
mod screenshot;
mod settings;

use countdown::{Countdown, CountdownSnapshot};
use external_notification::{
    CliInstallationState, ExternalNotificationRequest, NotificationDisposition,
};
use geometry::{
    clamp_to_visible_work_area, collect_monitors, default_activity_area, initial_pet_position,
    normalize_activity_area, pet_physical_dimensions, point_visible, Dimensions, MonitorPayload,
    Point, Rect,
};
use screenshot::ScreenshotCoordinator;
use global_shortcuts::ScreenshotShortcutStatus;
use serde::{Deserialize, Serialize};
use settings::{
    apply_preferences_patch, load_settings, save_settings, Settings, UserPreferencesPatch,
};
use std::{
    path::{Path, PathBuf},
    process::Command,
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
const PET_NOTIFICATION_EVENT: &str = "deskmon-pet-notification";
const POSITION_SAVE_INTERVAL_MS: u64 = 5000;
const CLIPBOARD_POLL_INTERVAL_MS: u64 = 500;

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
    countdown: CountdownSnapshot,
    screenshot_directory: String,
    screenshot_shortcut_status: ScreenshotShortcutStatus,
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
struct PreferencesSavePayload {
    settings: Settings,
    screenshot_directory: String,
    screenshot_shortcut_status: ScreenshotShortcutStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotSaveError {
    message: String,
    directory_unavailable: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum PetNotificationTone {
    Normal,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetNotificationPayload {
    title: Option<String>,
    text: String,
    tone: PetNotificationTone,
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
    countdown: Mutex<Countdown>,
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
    bootstrap_snapshot(app, state, true)
}

fn bootstrap_snapshot(app: AppHandle, state: tauri::State<'_, AppState>, persist: bool) -> Result<BootstrapPayload, String> {
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

    let countdown = countdown_snapshot(&state);
    resize_and_place_pet_window(&app, position, pet_dimensions)?;
    if persist { save_settings(&app, &settings_snapshot)?; }

    Ok(BootstrapPayload {
        settings: settings_snapshot,
        monitors,
        activity_area,
        default_activity_area,
        pet_dimensions,
        pet_window_dimensions,
        pet_position: position,
        countdown,
        screenshot_directory: screenshot_directory.to_string_lossy().into_owned(),
        screenshot_shortcut_status: global_shortcuts::screenshot_shortcut_status(&app),
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
async fn save_user_preferences(
    app: AppHandle,
    preferences: UserPreferencesPatch,
) -> Result<PreferencesSavePayload, String> {
    global_shortcuts::on_main_thread(app, move |app| {
        save_user_preferences_inner(app.clone(), app.state::<AppState>(), preferences)
    }).await
}

fn save_user_preferences_inner(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    preferences: UserPreferencesPatch,
) -> Result<PreferencesSavePayload, String> {
    let shortcut_touched = preferences.screenshot.as_ref().is_some_and(|patch| patch.shortcut.is_some());
    let current = state.settings.lock().map_err(|_| "settings lock poisoned")?.clone();
    let mut candidate = apply_preferences_patch(&current, preferences)?;
    let monitors = collect_monitors(&app)?;
    let default_area = default_activity_area(&monitors);
    let pet_dimensions = candidate.pet_size.logical_dimensions();
    let pet_window_dimensions = pet_physical_dimensions(pet_dimensions, &monitors, None);
    candidate.custom_activity_area = candidate
        .custom_activity_area
        .and_then(|area| normalize_activity_area(area, default_area, pet_window_dimensions));

    if shortcut_touched {
        candidate.screenshot.shortcut = global_shortcuts::validate_screenshot_shortcut(candidate.screenshot.shortcut.as_deref())?.map(|key| key.into_string());
    }
    let screenshot_directory = effective_screenshot_directory(&app, &candidate)?.to_string_lossy().into_owned();
    let persist = || {
        // Acquire the settings lock before replacing the file, so committing memory
        // cannot subsequently fail after the atomic disk replacement.
        let mut settings = state.settings.lock().map_err(|_| "settings lock poisoned")?;
        save_settings(&app, &candidate)?;
        *settings = candidate.clone();
        Ok(())
    };
    if shortcut_touched {
        global_shortcuts::update_screenshot_shortcut(&app, candidate.screenshot.shortcut.as_deref(), persist)?;
    } else { persist()?; }

    if let Some(window) = app.get_webview_window(PET_WINDOW) {
        if let Err(error) = window.set_always_on_top(candidate.always_on_top).and_then(|_| window.set_size(Size::Logical(LogicalSize::new(
                pet_dimensions.width,
                pet_dimensions.height,
            )))) { eprintln!("preferences saved; pet projection failed: {error}"); }
    }
    if let Err(error) = update_tray_menu(&app) { eprintln!("preferences saved; tray refresh failed: {error}"); }
    let _ = app.emit("deskmon-settings-changed", ());
    Ok(PreferencesSavePayload { settings: candidate, screenshot_directory, screenshot_shortcut_status: global_shortcuts::screenshot_shortcut_status(&app) })
}

#[tauri::command]
fn get_saved_preferences(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<PreferencesSavePayload, String> {
    let settings = state.settings.lock().map_err(|_| "settings lock poisoned")?.clone();
    let screenshot_directory = effective_screenshot_directory(&app, &settings)?.to_string_lossy().into_owned();
    Ok(PreferencesSavePayload { settings, screenshot_directory, screenshot_shortcut_status: global_shortcuts::screenshot_shortcut_status(&app) })
}

#[tauri::command]
async fn set_screenshot_shortcut_recording(app: AppHandle, window: WebviewWindow, recording: bool) -> Result<ScreenshotShortcutStatus, String> {
    if window.label() != SETTINGS_WINDOW { return Err("仅可在设置窗口录入快捷键".into()); }
    global_shortcuts::on_main_thread(app, move |app| {
        if recording && (!window.is_focused().unwrap_or(false) || app.get_webview_window(SETTINGS_WINDOW).is_none()) {
            return Err("设置窗口已失去焦点，请重新录入".into());
        }
        global_shortcuts::set_screenshot_shortcut_recording(&app, recording)
    }).await
}

fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        return show_window_in_front(&window);
    }

    let window = WebviewWindowBuilder::new(
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
    show_window_in_front(&window)
}

fn open_remember_window(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        memory_chain_paste::remember_foreground_app();
        memory_chain_paste::cancel(None);
    }
    if let Some(window) = app.get_webview_window(REMEMBER_WINDOW) {
        ensure_remember_window_size(&window)?;
        return show_window_in_front(&window);
    }

    let window = WebviewWindowBuilder::new(
        &app,
        REMEMBER_WINDOW,
        WebviewUrl::App("index.html#remember".into()),
    )
    .title("回忆")
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
    #[cfg(target_os = "macos")]
    memory_chain_paste::remember_foreground_app();
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
    let mut candidate = settings.clone();
    candidate.screenshot.save_directory = directory.map(|path| path.to_string_lossy().into_owned());
    save_settings(app, &candidate)?;
    *settings = candidate;
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
    let _ = dispatch_pet_notification(
        &app,
        Some("截图已保存".into()),
        filename.clone(),
        PetNotificationTone::Normal,
    );
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
    let _ = dispatch_pet_notification(
        app,
        Some("区域截图失败".into()),
        message.into(),
        PetNotificationTone::Error,
    );
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
fn remember_copy_recent(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<remember::RememberSnapshot, String> {
    remember_copy_recent_inner(&app, &state, &id)
}

#[tauri::command]
fn remember_forget_recent(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<remember::RememberSnapshot, String> {
    let snapshot = {
        let mut remember = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember.forget_recent(&id);
        remember::snapshot(&remember)
    };
    emit_remember_changed(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
fn remember_save_chain(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: Option<String>,
    name: String,
    note: Option<String>,
    values: Vec<String>,
) -> Result<remember::RememberSnapshot, String> {
    let (saved_id, snapshot) = {
        let mut remember = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        let saved_id = remember.save_chain(&app, id.as_deref(), name, note, values)?;
        (saved_id, remember::snapshot(&remember))
    };
    #[cfg(target_os = "macos")]
    memory_chain_paste::cancel(Some(&saved_id));
    emit_remember_changed(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
fn remember_set_chain_pinned(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<remember::RememberSnapshot, String> {
    let snapshot = {
        let mut remember = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember.set_chain_pinned(&app, &id, pinned)?;
        remember::snapshot(&remember)
    };
    emit_remember_changed(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
async fn remember_delete_chain(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<remember::RememberSnapshot, String> {
    let name = state
        .remember
        .lock()
        .map_err(|_| "remember lock poisoned")?
        .chain_name(&id)?
        .to_owned();
    let confirmed = confirm_dialog(
        app.clone(),
        "删除记忆链",
        format!("要删除“{name}”吗？"),
        "删除",
    )
    .await?;
    restore_remember_window_focus(&app);
    if !confirmed {
        return get_remember_snapshot(state);
    }

    let snapshot = {
        let mut remember = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember.delete_chain(&app, &id)?;
        remember::snapshot(&remember)
    };
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(move || memory_chain_paste::cancel(Some(&id)));
    emit_remember_changed(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
async fn remember_reset_chains(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<remember::RememberSnapshot, String> {
    let confirmed =
        confirm_dialog(app.clone(), "重置记忆链", "所有记忆链都会被清空。", "重置").await?;
    restore_remember_window_focus(&app);
    if !confirmed {
        return get_remember_snapshot(state);
    }
    let snapshot = {
        let mut remember = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember.reset_chains(&app)?;
        remember::snapshot(&remember)
    };
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(|| memory_chain_paste::cancel(None));
    emit_remember_changed(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
fn remember_use_chain(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    remember_use_chain_inner(&app, &state, id)?;
    if let Some(window) = app.get_webview_window(REMEMBER_WINDOW) {
        if let Err(error) = window.hide() {
            #[cfg(target_os = "macos")]
            memory_chain_paste::cancel(None);
            return Err(error.to_string());
        }
    }
    #[cfg(target_os = "macos")]
    memory_chain_paste::restore_foreground_app();
    Ok(())
}

#[tauri::command]
fn remember_chain_values(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<String>, String> {
    state
        .remember
        .lock()
        .map_err(|_| "remember lock poisoned")?
        .chain_values(&id)
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

fn start_countdown_inner(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<CountdownSnapshot, String> {
    let minutes = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .countdown
        .minutes;
    let (countdown_id, snapshot) = {
        let mut countdown = state
            .countdown
            .lock()
            .map_err(|_| "countdown lock poisoned")?;
        let countdown_id = countdown.start(minutes, now_ms());
        (countdown_id, countdown.snapshot(now_ms()))
    };
    if let Some(countdown_id) = countdown_id {
        publish_countdown_change(app, state, &snapshot)?;
        spawn_countdown_worker(app.clone(), countdown_id);
    }
    Ok(snapshot)
}

fn cancel_countdown_inner(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<CountdownSnapshot, String> {
    let (changed, snapshot) = {
        let mut countdown = state
            .countdown
            .lock()
            .map_err(|_| "countdown lock poisoned")?;
        let changed = countdown.cancel();
        (changed, countdown.snapshot(now_ms()))
    };
    if changed {
        publish_countdown_change(app, state, &snapshot)?;
    }
    Ok(snapshot)
}

fn publish_countdown_change(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    snapshot: &CountdownSnapshot,
) -> Result<(), String> {
    clear_timer_menu_items(state);
    update_tray_menu(app)?;
    app.emit("deskmon-countdown-changed", snapshot)
        .map_err(|err| err.to_string())
}

fn spawn_countdown_worker(app: AppHandle, countdown_id: u64) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let Some(state) = app.try_state::<AppState>() else {
            break;
        };
        let snapshot = {
            let countdown = match state.countdown.lock() {
                Ok(countdown) => countdown,
                Err(_) => break,
            };
            if countdown.active_id() != Some(countdown_id) {
                break;
            }
            countdown.snapshot(now_ms())
        };

        if snapshot.remaining_seconds > 0 {
            let _ = update_timer_menu_text(&app, &snapshot);
            let _ = app.emit("deskmon-countdown-changed", &snapshot);
            continue;
        }

        let (completed_minutes, completed_snapshot) = {
            let mut countdown = match state.countdown.lock() {
                Ok(countdown) => countdown,
                Err(_) => break,
            };
            let minutes = countdown.complete(countdown_id);
            (minutes, countdown.snapshot(now_ms()))
        };
        if let Some(minutes) = completed_minutes {
            let _ = publish_countdown_change(&app, &state, &completed_snapshot);
            let _ = dispatch_pet_notification(
                &app,
                Some("Deskmon".into()),
                format!("{minutes} 分钟倒计时结束啦"),
                PetNotificationTone::Normal,
            );
        }
        break;
    });
}

fn spawn_clipboard_worker(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        poll_remember_clipboard(&app);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(CLIPBOARD_POLL_INTERVAL_MS));
            let poll_app = app.clone();
            if app
                .run_on_main_thread(move || poll_remember_clipboard(&poll_app))
                .is_err()
            {
                break;
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    thread::spawn(move || {
        let Ok(mut clipboard) = arboard::Clipboard::new() else {
            return;
        };
        let mut initialized = false;
        loop {
            let Some(state) = app.try_state::<AppState>() else {
                break;
            };
            let text = clipboard.get_text().ok();
            let snapshot = {
                let Ok(mut remember) = state.remember.lock() else {
                    break;
                };
                observe_remember_clipboard(&mut remember, text, initialized)
            };
            if let Some(snapshot) = snapshot {
                emit_remember_changed(&app, &snapshot);
            }
            initialized = true;
            thread::sleep(Duration::from_millis(CLIPBOARD_POLL_INTERVAL_MS));
        }
    });
}

#[cfg(target_os = "macos")]
fn poll_remember_clipboard(app: &AppHandle) {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};

    let board = NSPasteboard::generalPasteboard();
    if memory_chain_paste::poll_clipboard(&board) {
        return;
    }
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let snapshot = {
        let Ok(mut remember) = state.remember.lock() else {
            return;
        };
        let revision = board.changeCount();
        if remember.clipboard_revision == Some(revision) {
            return;
        }
        let text = board
            .stringForType(unsafe { NSPasteboardTypeString })
            .map(|text| text.to_string());
        if board.changeCount() != revision {
            return;
        }
        let initialized = remember.clipboard_revision.replace(revision).is_some();
        observe_remember_clipboard(&mut remember, text, initialized)
    };
    if let Some(snapshot) = snapshot {
        emit_remember_changed(app, &snapshot);
    }
}

fn observe_remember_clipboard(
    remember: &mut remember::RememberState,
    text: Option<String>,
    initialized: bool,
) -> Option<remember::RememberSnapshot> {
    let Some((text, truncated)) = text.as_deref().and_then(remember::normalize_text) else {
        remember.last_clipboard_text = None;
        return None;
    };
    if remember.last_clipboard_text.as_deref() == Some(text.as_str()) {
        return None;
    }
    remember.last_clipboard_text = Some(text.clone());
    if !initialized {
        return None;
    }
    remember.push_recent(text, truncated);
    Some(remember::snapshot(remember))
}

fn remember_copy_recent_inner(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    id: &str,
) -> Result<remember::RememberSnapshot, String> {
    #[cfg(target_os = "macos")]
    memory_chain_paste::cancel(None);
    let snapshot = {
        let mut remember = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        let entry = remember
            .recent
            .iter()
            .find(|entry| entry.id == id)
            .ok_or("没有找到这条记忆")?;
        let (text, truncated) = (entry.text.clone(), entry.truncated);
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(text.clone()))
            .map_err(|error| error.to_string())?;
        remember.last_clipboard_text = Some(text.clone());
        remember.push_recent(text, truncated);
        remember::snapshot(&remember)
    };
    emit_remember_changed(app, &snapshot);
    Ok(snapshot)
}

fn remember_use_chain_inner(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let values = state
        .remember
        .lock()
        .map_err(|_| "remember lock poisoned")?
        .chain_values(&id)?;
    #[cfg(target_os = "macos")]
    {
        memory_chain_paste::start(app.clone(), id, values)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id, values);
        Err("此平台暂不支持顺序粘贴".into())
    }
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
    let countdown = countdown_snapshot(state);
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

    if countdown.is_running {
        let status = MenuItem::with_id(
            app,
            TRAY_TIMER_STATUS_ID,
            timer_status_label(&countdown),
            false,
            None::<&str>,
        )
        .map_err(|err| err.to_string())?;
        remember_tray_timer_status(state, Some(status.clone()))?;
        builder = builder.item(&status).text("cancel_countdown", "取消倒计时");
    } else {
        remember_tray_timer_status(state, None)?;
        builder = builder.text(
            "start_countdown",
            format!("{} 分钟倒计时", settings.countdown.minutes),
        );
    }

    builder = builder
        .separator()
        .text("region_screenshot", "区域截图")
        .separator()
        .text("open_remember", "回忆")
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
    let countdown = countdown_snapshot(state);
    let pause_label = if settings.movement_paused {
        "恢复移动"
    } else {
        "暂停移动"
    };

    let mut builder = MenuBuilder::new(app);
    if countdown.is_running {
        let status = MenuItem::with_id(
            app,
            PET_TIMER_STATUS_ID,
            timer_status_label(&countdown),
            false,
            None::<&str>,
        )
        .map_err(|err| err.to_string())?;
        remember_pet_timer_status(state, Some(status.clone()))?;
        builder = builder
            .item(&status)
            .text("cancel_countdown", "取消倒计时")
            .separator();
    } else {
        remember_pet_timer_status(state, None)?;
        builder = builder
            .text(
                "start_countdown",
                format!("{} 分钟倒计时", settings.countdown.minutes),
            )
            .separator();
    }

    builder = builder.text("region_screenshot", "区域截图").separator();
    let remember_submenu = build_remember_reset_submenu(app, state)?;
    builder = builder.item(&remember_submenu).separator();
    builder = builder
        .text("toggle_pause", pause_label)
        .text("hide_pet", "隐藏");
    builder.build().map_err(|err| err.to_string())
}

fn build_remember_reset_submenu(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<Submenu<tauri::Wry>, String> {
    let snapshot = {
        let remember = state
            .remember
            .lock()
            .map_err(|_| "remember lock poisoned")?;
        remember::snapshot(&remember)
    };
    let mut builder = SubmenuBuilder::new(app, "回忆");
    for chain in snapshot.chains {
        let pinned = if chain.pinned { "↑ " } else { "" };
        builder = builder.text(
            format!("remember_chain_{}", chain.id),
            format!("{pinned}{}", chain.name),
        );
    }
    if !snapshot.recent.is_empty() {
        let mut recent = SubmenuBuilder::new(app, "记忆中");
        for entry in snapshot.recent {
            recent = recent.text(format!("remember_recent_{}", entry.id), entry.preview);
        }
        let recent = recent.build().map_err(|error| error.to_string())?;
        builder = builder.separator().item(&recent);
    }
    builder
        .text("open_remember", "打开回忆…")
        .build()
        .map_err(|error| error.to_string())
}

fn timer_status_label(countdown: &CountdownSnapshot) -> String {
    format!("倒计时：{}", format_remaining(countdown.remaining_seconds))
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

fn update_timer_menu_text(app: &AppHandle, countdown: &CountdownSnapshot) -> Result<(), String> {
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
    let label = timer_status_label(countdown);
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
        let _ = remember_copy_recent_inner(app, &state, id);
        return;
    }
    if let Some(id) = event_id.strip_prefix("remember_chain_") {
        if let Err(error) = remember_use_chain(app.clone(), state, id.to_owned()) {
            let _ = dispatch_pet_notification(
                app,
                Some("记忆链".into()),
                error,
                PetNotificationTone::Error,
            );
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
        "region_screenshot" => {
            start_region_screenshot(app, &state);
        }
        "quit" => {
            #[cfg(target_os = "macos")]
            memory_chain_paste::cancel(None);
            app.exit(0);
        }
        "start_countdown" => {
            let _ = start_countdown_inner(app, &state);
        }
        "cancel_countdown" => {
            let _ = cancel_countdown_inner(app, &state);
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

fn countdown_snapshot(state: &tauri::State<'_, AppState>) -> CountdownSnapshot {
    state
        .countdown
        .lock()
        .map(|countdown| countdown.snapshot(now_ms()))
        .unwrap_or_else(|_| Countdown::default().snapshot(now_ms()))
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
    dispatch_pet_notification(
        app,
        request.title,
        request.text,
        PetNotificationTone::Normal,
    )?;
    Ok(NotificationDisposition::Accepted)
}

fn dispatch_pet_notification(
    app: &AppHandle,
    title: Option<String>,
    text: String,
    tone: PetNotificationTone,
) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or("app state is not available")?;
    let visible = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .pet_visible;
    if !visible {
        return app
            .notification()
            .builder()
            .title(title.clone().unwrap_or_else(|| "Deskmon".into()))
            .body(text)
            .show()
            .map_err(|error| error.to_string());
    }
    if app.get_webview_window(PET_WINDOW).is_none() {
        return Err("pet window is not available".into());
    }
    app.emit_to(
        PET_WINDOW,
        PET_NOTIFICATION_EVENT,
        PetNotificationPayload { title, text, tone },
    )
    .map_err(|error| error.to_string())?;
    Ok(())
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(global_shortcuts::GlobalShortcuts::default())
        .manage(AppState::default())
        .setup(|app| {
            let loaded_settings = load_settings(app.handle());
            let loaded_remember = remember::load(app.handle());
            if let Ok(cache_directory) = app.path().app_cache_dir() {
                screenshot::cleanup_cache(&cache_directory);
            }
            let screenshot_shortcut = loaded_settings.screenshot.shortcut.clone();
            {
                let state = app.state::<AppState>();
                let mut settings = state.settings.lock().expect("settings lock poisoned");
                *settings = loaded_settings;
                let mut remember_state = state.remember.lock().expect("remember lock poisoned");
                *remember_state = loaded_remember;
            }
            global_shortcuts::restore_screenshot_shortcut(app.handle(), screenshot_shortcut.as_deref());

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
        .on_window_event(|window, event| {
            if window.label() == SETTINGS_WINDOW && matches!(event, tauri::WindowEvent::Destroyed | tauri::WindowEvent::Focused(false)) {
                if let Err(error) = global_shortcuts::set_screenshot_shortcut_recording(window.app_handle(), false) {
                    eprintln!("failed to restore screenshot shortcut: {error}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap,
            get_desktop_snapshot,
            get_pet_window_frame,
            move_pet_window,
            set_pet_temporary_presentation,
            persist_pet_position,
            save_user_preferences,
            get_saved_preferences,
            set_screenshot_shortcut_recording,
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
            get_remember_snapshot,
            remember_copy_recent,
            remember_forget_recent,
            remember_save_chain,
            remember_set_chain_pinned,
            remember_delete_chain,
            remember_reset_chains,
            remember_use_chain,
            remember_chain_values
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timer_status_label_matches_countdown_format() {
        let countdown = CountdownSnapshot {
            is_running: true,
            minutes: Some(30),
            duration_seconds: 1500,
            remaining_seconds: 754,
            ends_at_ms: Some(1),
        };
        assert_eq!(timer_status_label(&countdown), "倒计时：12:34");
    }
}

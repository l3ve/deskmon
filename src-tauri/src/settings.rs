use crate::geometry::{Dimensions, Point, Rect};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";
pub(crate) const TIMER_MIN_MINUTES: u64 = 1;
pub(crate) const TIMER_MAX_MINUTES: u64 = 180;
const DEFAULT_FOCUS_MINUTES: [u64; 3] = [5, 25, 45];
const DEFAULT_BREAK_MINUTES: u64 = 5;
const DEFAULT_FOCUS_FINISHED_MESSAGE: &str = "专注结束，休息一下吧";
const DEFAULT_BREAK_FINISHED_MESSAGE: &str = "休息结束，回来继续吧";
const TIMER_MESSAGE_MAX_CHARS: usize = 80;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PetSize {
    Small,
    Medium,
    Large,
}

impl PetSize {
    pub(crate) fn logical_dimensions(self) -> Dimensions {
        match self {
            PetSize::Small => Dimensions {
                width: 76.0,
                height: 76.0,
            },
            PetSize::Medium => Dimensions {
                width: 104.0,
                height: 104.0,
            },
            PetSize::Large => Dimensions {
                width: 136.0,
                height: 136.0,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ActivityLevel {
    Quiet,
    Standard,
    Lively,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FocusTimerPreferences {
    #[serde(default = "default_focus_minutes")]
    pub(crate) focus_minutes: [u64; 3],
    #[serde(default = "default_break_minutes")]
    pub(crate) break_minutes: u64,
    #[serde(default = "default_focus_finished_message")]
    pub(crate) focus_finished_message: String,
    #[serde(default = "default_break_finished_message")]
    pub(crate) break_finished_message: String,
    #[serde(default = "default_break_sound_enabled")]
    pub(crate) break_sound_enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenshotPreferences {
    #[serde(default)]
    pub(crate) save_directory: Option<String>,
}

impl Default for FocusTimerPreferences {
    fn default() -> Self {
        Self {
            focus_minutes: DEFAULT_FOCUS_MINUTES,
            break_minutes: DEFAULT_BREAK_MINUTES,
            focus_finished_message: DEFAULT_FOCUS_FINISHED_MESSAGE.into(),
            break_finished_message: DEFAULT_BREAK_FINISHED_MESSAGE.into(),
            break_sound_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    pub(crate) pet_size: PetSize,
    pub(crate) activity_level: ActivityLevel,
    pub(crate) always_on_top: bool,
    #[serde(default)]
    pub(crate) focus_timer: FocusTimerPreferences,
    #[serde(default)]
    pub(crate) screenshot: ScreenshotPreferences,
    pub(crate) pet_visible: bool,
    pub(crate) movement_paused: bool,
    pub(crate) custom_activity_area: Option<Rect>,
    pub(crate) last_position: Option<Point>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            pet_size: PetSize::Medium,
            activity_level: ActivityLevel::Standard,
            always_on_top: true,
            focus_timer: FocusTimerPreferences::default(),
            screenshot: ScreenshotPreferences::default(),
            pet_visible: true,
            movement_paused: false,
            custom_activity_area: None,
            last_position: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserPreferences {
    pub(crate) pet_size: PetSize,
    pub(crate) activity_level: ActivityLevel,
    pub(crate) always_on_top: bool,
    pub(crate) focus_timer: FocusTimerPreferences,
    pub(crate) screenshot: ScreenshotPreferences,
    pub(crate) custom_activity_area: Option<Rect>,
}

pub(crate) fn load_settings(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    let mut settings: Settings = fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default();
    settings.focus_timer =
        normalize_focus_timer_preferences(settings.focus_timer).unwrap_or_default();
    settings.screenshot = normalize_screenshot_preferences(settings.screenshot);
    settings
}

pub(crate) fn normalize_screenshot_preferences(
    preferences: ScreenshotPreferences,
) -> ScreenshotPreferences {
    ScreenshotPreferences {
        save_directory: preferences
            .save_directory
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty()),
    }
}

pub(crate) fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    fs::write(path, json).map_err(|err| err.to_string())
}

pub(crate) fn normalize_focus_timer_preferences(
    preferences: FocusTimerPreferences,
) -> Result<FocusTimerPreferences, String> {
    let mut focus_minutes = preferences.focus_minutes;
    for minutes in focus_minutes {
        validate_timer_minutes(minutes, "专注时长")?;
    }
    focus_minutes.sort_unstable();
    if focus_minutes[0] == focus_minutes[1] || focus_minutes[1] == focus_minutes[2] {
        return Err("专注快捷时长不能重复".into());
    }
    validate_timer_minutes(preferences.break_minutes, "休息时长")?;

    Ok(FocusTimerPreferences {
        focus_minutes,
        break_minutes: preferences.break_minutes,
        focus_finished_message: normalize_timer_message(
            &preferences.focus_finished_message,
            DEFAULT_FOCUS_FINISHED_MESSAGE,
        ),
        break_finished_message: normalize_timer_message(
            &preferences.break_finished_message,
            DEFAULT_BREAK_FINISHED_MESSAGE,
        ),
        break_sound_enabled: preferences.break_sound_enabled,
    })
}

pub(crate) fn validate_timer_minutes(minutes: u64, label: &str) -> Result<(), String> {
    if (TIMER_MIN_MINUTES..=TIMER_MAX_MINUTES).contains(&minutes) {
        Ok(())
    } else {
        Err(format!(
            "{label}需要在 {TIMER_MIN_MINUTES}-{TIMER_MAX_MINUTES} 分钟之间"
        ))
    }
}

fn normalize_timer_message(message: &str, default_message: &str) -> String {
    let flattened = message.replace(['\r', '\n'], " ");
    let trimmed = flattened.trim();
    let message = if trimmed.is_empty() {
        default_message
    } else {
        trimmed
    };
    message.chars().take(TIMER_MESSAGE_MAX_CHARS).collect()
}

fn default_focus_minutes() -> [u64; 3] {
    DEFAULT_FOCUS_MINUTES
}

fn default_break_minutes() -> u64 {
    DEFAULT_BREAK_MINUTES
}

fn default_focus_finished_message() -> String {
    DEFAULT_FOCUS_FINISHED_MESSAGE.into()
}

fn default_break_finished_message() -> String {
    DEFAULT_BREAK_FINISHED_MESSAGE.into()
}

fn default_break_sound_enabled() -> bool {
    true
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_timer_defaults_match_lightweight_focus_timer_prd() {
        let preferences = FocusTimerPreferences::default();

        assert_eq!(preferences.focus_minutes, [5, 25, 45]);
        assert_eq!(preferences.break_minutes, 5);
        assert_eq!(preferences.focus_finished_message, "专注结束，休息一下吧");
        assert_eq!(preferences.break_finished_message, "休息结束，回来继续吧");
        assert!(preferences.break_sound_enabled);
    }

    #[test]
    fn screenshot_preferences_default_to_desktop_and_normalize_empty_paths() {
        assert_eq!(ScreenshotPreferences::default().save_directory, None);
        assert_eq!(
            normalize_screenshot_preferences(ScreenshotPreferences {
                save_directory: Some("   ".into()),
            })
            .save_directory,
            None
        );
        assert_eq!(
            normalize_screenshot_preferences(ScreenshotPreferences {
                save_directory: Some(" /tmp/captures ".into()),
            })
            .save_directory
            .as_deref(),
            Some("/tmp/captures")
        );
    }

    #[test]
    fn legacy_settings_without_screenshot_preferences_still_load() {
        let legacy = serde_json::json!({
            "petSize": "medium",
            "activityLevel": "standard",
            "alwaysOnTop": true,
            "focusTimer": FocusTimerPreferences::default(),
            "petVisible": true,
            "movementPaused": false,
            "customActivityArea": null,
            "lastPosition": null
        });

        let settings: Settings =
            serde_json::from_value(legacy).expect("legacy settings should load");
        assert_eq!(settings.screenshot, ScreenshotPreferences::default());
    }

    #[test]
    fn focus_timer_minutes_are_sorted_and_must_be_unique() {
        let preferences = FocusTimerPreferences {
            focus_minutes: [45, 5, 25],
            ..FocusTimerPreferences::default()
        };

        let normalized = normalize_focus_timer_preferences(preferences).expect("valid settings");
        assert_eq!(normalized.focus_minutes, [5, 25, 45]);

        let duplicate = FocusTimerPreferences {
            focus_minutes: [25, 25, 45],
            ..FocusTimerPreferences::default()
        };
        assert!(normalize_focus_timer_preferences(duplicate).is_err());
    }

    #[test]
    fn focus_timer_minutes_must_stay_in_range() {
        let too_short = FocusTimerPreferences {
            focus_minutes: [0, 25, 45],
            ..FocusTimerPreferences::default()
        };
        assert!(normalize_focus_timer_preferences(too_short).is_err());

        let too_long_break = FocusTimerPreferences {
            break_minutes: 181,
            ..FocusTimerPreferences::default()
        };
        assert!(normalize_focus_timer_preferences(too_long_break).is_err());
    }

    #[test]
    fn focus_timer_messages_are_normalized() {
        let long_message = "一".repeat(TIMER_MESSAGE_MAX_CHARS + 8);
        let preferences = FocusTimerPreferences {
            focus_finished_message: "  \n  ".into(),
            break_finished_message: format!("  休息\n结束  {long_message}"),
            ..FocusTimerPreferences::default()
        };

        let normalized = normalize_focus_timer_preferences(preferences).expect("valid settings");
        assert_eq!(normalized.focus_finished_message, "专注结束，休息一下吧");
        assert!(!normalized.break_finished_message.contains('\n'));
        assert!(normalized.break_finished_message.chars().count() <= TIMER_MESSAGE_MAX_CHARS);
    }
}

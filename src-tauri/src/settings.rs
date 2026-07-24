use crate::geometry::{Dimensions, Point, Rect};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";
pub(crate) const TIMER_MIN_MINUTES: u64 = 1;
pub(crate) const TIMER_MAX_MINUTES: u64 = 180;
const DEFAULT_COUNTDOWN_MINUTES: u64 = 30;

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
pub(crate) struct CountdownPreferences {
    #[serde(default = "default_countdown_minutes")]
    pub(crate) minutes: u64,
}

impl Default for CountdownPreferences {
    fn default() -> Self {
        Self {
            minutes: DEFAULT_COUNTDOWN_MINUTES,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyFocusTimerPreferences {
    #[serde(default)]
    focus_minutes: Vec<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenshotPreferences {
    #[serde(default)]
    pub(crate) save_directory: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    pub(crate) pet_size: PetSize,
    pub(crate) activity_level: ActivityLevel,
    pub(crate) always_on_top: bool,
    #[serde(default)]
    pub(crate) countdown: CountdownPreferences,
    #[serde(default, rename = "focusTimer", skip_serializing)]
    legacy_focus_timer: Option<LegacyFocusTimerPreferences>,
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
            countdown: CountdownPreferences::default(),
            legacy_focus_timer: None,
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
    pub(crate) countdown: CountdownPreferences,
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
    if let Some(legacy) = settings.legacy_focus_timer.take() {
        settings.countdown = migrate_legacy_countdown(legacy);
    }
    settings.countdown = normalize_countdown_preferences(settings.countdown).unwrap_or_default();
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

pub(crate) fn normalize_countdown_preferences(
    preferences: CountdownPreferences,
) -> Result<CountdownPreferences, String> {
    validate_timer_minutes(preferences.minutes, "倒计时时长")?;
    Ok(preferences)
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

fn migrate_legacy_countdown(legacy: LegacyFocusTimerPreferences) -> CountdownPreferences {
    let mut valid = legacy
        .focus_minutes
        .into_iter()
        .filter(|minutes| (TIMER_MIN_MINUTES..=TIMER_MAX_MINUTES).contains(minutes))
        .collect::<Vec<_>>();
    valid.sort_unstable();
    let minutes = valid
        .get(valid.len().saturating_sub(1) / 2)
        .copied()
        .unwrap_or(DEFAULT_COUNTDOWN_MINUTES);
    CountdownPreferences { minutes }
}

fn default_countdown_minutes() -> u64 {
    DEFAULT_COUNTDOWN_MINUTES
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
    fn countdown_defaults_to_thirty_minutes() {
        assert_eq!(CountdownPreferences::default().minutes, 30);
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
            "countdown": CountdownPreferences::default(),
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
    fn countdown_minutes_must_stay_in_range() {
        assert!(normalize_countdown_preferences(CountdownPreferences { minutes: 1 }).is_ok());
        assert!(normalize_countdown_preferences(CountdownPreferences { minutes: 180 }).is_ok());
        assert!(normalize_countdown_preferences(CountdownPreferences { minutes: 0 }).is_err());
        assert!(normalize_countdown_preferences(CountdownPreferences { minutes: 181 }).is_err());
    }

    #[test]
    fn legacy_focus_timer_uses_the_sorted_middle_value() {
        let legacy = serde_json::json!({
            "petSize": "medium",
            "activityLevel": "standard",
            "alwaysOnTop": true,
            "focusTimer": {
                "focusMinutes": [45, 10, 25],
                "breakMinutes": 5,
                "focusFinishedMessage": "ignored",
                "breakFinishedMessage": "ignored",
                "breakSoundEnabled": true
            },
            "petVisible": true,
            "movementPaused": false,
            "customActivityArea": null,
            "lastPosition": null
        });
        let mut settings: Settings =
            serde_json::from_value(legacy).expect("legacy settings should load");
        settings.countdown = migrate_legacy_countdown(
            settings
                .legacy_focus_timer
                .take()
                .expect("legacy timer should be present"),
        );

        assert_eq!(settings.countdown.minutes, 25);
        let serialized = serde_json::to_value(&settings).expect("settings should serialize");
        assert!(serialized.get("focusTimer").is_none());
        assert_eq!(serialized["countdown"]["minutes"], 25);
    }

    #[test]
    fn invalid_legacy_values_fall_back_to_thirty_minutes() {
        let migrated = migrate_legacy_countdown(LegacyFocusTimerPreferences {
            focus_minutes: vec![0, 181],
        });
        assert_eq!(migrated.minutes, 30);
    }
}

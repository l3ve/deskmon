use crate::geometry::{Dimensions, Point, Rect};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    pub(crate) pet_size: PetSize,
    pub(crate) activity_level: ActivityLevel,
    pub(crate) always_on_top: bool,
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
    pub(crate) custom_activity_area: Option<Rect>,
}

pub(crate) fn load_settings(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub(crate) fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    fs::write(path, json).map_err(|err| err.to_string())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

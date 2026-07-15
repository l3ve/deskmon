use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Local;
use rand::random;
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
};

const SCREENSHOT_PREFIX: &str = "Deskmon";
const CACHE_PREFIX: &str = "deskmon-screenshot-session-";
const LEGACY_CACHE_PREFIX: &str = ".deskmon-screenshot-session-";
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_ENCODED_PNG_BYTES: usize = 192 * 1024 * 1024;

#[derive(Debug, Default)]
struct ScreenshotTaskState {
    active: bool,
    owner_label: Option<String>,
    captured_at: Option<String>,
}

#[derive(Clone, Default)]
pub(crate) struct ScreenshotCoordinator {
    state: Arc<Mutex<ScreenshotTaskState>>,
}

impl ScreenshotCoordinator {
    pub(crate) fn try_begin(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.active {
            return false;
        }
        *state = ScreenshotTaskState {
            active: true,
            owner_label: None,
            captured_at: None,
        };
        true
    }

    pub(crate) fn claim_selection(&self, label: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if !state.active || state.captured_at.is_some() {
            return false;
        }
        match state.owner_label.as_deref() {
            Some(owner) => owner == label,
            None => {
                state.owner_label = Some(label.to_owned());
                true
            }
        }
    }

    pub(crate) fn release_selection(&self, label: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.active
            && state.captured_at.is_none()
            && state.owner_label.as_deref() == Some(label)
        {
            state.owner_label = None;
        }
    }

    pub(crate) fn is_owner(&self, label: &str) -> bool {
        self.state
            .lock()
            .map(|state| state.active && state.owner_label.as_deref() == Some(label))
            .unwrap_or(false)
    }

    pub(crate) fn mark_captured(&self, label: &str, captured_at: String) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "screenshot coordinator lock poisoned")?;
        if !state.active || state.owner_label.as_deref() != Some(label) {
            return Err("截图任务已结束".into());
        }
        state.captured_at = Some(captured_at);
        Ok(())
    }

    pub(crate) fn captured_at(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .filter(|state| state.active)
            .and_then(|state| state.captured_at.clone())
    }

    pub(crate) fn is_active(&self) -> bool {
        self.state.lock().map(|state| state.active).unwrap_or(false)
    }

    pub(crate) fn finish(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = ScreenshotTaskState::default();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CaptureRegion {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) fn logical_capture_region(
    window_x: i32,
    window_y: i32,
    scale_factor: f64,
    local_x: f64,
    local_y: f64,
    width: f64,
    height: f64,
) -> Result<CaptureRegion, String> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Err("无法读取截图窗口缩放比例".into());
    }
    if ![local_x, local_y, width, height]
        .into_iter()
        .all(f64::is_finite)
        || width < 10.0
        || height < 10.0
    {
        return Err("截图选区无效".into());
    }

    Ok(CaptureRegion {
        x: (window_x as f64 / scale_factor + local_x).round() as i32,
        y: (window_y as f64 / scale_factor + local_y).round() as i32,
        width: width.round().max(1.0) as u32,
        height: height.round().max(1.0) as u32,
    })
}

#[derive(Debug)]
pub(crate) struct CapturedPng {
    pub(crate) bytes: Vec<u8>,
    pub(crate) pixel_width: u32,
    pub(crate) pixel_height: u32,
    pub(crate) captured_at: String,
}

impl CapturedPng {
    pub(crate) fn data_url(&self) -> String {
        format!("data:image/png;base64,{}", STANDARD.encode(&self.bytes))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CaptureFailure {
    pub(crate) message: String,
    pub(crate) permission_denied: bool,
}

#[cfg(target_os = "macos")]
pub(crate) fn screen_capture_access_granted() -> bool {
    core_graphics::access::ScreenCaptureAccess::default().preflight()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn screen_capture_access_granted() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub(crate) fn capture_region(
    cache_directory: &Path,
    region: CaptureRegion,
) -> Result<CapturedPng, CaptureFailure> {
    fs::create_dir_all(cache_directory).map_err(|error| CaptureFailure {
        message: format!("无法创建截图缓存目录：{error}"),
        permission_denied: false,
    })?;
    let cache_path = next_cache_path(cache_directory);
    let captured_at = Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let region_argument = format!(
        "-R{},{},{},{}",
        region.x, region.y, region.width, region.height
    );
    let output = Command::new("/usr/sbin/screencapture")
        .arg(region_argument)
        .arg("-x")
        .arg("-t")
        .arg("png")
        .arg(&cache_path)
        .output();

    let result = match output {
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            match fs::read(&cache_path) {
                Ok(bytes) => png_dimensions(&bytes)
                    .map(|(pixel_width, pixel_height)| CapturedPng {
                        bytes,
                        pixel_width,
                        pixel_height,
                        captured_at,
                    })
                    .map_err(|message| CaptureFailure {
                        message,
                        permission_denied: false,
                    }),
                Err(error) => Err(classify_capture_failure(
                    output.status.success(),
                    &stderr,
                    &error.to_string(),
                )),
            }
        }
        Err(error) => Err(CaptureFailure {
            message: format!("无法启动系统截图：{error}"),
            permission_denied: false,
        }),
    };
    let _ = fs::remove_file(cache_path);
    result
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn capture_region(
    _cache_directory: &Path,
    _region: CaptureRegion,
) -> Result<CapturedPng, CaptureFailure> {
    Err(CaptureFailure {
        message: "区域截图目前仅支持 macOS".into(),
        permission_denied: false,
    })
}

fn classify_capture_failure(success: bool, stderr: &str, fallback: &str) -> CaptureFailure {
    let detail = if stderr.trim().is_empty() {
        fallback.trim()
    } else {
        stderr.trim()
    };
    let normalized = detail.to_ascii_lowercase();
    let permission_denied = normalized.contains("could not create image from display")
        || normalized.contains("screen recording")
        || normalized.contains("permission");
    CaptureFailure {
        message: if normalized.contains("cannot write file to intended destination") {
            "系统截图无法写入临时文件".into()
        } else if detail.is_empty() {
            "系统截图失败".into()
        } else if success {
            detail.to_owned()
        } else {
            format!("系统截图失败：{detail}")
        },
        permission_denied,
    }
}

fn next_cache_path(cache_directory: &Path) -> PathBuf {
    cache_directory.join(format!("{CACHE_PREFIX}{}.png", random::<u64>()))
}

pub(crate) fn ensure_save_directory(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| format!("无法创建截图目录：{error}"))?;

    let probe = directory.join(format!(".deskmon-write-test-{}", random::<u64>()));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| format!("截图目录不可写：{error}"))?;
    fs::remove_file(&probe).map_err(|error| format!("无法完成目录写入检查：{error}"))?;
    Ok(())
}

pub(crate) fn decode_png_base64(encoded: &str) -> Result<Vec<u8>, String> {
    let payload = encoded
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(encoded);
    if payload.len() > MAX_ENCODED_PNG_BYTES {
        return Err("截图数据过大，无法保存".into());
    }
    let bytes = STANDARD
        .decode(payload)
        .map_err(|error| format!("无法读取截图数据：{error}"))?;
    png_dimensions(&bytes)?;
    Ok(bytes)
}

pub(crate) fn write_screenshot_png(
    directory: &Path,
    captured_at: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    ensure_save_directory(directory)?;
    png_dimensions(bytes)?;

    let mut suffix = 1_u64;
    loop {
        let path = screenshot_path(directory, captured_at, suffix);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(format!("无法写入截图：{error}"));
                }
                return Ok(path);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => suffix += 1,
            Err(error) => return Err(format!("无法创建截图文件：{error}")),
        }
    }
}

fn screenshot_path(directory: &Path, captured_at: &str, suffix: u64) -> PathBuf {
    let base = format!("{SCREENSHOT_PREFIX}_{captured_at}");
    if suffix == 1 {
        directory.join(format!("{base}.png"))
    } else {
        directory.join(format!("{base}_{suffix}.png"))
    }
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < 24 || &bytes[..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        return Err("截图数据不是有效的 PNG".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("PNG width slice"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("PNG height slice"));
    if width == 0 || height == 0 {
        return Err("截图尺寸无效".into());
    }
    Ok((width, height))
}

pub(crate) fn cleanup_cache(cache_directory: &Path) {
    let Ok(entries) = fs::read_dir(cache_directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(CACHE_PREFIX) || name.starts_with(LEGACY_CACHE_PREFIX) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("deskmon-{name}-{}", random::<u64>()))
    }

    fn tiny_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0_u8; 24];
        bytes[..8].copy_from_slice(PNG_SIGNATURE);
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        bytes
    }

    #[test]
    fn coordinator_tracks_selection_and_capture_lifecycle() {
        let coordinator = ScreenshotCoordinator::default();
        assert!(coordinator.try_begin());
        assert!(!coordinator.try_begin());
        assert!(coordinator.claim_selection("screenshot-0"));
        assert!(!coordinator.claim_selection("screenshot-1"));
        coordinator.release_selection("screenshot-0");
        assert!(coordinator.claim_selection("screenshot-1"));
        coordinator
            .mark_captured("screenshot-1", "2026-07-15_12-34-56".into())
            .expect("owner should mark capture");
        assert_eq!(
            coordinator.captured_at().as_deref(),
            Some("2026-07-15_12-34-56")
        );
        coordinator.finish();
        assert!(!coordinator.is_active());
        assert!(coordinator.try_begin());
    }

    #[test]
    fn logical_region_uses_window_scale_for_global_origin() {
        assert_eq!(
            logical_capture_region(200, 100, 2.0, 12.0, 18.0, 120.0, 80.0).unwrap(),
            CaptureRegion {
                x: 112,
                y: 68,
                width: 120,
                height: 80,
            }
        );
        assert!(logical_capture_region(0, 0, 2.0, 0.0, 0.0, 9.0, 20.0).is_err());
    }

    #[test]
    fn save_directory_is_created_and_checked_for_writes() {
        let directory = test_directory("directory").join("nested");
        ensure_save_directory(&directory).expect("directory should be usable");
        assert!(directory.is_dir());
        let _ = fs::remove_dir_all(directory.parent().expect("test root"));
    }

    #[test]
    fn screenshot_names_use_ascii_timestamp_and_collision_suffixes() {
        let directory = test_directory("names");
        fs::create_dir_all(&directory).expect("create test directory");
        let timestamp = "2026-07-14_12-34-56";
        let png = tiny_png(2, 2);

        let first = write_screenshot_png(&directory, timestamp, &png).unwrap();
        assert_eq!(
            first.file_name().unwrap(),
            "Deskmon_2026-07-14_12-34-56.png"
        );
        let second = write_screenshot_png(&directory, timestamp, &png).unwrap();
        assert_eq!(
            second.file_name().unwrap(),
            "Deskmon_2026-07-14_12-34-56_2.png"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn png_data_is_validated_before_saving() {
        let png = tiny_png(3, 4);
        let encoded = STANDARD.encode(&png);
        assert_eq!(decode_png_base64(&encoded).unwrap(), png);
        assert!(decode_png_base64("not-a-png").is_err());
    }

    #[test]
    fn capture_failures_recognize_permission_errors() {
        assert_eq!(
            classify_capture_failure(false, "could not create image from display", "missing file"),
            CaptureFailure {
                message: "系统截图失败：could not create image from display".into(),
                permission_denied: true,
            }
        );
    }

    #[test]
    fn capture_cache_name_is_not_hidden_from_screencapture() {
        let path = next_cache_path(Path::new("/tmp"));
        let filename = path.file_name().unwrap().to_string_lossy();
        assert!(filename.starts_with(CACHE_PREFIX));
        assert!(!filename.starts_with('.'));
    }

    #[test]
    fn destination_failures_are_not_reported_as_permission_errors() {
        assert_eq!(
            classify_capture_failure(
                false,
                "screencapture: cannot write file to intended destination",
                "missing file",
            ),
            CaptureFailure {
                message: "系统截图无法写入临时文件".into(),
                permission_denied: false,
            }
        );
    }

    #[test]
    fn invalid_region_failures_are_not_reported_as_permission_errors() {
        assert_eq!(
            classify_capture_failure(false, "could not create image from rect", "missing file"),
            CaptureFailure {
                message: "系统截图失败：could not create image from rect".into(),
                permission_denied: false,
            }
        );
    }
}

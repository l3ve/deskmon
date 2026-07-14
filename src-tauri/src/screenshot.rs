use chrono::Local;
use rand::random;
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

const SCREENSHOT_PREFIX: &str = "Deskmon";

#[derive(Clone, Default)]
pub(crate) struct ScreenshotCoordinator {
    active: Arc<AtomicBool>,
}

impl ScreenshotCoordinator {
    pub(crate) fn try_begin(&self) -> Option<ScreenshotTaskGuard> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| ScreenshotTaskGuard {
                active: Arc::clone(&self.active),
            })
    }
}

pub(crate) struct ScreenshotTaskGuard {
    active: Arc<AtomicBool>,
}

impl Drop for ScreenshotTaskGuard {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CaptureOutcome {
    Saved,
    Canceled,
    Failed {
        message: String,
        permission_denied: bool,
    },
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

pub(crate) fn next_screenshot_path(directory: &Path) -> PathBuf {
    let timestamp = Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    next_screenshot_path_for_timestamp(directory, &timestamp)
}

fn next_screenshot_path_for_timestamp(directory: &Path, timestamp: &str) -> PathBuf {
    let base = format!("{SCREENSHOT_PREFIX}_{timestamp}");
    let first = directory.join(format!("{base}.png"));
    if !first.exists() {
        return first;
    }

    let mut suffix = 2_u64;
    loop {
        let candidate = directory.join(format!("{base}_{suffix}.png"));
        if !candidate.exists() {
            return candidate;
        }
        suffix += 1;
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn capture_region(output_path: &Path) -> CaptureOutcome {
    let output = Command::new("/usr/sbin/screencapture")
        .arg("-i")
        .arg("-s")
        .arg("-t")
        .arg("png")
        .arg(output_path)
        .output();

    match output {
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let file_size = fs::metadata(output_path)
                .map(|metadata| metadata.len())
                .ok();
            let outcome = classify_capture_result(output.status.success(), &stderr, file_size);
            if outcome != CaptureOutcome::Saved {
                let _ = fs::remove_file(output_path);
            }
            outcome
        }
        Err(error) => CaptureOutcome::Failed {
            message: format!("无法启动系统截图：{error}"),
            permission_denied: false,
        },
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn capture_region(_output_path: &Path) -> CaptureOutcome {
    CaptureOutcome::Failed {
        message: "区域截图目前仅支持 macOS".into(),
        permission_denied: false,
    }
}

fn classify_capture_result(success: bool, stderr: &str, file_size: Option<u64>) -> CaptureOutcome {
    if file_size.is_some_and(|size| size > 0) {
        return CaptureOutcome::Saved;
    }
    if stderr.trim().is_empty() {
        return CaptureOutcome::Canceled;
    }

    let normalized = stderr.to_ascii_lowercase();
    CaptureOutcome::Failed {
        message: if success {
            stderr.to_string()
        } else {
            format!("系统截图失败：{stderr}")
        },
        permission_denied: normalized.contains("could not create image from display")
            || normalized.contains("screen recording")
            || normalized.contains("permission"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("deskmon-{name}-{}", random::<u64>()))
    }

    #[test]
    fn coordinator_allows_only_one_active_task() {
        let coordinator = ScreenshotCoordinator::default();
        let guard = coordinator.try_begin().expect("first task should start");
        assert!(coordinator.try_begin().is_none());
        drop(guard);
        assert!(coordinator.try_begin().is_some());
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

        let first = next_screenshot_path_for_timestamp(&directory, timestamp);
        assert_eq!(
            first.file_name().unwrap(),
            "Deskmon_2026-07-14_12-34-56.png"
        );
        fs::write(&first, b"first").expect("create first collision");

        let second = next_screenshot_path_for_timestamp(&directory, timestamp);
        assert_eq!(
            second.file_name().unwrap(),
            "Deskmon_2026-07-14_12-34-56_2.png"
        );
        fs::write(&second, b"second").expect("create second collision");

        let third = next_screenshot_path_for_timestamp(&directory, timestamp);
        assert_eq!(
            third.file_name().unwrap(),
            "Deskmon_2026-07-14_12-34-56_3.png"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn capture_results_distinguish_success_cancel_and_permission_failure() {
        assert_eq!(
            classify_capture_result(true, "", Some(42)),
            CaptureOutcome::Saved
        );
        assert_eq!(
            classify_capture_result(false, "", None),
            CaptureOutcome::Canceled
        );
        assert_eq!(
            classify_capture_result(false, "could not create image from display", None),
            CaptureOutcome::Failed {
                message: "系统截图失败：could not create image from display".into(),
                permission_denied: true,
            }
        );
    }
}

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, ErrorKind, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const CLI_TARGET: &str = "/usr/local/bin/deskmon";
const SOCKET_FILENAME: &str = "deskmon-notify.sock";
const MAX_MESSAGE_BYTES: usize = 4096;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalNotificationRequest {
    pub(crate) title: Option<String>,
    pub(crate) text: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NotificationDisposition {
    Accepted,
    Ignored,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationResponse {
    disposition: Option<NotificationDisposition>,
    error: Option<String>,
}

impl NotificationResponse {
    fn success(disposition: NotificationDisposition) -> Self {
        Self {
            disposition: Some(disposition),
            error: None,
        }
    }

    fn failure(error: impl Into<String>) -> Self {
        Self {
            disposition: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum CliCommand {
    Help,
    Version,
    Notify(ExternalNotificationRequest),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CliInstallationState {
    NotInstalled,
    Installed,
    Updatable,
    Conflict,
}

pub fn run_cli_if_requested() -> Option<i32> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let command = match parse_cli_command(&args) {
        Ok(Some(command)) => command,
        Ok(None) => return None,
        Err(error) => {
            eprintln!("{error}");
            return Some(2);
        }
    };

    match command {
        CliCommand::Help => {
            print_help();
            Some(0)
        }
        CliCommand::Version => {
            println!("Deskmon {}", env!("CARGO_PKG_VERSION"));
            Some(0)
        }
        CliCommand::Notify(request) => match send_notification(&request) {
            Ok(_) => Some(0),
            Err(error) => {
                eprintln!("{error}");
                Some(1)
            }
        },
    }
}

fn parse_cli_command(args: &[String]) -> Result<Option<CliCommand>, String> {
    let Some(command) = args.first().map(String::as_str) else {
        return Ok(None);
    };

    match command {
        "--help" | "-h" => {
            if args.len() == 1 {
                Ok(Some(CliCommand::Help))
            } else {
                Err("用法：deskmon notify --text <正文> [--title <标题>]".into())
            }
        }
        "--version" | "-V" => {
            if args.len() == 1 {
                Ok(Some(CliCommand::Version))
            } else {
                Err("用法：deskmon --version".into())
            }
        }
        "notify" => parse_notify_command(&args[1..]).map(Some),
        _ if command.starts_with("-psn_") => Ok(None),
        _ => Err(format!("未知命令：{command}")),
    }
}

fn parse_notify_command(args: &[String]) -> Result<CliCommand, String> {
    if matches!(args, [flag] if flag == "--help" || flag == "-h") {
        return Ok(CliCommand::Help);
    }

    let mut title = None;
    let mut text = None;
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("参数 {flag} 缺少内容"))?
            .clone();
        match flag {
            "--title" => {
                if title.replace(value).is_some() {
                    return Err("参数 --title 不能重复".into());
                }
            }
            "--text" => {
                if text.replace(value).is_some() {
                    return Err("参数 --text 不能重复".into());
                }
            }
            _ => return Err(format!("未知参数：{flag}")),
        }
        index += 2;
    }

    let text = text.ok_or_else(|| "缺少必填参数 --text".to_string())?;
    Ok(CliCommand::Notify(ExternalNotificationRequest {
        title,
        text,
    }))
}

fn print_help() {
    println!("Deskmon 本地宠物提醒");
    println!();
    println!("用法：");
    println!("  deskmon notify --text <正文> [--title <标题>]");
}

fn notification_socket_path() -> PathBuf {
    std::env::temp_dir().join(SOCKET_FILENAME)
}

#[cfg(target_os = "macos")]
fn send_notification(
    request: &ExternalNotificationRequest,
) -> Result<NotificationDisposition, String> {
    send_notification_to_path(&notification_socket_path(), request)
}

#[cfg(not(target_os = "macos"))]
fn send_notification(
    _request: &ExternalNotificationRequest,
) -> Result<NotificationDisposition, String> {
    Err("Deskmon 本地宠物提醒目前只支持 macOS".into())
}

#[cfg(unix)]
fn send_notification_to_path(
    path: &Path,
    request: &ExternalNotificationRequest,
) -> Result<NotificationDisposition, String> {
    use std::os::unix::net::UnixStream;

    let mut stream = match UnixStream::connect(path) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::NotFound | ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(NotificationDisposition::Ignored);
        }
        Err(error) => return Err(format!("无法连接 Deskmon：{error}")),
    };
    stream
        .set_read_timeout(Some(Duration::from_millis(900)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(900)))
        .map_err(|error| error.to_string())?;

    let mut encoded = serde_json::to_vec(request).map_err(|error| error.to_string())?;
    encoded.push(b'\n');
    stream
        .write_all(&encoded)
        .map_err(|error| format!("无法发送提醒：{error}"))?;

    let mut response_line = String::new();
    BufReader::new(stream)
        .take(MAX_MESSAGE_BYTES as u64)
        .read_line(&mut response_line)
        .map_err(|error| format!("无法读取 Deskmon 响应：{error}"))?;
    let response: NotificationResponse = serde_json::from_str(response_line.trim_end())
        .map_err(|error| format!("Deskmon 响应无效：{error}"))?;
    if let Some(error) = response.error {
        return Err(error);
    }
    response
        .disposition
        .ok_or_else(|| "Deskmon 响应缺少处理状态".to_string())
}

#[cfg(unix)]
pub(crate) fn spawn_notification_server<F>(handler: F) -> Result<(), String>
where
    F: Fn(ExternalNotificationRequest) -> Result<NotificationDisposition, String>
        + Send
        + Sync
        + 'static,
{
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};
    use std::sync::Arc;

    let path = notification_socket_path();
    if path.exists() {
        if std::os::unix::net::UnixStream::connect(&path).is_ok() {
            return Ok(());
        }
        fs::remove_file(&path).map_err(|error| format!("无法清理旧提醒端点：{error}"))?;
    }

    let listener =
        UnixListener::bind(&path).map_err(|error| format!("无法创建提醒端点：{error}"))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法保护提醒端点：{error}"))?;
    let handler = Arc::new(handler);
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(mut stream) = connection else {
                continue;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
            let _ = stream.set_write_timeout(Some(Duration::from_millis(900)));
            let response = read_request(&stream)
                .and_then(|request| handler(request))
                .map(NotificationResponse::success)
                .unwrap_or_else(NotificationResponse::failure);
            if let Ok(mut encoded) = serde_json::to_vec(&response) {
                encoded.push(b'\n');
                let _ = stream.write_all(&encoded);
            }
        }
    });
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn spawn_notification_server<F>(_handler: F) -> Result<(), String>
where
    F: Fn(ExternalNotificationRequest) -> Result<NotificationDisposition, String>
        + Send
        + Sync
        + 'static,
{
    Ok(())
}

#[cfg(unix)]
fn read_request(
    stream: &std::os::unix::net::UnixStream,
) -> Result<ExternalNotificationRequest, String> {
    let mut line = String::new();
    BufReader::new(stream)
        .take(MAX_MESSAGE_BYTES as u64)
        .read_line(&mut line)
        .map_err(|error| format!("无法读取提醒：{error}"))?;
    if line.len() >= MAX_MESSAGE_BYTES {
        return Err("提醒内容过长".into());
    }
    serde_json::from_str(line.trim_end()).map_err(|error| format!("提醒格式无效：{error}"))
}

pub(crate) fn cli_installation_state() -> CliInstallationState {
    let Ok(current_exe) = std::env::current_exe() else {
        return CliInstallationState::Conflict;
    };
    cli_installation_state_for(&current_exe, Path::new(CLI_TARGET))
}

fn cli_installation_state_for(current_exe: &Path, target: &Path) -> CliInstallationState {
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return CliInstallationState::NotInstalled;
        }
        Err(_) => return CliInstallationState::Conflict,
    };
    if !metadata.file_type().is_symlink() {
        return CliInstallationState::Conflict;
    }
    let Ok(link) = fs::read_link(target) else {
        return CliInstallationState::Conflict;
    };
    let resolved = if link.is_absolute() {
        link
    } else {
        target.parent().unwrap_or_else(|| Path::new("/")).join(link)
    };
    if resolved == current_exe {
        CliInstallationState::Installed
    } else if is_deskmon_app_executable(&resolved) {
        CliInstallationState::Updatable
    } else {
        CliInstallationState::Conflict
    }
}

fn is_deskmon_app_executable(path: &Path) -> bool {
    let components = path
        .components()
        .rev()
        .take(4)
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    matches!(
        components.as_slice(),
        [binary, macos, contents, app]
            if binary == "deskmon"
                && macos == "MacOS"
                && contents == "Contents"
                && app == "Deskmon.app"
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn install_cli() -> Result<(), String> {
    let current_exe = std::env::current_exe().map_err(|error| error.to_string())?;
    if cli_installation_state_for(&current_exe, Path::new(CLI_TARGET))
        == CliInstallationState::Conflict
    {
        return Err(format!("{CLI_TARGET} 已被其他程序占用，未进行覆盖"));
    }
    run_admin_shell_command(&cli_install_command(&current_exe), "安装命令行工具")
}

fn cli_install_command(current_exe: &Path) -> String {
    format!(
        "/bin/mkdir -p -- {} && /bin/ln -sfn -- {} {}",
        shell_quote("/usr/local/bin"),
        shell_quote(&current_exe.to_string_lossy()),
        shell_quote(CLI_TARGET)
    )
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install_cli() -> Result<(), String> {
    Err("命令行工具安装目前只支持 macOS".into())
}

#[cfg(target_os = "macos")]
pub(crate) fn uninstall_cli() -> Result<(), String> {
    match cli_installation_state() {
        CliInstallationState::NotInstalled => return Ok(()),
        CliInstallationState::Conflict => {
            return Err(format!("{CLI_TARGET} 不属于 Deskmon，未进行删除"));
        }
        CliInstallationState::Installed | CliInstallationState::Updatable => {}
    }
    let command = format!("/bin/rm -- {}", shell_quote(CLI_TARGET));
    run_admin_shell_command(&command, "卸载命令行工具")
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn uninstall_cli() -> Result<(), String> {
    Err("命令行工具卸载目前只支持 macOS".into())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn run_admin_shell_command(command: &str, prompt: &str) -> Result<(), String> {
    let script = format!(
        "do shell script \"{}\" with prompt \"{}\" with administrator privileges",
        apple_script_escape(command),
        apple_script_escape(prompt)
    );
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map_err(|error| format!("无法请求管理员授权：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        Err(if message.is_empty() {
            format!("{prompt}未完成")
        } else {
            message
        })
    }
}

#[cfg(target_os = "macos")]
fn apple_script_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parses_notify_arguments_in_any_supported_order() {
        assert_eq!(
            parse_cli_command(&strings(&["notify", "--text", "完成", "--title", "Codex"])),
            Ok(Some(CliCommand::Notify(ExternalNotificationRequest {
                title: Some("Codex".into()),
                text: "完成".into(),
            })))
        );
        assert_eq!(
            parse_cli_command(&strings(&["notify", "--title", "Codex", "--text", "完成"])),
            Ok(Some(CliCommand::Notify(ExternalNotificationRequest {
                title: Some("Codex".into()),
                text: "完成".into(),
            })))
        );
    }

    #[test]
    fn requires_text_flag_but_allows_empty_text_value() {
        assert!(parse_cli_command(&strings(&["notify", "--title", "Codex"])).is_err());
        assert!(matches!(
            parse_cli_command(&strings(&["notify", "--text", ""])),
            Ok(Some(CliCommand::Notify(ExternalNotificationRequest { text, .. }))) if text.is_empty()
        ));
    }

    #[test]
    fn rejects_unknown_duplicate_and_missing_flag_values() {
        assert!(parse_cli_command(&strings(&["notify", "--body", "完成"])).is_err());
        assert!(parse_cli_command(&strings(&[
            "notify",
            "--text",
            "完成",
            "--text",
            "再次完成"
        ]))
        .is_err());
        assert!(parse_cli_command(&strings(&["notify", "--text"])).is_err());
    }

    #[test]
    fn leaves_normal_app_launch_arguments_unhandled() {
        assert_eq!(parse_cli_command(&[]), Ok(None));
        assert_eq!(parse_cli_command(&strings(&["-psn_0_12345"])), Ok(None));
    }

    #[test]
    fn rejects_unknown_top_level_commands_instead_of_launching_the_app() {
        assert_eq!(
            parse_cli_command(&strings(&["notfy", "--text", "完成"])),
            Err("未知命令：notfy".into())
        );
    }

    #[test]
    fn recognizes_only_deskmon_app_executables_as_updatable() {
        assert!(is_deskmon_app_executable(Path::new(
            "/Applications/Deskmon.app/Contents/MacOS/deskmon"
        )));
        assert!(!is_deskmon_app_executable(Path::new(
            "/Applications/Other.app/Contents/MacOS/deskmon"
        )));
        assert!(!is_deskmon_app_executable(Path::new(
            "/usr/local/bin/deskmon"
        )));
    }

    #[test]
    fn serializes_cli_installation_states_for_the_settings_ui() {
        assert_eq!(
            serde_json::to_string(&CliInstallationState::NotInstalled).unwrap(),
            "\"notInstalled\""
        );
        assert_eq!(
            serde_json::to_string(&CliInstallationState::Installed).unwrap(),
            "\"installed\""
        );
        assert_eq!(
            serde_json::to_string(&CliInstallationState::Updatable).unwrap(),
            "\"updatable\""
        );
        assert_eq!(
            serde_json::to_string(&CliInstallationState::Conflict).unwrap(),
            "\"conflict\""
        );
    }

    #[test]
    fn install_command_creates_the_cli_parent_directory_and_quotes_the_app_path() {
        let command = cli_install_command(Path::new(
            "/Applications/Deskmon user's.app/Contents/MacOS/deskmon",
        ));
        assert!(command.starts_with("/bin/mkdir -p -- '/usr/local/bin' && "));
        assert!(command.contains("Deskmon user'\\''s.app"));
        assert!(command.ends_with("'/usr/local/bin/deskmon'"));
    }

    #[cfg(unix)]
    #[test]
    fn classifies_cli_installation_targets_without_overwriting_conflicts() {
        use std::os::unix::fs::symlink;

        let directory = std::env::temp_dir().join(format!(
            "deskmon-install-state-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&directory).unwrap();
        let current = directory.join("Current.app/Contents/MacOS/deskmon");
        fs::create_dir_all(current.parent().unwrap()).unwrap();
        fs::write(&current, b"current").unwrap();
        let target = directory.join("deskmon");

        assert_eq!(
            cli_installation_state_for(&current, &target),
            CliInstallationState::NotInstalled
        );
        fs::write(&target, b"other command").unwrap();
        assert_eq!(
            cli_installation_state_for(&current, &target),
            CliInstallationState::Conflict
        );

        fs::remove_file(&target).unwrap();
        let old = directory.join("Deskmon.app/Contents/MacOS/deskmon");
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        fs::write(&old, b"old").unwrap();
        symlink(&old, &target).unwrap();
        assert_eq!(
            cli_installation_state_for(&current, &target),
            CliInstallationState::Updatable
        );

        fs::remove_file(&target).unwrap();
        symlink(&current, &target).unwrap();
        assert_eq!(
            cli_installation_state_for(&current, &target),
            CliInstallationState::Installed
        );
        fs::remove_dir_all(&directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn treats_an_unavailable_app_endpoint_as_a_successful_ignore() {
        let socket = std::env::temp_dir().join(format!(
            "deskmon-missing-{}-{}.sock",
            std::process::id(),
            crate::now_ms()
        ));
        let request = ExternalNotificationRequest {
            title: None,
            text: "完成".into(),
        };
        assert_eq!(
            send_notification_to_path(&socket, &request),
            Ok(NotificationDisposition::Ignored)
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_server_round_trips_a_notification() {
        use std::os::unix::{fs::symlink, net::UnixListener};

        let directory = std::env::temp_dir().join(format!(
            "deskmon-test-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&directory).unwrap();
        let socket = std::env::temp_dir().join(format!("dmn-{}.sock", std::process::id()));
        let _ = fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).unwrap();
        let request = ExternalNotificationRequest {
            title: Some("Codex".into()),
            text: "完成".into(),
        };
        let expected = request.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            assert_eq!(read_request(&stream).unwrap(), expected);
            let mut encoded = serde_json::to_vec(&NotificationResponse::success(
                NotificationDisposition::Accepted,
            ))
            .unwrap();
            encoded.push(b'\n');
            stream.write_all(&encoded).unwrap();
        });
        assert_eq!(
            send_notification_to_path(&socket, &request),
            Ok(NotificationDisposition::Accepted)
        );
        server.join().unwrap();
        fs::remove_file(&socket).unwrap();

        let current = directory.join("Deskmon.app/Contents/MacOS/deskmon");
        fs::create_dir_all(current.parent().unwrap()).unwrap();
        fs::write(&current, b"deskmon").unwrap();
        let installed = directory.join("installed");
        symlink(&current, &installed).unwrap();
        assert_eq!(
            cli_installation_state_for(&current, &installed),
            CliInstallationState::Installed
        );
        fs::remove_dir_all(&directory).unwrap();
    }
}

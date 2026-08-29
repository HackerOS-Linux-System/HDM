use crate::{session, DaemonState, SOCKET_PATH};
use serde::{Deserialize, Serialize};
use std::{os::unix::fs::PermissionsExt, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::Mutex,
};
use tracing::{error, info, warn};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum GreeterRequest {
    Authenticate {
        username: String,
        password: String,
    },
    PatternAuth {
        username: String,
        pattern: Vec<u8>,
    },
    StartSession {
        username: String,
        session: String,
        env: Option<Vec<(String, String)>>,
    },
    GuestLogin {
        session: String,
    },
    FingerprintAuth {
        username: String,
    },
    GetSessions,
    GetUsers,
    GetInfo,
    PowerAction {
        action: String,
    },
    Cancel,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DaemonResponse {
    AuthSuccess {
        username: String,
    },
    AuthFailure {
        reason: String,
        attempts_left: u8,
    },
    SessionStarted {
        session_id: String,
    },
    SessionError {
        reason: String,
    },
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    Users {
        users: Vec<UserInfo>,
    },
    Info {
        version: String,
        hostname: String,
        uptime: u64,
        os_name: String,
        os_version: String,
    },
    PowerResult {
        success: bool,
        message: String,
    },
    Error {
        message: String,
    },
    Bye,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub exec: String,
    pub session_type: String,
    pub desktop_names: Vec<String>,
    pub icon: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserInfo {
    pub username: String,
    pub realname: String,
    pub uid: u32,
    pub home: String,
    pub shell: String,
    pub icon_path: Option<String>,
    pub last_session: Option<String>,
}

pub async fn run_server(state: Arc<Mutex<DaemonState>>) {
    let listener = match UnixListener::bind(SOCKET_PATH) {
        Ok(l) => l,
        Err(e) => {
            error!("Failed to bind HDM socket at {}: {}", SOCKET_PATH, e);
            return;
        }
    };

    std::fs::set_permissions(SOCKET_PATH, std::fs::Permissions::from_mode(0o666)).ok();
    info!("HDM IPC listening on {}", SOCKET_PATH);

    tokio::spawn(async {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        term.recv().await;
        info!("SIGTERM received — shutting down HDM");
        let _ = std::fs::remove_file(SOCKET_PATH);
        std::process::exit(0);
    });

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                info!("Greeter client connected");
                let state_clone = state.clone();
                tokio::spawn(async move {
                    handle_client(stream, state_clone).await;
                });
            }
            Err(e) => {
                error!("Accept error: {}", e);
            }
        }
    }
}

async fn handle_client(mut stream: UnixStream, state: Arc<Mutex<DaemonState>>) {
    let (reader, mut writer) = stream.split();
    let mut lines = BufReader::new(reader).lines();
    let mut auth_user: Option<String> = None;

    // NOTE: there used to be a per-connection `fail_count: u8` here. That
    // was a client-visible-only lockout: closing and reopening the Unix
    // socket connection (trivial for anything calling `invoke()` directly,
    // bypassing the greeter UI) reset it to zero. Attempt counting and
    // lockout now live in `state.rate_limiter` (see pam_auth::RateLimiter),
    // which is shared across every connection and keyed by username, so it
    // cannot be reset by reconnecting.

    // Send welcome Info on connect
    send_response(&mut writer, &build_info_response().await).await;

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let request: GreeterRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                send_response(
                    &mut writer,
                    &DaemonResponse::Error {
                        message: format!("Parse error: {}", e),
                    },
                )
                .await;
                continue;
            }
        };

        match request {
            GreeterRequest::GetInfo => {
                send_response(&mut writer, &build_info_response().await).await;
            }
            GreeterRequest::GetSessions => {
                let sessions = crate::session::list_sessions(&state).await;
                send_response(&mut writer, &DaemonResponse::Sessions { sessions }).await;
            }
            GreeterRequest::GetUsers => {
                let users = crate::users::list_users(&state).await;
                send_response(&mut writer, &DaemonResponse::Users { users }).await;
            }
            GreeterRequest::Authenticate { username, password } => {
                if let Some(resp) = check_rate_limit(&state, &username).await {
                    send_response(&mut writer, &resp).await;
                    continue;
                }
                let allow_root = state.lock().await.config.allow_root.unwrap_or(false);
                if username == "root" && !allow_root {
                    let (attempts_left, locked_for) =
                        state.lock().await.rate_limiter.record_failure(&username);
                    send_response(
                        &mut writer,
                        &lockout_aware_failure(
                            "Root login not permitted".to_string(),
                            attempts_left,
                            locked_for,
                        ),
                    )
                    .await;
                    continue;
                }
                info!("Auth attempt for: {}", username);
                match crate::pam_auth::authenticate(&username, &password) {
                    Ok(()) => {
                        info!("Auth success: {}", username);
                        auth_user = Some(username.clone());
                        state.lock().await.rate_limiter.record_success(&username);
                        send_response(&mut writer, &DaemonResponse::AuthSuccess { username }).await;
                    }
                    Err(reason) => {
                        warn!("Auth failure for {}: {}", username, reason);
                        let (attempts_left, locked_for) =
                            state.lock().await.rate_limiter.record_failure(&username);
                        send_response(
                            &mut writer,
                            &lockout_aware_failure(reason, attempts_left, locked_for),
                        )
                        .await;
                    }
                }
            }
            GreeterRequest::StartSession {
                username,
                session,
                env,
            } => {
                let authed = auth_user.as_deref() == Some(username.as_str());
                if !authed {
                    send_response(
                        &mut writer,
                        &DaemonResponse::Error {
                            message: "Not authenticated".to_string(),
                        },
                    )
                    .await;
                    continue;
                }
                info!("Starting session '{}' for '{}'", session, username);
                let sid = session::launch_session(&state, &username, &session, env).await;
                send_response(
                    &mut writer,
                    &DaemonResponse::SessionStarted {
                        session_id: sid.unwrap_or_else(|| "error".to_string()),
                    },
                )
                .await;
            }
            GreeterRequest::GuestLogin { session } => {
                let allow_guest = state.lock().await.config.allow_guest.unwrap_or(false);
                if !allow_guest {
                    send_response(
                        &mut writer,
                        &DaemonResponse::Error {
                            message: "Guest login is disabled in hdm.hk (allow_guest = false)"
                                .to_string(),
                        },
                    )
                    .await;
                    continue;
                }
                info!("Guest login requested for session '{}'", session);
                // Create a temporary guest account if it doesn't exist
                crate::users::ensure_guest_account().await;
                let sid = session::launch_session(&state, "guest", &session, None).await;
                auth_user = Some("guest".to_string());
                send_response(
                    &mut writer,
                    &DaemonResponse::SessionStarted {
                        session_id: sid.unwrap_or_else(|| "error".to_string()),
                    },
                )
                .await;
            }
            GreeterRequest::PatternAuth { username, pattern } => {
                if let Some(resp) = check_rate_limit(&state, &username).await {
                    send_response(&mut writer, &resp).await;
                    continue;
                }
                let home = crate::users::list_users(&state)
                    .await
                    .into_iter()
                    .find(|u| u.username == username)
                    .map(|u| u.home);
                let result = match home {
                    Some(home) => crate::pam_auth::authenticate_pattern(&username, &home, &pattern),
                    None => Err(format!("User '{}' not found", username)),
                };
                match result {
                    Ok(()) => {
                        info!("Pattern auth success: {}", username);
                        auth_user = Some(username.clone());
                        state.lock().await.rate_limiter.record_success(&username);
                        send_response(&mut writer, &DaemonResponse::AuthSuccess { username }).await;
                    }
                    Err(reason) => {
                        warn!("Pattern auth failure for {}: {}", username, reason);
                        let (attempts_left, locked_for) =
                            state.lock().await.rate_limiter.record_failure(&username);
                        send_response(
                            &mut writer,
                            &lockout_aware_failure(reason, attempts_left, locked_for),
                        )
                        .await;
                    }
                }
            }
            GreeterRequest::FingerprintAuth { username } => {
                if let Some(resp) = check_rate_limit(&state, &username).await {
                    send_response(&mut writer, &resp).await;
                    continue;
                }
                info!("Fingerprint auth requested for {}", username);
                // fprintd-verify checks the enrolled print for the *given*
                // Linux user (it's already scoped server-side by fprintd —
                // see `fprintd-enroll <user>`), so we pass -u explicitly
                // rather than trusting "whichever user last enrolled".
                let user_for_scan = username.clone();
                let result = tokio::task::spawn_blocking(move || {
                    std::process::Command::new("fprintd-verify")
                        .arg("-u")
                        .arg(&user_for_scan)
                        .arg("-f")
                        .arg("any")
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false)
                })
                .await
                .unwrap_or(false);

                if result {
                    info!("Fingerprint auth success: {}", username);
                    auth_user = Some(username.clone());
                    state.lock().await.rate_limiter.record_success(&username);
                    send_response(&mut writer, &DaemonResponse::AuthSuccess { username }).await;
                } else {
                    let (attempts_left, locked_for) =
                        state.lock().await.rate_limiter.record_failure(&username);
                    send_response(&mut writer, &lockout_aware_failure(
                        "Fingerprint not recognised, sensor unavailable, or fprintd not enrolled for this user".to_string(),
                        attempts_left, locked_for)).await;
                }
            }
            GreeterRequest::PowerAction { action } => {
                let cmd = {
                    let st = state.lock().await;
                    let power = st.config.power.clone().unwrap_or_default();
                    match action.as_str() {
                        "shutdown" => power.shutdown,
                        "reboot" => power.reboot,
                        "suspend" => power.suspend,
                        "hibernate" => power.hibernate,
                        _ => None,
                    }
                };
                if let Some(cmd) = cmd {
                    send_response(
                        &mut writer,
                        &DaemonResponse::PowerResult {
                            success: true,
                            message: format!("Executing: {}", cmd),
                        },
                    )
                    .await;
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    let _ = tokio::process::Command::new("sh")
                        .arg("-c")
                        .arg(&cmd)
                        .spawn();
                } else {
                    send_response(
                        &mut writer,
                        &DaemonResponse::PowerResult {
                            success: false,
                            message: "Unknown power action".to_string(),
                        },
                    )
                    .await;
                }
            }
            GreeterRequest::Cancel => {
                send_response(&mut writer, &DaemonResponse::Bye).await;
                break;
            }
        }
    }
    info!("Greeter client disconnected");
}

/// Checks `state.rate_limiter` for `username` and, if locked out, returns
/// the `AuthFailure` response to send back immediately (the caller should
/// `continue` the request loop without attempting the actual credential
/// check). Returns `None` when the attempt is allowed to proceed.
///
/// This is the single choke point every auth method (password, pattern,
/// fingerprint) goes through — a hostile client that skips the greeter UI
/// entirely and calls `invoke("authenticate_pattern", …)` or similar still
/// hits this same server-side check, since it lives in shared `DaemonState`
/// rather than in the UI's own signals.
async fn check_rate_limit(
    state: &Arc<Mutex<DaemonState>>,
    username: &str,
) -> Option<DaemonResponse> {
    match state.lock().await.rate_limiter.check(username) {
        crate::pam_auth::RateLimitCheck::Allowed => None,
        crate::pam_auth::RateLimitCheck::Locked { seconds_left } => {
            warn!(
                "Rejected auth attempt for '{}' — locked out for {}s more",
                username, seconds_left
            );
            Some(DaemonResponse::AuthFailure {
                reason: format!("Account locked — try again in {}s", seconds_left),
                attempts_left: 0,
            })
        }
    }
}

/// Builds the `AuthFailure` response for a failed attempt, folding in
/// whether that attempt just triggered a new lockout window.
fn lockout_aware_failure(
    base_reason: String,
    attempts_left: u32,
    locked_for_secs: Option<u64>,
) -> DaemonResponse {
    match locked_for_secs {
        Some(secs) => DaemonResponse::AuthFailure {
            reason: format!("Too many failed attempts — locked for {}s", secs),
            attempts_left: 0,
        },
        None => DaemonResponse::AuthFailure {
            reason: base_reason,
            attempts_left: attempts_left.min(u8::MAX as u32) as u8,
        },
    }
}

async fn send_response(writer: &mut tokio::net::unix::WriteHalf<'_>, response: &DaemonResponse) {
    if let Ok(mut json) = serde_json::to_string(response) {
        json.push('\n');
        let _ = writer.write_all(json.as_bytes()).await;
    }
}

async fn build_info_response() -> DaemonResponse {
    let hostname = std::fs::read_to_string("/etc/hostname")
        .unwrap_or_else(|_| "localhost".to_string())
        .trim()
        .to_string();
    let uptime = std::fs::read_to_string("/proc/uptime")
        .unwrap_or_default()
        .split_whitespace()
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0) as u64;
    let (os_name, os_version) = read_os_release();
    DaemonResponse::Info {
        version: crate::HDM_VERSION.to_string(),
        hostname,
        uptime,
        os_name,
        os_version,
    }
}

fn read_os_release() -> (String, String) {
    let content = std::fs::read_to_string("/etc/os-release")
        .or_else(|_| std::fs::read_to_string("/usr/lib/os-release"))
        .unwrap_or_default();
    let mut name = "Linux".to_string();
    let mut version = String::new();
    for line in content.lines() {
        if let Some((k, v)) = line.split_once('=') {
            let v = v.trim_matches('"').to_string();
            match k {
                "PRETTY_NAME" => name = v,
                "VERSION_ID" => version = v,
                _ => {}
            }
        }
    }
    (name, version)
}

#[cfg(test)]
mod lockout_response_tests {
    use super::*;

    #[test]
    fn plain_failure_keeps_reason_and_attempts() {
        let resp = lockout_aware_failure("Incorrect password".to_string(), 3, None);
        match resp {
            DaemonResponse::AuthFailure {
                reason,
                attempts_left,
            } => {
                assert_eq!(reason, "Incorrect password");
                assert_eq!(attempts_left, 3);
            }
            _ => panic!("expected AuthFailure"),
        }
    }

    #[test]
    fn lockout_overrides_reason_and_zeroes_attempts() {
        let resp = lockout_aware_failure("Incorrect password".to_string(), 0, Some(60));
        match resp {
            DaemonResponse::AuthFailure {
                reason,
                attempts_left,
            } => {
                assert!(reason.contains("60s"));
                assert_eq!(attempts_left, 0);
            }
            _ => panic!("expected AuthFailure"),
        }
    }
}

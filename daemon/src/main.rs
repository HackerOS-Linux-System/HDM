mod config;
mod ipc;
mod pam_auth;
mod session;
mod users;
mod vt;

use std::{fs, os::unix::fs::PermissionsExt, sync::Arc};
use tokio::sync::Mutex;
use tracing::{error, info, warn};

pub const HDM_VERSION: &str = "0.6.0";
pub const SOCKET_PATH: &str = "/run/hdm/hdm.sock";
pub const CONFIG_PATH: &str = "/etc/hdm/hdm.hk";
pub const LOG_DIR: &str = "/tmp/hdm-logs";
pub const RUN_DIR: &str = "/run/hdm";

#[derive(Debug, Clone)]
pub struct DaemonState {
    pub config: config::HdmConfig,
    pub active_session: Option<session::ActiveSession>,
    pub greeter_pid: Option<u32>,
    /// Server-side authentication lockout tracking, keyed by username.
    /// Lives here (not as a local in `ipc::handle_client`) so a client
    /// cannot bypass a lockout by simply disconnecting and reconnecting —
    /// see `pam_auth::RateLimiter` for details.
    pub rate_limiter: pam_auth::RateLimiter,
}

#[tokio::main]
async fn main() {
    init_logging();
    info!("HDM v{} starting", HDM_VERSION);

    if unsafe { libc::getuid() } != 0 {
        eprintln!("HDM must run as root (UID 0)");
        std::process::exit(1);
    }

    setup_runtime_dirs();

    // Ensure default config exists
    config::ensure_default_config();

    let cfg = config::load_config(CONFIG_PATH).unwrap_or_else(|e| {
        warn!("Config load error: {} — using defaults", e);
        config::HdmConfig::default()
    });
    info!("Config loaded from {}", CONFIG_PATH);
    info!("Autologin user: {:?}", cfg.autologin_user);

    let state = Arc::new(Mutex::new(DaemonState {
        config: cfg.clone(),
        active_session: None,
        greeter_pid: None,
        rate_limiter: pam_auth::RateLimiter::new(),
    }));

    setup_signals();

    if let Some(ref user) = cfg.autologin_user {
        let user = user.clone();
        let configured_session = cfg.autologin_session.clone();
        let delay = cfg.autologin_delay.unwrap_or(0);
        let state_clone = state.clone();
        tokio::spawn(async move {
            // Resolve against the sessions HDM actually found under
            // sessions_dir (falling back to [default] -> session, and then
            // to "blue-environment") rather than hardcoding a session id
            // here — see session::get_default_session.
            let session_type = match configured_session {
                Some(s) => s,
                None => session::get_default_session(&state_clone).await,
            };
            info!("Autologin: {} -> {} (delay={}s)", user, session_type, delay);
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            }
            session::launch_session(&state_clone, &user, &session_type, None).await;
        });
    } else if let Some(live_user) = users::find_live_user(&state).await {
        // Blue Installer live mode — see users::find_live_user() for the
        // `.live` marker file contract. No delay: a live/installer session
        // should reach the desktop (and then the installer) as fast as
        // possible, there's no "wrong user logged in" risk to wait out.
        let state_clone = state.clone();
        tokio::spawn(async move {
            let session_type = session::get_default_session(&state_clone).await;
            info!("Live-mode autologin: {} -> {}", live_user, session_type);
            session::launch_session(&state_clone, &live_user, &session_type, None).await;
        });
    } else {
        let state_clone = state.clone();
        tokio::spawn(async move {
            launch_greeter(&state_clone).await;
        });
    }

    ipc::run_server(state.clone()).await;
}

fn init_logging() {
    // Try XDG_RUNTIME_DIR first (user-writable, no root needed),
    // then /tmp/hdm-logs, finally stderr-only fallback.
    let log_dir = std::env::var("XDG_RUNTIME_DIR")
        .map(|d| format!("{}/hdm/logs", d))
        .unwrap_or_else(|_| LOG_DIR.to_string());

    let dir_ok = fs::create_dir_all(&log_dir).is_ok();
    if dir_ok {
        let file_appender = tracing_appender::rolling::daily(&log_dir, "hdm.log");
        let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
        // Intentionally leak guard so logging continues for the process lifetime.
        std::mem::forget(guard);
        tracing_subscriber::fmt()
            .with_writer(non_blocking)
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .init();
    } else {
        // Fall back to stderr — avoids panic on systems where /var/log/hdm
        // is not writable (e.g. running as a non-root developer).
        tracing_subscriber::fmt()
            .with_ansi(true)
            .with_max_level(tracing::Level::INFO)
            .init();
        tracing::warn!(
            "Could not create log directory '{}', logging to stderr",
            log_dir
        );
    }
}

fn setup_runtime_dirs() {
    for dir in &[RUN_DIR, "/run/hdm/sessions"] {
        fs::create_dir_all(dir).ok();
        fs::set_permissions(dir, fs::Permissions::from_mode(0o755)).ok();
    }
    let _ = fs::remove_file(SOCKET_PATH);
}

fn setup_signals() {
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_flags = libc::SA_NOCLDWAIT;
        sa.sa_sigaction = libc::SIG_DFL;
        libc::sigaction(libc::SIGCHLD, &sa, std::ptr::null_mut());
    }
}

async fn launch_greeter(state: &Arc<Mutex<DaemonState>>) {
    // Restarts the greeter forever whenever it exits. This used to be a
    // directly-recursive `async fn`, which the Rust compiler rejects
    // (E0733: recursion in an async fn requires boxing) even when the
    // recursive call itself is wrapped in Box::pin — the fix is to use a
    // loop instead of self-recursion.
    loop {
        let (greeter_path, vt_num, compositor) = {
            let st = state.lock().await;
            (
                st.config
                    .greeter_path
                    .clone()
                    .unwrap_or_else(|| "/usr/bin/hdm-greeter".to_string()),
                st.config.vt.unwrap_or(1),
                st.config
                    .compositor
                    .clone()
                    .unwrap_or_else(|| "cage".to_string()),
            )
        };

        let use_compositor = !compositor.is_empty() && !compositor.eq_ignore_ascii_case("none");
        if use_compositor {
            info!("Launching greeter: {} (via {})", greeter_path, compositor);
        } else {
            info!("Launching greeter: {}", greeter_path);
        }

        if let Err(e) = vt::switch_to(vt_num) {
            warn!("VT switch to {} failed: {} — continuing", vt_num, e);
        }

        let spawn_result = if use_compositor {
            spawn_greeter_command(&compositor, &greeter_path)
        } else {
            spawn_greeter_command("none", &greeter_path)
        };

        let mut child = match spawn_result {
            Ok(child) => child,
            Err(e) if use_compositor => {
                // Missing/broken compositor binary shouldn't mean "no login
                // screen at all forever" — fall back to launching the
                // greeter directly for this cycle and try the compositor
                // again next time (e.g. it gets installed later).
                error!(
                    "Failed to launch compositor '{}': {} — falling back to launching '{}' directly this cycle",
                    compositor, e, greeter_path
                );
                match spawn_greeter_command("none", &greeter_path) {
                    Ok(child) => child,
                    Err(e2) => {
                        error!("Failed to launch greeter '{}' directly too: {}", greeter_path, e2);
                        error!("Is hdm-greeter installed at {}?", greeter_path);
                        return;
                    }
                }
            }
            Err(e) => {
                error!("Failed to launch greeter '{}': {}", greeter_path, e);
                error!("Is hdm-greeter installed at {}?", greeter_path);
                return;
            }
        };

        let pid = child.id().unwrap_or(0);
        info!("Greeter process PID: {}", pid);
        state.lock().await.greeter_pid = Some(pid);
        let _ = child.wait().await;
        info!("Greeter exited — relaunching");
        state.lock().await.greeter_pid = None;
        // Loop around and relaunch the greeter after the session ends.
    }
}

/// Builds and spawns the command that actually brings up the greeter.
///
/// `compositor == "none"` spawns `greeter_path` directly (the historical
/// behavior — e.g. for an X11 greeter, or one that manages its own
/// compositor). Any other value is treated as the name/path of a
/// single-application Wayland kiosk compositor binary and the greeter is
/// wrapped as `<compositor> -s -- <greeter_path>` — this is cage's
/// (https://github.com/cage-kiosk/cage) own command-line contract (`-s`:
/// don't fall back to VT-switching on its own since HDM already handles
/// that via `vt::switch_to`) and is what actually gives the Tauri/WebKit
/// greeter a Wayland display to render into pre-login; the greeter binary
/// itself is just a windowed application, not a compositor. Any other
/// drop-in-compatible single-app compositor honoring the same `-s -- <cmd>`
/// contract works too — this isn't hardcoded to literally require `cage`.
fn spawn_greeter_command(
    compositor: &str,
    greeter_path: &str,
) -> std::io::Result<tokio::process::Child> {
    let mut cmd = if compositor.eq_ignore_ascii_case("none") || compositor.is_empty() {
        tokio::process::Command::new(greeter_path)
    } else {
        let mut c = tokio::process::Command::new(compositor);
        c.arg("-s").arg("--").arg(greeter_path);
        c
    };

    cmd.env("HDM_SOCKET", SOCKET_PATH)
        .env("HDM_CONFIG", CONFIG_PATH)
        .env("XDG_SESSION_TYPE", "wayland")
        .spawn()
}

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
        let session_type = cfg
            .autologin_session
            .clone()
            .unwrap_or_else(|| "blue-environment".to_string());
        let delay = cfg.autologin_delay.unwrap_or(0);
        info!("Autologin: {} -> {} (delay={}s)", user, session_type, delay);
        let state_clone = state.clone();
        tokio::spawn(async move {
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
        info!("Live-mode autologin: {} -> blue-environment", live_user);
        let state_clone = state.clone();
        tokio::spawn(async move {
            session::launch_session(&state_clone, &live_user, "blue-environment", None).await;
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
        let (greeter_path, vt_num) = {
            let st = state.lock().await;
            (
                st.config
                    .greeter_path
                    .clone()
                    .unwrap_or_else(|| "/usr/bin/hdm-greeter".to_string()),
                st.config.vt.unwrap_or(1),
            )
        };

        info!("Launching greeter: {}", greeter_path);

        if let Err(e) = vt::switch_to(vt_num) {
            warn!("VT switch to {} failed: {} — continuing", vt_num, e);
        }

        match tokio::process::Command::new(&greeter_path)
            .env("HDM_SOCKET", SOCKET_PATH)
            .env("HDM_CONFIG", CONFIG_PATH)
            .env("XDG_SESSION_TYPE", "wayland")
            .spawn()
        {
            Ok(mut child) => {
                let pid = child.id().unwrap_or(0);
                info!("Greeter PID: {}", pid);
                state.lock().await.greeter_pid = Some(pid);
                let _ = child.wait().await;
                info!("Greeter exited — relaunching");
                state.lock().await.greeter_pid = None;
                // Loop around and relaunch the greeter after the session ends.
            }
            Err(e) => {
                error!("Failed to launch greeter '{}': {}", greeter_path, e);
                error!("Is hdm-greeter installed at {}?", greeter_path);
                return;
            }
        }
    }
}

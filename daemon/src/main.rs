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
        let (greeter_path, vt_num, compositor, compositor_renderer, greeter_user) = {
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
                st.config.compositor_renderer.clone(),
                st.config.greeter_user.clone(),
            )
        };

        // (uid, gid) 0/0 (root) unless [general] -> greeter_user names an
        // existing system user — see resolve_greeter_runtime_user(). Either
        // way we need a real, existing, correctly-owned XDG_RUNTIME_DIR:
        // cage refuses to start at all without one ("XDG_RUNTIME_DIR is not
        // set in the environment"), which — since this function relaunches
        // the greeter in a loop — used to turn into a tight crash/respawn
        // loop rather than a one-time error.
        let (uid, gid) = session::resolve_greeter_runtime_user(greeter_user.as_deref());
        let runtime_dir = format!("/run/user/{}", uid);
        if let Err(e) = fs::create_dir_all(&runtime_dir) {
            warn!(
                "Could not create greeter XDG_RUNTIME_DIR '{}': {} — the compositor will likely fail to start",
                runtime_dir, e
            );
        }
        unsafe {
            if let Ok(cpath) = std::ffi::CString::new(runtime_dir.clone()) {
                libc::chown(cpath.as_ptr(), uid, gid);
                libc::chmod(cpath.as_ptr(), 0o700);
            }
        }

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
            spawn_greeter_command(
                &compositor,
                compositor_renderer.as_deref(),
                &greeter_path,
                &runtime_dir,
                uid,
                gid,
            )
        } else {
            spawn_greeter_command("none", None, &greeter_path, &runtime_dir, uid, gid)
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
                match spawn_greeter_command("none", None, &greeter_path, &runtime_dir, uid, gid) {
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
        let exit_status = child.wait().await;
        state.lock().await.greeter_pid = None;

        // If the greeter (or its compositor) exits almost instantly and
        // keeps doing so, respawning it as fast as possible just burns CPU
        // and floods the log (exactly what happened before this XDG_RUNTIME_DIR
        // fix — cage was exiting in well under a second, forever). A short,
        // fixed backoff turns "infinite tight loop" into "a few readable log
        // lines per second" so the real error stays visible, without giving
        // up on retrying entirely.
        match exit_status {
            Ok(status) if status.success() => {
                info!("Greeter exited normally — relaunching");
            }
            Ok(status) => {
                warn!(
                    "Greeter exited with {} — relaunching in 1s (see the log lines above this for why)",
                    status
                );
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            Err(e) => {
                warn!("Failed to wait on greeter process: {} — relaunching in 1s", e);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
        // Loop around and relaunch the greeter.
    }
}

/// Appends the flags/argv that give a specific Wayland compositor binary
/// (`cmd`, already `Command::new(compositor)`) the "run `greeter_path` as
/// my one client, and exit once it exits" contract HDM's respawn loop in
/// `launch_greeter()` needs — it decides the greeter has exited by waiting
/// on *this* process, so the compositor exiting when its client does is
/// load-bearing, not just tidy.
///
/// Different compositors spell that differently, so this switches on
/// `compositor`'s basename (case-insensitive; a full path like
/// `/usr/bin/cage` and a bare `cage` are treated the same) instead of
/// assuming every compositor speaks the same dialect — an earlier version
/// of this code hardcoded cage's contract for every compositor name, which
/// silently breaks labwc (see below) rather than failing loudly:
///
/// - **cage** (<https://github.com/cage-kiosk/cage>): `-s -- <cmd>
///   [args...]`. `-s` tells cage not to fall back to VT-switching on its
///   own, since HDM already handles that itself via `vt::switch_to`; `--`
///   ends option parsing so the remainder execs directly as `greeter_path`'s
///   own argv, no shell involved.
/// - **labwc** (<https://github.com/labwc/labwc>): a full stacking window
///   manager, not a single-app kiosk compositor — but usable as one here via
///   `-S <command>` / `--session` (labwc's man page: "Run command on
///   startup and terminate compositor on exit", exactly the behavior above).
///   Its plain `-s`/`--startup` runs the command but does *not* exit labwc
///   when it does, which would turn every greeter exit (e.g. "start
///   session" after a successful login) into an orphaned labwc process
///   HDM's loop never notices. `<command>` is also a single shell-parsed
///   string, not a `--`-terminated argv like cage's — labwc doesn't
///   recognize `--` as an argument terminator at all, so reusing cage's
///   `-S -- <path>` form would hand labwc the literal two-character string
///   `"--"` as its startup command and the greeter would simply never run.
/// - **anything else** (an unrecognized compositor name/path): falls back
///   to cage's `-s -- <cmd>` contract, since most other single-app Wayland
///   kiosk compositors modeled themselves on cage rather than on labwc's
///   full-window-manager `-S`. If that's wrong for some other compositor a
///   deployment wants to use, this is the function to extend — add another
///   name match above the fallback rather than changing the fallback
///   itself, so unrecognized-but-cage-compatible binaries keep working.
fn apply_compositor_args(cmd: &mut tokio::process::Command, compositor: &str, greeter_path: &str) {
    let name = std::path::Path::new(compositor)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(compositor);

    if name.eq_ignore_ascii_case("labwc") {
        cmd.arg("-S").arg(greeter_path);
    } else {
        cmd.arg("-s").arg("--").arg(greeter_path);
    }
}

/// Builds and spawns the command that actually brings up the greeter.
///
/// `compositor == "none"` spawns `greeter_path` directly (the historical
/// behavior — e.g. for an X11 greeter, or one that manages its own
/// compositor). Any other value is treated as the name/path of a Wayland
/// compositor binary, and the greeter is wrapped in it using that
/// compositor's own command-line contract for "run this one client and
/// exit when it exits" — see `apply_compositor_args()`, which is where
/// that per-compositor knowledge actually lives; this function itself
/// doesn't assume a specific one.
///
/// `runtime_dir` MUST already exist, owned by `uid`/`gid`, mode 0700 — see
/// the caller, `launch_greeter()` — before this is called: cage hard-fails
/// immediately ("XDG_RUNTIME_DIR is not set in the environment") without a
/// valid one, and since `launch_greeter()` relaunches on exit, a missing
/// `XDG_RUNTIME_DIR` used to turn into a tight crash/respawn loop rather
/// than a one-time, easy-to-spot error.
///
/// `(uid, gid)` are only actually dropped to (via a `pre_exec` `setgid`
/// then `setuid`) when `uid != 0` — i.e. only when `[general] ->
/// greeter_user` names a real, resolvable system user. Left unset (the
/// default), the greeter keeps running as root, same as historically:
/// running it unprivileged additionally requires that user to already have
/// the access the compositor needs to open `/dev/dri`/`/dev/input`
/// directly (the `video`/`render`/`input` groups, and ideally an active
/// `seatd` or `systemd-logind` seat session) — see the README's Compositor
/// section.
fn spawn_greeter_command(
    compositor: &str,
    compositor_renderer: Option<&str>,
    greeter_path: &str,
    runtime_dir: &str,
    uid: u32,
    gid: u32,
) -> std::io::Result<tokio::process::Child> {
    let mut cmd = if compositor.eq_ignore_ascii_case("none") || compositor.is_empty() {
        tokio::process::Command::new(greeter_path)
    } else {
        let mut c = tokio::process::Command::new(compositor);
        apply_compositor_args(&mut c, compositor, greeter_path);
        c
    };

    cmd.env("HDM_SOCKET", SOCKET_PATH)
        .env("HDM_CONFIG", CONFIG_PATH)
        .env("XDG_SESSION_TYPE", "wayland")
        .env("XDG_RUNTIME_DIR", runtime_dir);

    // hdm-greeter is a Tauri/WebKitGTK app, and WebKitGTK's DMA-BUF
    // renderer is well known to crash a *host* nested/kiosk Wayland
    // compositor it's running inside of on some Mesa/i915 (and other) GPU
    // driver combinations. Not the bug this function used to think it
    // was working around below (see compositor_renderer), but a real,
    // separate failure mode of its own, so it's still worth disabling
    // unconditionally here — it's harmless when it isn't the culprit.
    cmd.env("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    // Confirmed by a real-world log: even with WEBKIT_DISABLE_DMABUF_RENDERER
    // set above *and* the compositor itself pinned to the software `pixman`
    // renderer (see compositor_renderer below — which does stop cage/wlroots
    // crashing in its own EGL/GBM setup), the greeter can still crash with
    // the same `Assertion 'surface->initialized' failed`, now preceded by
    // `libEGL warning: failed to get driver name for fd -1` /
    // `MESA-LOADER: failed to retrieve device information` instead of any
    // cage-side `[render/egl.c:...]` lines. That signature means it's now
    // hdm-greeter's *own* process trying to open a hardware-accelerated
    // EGL/GL context (WebKitGTK's non-DMA-BUF accelerated compositing path,
    // which WEBKIT_DISABLE_DMABUF_RENDERER does not disable — it only turns
    // off one specific buffer-sharing method, not GL/EGL use in general):
    // once the compositor's own renderer is `pixman` it advertises no
    // GBM-backed DRM device over linux-dmabuf for clients to open, so the
    // greeter's EGL init gets handed an invalid fd (-1), the greeter's
    // WebKit process dies mid-setup, and cage hits the same assertion
    // tearing down that now-orphaned, half-initialized client surface —
    // a different failure with the same symptom as the one
    // WEBKIT_DISABLE_DMABUF_RENDERER addresses, not a sign that fix didn't
    // work. WEBKIT_DISABLE_COMPOSITING_MODE=1 forces WebKit fully off
    // GL/EGL and onto plain CPU (Cairo) rendering instead, which avoids
    // this regardless of what the compositor's own renderer is doing —
    // unconditional here for the same reason as
    // WEBKIT_DISABLE_DMABUF_RENDERER above: harmless when it isn't the
    // culprit, and login-screen rendering doesn't need GPU acceleration
    // enough to trade this kind of crash for it.
    cmd.env("WEBKIT_DISABLE_COMPOSITING_MODE", "1");

    // `[general] -> compositor_renderer` in hdm.hk (see the field's doc
    // comment on `HdmConfig` in config.rs). Forces the compositor's
    // `WLR_RENDERER` — e.g. `"pixman"` to sidestep a cage/wlroots
    // GLES2-over-EGL/GBM renderer crash on the *compositor's own* output
    // surface (logged as `[render/egl.c:...]` lines immediately followed
    // by `Assertion 'surface->initialized' failed`, which is a crash in
    // cage/wlroots itself — WEBKIT_DISABLE_DMABUF_RENDERER above cannot
    // touch it, since it happens before the greeter's WebKit process has
    // rendered anything at all). `None` (the default) sets nothing and
    // leaves cage/wlroots to auto-detect as before. Only meaningful when
    // an actual compositor is hosting the greeter, hence gated on
    // `compositor != "none"` here rather than being set unconditionally
    // like the two WEBKIT_DISABLE_* vars above. Pairs with
    // WEBKIT_DISABLE_COMPOSITING_MODE above: setting this to a software
    // renderer (`"pixman"`) without also forcing the greeter off GL/EGL
    // just trades cage's crash for the greeter's, as the log that prompted
    // this comment demonstrated.
    if !(compositor.eq_ignore_ascii_case("none") || compositor.is_empty()) {
        if let Some(renderer) = compositor_renderer {
            if !renderer.is_empty() {
                cmd.env("WLR_RENDERER", renderer);
            }
        }
    }

    if uid != 0 {
        unsafe {
            cmd.pre_exec(move || {
                libc::setgid(gid);
                libc::setuid(uid);
                Ok(())
            });
        }
    }

    cmd.spawn()
}

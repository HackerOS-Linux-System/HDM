#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc_client;

use ipc_client::{HdmClient, SessionInfo, UserInfo};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

type ClientState = Arc<Mutex<Option<HdmClient>>>;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AuthResult {
    pub success: bool,
    pub username: Option<String>,
    pub error: Option<String>,
    pub attempts_left: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DaemonInfo {
    pub version: String,
    pub hostname: String,
    pub uptime: u64,
    pub os_name: String,
    pub os_version: String,
    pub connected: bool,
    /// The daemon's resolved `[default] -> session` (see
    /// `session::get_default_session` on the daemon side) — the UI uses
    /// this to pre-select a session instead of hardcoding "blue-environment".
    pub default_session: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GreeterConfig {
    pub theme: String,
    pub clock_format: String,
    pub show_user_list: bool,
    pub background: Option<String>,
}

// ── Tauri v2 commands ──────────────────────────────────────────────────────

#[tauri::command]
async fn connect_daemon(state: tauri::State<'_, ClientState>) -> Result<DaemonInfo, String> {
    let socket_path =
        std::env::var("HDM_SOCKET").unwrap_or_else(|_| "/run/hdm/hdm.sock".to_string());

    match HdmClient::connect(&socket_path).await {
        Ok((client, info)) => {
            *state.lock().await = Some(client);
            Ok(DaemonInfo {
                version: info.version,
                hostname: info.hostname,
                uptime: info.uptime,
                os_name: info.os_name,
                os_version: info.os_version,
                connected: true,
                default_session: info.default_session,
            })
        }
        Err(e) => Err(format!("Cannot connect to HDM daemon: {}", e)),
    }
}

#[tauri::command]
async fn get_sessions(state: tauri::State<'_, ClientState>) -> Result<Vec<SessionInfo>, String> {
    let mut guard = state.lock().await;
    let client = guard.as_mut().ok_or("Not connected to daemon")?;
    client.get_sessions().await
}

#[tauri::command]
async fn get_users(state: tauri::State<'_, ClientState>) -> Result<Vec<UserInfo>, String> {
    let mut guard = state.lock().await;
    let client = guard.as_mut().ok_or("Not connected to daemon")?;
    client.get_users().await
}

#[tauri::command]
async fn authenticate(
    state: tauri::State<'_, ClientState>,
    username: String,
    password: String,
) -> Result<AuthResult, String> {
    let mut guard = state.lock().await;
    let client = guard.as_mut().ok_or("Not connected to daemon")?;
    client.authenticate(&username, &password).await
}

#[tauri::command]
async fn authenticate_pattern(
    state: tauri::State<'_, ClientState>,
    username: String,
    pattern: Vec<u8>,
) -> Result<AuthResult, String> {
    let mut guard = state.lock().await;
    let client = guard.as_mut().ok_or("Not connected to daemon")?;
    client.authenticate_pattern(&username, &pattern).await
}

#[tauri::command]
async fn authenticate_fingerprint(
    state: tauri::State<'_, ClientState>,
    username: String,
) -> Result<AuthResult, String> {
    let mut guard = state.lock().await;
    let client = guard.as_mut().ok_or("Not connected to daemon")?;
    client.authenticate_fingerprint(&username).await
}

/// Real hardware check — NOT a placeholder. Queries fprintd (via the
/// `fprintd-list` CLI, which wraps the same D-Bus calls a GUI would use)
/// for whether this specific user has at least one finger enrolled AND a
/// fingerprint reader is present at all. Returns false on any error
/// (missing fprintd package, no reader, no enrollment, permission denied)
/// so the UI simply hides the fingerprint option rather than offering a
/// button that can never succeed.
#[tauri::command]
async fn has_fingerprint(username: String) -> bool {
    tokio::task::spawn_blocking(move || {
        std::process::Command::new("fprintd-list")
            .arg(&username)
            .output()
            .map(|o| {
                o.status.success() && !String::from_utf8_lossy(&o.stdout).contains("no fingers")
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
async fn pattern_is_configured(username: String, home: String) -> bool {
    let _ = username;
    tokio::fs::metadata(format!("{}/.config/Blue-Environment/pattern.hash", home))
        .await
        .is_ok()
}

#[tauri::command]
async fn start_session(
    state: tauri::State<'_, ClientState>,
    username: String,
    session: String,
) -> Result<String, String> {
    let mut guard = state.lock().await;
    let client = guard.as_mut().ok_or("Not connected to daemon")?;
    client.start_session(&username, &session).await
}

#[tauri::command]
async fn power_action(
    state: tauri::State<'_, ClientState>,
    action: String,
) -> Result<bool, String> {
    let mut guard = state.lock().await;
    let client = guard.as_mut().ok_or("Not connected to daemon")?;
    client.power_action(&action).await
}

/// HDM's built-in literal defaults for the handful of `[general]` fields
/// the greeter reads. Used both to fill `default_config_content()`-style
/// text for the per-user config layer below, and as the final fallback
/// once neither /etc/hdm/hdm.hk nor ~/.config/hdm/hdm.hk sets a value —
/// kept in sync with `HdmConfig::default()` in ../daemon/src/config.rs.
const DEFAULT_THEME: &str = "graphite";
const DEFAULT_WALLPAPER: &str = "/usr/share/wallpapers/HackerOS-Wallpapers/Wallpaper23.png";
const DEFAULT_CLOCK_FORMAT: &str = "%H:%M";

#[derive(Default)]
struct GreeterRawGeneral {
    background: Option<String>,
    theme: Option<String>,
    clock_format: Option<String>,
    show_user_list: Option<bool>,
}

/// Reads just the `[general]` section of a `.hk` file (HackerOS's own
/// config format — see the comment above `hk-parser` in Cargo.toml)
/// for the handful of display fields the greeter itself needs
/// (wallpaper/theme/clock format/show_user_list). This intentionally does
/// NOT go through `hk_parser::resolve_interpolations` — the greeter only
/// ever reads plain scalar values here (background is a literal
/// filesystem path, not something that references other keys), and
/// skipping it keeps this a pure, allocation-light read with no risk of
/// surfacing a cyclic/invalid-reference error from an unrelated section of
/// the daemon's config file just to render a login screen. Used for both
/// the system config (/etc/hdm/hdm.hk) and the per-user layer below —
/// same format, same parser, just a different path.
fn read_general_section(config_path: &str) -> GreeterRawGeneral {
    let Some(content) = std::fs::read_to_string(config_path).ok() else {
        return GreeterRawGeneral::default();
    };
    let Ok(config) = hk_parser::parse_hk(&content) else {
        return GreeterRawGeneral::default();
    };
    let Some(general) = config.get("general").and_then(|v| v.as_map().ok()) else {
        return GreeterRawGeneral::default();
    };

    GreeterRawGeneral {
        background: general.get("background").and_then(|v| v.as_string().ok()),
        theme: general.get("theme").and_then(|v| v.as_string().ok()),
        clock_format: general.get("clock_format").and_then(|v| v.as_string().ok()),
        show_user_list: general.get("show_user_list").and_then(|v| v.as_bool().ok()),
    }
}

/// Where the per-user, second layer of default settings lives:
/// `$XDG_CONFIG_HOME/hdm/hdm.hk`, falling back to `~/.config/hdm/hdm.hk`
/// per the XDG Base Directory spec (this is genuine, user-editable
/// *configuration*, not disposable data, so `~/.cache` was not the right
/// call here). `None` if neither `$XDG_CONFIG_HOME` nor `$HOME` is set —
/// e.g. the daemon-spawned greeter running as root pre-login, which has
/// no meaningful personal config directory of its own anyway.
fn user_config_path() -> Option<std::path::PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return Some(std::path::PathBuf::from(xdg).join("hdm/hdm.hk"));
        }
    }
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .map(|home| std::path::PathBuf::from(home).join(".config/hdm/hdm.hk"))
}

/// The text written to a fresh `~/.config/hdm/hdm.hk` — the same
/// `[general]` keys and the same default values as the packaged
/// `/etc/hdm/hdm.hk` (see `config/hdm.hk` / `default_config_content()` in
/// ../daemon/src/config.rs), just somewhere a regular user — or a
/// contributor running `hl build.hl dev-greeter` without root — can edit
/// it directly.
fn user_default_config_content() -> String {
    format!(
        "! ~/.config/hdm/hdm.hk — per-user HDM greeter defaults\n\
         !\n\
         ! Format: .hk — same format and parser (hk-parser) as\n\
         ! /etc/hdm/hdm.hk. Full syntax reference:\n\
         !   https://hackeros-linux-system.github.io/HackerOS-Website/tools-docs/hk.html\n\
         !\n\
         ! This is a second, user-editable layer of the greeter's default\n\
         ! settings. /etc/hdm/hdm.hk (root-managed) always wins for any key\n\
         ! it sets; anything left unset there falls back to whatever is set\n\
         ! here, and only then to the greeter's own built-in literal\n\
         ! defaults. Safe to edit freely — no root needed — and never\n\
         ! overwritten once it exists (see ensure_user_default_config() in\n\
         ! greeter/src/main.rs).\n\
         \n\
         [general]\n\
         -> theme        => {theme}\n\
         -> background   => \"{wallpaper}\"\n\
         -> clock_format => \"{clock}\"\n",
        theme = DEFAULT_THEME,
        wallpaper = DEFAULT_WALLPAPER,
        clock = DEFAULT_CLOCK_FORMAT,
    )
}

/// Writes the per-user default config the first time the greeter runs, if
/// nothing is there yet — mirroring what `config::ensure_default_config()`
/// does for `/etc/hdm/hdm.hk` on the daemon side, but at user scope (the
/// greeter has no business creating files under `/etc`). Best-effort: a
/// read-only `$HOME`, a missing `$HOME` entirely, or any other write
/// failure just means there's no second config layer to fall back to,
/// which is exactly the pre-existing behavior — never fatal.
fn ensure_user_default_config() {
    let Some(path) = user_config_path() else {
        return;
    };
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let _ = std::fs::write(&path, user_default_config_content());
}

/// Fills in whatever `primary` (the system config, `/etc/hdm/hdm.hk`)
/// leaves unset from `fallback` (the per-user layer) — `primary` wins
/// field-by-field for anything it does set.
fn merge_general(primary: GreeterRawGeneral, fallback: GreeterRawGeneral) -> GreeterRawGeneral {
    GreeterRawGeneral {
        background: primary.background.or(fallback.background),
        theme: primary.theme.or(fallback.theme),
        clock_format: primary.clock_format.or(fallback.clock_format),
        show_user_list: primary.show_user_list.or(fallback.show_user_list),
    }
}

/// The effective `[general]` section: `system_config_path` (normally
/// `/etc/hdm/hdm.hk`, or `$HDM_CONFIG`) first, then the per-user layer at
/// `user_config_path()` for anything the system config leaves unset. Only
/// touches the user layer at all when the system config is incomplete —
/// a fully-specified /etc/hdm/hdm.hk never pays for a second file read.
fn resolve_general_section(system_config_path: &str) -> GreeterRawGeneral {
    let system = read_general_section(system_config_path);
    let fully_specified = system.background.is_some()
        && system.theme.is_some()
        && system.clock_format.is_some()
        && system.show_user_list.is_some();
    if fully_specified {
        return system;
    }

    let user = user_config_path()
        .filter(|p| p.exists())
        .map(|p| read_general_section(&p.to_string_lossy()))
        .unwrap_or_default();
    merge_general(system, user)
}

#[tauri::command]
fn get_wallpaper() -> Option<String> {
    // Read from HDM config
    let config_path = std::env::var("HDM_CONFIG").unwrap_or_else(|_| "/etc/hdm/hdm.hk".to_string());

    // Try to read background from the system config, falling back to the
    // per-user layer (see resolve_general_section) before giving up.
    let general = resolve_general_section(&config_path);
    if let Some(s) = general.background {
        if !s.is_empty() && std::path::Path::new(&s).exists() {
            return Some(format!("file://{}", s));
        }
    }

    // Fallback wallpaper paths, checked in order, for a system where
    // neither config layer sets [general] -> background at all.
    let paths = [
        DEFAULT_WALLPAPER,
        "/etc/hdm/wallpaper.png",
        "/etc/hdm/wallpaper.jpg",
        "/usr/share/wallpapers/default.png",
    ];
    paths
        .iter()
        .find(|p| std::path::Path::new(*p).exists())
        .map(|p| format!("file://{}", p))
}

#[tauri::command]
fn get_greeter_config() -> GreeterConfig {
    let config_path = std::env::var("HDM_CONFIG").unwrap_or_else(|_| "/etc/hdm/hdm.hk".to_string());

    let general = resolve_general_section(&config_path);

    GreeterConfig {
        theme: general.theme.unwrap_or_else(|| DEFAULT_THEME.to_string()),
        clock_format: general
            .clock_format
            .unwrap_or_else(|| DEFAULT_CLOCK_FORMAT.to_string()),
        show_user_list: general.show_user_list.unwrap_or(true),
        background: general.background.filter(|s| !s.is_empty()),
    }
}

#[tauri::command]
fn get_hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .unwrap_or_else(|_| "localhost".to_string())
        .trim()
        .to_string()
}

#[tauri::command]
fn get_current_time() -> String {
    chrono::Local::now().format("%H:%M").to_string()
}

#[tauri::command]
fn get_current_date() -> String {
    chrono::Local::now().format("%A, %B %-d, %Y").to_string()
}

// ── System status commands ──────────────────────────────────────────────────
//
// HdmBridge in tauri.ts (checkNetwork / getBattery / getVolume /
// setKeyboardLayout) called these four command names from day one, but
// none of them existed here — every call in a real (non-mock) build was
// silently swallowed by the bridge's own try/catch and fell back to a
// default (network: assumed connected, battery/volume: hidden). The UI
// never crashed, so the gap was easy to miss, but the top-bar status
// icons never reflected anything real. Implemented below, each as a thin
// wrapper around a pure, unit-testable parser so the parsing logic itself
// doesn't need root, real hardware, or a real audio daemon to verify.

/// True if any non-loopback network interface is administratively and
/// operationally up. Deliberately does NOT attempt to reach the public
/// internet (no ping, no DNS lookup, no HTTP request) — HDM is a login
/// screen that must work fully offline, so "network ok" here means
/// "link-layer connectivity exists", which is the most this command
/// should ever claim.
#[tauri::command]
async fn check_network() -> bool {
    tokio::task::spawn_blocking(|| {
        let interfaces = std::fs::read_dir("/sys/class/net")
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter_map(|name| {
                        let state =
                            std::fs::read_to_string(format!("/sys/class/net/{}/operstate", name))
                                .ok()?;
                        Some((name, state.trim().to_string()))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        any_interface_up(&interfaces)
    })
    .await
    .unwrap_or(true) // if the check itself fails, don't block login over a status icon
}

/// Pure logic split out of `check_network` so it's testable without
/// `/sys/class/net` existing (e.g. inside a container or CI runner).
fn any_interface_up(interfaces: &[(String, String)]) -> bool {
    interfaces
        .iter()
        .any(|(name, state)| name != "lo" && state == "up")
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BatteryInfo {
    pub percentage: u8,
    pub charging: bool,
}

/// Reads the first battery under /sys/class/power_supply/BAT* (works for
/// laptops; returns None on desktops with no battery, which the UI
/// already treats as "hide the battery icon").
#[tauri::command]
async fn get_battery_info() -> Option<BatteryInfo> {
    tokio::task::spawn_blocking(|| {
        let base = "/sys/class/power_supply";
        let bat_dir = std::fs::read_dir(base)
            .ok()?
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("BAT"))?
            .path();

        let capacity = std::fs::read_to_string(bat_dir.join("capacity")).ok()?;
        let status = std::fs::read_to_string(bat_dir.join("status")).ok();
        parse_battery_info(&capacity, status.as_deref())
    })
    .await
    .ok()
    .flatten()
}

/// Pure parser: `capacity` is the raw content of .../capacity (e.g. "87\n"),
/// `status` is the raw content of .../status (e.g. "Charging\n") if it was
/// readable at all.
fn parse_battery_info(capacity: &str, status: Option<&str>) -> Option<BatteryInfo> {
    let percentage: u8 = capacity.trim().parse().ok()?;
    let charging = status
        .map(|s| {
            let s = s.trim();
            s.eq_ignore_ascii_case("Charging") || s.eq_ignore_ascii_case("Full")
        })
        .unwrap_or(false);
    Some(BatteryInfo {
        percentage,
        charging,
    })
}

/// Best-effort master volume as a 0-100 percentage via `amixer`. Returns
/// None (not an error) if amixer / ALSA isn't available — audio is
/// frequently not initialised yet at the login-screen stage, so a missing
/// mixer is an expected, not exceptional, outcome.
#[tauri::command]
async fn get_volume_level() -> Option<u8> {
    tokio::task::spawn_blocking(|| {
        let output = std::process::Command::new("amixer")
            .args(["get", "Master"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        parse_amixer_volume(&String::from_utf8_lossy(&output.stdout))
    })
    .await
    .ok()
    .flatten()
}

/// Pure parser for `amixer get Master` output, e.g. a line containing
/// `Front Left: Playback 45 [72%] [on]`. Takes the first `[N%]` found.
fn parse_amixer_volume(output: &str) -> Option<u8> {
    let start = output.find('[')?;
    let rest = &output[start + 1..];
    let end = rest.find('%')?;
    rest[..end].trim().parse().ok()
}

/// Best-effort keyboard layout switch for the greeter's own session.
/// Only works when the greeter is running under X11 (or Xwayland);
/// under a pure-Wayland compositor this needs a compositor-specific IPC
/// call instead (e.g. `hyprctl keyword input:kb_layout`, `swaymsg input * xkb_layout`) —
/// see the "still needs work" notes for why that isn't wired in generically
/// here. Errors are intentionally swallowed: a failed layout switch should
/// never block someone from logging in.
#[tauri::command]
async fn set_keyboard_layout_hdm(layout: String) {
    let _ = tokio::task::spawn_blocking(move || {
        std::process::Command::new("setxkbmap")
            .arg(&layout)
            .status()
    })
    .await;
}

#[tauri::command]
fn read_user_avatar(path: String) -> Option<String> {
    let data = std::fs::read(&path).ok()?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let mime = match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(data);
    Some(format!("data:{};base64,{}", mime, b64))
}

// ── Fix: "HDM wychodzi poza ekran" (greeter renders off-screen) ───────────
//
// Root cause: tauri.conf.json previously hard-coded a 1920x1080,
// non-resizable, "fullscreen" window. On any monitor that isn't exactly
// 1920x1080 (very common: 1366x768 laptops, ultrawide/4K panels, or a
// greeter compositor that doesn't honor the `fullscreen` hint), the window
// is created at its literal configured size and can be positioned partly or
// fully outside the visible display, with no way to resize it back since
// `resizable` was false.
//
// Fix: don't trust a static size at all. On startup, read the size of the
// monitor the window actually landed on (falling back to the primary
// monitor), resize+reposition the window to exactly match it, THEN show the
// window. This makes the greeter correct on any resolution, on any
// monitor, and even across multi-monitor setups where the greeter may spawn
// on a non-primary display.
fn fit_window_to_monitor(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use tauri::{PhysicalPosition, PhysicalSize};

    let monitor = window
        .current_monitor()?
        .or(window.primary_monitor()?)
        .ok_or_else(|| tauri::Error::WindowNotFound)?;

    let pos = monitor.position();
    let size = monitor.size();

    window.set_position(PhysicalPosition::new(pos.x, pos.y))?;
    window.set_size(PhysicalSize::new(size.width, size.height))?;
    window.set_fullscreen(true)?;
    window.show()?;
    window.set_focus()?;

    Ok(())
}

fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    // Give every fresh install/checkout an editable second layer of
    // default settings at ~/.config/hdm/hdm.hk (see
    // ensure_user_default_config() and resolve_general_section() above) —
    // a no-op once that file already exists.
    ensure_user_default_config();

    let state: ClientState = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = fit_window_to_monitor(&window) {
                    tracing::warn!("Could not fit greeter window to monitor, falling back to fullscreen(): {e}");
                    let _ = window.set_fullscreen(true);
                    let _ = window.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Re-fit on any resolution/monitor change (e.g. hot-plugged
            // display, resolution switch) so the greeter never gets stuck
            // off-screen again after it's already visible.
            if let tauri::WindowEvent::ScaleFactorChanged { .. } = event {
                if let Some(webview_window) = window.app_handle().get_webview_window(window.label()) {
                    let _ = fit_window_to_monitor(&webview_window);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            connect_daemon,
            get_sessions,
            get_users,
            authenticate,
            authenticate_pattern,
            authenticate_fingerprint,
            has_fingerprint,
            pattern_is_configured,
            start_session,
            power_action,
            get_wallpaper,
            get_greeter_config,
            get_hostname,
            get_current_time,
            get_current_date,
            read_user_avatar,
            check_network,
            get_battery_info,
            get_volume_level,
            set_keyboard_layout_hdm,
        ])
        .run(tauri::generate_context!())
        .expect("HDM greeter error");
}

#[cfg(test)]
mod general_config_tests {
    use super::*;

    #[test]
    fn user_default_config_content_is_valid_hk_with_expected_defaults() {
        let content = user_default_config_content();
        let parsed = hk_parser::parse_hk(&content).expect("user default .hk must parse");
        let general = parsed
            .get("general")
            .and_then(|v| v.as_map().ok())
            .expect("[general] section must be present");

        assert_eq!(
            general.get("theme").and_then(|v| v.as_string().ok()),
            Some(DEFAULT_THEME.to_string())
        );
        assert_eq!(
            general.get("background").and_then(|v| v.as_string().ok()),
            Some(DEFAULT_WALLPAPER.to_string())
        );
        assert_eq!(
            general.get("clock_format").and_then(|v| v.as_string().ok()),
            Some(DEFAULT_CLOCK_FORMAT.to_string())
        );
    }

    #[test]
    fn merge_general_prefers_system_values_over_the_user_layer() {
        let system = GreeterRawGeneral {
            background: None,
            theme: Some("graphite".to_string()),
            clock_format: None,
            show_user_list: Some(true),
        };
        let user = GreeterRawGeneral {
            background: Some("/tmp/wallpaper.png".to_string()),
            theme: Some("midnight".to_string()),
            clock_format: Some("%I:%M %p".to_string()),
            show_user_list: Some(false),
        };

        let merged = merge_general(system, user);

        // System sets theme and show_user_list — those win outright.
        assert_eq!(merged.theme, Some("graphite".to_string()));
        assert_eq!(merged.show_user_list, Some(true));
        // System leaves background and clock_format unset — filled in
        // from the user layer instead of staying None.
        assert_eq!(merged.background, Some("/tmp/wallpaper.png".to_string()));
        assert_eq!(merged.clock_format, Some("%I:%M %p".to_string()));
    }

    #[test]
    fn merge_general_falls_back_to_literal_defaults_when_both_layers_are_empty() {
        let merged = merge_general(GreeterRawGeneral::default(), GreeterRawGeneral::default());
        assert_eq!(merged.background, None);
        assert_eq!(merged.theme, None);
        assert_eq!(merged.clock_format, None);
        assert_eq!(merged.show_user_list, None);
    }
}

#[cfg(test)]
mod system_status_parser_tests {
    use super::*;

    #[test]
    fn network_up_when_a_non_loopback_interface_is_up() {
        let ifaces = vec![
            ("lo".to_string(), "up".to_string()),
            ("eth0".to_string(), "up".to_string()),
        ];
        assert!(any_interface_up(&ifaces));
    }

    #[test]
    fn network_down_when_only_loopback_is_up() {
        let ifaces = vec![
            ("lo".to_string(), "up".to_string()),
            ("wlan0".to_string(), "down".to_string()),
        ];
        assert!(!any_interface_up(&ifaces));
    }

    #[test]
    fn network_down_with_no_interfaces() {
        assert!(!any_interface_up(&[]));
    }

    #[test]
    fn battery_info_parses_charging_state() {
        let info = parse_battery_info("87\n", Some("Charging\n")).unwrap();
        assert_eq!(info.percentage, 87);
        assert!(info.charging);
    }

    #[test]
    fn battery_info_parses_discharging_state() {
        let info = parse_battery_info("42\n", Some("Discharging\n")).unwrap();
        assert_eq!(info.percentage, 42);
        assert!(!info.charging);
    }

    #[test]
    fn battery_info_treats_full_as_not_actively_charging_but_reads_ok() {
        // "Full" still counts as charging=true here (plugged in, topped
        // off) rather than false — a laptop sitting at 100% on AC power
        // should show the "charging" icon state, not "on battery".
        let info = parse_battery_info("100\n", Some("Full\n")).unwrap();
        assert!(info.charging);
    }

    #[test]
    fn battery_info_defaults_to_not_charging_when_status_unreadable() {
        let info = parse_battery_info("55\n", None).unwrap();
        assert_eq!(info.percentage, 55);
        assert!(!info.charging);
    }

    #[test]
    fn battery_info_none_on_unparseable_capacity() {
        assert!(parse_battery_info("not-a-number\n", Some("Charging\n")).is_none());
    }

    #[test]
    fn amixer_volume_parses_percentage() {
        let sample = "Simple mixer control 'Master',0\n  \
             Front Left: Playback 45 [72%] [on]\n  \
             Front Right: Playback 45 [72%] [on]\n";
        assert_eq!(parse_amixer_volume(sample), Some(72));
    }

    #[test]
    fn amixer_volume_none_when_no_percentage_present() {
        assert_eq!(parse_amixer_volume("no percentage here"), None);
    }
}

use serde::Deserialize;
use std::fs;
use tracing::warn;

#[derive(Debug, Clone, PartialEq)]
pub struct BedmConfig {
    pub greeter_path: Option<String>,
    pub vt: Option<u8>,
    pub autologin_user: Option<String>,
    pub autologin_session: Option<String>,
    pub autologin_delay: Option<u64>,
    pub session_timeout: Option<u64>,
    pub theme: Option<String>,
    pub background: Option<String>,
    pub clock_format: Option<String>,
    pub show_user_list: Option<bool>,
    pub allow_root: Option<bool>,
    pub allow_guest: Option<bool>,
    pub minimum_uid: Option<u32>,
    pub maximum_uid: Option<u32>,
    pub sessions_dir: Option<Vec<String>>,
    pub power: Option<PowerConfig>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PowerConfig {
    pub shutdown: Option<String>,
    pub reboot: Option<String>,
    pub suspend: Option<String>,
    pub hibernate: Option<String>,
}

impl Default for BedmConfig {
    fn default() -> Self {
        Self {
            greeter_path: Some("/usr/bin/bedm-greeter".to_string()),
            vt: Some(1),
            autologin_user: None,
            autologin_session: None,
            autologin_delay: Some(0),
            session_timeout: Some(0),
            theme: Some("blue".to_string()),
            background: None,
            clock_format: Some("%H:%M".to_string()),
            show_user_list: Some(true),
            allow_root: Some(false),
            allow_guest: Some(false),
            minimum_uid: Some(1000),
            maximum_uid: Some(65533),
            sessions_dir: Some(vec![
                "/usr/share/wayland-sessions".to_string(),
                "/usr/share/xsessions".to_string(),
            ]),
            power: Some(PowerConfig::default()),
        }
    }
}

impl Default for PowerConfig {
    fn default() -> Self {
        Self {
            shutdown: Some("shutdown -h now".to_string()),
            reboot: Some("reboot".to_string()),
            suspend: Some("systemctl suspend".to_string()),
            hibernate: Some("systemctl hibernate".to_string()),
        }
    }
}

// ── Raw TOML shape ──────────────────────────────────────────────────────
//
// These structs mirror the on-disk TOML layout 1:1 (see
// `default_config_content` below / config/BEDM/bedm.toml). Every field is
// optional so that a partial config file is valid — anything left unset
// falls back to `BedmConfig::default()` in `from_raw`.

#[derive(Debug, Default, Deserialize)]
struct RawConfig {
    #[serde(default)]
    general: RawGeneral,
    autologin: Option<RawAutologin>,
    power: Option<RawPower>,
}

#[derive(Debug, Default, Deserialize)]
struct RawGeneral {
    greeter_path: Option<String>,
    vt: Option<u8>,
    session_timeout: Option<u64>,
    theme: Option<String>,
    background: Option<String>,
    clock_format: Option<String>,
    show_user_list: Option<bool>,
    allow_root: Option<bool>,
    allow_guest: Option<bool>,
    maximum_uid: Option<u32>,
    minimum_uid: Option<u32>,
    sessions_dir: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
struct RawAutologin {
    user: Option<String>,
    session: Option<String>,
    delay: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct RawPower {
    shutdown: Option<String>,
    reboot: Option<String>,
    suspend: Option<String>,
    hibernate: Option<String>,
}

fn from_raw(raw: RawConfig) -> BedmConfig {
    let defaults = BedmConfig::default();

    BedmConfig {
        greeter_path: raw.general.greeter_path.or(defaults.greeter_path),
        vt: raw.general.vt.or(defaults.vt),
        autologin_user: raw.autologin.as_ref().and_then(|a| a.user.clone()),
        autologin_session: raw.autologin.as_ref().and_then(|a| a.session.clone()),
        autologin_delay: raw
            .autologin
            .as_ref()
            .and_then(|a| a.delay)
            .or(defaults.autologin_delay),
        session_timeout: raw.general.session_timeout.or(defaults.session_timeout),
        theme: raw.general.theme.or(defaults.theme),
        background: raw.general.background,
        clock_format: raw.general.clock_format.or(defaults.clock_format),
        show_user_list: raw.general.show_user_list.or(defaults.show_user_list),
        allow_root: raw.general.allow_root.or(defaults.allow_root),
        allow_guest: raw.general.allow_guest.or(defaults.allow_guest),
        minimum_uid: raw.general.minimum_uid.or(defaults.minimum_uid),
        maximum_uid: raw.general.maximum_uid.or(defaults.maximum_uid),
        sessions_dir: raw.general.sessions_dir.or(defaults.sessions_dir),
        power: Some(PowerConfig {
            shutdown: raw
                .power
                .as_ref()
                .and_then(|p| p.shutdown.clone())
                .or_else(|| defaults.power.as_ref().and_then(|p| p.shutdown.clone())),
            reboot: raw
                .power
                .as_ref()
                .and_then(|p| p.reboot.clone())
                .or_else(|| defaults.power.as_ref().and_then(|p| p.reboot.clone())),
            suspend: raw
                .power
                .as_ref()
                .and_then(|p| p.suspend.clone())
                .or_else(|| defaults.power.as_ref().and_then(|p| p.suspend.clone())),
            hibernate: raw
                .power
                .as_ref()
                .and_then(|p| p.hibernate.clone())
                .or_else(|| defaults.power.as_ref().and_then(|p| p.hibernate.clone())),
        }),
    }
}

// ── Public API ─────────────────────────────────────────────────────────────

pub fn load_config(path: &str) -> Result<BedmConfig, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("Cannot load {}: {}", path, e))?;
    load_config_str(&content)
}

pub fn load_config_str(content: &str) -> Result<BedmConfig, String> {
    let raw: RawConfig = toml::from_str(content).map_err(|e| format!("TOML parse error: {}", e))?;
    Ok(from_raw(raw))
}

pub fn ensure_default_config() {
    let config_dir = "/etc/bedm";
    let config_path = "/etc/bedm/bedm.toml";

    if std::path::Path::new(config_path).exists() {
        return;
    }

    let _ = fs::create_dir_all(config_dir);
    let content = default_config_content();
    if let Err(e) = fs::write(config_path, content) {
        warn!("Could not write default config: {}", e);
    }
}

pub fn default_config_content() -> &'static str {
    r#"# /etc/bedm/bedm.toml — BEDM Display Manager Configuration
# Blue Environment Display Manager v1.0.0
# Format: TOML

[general]
greeter_path = "/usr/bin/bedm-greeter"
vt = 1
theme = "blue"
show_user_list = true
allow_root = false
allow_guest = false
minimum_uid = 1000
maximum_uid = 65533
clock_format = "%H:%M"
sessions_dir = ["/usr/share/wayland-sessions", "/usr/share/xsessions", "/usr/local/share/wayland-sessions"]

# Uncomment and set to enable autologin:
# [autologin]
# user = "username"
# session = "blue-environment"
# delay = 0

[power]
shutdown = "shutdown -h now"
reboot = "reboot"
suspend = "systemctl suspend"
hibernate = "systemctl hibernate"
"#
}

#[cfg(test)]
mod default_config_tests {
    use super::*;

    #[test]
    fn default_config_content_is_valid_toml() {
        // A malformed r#"..."# literal would silently write a broken
        // config to disk on every fresh install via ensure_default_config()
        // — this test would catch that at CI time instead of on a user's
        // first boot.
        assert!(load_config_str(default_config_content()).is_ok());
    }

    /// Guards against `config/bedm.toml` (the packaged file installed by
    /// build.hl / the .deb / .rpm for fresh installs) drifting out of sync
    /// with this function, which is what the daemon itself writes on first
    /// boot via `ensure_default_config()` when no config file exists yet.
    /// Two different install paths (self-bootstrap vs. packaged file)
    /// silently disagreeing about the default config is exactly the kind
    /// of thing that's invisible until a user diffs `/etc/bedm/bedm.toml`
    /// against the docs and can't figure out why.
    ///
    /// Compares *parsed* config rather than raw text: the packaged file
    /// carries an extra maintainer comment block explaining why it must
    /// stay in sync, which default_config_content() intentionally doesn't
    /// (it's written to a live system's /etc/bedm/bedm.toml verbatim).
    #[test]
    fn packaged_config_file_matches_default_config_content() {
        let packaged_text = std::fs::read_to_string("../config/bedm.toml")
            .expect("../config/bedm.toml should exist relative to the daemon crate root");
        let packaged =
            load_config_str(&packaged_text).expect("../config/bedm.toml must be valid TOML");
        let builtin = load_config_str(default_config_content())
            .expect("default_config_content() must be valid TOML");
        assert_eq!(
            packaged, builtin,
            "config/bedm.toml has drifted from default_config_content() — keep their [general]/[power] values identical"
        );
    }
}

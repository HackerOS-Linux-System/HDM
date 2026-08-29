use hk_parser::{load_hk_file, parse_hk, resolve_interpolations, HkConfig, HkValue};
use indexmap::IndexMap;
use std::fs;
use tracing::warn;

#[derive(Debug, Clone, PartialEq)]
pub struct HdmConfig {
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

impl Default for HdmConfig {
    fn default() -> Self {
        Self {
            greeter_path: Some("/usr/bin/hdm-greeter".to_string()),
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
            // NOTE: kept in sync with default_config_content()'s
            // `sessions_dir` list below (see
            // `default_config_content_matches_hdm_config_default` test) —
            // these used to list only the first two entries here while the
            // packaged/self-bootstrapped config shipped a third
            // (`/usr/local/share/wayland-sessions`), so a daemon that found
            // *no* config file at all silently searched a different,
            // smaller set of session directories than one that loaded the
            // freshly-written default file.
            sessions_dir: Some(vec![
                "/usr/share/wayland-sessions".to_string(),
                "/usr/share/xsessions".to_string(),
                "/usr/local/share/wayland-sessions".to_string(),
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

// ── .hk config shape ─────────────────────────────────────────────────────
//
// HDM's configuration lives at /etc/hdm/hdm.hk in HackerOS's own `.hk`
// format (see config/hdm.hk / default_config_content() below), parsed via
// the `hk-parser` crate (https://hackeros-linux-system.github.io/HackerOS-Website/tools-docs/hk.html)
// rather than TOML. `.hk` has no serde integration of its own — a parsed
// file comes back as a plain `HkConfig` (an `IndexMap<String, HkValue>`,
// one entry per top-level `[section]`), so unlike the old TOML-based
// `RawConfig`/`RawGeneral`/... structs, there is no `#[derive(Deserialize)]`
// step here. Instead `from_hk` below walks the parsed sections by hand via
// a handful of small typed accessor helpers, falling back to
// `HdmConfig::default()` for anything missing or the wrong type — exactly
// mirroring the old "every field optional, partial config file is valid"
// behavior.

/// Looks up a top-level `[section]` and returns it as a map, or `None` if
/// the section is absent (e.g. no `[autologin]` block at all) or is
/// present but isn't a map (which `.hk`'s own grammar makes impossible for
/// a `[section]` header, but `as_map()` still returns `Err` defensively
/// rather than panicking if that ever changes).
fn section<'a>(config: &'a HkConfig, name: &str) -> Option<&'a IndexMap<String, HkValue>> {
    config.get(name).and_then(|v| v.as_map().ok())
}

fn get_string(map: &IndexMap<String, HkValue>, key: &str) -> Option<String> {
    map.get(key).and_then(|v| v.as_string().ok())
}

fn get_bool(map: &IndexMap<String, HkValue>, key: &str) -> Option<bool> {
    map.get(key).and_then(|v| v.as_bool().ok())
}

fn get_u64(map: &IndexMap<String, HkValue>, key: &str) -> Option<u64> {
    map.get(key).and_then(|v| v.as_number().ok()).map(|n| n as u64)
}

fn get_u32(map: &IndexMap<String, HkValue>, key: &str) -> Option<u32> {
    map.get(key).and_then(|v| v.as_number().ok()).map(|n| n as u32)
}

fn get_u8(map: &IndexMap<String, HkValue>, key: &str) -> Option<u8> {
    map.get(key).and_then(|v| v.as_number().ok()).map(|n| n as u8)
}

/// Reads a `.hk` array value as a `Vec<String>`, coercing each element via
/// `HkValue::as_string()` (so a stray bare number/bool item in the array
/// still comes through rather than silently vanishing) and dropping only
/// elements that are themselves arrays/maps, which have no string form.
fn get_string_array(map: &IndexMap<String, HkValue>, key: &str) -> Option<Vec<String>> {
    map.get(key)
        .and_then(|v| v.as_array().ok())
        .map(|arr| arr.iter().filter_map(|item| item.as_string().ok()).collect())
}

fn from_hk(config: &HkConfig) -> HdmConfig {
    let defaults = HdmConfig::default();

    let general = section(config, "general");
    let autologin = section(config, "autologin");
    let power_raw = section(config, "power");

    HdmConfig {
        greeter_path: general
            .and_then(|g| get_string(g, "greeter_path"))
            .or(defaults.greeter_path),
        vt: general.and_then(|g| get_u8(g, "vt")).or(defaults.vt),
        autologin_user: autologin.and_then(|a| get_string(a, "user")),
        autologin_session: autologin.and_then(|a| get_string(a, "session")),
        autologin_delay: autologin
            .and_then(|a| get_u64(a, "delay"))
            .or(defaults.autologin_delay),
        session_timeout: general
            .and_then(|g| get_u64(g, "session_timeout"))
            .or(defaults.session_timeout),
        theme: general.and_then(|g| get_string(g, "theme")).or(defaults.theme),
        background: general.and_then(|g| get_string(g, "background")),
        clock_format: general
            .and_then(|g| get_string(g, "clock_format"))
            .or(defaults.clock_format),
        show_user_list: general
            .and_then(|g| get_bool(g, "show_user_list"))
            .or(defaults.show_user_list),
        allow_root: general
            .and_then(|g| get_bool(g, "allow_root"))
            .or(defaults.allow_root),
        allow_guest: general
            .and_then(|g| get_bool(g, "allow_guest"))
            .or(defaults.allow_guest),
        minimum_uid: general
            .and_then(|g| get_u32(g, "minimum_uid"))
            .or(defaults.minimum_uid),
        maximum_uid: general
            .and_then(|g| get_u32(g, "maximum_uid"))
            .or(defaults.maximum_uid),
        sessions_dir: general
            .and_then(|g| get_string_array(g, "sessions_dir"))
            .or(defaults.sessions_dir),
        power: Some(PowerConfig {
            shutdown: power_raw
                .and_then(|p| get_string(p, "shutdown"))
                .or_else(|| defaults.power.as_ref().and_then(|p| p.shutdown.clone())),
            reboot: power_raw
                .and_then(|p| get_string(p, "reboot"))
                .or_else(|| defaults.power.as_ref().and_then(|p| p.reboot.clone())),
            suspend: power_raw
                .and_then(|p| get_string(p, "suspend"))
                .or_else(|| defaults.power.as_ref().and_then(|p| p.suspend.clone())),
            hibernate: power_raw
                .and_then(|p| get_string(p, "hibernate"))
                .or_else(|| defaults.power.as_ref().and_then(|p| p.hibernate.clone())),
        }),
    }
}

// ── Public API ─────────────────────────────────────────────────────────────

/// Loads `/etc/hdm/hdm.hk` (or whatever `path` points at) from disk via
/// `hk_parser::load_hk_file`, resolves any `${...}` interpolations
/// (references to other keys and `${env:VAR}` environment lookups) in
/// place via `hk_parser::resolve_interpolations`, then converts the parsed
/// `.hk` tree into a `HdmConfig`.
pub fn load_config(path: &str) -> Result<HdmConfig, String> {
    let mut config =
        load_hk_file(path).map_err(|e| format!("Cannot load {}: {}", path, e))?;
    resolve_interpolations(&mut config)
        .map_err(|e| format!(".hk interpolation error in {}: {}", path, e))?;
    Ok(from_hk(&config))
}

/// Same as `load_config`, but parses an in-memory string instead of
/// reading from disk — used for `default_config_content()` (below) and by
/// the test suite, so both can be exercised without touching the
/// filesystem.
pub fn load_config_str(content: &str) -> Result<HdmConfig, String> {
    let mut config = parse_hk(content).map_err(|e| format!(".hk parse error: {}", e))?;
    resolve_interpolations(&mut config).map_err(|e| format!(".hk interpolation error: {}", e))?;
    Ok(from_hk(&config))
}

pub fn ensure_default_config() {
    let config_dir = "/etc/hdm";
    let config_path = "/etc/hdm/hdm.hk";

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
    r#"! /etc/hdm/hdm.hk — HDM (HackerOS Display Manager) Configuration
! Format: .hk — see https://hackeros-linux-system.github.io/HackerOS-Website/tools-docs/hk.html

[general]
-> greeter_path   => "/usr/bin/hdm-greeter"
-> vt             => 1
-> theme          => blue
-> show_user_list => true
-> allow_root     => false
-> allow_guest    => false
-> minimum_uid    => 1000
-> maximum_uid    => 65533
-> clock_format   => "%H:%M"
-> sessions_dir   => ["/usr/share/wayland-sessions", "/usr/share/xsessions", "/usr/local/share/wayland-sessions"]

! Uncomment and fill in to enable autologin:
! [autologin]
! -> user    => username
! -> session => blue-environment
! -> delay   => 0

[power]
-> shutdown  => "shutdown -h now"
-> reboot    => reboot
-> suspend   => "systemctl suspend"
-> hibernate => "systemctl hibernate"
"#
}

#[cfg(test)]
mod default_config_tests {
    use super::*;

    #[test]
    fn default_config_content_is_valid_hk() {
        // A malformed r#"..."# literal would silently write a broken
        // config to disk on every fresh install via ensure_default_config()
        // — this test would catch that at CI time instead of on a user's
        // first boot.
        assert!(load_config_str(default_config_content()).is_ok());
    }

    #[test]
    fn default_config_content_matches_hdm_config_default() {
        // ensure_default_config() writes default_config_content() verbatim
        // to a fresh /etc/hdm/hdm.hk — if parsing it back doesn't round-trip
        // to exactly HdmConfig::default(), a brand-new install would silently
        // boot with different settings than a daemon that never found a
        // config file at all (which falls back straight to
        // HdmConfig::default() — see main.rs).
        let parsed = load_config_str(default_config_content()).unwrap();
        assert_eq!(parsed, HdmConfig::default());
    }

    /// Guards against `config/hdm.hk` (the packaged file installed by
    /// build.hl / the .deb / .rpm for fresh installs) drifting out of sync
    /// with this function, which is what the daemon itself writes on first
    /// boot via `ensure_default_config()` when no config file exists yet.
    /// Two different install paths (self-bootstrap vs. packaged file)
    /// silently disagreeing about the default config is exactly the kind
    /// of thing that's invisible until a user diffs `/etc/hdm/hdm.hk`
    /// against the docs and can't figure out why.
    ///
    /// Compares *parsed* config rather than raw text: the packaged file
    /// carries an extra maintainer comment block explaining why it must
    /// stay in sync, which default_config_content() intentionally doesn't
    /// (it's written to a live system's /etc/hdm/hdm.hk verbatim).
    #[test]
    fn packaged_config_file_matches_default_config_content() {
        let packaged_text = std::fs::read_to_string("../config/hdm.hk")
            .expect("../config/hdm.hk should exist relative to the daemon crate root");
        let packaged =
            load_config_str(&packaged_text).expect("../config/hdm.hk must be valid .hk");
        let builtin = load_config_str(default_config_content())
            .expect("default_config_content() must be valid .hk");
        assert_eq!(
            packaged, builtin,
            "config/hdm.hk has drifted from default_config_content() — keep their [general]/[power] values identical"
        );
    }

    #[test]
    fn missing_autologin_section_leaves_autologin_fields_none() {
        let cfg = load_config_str(default_config_content()).unwrap();
        assert_eq!(cfg.autologin_user, None);
        assert_eq!(cfg.autologin_session, None);
    }

    #[test]
    fn partial_hk_file_falls_back_to_defaults_for_missing_fields() {
        // Only overrides `theme` — everything else must come from
        // HdmConfig::default(), exactly like a hand-edited /etc/hdm/hdm.hk
        // that only tweaks one setting.
        let cfg = load_config_str(
            r#"
[general]
-> theme => midnight
"#,
        )
        .unwrap();
        assert_eq!(cfg.theme, Some("midnight".to_string()));
        assert_eq!(cfg.vt, HdmConfig::default().vt);
        assert_eq!(cfg.minimum_uid, HdmConfig::default().minimum_uid);
        assert_eq!(cfg.power, HdmConfig::default().power);
    }

    #[test]
    fn autologin_section_is_read_when_present() {
        let cfg = load_config_str(
            r#"
[general]
-> theme => blue

[autologin]
-> user    => alice
-> session => blue-environment
-> delay   => 3
"#,
        )
        .unwrap();
        assert_eq!(cfg.autologin_user, Some("alice".to_string()));
        assert_eq!(cfg.autologin_session, Some("blue-environment".to_string()));
        assert_eq!(cfg.autologin_delay, Some(3));
    }

    #[test]
    fn sessions_dir_array_is_parsed() {
        let cfg = load_config_str(
            r#"
[general]
-> sessions_dir => ["/opt/sessions", "/usr/share/wayland-sessions"]
"#,
        )
        .unwrap();
        assert_eq!(
            cfg.sessions_dir,
            Some(vec![
                "/opt/sessions".to_string(),
                "/usr/share/wayland-sessions".to_string(),
            ])
        );
    }

    #[test]
    fn interpolation_is_resolved_before_reading_values() {
        // Exercises hk_parser::resolve_interpolations end-to-end: `${...}`
        // references to another key in the same file must be substituted
        // before from_hk() ever sees the value.
        let cfg = load_config_str(
            r#"
[project]
-> base => /opt/hdm

[general]
-> greeter_path => ${project.base}/bin/hdm-greeter
"#,
        )
        .unwrap();
        assert_eq!(cfg.greeter_path, Some("/opt/hdm/bin/hdm-greeter".to_string()));
    }

    #[test]
    fn malformed_hk_is_reported_as_an_error_not_a_panic() {
        let result = load_config_str("this is not a valid .hk file");
        assert!(result.is_err());
    }
}

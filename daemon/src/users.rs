use crate::{ipc::UserInfo, DaemonState};
use std::{fs, sync::Arc};
use tokio::sync::Mutex;
use tracing::{info, warn};

/// Blue Installer live-mode: if the marker file named by `[autologin] ->
/// live_marker` (default `~/.config/Blue-Environment/.live`) exists for any
/// user, HDM treats that user as an autologin target — no password prompt,
/// no `[autologin] -> user`/`session` needed — exactly like a live-USB
/// session. Blue Installer (the Svelte app, not this daemon) deletes that
/// file once installation completes, so the *next* boot goes back to a
/// normal password prompt.
///
/// Toggled off entirely by `[autologin] -> live_detect => false`.
///
/// Deliberately NOT gated by `[general] -> minimum_uid`/`maximum_uid` (see
/// `list_users`): a live-boot image's baked-in user is frequently outside
/// whatever UID range an admin configures for their *installed* system, or
/// simply isn't an account anyone "created" through HDM/the greeter at all
/// — gating on that range would reintroduce exactly the "requires a created
/// user" problem this mechanism exists to avoid. The marker file itself is
/// specific and deliberate enough (an installer writes it, not a stray
/// coincidence) that scanning every account in `/etc/passwd` for it is
/// safe. Root and any account with a `nologin`/`false` shell are still
/// excluded as a defense-in-depth safety net, matching the rest of HDM's
/// login-eligibility rules, unless `allow_root` is set.
pub async fn find_live_user(state: &Arc<Mutex<DaemonState>>) -> Option<String> {
    let (live_enabled, marker_rel_path, allow_root) = {
        let st = state.lock().await;
        (
            st.config.live_autologin.unwrap_or(true),
            st.config
                .live_marker_path
                .clone()
                .unwrap_or_else(|| ".config/Blue-Environment/.live".to_string()),
            st.config.allow_root.unwrap_or(false),
        )
    };

    if !live_enabled {
        return None;
    }

    let passwd = fs::read_to_string("/etc/passwd").ok()?;
    for line in passwd.lines() {
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() < 7 {
            continue;
        }
        let username = parts[0];
        let uid: u32 = match parts[2].parse() {
            Ok(u) => u,
            Err(_) => continue,
        };
        let home = parts[5];
        let shell = parts[6].trim();

        if uid == 0 && !allow_root {
            continue;
        }
        if shell.ends_with("nologin") || shell.ends_with("false") {
            continue;
        }

        let live_marker = live_marker_for_home(home, &marker_rel_path);
        if std::path::Path::new(&live_marker).exists() {
            info!(
                "Live-mode marker found for user '{}' at {} — auto-login (no password, no [autologin] section required)",
                username, live_marker
            );
            return Some(username.to_string());
        }
    }
    None
}

/// Joins a user's home directory with the configured live-marker relative
/// path. Accepts the relative path either bare (`.config/Blue-Environment/.live`,
/// the default) or written with a leading `~/` or `/` for readability in
/// hdm.hk — both resolve the same way, relative to *that specific user's*
/// home directory, never to the daemon's own (root's) home or an absolute
/// path elsewhere on disk.
fn live_marker_for_home(home: &str, marker_rel_path: &str) -> String {
    let rel = marker_rel_path
        .strip_prefix("~/")
        .unwrap_or(marker_rel_path);
    let rel = rel.strip_prefix('/').unwrap_or(rel);
    format!("{}/{}", home.trim_end_matches('/'), rel)
}

#[cfg(test)]
mod live_marker_tests {
    use super::*;

    #[test]
    fn bare_relative_path_joins_directly() {
        assert_eq!(
            live_marker_for_home("/home/alice", ".config/Blue-Environment/.live"),
            "/home/alice/.config/Blue-Environment/.live"
        );
    }

    #[test]
    fn tilde_prefixed_path_resolves_relative_to_the_users_home() {
        assert_eq!(
            live_marker_for_home("/home/alice", "~/.config/Blue-Environment/.live"),
            "/home/alice/.config/Blue-Environment/.live"
        );
    }

    #[test]
    fn leading_slash_is_treated_as_relative_too() {
        // A hand-edited hdm.hk might write "/.config/..." by mistake —
        // treat it the same as the bare relative form rather than
        // silently checking a nonsensical "//.config/..." path.
        assert_eq!(
            live_marker_for_home("/home/alice", "/.config/Blue-Environment/.live"),
            "/home/alice/.config/Blue-Environment/.live"
        );
    }

    #[test]
    fn trailing_slash_on_home_does_not_double_up() {
        assert_eq!(
            live_marker_for_home("/home/alice/", ".config/Blue-Environment/.live"),
            "/home/alice/.config/Blue-Environment/.live"
        );
    }

    #[test]
    fn custom_marker_path_is_respected() {
        assert_eq!(
            live_marker_for_home("/home/bob", ".config/my-installer/.live-marker"),
            "/home/bob/.config/my-installer/.live-marker"
        );
    }
}

pub async fn list_users(state: &Arc<Mutex<DaemonState>>) -> Vec<UserInfo> {
    let (min_uid, max_uid) = {
        let st = state.lock().await;
        (
            st.config.minimum_uid.unwrap_or(1000),
            st.config.maximum_uid.unwrap_or(65533),
        )
    };

    let passwd = match fs::read_to_string("/etc/passwd") {
        Ok(c) => c,
        Err(e) => {
            warn!("Cannot read /etc/passwd: {}", e);
            return Vec::new();
        }
    };

    let mut users: Vec<UserInfo> = passwd
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(':').collect();
            if parts.len() < 7 {
                return None;
            }
            let username = parts[0].to_string();
            let uid: u32 = parts[2].parse().ok()?;
            let home = parts[5].to_string();
            let shell = parts[6].trim().to_string();
            let gecos = parts[4].to_string();

            if uid < min_uid || uid > max_uid {
                return None;
            }
            if shell.ends_with("nologin") || shell.ends_with("false") {
                return None;
            }

            let realname = gecos.split(',').next().unwrap_or(&username).to_string();
            let realname = if realname.is_empty() {
                username.clone()
            } else {
                realname
            };
            let icon_path = find_user_icon(&username, &home);
            let last_session = read_last_session(&username);

            Some(UserInfo {
                username,
                realname,
                uid,
                home,
                shell,
                icon_path,
                last_session,
            })
        })
        .collect();

    users.sort_by(|a, b| a.username.cmp(&b.username));
    users
}

fn find_user_icon(username: &str, home: &str) -> Option<String> {
    let candidates = [
        format!("{home}/.face"),
        format!("{home}/.face.icon"),
        format!("{home}/.config/hdm/avatar.png"),
        format!("/var/lib/AccountsService/icons/{username}"),
        format!("/usr/share/pixmaps/faces/{username}.png"),
    ];
    candidates
        .iter()
        .find(|p| std::path::Path::new(*p).exists())
        .cloned()
}

fn read_last_session(username: &str) -> Option<String> {
    let path = format!("/var/lib/hdm/users/{}/last_session", username);
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

#[allow(dead_code)]
pub fn save_last_session(username: &str, session: &str) {
    let dir = format!("/var/lib/hdm/users/{}", username);
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(format!("{}/last_session", dir), session);
}

/// Create a temporary guest account if it doesn't already exist.
/// The account has no password, a random home in /tmp, and is in no groups.
pub async fn ensure_guest_account() {
    tokio::task::spawn_blocking(|| {
        // Check if guest user exists
        let exists = std::process::Command::new("id")
            .arg("guest")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !exists {
            tracing::info!("Creating temporary guest account");
            let home = "/tmp/hdm-guest-home";
            let _ = std::fs::create_dir_all(home);

            // Create system user (no password, no login shell persistence)
            let _ = std::process::Command::new("useradd")
                .args([
                    "--no-create-home",
                    "--home-dir",
                    home,
                    "--shell",
                    "/bin/bash",
                    "--comment",
                    "HDM Guest",
                    "--no-user-group",
                    "guest",
                ])
                .status();

            // Ensure no password is needed
            let _ = std::process::Command::new("passwd")
                .args(["-d", "guest"])
                .status();

            // Set up minimal home
            let _ = std::fs::create_dir_all(format!("{home}/.config"));
            let _ = std::fs::write(
                format!("{home}/.profile"),
                "export HOME=/tmp/hdm-guest-home\n",
            );
        }
    })
    .await
    .ok();
}

/// Remove the guest account and its home directory on session end.
pub async fn cleanup_guest_account() {
    tokio::task::spawn_blocking(|| {
        tracing::info!("Cleaning up guest account");
        let _ = std::process::Command::new("userdel").arg("guest").status();
        let _ = std::fs::remove_dir_all("/tmp/hdm-guest-home");
    })
    .await
    .ok();
}

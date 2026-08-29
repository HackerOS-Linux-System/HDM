use crate::{ipc::UserInfo, DaemonState};
use std::{fs, sync::Arc};
use tokio::sync::Mutex;
use tracing::{info, warn};

/// Blue Installer live-mode: if `~/.config/Blue-Environment/.live` exists for
/// any regular user, BEDM treats that user as an autologin target — no
/// password prompt — exactly like a live-USB session. Blue Installer (the
/// Svelte app, not this daemon) deletes that file once installation
/// completes, so the *next* boot goes back to a normal password prompt.
///
/// Scans the same UID range / passwd source as `list_users` so it stays
/// consistent with what the greeter would otherwise show.
pub async fn find_live_user(state: &Arc<Mutex<DaemonState>>) -> Option<String> {
    let (min_uid, max_uid) = {
        let st = state.lock().await;
        (
            st.config.minimum_uid.unwrap_or(1000),
            st.config.maximum_uid.unwrap_or(65533),
        )
    };

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
        if uid < min_uid || uid > max_uid {
            continue;
        }

        let live_marker = format!("{}/.config/Blue-Environment/.live", home);
        if std::path::Path::new(&live_marker).exists() {
            info!(
                "Live-mode marker found for user '{}' — auto-login (no password)",
                username
            );
            return Some(username.to_string());
        }
    }
    None
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
        format!("{home}/.config/bedm/avatar.png"),
        format!("/var/lib/AccountsService/icons/{username}"),
        format!("/usr/share/pixmaps/faces/{username}.png"),
    ];
    candidates
        .iter()
        .find(|p| std::path::Path::new(*p).exists())
        .cloned()
}

fn read_last_session(username: &str) -> Option<String> {
    let path = format!("/var/lib/bedm/users/{}/last_session", username);
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

#[allow(dead_code)]
pub fn save_last_session(username: &str, session: &str) {
    let dir = format!("/var/lib/bedm/users/{}", username);
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
            let home = "/tmp/bedm-guest-home";
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
                    "BEDM Guest",
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
                "export HOME=/tmp/bedm-guest-home\n",
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
        let _ = std::fs::remove_dir_all("/tmp/bedm-guest-home");
    })
    .await
    .ok();
}

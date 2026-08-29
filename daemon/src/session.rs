use crate::{ipc::SessionInfo, DaemonState};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, sync::Arc};
use tokio::sync::Mutex;
use tracing::{error, info};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveSession {
    pub id: String,
    pub username: String,
    pub session_name: String,
    pub session_type: String,
    pub pid: u32,
    pub started_at: u64,
    pub display: Option<String>,
    pub wayland_display: Option<String>,
}

pub async fn list_sessions(state: &Arc<Mutex<DaemonState>>) -> Vec<SessionInfo> {
    let dirs = {
        let st = state.lock().await;
        st.config.sessions_dir.clone().unwrap_or_else(|| {
            vec![
                "/usr/share/wayland-sessions".to_string(),
                "/usr/share/xsessions".to_string(),
            ]
        })
    };

    let mut sessions = Vec::new();

    for dir in &dirs {
        let session_type = if dir.contains("wayland") {
            "wayland"
        } else {
            "x11"
        };
        let read_dir = match fs::read_dir(dir) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "desktop") {
                if let Some(info) = parse_session_desktop(&path, session_type) {
                    sessions.push(info);
                }
            }
        }
    }

    // Always ensure Blue Environment is available
    if !sessions.iter().any(|s| s.id.contains("blue-environment")) {
        sessions.insert(
            0,
            SessionInfo {
                id: "blue-environment".to_string(),
                name: "Blue Environment".to_string(),
                exec: "/usr/share/Blue-Environment/lib/blue-compositor".to_string(),
                session_type: "wayland".to_string(),
                desktop_names: vec!["Blue".to_string()],
                icon: Some("/usr/share/Blue-Environment/icon.png".to_string()),
                comment: Some("Blue Environment Wayland Desktop".to_string()),
            },
        );
    }

    sessions.sort_by(|a, b| {
        if a.id.contains("blue") {
            return std::cmp::Ordering::Less;
        }
        if b.id.contains("blue") {
            return std::cmp::Ordering::Greater;
        }
        a.name.cmp(&b.name)
    });

    sessions
}

fn parse_session_desktop(path: &std::path::PathBuf, session_type: &str) -> Option<SessionInfo> {
    let content = fs::read_to_string(path).ok()?;
    let mut info: HashMap<String, String> = HashMap::new();

    for line in content.lines() {
        if line.starts_with('[') && line != "[Desktop Entry]" {
            break;
        }
        if let Some((key, val)) = line.split_once('=') {
            info.insert(key.trim().to_string(), val.trim().to_string());
        }
    }

    let name = info.get("Name")?.clone();
    let exec = info.get("Exec")?.clone();
    if info.get("NoDisplay").map(|v| v == "true").unwrap_or(false) {
        return None;
    }

    let id = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_lowercase().replace(' ', "-"));

    let desktop_names = info
        .get("DesktopNames")
        .map(|d| {
            d.split(';')
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    Some(SessionInfo {
        id,
        name,
        exec,
        session_type: info
            .get("X-SessionType")
            .cloned()
            .unwrap_or_else(|| session_type.to_string()),
        desktop_names,
        icon: info.get("Icon").cloned(),
        comment: info.get("Comment").cloned(),
    })
}

pub async fn launch_session(
    state: &Arc<Mutex<DaemonState>>,
    username: &str,
    session_id: &str,
    extra_env: Option<Vec<(String, String)>>,
) -> Option<String> {
    let sessions = list_sessions(state).await;
    let session_info = sessions.iter().find(|s| s.id == session_id)?;

    let user_info = get_user_info(username)?;
    let session_uuid = Uuid::new_v4().to_string();
    let exec = session_info.exec.clone();
    let session_type = session_info.session_type.clone();

    info!(
        "Launching '{}' ({}) for user '{}' uid={}",
        session_id, exec, username, user_info.uid
    );

    // Build environment
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("USER".to_string(), username.to_string());
    env.insert("LOGNAME".to_string(), username.to_string());
    env.insert("HOME".to_string(), user_info.home.clone());
    env.insert("SHELL".to_string(), user_info.shell.clone());
    env.insert(
        "PATH".to_string(),
        "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin".to_string(),
    );
    env.insert(
        "XDG_RUNTIME_DIR".to_string(),
        format!("/run/user/{}", user_info.uid),
    );
    env.insert(
        "XDG_CONFIG_HOME".to_string(),
        format!("{}/.config", user_info.home),
    );
    env.insert(
        "XDG_DATA_HOME".to_string(),
        format!("{}/.local/share", user_info.home),
    );
    env.insert(
        "XDG_CACHE_HOME".to_string(),
        format!("{}/.cache", user_info.home),
    );
    env.insert("XDG_SEAT".to_string(), "seat0".to_string());
    env.insert("XDG_SESSION_CLASS".to_string(), "user".to_string());
    env.insert(
        "DBUS_SESSION_BUS_ADDRESS".to_string(),
        format!("unix:path=/run/user/{}/bus", user_info.uid),
    );

    if session_type == "wayland" {
        env.insert("XDG_SESSION_TYPE".to_string(), "wayland".to_string());
        env.insert("MOZ_ENABLE_WAYLAND".to_string(), "1".to_string());
        env.insert("QT_QPA_PLATFORM".to_string(), "wayland".to_string());
        env.insert("GDK_BACKEND".to_string(), "wayland,x11".to_string());
        env.insert("SDL_VIDEODRIVER".to_string(), "wayland".to_string());
        env.insert(
            "ELECTRON_OZONE_PLATFORM_HINT".to_string(),
            "wayland".to_string(),
        );
    } else {
        env.insert("XDG_SESSION_TYPE".to_string(), "x11".to_string());
        env.insert("DISPLAY".to_string(), ":0".to_string());
    }

    if let Some(extra) = extra_env {
        for (k, v) in extra {
            env.insert(k, v);
        }
    }

    // Create XDG_RUNTIME_DIR
    let runtime_dir = format!("/run/user/{}", user_info.uid);
    let _ = fs::create_dir_all(&runtime_dir);
    unsafe {
        let cpath = std::ffi::CString::new(runtime_dir.clone()).unwrap();
        libc::chown(cpath.as_ptr(), user_info.uid, user_info.gid);
        libc::chmod(cpath.as_ptr(), 0o700);
    }

    // Write session metadata
    let active = ActiveSession {
        id: session_uuid.clone(),
        username: username.to_string(),
        session_name: session_id.to_string(),
        session_type: session_type.clone(),
        pid: 0,
        started_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        display: if session_type == "x11" {
            Some(":0".to_string())
        } else {
            None
        },
        wayland_display: None,
    };
    let session_file = format!("/run/bedm/sessions/{}.json", session_uuid);
    let _ = fs::write(
        &session_file,
        serde_json::to_string_pretty(&active).unwrap_or_default(),
    );

    // Spawn session as user
    let uid = user_info.uid;
    let gid = user_info.gid;
    let home = user_info.home.clone();
    let env_vec: Vec<(String, String)> = env.into_iter().collect();
    let exec_clone = exec.clone();
    let uuid_clone = session_uuid.clone();
    let state_clone = state.clone();
    let username_for_cleanup = username.to_string();

    tokio::spawn(async move {
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg(&exec_clone);
        cmd.current_dir(&home);
        cmd.env_clear();
        for (k, v) in &env_vec {
            cmd.env(k, v);
        }

        unsafe {
            cmd.pre_exec(move || {
                libc::setgid(gid);
                libc::setuid(uid);
                Ok(())
            });
        }

        match cmd.spawn() {
            Ok(mut child) => {
                let pid = child.id().unwrap_or(0);
                info!("Session '{}' PID={}", uuid_clone, pid);
                let _ = child.wait().await;
                info!("Session '{}' ended", uuid_clone);
            }
            Err(e) => {
                error!("Session launch failed: {}", e);
            }
        }

        let _ = fs::remove_file(format!("/run/bedm/sessions/{}.json", uuid_clone));
        let mut st = state_clone.lock().await;
        if st
            .active_session
            .as_ref()
            .map(|s| s.id == uuid_clone)
            .unwrap_or(false)
        {
            st.active_session = None;
        }

        // Clean up temporary guest account if this was a guest session
        if username_for_cleanup == "guest" {
            info!("Guest session ended — cleaning up temporary account");
            crate::users::cleanup_guest_account().await;
        }
    });

    state.lock().await.active_session = Some(active);
    Some(session_uuid)
}

#[derive(Debug, Clone)]
struct UserInfo {
    uid: u32,
    gid: u32,
    home: String,
    shell: String,
}

fn get_user_info(username: &str) -> Option<UserInfo> {
    let passwd = fs::read_to_string("/etc/passwd").ok()?;
    passwd.lines().find_map(|line| {
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() >= 7 && parts[0] == username {
            Some(UserInfo {
                uid: parts[2].parse().ok()?,
                gid: parts[3].parse().ok()?,
                home: parts[5].to_string(),
                shell: parts[6].trim().to_string(),
            })
        } else {
            None
        }
    })
}

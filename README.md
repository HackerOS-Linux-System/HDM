# HDM — HackerOS Display Manager

**HDM** is a production display manager for Linux, built with:
- **Rust** daemon (`hdm`) — manages PAM auth, sessions, VT switching
- **Tauri + React** greeter (`hdm-greeter`) — the login UI
- **Unix socket IPC** — secure daemon↔greeter communication

HDM is a rival to SDDM, GDM, and LightDM, designed for the
[Blue Environment](https://github.com/HackerOS-Linux-System/Blue-environment)
Wayland desktop but works with any session.

---

## Features

- 🔐 **Real PAM authentication** via `/etc/shadow` + crypt(3)
- 🖼️ **Aurora glassmorphism UI** — animated background, user avatars
- 🖥️ **Session management** — Wayland & X11 sessions from `.desktop` files
- 👥 **Multi-user** — lists system users (UID ≥ 1000), user avatars from `~/.face`
- ⚡ **Autologin** support with configurable delay
- 🔌 **Power menu** — shutdown, reboot, suspend, hibernate with countdown
- 🔒 **Brute-force protection** — 5 attempt limit per session
- 📋 **systemd integration** — replaces `display-manager.service`
- 🎨 **Wallpaper support** — reads `/etc/hdm/wallpaper.png`

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  TTY1 / VT1                                      │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │  hdm (daemon, root)                         │ │
│  │    PAM authentication                        │ │
│  │    Session launching (drop privs to user)    │ │
│  │    VT management                             │ │
│  │    IPC: /run/hdm/hdm.sock                 │ │
│  └───────────────┬─────────────────────────────┘ │
│                  │ Unix socket (JSON)             │
│  ┌───────────────▼─────────────────────────────┐ │
│  │  hdm-greeter (Tauri, runs as _hdm user)     │ │
│  │    Solid.js UI (TypeScript + Tailwind)       │ │
│  │    Clock, user list, password input          │ │
│  │    Session picker, power menu                │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

---

## Quick Install

```bash
# Clone / extract HDM
cd HDM

# Build and install (requires Rust + Node.js)
sudo bash install.sh

# With autologin:
sudo bash install.sh --autologin myusername
```

---

## Manual Build

```bash
# Install build dependencies (Debian/Ubuntu)
apt install cargo nodejs npm libpam-dev

# Enable
sudo systemctl enable --now hdm
```

> **Rust toolchain requirement:** HDM's config parser depends on
> [`hk-parser`](https://hackeros-linux-system.github.io/HackerOS-Website/tools-docs/hk.html)
> (crates.io, `hk-parser = "0.3.2"`), which pulls in `indexmap 2.14.x` →
> `hashbrown 0.17.x`, a dependency that declares Rust's 2024 edition. That
> means building `daemon/` and `greeter/` now requires **Rust 1.85 or
> newer** (`rustup update stable` if you're on an older toolchain — the
> `rustc`/`cargo` shipped by some LTS distro repos, e.g. Ubuntu 24.04's
> `apt install cargo`, is only 1.75 and is too old for this). This is a
> requirement of the `.hk`-parsing dependency itself, not something HDM's
> own code opts into.

---

## Configuration

Edit `/etc/hdm/hdm.hk` — HDM's config is in HackerOS's own
[`.hk` format](https://hackeros-linux-system.github.io/HackerOS-Website/tools-docs/hk.html),
not TOML:

```
[general]
-> greeter_path   => "/usr/bin/hdm-greeter"
-> vt             => 1
-> theme          => blue
-> show_user_list => true
-> allow_root     => false
-> minimum_uid    => 1000

! Autologin (optional) — uncomment and fill in to enable:
! [autologin]
! -> user    => username
! -> session => blue-environment

[power]
-> shutdown  => "shutdown -h now"
-> reboot    => reboot
-> suspend   => "systemctl suspend"
-> hibernate => "systemctl hibernate"
```

---

## User Avatars

HDM reads user avatars from (in priority order):
1. `~/.face`
2. `~/.face.icon`
3. `~/.config/hdm/avatar.png`
4. `/var/lib/AccountsService/icons/<username>`

---

## Logs

```bash
# View HDM logs
journalctl -u hdm -f

# Or from file
tail -f /var/log/hdm/hdm.log
```

---

## Security notes

**Content Security Policy.** `greeter/tauri.conf.json` sets a CSP rather
than leaving it `null`. `style-src` includes `'unsafe-inline'` — this is a
deliberate, known tradeoff, not an oversight: the greeter UI sets `style="..."`
attributes at runtime throughout (a carry-over from the original Svelte
template's inline style bindings, kept for readability of long conditional
style strings as template literals rather than large object literals).
Runtime-set inline styles aren't covered by Tauri's automatic build-time
script/style hashing, so `'unsafe-inline'` is required for the UI to render
at all under a strict CSP. Everything else (`script-src`, `font-src`,
`default-src`) is locked to `'self'` with no external origins. If this
codebase migrates from string styles to `style={{...}}` objects or CSS
classes/custom properties in the future, `'unsafe-inline'` can be dropped
from `style-src` entirely.

**Fonts are self-hosted**, not loaded from Google's CDN — see
`ui/src/fonts.css`. A login screen has to render before networking is
necessarily up (fresh install, wifi still associating, airgapped
machines), so HDM ships its fonts (`@fontsource/oxanium`,
`@fontsource/dm-sans`, `@fontsource/jetbrains-mono`) as part of the built
UI bundle instead of fetching them at runtime.

**Authentication rate limiting is enforced server-side**, in
`daemon/src/pam_auth.rs::RateLimiter`, keyed by username and shared across
every IPC connection — not just in the greeter UI's own countdown display.
A client that skips the UI and calls the daemon's IPC commands directly
still hits the same lockout.

---

## Comparison

| Feature               | HDM | SDDM | GDM  | LightDM |
|-----------------------|------|------|------|---------|
| Wayland native        | ✅   | ✅   | ✅   | ⚠️      |
| X11 support           | ✅   | ✅   | ✅   | ✅      |
| PAM auth              | ✅   | ✅   | ✅   | ✅      |
| Autologin             | ✅   | ✅   | ✅   | ✅      |
| Custom themes         | ✅   | ✅   | ❌   | ✅      |
| User avatars          | ✅   | ✅   | ✅   | ✅      |
| Blue Environment      | ✅   | ❌   | ❌   | ❌      |
| Aurora UI             | ✅   | ❌   | ❌   | ❌      |
| Glassmorphism         | ✅   | ❌   | ❌   | ❌      |
| Rust backend          | ✅   | ✅   | ❌   | ❌      |
| Solid.js frontend     | ✅   | ❌   | ❌   | ❌      |

---

## License

GPL-3.0 — © 2026 HackerOS Team

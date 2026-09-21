# HDM — HackerOS Display Manager

**HDM** is a production display manager for Linux, built with:
- **Rust** daemon (`hdm`) — manages PAM auth, sessions, VT switching
- **Tauri + React** greeter (`hdm-greeter`) — the login UI
- **Unix socket IPC** — secure daemon↔greeter communication

HDM is a rival to SDDM, GDM, and LightDM, designed for the HackerOS.

---

## Features

- 🔐 **Real PAM authentication** via `/etc/shadow` + crypt(3)
- 🖼️ **Aurora glassmorphism UI** — animated background, user avatars
- 🖥️ **Session management** — Wayland & X11 sessions from `.desktop` files
- 👥 **Multi-user** — lists system users (UID ≥ 1000), user avatars from `~/.face`
- ⚡ **Autologin** support with configurable delay, plus marker-file **live-mode
  autologin** for live/installer boots (no config, no created user needed —
  see [Autologin](#autologin) below)
- 🎯 **Configurable default session** — pick which `.desktop` session HDM
  pre-selects and launches into (see [Default session](#default-session))
- 🪟 **Cage-composited greeter** — the greeter runs inside the
  [`cage`](https://github.com/cage-kiosk/cage) Wayland kiosk compositor by
  default (see [Compositor](#compositor))
- 🔌 **Power menu** — shutdown, reboot, suspend, hibernate with countdown
- 🔒 **Brute-force protection** — 5 attempt limit per session
- 📋 **systemd integration** — replaces `display-manager.service`
- 🎨 **Wallpaper support** — reads `/etc/hdm/wallpaper.png`

---

## Architecture

```
┌───────────────────────────────────────────────────────┐
│  TTY1 / VT1                                            │
│                                                         │
│  ┌───────────────────────────────────────────────────┐ │
│  │  hdm (daemon, root)                                │ │
│  │    PAM / crypt(3) authentication                   │ │
│  │    Session launching (drop privs to user)          │ │
│  │    VT management                                   │ │
│  │    Spawns + supervises the greeter (see below)     │ │
│  │    IPC: /run/hdm/hdm.sock                          │ │
│  └───────────────┬─────────────────────────────────────┘ │
│                  │ spawns, as a child process           │
│  ┌───────────────▼─────────────────────────────────────┐ │
│  │  cage -s -- hdm-greeter                              │ │
│  │    (single-app Wayland kiosk compositor, see         │ │
│  │     "Compositor" below — hosts the WebKit view       │ │
│  │     the greeter itself has no compositor of its own) │ │
│  │  ┌─────────────────────────────────────────────────┐ │ │
│  │  │  hdm-greeter (Tauri, runs as _hdm user)          │ │ │
│  │  │    Solid.js UI (TypeScript + Tailwind)           │ │ │
│  │  │    Clock, user list, password input              │ │ │
│  │  │    Session picker, power menu                    │ │ │
│  │  └─────────────────┬─────────────────────────────────┘ │ │
│  └────────────────────┼─────────────────────────────────┘ │
│                       │ Unix socket (JSON)                │
│                       ▼                                   │
│              back to hdm's IPC server above                │
└───────────────────────────────────────────────────────┘
```

**Does `hdm` launch `hdm-greeter` itself?** Yes — `hdm` is the only thing
that ever starts `hdm-greeter`; there's no separate systemd unit for it.
`launch_greeter()` in `daemon/src/main.rs` spawns it (by default wrapped in
`cage`, see below) on every boot and again every time the greeter process
exits (e.g. after "Cancel" or a crash), in a loop for as long as `hdm`
itself is running. `hdm-greeter` then connects back to `hdm`'s Unix socket
(`/run/hdm/hdm.sock`) as an ordinary IPC client — it never talks to PAM,
`/etc/shadow`, or spawns sessions itself.

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
-> theme          => graphite
-> background     => "/usr/share/wallpapers/HackerOS-Wallpapers/Wallpaper23.png"
-> show_user_list => true
-> allow_root     => false
-> minimum_uid    => 1000
-> compositor     => cage

[autologin]
-> live_detect => true
-> live_marker => ".config/Blue-Environment/.live"

! Force autologin into a specific user/session (optional) — uncomment and
! fill in:
! -> user    => username
! -> session => blue-environment

[default]
-> session => blue-environment

[power]
-> shutdown  => "shutdown -h now"
-> reboot    => reboot
-> suspend   => "systemctl suspend"
-> hibernate => "systemctl hibernate"
```

`/etc/hdm/hdm.hk` always wins. Anything it doesn't set falls back to a
second, user-editable layer at `~/.config/hdm/hdm.hk` (same `.hk` format,
auto-created with the same defaults the first time the greeter runs — see
`ensure_user_default_config()` in `greeter/src/main.rs`), and only then to
the greeter's own built-in defaults.

### Autologin

There are two independent autologin mechanisms:

1. **Config-based autologin** — `[autologin] -> user` (+ optional `session`
   and `delay`) in hdm.hk. Skips the greeter entirely and launches straight
   into that user's session after `delay` seconds. If `session` is left
   unset, it uses the [default session](#default-session) instead of a
   hardcoded value.

2. **Live-mode (marker-file) autologin** — for live-USB / installer boots
   (e.g. Blue Installer). Independent of `user`/`session`/`delay` above and
   needs **no `[autologin]` content at all** to work: if *any* user's home
   directory contains the marker file named by `live_marker` (default
   `.config/Blue-Environment/.live`), HDM logs that user in automatically —
   no password prompt, no `[autologin] -> user` to configure, and the
   account doesn't need to fall inside `minimum_uid`/`maximum_uid` either
   (`daemon/src/users.rs::find_live_user` deliberately doesn't gate on that
   range, since a live image's built-in account commonly sits outside
   whatever range an admin configures for an *installed* system). Root and
   `nologin`/`false`-shell accounts are still excluded unless `allow_root`
   is set. Blue Installer deletes the marker file once installation
   completes, so the next boot goes back to a normal password prompt.

   This is on by default; disable it with `[autologin] -> live_detect =>
   false`, or point it at a different marker with `[autologin] ->
   live_marker => "..."` (relative to each candidate user's home — a
   leading `~/` or `/` is stripped and ignored).

   Note that this still requires an actual Linux user account to exist
   (Unix has no way to run a session without a UID/GID to drop privileges
   to) — what it does *not* require is that account to have been set up
   through HDM/the greeter, given an `[autologin]` entry, or fall inside
   the configured UID range. A live image's baked-in account is enough.

Config-based autologin takes priority if both are configured; live-mode is
only checked when `[autologin] -> user` is unset.

### Default session

`[default] -> session` names the session id HDM treats as the default —
matched against the `id` of a `.desktop` file found by scanning `[general]
-> sessions_dir`, or the built-in `"blue-environment"` fallback session
(which always exists even with no matching `.desktop` file — see
`list_sessions()` in `daemon/src/session.rs`). It's used to:

- pre-select a session in the greeter's session picker (sent to the
  greeter as `default_session` in the daemon's `GetInfo`/welcome IPC
  response),
- launch into for live-mode autologin, and
- launch into for a config-based `[autologin]` entry that omits `session`.

If unset, or if it names something `sessions_dir` doesn't actually contain,
HDM logs a warning and falls back to `"blue-environment"`.

### Compositor

`[general] -> compositor` (default `cage`) is the Wayland compositor HDM
wraps `greeter_path` in before launching it — `hdm-greeter` is a windowed
Tauri/WebKit application, not a compositor, so something has to give it a
Wayland display to render into pre-login. By default HDM runs it as:

```
cage -s -- /usr/bin/hdm-greeter
```

[`cage`](https://github.com/cage-kiosk/cage) is a minimal single-application
Wayland kiosk compositor built exactly for this (fullscreen one app, exit
when it exits) and needs to be installed and on `$PATH` (e.g. `apt install
cage` / `dnf install cage`). Set `compositor` to `"none"` to launch
`greeter_path` directly instead (e.g. for an X11 greeter build, or one that
brings up its own compositor) — and if the configured compositor binary
can't be found at all, HDM logs that and falls back to launching
`greeter_path` directly for that cycle rather than refusing to show a login
screen.

HDM always creates and owns `/run/user/<uid>` and sets `XDG_RUNTIME_DIR` to
it before spawning the compositor/greeter — cage refuses to start at all
without one. By default that's `/run/user/0` (root); `[general] ->
greeter_user` (unset by default) lets you run the greeter as an
unprivileged system user instead, but only do that once that user has the
device access cage needs — see [Troubleshooting](#troubleshooting) and
`config/sysusers.d/hdm.conf`.

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

## Troubleshooting

**Running `hdm` manually without root: `HDM must run as root (UID 0)`.**
Expected — HDM reads `/etc/shadow` and issues VT ioctls, both of which
require root, so it refuses to start otherwise (see `main.rs`, checked via
`libc::getuid()`). This has nothing to do with `sudo` specifically: the
shipped `hdm.service` sets `User=root`/`Group=root` explicitly, so
`systemctl start hdm` (or booting into it as `display-manager.service`)
already runs it as root automatically — no interactive `sudo` involved at
all. `sudo hdm` in a terminal is only useful for manually testing/debugging
outside systemd, and by default `sudo` does *not* forward your shell's
`XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, etc. into root's environment — which
matters for the next issue below.

**Greeter log spammed with `[../cage.c:298] XDG_RUNTIME_DIR is not set in
the environment`, repeating forever until you `Ctrl+C`.** This was a real
bug, fixed: `launch_greeter()` used to spawn `cage` without ever setting
`XDG_RUNTIME_DIR`, so cage exited immediately every time — and because
`launch_greeter()` relaunches the greeter whenever it exits, that turned
into a tight crash/respawn loop rather than a one-time error. It now
creates and owns `/run/user/<uid>` (uid 0 unless you've set `[general] ->
greeter_user`) and sets `XDG_RUNTIME_DIR` to it before spawning, exactly
like `session::launch_session()` already did for real user sessions. A
1-second backoff was also added between relaunch attempts so any *future*
fast-crash-loop stays readable in the log instead of flooding it. If you
still see this after updating, check that `/run` isn't mounted read-only
and that nothing else is deleting `/run/user/0` out from under HDM.

**`sudo: nie udało się rozwiązać nazwy hosta ...` /
`sudo: unable to resolve host ...` before HDM even starts.** Unrelated to
HDM — it's `sudo` itself trying to resolve your machine's configured
hostname and failing, almost always because that hostname isn't listed in
`/etc/hosts`. Fix it at the OS level, e.g. add a line like
`127.0.1.1 <your-hostname>` to `/etc/hosts` (`hostnamectl hostname` shows
what it's currently set to). It's a warning, not a fatal error — `sudo`
still runs the command afterwards.

**Greeter runs but the screen is black / cage fails to open a device.**
This means cage started (so `XDG_RUNTIME_DIR` is fine) but couldn't open
`/dev/dri`/`/dev/input` — typically because `[general] -> greeter_user` is
set to a user that lacks device access. Either leave `greeter_user` unset
(root can always open these devices directly), or make sure that user is
in the `video`/`render`/`input` groups and has an active seat session
(`seatd`, or `systemd-logind` on a system with elogind/logind support) —
see `config/sysusers.d/hdm.conf` for a starting point.

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

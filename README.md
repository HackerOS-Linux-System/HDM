# HDM — HackerOS Display Manager

**HDM** is a production display manager for Linux, built with:
- **H#** daemon (`hdm`) — password/pattern/fingerprint auth, sessions, VT switching
- **Silver + Solid.js** greeter (`hdm-greeter`) — the login UI: backend in H#, frontend in
  TypeScript + Solid.js, rendered by Silver's own engine (SDL2 — no WebView, no GTK, no WebKit)
- **Unix socket IPC** — secure daemon↔greeter communication
- a small **C shim** (`common/native/`) for what H#'s std doesn't have (Unix sockets, `setuid`,
  VT ioctls, `crypt_r`, robust JSON) — bound through `extern static`

> HDM was originally written in TypeScript + Rust + Tauri. This is the H# / Silver rewrite —
> see [`MIGRATION.md`](MIGRATION.md) for what moved where and what changed.

HDM is a rival to SDDM, GDM, and LightDM, designed for the HackerOS.

---

## Features

- 🔐 **Real authentication** via `/etc/shadow` + `crypt_r(3)` (libcrypt: yescrypt, SHA-512, bcrypt…), 3×3 pattern, fprintd fingerprint
- 🖼️ **Aurora glassmorphism UI** — animated background, user avatars (Silver: CSS animations, `backdrop-filter`)
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
- 🔒 **Brute-force protection** — 5 attempts, then an escalating lockout enforced by the daemon (password, pattern *and* fingerprint share one counter)
- 📋 **systemd integration** — replaces `display-manager.service`
- 🎨 **Wallpaper support** — `[general] -> background`, falling back to `/etc/hdm/wallpaper.png`

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
│  │     "Compositor" below — hosts the Silver window;    │ │
│  │     the greeter has no compositor of its own)        │ │
│  │  ┌─────────────────────────────────────────────────┐ │ │
│  │  │  hdm-greeter (Silver, runs as root / _hdm)       │ │ │
│  │  │    Solid.js UI (TypeScript + plain CSS)          │ │ │
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
`greeter::launch()` in `daemon/src/greeter.h#` spawns it (by default wrapped in
`cage`, see below) on every boot and again every time the greeter process
exits (e.g. after "Cancel" or a crash — with a 1 s backoff), in the daemon's event
loop (`daemon/src/main.h#`) for as long as `hdm` itself is running. While a user session runs the
greeter is stopped (it must release the DRM master) and comes back after logout. `hdm-greeter` then connects back to `hdm`'s Unix socket
(`/run/hdm/hdm.sock`) as an ordinary IPC client — it never talks to PAM,
`/etc/shadow`, or spawns sessions itself.

---

## Build & install

Requirements: the [H# compiler `h#`](https://github.com/HackerOS-Linux-System/H-Sharp) and the
[`bit`](https://github.com/HackerOS-Linux-System/bit) package manager (resolves the `silver` dependency
from the index), a C compiler + `libcrypt` headers, and Node.js ≥ 20 + npm for the frontend. Silver links
SDL2 statically — see Silver's `docs/building-linux.md` for its system packages.

```bash
# Debian/Ubuntu: native shim + frontend toolchain
sudo apt install build-essential libcrypt-dev nodejs npm cage

# Build everything and install (root):
hl build.hl build
sudo hl build.hl install            # binaries -> /usr/bin/hdm, /usr/bin/hdm-greeter; unit, PAM, config

sudo systemctl enable --now hdm
```

Individual steps (what `build.hl` runs):

```bash
sh common/native/build.sh                       # libhdmshim.a (C shim, statically linked by bit)
(cd daemon  && bit build)                       # hdm
(cd greeter/frontend && npm install && npm run build)   # Solid.js -> dist/app.js + dist/app.css
(cd greeter && node ../tools/embed.mjs && bit build)    # embeds dist/ into the binary, builds hdm-greeter
```

The greeter is a **single static binary**: the built frontend (`index.html`, `app.js`, `app.css`,
fonts) is embedded by `tools/embed.mjs` (same format as `silver embed`), so there is no `frontend/`
directory to ship.

Tests: `bit test` at the root runs the C selftest, the daemon's H# tests, the greeter's H# tests and
the frontend's vitest suite. `python3 tools/lint_hsharp.py common daemon greeter` is a compiler-free
syntax lint.

Local frontend development (no Silver needed): `cd greeter/frontend && npm run watch`; outside Silver the
bridge (`src/lib/utils/silver.ts`) falls back to a mock backend returning the same wire format.

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
`gconfig::ensure_user_default_config()` in `greeter/src/gconfig.h#`), and only then to
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
   (`daemon/src/users.h#::find_live_user` deliberately doesn't gate on that
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
`list_sessions()` in `daemon/src/session.h#`). It's used to:

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
Silver (SDL2) application, not a compositor, so something has to give it a
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

Set `compositor` to `"labwc"` to use
[`labwc`](https://github.com/labwc/labwc) instead — a full wlroots-based
stacking window manager (not a single-app kiosk compositor like cage), run
here single-app-style via its own session flag:

```
labwc -S /usr/bin/hdm-greeter
```

This is a genuinely different code path, not just a different binary name:
`greeter::compositor_argv()` in `daemon/src/greeter.h#` builds cage's `-s --
<cmd>` and labwc's `-S <cmd>` separately, because the two aren't
interchangeable — labwc doesn't understand `--` as an argument terminator
at all (`-S -- <path>` would hand it the literal string `"--"` as its
startup command and the greeter would never run), and only labwc's
`-S`/`--session` — not its `-s`/`--startup` — exits the compositor when the
greeter does, which HDM's respawn loop needs.
`compositor` values other than `"none"`, `"cage"`, or `"labwc"` are assumed
to be cage-compatible (most other single-app Wayland kiosk compositors
are); if that's wrong for some other binary, `compositor_argv()` is
the place to teach HDM its contract too.

Since cage and labwc are separate compositors with their own renderer code
(wlroots' GLES2/EGL/GBM path, in both cases, unless overridden — see
`compositor_renderer` below), switching from one to the other is a
legitimate thing to try if a crash turns out to be specific to one of
them — see the `Assertion 'surface->initialized' failed` entry under
Troubleshooting.

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

**Running `hdm` manually without root: `HDM must run as root`.**
Expected — HDM reads `/etc/shadow` and issues VT ioctls, both of which require root, so it refuses to
start otherwise (checked via `getuid()` in `daemon/src/main.h#`). The shipped `hdm.service` sets
`User=root`/`Group=root` explicitly, so `systemctl start hdm` already runs it as root. `sudo hdm` in a
terminal is only useful for manual testing outside systemd.

**`cage`: `XDG_RUNTIME_DIR is not set in the environment`, repeating.** HDM creates and owns
`/run/user/<uid>` (uid 0 unless `[general] -> greeter_user` is set) and sets `XDG_RUNTIME_DIR` before
spawning the compositor (`greeter::launch()`), with a 1 s backoff between relaunches. If you still see
it, check that `/run` isn't read-only and nothing deletes `/run/user/0` under HDM.

**Greeter runs but the screen is black / cage fails to open a device.** cage started but couldn't open
`/dev/dri`/`/dev/input` — typically because `[general] -> greeter_user` points at a user without device
access. Leave `greeter_user` unset (root can open these devices directly), or put that user in the
`video`/`render`/`input` groups with an active seat session (`seatd`/`systemd-logind`) — see
`config/sysusers.d/hdm.conf`.

**cage crashes with `Assertion 'surface->initialized' failed` right after the DRM/EGL init lines.**
A cage/wlroots GLES2-over-EGL/GBM bug on some GPU driver combinations (seen on some Intel i915 setups) —
not fixable from HDM, but avoidable:
```
[general]
-> compositor_renderer => pixman
```
forces wlroots' software renderer (`WLR_RENDERER=pixman`). You can also try `compositor => labwc`.
The old WebKitGTK-specific workarounds (`WEBKIT_DISABLE_DMABUF_RENDERER`, `WEBKIT_DISABLE_COMPOSITING_MODE`,
`GDK_GL=disable`) are gone: Silver draws with SDL2's software renderer and never opens its own EGL context
in the greeter, so the "second crash" after switching to pixman no longer exists.

**The greeter shows a login screen but wallpaper/avatars are missing.** Silver loads `<img src>` straight
from the file path, so the files must be readable by the user the greeter runs as (root by default).
`[general] -> background` must be a path to an image SDL2_image can decode (PNG/JPEG/…).

**Fingerprint scan seems to hang.** `fprintd-verify` can take up to ~30 s. The daemon runs it as a child
process and kills it after 30 s; the greeter stays responsive and receives the result as the
`hdm://fingerprint` event. If your reader isn't enrolled, the tab simply isn't offered.

**`sudo: unable to resolve host ...` before HDM even starts.** Unrelated to HDM — add
`127.0.1.1 <your-hostname>` to `/etc/hosts`.

---

## Security notes

**No WebView, no CSP to maintain.** The previous Tauri build needed a Content-Security-Policy with
`style-src 'unsafe-inline'`. Silver is a custom renderer (no browser, no network stack in the page): the
frontend runs in QuickJS with only the `silver.invoke` bridge, and the bundle is embedded in the binary.

**Passwords never touch a hand-rolled JSON parser.** `std -> json` in H# is flat and does not unescape,
so all JSON parsing/escaping is done by the C shim (`common/native/hdm_shim.c`), which handles `\"`, `\\`,
`\uXXXX` and surrogate pairs and is covered by `common/native/tests/selftest.c`.

**Session processes drop privileges completely.** The child does `setsid → initgroups → setgid → setuid`
and verifies that root cannot be regained; the Rust version skipped `initgroups`, so sessions kept root's
supplementary groups.

**Fonts are self-hosted** (merged TTFs in `greeter/frontend/fonts/`, SIL OFL) and embedded in the
binary — a login screen has to render before the network is up.

**Authentication rate limiting is enforced server-side**, in `daemon/src/pam_auth.h#` (`RateLimiter`),
keyed by username and shared across every IPC connection and every method (password, pattern, fingerprint)
— not just in the greeter UI's own countdown display. Usernames containing `:`, `/` or newlines are
rejected before they can be matched against `/etc/shadow`, and entries are matched on the whole first field.

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
| H# backend            | ✅   | ❌   | ❌   | ❌      |
| Solid.js frontend     | ✅   | ❌   | ❌   | ❌      |

---

## License

GPL-3.0 — © 2026 HackerOS Team

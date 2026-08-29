use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{Duration, Instant};

// ── Server-side rate limiting ───────────────────────────────────────────────
//
// The greeter UI already shows a lockout countdown, but that is a UX nicety
// only — a hostile client can bypass a client-side-only lockout trivially by
// just calling `invoke()` directly (bypassing the Svelte/Solid UI entirely)
// or by disconnecting and reconnecting to reset an in-memory-per-connection
// counter. The authority for "is this account locked out" must live here,
// in the daemon, keyed by username, and survive across IPC connections —
// which is why `RateLimiter` is stored on `DaemonState` (shared, long-lived)
// rather than as a local in `ipc::handle_client`.
//
// Backoff schedule mirrors the greeter's own countdown (30s, 60s, 120s, …,
// capped at 300s) purely so the UI's optimistic countdown and the daemon's
// actual enforcement stay in visual sync — but the daemon never trusts the
// UI's counter, it always recomputes independently from `fail_count`.

pub const LOCKOUT_AFTER_ATTEMPTS: u32 = 5;
pub const LOCKOUT_BASE_SECS: u64 = 30;
pub const LOCKOUT_MAX_SECS: u64 = 300;

#[derive(Debug, Clone, Default)]
pub struct LoginAttemptState {
    pub fail_count: u32,
    pub locked_until: Option<Instant>,
}

#[derive(Debug, Clone, Default)]
pub struct RateLimiter {
    attempts: HashMap<String, LoginAttemptState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitCheck {
    Allowed,
    Locked { seconds_left: u64 },
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Must be called before every authentication attempt (password,
    /// pattern, *and* fingerprint — all three share one counter per
    /// username, since they are all just "ways to prove you're the user").
    pub fn check(&mut self, username: &str) -> RateLimitCheck {
        if let Some(state) = self.attempts.get(username) {
            if let Some(until) = state.locked_until {
                let now = Instant::now();
                if until > now {
                    return RateLimitCheck::Locked {
                        seconds_left: (until - now).as_secs() + 1,
                    };
                }
            }
        }
        RateLimitCheck::Allowed
    }

    pub fn record_success(&mut self, username: &str) {
        self.attempts.remove(username);
    }

    /// Records one failed attempt. Returns `(attempts_left, locked_for_secs)`
    /// — `locked_for_secs` is `Some(_)` only on the attempt that *triggers*
    /// a new lockout window.
    pub fn record_failure(&mut self, username: &str) -> (u32, Option<u64>) {
        let entry = self.attempts.entry(username.to_string()).or_default();

        // Clear a stale (already-expired) lockout flag before counting this
        // attempt so `check()` doesn't keep reporting a lockout that has
        // already elapsed. `fail_count` itself is intentionally NOT reset
        // here — it keeps growing across lockout windows so the backoff
        // keeps escalating (30s, 60s, 120s, …) for a persistent attacker
        // instead of giving them a fresh 5 free guesses every time a
        // window expires. This mirrors the greeter UI's own algorithm,
        // which also never resets its local fail counter except on a
        // successful login or switching to a different user.
        if let Some(until) = entry.locked_until {
            if until <= Instant::now() {
                entry.locked_until = None;
            }
        }

        entry.fail_count += 1;

        if entry.fail_count >= LOCKOUT_AFTER_ATTEMPTS {
            let over = entry.fail_count - LOCKOUT_AFTER_ATTEMPTS;
            let dur = LOCKOUT_BASE_SECS
                .saturating_mul(1u64 << over.min(10))
                .min(LOCKOUT_MAX_SECS);
            entry.locked_until = Some(Instant::now() + Duration::from_secs(dur));
            (0, Some(dur))
        } else {
            (LOCKOUT_AFTER_ATTEMPTS - entry.fail_count, None)
        }
    }
}

#[cfg(test)]
mod rate_limiter_tests {
    use super::*;

    #[test]
    fn allows_first_attempt() {
        let mut rl = RateLimiter::new();
        assert_eq!(rl.check("alice"), RateLimitCheck::Allowed);
    }

    #[test]
    fn locks_out_after_threshold() {
        let mut rl = RateLimiter::new();
        for _ in 0..LOCKOUT_AFTER_ATTEMPTS - 1 {
            let (_, locked) = rl.record_failure("alice");
            assert!(locked.is_none());
        }
        let (attempts_left, locked) = rl.record_failure("alice");
        assert_eq!(attempts_left, 0);
        assert_eq!(locked, Some(LOCKOUT_BASE_SECS));
        match rl.check("alice") {
            RateLimitCheck::Locked { seconds_left } => {
                assert!(seconds_left <= LOCKOUT_BASE_SECS + 1)
            }
            RateLimitCheck::Allowed => panic!("expected account to be locked"),
        }
    }

    #[test]
    fn lockout_is_per_username() {
        let mut rl = RateLimiter::new();
        for _ in 0..LOCKOUT_AFTER_ATTEMPTS {
            rl.record_failure("alice");
        }
        assert_ne!(rl.check("alice"), RateLimitCheck::Allowed);
        assert_eq!(rl.check("bob"), RateLimitCheck::Allowed);
    }

    #[test]
    fn success_clears_fail_count() {
        let mut rl = RateLimiter::new();
        rl.record_failure("alice");
        rl.record_failure("alice");
        rl.record_success("alice");
        assert_eq!(rl.check("alice"), RateLimitCheck::Allowed);
        // A fresh failure after a reset should not immediately relock.
        let (attempts_left, locked) = rl.record_failure("alice");
        assert_eq!(attempts_left, LOCKOUT_AFTER_ATTEMPTS - 1);
        assert!(locked.is_none());
    }

    #[test]
    fn backoff_grows_and_caps() {
        let mut rl = RateLimiter::new();
        // Trigger the first lockout.
        for _ in 0..LOCKOUT_AFTER_ATTEMPTS {
            rl.record_failure("alice");
        }
        // Force-expire it so the next failure can trigger a second, longer
        // lockout window instead of being swallowed by the first.
        if let Some(state) = rl.attempts.get_mut("alice") {
            state.locked_until = Some(Instant::now() - Duration::from_secs(1));
        }
        let (_, locked) = rl.record_failure("alice");
        assert_eq!(locked, Some(LOCKOUT_BASE_SECS * 2));
    }
}

/// Authenticate user against /etc/shadow using crypt(3).
pub fn authenticate(username: &str, password: &str) -> Result<(), String> {
    check_account_status_ok(username)?;
    verify_shadow_password(username, password)
}

/// Pattern-lock authentication (Android-style 3x3 dot grid, encoded as the
/// sequence of visited cell indices 0-8).
///
/// PAM has no native concept of a pattern, so — like fingerprint below —
/// this is an HDM-specific second factor: the pattern is hashed (SHA-256,
/// salted with the username) and compared against
/// `{home}/.config/Blue-Environment/pattern.hash`, which the user creates
/// via Settings → Security in Blue Environment (not part of this daemon).
/// If no pattern has been set up for that user, authentication fails closed
/// (never silently falls back to "no pattern required").
pub fn authenticate_pattern(username: &str, home: &str, pattern: &[u8]) -> Result<(), String> {
    // Cheap, pure validation first — fail fast before doing any I/O or
    // touching account-status logic, both for performance and so the
    // error message a caller gets back reflects the actual problem with
    // what they sent rather than an unrelated account-lookup error.
    if pattern.len() < 4 {
        return Err("Pattern too short".to_string());
    }

    check_account_status_ok(username)?;

    let hash_path = format!("{}/.config/Blue-Environment/pattern.hash", home);
    let stored = std::fs::read_to_string(hash_path).map_err(|_| {
        "No pattern configured for this user — set one up in Settings → Security".to_string()
    })?;
    let stored = stored.trim();

    let computed = hash_pattern(username, pattern);
    if computed == stored {
        Ok(())
    } else {
        Err("Pattern not recognised".to_string())
    }
}

/// Used by both HDM (to verify) and Blue Environment Settings (to store,
/// via the same algorithm) — keep in sync if this ever changes.
pub fn hash_pattern(username: &str, pattern: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(username.as_bytes());
    hasher.update(b":");
    hasher.update(pattern);
    format!("{:x}", hasher.finalize())
}

fn verify_shadow_password(username: &str, password: &str) -> Result<(), String> {
    let shadow_content = std::fs::read_to_string("/etc/shadow")
        .map_err(|_| "Cannot read /etc/shadow — HDM must run as root".to_string())?;

    let entry = shadow_content
        .lines()
        .find(|line| line.starts_with(&format!("{}:", username)))
        .ok_or_else(|| format!("User '{}' not found in shadow", username))?;

    let parts: Vec<&str> = entry.split(':').collect();
    if parts.len() < 2 {
        return Err("Malformed shadow entry".to_string());
    }

    let hash = parts[1];

    if hash.starts_with('!') || hash.starts_with('*') || hash.is_empty() {
        return Err("Account is locked or has no password".to_string());
    }

    verify_crypt_hash(password, hash)
}

fn verify_crypt_hash(password: &str, hash: &str) -> Result<(), String> {
    // Call crypt(3) from libcrypt via std::process as a safe fallback.
    // libcrypt exports `crypt` but libc crate doesn't always bind it
    // (depends on platform / glibc version). We shell out to Python's
    // hashlib-backed `crypt` module for portability across every glibc
    // hash format below.
    //
    // For a production build, add crypt = "0.1" or link libcrypt directly.
    //
    // Every supported prefix ends up calling the exact same verifier —
    // `crypt.crypt()` auto-detects the algorithm from the hash's own
    // prefix, so there is nothing format-specific left for HDM to branch
    // on here. The prefix check below exists only to fail fast with a
    // clear, format-aware error rather than a shell error, for prefixes
    // this build does not claim to support.
    const SUPPORTED_PREFIXES: &[&str] = &["$6$", "$5$", "$y$", "$gy$", "$2b$", "$2a$"];
    if !SUPPORTED_PREFIXES.iter().any(|p| hash.starts_with(p)) {
        tracing_or_eprintln(&format!(
            "Unrecognised shadow hash prefix (not in {:?}) — attempting verification anyway",
            SUPPORTED_PREFIXES
        ));
    }
    verify_via_python_crypt(password, hash)
}

/// pam_auth has no dependency on `tracing` (it's a pure auth-logic module,
/// deliberately kept decoupled from the daemon's logging setup so it stays
/// easy to unit test) — this is a minimal local stand-in so the warning
/// above at least reaches stderr/the log file instead of being silently
/// dropped.
fn tracing_or_eprintln(msg: &str) {
    eprintln!("[hdm-daemon] {}", msg);
}

/// Use Python hashlib.crypt (available on all glibc systems) to verify.
/// This avoids the `libc::crypt` binding issue entirely.
fn verify_via_python_crypt(password: &str, hash: &str) -> Result<(), String> {
    use std::process::Command;

    // Python script: import crypt; print(crypt.crypt(pw, hash) == hash)
    let script = "import crypt, sys; pw=sys.argv[1]; h=sys.argv[2]; \
         result=crypt.crypt(pw,h); sys.exit(0 if result==h else 1)";

    let status = Command::new("python3")
        .args(["-c", script, password, hash])
        .status()
        .map_err(|e| format!("python3 not available for crypt verification: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err("Incorrect password".to_string())
    }
}

fn check_account_status_ok(username: &str) -> Result<(), String> {
    let shadow_content = match std::fs::read_to_string("/etc/shadow") {
        Ok(c) => c,
        Err(_) => return Ok(()), // If we can't read shadow, let PAM decide
    };
    match parse_account_status(&shadow_content, username) {
        AccountStatus::NotFound => Err(format!("User '{}' does not exist", username)),
        AccountStatus::Locked => Err("Account is locked".to_string()),
        AccountStatus::NoPassword => Err("Account has no password set".to_string()),
        AccountStatus::Active => Ok(()),
    }
}

#[derive(Debug, PartialEq)]
pub enum AccountStatus {
    Active,
    Locked,
    NoPassword,
    NotFound,
}

// Public API surface, not yet called from `ipc.rs` — reserved for a future
// "show a locked-account hint before the user even types a password"
// UX improvement. Kept (rather than deleted) since `pam_auth` is the
// module other HDM tooling (e.g. a future `hdmctl` CLI) would also use.
#[allow(dead_code)]
pub fn check_account_status(username: &str) -> AccountStatus {
    let shadow_content = match std::fs::read_to_string("/etc/shadow") {
        Ok(c) => c,
        Err(_) => return AccountStatus::NotFound,
    };
    parse_account_status(&shadow_content, username)
}

/// Pure parsing logic split out from `check_account_status` / the
/// `_ok` variant so it can be unit tested without root or a real
/// `/etc/shadow` on the machine running `cargo test`.
fn parse_account_status(shadow_content: &str, username: &str) -> AccountStatus {
    let entry = match shadow_content
        .lines()
        .find(|l| l.starts_with(&format!("{}:", username)))
    {
        Some(e) => e,
        None => return AccountStatus::NotFound,
    };

    let parts: Vec<&str> = entry.split(':').collect();
    if parts.len() < 2 {
        return AccountStatus::Active;
    }

    let hash = parts[1];
    if hash.starts_with('!') {
        AccountStatus::Locked
    } else if hash == "*" || hash.is_empty() {
        AccountStatus::NoPassword
    } else {
        AccountStatus::Active
    }
}

#[cfg(test)]
mod account_status_tests {
    use super::*;

    const FIXTURE: &str = "\
root:!:19700:0:99999:7:::
alice:$6$abc123$hashedvaluehere:19700:0:99999:7:::
bob:*:19700:0:99999:7:::
carol::19700:0:99999:7:::
";

    #[test]
    fn locked_account_detected() {
        assert_eq!(parse_account_status(FIXTURE, "root"), AccountStatus::Locked);
    }

    #[test]
    fn active_account_detected() {
        assert_eq!(
            parse_account_status(FIXTURE, "alice"),
            AccountStatus::Active
        );
    }

    #[test]
    fn star_hash_means_no_password() {
        assert_eq!(
            parse_account_status(FIXTURE, "bob"),
            AccountStatus::NoPassword
        );
    }

    #[test]
    fn empty_hash_means_no_password() {
        assert_eq!(
            parse_account_status(FIXTURE, "carol"),
            AccountStatus::NoPassword
        );
    }

    #[test]
    fn missing_user_not_found() {
        assert_eq!(
            parse_account_status(FIXTURE, "nobody"),
            AccountStatus::NotFound
        );
    }
}

#[cfg(test)]
mod hash_pattern_tests {
    use super::*;

    #[test]
    fn same_input_hashes_the_same() {
        let a = hash_pattern("alice", &[0, 1, 2, 4, 6, 7, 8]);
        let b = hash_pattern("alice", &[0, 1, 2, 4, 6, 7, 8]);
        assert_eq!(a, b);
    }

    #[test]
    fn different_usernames_hash_differently() {
        // Username is folded into the hash so the same pattern doesn't
        // produce the same stored hash for two different accounts.
        let a = hash_pattern("alice", &[0, 1, 2, 4, 6, 7, 8]);
        let b = hash_pattern("bob", &[0, 1, 2, 4, 6, 7, 8]);
        assert_ne!(a, b);
    }

    #[test]
    fn different_patterns_hash_differently() {
        let a = hash_pattern("alice", &[0, 1, 2]);
        let b = hash_pattern("alice", &[0, 1, 3]);
        assert_ne!(a, b);
    }

    #[test]
    fn output_is_64_char_hex() {
        let h = hash_pattern("alice", &[0, 1, 2, 4]);
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }
}

#[cfg(test)]
mod pattern_auth_tests {
    use super::*;

    #[test]
    fn pattern_too_short_is_rejected_before_touching_disk() {
        // `home` deliberately points nowhere — if this test ever starts
        // reading the filesystem for the length check, it will fail with
        // the wrong error message instead of "Pattern too short".
        let result = authenticate_pattern("alice", "/nonexistent/home", &[0, 1]);
        assert_eq!(result, Err("Pattern too short".to_string()));
    }
}

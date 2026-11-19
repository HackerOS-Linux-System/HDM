import { createSignal, createMemo, onMount, onCleanup, For, Show } from 'solid-js';
import {
  Power,
  ChevronLeft,
  Eye,
  EyeOff,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Wifi,
  WifiOff,
  Volume2,
  VolumeX,
  Shield,
  Monitor,
  Fingerprint,
  BatteryLow,
  BatteryMedium,
  BatteryFull,
  BatteryCharging,
  Languages,
  RefreshCw,
  UserPlus,
  ZoomIn,
  ZoomOut,
  Contrast,
  LockKeyhole,
  AlertTriangle,
} from 'lucide-solid';

import Background from './lib/components/Background';
import Clock from './lib/components/Clock';
import UserCard from './lib/components/UserCard';
import SessionPicker from './lib/components/SessionPicker';
import PowerMenu from './lib/components/PowerMenu';
import PatternLock from './lib/components/PatternLock';
import { HdmBridge } from './lib/utils/silver';
import type { DaemonInfo, UserInfo, SessionInfo, Screen, PowerAction } from './lib/types';

interface KeyboardLayout {
  id: string;
  label: string;
  flag?: string;
}

const KEYBOARD_LAYOUTS: KeyboardLayout[] = [
  { id: 'us', label: 'US English', flag: 'US' },
  { id: 'pl', label: 'Polish', flag: 'PL' },
  { id: 'de', label: 'German', flag: 'DE' },
  { id: 'fr', label: 'French', flag: 'FR' },
  { id: 'es', label: 'Spanish', flag: 'ES' },
  { id: 'ru', label: 'Russian', flag: 'RU' },
  { id: 'ua', label: 'Ukrainian', flag: 'UA' },
  { id: 'cz', label: 'Czech', flag: 'CZ' },
  { id: 'gb', label: 'UK English', flag: 'GB' },
  { id: 'jp', label: 'Japanese', flag: 'JP' },
  { id: 'cn', label: 'Chinese (PRC)', flag: 'CN' },
  { id: 'ar', label: 'Arabic', flag: 'AR' },
];

const LOCKOUT_AFTER_ATTEMPTS = 5;
const LOCKOUT_DURATION_SECS = 30;

type AuthMethod = 'password' | 'pattern' | 'fingerprint';

export default function App() {
  // ── Core state ──────────────────────────────────────────────────────────
  const [screen, setScreen] = createSignal<Screen>('connecting');
  const [daemon, setDaemon] = createSignal<DaemonInfo | null>(null);
  const [users, setUsers] = createSignal<UserInfo[]>([]);
  const [sessions, setSessions] = createSignal<SessionInfo[]>([]);
  const [wallpaper, setWallpaper] = createSignal<string | null>(null);
  const [avatars, setAvatars] = createSignal<Record<string, string>>({});

  const [selectedUser, setSelectedUser] = createSignal<UserInfo | null>(null);
  const [selectedSession, setSelectedSession] = createSignal('');
  const [showSessionPicker, setShowSessionPicker] = createSignal(false);

  const [password, setPassword] = createSignal('');
  const [showPassword, setShowPassword] = createSignal(false);
  const [authError, setAuthError] = createSignal<string | null>(null);
  const [attemptsLeft, setAttemptsLeft] = createSignal(LOCKOUT_AFTER_ATTEMPTS);
  const [failCount, setFailCount] = createSignal(0);
  const [lockoutUntil, setLockoutUntil] = createSignal<Date | null>(null);
  const [lockoutSecsLeft, setLockoutSecsLeft] = createSignal(0);
  const [shake, setShake] = createSignal(false);
  const [isAuthenticating, setIsAuthenticating] = createSignal(false);

  const [capsLock, setCapsLock] = createSignal(false);
  const [networkOk, setNetworkOk] = createSignal<boolean | null>(null);
  const [batteryPct, setBatteryPct] = createSignal<number | null>(null);
  const [batteryCharging, setBatteryCharging] = createSignal(false);
  const [volume, setVolume] = createSignal<number | null>(null);
  const [kbLayout, setKbLayout] = createSignal<KeyboardLayout>(KEYBOARD_LAYOUTS[0]);
  const [showLayoutPicker, setShowLayoutPicker] = createSignal(false);

  const [highContrast, setHighContrast] = createSignal(false);
  const [fontSize, setFontSize] = createSignal(16);

  const [showPowerMenu, setShowPowerMenu] = createSignal(false);
  const [connectError, setConnectError] = createSignal<string | null>(null);
  const [showGuestOption, setShowGuestOption] = createSignal(false);

  const [authMethod, setAuthMethod] = createSignal<AuthMethod>('password');
  const [fingerprintAvailable, setFingerprintAvailable] = createSignal(false);
  const [patternAvailable, setPatternAvailable] = createSignal(false);
  const [patternError, setPatternError] = createSignal(false);

  let passwordInput: HTMLInputElement | undefined;
  let lockoutTimer: ReturnType<typeof setInterval> | undefined;
  let statusPollTimer: ReturnType<typeof setTimeout> | undefined;

  function focusPasswordSoon(delay = 150) {
    setTimeout(() => passwordInput?.focus(), delay);
  }

  async function init() {
    setScreen('connecting');
    try {
      const daemonInfo = await HdmBridge.connectDaemon();
      setDaemon(daemonInfo);

      const [usersData, sessionsData, wp] = await Promise.all([
        HdmBridge.getUsers(),
        HdmBridge.getSessions(),
        HdmBridge.getWallpaper(),
      ]);

      setUsers(usersData);
      setSessions(sessionsData);
      setWallpaper(wp);
      setShowGuestOption(usersData.some((u) => u.username === 'guest'));

      // Prefer the session HDM itself resolved as the default (hdm.hk's
      // [default] -> session, validated server-side against what's
      // actually under sessions_dir — see get_default_session() on the
      // daemon side) over hardcoding an id here.
      const defaultSession =
        sessionsData.find((s) => s.id === daemonInfo.default_session) ??
        sessionsData.find((s) => s.id === 'blue-environment') ??
        sessionsData[0];
      if (defaultSession) setSelectedSession(defaultSession.id);

      loadAvatars(usersData);
      setScreen('user-select');
    } catch (e: any) {
      setConnectError(e?.message ?? 'Cannot connect to HDM daemon. Is it running as root?');
      setScreen('error');
    }
  }

  async function loadAvatars(usersData: UserInfo[]) {
    for (const user of usersData) {
      if (user.icon_path) {
        try {
          const data = await HdmBridge.readUserAvatar(user.icon_path);
          if (data) setAvatars((prev) => ({ ...prev, [user.username]: data }));
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function pollSystemStatus() {
    try {
      setNetworkOk((await HdmBridge.checkNetwork?.()) ?? null);
    } catch {
      /* ignore */
    }
    try {
      const bat = await HdmBridge.getBattery?.();
      if (bat) {
        setBatteryPct(bat.percentage);
        setBatteryCharging(bat.charging);
      }
    } catch {
      /* ignore */
    }
    try {
      const vol = await HdmBridge.getVolume?.();
      if (vol != null) setVolume(vol);
    } catch {
      /* ignore */
    }
    statusPollTimer = setTimeout(pollSystemStatus, 30_000);
  }

  function startLockout(fails: number) {
    const dur = Math.min(LOCKOUT_DURATION_SECS * Math.pow(2, fails - LOCKOUT_AFTER_ATTEMPTS), 300);
    const until = new Date(Date.now() + dur * 1000);
    setLockoutUntil(until);
    setLockoutSecsLeft(dur);

    clearInterval(lockoutTimer);
    lockoutTimer = setInterval(() => {
      const left = Math.ceil((until.getTime() - Date.now()) / 1000);
      if (left <= 0) {
        setLockoutUntil(null);
        setLockoutSecsLeft(0);
        clearInterval(lockoutTimer);
        setAuthError(null);
        focusPasswordSoon(0);
      } else {
        setLockoutSecsLeft(left);
      }
    }, 500);
  }

  async function selectUser(user: UserInfo) {
    setSelectedUser(user);
    setPassword('');
    setAuthError(null);
    setAttemptsLeft(LOCKOUT_AFTER_ATTEMPTS);
    setFailCount(0);
    setLockoutUntil(null);
    setAuthMethod('password');
    setPatternError(false);
    clearInterval(lockoutTimer);

    if (user.last_session) {
      const found = sessions().find((s) => s.id === user.last_session);
      if (found) setSelectedSession(user.last_session);
    }

    // Real hardware/config checks — not placeholders. If a laptop has no
    // fingerprint reader (or this user never enrolled one), the option is
    // simply not offered instead of showing a button that can't work.
    setFingerprintAvailable(await HdmBridge.hasFingerprint(user.username).catch(() => false));
    setPatternAvailable(
      await HdmBridge.patternIsConfigured(user.username, user.home).catch(() => false),
    );

    setScreen('password');
    focusPasswordSoon();
  }

  function goBack() {
    setScreen('user-select');
    setSelectedUser(null);
    setPassword('');
    setAuthError(null);
    setLockoutUntil(null);
    clearInterval(lockoutTimer);
  }

  const isLockedOut = createMemo(() => {
    const until = lockoutUntil();
    return until != null && until > new Date();
  });

  function handleAuthOutcome(result: { success: boolean; error?: string }) {
    if (result.success) {
      setFailCount(0);
      launchSession(selectedUser()!.username, selectedSession());
      return true;
    }
    const newFails = failCount() + 1;
    setFailCount(newFails);
    setAttemptsLeft(Math.max(0, LOCKOUT_AFTER_ATTEMPTS - newFails));
    setAuthError(result.error ?? 'Authentication failed');
    setShake(true);
    setTimeout(() => setShake(false), 500);
    if (newFails >= LOCKOUT_AFTER_ATTEMPTS) startLockout(newFails);
    return false;
  }

  async function authenticate() {
    if (!selectedUser() || !password() || isAuthenticating() || isLockedOut()) return;

    setIsAuthenticating(true);
    setAuthError(null);

    try {
      const result = await HdmBridge.authenticate(selectedUser()!.username, password());
      setPassword('');
      const ok = handleAuthOutcome(result);
      if (!ok && failCount() < LOCKOUT_AFTER_ATTEMPTS) focusPasswordSoon(100);
    } catch (e: any) {
      setAuthError(e?.message ?? 'Authentication error');
      setShake(true);
      setTimeout(() => setShake(false), 500);
    } finally {
      setIsAuthenticating(false);
    }
  }

  async function authenticateWithPattern(pattern: number[]) {
    if (!selectedUser() || isAuthenticating() || isLockedOut()) return;
    setIsAuthenticating(true);
    setAuthError(null);
    setPatternError(false);
    try {
      const result = await HdmBridge.authenticatePattern(selectedUser()!.username, pattern);
      const ok = handleAuthOutcome(result);
      if (!ok) setPatternError(true);
      setTimeout(() => setPatternError(false), 600);
    } catch (e: any) {
      setAuthError(e?.message ?? 'Pattern authentication error');
      setPatternError(true);
    } finally {
      setIsAuthenticating(false);
    }
  }

  async function authenticateWithFingerprint() {
    if (!selectedUser() || isAuthenticating() || isLockedOut()) return;
    setIsAuthenticating(true);
    setAuthError(null);
    try {
      // Prawdziwy skan sprzętowy (do ~30 s): backend nie blokuje UI — wynik przychodzi zdarzeniem
      // `hdm://fingerprint` (patrz HdmBridge.authenticateFingerprint).
      const result = await HdmBridge.authenticateFingerprint(selectedUser()!.username);
      handleAuthOutcome(result);
    } catch (e: any) {
      setAuthError(e?.message ?? 'Fingerprint authentication error');
    } finally {
      setIsAuthenticating(false);
    }
  }

  async function launchSession(username: string, sessionId: string) {
    setScreen('logging-in');
    try {
      await HdmBridge.startSession(username, sessionId);
    } catch (e: any) {
      setAuthError(e?.message ?? 'Session failed to start');
      setScreen('password');
    }
  }

  async function loginAsGuest() {
    await launchSession('guest', selectedSession());
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') authenticate();
    if (e.key === 'Escape') goBack();
  }

  async function handlePower(action: PowerAction) {
    setShowPowerMenu(false);
    await HdmBridge.powerAction(action);
  }

  function changeKbLayout(layout: KeyboardLayout) {
    setKbLayout(layout);
    setShowLayoutPicker(false);
    HdmBridge.setKeyboardLayout?.(layout.id).catch(() => {});
  }

  const currentSession = createMemo(() => sessions().find((s) => s.id === selectedSession()));

  function formatUptime(secs: number) {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  const BatteryIcon = () =>
    batteryCharging()
      ? BatteryCharging
      : batteryPct() != null && batteryPct()! < 20
        ? BatteryLow
        : batteryPct() != null && batteryPct()! < 60
          ? BatteryMedium
          : BatteryFull;

  const rootStyle = createMemo(
    () => `font-size:${fontSize()}px; ${highContrast() ? 'filter:contrast(1.4);' : ''}`,
  );

  function isWayland(type?: string) {
    return type === 'wayland';
  }

  onMount(() => {
    init();
    pollSystemStatus();
    const keyHandler = (e: KeyboardEvent) => {
      if (e.getModifierState) setCapsLock(e.getModifierState('CapsLock'));
    };
    window.addEventListener('keydown', keyHandler);
    window.addEventListener('keyup', keyHandler);

    onCleanup(() => {
      clearInterval(lockoutTimer);
      clearTimeout(statusPollTimer);
      window.removeEventListener('keydown', keyHandler);
      window.removeEventListener('keyup', keyHandler);
    });
  });

  const sessionBadge = () => (
    <span class={`badge ${isWayland(currentSession()?.session_type) ? 'badge-wl' : 'badge-x11'}`}>
      {isWayland(currentSession()?.session_type) ? 'WL' : 'X11'}
    </span>
  );

  const avatarOf = (u: UserInfo | null) => (u ? avatars()[u.username] : undefined);

  return (
    // Silver: korzeń wypełnia okno (pełny ekran = dokładnie rozmiar monitora), więc nie ma już
    // problemu „HDM wychodzi poza ekran” z wersji Tauri (statyczne 1920x1080).
    <div class="app" style={rootStyle()}>
      <Background wallpaper={wallpaper()} />

      {/* Górny pasek systemowy */}
      <div class="topbar">
        <div class="topbar-left">
          <div class="logo-badge">
            <Shield size={14} class="icon-white" />
          </div>
          <span class="brand">HDM</span>
          <Show when={daemon()}>
            <span class="mono-dim">v{daemon()!.version}</span>
          </Show>
        </div>

        <div class="topbar-right">
          <Show when={networkOk() === true}>
            <span title="Connected">
              <Wifi size={14} class="icon-muted" />
            </span>
          </Show>
          <Show when={networkOk() === false}>
            <span title="No network">
              <WifiOff size={14} class="icon-warn" />
            </span>
          </Show>

          <Show when={volume() != null}>
            <Show
              when={volume()! > 0}
              fallback={
                <span title="Muted">
                  <VolumeX size={14} class="icon-dim" />
                </span>
              }
            >
              <span title={`Volume ${volume()}%`}>
                <Volume2 size={14} class="icon-muted" />
              </span>
            </Show>
          </Show>

          <Show when={batteryPct() != null}>
            <div class="battery">
              {(() => {
                const Icon = BatteryIcon();
                return (
                  <Icon
                    size={14}
                    class={
                      batteryCharging()
                        ? 'icon-good'
                        : batteryPct()! < 20
                          ? 'icon-bad'
                          : 'icon-muted'
                    }
                  />
                );
              })()}
              <span class={`battery-pct ${batteryPct()! < 20 ? 'low' : ''}`}>{batteryPct()}%</span>
            </div>
          </Show>

          <div class="layout-picker">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowLayoutPicker(!showLayoutPicker());
              }}
              class="pill-btn"
            >
              <Languages size={13} class="icon-muted" />
              <span class="pill-text">
                {kbLayout().flag} {kbLayout().id.toUpperCase()}
              </span>
            </button>
            <Show when={showLayoutPicker()}>
              <div class="dropdown">
                <div class="dropdown-scroll">
                  <For each={KEYBOARD_LAYOUTS}>
                    {(l) => (
                      <button
                        onClick={() => changeKbLayout(l)}
                        class={`dropdown-item ${kbLayout().id === l.id ? 'active' : ''}`}
                      >
                        <span class="dropdown-flag">{l.flag}</span>
                        <span>{l.label}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>

          <button
            onClick={() => setFontSize(Math.min(fontSize() + 2, 24))}
            class="btn-icon"
            title="Increase font size"
          >
            <ZoomIn size={13} />
          </button>
          <button
            onClick={() => setFontSize(Math.max(fontSize() - 2, 12))}
            class="btn-icon"
            title="Decrease font size"
          >
            <ZoomOut size={13} />
          </button>
          <button
            onClick={() => setHighContrast(!highContrast())}
            class={`btn-icon ${highContrast() ? 'on' : ''}`}
            title="Toggle high contrast"
          >
            <Contrast size={13} />
          </button>

          <Show when={daemon()}>
            <span class="mono-dim">{daemon()!.hostname}</span>
          </Show>
        </div>
      </div>

      <button onClick={() => setShowPowerMenu(true)} class="corner-power" title="Power Options">
        <Power size={18} class="corner-power-icon" />
      </button>

      <Show when={daemon()}>
        <div class="corner-uptime">
          <span class="mono-dim">up {formatUptime(daemon()!.uptime)}</span>
        </div>
      </Show>

      {/* Zawartość główna: przewija się W OBRĘBIE okna, zamiast wypychać układ poza ekran. */}
      <div class="scroll" onClick={() => setShowLayoutPicker(false)}>
        <div class="stage">
          <Show
            when={screen() !== 'logging-in' && screen() !== 'connecting' && screen() !== 'error'}
          >
            <Clock class="animate-fade-in" />
          </Show>

          <Show when={screen() === 'connecting'}>
            <div class="screen-center animate-fade-in">
              <div class="splash-badge">
                <Shield size={36} class="icon-white" />
              </div>
              <div class="center-text">
                <div class="splash-title">Blue Environment</div>
                <div class="status-line">
                  <Loader2 size={14} class="animate-spin" />
                  Connecting to HDM daemon…
                </div>
              </div>
            </div>
          </Show>

          <Show when={screen() === 'error'}>
            <div class="screen-center animate-slide-up">
              <div class="err-badge">
                <AlertCircle size={28} class="icon-bad" />
              </div>
              <div class="center-text err-box">
                <div class="err-title">HDM Connection Failed</div>
                <div class="err-text">{connectError()}</div>
              </div>
              <div class="btn-row">
                <button onClick={init} class="btn btn-primary btn-pad">
                  <RefreshCw size={14} />
                  Retry
                </button>
                <button
                  onClick={() => HdmBridge.powerAction('shutdown')}
                  class="btn btn-ghost btn-pad"
                >
                  Shut Down
                </button>
              </div>
              <p class="fine-print">
                Ensure <code>hdm</code> (the daemon) is running as root. Check{' '}
                <code>/var/log/hdm/</code> for errors.
              </p>
            </div>
          </Show>

          <Show when={screen() === 'logging-in'}>
            <div class="screen-center animate-fade-in">
              <div class="avatar-glow-wrap">
                <div class="avatar avatar-xl">
                  <Show
                    when={avatarOf(selectedUser())}
                    fallback={(selectedUser()?.realname.charAt(0) ?? '?').toUpperCase()}
                  >
                    <img src={avatarOf(selectedUser())} class="avatar-img" alt="" />
                  </Show>
                </div>
                <div class="avatar-ring animate-pulse-glow" />
              </div>
              <div class="center-text">
                <div class="welcome">Welcome, {selectedUser()?.realname}</div>
                <div class="status-line">
                  <Loader2 size={14} class="animate-spin" />
                  Starting {currentSession()?.name ?? 'session'}…
                </div>
              </div>
            </div>
          </Show>

          <Show when={screen() === 'user-select'}>
            <div class="screen-center animate-slide-up">
              <div class="card card-wide">
                <div class="label-caps">Select User</div>

                <Show
                  when={users().length > 0}
                  fallback={<div class="muted-text">No users found</div>}
                >
                  <div class="user-grid">
                    <For each={users()}>
                      {(user) => (
                        <UserCard
                          user={user}
                          isSelected={false}
                          avatarData={avatars()[user.username]}
                          onClick={() => selectUser(user)}
                        />
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={showGuestOption()}>
                  <button onClick={loginAsGuest} class="btn btn-ghost btn-guest">
                    <UserPlus size={14} />
                    Continue as Guest
                  </button>
                </Show>

                <div class="session-section">
                  <button
                    onClick={() => setShowSessionPicker(!showSessionPicker())}
                    class="btn btn-ghost session-toggle"
                  >
                    <div class="session-toggle-left">
                      <Monitor size={14} />
                      <span>{currentSession()?.name ?? 'Select session…'}</span>
                      {sessionBadge()}
                    </div>
                    <Show
                      when={showSessionPicker()}
                      fallback={<ChevronDown size={14} class="icon-dim" />}
                    >
                      <ChevronUp size={14} class="icon-dim" />
                    </Show>
                  </button>
                  <Show when={showSessionPicker()}>
                    <div class="session-drop animate-slide-down">
                      <SessionPicker
                        sessions={sessions()}
                        selected={selectedSession()}
                        onSelect={(id) => {
                          setSelectedSession(id);
                          setShowSessionPicker(false);
                        }}
                      />
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          <Show when={screen() === 'password' && selectedUser()}>
            <div class="screen-center animate-slide-up">
              <div class="card card-auth">
                <div class="who">
                  <div class="avatar avatar-lg">
                    <Show
                      when={avatarOf(selectedUser())}
                      fallback={selectedUser()!.realname.charAt(0).toUpperCase()}
                    >
                      <img src={avatarOf(selectedUser())} class="avatar-img" alt="" />
                    </Show>
                  </div>
                  <div class="center-text">
                    <div class="who-name">{selectedUser()!.realname}</div>
                    <div class="who-user">{selectedUser()!.username}</div>
                  </div>
                </div>

                <Show when={isLockedOut()}>
                  <div class="alert alert-lock animate-slide-down">
                    <LockKeyhole size={15} class="icon-yellow" />
                    <div>
                      <div class="alert-title">Account locked</div>
                      <div class="alert-sub">Try again in {lockoutSecsLeft()}s</div>
                    </div>
                  </div>
                </Show>

                <Show when={capsLock() && !isLockedOut()}>
                  <div class="alert alert-caps">
                    <AlertTriangle size={13} class="icon-orange" />
                    <span>Caps Lock is on</span>
                  </div>
                </Show>

                <Show when={(patternAvailable() || fingerprintAvailable()) && !isLockedOut()}>
                  <div class="tabs">
                    <button
                      onClick={() => setAuthMethod('password')}
                      class={`tab ${authMethod() === 'password' ? 'active' : ''}`}
                    >
                      Password
                    </button>
                    <Show when={patternAvailable()}>
                      <button
                        onClick={() => setAuthMethod('pattern')}
                        class={`tab ${authMethod() === 'pattern' ? 'active' : ''}`}
                      >
                        Pattern
                      </button>
                    </Show>
                    <Show when={fingerprintAvailable()}>
                      <button
                        onClick={() => setAuthMethod('fingerprint')}
                        class={`tab ${authMethod() === 'fingerprint' ? 'active' : ''}`}
                      >
                        Fingerprint
                      </button>
                    </Show>
                  </div>
                </Show>

                <Show when={authMethod() === 'password'}>
                  <div class={`field ${shake() ? 'shake' : ''}`}>
                    <div class="input-wrap">
                      <input
                        ref={passwordInput}
                        type={showPassword() ? 'text' : 'password'}
                        value={password()}
                        onInput={(e) => setPassword(e.currentTarget.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Password"
                        class="input"
                        autofocus
                        disabled={isAuthenticating() || isLockedOut()}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword())}
                        class="eye-btn"
                        aria-label="Toggle password visibility"
                      >
                        <Show when={showPassword()} fallback={<Eye size={15} class="icon-dim" />}>
                          <EyeOff size={15} class="icon-dim" />
                        </Show>
                      </button>
                    </div>

                    <Show when={authError() && !isLockedOut()}>
                      <div class="error-line animate-slide-down">
                        <AlertCircle size={14} />
                        <span>{authError()}</span>
                        <Show when={attemptsLeft() < LOCKOUT_AFTER_ATTEMPTS && attemptsLeft() > 0}>
                          <span class="attempts">{attemptsLeft()} left</span>
                        </Show>
                      </div>
                    </Show>

                    <button
                      onClick={authenticate}
                      disabled={!password() || isAuthenticating() || isLockedOut()}
                      class="btn btn-primary btn-login"
                    >
                      <Show
                        when={!isAuthenticating()}
                        fallback={
                          <>
                            <Loader2 size={16} class="animate-spin" /> Authenticating…
                          </>
                        }
                      >
                        <Show
                          when={!isLockedOut()}
                          fallback={
                            <>
                              <LockKeyhole size={15} /> Locked ({lockoutSecsLeft()}s)
                            </>
                          }
                        >
                          Log In
                        </Show>
                      </Show>
                    </button>
                  </div>
                </Show>

                <Show when={authMethod() === 'pattern'}>
                  <div class="method-col">
                    <PatternLock
                      disabled={isAuthenticating() || isLockedOut()}
                      error={patternError()}
                      onComplete={authenticateWithPattern}
                    />
                    <Show when={authError() && !isLockedOut()}>
                      <div class="error-line animate-slide-down">
                        <AlertCircle size={14} />
                        <span>{authError()}</span>
                      </div>
                    </Show>
                    <p class="hint">Draw your pattern to unlock</p>
                  </div>
                </Show>

                <Show when={authMethod() === 'fingerprint'}>
                  <div class="method-col fp-col">
                    <button
                      onClick={authenticateWithFingerprint}
                      disabled={isAuthenticating() || isLockedOut()}
                      class={`fp-btn ${isAuthenticating() ? 'busy' : ''}`}
                    >
                      <Show
                        when={isAuthenticating()}
                        fallback={<Fingerprint size={32} class="icon-bright" />}
                      >
                        <Loader2 size={32} class="icon-bright animate-spin" />
                      </Show>
                    </button>
                    <Show when={authError() && !isLockedOut()}>
                      <div class="error-line animate-slide-down">
                        <AlertCircle size={14} />
                        <span>{authError()}</span>
                      </div>
                    </Show>
                    <p class="hint">
                      {isAuthenticating() ? 'Scanning…' : 'Tap to scan your fingerprint'}
                    </p>
                  </div>
                </Show>

                <div class="session-section">
                  <button
                    onClick={() => setShowSessionPicker(!showSessionPicker())}
                    class="btn btn-ghost session-toggle session-toggle-sm"
                  >
                    <div class="session-toggle-left">
                      <Monitor size={13} />
                      <span class="session-toggle-name">{currentSession()?.name}</span>
                      {sessionBadge()}
                    </div>
                    <Show
                      when={showSessionPicker()}
                      fallback={<ChevronDown size={12} class="icon-dim" />}
                    >
                      <ChevronUp size={12} class="icon-dim" />
                    </Show>
                  </button>
                  <Show when={showSessionPicker()}>
                    <div class="session-drop animate-slide-down">
                      <SessionPicker
                        sessions={sessions()}
                        selected={selectedSession()}
                        onSelect={(id) => {
                          setSelectedSession(id);
                          setShowSessionPicker(false);
                        }}
                      />
                    </div>
                  </Show>
                </div>
              </div>

              <Show when={users().length > 1}>
                <button onClick={goBack} class="back-btn">
                  <ChevronLeft size={16} />
                  Switch User
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <Show when={showPowerMenu()}>
        <PowerMenu onAction={handlePower} onClose={() => setShowPowerMenu(false)} />
      </Show>
    </div>
  );
}

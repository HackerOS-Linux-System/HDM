import { createSignal, createMemo, onMount, onCleanup, For, Show } from 'solid-js';
import {
  Power,
  ChevronLeft,
  Eye,
  EyeOff,
  AlertCircle,
  Loader2,
  ChevronDown,
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
import { HdmBridge } from './lib/utils/tauri';
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

      const defaultSession =
        sessionsData.find((s) => s.id === 'blue-environment') ?? sessionsData[0];
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
      // This call blocks (real hardware scan) until the daemon's
      // fprintd-verify subprocess returns a match/no-match/timeout.
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
    () =>
      `font-size:${fontSize()}px; ${highContrast() ? 'filter:contrast(1.4) saturate(0.7);' : ''}`,
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

  return (
    // FIX "wychodzi poza ekran": use w-full/h-full anchored to the fixed,
    // zero-inset #app root (see index.html) instead of w-screen/h-screen,
    // which report the *display* viewport and can exceed the actual Tauri
    // window box during the fullscreen negotiation on non-1920x1080 screens.
    <div class="relative w-full h-full" style={rootStyle()}>
      <Background wallpaper={wallpaper()} />

      {/* Top system bar */}
      <div class="absolute top-0 inset-x-0 flex items-center justify-between px-6 py-3 z-20">
        <div class="flex items-center gap-2.5">
          <div
            class="w-7 h-7 rounded-xl flex items-center justify-center"
            style="background:linear-gradient(135deg,#1d4ed8,#7c3aed); box-shadow:0 0 14px rgba(59,130,246,.4);"
          >
            <Shield size={14} class="text-white" />
          </div>
          <span
            class="text-slate-500 text-xs tracking-[0.18em] uppercase"
            style="font-family:'Oxanium',monospace;"
          >
            HDM
          </span>
          <Show when={daemon()}>
            <span class="text-slate-700 text-xs" style="font-family:'JetBrains Mono',monospace;">
              v{daemon()!.version}
            </span>
          </Show>
        </div>

        <div class="flex items-center gap-3">
          <Show when={networkOk() === true}>
            <span title="Connected">
              <Wifi size={14} class="text-slate-500" />
            </span>
          </Show>
          <Show when={networkOk() === false}>
            <span title="No network">
              <WifiOff size={14} class="text-yellow-600" />
            </span>
          </Show>

          <Show when={volume() != null}>
            <Show
              when={volume()! > 0}
              fallback={
                <span title="Muted">
                  <VolumeX size={14} class="text-slate-600" />
                </span>
              }
            >
              <span title={`Volume ${volume()}%`}>
                <Volume2 size={14} class="text-slate-500" />
              </span>
            </Show>
          </Show>

          <Show when={batteryPct() != null}>
            <div class="flex items-center gap-1">
              {(() => {
                const Icon = BatteryIcon();
                return (
                  <Icon
                    size={14}
                    class={
                      batteryCharging()
                        ? 'text-green-500'
                        : batteryPct()! < 20
                          ? 'text-red-500'
                          : 'text-slate-500'
                    }
                  />
                );
              })()}
              <span
                class="text-[11px]"
                style={`font-family:'JetBrains Mono',monospace; color:${batteryPct()! < 20 ? '#f87171' : '#64748b'};`}
              >
                {batteryPct()}%
              </span>
            </div>
          </Show>

          <div class="relative">
            <button
              onClick={() => setShowLayoutPicker(!showLayoutPicker())}
              class="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-white/5 transition-colors"
            >
              <Languages size={13} class="text-slate-500" />
              <span class="text-slate-500 text-xs">
                {kbLayout().flag} {kbLayout().id.toUpperCase()}
              </span>
            </button>
            <Show when={showLayoutPicker()}>
              <div
                class="absolute right-0 top-full mt-1 w-48 rounded-xl overflow-hidden z-30"
                style="background:rgba(2,6,23,0.97); border:1px solid rgba(255,255,255,0.07);"
              >
                <div class="max-h-64 overflow-y-auto py-1">
                  <For each={KEYBOARD_LAYOUTS}>
                    {(l) => (
                      <button
                        onClick={() => changeKbLayout(l)}
                        class={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors hover:bg-white/5 ${
                          kbLayout().id === l.id ? 'text-blue-400' : 'text-slate-400'
                        }`}
                      >
                        <span class="text-base">{l.flag}</span>
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
            class="p-1.5 rounded-lg hover:bg-white/5 text-slate-600 hover:text-slate-400"
            title="Increase font size"
          >
            <ZoomIn size={13} />
          </button>
          <button
            onClick={() => setFontSize(Math.max(fontSize() - 2, 12))}
            class="p-1.5 rounded-lg hover:bg-white/5 text-slate-600 hover:text-slate-400"
            title="Decrease font size"
          >
            <ZoomOut size={13} />
          </button>
          <button
            onClick={() => setHighContrast(!highContrast())}
            class={`p-1.5 rounded-lg transition-colors ${highContrast() ? 'text-yellow-400' : 'text-slate-600 hover:text-slate-400'}`}
            title="Toggle high contrast"
          >
            <Contrast size={13} />
          </button>

          <Show when={daemon()}>
            <span
              class="text-[11px] text-slate-700"
              style="font-family:'JetBrains Mono',monospace;"
            >
              {daemon()!.hostname}
            </span>
          </Show>
        </div>
      </div>

      <button
        onClick={() => setShowPowerMenu(true)}
        class="absolute bottom-6 right-6 z-20 p-3 rounded-xl hdm-btn-ghost group"
        title="Power Options"
      >
        <Power size={18} class="text-slate-500 group-hover:text-red-400 transition-colors" />
      </button>

      <Show when={daemon()}>
        <div class="absolute bottom-6 left-6 z-20">
          <span class="text-slate-700 text-xs" style="font-family:'JetBrains Mono',monospace;">
            up {formatUptime(daemon()!.uptime)}
          </span>
        </div>
      </Show>

      {/* Main content: overflow-y-auto so tall content scrolls WITHIN the
          window instead of pushing the layout past the visible screen. */}
      <div
        class="absolute inset-0 z-10 overflow-y-auto overflow-x-hidden h-full"
        onClick={() => setShowLayoutPicker(false)}
      >
        <div
          class="flex flex-col items-center justify-center px-4"
          style="min-height:100%; gap:clamp(0.75rem, 2.5vh, 2rem); padding-top:4rem; padding-bottom:4rem;"
        >
          <Show
            when={screen() !== 'logging-in' && screen() !== 'connecting' && screen() !== 'error'}
          >
            <Clock class="animate-fade-in" />
          </Show>

          <Show when={screen() === 'connecting'}>
            <div class="flex flex-col items-center gap-6 animate-fade-in">
              <div
                class="w-20 h-20 rounded-2xl flex items-center justify-center"
                style="background:linear-gradient(135deg,#1d4ed8,#7c3aed); box-shadow:0 0 40px rgba(59,130,246,.4);"
              >
                <Shield size={36} class="text-white" />
              </div>
              <div class="text-center">
                <div
                  class="text-white text-2xl mb-2"
                  style="font-family:'Oxanium',monospace; font-weight:400;"
                >
                  Blue Environment
                </div>
                <div class="text-slate-500 text-sm flex items-center gap-2 justify-center">
                  <Loader2 size={14} class="animate-spin" />
                  Connecting to HDM daemon…
                </div>
              </div>
            </div>
          </Show>

          <Show when={screen() === 'error'}>
            <div class="flex flex-col items-center gap-6 animate-slide-up">
              <div
                class="w-16 h-16 rounded-2xl flex items-center justify-center"
                style="background:rgba(239,68,68,.15); border:1px solid rgba(239,68,68,.3);"
              >
                <AlertCircle size={28} class="text-red-400" />
              </div>
              <div class="text-center max-w-sm">
                <div class="text-white text-lg mb-2">HDM Connection Failed</div>
                <div class="text-slate-400 text-sm leading-relaxed">{connectError()}</div>
              </div>
              <div class="flex gap-3">
                <button
                  onClick={init}
                  class="hdm-btn-primary px-5 py-2.5 rounded-xl text-sm flex items-center gap-2"
                >
                  <RefreshCw size={14} />
                  Retry
                </button>
                <button
                  onClick={() => HdmBridge.powerAction('shutdown')}
                  class="px-5 py-2.5 rounded-xl text-sm text-slate-400 hover:text-white hdm-btn-ghost"
                >
                  Shut Down
                </button>
              </div>
              <p class="text-slate-700 text-xs max-w-xs text-center">
                Ensure <code class="text-slate-500">hdm-daemon</code> is running as root. Check{' '}
                <code class="text-slate-500">/var/log/hdm/</code> for errors.
              </p>
            </div>
          </Show>

          <Show when={screen() === 'logging-in'}>
            <div class="flex flex-col items-center gap-8 animate-fade-in">
              <div class="relative">
                <div
                  class="w-24 h-24 rounded-full flex items-center justify-center text-3xl font-medium text-white"
                  style="background:linear-gradient(135deg,#1d4ed8,#7c3aed); box-shadow:0 0 60px rgba(59,130,246,.5); font-family:'DM Sans',sans-serif;"
                >
                  <Show
                    when={selectedUser() && avatars()[selectedUser()!.username]}
                    fallback={(selectedUser()?.realname.charAt(0) ?? '?').toUpperCase()}
                  >
                    <img
                      src={avatars()[selectedUser()!.username]}
                      class="w-full h-full rounded-full object-cover"
                      alt=""
                    />
                  </Show>
                </div>
                <div
                  class="absolute inset-0 rounded-full animate-pulse-glow"
                  style="border:2px solid rgba(59,130,246,.5);"
                />
              </div>
              <div class="text-center">
                <div class="text-white text-xl mb-2" style="font-family:'Oxanium',monospace;">
                  Welcome, {selectedUser()?.realname}
                </div>
                <div class="text-slate-400 text-sm flex items-center gap-2 justify-center">
                  <Loader2 size={14} class="animate-spin" />
                  Starting {currentSession()?.name ?? 'session'}…
                </div>
              </div>
            </div>
          </Show>

          <Show when={screen() === 'user-select'}>
            <div class="flex flex-col items-center gap-6 animate-slide-up">
              <div
                class="glass-card rounded-3xl px-6 py-6 flex flex-col items-center gap-4 w-full"
                style="max-width:560px; min-width:min(520px, 90vw);"
              >
                <div
                  class="text-slate-400 text-xs tracking-[0.22em] uppercase"
                  style="font-family:'Oxanium',monospace;"
                >
                  Select User
                </div>

                <Show
                  when={users().length > 0}
                  fallback={<div class="text-slate-500 text-sm py-4">No users found</div>}
                >
                  <div class="flex gap-4 flex-wrap justify-center">
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
                  <button
                    onClick={loginAsGuest}
                    class="flex items-center gap-2 px-4 py-2 rounded-xl text-sm text-slate-500 hover:text-slate-300 hdm-btn-ghost"
                  >
                    <UserPlus size={14} />
                    Continue as Guest
                  </button>
                </Show>

                <div class="w-full pt-3 border-t border-white/5">
                  <button
                    onClick={() => setShowSessionPicker(!showSessionPicker())}
                    class="w-full flex items-center justify-between px-4 py-2.5 rounded-xl hdm-btn-ghost"
                  >
                    <div class="flex items-center gap-2 text-sm text-slate-400">
                      <Monitor size={14} />
                      <span>{currentSession()?.name ?? 'Select session…'}</span>
                      <span
                        class="text-[10px] px-1.5 py-0.5 rounded"
                        style={`
                          background:${isWayland(currentSession()?.session_type) ? 'rgba(59,130,246,.15)' : 'rgba(249,115,22,.15)'};
                          color:${isWayland(currentSession()?.session_type) ? '#93c5fd' : '#fdba74'};
                          font-family:'JetBrains Mono',monospace;
                        `}
                      >
                        {isWayland(currentSession()?.session_type) ? 'WL' : 'X11'}
                      </span>
                    </div>
                    <ChevronDown
                      size={14}
                      class={`text-slate-600 transition-transform ${showSessionPicker() ? 'rotate-180' : ''}`}
                    />
                  </button>
                  <Show when={showSessionPicker()}>
                    <div class="mt-2 animate-slide-down">
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
            <div class="flex flex-col items-center gap-6 animate-slide-up">
              <div
                class="glass-card rounded-3xl px-6 py-6 flex flex-col items-center gap-4"
                style="width:min(24rem, 90vw);"
              >
                <div class="flex flex-col items-center gap-3">
                  <div
                    class="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-medium text-white"
                    style={`
                      background:${avatars()[selectedUser()!.username] ? 'transparent' : 'linear-gradient(135deg,#1d4ed8,#7c3aed)'};
                      box-shadow:0 0 0 3px rgba(59,130,246,.3),0 4px 20px rgba(0,0,0,.4);
                      font-family:'DM Sans',sans-serif;
                    `}
                  >
                    <Show
                      when={avatars()[selectedUser()!.username]}
                      fallback={selectedUser()!.realname.charAt(0).toUpperCase()}
                    >
                      <img
                        src={avatars()[selectedUser()!.username]}
                        class="w-full h-full rounded-full object-cover"
                        alt=""
                      />
                    </Show>
                  </div>
                  <div class="text-center">
                    <div class="text-white font-medium">{selectedUser()!.realname}</div>
                    <div class="text-slate-500 text-sm">{selectedUser()!.username}</div>
                  </div>
                </div>

                <Show when={isLockedOut()}>
                  <div
                    class="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm animate-slide-down"
                    style="background:rgba(234,179,8,.08); border:1px solid rgba(234,179,8,.2);"
                  >
                    <LockKeyhole size={15} class="text-yellow-500 shrink-0" />
                    <div>
                      <div class="text-yellow-400 font-medium text-xs">Account locked</div>
                      <div class="text-yellow-600 text-xs">Try again in {lockoutSecsLeft()}s</div>
                    </div>
                  </div>
                </Show>

                <Show when={capsLock() && !isLockedOut()}>
                  <div
                    class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
                    style="background:rgba(249,115,22,.08); border:1px solid rgba(249,115,22,.2);"
                  >
                    <AlertTriangle size={13} class="text-orange-400 shrink-0" />
                    <span class="text-orange-400">Caps Lock is on</span>
                  </div>
                </Show>

                <Show when={(patternAvailable() || fingerprintAvailable()) && !isLockedOut()}>
                  <div
                    class="flex gap-1 p-1 rounded-xl w-full"
                    style="background:rgba(8,20,45,0.5);"
                  >
                    <button
                      onClick={() => setAuthMethod('password')}
                      class={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        authMethod() === 'password'
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      Password
                    </button>
                    <Show when={patternAvailable()}>
                      <button
                        onClick={() => setAuthMethod('pattern')}
                        class={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          authMethod() === 'pattern'
                            ? 'bg-blue-600 text-white'
                            : 'text-slate-500 hover:text-slate-300'
                        }`}
                      >
                        Pattern
                      </button>
                    </Show>
                    <Show when={fingerprintAvailable()}>
                      <button
                        onClick={() => setAuthMethod('fingerprint')}
                        class={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          authMethod() === 'fingerprint'
                            ? 'bg-blue-600 text-white'
                            : 'text-slate-500 hover:text-slate-300'
                        }`}
                      >
                        Fingerprint
                      </button>
                    </Show>
                  </div>
                </Show>

                <Show when={authMethod() === 'password'}>
                  <div
                    class="w-full space-y-2.5"
                    style={`animation:${shake() ? 'shake .4s cubic-bezier(.36,.07,.19,.97)' : 'none'};`}
                  >
                    <div class="relative">
                      <input
                        ref={passwordInput}
                        type={showPassword() ? 'text' : 'password'}
                        value={password()}
                        onInput={(e) => setPassword(e.currentTarget.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Password"
                        class="hdm-input w-full px-4 py-3 rounded-xl pr-12 text-sm"
                        style="font-family:'DM Sans',sans-serif;"
                        autofocus
                        disabled={isAuthenticating() || isLockedOut()}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword())}
                        class="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg hover:bg-white/5"
                      >
                        <Show
                          when={showPassword()}
                          fallback={<Eye size={15} class="text-slate-600" />}
                        >
                          <EyeOff size={15} class="text-slate-600" />
                        </Show>
                      </button>
                    </div>

                    <Show when={authError() && !isLockedOut()}>
                      <div class="flex items-center gap-2 text-red-400 text-sm animate-slide-down">
                        <AlertCircle size={14} />
                        <span>{authError()}</span>
                        <Show when={attemptsLeft() < LOCKOUT_AFTER_ATTEMPTS && attemptsLeft() > 0}>
                          <span class="text-slate-600 text-xs ml-auto">{attemptsLeft()} left</span>
                        </Show>
                      </div>
                    </Show>

                    <button
                      onClick={authenticate}
                      disabled={!password() || isAuthenticating() || isLockedOut()}
                      class="hdm-btn-primary w-full py-3 rounded-xl font-medium text-sm flex items-center justify-center gap-2"
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
                  <div class="w-full flex flex-col items-center gap-3">
                    <PatternLock
                      disabled={isAuthenticating() || isLockedOut()}
                      error={patternError()}
                      onComplete={authenticateWithPattern}
                    />
                    <Show when={authError() && !isLockedOut()}>
                      <div class="flex items-center gap-2 text-red-400 text-sm animate-slide-down">
                        <AlertCircle size={14} />
                        <span>{authError()}</span>
                      </div>
                    </Show>
                    <p class="text-slate-600 text-xs">Draw your pattern to unlock</p>
                  </div>
                </Show>

                <Show when={authMethod() === 'fingerprint'}>
                  <div class="w-full flex flex-col items-center gap-4 py-4">
                    <button
                      onClick={authenticateWithFingerprint}
                      disabled={isAuthenticating() || isLockedOut()}
                      class="w-20 h-20 rounded-full flex items-center justify-center transition-all"
                      style={`
                        background:${isAuthenticating() ? 'rgba(59,130,246,0.2)' : 'rgba(8,20,45,0.6)'};
                        border:2px solid ${isAuthenticating() ? '#3b82f6' : 'rgba(59,130,246,0.3)'};
                      `}
                    >
                      <Show
                        when={isAuthenticating()}
                        fallback={<Fingerprint size={32} class="text-blue-400" />}
                      >
                        <Loader2 size={32} class="text-blue-400 animate-spin" />
                      </Show>
                    </button>
                    <Show when={authError() && !isLockedOut()}>
                      <div class="flex items-center gap-2 text-red-400 text-sm animate-slide-down">
                        <AlertCircle size={14} />
                        <span>{authError()}</span>
                      </div>
                    </Show>
                    <p class="text-slate-600 text-xs">
                      {isAuthenticating() ? 'Scanning…' : 'Tap to scan your fingerprint'}
                    </p>
                  </div>
                </Show>

                <div class="w-full border-t border-white/5 pt-3">
                  <button
                    onClick={() => setShowSessionPicker(!showSessionPicker())}
                    class="w-full flex items-center justify-between px-3 py-2 rounded-xl hdm-btn-ghost text-sm"
                  >
                    <div class="flex items-center gap-2 text-slate-500">
                      <Monitor size={13} />
                      <span class="text-xs">{currentSession()?.name}</span>
                      <span
                        class="text-[10px] px-1.5 py-0.5 rounded"
                        style={`
                          background:${isWayland(currentSession()?.session_type) ? 'rgba(59,130,246,.15)' : 'rgba(249,115,22,.15)'};
                          color:${isWayland(currentSession()?.session_type) ? '#93c5fd' : '#fdba74'};
                          font-family:'JetBrains Mono',monospace;
                        `}
                      >
                        {isWayland(currentSession()?.session_type) ? 'WL' : 'X11'}
                      </span>
                    </div>
                    <ChevronDown
                      size={12}
                      class={`text-slate-700 transition-transform ${showSessionPicker() ? 'rotate-180' : ''}`}
                    />
                  </button>
                  <Show when={showSessionPicker()}>
                    <div class="mt-1 animate-slide-down">
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
                <button
                  onClick={goBack}
                  class="flex items-center gap-2 text-slate-500 hover:text-slate-300 text-sm transition-colors"
                >
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

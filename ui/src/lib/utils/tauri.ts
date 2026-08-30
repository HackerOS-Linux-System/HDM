import { z } from 'zod';

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
}
const isTauri = isTauriEnv();

// ── invoke() error handling: timeouts + retry ───────────────────────────────
//
// The original `invoke()` had no timeout at all: if the daemon hung (e.g.
// blocked on a slow fprintd scan, a stuck PAM module, or a dead socket that
// the OS hasn't noticed yet), an `await HdmBridge.foo()` call in App.tsx
// would simply never resolve — the greeter would sit frozen with no error,
// no retry, and no way out short of a hard VT switch. This wraps every
// underlying `core.invoke()` call with:
//
//  - a per-call timeout (`IpcTimeoutError`), so a hung daemon call always
//    eventually surfaces as a normal, catchable error instead of an
//    infinite hang;
//  - bounded automatic retries with a short backoff, but ONLY for calls
//    explicitly marked `idempotent: true` below — retrying a non-idempotent
//    call like `authenticate` automatically would be actively dangerous
//    (e.g. contributing extra failed attempts against the server-side
//    rate limiter for a request that may have actually succeeded).

export class IpcTimeoutError extends Error {
  constructor(cmd: string, timeoutMs: number) {
    super(`HDM daemon did not respond to '${cmd}' within ${timeoutMs}ms`);
    this.name = 'IpcTimeoutError';
  }
}

export class IpcError extends Error {
  public cause?: unknown;

  constructor(cmd: string, cause: unknown) {
    super(
      `HDM IPC call '${cmd}' failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'IpcError';
    this.cause = cause;
  }
}

/**
 * Thrown when the daemon/greeter returned a value that doesn't match the
 * shape the UI expects (see ipcSchemas.ts). This is deliberately a
 * distinct error type from `IpcError` — a validation failure means the
 * call *succeeded* at the transport level but the payload is untrustworthy,
 * which callers may want to handle differently from a network-level
 * failure (e.g. always surface a bug report prompt rather than a plain
 * "try again").
 */
export class IpcValidationError extends Error {
  public issues: unknown;

  constructor(cmd: string, issues: unknown) {
    super(`HDM IPC call '${cmd}' returned an unexpected shape — see .issues for details`);
    this.name = 'IpcValidationError';
    this.issues = issues;
  }
}

interface InvokeOptions<T = unknown> {
  /** Milliseconds before the call is abandoned and IpcTimeoutError is thrown. */
  timeoutMs?: number;
  /**
   * Safe to silently retry on failure/timeout (GET-like reads: session
   * lists, user lists, system status). Never set this for anything that
   * changes daemon state or counts as an auth attempt.
   */
  idempotent?: boolean;
  /** Max additional attempts after the first, only used when idempotent. */
  retries?: number;
  /**
   * Zod schema the resolved value must satisfy. When provided, the
   * schema's *parsed* output is returned (not the raw IPC value) — this
   * also gives Zod's own type coercion/defaults a chance to run, and
   * guarantees callers only ever see a value matching `T`.
   */
  schema?: z.ZodType<T>;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const RETRY_BACKOFF_MS = 400;

function withTimeout<T>(promise: Promise<T>, cmd: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new IpcTimeoutError(cmd, timeoutMs)), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function invoke<T>(cmd: string, args?: unknown, opts: InvokeOptions<T> = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.idempotent ? 1 + (opts.retries ?? 2) : 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const call = isTauri
        ? import('@tauri-apps/api/core').then((core) => core.invoke(cmd, args as any) as Promise<T>)
        : mockInvoke<T>(cmd, args);
      const result = await withTimeout(call, cmd, timeoutMs);

      if (opts.schema) {
        const parsed = opts.schema.safeParse(result);
        if (!parsed.success) {
          throw new IpcValidationError(cmd, parsed.error.issues);
        }
        return parsed.data;
      }
      return result;
    } catch (e) {
      lastError = e;
      // A validation failure means the daemon answered but with a shape
      // the UI can't trust — retrying the exact same call is unlikely to
      // produce a different shape, so idempotent retries only apply to
      // transport-level failures (timeouts, IPC errors), not this.
      if (e instanceof IpcValidationError) break;

      const isLastAttempt = attempt === maxAttempts;
      if (!isLastAttempt) {
        console.warn(`[HdmBridge] '${cmd}' attempt ${attempt}/${maxAttempts} failed, retrying…`, e);
        await sleep(RETRY_BACKOFF_MS * attempt);
        continue;
      }
    }
  }
  throw lastError instanceof IpcTimeoutError ||
    lastError instanceof IpcError ||
    lastError instanceof IpcValidationError
    ? lastError
    : new IpcError(cmd, lastError);
}

// ── Real Tauri commands ────────────────────────────────────────────────────

import type { AuthResult, DaemonInfo, SessionInfo, UserInfo } from '../types';
import {
  AuthResultSchema,
  BatteryInfoSchema,
  DaemonInfoSchema,
  SessionInfoListSchema,
  UserInfoListSchema,
} from './ipcSchemas';

export const HdmBridge = {
  connectDaemon: () =>
    invoke<DaemonInfo>('connect_daemon', undefined, {
      timeoutMs: 10_000,
      idempotent: true,
      retries: 2,
      schema: DaemonInfoSchema,
    }),

  getSessions: () =>
    invoke<SessionInfo[]>('get_sessions', undefined, {
      idempotent: true,
      retries: 2,
      schema: SessionInfoListSchema,
    }),

  getUsers: () =>
    invoke<UserInfo[]>('get_users', undefined, {
      idempotent: true,
      retries: 2,
      schema: UserInfoListSchema,
    }),

  // Auth calls are never retried automatically: a retry could count as a
  // second attempt against the daemon's server-side lockout counter for a
  // request that may have actually already succeeded or failed for a
  // legitimate reason (wrong password). The caller (App.tsx) already has
  // its own explicit retry UX — the person pressing "Log In" again.
  authenticate: (username: string, password: string) =>
    invoke<AuthResult>('authenticate', { username, password }, { schema: AuthResultSchema }),

  authenticatePattern: (username: string, pattern: number[]) =>
    invoke<AuthResult>('authenticate_pattern', { username, pattern }, { schema: AuthResultSchema }),

  // Longer timeout: fprintd-verify blocks on the physical sensor and can
  // legitimately take much longer than a typical IPC round-trip.
  authenticateFingerprint: (username: string) =>
    invoke<AuthResult>(
      'authenticate_fingerprint',
      { username },
      { timeoutMs: 35_000, schema: AuthResultSchema },
    ),

  /** Real fprintd hardware+enrollment check — see main.rs has_fingerprint(). */
  hasFingerprint: (username: string): Promise<boolean> =>
    invoke<boolean>(
      'has_fingerprint',
      { username },
      { idempotent: true, retries: 1, schema: z.boolean() },
    ).catch(() => false),

  patternIsConfigured: (username: string, home: string): Promise<boolean> =>
    invoke<boolean>(
      'pattern_is_configured',
      { username, home },
      { idempotent: true, retries: 1, schema: z.boolean() },
    ).catch(() => false),

  // Not retried: starting a session twice would launch two compositors.
  startSession: (username: string, session: string) =>
    invoke<string>(
      'start_session',
      { username, session },
      { timeoutMs: 20_000, schema: z.string() },
    ),

  // Not retried: a retried shutdown/reboot command is not something you
  // want to accidentally send twice.
  powerAction: (action: string) =>
    invoke<boolean>('power_action', { action }, { schema: z.boolean() }),

  getWallpaper: () =>
    invoke<string | null>('get_wallpaper', undefined, {
      idempotent: true,
      retries: 2,
      schema: z.string().nullable(),
    }),

  getHostname: () =>
    invoke<string>('get_hostname', undefined, { idempotent: true, retries: 2, schema: z.string() }),

  getCurrentTime: () =>
    invoke<string>('get_current_time', undefined, {
      idempotent: true,
      retries: 1,
      schema: z.string(),
    }),

  getCurrentDate: () =>
    invoke<string>('get_current_date', undefined, {
      idempotent: true,
      retries: 1,
      schema: z.string(),
    }),

  readUserAvatar: (path: string) =>
    invoke<string | null>(
      'read_user_avatar',
      { path },
      { idempotent: true, retries: 2, schema: z.string().nullable() },
    ),

  // ── New methods added for expanded greeter ────────────────────────────
  checkNetwork: async (): Promise<boolean> => {
    try {
      return await invoke<boolean>('check_network', undefined, {
        idempotent: true,
        retries: 1,
        schema: z.boolean(),
      });
    } catch {
      return true; // assume connected if command missing or the payload was malformed
    }
  },

  getBattery: async (): Promise<{ percentage: number; charging: boolean } | null> => {
    try {
      return await invoke<{ percentage: number; charging: boolean } | null>(
        'get_battery_info',
        undefined,
        {
          idempotent: true,
          retries: 1,
          schema: BatteryInfoSchema.nullable(),
        },
      );
    } catch {
      return null;
    }
  },

  getVolume: async (): Promise<number | null> => {
    try {
      return await invoke<number | null>('get_volume_level', undefined, {
        idempotent: true,
        retries: 1,
        schema: z.number().min(0).max(100).nullable(),
      });
    } catch {
      return null;
    }
  },

  setKeyboardLayout: async (layout: string): Promise<void> => {
    try {
      await invoke<void>('set_keyboard_layout_hdm', { layout });
    } catch {
      /* best-effort — a failed layout switch shouldn't block login */
    }
  },
};

// ── Dev mocks (used when running in browser without Tauri) ─────────────────

function mockInvoke<T>(cmd: string, args?: unknown): Promise<T> {
  const MOCK_USERS: UserInfo[] = [
    {
      username: 'michal',
      realname: 'Michał Kowalski',
      uid: 1000,
      home: '/home/michal',
      shell: '/bin/bash',
      icon_path: undefined,
      last_session: 'blue-environment',
    },
    {
      username: 'admin',
      realname: 'System Administrator',
      uid: 1001,
      home: '/home/admin',
      shell: '/bin/bash',
      icon_path: undefined,
      last_session: undefined,
    },
  ];

  const MOCK_SESSIONS: SessionInfo[] = [
    {
      id: 'blue-environment',
      name: 'Blue Environment',
      exec: '/usr/share/Blue-Environment/lib/blue-compositor',
      session_type: 'wayland',
      desktop_names: ['Blue'],
      comment: 'Blue Environment Wayland Desktop',
    },
    {
      id: 'gnome',
      name: 'GNOME',
      exec: 'gnome-session',
      session_type: 'wayland',
      desktop_names: ['GNOME'],
      comment: 'GNOME Desktop Environment',
    },
    {
      id: 'plasma',
      name: 'KDE Plasma',
      exec: 'startplasma-wayland',
      session_type: 'wayland',
      desktop_names: ['KDE'],
      comment: 'KDE Plasma Desktop',
    },
    {
      id: 'openbox',
      name: 'Openbox',
      exec: 'openbox-session',
      session_type: 'x11',
      desktop_names: ['Openbox'],
      comment: 'Openbox Window Manager',
    },
  ];

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  switch (cmd) {
    case 'connect_daemon':
      return delay(600).then(
        () =>
          ({
            version: '1.0.0',
            hostname: 'legendaryos-pc',
            uptime: 3600,
            os_name: 'LegendaryOS Linux',
            os_version: '0.2.0-alpha',
            connected: true,
          }) as unknown as T,
      );

    case 'get_users':
      return delay(200).then(() => MOCK_USERS as unknown as T);

    case 'get_sessions':
      return delay(200).then(() => MOCK_SESSIONS as unknown as T);

    case 'authenticate': {
      const { username, password } = args as { username: string; password: string };
      return delay(800).then(() => {
        if (password === 'demo' || password === '') {
          return { success: true, username, error: undefined, attempts_left: 5 } as unknown as T;
        }
        return {
          success: false,
          username: undefined,
          error: 'Incorrect password',
          attempts_left: 4,
        } as unknown as T;
      });
    }

    case 'authenticate_pattern': {
      const { username, pattern } = args as { username: string; pattern: number[] };
      return delay(600).then(() => {
        // Dev mock: the demo pattern is the "Z" shape 0-1-2-4-6-7-8.
        const demo = [0, 1, 2, 4, 6, 7, 8];
        const ok = pattern.length === demo.length && pattern.every((v, i) => v === demo[i]);
        return (ok
          ? { success: true, username, error: undefined, attempts_left: 5 }
          : {
              success: false,
              username: undefined,
              error: 'Pattern not recognised',
              attempts_left: 4,
            }) as unknown as T;
      });
    }

    case 'authenticate_fingerprint': {
      const { username } = args as { username: string };
      return delay(1000).then(
        () => ({ success: true, username, error: undefined, attempts_left: 5 }) as unknown as T,
      );
    }

    case 'has_fingerprint':
      return delay(100).then(() => true as unknown as T);

    case 'pattern_is_configured':
      return delay(100).then(() => true as unknown as T);

    case 'start_session':
      return delay(1200).then(() => 'mock-session-id' as unknown as T);

    case 'power_action':
      return delay(300).then(() => true as unknown as T);

    case 'get_wallpaper':
      return Promise.resolve(null as unknown as T);

    case 'get_hostname':
      return Promise.resolve('legendaryos-pc' as unknown as T);

    case 'get_current_time': {
      const now = new Date();
      const t = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      return Promise.resolve(t as unknown as T);
    }

    case 'get_current_date': {
      const now = new Date();
      const opts: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      };
      return Promise.resolve(now.toLocaleDateString('en-US', opts) as unknown as T);
    }

    case 'read_user_avatar':
      return Promise.resolve(null as unknown as T);

    // These three were referenced by HdmBridge (checkNetwork/getBattery/
    // getVolume) but had no corresponding case here, so every dev-mode
    // (non-Tauri) run silently hit the `default` branch below and got
    // `null` back instead of a plausible value — harmless in itself, but
    // it meant the system-status icons in the top bar never had anything
    // to render against outside of a real Tauri build.
    case 'check_network':
      return delay(50).then(() => true as unknown as T);

    case 'get_battery_info':
      return delay(50).then(() => ({ percentage: 87, charging: false }) as unknown as T);

    case 'get_volume_level':
      return delay(50).then(() => 62 as unknown as T);

    case 'set_keyboard_layout_hdm':
      return Promise.resolve(undefined as unknown as T);

    default:
      console.warn('[MockBridge] Unknown command:', cmd);
      return Promise.resolve(null as unknown as T);
  }
}

import { z } from 'zod';

/**
 * Most między frontendem a backendem H# (Silver). Zastępuje `tauri.ts` z wersji Tauri.
 *
 *   frontend  --silver.invoke(cmd, args)-->  app::command(...) w greeter/src/commands.h#  --IPC-->  daemon
 *
 * Format odpowiedzi komend (patrz commands.h#):
 *   - wartości proste:  {"value": ...}                  (np. has_fingerprint -> {"value": true})
 *   - listy:            {"type":"sessions","sessions":[...]} / {"type":"users","users":[...]}
 *   - obiekty:          bez opakowania (connect_daemon, authenticate*, get_greeter_config)
 *   - błąd:             odrzucony Promise (ipc::error_json)
 * Poza Silverem (przeglądarka, vitest) działa ten sam kod, a transport zastępuje `mockInvoke`
 * zwracający DOKŁADNIE ten sam format — dzięki temu rozpakowywanie jest zawsze ćwiczone.
 */

function hasSilver(): boolean {
  return typeof silver !== 'undefined' && typeof silver.invoke === 'function';
}

// ── invoke(): limity czasu + ponowienia ─────────────────────────────────────
//
//  - limit czasu na wywołanie (`IpcTimeoutError`), żeby zawieszony daemon zawsze kończył się
//    normalnym, przechwytywalnym błędem, a nie nieskończonym oczekiwaniem;
//  - ograniczone ponowienia z krótkim backoffem, ale TYLKO dla wywołań oznaczonych `idempotent`
//    — automatyczne ponawianie `authenticate` mogłoby doliczać nieudane próby do limitera daemona.

export class IpcTimeoutError extends Error {
  constructor(cmd: string, timeoutMs: number) {
    super(`HDM daemon did not respond to '${cmd}' within ${timeoutMs}ms`);
    this.name = 'IpcTimeoutError';
  }
}

/** Komunikat z dowolnej przyczyny — Silver odrzuca Promise zwykłym obiektem {code, message}. */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
}

export class IpcError extends Error {
  public cause?: unknown;

  constructor(cmd: string, cause: unknown) {
    super(`HDM IPC call '${cmd}' failed: ${describeCause(cause)}`);
    this.name = 'IpcError';
    this.cause = cause;
  }
}

/**
 * Backend zwrócił wartość o kształcie, jakiego UI nie oczekuje (patrz ipcSchemas.ts). Osobny typ
 * błędu od `IpcError`: transport się udał, ale ładunek jest niewiarygodny.
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
  /** Milisekundy do porzucenia wywołania i rzucenia IpcTimeoutError. */
  timeoutMs?: number;
  /** Bezpieczne do cichego ponowienia (odczyty). Nigdy dla zmian stanu ani prób uwierzytelnienia. */
  idempotent?: boolean;
  /** Maks. dodatkowych prób po pierwszej (tylko dla idempotent). */
  retries?: number;
  /** Wyciąga właściwą wartość z opakowania odpowiedzi, zanim zadziała schemat. */
  select?: (raw: any) => unknown;
  /** Schemat Zod: zwracany jest jego sparsowany wynik. */
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

function transport<T>(cmd: string, args?: unknown): Promise<T> {
  if (hasSilver()) {
    return silver.invoke<T>(cmd, args as Record<string, unknown> | undefined);
  }
  return mockInvoke<T>(cmd, args);
}

/** {"value": x} -> x (odpowiedź bez opakowania przechodzi bez zmian). */
export function unwrapValue(raw: any): unknown {
  return raw !== null && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
}

async function invoke<T>(cmd: string, args?: unknown, opts: InvokeOptions<T> = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.idempotent ? 1 + (opts.retries ?? 2) : 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await withTimeout(transport<unknown>(cmd, args), cmd, timeoutMs);
      const selected = opts.select ? opts.select(raw) : raw;

      if (opts.schema) {
        const parsed = opts.schema.safeParse(selected);
        if (!parsed.success) {
          throw new IpcValidationError(cmd, parsed.error.issues);
        }
        return parsed.data;
      }
      return selected as T;
    } catch (e) {
      lastError = e;
      // Błąd walidacji: ponowienie tego samego wywołania nie da innego kształtu.
      if (e instanceof IpcValidationError) break;

      if (attempt < maxAttempts) {
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

// ── Komendy ─────────────────────────────────────────────────────────────────

import type { AuthResult, DaemonInfo, SessionInfo, UserInfo } from '../types';
import {
  AuthResultSchema,
  BatteryInfoSchema,
  DaemonInfoSchema,
  FingerprintStartSchema,
  SessionInfoListSchema,
  UserInfoListSchema,
} from './ipcSchemas';

export const FINGERPRINT_EVENT = 'hdm://fingerprint';
const FINGERPRINT_TIMEOUT_MS = 35_000;

/**
 * Skan odcisku trwa do ~30 s, więc backend nie blokuje UI: komenda wraca od razu z {pending:true},
 * a wynik (AuthResult) przychodzi jako zdarzenie `hdm://fingerprint` (app::emit w on_tick).
 * Nasłuch zakładamy PRZED wywołaniem, żeby nie zgubić szybkiej odpowiedzi.
 */
async function authenticateFingerprint(username: string): Promise<AuthResult> {
  let unlisten: () => void = () => {};
  const eventResult: Promise<unknown> | null = hasSilver()
    ? new Promise<unknown>((resolve) => {
        unlisten = silver.listen<unknown>(FINGERPRINT_EVENT, resolve);
      })
    : null;
  try {
    const first = await invoke(
      'authenticate_fingerprint',
      { username },
      { timeoutMs: 10_000, schema: FingerprintStartSchema },
    );
    if ('pending' in first) {
      if (!eventResult) throw new IpcError('authenticate_fingerprint', 'no event channel');
      const payload = await withTimeout(
        eventResult,
        'authenticate_fingerprint',
        FINGERPRINT_TIMEOUT_MS,
      );
      const parsed = AuthResultSchema.safeParse(payload);
      if (!parsed.success)
        throw new IpcValidationError('authenticate_fingerprint', parsed.error.issues);
      return parsed.data;
    }
    return first;
  } finally {
    unlisten();
  }
}

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
      select: (r) => r?.sessions,
      schema: SessionInfoListSchema,
    }),

  getUsers: () =>
    invoke<UserInfo[]>('get_users', undefined, {
      idempotent: true,
      retries: 2,
      select: (r) => r?.users,
      schema: UserInfoListSchema,
    }),

  // Wywołania uwierzytelniania nigdy nie są ponawiane automatycznie: ponowienie mogłoby doliczyć
  // drugą próbę do limitera daemona za żądanie, które mogło już się udać albo legalnie nie udać.
  authenticate: (username: string, password: string) =>
    invoke<AuthResult>('authenticate', { username, password }, { schema: AuthResultSchema }),

  authenticatePattern: (username: string, pattern: number[]) =>
    invoke<AuthResult>('authenticate_pattern', { username, pattern }, { schema: AuthResultSchema }),

  authenticateFingerprint,

  /** Prawdziwa kontrola sprzętu i zapisanych palców (fprintd-list) — patrz commands.h#. */
  hasFingerprint: (username: string): Promise<boolean> =>
    invoke<boolean>(
      'has_fingerprint',
      { username },
      { idempotent: true, retries: 1, select: unwrapValue, schema: z.boolean() },
    ).catch(() => false),

  patternIsConfigured: (username: string, home: string): Promise<boolean> =>
    invoke<boolean>(
      'pattern_is_configured',
      { username, home },
      { idempotent: true, retries: 1, select: unwrapValue, schema: z.boolean() },
    ).catch(() => false),

  // Bez ponowień: dwukrotny start sesji uruchomiłby dwa kompozytory.
  startSession: (username: string, session: string) =>
    invoke<string>(
      'start_session',
      { username, session },
      { timeoutMs: 20_000, select: unwrapValue, schema: z.string() },
    ),

  // Bez ponowień: nie chcesz przypadkiem wysłać shutdown/reboot dwa razy.
  powerAction: (action: string) =>
    invoke<boolean>('power_action', { action }, { select: unwrapValue, schema: z.boolean() }),

  /** Ścieżka pliku tapety (do <img src>) albo null. */
  getWallpaper: () =>
    invoke<string | null>('get_wallpaper', undefined, {
      idempotent: true,
      retries: 2,
      select: unwrapValue,
      schema: z.string().nullable(),
    }),

  getHostname: () =>
    invoke<string>('get_hostname', undefined, {
      idempotent: true,
      retries: 2,
      select: unwrapValue,
      schema: z.string(),
    }),

  getCurrentTime: () =>
    invoke<string>('get_current_time', undefined, {
      idempotent: true,
      retries: 1,
      select: unwrapValue,
      schema: z.string(),
    }),

  getCurrentDate: () =>
    invoke<string>('get_current_date', undefined, {
      idempotent: true,
      retries: 1,
      select: unwrapValue,
      schema: z.string(),
    }),

  /** Ścieżka pliku awatara (Silver ładuje <img src> ze ścieżki — bez data-URL) albo null. */
  readUserAvatar: (path: string) =>
    invoke<string | null>(
      'read_user_avatar',
      { path },
      { idempotent: true, retries: 2, select: unwrapValue, schema: z.string().nullable() },
    ),

  checkNetwork: async (): Promise<boolean> => {
    try {
      return await invoke<boolean>('check_network', undefined, {
        idempotent: true,
        retries: 1,
        select: unwrapValue,
        schema: z.boolean(),
      });
    } catch {
      return true; // brak komendy albo zły kształt — nie blokuj logowania ikoną statusu
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
          select: unwrapValue,
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
        select: unwrapValue,
        schema: z.number().min(0).max(100).nullable(),
      });
    } catch {
      return null;
    }
  },

  setKeyboardLayout: async (layout: string): Promise<void> => {
    try {
      await invoke<unknown>('set_keyboard_layout_hdm', { layout });
    } catch {
      /* best-effort — nieudana zmiana układu nie może blokować logowania */
    }
  },
};

// ── Atrapy deweloperskie (przeglądarka / vitest, bez Silvera) ───────────────
// Zwracają ten sam format, co prawdziwy backend (opakowania {value}/{sessions}/{users}).

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
  const v = (value: unknown) => ({ value }) as unknown as T;

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
            default_session: 'blue-environment',
          }) as unknown as T,
      );

    case 'get_users':
      return delay(200).then(() => ({ type: 'users', users: MOCK_USERS }) as unknown as T);

    case 'get_sessions':
      return delay(200).then(() => ({ type: 'sessions', sessions: MOCK_SESSIONS }) as unknown as T);

    case 'authenticate': {
      const { username, password } = args as { username: string; password: string };
      return delay(800).then(() => {
        if (password === 'demo' || password === '') {
          return { success: true, username, attempts_left: 5 } as unknown as T;
        }
        return { success: false, error: 'Incorrect password', attempts_left: 4 } as unknown as T;
      });
    }

    case 'authenticate_pattern': {
      const { username, pattern } = args as { username: string; pattern: number[] };
      return delay(600).then(() => {
        // Wzorzec demonstracyjny: litera „Z” 0-1-2-4-6-7-8.
        const demo = [0, 1, 2, 4, 6, 7, 8];
        const ok = pattern.length === demo.length && pattern.every((x, i) => x === demo[i]);
        return (ok
          ? { success: true, username, attempts_left: 5 }
          : { success: false, error: 'Pattern not recognised', attempts_left: 4 }) as unknown as T;
      });
    }

    case 'authenticate_fingerprint': {
      const { username } = args as { username: string };
      // Atrapa odpowiada od razu pełnym AuthResult (prawdziwy backend: {pending:true} + zdarzenie).
      return delay(1000).then(
        () => ({ success: true, username, attempts_left: 5 }) as unknown as T,
      );
    }

    case 'has_fingerprint':
      return delay(100).then(() => v(true));

    case 'pattern_is_configured':
      return delay(100).then(() => v(true));

    case 'start_session':
      return delay(1200).then(() => v('mock-session-id'));

    case 'power_action':
      return delay(300).then(() => v(true));

    case 'get_wallpaper':
      return Promise.resolve(v(null));

    case 'get_hostname':
      return Promise.resolve(v('legendaryos-pc'));

    case 'get_current_time': {
      const now = new Date();
      const t = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      return Promise.resolve(v(t));
    }

    case 'get_current_date': {
      const now = new Date();
      const opts: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      };
      return Promise.resolve(v(now.toLocaleDateString('en-US', opts)));
    }

    case 'read_user_avatar':
      return Promise.resolve(v(null));

    case 'check_network':
      return delay(50).then(() => v(true));

    case 'get_battery_info':
      return delay(50).then(() => v({ percentage: 87, charging: false }));

    case 'get_volume_level':
      return delay(50).then(() => v(62));

    case 'set_keyboard_layout_hdm':
      return Promise.resolve(v(null));

    default:
      console.warn('[MockBridge] Unknown command:', cmd);
      return Promise.resolve(v(null));
  }
}

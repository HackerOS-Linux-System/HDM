import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HdmBridge, IpcError, IpcValidationError, IpcTimeoutError, describeCause } from './silver';

/** Ustawia fałszywe globalne `silver` (tak jak robi to Silver po stronie QuickJS). */
function installSilver(invoke: (cmd: string, args?: unknown) => Promise<unknown>) {
  const listeners = new Map<string, (p: unknown) => void>();
  const api = {
    invoke: vi.fn(invoke),
    listen: vi.fn((ev: string, cb: (p: unknown) => void) => {
      listeners.set(ev, cb);
      return () => listeners.delete(ev);
    }),
  };
  (globalThis as { silver?: unknown }).silver = api;
  return { api, emit: (ev: string, p: unknown) => listeners.get(ev)?.(p), listeners };
}

describe('HdmBridge — transport Silver', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('rozpakowuje {sessions:[...]} i waliduje kształt', async () => {
    const { api } = installSilver(async () => ({
      type: 'sessions',
      sessions: [
        {
          id: 'gnome',
          name: 'GNOME',
          exec: 'gnome-session',
          session_type: 'wayland',
          desktop_names: [],
        },
      ],
    }));
    const s = await HdmBridge.getSessions();
    expect(s).toHaveLength(1);
    expect(s[0].id).toBe('gnome');
    expect(api.invoke).toHaveBeenCalledWith('get_sessions', undefined);
  });

  it('rozpakowuje {users:[...]}', async () => {
    installSilver(async () => ({
      type: 'users',
      users: [{ username: 'a', realname: 'A', uid: 1000, home: '/home/a', shell: '/bin/sh' }],
    }));
    expect((await HdmBridge.getUsers())[0].username).toBe('a');
  });

  it('rozpakowuje {value} dla wartości prostych', async () => {
    installSilver(async (cmd) => (cmd === 'has_fingerprint' ? { value: true } : { value: 'host' }));
    expect(await HdmBridge.hasFingerprint('a')).toBe(true);
    expect(await HdmBridge.getHostname()).toBe('host');
  });

  it('przekazuje hasło z escapowanymi znakami bez zmian (argumenty to zwykły obiekt)', async () => {
    const { api } = installSilver(async () => ({ success: true, username: 'a', attempts_left: 0 }));
    await HdmBridge.authenticate('al"ice', 'p\\a"s\ns');
    expect(api.invoke).toHaveBeenCalledWith('authenticate', {
      username: 'al"ice',
      password: 'p\\a"s\ns',
    });
  });

  it('odrzuca zły kształt jako IpcValidationError i NIE ponawia', async () => {
    const { api } = installSilver(async () => ({ type: 'sessions', sessions: [{ id: 1 }] }));
    await expect(HdmBridge.getSessions()).rejects.toBeInstanceOf(IpcValidationError);
    expect(api.invoke).toHaveBeenCalledTimes(1);
  });

  it('pakuje odrzucenie Silvera ({code,message}) w IpcError z czytelnym komunikatem', async () => {
    installSilver(async () => {
      throw { code: 'daemon', message: 'Cannot connect to HDM daemon: /run/hdm/hdm.sock' };
    });
    await expect(HdmBridge.authenticate('a', 'b')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof IpcError && /Cannot connect to HDM daemon/.test((e as Error).message),
    );
  });

  it('authenticate NIE jest ponawiane po błędzie (limiter daemona)', async () => {
    const { api } = installSilver(async () => {
      throw new Error('boom');
    });
    await expect(HdmBridge.authenticate('a', 'b')).rejects.toBeInstanceOf(IpcError);
    expect(api.invoke).toHaveBeenCalledTimes(1);
  });

  it('odczyty idempotentne są ponawiane (getHostname: 1 + 2 próby)', async () => {
    vi.useFakeTimers();
    const { api } = installSilver(async () => {
      throw new Error('transient');
    });
    const p = HdmBridge.getHostname().catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toBeInstanceOf(IpcError);
    expect(api.invoke).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('zawieszone wywołanie kończy się IpcTimeoutError', async () => {
    vi.useFakeTimers();
    installSilver(() => new Promise(() => {}));
    const p = HdmBridge.authenticate('a', 'b').catch((e) => e);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await p).toBeInstanceOf(IpcTimeoutError);
    vi.useRealTimers();
  });

  it('startSession zwraca id sesji z {value}', async () => {
    installSilver(async () => ({ value: 'abc-123' }));
    expect(await HdmBridge.startSession('a', 'gnome')).toBe('abc-123');
  });

  it('checkNetwork/getBattery/getVolume są best-effort (błąd -> bezpieczna wartość)', async () => {
    installSilver(async () => {
      throw new Error('x');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const a = HdmBridge.checkNetwork();
    const b = HdmBridge.getBattery();
    const c = HdmBridge.getVolume();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await a).toBe(true);
    expect(await b).toBeNull();
    expect(await c).toBeNull();
    vi.useRealTimers();
  });
});

describe('HdmBridge — odcisk palca (zdarzenie hdm://fingerprint)', () => {
  it('{pending:true} + zdarzenie -> AuthResult, nasłuch jest sprzątany', async () => {
    const { api, emit, listeners } = installSilver(async () => ({ pending: true }));
    const p = HdmBridge.authenticateFingerprint('alice');
    await Promise.resolve();
    await Promise.resolve();
    emit('hdm://fingerprint', { success: true, username: 'alice', attempts_left: 0 });
    const r = await p;
    expect(r.success).toBe(true);
    expect(api.invoke).toHaveBeenCalledWith('authenticate_fingerprint', { username: 'alice' });
    expect(listeners.size).toBe(0);
  });

  it('wynik negatywny ze zdarzenia przechodzi walidację', async () => {
    const { emit } = installSilver(async () => ({ pending: true }));
    const p = HdmBridge.authenticateFingerprint('alice');
    await Promise.resolve();
    await Promise.resolve();
    emit('hdm://fingerprint', {
      success: false,
      error: 'Fingerprint not recognised',
      attempts_left: 3,
    });
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.attempts_left).toBe(3);
  });

  it('zły ładunek zdarzenia -> IpcValidationError', async () => {
    const { emit } = installSilver(async () => ({ pending: true }));
    const p = HdmBridge.authenticateFingerprint('alice').catch((e) => e);
    await Promise.resolve();
    await Promise.resolve();
    emit('hdm://fingerprint', { nonsense: 1 });
    expect(await p).toBeInstanceOf(IpcValidationError);
  });

  it('natychmiastowy AuthResult (np. błąd daemona) jest zwracany bez czekania na zdarzenie', async () => {
    installSilver(async () => ({
      success: false,
      error: 'Not connected to daemon',
      attempts_left: 0,
    }));
    const r = await HdmBridge.authenticateFingerprint('alice');
    expect(r.success).toBe(false);
  });
});

describe('HdmBridge — atrapa deweloperska (bez Silvera)', () => {
  it('zwraca ten sam format co backend i przechodzi walidację', async () => {
    delete (globalThis as { silver?: unknown }).silver;
    const info = await HdmBridge.connectDaemon();
    expect(info.connected).toBe(true);
    expect((await HdmBridge.getUsers()).length).toBeGreaterThan(0);
    expect((await HdmBridge.getSessions())[0].id).toBe('blue-environment');
    expect(await HdmBridge.hasFingerprint('michal')).toBe(true);
    expect((await HdmBridge.authenticate('michal', 'demo')).success).toBe(true);
    expect((await HdmBridge.authenticate('michal', 'zle')).success).toBe(false);
    expect((await HdmBridge.authenticateFingerprint('michal')).success).toBe(true);
  });
});

describe('describeCause', () => {
  it('obsługuje Error, obiekt {message} i napis', () => {
    expect(describeCause(new Error('a'))).toBe('a');
    expect(describeCause({ code: 'x', message: 'b' })).toBe('b');
    expect(describeCause('c')).toBe('c');
  });
});

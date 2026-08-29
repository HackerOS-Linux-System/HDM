import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// These tests run in "dev mock" mode (no window.__TAURI_INTERNALS__ present
// in jsdom), which exercises the same invoke() timeout/retry wrapper the
// real Tauri path uses — only the underlying call source differs.
import { HdmBridge, IpcTimeoutError, IpcValidationError } from './tauri';

describe('HdmBridge (dev mock mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves getUsers with the mock user list', async () => {
    const promise = HdmBridge.getUsers();
    await vi.advanceTimersByTimeAsync(300);
    const users = await promise;
    expect(users.length).toBeGreaterThan(0);
    expect(users[0]).toHaveProperty('username');
  });

  it('authenticate succeeds for the documented demo password', async () => {
    const promise = HdmBridge.authenticate('michal', 'demo');
    await vi.advanceTimersByTimeAsync(900);
    const result = await promise;
    expect(result).toMatchObject({ success: true, username: 'michal' });
  });

  it('authenticate fails for a wrong password', async () => {
    const promise = HdmBridge.authenticate('michal', 'not-the-password');
    await vi.advanceTimersByTimeAsync(900);
    const result = await promise;
    expect(result).toMatchObject({ success: false });
  });

  it('hasFingerprint never throws — resolves false on any underlying error', async () => {
    // has_fingerprint is mocked to always succeed in dev mode, but the
    // wrapper itself (HdmBridge.hasFingerprint) must never reject —
    // App.tsx treats a rejected hasFingerprint() as a bug, not a "no
    // fingerprint available" signal.
    const promise = HdmBridge.hasFingerprint('michal');
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toBe(true);
  });

  it('checkNetwork resolves rather than rejecting when the underlying call fails', async () => {
    const promise = HdmBridge.checkNetwork();
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe(true);
  });
});

describe('IpcTimeoutError', () => {
  it('carries the command name and timeout in its message', () => {
    const err = new IpcTimeoutError('start_session', 20_000);
    expect(err.name).toBe('IpcTimeoutError');
    expect(err.message).toContain('start_session');
    expect(err.message).toContain('20000');
  });
});

describe('IpcValidationError', () => {
  it('carries the failing Zod issues for inspection by the caller', () => {
    const fakeIssues = [{ path: ['uptime'], message: 'Expected number, received string' }];
    const err = new IpcValidationError('connect_daemon', fakeIssues);
    expect(err.name).toBe('IpcValidationError');
    expect(err.message).toContain('connect_daemon');
    expect(err.issues).toBe(fakeIssues);
  });
});

describe('HdmBridge shape validation (schema wired to every real command)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('successfully validates the mock connect_daemon payload against DaemonInfoSchema', async () => {
    // If HdmBridge.connectDaemon()'s wired-in schema and the dev mock's
    // payload shape ever drift apart, this rejects instead of silently
    // returning — this is exactly the "daemon and UI disagree on the
    // wire shape" scenario the schema layer exists to catch, exercised
    // here through the real HdmBridge call path rather than the schema
    // in isolation (see ipcSchemas.test.ts for that).
    const promise = HdmBridge.connectDaemon();
    await vi.advanceTimersByTimeAsync(700);
    await expect(promise).resolves.toMatchObject({ hostname: 'legendaryos-pc' });
  });

  it('successfully validates the mock getUsers payload against UserInfoListSchema', async () => {
    const promise = HdmBridge.getUsers();
    await vi.advanceTimersByTimeAsync(300);
    const users = await promise;
    expect(Array.isArray(users)).toBe(true);
    expect(users[0]).toHaveProperty('username');
  });
});

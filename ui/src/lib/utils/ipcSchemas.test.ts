import { describe, it, expect } from 'vitest';
import {
  AuthResultSchema,
  BatteryInfoSchema,
  DaemonInfoSchema,
  SessionInfoListSchema,
  UserInfoListSchema,
} from './ipcSchemas';

describe('ipcSchemas', () => {
  describe('DaemonInfoSchema', () => {
    it('accepts a well-formed daemon info payload', () => {
      const result = DaemonInfoSchema.safeParse({
        version: '1.0.0',
        hostname: 'my-pc',
        uptime: 3600,
        os_name: 'LegendaryOS',
        os_version: '0.2.0',
        connected: true,
      });
      expect(result.success).toBe(true);
    });

    it('rejects a payload missing a required field (e.g. a stale daemon build)', () => {
      const result = DaemonInfoSchema.safeParse({
        version: '1.0.0',
        hostname: 'my-pc',
        // uptime missing entirely
        os_name: 'LegendaryOS',
        os_version: '0.2.0',
        connected: true,
      });
      expect(result.success).toBe(false);
    });

    it('rejects a field with the wrong type (uptime as a string instead of a number)', () => {
      const result = DaemonInfoSchema.safeParse({
        version: '1.0.0',
        hostname: 'my-pc',
        uptime: '3600', // wrong type
        os_name: 'LegendaryOS',
        os_version: '0.2.0',
        connected: true,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('UserInfoListSchema', () => {
    it('accepts a list of well-formed users, with optional fields omitted', () => {
      const result = UserInfoListSchema.safeParse([
        { username: 'alice', realname: 'Alice', uid: 1000, home: '/home/alice', shell: '/bin/bash' },
      ]);
      expect(result.success).toBe(true);
    });

    it('rejects a session_type value outside the wayland/x11 enum', () => {
      const result = SessionInfoListSchema.safeParse([
        {
          id: 'x',
          name: 'X',
          exec: '/bin/x',
          session_type: 'arcan', // not a recognised session type
          desktop_names: ['X'],
        },
      ]);
      expect(result.success).toBe(false);
    });
  });

  describe('AuthResultSchema', () => {
    it('accepts a successful auth result', () => {
      const result = AuthResultSchema.safeParse({ success: true, username: 'alice', attempts_left: 5 });
      expect(result.success).toBe(true);
    });

    it('accepts a failed auth result with an error message and no username', () => {
      const result = AuthResultSchema.safeParse({ success: false, error: 'Incorrect password', attempts_left: 3 });
      expect(result.success).toBe(true);
    });

    it('rejects a payload missing attempts_left', () => {
      const result = AuthResultSchema.safeParse({ success: true, username: 'alice' });
      expect(result.success).toBe(false);
    });
  });

  describe('BatteryInfoSchema', () => {
    it('rejects an out-of-range percentage (a malformed or corrupted reading)', () => {
      const result = BatteryInfoSchema.safeParse({ percentage: 150, charging: false });
      expect(result.success).toBe(false);
    });

    it('accepts a valid battery reading', () => {
      const result = BatteryInfoSchema.safeParse({ percentage: 87, charging: true });
      expect(result.success).toBe(true);
    });
  });
});

import { z } from 'zod';

/**
 * Runtime shape validation for everything that crosses the IPC boundary
 * from the Rust side (daemon → greeter → UI).
 *
 * TypeScript's `AuthResult` / `UserInfo` / etc. interfaces in `types.ts`
 * are compile-time only — `invoke()` returns `any` under the hood (see
 * `@tauri-apps/api/core`'s own signature), so a mismatch between what
 * `daemon/src/ipc.rs` or `greeter/src/main.rs` actually serializes and
 * what the UI expects (a renamed field, a `daemon` binary built from an
 * older commit than the UI it's paired with, a future Rust-side refactor
 * that changes a field type) would previously surface as `undefined` deep
 * inside a component, or a silent wrong render — not a clear error at the
 * one place (`tauri.ts`) that's actually responsible for the boundary.
 *
 * These schemas are intentionally permissive about *extra* fields (Zod
 * objects allow unknown keys by default) — the goal is to catch "this is
 * missing or the wrong type", not to enforce an exact wire format that
 * would make additive, backwards-compatible Rust-side changes a breaking
 * UI change too.
 */

export const DaemonInfoSchema = z.object({
  version: z.string(),
  hostname: z.string(),
  uptime: z.number(),
  os_name: z.string(),
  os_version: z.string(),
  connected: z.boolean(),
});

export const UserInfoSchema = z.object({
  username: z.string(),
  realname: z.string(),
  uid: z.number(),
  home: z.string(),
  shell: z.string(),
  icon_path: z.string().optional(),
  last_session: z.string().optional(),
});

export const SessionInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  exec: z.string(),
  session_type: z.enum(['wayland', 'x11']),
  desktop_names: z.array(z.string()),
  icon: z.string().optional(),
  comment: z.string().optional(),
});

export const AuthResultSchema = z.object({
  success: z.boolean(),
  username: z.string().optional(),
  error: z.string().optional(),
  attempts_left: z.number(),
});

export const BatteryInfoSchema = z.object({
  percentage: z.number().min(0).max(100),
  charging: z.boolean(),
});

export const UserInfoListSchema = z.array(UserInfoSchema);
export const SessionInfoListSchema = z.array(SessionInfoSchema);

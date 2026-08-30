export interface SessionInfo {
  id: string;
  name: string;
  exec: string;
  session_type: 'wayland' | 'x11';
  desktop_names: string[];
  icon?: string;
  comment?: string;
}

export interface UserInfo {
  username: string;
  realname: string;
  uid: number;
  home: string;
  shell: string;
  icon_path?: string;
  last_session?: string;
}

export interface AuthResult {
  success: boolean;
  username?: string;
  error?: string;
  attempts_left: number;
}

export interface DaemonInfo {
  version: string;
  hostname: string;
  uptime: number;
  os_name: string;
  os_version: string;
  connected: boolean;
}

export type Screen =
  'connecting' | 'user-select' | 'password' | 'session-select' | 'logging-in' | 'error';

export type PowerAction = 'shutdown' | 'reboot' | 'suspend' | 'hibernate';

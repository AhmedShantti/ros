/**
 * Reserved sentinel tenant for global / anonymous identity-auth events that have
 * no real tenant (login, logout, refresh, password) — see ADR 0007. Global
 * events form a single hash chain under this id; tenant-scoped events chain under
 * their real tenant. Keeps audit_entries.tenant_id NOT NULL with zero schema
 * deviation.
 */
export const SENTINEL_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export type AuditActorType = 'user' | 'anonymous' | 'system' | 'terminal';

export const AUDIT_ACTION = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILURE: 'LOGIN_FAILURE',
  LOGOUT: 'LOGOUT',
  REFRESH_REUSE_DETECTED: 'REFRESH_REUSE_DETECTED',
  TENANT_SELECTED: 'TENANT_SELECTED',
  ROLE_ASSIGNED: 'ROLE_ASSIGNED',
  TERMINAL_REGISTERED: 'TERMINAL_REGISTERED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
} as const;

export const AUDIT_ENTITY = {
  USER: 'user',
  SESSION: 'session',
  TENANT: 'tenant',
  MEMBERSHIP: 'membership',
  TERMINAL: 'terminal',
} as const;

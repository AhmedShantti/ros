export interface PermissionDef {
  code: string;
  module: string;
  description: string;
}

/**
 * Identity-domain (RBAC administration) permissions — the ONLY permission codes
 * this service defines. They exist to guard the RBAC admin endpoints themselves.
 *
 * Business permissions (sales/inventory/…) are intentionally NOT invented here:
 * the SRS business permission catalog is not present in this repository. Seed it
 * from the SRS when available. Codes follow the SRS dot-notation `module.action`.
 */
export const IDENTITY_PERMISSIONS = {
  ROLE_READ: 'identity.role.read',
  ROLE_CREATE: 'identity.role.create',
  ROLE_UPDATE: 'identity.role.update',
  ROLE_ASSIGN: 'identity.role.assign',
  TERMINAL_READ: 'identity.terminal.read',
  TERMINAL_MANAGE: 'identity.terminal.manage',
} as const;

export const IDENTITY_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: IDENTITY_PERMISSIONS.ROLE_READ,
    module: 'identity',
    description: 'Read roles and permissions within the tenant',
  },
  {
    code: IDENTITY_PERMISSIONS.ROLE_CREATE,
    module: 'identity',
    description: 'Create tenant roles',
  },
  {
    code: IDENTITY_PERMISSIONS.ROLE_UPDATE,
    module: 'identity',
    description: 'Update tenant roles and their permission grants',
  },
  {
    code: IDENTITY_PERMISSIONS.ROLE_ASSIGN,
    module: 'identity',
    description: 'Assign or remove roles on memberships',
  },
  {
    code: IDENTITY_PERMISSIONS.TERMINAL_READ,
    module: 'identity',
    description: 'Read terminals within the tenant',
  },
  {
    code: IDENTITY_PERMISSIONS.TERMINAL_MANAGE,
    module: 'identity',
    description: 'Register, update, and revoke terminals',
  },
];

import { PermissionDef } from '../identity/authz/permissions.constants';

/**
 * Organisation permission codes (ADR 0008 D-01).
 *
 * The SRS permission catalogue (§15.2) is explicitly "representative rather than
 * exhaustive; the full catalogue is maintained in Appendix C" — and Appendix C is
 * NOT present in ROS_SRS_v1.0.pdf. The only Organisation-adjacent codes the SRS
 * actually contains are `settings.tenant.manage` and `settings.branch.manage`.
 *
 * Ratified decision: use those two verbatim, plus exactly TWO invented read
 * companions, because collapsing read into manage would make the §15.3 Auditor
 * role ("read-only everything") unexpressible. The two `.read` codes are
 * PROVISIONAL — if Appendix C names them differently, remap per ADR 0008 D-01.
 *
 * No other Organisation permission was invented.
 */
export const ORGANISATION_PERMISSIONS = {
  /** Tenant-level Organisation objects: Brand, Warehouse, Central Kitchen. */
  TENANT_READ: 'settings.tenant.read',
  TENANT_MANAGE: 'settings.tenant.manage',
  /** Branch-level objects: Branch, Station, Table, Hours, Routing. */
  BRANCH_READ: 'settings.branch.read',
  BRANCH_MANAGE: 'settings.branch.manage',
} as const;

export const ORGANISATION_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: ORGANISATION_PERMISSIONS.TENANT_READ,
    module: 'settings',
    description: 'Read tenant-level organisation configuration',
  },
  {
    code: ORGANISATION_PERMISSIONS.TENANT_MANAGE,
    module: 'settings',
    description: 'Manage tenant configuration (brands, warehouses, kitchens)',
  },
  {
    code: ORGANISATION_PERMISSIONS.BRANCH_READ,
    module: 'settings',
    description: 'Read branch-level organisation configuration',
  },
  {
    code: ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
    module: 'settings',
    description: 'Manage branch configuration (stations, tables, routing)',
  },
];

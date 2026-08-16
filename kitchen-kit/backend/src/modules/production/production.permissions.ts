import { PermissionDef } from '../identity/authz/permissions.constants';

/**
 * Production Spec permission codes — EXACTLY the three attested verbatim by
 * SRS §15.2 ("recipe.view / recipe.edit / recipe.publish"). D-17-06 forbids
 * inventing any further code.
 *
 * Consequences of that decision, recorded so they are not mistaken for
 * oversights:
 *   - substitute-group operations fall under `recipe.edit`;
 *   - creating a branch override is `recipe.edit`, identical to editing a
 *     brand-standard recipe — the SRS defines no separate capability;
 *   - `POST /recipes` (the GAP-1 ratified endpoint) is `recipe.edit`.
 *
 * Authorization is TENANT-scoped. ADR 0008 D-02's deferral of branch-scoped
 * RBAC still stands: no handler reads `TenantContext.branchId`, even though a
 * recipe may carry a branch scope.
 */
export const PRODUCTION_PERMISSIONS = {
  VIEW: 'recipe.view',
  EDIT: 'recipe.edit',
  PUBLISH: 'recipe.publish',
} as const;

export const PRODUCTION_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: PRODUCTION_PERMISSIONS.VIEW,
    module: 'recipe',
    description: 'View recipes',
  },
  {
    code: PRODUCTION_PERMISSIONS.EDIT,
    module: 'recipe',
    description: 'Edit recipes',
  },
  {
    code: PRODUCTION_PERMISSIONS.PUBLISH,
    module: 'recipe',
    description: 'Publish a recipe version',
  },
];

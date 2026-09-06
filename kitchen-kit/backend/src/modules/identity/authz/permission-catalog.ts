import type { PermissionDef } from './permissions.constants';
import { IDENTITY_PERMISSION_DEFS } from './permissions.constants';
import { SALES_PERMISSION_DEFS } from '../../sales/contract';
import { CATALOGUE_PERMISSION_DEFS } from '../../catalogue/contract';
import { INVENTORY_PERMISSION_DEFS } from '../../inventory/contract';
import { ORGANISATION_PERMISSION_DEFS } from '../../organisation/contract';
import { PRODUCTION_PERMISSION_DEFS } from '../../production/contract';
import { TREASURY_PERMISSION_DEFS } from '../../treasury/contract';
import { KDS_PERMISSION_DEFS } from '../../kitchen/contract';
import { REPORTING_PERMISSION_DEFS } from '../../reporting/contract';
import { AUDIT_PERMISSION_DEFS } from '../../governance/contract';
import { WORKFORCE_PERMISSION_DEFS } from '../../workforce/contract';

/**
 * SIGNUP-1 — the full, production-safe permission catalog.
 *
 * Every module's permission definitions, aggregated ONCE from each module's
 * own PUBLIC `contract/` barrel (never a private path — see
 * `module-boundaries.spec.ts`). This is the SAME set `src/scripts/
 * seed-dev-data.ts` upserts for local/dev fixtures; both this module and that
 * script import their module-level defs independently (the script reaches
 * each module directly since it lives outside `src/modules/` and is not
 * scanned by the architecture test), so there is exactly one authored list of
 * permission definitions per module, never a second copy.
 *
 * Used by tenant self-service signup (`RegistrationsService`) to bootstrap the
 * permission catalog on a schema-only production database — idempotent
 * (`PermissionsService.upsert` is an upsert keyed on `Permission.code`), and
 * NOT coupled to demo seeding.
 */
export const ALL_PERMISSION_DEFS: PermissionDef[] = [
  ...IDENTITY_PERMISSION_DEFS,
  ...SALES_PERMISSION_DEFS,
  ...CATALOGUE_PERMISSION_DEFS,
  ...INVENTORY_PERMISSION_DEFS,
  ...ORGANISATION_PERMISSION_DEFS,
  ...PRODUCTION_PERMISSION_DEFS,
  ...TREASURY_PERMISSION_DEFS,
  ...KDS_PERMISSION_DEFS,
  ...REPORTING_PERMISSION_DEFS,
  ...AUDIT_PERMISSION_DEFS,
  ...WORKFORCE_PERMISSION_DEFS,
];

export const ALL_PERMISSION_CODES: string[] = ALL_PERMISSION_DEFS.map(
  (def) => def.code,
);

/**
 * CANONICAL-ROLE-PERMISSION-BACKFILL-P0 — reconcile every already-existing
 * tenant's canonical-named roles (Cashier / Branch Manager / Shift
 * Supervisor / Kitchen Staff) against the CURRENT canonical template.
 *
 * WHY THIS EXISTS
 *
 * `ensureCanonicalRole` (`../modules/identity/authz/canonical-role-templates`)
 * only runs at tenant signup, at Cashier auto-provisioning for a new
 * employee, and on an explicit role (re)assignment — its own docblock is
 * explicit that a role created under an earlier, narrower template version
 * "self-heals the next time ANY employee is assigned that role by name",
 * never automatically, never on login, never on a schedule. A tenant whose
 * canonical role rows were materialised BEFORE a template hotfix (e.g.
 * DEMO-AUTH-CASH-HOTFIX-P0, which added `cash.session.close` /
 * `cash.session.close_other` to Branch Manager) never gains the new codes
 * on its own. This script closes that gap for EVERY existing tenant,
 * generically — it is not specific to any one tenant, employee, or
 * permission code. It reads the codes to grant directly from
 * `CANONICAL_ROLE_TEMPLATES`, the single source of truth this repository
 * already uses for the identical decision at provisioning time — no second
 * copy of the permission list is authored here.
 *
 * WHAT IT DOES NOT DO
 *
 *  - Never creates a `Role` row. A tenant that never had a given canonical
 *    role keeps not having it — this is a repair, not a new grant.
 *  - Never touches a role whose name is not one of the four canonical
 *    names — a "custom" role, however similar its permission set, is never
 *    read or written (see `reconcileExistingCanonicalRoles`'s own doc).
 *  - Never removes a `RolePermission` row. Additive only.
 *  - Never reads or writes `MembershipRole` (assignments/scopes) at all.
 *  - Never changes authorization guards, Treasury/cash-session code, or POS
 *    session semantics — it only reconciles `identity.role_permissions`.
 *
 * CREDENTIALS
 *
 * Runs as the ordinary application database role (`APP_DATABASE_URL`,
 * RLS-constrained `ros_app`) via the same `PrismaService.withAuthContext`
 * every other tenant-scoped write in this codebase already uses — no
 * migrator/superuser credential is needed. `identity.tenants` itself
 * carries no row-level-security policy (a caller must be able to resolve
 * which tenant to scope to before any tenant context exists), so listing
 * tenant ids needs no special privilege either.
 *
 * IDEMPOTENCY / FAILURE BEHAVIOUR
 *
 * Safe to run any number of times: a tenant/role with nothing missing is
 * simply skipped in the printed summary (its `addedPermissionCodes` array is
 * empty). Each tenant is reconciled inside its own transaction
 * (`withAuthContext`) — a failure partway through one tenant rolls back only
 * that tenant's changes and stops the run; tenants already processed keep
 * their (already-committed, correct) state, and re-running the script from
 * the top is safe and picks up exactly where it left off, because every
 * already-reconciled role is a no-op on the next pass.
 *
 * USAGE
 *
 *   npx ts-node -r tsconfig-paths/register \
 *     src/scripts/backfill-canonical-role-permissions.ts
 *
 *   # or, compiled:
 *   node dist/scripts/backfill-canonical-role-permissions.js
 *
 * Prints a per-tenant, per-role summary of exactly what was added (or "no
 * changes needed") and exits 0 on success, 1 on any error (nothing is ever
 * partially applied beyond the transaction boundary above).
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import {
  reconcileExistingCanonicalRoles,
  type CanonicalRoleReconciliationResult,
} from '../modules/identity/authz/canonical-role-templates';

/**
 * Iterates every tenant and reconciles its already-existing canonical
 * roles. Exported (not run inline) so it can be unit-tested against a
 * mocked `prisma` without a real database —
 * `backfill-canonical-role-permissions.spec.ts`.
 */
export async function backfillCanonicalRolePermissions(
  prisma: Pick<PrismaService, 'tenant' | 'withAuthContext'>,
): Promise<CanonicalRoleReconciliationResult[]> {
  const tenants = await prisma.tenant.findMany({ select: { id: true } });

  const results: CanonicalRoleReconciliationResult[] = [];
  for (const { id: tenantId } of tenants) {
    const tenantResults = await prisma.withAuthContext(
      { tenantId },
      (tx) => reconcileExistingCanonicalRoles(tx, tenantId),
    );
    results.push(...tenantResults);
  }
  return results;
}

function printSummary(results: CanonicalRoleReconciliationResult[]): void {
  const changed = results.filter((r) => r.addedPermissionCodes.length > 0);
  if (changed.length === 0) {
    console.log(
      'Canonical role backfill: no changes needed — every existing canonical role already matches its template.',
    );
    return;
  }
  console.log(`Canonical role backfill: ${changed.length} role(s) updated.`);
  for (const r of changed) {
    console.log(
      `  tenant=${r.tenantId} role="${r.roleName}" (${r.templateKey}) +[${r.addedPermissionCodes.join(', ')}]`,
    );
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const results = await backfillCanonicalRolePermissions(prisma);
    printSummary(results);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('Canonical role backfill failed:', error);
    process.exitCode = 1;
  });
}

import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { CATALOGUE_PERMISSIONS } from '../../catalogue/contract';
import { INVENTORY_PERMISSIONS } from '../../inventory/contract';
import { KDS_PERMISSIONS } from '../../kitchen/contract';
import { ORGANISATION_PERMISSIONS } from '../../organisation/contract';
import { REPORTING_PERMISSIONS } from '../../reporting/contract';
import { SALES_PERMISSIONS } from '../../sales/contract';
import { TREASURY_PERMISSIONS } from '../../treasury/contract';
import { WORKFORCE_PERMISSIONS } from '../../workforce/contract';

/**
 * DEMO-EMPLOYEE-RBAC-1 — canonical demo role templates.
 *
 * `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (~line 5841-5850,
 * "AMENDMENT — D-2 REOPENED IN PART (2)") is explicit: "ROS has no
 * system-defined 'standard role' persistence mechanism" — a tenant's
 * Cashier/Branch-Manager-equivalent role is a POLICY choice made by
 * "the tenant-admin RBAC API or test/seed bootstrap", never a hardcoded
 * role-name -> permission-set rule inside the authorization path itself.
 * This file IS that onboarding-tooling policy — the same role a real tenant
 * admin could have composed by hand through `POST /auth/roles` +
 * `POST /auth/roles/:roleId/permissions` — declared once so
 * `RegistrationsService` (tenant signup) and `WorkforceEmployeesService`
 * (auto-provisioned Cashier) share exactly one definition instead of two
 * drifting copies.
 *
 * Every permission code is imported from its OWNING module's public
 * `contract/` barrel (never a private path, never a re-declared string
 * literal) — the same precedent `identity/authz/permission-catalog.ts`
 * already established for the full catalog aggregation.
 */
export type CanonicalRoleTemplateKey =
  | 'cashier'
  | 'branch_manager'
  | 'shift_supervisor'
  | 'kitchen_staff';

export interface CanonicalRoleTemplate {
  readonly key: CanonicalRoleTemplateKey;
  /** Exact `Role.name` — create-if-missing, reused by name within the tenant. */
  readonly name: string;
  readonly description: string;
  readonly permissionCodes: readonly string[];
}

/**
 * Cashier — FR-POS-090 verbatim: opening AND closing one's OWN shift is a
 * cashier-tier action (`cash.session.open` / `cash.session.close`, per
 * `treasury.permissions.ts`'s own docblock), distinct from
 * `cash.session.close_other` (closing someone ELSE's shift — manager-tier,
 * deliberately withheld here). `pos.payment.capture` is included so a
 * cashier who can create and fire an order can also take payment for it —
 * the accepted end-to-end cashier workflow. No reporting, no
 * inventory-cost-view, no branch-management permission — matching the
 * governance register's explicit "NOT granted: Cashier" list for those.
 */
const CASHIER_PERMISSION_CODES = [
  SALES_PERMISSIONS.ORDER_CREATE,
  SALES_PERMISSIONS.ORDER_FIRE,
  SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE,
  SALES_PERMISSIONS.PAYMENT_CAPTURE,
  CATALOGUE_PERMISSIONS.ITEM_READ,
  CATALOGUE_PERMISSIONS.PRICE_READ,
  CATALOGUE_PERMISSIONS.AVAILABILITY_READ,
  TREASURY_PERMISSIONS.CASH_SESSION_OPEN,
  TREASURY_PERMISSIONS.CASH_SESSION_CLOSE,
] as const;

/**
 * Branch Manager — verbatim the same permission set `seed-dev-data.ts`
 * already seeds for its own demo Branch Manager role. Not altered by this
 * ticket; declared here so both the seed script and this production onboarding
 * path could, in principle, share one definition (the seed script keeps its
 * own literal copy, being outside `src/modules/` and not subject to the
 * architecture test — no behaviour changes there).
 */
const BRANCH_MANAGER_PERMISSION_CODES = [
  ORGANISATION_PERMISSIONS.BRANCH_READ,
  ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
  SALES_PERMISSIONS.ORDER_CREATE,
  SALES_PERMISSIONS.ORDER_FIRE,
  SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE,
  CATALOGUE_PERMISSIONS.ITEM_READ,
  CATALOGUE_PERMISSIONS.PRICE_READ,
  CATALOGUE_PERMISSIONS.AVAILABILITY_READ,
  INVENTORY_PERMISSIONS.VIEW,
  INVENTORY_PERMISSIONS.ADJUST,
  TREASURY_PERMISSIONS.CASH_SESSION_OPEN,
  WORKFORCE_PERMISSIONS.EMPLOYEE_VIEW,
  WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE,
  REPORTING_PERMISSIONS.VIEW_SALES,
  REPORTING_PERMISSIONS.VIEW_FINANCIAL,
] as const;

/**
 * Shift Supervisor — NO existing precedent anywhere in this codebase; this is
 * an authored composition (a considered judgment call, not a ratified
 * template): everything Cashier has, plus the ability to close ANOTHER
 * cashier's shift (`cash.session.close_other` — the literal supervisory act)
 * and to approve an above-limit discount (`pos.discount.approve`, the
 * generic manager-tier override permission this catalogue provides).
 * Deliberately WITHOUT `organisation.branch.manage`, any reporting
 * permission, or `inventory.adjust` — those stay Branch-Manager-tier.
 */
const SHIFT_SUPERVISOR_PERMISSION_CODES = [
  ...CASHIER_PERMISSION_CODES,
  TREASURY_PERMISSIONS.CASH_SESSION_CLOSE_OTHER,
  SALES_PERMISSIONS.DISCOUNT_APPROVE,
] as const;

/**
 * Kitchen Staff — EXACTLY `kds.operate`. KDS-R11 (ratified 2026-08-30) is
 * explicit that this ONE coarse code "MUST NOT be split" and station-level
 * scope is enforced by the terminal-to-station binding, not by RBAC scope —
 * so no other permission belongs on this role.
 */
const KITCHEN_STAFF_PERMISSION_CODES = [KDS_PERMISSIONS.OPERATE] as const;

export const CANONICAL_ROLE_TEMPLATES: Readonly<
  Record<CanonicalRoleTemplateKey, CanonicalRoleTemplate>
> = {
  cashier: {
    key: 'cashier',
    name: 'Cashier',
    description:
      'POS order capture, own-shift cash session, payment capture.',
    permissionCodes: CASHIER_PERMISSION_CODES,
  },
  branch_manager: {
    key: 'branch_manager',
    name: 'Branch Manager',
    description: 'Branch-scoped day-to-day operations and reporting.',
    permissionCodes: BRANCH_MANAGER_PERMISSION_CODES,
  },
  shift_supervisor: {
    key: 'shift_supervisor',
    name: 'Shift Supervisor',
    description:
      'Cashier duties plus closing other cashiers’ shifts and approving above-limit discounts.',
    permissionCodes: SHIFT_SUPERVISOR_PERMISSION_CODES,
  },
  kitchen_staff: {
    key: 'kitchen_staff',
    name: 'Kitchen Staff',
    description: 'KDS station operation only.',
    permissionCodes: KITCHEN_STAFF_PERMISSION_CODES,
  },
};

const CANONICAL_ROLE_KEY_BY_NAME: ReadonlyMap<string, CanonicalRoleTemplateKey> =
  new Map(
    Object.values(CANONICAL_ROLE_TEMPLATES).map((template) => [
      template.name,
      template.key,
    ]),
  );

/**
 * DEMO-OPS-HOTFIX-2 — identify whether an existing `Role.name` is one of the
 * canonical templates, so a caller that is about to GRANT an already-existing
 * role (found by id, e.g. via `GET /auth/roles`) can reconcile it to the
 * CURRENT template's permission set first via `ensureCanonicalRole`. This is
 * what makes the fix live in "the canonical role template/provisioning" (as
 * required) rather than in one employee's grant: a role row created under an
 * earlier, narrower version of a template (e.g. the original
 * LIVE-DEMO-HOTFIX-1 Cashier cut, missing `cash.session.open`) self-heals the
 * next time ANY employee is assigned that role by name, with no migration and
 * no per-tenant backfill required.
 */
export function canonicalRoleKeyForName(
  name: string,
): CanonicalRoleTemplateKey | undefined {
  return CANONICAL_ROLE_KEY_BY_NAME.get(name);
}

/**
 * Idempotent create-or-reuse-by-name of a tenant role for the given template,
 * with every one of its permission codes upserted onto it. Safe to call on
 * every signup and every employee creation — never duplicates a role row or a
 * grant. Runs INLINE on the caller's own transaction (mirrors
 * `RegistrationsService`/`WorkforceEmployeesService`'s existing inline-`tx`
 * composition — `PrismaService.withAuthContext` does not support nested
 * interactive transactions, so this cannot open its own).
 */
export async function ensureCanonicalRole(
  tx: Prisma.TransactionClient,
  tenantId: string,
  templateKey: CanonicalRoleTemplateKey,
): Promise<{ id: string }> {
  const template = CANONICAL_ROLE_TEMPLATES[templateKey];

  let role = await tx.role.findFirst({
    where: { tenantId, name: template.name, isSystem: false },
    select: { id: true },
  });
  if (!role) {
    role = await tx.role.create({
      data: {
        id: newId(),
        tenantId,
        name: template.name,
        description: template.description,
        isSystem: false,
      },
      select: { id: true },
    });
  }

  for (const code of template.permissionCodes) {
    const permission = await tx.permission.findUnique({ where: { code } });
    // Defensive: the permission catalog bootstrap (signup/auto-provision)
    // runs immediately before this in every caller, so this should never
    // miss — but never hard-fail role provisioning over a bootstrap race.
    if (!permission) continue;
    await tx.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }

  return role;
}

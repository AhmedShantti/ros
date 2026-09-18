import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { CATALOGUE_PERMISSIONS } from '../../catalogue/contract';
import { INVENTORY_PERMISSIONS } from '../../inventory/contract';
import { KDS_PERMISSIONS } from '../../kitchen/contract';
import { ORGANISATION_PERMISSIONS } from '../../organisation/contract';
import { PROCUREMENT_PERMISSIONS } from '../../procurement/contract';
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
  'cashier' | 'branch_manager' | 'shift_supervisor' | 'kitchen_staff';

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
 *
 * `pos.refund.issue` (GOLDEN-PATH-BACKEND-CLOSURE, 2026-09-07) is included so
 * a Cashier can INITIATE a refund — this grants only the ability to start the
 * flow, never to self-approve it: `RefundsService.issueRefund` still requires
 * manager sign-off (`pos.discount.approve`, verified via manager PIN) unless a
 * branch's `DiscountApprovalPolicyVersion` explicitly raises a no-approval
 * threshold, and no such policy is provisioned by default (absent policy =
 * approval always required — the safe default, unchanged by this grant).
 * `pos.refund.different_tender` (refunding to a tender other than the
 * original) and `pos.discount.approve` (the approval act itself) are
 * deliberately WITHHELD here — that separation is the point.
 *
 * `pos.discount.apply` and `pos.comp.apply` (DEMO-PRODUCTION-CLOSURE-P0,
 * 2026-09-07) are included so a Cashier can reach the ordinary line/order
 * discount and comp routes at all — SRS §15.2 names both as base-tier
 * capabilities ("Apply discounts within limits" / "Give complimentary
 * items"), and `DiscountsService.applyLineDiscount` /
 * `applyOrderDiscount` still gate any above-threshold amount behind
 * `resolveApproval` → manager PIN + `pos.discount.approve` regardless of
 * this grant (absent an approval-threshold policy, EVERY discount still
 * requires approval — unchanged). `applyComp` carries no such
 * threshold/approval mechanism in the domain model (SRS names no
 * comp-approval act), so `pos.comp.apply` alone is the complete authority
 * for it, matching the demo golden path's "discount/comp if shown" step.
 * `pos.discount.unlimited` (the approval-BYPASS override) and
 * `pos.order.void_line_postfire` are deliberately WITHHELD here —
 * `pos.order.void_line_postfire` in particular is governed by
 * `GOVERNANCE_DECISION_REGISTER.md` CLARIFICATION C ("AFTER a line is
 * fired — the cashier SHALL NOT directly mutate that fired content ...
 * requiring Manager-or-higher authority"), so it cannot be granted to
 * Cashier regardless of route-reachability; both live on
 * `SHIFT_SUPERVISOR_PERMISSION_CODES` instead.
 *
 * `pos.order.cancel` (FULL-SRS-POS-ORDER-CANCELLATION-P3) is included so a
 * Cashier can cancel an ORDINARY (unproduced) order — the same base-tier
 * posture as `pos.order.void_line_prefire`. `pos.order.cancel_after_
 * production` (BR-POS-003's elevated-approval permission) is deliberately
 * WITHHELD here for the identical CLARIFICATION C reason
 * `pos.order.void_line_postfire` is — it lives on
 * `SHIFT_SUPERVISOR_PERMISSION_CODES` instead.
 */
const CASHIER_PERMISSION_CODES = [
  SALES_PERMISSIONS.ORDER_CREATE,
  SALES_PERMISSIONS.ORDER_FIRE,
  SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE,
  SALES_PERMISSIONS.ORDER_CANCEL,
  SALES_PERMISSIONS.PAYMENT_CAPTURE,
  SALES_PERMISSIONS.DISCOUNT_APPLY,
  SALES_PERMISSIONS.COMP_APPLY,
  SALES_PERMISSIONS.REFUND_ISSUE,
  CATALOGUE_PERMISSIONS.ITEM_READ,
  CATALOGUE_PERMISSIONS.PRICE_READ,
  CATALOGUE_PERMISSIONS.AVAILABILITY_READ,
  TREASURY_PERMISSIONS.CASH_SESSION_OPEN,
  TREASURY_PERMISSIONS.CASH_SESSION_CLOSE,
] as const;

/**
 * Branch Manager — the same permission set `seed-dev-data.ts` seeds for its
 * own demo Branch Manager role, corrected by DEMO-AUTH-CASH-HOTFIX-P0
 * (2026-09-14): the template granted `cash.session.open` but neither
 * `cash.session.close` nor `cash.session.close_other`, so a Branch Manager
 * could open a drawer but could never close it — not their own, and not a
 * cashier's, despite being the role this system expects to reconcile a
 * branch's cash sessions. `seed-dev-data.ts` keeps its own literal copy
 * (outside `src/modules/`, not subject to the architecture test) and must be
 * updated identically.
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
  TREASURY_PERMISSIONS.CASH_SESSION_CLOSE,
  TREASURY_PERMISSIONS.CASH_SESSION_CLOSE_OTHER,
  WORKFORCE_PERMISSIONS.EMPLOYEE_VIEW,
  WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE,
  REPORTING_PERMISSIONS.VIEW_SALES,
  REPORTING_PERMISSIONS.VIEW_FINANCIAL,
  // FULL-SRS-PRC-PURCHASE-ORDERS-P2 — FR-PRC-018's own value-band table
  // names "Branch Manager" as the threshold-1..2 tier's approver; this is
  // the only band whose prose name matches an existing canonical role in
  // this codebase. Tiers 2/3 ("Operations Director"/"Tenant Owner") have no
  // canonical role template here — no such template exists anywhere in this
  // repository yet (only Cashier/Branch Manager/Shift Supervisor/Kitchen
  // Staff do), and inventing one is out of this slice's scope (mission
  // brief §8: "map value bands... using CURRENT role templates" — not
  // author new ones). Those two codes are seeded and independently grantable
  // via a tenant-created custom role, exactly like any other catalogue code
  // with no canonical-template attachment yet.
  PROCUREMENT_PERMISSIONS.REQUISITION_CREATE,
  PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE,
  PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_1,
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
 *
 * `pos.discount.unlimited` (DEMO-PRODUCTION-CLOSURE-P0, 2026-09-07) — the
 * per-actor approval-threshold BYPASS (SRS §15.2 "Apply discounts without
 * limit") — is manager-tier by definition (it exists to let a supervisor
 * skip the very approval gate `pos.discount.approve` otherwise enforces), so
 * it is added here rather than to Cashier. `pos.order.void_line_postfire`
 * is added here because `GOVERNANCE_DECISION_REGISTER.md` CLARIFICATION C
 * makes a post-fire line correction/void explicitly "Manager-or-higher
 * authority" — Shift Supervisor is the smallest canonical role that
 * satisfies that bar, so this is where SRS-consistent route-reachability
 * requires it to live, not on Cashier.
 *
 * `pos.order.cancel_after_production` (FULL-SRS-POS-ORDER-CANCELLATION-P3,
 * BR-POS-003) is added for the identical reason as
 * `pos.order.void_line_postfire` immediately above — it is the same
 * Manager-or-higher bar, for the produced/bumped-line cancellation limb.
 */
const SHIFT_SUPERVISOR_PERMISSION_CODES = [
  ...CASHIER_PERMISSION_CODES,
  TREASURY_PERMISSIONS.CASH_SESSION_CLOSE_OTHER,
  SALES_PERMISSIONS.DISCOUNT_APPROVE,
  SALES_PERMISSIONS.DISCOUNT_UNLIMITED,
  SALES_PERMISSIONS.ORDER_VOID_LINE_POSTFIRE,
  SALES_PERMISSIONS.ORDER_CANCEL_AFTER_PRODUCTION,
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
    description: 'POS order capture, own-shift cash session, payment capture.',
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

const CANONICAL_ROLE_KEY_BY_NAME: ReadonlyMap<
  string,
  CanonicalRoleTemplateKey
> = new Map(
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
 * Idempotently ensures `roleId` carries every code in `permissionCodes` —
 * ADDITIVE ONLY. Never removes a `RolePermission` row a tenant (or an
 * earlier, narrower template version) already granted, so a role a tenant
 * has since customised is only ever widened toward the current template,
 * never reset to it. Shared by `ensureCanonicalRole` (create-or-reuse a
 * role, then reconcile it) and `reconcileExistingCanonicalRoles`
 * (CANONICAL-ROLE-PERMISSION-BACKFILL-P0 — reconcile a role that already
 * exists, never creating one) so the upsert loop exists exactly once.
 *
 * Returns the codes that were actually missing (and have now been added),
 * so a caller can report what a backfill run changed without a second,
 * separate diff query.
 */
async function reconcileRolePermissions(
  tx: Prisma.TransactionClient,
  roleId: string,
  permissionCodes: readonly string[],
): Promise<{ addedPermissionCodes: string[] }> {
  const existing = await tx.rolePermission.findMany({
    where: { roleId },
    select: { permission: { select: { code: true } } },
  });
  const have = new Set(existing.map((rp) => rp.permission.code));
  const missing = permissionCodes.filter((code) => !have.has(code));

  const addedPermissionCodes: string[] = [];
  for (const code of missing) {
    const permission = await tx.permission.findUnique({ where: { code } });
    // Defensive: the permission catalog bootstrap (signup/auto-provision)
    // runs immediately before this in every caller, so this should never
    // miss — but never hard-fail role provisioning over a bootstrap race.
    if (!permission) continue;
    await tx.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId, permissionId: permission.id },
      },
      update: {},
      create: { roleId, permissionId: permission.id },
    });
    addedPermissionCodes.push(code);
  }

  return { addedPermissionCodes };
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

  await reconcileRolePermissions(tx, role.id, template.permissionCodes);

  return role;
}

/** One canonical role's reconciliation result, for a backfill run's report. */
export interface CanonicalRoleReconciliationResult {
  readonly tenantId: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly templateKey: CanonicalRoleTemplateKey;
  readonly addedPermissionCodes: readonly string[];
}

/**
 * CANONICAL-ROLE-PERMISSION-BACKFILL-P0 — reconciles every ALREADY-EXISTING
 * canonical-named role in ONE tenant against the CURRENT template.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `ensureCanonicalRole` ───────────────────
 * `ensureCanonicalRole` is a provisioning-time call: it names ONE template
 * key and creates the role if the tenant never had it. A backfill must never
 * do that — inventing a Role row for a canonical name a tenant deliberately
 * never provisioned (e.g. no Kitchen Staff at a takeaway-only branch) would
 * be a new grant, not a repair. This function only ever touches a `Role`
 * row that ALREADY EXISTS; a canonical role the tenant never had is left
 * alone, exactly as before.
 *
 * ── SAME "CUSTOM ROLE" SAFETY AS THE NAME-MATCH SELF-HEAL ───────────────────
 * Matches roles by `name IN (canonical template names)` AND `isSystem:
 * false` — the identical signal `canonicalRoleKeyForName` already uses to
 * self-heal on the next (re)assignment (this module's own docblock above).
 * Anything else — any other name — is a custom role and is never read or
 * written here.
 *
 * ── ADDITIVE, NEVER DESTRUCTIVE ──────────────────────────────────────────
 * Delegates the actual upsert to `reconcileRolePermissions`, the exact same
 * routine `ensureCanonicalRole` uses — no second copy of "how to grant a
 * missing code" exists. A tenant's own extra permissions on a canonical
 * role are untouched; `MembershipRole` (assignment + scope) rows are never
 * read or written by this function at all.
 *
 * Runs on the caller's own tenant-scoped transaction (mirrors
 * `ensureCanonicalRole`'s signature) — the caller is responsible for
 * establishing `PrismaService.withAuthContext({ tenantId })` per tenant, the
 * same convention every other cross-tenant-unsafe call in this codebase
 * already follows. Idempotent: a second call for the same tenant always
 * returns results with empty `addedPermissionCodes` arrays.
 */
export async function reconcileExistingCanonicalRoles(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<CanonicalRoleReconciliationResult[]> {
  const canonicalNames = Object.values(CANONICAL_ROLE_TEMPLATES).map(
    (template) => template.name,
  );

  const roles = await tx.role.findMany({
    where: { tenantId, isSystem: false, name: { in: canonicalNames } },
    select: { id: true, name: true },
  });

  const results: CanonicalRoleReconciliationResult[] = [];
  for (const role of roles) {
    const templateKey = canonicalRoleKeyForName(role.name);
    // Unreachable given the `name: { in: canonicalNames } }` filter above —
    // guarded anyway so a future rename of a template's `name` cannot ever
    // silently touch a role it no longer recognises.
    if (!templateKey) continue;
    const template = CANONICAL_ROLE_TEMPLATES[templateKey];

    const { addedPermissionCodes } = await reconcileRolePermissions(
      tx,
      role.id,
      template.permissionCodes,
    );

    results.push({
      tenantId,
      roleId: role.id,
      roleName: role.name,
      templateKey,
      addedPermissionCodes,
    });
  }

  return results;
}

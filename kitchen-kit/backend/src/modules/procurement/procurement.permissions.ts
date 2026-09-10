import type { PermissionDef } from '../identity/contract';

/**
 * FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1.
 *
 * `supplier.manage` is taken VERBATIM from the SRS §15.2 permission
 * catalogue — the same "unwired SRS code, now seeded by the module that
 * finally implements it" pattern `hr.employee.manage` (Workforce),
 * `kds.operate` (Kitchen) and `report.view.*` (Reporting) each established.
 * A prior full-SRS backend audit
 * (`docs/reports/claude/2026-09-07_SRS-AUDIT-IDENTITY-RBAC_...md`)
 * independently confirmed the entire Procurement permission domain
 * (`purchase.*`, `supplier.manage`) was absent because no Procurement module
 * existed at all — this is that domain's first code.
 *
 * ONE code, deliberately, covering every supplier-master / sourcing /
 * pricing MUTATION (create, update, status change, link, price entry). SRS
 * §15.2 gives no separate `supplier.view` verb, so — mirroring
 * `WORKFORCE_PERMISSIONS.EMPLOYEE_VIEW`'s "no read verb, so the nearest
 * read-shaped permission covers it" discipline — `supplier.manage` also
 * gates ordinary reads of supplier/sourcing/price data. The one exception is
 * the comparative-pricing read (mission brief §9/§12), which a future
 * Purchase Order actor must also be able to reach before any PO exists; see
 * `PURCHASE_ORDER_CREATE_PERMISSION` below.
 *
 * No standard-role seeding is performed by this file.
 */
export const PROCUREMENT_PERMISSIONS = {
  SUPPLIER_MANAGE: 'supplier.manage',
  /**
   * FULL-SRS-PRC-PURCHASE-ORDERS-P2 §1. Previously referenced only as the
   * `PURCHASE_ORDER_CREATE_PERMISSION` string literal by Supplier Foundation
   * P1 (deliberately unseeded there — "owned by the future Purchase Order
   * slice"). This slice IS that future slice: the code is now actually
   * seeded, claiming the ownership Supplier Foundation P1 reserved.
   */
  REQUISITION_CREATE: 'purchase.requisition.create',
  PURCHASE_ORDER_CREATE: 'purchase.order.create',
  /**
   * §7/§8 — FR-PRC-018 value-band approval tiers, taken verbatim from SRS
   * §15.2 ("Approve within a value band"). The ratified Governance Decision
   * Register (D-5, "Multi-Level Approval Chains", 2026-08-17) establishes
   * these three permissions as the SRS's own permission-based encoding of
   * FR-PRC-018's "Branch Manager / Operations Director / Tenant Owner" prose
   * bands — single-step approval, not a chain.
   */
  PURCHASE_ORDER_APPROVE_TIER_1: 'purchase.order.approve_tier_1',
  PURCHASE_ORDER_APPROVE_TIER_2: 'purchase.order.approve_tier_2',
  PURCHASE_ORDER_APPROVE_TIER_3: 'purchase.order.approve_tier_3',
} as const;

export const PROCUREMENT_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE,
    module: 'procurement',
    description:
      'Create, update, and manage suppliers, item sourcing links, and price lists',
  },
  {
    code: PROCUREMENT_PERMISSIONS.REQUISITION_CREATE,
    module: 'procurement',
    description: 'Create and submit purchase requisitions',
  },
  {
    code: PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE,
    module: 'procurement',
    description:
      'Create, update, and submit purchase orders; consolidate requisitions into a purchase order',
  },
  {
    code: PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_1,
    module: 'procurement',
    description:
      'Approve a purchase order within value band 1 (FR-PRC-018 "Branch Manager" tier)',
  },
  {
    code: PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_2,
    module: 'procurement',
    description:
      'Approve a purchase order within value band 2 (FR-PRC-018 "Operations Director" tier)',
  },
  {
    code: PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_3,
    module: 'procurement',
    description:
      'Approve a purchase order within value band 3 (FR-PRC-018 "Tenant Owner" tier)',
  },
];

/**
 * `purchase.order.create` — kept as a standalone literal too (byte-identical
 * to `PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE`) ONLY because Supplier
 * Foundation P1's `procurement.controller.ts` already imports this exact
 * named export for its `RequireAnyPermission(...)` read guards; removing it
 * would be an unrelated rename of already-shipped code. New code in this
 * slice uses `PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE` directly.
 */
export const PURCHASE_ORDER_CREATE_PERMISSION =
  PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE;

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
} as const;

export const PROCUREMENT_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE,
    module: 'procurement',
    description:
      'Create, update, and manage suppliers, item sourcing links, and price lists',
  },
];

/**
 * `purchase.order.create` — SRS §15.2 Procurement catalogue code, OWNED BY
 * THE FUTURE PURCHASE ORDER SLICE (mission brief §19 scope fence: no
 * Purchase Order in this slice). Referenced ONLY as a string literal in the
 * any-permission read guard on supplier-sourcing/comparative-pricing routes
 * (mission brief §12): a read route must already accept an actor who will
 * need this permission once Purchase Orders exist, without this module
 * minting, seeding, or claiming ownership of the code. Deliberately NOT
 * included in `PROCUREMENT_PERMISSION_DEFS` — no `Permission` row is seeded
 * for it here, so until the PO slice seeds it, only `supplier.manage`
 * holders actually satisfy these routes in practice.
 */
export const PURCHASE_ORDER_CREATE_PERMISSION = 'purchase.order.create';

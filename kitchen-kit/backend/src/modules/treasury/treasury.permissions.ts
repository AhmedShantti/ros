import { PermissionDef } from '../identity/authz/permissions.constants';

/**
 * Treasury permission codes — taken VERBATIM from the SRS §15.2 catalogue.
 *
 * `cash.session.open` is quoted there as "Open a shift", which is exactly the
 * FR-POS-090 operation: a cashier opening a shift and declaring an opening
 * float. No separate shift-opening permission is invented — the SRS already
 * treats the two as one authority.
 *
 * The catalogue's remaining cash codes — `cash.session.close`,
 * `cash.session.close_other`, `cash.drawer.open_no_sale`, `cash.payin`,
 * `cash.payout`, `cash.safedrop`, `cash.variance.approve`, `cash.day.close` —
 * are deliberately NOT seeded. This repository seeds a permission only where an
 * executable consumer exists; a code with no route behind it is appearance
 * without capability. Each is seeded by the slice that implements it.
 *
 * `pos.payment.capture` (carried item P1D-F) is authorised but likewise not
 * seeded here: no payment route exists.
 *
 * Authorization is TENANT-scoped. D-2's branch-scoped RBAC deferral stands — no
 * handler consults `TenantContext.branchId`. Branch safety on this route comes
 * from the terminal binding and the FR-SEC-021 permitted-branch set.
 */
export const TREASURY_PERMISSIONS = {
  CASH_SESSION_OPEN: 'cash.session.open',
} as const;

export const TREASURY_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: TREASURY_PERMISSIONS.CASH_SESSION_OPEN,
    module: 'cash',
    description: 'Open a shift',
  },
];

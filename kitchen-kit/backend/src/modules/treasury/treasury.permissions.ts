import { PermissionDef } from '../identity/authz/permissions.constants';

/**
 * Treasury permission codes — taken VERBATIM from the SRS §15.2 catalogue.
 *
 * `cash.session.open` is quoted there as "Open a shift", which is exactly the
 * FR-POS-090 operation: a cashier opening a shift and declaring an opening
 * float. No separate shift-opening permission is invented — the SRS already
 * treats the two as one authority.
 *
 * P1G-0 seeds `cash.payin` / `cash.payout` / `cash.safedrop` — FR-POS-091 —
 * now that an executable consumer (the three mid-shift movement routes)
 * exists for each. §15.2 quotes `cash.payin` / `cash.payout` together as
 * "Record cash in / out"; ONE code covers each verb, matching the catalogue.
 *
 * The catalogue's remaining cash codes — `cash.session.close`,
 * `cash.session.close_other`, `cash.drawer.open_no_sale`,
 * `cash.variance.approve`, `cash.day.close` — remain deliberately NOT
 * seeded: this repository seeds a permission only where an executable
 * consumer exists; a code with no route behind it is appearance without
 * capability. Each is seeded by the slice that implements it.
 *
 * `pos.payment.capture` (carried item P1D-F) is authorised but likewise not
 * seeded here: no payment route exists.
 *
 * Authorization is TENANT-scoped. D-2's branch-scoped RBAC deferral stands — no
 * handler consults `TenantContext.branchId`. Branch safety on these routes
 * comes from the terminal binding, the FR-SEC-021 permitted-branch set, and
 * (for the movement routes) the own-session-only rule (design gate §4): §15.2
 * supplies NO `_other` variant for any movement permission.
 */
export const TREASURY_PERMISSIONS = {
  CASH_SESSION_OPEN: 'cash.session.open',
  CASH_PAYIN: 'cash.payin',
  CASH_PAYOUT: 'cash.payout',
  CASH_SAFEDROP: 'cash.safedrop',
} as const;

export const TREASURY_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: TREASURY_PERMISSIONS.CASH_SESSION_OPEN,
    module: 'cash',
    description: 'Open a shift',
  },
  {
    code: TREASURY_PERMISSIONS.CASH_PAYIN,
    module: 'cash',
    description: 'Record cash in',
  },
  {
    code: TREASURY_PERMISSIONS.CASH_PAYOUT,
    module: 'cash',
    description: 'Record cash out',
  },
  {
    code: TREASURY_PERMISSIONS.CASH_SAFEDROP,
    module: 'cash',
    description: 'Perform a safe drop',
  },
];

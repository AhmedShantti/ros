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
 *
 * `SETTINGS_BRANCH_MANAGE` — P1G-1 migration 33 (cash-close policy write).
 * `'settings.branch.manage'` is quoted VERBATIM from §15.2 ("Branch
 * configuration"; ratification R-5) and is ALREADY SEEDED by Organisation
 * (`ORGANISATION_PERMISSION_DEFS`, ADR 0008 D-01) — it is declared here as a
 * plain local STRING LITERAL, not imported from
 * `organisation/organisation.permissions`, because that import would be a
 * NEW `treasury->organisation` private-path deviation
 * (`module-boundaries.spec.ts` has no such entry today). No duplicate
 * `PermissionDef` is added below: the permission row already exists, keyed
 * by `code`, and a second def would be a redundant upsert, not a second
 * permission.
 *
 * P1G-1 migration 34 (CashSession Close) seeds the SRS's remaining three
 * cash codes now that each has an executable consumer for the first time:
 * `cash.session.close` ("Close own shift" — the declaration/finalize routes
 * when the actor IS the session owner), `cash.session.close_other` ("Close
 * another user's shift" — the same routes when the actor is NOT the owner),
 * and `cash.variance.approve` (FR-FIN-006 [M] verbatim — checked by the
 * Approval Runtime itself, against the PIN-verified manager's resolved
 * permission set, never by a route-level `@RequirePermission`, since the
 * approver is a different actor than the caller). `cash.drawer.open_no_sale`
 * and `cash.day.close` remain deliberately NOT seeded — still no executable
 * consumer for either.
 */
export const TREASURY_PERMISSIONS = {
  CASH_SESSION_OPEN: 'cash.session.open',
  CASH_PAYIN: 'cash.payin',
  CASH_PAYOUT: 'cash.payout',
  CASH_SAFEDROP: 'cash.safedrop',
  /** Existing SRS §15.2 code; owned/seeded by Organisation. See docblock. */
  SETTINGS_BRANCH_MANAGE: 'settings.branch.manage',
  /** P1G-1 migration 34. "Close own shift". */
  CASH_SESSION_CLOSE: 'cash.session.close',
  /** P1G-1 migration 34. "Close another user's shift". */
  CASH_SESSION_CLOSE_OTHER: 'cash.session.close_other',
  /** P1G-1 migration 34. FR-FIN-006 [M] verbatim — the manager's approval
   *  authority, checked by the Approval Runtime, never by a route guard. */
  CASH_VARIANCE_APPROVE: 'cash.variance.approve',
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
  {
    code: TREASURY_PERMISSIONS.CASH_SESSION_CLOSE,
    module: 'cash',
    description: 'Close own shift',
  },
  {
    code: TREASURY_PERMISSIONS.CASH_SESSION_CLOSE_OTHER,
    module: 'cash',
    description: "Close another user's shift",
  },
  {
    code: TREASURY_PERMISSIONS.CASH_VARIANCE_APPROVE,
    module: 'cash',
    description: 'Approve a variance beyond tolerance',
  },
];

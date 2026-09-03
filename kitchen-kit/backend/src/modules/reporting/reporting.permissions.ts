import type { PermissionDef } from '../identity/contract';

/**
 * RPT-R1 (ratified 2026-08-31, `docs/governance/GOVERNANCE_DECISION_REGISTER.md`
 * "Minimum Operational Reporting Ratification — 2026-08-31").
 *
 * Exactly two codes, instantiating SRS §15.2's `report.view.<category>`
 * template with the §19.3 category names this route's response actually
 * spans: *Sales Summary* / *Sales by Tender* are Sales reports; *Cash
 * Reconciliation* / *Tax Summary* are Financial reports. Appendix C (§15.2's
 * designated authority for the full catalogue) is absent from the delivered
 * SRS, so these are the FOURTH/FIFTH explicit user-authorized exceptions to
 * the zero-invented-codes discipline (after `pos.order.fire`,
 * `pos.payment.capture`, `kds.operate`).
 *
 * BOTH are required together (AND, `mode: 'all'` — the `@RequirePermission`
 * default) on the single composite daily-trading route. They carry NO
 * branch scope and must never be relied on for it — branch safety is the
 * separately enforced fail-closed assertion (`BRANCH_REPORTING_SCOPE_QUERY`),
 * exactly as KDS-R11 separates `kds.operate` from station scope.
 *
 * MUST NOT be broadened, split, or accompanied by `report.export` or any
 * other `report.view.*` code (RPT-R1 clauses 5/NOT-authorized list). No
 * standard-role seeding is performed by this file.
 *
 * AUD-R1 (2026-09-03) narrowly reopened RPT-R1 clause 6 to authorize
 * `report.export` — but ONLY for `GET /governance/audit/entries/export`
 * (`governance/audit/audit.permissions.ts`), a route in a DIFFERENT module.
 * That amendment does not touch this file, does not add `report.export` to
 * the reporting module's own route, and this prohibition remains in force
 * for every route this module owns.
 */
export const REPORTING_PERMISSIONS = {
  VIEW_SALES: 'report.view.sales',
  VIEW_FINANCIAL: 'report.view.financial',
} as const;

export const REPORTING_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: REPORTING_PERMISSIONS.VIEW_SALES,
    module: 'reporting',
    description: 'View sales reports',
  },
  {
    code: REPORTING_PERMISSIONS.VIEW_FINANCIAL,
    module: 'reporting',
    description: 'View financial reports',
  },
];

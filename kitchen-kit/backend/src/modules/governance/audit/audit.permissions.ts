import type { PermissionDef } from '../../identity/contract';

/**
 * AUD-R1 (RATIFIED 2026-09-03, `docs/governance/GOVERNANCE_DECISION_REGISTER.md`
 * "AUD-R1 — Audit Log Query/Export Permissions & Surface").
 *
 * Both codes are drawn VERBATIM from `FR-AUD-008` [M]: *"...and SHALL be
 * exportable by users with audit.view plus report.export."* No other code is
 * invented; §15.2's `module.action` dot-notation is followed.
 *
 * `audit.view` alone gates `GET /governance/audit/entries` (search/filter).
 * BOTH codes together (AND) gate `GET /governance/audit/entries/export`.
 *
 * `report.export` is a NARROW, EXPLICIT exception to RPT-R1 clause 6, which
 * lists `report.export` among codes "NOT authorized and MUST NOT be
 * created" — a prohibition scoped to the sole route RPT-R1 governs
 * (`GET /reports/branches/{branchId}/daily-trading/{businessDay}`), because no
 * route existed at the time that needed it. AUD-R1 authorizes `report.export`
 * for EXACTLY the audit-export route above and NO other; RPT-R1's prohibition
 * remains in force for the reporting module's own route and for every
 * `report.view.*` code. See AUD-R1 clause 3 for the full reasoning — this file
 * intentionally does NOT modify `reporting/reporting.permissions.ts`, whose
 * own RPT-R1 file comment remains accurate for the reporting module's route.
 */
export const AUDIT_PERMISSIONS = {
  VIEW: 'audit.view',
  EXPORT: 'report.export',
} as const;

export const AUDIT_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: AUDIT_PERMISSIONS.VIEW,
    module: 'governance',
    description: 'Search and view audit log entries for the tenant',
  },
  {
    code: AUDIT_PERMISSIONS.EXPORT,
    module: 'governance',
    description:
      'Export audit log entries the caller is otherwise authorized to view (AUD-R1 — audit-export route only)',
  },
];

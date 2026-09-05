import { PermissionDef } from '../identity/authz/permissions.constants';

/**
 * Workforce permission codes — taken VERBATIM from the SRS §15.2 "Workforce"
 * catalogue: `hr.employee.view / .manage`, `hr.compensation.view`,
 * `hr.schedule.manage`, `hr.attendance.correct`. No sixth code is invented.
 *
 * `hr.overtime.approve` and `hr.payroll.export` exist in the catalogue and
 * are deliberately NOT seeded: no overtime-approval or payroll-export route
 * exists in this slice (see the HR-1 report — FR-HRM-033/034 are blocked by
 * the absent Country Pack labour section, and FR-HRM-035/036 are out of
 * scope for this slice). Seeding an unused code would be appearance without
 * capability — the exact `pos.payment.capture` / P1D-F discipline this
 * repository already applies everywhere else.
 *
 * `HR_EMPLOYEE_VIEW` also gates schedule/attendance READS: §15.2 gives no
 * separate `hr.schedule.view` / `hr.attendance.view` code, and the catalogue
 * entry is "Employee records" broadly — the same "no read verb, so the
 * nearest read-shaped permission covers it" discipline `SALES_PERMISSIONS`
 * documents for `pos.order.create`.
 *
 * Authorization is TENANT+BRANCH scoped via B1-3 `@AuthorizationTarget`
 * (`contract/authorization-target.ts`) — every route below declares one.
 * Clock-in/out carry NO permission at all (see `attendance.controller.ts`):
 * the caller acts on their OWN employment record via a PIN-verified POS
 * session, exactly like `POST /cash-sessions` needs no permission to name
 * the acting employee.
 */
export const WORKFORCE_PERMISSIONS = {
  EMPLOYEE_VIEW: 'hr.employee.view',
  EMPLOYEE_MANAGE: 'hr.employee.manage',
  COMPENSATION_VIEW: 'hr.compensation.view',
  SCHEDULE_MANAGE: 'hr.schedule.manage',
  ATTENDANCE_CORRECT: 'hr.attendance.correct',
} as const;

export const WORKFORCE_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: WORKFORCE_PERMISSIONS.EMPLOYEE_VIEW,
    module: 'workforce',
    description: 'View employee records',
  },
  {
    code: WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE,
    module: 'workforce',
    description: 'Create, update, and deactivate employee records',
  },
  {
    code: WORKFORCE_PERMISSIONS.COMPENSATION_VIEW,
    module: 'workforce',
    description: 'View employee compensation (pay rates)',
  },
  {
    code: WORKFORCE_PERMISSIONS.SCHEDULE_MANAGE,
    module: 'workforce',
    description: 'Build and read shift schedules',
  },
  {
    code: WORKFORCE_PERMISSIONS.ATTENDANCE_CORRECT,
    module: 'workforce',
    description: 'Manually correct clock-in/clock-out records',
  },
];

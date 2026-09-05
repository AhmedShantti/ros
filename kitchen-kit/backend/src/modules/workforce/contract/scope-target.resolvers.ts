/**
 * Workforce PUBLIC contract — B1-3 resource-derived authorization targets.
 *
 * An Employee, a Schedule, and an AttendanceRecord are each addressed by
 * their own id on their respective routes; the branch each belongs to
 * appears nowhere else in the path. Each carries a real `branch_id` (a
 * Schedule directly, an Employee via `home_branch_id`, an AttendanceRecord
 * directly) with a tenant-safe composite FK, so the owning branch is read
 * from the row rather than accepted from the caller. Mirrors
 * `treasury/contract/scope-target.resolvers.ts`'s
 * `TREASURY_CASH_SESSION_TARGET_RESOLVER` exactly.
 */
export const WORKFORCE_EMPLOYEE_TARGET_RESOLVER = Symbol(
  'WORKFORCE_EMPLOYEE_TARGET_RESOLVER',
);
export const WORKFORCE_SCHEDULE_TARGET_RESOLVER = Symbol(
  'WORKFORCE_SCHEDULE_TARGET_RESOLVER',
);
export const WORKFORCE_ATTENDANCE_RECORD_TARGET_RESOLVER = Symbol(
  'WORKFORCE_ATTENDANCE_RECORD_TARGET_RESOLVER',
);

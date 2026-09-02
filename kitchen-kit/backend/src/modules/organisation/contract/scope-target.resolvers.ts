/**
 * Organisation PUBLIC contract — B1-3 resource-derived authorization targets.
 *
 * `@AuthorizationTarget(resourceTarget(TOKEN, …))` names one of these tokens on
 * a route whose branch is NOT in the path. `PermissionGuard` obtains the bound
 * `ScopeTargetResolver` by token, so a route never reaches into Organisation's
 * private directories and `module-boundaries.spec.ts`'s `KNOWN_DEVIATIONS` does
 * not grow.
 *
 * ── WHY THESE EXIST AT ALL ──────────────────────────────────────────────────
 * Stations and tables are BRANCH-OWNED rows that carry no `tenant_id` of their
 * own — their tenant boundary IS the parent branch (ADR 0008). Addressing one
 * by its own id (`PATCH /org/stations/:stationId`) therefore says nothing about
 * which branch is being modified until the row is read. Believing a caller's
 * claim about that would be exactly the "body-supplied target" defect the
 * scoped model exists to prevent, so the branch is taken from the row itself.
 */

/** `org.stations.branch_id` for a station addressed by its own id. */
export const ORG_STATION_TARGET_RESOLVER = Symbol(
  'ORG_STATION_TARGET_RESOLVER',
);

/** `org.branch_tables.branch_id` for a table addressed by its own id. */
export const ORG_TABLE_TARGET_RESOLVER = Symbol('ORG_TABLE_TARGET_RESOLVER');

/**
 * `org.warehouses` — a warehouse is a BRANCH target when it belongs to a
 * branch, and a TENANT target when it is standalone (`branch_id IS NULL`).
 *
 * ADR 0009 D-02 refused `WAREHOUSE` as a SCOPE TYPE precisely because
 * `org.warehouses.branch_id` is nullable, so a warehouse scope would be
 * undefined for tenant-level warehouses. That is a statement about what an
 * ASSIGNMENT may hold; it does not stop a warehouse-owned RESOURCE from having
 * a real owning branch when it has one. Deriving the target this way adds no
 * scope type and invents nothing.
 */
export const ORG_WAREHOUSE_TARGET_RESOLVER = Symbol(
  'ORG_WAREHOUSE_TARGET_RESOLVER',
);

/**
 * `org.locations` — the inventory location registry. A location is exactly one
 * of a branch, a warehouse, or a central kitchen (`ck_location_target`), so its
 * target is BRANCH for a branch location, BRANCH for a branch-owned warehouse,
 * and TENANT for a standalone warehouse or a central kitchen (which is
 * tenant-level by construction — ADR 0009 D-02).
 */
export const ORG_LOCATION_TARGET_RESOLVER = Symbol(
  'ORG_LOCATION_TARGET_RESOLVER',
);

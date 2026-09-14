/**
 * Organisation PUBLIC contract barrel — SRS §5.4.
 *
 * `routing-config.query.ts` is the FR-KDS-010 tiers 2–5 configuration query
 * (ADR 0008 D-07/D-06 — Station/routing-config ownership). `table-display.query.ts`
 * (P1E-6) is the FR-KDS-020 dine-in Table display fact. `branch-currency.query.ts`
 * (P1G-1 acceptance closure) is a branch's authoritative base currency
 * (SRS §7.3 #5). Other modules (Kitchen, Sales, Treasury) MUST import only
 * this barrel, never a private Organisation path such as
 * `station-routing/station-routing.service`, `stations/stations.service`,
 * `tables/tables.service`, or `branches/branches.service` — see
 * `module-boundaries.spec.ts`.
 */
export * from './routing-config.query';
export * from './table-display.query';
export * from './branch-currency.query';
export * from './branch-jurisdiction.query';
export * from './station-display-binding.query';
export * from './kds-branch-config.query';
/**
 * KDS-STATION-DISCOVERY-AUTH-FIX-P0 — the minimal branch-scoped station
 * picker read a KDS session needs; never `StationSummary`'s management
 * fields, never `stations/stations.service`.
 */
export * from './station-list.query';
export * from './branch-reporting-scope.query';
export * from './branch-brand.query';
export * from './branch-locations.query';
/**
 * FULL-SRS-PRC-PURCHASE-ORDERS-P2 §5 — `org.locations` existence/kind facts
 * for an arbitrary location id (Purchase Order delivery-location validation).
 */
export * from './location-facts.query';
export * from './scope-target.resolvers';
/**
 * SIGNUP-1 — thin re-export of the existing Organisation permission catalog,
 * mirroring Kitchen's `KDS_PERMISSIONS` re-export pattern. Consumed by
 * Identity's production-safe permission-catalog aggregator.
 */
export {
  ORGANISATION_PERMISSIONS,
  ORGANISATION_PERMISSION_DEFS,
} from '../organisation.permissions';

/**
 * Organisation PUBLIC contract barrel — SRS §5.4.
 *
 * `routing-config.query.ts` is the FR-KDS-010 tiers 2–5 configuration query
 * (ADR 0008 D-07/D-06 — Station/routing-config ownership). `table-display.query.ts`
 * (P1E-6) is the FR-KDS-020 dine-in Table display fact. Other modules
 * (Kitchen, Sales) MUST import only this barrel, never a private
 * Organisation path such as `station-routing/station-routing.service`,
 * `stations/stations.service`, or `tables/tables.service` — see
 * `module-boundaries.spec.ts`.
 */
export * from './routing-config.query';
export * from './table-display.query';

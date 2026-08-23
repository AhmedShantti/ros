/**
 * Organisation PUBLIC contract barrel — SRS §5.4.
 *
 * `routing-config.query.ts` is the FR-KDS-010 tiers 2–5 configuration query
 * (ADR 0008 D-07/D-06 — Station/routing-config ownership). Other modules
 * (Kitchen) MUST import only this barrel, never a private Organisation path
 * such as `station-routing/station-routing.service` or
 * `stations/stations.service` — see `module-boundaries.spec.ts`.
 */
export * from './routing-config.query';

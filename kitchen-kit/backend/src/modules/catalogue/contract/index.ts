/**
 * Catalogue PUBLIC contract barrel — SRS §5.4.
 *
 * `fire-facts.query.ts` is the Fire-time Catalogue query Sales needs
 * (categoryIds for FR-KDS-010 tier 4 routing selectors, and the Kitchen/KDS
 * display name if one is configured). Other modules MUST import only this
 * barrel, never a private Catalogue path such as
 * `menu-items/menu-items.service` or `fire-facts/catalogue-fire-facts.query.service`
 * — see `module-boundaries.spec.ts`.
 */
export * from './fire-facts.query';
export * from './scope-target.resolvers';
/**
 * SIGNUP-1 — thin re-export of the existing Catalogue permission catalog,
 * mirroring Kitchen's `KDS_PERMISSIONS` re-export pattern. Consumed by
 * Identity's production-safe permission-catalog aggregator.
 */
export { CATALOGUE_PERMISSIONS, CATALOGUE_PERMISSION_DEFS } from '../catalogue.permissions';

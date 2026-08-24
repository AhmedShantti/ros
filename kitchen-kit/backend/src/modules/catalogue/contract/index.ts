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

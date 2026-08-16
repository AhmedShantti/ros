import { PermissionDef } from '../identity/authz/permissions.constants';

/**
 * Catalogue permission codes (Phase 16 design gate, C-05).
 *
 * THREE are authoritative — they appear verbatim in SRS §15.2 under
 * "Catalogue & Recipes": `menu.item.manage`, `menu.price.change`,
 * `menu.availability.toggle`.
 *
 * THREE are ratified read companions (`*.read`). The SRS catalogue is
 * "representative rather than exhaustive; the full catalogue is maintained in
 * Appendix C", and Appendix C is NOT in the supplied SRS. Without a read code
 * the §15.3 Auditor role ("read-only everything") is unexpressible — the same
 * problem ADR 0008 D-01 resolved for Organisation. These three are PROVISIONAL:
 * if Appendix C names them differently, remap per D-01.
 *
 * No permission was invented for categories, modifiers, combos or menus as
 * separate resources.
 */
export const CATALOGUE_PERMISSIONS = {
  /** Read MenuItem / Variant / Category / Menu information. */
  ITEM_READ: 'menu.item.read',
  /** Create/edit MenuItem and its Catalogue-owned structure. */
  ITEM_MANAGE: 'menu.item.manage',
  /** Read price lists, entries and price history. */
  PRICE_READ: 'menu.price.read',
  /** Create/change/schedule prices. */
  PRICE_CHANGE: 'menu.price.change',
  /** Read availability state/configuration. */
  AVAILABILITY_READ: 'menu.availability.read',
  /** Perform authorised 86/availability operations. */
  AVAILABILITY_TOGGLE: 'menu.availability.toggle',
} as const;

export const CATALOGUE_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: CATALOGUE_PERMISSIONS.ITEM_READ,
    module: 'menu',
    description: 'Read menu items, variants, categories and menus',
  },
  {
    code: CATALOGUE_PERMISSIONS.ITEM_MANAGE,
    module: 'menu',
    description: 'Create and edit menu items',
  },
  {
    code: CATALOGUE_PERMISSIONS.PRICE_READ,
    module: 'menu',
    description: 'Read price lists, price entries and price history',
  },
  {
    code: CATALOGUE_PERMISSIONS.PRICE_CHANGE,
    module: 'menu',
    description: 'Change prices',
  },
  {
    code: CATALOGUE_PERMISSIONS.AVAILABILITY_READ,
    module: 'menu',
    description: 'Read availability configuration and state',
  },
  {
    code: CATALOGUE_PERMISSIONS.AVAILABILITY_TOGGLE,
    module: 'menu',
    description: '86 items (toggle availability)',
  },
];

/**
 * Country Pack settings-key vocabulary — Localisation-owned, per P2A-R1
 * clause 2: "the CLOSED SET of keys Country Pack may ever contribute, and
 * the per-pack 'does this pack actually define this key' check, remain
 * entirely Localisation-owned."
 *
 * ONE canonical list, consumed by:
 *   - `country-pack-setting-fact.query.service.ts` (the published fact — what
 *     value/lock a currently-effective pack contributes for a key)
 *   - `country-pack.parser.ts` (FR-LOC-023-adjacent validation — a pack's
 *     `settingsLocks` entries must each name a key in this closed set, and one
 *     this specific pack actually contributes)
 *
 * No import from `platform-settings` — this file only knows what Country
 * Pack itself can express, never platform-settings' generic hierarchy.
 */

import type { CountryPack } from './country-pack.model';

/**
 * The one Country-Pack-backed setting key this slice honestly supports: the
 * pack's cash-rounding/tax-rounding facts (BR-FIN-002/FR-FIN-035, §22.2's
 * `currency.cashRounding` and `tax.roundingMode`/`roundingPrecision` blocks —
 * the same facts `PINNED_PAYMENT_POLICY_QUERY` exposes for a PINNED
 * historical pack version, here exposed for the CURRENTLY effective one,
 * which a live settings resolve/inspect/lock needs instead).
 *
 * Adding a second key means adding a second case to `countryPackContributes`
 * below and one more entry here — never widening this into a passthrough of
 * the whole `CountryPack` object (Localisation's tax-engine internals stay
 * private).
 */
export const COUNTRY_PACK_SETTING_KEYS = Object.freeze([
  'payments.cash_rounding_policy',
] as const);

export type CountryPackSettingKey = (typeof COUNTRY_PACK_SETTING_KEYS)[number];

export function isCountryPackSettingKey(
  key: string,
): key is CountryPackSettingKey {
  return (COUNTRY_PACK_SETTING_KEYS as readonly string[]).includes(key);
}

/**
 * Does THIS parsed pack actually authoritatively contribute a value for
 * `key`? The predicate a pack's `settingsLocks` declaration is checked
 * against: a pack may lock only a key it itself defines.
 *
 * Every key currently in `COUNTRY_PACK_SETTING_KEYS` is defined by every
 * structurally valid pack — `currency.cashRounding` and
 * `tax.roundingMode`/`roundingPrecision` are mandatory fields the parser
 * already requires (`parseCurrency`/`parseTax`), so `payments.cash_rounding_
 * policy` is unconditionally `true` here today. A future OPTIONAL facet
 * (e.g. a key only some packs configure) would return `false` for a pack
 * that omits it, exactly as this predicate's contract requires — this is not
 * currently reachable and no such facet is invented by this slice.
 */
export function countryPackContributes(
  pack: Pick<CountryPack, 'currency' | 'tax'>,
  key: CountryPackSettingKey,
): boolean {
  switch (key) {
    case 'payments.cash_rounding_policy':
      return pack.currency !== undefined && pack.tax !== undefined;
  }
}

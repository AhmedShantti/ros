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

/**
 * P2C1-R1 — the CLOSED, EXPLICIT subset of `COUNTRY_PACK_SETTING_KEYS`
 * that is PROVIDER-EXCLUSIVE: no `platform`/`tenant`/`brand`/`branch`/
 * `terminal` generic-settings override may ever be treated as effective
 * for one of these keys, regardless of whether the active pack declares
 * it in `settingsLocks`. This is a STATIC, structural fact about the key
 * itself, grounded in that key's own governing SRS text — NOT a blanket
 * "every Country-Pack-contributed key is automatically provider-
 * exclusive" rule. Each entry below is an individual, evidenced
 * Localisation judgment; a future key added to `COUNTRY_PACK_SETTING_KEYS`
 * does NOT automatically join this set (P2C1-R1 clause 4) — it requires
 * its own authority decision.
 *
 * `payments.cash_rounding_policy`: `FR-POS-063` [M] ("apply THE COUNTRY
 * PACK'S cash rounding rule" — sole authority, no tenant/brand/branch
 * override contemplated), `FR-FIN-035` [M] ("specified by the country
 * pack ... applied CONSISTENTLY across POS, server, receipt, and fiscal
 * submission"), `BR-FIN-004` (a jurisdiction fact — "where the
 * jurisdiction has withdrawn small denominations"), `FR-LOC-020` [M]
 * ("ALL jurisdiction-specific behaviour SHALL be driven by the country
 * pack. No country-specific logic SHALL be compiled into core application
 * code" — unconditional, no stated exception for a business override).
 * Ratified: `docs/governance/GOVERNANCE_DECISION_REGISTER.md` `P2C1-R1`.
 */
const PROVIDER_EXCLUSIVE_SETTING_KEYS: ReadonlySet<string> = new Set([
  'payments.cash_rounding_policy',
] satisfies readonly CountryPackSettingKey[]);

/**
 * Distinct from `countryPackContributes` (whether a specific pack DEFINES
 * a value for `key`) and from a pack's own `settingsLocks` (whether THIS
 * pack chose to lock it). This answers a third, independent question:
 * whether `key` may EVER be configured below `country_pack` at all, for
 * ANY pack, ANY tenant. See `COUNTRY_PACK_SETTING_FACT_QUERY.isProviderExclusive`
 * for the full contract this implements.
 */
export function isProviderExclusiveSettingKey(key: string): boolean {
  return PROVIDER_EXCLUSIVE_SETTING_KEYS.has(key);
}

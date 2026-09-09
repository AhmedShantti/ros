/**
 * Localisation PUBLIC contract — the Country-Pack tier of the FR-PLT-025
 * hierarchical settings resolver (`platform-settings` module).
 *
 * SRS §6.4's cascade names "Country Pack" as the second-highest level. This
 * repository has no generic representation of an arbitrary settings key
 * inside a Country Pack — `CountryPack` carries a fixed, typed shape (tax
 * classes/components, currency, cash-rounding), not a key/value store. Per
 * the FR-PLT-025 slice's own instruction, the resolver's Country Pack tier
 * must "support actual keys that legitimately exist today" and "report
 * unsupported generic Country Pack keys honestly" rather than fabricate a
 * value — so this contract answers a small, explicit allow-list of setting
 * keys (see `COUNTRY_PACK_SETTING_KEYS` in the implementation) and returns
 * `null` (no Country-Pack contribution) for every other key, exactly as it
 * would for a key this pack genuinely does not configure.
 *
 * `null` is used for BOTH "this key has no Country Pack representation" and
 * "no pack is currently effective for this code" — the settings resolver
 * only needs to know whether the Country Pack tier contributes a value, not
 * why it does not; see `SettingsResolverService` for how the two are still
 * distinguished for the settings INSPECTOR (FR-PLT-027), which surfaces a
 * `notEligible` reason rather than the same silent fall-through the plain
 * effective-value resolve path uses.
 *
 * Synchronous, matching `PINNED_PAYMENT_POLICY_QUERY` — `CountryPackRegistry`
 * is an in-memory registry (the signed pack document lives in process
 * memory once activated), so there is no I/O to await.
 *
 * ── `countryPackCode` IS A CALLER-RESOLVED JURISDICTION CODE ────────────────
 * This contract stays a pure, tx-free "given a jurisdiction code, what does
 * the pack say" oracle — it never resolves WHICH jurisdiction applies
 * itself, and never gains a dependency on Organisation to do so. The CALLER
 * (`platform-settings`' `SettingsResolverService`, which already legitimately
 * depends on both Organisation and Localisation through their own published
 * contracts) decides which code to pass: `org.branches.country_code`
 * (Organisation's `BRANCH_JURISDICTION_QUERY`) when a branch/terminal is in
 * scope — matching `CountryPackService.resolveForBranch`'s own FR-BRN-003
 * reasoning that "two branches of ONE tenant must resolve to DIFFERENT
 * packs" — or `Tenant.countryPackCode` ONLY as the honest fallback for a
 * genuinely tenant/brand-only request, where no branch exists to derive a
 * jurisdiction from at all. This is dependency inversion, not a limitation
 * of this contract: reaching Organisation FROM HERE would close a
 * Localisation→Organisation→Identity→Localisation cycle (Identity already
 * imports Localisation, Organisation already imports Identity); resolving
 * the code in the caller and passing it in as an opaque value avoids that
 * entirely. See `docs/reports/claude/
 * 2026-09-09_FULL-SRS-PLT-SETTINGS-DESIGN-CORRECTION-GATE-P1B.md` §1 and
 * `docs/reports/claude/2026-09-09_FULL-SRS-PLT-SETTINGS-CORRECTION-P1C.md`
 * BRANCH_COUNTRY_RESOLUTION_PATH.
 */
export const COUNTRY_PACK_SETTING_FACT_QUERY = Symbol(
  'COUNTRY_PACK_SETTING_FACT_QUERY',
);

export interface CountryPackSettingFactInput {
  /**
   * The caller-resolved jurisdiction/pack code (e.g. `"EG"`) — NOT
   * necessarily `Tenant.countryPackCode`. The caller is responsible for
   * resolving the right code for its request (branch-accurate when a
   * branch is in scope, tenant-default otherwise); see this file's own
   * docblock above.
   */
  readonly countryPackCode: string;
  readonly settingKey: string;
  readonly at: Date;
}

export interface CountryPackSettingFactQuery {
  /**
   * The Country-Pack-sourced contribution for one generic settings-hierarchy
   * key.
   *
   * Returns `undefined` when `settingKey` has no Country Pack representation
   * at all (an honest "not applicable", never fabricated). Returns `null`
   * when the key IS a supported Country Pack key but no pack is currently
   * activated/effective for `countryPackCode` at `at` (an honest "eligible,
   * but unconfigured right now" — the resolver treats this exactly like an
   * absent row at any other level). Otherwise returns the JSON-serializable
   * value.
   */
  getSettingFact(input: CountryPackSettingFactInput): unknown;

  /**
   * The fixed allow-list of settingKeys this query can ever answer for —
   * published so the settings INSPECTOR (FR-PLT-027) can state plainly
   * whether a key is eligible at the Country Pack level at all, without
   * probing with a throwaway call.
   */
  supportedSettingKeys(): readonly string[];
}

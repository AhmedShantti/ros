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
 * ── KNOWN LIMITATION: TENANT-WIDE, NOT PER-BRANCH ───────────────────────────
 * `CountryPackService`'s own docblock states plainly that
 * `identity.tenants.country_pack_code` is "deliberately NOT used" for real
 * pricing decisions, because FR-BRN-003 requires two branches of ONE tenant
 * to be able to resolve to DIFFERENT packs (`org.branches.country_code` is
 * the correct per-branch source `CountryPackService.resolveForBranch` uses).
 * This contract nonetheless takes `countryPackCode` (the TENANT default),
 * not a branch id, because: (1) the generic settings resolver can be asked
 * at tenant/brand-only granularity, where no branch exists to derive a
 * jurisdiction from at all; (2) reaching Organisation's per-branch
 * `org.branches.country_code` from here would require Localisation to
 * import Organisation, which — given Identity already imports Localisation
 * and Organisation already imports Identity — would close a THREE-MODULE
 * import cycle this slice is not the place to open. This is a deliberate,
 * documented simplification, not a silent bug: the resolver never claims a
 * branch-accurate answer, only the tenant's own configured default. Proper
 * per-branch, effective-dated Country-Pack integration belongs to
 * `FR-PLT-028` (explicitly out of scope this slice) — see
 * `docs/reports/claude/2026-09-09_FULL-SRS-PLT-SETTINGS-RESOLVER-P1.md` §8.
 */
export const COUNTRY_PACK_SETTING_FACT_QUERY = Symbol(
  'COUNTRY_PACK_SETTING_FACT_QUERY',
);

export interface CountryPackSettingFactInput {
  /**
   * `Tenant.countryPackCode` (`fiscal.country_packs.code`) — the TENANT
   * default, not a branch-resolved jurisdiction. See this file's own
   * "KNOWN LIMITATION" note above.
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

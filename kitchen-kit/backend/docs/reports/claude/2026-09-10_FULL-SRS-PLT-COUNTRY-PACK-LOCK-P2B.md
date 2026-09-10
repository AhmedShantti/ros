# FULL-SRS-PLT-COUNTRY-PACK-LOCK-P2B — Backend Implementation, Closes FR-PLT-026

**Report type:** Implementation / verification report.
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions (`docs/governance/GOVERNANCE_DECISION_REGISTER.md`,
entry `P2A-R1`) remain authoritative. Nothing in this file overrides either.
**Date:** 2026-09-10
**Task identifier:** `FULL-SRS-PLT-COUNTRY-PACK-LOCK-P2B`
**HEAD at start:** `7c604d66a01793c7a36f6fcfacf4675f3843f6d2`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree at start:** clean except pre-existing untracked reports from
other, unrelated work sessions (three `2026-09-10_FULL-SRS-PLT-FINANCIAL-
SETTINGS-GOVERNANCE-*` design-gate reports, a `2026-09-08` and two
`2026-09-09` reports, none touched or committed by this task).

## 0. Baseline verification

`git rev-parse HEAD` = `7c604d66a01793c7a36f6fcfacf4675f3843f6d2`.

```
7c604d6 docs(governance): ratify P2A-R1 financial-settings decision (Country Pack lock + FR-PLT-028 storage)
3402c37 docs(reports): record commit hash in FULL-SRS-PLT-SETTINGS-CORRECTION-P1C report
656c354 fix(platform-settings): branch-accurate Country Pack resolution, remove avoidable KNOWN_DEVIATIONS
8971af7 docs(reports): record backend commit hash in FULL-SRS-PLT-SETTINGS-RESOLVER-P1 report and index
6f12c62 feat(platform-settings): FR-PLT-025/026/027 hierarchical settings resolver
```

`docs/governance/GOVERNANCE_DECISION_REGISTER.md` §`P2A-R1` confirmed present
and RATIFIED ("RECORDED 2026-09-10 by explicit user governance action"),
with clause 1 (optional signed `CountryPack.settingsLocks`, absent = `[]`,
lock only a key the pack authoritatively contributes) and clause 2 (setting-
key syntax in `src/common/settings-key.ts`, Country-Pack closed vocabulary +
per-pack contribution check Localisation-owned, no new `Localisation ->
PlatformSettings` edge) the two clauses this slice implements. P2A3 named as
controlling design text.

Pre-change inspection confirmed the known gap exactly as stated in the task:
`settings-resolver.service.ts`'s `fetchCountryPackEntry` hardcoded
`locked: false` for the Country-Pack tier with an explicit "KNOWN,
GOVERNANCE-BLOCKED GAP" comment, because `CountryPack` (`country-pack.model.ts`)
had no field to express a lock and the parser performed no such validation.

## 1. Shared setting-key syntax primitive

Created `src/common/settings-key.ts` — `SETTING_KEY_PATTERN`,
`SETTING_KEY_MAX_LENGTH` (120), `isValidSettingKeySyntax(key): boolean`.
Framework-free: no NestJS import, no HTTP exception, no domain logic. Lives
outside `src/modules/`, so it is structurally outside
`module-boundaries.spec.ts`'s tracked module graph (verified: `resolveTarget`
in that suite only tracks paths under `MODULES_ROOT` = `src/modules`).

`platform-settings/settings-key.util.ts`'s `assertValidSettingKey` now
delegates the syntax check to `isValidSettingKeySyntax`; its external
behaviour and exception shape (`BadRequestException`, same message text
modulo the length constant) are unchanged. Existing Platform Settings
semantics (max length 120, pattern) are identical, byte-for-byte the same
regex.

## 2. Localisation-owned Country Pack key vocabulary

Created `src/modules/localisation/country-pack/country-pack.setting-keys.ts`,
owning:

- `COUNTRY_PACK_SETTING_KEYS` — the same one-entry closed set
  (`payments.cash_rounding_policy`), moved here from
  `country-pack-setting-fact.query.service.ts` (which now imports it, rather
  than defining its own copy).
- `isCountryPackSettingKey(key): key is CountryPackSettingKey`.
- `countryPackContributes(pack, key): boolean` — the Localisation-owned "does
  THIS parsed pack actually contribute this key" predicate. Every
  structurally valid pack unconditionally contributes the sole supported key
  today (`currency.cashRounding`/`tax.roundingMode`/`roundingPrecision` are
  parser-mandatory fields), documented explicitly in the function's own
  docblock as the honest current answer, not a fabricated future one.

No import from `platform-settings` anywhere in this file or its consumers.
Both `country-pack-setting-fact.query.service.ts` (the published fact) and
`country-pack.parser.ts` (`settingsLocks` validation) now consume this one
canonical list — no duplicate copy exists anywhere in the tree (grep-verified:
`payments.cash_rounding_policy` appears as a defining literal only in
`country-pack.setting-keys.ts`).

## 3. Country Pack signed model — `settingsLocks`

`country-pack.model.ts`'s `CountryPack` interface gained:

```ts
readonly settingsLocks: readonly string[];
```

Documented as OPTIONAL in the signed *input* document; the parser normalises
absence to `[]` — the internal model always carries a concrete (possibly
empty) array, never `undefined`. No jurisdiction-specific logic, no
hardcoded `EG`, anywhere in the field or its validation.

## 4. Parser validation

`country-pack.parser.ts` gained `parseSettingsLocks(raw, path, pack)`, called
after `currency`/`tax` are parsed (needed for the contribution check) and
wired into `parseCountryPack`'s return value. Validates, in order, for every
declared entry:

1. Array type (`asArray`) — a non-array `settingsLocks` fails with the
   `countryPack.settingsLocks` path.
2. Each entry is a string (`asString`) — a non-string member fails with the
   `countryPack.settingsLocks[i]` path.
3. **(A)** `isValidSettingKeySyntax(key)` — syntactically invalid keys
   rejected.
4. **(B)** `isCountryPackSettingKey(key)` — keys outside Country Pack's
   closed vocabulary rejected.
5. **(C)** `countryPackContributes(pack, key)` — a key this specific pack
   does not itself define is rejected.
6. Duplicate detection (`Set`) — a repeated key is rejected.

Every failure raises through the existing `fail()` →
`CountryPackValidationError` mechanism used by every other parser rule; no
`BadRequestException` anywhere in this file (grep-verified).

## 5. Country Pack fact contract

`localisation/contract/country-pack-setting-fact.query.ts` gained
`CountryPackSettingFact { readonly value: unknown; readonly locked: boolean }`
and `CountryPackSettingFactQuery.getSettingFact` now returns
`CountryPackSettingFact | null | undefined` (was `unknown`). The `undefined`
("no Country Pack representation") / `null` ("no pack currently effective")
semantics are unchanged; only the "eligible and configured" case changed
shape, from a bare value to `{ value, locked }`. No signature/provider/
internal metadata, and no full `CountryPack` document, is exposed — verified
by reading the concrete implementation, which builds a small explicit object
literal.

`country-pack-setting-fact.query.service.ts`'s `resolveCashRoundingPolicy`
now returns `{ value: {...same five fields as before...}, locked:
pack.settingsLocks.includes(input.settingKey) }`.

## 6. Platform Settings resolver wiring

`settings-resolver.service.ts`'s `fetchCountryPackEntry` no longer hardcodes
`locked: false`. It now reads `fact?.locked ?? false` and `fact?.value ??
null` from the same fact the resolver already fetched — no new precedence
logic, no new lock-walk. `computeEffective` (unchanged, not touched by this
slice) and `SettingsAdminService.assertNotBlockedByHigherLock` (unchanged)
are exactly the same generic mechanisms every other level's lock already
goes through — verified by inspecting both: neither contains any
level-specific branch, so wiring a real `locked` value into the
`country_pack` `SettingLevelEntry` was sufficient to make both write-time
rejection and the FR-PLT-027 inspector (`SettingsInspectorService`, also
unchanged) honour a Country-Pack lock automatically.

## 7. Backward compatibility

Proven, not merely asserted:

- `country-pack.parser.spec.ts` — "an old pack with no settingsLocks parses,
  and `settingsLocks` is exactly `[]`"; "an explicit empty settingsLocks
  means nothing locked, same as absent".
- `country-pack.registry.spec.ts` — "activates and verifies a pack signed
  with no settingsLocks field at all"; a second test proves a pack that DOES
  declare `settingsLocks` also activates and verifies correctly (the field
  participates in RFC-8785 canonicalisation/signature as ordinary content,
  with zero special-casing added to `country-pack.signature.ts`, which this
  slice does not touch at all); a third proves a `settingsLocks` value
  tampered with after signing is rejected exactly like any other tampered
  field (same `CountryPackActivationError` path).
- No existing pack fixture JSON was rewritten; `country-pack.fixture.ts`'s
  `makePackDocument` is unchanged — tests pass `settingsLocks` only via the
  existing `overrides` parameter.

## 8. Invalid pack tests

All six required cases added to `country-pack.parser.spec.ts`, describe
block "Country Pack parser — settingsLocks (FR-PLT-026 / P2A-R1)":

- **A** unknown lock key → `/not a Country-Pack-supported settings key/`.
- **B** syntactically invalid key (two shapes: mixed-case, leading dot) →
  `/not a valid settings-hierarchy key/`.
- **C** duplicate key → `/duplicate settings lock/`.
- **D** "pack does not authoritatively contribute this key" — not reachable
  through a production pack document today (every valid pack unconditionally
  contributes the sole supported key; see §2). Per the task's own fallback
  instruction, the predicate itself is proven directly instead, in a new
  file `country-pack.setting-keys.spec.ts`: `countryPackContributes` is
  exercised against a genuinely parsed, valid pack and asserted `true`; no
  unsupported production shape is invented to force a `false` branch that
  cannot occur today.
- **E** non-array `settingsLocks` → rejected via the existing `asArray`
  path-tagged error.
- **F** non-string member → rejected via the existing `asString`
  path-tagged error (`countryPack.settingsLocks[0]`).

Plus two extra tests proving the positive path (accepts a lock on a
genuinely contributed key) and the fact-query-level lock projection
(`country-pack-setting-fact.query.service.spec.ts`: unlocked when
`settingsLocks` is absent, `locked: true` when the activated pack declares
the key).

## 9. End-to-end lock test

`test/platform-settings.e2e-spec.ts` — jurisdiction X's activated pack
(`activateTwoJurisdictionPacksBeforeBoot`) now carries `settingsLocks:
['payments.cash_rounding_policy']`. A new terminal, `terminalCX`, was added
(bound to `branchCX`, jurisdiction X) alongside the existing `terminalCY`,
so a terminal-scoped case could be proven for the LOCKED jurisdiction, not
just the unlocked one the existing branch-accuracy test already covers.

New test "Country-Pack lock (FR-PLT-026 / P2A-R1): country_pack lock blocks
every lower-level override, on read and on write, and the inspector shows
it":

1. Resolves `payments.cash_rounding_policy` for `branchCX` — proves
   `effectiveSourceLevel === 'country_pack'`, `isLocked === true`,
   `lockedAtLevel === 'country_pack'`.
2. Attempts a tenant, brand, branch, and terminal write beneath the lock —
   all four rejected `409` by the existing, unmodified
   `assertNotBlockedByHigherLock` check.
3. Inserts a pre-existing branch-level row directly via Prisma (same
   technique the pre-existing "Platform-Default lock" e2e test uses for the
   platform level, necessary here because the Country-Pack lock is active
   from process boot — there is no "before the lock" moment reachable
   through the ordinary write API at this level, unlike the tenant/branch
   lock tests which apply their lock after an earlier legitimate write) and
   confirms the inspector marks it `blockedByHigherLock: true`,
   `isEffectiveSource: false`, while `country_pack`'s own inspector row shows
   `isEffectiveSource: true`, `locked: true`.
4. Repeats the resolve for `terminalCX` (terminal-scoped), proving
   `terminalCX -> branchCX -> jurisdiction X` branch-jurisdiction derivation
   composes correctly with the Country-Pack lock.

All existing tests in this file (A–R, the Platform-Default lock test, and
the P1C-item-7 branch-accuracy test) were re-verified to still pass with
jurisdiction X's pack now carrying a lock declaration — none of them assert
`isLocked`/`lockedAtLevel` for jurisdiction X, so none regressed.

## 10. Module boundaries

`src/common/settings-key.ts` lives outside `src/modules/`, so it is not part
of `module-boundaries.spec.ts`'s tracked graph at all — no import of it from
either `platform-settings` or `localisation` can register as a cross-module
edge. `localisation/country-pack/country-pack.setting-keys.ts` is imported
only from within `localisation` (`country-pack.parser.ts`,
`country-pack-setting-fact.query.service.ts`) — Localisation does not import
`platform-settings` anywhere (grep-verified: no `platform-settings` string
appears under `src/modules/localisation/`). `module-boundaries.spec.ts`'s
"records every pre-existing deviation, and no more" test passed unmodified —
**zero new `KNOWN_DEVIATIONS` entries**, and the whole-tree diff against the
frozen allow-list is exact.

## 11. Scope discipline

Not touched, not implemented, verified by `git diff --stat` against the
baseline: `FR-PLT-028`, `ServiceChargePolicy`, `Order.serviceChargePolicyId`,
cash-rounding computation, service-charge computation, tips, ACT-01 Platform
Administrator, any Platform-Default HTTP write route, any new permission.
The only files touched are listed in §`FILES_CHANGED` below.

## 12. Verification

- `npx tsc --noEmit` — clean, zero errors.
- `npm run build` (`nest build`) — clean.
- Targeted unit tests: `npx jest --testPathPatterns "country-pack|localisation|module-boundaries|authorization-coverage"` — **234/234 passed, 11/11 suites**.
- Targeted e2e: `npx jest --config ./test/jest-e2e.json --testPathPatterns "platform-settings"` — **15/15 passed, 1/1 suite** (14 pre-existing + 1 new Country-Pack lock test; no full E2E run, per instruction).
- `npm run openapi:generate` — regenerated `docs/api/openapi.json`/`.yaml`; `git diff --stat -- docs/api` **empty** — no semantic route change, confirmed.
- `npx eslint` on every changed/new file — clean after one auto-fix pass (7 pure-formatting/prettier fixes, no logic change; re-verified typecheck/unit/e2e green afterward).

## 13. Status gate

Independent reassessment against the task's own COMPLETE criteria (§13):

- Country Pack can express the lock — yes (`settingsLocks` field, §3).
- Parser enforces valid lock declarations — yes (§4, six invalid-case tests, §8).
- Signed-pack compatibility remains correct — yes (§7, three dedicated tests).
- Resolver reads it — yes (§6, hardcoded `locked: false` removed).
- Lower overrides are blocked server-side — yes, proven for all four
  storable levels beneath `country_pack` (§9 step 2, all `409`).
- Inspector exposes locking level — yes (§9 step 3, `blockedByHigherLock`/
  `isEffectiveSource`/`locked` all verified).
- Branch-accurate Country Pack selection still works — yes, the pre-existing
  P1C-item-7 branch-accuracy test still passes unmodified with jurisdiction
  X now locked.
- Executable tests prove all of the above — yes, §8/§9.

```
FR_PLT_025_FINAL_STATUS: COMPLETE (unchanged by this slice)
FR_PLT_026_FINAL_STATUS: COMPLETE
FR_PLT_027_FINAL_STATUS: COMPLETE (unchanged by this slice; now exercises a real Country-Pack lock)
FR_PLT_028_FINAL_STATUS: NOT_IMPLEMENTED (unchanged; explicitly out of scope, per task §11 and P2A-R1 clause 3)
```

## 14. Files changed

Implementation:
- `src/common/settings-key.ts` (new)
- `src/modules/platform-settings/settings-key.util.ts` (edit)
- `src/modules/localisation/country-pack/country-pack.setting-keys.ts` (new)
- `src/modules/localisation/country-pack/country-pack.model.ts` (edit)
- `src/modules/localisation/country-pack/country-pack.parser.ts` (edit)
- `src/modules/localisation/contract/country-pack-setting-fact.query.ts` (edit)
- `src/modules/localisation/country-pack/country-pack-setting-fact.query.service.ts` (edit)
- `src/modules/platform-settings/settings-resolver.service.ts` (edit)

Tests:
- `src/modules/localisation/country-pack/country-pack.setting-keys.spec.ts` (new)
- `src/modules/localisation/country-pack/country-pack.parser.spec.ts` (edit)
- `src/modules/localisation/country-pack/country-pack.registry.spec.ts` (edit)
- `src/modules/localisation/country-pack/country-pack-setting-fact.query.service.spec.ts` (edit)
- `test/platform-settings.e2e-spec.ts` (edit)

Generated artifacts: `docs/api/openapi.json`/`.yaml` regenerated; content
identical to baseline (empty diff), so not separately committed as a
content change (the generation command was still run and verified, per §12).

Report + index:
- `docs/reports/claude/2026-09-10_FULL-SRS-PLT-COUNTRY-PACK-LOCK-P2B.md` (this file)
- `docs/reports/claude/INDEX.md` (new row)

## RETURN block

```
START_HEAD: 7c604d66a01793c7a36f6fcfacf4675f3843f6d2
GOVERNANCE_DECISION: P2A-R1 (docs/governance/GOVERNANCE_DECISION_REGISTER.md)
GOVERNANCE_STATUS: RATIFIED — clauses 1 and 2 implemented by this slice

SETTING_KEY_COMMON_PRIMITIVE: src/common/settings-key.ts (SETTING_KEY_PATTERN, SETTING_KEY_MAX_LENGTH, isValidSettingKeySyntax) — framework-free, no NestJS/HTTP/domain logic
COUNTRY_PACK_SETTING_KEYS_OWNER: src/modules/localisation/country-pack/country-pack.setting-keys.ts (COUNTRY_PACK_SETTING_KEYS, isCountryPackSettingKey, countryPackContributes) — Localisation-owned, no platform-settings import

COUNTRY_PACK_MODEL_CHANGE: CountryPack.settingsLocks: readonly string[] added (country-pack.model.ts)
OLD_PACK_DEFAULT: absent settingsLocks normalised to [] by the parser; internal model never carries undefined
PARSER_VALIDATION: array type, string members, syntax (isValidSettingKeySyntax), closed-vocabulary membership, per-pack contribution (countryPackContributes), no duplicates — all via CountryPackValidationError/fail(), never BadRequestException
SIGNATURE_COMPATIBILITY: proven — old packs with no settingsLocks activate/verify unchanged; packs WITH settingsLocks activate/verify with zero special-casing in country-pack.signature.ts (untouched); tampered settingsLocks rejected exactly like any other tampered field

COUNTRY_PACK_FACT_CONTRACT: CountryPackSettingFact { value: unknown; locked: boolean } — getSettingFact returns CountryPackSettingFact | null | undefined
RESOLVER_LOCK_WIRING: settings-resolver.service.ts's fetchCountryPackEntry reads fact?.locked ?? false / fact?.value ?? null — hardcoded locked:false removed, no new precedence logic
WRITE_ENFORCEMENT: unmodified SettingsAdminService.assertNotBlockedByHigherLock now genuinely blocks country_pack-locked keys — proven 409 for tenant/brand/branch/terminal writes beneath a Country-Pack lock
INSPECTOR_BEHAVIOUR: unmodified SettingsInspectorService now genuinely reports blockedByHigherLock/isEffectiveSource/locked for a Country-Pack lock — proven in the e2e suite

BRANCH_ACCURACY_REGRESSION_STATUS: no regression — pre-existing P1C-item-7 branch-accuracy e2e test still passes unmodified with jurisdiction X now locked
MODULE_GRAPH: zero new KNOWN_DEVIATIONS entries; module-boundaries.spec.ts "records every pre-existing deviation, and no more" passes unmodified
KNOWN_DEVIATIONS_ADDED: none

FR_PLT_025_FINAL_STATUS: COMPLETE
FR_PLT_026_FINAL_STATUS: COMPLETE
FR_PLT_027_FINAL_STATUS: COMPLETE
FR_PLT_028_FINAL_STATUS: NOT_IMPLEMENTED (out of scope, per task §11 / P2A-R1 clause 3)

TESTS: unit 234/234 (11 suites, country-pack|localisation|module-boundaries|authorization-coverage); e2e 15/15 (1 suite, platform-settings, 14 pre-existing + 1 new)
TYPECHECK: clean (npx tsc --noEmit)
BUILD: clean (npm run build)
OPENAPI: regenerated, empty diff — no semantic route change
LINT: clean (7 pure-formatting auto-fixes applied, re-verified green after)

FILES_CHANGED: see §14 above (8 implementation, 5 test, 2 report/index)
COMMIT: recorded in a follow-up report once created, per repository convention (see this file's own git history after commit)
SAFE_TO_INTEGRATE: yes — no pull/merge/push performed, per instruction
BLOCKERS_OR_UNCERTAINTIES: none identified. FR-PLT-028 (effective-dated financial-policy storage) remains the next slice, per P2A-R1 clauses 3-16, explicitly out of scope here.
```

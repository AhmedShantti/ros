# FULL-SRS-PLT-CASH-ROUNDING-PROVIDER-EXCLUSIVE-P2C1-IMPL

**Report type:** Implementation / verification report.
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decision (`docs/governance/GOVERNANCE_DECISION_REGISTER.md`,
entry `P2C1-R1`) remain authoritative.
**Date:** 2026-09-10
**Task identifier:** `FULL-SRS-PLT-CASH-ROUNDING-PROVIDER-EXCLUSIVE-P2C1-IMPL`
**START_HEAD:** `9a7da007d58e5b119b1714ac597b96d595a93dba`
**Branch:** `full-srs/lane-d4-reporting-demo`

## 0. Baseline verification

`git rev-parse HEAD` = `9a7da007d58e5b119b1714ac597b96d595a93dba`.

```
9a7da00 docs(governance): ratify P2C1-R1 and P2D-R1 (cash-rounding provider-exclusivity + ServiceChargePolicy config semantics)
5dc916c docs(reports): record commit hash in FULL-SRS-PLT-COUNTRY-PACK-LOCK-P2B report
7cd43e5 feat(localisation,platform-settings): Country Pack settingsLocks — closes FR-PLT-026
7c604d6 docs(governance): ratify P2A-R1 financial-settings decision (Country Pack lock + FR-PLT-028 storage)
```

`docs/governance/GOVERNANCE_DECISION_REGISTER.md` confirmed to contain both
`P2C1-R1` (line 9173) and `P2D-R1` (line 9363), both `RATIFIED — CLOSED`.
This task implements ONLY `P2C1-R1`; `P2D-R1`/`ServiceChargePolicy` is
untouched, per instruction.

Split-brain re-confirmed before any change (re-tracing, not assumed):

- **A.** `PlatformSettingsController`'s write routes accept `settingKey` as
  a free-form URL parameter (`platform-settings.controller.ts`); prior to
  this task, `SettingsAdminService.upsert`/`unset` had no key-specific
  check — a tenant/brand/branch/terminal write for
  `payments.cash_rounding_policy` succeeded whenever the active Country
  Pack did not declare `settingsLocks` for it (the default posture).
- **B.** `SettingsResolverService.computeEffective` walked such a row as
  eligible/configured and, with `country_pack` unlocked, reported it as
  `effectiveSourceLevel`.
- **C.** `SalesPaymentService` (cash-rounding computation) imported nothing
  from `platform-settings`; it consumed only `PINNED_PAYMENT_POLICY_QUERY`
  → `CountryPackService.requirePinned` → `Order.countryPackVersion`.
  `EFFECTIVE_SETTING_QUERY` remained unconsumed by any module
  (`grep -rln "EFFECTIVE_SETTING_QUERY" src/modules`, excluding specs,
  returned only `platform-settings`' own four files).

## 1-2. Provider-exclusivity contract and Localisation classification

`src/modules/localisation/contract/country-pack-setting-fact.query.ts` —
`CountryPackSettingFactQuery` gained `isProviderExclusive(settingKey:
string): boolean`, documented as a STATIC, structural, per-key fact,
strictly distinct from `FR-PLT-026` locking, and explicitly NOT inferred
from mere `COUNTRY_PACK_SETTING_KEYS` membership.

`src/modules/localisation/country-pack/country-pack.setting-keys.ts` —
Localisation owns the classification: a new `PROVIDER_EXCLUSIVE_SETTING_KEYS`
`Set` (typed via `satisfies readonly CountryPackSettingKey[]` so a typo
fails to compile) and `isProviderExclusiveSettingKey(key): boolean`.
Exactly `payments.cash_rounding_policy` is classified provider-exclusive
today, with the evidencing citations (`FR-POS-063`, `FR-FIN-035`,
`BR-FIN-004`, `FR-LOC-020`) recorded in the docblock. No other entry exists
or is inferred — a unit test (`country-pack.setting-keys.spec.ts`) asserts
every current `COUNTRY_PACK_SETTING_KEYS` entry is individually classified
(today, trivially, the one entry), specifically so a future SECOND key
added to the vocabulary without its own deliberate judgment call fails
that test rather than silently inheriting provider-exclusivity or silently
not needing to declare it either way.

`country-pack-setting-fact.query.service.ts` implements
`isProviderExclusive` by delegating to `isProviderExclusiveSettingKey` —
one canonical definition, no duplicated literal list, consistent with how
`COUNTRY_PACK_SETTING_KEYS`/`countryPackContributes` are already consumed.

**Not touched, verified by diff**: `CountryPack.settingsLocks`,
`countryPackContributes`, `country-pack.signature.ts`, `country-pack.parser.ts`
(no changes to any of these — provider-exclusivity and `settingsLocks`
remain two separate, independently-evidenced concepts, exactly per
instruction).

## 3. Resolver eligibility

`settings-resolver.service.ts`'s `fetchLevelEntry` was restructured
(handled `country_pack` first, then a single provider-exclusivity gate
applied uniformly to `platform` and every storable level, BEFORE any
database read) — no branch was added inside `computeEffective`, which is
byte-for-byte unchanged. A shared `ineligibleEntry(level)` helper replaces
the three previously-duplicated "not in play" object literals (absent-id
levels, country_pack-has-no-representation, and now
provider-exclusive-key) — one honest shape for "nothing to see here,"
never `locked: true`.

Verified behaviour (Case A/B e2e, §7-8 below):

- Active pack WITHOUT `settingsLocks` for the key: `country_pack` eligible,
  `isLocked: false`, `lockedAtLevel: null`; platform/tenant/brand/branch/
  terminal all `eligible: false`.
- Active pack WITH `settingsLocks` for the key: `country_pack` eligible,
  `isLocked: true`, `lockedAtLevel: 'country_pack'` (the pack's own signed
  fact, honestly projected, entirely unaffected); every other level still
  `eligible: false` (now for the STRUCTURAL provider-exclusivity reason,
  not merely "shadowed by a lock").

## 4. Admin write enforcement

`settings-admin.service.ts` — `SettingsAdminService` now injects
`COUNTRY_PACK_SETTING_FACT_QUERY` (via the published contract only — no
private Localisation import). A new `assertNotProviderExclusive(settingKey,
level)` throws the existing `ConflictException` (409) with a message that
explicitly names provider-exclusivity and never contains the word
"locked": `"${settingKey} is exclusively governed by the Country Pack and
cannot be configured at ${level}."`. Called at the very top of both
`upsert` and `unset`, immediately after `assertValidSettingKey`, BEFORE
`validateTarget`/`assertNotBlockedByHigherLock`/any database access — the
cheapest possible rejection, and structurally prior to (never confusable
with) the lock-conflict path. No new permission, no new exception type, no
new error-code convention.

## 5. Stale-row behaviour

No migration. No `SettingValue` row is deleted anywhere by this change. A
physically-existing row for `payments.cash_rounding_policy` at any of
platform/tenant/brand/branch/terminal is now provably inert: `fetchLevelEntry`
returns `eligible: false` for that level UNCONDITIONALLY, without even
issuing the `tx.settingValue.findUnique`/`tx.platformDefaultSetting.findUnique`
query — so the row can never become `hasConfiguredValue: true`, never
becomes `effectiveSourceLevel`, and (verified directly, §8) is reported by
the inspector as `configuredValue: null, blockedByHigherLock: false,
isEffectiveSource: false` — a STRONGER guarantee than "blocked": the row is
structurally invisible, not merely outranked.

## 6. Stale comment

`src/modules/sales/orders/order-totals.ts:103-110` — the comment
incorrectly claiming cash rounding "are not implemented" is corrected to
distinguish the two columns explicitly: `serviceChargeTotal` remains
genuinely unimplemented (tracked separately, `P2D`/`P2E`);
`roundingAdjustment` IS implemented, correctly, at PAYMENT CAPTURE time by
`SalesPaymentService`, and is intentionally never recomputed from order
lines in this function. Comment-only change — `recomputeOrderTotals`'s own
logic (and its returned object, which still excludes both columns) is
byte-for-byte unchanged; `SalesPaymentService` was not touched.

## 7-9. Test cases A/B/C

**Case A** (`test/platform-settings.e2e-spec.ts`, new test) — jurisdiction
Y's pack (already activated, declares NO `settingsLocks`) proves: resolve
shows `country_pack` effective, `isLocked: false`, `lockedAtLevel: null`;
inspector shows platform/tenant/brand/branch/terminal all `eligible:
false`; `PUT`/`DELETE` at tenant, brand, branch, and terminal all reject
409 with a message matching `/exclusively governed by the Country Pack/`
and explicitly asserted NOT to match `/locked/i`. `DELETE` (unset) is
proven to reject for the SAME reason even though no row could ever have
been written to unset in the first place (proves the check precedes the
"no existing override" 404 path).

**Case B** (revises the former `FULL-SRS-PLT-COUNTRY-PACK-LOCK-P2B` test in
place) — jurisdiction X's pack (declares `settingsLocks:
['payments.cash_rounding_policy']`) keeps its READ-side proof unchanged
(`isLocked: true`, `lockedAtLevel: 'country_pack'`, honestly reflecting the
signed fact) but its write-rejection narrative is corrected: the test name,
comments, and a new message assertion now state explicitly that the 409 is
NOT, by itself, proof of lock causality (Case A already proves
provider-exclusivity alone produces the identical rejection for an
unlocked jurisdiction). The pre-existing-stale-branch-row assertions were
updated from "`blockedByHigherLock: true`, reports the stale value" to
"`eligible: false`, `configuredValue: null`, `blockedByHigherLock: false`
at every level" — the correct, stronger post-correction behaviour, checked
for platform/tenant/brand/branch/terminal together.

**Case C** (new `describe` block, end of file) — an independent,
causally-isolated proof that `country_pack`-level locking itself still
works, decoupled from provider-exclusivity and from any real production
key. Boots a SEPARATE `Test.createTestingModule({imports:[AppModule]})
.overrideProvider(COUNTRY_PACK_SETTING_FACT_QUERY).useValue(fake)` Nest
application (the shared main-describe-block app/DB is untouched — the
override is scoped to this second, isolated compilation only). The fake
reports one synthetic, non-production key
(`test.plt_lock_causality_<timestamp>`) as `{value, locked: true}` at
`country_pack` and `isProviderExclusive: false`. A tenant-level
`SettingValue` row is pre-seeded directly via Prisma for that same
synthetic key, and `SettingsInspectorService.inspect` (fetched directly
from the second app's own DI container, no HTTP layer needed) is called
directly: proves `effectiveSourceLevel: 'country_pack'`, `isLocked: true`,
`lockedAtLevel: 'country_pack'`, and the tenant row `blockedByHigherLock:
true, isEffectiveSource: false`. The synthetic key is NEVER added to
`COUNTRY_PACK_SETTING_KEYS` and never reaches the real Country-Pack parser
— grep-verified after the change: `COUNTRY_PACK_SETTING_KEYS` still names
exactly one entry.

One pre-existing test (`B: with no Country Pack activated...`) needed a
correction unrelated to Cases A-C: it configured a `PlatformDefaultSetting`
row for `payments.cash_rounding_policy` and asserted it resolved as
effective — now genuinely wrong, since `platform` is provider-exclusive-
ineligible for this key too (per the task's own explicit "platform ...
must never be treated as effective" mission text). Corrected to assert
`hasEffectiveValue: false`, `effectiveSourceLevel: null`, and the inspector
showing `platform: eligible: false` despite the configured row — this is
the platform-level half of the §5 stale-row-behaviour requirement, now
exercised explicitly by this test.

## 10. Payment computation regression

`SalesPaymentService` was not modified. `PINNED_PAYMENT_POLICY_QUERY` →
`CountryPackService.requirePinned` → `Order.countryPackVersion` remains
the sole authority path — grep-confirmed no new import of anything under
`platform-settings` in `src/modules/sales`. `test/sales-payment.e2e-spec.ts`
— **51/51 passed**, including the named cash-rounding tests: `'computes
change due correctly with rounding ENABLED (step 25, HALF_UP)'`, `'rounding
is persisted per Payment, and the Order rounding projection reflects it'`,
`'the rounding-DISABLED country pack applies zero rounding'`, `'cash
affects the persisted data needed for expected-cash derivation'`.

## 11. Module boundaries

`SettingsAdminService`'s new dependency reaches Localisation ONLY through
`../localisation/contract` (the same edge `SettingsResolverService` already
had) — no private import. `module-boundaries.spec.ts`'s "records every
pre-existing deviation, and no more" test passed unmodified: **zero new
`KNOWN_DEVIATIONS` entries**.

## 12. Requirement status

Independently reassessed, unchanged by this correction (it removes a
coherence DEFECT within the already-COMPLETE FR-PLT-025 mechanism; it does
not newly satisfy or violate any requirement's own text):

```
FR-PLT-025 = COMPLETE
FR-PLT-026 = COMPLETE
FR-PLT-027 = COMPLETE
FR-PLT-028 = PARTIAL (unchanged — the pre-existing service-charge gap,
  P2D, untouched by this task)
BR-FIN-004 = COMPLETE

CASH_ROUNDING_SETTINGS_COHERENCE: CLOSED
```

## 13. Verification

- `npx tsc --noEmit` — clean.
- `npm run build` — clean.
- Unit: `npx jest --testPathPatterns "country-pack|localisation|module-boundaries|authorization-coverage"` — **238/238 passed, 11/11 suites** (4 new: `isProviderExclusiveSettingKey` x3, `isProviderExclusive` delegation x1).
- Targeted e2e: `npx jest --config ./test/jest-e2e.json --testPathPatterns "platform-settings|sales-payment\.e2e"` — **68/68 passed, 2/2 suites** (platform-settings 17/17 — 14 pre-existing/1 corrected + Case A + Case C; sales-payment 51/51, no regression). No full E2E run, per instruction.
- `npm run openapi:generate` — regenerated; `git diff --stat -- docs/api` **empty** — no semantic route/schema change.
- `npx eslint` on every changed file — clean (one auto-fix pass for pure formatting + a manual fix replacing unsafe `.body.message` accesses in the e2e spec with a typed `errBody()` helper, mirroring the file's existing `effBody`/`inspBody` convention; re-verified green afterward).

## 14. Scope discipline

Not implemented, verified by `git diff --stat`: `ServiceChargePolicy` (any
form), any resolver/controller for it, any Prisma migration, `Order.
serviceChargePolicyVersionId`, `serviceChargeTotal` computation,
`serviceChargeTaxable` application, tips, discount/service-charge
interaction, `P2E`, Platform Administrator, or any new permission. The only
files touched are listed below.

## 15. Report / commit

Written to `docs/reports/claude/2026-09-10_FULL-SRS-PLT-CASH-ROUNDING-PROVIDER-EXCLUSIVE-P2C1-IMPL.md`.
`docs/reports/claude/INDEX.md` updated with a new row. Commit includes
implementation, tests, the stale-comment correction, this report, and the
INDEX row. `docs/api/*` NOT committed (content identical to baseline, empty
diff). Not pushed.

---

## RETURN

```
START_HEAD: 9a7da007d58e5b119b1714ac597b96d595a93dba
GOVERNANCE_DECISION: P2C1-R1 (docs/governance/GOVERNANCE_DECISION_REGISTER.md)
GOVERNANCE_STATUS: RATIFIED — CLOSED, ancestry confirmed (commit 9a7da00)

PROVIDER_EXCLUSIVE_CONTRACT: CountryPackSettingFactQuery.isProviderExclusive(settingKey): boolean — added to src/modules/localisation/contract/country-pack-setting-fact.query.ts
LOCALISATION_CLASSIFICATION: country-pack.setting-keys.ts — PROVIDER_EXCLUSIVE_SETTING_KEYS Set + isProviderExclusiveSettingKey(); exactly payments.cash_rounding_policy classified today, individually evidenced (FR-POS-063/FR-FIN-035/BR-FIN-004/FR-LOC-020), no blanket rule

RESOLVER_ELIGIBILITY_BEHAVIOUR: fetchLevelEntry gates platform + every storable level on isProviderExclusive BEFORE any DB read; country_pack's own entry (and computeEffective) untouched; unlocked pack -> isLocked:false/lockedAtLevel:null; locked pack -> isLocked:true/lockedAtLevel:'country_pack', both real, never fabricated
WRITE_REJECTION_BEHAVIOUR: SettingsAdminService.upsert rejects 409 (ConflictException) before validateTarget/assertNotBlockedByHigherLock/any DB access; message names provider-exclusivity, never "locked"
UNSET_REJECTION_BEHAVIOUR: SettingsAdminService.unset rejects identically, before the "no existing override" 404 check
STALE_ROW_BEHAVIOUR: physically-existing rows at any non-country_pack level are eligible:false unconditionally — never read, never effective, never reported as configured; no migration; proven directly (Case B's pre-existing branch row, test B's pre-existing platform row)

UNLOCKED_PACK_CASE: Case A — provider-exclusivity alone rejects every generic write (409, correct message, no "locked"); resolve/inspect show isLocked:false
LOCKED_PACK_CASE: Case B — READ still honestly isLocked:true/lockedAtLevel:country_pack; WRITE rejection narrative corrected to no longer claim lock-causality; stale-row assertions corrected to the new eligible:false shape
COUNTRY_PACK_LOCK_CAUSALITY_CASE: Case C — isolated second Nest app, DI-overridden COUNTRY_PACK_SETTING_FACT_QUERY fake, synthetic non-production key, real SettingsResolverService/SettingsInspectorService/Prisma — proves country_pack lock-stop causally, independent of provider-exclusivity, without touching COUNTRY_PACK_SETTING_KEYS or the real parser

PAYMENT_AUTHORITY_PATH: unchanged — PINNED_PAYMENT_POLICY_QUERY -> CountryPackService.requirePinned -> Order.countryPackVersion; zero platform-settings import in src/modules/sales
PAYMENT_REGRESSION_STATUS: none — sales-payment.e2e-spec.ts 51/51 passed, including all four named cash-rounding tests

STALE_COMMENT_CORRECTED: YES — order-totals.ts:103-110, comment-only, distinguishes serviceChargeTotal (still unimplemented) from roundingAdjustment (implemented at payment-capture time, intentionally not recomputed here)

MODULE_GRAPH: platform-settings -> localisation/contract only (SettingsAdminService's new dependency reuses the existing published edge); no reverse edge; module-boundaries "records every pre-existing deviation, and no more" passes unmodified
KNOWN_DEVIATIONS_ADDED: none

FR_PLT_025_STATUS: COMPLETE (unchanged)
FR_PLT_026_STATUS: COMPLETE (unchanged)
FR_PLT_027_STATUS: COMPLETE (unchanged)
FR_PLT_028_STATUS: PARTIAL (unchanged — service-charge gap, out of this task's scope)
BR_FIN_004_STATUS: COMPLETE (unchanged)

CASH_ROUNDING_SETTINGS_COHERENCE: CLOSED

TESTS: unit 238/238 (11 suites); e2e 68/68 (2 suites: platform-settings 17/17, sales-payment 51/51); no full E2E run
TYPECHECK: clean (npx tsc --noEmit)
BUILD: clean (npm run build)
OPENAPI: regenerated, empty diff — no semantic route/schema change
LINT: clean (all changed files, zero errors)

FILES_CHANGED: 8 implementation/test files (localisation contract, localisation setting-keys + spec, localisation fact-query-service + spec, platform-settings resolver, platform-settings admin, sales order-totals comment, platform-settings e2e spec) + this report + INDEX.md row
COMMIT: b5f67d5
SAFE_TO_INTEGRATE: yes — no pull/merge/push performed, per instruction
BLOCKERS_OR_UNCERTAINTIES: none identified. ServiceChargePolicy (P2D) remains the next, entirely independent slice, per P2D-R1.
```

# FULL-SRS-PLT-SETTINGS-CORRECTION-P1C

**Slice:** FULL-SRS-PLT-SETTINGS-CORRECTION-P1C — backend implementation, closing all non-governance P1B findings
**Report type:** Implementation + verification report
**Authority statement:** This report is **non-authoritative evidence**. The ROS SRS (`ROS_SRS_v1.0.pdf`) and ratified governance decisions in `docs/governance/GOVERNANCE_DECISION_REGISTER.md`/`docs/adr/*.md` remain the sole authoritative sources. Nothing here overrides, amends, or substitutes for a governance decision — the two items this report defers to governance (Country-Pack lock representation, ACT-01 Platform Administrator) are still owed, not made, by this slice.
**Date:** 2026-09-09
**HEAD at start:** `8971af759b587397cb60df4a2583fab074dc3779`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Design gate reviewed:** `docs/reports/claude/2026-09-09_FULL-SRS-PLT-SETTINGS-DESIGN-CORRECTION-GATE-P1B.md`
**Task identifier:** `FULL-SRS-PLT-SETTINGS-CORRECTION-P1C`
**Scope discipline:** Implemented ONLY the corrections P1B proved safe and governance-free. Explicitly did NOT implement: Country-Pack lock schema, FR-PLT-028, a Platform Administrator actor, Platform-Default HTTP writes, service charge, financial effective dating, or any new permission code. Not pushed.

---

## START_HEAD

`8971af759b587397cb60df4a2583fab074dc3779`

## IDENTITY_DEVIATION_REMOVED

**Yes.** `platform-settings.controller.ts` now imports `JwtAuthGuard`, `PermissionGuard`, `RequirePermission`, `RequireAnyPermission`, `CurrentTenantContext`, `TenantContextGuard`, and `type TenantContext` from `../identity/contract` (merged into the SAME import block already used for `AuthorizationTarget`/`resourceTarget`/etc.) instead of six private `identity/auth`, `identity/authz`, `identity/context` paths. No new re-export wrapper was created — `identity/contract/http.ts` already published every symbol needed, verbatim (thin re-export, created 2026-08-31, before this module existed).

## GOVERNANCE_DEVIATION_REMOVED

**Yes.** `settings-admin.service.ts` now imports `AuditService`, `AUDIT_ACTION`, `AUDIT_ENTITY` from `../governance/contract` instead of the private `governance/audit/audit.service`/`audit.constants` paths. `platform-settings.module.ts`'s explicit `AuditModule` import/entry was removed entirely — confirmed safe by reading `audit.module.ts` directly: `AuditService` is `@Global()` (line 39) and `AuditModule` is already registered in `app.module.ts` (line 44), so it is injectable app-wide without any consumer module listing it.

## PLATFORM_SETTINGS_KNOWN_DEVIATIONS_AFTER

**Zero.** `grep -c "platform-settings" src/modules/module-boundaries.spec.ts` returns `0` — the module is no longer mentioned anywhere in `KNOWN_DEVIATIONS` at all (not even an empty/near-empty entry). Verified by running the suite: `npx jest src/modules/module-boundaries.spec.ts` — **46/46 passed**, including the exact-match `toEqual(KNOWN_DEVIATIONS)` assertion that fails on any extra or missing entry.

---

## ORGANISATION_CONTRACT_DECISION

**New sibling contract: `BRANCH_JURISDICTION_QUERY`** (`src/modules/organisation/contract/branch-jurisdiction.query.ts` + private implementation `src/modules/organisation/branches/branch-jurisdiction.query.service.ts`), **not** an additive field on `BRANCH_CURRENCY_QUERY`. Reasoning, checked directly against current source before deciding: `branch-currency.query.ts`'s docblock, file name, interface name (`BranchCurrencyResult`), and stated rationale (SRS §7.3 #5 "one timezone; one base currency") are entirely currency-specific — widening it to also carry jurisdiction would quietly change what "branch currency" means to its one existing consumer (`CashClosePolicyService`) for a fact that, while sourced from the same `org.branches` row, is conceptually distinct. The new contract mirrors `BranchCurrencyQuery`'s exact shape (`find(tx, {tenantId, branchId}) => {branchId, countryCode} | null`, transaction-aware, null-on-invisible) and required **zero changes to any existing caller** — `BRANCH_CURRENCY_QUERY` and its consumer are untouched.

## BRANCH_COUNTRY_RESOLUTION_PATH

`SettingsResolverService.resolveJurisdictionCode` (new private method): when `scope.branchId !== null` (already derived by `SettingsScopeService.deriveScope` for any branch- or terminal-scoped request — terminal derives its branch first), calls `BRANCH_JURISDICTION_QUERY.find(tx, {tenantId, branchId})` and uses the returned `countryCode` as the jurisdiction code passed into `COUNTRY_PACK_SETTING_FACT_QUERY.getSettingFact`.

## TENANT_FALLBACK_PATH

When `scope.branchId === null` (a genuinely tenant/brand-only request — no branch anywhere in the derived scope), falls back to `tx.tenant.findUnique({ select: { countryPackCode: true } })`, exactly as before — the correct, honest answer at that narrower granularity, not a workaround.

## MODULE_GRAPH_IMPACT

**None beyond what already existed.** `platform-settings.module.ts`'s `imports` array is unchanged (`IdentityModule, OrganisationModule, LocalisationModule` — `AuditModule` removed, see GOVERNANCE_DEVIATION_REMOVED). `Localisation` gained **no** new dependency — `COUNTRY_PACK_SETTING_FACT_QUERY`'s input shape is unchanged (`countryPackCode: string`, now documented as caller-resolved rather than necessarily `Tenant.countryPackCode`); it still never imports Organisation, never reads `org.branches`, and stays a pure "given a jurisdiction code, what does the pack say" oracle. `Organisation` gained one new provider/export (`BRANCH_JURISDICTION_QUERY`) inside its own module, exported the same way every other Organisation query contract is. No raw Prisma read of `org.branches` was added to `platform-settings` or `Localisation` — every branch fact is reached through the published contract, per the task's explicit prohibition. No `KNOWN_DEVIATIONS` entry was added for any of this (verified: `module-boundaries.spec.ts` 46/46, zero `organisation->*` or `localisation->*` new entries).

---

## COUNTRY_PACK_LOCK_RUNTIME_CHANGE

**None — as instructed.** `fetchCountryPackEntry` still always returns `locked: false` for Country-Pack-sourced values. No signed-pack schema change, no new lock field, no parser change.

## COUNTRY_PACK_LOCK_DOCUMENTED_GAP

The misleading comment (`"Country Pack facts are Localisation's own authoritative data, never an app-writable row here, so FR-PLT-026 locking does not apply to them"`) was replaced in `settings-resolver.service.ts` with an accurate statement: Country Pack **cannot currently express** a generic settings-key lock (no field anywhere in `country-pack.model.ts`/`country-pack.parser.ts`); the resolver therefore reports Country-Pack contributions unlocked because that is presently, literally true, **not** because the SRS or any ratified governance decision exempts Country Pack from FR-PLT-026's "at any level"; this is a **known, governance-blocked gap** — a lower-level override remains possible for a Country-Pack-sourced value until a governance decision extends the signed-pack format with a lock representation and this resolver is updated to honour it. The equivalent claim was never present in `country-pack-setting-fact.query.ts`'s own docblock (it only described the tenant-vs-branch limitation, now also corrected — see BRANCH_COUNTRY_RESOLUTION_PATH), so no second correction was needed there.

---

## PLATFORM_DEFAULT_LOCK_TEST

Added: `test/platform-settings.e2e-spec.ts`, *"Platform-Default lock blocks every lower level, both on read and on write, and the inspector shows it (CORRECTION-P1C item 6)"*. Proves, in one test:
- A tenant-level value written **before** the platform lock exists, then a `PlatformDefaultSetting` seeded directly (locked=true) — resolving afterward returns the platform value (`effectiveSourceLevel: 'platform'`, `isLocked: true`, `lockedAtLevel: 'platform'`), the pre-existing tenant row never applies.
- Inspector: `platform` level `isEffectiveSource: true`; `tenant` level (which HAS a configured row) `blockedByHigherLock: true`, `isEffectiveSource: false`; `branch` level (no row at all) correctly `blockedByHigherLock: false` — nothing there to be blocked, matching the existing K-M test's own convention that "blocked" describes a level with an actual value the lock prevented from winning.
- A brand-level write attempt and a branch-level write attempt beneath the platform lock both return `409 Conflict` — the generic `assertNotBlockedByHigherLock` check, now proven for the platform level specifically (previously only proven for tenant/branch locks in tests G/H).

## Multi-country branch-accuracy test (item 7)

Added: `test/platform-settings.e2e-spec.ts`, *"Country-Pack resolution is branch-accurate, not tenant-default-only (CORRECTION-P1C item 7)"*, plus the shared fixture `activateTwoJurisdictionPacksBeforeBoot()` at the top of the file. Two genuinely signed, genuinely activated Country Packs (jurisdictions `ZX`/`ZY` — deliberately not Egypt, per instruction) are built with the SAME ephemeral in-memory Ed25519 signing fixtures `country-pack.registry.spec.ts` already uses (`generateReleaseKey`, `signPackDocument`), written to a temp directory + trust manifest, and `COUNTRY_PACK_DIR`/`COUNTRY_PACK_TRUST_MANIFEST` are set **before** `Test.createTestingModule({imports:[AppModule]}).compile()` runs (`CountryPackLoader.onModuleInit` reads them once, at boot). This is the first e2e suite in this repository to genuinely activate a signed pack rather than leaving both variables unset. `tenantC` defaults to jurisdiction X; `branchCX` also sits in X; `branchCY` sits in Y; `terminalCY` belongs to `branchCY`. The test proves:
- Resolving for `branchCX` returns X's pack (`currencyCode: 'XPA'`, `cashRoundingEnabled: false`) — sanity check that branch-accurate resolution still agrees with the tenant default when they happen to match.
- Resolving for `branchCY` returns **Y's** pack (`currencyCode: 'XPB'`, `cashRoundingEnabled: true`, `cashRoundingStepMinorUnits: '50'`), NOT tenant C's own default — the actual bug fix.
- A tenant/brand-only request (no branch) still resolves X (`effectiveSourceTargetId: jurisdictionXCode`) — the honest fallback still works.
- Resolving by `terminalId: terminalCY` alone (no explicit `branchId`) also resolves Y — proves `SettingsScopeService.deriveScope`'s terminal→branch derivation feeds the SAME branch-accurate path, not a terminal-blind tenant fallback.

Both new tests pass; full suite: **14/14**.

---

## FR_PLT_025_FINAL_STATUS

**COMPLETE.** All six resolution levels now behave correctly for their supported context: Platform Default, Tenant, Brand, Branch, Terminal (unchanged from P1, already correct), and Country Pack is now branch-accurate when a branch/terminal is in scope and honestly tenant-default when it is not — closing the one concrete defect that kept P1B's reassessment at PARTIAL. Verified end-to-end with genuinely activated, differently-jurisdictioned signed packs (item 7 test), not merely asserted.

## FR_PLT_026_FINAL_STATUS

**PARTIAL — as instructed, not marked COMPLETE.**

## FR_PLT_026_REMAINING_GAP

Country Pack still cannot be marked locked — the signed pack document has no field to express it (§COUNTRY_PACK_LOCK_RUNTIME_CHANGE above). This is the SAME gap P1B identified and is explicitly governance-blocked (requires extending Localisation's signed pack format, out of this slice's authority). Platform-Default-level locking is no longer an uncertainty: it was already implemented by the same generic code path as every other level, and is now proven end-to-end by the new test (both the read-time block and the write-time `409`).

## FR_PLT_027_FINAL_STATUS

**COMPLETE.** Unchanged from P1B's reassessment — the inspector mechanism itself was never deficient; it correctly reports on a resolver that, as of this slice, has one fewer known gap (branch-accuracy) than before.

---

## TESTS

- `test/platform-settings.e2e-spec.ts` — **14/14** (12 pre-existing + 2 new: Platform-Default lock, multi-country branch-accuracy).
- `src/modules/module-boundaries.spec.ts` — **46/46** (platform-settings carries zero `KNOWN_DEVIATIONS` entries).
- `src/modules/authorization-coverage.spec.ts` — **9/9** (part of the combined 55/55 run with the above).
- `src/modules/localisation/**` (full unit suite) — **164/164**, unaffected.
- `src/modules/organisation/**` (full unit suite) — **68/68** (part of the combined 232/232 run with the above four groups).
- `test/organisation.e2e-spec.ts` (Organisation contract regression, per instruction) — **62/62**, unaffected.

No full E2E suite run, per instruction.

## TYPECHECK

`npx tsc --noEmit` — clean, both after the initial corrections and again after `eslint --fix`.

## BUILD

`npm run build` (`nest build`) — clean.

## OPENAPI

`npm run openapi:generate` — regenerated; `git diff --stat docs/api/` is **empty** (no HTTP surface changed this slice — every correction was internal wiring/logic, no new routes, no DTO changes).

## LINT

`npx eslint <every changed/new file> --fix` then re-run without `--fix` on the same file set — **0 errors**.

---

## FILES_CHANGED

**New:**
```
src/modules/organisation/branches/branch-jurisdiction.query.service.ts
src/modules/organisation/contract/branch-jurisdiction.query.ts
docs/reports/claude/2026-09-09_FULL-SRS-PLT-SETTINGS-CORRECTION-P1C.md (this report)
```

**Modified:**
```
src/modules/localisation/contract/country-pack-setting-fact.query.ts   (docblock: countryPackCode is caller-resolved, not Tenant.countryPackCode)
src/modules/module-boundaries.spec.ts                                   (removed platform-settings->identity, platform-settings->governance)
src/modules/organisation/contract/index.ts                              (+branch-jurisdiction.query re-export)
src/modules/organisation/organisation.module.ts                         (+BranchJurisdictionQueryService wiring, +export)
src/modules/platform-settings/platform-settings.controller.ts           (guard/decorator imports moved to identity/contract)
src/modules/platform-settings/platform-settings.module.ts               (AuditModule import removed — @Global())
src/modules/platform-settings/settings-admin.service.ts                 (audit imports moved to governance/contract)
src/modules/platform-settings/settings-resolver.service.ts              (branch-accurate jurisdiction resolution; corrected lock comment)
test/platform-settings.e2e-spec.ts                                      (+2 tests, +multi-jurisdiction pack-activation fixture, +tenantC/branchCX/branchCY/terminalCY fixtures)
docs/reports/claude/INDEX.md                                            (this entry appended)
```

## COMMIT

Committed as `656c354` on `full-srs/lane-d4-reporting-demo` (parent `8971af7`). Not pushed.

## SAFE_TO_INTEGRATE

**Yes.** Every change is either a pure import-path correction (zero behaviour change, verified by full regression), a new additive Organisation contract with no existing-caller impact, or a genuine bug fix (branch-accuracy) verified by a real end-to-end test using genuinely activated, differently-configured signed packs — not merely asserted. `platform-settings` now carries zero architectural debt of its own. FR-PLT-025 can be honestly marked COMPLETE; FR-PLT-026 remains honestly PARTIAL for a reason that is now precisely scoped and governance-gated, not vague.

## GOVERNANCE_STILL_REQUIRED

1. Country-Pack generic lock representation — extending Localisation's signed pack format so a pack can declare a generic settings-key locked; recommend pairing with FR-PLT-028's design (both touch the same signed-document format).
2. ACT-01 Platform Administrator authorization model — SRS Chapter 3 names the actor (cross-tenant, "Admin Console") but §15.2/15.3 give it no permission codes or role (Appendix C, where they would live, is absent); building Platform-Default HTTP administration requires this decision first.

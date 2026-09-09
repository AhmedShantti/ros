# FULL-SRS-PLT-SETTINGS-DESIGN-CORRECTION-GATE-P1B

**Slice:** FULL-SRS-PLT-SETTINGS-DESIGN-CORRECTION-GATE-P1B
**Report type:** Read-only design-gate review (no source changed)
**Authority statement:** This report is **non-authoritative evidence**. The ROS SRS (`ROS_SRS_v1.0.pdf`) and ratified governance decisions in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` / `docs/adr/*.md` remain the sole authoritative sources. Nothing here overrides, amends, or substitutes for a governance decision — where this report concludes one is required, that decision is still owed, not made.
**Date:** 2026-09-09
**HEAD at start (and end — no commits made):** `8971af759b587397cb60df4a2583fab074dc3779`
**Baseline commits reviewed:** `6f12c62` (platform-settings resolver implementation), `8971af7` (report hash follow-up)
**Branch:** `full-srs/lane-d4-reporting-demo`
**Task identifier:** `FULL-SRS-PLT-SETTINGS-DESIGN-CORRECTION-GATE-P1B`
**Scope discipline:** No source file was modified. No commit was made. `git status` at the end of this session is identical to the start except for this new report file. Every claim below was verified live against current source, the SRS text (extracted from `ROS_SRS_v1.0.pdf` via `pdftotext -layout`), and `docs/governance/GOVERNANCE_DECISION_REGISTER.md`/`docs/adr/*.md` — not taken on trust from the prior `2026-09-09_FULL-SRS-PLT-SETTINGS-RESOLVER-P1.md` report.

---

## 1. BRANCH-ACCURATE COUNTRY PACK RESOLUTION

### CURRENT_CYCLE

There is **no live import cycle today** — the prior report's concern was about what WOULD be created by the most obvious-looking fix, not something already broken. Concretely: `Identity` already imports `Localisation` (`identity.module.ts`), and `Organisation` already imports `Identity` (`organisation.module.ts`, confirmed bidirectional with `forwardRef`). If `Localisation` were made to import `Organisation` (the naive fix — read `org.branches.country_code` from inside `CountryPackSettingFactQueryService`), the cycle `Localisation → Organisation → Identity → Localisation` would close. That fix was correctly rejected in the prior slice.

### POSSIBLE_ARCHITECTURES

1. **Localisation imports Organisation directly.** Rejected — closes the 3-module cycle above.
2. **Organisation imports Localisation to publish a combined "branch's effective country pack" contract.** Rejected — wrong direction (Organisation has no business reasoning about Country Pack content) and Identity already imports Localisation, so this doesn't avoid a cycle either (`Organisation → Localisation`, and `Organisation` is already imported by `Identity`, which imports `Localisation` — no NEW cycle here specifically, but it wrongly moves domain knowledge into the wrong module and duplicates what Localisation already does via `CountryPackService.resolveForBranch`/`requireEffectiveFor`).
3. **Caller-supplied jurisdiction facts (dependency inversion) — RECOMMENDED.** The **caller** (`platform-settings`, which already legitimately imports both `OrganisationModule` and `LocalisationModule` with no cycle — neither of those two modules imports `platform-settings`) resolves the branch's jurisdiction code itself, through Organisation's own published contract, and hands that already-resolved code to Localisation's existing `COUNTRY_PACK_SETTING_FACT_QUERY` (whose `countryPackCode: string` parameter is already an **opaque caller-supplied input** — it does not need to change shape at all, only which value the caller passes in it). Neither Localisation nor Organisation gains a new dependency on the other.
4. **Localisation exposes a pure, tx-free function taking a pre-loaded branch shape (the SAME pattern `requireEffectiveFor(branch: {id, countryCode, baseCurrency}, at)` and `orders.service.ts:247` already use today).** This is really architecture 3 wearing Localisation's existing API — not a new idea, an existing, already-proven precedent to reuse rather than reinvent.

This is corroborated by existing precedent already in the codebase: `Branch.countryCode` (Organisation-owned, `org.branches.country_code CHAR(2)`) and `Tenant.countryPackCode`/`CountryPack.code` (Identity/Localisation, `VARCHAR(8)`, "e.g. `EG`") are **the same value space** — `CountryPackService.requireEffectiveFor` literally does `this.registry.requireEffective(branch.countryCode, at)`, using the branch's country code directly as the pack registry key. `orders.service.ts:247` (Sales) already resolves this way: it loads the branch row itself (a **pre-existing, separate** raw-table-read debt — see note below) and calls the **pure, synchronous** `requireEffectiveFor(branch, at)`, never `resolveForBranch` (which does its own internal `withAuthContext`, and is therefore unusable from inside an already-open transaction — the same nesting hazard the prior report flagged).

**Caveat surfaced by this trace, not previously recorded:** `CountryPackService.resolveForBranch` (and `orders.service.ts`'s own inline `tx.branch.findUnique`) already read `org.branches` directly via raw Prisma from inside Sales/Localisation — an existing, undocumented instance of exactly the "table read invisible to `module-boundaries.spec.ts`, still a table-ownership violation" pattern `BRANCH_CURRENCY_QUERY`'s own docblock explicitly named and fixed **only for currency**, not for country code. This is pre-existing debt, out of this gate's authority to fix, but it means: **do not copy `orders.service.ts`'s raw-read pattern into `platform-settings` either** — the correction below must go through a contract, not replicate the debt a third time.

### RECOMMENDED_ARCHITECTURE

Extend Organisation's published `branch-currency.query.ts` contract additively — add `countryCode` to `BranchCurrencyResult` (its `find()` already loads the exact branch row that has this column; zero extra query cost, fully backward-compatible for the existing consumer, `CashClosePolicyService`) — **or**, if keeping "currency" and "jurisdiction" as conceptually separate facts is preferred, add one new sibling contract `branch-jurisdiction.query.ts` (`BRANCH_JURISDICTION_QUERY`) with the identical shape/precedent (`find(tx, {tenantId, branchId}) => {branchId, countryCode} | null`). Either is architecturally sound; the additive-field option is marginally preferred because it reuses an already-loaded row and avoids a fourth near-identical "one branch fact" query object.

`platform-settings/settings-resolver.service.ts`'s `fetchCountryPackEntry` then: if `scope.branchId` is present (already derived by `SettingsScopeService.deriveScope` for every branch/terminal-scoped request), call the extended/new Organisation contract for `countryCode` and use it; **fall back to `Tenant.countryPackCode`** only when the request is genuinely tenant/brand-only (no branch in scope — there is no more accurate answer available at that granularity, and this fallback is the CORRECT, honest behaviour for that case, not a workaround). This exactly mirrors `requireEffectiveFor`'s existing sync signature — `SettingsResolverService` already runs inside its own open transaction (`fetchLevelBreakdownInTx`), so it must call the Organisation contract's `find(tx, ...)` (transaction-aware, no second transaction — same convention `BRANCH_CURRENCY_QUERY` already documents) and then Localisation's `getSettingFact` stays exactly as it is today (still takes an opaque `countryPackCode` string — no shape change, no new Localisation dependency).

### NEW_CONTRACTS_IF_ANY

One additive field (`countryCode`) on the existing `BranchCurrencyResult`, **or** one new narrow Organisation contract (`BRANCH_JURISDICTION_QUERY`) of the identical shape to `BRANCH_CURRENCY_QUERY`. No new contract is needed on the Localisation side — `COUNTRY_PACK_SETTING_FACT_QUERY`'s existing `countryPackCode: string` input already accepts whatever the caller resolves it to be; only its doc comment needs updating to say "the resolved jurisdiction code — tenant default OR branch-resolved, at the caller's discretion" instead of implying it is always the tenant's own field.

### MODULE_BOUNDARY_IMPACT

**None beyond what already exists.** `platform-settings` already legitimately imports `OrganisationModule` (for `BRANCH_BRAND_QUERY`) and `LocalisationModule` (for `COUNTRY_PACK_SETTING_FACT_QUERY`) — this correction adds no new module-graph edge anywhere, adds no new `KNOWN_DEVIATIONS` entry, and does not touch Localisation's or Organisation's own dependency lists at all. Per instruction, **no `KNOWN_DEVIATIONS` entry is proposed or required** for this correction.

---

## 2. COUNTRY-PACK LOCK SEMANTICS

SRS §6.4, verbatim: *"FR-PLT-026 [M] — A setting SHALL be markable as locked at any level, preventing override at lower levels."* No level is carved out as exempt. Read literally, Country Pack is one of the six named levels in the same section's own cascade diagram, so the SRS text alone does not support "Country Pack is always unlocked" as a permanent architectural stance.

### COUNTRY_PACK_LOCK_REQUIRED

**Yes, in principle — per SRS text — but with no way to express it today.** `CountryPack`'s schema (`country-pack.model.ts`, `country-pack.parser.ts`) has **no generic key/value structure at all** (verified: no `lock`/`locked`/`mandatory` field anywhere in the model or parser; `orderTypeOverrides` is an unrelated concept — per-order-type tax RATE overrides, not settings-hierarchy locking). A pack cannot today declare "this generic settings key, as I define it, may not be overridden below me" because the pack format has no notion of a generic settings key at all — it only knows about its own fixed, typed facets (tax classes, currency, rounding).

### CURRENT_SUPPORT

**None.** `platform-settings`' `SettingsResolverService.fetchCountryPackEntry` hardcodes `locked: false` for every Country-Pack-sourced value, with a code comment asserting *"Country Pack facts are Localisation's own authoritative data, never an app-writable row here, so FR-PLT-026 locking does not apply to them."* This gate's own finding: **that comment is an unsupported assumption**, not a conclusion the SRS or any ratified governance decision backs — it was written to make the code buildable, not because the requirement was found to be inapplicable. It should be corrected to say plainly that Country-Pack lockability is **not yet representable**, not that it "does not apply."

### REQUIRED_MODEL_CHANGE

To genuinely support this, `CountryPack`'s SIGNED schema would need an explicit field declaring lock intent for whichever generic setting keys the pack contributes to (today, exactly one: `payments.cash_rounding_policy`) — e.g. a `locks: string[]` array of settingKeys, included in the RFC-8785 canonicalized/signed payload. This is not a small addition: it changes what a release key attests to, requires deciding how already-signed, already-distributed packs (FR-LOC-024) are treated (no `locks` field = implicitly unlocked, presumably, but that itself is a decision), and touches the parser (`country-pack.parser.ts`), the model (`country-pack.model.ts`), and the fixture/test-signing helpers (`country-pack.fixture.ts`, `country-pack.signing.fixture.ts`) used across the whole Localisation test suite.

### GOVERNANCE_DECISION_REQUIRED

**Yes.** This is a change to Localisation's authoritative signed-document format and distribution model (FR-LOC-022 signature scheme, FR-LOC-024 distribution to offline terminals) — squarely outside a settings-resolver slice's authority to decide unilaterally, and squarely the kind of decision this repository's process gates through an ADR/governance-register entry (the same class of decision ADR 0008 D-11 itself was). Recommend raising it paired with FR-PLT-028 (§6 below), since FR-PLT-028's own "versioned with effective dates" requirement for tax/rounding/service-charge already forces a Country-Pack-format conversation; deciding lock representation at the same time avoids a second format change shortly after the first.

**Until that decision lands**, the correct, honest interim posture is: Country Pack contributes a value (when eligible) but is reported as **never locked**, and the code/docs must say so as a **known gap**, not as a settled architectural conclusion. This is a required correction to the code's own comments/docblocks (not a functional change — the runtime behaviour, "Country Pack cannot currently block a lower override," does not change until the governance decision above lands and a real mechanism is built) — see CORRECTIONS_REQUIRED_BEFORE_ACCEPT.

---

## 3. PLATFORM-DEFAULT ADMINISTRATION AUTHORITY

### SRS evidence, checked directly

- **Chapter 3, Actor Catalogue, ACT-01**: *"Platform Administrator — Scope: Cross-tenant (ROS staff) — Primary Interface: Admin Console."* This actor is **explicitly named and scoped** by the SRS — it is not something this codebase would be inventing from nothing.
- **§15.2 Permission Catalogue** ("Governance & Platform" section): lists `settings.branch.manage` and `settings.tenant.manage` only. **No `settings.platform.*` or any platform-scoped permission code appears anywhere in the catalogue.** The catalogue is explicitly marked "representative rather than exhaustive; the full catalogue is maintained in Appendix C" — and Appendix C is **absent** from `ROS_SRS_v1.0.pdf`, the same gap ADR 0008 D-01 already recorded for Organisation's own permissions.
- **§15.3 Standard Roles**: every listed role (Owner, Operations Director, Brand Manager, ... Auditor, HR Officer) is tenant-scoped or narrower — **Owner ("Tenant" scope) is the widest role defined**. No row exists for a Platform Administrator role, and no role is scoped wider than "Tenant."
- **Codebase-wide search** (`ACT-01`, `Platform Administrator`, `Admin Console`) across `src/`, `docs/governance/`, `docs/adr/`: **zero hits.** This actor has never been implemented, discussed, or even mentioned anywhere in this repository's code or governance history.

### Verdict

**C. REQUIREMENT_AMBIGUOUS_NEEDS_GOVERNANCE.**

The SRS confirms the actor is *intended* to exist (ACT-01 is named, scoped "cross-tenant," and given its own distinct primary interface, "Admin Console," separate from the Web Dashboard every other actor uses) — this makes **B likely to be the eventual correct answer** once specified. But the SRS gives this codebase **no concrete authorization mechanism** to build against: no permission codes, no role definition, and the one place such a catalogue would live (Appendix C) is not present in the available material. Building a real write path today would mean inventing — unilaterally, in a settings-resolver slice — exactly the kind of authentication/authorization architecture decision (a genuinely separate, non-tenant-RLS-scoped actor and credential space, or something else entirely) that this repository's own established process gates through governance (the identical situation ADR 0008 D-01/D-02 already handled for Organisation's permissions and branch-scoped RBAC respectively).

The prior slice's "ops-seeded only, no HTTP write route" posture is confirmed **correct and should remain** until this governance decision is made: it is the only posture available that neither invents the missing actor model nor creates the cross-tenant privilege-escalation hole a naive tenant-scoped permission would open (any tenant assigning itself a hypothetical `settings.platform.manage` code to one of its own roles could rewrite every other tenant's defaults — nothing in the current RBAC model expresses "this permission may only be held by a non-tenant actor"). This is not a gap in what was BUILT; it is a gap in what the SRS SPECIFIES, correctly left unresolved rather than papered over.

---

## 4. KNOWN_DEVIATIONS REVIEW

Both entries the prior slice added are **removable right now**, with a mechanical, safe, zero-risk fix — the original "STOP before introducing a genuinely new deviation" instruction was correctly heeded in *spirit* (neither is a new architectural violation), but the actual code took a shortcut that a **more careful check of already-published contracts** would have avoided entirely. This gate finds both are category **B**, not the "mechanical, structurally-unavoidable category A" the prior report assumed.

### DEVIATION_1: `platform-settings->identity`

**WHY it exists:** `platform-settings.controller.ts` imports `JwtAuthGuard`, `PermissionGuard`, `RequirePermission`, `RequireAnyPermission`, `CurrentTenantContext`, `TenantContext` (type), and `TenantContextGuard` from six separate **private** Identity paths (`identity/auth/guards/jwt-auth.guard`, `identity/authz/guards/permission.guard`, `identity/authz/decorators/require-permission.decorator`, `identity/context/current-tenant-context.decorator`, `identity/context/tenant-context`, `identity/context/tenant-context.guard`) instead of the barrel.

**CAN_REMOVE: YES.** `src/modules/identity/contract/http.ts` (re-exported by `identity/contract/index.ts`, already imported elsewhere in the SAME file for `AuthorizationTarget`/`resourceTarget`/etc.) already publishes **every one of these seven symbols** verbatim — it exists for exactly this purpose (its own docblock: *"Rather than let [a module's] first controller add its OWN copy of that same pre-existing debt, this file publishes the identical surface as Identity's own public export"*, dated 2026-08-31, i.e. before this slice was written).

**HOW:** In `platform-settings.controller.ts`, delete the six private-path import lines and add `JwtAuthGuard, PermissionGuard, RequirePermission, RequireAnyPermission, CurrentTenantContext, TenantContextGuard` (and `type TenantContext`) to the existing `from '../identity/contract'` import block. Zero behaviour change (same classes, same DI tokens, re-exported not reimplemented) — purely an import-path correction. Removes the `platform-settings->identity` `KNOWN_DEVIATIONS` entry entirely.

### DEVIATION_2: `platform-settings->governance`

**WHY it exists:** `settings-admin.service.ts` imports `AuditService` from `governance/audit/audit.service` and `AUDIT_ACTION`/`AUDIT_ENTITY` from `governance/audit/audit.constants` (private paths); `platform-settings.module.ts` imports `AuditModule` from `governance/audit/audit.module` (also private — `isPublicSurface`'s `.module`-file exemption only covers the literal top-level `governance.module`, not a nested `audit/audit.module`).

**CAN_REMOVE: YES.** `src/modules/governance/contract/audit.ts` (re-exported by `governance/contract/index.ts`) already re-exports `AuditService`, `AuditEvent`, `AUDIT_ACTION`, `AUDIT_ENTITY`, `SENTINEL_TENANT_ID` — created specifically so a new consumer never has to add this exact deviation (its own docblock: *"Before this correction every module reached it through a PRIVATE ... path ... `AuditService` is registered `@Global()` precisely because it is meant to be consumed everywhere; this file makes that intent explicit as a published contract"*). Additionally, `AuditModule` is declared `@Global()` (`audit.module.ts:31`) — once registered in `app.module.ts` (it is), `AuditService` is injectable from **any** module without that module listing `AuditModule` in its own `imports` array at all.

**HOW:** In `settings-admin.service.ts`, import `AuditService, AUDIT_ACTION, AUDIT_ENTITY` from `'../governance/contract'` instead of the two private paths. In `platform-settings.module.ts`, delete the `AuditModule` import and its entry in `imports: [...]` entirely (redundant given `@Global()`). Removes the `platform-settings->governance` `KNOWN_DEVIATIONS` entry entirely.

**Net effect of both fixes:** `platform-settings` would carry **zero** `KNOWN_DEVIATIONS` entries of any kind — a cleaner result than most of the modules it was implicitly modelled on (which predate one or both contract files and are each individually out of scope to retroactively clean up, per each contract file's own "does not retroactively clean up any OTHER module's pre-existing entry" disclaimer).

---

## 5. STATUS REASSESSMENT

Per instruction, tests of knowingly-narrowed semantics (the fallback-to-platform e2e test for Country Pack, the seed-only Platform-Default test) are **not** counted as proof of the full requirement below.

### FR-PLT-025: **PARTIAL**

Missing backend-observable behaviour:
- The Country-Pack level resolves from the **tenant's** default `countryPackCode`, not the requested branch's actual jurisdiction (`org.branches.country_code`) — observably wrong the instant a tenant has two branches in different countries (FR-BRN-003's own scenario), which is exactly the case `CountryPackService`'s own docblock says the tenant-default field "cannot satisfy." A `GET /platform/settings/resolve?settingKey=payments.cash_rounding_policy&branchId=<branch in country Y>` for a tenant whose default is country X will silently resolve country X's pack, not Y's — an observably incorrect hierarchy resolution for that one Country-Pack-sourced key today, and for anything added to the allow-list later.
- (Minor, structural rather than behavioural) Platform-Default level's write path is intentionally absent (§3) — the resolver reads it correctly when a row exists, so this does not make resolution itself incorrect, but it does mean the level can only ever be exercised by direct DB seeding, never end-to-end through the product surface FR-PLT-025 implies exists.

### FR-PLT-026: **PARTIAL**

Missing backend-observable behaviour:
- Country Pack cannot be locked at all — no representation exists to mark it locked, so "a setting SHALL be markable as locked at any level" is false for one of the six named levels today (§2 above).
- Platform-Default-level locking is implemented by the same generic code path as every other level (verified by reading `computeEffective` — it treats all six entries uniformly) but is **not test-proven end-to-end**: `platform-settings.e2e-spec.ts` tests G/H prove tenant-locks-brand/branch/terminal and branch-locks-terminal; no test seeds a locked `PlatformDefaultSetting` row and proves it blocks a lower configured+unlocked level. This is a test-coverage gap on top of the code, not a known code defect — but per this gate's instruction not to count narrowed-semantics tests as proof, the FULL requirement ("at any level") is not demonstrated for this level either.

### FR-PLT-027: **COMPLETE** (for the inspector's own stated requirement)

The inspector mechanism itself — "showing, for any effective value, which level supplied it and what the value would be at each level" — is implemented and tested for all six levels, including reporting Country Pack's and Platform Default's states honestly (a `null`/absent value where none exists, `locked: false` for Country Pack because that is presently, accurately, true). This is marked COMPLETE deliberately distinctly from FR-PLT-025/026: the inspector is not itself deficient — it correctly reports on a resolver that has the FR-PLT-025/026 gaps above. Once those gaps are corrected, the inspector requires no further change to keep reporting them correctly (it already reads through the same `fetchLevelBreakdown` the corrected resolver would use).

---

## 6. FR-PLT-028 DESIGN DEPENDENCY

**Not implemented, not designed further than this trace — per instruction.**

Which of the four corrections above are **hard prerequisites** before FR-PLT-028 can be safely designed:

- **Branch-accurate Country Pack resolution (§1) — HARD PREREQUISITE.** FR-PLT-028 is specifically about tax class / rounding policy / service charge — all three are Country-Pack-sourced and, per FR-BRN-003 and the existing `Order.countryPackVersion` pinning precedent, are unambiguously **branch**-scoped facts, never tenant-default facts. Designing FR-PLT-028's effective-dating/pinning semantics on top of the CURRENT tenant-only resolution would bake the wrong jurisdiction model into a financial-correctness feature. Must be fixed first.
- **Country-Pack lock governance decision (§2) — HARD PREREQUISITE.** FR-PLT-028's whole premise is "financial settings, versioned with effective dates" — you cannot design how a Country-Pack-sourced, effective-dated, potentially-locked value interacts with lower-level overrides without first deciding whether/how Country Pack expresses a lock at all. Designing FR-PLT-028 first and retrofitting locking afterward risks a second incompatible format change to the signed pack document in short order.
- **Platform-Default administration authority (§3) — NOT a hard prerequisite for FR-PLT-028 specifically.** FR-PLT-028 concerns Country-Pack-sourced financial settings' effective-dating, not Platform-Default administration. It remains a real, separately-tracked open item (and FR-PLT-028's own eventual administration surface, if any, may hit the identical actor-model question — worth flagging to whoever designs it, not a blocker to *starting* that design).
- **KNOWN_DEVIATIONS cleanup (§4) — NOT a semantic prerequisite, but should land first as a matter of hygiene.** It is free, safe, and mechanical; leaving it unfixed means any FR-PLT-028 code added to `platform-settings` is likely to copy the same wrong import paths by example, compounding cleanup later for no benefit now.

Explicitly reiterated, not newly decided here, per instruction:
- **Effective dating / immutable, history-preserving financial settings**: `setting_values`/`platform_default_settings` have no effective-dating column at all (by the P1 slice's explicit, correct scope decision) — FR-PLT-028 needs its own append-only, effective-dated storage shape (mirroring `treasury.cash_close_policies`), not an in-place mutation of these tables.
- **Transaction snapshot / pinning**: already correctly implemented and unaffected for Country-Pack-sourced tax/rounding today (`Order.countryPackVersion` + `CountryPackService.requirePinned`) — this pre-existing mechanism must **not** be replaced or duplicated by FR-PLT-028; FR-PLT-028's job is deciding how the GENERIC resolver's tenant/brand/branch/terminal tiers gain the same pinning guarantee, if they are ever extended to carry financial settings.
- **Tax class, rounding policy**: remain Country-Pack-owned; per instruction, this gate does not propose moving them, and neither should FR-PLT-028's design.
- **Service charge**: confirmed (again, independently, via `order-totals.ts:103-106`'s own comment) entirely unimplemented anywhere in this codebase — `CountryPack.tax.serviceChargeTaxable` is a dormant boolean carried for exactly this future slice. FR-PLT-028 is the natural place to design it from scratch, but only after §1/§2 are settled, so the same two mistakes are not re-baked into a brand-new feature.

---

## RETURN

**AUDITED_HEAD:** `8971af759b587397cb60df4a2583fab074dc3779` (unchanged this session — read-only)

**FR_PLT_025_REASSESSED:** PARTIAL — Country-Pack tier is tenant-default-only, not branch-accurate (observably wrong for a tenant with branches in different countries); Platform-Default level has no exercisable write path.

**FR_PLT_026_REASSESSED:** PARTIAL — Country Pack has no lock representation at all (schema gap, not a code defect); Platform-Default-level locking is implemented but not test-proven.

**FR_PLT_027_REASSESSED:** COMPLETE — the inspector mechanism itself fully and honestly reports all six levels, including the FR-PLT-025/026 gaps above; no defect in the inspector's own requirement.

**BRANCH_ACCURATE_COUNTRY_PACK_SOLUTION:** Dependency inversion — `platform-settings` (already legitimately depending on both Organisation and Localisation) resolves the branch's `countryCode` itself via an additive extension to Organisation's existing `BRANCH_CURRENCY_QUERY` contract (or one new sibling `BRANCH_JURISDICTION_QUERY` of identical shape), then passes that resolved code into Localisation's `COUNTRY_PACK_SETTING_FACT_QUERY` exactly as today (its input shape needs no change). No new module-graph edge, no cycle, no new `KNOWN_DEVIATIONS` entry.

**COUNTRY_PACK_LOCK_DECISION:** Not currently representable — CountryPack's signed schema has no generic key/lock concept. SRS text does not exempt Country Pack from FR-PLT-026's "at any level," so this is a real gap, not a settled design choice; the code's current "locking does not apply to Country Pack" comment overstates what has actually been decided and should be corrected to state it as an open gap. A real fix requires a governance decision on changing Localisation's signed pack format (recommend pairing with FR-PLT-028).

**PLATFORM_DEFAULT_ADMIN_DECISION:** C — REQUIREMENT_AMBIGUOUS_NEEDS_GOVERNANCE. SRS Chapter 3 names ACT-01 "Platform Administrator" (cross-tenant, "Admin Console") explicitly, but §15.2/15.3 give it no permission codes and no role (Appendix C, where they would live, is absent from the available SRS document) — the actor is real but unspecified. The current ops-seeded-only, no-HTTP-write-route posture remains correct until that governance gap closes; building a write route now would mean inventing the missing actor/authorization model unilaterally, or risk a genuine cross-tenant privilege-escalation hole if guarded by an ordinary tenant-scoped permission.

**KNOWN_DEVIATIONS_REVIEW:** Both `platform-settings->identity` and `platform-settings->governance` are category **B — removable through already-published contracts** (`identity/contract/http.ts` and `governance/contract/audit.ts`, both created before this slice was written). Neither is structurally unavoidable "category A" plumbing debt as the prior report assumed; both were a straightforward import-path oversight. Fixing both is a zero-risk, purely mechanical correction (see §4 for exact HOW) that removes the entries entirely rather than merely justifying them.

**CORRECTIONS_REQUIRED_BEFORE_ACCEPT:**
1. Fix `platform-settings.controller.ts` to import the 7 auth/context symbols from `identity/contract` instead of 6 private Identity paths — removes `platform-settings->identity` from `KNOWN_DEVIATIONS`.
2. Fix `settings-admin.service.ts`/`platform-settings.module.ts` to import audit symbols from `governance/contract` and drop the redundant `AuditModule` import (`@Global()`) — removes `platform-settings->governance` from `KNOWN_DEVIATIONS`.
3. Implement branch-accurate Country-Pack resolution per §1's RECOMMENDED_ARCHITECTURE (Organisation contract extension + caller-side resolution in `SettingsResolverService`).
4. Correct `fetchCountryPackEntry`'s code comment (and this area's docs generally) to state Country-Pack lockability is an **open gap pending a governance decision**, not an architectural non-applicability — a docs/comment-only change, no behaviour change, until §2's governance decision lands.
5. Add an e2e test proving Platform-Default-level locking blocks a lower configured+unlocked level (closes the FR-PLT-026 test-coverage gap noted in §5; no code change implied — the generic lock-walk already appears correct by construction, this is verification only).

**GOVERNANCE_DECISIONS_REQUIRED:**
- Whether/how `CountryPack`'s signed schema should represent a generic settings-key lock (§2) — recommend pairing with the FR-PLT-028 design.
- Whether/how a Platform Administrator (ACT-01) actor, permission set, and "Admin Console" surface should be specified and implemented (§3) — a cross-cutting identity/security decision well beyond this slice, likely relevant to more than just settings.

**FR_PLT_028_PREREQUISITES:** Corrections 1 and 3 from CORRECTIONS_REQUIRED_BEFORE_ACCEPT are hard prerequisites (branch-accuracy — §1 — and the Country-Pack lock governance decision — §2). Corrections 2 and 5 (KNOWN_DEVIATIONS cleanup, lock test coverage) are not semantic prerequisites but should land first as low-cost hygiene. Platform-Default admin authority (§3) is not a blocker to *starting* FR-PLT-028's design. Effective-dating/immutable-history storage, transaction pinning, tax-class/rounding-policy ownership, and service-charge design all remain exactly as scoped in the prior report's FR_PLT_028_NEXT_SLICE — reiterated, not re-decided, here.

**SAFE_TO_KEEP_6F12C626:** Yes. Nothing in it is factually wrong, dangerous, or misrepresented — every limitation this gate found was already either implied or partially documented in the original report; this gate sharpens and formalizes them, it does not discover a hidden defect that was hidden from the reader.

**SAFE_TO_PUSH_6F12C626:** Not yet, as-is, if "push" implies presenting FR-PLT-025/026/027 as complete — this gate reassesses two of the three as PARTIAL with concrete, named, currently-missing backend-observable behaviour, and finds two of the commit's own `KNOWN_DEVIATIONS` additions were avoidable with a five-minute mechanical fix that was simply missed. None of this makes the commit unsafe to *keep* or build on top of locally; it means "done" was claimed slightly ahead of what was actually true, which this gate exists to catch before that claim reaches `main`.

**RECOMMENDED_NEXT_ACTION:** Apply corrections 1, 2, 4, and 5 from CORRECTIONS_REQUIRED_BEFORE_ACCEPT (all safe, mechanical, no governance dependency) plus correction 3 (branch-accurate resolution — also fully specified above, no governance dependency, safe to implement now) in a follow-up implementation slice; raise the two GOVERNANCE_DECISIONS_REQUIRED items for ratification before FR-PLT-028 design begins; do not push or merge until at least corrections 1–4 land and FR-PLT-025/026 can be honestly reassessed as COMPLETE (or their remaining gap re-scoped and re-documented as explicitly, deliberately deferred — as Platform-Default administration already correctly is).

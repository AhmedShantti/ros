# FULL-SRS-PLT-SETTINGS-RESOLVER-P1

**Slice:** FULL-SRS-PLT-SETTINGS-RESOLVER-P1 — FR-PLT-025 / FR-PLT-026 / FR-PLT-027 backend implementation
**Report type:** Implementation + design-gate + FR-PLT-028 compatibility-analysis report
**Authority statement:** This report is **non-authoritative evidence**. The ROS SRS (`ROS_SRS_v1.0.pdf`) and ratified governance decisions in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` and `docs/adr/*.md` remain the sole authoritative sources. Nothing in this report overrides, amends, or supersedes any ratified decision — in particular ADR 0008 D-11, which remains the controlling record of the original (deferred) `org.settings` design this slice replaces with a new design.
**Date:** 2026-09-09
**HEAD at start:** `00a1b69e4206c25dd02eab18fac086fc658ace59`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree at start:** clean except pre-existing untracked report files from prior sessions (`2026-09-08_DEMO-RELEASE-BRANCH-RECOVERY-P0_*.md`, `2026-09-09_FULL-SRS-BACKEND-COMPLETION-AUDIT-V2.md`, `2026-09-09_FULL-SRS-BACKEND-REQUIREMENT-MATRIX.csv`) — none of those were touched by this task.
**Task identifier:** `FULL-SRS-PLT-SETTINGS-RESOLVER-P1` (as given in the task brief)

---

## 0. Governance context traced before implementation

This exact area was formally **deferred**, not merely unstarted:

- **ADR 0008 D-11** (`docs/adr/0008-organisation-foundation.md:592-619`) — status **DEFERRED**. The originally-approved `org.settings(scope_type, scope_id, key, value, updated_at)` design modeled only 3 of the 6 cascade levels (no Platform Default, no Country Pack, no Terminal), had no `locked` column, no effective-dating, and **no `tenant_id`** — flagged as un-RLS-anchorable as designed. Binding instruction for whatever is built later: *"must carry `tenant_id` and a `scope_type`-aware ownership check from the first migration."*
- **`docs/governance/GOVERNANCE_DECISION_REGISTER.md`**, "P1G-1 Cash-Close Policy Ratification" (~line 6580-6650) — explicitly and repeatedly states the narrow Treasury `CashClosePolicy` substrate **is not** the generic settings platform and must not be described as implementing FR-PLT-025/026/027; the same clause is repeated for Workforce's `AttendanceSettings` (HR-1).
- **`docs/reports/claude/2026-08-30_P1G1_variance-settings-final-design-gate.md`** — the most relevant prior analysis: names the six SRS §6.4 levels verbatim, records that `identity.tenants.settings` (JSONB) is completely **inert** (no code reads/writes it), `org.brands.default_settings` is **store-and-echo only**, and `org.settings` **does not exist**.
- **`test/cash-close-policy.e2e-spec.ts:718,755`** — tests literally titled *"DOCUMENTED GAP — no inherited hierarchy exists ... (NOT FR-PLT-025 coverage)"* / *"DOCUMENTED GAP — no lock mechanism exists ... (NOT FR-PLT-026 coverage)"*.
- **`docs/reports/claude/2026-09-09_FULL-SRS-BACKEND-COMPLETION-AUDIT-V2.md`** (same date, prior session) — confirms this gap is still open and is now blocking `FR-INV-046`/`FR-INV-058` (Inventory approval thresholds) and 2 HRM overtime items.

Conclusion drawn before writing any code: this task is the dedicated design/build slice ADR 0008 D-11 itself anticipated ("a design exercise, not a foundation task"), not a reopening of a settled decision. The SRS §6.4 hierarchy, FR-PLT-025/026/027 semantics, and D-11's binding `tenant_id`/ownership-check instruction are all unambiguous enough to implement without a **new** governance decision on the core semantics. One genuine gap requiring an explicit, narrowed scope decision *was* found — see §"Platform Default write surface" under OWNERSHIP_DECISION / BLOCKERS_OR_UNCERTAINTIES below — and is handled by narrowing scope, not by inventing new authorization architecture.

---

## 1. Trace of current state (Section 0 of the task)

- **No generic settings/config/policy model exists.** `grep`-verified: no `Setting`/`Config`/`Policy` Prisma model with `key`/`value`/`locked`/`scope` columns anywhere in `prisma/schema.prisma`. `identity.tenants.settings` (JSONB) and `org.brands.default_settings`/`theme` (JSONB) exist but are confirmed **unused** (no `src/` code reads or writes `tenant.settings`; `brand.defaultSettings`/`theme` are passed through verbatim by `BrandsService` with zero resolution logic) — left untouched by this slice.
- **Existing "resolver"-named code is unrelated or intentionally narrow and MUST NOT be repurposed:**
  - `CashClosePolicyResolver` (Treasury) — single-branch, no lock, no hierarchy; its own module-header docblock says it is "Treasury-PRIVATE... NOT a contract export."
  - `RoutingConfigQuery`/routing resolvers (Kitchen/Organisation), `PriceResolutionService` (Catalogue) — different domains entirely.
  - `*-target.resolvers.ts` files across every module are RBAC **authorization**-target resolvers (an unrelated concept from the identity-authz B1-3 lattice), not settings resolvers.
- **Platform module** (`src/modules/platform/`) owns exactly two things — DB partitioning and the durable scheduled-job runner — and has **zero HTTP controllers** and **zero permission codes**. Its own docblock states, as a stated architectural invariant: *"This module still imports zero domain modules, and always will."*
- **Organisation module** is the ADR 0008 D-11-implied storage owner for the originally-imagined `org.settings` table, but Organisation does not own Tenant (Identity) or Terminal (Identity), so it cannot alone host a resolver spanning all six levels.
- **Localisation module** (Country Pack) publishes exactly three narrow `contract/` queries today (`PINNED_PAYMENT_POLICY_QUERY`, `TAX_CLASS_LABELS_QUERY`, `SELLABLE_TAX_CLASSES_QUERY`) — no generic "country pack setting" surface existed before this slice.
- **Auth/authorization**: `settings.tenant.read`/`settings.tenant.manage`/`settings.branch.read`/`settings.branch.manage` already exist (Organisation, ADR 0008 D-01, SRS §15.2 verbatim codes) and are already reused cross-module by Treasury as plain re-declared string literals. **No `platform.*` permission code exists**, and — critically — **no cross-tenant "platform administrator" actor/authorization concept exists anywhere in this codebase**: every authenticated route runs inside a tenant's RLS context established by `TenantContextGuard`, and there is no route, guard, or permission scoped outside a tenant. This is the load-bearing fact behind the Platform-Default write-surface scope decision below.
- **Audit**: `AuditService.record(tx, event)` is the established, mandatory-in-transaction writer; FR-AUD-006 ("configuration changes") is already the documented authority for auditing exactly this kind of write (P1G-1 ratification, `GOVERNANCE_DECISION_REGISTER.md:6637-6639`).
- **RLS convention**: every tenant-scoped table gets `ENABLE`+`FORCE ROW LEVEL SECURITY` and four policies keyed on `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` (fail-closed on missing context). `identity.tenants` and `identity.permissions` are the two precedents for a genuinely global, non-tenant table carrying **no** RLS at all.
- **Module-boundary convention** (`src/modules/module-boundaries.spec.ts`): a module's only legal cross-module import is another module's `contract/` barrel (interfaces/tokens only, mechanically enforced) or the target module's own `<module>.module.ts` class (DI wiring). A `KNOWN_DEVIATIONS` allow-list freezes pre-existing debt; the file's own docblock explicitly anticipates a module's *first* HTTP controller adding the same "cross-cutting HTTP/auth plumbing" category entries every other HTTP module already carries (cites Workforce/HR-1 as precedent) — this slice's `platform-settings->identity`/`platform-settings->governance` entries follow that exact, already-sanctioned pattern.

---

## 2. OWNERSHIP_DECISION

**New, dedicated module: `src/modules/platform-settings/`** (not an addition to `PlatformModule`).

Reasoning: `PlatformModule`'s own docblock states, as a deliberate architectural invariant, that it imports zero domain modules "and always will" — the rationale given is keeping the elevated partition-admin DB connection unreachable from anywhere else. Implementing FR-PLT-025/026/027 correctly requires importing Identity (terminal facts, RBAC lattice, audit) and Organisation (branch/brand hierarchy) and Localisation (Country Pack). Extending `PlatformModule` to do this would either silently contradict its own documented guarantee, or require rewriting that guarantee — neither of which this slice's scope authorizes unilaterally. A new, sibling bounded-context module avoids the conflict entirely, needs no `KNOWN_DEVIATIONS` growth beyond the same category every other HTTP module already carries, and keeps `PlatformModule`'s existing invariant intact and true.

Storage lives in the **`platform`** Postgres schema (SRS §25.1 names `platform` for exactly this kind of cross-cutting substrate), owned by the new module — not literally inside `PlatformModule`'s own code, which is a separate, narrower distinction (schema ownership vs. NestJS module ownership).

### Platform Default write surface — the one scope decision that required narrowing, not stopping

This codebase has **zero** concept of a cross-tenant "platform administrator" actor. Every authenticated write goes through `TenantContextGuard` inside one tenant's RLS context; `RolePermission` assignment is always scoped to one tenant's own `Role`. If an HTTP write route for Platform-Default values were guarded by an ordinary tenant-scoped permission (even a newly-invented one), **any tenant able to assign that permission code to one of its own roles could rewrite every other tenant's platform defaults** — a genuine cross-tenant privilege-escalation hole this schema alone cannot prevent, because nothing in the existing RBAC model expresses "this permission may only be held by a non-tenant actor."

Building a real cross-tenant admin-actor model is a security-architecture decision squarely outside this slice's authority (and outside its instructed scope — the task explicitly forbids inventing a new permission where none is warranted and asks for the *narrowest* route). Resolution: **Platform Default is read-through / lock-aware / inspector-visible, but has no HTTP write route this slice.** It is stored in its own table (`platform_default_settings`, genuinely global, no RLS — same posture as `identity.permissions`) and seeded only through a trusted, non-HTTP path (migration/ops/direct DB access), exactly as `identity.permissions` itself already is. This is recorded as a blocker for whoever designs the next slice, not silently glossed over — see BLOCKERS_OR_UNCERTAINTIES.

---

## 3. COUNTRY_PACK_BOUNDARY

Country Pack configuration is **never copied** into `platform.setting_values`/`platform_default_settings`. A new, narrow Localisation `contract/` surface, `COUNTRY_PACK_SETTING_FACT_QUERY` (`src/modules/localisation/contract/country-pack-setting-fact.query.ts`), answers exactly the settings-hierarchy question — "does this generic key have a Country-Pack-sourced value?" — for a small, explicit, honestly-published allow-list of keys (`COUNTRY_PACK_SETTING_KEYS` in the private implementation), currently exactly **one**: `payments.cash_rounding_policy` (mapped from `CountryPack.currency.cashRounding` + `CountryPack.tax.roundingMode`/`roundingPrecision`). Every other `settingKey` gets an honest `undefined` ("no Country Pack representation") — never a fabricated value.

**Documented, deliberate limitation:** the query resolves the pack via `Tenant.countryPackCode` (the tenant-wide default), **not** per-branch `org.branches.country_code`. `CountryPackService`'s own docblock states plainly that `identity.tenants.country_pack_code` is "deliberately NOT used" for real pricing (FR-BRN-003 requires two branches of one tenant to resolve to different packs). This settings resolver's Country-Pack tier can be asked at tenant/brand-only granularity where no branch exists to derive a jurisdiction from at all, and reaching Organisation's per-branch data from Localisation would close a three-module import cycle (Localisation → Organisation → Identity → Localisation, since Identity already imports Localisation and Organisation already imports Identity) that this slice is not the place to open. This is recorded explicitly in the contract file's own docblock and here — not a silent bug. Proper per-branch, effective-dated Country-Pack integration is exactly what FR-PLT-028 (explicitly out of scope) should design.

---

## 4. DATA_MODEL_ADDED

Two new tables, deliberately **not one**, because Platform Default cannot share a per-tenant RLS posture with the other four levels:

```
model PlatformDefaultSetting {        // platform.platform_default_settings
  id, settingKey (UNIQUE), value (Json), locked, createdBy, createdAt, updatedAt
  // NO tenant_id. NO RLS (see OWNERSHIP_DECISION above — same posture as
  // identity.permissions, the repo's only other table with none).
}

enum SettingLevel { tenant brand branch terminal }   // @@schema("platform")

model SettingValue {                  // platform.setting_values
  id, tenantId, level (SettingLevel), targetId, settingKey, value (Json),
  locked, createdBy, createdAt, updatedAt
  @@unique([tenantId, level, targetId, settingKey])
  // tenant_id IS a real FK to identity.tenants (ADR 0008 D-11's binding
  // instruction). target_id is POLYMORPHIC by level (tenant/brand/branch/
  // terminal id) and therefore carries NO direct FK of its own — Postgres
  // cannot FK one column to four different parent tables selected by a
  // discriminator. Every write validates the target's existence AND tenant
  // ownership through the OWNING module's published contract
  // (BRANCH_BRAND_QUERY / TERMINAL_FACTS_QUERY) before the row lands — an
  // application-level invariant, not a DB one; this is the SAME limitation
  // ADR 0008 D-11 flagged for the original design, now narrowed to exactly
  // the one column a cross-schema FK genuinely cannot express, rather than
  // left on tenant_id too (which now IS a real FK, unlike the deferred
  // design).
}
```

Country Pack (SRS §6.4's second tier) and Platform Default's *write path* are, by design, **not** rows a tenant actor can create through this schema alone — see §2 and §3.

## MIGRATION

`prisma/migrations/20260909120000_platform_settings_resolver/migration.sql` — hand-written (a `prisma migrate dev` diff against the live dev DB pulled in a large amount of **pre-existing, unrelated** FK/index-rename drift between the committed migration history and `schema.prisma`'s default naming; that generated migration was discarded entirely and NOT used). Contains: `CREATE TYPE "platform"."SettingLevel"`, both `CREATE TABLE`s, the composite unique index, both FKs, `GRANT`s, and — for `setting_values` only — `ENABLE`+`FORCE ROW LEVEL SECURITY` plus the standard four `app.tenant_id`-predicate policies (identical shape to `treasury.cash_close_policies`/`platform.job_schedules`). Applied via `prisma migrate deploy` against the worktree's dev DB (`ros-postgres-lane-d`, port 5566); `prisma migrate status` reports clean; `prisma generate` regenerated the client.

## SETTING_LEVELS

Represented as a 6-member TypeScript union `SettingHierarchyLevel = 'platform' | 'country_pack' | 'tenant' | 'brand' | 'branch' | 'terminal'` (`platform-settings/settings-hierarchy.types.ts`) for the resolver/inspector's *output*, separate from the narrower 4-member Prisma `SettingLevel` DB enum (only the levels that are ever real storage rows). This is deliberate, not an oversight — `platform` and `country_pack` are never DB rows in `setting_values` (see §2/§3), so giving them a DB enum member would be misleading.

## SETTING_KEY_MODEL

`settingKey VARCHAR(120)`, validated by `assertValidSettingKey` (`platform-settings/settings-key.util.ts`) against `^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$` (lower_snake, dot-separated segments — e.g. `payments.cash_rounding_policy`) — chosen so a key is always a safe, un-encoded URL path segment and greppable across the codebase, mirroring the existing `permissions.code` convention.

---

## RESOLUTION_ALGORITHM

`SettingsResolverService.fetchLevelBreakdown`/`fetchLevelBreakdownInTx` (`platform-settings/settings-resolver.service.ts`) is **the one authoritative resolver** — the HTTP controller, the inspector, and the published `EFFECTIVE_SETTING_QUERY` contract all call into it; the precedence/lock walk exists in exactly one place.

1. `SettingsScopeService.deriveScope` (`settings-scope.service.ts`) validates and derives the full scope from whatever subset of `brandId`/`branchId`/`terminalId` the caller supplied, in this precedence: `terminalId` → derives `branchId` (via Identity's published `TERMINAL_FACTS_QUERY`) → derives `brandId` (via Organisation's published `BRANCH_BRAND_QUERY`). A caller-supplied id that contradicts a derived one (branch/brand mismatch, terminal/branch mismatch) is rejected (404) — never silently overwritten. Every check runs inside the caller's own tenant-scoped `withAuthContext` transaction, so a cross-tenant id is simply invisible (the same fail-closed shape `AuthorizationTargetResolver` already uses) — this is what makes tests N and O pass.
2. One entry is fetched per level, in SRS §6.4 order (`platform, country_pack, tenant, brand, branch, terminal`), each level marked `eligible` (was there an id deep enough to reach it / does `country_pack` have a representation for this key) and, if eligible, `hasConfiguredValue`/`configuredValue`/`locked`.
3. `computeEffective` walks the entries **top to bottom**: the first eligible configured value becomes (so far) effective; a later eligible configured value overrides it; the walk **stops** the instant it passes a configured, **locked** level — nothing lower may then win, matching the SRS's own worked example ("tenant C, locked ... branch D exists ... branch D does NOT win") exactly.

## LOCK_ALGORITHM

FR-PLT-026 is enforced in **two** places, per the task's explicit instruction ("Do not implement lock enforcement only in the client"):

- **Read-time**: the `computeEffective` walk above — a locked configured level is terminal; nothing below it is ever read into the effective value, regardless of what rows exist there.
- **Write-time**: `SettingsAdminService.assertNotBlockedByHigherLock` re-runs the same resolver walk for the write's own ancestor chain and rejects (`409 Conflict`) any write whose target level sits **below** an already-configured, already-locked ancestor — "writes attempting an illegal lower-level override must be rejected server-side" (proves test I; test G proves both halves together).

`EffectiveSettingResult` returns `isLocked`/`lockedAtLevel`/`lockedByTargetId` — the exact FR-PLT-026 requirement ("expose enough information for clients to identify the locking level").

## WRITE_ENFORCEMENT

`SettingsAdminService` (`settings-admin.service.ts`) — `upsert`/`unset`, for **tenant/brand/branch/terminal only** (Platform Default and Country Pack are not writable through this service — see §2/§3). Every write: validates the target through `SettingsScopeService` (same hierarchy-consistency check the resolver uses), checks for a blocking higher lock, performs the Prisma `upsert`/`delete`, and calls `AuditService.record` in the **same transaction** (FR-AUD-006 "configuration changes", the exact precedent `CASH_CLOSE_POLICY_VERSION_CREATED` already established) — two new verbs, `SETTING_VALUE_UPSERTED`/`SETTING_VALUE_UNSET` (`governance/audit/audit.constants.ts`).

## INSPECTOR_CONTRACT

`SettingsInspectorService.inspect` (`settings-inspector.service.ts`) calls `SettingsResolverService.fetchLevelBreakdown` (never re-implements the walk) and annotates every one of the six levels with `eligible`/`targetId`/`configuredValue`/`locked`/`isEffectiveSource`/`shadowedByLowerOverride`/`blockedByHigherLock` — exactly the FR-PLT-027 checklist ("which level supplied the effective value; what value exists at each level ... whether it was shadowed by a lower override; whether it was blocked by a higher lock"), with no internal DB/security metadata exposed.

---

## READ_ROUTES

- `GET /platform/settings/resolve?settingKey=&brandId=&branchId=&terminalId=` — FR-PLT-025/026, returns `EffectiveSettingResult`.
- `GET /platform/settings/inspect?settingKey=&brandId=&branchId=&terminalId=` — FR-PLT-027, returns `SettingsInspectorResult` (all 6 levels).

Both use a custom `ScopeTargetResolver` (`PlatformSettingsScopeTargetResolver`) plugged into the existing B1-3 `@AuthorizationTarget(resourceOrTenantTarget(...))` machinery — the deepest of `brandId`/`branchId`/`terminalId` supplied determines the authorization target (falling back to `tenant` when none is given), reusing the SAME hierarchy-derivation logic the resolver itself uses, so a read's authorization target and a write's hierarchy validation never disagree.

## WRITE_ROUTES

One `PUT`+`DELETE` pair per storable level:

```
PUT/DELETE /platform/settings/tenant/:settingKey
PUT/DELETE /platform/settings/brand/:brandId/:settingKey
PUT/DELETE /platform/settings/branch/:branchId/:settingKey
PUT/DELETE /platform/settings/terminal/:terminalId/:settingKey
```

`PUT` body: `{ value: <any JSON>, locked?: boolean }`. `PUT` carries `@Idempotent()` (FR-API-020 convention, mirrors `CashClosePolicyController`'s write route). No route exists for `platform` or `country_pack` — see §2/§3.

## PERMISSIONS

**Zero new permission codes minted** — "Do NOT invent a permission if an existing suitable one exists" is satisfied exactly:

| Route family | Permission | Why |
|---|---|---|
| tenant/brand read | `settings.tenant.read` (`RequireAnyPermission` w/ branch.read) | Brand is a "tenant-level object" per ADR 0008 D-01 |
| tenant/brand write | `settings.tenant.manage` | same |
| branch/terminal read | `settings.branch.read` | |
| branch/terminal write | `settings.branch.manage` | Terminal has no RBAC scope tier of its own (the lattice only has tenant/brand/branch — `authz/scope.ts`); a terminal write is authorized at the branch owning it, mirroring `IDENTITY_TERMINAL_TARGET_RESOLVER`'s own posture. |

Both codes are already seeded by Organisation (`ORGANISATION_PERMISSION_DEFS`); imported directly from the already-public `organisation/contract` barrel (not re-declared as a local string literal, unlike Treasury's narrower precedent — this module already legitimately depends on `organisation/contract` for `BRANCH_BRAND_QUERY`, so importing the SAME public barrel's permission constants adds no new coupling).

## AUDIT_BEHAVIOUR

Every `upsert`/`unset` writes exactly one `governance.audit_entries` row in the SAME transaction as the data mutation (`AUDIT_ACTION.SETTING_VALUE_UPSERTED` / `SETTING_VALUE_UNSET`, `AUDIT_ENTITY.SETTING_VALUE`), per FR-AUD-006. No read is audited (matches the existing repo-wide convention — reads are not audited elsewhere either, e.g. `CashClosePolicyController`'s GET).

## TENANT_ISOLATION

`platform.setting_values` carries `ENABLE`+`FORCE ROW LEVEL SECURITY` and the standard four fail-closed `app.tenant_id` policies (test R proves this directly at the DB layer: a tenant-B session sees zero of tenant-A's rows). `platform_default_settings` has no `tenant_id` and no RLS by design (§2) — it is not tenant data.

## MODULE_BOUNDARY_STATUS

`npx jest src/modules/module-boundaries.spec.ts src/modules/authorization-coverage.spec.ts` — **clean, 55/55**. Two new `KNOWN_DEVIATIONS` entries added (`platform-settings->identity`, `platform-settings->governance`) — the SAME "cross-cutting HTTP/auth plumbing" category every other HTTP module already carries, explicitly anticipated by that file's own docblock for a module gaining its first controller (cites Workforce/HR-1 as the precedent). No new **domain** deviation was added — every cross-module domain read (`BRANCH_BRAND_QUERY`, `TERMINAL_FACTS_QUERY`, `COUNTRY_PACK_SETTING_FACT_QUERY`, `ORGANISATION_PERMISSIONS`) goes through a published `contract/` barrel.

---

## FR_PLT_025_STATUS

**Backend hierarchical resolver implemented and tested end-to-end** for all six SRS §6.4 levels: Platform Default (read/lock, seed-only — see §2), Country Pack (one honestly-supported key, documented tenant-wide-default limitation — see §3), Tenant, Brand, Branch, Terminal (fully read+write, hierarchy-validated, RLS-isolated). Precedence, hierarchy-consistency rejection (cross-tenant, mismatched branch/brand/terminal), and a published cross-module contract (`EFFECTIVE_SETTING_QUERY`) are all in place. **NOT claimed complete**: Platform-Default administration (no HTTP write path — deliberate, documented scope narrowing, not a defect in what was built).

## FR_PLT_026_BACKEND_STATUS

**Implemented and enforced server-side at both read and write time** (see LOCK_ALGORITHM). `isLocked`/`lockedAtLevel`/`lockedByTargetId` exposed on every effective-value response.

## FR_PLT_027_BACKEND_STATUS

**Implemented.** `GET /platform/settings/inspect` returns every level, its configured value (or `null`), lock state, and whether it is the effective source / shadowed / lock-blocked.

## FR_PLT_028_CURRENT_TRACE

Per task instruction, traced for compatibility only — **no FR-PLT-028 code was written**, tax rates were not moved out of Country Packs, Sales tax calculation was not touched, and no service-charge behaviour was added.

| | Tax class | Rounding policy (cash) | Service charge |
|---|---|---|---|
| **CURRENT_OWNER** | Localisation (`fiscal.tax_classes` + `CountryPack.tax.classes`); read/validate surface published via `SELLABLE_TAX_CLASSES_QUERY`/`TAX_CLASS_LABELS_QUERY` | Localisation (`CountryPack.currency.cashRounding` + `CountryPack.tax.roundingMode`/`roundingPrecision`) | **No owner — not implemented.** `CountryPack.tax.serviceChargeTaxable` is a bare boolean, explicitly commented *"Carried for the service-charge slice; unused until that exists."* No rate, no policy, no computation anywhere. |
| **CURRENT_VERSIONING** | `CountryPack.code` + `.version` (e.g. `EG` / `2026.1`); `CountryPackRegistry.activate()` refuses to re-register a version with a different `effectiveFrom` (immutable once published, FR-LOC-021) | Same pack, same version — rounding is one field of the same `CountryPack` object as tax | N/A |
| **CURRENT_EFFECTIVE_DATE_MODEL** | `CountryPackRegistry.resolveEffective(code, at)` — latest `effectiveFrom <= at`, ties broken by descending version | Same mechanism (same object) | N/A |
| **CURRENT_TRANSACTION_SNAPSHOT_BEHAVIOUR** | **Already correctly implemented and unaffected by this slice**: `sales.orders.country_pack_version` pins the exact `(code, version)` at order-creation time (`schema.prisma:2064`); every later interpretation goes through `CountryPackService.requirePinned(code, version)` — a pure `(code, version)` lookup, so activating a newer pack can never move a historical order onto a different rate. | Same pinning mechanism (same pack object) | N/A — nothing to snapshot |
| **HOW_FR_PLT_028_SHOULD_INTEGRATE_WITH_THIS_RESOLVER** | This resolver's Country-Pack tier (`COUNTRY_PACK_SETTING_FACT_QUERY`) resolves the pack **effective now**, from the **tenant's** default code (§3's documented limitation) — correct for a live settings inspection, wrong for FR-PLT-028's "effective-dated financial settings interpreted at transaction time." FR-PLT-028 needs a SEPARATE, pinned-version-aware resolution path (mirroring `requirePinned`, not `requireEffective`) and, to be branch-accurate, must resolve the jurisdiction from the branch (`org.branches.country_code`) the transaction actually belongs to, not the tenant default — which in turn means FR-PLT-028 is the right place to finally decide how Localisation and Organisation should be connected (the three-module cycle problem noted in §3), since it is the first consumer that genuinely needs branch-accurate, transaction-time pinning rather than "what applies right now." The `setting_values`/`platform_default_settings` tables this slice adds have **no effective-dating column at all** (deliberately, per task instruction) — FR-PLT-028 will need its own append-only, effective-dated variant (mirroring `treasury.cash_close_policies`' `effectiveFrom`-versioned shape) rather than an in-place mutation of these tables, to preserve "the value re-readable as-of a past instant" the way `CashClosePolicy`/`DayClose` already do. |

## FR_PLT_028_NEXT_SLICE

Recommend the next slice (not started, not designed beyond the trace above):
1. Decide whether FR-PLT-028's financial-setting tiers get their own effective-dated table(s) (mirroring `CashClosePolicy`) or extend `setting_values` with an `effective_from`/immutable-versioning column — the latter would need `setting_values`' current `UPDATE`/`DELETE` grants revisited (currently mutable, matching this slice's explicit "no effective-dating" scope).
2. Decide how (or whether) to resolve the Localisation↔Organisation branch-accuracy gap this report's §3 documents, since FR-PLT-028 is the first real consumer that needs it.
3. Decide the actual financial semantics (tax class / rounding / service charge as *settings*, vs. remaining Localisation/Sales-owned computation with this resolver only exposing *administrative overrides*) — explicitly out of this slice's authority per the task brief.

---

## TESTS

**Unit** (`npx jest`, no DB): `src/modules/localisation/country-pack/country-pack-setting-fact.query.service.spec.ts` — 4/4, new. Proves the Country-Pack tier's own mapping produces a real value once a pack is genuinely activated (signed with an ephemeral in-memory Ed25519 key, the SAME fixture convention `country-pack.registry.spec.ts` already uses) — no e2e suite in this repository activates a real pack (`COUNTRY_PACK_DIR` unset by default), so this is the correct place to prove that half.

**Architecture** (`npx jest`, no DB): `src/modules/module-boundaries.spec.ts` + `src/modules/authorization-coverage.spec.ts` — 55/55 (test S).

**E2E** (`npm run test:e2e` scoped to this file only, real Postgres via the repo's per-suite DB-isolation harness): `test/platform-settings.e2e-spec.ts` — **12/12**, covering every lettered requirement:

| Letter | Covered by |
|---|---|
| A | platform default resolves when nothing overrides |
| B | (reframed — see §3) no-pack-activated fallback proven e2e; override composition proven at unit level |
| C-F | tenant → brand → branch → terminal, one test walking all four overrides |
| G | tenant lock blocks brand/branch/terminal (both read-time AND write-time — test I lives here) |
| H | branch lock blocks terminal |
| J | unset restores inheritance; unsetting twice is a clean 404 |
| K-M | inspector effective source, all 6 levels listed in order, shadowed vs. lock-blocked (pre-existing-row-beneath-a-later-lock scenario, matching the SRS's own worked example) |
| N | cross-tenant brand/branch ids rejected on both read and write |
| O | brand/branch and branch/terminal hierarchy mismatches rejected |
| P | unauthorized actor (no permission) → 403 on tenant and branch writes |
| Q | no HTTP route exists at all for Platform-Default writes → 404, for any actor including the tenant owner |
| R | RLS: a tenant-B session sees zero of tenant-A's `setting_values` rows |
| S | module-boundary/authorization-coverage suites (above) |

Pre-existing localisation unit suite re-run for regression: `npx jest src/modules/localisation` — 164/164, unaffected.

Full E2E suite was **not** run (task instruction: "Do NOT run the full E2E suite. Run targeted relevant suites only.").

## TYPECHECK

`npx tsc --noEmit` — clean.

## BUILD

`npm run build` (`nest build`) — clean.

## OPENAPI

`npm run openapi:generate` — regenerated `docs/api/openapi.json`/`.yaml` (additive: the new `platform-settings` routes only).

## LINT

`npx eslint <every changed/new file> --fix` then re-run without `--fix` — **0 errors** (2 harmless "not a `.ts` file" warnings for the new migration `.sql` and `schema.prisma` themselves, from an overbroad glob — not real findings).

---

## FILES_CHANGED

**New:**
```
prisma/migrations/20260909120000_platform_settings_resolver/migration.sql
src/modules/localisation/contract/country-pack-setting-fact.query.ts
src/modules/localisation/country-pack/country-pack-setting-fact.query.service.ts
src/modules/localisation/country-pack/country-pack-setting-fact.query.service.spec.ts
src/modules/platform-settings/contract/effective-setting.query.ts
src/modules/platform-settings/contract/index.ts
src/modules/platform-settings/dto/resolve-settings-query.dto.ts
src/modules/platform-settings/dto/upsert-setting-value.dto.ts
src/modules/platform-settings/effective-setting.query.service.ts
src/modules/platform-settings/platform-settings-scope-target.resolver.ts
src/modules/platform-settings/platform-settings.controller.ts
src/modules/platform-settings/platform-settings.module.ts
src/modules/platform-settings/platform-settings.views.ts
src/modules/platform-settings/settings-admin.service.ts
src/modules/platform-settings/settings-hierarchy.types.ts
src/modules/platform-settings/settings-inspector.service.ts
src/modules/platform-settings/settings-key.util.ts
src/modules/platform-settings/settings-resolver.service.ts
src/modules/platform-settings/settings-scope.service.ts
test/platform-settings.e2e-spec.ts
docs/reports/claude/2026-09-09_FULL-SRS-PLT-SETTINGS-RESOLVER-P1.md (this report)
```

**Modified:**
```
prisma/schema.prisma                                    (+PlatformDefaultSetting, +SettingValue, +SettingLevel enum, +2 back-relations)
src/app.module.ts                                        (+PlatformSettingsModule)
src/modules/governance/audit/audit.constants.ts           (+SETTING_VALUE_UPSERTED/UNSET, +SETTING_VALUE entity)
src/modules/localisation/contract/index.ts                 (+country-pack-setting-fact.query re-export)
src/modules/localisation/localisation.module.ts             (+CountryPackSettingFactQueryService wiring)
src/modules/module-boundaries.spec.ts                       (+2 KNOWN_DEVIATIONS entries, category (a), see MODULE_BOUNDARY_STATUS)
docs/api/openapi.json / docs/api/openapi.yaml               (regenerated, additive)
docs/reports/claude/INDEX.md                                (this entry appended)
```

## COMMIT

Per task instruction §11 ("Commit source + tests + generated OpenAPI + report. Do NOT push."), committed as `6f12c62692ea5281d4de24038ac386cfa4759391` on `full-srs/lane-d4-reporting-demo`. Not pushed.

## SAFE_TO_INTEGRATE

**Yes, with the documented scope narrowing understood by whoever reviews it:**
- No existing route, permission, table, or module was modified in a way that changes prior behaviour (every change is additive: new tables, new module, new contract, two new audit verbs, two new module-boundary allow-list entries of an already-established category).
- `tsc`/`build`/`openapi:generate`/targeted tests/lint all clean.
- Two deliberate, explicitly-documented scope boundaries a reviewer should know about before treating this as "FR-PLT-025/026/027 done": (1) Platform-Default has no HTTP write path (§2); (2) the Country-Pack tier is tenant-default-only, not branch-accurate (§3). Neither is silently glossed over — both are named in this report, in the code's own docblocks, and in a dedicated e2e test each (Q and B respectively).

## BLOCKERS_OR_UNCERTAINTIES

1. **Platform-Default administration has no safe HTTP write path today.** Building one requires a genuine cross-tenant "platform administrator" authorization concept this codebase does not have anywhere — a security-architecture decision, not an implementation detail, and outside this slice's authority to invent unilaterally. Recommend a dedicated design-gate before FR-PLT-028 (which likely also needs a global/administrative actor for pack-level financial-setting administration) rather than solving it ad hoc per-slice.
2. **Country-Pack tier is tenant-default-only** (§3) — correct for a live "what applies now" resolve/inspect, not branch-accurate, and explicitly not sufficient for FR-PLT-028's transaction-time semantics. Fixing it properly means deciding how to break (or route around) the Localisation↔Identity↔Organisation three-module cycle noted in §3 — a design question for the FR-PLT-028 slice, not resolved here.
3. `setting_values` has **no effective-dating** at all (by explicit task instruction) — every write is an immediate, mutable upsert. This is correct for FR-PLT-025/026 alone but is exactly the gap FR-PLT-028 exists to close; do not extend this table in place without first deciding point 1 above under FR_PLT_028_NEXT_SLICE.

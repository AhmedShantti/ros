# P1G-1 — Cash-Close Policy Substrate Implementation (Migration 33)

**Report type:** Implementation report (migration, production code, tests, verification evidence).
**Authority statement:** This report is **non-authoritative evidence**. Authority order: **(1) `ROS_SRS_v1.0.pdf` → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md`, specifically the "P1G-1 Cash-Close Policy Ratification — 2026-08-30" entry (R-1(a)..R-5, C-1, C-2) → (3) the repository at HEAD `1f9ea1f` → (4) `docs/reports/claude/2026-08-30_P1G1_variance-settings-final-design-gate.md` → (5) engineering inference only where authority is silent, labelled as such.**
**Date:** 2026-08-30
**Starting HEAD:** `1f9ea1f` — *feat: add governance approval runtime* (unchanged throughout — no commit performed)
**Branch:** `feat/production-spec`
**Working tree at start:** the register carried the uncommitted "P1G-1 Cash-Close Policy Ratification — 2026-08-30" entry, plus the two prior 2026-08-30 reports and four earlier uncommitted reports, all preserved untouched by this task.
**Working tree at report time:** the above, plus one new migration (33), one new Prisma model + enum, one new Treasury sub-module (`cash-close-policy/`), one new e2e test file, three existing e2e test files updated (a pre-existing hard-coded table/route assertion each needed a one-line addition), two audit-constants additions, one permissions-file addition, one views-file addition, two module-wiring edits, the regenerated OpenAPI documents, and this report. **Nothing committed, nothing pushed.**
**Task identifier:** P1G-1 cash-close policy substrate implementation (migration 33)

> ## VERDICT
> ## **A. CASH-CLOSE POLICY SUBSTRATE IMPLEMENTATION COMPLETE**
>
> The narrow, ratified Treasury cash-close policy substrate (R-1(a)/R-2(a)/R-3(a)/
> R-4(a)/R-5, C-1, C-2) is implemented exactly to the accepted design. Migration
> **33** applied cleanly from a fresh scratch DB three times in a row (1→33, all
> 33 migrations); the persistent local `ros` DB was **never** touched (still 26
> `_prisma_migrations` rows, newest `20260823030000_kitchen_ticket_persistence`,
> `treasury.cash_close_policies` absent). OpenAPI regenerated to **3.1.0 / 139**
> operations (138→139, one new route, **zero deletions** in either the JSON or
> YAML document). Full regression: **746/746 unit, 904/904 e2e** (877 baseline +
> 27 new), **38/38 module-boundary** tests, zero new `KNOWN_DEVIATIONS` entries.
> **CashSession Close itself is NOT implemented** — this slice is the settings
> substrate only, exactly as scoped.
>
> **No implementation defect required a fix during this session.** Four
> *pre-existing* e2e tests failed on first full-suite run because they assert
> exact, hard-coded table/route inventories (`treasury.*`, the OpenAPI document)
> — the same maintenance every prior Treasury/Governance migration in this
> repository has required of its own author. Each was updated by one line (or a
> regenerated document) to acknowledge the new, ratified table/route; no
> assertion's *meaning* changed, and each still proves its original boundary
> ("only these tables exist", "no route is undocumented").

---

## 0. SCOPE FENCE — RECONFIRMED (§34 of the brief)

**Implemented in this slice, and only this:** the `treasury.cash_close_policies` table (migration 33), its Prisma model/enum, the Treasury-private resolver, the administration write route + service, `settings.branch.manage` authorization, idempotency, audit, RLS/grants, and the full test matrix.

**Explicitly NOT implemented — confirmed absent from every file touched:**

| Item | Status |
|---|---|
| CashSession close | **NOT implemented.** No route, no service, no schema column. |
| Count declaration / denomination catalogue | **NOT implemented.** |
| Expected-cash close computation | **NOT implemented.** |
| Variance close record / variance reason persistence | **NOT implemented.** |
| Approval request creation by CashSession close | **NOT implemented.** No `ApprovalCommands` call anywhere in this diff. |
| `cash.variance.approve` consumer wiring | **NOT implemented.** The permission is not even referenced. |
| Day Close / X report / Z report | **NOT implemented.** |
| Drawer limit (FR-POS-092) | **NOT implemented.** No column, no field, no check. |
| Six-level FR-PLT-025 settings hierarchy | **NOT implemented.** One level (branch) only. |
| FR-PLT-026 locks | **NOT implemented.** No `is_locked`/`locked` column exists anywhere (proved by test, §7 below). |
| Settings inspector (FR-PLT-027) | **NOT implemented.** |
| Offline policy sync | **NOT implemented.** |
| Already-open-session rollout migration | **NOT implemented / not addressed.** C-2 leaves this an explicit future decision. |
| `/v1` retrofit | **NOT performed.** C-1 honoured — see §3. |
| `NFR-PERF-006` | **Not touched.** |

`treasury.cash_sessions` was **not modified in any way** — no column added, no migration touching it, matching R-3(a)'s explicit instruction not to snapshot policy at open.

---

## 1. MIGRATION 33

**File:** `prisma/migrations/20260830010000_treasury_cash_close_policies/migration.sql`. **Migration 34 was not created.**

`treasury."CashCountMode"` enum (`blind`, `open`) + `treasury.cash_close_policies`:

```
id UUID PK
tenant_id UUID NOT NULL
branch_id UUID NOT NULL
effective_from TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp()
count_mode treasury."CashCountMode" NOT NULL DEFAULT 'blind'
variance_tolerance_minor_units BIGINT NOT NULL            -- NO default
currency CHAR(3) NOT NULL
variance_approval_expiry_seconds INTEGER NOT NULL         -- NO default
created_by UUID NOT NULL
created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp()
```

**CHECKs:** `variance_tolerance_minor_units >= 0`; `variance_approval_expiry_seconds > 0`; `currency ~ '^[A-Z]{3}$'` (the repository's existing `Currency.CODE_PATTERN` convention, `currency.ts:67`); `effective_from >= created_at` (**C-2** anti-backdating).

**Indexes:** `UNIQUE (tenant_id, id)` (composite-FK target); `UNIQUE (tenant_id, branch_id, effective_from)` (`uq_ccp_branch_effective_from` — the deterministic same-instant race resolver, test 21); `(tenant_id, branch_id, effective_from DESC)` (the resolver's only access path).

**FKs:** `(tenant_id, branch_id) → org.branches(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE` (D-09 composite tenant-safe FK); `created_by → identity.users(id) ON DELETE RESTRICT ON UPDATE CASCADE` (untenanted global FK, mirroring `cash_movements.performed_by` / `stock_movements.performed_by`).

Verified against a real scratch DB (`\d treasury.cash_close_policies`): all constraints, indexes and FKs present exactly as designed.

---

## 2. "EFFECTIVE IMMEDIATELY" — DATABASE TIME ONLY (§7)

**Mechanism:** both `effective_from` and `created_at` default to `statement_timestamp()`. Postgres evaluates `statement_timestamp()` **once per statement**, so an INSERT that omits `effective_from` (the "activate immediately" path) gets the **identical instant** as `created_at` — satisfying `ck_ccp_no_backdating` by **equality**, using DATABASE time exclusively. The application never supplies its own clock as part of this boundary: the write service passes SQL `NULL` for `effective_from` when the caller omits it, and `COALESCE(NULL::timestamptz, statement_timestamp())` resolves it server-side.

**Proven** (e2e test, `cash-close-policy.e2e-spec.ts`, `"effective immediately"…`): a created row's `effective_from` and `created_at` are read back **byte-identical** (`row.effectiveFrom.getTime()).toBe(row.createdAt.getTime())`).

**Explicit past `effectiveFrom` is rejected twice:** (a) a friendly app-level 400 (`parseEffectiveFrom`), and (b) — the actual security boundary — a direct raw `INSERT` bypassing the service entirely, attempted as `ros_app` with a backdated `effective_from`, genuinely fails against real Postgres (test 20, both halves).

**Explicit future `effectiveFrom` is accepted** and used as given (test, "future effectiveFrom is accepted").

No option under §7's "STOP and report" clause was triggered — the DB-default approach satisfies every constraint the brief lists (never accepts a past `effectiveFrom`; never trusts only application `new Date()`; never silently rewrites a supplied past timestamp).

---

## 3. ROUTE (C-1)

**Selected:** `POST /branches/{branchId}/cash-close-policy`, on a **new** `CashClosePolicyController` inside `TreasuryModule` (distinct from `TreasuryController`, which owns `/cash-sessions/*`). **No `@AllowPosSession()`** — this is a dashboard/back-office route (`settings.branch.manage` is a configuration act, not a POS-session operation), so `JwtAuthGuard` rejects a PIN-issued session by default (FR-SEC-021), and a dashboard JWT works normally (guard chain: `JwtAuthGuard → TenantContextGuard → PermissionGuard`, identical to Organisation's own branch-admin routes).

**No `/v1` prefix** — confirmed the repository's *only* existing convention: `swagger.config.ts` documents that no `/v1` prefix exists anywhere (`addServer('/', …)`), and every controller in this codebase is unprefixed. **C-1 is honoured literally**: no isolated retrofit was performed, and the global SRS `/v1` compliance gap is **not** claimed fixed anywhere in this diff.

**Why a separate controller, and why `/branches/…` rather than nesting under `/cash-sessions`:** this resource is branch-scoped **configuration**, not a cash-session operation. The choice mirrors the existing split between Organisation's `/org/branches/…` (organisation-owned branch configuration) and Treasury's `/cash-sessions` (session operations) — both families are legitimate; folding policy administration into `/cash-sessions` would misdescribe what it configures. Documented in the controller's own docblock.

**Deliberately absent:** PATCH/PUT (no update — a new configuration is always a new immutable row); DELETE (no DELETE grant exists on the table at all); any read/inspector endpoint (FR-PLT-027 `[S]`, out of scope, and §26 of the brief explicitly permits an admin write route without one).

---

## 4. ID GENERATION (§18)

**Server-generated ULID-as-UUID** (`newId()`), the same convention `BranchesService.create` uses. **This is not an FR-OFF-015 device-created entity** — no offline terminal ever originates a policy version, so there is no client permanent-id protocol to honour (unlike `CashMovementsService`, which the design gate does not apply to this route). `Idempotency-Key` (mandatory, FR-API-020) is the retry protection, layered under the same global `IdempotencyInterceptor` every other write route in this repository uses.

**FR-OFF-015 is not falsely claimed to require a client id here** — the docblock states this explicitly.

---

## 5. SCHEMA (Prisma) AND CONSTRAINTS

`prisma/schema.prisma`: `CashCountMode` enum + `CashClosePolicy` model, inserted immediately after `CashMovement`, in `treasury` schema. Back-relations added to `Tenant.cashClosePolicies`, `Branch.cashClosePolicies`, `User.cashClosePoliciesCreated` — virtual only, no DDL impact, matching the existing back-relation convention throughout the schema. `npx prisma format` / `npx prisma validate` both pass; `npx prisma generate` regenerated the client with the new model/enum with no errors.

**No generic Settings model was created.** No `is_locked`, no `effective_to`, no `version_number`, no drawer-limit column, no tenant/brand/terminal scope column — confirmed by direct `information_schema.columns` inspection in the test suite (§9 below).

---

## 6. RLS AND GRANTS

`ENABLE` + `FORCE ROW LEVEL SECURITY`. SELECT and INSERT policies only, both keyed on `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` — the fail-closed predicate: an unset/empty tenant GUC makes `NULLIF(...) IS NULL`, which no row can equal. **No UPDATE policy. No DELETE policy.**

**Grants** (verified against real PostgreSQL via `information_schema.role_table_grants` / `role_column_grants`, exactly the migration-32 verification method):

- `GRANT SELECT` — **table-level**, the *only* table-level privilege `ros_app` holds (`role_table_grants` returns exactly `['SELECT']`).
- `GRANT INSERT` — **column-level**, naming every business column and **deliberately excluding `created_at`**. Proven empirically: `role_column_grants` for `privilege_type='INSERT'` contains `effective_from`/`variance_tolerance_minor_units`/etc. but **not** `created_at`.
- `REVOKE UPDATE, DELETE, TRUNCATE` — proven not merely absent-by-omission but genuinely rejected: a real `UPDATE`/`DELETE` attempt as `ros_app` against an existing row **throws**, and the row is unchanged afterward (verified via the migrator connection).
- A direct attempt to `INSERT … created_at` as `ros_app` (forging a backdated creation instant) **fails** — the column-level grant makes forgery structurally impossible, not merely application-discouraged.

This is the exact `governance.approval_decisions` pattern from migration 32, reused verbatim for the same reason: immutability enforced at the privilege layer, not the application layer.

---

## 7. RESOLVER (§12/§13)

`src/modules/treasury/cash-close-policy/cash-close-policy.resolver.ts` — **Treasury-PRIVATE**, **not** a `contract/` export (design gate §9.1: the only consumer this slice has is Treasury itself). `resolve(tx, {tenantId, branchId, asOf})` returns the latest version with `effective_from <= asOf` for one branch, or `null` when none exists — the caller (a future CashSession Close) **must** fail closed on `null` rather than assume a tolerance (R-5). `resolveCountMode(tx, …)` never fails closed: it returns the SRS-stated default `'blind'` when no policy exists.

**Determinism proven historically:** a version resolved at a fixed `asOf` returns the identical, byte-for-byte snapshot (`toEqual`) both **before** and **after** a chronologically later version is inserted for the same branch — the `effective_from <= asOf` predicate structurally excludes the later row from ever affecting a strictly-earlier resolution (test 9/22).

**FR-PLT-025/026 gaps proven, not glossed:** a branch with no configured policy resolves `null` (test 5, explicitly labelled *"DOCUMENTED GAP… NOT FR-PLT-025 coverage"*); the table carries no `is_locked`/`locked` column at all, queried directly via `information_schema.columns` (test 6, explicitly labelled *"DOCUMENTED GAP… NOT FR-PLT-026 coverage"*). Neither test claims progress on either requirement.

---

## 8. CURRENCY (§14/§17/§21)

**Never accepted from the request body.** The DTO has no `currency` field; supplying one is rejected by the global `ValidationPipe`'s `forbidNonWhitelisted: true` (proven, test 16, first half — a 400). The service derives currency from `tx.branch.baseCurrency` **inside the same transaction**, using the **exact, already-accepted `CashSessionsService.open` precedent** (`cash-sessions.service.ts:127`, `tx.branch.findUnique({select:{baseCurrency:true}})`). This is a **direct Prisma table access via the shared client**, not a TypeScript import of an Organisation module file — confirmed against `module-boundaries.spec.ts`'s `KNOWN_DEVIATIONS` list: **no `treasury->organisation` entry exists, and none was added.** 38/38 module-boundary tests pass unchanged.

**Proven per-branch (test 16, second half):** a policy created for a EGP-base-currency branch stores `currency: 'EGP'`; a policy created for a USD-base-currency branch (`branchA2`, seeded explicitly with `baseCurrency: 'USD'`) stores `currency: 'USD'` — the branch's own currency, never a shared/global assumption.

**No FX conversion, no currency comparison to `CashSession.currency`** — out of scope for this slice, exactly as instructed; the resolver returns the stored `currency` field, giving a future CashSession Close everything it needs to fail closed on a mismatch itself.

---

## 9. WRITE AUTHORIZATION (§16)

`settings.branch.manage` — **the existing SRS §15.2 code**, already seeded by Organisation (`ORGANISATION_PERMISSION_DEFS`, ADR 0008 D-01). Declared in `treasury.permissions.ts` as a **local plain string literal** (`TREASURY_PERMISSIONS.SETTINGS_BRANCH_MANAGE`), **not** imported from `organisation/organisation.permissions` — importing it would be a **new** `treasury->organisation` private-path deviation, and none exists in `KNOWN_DEVIATIONS` today. **No duplicate `PermissionDef` was added** to `TREASURY_PERMISSION_DEFS` — the code is already upserted by Organisation's seed, keyed by `code`; a second def would be a redundant no-op, not a second permission.

**Proven identical at test setup** (`expect(TREASURY_PERMISSIONS.SETTINGS_BRANCH_MANAGE).toBe(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)`) — both constants resolve to the literal `'settings.branch.manage'`.

**Authorization enforcement proven** (test 23/24): a user without the permission gets 403; a user with it gets 201 and exactly one audit entry.

---

## 10. IDEMPOTENCY (FR-API-020)

Uses the repository's existing global `IdempotencyInterceptor` (`@Idempotent()` + mandatory `Idempotency-Key` header) — **no Treasury-specific idempotency store was created.** Missing key → 400 (proven). Same key + identical body → the stored response is replayed verbatim (`Idempotent-Replay: true`), **exactly one** row and **exactly one** audit entry exist afterward (test 25). Same key + a differing body → 409, the repository-standard fingerprint-mismatch response (test 26).

---

## 11. AUDIT (FR-AUD-006)

New action `CASH_CLOSE_POLICY_VERSION_CREATED` (`audit.constants.ts`) — one verb, because every write is a new immutable version, never an edit, so no `_UPDATED` counterpart exists. New entity `cash_close_policy`. One audit entry per genuine creation, recording `branchId`, `effectiveFrom`, `countMode`, `varianceToleranceMinorUnits` (**serialized as a decimal string**, not a raw `bigint`, avoiding the exact JSON-serialization hazard this repository's own money conventions exist to prevent), `currency`, `varianceApprovalExpirySeconds`. **No secret is audited.** Proven: exactly one audit row exists after a successful create, and idempotent replay creates **zero** additional rows (test 24/25).

---

## 12. CONCURRENCY (test 21, §26)

**No advisory lock. No `SELECT FOR UPDATE`.** The same-branch/same-`effective_from` race is resolved **structurally** by the `uq_ccp_branch_effective_from` unique index: two genuinely concurrent HTTP `POST`s (`Promise.all`, distinct `Idempotency-Key`s, identical `branchId` + `effectiveFrom`) against the running application race at the database, and Postgres's own unique-index enforcement guarantees exactly one winner (201) and one loser (409) — never two rows, never zero. **Run three clean times** in a single test (`runConcurrentRace()` invoked three times sequentially, each against a fresh future `effectiveFrom`), and independently re-run as part of **three separate full fresh-scratch-DB test-suite executions** — 9 total race observations, zero flakes, zero double-inserts (each verified via `admin.cashClosePolicy.findMany(...).toHaveLength(1)`).

**Raw-query error classification, a real implementation subtlety resolved during this session (not a defect — a correctly-anticipated shape):** `tx.$queryRaw` failures surface as `PrismaClientKnownRequestError` code `P2010` ("raw query failed"), **not** the `P2002`/`P2003` shape Prisma's own query builder produces. Reusing the organisation `rethrowAsNotFoundOnFk` helper (which matches on `P2002`) would have silently **failed to catch the unique violation at all**, letting it propagate as an unhandled 500 — and would additionally have introduced a forbidden new `treasury->organisation` import. Both problems are avoided by a **local**, Treasury-owned classifier (`rawQueryOriginalCode`/`isUniqueViolation` in `cash-close-policy.service.ts`) that inspects `err.meta.driverAdapterError.cause.originalCode` — the exact technique `governance/approvals/approvals.service.ts`'s `isRowLevelSecurityViolation` already established as this repository's precedent for classifying raw-query Postgres errors. This was caught and corrected **before** any test ran, by reading that precedent first; it never manifested as a test failure.

---

## 13. MODULE BOUNDARIES

`src/modules/module-boundaries.spec.ts`: **38/38 pass, `KNOWN_DEVIATIONS` unchanged (0 new entries).** No `treasury->organisation`, no `treasury->identity` beyond the existing whitelisted cross-cutting plumbing paths (guards/authz/context — already listed for every HTTP module), no new generic Settings module, no schema FK miscounted as a TypeScript import edge.

---

## 14. OPENAPI

Regenerated via the project's own `npm run openapi:generate` script (against a scratch DB, `nest build` + `generate-openapi.js`). **Operation count: 138 → 139** (exactly the one new route this slice adds). **Version unchanged: `3.1.0`.** **Diff is purely additive** — `git diff` on both `docs/api/openapi.json` and `docs/api/openapi.yaml` shows **zero deleted lines** in either file; the new path `/branches/{branchId}/cash-close-policy` appears once, with its full request/response schema, error responses, and the mandatory `Idempotency-Key` header documented. No `/v1` prefix appears anywhere in the regenerated document (confirms C-1 again, mechanically). `openapi.e2e-spec.ts`'s drift-detection tests (both directions: "no live route missing from the doc" and "no documented operation missing its live route") now pass — they failed on first run purely because the document was stale, not because of a route-shape defect.

---

## 15. MIGRATION VERIFICATION (SCRATCH) AND PERSISTENT `ros` ISOLATION

| Check | Result |
|---|---|
| Fresh scratch DB, `prisma migrate deploy`, migrations 1→33 | **Applied cleanly**, three separate times across this session (each preceded by `DROP DATABASE IF EXISTS` + `CREATE DATABASE`) |
| `_prisma_migrations` count on scratch after deploy | **33** |
| Persistent `ros` DB `_prisma_migrations` count, checked **before and after** every scratch operation | **26, unchanged throughout** |
| Persistent `ros` DB newest migration | `20260823030000_kitchen_ticket_persistence` — **unchanged** |
| `to_regclass('treasury.cash_close_policies')` on persistent `ros` | **NULL** — the table does not exist there, confirming migration 33 was never applied to it |
| Scratch DB dropped after final use | **Yes** (`DROP DATABASE ros_p1g1_scratch`) |
| Persistent `ros` DB dropped or terminated at any point | **Never** |

---

## 16. TEST TOTALS

| Suite | Baseline (accepted) | This session |
|---|---|---|
| Unit (`npx jest`) | 746/746 | **746/746** — unchanged count, zero regressions |
| Module boundaries | 38/38 | **38/38** — unchanged, zero new deviations |
| e2e (`--config test/jest-e2e.json --runInBand`) | 877/877 | **904/904** (877 + 27 new — `cash-close-policy.e2e-spec.ts`) |
| New e2e file alone, re-run in isolation | n/a | **27/27**, reproduced clean across **3 independent fresh-scratch-DB runs** |

**The 4 pre-existing e2e tests that failed on the first full-suite run** (`cash-session.e2e-spec.ts` "creates only the four authorised tables…", the equivalent assertions in `catalogue.e2e-spec.ts` and `inventory.e2e-spec.ts`, and `openapi.e2e-spec.ts`'s drift-detection test) failed **exactly as expected** for a migration that legitimately adds a new table and a new route: each asserts an exact, hard-coded inventory. Each was updated by exactly the maintenance a new authorised table/route requires — one new array entry (in alphabetical/schema order, matching the existing convention) or a regenerated document — with an explanatory comment naming this slice, mirroring how P1G-0's `cash_movements` addition updated the same three table-inventory tests in its own time. **No assertion's semantic meaning was weakened**: each still proves its original boundary (no unauthorised table/route exists) with the new, ratified addition acknowledged.

---

## 17. REQUIREMENT CLASSIFICATION (§33 — post-substrate, pre-CashSession-Close)

| Requirement | Classification | Reason |
|---|---|---|
| **FR-PLT-025** | **NOT IMPLEMENTED** | Branch-level store only; no six-level resolver, no Platform Default/Country Pack/Tenant/Brand/Terminal levels. Proven-as-gap by test 5. |
| **FR-PLT-026** | **NOT IMPLEMENTED** | No lock column exists anywhere in the table. Proven-as-gap by test 6. |
| **FR-PLT-028** | **PARTIAL** | Effective-dated immutable versioning exists for cash-close policy only; the SRS-named scope (tax class, rounding policy, service charge) remains untouched. |
| **FR-POS-094** | **PARTIAL** | Per-branch blind/open configuration and its resolver exist and are proven; the physical close/count flow does not exist. |
| **FR-POS-095** | **PARTIAL** | The `blind` default is expressible, DB-enforced, and resolver-proven; no CashSession Close consumes it yet. |
| **FR-FIN-006** | **DESIGNED ONLY** | A configurable, non-invented tolerance now exists and is resolvable, and the (already-accepted) Approval Runtime exists — but no CashSession Close exists to exercise either. **Not claimed COMPLETE.** |
| **FR-POS-092** | **NOT IMPLEMENTED** | No drawer-limit column, no field, no logic. Confirmed compatible-by-design (one nullable `BIGINT` could be added to the same table later) but nothing was added speculatively. |

---

## Scope compliance

Implements ONLY the ratified P1G-1 cash-close policy substrate. CashSession Close is NOT implemented. No commit, no push, no deployment, no amend, no rebase, no destructive git command (`reset`, `restore`, `checkout`, `clean`, `stash` — none used at any point). The uncommitted governance ratification was read as binding authority and left byte-identical by this task. HEAD `1f9ea1f` unchanged throughout.

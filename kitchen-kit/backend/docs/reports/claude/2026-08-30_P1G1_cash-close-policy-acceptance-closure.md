# P1G-1 Cash-Close Policy Substrate — Acceptance Closure (Module-Boundary Correction)

**Report type:** Correction report (production code + one new test file; no migration, no governance change).
**Authority statement:** This report is **NON-AUTHORITATIVE EVIDENCE**. Authority order: **(1) `ROS_SRS_v1.0.pdf`, specifically §5.2.3 and §5.4 → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md`, "P1G-1 Cash-Close Policy Ratification — 2026-08-30" (unchanged by this task) → (3) the repository at HEAD `1f9ea1f` → (4) `docs/reports/claude/2026-08-30_P1G1_variance-settings-final-design-gate.md` and `…_cash-close-policy-substrate.md` → (5) engineering inference, labelled as such.**
**Date:** 2026-08-30
**HEAD:** `1f9ea1f` — *feat: add governance approval runtime* (unchanged; **no commit performed**)
**Branch:** `feat/production-spec`
**Working tree at start:** the binding P1G-1 ratification, migration 33, the cash-close-policy substrate, and every unrelated pre-existing report — all as left by the prior implementation task.
**Working tree at report time:** the above, plus one new Organisation contract (`branch-currency.query.ts` + its private implementation), one new targeted architecture test, `CashClosePolicyService` corrected to consume it, `treasury.module.ts` / `organisation.module.ts` / `organisation/contract/index.ts` wiring updates, and this report. **No migration created or changed. No governance file touched.**
**Migrations:** 33, **unchanged** (no migration 34).
**Task identifier:** P1G-1 cash-close policy substrate acceptance closure

> ## VERDICT
> ## **A. CASH-CLOSE POLICY SUBSTRATE CORRECTED — FINAL-ACCEPTANCE READY**
>
> The SRS §5.2.3 module-boundary defect is corrected: `CashClosePolicyService`
> no longer queries `org.branches` directly. It now consumes a new Organisation
> **PUBLIC** `contract/` query (`BRANCH_CURRENCY_QUERY`), transaction-scoped,
> exactly mirroring this repository's own established pattern
> (`TABLE_DISPLAY_QUERY`, `ROUTING_CONFIG_QUERY`, `CASH_SESSION_FACTS_QUERY`).
> A **new, targeted architecture test** proves the specific edge the generic
> `module-boundaries.spec.ts` suite structurally cannot see (§7 below), and
> was itself caught firing on a genuine false positive in this task's own
> documentation prose — fixed before merge, not glossed over.
>
> **Full regression, confirmed clean:** unit **751/751** (746 baseline + 5 new
> architecture-test cases), module-boundaries **38/38** with **zero new
> `KNOWN_DEVIATIONS` entries**, the targeted `cash-close-policy.e2e-spec.ts`
> **27/27** reproduced clean across **3 independent fresh-scratch-DB runs**
> (including the ≥3× concurrency race, now proven through the contract
> indirection), and the full e2e suite **904/904**. OpenAPI unchanged:
> **3.1.0 / 139** operations — this correction adds no route. Persistent `ros`
> DB reconfirmed untouched throughout (26 migrations, unchanged).
>
> **One transient environmental flake occurred and is recorded, not hidden:**
> a full e2e run mid-session hung at zero CPU for 14 minutes then, once
> killed, its buffered output showed 46 failures concentrated entirely in
> `catalogue.e2e-spec.ts` (a file this task never touches) with a trailing
> "Jest did not exit" warning. An immediate clean re-run (fresh scratch DB,
> `--forceExit`) completed in **84.5s with 904/904 passing** — identical
> timing and result to every other run in this session. This is recorded as
> an isolated environmental artifact of this local machine/session, not a
> defect in the correction, and the report explains the evidence for that
> conclusion in §11 rather than asserting it.

---

## 1. THE DEFECT, RESTATED PRECISELY

**The prior implementation report's claim was false.** It stated: *"This is a direct Prisma table access via the shared client, not a TypeScript import of an Organisation module file, so it introduces NO new `module-boundaries.spec.ts` deviation."* That sentence is **true about `module-boundaries.spec.ts`** and **false about SRS §5.2.3 compliance**. §5.2.3 states plainly:

> *"A module MUST NOT import from another module's internal directory"* **and** *"Cross-module communication is via a published interface or a domain event"*

The second clause is about **data ownership**, not about **import syntax**. `CashClosePolicyService.create()` executed `tx.branch.findUnique({...})` — a live query against `org.branches`, a table Organisation owns — inside Treasury's own service. **No Organisation TypeScript file was imported at all**, so `module-boundaries.spec.ts`'s import-scan (which greps for `import`/`export`/`require` specifiers) had **nothing to flag**: the violation is not in what was imported, it is in what was *queried*, through the one shared resource (the Prisma client) every module happens to have equal syntactic access to. **This report corrects that claim explicitly and does not repeat it.**

**`module-boundaries.spec.ts`'s prior 38/38 result did not test database-table ownership at all.** It is, and remains, a correct and valuable suite for what it actually checks (import-path boundaries) — the prior report's error was in treating "passes this suite" as a stronger claim ("is SRS §5.2.3-compliant") than the suite establishes.

---

## 2. THE CORRECTION — ORGANISATION PUBLIC CONTRACT

### 2.1 What was inspected first

Per the brief's instruction, `src/modules/organisation/contract/` was inspected before adding anything: `routing-config.query.ts` (FR-KDS-010 tiers 2–5, ADR 0008 D-07/D-06) and `table-display.query.ts` (FR-KDS-020 dine-in table display, P1E-6). **Neither exposes a branch's currency or any branch fact at all** — no suitable existing capability was duplicated.

### 2.2 The new contract

`src/modules/organisation/contract/branch-currency.query.ts` — **interface + DTOs only** (SRS §5.4):

```ts
export const BRANCH_CURRENCY_QUERY = Symbol('BRANCH_CURRENCY_QUERY');

export interface BranchCurrencyQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
}
export interface BranchCurrencyResult {
  readonly branchId: string;
  readonly baseCurrency: string;
}
export interface BranchCurrencyQuery {
  find(
    tx: Prisma.TransactionClient,
    input: BranchCurrencyQueryInput,
  ): Promise<BranchCurrencyResult | null>;
}
```

**`tx`-first**, exactly matching every other published query in this repository (`CashSessionFactsQuery.find`, `TableDisplayQuery.find`, `RoutingConfigQuery.find`) — the caller's own transaction, never a second one. Returns `null` on an unknown or genuinely cross-tenant id (RLS makes the row invisible regardless of the WHERE clause — the same convention every other `null`-returning query in this codebase already uses).

### 2.3 The private implementation

`src/modules/organisation/branches/branch-currency.query.service.ts` — **PRIVATE**, co-located with `branches/` (the aggregate it reads), bound to `BRANCH_CURRENCY_QUERY` only inside `OrganisationModule` via `useExisting`:

```ts
async find(tx, input) {
  const branch = await tx.branch.findUnique({
    where: { id: input.branchId },
    select: { id: true, baseCurrency: true },
  });
  return branch ? { branchId: branch.id, baseCurrency: branch.baseCurrency } : null;
}
```

**`org.branches` may be queried here** — this is Organisation's own module, querying its own table, which is exactly what SRS §5.2.3 permits and requires: table ownership stays inside its owning module.

### 2.4 Wiring

`organisation/contract/index.ts` exports the new barrel entry. `organisation.module.ts` provides `BranchCurrencyQueryService` and binds `BRANCH_CURRENCY_QUERY` to it, exported alongside the two existing tokens. `treasury.module.ts` now **imports `OrganisationModule`** — the *module class*, which `module-boundaries.spec.ts` explicitly permits without a `KNOWN_DEVIATIONS` entry (its own documented exemption: *"modules/\<other\>/\<other\>.module · the Nest composition root… Without this exemption the rule would forbid dependency injection itself"*).

### 2.5 The consumer

`CashClosePolicyService` now injects `@Inject(BRANCH_CURRENCY_QUERY) private readonly branchCurrency: BranchCurrencyQuery` (the interface imported with `import type`, matching every other consumer of a `contract/` interface in this codebase — `sales-fire.service.ts`, `sales-payment.service.ts`, `routing-resolver.service.ts` — required by `emitDecoratorMetadata`/`isolatedModules`), and calls:

```ts
const branch = await this.branchCurrency.find(tx, { tenantId, branchId: input.branchId });
if (!branch) throw new NotFoundException('Branch not found.');
```

**inside the exact same transaction** the policy INSERT itself runs in (`this.prisma.withAuthContext(...)`'s `tx`) — no second transaction opened, no currency cached, no currency accepted from the HTTP body, and the returned `baseCurrency` is what gets persisted onto the immutable policy version, unchanged in every other respect from the prior (defective) implementation's behaviour.

**All direct `tx.branch.*` / `prisma.branch.*` access was removed from `src/modules/treasury/cash-close-policy/*.ts`.** No `organisation/branches/*`, `organisation/services/*`, or any other private Organisation path is imported anywhere in that directory — only `organisation/contract`.

---

## 3. SCHEMA — UNCHANGED, AS INSTRUCTED

**Migration 33 was not touched.** The composite FK `(tenant_id, branch_id) → org.branches(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE` is retained exactly as implemented. **This was never a schema defect** — a foreign key is PostgreSQL's own referential-integrity mechanism, evaluated by the database regardless of which application module performs the write; it says nothing about which *application module* is permitted to *query* the referenced table on the read side, which is what §5.2.3 governs and what this correction fixes. No migration 34 was created.

---

## 4. THE TARGETED ARCHITECTURE TEST (§7 of the brief)

`src/modules/treasury/cash-close-policy/cash-close-policy.db-ownership.spec.ts` — a **new, narrowly-scoped** unit spec (pure static file-content analysis, no DB, no Nest container — the same style as `module-boundaries.spec.ts`). It proves, **for `cash-close-policy/` production files only**:

1. **Sanity** that the scan actually reaches the three production files it claims to (`.service.ts`, `.resolver.ts`, `.controller.ts`) — a scan of an empty directory would otherwise pass every assertion vacuously.
2. **No Prisma `Branch`-model property access** anywhere in this directory — a regex over `.branch.(findUnique|findFirst|findMany|create|update|upsert|delete|count|aggregate)(` catches the exact shape of a direct table query **independent of the receiver's variable name** (`tx.branch`, `prisma.branch`, or any future alias), which is precisely the class of defect the import-scan could not see.
3. **Every Organisation import in this directory reaches only `organisation/contract` or `organisation/organisation.module`** — the same rule `module-boundaries.spec.ts` enforces repo-wide, re-asserted narrowly here so this specific edge cannot silently regress even if the generic suite's exemption list is ever loosened elsewhere.
4. **The Organisation contract's private implementation — not Treasury — still contains the query**, proving the fix *moved* the query to its correct owner rather than merely deleting the visible symptom.
5. **`module-boundaries.spec.ts`'s `KNOWN_DEVIATIONS` table gained no `'treasury->organisation'` entry** — the edge is closed through the published-contract exemption, not by documenting a new private-path deviation.

### 4.1 A real false positive this test caught — and how it was resolved

On first run, both this new spec **and** the pre-existing `module-boundaries.spec.ts` contract-purity check (*"Organisation `contract/` contains interface/types only"*) **failed** — correctly, but not for the reason initially assumed. This report's own prose (in `branch-currency.query.ts`'s docblock, `cash-close-policy.service.ts`'s docblock, and this new spec's own docblock) had written the exact literal substring `` tx.branch.findUnique() `` — with a trailing parenthesis — inside **comments**, explaining the general problem. Neither this new spec's regex nor `module-boundaries.spec.ts`'s existing `containsPersistenceImplementation` helper strips comments before scanning (a deliberate, pre-existing design choice: `module-boundaries.spec.ts`'s own docblock explains it looks for *"BEHAVIOUR, not the literal word"*, but its `QUERY_CALL_RE` genuinely does not distinguish code from prose). The docblocks were reworded (*"a bare Branch-model lookup"* instead of the call-shaped literal) rather than weakening either detector — **the detectors were correct to fire; the documentation was wrong to contain call-shaped text.** Re-run after the wording fix: both suites pass, 43/43 combined.

This is recorded explicitly because it is a genuine example of exactly the kind of thing §7 asked for — a mechanical check that actually catches something, including catching this task's own drafting.

### 4.2 What this test does NOT prove — stated honestly (§7's own instruction)

This is a **narrow, file-scoped** check. It does **not** implement, and does not claim to implement, a repository-wide scan of every module for direct Prisma-model access against every *other* module's tables. **Global SRS §5.2.3 mechanical DB-table-ownership enforcement across the whole repository remains PARTIAL** unless a general per-module database-role/grant enforcement (or a repo-wide static scanner of this shape) is implemented separately — that is a distinct, larger architecture-test slice, not undertaken here.

**A matching, pre-existing instance of the same class of defect was found and deliberately NOT touched, per the brief's fence:** `CashSessionsService.open` (`treasury/cash-sessions/cash-sessions.service.ts:127`, accepted P1D-1 code, unrelated to this correction) also executes `tx.branch.findUnique({select:{baseCurrency:true}})` directly. **This correction's own docblocks name that fact explicitly** (§2.5 above; the code comment in `cash-close-policy.service.ts` states it), so it is visible to any future reader rather than silently repeated as a "precedent" the way the original (defective) implementation cited it. Fixing it is out of this correction's scope — the brief's fence was `CashClosePolicyService` only — and is recorded here as a known, matching residual, not swept under the new contract's existence.

---

## 5. CURRENCY BEHAVIOUR — PRESERVED, RE-PROVEN THROUGH THE CONTRACT

Every accepted currency behaviour is unchanged in substance, now routed through the contract:

| Behaviour | Status |
|---|---|
| Currency never accepted from the request body | **Preserved** — the DTO still has no `currency` field; `forbidNonWhitelisted` still rejects one, re-proven (test 16, first half) |
| Branch base currency is authoritative | **Preserved** — sourced from `org.branches.base_currency` via the contract, not a Treasury-local copy |
| Policy stores a currency snapshot | **Preserved** — the immutable version's `currency` column, unchanged |
| No FX conversion | **Preserved** — out of scope, untouched |
| Same transaction | **Preserved and now explicit in the contract's own type signature** — `find(tx, …)` cannot be called without a `Prisma.TransactionClient`, so a future author cannot accidentally call it outside the write's transaction without a compile error |
| Future comparison against `CashSession.currency`, fail-closed on mismatch | **Unaffected** — this slice still does not implement CashSession Close; the resolver still returns the stored `currency` for a future close to compare |
| EGP/USD branch tests | **Re-proven through the new contract** (test 16, second half): a EGP-base-currency branch still produces an `EGP` policy; a USD-base-currency branch (`branchA2`) still produces a `USD` policy — now resolved via `BranchCurrencyQueryService` instead of a direct query, with byte-identical output |

---

## 6. AUTHORIZATION WORDING CORRECTION (§9 of the brief)

**No code change** — `settings.branch.manage` remains the route's permission code, unchanged, exactly as ratified. **The correction is reporting language only.**

The prior implementation report's phrasing did not claim branch-scoped RBAC, but this report states the boundary explicitly so no future reader infers it: **the route is authorized under the current TENANT-WIDE permission resolver** (`TenantContextService`/`PermissionGuard`, the same mechanism every other permission-guarded route in this repository uses). A holder of `settings.branch.manage` **anywhere in the tenant** may configure **any branch's** cash-close policy — there is no per-branch scoping of the permission check, because branch-scoped RBAC (**FR-SEC-002/003/004**) is a separately deferred, unimplemented capability (**ADR 0008 D-02**), unaffected by and unresolved by this correction. **This is not claimed as full branch-scoped authorization anywhere in this report or its code**, and no new permission code was created or considered.

---

## 7. EVERYTHING ELSE — CONFIRMED UNCHANGED

Every item §10 of the brief lists was verified **byte-identical in behaviour** (not merely "not intentionally edited"): migration 33's DDL; `CashCountMode` enum values and the `blind` DB default; `variance_tolerance_minor_units BIGINT` with no default; the policy's own currency snapshot; `variance_approval_expiry_seconds` configured-positive semantics; the `effective_from`/`created_at` `statement_timestamp()` pairing and its anti-backdating CHECK; immutable append-only versions; the resolver's historical-resolution determinism; `ENABLE`+`FORCE` RLS; the column-level INSERT grant (still excluding `created_at`); `settings.branch.manage` as the guard; mandatory `Idempotency-Key`; the audit action/entity; the route shape (`POST /branches/{branchId}/cash-close-policy`, no `/v1`); OpenAPI operation count (139); and server-generated policy-version ids. None of these required a code change in this correction and none regressed — see §9/§10 for the re-proof.

---

## 8. MODULE BOUNDARIES — FULL RE-VERIFICATION

`src/modules/module-boundaries.spec.ts`: **38/38 pass.** `KNOWN_DEVIATIONS` inspected directly (not merely re-run): **no `'treasury->organisation'` key exists** — confirmed both by the new targeted test (§4, item 5) and by direct inspection of the file. `treasury.module.ts` imports exactly one new specifier, `../organisation/organisation.module` — the module-class exemption, requiring no deviation entry. `cash-close-policy/*.ts` imports exactly `../../organisation/contract` (twice — once as a value import for the Symbol, once as `import type` for the interface) — the contract exemption, likewise requiring none.

---

## 9. TARGETED VERIFICATION (§11 of the brief)

All re-proven against real PostgreSQL, exactly as the brief's numbered list requires:

| # | Requirement | Result |
|---|---|---|
| 1 | EGP branch creates EGP policy | ✅ (test 16, first assertion) |
| 2 | USD branch creates USD policy | ✅ (test 16, second assertion — `branchA2`) |
| 3 | Caller cannot submit currency | ✅ (test 16 — `forbidNonWhitelisted` 400) |
| 4 | Cross-tenant branch remains rejected | ✅ (test "1/17" — 404 for a tenant-A caller targeting tenant-B's branch; the composite FK independently proven unreachable by direct raw INSERT) |
| 5 | Same transaction is used | ✅ — structural: `BranchCurrencyQuery.find`'s signature requires the caller's own `tx`; `CashClosePolicyService` passes the identical `tx` its own INSERT runs in; no second `withAuthContext`/`$transaction` call exists anywhere in the service |
| 6 | No direct Treasury Branch-model query exists | ✅ (new architecture test, §4 item 2 — zero matches, verified against real files) |
| 7 | No new `KNOWN_DEVIATIONS` | ✅ (§8, and new architecture test §4 item 5) |

Static checks: `npx prisma validate` — valid (schema itself unchanged by this task, but reformatted/reconfirmed). `npx tsc --noEmit` — zero new errors (one pre-existing, unrelated `access-token.service.spec.ts` error, confirmed via `git status` to be outside every file this task or the prior task touched). `npm run build` — clean. `git diff --check` — clean, no whitespace errors. **No migration replay was forced** — migration 33 is byte-unchanged, and a scratch `prisma migrate deploy` was run anyway (as part of the e2e prerequisite) and confirmed **still exactly 33** rows in `_prisma_migrations`, proving no schema drift was introduced.

---

## 10. REGRESSION (§12 of the brief)

**Unit suite:** `npx jest` → **751/751** (746 baseline + 5 new architecture-test cases, zero regressions).

**Targeted e2e (`cash-close-policy.e2e-spec.ts`):** **27/27**, reproduced clean across **3 independent fresh-scratch-DB runs** — identical to the pre-correction baseline, now exercising the contract path instead of the direct query, including the ≥3× same-branch/same-`effective_from` concurrency race (9 total race observations across the 3 runs, zero double-inserts, zero flakes).

**Full e2e suite (`--config test/jest-e2e.json --runInBand`):** **904/904** — see §11 for the one anomalous intermediate run and why it is not attributed to this correction.

**OpenAPI:** regenerated and diffed — **3.1.0 / 139 operations, unchanged.** This correction adds no route, removes no route, and changes no request/response schema (the contract is an internal, in-process interface with no HTTP surface of its own). `git diff` on `docs/api/openapi.json`/`.yaml` against the prior task's already-regenerated document shows **zero additional changes** from this correction.

---

## 11. THE ONE ANOMALOUS RUN — RECORDED, NOT HIDDEN

Mid-session, a full e2e run (fresh scratch DB, otherwise identical command to every other run in this task) was launched in the background. After **14 minutes of wall-clock elapsed time with the process's CPU time frozen at 2:01.84 across two separate checks roughly 10 minutes apart** — genuinely zero further CPU consumption, and `pg_stat_activity` on the scratch database showing **zero active connections and zero queries at all** at the moment of inspection — the process was killed (`kill -9`) as a diagnosed hang, following the brief's own "inspect `pg_stat_activity`/`pg_locks`" instruction.

Its buffered output (only flushed by the shell's `tail` pipeline once the process actually exited, which happened to coincide almost exactly with the kill) showed the run had in fact **completed** on its own — 271.6s total, 858/904 passing, with **all 46 failures concentrated entirely inside `catalogue.e2e-spec.ts`** (every failure a `"Exceeded timeout of 5000 ms"` from partway through that file onward), followed by Jest's own `"did not exit one second after the test run has completed… asynchronous operations weren't stopped"` warning.

**Why this is attributed to the environment, not to this correction, stated as evidence rather than assertion:**

- `catalogue.e2e-spec.ts` is a file this correction **never touches**, imports nothing this correction changed, and exercises no Treasury or Organisation-contract code path this correction added.
- An **immediate retry**, same command plus `--forceExit`, fresh scratch DB, completed in **84.528s with 904/904 passing** — matching, almost to the second, both this task's own successful 84.5s run and the prior implementation task's own 84.737s baseline run. A genuine regression introduced by this correction's code would be expected to reproduce; it did not.
- `pg_stat_activity` immediately after the kill showed only 6 total connections cluster-wide, well under `max_connections=100` — no persisting connection leak from the hung run remained to explain a repeat.
- The failure signature (many unrelated tests each independently timing out at exactly the client-side 5000ms Jest default, clustered together, followed by an explicit "async operations kept running" warning) is the signature of **transient resource contention** (CPU scheduling pressure or connection-pool pressure external to the test logic itself), not of a specific assertion failing on its merits — no failure in that list is an assertion mismatch; every one is a timeout.

**This is recorded as an isolated environmental artifact of this local session**, not as a confirmed root cause (no deeper investigation, such as `--detectOpenHandles`, was performed, since the immediate clean re-run already gave a definitive, reproducible, passing result and the brief's verification bar is the passing regression run, not root-causing an unrelated flake). It is documented here in full rather than silently omitted, consistent with the reporting policy's requirement to record blockers and anomalies actually encountered in-session.

---

## 12. REQUIREMENT CLASSIFICATION — UNCHANGED FROM THE PRIOR REPORT

This correction touches only *how* branch currency is obtained, not *what* is implemented. Every classification in `2026-08-30_P1G1_cash-close-policy-substrate.md` §17 stands unchanged: FR-PLT-025/FR-POS-092 **NOT IMPLEMENTED**; FR-PLT-028/FR-POS-094/FR-POS-095 **PARTIAL**; FR-FIN-006 **DESIGNED ONLY** (not claimed COMPLETE). No requirement classification is revised upward or downward by this correction.

---

## Scope compliance

Correction task only. No new migration (migration 33 byte-unchanged; no migration 34). No governance file touched (the P1G-1 ratification entry is byte-identical — confirmed by `git status` showing the register file absent from this task's changes). No CashSession Close implemented. No commit, no push, no deployment. No destructive git command used at any point (`reset`, `restore`, `checkout`, `clean`, `stash`, `rebase`, `amend` — none). All unrelated pre-existing uncommitted reports preserved byte-identical. HEAD `1f9ea1f` unchanged throughout.

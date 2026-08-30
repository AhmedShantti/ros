# P1G-1 CashSession Close — Migration-Compatibility Closure

**Task / slice:** P1G-1 CashSession Close — migration compatibility and relational-integrity closure
**Report type:** Design / migration review. **No product code, no migration file created, no test modification, no governance recording, no commit, no push, no deployment, no D-21+.**
**Authority statement:** This report is **NON-AUTHORITATIVE EVIDENCE**. Authority order: **(1) `ROS_SRS_v1.0.pdf` → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (ratified R-1(a)…R-5, C-1, C-2, D-1, D-6, D-10 — none amended) → (3) the repository and its live databases at HEAD `0f10afe` → (4) the three prior P1G-1 close reports, **corrected on two points here** → (5) engineering inference, labelled.** Where this report and the SRS or the register differ, **they govern**.
**Date:** 2026-08-30
**HEAD:** `0f10afe` (unchanged; no commit performed) · **Branch:** `feat/production-spec`
**Migrations:** 33 (unchanged — **no migration file created**) · **OpenAPI:** 3.1.0 / 139 (unchanged)
**Working tree:** the 4 unrelated uncommitted reports, the three prior P1G-1 close reports, and their `INDEX.md` rows — all byte-identical. This report and one appended `INDEX.md` row added.
**Task identifier:** P1G-1 CashSession Close migration-compatibility closure

> ## VERDICT
> ## **A. P1G-1 MIGRATION DESIGN READY — R-6 ONLY**
>
> Both blockers are closed, and **every claim below was executed against real
> PostgreSQL 16.15 rather than reasoned from memory.** Two of the findings
> reverse what the prior reports assumed.
>
> * **Blocker A is REAL, not theoretical — and it would have aborted migration
>   34 on the actual development database.** The persistent `ros` DB contains
>   **33 CLOSED cash sessions** today. The prior plan's
>   `ck_cs_closed_is_complete` was executed against a faithful reproduction and
>   returned `ERROR: check constraint … is violated by some row`. The
>   legacy-tolerant replacement was executed against the same data and
>   succeeded. **No legacy state, no marker column, no backfill, no fabricated
>   attempt.**
> * **The enum question resolved the OPPOSITE way to the prior report's
>   caution.** A raw `BEGIN; ALTER TYPE … ADD VALUE; …use it…; COMMIT;` fails
>   with `unsafe use of new value` — but **Prisma Migrate 7.9.1 does not wrap a
>   migration file in a transaction**, proven by a migration whose later
>   statement failed while every earlier statement persisted. `ALTER TYPE … ADD
>   VALUE` **plus** its use in a CHECK **and** an RLS policy in the **same
>   file** applied cleanly. **One migration 34 is correct; no migration 35.**
> * **Blocker B closed relationally**, with the two three-column FKs executed
>   and proven to reject a cross-branch session and a cross-branch policy while
>   admitting the consistent row.
> * **§11's three exploit paths were executed as an unprivileged, `NOBYPASSRLS`
>   role** and all three were blocked.
>
> **R-6(a) remains the only business ratification.** Nothing in this review
> uncovered a new business-policy gap.

---

## 1. EMPIRICAL METHOD

Every claim marked **PROVEN** was executed against PostgreSQL **16.15** (the project's own container) on **throwaway databases** (`ros_enumtest`, `ros_enumproj`, `ros_enumproj2`, `ros_legacytest`), all **dropped afterwards**. The Prisma behaviour test ran from a **throwaway project directory in the scratchpad**, never inside the repository, so **no migration file was created in `prisma/migrations/`**. The persistent `ros` database was **read only** and re-verified unchanged at the end: **26 migrations, 196 open / 33 closed cash sessions — identical before and after.**

---

## 2. BLOCKER A — HISTORICAL CLOSED CASHSESSIONS

### 2.1 The blocker is real, and it is in the live database

```
SELECT status, count(*) FROM treasury.cash_sessions GROUP BY status;
 open   | 196
 closed |  33        ← legacy closed rows, TODAY, in the persistent `ros` DB
```

All 33 carry `closed_at` (33 of 33) and — necessarily — **NULL** for every column migration 34 introduces, because `ALTER TABLE … ADD COLUMN` of a nullable column sets existing rows to NULL.

**How can closed rows exist when no close path exists?** `ros_app` holds `GRANT SELECT, INSERT` on `cash_sessions`, and the INSERT policy constrains only `tenant_id` — so a row can be **created** with `status='closed'` even though it can never be **transitioned** to closed. Test fixtures and seeded data do exactly this. The provenance does not matter; **the rows exist and migration 34 must tolerate them.**

### 2.2 PROVEN — the prior plan aborts on this data

Reproduced faithfully (33 closed with `closed_at`, 196 open, then the eight new nullable columns added), then the prior plan's constraint applied:

```
ALTER TABLE ... ADD CONSTRAINT ck_cs_closed_is_complete_STRICT CHECK (
  status <> 'closed' OR (expected_cash IS NOT NULL AND ... ));

ERROR:  check constraint "ck_cs_closed_is_complete_strict" of relation
        "cash_sessions" is violated by some row
```

**Migration 34 as previously planned would have failed to apply.** This is a correction to my own prior report, which asserted the closed-completeness constraint without testing it against existing data.

### 2.3 PROVEN — the legacy-tolerant constraint set applies cleanly

Against the identical data, all four constraints applied in one statement: **`ALTER TABLE`** (success).

```sql
-- C1 · anchor, legacy-tolerant. 'closed' is permitted BOTH anchored (new) and
--      unanchored (legacy); 'closing' is only ever reachable via a new write.
CONSTRAINT ck_cs_attempt_anchor CHECK (
     (status = 'open'    AND close_attempt_id IS NULL)
  OR (status = 'closing' AND close_attempt_id IS NOT NULL)
  OR (status = 'closed')
);

-- C2 · core facts require an anchor. This is BOTH the closing-state freeze
--      AND the legacy guarantee: an unanchored row (open, closing, or legacy
--      closed) must hold NULL in every new P1G-1 column.
--      `closed_at` is deliberately EXCLUDED — all 33 legacy rows have it set.
CONSTRAINT ck_cs_core_facts_require_anchor CHECK (
     (status = 'closed' AND close_attempt_id IS NOT NULL)
  OR (expected_cash IS NULL AND counted_cash IS NULL AND variance IS NULL
      AND variance_reason IS NULL AND approval_request_id IS NULL
      AND closed_by_user_id IS NULL AND closed_by_employee_id IS NULL)
);

-- C3 · completeness applies ONLY to anchored P1G-1 closes (§4 of the brief).
CONSTRAINT ck_cs_anchored_close_complete CHECK (
     close_attempt_id IS NULL OR status <> 'closed'
  OR (expected_cash IS NOT NULL AND counted_cash IS NOT NULL AND variance IS NOT NULL
      AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL
      AND closed_by_employee_id IS NOT NULL)
);

-- C4 · one-directional: closed_at implies closed. Deliberately NOT a
--      biconditional — that would assume every legacy closed row has it.
CONSTRAINT ck_cs_closed_at_requires_closed CHECK (
  closed_at IS NULL OR status = 'closed'
);

-- C5/C6 · unchanged from the accepted design.
CONSTRAINT ck_cs_variance_arith  CHECK (variance IS NULL OR variance = counted_cash - expected_cash),
CONSTRAINT ck_cs_reason_nonblank CHECK (variance_reason IS NULL OR length(btrim(variance_reason)) > 0)
```

**Unknown historical facts stay NULL — never zero** (§4). A legacy close has no expected cash; recording `0` would assert a measurement that was never taken.

### 2.4 PROVEN — `ros_app` cannot create a new legacy-style closed row

The CHECKs are permissive at rest so the migration can apply. The **write gate** is the RLS UPDATE policy:

```sql
CREATE POLICY cash_sessions_update ON treasury.cash_sessions FOR UPDATE
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('open','closing'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('closing','closed')
              AND close_attempt_id IS NOT NULL);     -- ← the new-write gate
```

**Formal proof.** Every `ros_app` UPDATE must satisfy `WITH CHECK` on the **new** row. `WITH CHECK` requires `close_attempt_id IS NOT NULL`. Therefore **every row `ros_app` transitions into `closing` or `closed` is anchored to an immutable attempt.** Legacy closed rows are excluded by `USING`, so they are invisible to UPDATE, are never modified, and never have to satisfy `WITH CHECK`. ∎

**Executed as `ros_app_t` (`NOBYPASSRLS`), §11 verbatim:**

| Attack | Result |
|---|---|
| `OPEN → CLOSED`, `close_attempt_id` NULL, all core NULL | `ERROR: new row violates row-level security policy` ✅ |
| `OPEN → CLOSING` with no attempt | `ERROR: new row violates row-level security policy` ✅ |
| modify a legacy CLOSED row | `UPDATE 0` — invisible under `USING` ✅ |

**No business-visible "legacy" state and no marker column is introduced.** None is needed: `close_attempt_id IS NULL` on a closed row **is** the discriminator, and it is a genuine relational fact ("this close carries no P1G-1 declaration"), not an invented status value. A marker column would add a second, redundant source of the same truth — and §3 asks that one be justified only if the simpler design cannot work. It works, proven above.

---

## 3. ENUM MIGRATION SEQUENCING — RESOLVED BY EXECUTION (§9)

### 3.1 PROVEN — raw PostgreSQL rejects add-then-use in one transaction

```
BEGIN;
ALTER TYPE treasury."TestStatus" ADD VALUE 'closing';
ALTER TABLE treasury.t ADD CONSTRAINT ck_test CHECK (status IN ('open','closing'));
COMMIT;

ERROR:  unsafe use of new value "closing" of enum type treasury."TestStatus"
HINT:   New enum values must be committed before they can be used.
```

The whole transaction rolled back — the enum value was **not** added either. This is the hazard the prior report flagged.

### 3.2 PROVEN — but Prisma Migrate does not use one transaction

A throwaway Prisma project (outside the repository) with the realistic shape:

```sql
ALTER TYPE "treasury"."CashSessionStatus" ADD VALUE 'closing';
ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "ck_test" CHECK ("status" IN ('open','closing','closed'));
```

→ **`All migrations have been successfully applied.`** End state verified: enum labels `open, closed, closing`; constraint present and correctly typed.

A second file additionally used the new value in an **RLS policy** and then deliberately failed on `SELECT 1/0`:

```
Error: P3018 · Database error code: 22012 · ERROR: division by zero
```

Yet afterwards the new enum value **`frozen`**, the RLS policy **`p_test`**, and the marker table created immediately before the failing statement had **all persisted**. **Prisma Migrate 7.9.1 executes migration statements non-transactionally**, so each `ALTER TYPE … ADD VALUE` commits before later statements use it.

### 3.3 Decision — **Option A: one migration 34. No migration 35.**

Per §9's instruction not to force one migration if correctness requires two — correctness **does not**. Splitting would add a migration for no benefit.

**Operational corollary, recorded because it is the other side of the same finding:** because migrations are **not** transactional, a mid-file failure leaves migration 34 **partially applied**, requiring `prisma migrate resolve`. The implementation slice must therefore (a) order statements so object creation precedes constraint/grant/RLS statements, and (b) treat the §4 scratch proof as mandatory, since a from-zero replay is the only way to catch a partial-apply hazard before it reaches a real database.

---

## 4. SCRATCH-PROOF REQUIREMENT FOR IMPLEMENTATION (§10)

The implementation prompt must require a scratch database seeded **before** the new migration with:

1. at least one **pre-P1G-1 CLOSED** CashSession (`status='closed'`, `closed_at` set, all new columns absent) — the exact shape of the 33 real rows;
2. at least one **OPEN** CashSession;

then `prisma migrate deploy` from **1 → 34** via the real CLI, proving:

* all 34 migrations apply cleanly, **including the enum path through the actual runner** (§3.2's method, not a hand-run `psql` script);
* the historical CLOSED row **survives unchanged** — same `closed_at`, new columns NULL, `close_attempt_id` NULL;
* the OPEN row survives with `close_attempt_id` NULL;
* **no attempt row was fabricated** (`SELECT count(*) FROM treasury.cash_session_close_attempts` → `0`);
* the new invariants bite **afterwards** — the §2.4 attacks fail as `ros_app`.

---

## 5. BLOCKER B — ATTEMPT BRANCH AND POLICY OWNERSHIP (§6)

### 5.1 The gap

With independent FKs on `cash_session_id`, `branch_id` and `policy_version_id`, a single tenant could hold a structurally incoherent immutable accounting fact: a session in Branch A, `branch_id` = Branch B, and a policy belonging to Branch B. Service code intends them to match; nothing proved it.

### 5.2 The correction — two three-column FKs, executed and proven

New unique targets (both Treasury-owned; **no module-boundary issue**):

```sql
ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "uq_cs_branch_scoped_id" UNIQUE ("tenant_id","branch_id","id");
ALTER TABLE "treasury"."cash_close_policies"
  ADD CONSTRAINT "uq_ccp_branch_scoped_id" UNIQUE ("tenant_id","branch_id","id");
```

Replacing the two separate FKs on the attempt:

```sql
CONSTRAINT "csca_session_fkey" FOREIGN KEY ("tenant_id","branch_id","cash_session_id")
  REFERENCES "treasury"."cash_sessions"("tenant_id","branch_id","id") ON DELETE RESTRICT,
CONSTRAINT "csca_policy_fkey"  FOREIGN KEY ("tenant_id","branch_id","policy_version_id")
  REFERENCES "treasury"."cash_close_policies"("tenant_id","branch_id","id") ON DELETE RESTRICT
```

**PROVEN against real PostgreSQL:**

| Case | Result |
|---|---|
| attempt claims **Branch B** for a Branch-A session | FK violation — `Key (tenant_id, branch_id, cash_session_id)=(…, …b, …) is not present in table "cash_sessions"` ✅ |
| attempt uses a policy belonging to **another branch** | FK violation — `Key (tenant_id, branch_id, policy_version_id)=(…, …a, …b) is not present in table "cash_close_policies"` ✅ |
| fully consistent session/branch/policy | `INSERT 0 1` ✅ |

**No column is duplicated** — `branch_id` already existed on the attempt and simply becomes load-bearing. **The separate `csca_branch_fkey` to `org.branches` is dropped as redundant**: `cash_sessions` already carries its own `(tenant_id, branch_id) → org.branches` FK, so branch validity is proven transitively. Cross-tenant variants fail on the same constraints (`tenant_id` leads every key) and are additionally invisible under RLS.

The session→attempt anchor from the prior report is unchanged: `(tenant_id, id, close_attempt_id) → cash_session_close_attempts(tenant_id, cash_session_id, id)`, which together with `UNIQUE (tenant_id, cash_session_id)` still makes attempt substitution admit exactly one legal value.

---

## 6. ACTOR AND TERMINAL PROVENANCE (§7)

Decided **mechanically from the schema's actual unique targets**, inventing no relationship:

| Column | Decision | Basis |
|---|---|---|
| `declared_by_user_id` | **FK → `identity.users(id)`**, `ON DELETE RESTRICT` | `User.id` is the global PK; exact precedent `cash_movements.performed_by` and `stock_movements.performed_by`. A nonexistent Identity User is now unrepresentable |
| `terminal_id` | **FK `(branch_id, terminal_id) → identity.terminals(branch_id, id)`**, `ON DELETE RESTRICT` | `Terminal` already exposes `@@unique([branchId, id])` (ADR 0008 D-16) — the same **branch-safe** target `Drawer.terminal` and `OrderPayment.terminal` use. Because the attempt's `branch_id` is itself proven equal to the session's branch (§5), a terminal from another branch is structurally unrepresentable |
| `declared_by_employee_id` | **FK `(tenant_id, declared_by_employee_id) → identity.employees(tenant_id, id)`** | tenant-safe composite, unchanged from the accepted design |

No tenant-scoped unique target exists on `identity.terminals` (`@@unique([tenantId, branchId, name])` is name-keyed, not id-keyed), so the branch-safe form is the strongest the **actual** model supports — and it is strictly stronger than a bare `terminals(id)` reference.

---

## 7. `created_at` GRANT INTEGRITY (§8)

The prior plan's table-level `GRANT INSERT` would have let `ros_app` **forge** `created_at`, defeating its `DEFAULT statement_timestamp()`. Corrected to the **column-level** posture already ratified and empirically verified in migration 32 (`approval_decisions`) and migration 33 (`cash_close_policies`):

```sql
GRANT SELECT ON "treasury"."cash_session_close_attempts" TO ros_app;
GRANT INSERT ("id","tenant_id","branch_id","cash_session_id",
              "policy_version_id","tolerance_minor_units","count_mode",
              "opening_float","cash_sales_total","cash_tips_total","pay_in_total",
              "cash_refunds_total","pay_out_total","safe_drop_total",
              "cash_rounding_adjustments","expected_cash","counted_cash","variance",
              "currency","approval_required","declared_by_employee_id",
              "declared_by_user_id","terminal_id","declared_at")
  ON "treasury"."cash_session_close_attempts" TO ros_app;   -- created_at DELIBERATELY OMITTED
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."cash_session_close_attempts" FROM ros_app;

-- denominations: table-level INSERT is correct here — the table has NO
-- server-set column to protect (all four columns are caller-supplied).
GRANT SELECT, INSERT ON "treasury"."cash_count_denominations" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."cash_count_denominations" FROM ros_app;
```

**`declared_at` and `created_at` are kept distinct**, as §8 requires: `declared_at` is the **device event instant** the cashier's terminal asserts (caller-supplied, mirroring `cash_movements.occurred_at`); `created_at` is **database persistence provenance**, server-set and un-forgeable. Conflating them would let a device rewrite when the server received the count.

---

## 8. FINAL MIGRATION PLAN — **MIGRATION 34 ONLY** (planned; **NOT created**)

Reason: §3.2 proves Prisma Migrate executes statements non-transactionally, so the enum value commits before its use in the same file. A migration 35 would be ceremony.

**Statement order matters** (non-transactional runner — §3.3): enum → new tables → new unique targets → session columns → constraints/FKs → grants → RLS.

```sql
-- 1 ENUM (proven safe in this file under Prisma Migrate — §3.2)
ALTER TYPE "treasury"."CashSessionStatus" ADD VALUE 'closing';

-- 2 IMMUTABLE CLOSE ATTEMPT (client-keyed PK, FR-OFF-015)
CREATE TABLE "treasury"."cash_session_close_attempts" (
  "id" UUID NOT NULL,                       -- client ULID; server NEVER reassigns
  "tenant_id" UUID NOT NULL, "branch_id" UUID NOT NULL, "cash_session_id" UUID NOT NULL,
  "policy_version_id" UUID NOT NULL, "tolerance_minor_units" BIGINT NOT NULL,
  "count_mode" "treasury"."CashCountMode" NOT NULL,
  "opening_float" BIGINT NOT NULL, "cash_sales_total" BIGINT NOT NULL,
  "cash_tips_total" BIGINT NOT NULL, "pay_in_total" BIGINT NOT NULL,
  "cash_refunds_total" BIGINT NOT NULL, "pay_out_total" BIGINT NOT NULL,
  "safe_drop_total" BIGINT NOT NULL, "cash_rounding_adjustments" BIGINT NOT NULL,
  "expected_cash" BIGINT NOT NULL, "counted_cash" BIGINT NOT NULL,
  "variance" BIGINT NOT NULL, "currency" CHAR(3) NOT NULL,
  "approval_required" BOOLEAN NOT NULL,
  "declared_by_employee_id" UUID NOT NULL, "declared_by_user_id" UUID NOT NULL,
  "terminal_id" UUID NOT NULL, "declared_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT "cash_session_close_attempts_pkey" PRIMARY KEY ("id"),
  -- FR-FIN-004. Overflow-safe: the DTO cap ^\d{1,18}$ keeps 8 terms under BIGINT_MAX.
  -- WIDENING THAT REGEX TO 19 DIGITS WOULD BREAK THIS CONSTRAINT.
  CONSTRAINT "ck_csca_formula" CHECK (
    expected_cash = opening_float + cash_sales_total + cash_tips_total + pay_in_total
                  - cash_refunds_total - pay_out_total - safe_drop_total
                  + cash_rounding_adjustments),
  CONSTRAINT "ck_csca_variance" CHECK (variance = counted_cash - expected_cash),
  CONSTRAINT "ck_csca_nonneg"   CHECK (counted_cash >= 0 AND opening_float >= 0
                                       AND tolerance_minor_units >= 0),
  CONSTRAINT "ck_csca_currency" CHECK (currency ~ '^[A-Z]{3}$'),
  -- ratified R-2(a), OVERFLOW-SAFE (abs() would raise on BIGINT_MIN)
  CONSTRAINT "ck_csca_approval_required_matches" CHECK (
    approval_required = (variance > tolerance_minor_units
                         OR variance < -tolerance_minor_units)),
  -- phase markers: the slice implementing tips/refunds MUST drop these
  CONSTRAINT "ck_csca_tips_structurally_zero_p1g1"    CHECK (cash_tips_total = 0),
  CONSTRAINT "ck_csca_refunds_structurally_zero_p1g1" CHECK (cash_refunds_total = 0)
);
CREATE UNIQUE INDEX "cash_session_close_attempts_tenant_id_id_key"
  ON "treasury"."cash_session_close_attempts"("tenant_id","id");
CREATE UNIQUE INDEX "uq_csca_one_per_session"                 -- blind-integrity guarantee
  ON "treasury"."cash_session_close_attempts"("tenant_id","cash_session_id");
ALTER TABLE "treasury"."cash_session_close_attempts"
  ADD CONSTRAINT "uq_csca_session_scoped_id" UNIQUE ("tenant_id","cash_session_id","id");

-- 3 DENOMINATIONS — composite identity, no synthetic id
CREATE TABLE "treasury"."cash_count_denominations" (
  "tenant_id" UUID NOT NULL, "close_attempt_id" UUID NOT NULL,
  "denomination_minor_units" BIGINT NOT NULL, "quantity" INTEGER NOT NULL,
  CONSTRAINT "cash_count_denominations_pkey"
    PRIMARY KEY ("tenant_id","close_attempt_id","denomination_minor_units"),
  CONSTRAINT "ck_ccd_denom_positive" CHECK ("denomination_minor_units" > 0),
  CONSTRAINT "ck_ccd_qty_positive"   CHECK ("quantity" > 0),
  CONSTRAINT "ccd_attempt_fkey" FOREIGN KEY ("tenant_id","close_attempt_id")
    REFERENCES "treasury"."cash_session_close_attempts"("tenant_id","id") ON DELETE RESTRICT
);

-- 4 NEW UNIQUE TARGETS for the ownership FKs (Blocker B)
ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "uq_cs_branch_scoped_id" UNIQUE ("tenant_id","branch_id","id");
ALTER TABLE "treasury"."cash_close_policies"
  ADD CONSTRAINT "uq_ccp_branch_scoped_id" UNIQUE ("tenant_id","branch_id","id");

-- 5 ATTEMPT FKs — ownership proven relationally (§5, §6)
ALTER TABLE "treasury"."cash_session_close_attempts"
  ADD CONSTRAINT "csca_session_fkey" FOREIGN KEY ("tenant_id","branch_id","cash_session_id")
    REFERENCES "treasury"."cash_sessions"("tenant_id","branch_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "csca_policy_fkey"  FOREIGN KEY ("tenant_id","branch_id","policy_version_id")
    REFERENCES "treasury"."cash_close_policies"("tenant_id","branch_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "csca_employee_fkey" FOREIGN KEY ("tenant_id","declared_by_employee_id")
    REFERENCES "identity"."employees"("tenant_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "csca_user_fkey" FOREIGN KEY ("declared_by_user_id")
    REFERENCES "identity"."users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "csca_terminal_fkey" FOREIGN KEY ("branch_id","terminal_id")
    REFERENCES "identity"."terminals"("branch_id","id") ON DELETE RESTRICT;
-- NOTE: no direct org.branches FK — branch validity is proven transitively
-- through cash_sessions' own (tenant_id, branch_id) FK.

-- 6 cash_sessions NEW COLUMNS (closed_at already exists)
ALTER TABLE "treasury"."cash_sessions"
  ADD COLUMN "close_attempt_id" UUID NULL, ADD COLUMN "expected_cash" BIGINT NULL,
  ADD COLUMN "counted_cash" BIGINT NULL,   ADD COLUMN "variance" BIGINT NULL,
  ADD COLUMN "variance_reason" TEXT NULL,  ADD COLUMN "approval_request_id" UUID NULL,
  ADD COLUMN "closed_by_user_id" UUID NULL,
  ADD COLUMN "closed_by_employee_id" UUID NULL;

-- 7 LEGACY-COMPATIBLE CONSTRAINTS (§2.3 — proven to apply over the 33 real rows)
ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "ck_cs_attempt_anchor"            CHECK (/* C1 */),
  ADD CONSTRAINT "ck_cs_core_facts_require_anchor" CHECK (/* C2 */),
  ADD CONSTRAINT "ck_cs_anchored_close_complete"   CHECK (/* C3 */),
  ADD CONSTRAINT "ck_cs_closed_at_requires_closed" CHECK (/* C4 */),
  ADD CONSTRAINT "ck_cs_variance_arith"            CHECK (/* C5 */),
  ADD CONSTRAINT "ck_cs_reason_nonblank"           CHECK (/* C6 */),
  ADD CONSTRAINT "cash_sessions_close_attempt_fkey"
    FOREIGN KEY ("tenant_id","id","close_attempt_id")
    REFERENCES "treasury"."cash_session_close_attempts"("tenant_id","cash_session_id","id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cash_sessions_closed_by_user_id_fkey"
    FOREIGN KEY ("closed_by_user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "cash_sessions_tenant_id_closed_by_employee_id_fkey"
    FOREIGN KEY ("tenant_id","closed_by_employee_id")
    REFERENCES "identity"."employees"("tenant_id","id") ON DELETE RESTRICT;

-- 8 GRANTS (§7 — column-level INSERT excluding created_at)
GRANT UPDATE ("status","close_attempt_id","closed_at","expected_cash","counted_cash",
              "variance","variance_reason","approval_request_id",
              "closed_by_user_id","closed_by_employee_id")
  ON "treasury"."cash_sessions" TO ros_app;
-- (attempt + denomination grants exactly as §7)

-- 9 RLS
ALTER TABLE "treasury"."cash_session_close_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."cash_session_close_attempts" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "treasury"."cash_count_denominations"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."cash_count_denominations"    FORCE  ROW LEVEL SECURITY;
-- SELECT + INSERT policies only on both; fail-closed NULLIF predicate; no UPDATE/DELETE policy.
CREATE POLICY cash_sessions_update ON "treasury"."cash_sessions" FOR UPDATE
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('open','closing'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('closing','closed')
              AND close_attempt_id IS NOT NULL);
```

---

## 9. TEST MATRIX — PRIOR 62 PRESERVED, 8 ADDED

| # | Test | Expected |
|---|---|---|
| 63 | migrate 1 → 34 over a scratch DB seeded with a **pre-P1G-1 CLOSED** session and an OPEN session | all apply; **legacy row unchanged**; new columns NULL; **zero attempt rows created** |
| 64 | after migration, `ros_app` attempts `OPEN → CLOSED` with `close_attempt_id` NULL | **RLS violation** (proven, §2.4) |
| 65 | after migration, `ros_app` attempts `OPEN → CLOSING` with no attempt | **RLS violation** (proven, §2.4) |
| 66 | `ros_app` attempts to modify a legacy CLOSED row | **0 rows affected** (proven, §2.4) |
| 67 | attempt for Session A claims Branch B | **FK violation** (proven, §5.2) |
| 68 | attempt uses a policy belonging to another branch | **FK violation** (proven, §5.2) |
| 69 | cross-tenant variants of 67/68 | FK violation; row also invisible under RLS |
| 70 | `ros_app` supplies `created_at` explicitly on a close attempt | **`permission denied`** (column-level grant) |

Plus the enum path proven **through the real Prisma CLI**, not a hand-run script. All genuine races ≥3 clean runs; no arbitrary sleeps.

---

## 10. PRESERVED WITHOUT CHANGE (§13)

Two-phase blind close; **no** above-tolerance initial fast approval; client-generated `closeAttemptId`; denomination composite identity; policy pinned at `opened_at` (**R-3(a)**); strict `>` threshold with equality within tolerance (**R-2(a)**); tips/refunds structural zeros; the Payment `ros_cash_session` advisory-lock correction; the `CashSessionsService.open` → `BRANCH_CURRENCY_QUERY` correction; the `statement_timestamp()` expiry base; rejection-commits-with-200 semantics; **R-6(a)** recommendation; no Shift auto-close; no `/v1` retrofit. Requirement classifications unchanged (FR-FIN-004/007/010 and FR-SEC-032 **PARTIAL**; branch-scoped RBAC **NOT IMPLEMENTED**, not claimed).

---

## 11. R-6 POSITION (§14)

**R-6(a) remains the ONLY business ratification candidate.** This review surfaced **no new business-policy gap** — every item it resolved was migration mechanics or relational integrity, decided by executed evidence:

| Resolved as mechanics — **not** ratification | Basis |
|---|---|
| Legacy-tolerant CHECK shapes | executed against a faithful reproduction of the 33 real rows |
| `close_attempt_id IS NOT NULL` in `WITH CHECK` | executed as an unprivileged role; three attacks blocked |
| One migration vs two | executed through the real Prisma CLI |
| Branch/policy ownership FKs | executed; three cases proven |
| `declared_by_user_id` / `terminal_id` FKs | chosen mechanically from the schema's existing unique targets |
| Column-level `created_at` grant | the ratified migration-32/33 posture |

**Not recorded in governance by this task**, as instructed.

---

## 12. VERDICT

# **A. P1G-1 MIGRATION DESIGN READY — R-6 ONLY**

Blocker A is closed with legacy-tolerant CHECKs plus an RLS write-gate, both executed against real data — and the review **caught a defect that would have aborted migration 34 on the live development database**. Blocker B is closed by two executed three-column FKs. Enum sequencing is settled empirically as **one migration**. **No Sonnet implementation prompt is issued**, because R-6 remains unratified.

---

## Scope compliance

Design/migration review only. No product code, no migration file created (34 planned only), no test modification, **no governance recording**, no `D-21+`, no commit, no push, no deployment. No destructive git command used. All empirical work ran on throwaway databases and a throwaway project directory outside the repository; every scratch database was dropped. **The persistent `ros` database was read-only throughout and re-verified unchanged (26 migrations; 196 open / 33 closed cash sessions).** HEAD `0f10afe` unchanged; prior reports not overwritten; `INDEX.md` appended to only.

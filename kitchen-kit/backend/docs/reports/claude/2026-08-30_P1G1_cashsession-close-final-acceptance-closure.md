# P1G-1 CashSession Close — Design FINAL Acceptance Closure

**Task / slice:** P1G-1 CashSession Close — closure of two implementation-critical defects and one arithmetic-hardening issue
**Report type:** Design correction. **No product code, no migration, no test change, no governance recording, no commit, no push, no deployment, no D-21+.**
**Authority statement:** This report is **NON-AUTHORITATIVE EVIDENCE**. Authority order: **(1) `ROS_SRS_v1.0.pdf` → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (ratified R-1(a)…R-5, D-1, D-6, D-10, C-1, C-2 — none amended here) → (3) the repository at HEAD `0f10afe`, including the accepted Approval Runtime implementation → (4) the two prior P1G-1 close reports, **corrected on two points by this report** → (5) engineering inference, labelled.** Where this report and the SRS or the register differ, **they govern**.
**Date:** 2026-08-30
**HEAD:** `0f10afe` (unchanged; no commit performed) · **Branch:** `feat/production-spec`
**Migrations:** 33 (unchanged — **migration 34 planned only, NOT created**) · **OpenAPI:** 3.1.0 / 139 (unchanged)
**Working tree:** the 4 unrelated uncommitted reports, the two prior P1G-1 close design reports, and their `INDEX.md` rows — all left byte-identical. This report and one appended `INDEX.md` row added.
**Task identifier:** P1G-1 CashSession Close design final acceptance closure

> ## VERDICT
> ## **A. P1G-1 DESIGN FINAL-ACCEPTANCE READY — R-6 ONLY**
>
> All three items are closed, **relationally** rather than procedurally, and
> **R-6(a) remains the single user-ratification item**.
>
> * **Defect A — expiry base: CORRECTED.** The brief is right and the prior
>   report was wrong. `transaction_timestamp()` is **fixed at BEGIN**, and the
>   finalisation transaction's *first* act is to wait on the
>   `ros_cash_session` advisory lock — so a lock wait ages the TTL before the
>   request is ever created. The base is now the **DB statement instant read
>   immediately before `createRequest`**, which is the *same clock the decision
>   RLS policy already uses*. **D-10 unchanged, the decision policy unchanged,
>   no default duration introduced.**
> * **Defect B — the close-attempt anchor: CORRECTED, and proven by relational
>   constraints alone.** The prior plan let raw `ros_app` set `status='closing'`
>   with no attempt row at all. `cash_sessions` now carries
>   `close_attempt_id`, anchored by a **three-column composite FK**
>   `(tenant_id, id, close_attempt_id) → cash_session_close_attempts(tenant_id,
>   cash_session_id, id)`. Combined with the existing
>   `UNIQUE (tenant_id, cash_session_id)` this makes attempt **substitution
>   mathematically impossible** — there is exactly one legal value the column
>   can ever hold. **No trigger** (the repository still contains zero).
> * **Defect C — `abs()` overflow: CORRECTED.** `abs(-9223372036854775808::bigint)`
>   raises `bigint out of range`. The CHECK is restated as
>   `variance > tol OR variance < -tol`, which is exactly equivalent for
>   `tol >= 0`, never overflows, and is mirrored in TypeScript so SQL and
>   application cannot diverge.
>
> **Two corrections to my own prior reports are recorded plainly** (§2.1, §3.1)
> rather than quietly fixed: the "structurally unreachable" expiry claim and
> the unenforced attempt anchor were both wrong.

---

## 1. WHAT WAS VERIFIED AT `0f10afe`

| Fact | Evidence |
|---|---|
| `CreateApprovalRequestCommand.expiresAt` **must be a JS `Date`** — no SQL expression can be passed | `approvals.service.ts`: `if (!(command.expiresAt instanceof Date) \|\| Number.isNaN(...)) throw new BadRequestException('expiresAt must be a valid Date.')` |
| It is bound as a parameter, not an expression | `${command.expiresAt}::timestamptz` inside the raw INSERT |
| The decision policy's expiry conjunct uses `statement_timestamp()` | migration 32 `:216` — `r.expires_at < statement_timestamp()` |
| `decide()` throws `ApprovalDecisionRejectedError` on the RLS violation | `catch (err) { if (isRowLevelSecurityViolation(err)) throw ... }` |
| `cash_sessions` already exposes `UNIQUE (tenant_id, id)` — the target the attempt→session FK needs | `schema.prisma` `@@unique([tenantId, id])` |
| **Nullable-column composite FK precedent exists** (MATCH SIMPLE) | `drawers_terminal_fkey FOREIGN KEY ("branch_id","terminal_id")` with `terminal_id` nullable — migration `20260820160000:142` |
| **Zero** triggers / functions / rules across all 33 migrations | exhaustive grep (re-confirmed) |
| PostgreSQL is 16.15 | `SHOW server_version` |

---

## 2. DEFECT A — APPROVAL EXPIRY BASE

### 2.1 Correction to my prior report

My acceptance-closure report claimed expiry was *"structurally unreachable"* because `createRequest` and `decide` are adjacent. **That was wrong, and the reasoning error is worth naming precisely:** I computed the TTL from `transaction_timestamp()`, which PostgreSQL fixes at **transaction start** — not at the moment the request is created. The finalisation transaction's **first** statement is:

```sql
SELECT pg_advisory_xact_lock(hashtext('ros_cash_session'), hashtext($1))
```

which **blocks** whenever a payment, a cash movement, or a concurrent close holds the same lock. A 40-second wait against a configured `variance_approval_expiry_seconds = 60` leaves the request with 20 seconds of life the moment it is born; a 60-second wait produces a request that is **already expired at creation**. Far from unreachable, the failure is *most likely* exactly when the system is busiest — and it would have manifested as a baffling intermittent rejection under load. The brief's Defect A is correct.

It also contradicted the accepted Approval design's own deliberate distinction: **D-10 (E2) evaluates validity lazily at the decision INSERT using `statement_timestamp()`**. Basing the TTL on `transaction_timestamp()` while the check uses `statement_timestamp()` mixes two different clocks across the same window.

### 2.2 The correction

**Only the base instant changes.** The configured duration from ratified **R-4(a)** is untouched.

Because the contract demands a JS `Date`, Treasury reads the **database's** current statement instant immediately before creating the request, then adds the configured seconds:

```ts
// INSIDE the finalisation transaction, AFTER the advisory lock has been
// acquired and the policy resolved — immediately before createRequest.
const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
  SELECT statement_timestamp() AS "now"
`;
const expiresAt = new Date(
  now.getTime() + policy.varianceApprovalExpirySeconds * 1000,
);
```

**Why `statement_timestamp()` and not something else:**

| Candidate | Verdict |
|---|---|
| `transaction_timestamp()` / `now()` | **Forbidden by the brief and wrong** — fixed at BEGIN, ages across the lock wait |
| **`statement_timestamp()`** | **SELECTED.** Advances per statement, so a lock wait cannot age it. It is the **identical primitive the decision RLS policy already evaluates**, so the window is measured and checked on one clock |
| `clock_timestamp()` | Also correct (differs by microseconds) but introduces a *second* clock primitive for no benefit; `statement_timestamp()` is preferred purely for symmetry with the policy |
| Application `new Date()` | Rejected — the app clock is not the clock the RLS predicate evaluates; skew between app host and DB would silently widen or narrow the window |

**What is explicitly NOT changed:** **D-10** is untouched; the decision RLS policy still evaluates `r.expires_at < statement_timestamp()`; generic Governance semantics are unchanged; `expiresAt` remains mandatory with **no default duration** anywhere. This is a change to *how the consuming domain computes its own value*, which is precisely what the ratification left to Treasury.

**Classification: DESIGN-DECIDABLE.** No governance decision is touched or required.

### 2.3 Corrected characterisation of expiry (§4 of the brief)

The word *"structurally unreachable"* is **withdrawn**. The accurate statement:

> In the synchronous P1G-1 flow, expiry should be **uncommon** — PIN verification happens before the transaction, request creation and decision are adjacent statements, and no network call occurs between them. It nevertheless **remains reachable** under a sufficiently long database delay (advisory-lock contention, checkpoint stall, saturated pool).

**When it does fire**, the behaviour is proven from the accepted implementation:

1. the decision INSERT violates the RLS `WITH CHECK` (SQLSTATE `42501`);
2. `decide()` catches it and **throws** `ApprovalDecisionRejectedError`;
3. the throw propagates out of Treasury's transaction → **full rollback**, taking the `approval_requests` row created moments earlier with it;
4. **no expired ApprovalRequest survives** — there is no orphan Governance state to reconcile;
5. the CashSession remains **`CLOSING`** (the rollback undid nothing committed);
6. the immutable close attempt is **untouched** (it was committed by the earlier `POST /close` transaction);
7. the caller retries `finalize`, producing a **new** request with a **fresh** expiry computed from the new statement instant.

**Therefore expiry requires no business ratification** — there is no state for a human policy to govern — **but it is a real rollback/retry path and must be tested** (tests 60 and 61). **R-6 remains rejection-only.**

---

## 3. DEFECT B — THE CLOSE-ATTEMPT ANCHOR

### 3.1 Correction to my prior report

My prior design claimed *"every close/freeze is anchored by the immutable declaration"* but did **not** enforce it. Under that plan, raw `ros_app` could execute:

```sql
UPDATE treasury.cash_sessions SET status = 'closing' WHERE id = $1;   -- no attempt inserted
```

and satisfy every proposed CHECK, because `ck_cs_core_facts_only_when_closed` merely required the core columns to be **NULL** while closing — which they already were. Equally, a raw `open → closed` UPDATE could populate the session's core fields directly with **no attempt row in existence at all**, defeating the entire audit-reconstruction premise. **The invariant was asserted in prose and unenforced in the schema.** The brief's Defect B is correct.

### 3.2 The correction — a relational anchor, not a trigger

`treasury.cash_sessions` gains one column:

```sql
close_attempt_id UUID NULL
```

with a status/attempt binding CHECK and a **three-column composite FK** that proves *exact* ownership:

```sql
-- the attempt table gains the matching unique target
ALTER TABLE "treasury"."cash_session_close_attempts"
  ADD CONSTRAINT "uq_csca_session_scoped_id"
  UNIQUE ("tenant_id", "cash_session_id", "id");

-- the session anchors to it, proving tenant AND session ownership relationally
ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "cash_sessions_close_attempt_fkey"
  FOREIGN KEY ("tenant_id", "id", "close_attempt_id")
  REFERENCES "treasury"."cash_session_close_attempts"("tenant_id", "cash_session_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "ck_cs_attempt_anchor" CHECK (
    (status = 'open'                 AND close_attempt_id IS NULL) OR
    (status IN ('closing','closed')  AND close_attempt_id IS NOT NULL)
  );
```

Note the FK's **middle column is the session's own `id`**, matched against the attempt's `cash_session_id`. That is what turns a generic tenant-safe reference into a proof of *this* session's ownership — a plain `(tenant_id, close_attempt_id)` FK would only prove same-tenant, exactly as the brief warns.

**The nullable-column behaviour is the established one:** PostgreSQL's default `MATCH SIMPLE` skips the constraint entirely when any FK column is NULL, so an `open` session (`close_attempt_id IS NULL`) satisfies it trivially while a `closing`/`closed` session is fully checked. The repository already relies on this exact behaviour — `drawers_terminal_fkey FOREIGN KEY (branch_id, terminal_id)` with a nullable `terminal_id` (migration `20260820160000:142`).

### 3.3 Why attempt substitution is now *impossible* — the proof (§7 of the brief)

Let session `S` be in state `closing`, anchored to attempt `A`. Suppose `ros_app` attempts `UPDATE cash_sessions SET close_attempt_id = X WHERE id = S`.

1. `ck_cs_attempt_anchor` forbids `X = NULL` while `status IN ('closing','closed')`.
2. The composite FK requires the row `X` to satisfy `tenant_id = S.tenant_id` **and** `cash_session_id = S.id`.
3. `UNIQUE (tenant_id, cash_session_id)` on `cash_session_close_attempts` permits **at most one** row satisfying (2) — and that row is `A`.
4. Therefore `X = A` is the **only** value the column can legally hold. ∎

Creating a second attempt to swap to is blocked by the same `UNIQUE (tenant_id, cash_session_id)`. Referencing another session's attempt fails condition (2). Referencing another tenant's attempt fails condition (2) and is additionally invisible under RLS. **No trigger is required, and none is introduced** — the repository's zero-trigger precedent is preserved.

### 3.4 Write order and the circular reference (§7)

`cash_sessions ↔ cash_session_close_attempts` now reference each other. This needs **no deferred constraint**, because the write order resolves it naturally:

```
1. pg_advisory_xact_lock('ros_cash_session', cashSessionId)
2. INSERT cash_session_close_attempts      -- FK → cash_sessions: the session already exists ✓
3. INSERT cash_count_denominations         -- FK → the attempt just inserted ✓
4. UPDATE cash_sessions SET close_attempt_id = <attempt>,
          status = 'closing'                                    (above tolerance)
       OR status = 'closed' + core facts                        (within tolerance)
                                            -- FK → the attempt just inserted ✓
5. audit
6. COMMIT
```

Every FK is satisfied at the moment of its own statement. `close_attempt_id` is nullable and populated by a **later UPDATE**, never by the session's original INSERT, so the classic circular-NOT-NULL-INSERT problem that would require `DEFERRABLE INITIALLY DEFERRED` does not arise.

**For `CLOSING → CLOSED`, `close_attempt_id` is not re-written at all** — the finalisation UPDATE touches only `status`, `closed_at`, `closed_by_*`, the core facts, `variance_reason` and `approval_request_id`. Even if it did rewrite the column, §3.3 proves the only legal value is the value already there.

### 3.5 Every invariant §10 demands, and what proves it

| Invariant | Proof |
|---|---|
| **OPEN → CLOSING only with an immutable attempt** | `ck_cs_attempt_anchor` (NOT NULL) **+** composite FK (must reference a real, session-owned attempt) |
| **OPEN → CLOSED only with an immutable attempt** | identical — plus `ck_cs_closed_is_complete` |
| **CLOSING → CLOSED only with the SAME attempt** | §3.3 — exactly one legal value exists |
| **CLOSED → anything impossible** | RLS `USING (status IN ('open','closing'))` — a closed row is **invisible to UPDATE** for `ros_app` |
| **Count / policy / denominations immutable throughout** | **no UPDATE or DELETE grant** on either append-only table, plus `UNIQUE (tenant_id, cash_session_id)` |
| **Core facts frozen while CLOSING** | `ck_cs_core_facts_only_when_closed` — every core column must be NULL unless `status = 'closed'` |
| `closing → open` (un-freeze) | RLS `WITH CHECK (status IN ('closing','closed'))` |

Per §10's instruction, no invariant above is claimed unless a database object proves it. **The one boundary that remains service-enforced, and is named as such:** that the figures written at `CLOSED` are *copied from* the anchored attempt rather than recomputed or invented. The FK proves *which* attempt is authoritative and the CHECKs prove *when* the columns may be written; that the service reads from that attempt is a service-layer guarantee, covered by tests 50 and 58.

---

## 4. DEFECT C — OVERFLOW-SAFE `abs()` (§9)

`abs(-9223372036854775808::bigint)` raises `ERROR: bigint out of range`, because `BIGINT_MIN` has no representable positive counterpart. A CHECK constraint that *raises* instead of *failing cleanly* is a latent defect: the caller would see an opaque database error rather than a constraint violation.

**Restated, overflow-safe, and exactly equivalent for `tolerance_minor_units >= 0`:**

```sql
CONSTRAINT "ck_csca_approval_required_matches" CHECK (
  approval_required = (
    variance >  tolerance_minor_units OR
    variance < -tolerance_minor_units      -- negating a NON-NEGATIVE bigint is always safe
  )
)
```

Negation is safe because `tolerance_minor_units >= 0` is itself CHECK-enforced, and `-BIGINT_MAX` is representable (`BIGINT_MIN = -BIGINT_MAX - 1`). The comparison is exact for **every** representable `variance`, including `BIGINT_MIN`. Ratified semantics are unchanged: strictly greater, equality within tolerance (**R-2(a)**).

**TypeScript mirrors the same shape** so the two can never diverge:

```ts
const beyondTolerance = variance > tolerance || variance < -tolerance;
```

JavaScript `BigInt` is arbitrary-precision, so `-variance` could not overflow there — but writing the *identical* two-sided form keeps the SQL constraint and the application predicate textually and semantically aligned, which is the property that actually prevents drift.

**A related bound worth recording as load-bearing:** the DTO money pattern `^\d{1,18}$` caps every input below `10^18`. The eight-term expected-cash sum therefore stays under `8 × 10^18 < BIGINT_MAX ≈ 9.223 × 10^18`, so the formula CHECK's own arithmetic cannot overflow. **Widening that regex to 19 digits would break this**, and the migration comment must say so.

**Classification: DESIGN-DECIDABLE. Not a governance decision** (§9's own instruction).

---

## 5. MIGRATION 34 — FINAL REBASE (planned only; **NOT created**)

```sql
-- 1. ENUM --------------------------------------------------------------------
ALTER TYPE "treasury"."CashSessionStatus" ADD VALUE 'closing';
-- PG 16.15. Permitted inside a transaction block since PG 12 provided the new
-- value is not USED in the same transaction (it is not). No ALTER TYPE
-- precedent exists in this repo — the implementation slice MUST verify against
-- a scratch DB. Fallback: new type + column swap (mechanical, no design change).

-- 2. IMMUTABLE CLOSE ATTEMPT (client-keyed, FR-OFF-015) ----------------------
CREATE TABLE "treasury"."cash_session_close_attempts" (
  "id"              UUID NOT NULL,   -- client-generated ULID; server NEVER reassigns
  "tenant_id"       UUID NOT NULL,
  "branch_id"       UUID NOT NULL,
  "cash_session_id" UUID NOT NULL,
  -- policy snapshot, pinned at cash_session.opened_at (ratified R-3(a))
  "policy_version_id"     UUID NOT NULL,
  "tolerance_minor_units" BIGINT NOT NULL,
  "count_mode"            "treasury"."CashCountMode" NOT NULL,
  -- the eight FR-FIN-004 terms
  "opening_float" BIGINT NOT NULL, "cash_sales_total" BIGINT NOT NULL,
  "cash_tips_total" BIGINT NOT NULL, "pay_in_total" BIGINT NOT NULL,
  "cash_refunds_total" BIGINT NOT NULL, "pay_out_total" BIGINT NOT NULL,
  "safe_drop_total" BIGINT NOT NULL, "cash_rounding_adjustments" BIGINT NOT NULL,
  -- computed
  "expected_cash" BIGINT NOT NULL, "counted_cash" BIGINT NOT NULL,
  "variance" BIGINT NOT NULL, "currency" CHAR(3) NOT NULL,
  "approval_required" BOOLEAN NOT NULL,
  -- provenance
  "declared_by_employee_id" UUID NOT NULL, "declared_by_user_id" UUID NOT NULL,
  "terminal_id" UUID NOT NULL,
  "declared_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

  CONSTRAINT "cash_session_close_attempts_pkey" PRIMARY KEY ("id"),
  -- FR-FIN-004: the formula itself, DB-enforced. Safe from overflow because the
  -- DTO pattern ^\d{1,18}$ caps each term below 1e18 and 8 x 1e18 < BIGINT_MAX.
  -- WIDENING THAT DTO REGEX TO 19 DIGITS WOULD BREAK THIS CONSTRAINT.
  CONSTRAINT "ck_csca_formula" CHECK (
    expected_cash = opening_float + cash_sales_total + cash_tips_total + pay_in_total
                  - cash_refunds_total - pay_out_total - safe_drop_total
                  + cash_rounding_adjustments),
  CONSTRAINT "ck_csca_variance" CHECK (variance = counted_cash - expected_cash),  -- FR-FIN-005
  CONSTRAINT "ck_csca_nonneg"   CHECK (counted_cash >= 0 AND opening_float >= 0
                                       AND tolerance_minor_units >= 0),
  CONSTRAINT "ck_csca_currency" CHECK (currency ~ '^[A-Z]{3}$'),
  -- ratified R-2(a), OVERFLOW-SAFE: abs() would raise on BIGINT_MIN.
  CONSTRAINT "ck_csca_approval_required_matches" CHECK (
    approval_required = (variance > tolerance_minor_units
                         OR variance < -tolerance_minor_units)),
  -- phase markers: the slice implementing tips/refunds MUST drop these.
  CONSTRAINT "ck_csca_tips_structurally_zero_p1g1"    CHECK (cash_tips_total = 0),
  CONSTRAINT "ck_csca_refunds_structurally_zero_p1g1" CHECK (cash_refunds_total = 0)
);

CREATE UNIQUE INDEX "cash_session_close_attempts_tenant_id_id_key"
  ON "treasury"."cash_session_close_attempts"("tenant_id","id");
-- EXACTLY ONE count per session, forever — the blind-integrity guarantee AND
-- the reason attempt substitution is impossible (see the report's §3.3 proof).
CREATE UNIQUE INDEX "uq_csca_one_per_session"
  ON "treasury"."cash_session_close_attempts"("tenant_id","cash_session_id");
-- the exact target the session's ownership-proving composite FK requires.
ALTER TABLE "treasury"."cash_session_close_attempts"
  ADD CONSTRAINT "uq_csca_session_scoped_id" UNIQUE ("tenant_id","cash_session_id","id");

ALTER TABLE "treasury"."cash_session_close_attempts"
  ADD CONSTRAINT "csca_session_fkey"  FOREIGN KEY ("tenant_id","cash_session_id")
    REFERENCES "treasury"."cash_sessions"("tenant_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "csca_policy_fkey"   FOREIGN KEY ("tenant_id","policy_version_id")
    REFERENCES "treasury"."cash_close_policies"("tenant_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "csca_branch_fkey"   FOREIGN KEY ("tenant_id","branch_id")
    REFERENCES "org"."branches"("tenant_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "csca_employee_fkey" FOREIGN KEY ("tenant_id","declared_by_employee_id")
    REFERENCES "identity"."employees"("tenant_id","id") ON DELETE RESTRICT;

-- 3. DENOMINATIONS — composite identity, no synthetic id ---------------------
CREATE TABLE "treasury"."cash_count_denominations" (
  "tenant_id" UUID NOT NULL,
  "close_attempt_id" UUID NOT NULL,
  "denomination_minor_units" BIGINT NOT NULL,
  "quantity" INTEGER NOT NULL,
  CONSTRAINT "cash_count_denominations_pkey"
    PRIMARY KEY ("tenant_id","close_attempt_id","denomination_minor_units"),
  CONSTRAINT "ck_ccd_denom_positive" CHECK ("denomination_minor_units" > 0),
  CONSTRAINT "ck_ccd_qty_positive"   CHECK ("quantity" > 0),
  CONSTRAINT "ccd_attempt_fkey" FOREIGN KEY ("tenant_id","close_attempt_id")
    REFERENCES "treasury"."cash_session_close_attempts"("tenant_id","id") ON DELETE RESTRICT
);

-- 4. cash_sessions — NEW COLUMNS (closed_at already exists) ------------------
ALTER TABLE "treasury"."cash_sessions"
  ADD COLUMN "close_attempt_id"      UUID   NULL,   -- the ANCHOR (Defect B)
  ADD COLUMN "expected_cash"         BIGINT NULL,
  ADD COLUMN "counted_cash"          BIGINT NULL,
  ADD COLUMN "variance"              BIGINT NULL,
  ADD COLUMN "variance_reason"       TEXT   NULL,
  ADD COLUMN "approval_request_id"   UUID   NULL,   -- Governance ref, NO FK
  ADD COLUMN "closed_by_user_id"     UUID   NULL,
  ADD COLUMN "closed_by_employee_id" UUID   NULL;

ALTER TABLE "treasury"."cash_sessions"
  -- every freeze/close is anchored by an immutable attempt (Defect B)
  ADD CONSTRAINT "ck_cs_attempt_anchor" CHECK (
    (status = 'open'                AND close_attempt_id IS NULL) OR
    (status IN ('closing','closed') AND close_attempt_id IS NOT NULL)),
  -- core facts exist ONLY on a closed session: this is what freezes the count,
  -- because a raw `closing -> closing` UPDATE writing any of them violates it.
  ADD CONSTRAINT "ck_cs_core_facts_only_when_closed" CHECK (
    status = 'closed' OR (
      expected_cash IS NULL AND counted_cash IS NULL AND variance IS NULL
      AND variance_reason IS NULL AND approval_request_id IS NULL
      AND closed_at IS NULL AND closed_by_user_id IS NULL
      AND closed_by_employee_id IS NULL)),
  -- no half-written close
  ADD CONSTRAINT "ck_cs_closed_is_complete" CHECK (
    status <> 'closed' OR (
      expected_cash IS NOT NULL AND counted_cash IS NOT NULL AND variance IS NOT NULL
      AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL
      AND closed_by_employee_id IS NOT NULL)),
  ADD CONSTRAINT "ck_cs_variance_arith" CHECK (
    variance IS NULL OR variance = counted_cash - expected_cash),          -- FR-FIN-005
  ADD CONSTRAINT "ck_cs_reason_nonblank" CHECK (
    variance_reason IS NULL OR length(btrim(variance_reason)) > 0),
  -- EXACT-OWNERSHIP anchor: middle column is the session's own id, matched
  -- against the attempt's cash_session_id. MATCH SIMPLE skips it while NULL.
  ADD CONSTRAINT "cash_sessions_close_attempt_fkey"
    FOREIGN KEY ("tenant_id","id","close_attempt_id")
    REFERENCES "treasury"."cash_session_close_attempts"("tenant_id","cash_session_id","id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cash_sessions_closed_by_user_id_fkey"
    FOREIGN KEY ("closed_by_user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "cash_sessions_tenant_id_closed_by_employee_id_fkey"
    FOREIGN KEY ("tenant_id","closed_by_employee_id")
    REFERENCES "identity"."employees"("tenant_id","id") ON DELETE RESTRICT;

-- 5. GRANTS ------------------------------------------------------------------
GRANT UPDATE ("status","close_attempt_id","closed_at","expected_cash","counted_cash",
              "variance","variance_reason","approval_request_id",
              "closed_by_user_id","closed_by_employee_id")
  ON "treasury"."cash_sessions" TO ros_app;     -- column-level; DELETE/TRUNCATE stay revoked
GRANT SELECT, INSERT ON "treasury"."cash_session_close_attempts" TO ros_app;
GRANT SELECT, INSERT ON "treasury"."cash_count_denominations"    TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."cash_session_close_attempts" FROM ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."cash_count_denominations"    FROM ros_app;

-- 6. RLS ---------------------------------------------------------------------
ALTER TABLE "treasury"."cash_session_close_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."cash_session_close_attempts" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "treasury"."cash_count_denominations"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."cash_count_denominations"    FORCE  ROW LEVEL SECURITY;
-- SELECT + INSERT policies only on both, fail-closed NULLIF predicate.
-- No UPDATE policy. No DELETE policy.

CREATE POLICY cash_sessions_update ON "treasury"."cash_sessions" FOR UPDATE
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('open','closing'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('closing','closed'));
```

---

## 6. TEST MATRIX — PRIOR 52 PRESERVED, 10 ADDED

Deterministic DB barriers only; **no arbitrary sleeps**; every genuine race run **≥3 clean times**.

| # | Test | Expected |
|---|---|---|
| 53 | raw `ros_app` `UPDATE … SET status='closing'` with **no** attempt inserted | **`ck_cs_attempt_anchor` violation** |
| 54 | raw `ros_app` `open → closed` populating core fields with **no** attempt | **`ck_cs_attempt_anchor` violation** |
| 55 | `closing` session attempts to swap `close_attempt_id` to a fresh UUID | **FK violation**; and inserting a second attempt for the session first → **`uq_csca_one_per_session` violation** |
| 56 | session references **another session's** attempt in the same tenant | **FK violation** (middle column mismatch) |
| 57 | session references **another tenant's** attempt | **FK violation**; row also invisible under RLS |
| 58 | attempt + denominations + session transition commit **atomically** | all present, or none |
| 59 | forced rollback after step 4 | **no orphan attempt, no orphan denominations, session still `open`** |
| 60 | expiry base: hold `ros_cash_session` from another connection for `> variance_approval_expiry_seconds`, release, let finalize proceed | request's `expires_at` reflects **statement time at creation**, not BEGIN — decision **succeeds** (this test fails under the withdrawn `transaction_timestamp()` design) |
| 61 | genuine decision-time expiry (deliberate delay **between** request creation and decision) | `decide()` throws → **full rollback**, **no** `approval_requests` row survives, session still `CLOSING`, attempt untouched, retry creates a new request |
| 62 | `variance = -9223372036854775808` (BIGINT_MIN) with `tolerance = 0` | `approval_required = true`, **no `bigint out of range` error** — the `abs()` form would raise here |

---

## 7. PRESERVED WITHOUT CHANGE

* **R-6(a)** (§11 of the brief) — verbatim: after an explicit manager **rejection** the session stays `CLOSING`; the physical count stays immutable; `close_attempt_id` unchanged; payments and movements stay frozen; **no recount, no reopen**; the caller may retry with a **new** `ApprovalRequest`/`ApprovalDecision` id, possibly a different manager and a different reason; the rejected request and decision remain immutable in Governance; the final `cash_sessions.variance_reason` is the reason on the **approved** close. **No expiry limb.**
* **Rejection transaction** (§12) — create request, create REJECTED decision, leave the session `CLOSING`, **COMMIT**, return HTTP **200** with an outcome discriminator. **Never throw after the decision INSERT** (that would roll back the immutable record FR-SEC-033 requires). Idempotent replay returns the stored outcome with no second request or decision.
* **No above-tolerance one-request fast path**; `managerPin` and `reason` absent from the `POST /close` DTO; reason collected at finalisation.
* **`closeAttemptId`** — mandatory client-generated ULID (FR-OFF-015), the attempt's PK; denominations keyed compositely with no synthetic id.
* **Payment advisory-lock correction** — the exact `pg_advisory_xact_lock(hashtext('ros_cash_session'), hashtext(cashSessionId))` before the Order/CashSession read; no schema change, no alternate key, in-slice.
* **`CashSessionsService.open` §5.2.3 fix** — consume the published `BRANCH_CURRENCY_QUERY`; no behaviour or schema change; no `KNOWN_DEVIATIONS` growth.
* **Expected cash** — six terms live; tips and refunds structurally zero and now DB-enforced by phase-marked CHECKs; **FR-FIN-004 remains PARTIAL**.
* Policy pinned at `opened_at` (**R-3(a)**); strict `>` with equality within tolerance (**R-2(a)**); self-approval blocked by the DB conjunct with fail-closed on a NULL owner User; lock order CashSession → Order → Inventory; `closing` freezes both consumers through their existing `!== 'open'` checks; **Shift is not transitioned**; three routes, no `/v1`, OpenAPI 139 → 142.
* Requirement classifications unchanged: FR-POS-094/095/096/097, FR-FIN-005/006, FR-SEC-016/030/033 → **COMPLETE**; FR-FIN-004/007/010, FR-SEC-032 → **PARTIAL**; FR-SEC-002/003/004 branch-scoped RBAC → **NOT IMPLEMENTED**, not claimed.

---

## 8. FINAL USER-RATIFICATION POSITION (§15)

**`R-6(a)` is confirmed as the ONLY user-ratification item.**

Per §15's instruction, none of the following was turned into a ratification, because each is implementation/design mechanics resolved by evidence rather than a business-policy gap:

| Resolved as mechanics — **not** ratification | Basis |
|---|---|
| `close_attempt_id` column and its FK shape | relational proof (§3.3); no business behaviour changes |
| Expiry **base** instant | corrects a defect against the accepted D-10 semantics; the *duration* stays exactly as ratified in **R-4(a)** |
| Overflow-safe comparison form | arithmetic identity for `tol >= 0`; **R-2(a)** semantics unchanged |
| `statement_timestamp()` as the timestamp primitive | symmetry with the decision policy already in migration 32 |
| Write order and the circular FK | resolved by ordering; no deferred constraint needed |

**Expiry needs no ratification** — a rolled-back transaction leaves no state for a human policy to govern (§2.3). **R-6 is rejection-only.**

---

## 9. VERDICT

# **A. P1G-1 DESIGN FINAL-ACCEPTANCE READY — R-6 ONLY**

Defects A, B and C are closed; two errors in my own prior reports are corrected on the record; **no new ratification item was discovered**. **No Sonnet implementation prompt is issued**, because R-6 is P1G-1-critical and remains unratified.

---

## Scope compliance

Design correction only. No product code, no migration (34 planned only, **not created**), no test change, **no governance recording**, no `D-21+`, no commit, no push, no deployment. No destructive git command used (`reset`, `restore`, `checkout`, `clean`, `stash`, `rebase`, `amend` — none). HEAD `0f10afe` unchanged. Prior reports are **not overwritten**; the 4 unrelated uncommitted reports and both prior P1G-1 close reports are byte-identical; `INDEX.md` is appended to only.

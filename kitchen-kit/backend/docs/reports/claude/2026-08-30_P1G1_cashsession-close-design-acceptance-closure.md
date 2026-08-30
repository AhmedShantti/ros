# P1G-1 CashSession Close — Design Acceptance Closure

**Task / slice:** P1G-1 CashSession Close — correction of three design defects before R-6 ratification
**Report type:** Design correction. **No product code, no migration, no test change, no governance recording, no commit, no push, no deployment, no D-21+.**
**Authority statement:** This report is **NON-AUTHORITATIVE EVIDENCE**. Authority order: **(1) `ROS_SRS_v1.0.pdf` — FR-POS-094/095, FR-FIN-005/006/007, FR-OFF-015, §5.2.3, §24.2.3 → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md` → (3) the repository at HEAD `0f10afe` → (4) `docs/reports/claude/2026-08-30_P1G1_cashsession-close-final-design-gate.md` (CORRECTED by this report on three points) → (5) the accepted Approval Runtime reports → (6) engineering inference, labelled.** Where this report and the SRS or the register differ, **they govern**.
**Date:** 2026-08-30
**HEAD:** `0f10afe` (unchanged; no commit performed) · **Branch:** `feat/production-spec`
**Migrations:** 33 (unchanged — **migration 34 planned only, NOT created**) · **OpenAPI:** 3.1.0 / 139 (unchanged)
**Working tree:** 4 unrelated uncommitted reports + the prior design gate + their `INDEX.md` rows — all left byte-identical. This report and one appended `INDEX.md` row added.
**Task identifier:** P1G-1 CashSession Close design acceptance closure

> ## VERDICT
> ## **A. P1G-1 DESIGN CORRECTED — R-6 ONLY REMAINS**
>
> All three defects are closed, and **no new ratification item was discovered**.
>
> * **Defect 1 — above-tolerance one-request approval: REMOVED.** `managerPin`
>   and `reason` are deleted from the `POST /close` DTO entirely. A manager can
>   only decide **after** the authoritative variance has been disclosed, which is
>   the only way a synchronous approval can be an *informed* approval.
> * **Defect 2 — the RLS plan did not freeze core facts: CORRECTED, and the fix
>   removed a whole class of risk rather than patching it.** The prior plan wrote
>   `counted_cash`/`expected_cash`/`variance` onto `cash_sessions` at
>   *declaration*, which no RLS policy can then freeze — PostgreSQL RLS cannot
>   compare OLD to NEW. The corrected design **writes those columns only at the
>   `CLOSED` transition** and adds a CHECK binding them to `status = 'closed'`.
>   A `closing → closing` UPDATE touching any of them now **violates a CHECK
>   constraint**. **No trigger is required** — and that matters, because the
>   repository contains **zero** triggers, functions or rules across all 33
>   migrations, while using CHECK constraints pervasively.
> * **Defect 3 — FR-OFF-015: RESOLVED AS APPLYING.** The close attempt is created
>   by the cashier on the POS device, and §21.3 lists *"Shifts, cash sessions,
>   drawer events"* as device-originated Up-synced data. `closeAttemptId` is a
>   **mandatory client-generated ULID-as-UUID and the table's primary key.**
>   Denomination rows take a **composite identity**, no synthetic ids.
>
> **One further correction the brief did not anticipate, proven from the accepted
> implementation (§4):** in the synchronous same-transaction design, **approval
> expiry is structurally unreachable**, and when it does fire under a pathological
> stall it **rolls the whole transaction back, leaving no request row at all**.
> The prior gate's phrase *"expiry recovery"* implied a surviving expired
> request. That is **false**, and is corrected here. **R-6 therefore reduces to
> rejection semantics alone.**

---

## 1. WHAT WAS VERIFIED AT `0f10afe`

| Fact | Evidence |
|---|---|
| **Zero triggers / functions / rules** in any of the 33 migrations | `grep -l "CREATE TRIGGER\|CREATE OR REPLACE FUNCTION\|CREATE RULE"` over all migrations → **no matches** |
| CHECK constraints are the established mechanism (39+ across 10 migrations) | per-file counts; `sales_order_foundation` alone has 14 |
| `cash_sessions` already has `closed_at TIMESTAMPTZ NULL`; **no** expected/counted/variance columns | `schema.prisma` `model CashSession` |
| `cash_sessions` grants remain `SELECT, INSERT` only; SELECT + INSERT policies only | migration `20260820160000:236,255,257` |
| The decisions INSERT policy's expiry conjunct is `r.expires_at < statement_timestamp()` | migration 32 `:216` |
| `decide()` **catches the RLS violation and throws** `ApprovalDecisionRejectedError` | `approvals.service.ts` — `catch (err) { if (isRowLevelSecurityViolation(err)) throw new ApprovalDecisionRejectedError(...) }` |
| The accepted code's own comment names **expiry** as one of the RLS-exception cases | *"A genuinely illegal decision (self-approval / excluded approver / **expired**) is a SEPARATE, real RLS exception, not a zero-row outcome"* |
| `decide()` returns **normally** for `decision: 'rejected'` — rejection is a valid value, not an error path | `expectedDecision.decision = command.decision`; only conflict / not-pending / missing-permission / RLS throw |
| FR-OFF-015 verbatim | *"All entities **created on a device** SHALL receive a client-generated ULID as their permanent primary key. The server SHALL NOT reassign identifiers."* |

---

## 2. DEFECT 1 — ABOVE-TOLERANCE ONE-REQUEST APPROVAL, REMOVED

### 2.1 Why the prior design was wrong

The prior gate allowed `POST /close` to close an above-tolerance variance in one transaction when the caller pre-supplied `reason` + a manager PIN. The brief's objection is correct and decisive:

> In blind mode the authoritative expected cash and variance **must not** be disclosed until the count is durably immutable. A manager who supplies a PIN *before* that disclosure has therefore **not seen the `ApprovalRequest.value` they are approving**.

This is not merely poor UX — it is a **defective approval**. FR-SEC-031 [M] requires the request to specify *"the requesting user, the action, the affected entity, **the value**, the required approver permission, and an expiry"*, and §24.2.3 places the policy evaluation inside the consuming handler with the approval as a distinct collaborator. A decision recorded against a value the approver could not have read is an approval in name only, and FR-SEC-033 makes that hollow record **immutable**. It also inverts the FR-FIN-006 control: the manager is meant to adjudicate *this specific* discrepancy, not pre-authorise an unknown one.

**Corrected: there is no above-tolerance fast path.** The only one-request path is **within tolerance**, where no approval exists to be uninformed about.

### 2.2 The corrected protocol

```
WITHIN TOLERANCE                          ABOVE TOLERANCE
────────────────────────────────────      ────────────────────────────────────────────
POST /close                               POST /close
  lock → assert open                        lock → assert open
  resolve policy @ opened_at                resolve policy @ opened_at
  compute expected / counted / variance     compute expected / counted / variance
  INSERT immutable attempt                  INSERT immutable attempt
  |variance| <= tolerance                   |variance| > tolerance
  status: open → CLOSED                     status: open → CLOSING
  write core facts + audit                  (no core facts written)
  COMMIT                                    COMMIT
  → 201, discloses expected/variance        → 200, discloses expected/variance,
                                                 approvalRequired: true
                                            ────────────────────────────────────────
                                            POST /close/finalize
                                              OUTSIDE tx: verify manager PIN
                                              INSIDE tx: lock → assert CLOSING
                                                → read immutable attempt
                                                → create ApprovalRequest (value from attempt)
                                                → create ApprovalDecision (approved|rejected)
                                                → APPROVED: status CLOSING → CLOSED,
                                                   write core facts, audit
                                                → REJECTED: status unchanged (CLOSING)
                                              COMMIT
```

**Ordering guarantee:** the disclosure at the end of `POST /close` happens **after COMMIT**, so the count is durably immutable before any figure is revealed. The manager then sees the real variance and reason before deciding. Both requirements are satisfied simultaneously.

### 2.3 Corrected DTOs (§2's "simplest consistent DTO design")

```jsonc
// POST /cash-sessions/{id}/close — DECLARATION ONLY
{
  "closeAttemptId": "01J...-as-uuid",          // REQUIRED, client ULID (FR-OFF-015, §4)
  "countedTotalMinorUnits": "154300",           // optional
  "denominations": [ { "denominationMinorUnits": "20000", "quantity": 5 } ]   // optional
  // NO reason.  NO managerPin.  NO decision.
}
```

**`reason` is collected at finalisation, not declaration** — in blind mode the cashier does not know the variance (or even that a reason will be needed) until after declaring, so asking for one up front is both impossible to answer meaningfully and a subtle disclosure hint. Its absence from this DTO is deliberate.

```jsonc
// POST /cash-sessions/{id}/close/finalize — MANAGER DECISION
{
  "approvalRequestId":  "01J...-as-uuid",
  "approvalDecisionId": "01J...-as-uuid",
  "decision": "approved",                       // "approved" | "rejected"  (§10)
  "reason": "Till short after a disputed refund at 18:40.",   // REQUIRED
  "managerPin": "····",                         // verified OUTSIDE the transaction
  "comment": "Recount witnessed."               // optional, → ApprovalDecision.comment
}
```

`decision` is explicit because R-6(a) makes **rejection a first-class, recorded outcome**. A route that could only ever record approval while the design claimed rejection recovery would be incoherent — exactly what §10 forbids. **Classification: DESIGN-DECIDABLE. No ratification consumed.**

---

## 3. DEFECT 2 — DB-ENFORCED FREEZE OF THE CORE FACTS

### 3.1 The prior plan's real flaw

The prior plan granted column-level UPDATE on `expected_cash`, `counted_cash`, `variance`, … and relied on:

```sql
USING (status IN ('open','closing'))  WITH CHECK (status IN ('closing','closed'))
```

This blocks `closed → *`. It does **not** block `closing → closing` while rewriting `counted_cash`. **PostgreSQL RLS cannot express OLD-vs-NEW comparison**: `USING` sees the old row, `WITH CHECK` sees the new one, and no policy expression sees both. So the claimed blind-count freeze was **not** DB-enforced. The brief is right.

### 3.2 The correction — remove the mutable duplicate, don't police it

Rather than adding machinery to guard a mutable copy, the corrected design **eliminates the mutable copy**. This is §6's proposed shape, and evaluating it against the prior write-at-declaration design shows it is strictly better on every axis:

| | Prior: write core facts at declaration | **Corrected: write only at CLOSED** |
|---|---|---|
| Authoritative source during CLOSING | ambiguous — session **and** attempt both hold figures | **the attempt alone**, append-only, no UPDATE grant |
| `closing → closing` tampering | **possible** — no mechanism blocks it | **CHECK violation** |
| FR-FIN-005 *"recorded on the session"* | satisfied early, but on a not-yet-closed session | satisfied **at close**, which is when a variance exists as a closed fact |
| Mechanism needed | RLS + a **trigger** (repo's first) | **CHECK only** — 39+ precedents, zero triggers |
| Reconciliation risk | two copies can disagree mid-flight | one copy, by construction |

**During `CLOSING`, the only column on `cash_sessions` that has changed is `status`.** Everything else about the close lives on the immutable attempt.

### 3.3 The constraints that make it enforced

```sql
-- Core close facts exist ONLY on a closed session. This is what freezes the
-- count: while status='closing' every one of these columns MUST be NULL, so a
-- raw `closing → closing` UPDATE that writes counted_cash/expected_cash/
-- variance violates the constraint. No trigger, no OLD/NEW comparison needed.
CONSTRAINT ck_cs_core_facts_only_when_closed CHECK (
  status = 'closed' OR (
    expected_cash IS NULL AND counted_cash IS NULL AND variance IS NULL
    AND variance_reason IS NULL AND approval_request_id IS NULL
    AND closed_at IS NULL AND closed_by_user_id IS NULL AND closed_by_employee_id IS NULL
  )
);

-- A closed session is fully populated — no half-written close.
CONSTRAINT ck_cs_closed_is_complete CHECK (
  status <> 'closed' OR (
    expected_cash IS NOT NULL AND counted_cash IS NOT NULL AND variance IS NOT NULL
    AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL
    AND closed_by_employee_id IS NOT NULL
  )
);

CONSTRAINT ck_cs_variance_arith CHECK (
  variance IS NULL OR variance = counted_cash - expected_cash            -- FR-FIN-005
);
CONSTRAINT ck_cs_reason_nonblank CHECK (
  variance_reason IS NULL OR length(btrim(variance_reason)) > 0
);
```

### 3.4 Every transition invariant §5 requires, and what enforces it

| Transition | Requirement | Enforcement |
|---|---|---|
| **OPEN → CLOSING** | attempt exists in the same tx; core session columns do **not** become mutable | `ck_cs_core_facts_only_when_closed` forces them NULL; the attempt INSERT is in the same transaction |
| **OPEN → CLOSED** (within-tolerance fast path) | core facts written **exactly once** | `WITH CHECK (status IN ('closing','closed'))` + `ck_cs_closed_is_complete`; the row is thereafter invisible to UPDATE |
| **CLOSING → CLOSING** | count, expected, variance, policy snapshot, denominations **MUST NOT** change | session columns: **`ck_cs_core_facts_only_when_closed`**. Attempt + denominations: **no UPDATE/DELETE grant at all** and `UNIQUE (tenant_id, cash_session_id)` — structurally one immutable count per session, forever |
| **CLOSING → CLOSED** | core fields populated **from the immutable attempt**; approved request id / actor / `closed_at` written | same two CHECKs; the service reads the attempt as its only source |
| **CLOSED → anything** | impossible at the database | `USING (status IN ('open','closing'))` — a closed row is **not visible to any UPDATE** for `ros_app` |
| `closing → open` (un-freeze) | impossible | `WITH CHECK (status IN ('closing','closed'))` |

### 3.5 The retryable-reason exception, dissolved

§5 allows "only explicitly retryable metadata such as the current variance reason may change, if R-6 ratifies that behaviour." The corrected design needs **no exception at all**:

* While `CLOSING`, `cash_sessions.variance_reason` is **NULL** (forced by the CHECK). There is no Treasury-authoritative reason yet — correctly, because **no close has occurred**.
* The in-flight reason is a **parameter of each finalize call**, copied into that call's `ApprovalRequest.value`. Each rejected attempt keeps its own immutable copy **in Governance**.
* "Revising the reason" is therefore just *supplying a different reason on the next finalize call* — no mutable Treasury column, no special grant, no exception clause.
* `cash_sessions.variance_reason` is written **once**, at `CLOSED`, and is by definition the reason attached to the **approved** request.

**Classification: DESIGN-DECIDABLE.** §11 is answered in full, and the answer needed no new schema.

---

## 4. APPROVAL EXPIRY — PROVEN FROM IMPLEMENTATION, AND A CORRECTION

§9 asks for the exact runtime behaviour, proven from the accepted implementation.

**Finding 1 — expiry is structurally unreachable in this design.** The request is created and decided in the **same transaction**. `expires_at = transaction_timestamp() + variance_approval_expiry_seconds`, with the ratified `CHECK (variance_approval_expiry_seconds > 0)` so the interval is **≥ 1 second**. The decisions INSERT policy tests `r.expires_at < statement_timestamp()`, evaluated microseconds later. `T + N < T + ε` is false for any `N ≥ 1s`. **The conjunct cannot fire** unless the transaction stalls for longer than the configured duration between two adjacent statements — which the design already forbids by verifying the PIN *outside* the transaction and performing no network I/O inside it.

**Finding 2 — if it does fire, nothing survives.** `decide()` catches the RLS violation (`isRowLevelSecurityViolation`, SQLSTATE `42501`) and **throws** `ApprovalDecisionRejectedError`. The throw propagates out of Treasury's transaction, so **the whole transaction rolls back — including the `approval_requests` INSERT made moments earlier**. Therefore:

* **no expired `ApprovalRequest` row survives;**
* the CashSession remains `CLOSING` (the rollback undoes nothing committed);
* the immutable attempt is untouched;
* the caller retries `finalize`, creating a **genuinely new** request with a fresh `expires_at`.

**CORRECTION to the prior gate.** Its R-6 spoke of *"expiry recovery"* and listed rejection and expiry as parallel limbs. That framing implied a stored expired request needing recovery. **It is wrong.** There is no expired-request state to recover from, no orphan row, and no Governance state to reconcile. **R-6 reduces to rejection semantics alone.**

**Honest limit:** this reasoning holds for the **synchronous** path P1G-1 implements. If FR-SEC-032's deferred asynchronous half is ever built — request created in one transaction, decided in another, minutes later — expiry becomes genuinely reachable and *will* need the recovery design R-6 was originally imagined to cover. **Recorded for that future slice; not designed here.**

---

## 5. DEFECT 3 — FR-OFF-015 PERMANENT IDENTITY

### 5.1 Does FR-OFF-015 apply to the close attempt? **YES.**

> *"All entities **created on a device** SHALL receive a client-generated ULID as their permanent primary key. The server SHALL NOT reassign identifiers."*

The test is **"created on a device"**, and a cash count declaration meets it unambiguously: the cashier physically counts the drawer **at the POS terminal** and declares the result there. §21.3's local data model lists *"Shifts, cash sessions, **drawer events**"* as **Up / Continuous** — device-originated data — and a close declaration is a drawer event of exactly that class. Every sibling in that class already honours FR-OFF-015: `CashMovementDto.id` is **required** with the docblock *"There is no server-generated movement-id fallback"*; `OpenCashSessionDto` requires both `shiftId` and `cashSessionId`.

**The contrast that proves the rule is being applied and not merely invoked:** the accepted cash-close **policy** row is server-generated (`newId()`), and its own docblock explains why — *"an ADMINISTRATIVE/server write, not an FR-OFF-015 device-created entity — no offline terminal ever originates a policy version."* The close attempt is the exact opposite. The prior gate called the attempt *"offline-shaped"* and *"device-originated"* but left its id origin unresolved; that gap is closed here.

**Decision:** `closeAttemptId` is **REQUIRED** on `POST /close`, validated against `UUID_PATTERN` (ULID-as-UUID), and is the **primary key** of `treasury.cash_session_close_attempts`. **The server never reassigns it.** It is **not** a synonym for `Idempotency-Key`: the key protects one HTTP retry; the permanent id protects an offline-replayed record, and it is what makes "different key, same logical close" deterministic (§10 of the prior gate).

### 5.2 Denomination child rows — **composite identity, no synthetic ids**

Denomination rows are **value rows of the attempt**, not independently addressable entities: nothing references one, nothing updates one, and they have no lifecycle apart from their parent. Their natural key is already unique and already required by the design:

```
PRIMARY KEY (tenant_id, close_attempt_id, denomination_minor_units)
```

This is simultaneously the duplicate-denomination guard (§17 of the prior gate) and the row's identity. **No synthetic `id` column is added** — §7's explicit preference, and it removes a meaningless client-supplied id from the DTO.

### 5.3 ApprovalRequest / ApprovalDecision ids — client-supplied

`CreateApprovalRequestCommand.id` and `DecideApprovalCommand.id` are documented in the accepted contract as *"FR-OFF-015-style client-generated permanent id, ULID rendered as UUID."* The finalize call originates at the terminal, so the DTO carries `approvalRequestId` and `approvalDecisionId`. This also makes **finalisation replay work at permanent-identity level**: a retried finalize with the same ids hits `decide()`'s step-1 same-id replay path and returns the stored decision rather than creating a second request. A retry **after a rejection** naturally supplies fresh ids, which is exactly what R-6(a) requires. **Classification: DESIGN-DECIDABLE**, consistent with the accepted contract's documented shape.

---

## 6. R-6 — REJECTION SEMANTICS, WITH EXPLICIT TRANSACTION SHAPE

### 6.1 The approved path

```
OUTSIDE tx:  principal = TERMINAL_PIN_VERIFIER.verifyTerminalPin(...)     // lockout survives rollback
INSIDE  tx:  pg_advisory_xact_lock('ros_cash_session', cashSessionId)
             assert status = 'closing'
             attempt = read immutable cash_session_close_attempt          // the ONLY source of figures
             ApprovalCommands.createRequest(tx, tenantId, actorUserId, {
               id: approvalRequestId, requestType: 'cash.variance',
               entityType: 'cash_session', entityId: sessionId,
               requiredPermission: 'cash.variance.approve',
               value: { ...attempt figures as base-10 integer strings, reason },
               expiresAt: transaction_timestamp() + policy.varianceApprovalExpirySeconds,
               excludedApproverUserId: ownerUserId,                        // FAIL CLOSED if NULL
             })
             ApprovalCommands.decide(tx, tenantId, { id: approvalDecisionId, decision: 'approved', approver: principal })
             UPDATE cash_sessions SET status='closed', closed_at, closed_by_*,
                    expected_cash, counted_cash, variance, variance_reason, approval_request_id
             audit CASH_SESSION_CLOSED
             COMMIT
```

### 6.2 The rejected path — and why it must not throw

```
INSIDE  tx:  ... identical up to and including decide(..., decision: 'rejected')
             status stays 'closing'                                        // NO session UPDATE at all
             COMMIT                                                        // the rejection is now durable
AFTER   tx:  HTTP 200 { outcome: 'rejected', ... }
```

**The rejection must never be implemented by throwing after the decision INSERT** — the brief is right, and the accepted implementation makes the point concrete: a throw would roll back the very `approval_decisions` row that FR-SEC-033 requires to be an immutable record, plus its parent request. The rejection would then have *never happened*, while the manager believes they rejected it.

**This works with the accepted runtime unmodified.** `decide()` treats `'rejected'` as an ordinary valid value and **returns normally** — it throws only on conflict, not-pending, missing permission, or a genuine RLS violation. Treasury simply does not perform the session UPDATE and returns.

**HTTP outcome:** **`200 OK`** with an explicit discriminator, **not** a 4xx. Three reasons: the request *succeeded* — a decision was recorded exactly as asked; a 4xx would cause the idempotency interceptor's error branch to **release** the reservation, so a replay would create a **second** request and decision; and the caller needs the decision reference in the body, which an error response would not carry.

```jsonc
// 200 OK
{ "outcome": "rejected",
  "cashSessionStatus": "closing",
  "approvalRequestId": "...", "approvalDecisionId": "...",
  "expectedCash": "150000", "countedCash": "154300", "variance": "4300",
  "mayRetryWithAnotherApprover": true }
```

### 6.3 What rejection does **not** do (§12)

A rejection does **not** reopen the session, unfreeze payments or movements, or permit a recount — and under the corrected schema these are not merely service rules but **structural impossibilities**:

| Attempted | Blocked by |
|---|---|
| `closing → open` | `WITH CHECK (status IN ('closing','closed'))` |
| delete / replace the attempt | no DELETE grant; no UPDATE grant; `UNIQUE (tenant_id, cash_session_id)` |
| second declaration with a different count | same UNIQUE → `409` |
| write core facts while still `closing` | `ck_cs_core_facts_only_when_closed` |
| cash payment · manual-card payment · pay-in · pay-out · safe-drop | both consumers already gate on `status !== 'open'`, unchanged |

Permissions are unchanged: `cash.session.close`, `cash.session.close_other`, `cash.variance.approve`. **No new permission.**

### 6.4 R-6, restated narrowly for ratification

> **R-6 — Variance-approval rejection recovery.** P1G-1-CRITICAL. Not migration-critical. *(Expiry is no longer part of this item — §4.)*
>
> **R-6(a) — RECOMMENDED.** After a manager **rejects**: the session stays `CLOSING`; the physical count stays **immutable**; **no** economic activity resumes; **no** recount and **no** reopen; the close may be retried with a **new** `ApprovalRequest` (possibly a different manager) and a **different reason**. The rejected request and decision remain immutable and audited in Governance.
>
> **R-6(b) — Reopen and recount.** Rejected here: it restores precisely the disclose-then-recount oracle that made the one-shot protocol unsafe, defeating FR-POS-095 [M]. It would also require schema permissiveness the corrected design deliberately does not grant.
>
> **R-6(c) — Supervisor override / escalation.** Invents authority the SRS does not name; FR-SEC-034 is `[S]` and **D-12 is BLOCKED**.
>
> **Why still a ratification and not a design decision:** whether a rejected cash close is retryable at all — and whether the reason may differ between attempts — is an **operational control decision** about how a disputed drawer is resolved. It materially changes business behaviour, so per §47 it is surfaced rather than assumed, even though (a) is the only option that survives the security analysis.

**No governance recording is performed by this task.**

---

## 7. EXPECTED CASH — POSITION PRESERVED, WITH ONE ADDITION (§15)

The prior finding is **not reopened** and no evidence contradicts it: six terms live; **cash tips structurally unrecordable** (`Order.tipTotal` written by zero code paths); **cash refunds structurally unreachable** (`refunded`/`partially_refunded` have no inbound transition in `TRANSITIONS`); **FR-FIN-004 remains PARTIAL**.

**Addition — the structural zeros become DB-enforced:**

```sql
CONSTRAINT ck_csca_tips_structurally_zero_p1g1    CHECK (cash_tips_total = 0),
CONSTRAINT ck_csca_refunds_structurally_zero_p1g1 CHECK (cash_refunds_total = 0),
```

Service-level zeroing would be sufficient for *correctness today*, but it is weaker **evidence**. These constraints convert *"we believe those terms are zero"* into *"the database guarantees it, and changing that requires a deliberate, reviewable migration."* That is exactly the property FR-FIN-004's PARTIAL classification should rest on, and it makes it impossible for a later slice to start populating a term without also, visibly, taking responsibility for the requirement. The constraint names carry the phase marker and the migration comment states that **the slice implementing tips or refunds must drop the corresponding constraint as part of implementing that domain.** **No claim is made that either domain is implemented.**

---

## 8. MIGRATION 34 — RE-ISSUED (planned only; **NOT created**)

```sql
-- 1. ENUM ------------------------------------------------------------------
ALTER TYPE "treasury"."CashSessionStatus" ADD VALUE 'closing';
-- PG 16.15; permitted inside a transaction block since PG 12 provided the new
-- value is not USED in the same transaction (it is not). No ALTER TYPE
-- precedent exists in this repo — the implementation slice MUST verify against
-- a scratch DB. Fallback: new type + column swap (mechanical, no design change).

-- 2. cash_sessions: NEW COLUMNS (closed_at already exists) -------------------
ALTER TABLE "treasury"."cash_sessions"
  ADD COLUMN "expected_cash"          BIGINT NULL,
  ADD COLUMN "counted_cash"           BIGINT NULL,
  ADD COLUMN "variance"               BIGINT NULL,
  ADD COLUMN "variance_reason"        TEXT   NULL,
  ADD COLUMN "approval_request_id"    UUID   NULL,   -- Governance ref, NO FK (§30 prior gate)
  ADD COLUMN "closed_by_user_id"      UUID   NULL,
  ADD COLUMN "closed_by_employee_id"  UUID   NULL;

-- the four CHECKs of §3.3 (core-facts-only-when-closed, closed-is-complete,
-- variance arithmetic, non-blank reason)
ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "cash_sessions_closed_by_user_id_fkey"
    FOREIGN KEY ("closed_by_user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "cash_sessions_tenant_id_closed_by_employee_id_fkey"
    FOREIGN KEY ("tenant_id","closed_by_employee_id")
    REFERENCES "identity"."employees"("tenant_id","id") ON DELETE RESTRICT;

-- 3. treasury.cash_session_close_attempts — IMMUTABLE, CLIENT-KEYED ----------
CREATE TABLE "treasury"."cash_session_close_attempts" (
  "id"              UUID NOT NULL,          -- FR-OFF-015 client ULID, never reassigned
  "tenant_id"       UUID NOT NULL,
  "branch_id"       UUID NOT NULL,
  "cash_session_id" UUID NOT NULL,
  -- policy snapshot (ratified R-3(a), pinned at cash_session.opened_at)
  "policy_version_id"       UUID NOT NULL,
  "tolerance_minor_units"   BIGINT NOT NULL,
  "count_mode"              "treasury"."CashCountMode" NOT NULL,
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
  CONSTRAINT "ck_csca_formula" CHECK (
    expected_cash = opening_float + cash_sales_total + cash_tips_total + pay_in_total
                  - cash_refunds_total - pay_out_total - safe_drop_total
                  + cash_rounding_adjustments),
  CONSTRAINT "ck_csca_variance"  CHECK (variance = counted_cash - expected_cash),
  CONSTRAINT "ck_csca_nonneg"    CHECK (counted_cash >= 0 AND opening_float >= 0
                                        AND tolerance_minor_units >= 0),
  CONSTRAINT "ck_csca_currency"  CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT "ck_csca_approval_required_matches" CHECK (
    approval_required = (abs(variance) > tolerance_minor_units)),   -- ratified R-2(a)
  CONSTRAINT "ck_csca_tips_structurally_zero_p1g1"    CHECK (cash_tips_total = 0),
  CONSTRAINT "ck_csca_refunds_structurally_zero_p1g1" CHECK (cash_refunds_total = 0)
);
CREATE UNIQUE INDEX "cash_session_close_attempts_tenant_id_id_key"
  ON "treasury"."cash_session_close_attempts"("tenant_id","id");
-- EXACTLY ONE count per session, forever — the blind-integrity guarantee
CREATE UNIQUE INDEX "uq_csca_one_per_session"
  ON "treasury"."cash_session_close_attempts"("tenant_id","cash_session_id");
-- tenant-safe composite FKs
ALTER TABLE "treasury"."cash_session_close_attempts"
  ADD CONSTRAINT "csca_session_fkey" FOREIGN KEY ("tenant_id","cash_session_id")
    REFERENCES "treasury"."cash_sessions"("tenant_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "csca_policy_fkey"  FOREIGN KEY ("tenant_id","policy_version_id")
    REFERENCES "treasury"."cash_close_policies"("tenant_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "csca_branch_fkey"  FOREIGN KEY ("tenant_id","branch_id")
    REFERENCES "org"."branches"("tenant_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "csca_employee_fkey" FOREIGN KEY ("tenant_id","declared_by_employee_id")
    REFERENCES "identity"."employees"("tenant_id","id") ON DELETE RESTRICT;

-- 4. treasury.cash_count_denominations — COMPOSITE IDENTITY, no synthetic id --
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

-- 5. GRANTS ------------------------------------------------------------------
GRANT UPDATE ("status","closed_at","expected_cash","counted_cash","variance",
              "variance_reason","approval_request_id",
              "closed_by_user_id","closed_by_employee_id")
  ON "treasury"."cash_sessions" TO ros_app;      -- column-level; DELETE/TRUNCATE stay revoked
GRANT SELECT, INSERT ON "treasury"."cash_session_close_attempts" TO ros_app;
GRANT SELECT, INSERT ON "treasury"."cash_count_denominations"    TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."cash_session_close_attempts" FROM ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."cash_count_denominations"    FROM ros_app;

-- 6. RLS ---------------------------------------------------------------------
CREATE POLICY cash_sessions_update ON "treasury"."cash_sessions" FOR UPDATE
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('open','closing'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('closing','closed'));
-- both new tables: ENABLE + FORCE RLS, SELECT + INSERT policies only,
-- fail-closed NULLIF predicate. No UPDATE policy. No DELETE policy.
```

**Immutability summary:** *closed* immutability = `USING (status IN ('open','closing'))` — a closed row is invisible to UPDATE. *Closing-state* immutability of the count = `ck_cs_core_facts_only_when_closed` on the session **plus** the total absence of UPDATE/DELETE grants on both new tables. **Retryable-reason exception: none needed** (§3.5). **No trigger, matching the repository's zero-trigger precedent.**

---

## 9. API — RE-ISSUED

No `/v1` retrofit; current routing convention. **OpenAPI 139 → 142.**

| Route | Perm | POS | Idem-Key | Body | Response |
|---|---|---|---|---|---|
| `GET /cash-sessions/{id}/close-context` | `cash.session.close` \| `_other` | ✅ | — | — | `countMode`, `currency`, `openingFloat`, `toleranceMinorUnits`; **`expectedCash` + term breakdown ONLY in open mode** (fields absent, not null, in blind mode) |
| `POST /cash-sessions/{id}/close` | `cash.session.close` \| `_other` | ✅ | required | `closeAttemptId` (**required**), `countedTotalMinorUnits?`, `denominations?` — **no reason, no managerPin** | `201` closed (within tolerance) **or** `200` `{approvalRequired:true, …}` (frozen). Both disclose expected/counted/variance **after** commit |
| `POST /cash-sessions/{id}/close/finalize` | `cash.session.close` \| `_other` | ✅ | required | `approvalRequestId`, `approvalDecisionId`, `decision:'approved'\|'rejected'`, `reason`, `managerPin`, `comment?` | `200` `{outcome:'closed'\|'rejected', …}` |

No Governance HTTP surface (**D-14 A-1** unchanged). No X-report route or permission.

---

## 10. TEST MATRIX — PRIOR 40 PRESERVED, 12 ADDED

All genuine DB races run **≥3 clean times**; deterministic barriers, no sleeps.

41. direct `ros_app` `UPDATE … SET counted_cash=…` while `status='closing'` → **CHECK violation**
42. direct `UPDATE` cannot alter the attempt or its policy/denomination facts → **no UPDATE grant**; second attempt row → **UNIQUE violation**
43. reason revision across retries succeeds (each finalize carries its own reason) — *shape contingent on R-6(a)*
44. manager rejection **COMMITs** `ApprovalRequest` + REJECTED `ApprovalDecision` while the session stays `closing`
45. rejection does **not** permit a recount (`UNIQUE` → 409) nor `closing → open` (`WITH CHECK`)
46. rejection does **not** permit Payment / pay-in / pay-out / safe-drop
47. approval-expiry failure leaves **no** partial Governance state — request and decision both rolled back, session unchanged
48. retry after rejection creates a **NEW** request with new ids
49. retry after an expiry-induced rollback creates a **NEW** request
50. approved close stores the **approved** request id and that call's reason
51. `POST /close` has **no** manager-PIN path — asserted against the DTO/OpenAPI schema, so the removed fast path cannot silently return
52. FR-OFF-015: missing `closeAttemptId` → 400; server never reassigns it; replay with the same id + same count → replay; same id + different count → **409**

---

## 11. PRESERVED WITHOUT CHANGE

* **Payment advisory lock (§13):** `SalesPaymentService` must acquire the **exact** `pg_advisory_xact_lock(hashtext('ros_cash_session'), hashtext(cashSessionId))` before reading the Order/CashSession facts. No schema change, no alternate key, in-slice.
* **`CashSessionsService.open` §5.2.3 correction (§14):** replace the carried direct Branch query with the published `BRANCH_CURRENCY_QUERY`. No behaviour change, no schema change, no `KNOWN_DEVIATIONS` growth.
* **Expected-cash position (§15):** unchanged, now DB-enforced (§7).
* Policy resolution at `opened_at` (R-3(a)); `abs(variance) > tolerance` (R-2(a)); self-approval blocked by the DB conjunct with **fail-closed on a NULL owner User**; canonical lock order CashSession → Order → Inventory; `closing` freezes both consumers via their existing `!== 'open'` checks; Shift is **not** transitioned.
* Requirement classifications unchanged: FR-POS-094/095/096/097, FR-FIN-005/006, FR-SEC-016/030/033 → **COMPLETE**; FR-FIN-004/007/010, FR-SEC-032 → **PARTIAL**; branch-scoped RBAC (FR-SEC-002/003/004) → **NOT IMPLEMENTED**, not claimed.

---

## 12. VERDICT

# **A. P1G-1 DESIGN CORRECTED — R-6 ONLY REMAINS**

Three defects closed; **no new ratification item discovered**; R-6 **narrowed** to rejection semantics alone after the expiry limb was disproved from the accepted implementation. **No Sonnet implementation prompt is issued**, because R-6 is P1G-1-critical and unratified.

---

## Scope compliance

Design correction only. No product code, no migration (34 planned only, **not created**), no test change, **no governance recording**, no `D-21+`, no commit, no push, no deployment. No destructive git command used. HEAD `0f10afe` unchanged. The prior design gate is **not overwritten**; the 4 unrelated uncommitted reports and their `INDEX.md` rows are byte-identical; `INDEX.md` is appended to only.

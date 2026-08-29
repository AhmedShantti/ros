# Approval Runtime — Design Acceptance Closure

**Report type:** Narrow design correction. **No product code, no migration, no governance-register edit, no commit, no push, no D-21+.**
**Authority statement:** This report is **non-authoritative evidence**. Authority order: **(1) `ROS_SRS_v1.0.pdf` → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (current working tree, including the uncommitted 2026-08-29 ratification) → (3) the repository at HEAD `55e4ae8` → (4) accepted reports → (5) engineering inference only where authority is silent.**
**Date:** 2026-08-29
**HEAD:** `55e4ae8` (unchanged), branch `feat/production-spec`, migrations **31**
**Corrects:** `docs/reports/claude/2026-08-29_APPROVAL_runtime-final-design-gate.md` §§5.2, 9, 10.2, 12, 17, 19. All other sections of that gate stand.
**Task identifier:** APPROVAL runtime design acceptance closure

> ## VERDICT
> ## **B. DESIGN CORRECTION REQUIRED — PROVIDED, NO NEW RATIFICATION**
>
> **The expiry challenge is upheld, and it is more serious than a style
> preference: the prior design's `now()` predicate would have *violated*
> ratified D-10.** PostgreSQL's `now()` is the **transaction** timestamp, so a
> transaction begun before `expires_at` could insert a decision after real
> expiry and be admitted. D-10 clauses **2, 8 and 9** independently fix
> evaluation at the **decision INSERT boundary** — *"unexpired **at decision
> time**"* — which transaction-start time does not satisfy. Corrected to
> **`statement_timestamp()`**, which is exactly the property the brief names:
> stable for the statement, never frozen at transaction start.
>
> **The `now()` in the register is not a mandate.** It appears **only** in
> D-10's retained *options table* (row E2), whose own column reads *"lazy, at
> the point of action"*; **not one of D-10's fifteen ratified clauses names any
> SQL function.** So conceptual current-time-at-INSERT (A) is ratified; a
> literal call to `now()` (B) is not. **No new ratification is required — this
> correction is what compliance with the existing one demands.**
>
> **`decided_at` is bound to the same basis structurally**, not by convention:
> `DEFAULT statement_timestamp()` plus a **column-level `GRANT INSERT`** that
> omits it, so `ros_app` cannot supply it at all. The divergence the brief
> forbids becomes unrepresentable.
>
> **The PIN trust boundary is ACCEPTED, not hand-waved.** Governance's own
> shipped `AuditService` already accepts `actorId`/`tenantId` as plain trusted
> values from every module and writes them into the hash chain — so plain
> trusted-principal passing is not a new concession but the established
> architecture. It is now made explicit and **mechanically fenced** by a
> branded type plus a boundary-test detector.
>
> Nothing in §7's preserved list is reopened. **No user ratification.**

---

## 1. EXPIRY CLOCK — THE PRIOR PREDICATE VIOLATED RATIFIED D-10

### 1.1 The defect, precisely

The prior gate's policy used `r.expires_at < now()`. In PostgreSQL, `now()`, `CURRENT_TIMESTAMP` and `transaction_timestamp()` are synonyms for the **transaction start** time, frozen for the transaction's whole life.

**Failure case.** A transaction BEGINs at `T0`, before a request's `expires_at = T1`. Work proceeds; real wall-clock passes `T1`. The decision INSERT executes at `T2 > T1`. The predicate evaluates `T1 < T0` → **FALSE**, the violating disjunct does not fire, and **the decision is admitted after real expiry**. The longer the enclosing transaction, the wider the hole — and the enclosing transaction here is Treasury's close, which in the P1F-2 pattern also performs consumption planning, depletion and COGS posting.

### 1.2 Does this violate ratified D-10? — **YES**

D-10's binding clauses, verbatim:

> 2. **Expiry is evaluated when an approval decision is inserted.**
> 3. An approval decision **MUST NOT be inserted** for an approval request whose `expires_at` has passed.
> 8. Expiry enforcement occurs at the **database approval-decision INSERT boundary**, consistent with **D-7's** database-enforced mechanism.
> 9. **D-9 is explicitly amended:** … **additionally requires the approval request to be unexpired at decision time**.

Four clauses, independently, fix the evaluation point at **the INSERT / decision moment**. Transaction-start time is a *different instant*, and under the §1.1 case it reports the request as unexpired when it has in fact expired. **`now()` therefore fails clauses 2, 8 and 9.** The correction is not an optimisation; it is required for compliance.

### 1.3 A versus B — the brief's separation, answered

**A — conceptual "current time at decision INSERT": RATIFIED.** Clauses 2, 8 and 9 above.

**B — a literal mandate to call PostgreSQL `now()`: NOT RATIFIED.** The string `now()` occurs exactly once in D-10, in the **retained options-comparison table**:

> | **E2** | **Validity predicate, lazily evaluated at decision INSERT** — a decision may not be inserted once `now() > expires_at`; request stays `pending` | **lazy, at the point of action** | … |

That row is analysis, not a ratified clause, and its own adjacent column — *"lazy, at the point of action"* — states the concept the row is describing. **None of D-10's fifteen ratified clauses names a SQL function.** Reading `now()` there as a literal SQL mandate would make the ratification contradict itself, since clause 8's "INSERT boundary" and transaction-start time are different instants.

This is the same distinction the register itself draws between retained analysis and binding text — the distinction the P1G-1 gate got wrong on P-1 and the P1G-0 gate corrected.

### 1.4 The correct primitive — `statement_timestamp()`

| Function | Semantics | Fit |
|---|---|---|
| `now()` / `CURRENT_TIMESTAMP` / `transaction_timestamp()` | Transaction start; frozen | ✗ Fails D-10 cl. 2/8/9 (§1.1) |
| **`statement_timestamp()`** | Start of the **current statement**; stable within it | **✓ Exactly the brief's stated property** — stable for the INSERT, not frozen at transaction start |
| `clock_timestamp()` | True current time; **can advance within a single statement** | ✗ A security predicate that can return different values for different rows of one statement is non-deterministic; needlessly weaker guarantee for no gain |

**Repository precedent — checked, and it is clean.** Across all 31 migrations: `CURRENT_TIMESTAMP` appears 50 times (all `DEFAULT` clauses on bookkeeping columns), `now()` four times (three data backfills and one `DEFAULT`). **`now()` appears in zero RLS policies** — no existing security predicate depends on a transaction timestamp, so this correction breaks no precedent and reveals no analogous defect elsewhere. `statement_timestamp()` and `clock_timestamp()` are currently unused; this would be the first use, and it is introduced for a reason the ratified text compels.

**Application `new Date()` is not used as the authoritative boundary** — the check stays entirely inside the database WITH CHECK, per D-10 clause 8 and D-7's database-enforced mechanism.

### 1.5 Corrected policy

```sql
CREATE POLICY approval_decisions_insert ON "governance"."approval_decisions" FOR INSERT
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND NOT EXISTS (
      SELECT 1
      FROM "governance"."approval_requests" r
      WHERE r.tenant_id = approval_decisions.tenant_id
        AND r.id        = approval_decisions.approval_request_id
        AND (    r.requested_by              = approval_decisions.approver_id
              OR r.expires_at                <  statement_timestamp()      -- CORRECTED
              OR r.excluded_approver_user_id = approval_decisions.approver_id )
    )
  );
```

Still **four conjuncts**, still a `NOT EXISTS` traversal per D-7, still NULL-safe on the excluded-approver disjunct, still fail-closed on missing tenant context. **Only the clock primitive changes.**

The ratified boundary is preserved exactly: the *violating* condition is `expires_at < statement_timestamp()`, so insertion is permitted while `statement_timestamp() <= expires_at` — i.e. **a decision at exactly `expires_at` is admitted**, matching D-10's *"has passed"* / *"once `now() > expires_at`"*.

---

## 2. `decided_at` — BOUND TO THE SAME BASIS, STRUCTURALLY

### 2.1 Corrected column

| SQL | Type | Null | Default |
|---|---|---|---|
| `decided_at` | `TIMESTAMPTZ(6)` | NO | **`statement_timestamp()`** |

Prisma: `decidedAt DateTime @default(dbgenerated("statement_timestamp()")) @map("decided_at") @db.Timestamptz(6)`.

`dbgenerated(...)` is **already used in this schema** (`schema.prisma:692`, `businessDayCutover`), so the DB-side default is expressible without drift between the hand-written migration and `schema.prisma`.

`created_at` stays `DEFAULT CURRENT_TIMESTAMP`, matching the 50 existing usages: it is a bookkeeping stamp, not a security input. **`decided_at` is the authoritative `FR-SEC-033` timestamp**, and the two may differ by microseconds within one transaction — documented, not accidental.

### 2.2 The caller cannot supply `decided_at` — column-level `GRANT INSERT`

```sql
GRANT SELECT ON "governance"."approval_decisions" TO ros_app;
GRANT INSERT ("id", "tenant_id", "approval_request_id",
              "approver_id", "decision", "comment")
  ON "governance"."approval_decisions" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "governance"."approval_decisions" FROM ros_app;
```

`decided_at` and `created_at` are **absent from the grant**, so `ros_app` cannot name them in an INSERT and both defaults always fire. This is the **first column-level `GRANT INSERT`** in the repository; the mechanism itself is precedented by the ratified Production GAP-2 column-level `GRANT UPDATE ("status")`, which exists for exactly this purpose — making a column structurally unwritable rather than merely conventionally unwritten.

**Compatibility:** the service uses the raw parameterized `INSERT … ON CONFLICT DO NOTHING RETURNING` already specified in the design, which names its columns explicitly, so it simply omits both. Prisma likewise omits a field carrying a `dbgenerated` default when it is not supplied. A future caller that *did* try to supply `decided_at` would fail with a permission error — which is the intended outcome.

### 2.3 Proof

**Claim 1 — if stored `decided_at > expires_at`, the decision cannot commit.**

`decided_at` is unsuppliable by `ros_app` (§2.2), so its value is always the DEFAULT, `statement_timestamp()`, evaluated during the INSERT statement. `statement_timestamp()` is fixed for the duration of that statement, and RLS `WITH CHECK` is evaluated on the resulting row **within the same statement**, so the predicate's `statement_timestamp()` returns the **identical value** now stored in `decided_at`. Write it `S`. The policy rejects the row when `expires_at < S`. Since `decided_at = S`, the policy rejects exactly when `decided_at > expires_at`. Therefore no row with `decided_at > expires_at` can be admitted. ∎

**Claim 2 — if `decided_at = expires_at`, the row is admitted.**

With `decided_at = S = expires_at`, the violating condition `expires_at < S` is `S < S` → FALSE, so the disjunct does not fire and the row is admitted — the ratified boundary of §1.5. ∎

**Corollary — the divergence the brief forbids is unrepresentable.** "Policy says unexpired while stored `decided_at` says expired" would require the policy's clock and the stored value to differ; §2.2 makes them the same expression evaluated in the same statement, so the two can never disagree. Equivalently, the predicate could have been written `r.expires_at < approval_decisions.decided_at`; `statement_timestamp()` is preferred because it keeps the security boundary independent of the row's column values, so the guarantee survives even if a future migration widened the grant.

---

## 3. EXPIRY CONCURRENCY TEST — CORRECTED AND MADE MANDATORY

The prior §17 matrix tested the exact boundary (#5) and post-expiry decision (#6) but **would not have caught the `now()` defect**, because both used short transactions in which transaction time and statement time coincide. A new mandatory scenario is added; it is the discriminator between `transaction_timestamp()` and `statement_timestamp()`.

### 3.1 New scenario 15 — long transaction straddling the expiry boundary

**Setup.** Create a request whose `expires_at` is a known near-future instant, set from the database clock so no application clock is authoritative: `expires_at = statement_timestamp() + interval '250 milliseconds'`, and read the resulting value back as `T_exp`.

**Procedure.**
1. **BEGIN** the decision transaction and immediately execute one statement, fixing its transaction timestamp. Read `transaction_timestamp()` as `t0`. **Assert `t0 < T_exp`** — the transaction provably began *before* expiry.
2. Hold that transaction open. On a **separate connection** (the migrator/admin client, the pattern already used by the P1G-0 concurrency tests), poll `SELECT clock_timestamp() > $T_exp` until true, with a bounded timeout. This is a **bounded wait to cross a known timestamp**, not a sleep offered as proof.
3. Back inside the still-open transaction, read `statement_timestamp()` as `t2`. **Assert `t2 > T_exp`** and **assert `transaction_timestamp()` is still exactly `t0`** — proving the two clocks have genuinely diverged and straddle the boundary.
4. Execute the decision INSERT. **Assert it is rejected** (zero rows admitted / RLS violation).
5. **Assert zero decision rows exist** for the request and that its `status` is still `pending`.

**Discriminating power.** Under the prior `now()` predicate, step 4 would **succeed** — the transaction timestamp `t0` precedes `T_exp` — and the test fails, exposing the defect. Under `statement_timestamp()`, step 4 is correctly rejected. Every correctness assertion is a **database timestamp comparison**; wall-clock elapsed time is never the proof.

### 3.2 Retained and adjusted

Scenario **#5 (exact boundary)** is **retained**, and is strengthened by §2: since `decided_at` is DB-supplied, the test asserts the *stored* `decided_at <= expires_at` on the admitted row rather than trusting an application timestamp. Scenario **#6 (already-expired request)** is retained unchanged. The full §17 matrix is otherwise preserved, now **15 scenarios**.

---

## 4. PIN VERIFICATION TRUST BOUNDARY

### 4.1 The four questions, answered directly

**A. Is every module allowed to be trusted to provide authenticated identity facts to Governance?**

**Within this architecture, yes — because there is no boundary that could enforce otherwise.** ROS is a modular monolith: all modules share one process and one Prisma client. A module that wanted to forge an approval need not go through Governance's contract at all — it could issue `tx.$executeRaw` directly, bounded only by RLS. The real security boundaries are the HTTP/auth layer above and the **database** below; the module edge is a **design-discipline** boundary, mechanically enforced for *imports*, not a trust boundary against a hostile in-process caller.

Critically, **the ratified DB invariants do not trust the passed principal at all.** The four-conjunct policy compares `approval_decisions.approver_id` against the request's own `requested_by` and `excluded_approver_user_id`. A fabricated principal cannot defeat self-approval or the excluded approver, cannot cross tenants, and cannot beat expiry. What it *could* do is attribute a decision to a user who did not authenticate — which is precisely the residual that already exists for every `actorUserId` in the system.

**B. Does the current architecture already use equivalent trusted-principal passing? — YES, and Governance itself already does it.**

- `SalesPaymentService.capture(tenantId, actorUserId, { employeeId, terminalId, … })` — the input fields are documented *"Trusted PIN-session employee. NEVER from the request body."*
- `CashMovementsService.record(tenantId, actorUserId, { employeeId, terminalId })` — identical posture, shipped in P1G-0.
- `CashSessionsService.open(tenantId, actorUserId, { employeeId, terminalId })` — identical.
- **`AuditService.record(tx, { tenantId, actorId, actorType, … })`** — **a Governance service**, called by every module in the system, accepting the actor as a plain string and writing it into the **hash-chained** audit trail.

The last is decisive: if plain trusted-value passing were unacceptable for Governance, the shipped audit chain — the system's tamper-evidence mechanism — would already be unsound. Accepting `VerifiedTerminalPrincipal` is **strictly stronger** than the status quo, because it carries a membership-validated `userId` plus the resolved permission set rather than a bare string.

**C. Does FR-SEC-032 require Governance itself to verify? — NO.**

Verbatim: *"Approvals SHALL be obtainable **synchronously (manager PIN on the terminal)** or asynchronously…"*. It requires the **capability** to exist; it assigns no module. The SRS's own context map places authentication in **Identity & Tenancy**, *"(upstream, conformist) ──▶ every context"*, and §7.3 row 36 places only the ApprovalRequest aggregate in Governance. **Identity verifying and Governance recording is the SRS's own layering**, not a compromise.

**D. Can Governance consume the Identity verifier directly, without nesting `withAuthContext` and without separating the decision from the consuming business transaction? — NOT SAFELY.**

`PinService.authenticate` opens its own `prisma.withAuthContext(...)`. Called from inside Treasury's open transaction it would not literally nest — Prisma would take a **second pooled connection** — but that is the classic transaction-inside-transaction anti-pattern: it holds two connections for one logical operation and risks pool exhaustion and self-deadlock under load, and it contradicts the explicit guidance in `prisma.service.ts` (*"Nested calls to `withAuthContext` are NOT supported … compose within a single scope instead"*).

Nor can it be fixed by making the verifier `tx`-first: `recordFailure` deliberately runs **outside** any transaction so lockout counters survive a caller rollback. Joining Treasury's transaction would let an attacker obtain unlimited PIN attempts by forcing that transaction to roll back — a real regression in a `FR-SEC-022` control.

The remaining alternative — passing the **raw PIN** through Treasury into Governance — is worse: it widens the blast radius of the secret and puts credential material in a module that has no business holding it.

**Conclusion: the current orchestration is the correct one.** Verify in Identity, before the transaction; pass verified facts; keep the decision, status transition, audit and business write in one transaction.

### 4.2 Accepted — with the trust assumption stated and mechanically fenced

**Explicit trust assumption, to be recorded in the contract docblock:**

> `VerifiedTerminalPrincipal` asserts that Identity verified a manager PIN on a registered terminal. Governance **consumes** that assertion and does not re-verify it. This is the same trust the shipped `AuditService` places in every caller's `actorId`, and the same trust `SalesPaymentService` and `CashMovementsService` place in a caller-supplied trusted `employeeId`. It is a **design-discipline** boundary, not a defence against a hostile in-process caller — which the modular monolith does not have and does not claim. The **security-critical invariants — tenant isolation, requester ≠ approver, excluded approver, expiry, one-final-decision — are enforced by the database and hold regardless of what any caller passes.**

**Fence 1 — a branded type, so fabrication cannot be silent.** In `identity/contract/pin-verification.contract.ts`:

```ts
declare const VERIFIED_BY_IDENTITY: unique symbol;

export interface VerifiedTerminalPrincipal {
  /** Brand — only Identity's verifier produces this type. Not present at runtime. */
  readonly [VERIFIED_BY_IDENTITY]: true;
  readonly userId: string;
  readonly employeeId: string;
  readonly membershipId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly permissions: ReadonlySet<string>;
}
```

The symbol is `declare`d and **not exported as a value**, so no module outside Identity can construct a conforming object literal. Fabrication becomes impossible by accident and requires an explicit `as`-cast — a **greppable, reviewable act** rather than a silent one. There is zero runtime cost: the brand never exists at runtime, and Identity performs exactly one cast in its implementation. It introduces no `any`, no class and no Prisma query, so it passes the contract-purity detectors unchanged.

**Fence 2 — a boundary-test detector.** `module-boundaries.spec.ts` already carries behavioural detectors with self-tests (`containsPersistenceImplementation`, `containsForeignPrismaQuery`). Add one asserting that a cast to `VerifiedTerminalPrincipal` appears **only** under `src/modules/identity/`, with its own self-test proving the detector fires on a fabricated bad example. Any future forger must then delete a test to proceed.

**Fence 3 — Governance still checks what it can.** `decide` asserts that the inserted `approver_id` equals `approver.userId` (the caller cannot decouple the attributed approver from the verified one) and that `approver.permissions` contains the request's `required_permission`. Everything further is DB-enforced.

**Not invented, per the brief:** no new auth token, no signed approval proof, no new session, no Governance HTTP endpoint.

---

## 5. DECISION ZERO-ROW ALGORITHM — SPECIFIED EXACTLY

A zero-row result from `INSERT … ON CONFLICT DO NOTHING RETURNING …` means the PK on `id` conflicted, or `UNIQUE (tenant_id, approval_request_id)` conflicted, or both. The transaction is **healthy** — `ON CONFLICT` raises nothing, so no `23505` recovery in an aborted transaction ever occurs (the P1E-5A lesson).

```
if (inserted.length === 0) {

  // ── BRANCH 1 — permanent-id conflict. Checked FIRST: a same-id retry is a
  //    replay and must not be misreported as a per-request conflict.
  const sameId = await tx.approvalDecision.findUnique({ where: { id: command.id } });
  if (sameId) {
    assertIdenticalDecision(sameId, {
      tenantId,
      approvalRequestId: command.approvalRequestId,
      approverId:        approver.userId,
      decision:          command.decision,
      comment:           command.comment ?? null,
    });                       // differing -> ApprovalDecisionConflictError (409)
    return { decision: sameId, created: false };   // identical -> REPLAY
  }

  // ── BRANCH 2 — a DIFFERENT decision id already exists for this request.
  //    ALWAYS a conflict. Never replay, even if `decision` happens to match:
  //    a distinct id is a distinct business act by a distinct approver.
  const winner = await tx.approvalDecision.findFirst({
    where: { tenantId, approvalRequestId: command.approvalRequestId },
  });
  if (winner) {
    throw new ApprovalDecisionConflictError(
      'That approval request already has a final decision.',
    );
  }

  // ── BRANCH 3 — defensive: conflict with no visible winner.
  throw new Error(
    `Decision insert conflicted for id ${command.id} but no row is visible afterwards.`,
  );
}
```

**Why branch order is load-bearing.** Checking the per-request UNIQUE first would report a legitimate same-id replay as a conflict, because the replayed row also satisfies the per-request predicate. Same-id must therefore be resolved first.

**`assertIdenticalDecision` compares** `tenantId`, `approvalRequestId`, `approverId`, `decision`, `comment` — and **excludes `decided_at` and `created_at`**, which are DB-generated and would differ between two genuine attempts. This mirrors the established precedent of excluding `OrderPayment.processedAt` and `CashMovement.occurredAt` from identical-content checks.

**Guarantees the brief requires, each satisfied:**

| Requirement | How |
|---|---|
| Case 1 identical → replay | Branch 1 returns the existing row, `created: false` |
| Case 1 differing → conflict | `assertIdenticalDecision` throws |
| Case 2 → conflict, **never** replay on matching outcome | Branch 2 throws unconditionally; `decision` is never compared there |
| **No duplicate audit** | Audit is written only on the created path; both replay and conflict skip it |
| **No CAS UPDATE on replay** | Branch 1 returns before the status transition; the original winner already performed it |
| **No `23505` recovery in an aborted transaction** | `ON CONFLICT DO NOTHING` raises nothing; the transaction stays healthy for both reads |

A **STEP-1 pre-check** (`findUnique` by `id` before the INSERT) is retained from the accepted design for the cheap sequential-retry case; the branches above cover the concurrent case that the pre-check cannot see. This is exactly `CashMovementsService.record`'s shape.

---

## 6. CORRECTED REQUIREMENT CLASSIFICATION

**`FR-SEC-016` [M] — corrected from PARTIAL to:**

> **NOT IMPLEMENTED — enforcement substrate enabled.**
> The DB-enforced generic primitives exist (requester ≠ approver via D-7 M2; excluded approver via item 8), and any future consumer inherits them automatically. But **zero of the four named combinations is operational after migration 32 alone**: cash variance awaits P1G-1; discounts have no approval consumer in Sales; requisitions have no Procurement domain; and strict SoD does not exist as a tenant setting. **No combination is claimed operational.**

This adopts the P1G-0 phrasing precedent ("NOT IMPLEMENTED — substrate enabled") rather than PARTIAL, because PARTIAL would imply at least one named combination is partly working, which is not the case.

**Re-checked for the same error, and sharpened:**

| Requirement | Classification after migration 32 alone |
|---|---|
| **FR-SEC-030** [M] | **PARTIAL** — the general mechanism is provided and consumable, which is the operative SHALL; but **zero of the seven named consumers is wired**, so COMPLETE is not claimed |
| **FR-SEC-031** [M] | **COMPLETE (substrate)** — all six elements present, `NOT NULL`, immutable after INSERT. Constrains the shape of any request created; no request exists until a consumer does |
| **FR-SEC-032** [M] | **PARTIAL** — synchronous manager PIN implemented; the **asynchronous half remains deferred and knowingly unmet** (D-2, D-11 N-B), including *"the terminal remaining usable while awaiting an asynchronous decision"* |
| **FR-SEC-033** [M] | **COMPLETE (substrate)** — approver, timestamp, decision, comment recorded; immutability DB-enforced. Strengthened by §2: `decided_at` is now DB-supplied and unforgeable |
| **FR-SEC-016** [M] | **NOT IMPLEMENTED — enforcement substrate enabled** (corrected) |
| **FR-FIN-006** [M] | **NOT IMPLEMENTED — substrate enabled** — wholly P1G-1's |

---

## 7. ACCEPTED DESIGN PRESERVED

Explicitly unchanged, per the brief: **migration 32**; the **two Governance tables**; the **P-1 direct composite parent FK** with `ON DELETE RESTRICT`; **no user FKs**; `excluded_approver_user_id`; the **opaque `JSONB` `value`** with minor-unit integer strings; **`UNIQUE (tenant_id, approval_request_id)`**; **no Governance HTTP or read surface**; the **Identity public PIN contract**; **D-12 untouched**; **async approval deferred**; the **four DB exclusion/expiry conjuncts**; **D-9 U4's request-status CAS**; **no approval-specific pessimistic lock**; **OpenAPI stays 138**; and the full §17 concurrency matrix (now 15 scenarios).

**Delta from the accepted gate — the complete list:**

| # | Change | Section |
|---|---|---|
| 1 | Policy clock `now()` → **`statement_timestamp()`** | §1 |
| 2 | `decided_at` gains **`DEFAULT statement_timestamp()`** (`dbgenerated` in Prisma) | §2.1 |
| 3 | Decisions use a **column-level `GRANT INSERT`** omitting `decided_at`/`created_at` | §2.2 |
| 4 | New mandatory **scenario 15** (long transaction straddling expiry); #5 asserts the stored `decided_at` | §3 |
| 5 | `VerifiedTerminalPrincipal` becomes a **branded type**; trust assumption documented; boundary detector added | §4.2 |
| 6 | Zero-row branch algorithm **specified exactly**, branch order justified | §5 |
| 7 | **FR-SEC-016** corrected to NOT IMPLEMENTED — substrate enabled | §6 |

Items 1–3 touch the migration; 4 touches tests; 5 touches two contract files and the boundary spec; 6 is service logic; 7 is wording. **No new table, column semantic, constraint, ratified invariant or module boundary is introduced.**

---

## 8. GOVERNANCE IMPACT — NONE

**No new ratification is required, and the register is not edited by this task.**

- The **expiry correction implements** ratified D-10 clauses 2/8/9; it does not amend them. `now()` was an implementation error against the ratified semantic, not an alternative reading of it.
- `statement_timestamp()` is a **SQL primitive choice** — expressly a Design-Gate detail under the 2026-08-29 ratification, which reserved *"exact RLS SQL / predicate form"* to this gate.
- The **column-level `GRANT INSERT`** narrows what `ros_app` may write; it grants nothing new and strengthens D-8's append-only posture.
- The **branded type** is a TypeScript device with no runtime or database effect.
- **P-1 unopened · D-12 BLOCKED · D-16 enumeration OPEN · async `FR-SEC-032` deferred · no Governance HTTP or read surface · D-15's clause 3, 5 and C-3 prohibitions preserved · D-9 U4 unchanged.**

---

## 9. FINAL VERDICT

## **B. DESIGN CORRECTION REQUIRED — PROVIDED, NO NEW RATIFICATION**

The challenge was well-founded on every count. The expiry defect was real and would have **violated ratified D-10** — the prior design would have admitted decisions after genuine expiry inside any long transaction, and the prior test matrix could not have detected it. `decided_at` is now bound to the same clock structurally rather than by convention, making the forbidden divergence unrepresentable. The zero-row algorithm is specified branch by branch with its ordering justified. The PIN trust boundary is **accepted on evidence** — Governance's own `AuditService` already relies on exactly this trust — and is now stated openly and fenced by a branded type plus a boundary detector, rather than left implicit.

**Verdict E is not selected:** the corrected design does not conflict with D-10 — it is what D-10 requires, and the conflict existed only in the prior SQL. **Verdict D is not selected:** the trust boundary is architecturally consistent, DB-backstopped, and mechanically fenced. **Verdict C is not selected:** nothing here needs user ratification. **Verdict A is not selected:** the prior design was not correct as written.

**With these seven corrections applied, the approval runtime design is implementation-ready.** The next step remains a Sonnet implementation prompt scoped to the corrected design, with the 15-scenario matrix — scenario 15 in particular — as the acceptance bar.

**No commit. No push. No implementation authorized.**

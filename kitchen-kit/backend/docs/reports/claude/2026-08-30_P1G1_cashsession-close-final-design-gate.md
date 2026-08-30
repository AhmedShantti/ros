# P1G-1 CashSession Close — FINAL DESIGN / REBASE GATE

**Task / slice:** P1G-1 CashSession Close (physical count, variance, approval, immutable close)
**Report type:** Design / analysis gate. **No product code, no migration, no test change, no commit, no push, no deployment, no D-21+.**
**Authority statement:** This report is **NON-AUTHORITATIVE EVIDENCE**. Authority order: **(1) `ROS_SRS_v1.0.pdf` → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md` → (3) the repository at HEAD `0f10afe` → (4) the accepted P1G-1 / Approval / P1G-0 reports → (5) engineering inference, labelled as such.** Where this report and the SRS or the register differ, **they govern**. Prior report prose is corrected in §0.3 where current source gives stronger evidence.
**Date:** 2026-08-30
**HEAD:** `0f10afe` — *feat: add cash close policy substrate* (unchanged; no commit performed)
**Branch:** `feat/production-spec` · **Remotes:** `upstream/main` and `origin/feat/production-spec` both at `0f10afe`
**Working tree at start:** 4 unrelated uncommitted reports + their 4 `INDEX.md` rows. All left byte-identical.
**Working tree at report time:** the above, plus this report and one appended `INDEX.md` row.
**Migrations at HEAD:** 33 · **OpenAPI:** 3.1.0 / 139 operations · **Baseline:** unit 751/751, e2e 904/904, module-boundaries 38/38
**Task identifier:** P1G-1 CashSession Close final design gate

> ## VERDICT
> ## **B. P1G-1 IMPLEMENTATION READY AFTER NARROW USER RATIFICATION**
>
> **One** ratification item remains, and it is genuinely a business-behaviour gap
> no source decides: **what happens to a frozen drawer when the variance approval
> is REJECTED or EXPIRES** (§24 → **R-6**). Everything else — the close protocol,
> the blind-count freeze point, the state machine, the concurrency model, the
> expected-cash formula, denominations, approval wiring, immutability, and the
> full migration-34 plan — is **design-decidable and settled below**.
>
> **Two findings are load-bearing and correct prior prose:**
>
> 1. **A real Payment/Close race exists and is proven, not asserted.**
>    `SalesPaymentService` reads CashSession status through an **unlocked**
>    `SELECT` (`sales-payment.service.ts:183`) and takes **no** advisory lock
>    anywhere. Under the repository's default READ COMMITTED isolation a payment
>    can commit *after* a close has computed expected cash and closed the
>    session. **Accepted Payment code MUST be narrowly modified** — a 4-line
>    advisory-lock acquisition, scope fixed in §8. This is an **in-slice**
>    correction, not a prior blocker: it needs no migration and no schema change.
>
> 2. **`ros_app` currently holds NO UPDATE grant on `treasury.cash_sessions`
>    at all** (`GRANT SELECT, INSERT` only; SELECT+INSERT policies only). Closing
>    is therefore not merely unrouted — it is **structurally impossible today**.
>    Migration 34 must grant a *narrow, column-level, compare-and-set* UPDATE,
>    reusing migration 32's own ratified `approval_requests` pattern verbatim.
>
> **FR-FIN-004 will be PARTIAL, honestly and safely.** Cash tips and cash refunds
> are **structurally unrepresentable** at HEAD — proven in §6, not assumed — so
> their contribution is *necessarily* zero rather than *conveniently* zero. This
> is not a blocker (verdict is **not C**).

---

## 0. WHAT WAS READ, AND THREE CORRECTIONS

### 0.1 Evidence base

`ROS_SRS_v1.0.pdf` (6,510 lines, `pdftotext -layout`); the Governance Decision Register (6,671 lines at HEAD, including the ratified *P1G-1 Cash-Close Policy Ratification — 2026-08-30*); the repository at `0f10afe` — `prisma/schema.prisma`, all 33 migrations' grant/RLS/policy shape, `modules/{treasury,sales,identity,governance,organisation}`, `module-boundaries.spec.ts`; and the five accepted P1G-1 / Approval / P1G-0 reports.

### 0.2 Repository facts established by direct inspection (not from prior prose)

| Fact | Evidence |
|---|---|
| `cash_sessions` grants are `SELECT, INSERT` **only** — no UPDATE, no DELETE | `20260820160000_…/migration.sql:236` |
| `cash_sessions` has SELECT + INSERT **policies only** — no UPDATE policy | same file, `:255`, `:257` |
| `CashSessionStatus` enum is exactly `open \| closed` | `schema.prisma` |
| The `ros_cash_session` advisory lock is used by **exactly one** service | `cash-movements.service.ts:182` |
| `SalesPaymentService` takes **no** advisory lock, and reads session status unlocked | `sales-payment.service.ts:183`; no `pg_advisory_xact_lock` anywhere in the file |
| `orders.service.ts:129`'s advisory lock is a **different key** (`ros_order_number`) | `orders.service.ts:129-132` |
| No `isolationLevel` is configured anywhere → **READ COMMITTED** | exhaustive grep of `prisma.service.ts`, `unit-of-work.ts` |
| Payment uses **optimistic CAS on `order.version`**, not a row lock | `sales-payment.service.ts:370`, `:532` |
| `Order.tipTotal` is **read in 4 places, written in 0** | exhaustive grep for `tipTotal:` in any create/update data block → no matches |
| `partially_refunded` / `refunded` have **no inbound transition** | `order-state.ts:88-90` — `TRANSITIONS` maps both to `[]`, and nothing targets them |
| `OrderPayment.roundingAdjustment` exists and is CASH-only | `schema.prisma`; CHECK-enforced |
| `OrderPayment` is indexed `(tenantId, cashSessionId)` | `schema.prisma` `@@index` |
| **Sales publishes NO query contract** — `contract/` holds only `events.ts` | `sales/contract/index.ts` |
| `cash.variance.approve` is **NOT seeded** | `treasury.permissions.ts` — 4 codes seeded, this is documented as deliberately absent |
| `Employee.userId` is **nullable** (`String?`) | `schema.prisma` |
| **No Treasury GET route exists**; no route returns expected cash | route inventory, §34 |
| PostgreSQL is **16.15** | `SHOW server_version` |

### 0.3 Three corrections to prior prose

1. **CORRECTION — the 2026-08-28 gate's "6 of 8 terms" framing is stale and imprecise.** At HEAD `0f10afe`, **six of eight terms are computable and two are structurally zero**, which is a materially different (and better) position than "two terms missing". Critically, **Cash Rounding Adjustments is now computable** — `OrderPayment.roundingAdjustment` was added by P1F-1 and is CASH-only — which that gate listed as merely "IMPLEMENTABLE". §5 gives the term-by-term matrix.

2. **CORRECTION — the prior gate's proposed `SELECT … FOR UPDATE` on `cash_sessions` remains inoperable, and P1G-0 already recorded why.** `ros_app` holds no UPDATE privilege on that table, and PostgreSQL requires UPDATE privilege to take a row lock via `FOR UPDATE`. P1G-0 substituted the advisory lock for exactly this reason. **P1G-1 must reuse the advisory lock, not reintroduce `FOR UPDATE`** — even after migration 34 grants a *column-level* UPDATE, because a column-level grant does **not** confer row-lock privilege.

3. **CORRECTION — "the session status check protects Payment" is false.** The check at `sales-payment.service.ts:190` reads a snapshot taken without any lock. Under READ COMMITTED it is a classic time-of-check/time-of-use window. §8 proves the interleaving.

---

## 1. SRS REQUIREMENTS TRACED

Verbatim where quoted; classification per §3 of the brief.

| ID | Exact meaning | Classification |
|---|---|---|
| **FR-POS-090** [M] | *"A cashier SHALL be required to open a shift, declaring an opening float, before processing sales."* | **SOURCE-DECIDED** — already COMPLETE at HEAD |
| **FR-POS-091** [M] | pay-in / pay-out / safe drop, *"each with reason and amount"* | **SOURCE-DECIDED** — COMPLETE (P1G-0) |
| **FR-POS-094** [M] | *"Shift close SHALL require a physical cash count. The System SHALL support both **blind count** (expected amount hidden until after entry) and **open count**, configurable per branch."* | **SOURCE-DECIDED**. Note *"hidden until **after entry**"* — the disclosure boundary is the **entry**, which is the design's freeze point (§11) |
| **FR-POS-095** [M] | *"Blind count SHALL be the default configuration."* + rationale: *"a shortage can be concealed by 'counting' the expected number… a basic internal control"* | **SOURCE-DECIDED**, and the rationale makes blind a **security control**, not a display preference |
| **FR-POS-096** [M] | *"Shift close SHALL compute and record cash variance, and SHALL require a reason and manager acknowledgement when variance exceeds a configurable tolerance."* | **SOURCE-DECIDED**. FR-FIN-006 is strictly stronger (named permission + non-self-approval), so satisfying FR-FIN-006 satisfies this |
| **FR-POS-097** [M] | *"Denomination-level counting SHALL be **supported**, with the System computing the total from denomination counts."* | **SOURCE-DECIDED** — "supported", i.e. *available*, not mandatory on every close (§18) |
| **FR-FIN-001/002** [M] | drawer is branch-level, one open session per drawer; session bound to exactly one employee | **SOURCE-DECIDED** — COMPLETE at HEAD |
| **FR-FIN-004** [M] | the eight-term expected-cash formula | **SOURCE-DECIDED** — see §5 |
| **FR-FIN-005** [M] | *"Cash variance SHALL be computed as Counted Cash − Expected Cash and SHALL be **recorded on the session**."* | **SOURCE-DECIDED** — variance is **signed**, and *"on the session"* is why §19 puts the three core figures on `cash_sessions` |
| **FR-FIN-006** [M] | *"Variance **beyond** a configurable tolerance SHALL require a reason and approval by a user with `cash.variance.approve`, who SHALL NOT be the session owner."* | **SOURCE-DECIDED**; comparison semantics **RATIFIED** as R-2(a) |
| **FR-FIN-007** [M] | *"Cash sessions SHALL be immutable once closed. Corrections SHALL be recorded as adjusting entries referencing the session."* | **SOURCE-DECIDED**, two clauses. Clause 1 **in scope**; clause 2 **out of scope** (§41) |
| **FR-FIN-010** [M] | totals by tender type per session and per day | **SOURCE-DECIDED** — only `cash` and `manual_external_card` exist, so global completion is impossible; §40 keeps the data reachable |
| **FR-FIN-021** [M] | *"Day close SHALL be blocked while any cash session remains open"* | **SOURCE-DECIDED** — a `closing` session is **not closed** and therefore blocks day close (§28) |
| **FR-FIN-022** [M] | Z report content incl. *"cash reconciliation, and variance summary"* | **SOURCE-DECIDED** — out of scope; §39's snapshot supplies its inputs |
| **FR-SEC-016** [M] | *"The System SHALL **block, not merely warn**… approving one's own cash variance"* | **SOURCE-DECIDED** — DB-enforced by the Approval Runtime's 4th conjunct |
| **FR-SEC-030…033** [M] | general approval mechanism; request carries requester/action/entity/value/required permission/expiry; synchronous **or** asynchronous; decisions immutable | **SOURCE-DECIDED**; runtime **FINAL ACCEPTED**. Async half remains **deferred** |
| **FR-AUD-002/006** [M] | audit field set; *"cash variances"* and *"configuration changes"* always audited | **SOURCE-DECIDED** |
| **FR-API-020…023** [M] | mandatory `Idempotency-Key`; store key+fingerprint+response; replay; 409 on mismatch | **SOURCE-DECIDED** — global interceptor already implements all four |
| **FR-PLT-003/010…014** [M] | tenant isolation, RLS, fail-closed, delete isolation tested | **SOURCE-DECIDED** — established pattern |
| **BR-CORE-001 / §7.2** | integer minor units + ISO currency; *"Arithmetic between different currencies SHALL raise an error"* | **SOURCE-DECIDED** |
| **§15.2 Cash** | `cash.session.close`, `cash.session.close_other`, `cash.drawer.open_no_sale`, `cash.variance.approve`, `cash.day.close` | **SOURCE-DECIDED** vocabulary; none may be invented |
| **§15.4 SoD** | `cash.session.close (own)` × `cash.variance.approve` = *"Self-approved shortage"* | **SOURCE-DECIDED** |
| **§24.2.3** | `policy.evaluate()` inside the consuming handler, `ApprovalService` injected as a collaborator | **SOURCE-DECIDED** pattern — Treasury owns the gate, Governance stays generic (**D-13 RATIFIED**) |

### 1.1 Shift vs CashSession — the SRS's own wording

§8.7 titles the requirements *"Shift close"*; §16.2 models the **CashSession** as the drawer-custody aggregate. The SRS never states that closing a drawer closes a shift, and §16.2's hierarchy is `Drawer → Cash Session`, with the Shift belonging to Workforce.

**Repository facts settle the ambiguity:** `cash_sessions.shift_id` is indexed **non-uniquely**, and the one-open-session constraint is on the **drawer**, not the shift — so one Shift genuinely may own several concurrent CashSessions. **Closing one CashSession therefore cannot close its Shift** without silently terminating sibling sessions.

**Decision (§4):** FR-POS-094/095/096/097's *content* (physical count, blind/open, variance, denominations) applies to **CashSession close**, because the drawer is the Treasury custody boundary those rules describe. **No Shift status transition occurs in P1G-1.** The Shift-close trigger/actor/timing remains **NOT SOURCE-DECIDABLE** and is left unresolved, exactly as the 2026-08-28 gate found. **No auto-close of Shift is invented.**

---

## 2. EXPECTED CASH — TERM-BY-TERM EVIDENCE MATRIX (§5)

FR-FIN-004's eight terms, audited at HEAD `0f10afe`:

| # | Term | Owner | Source at HEAD | Contract needed | Non-zero possible? | Computable by P1G-1? |
|---|---|---|---|---|---|---|
| 1 | **Opening Float** | Treasury | `cash_sessions.opening_float` | none (own table) | **Yes** | **Yes** |
| 2 | **Cash Sales** | Sales | `sales.order_payments` where `tender='cash'`, indexed `(tenantId, cashSessionId)` | **NEW Sales contract** (§7) | **Yes** | **Yes, via contract** |
| 3 | **Cash Tips (if placed in drawer)** | Sales | `orders.tip_total` exists, `@default(0)`, **written by zero code paths** | — | **NO — structurally zero** | Yes: necessarily `0` |
| 4 | **Pay-ins** | Treasury | `cash_movements` type `pay_in` | `CASH_MOVEMENT_TOTALS_QUERY` (**exists**) | **Yes** | **Yes** |
| 5 | **Cash Refunds** | Sales | no refund entity; `refunded`/`partially_refunded` have **no inbound transition** | — | **NO — structurally zero** | Yes: necessarily `0` |
| 6 | **Pay-outs** | Treasury | `cash_movements` type `pay_out` | `CASH_MOVEMENT_TOTALS_QUERY` (**exists**) | **Yes** | **Yes** |
| 7 | **Safe Drops** | Treasury | `cash_movements` type `safe_drop` | `CASH_MOVEMENT_TOTALS_QUERY` (**exists**) | **Yes** | **Yes** |
| 8 | **Cash Rounding Adjustments** | Sales | `order_payments.rounding_adjustment`, CASH-only, CHECK-enforced | **NEW Sales contract** (§7) | **Yes** | **Yes, via contract** |

**Six of eight terms are live and computable. Two are structurally zero.**

### 2.1 Tips and refunds — the honest resolution (§6)

The brief demands the distinction between *"zero because no such transaction can exist"* and *"zero because we did not implement the term."* Both terms are the **former**, and this is proven rather than assumed:

**Cash tips — answer A (truly impossible to record today).**
`Order.tipTotal` is a real `BigInt @default(0)` column, but an exhaustive grep for `tipTotal:` inside any Prisma `create`/`update` data block returns **zero matches**; the column appears only in a view mapper, an event payload, an OpenAPI schema and the domain-event contract — all **reads**. There is no tip-entry route, no tip DTO field, and no tip column on `OrderPayment` at all. FR-POS-056/057 are **[S]**, not [M]. **A tip cannot be recorded at HEAD, so the drawer cannot contain one.** Its contribution is *necessarily* zero.

**Cash refunds — answer A (truly impossible to record today).**
There is no refund table, no refund route, no refund service. `OrderState` declares `partially_refunded` and `refunded`, but `TRANSITIONS` maps **both to `[]`** and **no entry targets either** — `assertTransition` refuses every path into them, and `order-state.ts`'s own docblock says so explicitly (*"it refuses to invent a way of reaching them"*). **A refund cannot occur at HEAD, so no cash can leave the drawer as one.** Its contribution is *necessarily* zero.

**Is computing the presently-realisable formula safe? YES.**
The computed expected cash is **exactly correct for every transaction the system can represent**. There is no reachable state in which a real tip or refund exists and is omitted. This is arithmetically sound, not an approximation.

**FR-FIN-004 nevertheless remains PARTIAL** after P1G-1 — two mandated terms have no producing operation, and the requirement is about the System supporting the formula, not about one close being right. **This is recorded as PARTIAL and must not be claimed COMPLETE.** No blocker; verdict is **not C**.

---

## 3. CROSS-MODULE QUERIES — ONE NEW SALES CONTRACT (§7)

Treasury needs terms 2 and 8 (both Sales-owned). **Sales publishes no query contract today** — `sales/contract/index.ts` exports only `events.ts`, and its own docblock states *"no command/query/type crosses the Sales boundary yet."*

Following the acceptance-closure precedent (§5.2.3 is about **table ownership**, not import syntax — a direct `tx.orderPayment.aggregate(...)` from Treasury would be exactly the defect just corrected for `tx.branch`), the design adds **the smallest possible Sales public contract**:

```ts
// src/modules/sales/contract/cash-session-tender-totals.query.ts
export const CASH_SESSION_TENDER_TOTALS_QUERY = Symbol('CASH_SESSION_TENDER_TOTALS_QUERY');

export interface CashSessionTenderTotals {
  readonly cashSessionId: string;
  /** tender='cash' Σ amount — FR-FIN-004 term 2. */
  readonly cashSalesTotal: bigint;
  /** tender='cash' Σ rounding_adjustment — FR-FIN-004 term 8 (signed). */
  readonly cashRoundingAdjustments: bigint;
  /** tender='manual_external_card' Σ amount — NOT a cash term; FR-FIN-010 input. */
  readonly manualExternalCardTotal: bigint;
  /** Payment row count, for the close snapshot's provenance. */
  readonly paymentCount: number;
}

export interface CashSessionTenderTotalsQuery {
  totalsForSession(
    tx: Prisma.TransactionClient,   // tx-FIRST — same transaction as the close
    tenantId: string,
    cashSessionId: string,
  ): Promise<CashSessionTenderTotals>;
}
```

**`tx`-first is load-bearing**, exactly as `CASH_MOVEMENT_TOTALS_QUERY`'s docblock already argues: the totals must be read inside the transaction that holds the `ros_cash_session` advisory lock, so no payment can commit between the read and the close. Private implementation in `sales/orders/`, bound in `SalesModule`, consumed by Treasury via `modules/sales/contract` only. `TreasuryModule` imports `SalesModule` (the module-class exemption). **No `KNOWN_DEVIATIONS` growth.** Non-cash totals are included because FR-FIN-010 needs them later and one contract is cheaper than two.

**Classification: DESIGN-DECIDABLE.**

---

## 4. THE PAYMENT / CLOSE RACE — PROVEN, AND THE REQUIRED CORRECTION (§8)

### 4.1 The race

`SalesPaymentService.capture` runs inside `UnitOfWork.execute` at **READ COMMITTED** (no `isolationLevel` is set anywhere in the repository) and:

* step 5 (`:183`) reads CashSession facts through `cashSessionFacts.find(tx, …)` — a plain, **unlocked** `SELECT`;
* step 5 (`:190`) rejects if `status !== 'open'`;
* step 9 (`:277`) inserts the Payment;
* it holds **no advisory lock** — grep proves `pg_advisory_xact_lock` appears nowhere in the file — and locks the Order only by **optimistic CAS on `version`**, which protects the Order, not the session.

**Interleaving that breaks correctness:**

| Time | T2 (Payment) | T1 (Close) |
|---|---|---|
| t0 | BEGIN | |
| t1 | reads session → `open` ✅ | |
| t2 | | BEGIN, acquires `ros_cash_session` lock |
| t3 | | reads payments → **T2's row not yet inserted** |
| t4 | | expected cash computed, session → `closed`, COMMIT |
| t5 | INSERT payment (FK still resolves — the row exists) | |
| t6 | COMMIT ✅ | |

**Outcome:** a cash payment attributed to a **closed** session, excluded from the close's expected cash. The drawer's counted cash was physically correct; the recorded expected cash is now permanently wrong, on an **immutable** record (FR-FIN-007). Tender totals (FR-FIN-010) also disagree with the close.

A `status` re-check at t5 does not help: T2's snapshot was taken at t1, and re-reading inside T2 would still require serialisation against T1 to be meaningful. **This cannot be fixed inside Treasury alone.**

### 4.2 The required correction — exact scope

**YES — accepted Payment code MUST be narrowly modified as part of P1G-1.**

**Scope: one statement, inserted in `SalesPaymentService.capture`, immediately after the transaction opens and BEFORE step 2 (the Order load):**

```ts
await tx.$executeRawUnsafe(
  'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
  'ros_cash_session',
  input.cashSessionId,
);
```

* **Byte-identical** to `cash-movements.service.ts:182-183` — the same key, the same primitive, the same transaction-scoped release.
* **No schema change, no migration, no behavioural change** on the happy path: it only serialises writers that were already logically exclusive.
* **Placed before the Order read** so the acquisition order is **CashSession → Order → Inventory**, matching the canonical order P1G-0's gate recorded and P1F-2 already follows. No inversion is introduced (§37).
* Everything else in `SalesPaymentService` is untouched.

**Why this is in-slice and not a prior blocker (verdict is not E):** it needs no migration, no ratification, and no schema change; it is 4 lines; and shipping it *separately* would leave a window in which P1G-1's close is knowably incorrect. §8's own instruction — *"Do NOT preserve accepted code at the expense of atomic correctness"* — is decisive.

**Classification: DESIGN-DECIDABLE (compelled by correctness).**

---

## 5. MOVEMENT / CLOSE CONCURRENCY AND LOCK ORDER (§9, §37)

`CashMovementsService.record` already acquires **exactly** `pg_advisory_xact_lock(hashtext('ros_cash_session'), hashtext(cashSessionId))` before validating openness and inserting. P1G-1's close acquires **the same lock** before reading any close-sensitive fact and before any mutation. Therefore:

* **pay-in / pay-out / safe-drop vs close** — fully serialised. Movement first → included in expected cash. Close first → the movement's subsequent locked read sees `closing`/`closed` and rejects.
* **payment vs close** — serialised once §4.2 lands.
* **close vs close** — serialised; §7 below defines replay semantics on top.

**Canonical lock order (unchanged, now universally observed):**

```
ros_cash_session (advisory)  →  Order (optimistic CAS on version)  →  Inventory (FIFO layer locks)  →  audit chain (advisory, per tenant)
```

Close acquires only the first (and the audit chain, last, exactly as every other writer does). It never takes Order or Inventory locks, so it cannot invert. **No deadlock cycle is reachable.**

**Hard rules:** PIN verification happens **outside** the transaction (§9 below); no network call occurs inside a transaction; no `SELECT … FOR UPDATE` on `cash_sessions` (still inoperable — a column-level UPDATE grant does not confer row-lock privilege); no sleeps anywhere.

---

## 6. THE CLOSE PROTOCOL (§11, §12, §13)

### 6.1 Why one-shot close (C-1) is rejected — the blind-count oracle

The attack in §11 is not merely "resubmit a corrected count". The fatal weakness of C-1 is subtler and decisive:

> To reject an above-tolerance close for missing reason/approval, the server must **first compute the variance** and then **tell the cashier that approval is required**. That response is an **oracle**: it discloses `|counted − expected| > tolerance` without committing anything. A cashier can binary-search the count and locate expected cash to within tolerance precision, then submit a "clean" count.

Any protocol that reveals *anything* variance-dependent before the count is durably immutable defeats FR-POS-095, whose rationale names concealment explicitly. **C-1 is rejected on security grounds, not ergonomics.**

### 6.2 Selected: **C-3 — durable close attempt, with a same-transaction fast path**

**`POST /cash-sessions/{id}/close`** — one request, one transaction:

1. acquire `ros_cash_session` advisory lock;
2. assert `status = 'open'`;
3. resolve the policy version **effective at `cash_session.opened_at`** (R-3(a)); fail closed if absent or currency-mismatched;
4. compute the six live terms + two structural zeros → `expectedCash`;
5. compute `countedCash` (server-authoritative, §8 below) and `variance = counted − expected` (signed, FR-FIN-005);
6. **persist the immutable `cash_session_close_attempt`** — count, denominations, all eight formula terms, policy snapshot, computed figures;
7. write `expected_cash`, `counted_cash`, `variance` onto `cash_sessions` (FR-FIN-005 *"recorded on the session"*);
8. evaluate `abs(variance) > tolerance` (R-2(a)):
   * **within tolerance** → set `status = 'closed'`, `closed_at`, `closed_by_*`; audit; **COMMIT**. → *one request, fully closed*;
   * **beyond tolerance, and the caller already supplied reason + a verified manager principal** → create + decide the ApprovalRequest, then close; audit; **COMMIT**. → *one request*;
   * **beyond tolerance, no approval supplied** → set `status = 'closing'`; audit; **COMMIT**. → *frozen, count immutable*;
9. **only now** does the response disclose `expectedCash` / `variance`.

**The disclosure at step 9 is safe because steps 6–8 are already committed.** The count can never be changed afterwards: the attempt row is append-only with `UNIQUE (tenant_id, cash_session_id)`, and the session is no longer `open`.

**`POST /cash-sessions/{id}/close/finalize`** — only for the frozen case:

* **outside** the transaction: `TERMINAL_PIN_VERIFIER.verifyTerminalPin(...)` (so failed-attempt counters and lockout survive any later rollback);
* **inside**: lock → assert `status = 'closing'` → re-read the immutable attempt → create the ApprovalRequest → decide it with the verified principal → write `variance_reason`, `approval_request_id`, `closed_by_*`, `closed_at`, `status = 'closed'` → audit → COMMIT.

### 6.3 Protocol comparison

| Criterion | C-1 one-shot | **C-3 (selected)** | C-2 always-two-phase |
|---|---|---|---|
| Blind integrity | ❌ **oracle leak** | ✅ count immutable before any disclosure | ✅ |
| Within-tolerance UX | ✅ 1 request | ✅ **1 request** | ❌ always 2 |
| Above-tolerance UX | ❌ unsafe | ✅ 2 requests (1 in open mode) | ✅ 2 |
| Manager unavailable | ❌ | ✅ frozen, resumable | ✅ |
| Crash between phases | n/a | ✅ attempt is committed; retry is a replay | ✅ |
| Activity during pending | n/a | ✅ frozen by `closing` (§7) | ✅ |
| Retry / idempotency | ✅ | ✅ (§10) | ✅ |
| Auditability | ✅ | ✅ | ⚠️ extra event for no gain |
| DB complexity | lowest | **one table + narrow grant** | same |
| Offline compatibility | ✅ | ✅ attempt is a device-shaped fact | ✅ |

C-3 is the **only** option that is both safe and one-request in the common case — which is precisely §12's instruction to prefer the easiest *safe* UX.

**Classification: DESIGN-DECIDABLE.**

---

## 7. THE FREEZE, AND ACTIVITY AFTER DECLARATION (§13, §14)

**Selected: state A — extend `CashSessionStatus` with `closing`.**

**Why this is the minimum:** both existing consumers already gate on **exactly** `'open'` —

* `sales-payment.service.ts:190` → `if (session.status !== 'open') throw InvalidCashSessionError`
* `cash-movements.service.ts` → `if (session.status !== 'open') throw ConflictException`

so adding the enum value **automatically freezes payments and all three movement types with no change to either check.** Cash payment, manual-card payment, pay-in, pay-out and safe-drop are all rejected while `closing`.

**Derived from invariants, not convenience:** once the physical count is declared, expected cash has been computed against a specific transaction set and *recorded immutably*. Any subsequent economic event would make the recorded expected cash false while the counted cash can no longer be re-measured. FR-FIN-005 requires variance to be *recorded*; a recorded variance that later becomes arithmetically wrong is a defect. Freezing is the only posture that preserves the invariant.

**DB enforcement** — the compare-and-set RLS UPDATE policy in §12 makes `closed → anything` unreachable at the database, and the enum makes `closing` unambiguous. Application checks are the friendly error; the policy is the guarantee.

**Implementation note (flagged, not hidden):** `ALTER TYPE … ADD VALUE` inside a transaction block is permitted from PostgreSQL 12 provided the new value is not *used* in the same transaction. This project runs **16.15**, and migration 34 only adds the value (it inserts no row using it), so it is expected to succeed under Prisma's transactional migration runner. **There is no existing `ALTER TYPE` precedent in this repository**, so the implementation slice must verify this against a scratch DB before relying on it. Fallback if it fails: create a new enum type and swap the column — mechanical, no design change.

**Recorded alternative (not selected):** add a `frozen` boolean to Treasury's existing `CashSessionFactsQuery` contract instead of an enum value. It avoids `ALTER TYPE` but requires editing both consumers' checks and makes "not open, not closed" implicit rather than explicit. The enum is the smaller and more honest model.

---

## 8. COUNT INPUT AND DENOMINATIONS (§17, §18)

**No authoritative denomination catalogue exists** — re-verified: the country pack carries `currency { code, exponent, symbol, symbolPosition, cashRounding }` and nothing else; `country-pack.model.ts` models only the currency and tax blocks. **No Egyptian (or any) denomination catalogue may be invented.**

**Accepted input — option D (either path, server always authoritative):**

```jsonc
{
  "countedTotalMinorUnits": "154300",          // optional
  "denominations": [                            // optional
    { "denominationMinorUnits": "20000", "quantity": 5 },
    { "denominationMinorUnits": "10000", "quantity": 4 }
  ]
}
```

* **At least one** of the two must be present (a close without a physical count violates FR-POS-094).
* If **both** are present they must be **equal**, else `400` — a client-side checksum, never a source of truth.
* If only `denominations` is present, the server computes the total (**FR-POS-097 literal**: *"the System computing the total from denomination counts"*).
* If only `countedTotalMinorUnits` is present, that is the count — FR-POS-097 requires denomination counting to be **supported**, not mandatory on every close.

**Validation:** `denominationMinorUnits` a **positive** integer string (`^[1-9]\d{0,17}$`); `quantity` a positive integer (`>= 1`); **duplicate `denominationMinorUnits` rejected** (`400`) — one line per denomination, so the sum is unambiguous; total stored as `BIGINT`; **all money as base-10 integer strings in JSON**, never JSON numbers (ADR-008 / the `openingFloat` precedent). **No catalogue validation** — arbitrary positive denominations are accepted, and that limitation is recorded rather than papered over with an invented catalogue.

**Classification: DESIGN-DECIDABLE.** Denomination-catalogue validation remains **NOT SOURCE-DECIDABLE** and is explicitly not implemented.

---

## 9. APPROVAL WIRING (§21, §22, §23, §24)

### 9.1 Fixed values

| Field | Value | Authority |
|---|---|---|
| `requestType` | `'cash.variance'` | **RATIFIED** design-decidable literal (2026-08-30 gate §15) |
| `entityType` | `'cash_session'` | **REPOSITORY FACT** — `AUDIT_ENTITY.CASH_SESSION` already exists |
| `entityId` | the CashSession id | design-decidable |
| `requiredPermission` | `'cash.variance.approve'` | **SOURCE-DECIDED** (FR-FIN-006 verbatim, §15.2) |
| `value` | opaque JSONB; money as **base-10 integer strings** | **RATIFIED** (item 7 + Clarification A) |
| `expiresAt` | `transaction_timestamp() + variance_approval_expiry_seconds` from the **pinned policy version** | **RATIFIED** R-4(a) |
| `excludedApproverUserId` | the session owner's **Identity User** id | **RATIFIED** (item 8 + Clarification B) |
| `requestedBy` | the acting cashier's User id, from `TenantContext` | contract signature |

**`cash.variance.approve` is NOT seeded at HEAD** (`treasury.permissions.ts` documents the deliberate omission). **P1G-1 seeds this existing SRS code** — it is the slice that finally gives it an executable consumer. **No permission is invented.**

**Fail closed on a NULL owner User.** `Employee.userId` is `String?`. If the session owner has no linked User, `excludedApproverUserId` would be NULL and the DB-enforced self-approval conjunct would go **inert** — silently disabling FR-SEC-016 [M], which requires the system to *block, not warn*. The close must therefore **refuse** rather than proceed. A PIN-opened session's owner necessarily has a linked User, so this is a guard, not a common path.

### 9.2 Synchronous PIN flow and the trust boundary (§22)

```
OUTSIDE the transaction:   TERMINAL_PIN_VERIFIER.verifyTerminalPin(...) → VerifiedTerminalPrincipal (branded)
INSIDE the transaction:    advisory lock → re-read the immutable attempt → create request → decide → close → audit
```

PIN verification **must not** run inside the business transaction: the contract's own docblock states the lockout counter *"persists independently of the caller's own transaction/rollback"*, and joining the caller's transaction would let a failed-PIN attempt be rolled back away. It is also a comparatively slow operation that must not be performed while holding the advisory lock (§37).

**Nothing economic can change between disclosure and finalisation** because the session is `closing`: payments and all movements are rejected, and the attempt row is append-only. This is what makes the two-request flow safe.

### 9.3 ApprovalRequest creation timing — **option B (at finalize)**

Created **only when the manager PIN is submitted**, not at declaration.

* **Expiry** is meaningful: `expiresAt` is measured from the moment a manager actually engages, not from a declaration that may sit for an hour. Under option A, a request created at declaration would routinely be **already expired** by the time a manager arrived — a self-inflicted failure.
* **No orphan pending approvals** accumulate for closes that are abandoned or resolved another way.
* **Retry with a different manager** is natural: each attempt is its own request (§9.4).
* One-decision-per-request (**RATIFIED item 5**) is respected: each request receives exactly one decision, in the same transaction that created it.

**FR-SEC-032's asynchronous half remains deferred** — no notification, no polling, no async workflow is designed here.

### 9.4 Rejection and expiry — **the one open ratification (R-6)**

If the manager **rejects**, or the request **expires** before a decision, the session is `closing`, the count is immutable, and the drawer is frozen. No source decides what happens next. Searched: the SRS is silent; the register's D-15 records *"Retry of the same logical decision — no service-level dedup ratified"* and nothing about recovery; the P1G-1 ratification's *"Not decided"* block does not cover it.

| Option | Assessment |
|---|---|
| **R-6(a) — retry with a NEW ApprovalRequest; the count stays immutable; `variance_reason` may be revised (RECOMMENDED)** | Drawer is never stranded — another `cash.variance.approve` holder can approve. **Blind integrity fully preserved**: the physical count can never be re-entered. The failed request and its decision remain in Governance, immutable and audited. |
| R-6(b) — return the session to `open`, void the attempt, require a fresh count | **Affirmatively unsafe.** It hands the cashier the oracle C-1 was rejected for: reject → learn expected → recount to match. Defeats FR-POS-095 [M]. |
| R-6(c) — supervisor override / escalation | Invents vocabulary and authority the SRS does not name; FR-SEC-034 escalation is `[S]` and **D-12 is BLOCKED**. |

Only (a) survives scrutiny, and the report recommends it strongly — but it **materially changes business behaviour** (whether a rejected cash close is retryable, and by whom), so per §47 it is surfaced rather than assumed.

**Consequence if unratified:** the state machine has a reachable state with undefined exit. **This is P1G-1-critical** and is why the verdict is **B**, not A.

**Not migration-critical:** every option (a)/(b)/(c) uses the same schema; only service logic differs.

---

## 10. AUTHORIZATION, ACTORS, IDEMPOTENCY (§25, §26, §31)

### 10.1 Permissions

| Route | Permission | Basis |
|---|---|---|
| `POST .../close` — owner closing **own** session | `cash.session.close` | §15.2 *"Close own shift"* |
| `POST .../close` — actor ≠ session owner | `cash.session.close_other` | §15.2 *"Close another user's shift"* |
| `POST .../close/finalize` | `cash.session.close` **or** `cash.session.close_other` (same rule as above); the **approver's** authority is `cash.variance.approve`, checked by the Approval Runtime at decision time against the verified principal | §15.2 + FR-FIN-006 |

Both close codes are seeded by P1G-1 (currently unseeded). **No permission is invented.**

**Honest scope statement (mandatory per §25):** authorization is enforced by the **current tenant-wide permission resolver**. A holder of `cash.session.close_other` anywhere in the tenant may close any branch's session. **Branch-scoped RBAC (FR-SEC-002/003/004) remains NOT IMPLEMENTED** (ADR 0008 D-02, deferred), and **this slice does not implement it and must not claim it.** Branch safety on the close path comes from the terminal binding and the FR-SEC-021 permitted-branch set, exactly as on the movement routes.

**POS session:** `@AllowPosSession()` — close is a cashier operation at the terminal (FR-SEC-021), unlike the back-office policy route.

### 10.2 Actor facts persisted (§26) — four distinct roles, never conflated

| Role | Stored as | Notes |
|---|---|---|
| **Session owner** | `cash_sessions.employee_id` (existing) | unchanged; feeds `excludedApproverUserId` via its linked User |
| **Close actor (employee)** | `closed_by_employee_id` | P1D-E: the accountable business actor |
| **Close actor (user)** | `closed_by_user_id` | the login that transmitted it (mirrors `performed_by`) |
| **Terminal** | `closed_at_terminal_id` | on the attempt row |
| **Approver** | **not** duplicated in Treasury — `approval_decisions.approver_id` in Governance | reachable via `approval_request_id` |
| **Requester** | `approval_requests.requested_by` | the cashier, not the approver |
| **Timestamp** | `closed_at` (server clock) | |

### 10.3 Idempotency (§31)

Both routes carry `@Idempotent()` and the mandatory `Idempotency-Key`, using the existing global interceptor — **no Treasury-specific store**.

| Case | Behaviour |
|---|---|
| same key + same body | replay of the stored response, `Idempotent-Replay: true` (FR-API-022) |
| same key + different body | `409` (FR-API-023) |
| **different key, session already has an attempt** | the `UNIQUE (tenant_id, cash_session_id)` attempt constraint is the permanent-aggregate identity: an **identical** count replays the stored close facts; a **differing** count is `409` — *the blind-integrity guarantee, enforced at the database, not by the interceptor* |
| different key, session already `closed` | `409` with a distinct code — never a silent second close |
| finalize replay | `status` is already `closed`; the compare-and-set policy makes a second finalisation a no-op → deterministic replay |

**No duplicate is possible** for: close attempt (unique constraint), ApprovalRequest (created once, inside the finalising transaction, which the advisory lock serialises), ApprovalDecision (`UNIQUE (tenant_id, approval_request_id)`, RATIFIED item 5), audit (emitted only on a genuine state change), or final close (compare-and-set).

---

## 11. BLIND / OPEN MODE AND LEAK AUDIT (§15, §34)

**Mode comes solely from the policy version effective at `cash_session.opened_at`** — no second configuration source, no generic settings API.

**`GET /cash-sessions/{id}/close-context`** — permission `cash.session.close` (or `_other`), POS session allowed:

| Field | Blind mode | Open mode |
|---|---|---|
| `countMode` | ✅ | ✅ |
| `currency`, `openingFloat` | ✅ | ✅ |
| `toleranceMinorUnits` | ✅ | ✅ |
| **`expectedCash`** | ❌ **omitted** | ✅ |
| **formula term breakdown** | ❌ **omitted** | ✅ |
| **`variance`** | ❌ (undefined pre-count) | ❌ |

Blind mode returns a response in which the expected-cash fields are **absent from the payload**, not null-valued and not merely hidden by the client. Open mode satisfies FR-POS-094's second half — a design that only ever discloses after submission would implement blind but **not** open.

**Leak audit (§34) — performed, with one honest residual.** No Treasury `GET` route exists today; the only routes are 4 Treasury `POST`s, 1 policy `POST`, and the Sales order routes. **No existing endpoint returns expected cash, opening float, or movement totals.** Blind mode is therefore not pre-defeated.

**Residual, recorded not glossed:** `GET /orders` and `GET /orders/{businessDay}/{id}` expose per-order `paidTotal`. A determined cashier could sum their own cash orders to approximate *cash sales* — but **not** expected cash, which also requires the opening float and the pay-in/pay-out/safe-drop totals, none of which any route exposes. This is a partial-information residual inherent in letting a cashier see their own orders; it is **not** a blind-count defeat, and closing it is not in P1G-1's scope. Recorded so a future reader does not mistake silence for absence.

---

## 12. DATA MODEL AND MIGRATION 34 (§19, §27, §28, §29, §30, §44)

**Migration 34 is required and is NOT created by this gate.**

### 12.1 Enum

```sql
ALTER TYPE "treasury"."CashSessionStatus" ADD VALUE 'closing';   -- verify on scratch (§7)
```

### 12.2 `treasury.cash_sessions` — added columns

FR-FIN-005 says variance is *"recorded on the session"*, so the three core figures live here (option **D** of §19: typed core columns **plus** an immutable breakdown):

```
expected_cash             BIGINT   NULL
counted_cash              BIGINT   NULL
variance                  BIGINT   NULL      -- signed: counted - expected
variance_reason           TEXT     NULL      -- FR-FIN-006, required above tolerance
approval_request_id       UUID     NULL      -- Governance reference, no FK (§30)
closed_by_user_id         UUID     NULL      -- FK identity.users(id) RESTRICT
closed_by_employee_id     UUID     NULL      -- composite FK (tenant_id, employee_id)
CONSTRAINT ck_cs_closed_facts CHECK (
  status <> 'closed' OR (expected_cash IS NOT NULL AND counted_cash IS NOT NULL
                         AND variance IS NOT NULL AND closed_at IS NOT NULL
                         AND closed_by_user_id IS NOT NULL)
)
CONSTRAINT ck_cs_variance_arith CHECK (variance IS NULL OR variance = counted_cash - expected_cash)
CONSTRAINT ck_cs_reason_nonblank CHECK (variance_reason IS NULL OR length(btrim(variance_reason)) > 0)
```

### 12.3 `treasury.cash_session_close_attempts` — the immutable declaration

Append-only; **exactly one per session**; carries the full historical proof (§39):

```
id UUID PK · tenant_id · branch_id · cash_session_id
-- policy snapshot (R-3(a)) --------------------------------------------
policy_version_id UUID · tolerance_minor_units BIGINT · tolerance_currency CHAR(3)
count_mode treasury."CashCountMode"
-- the eight FR-FIN-004 terms, each stored -----------------------------
opening_float · cash_sales_total · cash_tips_total · pay_in_total
cash_refunds_total · pay_out_total · safe_drop_total · cash_rounding_adjustments   (all BIGINT)
-- computed ------------------------------------------------------------
expected_cash BIGINT · counted_cash BIGINT · variance BIGINT · currency CHAR(3)
approval_required BOOLEAN
-- provenance ----------------------------------------------------------
declared_by_employee_id · declared_by_user_id · terminal_id · declared_at TIMESTAMPTZ(6)
created_at TIMESTAMPTZ(6) DEFAULT statement_timestamp()

UNIQUE (tenant_id, cash_session_id)          -- at most one count, ever
UNIQUE (tenant_id, id)
CHECK  (expected_cash = opening_float + cash_sales_total + cash_tips_total + pay_in_total
                      - cash_refunds_total - pay_out_total - safe_drop_total
                      + cash_rounding_adjustments)     -- the formula, DB-enforced
CHECK  (variance = counted_cash - expected_cash)
CHECK  (counted_cash >= 0 AND opening_float >= 0)
CHECK  (currency ~ '^[A-Z]{3}$' AND tolerance_currency = currency)
FK (tenant_id, cash_session_id) → treasury.cash_sessions(tenant_id, id) RESTRICT
FK (tenant_id, policy_version_id) → treasury.cash_close_policies(tenant_id, id) RESTRICT
```

**The formula CHECK is the point of option D**: the eight terms and `expected_cash` are stored together and the database itself refuses a row where they disagree. A seven-year-old close explains itself with **no join to current settings and no recomputation** (FR-FIN-007).

### 12.4 `treasury.cash_count_denominations` — child rows (FR-POS-097)

```
id UUID PK · tenant_id · close_attempt_id · denomination_minor_units BIGINT · quantity INTEGER
CHECK (denomination_minor_units > 0) · CHECK (quantity > 0)
UNIQUE (tenant_id, close_attempt_id, denomination_minor_units)   -- no duplicate denominations
FK (tenant_id, close_attempt_id) → cash_session_close_attempts(tenant_id, id) RESTRICT
```

Typed rows, not JSONB — per-row CHECKs and SQL aggregation are exactly what §29 asks for over a mutable blob.

### 12.5 Grants and immutability — the decisive change (§27)

Today `ros_app` holds `SELECT, INSERT` on `cash_sessions` and nothing else, so **closing is impossible**. Migration 34 grants the **narrowest** capability that permits close and forbids everything after it, reusing migration 32's ratified `approval_requests` pattern **verbatim**:

```sql
-- cash_sessions: column-level UPDATE only, on exactly the close columns
GRANT UPDATE ("status","closed_at","expected_cash","counted_cash","variance",
              "variance_reason","approval_request_id",
              "closed_by_user_id","closed_by_employee_id")
  ON "treasury"."cash_sessions" TO ros_app;
-- DELETE/TRUNCATE stay revoked; no other column is writable.

CREATE POLICY cash_sessions_update ON "treasury"."cash_sessions" FOR UPDATE
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('open','closing'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('closing','closed'));

-- attempts + denominations: append-only, the cash_movements pattern
GRANT SELECT, INSERT ON "treasury"."cash_session_close_attempts" TO ros_app;
GRANT SELECT, INSERT ON "treasury"."cash_count_denominations"    TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON both FROM ros_app;
```

**`USING (status IN ('open','closing'))` is the immutability guarantee**: once `status = 'closed'`, **no `UPDATE` can even see the row**, at the database, for the application role — regardless of what any service does. FR-FIN-007 clause 1 is enforced by **privilege + policy**, not by the absence of an edit method. `opening_float`, `employee_id`, `drawer_id`, `currency` and `opened_at` remain unwritable at every moment of the session's life.

All three tables: `ENABLE` + `FORCE` RLS, fail-closed `NULLIF` predicate, `tenant_id NOT NULL`, D-09 composite tenant-safe FKs. **No `BYPASSRLS`.**

**`approval_request_id` carries no FK** (§30): `governance.approval_requests` is another module's table; the accepted Approval design already stores such references as bare UUIDs (`audit_entries.approval_id`, `waste_records.approval_request_id`). A cross-schema FK would neither add tenant safety nor license a cross-module query — and **Treasury still must not query `approval_requests` directly**; it uses `ApprovalCommands` only.

---

## 13. AUDIT (§32)

| Event | When | Contents |
|---|---|---|
| `CASH_SESSION_CLOSED` | on the genuine close (either path) | session, branch, employee, expected/counted/variance **as decimal strings**, currency, count mode, policy version id, `approvalRequired`, `approverId` + `approvalId` where applicable |
| `CASH_VARIANCE_APPROVAL_REQUESTED` | only when a request is created | session, variance, tolerance, request id |

The Approval Runtime already emits `APPROVAL_REQUEST_CREATED` / `APPROVAL_DECISION_RECORDED`, so Treasury adds no third copy — **no audit spam**. The frozen declaration emits **no separate event**: `CASH_SESSION_CLOSED` carries the same facts and a `closing` session that never finalises is discoverable from the attempt row. `BigInt` is never placed raw into JSON metadata (the `CASH_MOVEMENT_RECORDED` precedent). `approverId`/`approvalId` use the existing `AuditEntry` fields. **Audit hash coverage is not extended; GAP-11 remains separate.**

---

## 14. API SURFACE (§33) — C-1 binding, no `/v1`

Current routing convention only; **no isolated `/v1` retrofit**, and the global `/v1` gap is **not** claimed fixed.

| Route | Perm | POS | Idem-Key | Notes |
|---|---|---|---|---|
| `GET /cash-sessions/{id}/close-context` | `cash.session.close` \| `_other` | ✅ | — | Blind: **omits** expected/terms. Open: includes them |
| `POST /cash-sessions/{id}/close` | `cash.session.close` \| `_other` | ✅ | **required** | Count + optional reason + optional managerPin. `201` closed, or `200` frozen + `approvalRequired: true` |
| `POST /cash-sessions/{id}/close/finalize` | `cash.session.close` \| `_other` | ✅ | **required** | reason + managerPin → approval + close |

Three operations → **OpenAPI 139 → 142**. No Governance HTTP surface (**D-14 A-1** unchanged). No X-report route, no new X-report permission.

---

## 15. §5.2.3 CARRIED DEFECT — `CashSessionsService.open` (§35)

The acceptance-closure report recorded a matching pre-existing defect: `CashSessionsService.open` queries `tx.branch.findUnique({select:{baseCurrency:true}})` directly (`cash-sessions.service.ts:125-128`) instead of Organisation's now-published `BRANCH_CURRENCY_QUERY`.

**Recommendation: INCLUDE the correction in the P1G-1 slice.** P1G-1 modifies `cash-sessions.service.ts` anyway (the close command lives there or beside it); `BranchCurrencyQuery` now exists and `TreasuryModule` will already import `OrganisationModule`; the change is **behaviour-identical and schema-free**; and leaving a known direct cross-module table query inside a file this slice is actively editing would repeat exactly the reasoning the acceptance closure rejected. The new `cash-close-policy.db-ownership.spec.ts` should have its scan widened to cover `treasury/cash-sessions/` once corrected.

**Classification: DESIGN-DECIDABLE. Does not block P1G-1** — if descoped, the defect simply persists and must be recorded again, unfixed.

---

## 16. OFFLINE (§42)

**No offline close is designed or claimed.** §21.3's local data model lists *"Shifts, cash sessions, drawer events"* as synced **Up/Continuous**, and FR-OFF-003 [M] guarantees 72 hours isolated *"without functional degradation of **sales capture**"* — it does not name shift close.

This design is **server-executed**: the count is submitted, expected cash is computed server-side inside the transaction, and disclosure occurs in the response. The count-declaration model is deliberately offline-*shaped* (an immutable, device-originated fact with a permanent id), so a future offline slice can sync it — but **synchronous manager approval cannot work offline** without FR-SEC-035's configurable offline-approval policy, which is unimplemented.

**Classification: DEFERRED BUT MVP-RELEVANT.** A terminal that loses connectivity cannot close its drawer. Recorded honestly; **no FR-OFF requirement is claimed complete, partial, or advanced.**

---

## 17. CONCURRENCY / TEST MATRIX (§45)

Real PostgreSQL; deterministic barriers (the `GatedAuditService` pattern already proven in `cash-movements.e2e-spec.ts`, plus `pg_stat_activity.wait_event_type='Lock'` polling); **no sleeps as correctness proof**; every genuine race run **≥3 clean times**.

1–3. close vs pay-in / pay-out / safe-drop → serialised; movement either included or rejected, never lost
4. **close vs CASH payment** → the §4.1 race; must fail before the §4.2 fix and pass after
5. close vs manual-card payment on the same session → same
6. two concurrent close declarations → exactly one attempt row
7. count-declaration replay (same key) → identical stored response
8. different key, identical count → replay; different key, **different count → 409** (blind integrity)
9. **blind count cannot be modified after disclosure** — the central control
10. open mode may read expected before declaration
11. **blind mode may NOT** — field absent from the payload
12. within tolerance → closes, no approval
13. `|variance| == tolerance` → **within**, closes (R-2(a))
14. positive variance > tolerance → approval required
15. **negative** variance magnitude > tolerance → approval required (the shortage case FR-SEC-015 names)
16. missing reason above tolerance → rejected
17. approver lacking `cash.variance.approve` → rejected
18. **owner self-approval rejected at the DB** (4th conjunct)
19. requester self-approval rejected (D-7 conjunct)
20. **NULL owner User mapping → fail closed**
21. no policy effective at `opened_at` → fail closed
22. **policy created after the session opened does not rescue it** (R-3(a) + C-2 anti-backdating)
23. policy currency ≠ session currency → fail closed
24. **manager PIN failure leaves lockout counters durable** after the business tx rolls back
25. approval expiry boundary (`expires_at < statement_timestamp()`)
26–27. rejection / expiry recovery — **shape depends on R-6**
28. finalisation replay → no second close
29. no duplicate ApprovalDecision (`UNIQUE (tenant_id, approval_request_id)`)
30. no duplicate close audit
31. `closing` **and** `closed` session rejects movements
32. `closing` **and** `closed` session rejects Payment
33. **closed session immutable at the DB** — direct `UPDATE` as `ros_app` fails
34. cross-tenant close blocked (composite FK + RLS)
35. missing tenant context → fail closed
36. denomination arithmetic exact
37. duplicate denomination → 400
38. **BigInt precision beyond `Number.MAX_SAFE_INTEGER`** round-trips exactly
39. **formula-component snapshot equals `expected_cash`** (also DB-CHECKed)
40. historical close remains explainable after a later policy version exists

---

## 18. REQUIREMENT CLASSIFICATION AFTER P1G-1 (§43)

| Requirement | After P1G-1 | Why |
|---|---|---|
| **FR-POS-090** | **COMPLETE** | unchanged; open already implemented |
| **FR-POS-094** | **COMPLETE** | physical count required; blind **and** open both implemented, per branch |
| **FR-POS-095** | **COMPLETE** | blind default resolved from policy and **enforced as a control**, not a display rule |
| **FR-POS-096** | **COMPLETE** | variance computed + recorded; reason + approval above tolerance (FR-FIN-006 is stricter and satisfies it) |
| **FR-POS-097** | **COMPLETE** | denomination counting supported, system-computed total. *Denomination-catalogue validation remains absent and is recorded as NOT SOURCE-DECIDABLE* |
| **FR-FIN-004** | **PARTIAL** | six terms live, **two structurally absent** (tips [S], refunds [M]-but-unimplemented). **Must not be claimed COMPLETE** |
| **FR-FIN-005** | **COMPLETE** | signed `counted − expected`, recorded on the session |
| **FR-FIN-006** | **COMPLETE** *(contingent on R-6)* | configurable tolerance, mandatory reason, `cash.variance.approve`, non-owner, DB-enforced |
| **FR-FIN-007** | **PARTIAL** | immutability clause **COMPLETE and DB-enforced**; **adjusting entries absent** (§41). Must not be claimed COMPLETE |
| **FR-FIN-010** | **PARTIAL** | per-session totals for the two tenders that exist; the other seven tender types are unimplemented |
| **FR-SEC-016** | **COMPLETE** | self-approval blocked at the database, plus fail-closed on NULL owner User |
| **FR-SEC-030** | **COMPLETE** | the general mechanism exists and now has its first real consumer |
| **FR-SEC-032** | **PARTIAL** | synchronous manager-PIN implemented; **asynchronous half remains deferred** |
| **FR-SEC-033** | **COMPLETE** | decisions immutable, append-only, DB-enforced |
| **FR-FIN-021/022** | **NOT IMPLEMENTED** | out of scope; the close data model supplies their inputs (§40) |
| **FR-PLT-025/026** | **NOT IMPLEMENTED** | unchanged by this slice |

---

## 19. SEQUENCING (§46)

**Recommended: ONE coherent slice.**

Migration 34 + the close state machine + both routes + the Sales tender-totals contract + the Payment advisory-lock correction + the `CashSessionsService.open` boundary fix + the full test matrix.

**Why not split into P1G-1A / P1G-1B:** the freeze (`closing`) and the approval finalisation are **two halves of one state machine**. Shipping A alone would create a state — a frozen drawer — with **no exit path**, i.e. a knowingly stranded drawer in production. That is precisely the *false atomicity* §46 warns against. The Payment lock correction likewise cannot be deferred: without it the close is knowably incorrect under concurrency. The slice is large but internally indivisible; every part is independently tested by the §17 matrix.

---

## 20. FINAL READINESS TABLE (§48)

| Item | Authority | Decision | Implementation consequence | Blocks P1G-1? |
|---|---|---|---|---|
| Close protocol | DESIGN-DECIDABLE | **C-3**: durable attempt + same-tx fast path | 2 write routes, 1 read route | **No** |
| Blind freeze point | SOURCE (FR-POS-094/095) | Disclosure **only after** the attempt is committed | attempt INSERT + `closing` precede the response | **No** |
| Open count | SOURCE (FR-POS-094) | `close-context` returns expected in open mode only | mode from the pinned policy | **No** |
| Denominations | SOURCE (FR-POS-097) | typed child rows, positive ints, no duplicates, **no catalogue** | 1 child table | **No** |
| Expected cash — 8 terms | SOURCE (FR-FIN-004) | 6 computed, 2 structurally zero | all 8 stored + DB-CHECKed | **No** |
| Tips | REPOSITORY FACT | **structurally unrecordable** → necessarily 0 | FR-FIN-004 **PARTIAL** | **No** |
| Refunds | REPOSITORY FACT | **structurally unreachable** → necessarily 0 | FR-FIN-004 **PARTIAL** | **No** |
| Policy time | **RATIFIED R-3(a)** | effective at `opened_at`, resolved lazily | resolver `asOf = opened_at` | **No** |
| Tolerance comparison | **RATIFIED R-2(a)** | `abs(variance) > tolerance`; equality within | pure function | **No** |
| Reason | SOURCE + repo precedent | non-blank free text on `cash_sessions`; copy into opaque `value` | Treasury is authoritative; Governance never parses | **No** |
| Approval flow | RATIFIED + §24.2.3 | PIN outside tx → create+decide inside | 2-phase, gate in Treasury | **No** |
| Approval request timing | DESIGN-DECIDABLE | **at finalize** (option B) | expiry meaningful; no orphans | **No** |
| **Approval rejection** | **NOT SOURCE-DECIDABLE** | **R-6 — recommend retry, count immutable** | defines a reachable state's exit | **YES** |
| **Approval expiry** | **NOT SOURCE-DECIDABLE** | **R-6 (same item)** | as above | **YES** |
| Self-approval | SOURCE (FR-SEC-016) + RATIFIED | DB 4th conjunct; **fail closed on NULL owner User** | no weakening | **No** |
| Close permission | SOURCE §15.2 | `cash.session.close`; seed it | tenant-wide resolver (stated) | **No** |
| Close-other | SOURCE §15.2 | `cash.session.close_other` when actor ≠ owner | seed it | **No** |
| **Payment advisory lock** | REPOSITORY FACT + correctness | **MUST modify accepted Payment** — 4 lines, in-slice | `sales-payment.service.ts` only | **No** (in-slice) |
| P1G-0 advisory lock | REPOSITORY FACT | reuse the identical key | no P1G-0 change | **No** |
| Lock order | DESIGN-DECIDABLE | CashSession → Order → Inventory → audit | no inversion | **No** |
| Session state | DESIGN-DECIDABLE | add **`closing`**; freezes both consumers unchanged | `ALTER TYPE` (verify on scratch) | **No** |
| Closed immutability | SOURCE (FR-FIN-007) | column-level UPDATE + compare-and-set policy | **grant change is mandatory** | **No** |
| Historical snapshot | SOURCE (FR-FIN-007) + §19 | typed core on session + full breakdown on attempt | DB-CHECKed formula | **No** |
| Migration 34 | DESIGN-DECIDABLE | enum + 2 tables + 9 columns + grants + RLS | planned, **not created** | **No** |
| API routes | **C-1 binding** | 3 ops, no `/v1` | OpenAPI 139 → 142 | **No** |
| Idempotency | SOURCE (FR-API-020…023) | global interceptor + unique attempt constraint | no new store | **No** |
| §5.2.3 `open` correction | DESIGN-DECIDABLE | **include in slice** | behaviour-identical | **No** |

---

## 21. USER RATIFICATION REQUIRED — ONE ITEM

> **R-6 — Variance-approval rejection / expiry recovery.** P1G-1-CRITICAL. Not migration-critical.
>
> When a frozen (`closing`) session's variance approval is **rejected**, or **expires** undecided:
>
> **(a) RECOMMENDED — Retry.** The session stays `closing`; the physical count stays **immutable**; a **new** ApprovalRequest may be created (possibly for a different manager); `variance_reason` may be revised. The rejected request and its decision remain immutable and audited in Governance. *Never strands the drawer; fully preserves blind-count integrity.*
>
> (b) Re-open. Session returns to `open`, the attempt is voided, a fresh count is required. **Affirmatively unsafe** — it restores exactly the disclose-then-recount oracle that FR-POS-095's rationale exists to prevent.
>
> (c) Supervisor override / escalation. Invents authority the SRS does not name; FR-SEC-034 is `[S]` and **D-12 is BLOCKED**.

**No other ratification is required.** Per §47, nothing else here is surfaced: naming, schema shape, route URLs, lock placement, denomination representation and approval timing are all safely design-decidable, and creating governance work for them would be waste.

---

## 22. FINAL VERDICT

# **B. P1G-1 IMPLEMENTATION READY AFTER NARROW USER RATIFICATION**

One item — **R-6** — remains. It is P1G-1-critical because it defines the exit from a reachable state, so **no Sonnet implementation prompt is issued** (§49). Everything else is settled, and on ratification the slice is immediately writable to the plan in §12, §14 and §17.

---

## Scope compliance

Design/analysis only. No product code, no migration (34 planned only, **not created**), no test change, no governance change, no `D-21+`, no commit, no push, no deployment. No destructive git command used (`reset`, `restore`, `checkout`, `clean`, `stash`, `rebase`, `amend` — none). HEAD `0f10afe` unchanged. The 4 unrelated uncommitted reports and their 4 `INDEX.md` rows are byte-identical; `INDEX.md` is appended to only.

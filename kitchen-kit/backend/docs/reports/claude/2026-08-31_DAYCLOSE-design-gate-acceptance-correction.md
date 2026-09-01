# DAY CLOSE — Design-Gate Acceptance Correction

| Field | Value |
|---|---|
| **Task / slice name** | DAY CLOSE — final design-gate acceptance correction (pre-ratification) |
| **Report type** | Design correction. **No implementation.** No migration, no schema change, no route, no permission, no governance edit, no commit, no push, no deploy. No agents/forks launched. |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report corrects `2026-08-31_DAYCLOSE-final-design-gate.md` **before** ratification. **The original gate is preserved byte-unmodified**; where the two differ, **this correction governs**. Everything the original gate settled that is not named below stands unchanged. |
| **Date** | 2026-08-31 |
| **HEAD** | `7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c` — *feat: add minimum operational reporting* |
| **Branch** | `feat/production-spec` |
| **Working tree** | Dirty **only** in `docs/reports/claude/`. **Zero** source / schema / migration / test / OpenAPI drift. |
| **Task identifier** | DAYCLOSE-design-gate-acceptance-correction |
| **Status** | COMPLETE |
| **Migrations** | 34 — unchanged. Migration 35 remains **conceptual only**. |
| **Tests** | **No test suite executed in this session.** Test files cited as structural evidence only. |

---

## §0. VERDICT

> # **A. DAYCLOSE DESIGN CORRECTION CLEAN — READY FOR USER RATIFICATION**
>
> **Correction A accepted in full — my SSI proof was invalid and is WITHDRAWN.**
> Replaced by a **strictly-past-business-day** close boundary, which is a
> *structural* invariant rather than an isolation-level argument.
> **DC-R2 now carries a recommendation** (close-business-day ownership).
> **DC-R3 now recommends extending `report.view.financial`**, not a new token.
> **DC-R1 wording is fixed verbatim.**
> **§24.6.4 aggregate-version question resolved explicitly (Option B, with
> four accepted precedents).**
>
> **Still exactly THREE user decisions. No fourth decision is created.**

---

## §1. BASELINE

```
git rev-parse HEAD        -> 7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c   MATCH
git branch --show-current -> feat/production-spec                        MATCH
```

`git status --short --untracked-files=all` returned **only** `docs/reports/claude/`
paths: modified `INDEX.md` plus six untracked reports (the four long-standing
unrelated ones, the POST-REPORTING rebase, and the DayClose gate). Migrations:
**34**. **Nothing outside `docs/reports/claude/`.**

`2026-08-31_DAYCLOSE-final-design-gate.md` was **read, not modified**.

**BASELINE UNCHANGED — not verdict E.**

---

## §2. CORRECTION A — THE SSI LATE-SESSION PROOF IS WITHDRAWN

### 2.1 What is withdrawn

> ### **WITHDRAWN — the original gate §14/§15 claim:**
> *"The blocker read is a range predicate on `(tenant, branch, status<>'closed')`;
> a concurrent `INSERT` of a session into that range is an SSI write-skew/phantom
> conflict → `40001` at commit."*
>
> **This is not a sufficient SSI proof, and the conclusion does not follow.**

### 2.2 Why it is wrong

PostgreSQL SSI aborts a transaction only on a **dangerous structure** — a pivot
transaction with **both** an inbound and an outbound rw-antidependency, forming a
potential cycle in the serialization graph. A predicate lock alone is **not** an
abort condition; it is only the bookkeeping that lets a conflict be *detected*.

In the late-session race the dependency graph is:

```
T1 (DayClose)  reads  cash_sessions WHERE branch AND status <> 'closed'
T2 (SessionOpen) writes a row into that predicate range

  ⇒  T1 --rw--> T2        (one antidependency, one direction)
```

T2 reads **nothing** that T1 writes: it never touches `day_closes`,
`day_close_sessions`, or any Z table. There is therefore **no inbound
antidependency on either transaction**, **no pivot**, and **no cycle**. The
schedule serializes cleanly as **T1 before T2** — *"the day closed, then a new
session opened"* — which is a **perfectly valid serial order**, and PostgreSQL
correctly commits **both**.

**The KDS precedent does not transfer.** KDS's Serializable proof rests on a real
cycle: two stations each *read* the other's ticket/line state **and** *write*
into what the other read (`test/kds-concurrency.e2e-spec.ts` `D0 [GUARD]`
documents the write-skew anomaly explicitly). DayClose-vs-SessionOpen has no such
mutual dependency. **Reusing that conclusion without the cycle was the error.**

### 2.3 The replacement — a structural close boundary

> ## **A manual DayClose may close ONLY a STRICTLY PAST business day.**
>
> ```
> targetBusinessDay  <  branchCurrentBusinessDay        → permitted
> targetBusinessDay ==  branchCurrentBusinessDay        → refused
> targetBusinessDay  >  branchCurrentBusinessDay        → refused
> ```
>
> `branchCurrentBusinessDay` is resolved by the **single existing** `FR-FIN-024`
> implementation (`resolveBusinessDay` + `cutoverLookup`,
> `sales/orders/business-day.ts`) — the same one Order creation and Reporting
> already share. **No second algorithm.**

**Why this is sound — four legs, all structural, none relying on an isolation level:**

1. **New orders cannot enter a past day.** `orders.business_day` is
   **server-derived from the server clock at order creation**
   (`orders.service.ts:224` — *"the day the sale is booked to is derived, never
   supplied"*). A new order is always stamped the **current** business day.
   A strictly-past target is therefore closed to new orders **by construction**.
2. **A session opened after the close is operationally the new day's.** It cannot
   produce orders in the past day (leg 1), and — under §4's ownership rule — its
   `closedBusinessDay` is necessarily ≥ the current day, so it cannot join the
   past day's variance set either. **A late session INSERT is harmless, so no
   mechanism needs to prevent it.**
3. **`openOrderCount == 0` closes the late-completion path** for orders that
   *already* belong to the target past day (§10).
4. **`FR-FIN-021` is still enforced in full** at the close instant — **all**
   currently `open`/`closing` branch sessions block, unqualified by day. The
   original gate's blocking set is unchanged.

### 2.4 No source requires early close of the CURRENT business day

Checked before adopting the rule, as instructed:

| Source | Finding |
|---|---|
| `FR-FIN-020` | *"support a business-day close operation per branch"* — **no timing constraint either way** |
| `FR-FIN-021` | a **precondition** on sessions; says nothing about *when* the day may be closed |
| `FR-FIN-023` | *"retrievable for any **historical** date"* — points **toward** past-day semantics |
| `FR-FIN-024` | defines the boundary that makes *"past day"* well-defined |
| `FR-FIN-025` **[S]** | automatic close **"at the configured boundary"** — i.e. **at the instant the day ends**, which is exactly when it becomes strictly past. **Consistent, not contradictory** |
| Glossary — *Z Report* | *"closes a shift or business day and **resets counters**"* — a terminal act |

> **No source evidence requires manual early-close of the current business day.
> No STOP condition.** *(Recorded so the check is auditable, not assumed.)*

### 2.5 HTTP semantics, from existing repository conventions

| Case | Status | Convention it follows |
|---|---|---|
| `targetBusinessDay > current` (future) | **400** | The accepted Reporting precedent verbatim — *"Future business days are not supported."* A day that does not yet exist is a malformed request |
| `targetBusinessDay == current` | **409** | Conflict with present resource state, and **transient by nature** — it becomes closeable once the day ends. **Not 400** (the request is well-formed); **not 422**, which `serialization-retry.ts` records as wrongly meaning *"the operation can never succeed"* |
| `targetBusinessDay < current` | permitted | — |

**No lock was added to preserve the previous design.**

---

## §3. RE-DERIVED CONCURRENCY PROOF

Each case is proved from the actual dependency structure. **SERIALIZABLE is
claimed only where a genuine cycle exists.** No advisory locks and no
`SELECT … FOR UPDATE` are introduced by DayClose. §24.6.4 respected.

### A — Two concurrent closes of the SAME branch/day

Both pass their preconditions on their own snapshots; both `INSERT` into
`day_closes` with the same `(tenant_id, branch_id, business_day)`.

**Mechanism: `UNIQUE (tenant_id, branch_id, business_day)`.** One commits; the
other raises a unique violation (`23505` / Prisma `P2002`).
**This is a genuine, terminal business conflict → 409 "business day already
closed"**, carrying the existing `zNumber`/`closedAt`. **It is NOT a
serialization failure and MUST NOT be retried** — `isSerializationFailure()`
correctly excludes `P2002` (*"a `PrismaClientKnownRequestError` with a DIFFERENT
code (P2002, P2003, …)"*). **Structural, isolation-independent.**

### B — Two closes of DIFFERENT past days at the same branch, competing for `zNumber`

> ### **This is the ONE case where SERIALIZABLE is genuinely load-bearing, and here a real cycle DOES exist.**

```
T1 reads MAX(z_number) WHERE (tenant, branch)      → predicate lock P
T2 reads MAX(z_number) WHERE (tenant, branch)      → predicate lock P
T1 writes z_number = N+1  ∈ P   ⇒  T2 --rw--> T1
T2 writes z_number = N+1  ∈ P   ⇒  T1 --rw--> T2
                                   ────────────────
                                   CYCLE  ⇒ dangerous structure ⇒ SSI aborts one (40001)
```

Each transaction reads the range the other writes — **mutual** rw-antidependency,
a true cycle, unlike §2.2. SSI aborts one; `UnitOfWork`'s bounded whole-UoW retry
re-executes on a fresh transaction with fresh reads (`unit-of-work.ts:205-207`),
recomputes `MAX+1`, and obtains `N+2`.

**Structural backstop: `UNIQUE (tenant_id, branch_id, z_number)`.**

> **Refinement this correction adds — the two unique constraints carry DIFFERENT
> meanings and MUST be handled differently:**
>
> | Violated constraint | Meaning | Handling |
> |---|---|---|
> | `(tenant, branch, business_day)` | the day is genuinely already closed | **terminal → 409.** Never retried |
> | `(tenant, branch, z_number)` | a transient allocation collision that SSI did not surface first (e.g. the winner committed before the loser reached its own commit-time check) | **retryable**, inside the same bounded budget, then 409 if exhausted |
>
> Collapsing both into one 409 would turn a retryable allocation collision into a
> spurious permanent failure. **This distinction is load-bearing.**

### C — Close vs. an existing past-day Order completion

**Closed by already-accepted mechanisms — not by SSI.** The chain:

1. A completion of an order of day `D` requires a **settling payment**.
2. `SalesPaymentService.capture` requires the order to be `open` or
   `partially_paid` (`assertMayCapturePayment`, `order-state.ts:226-234`) **and**
   the cash session to be **`open`** (`sales-payment.service.ts:207`).
3. Payment, cash movements, and CashSession close **all take the same
   transaction-scoped advisory lock** —
   `pg_advisory_xact_lock(hashtext('ros_cash_session'), hashtext(cashSessionId))`
   (`sales-payment.service.ts:180`, `cash-session-close.service.ts:226` and
   `:451`, `cash-movements.service.ts:183`; `LOCK_KEY = 'ros_cash_session'`).
   **These already exist; DayClose adds none.**
4. Therefore a payment transaction and its session's close transaction are
   **mutually exclusive**: either the payment commits first, or it blocks and
   then finds `status !== 'open'` and refuses. **No payment can commit after its
   session has closed.**
5. DayClose observes a session as `closed` only in a snapshot taken **after** that
   close committed — which is **after** every payment through it committed.
   ⇒ **DayClose's snapshot necessarily includes every payment of every session it
   sees as closed.**
6. `FR-FIN-021` guarantees **all** branch sessions are closed at the close
   instant, and precondition (4) guarantees **zero open orders** for the target
   day (§10).

**Result: no in-flight completion of a target-day order can exist. Proven from
the existing lock discipline plus the two preconditions — no new claim about SSI.**

### D — Close vs. new Order creation

**Structurally impossible to affect the target day.** `orders.business_day` is
server-clock-derived to the **current** day; the target is **strictly past**
(§2.3 leg 1). A concurrently created order lands in a different partition and a
different day entirely. **No isolation level is invoked.**

### E — Close vs. CashSession opening

> ### **The previously-claimed abort DOES NOT OCCUR — and does not need to.**

Both transactions may commit (§2.2). Two outcomes, **both correct**:

- The closer's snapshot **includes** the new session ⇒ `FR-FIN-021` blocks ⇒
  **409 + blocking list**. Correct.
- The closer's snapshot **precedes** it ⇒ the close commits, and the new session
  belongs to the current (later) day: it cannot produce orders in the past day
  (case D) and its `closedBusinessDay` will be ≥ the current day (§4), so it
  **cannot enter the sealed day's variance set**.

**The late session INSERT is harmless under the strictly-past-day rule. Nothing
needs to prevent it, and nothing does.**

### F — Close vs. CashSession finalisation (`closing` → `closed`)

- Snapshot sees `closing` ⇒ **blocks** (`FR-FIN-021`; `closing` is not `closed`).
- Snapshot sees `closed` ⇒ the session carries its immutable `closedBusinessDay`
  (§4). It joins the target day's variance set **iff** that value equals the
  target day — a deterministic comparison, not a race.
- **A session cannot acquire `closedBusinessDay = D` after `DayClose(D)` commits.**
  Proof: `DayClose(D)` runs at a wall-clock instant `T` in business day ≥ `D+1`
  (strictly-past rule). Acquiring `closedBusinessDay = D` requires closing at an
  instant inside `D`, i.e. **before `T`**. ∎

### Summary of mechanisms

| Case | Mechanism | Isolation-dependent? |
|---|---|---|
| A same-day duplicate | `UNIQUE (tenant, branch, business_day)` → terminal 409 | **No** |
| B `zNumber` allocation | **SERIALIZABLE + bounded retry (real cycle)** + `UNIQUE (tenant, branch, z_number)` (retryable) | **Yes — the one genuine case** |
| C past-day completion | existing `ros_cash_session` advisory locks + `FR-FIN-021` + zero-open-orders | **No** |
| D new order | strictly-past-day invariant | **No** |
| E session open | strictly-past-day invariant (race is harmless) | **No** |
| F session finalisation | `FR-FIN-021` + immutable `closedBusinessDay` | **No** |

> **Honest statement of SERIALIZABLE's role:** it protects **Z-number allocation**
> and gives the multi-statement Z-content read set one coherent snapshot with
> retryable conflict detection. **It is NOT the mechanism that prevents a late
> session or a late order** — the strictly-past-day invariant and the existing
> lock discipline are. **Selected: `UnitOfWork.execute(..., { isolationLevel:
> Serializable, maxAttempts: 3 })`**, matching the accepted KDS write precedent.

---

## §4. CORRECTION B — DC-R2 NOW HAS A RECOMMENDATION

> ## **RECOMMENDED: CLOSE-BUSINESS-DAY OWNERSHIP.** *(Accepted from external review; adopted here with its design consequences worked out.)*

### 4.1 Semantics

> A CashSession's **WHOLE-SESSION close facts — above all its variance — belong
> exactly once to the business day in which that CashSession itself became
> `CLOSED`.**

### 4.2 Design consequences for the future implementation

1. **Derive `closedBusinessDay` at CashSession final-close time**, using the
   **same authoritative resolver** Sales uses (`resolveBusinessDay` +
   `cutoverLookup`). Treasury already consumes Sales' public contracts with
   **zero** `KNOWN_DEVIATIONS` (`cash-session-close.service.ts:65-66`), so the
   edge is precedented.
2. **Persist it immutably alongside the final close facts.** Natural home:
   `treasury.cash_sessions`, written in the **same single UPDATE** that already
   writes `expectedCash` / `countedCash` / `variance` **exactly once at the
   `CLOSED` transition**, and joining the existing
   `ck_cs_core_facts_only_when_closed` CHECK.
3. **Never re-derive it historically** from the mutable `org.branches.timezone`
   (updatable via `PATCH /branches/{id}`, `branches.service.ts:149-150`) or the
   effectively-mutable `org.operating_hours.business_day_cutover`.
4. **NULLABLE, for legacy tolerance.** The P1G-1 migration-compatibility closure
   recorded **real pre-existing `closed` rows** in the dev database; a `NOT NULL`
   column would abort the migration. A `closed` row with
   `closedBusinessDay IS NULL` is a **pre-DayClose legacy close, owned by no
   DayClose** — the exact legacy-tolerant relational discriminator P1G-1 already
   used for `close_attempt_id`. **Honest, no backfill, no invented value.**

> **Note — this is NOT the previously-rejected column.** The gate rejected
> `cash_sessions.business_day` meaning *"the day this session's trading belongs
> to"*, which is lossy for spanning sessions. `closedBusinessDay` means *"the
> business day in which this session became closed"* — a fact about a **single
> instant**, well-defined, non-lossy, and making **no** claim about trading
> attribution. The rejection stands for the former; it never applied to the latter.

### 4.3 The worked example

Payments touch **D** and **D+1**; the session **closes in D+1**:

| | Linked? | Day-scoped tender contribution | Whole-session variance |
|---|---|---|---|
| **DayClose D** | **YES** | **D's** tender contribution included | **NOT owned by D** |
| **DayClose D+1** | **YES** | **D+1's** tender contribution included | **OWNED HERE** |

> **The same session therefore MAY appear in two DayClose linkage children.**
> **Unconditional `UNIQUE (tenant_id, cash_session_id)` on the linkage table
> remains FORBIDDEN.**

### 4.4 Is a partial owner `UNIQUE` still needed? — **NO, as the mechanism**

**Ownership is already functionally determined**, with no flag and no constraint:

```
ownedBy(session) = the DayClose of (session.branchId, session.closedBusinessDay)
```

Each closed session has **exactly one** immutable `closedBusinessDay`, and
`UNIQUE (tenant_id, branch_id, business_day)` guarantees **at most one** DayClose
per branch-day. **Uniqueness of ownership is therefore a theorem, not a
constraint.** This is a genuine simplification over the original gate's
partial-unique proposal.

**Recommendation:** if the linkage snapshot **materialises** the flag — and it
should, so a sealed Z explains itself without joining live `cash_sessions`, the
`cash_session_close_attempts` self-explanation precedent — then add the **partial**
`UNIQUE (tenant_id, cash_session_id) WHERE <owner flag>` as **defence in depth
only**. It is provably non-restrictive under this ownership rule (at most one
owner genuinely exists), it costs nothing, and it turns a materialisation bug
into a write failure instead of a silently double-counted variance. **It is
explicitly NOT the ownership mechanism.** *(Precedent for the partial form:
`cash_sessions`' one-open-session-per-drawer partial unique index.)*

### 4.5 Zero-payment and movement-only sessions under this model

| Session kind | Tender contribution | Variance ownership |
|---|---|---|
| **Zero-payment** (opened, no sale, closed) | **none, to any day** — it appears in no day's tender totals | **Owned by the day it closed in.** Its variance can be genuinely non-zero (a miscounted opening float), and it is counted **exactly once** |
| **Movement-only** (pay-in / pay-out / safe-drop, no sale) | **none** | **Owned by the day it closed in.** Its movements feed `FR-FIN-004`'s expected-cash formula and therefore its variance — counted **exactly once** |
| **Spanning** | **split** across days by `order_payments.business_day` (genuinely day-attributable) | **Owned by the closing day only** |
| **Legacy closed** (`closedBusinessDay IS NULL`) | none | **Owned by no DayClose** — recorded honestly, never silently attributed |

> ### **This is the first model in which zero-payment and movement-only sessions
> become attributable at all.** Accepted Reporting cannot see them
> (payment-derived set; RPT-R2 clause 9). DayClose reaches them because Treasury
> queries its own `cash_sessions` directly (`FR-FIN-021`'s global set), and
> `closedBusinessDay` tells it which day owns them. **A strict improvement,
> achieved with no trading-attribution guesswork.**

### 4.6 Why not the alternatives

Restated with the recommendation now made: **B** (payments touched the day)
double-counts a spanning session's whole-session variance into two days — the
exact defect the Reporting acceptance correction removed. **C** (first opened in
the day) misattributes a session that earned most of its money after the
boundary. **A** (closed *during* the day, derived historically) is
close-business-day ownership **done unsafely**, by re-deriving from mutable
config; persisting `closedBusinessDay` at close time is the same semantics done
**safely**. **E** (whole-branch delta since the previous DayClose) is sound but
leaves the first DayClose's window unbounded and needs a separate rule for
sessions predating any DayClose — close-business-day ownership handles those
uniformly via `NULL`.

**DC-R2 is no longer recommendationless.**

---

## §5. CORRECTION C — DC-R3 RECOMMENDS EXTENDING `report.view.financial`

### 5.1 Recommendation

> ## **Ratify a NARROW SCOPE EXTENSION of the existing `report.view.financial`:**
>
> ```
> POST /branches/{branchId}/day-closes/{businessDay}   →  cash.day.close        (source-decided, unchanged)
> GET  /branches/{branchId}/day-closes/{businessDay}   →  report.view.financial (subject to DC-R3)
> ```

### 5.2 Why this is the right shape

- The historical DayClose/Z **is a Financial report** — SRS §19.3 lists **“Z
  Report — Statutory day close”** under **Financial Reports**, the same §19.3
  category from which RPT-R1 drew `report.view.financial`.
- `report.view.financial` **already instantiates** §15.2's own
  `report.view.<category>` template. **No new invention is required**, so the
  zero-invented-codes discipline is not weakened.
- **RPT-R1 clause 6's NOT-authorized list is not breached.** It forbids
  `report.export`, `report.view.daily_trading`, `report.view.inventory`,
  `report.view.kitchen`, `report.view.workforce`, `report.view.governance` and
  *"any other `report.view.*` code"*. This extension **creates no code at all** —
  it widens the route set of a code that already exists.
- **What it DOES touch, and this is stated plainly:** RPT-R1 gated the two codes
  on *"the single composite daily-trading route"*, and `reporting.permissions.ts`
  records *"MUST NOT be broadened, split, or accompanied by…"*. **DC-R3 is
  therefore an explicit, narrow, user-ratified widening of exactly one code to
  exactly one additional read route** — surfaced, not smuggled.

### 5.3 What is refused

| Candidate | Status |
|---|---|
| **`cash.day.close`** | ❌ **REFUSED.** §15.2 quotes it as *"Close the business day"* — a **WRITE** authority. **A write permission is not automatically a read-history permission**, and `treasury.controller.ts` has already refused this exact reinterpretation for `cash.session.open`: *"It is not a generic CashSession read permission, and reinterpreting it as one would hand every session-opening cashier a read capability no source grants."* |
| **`cash.day.read` / `cash.z.read` / `report.view.z` / `report.view.day_close`** | ❌ **NOT CREATED.** No authority proves the existing financial-report code cannot be extended coherently — and §5.2 shows it can. `report.view.day_close` would additionally fail RPT-R1 clause 6's own test (*"`daily_trading` is **not** a §19.3 category"*); `day_close` is not one either. **Z Report is** |
| **Deferring the route** | ❌ **NOT RECOMMENDED.** It would leave `FR-FIN-023` [M]'s retrievability limb unmet when a coherent, already-ratified code exists |

### 5.4 Recorded

- **POST DayClose → `cash.day.close`** (source-decided; unchanged).
- **GET historical DayClose/Z → `report.view.financial`, subject to DC-R3
  ratification.**
- The `GET` remains **dashboard-only**, `Cache-Control: no-store`, **no audit
  entry** (RPT-R2 clause 12), and **no `report.view.sales`** — the Z is a
  Financial report, and requiring the Sales code too would broaden a second code
  without cause.

---

## §6. CORRECTION D — EXACT DC-R1 RATIFICATION WORDING

> ### **DC-R1 — INTERNAL-MVP DAYCLOSE SEQUENCING** *(recommended: **YES**)*
>
> **RATIFIED — binding:**
>
> 1. **The Internal-MVP operational DayClose is AUTHORISED to be implemented
>    now**, as an additive Treasury aggregate: a **strictly-past-business-day**,
>    per-branch, immutable, sequentially-numbered close with its Z snapshot and
>    historical retrieval.
> 2. **`FR-FIN-020`** — implemented. **`FR-FIN-021`** — implemented **in full**,
>    both limbs (block + list the blocking sessions), over **all** branch cash
>    sessions with `status <> 'closed'`. **`FR-FIN-023`** — sequential per-branch
>    numbering, DB-enforced immutability, and historical retrieval (retrieval
>    subject to **DC-R3**). **`FR-FIN-024`** — already **COMPLETE**; reused, not
>    reimplemented.
> 3. **Simultaneously, and without qualification — `FR-FIN-022` [M] remains
>    PARTIAL.** The following limbs are **NOT IMPLEMENTED**:
>
>    | Limb | Why |
>    |---|---|
>    | **tax by rate** | `FR-FIN-032` permits multiple tax components; only the component **sum** is persisted (`order_lines.tax_amount`). Per-component rate/base exists nowhere. Deriving a legal rate from rounded money is forbidden |
>    | **sales by category** | `sales.order_lines` carries **no category snapshot**; `MenuItem` deliberately has no `category_id`; placement is the **many-to-many** `catalogue.menu_item_placements`. Aggregating would join a sealed immutable Z to **mutable** master data and be ambiguous for a multi-placed item |
>    | **comp** half of *void and comp summary* | **structurally zero** — no code path writes `state:'comped'` |
>    | **sales by tender** | **PARTIAL** — two tenders only; *each card scheme* and nine tender families remain UNSATISFIED (RPT-R2 clause 8) |
>
>    *(The **void** half **is** implemented — pre-fire voids are written with
>    `voided_by` and a reason CHECK. Gross sales, discounts, refunds, net sales,
>    transaction count, average order value, cash reconciliation and the variance
>    summary are implemented.)*
> 4. **`FR-FIN-026` [M] remains PARTIAL — all four limbs unmet:**
>    - **fiscal document finalisation — NOT IMPLEMENTED.** **No
>      fiscal-finalisation capability is implemented**, and **no fiscal documents
>      currently exist to finalise** (no fiscal model among 88; none of the 34
>      migrations creates one). **CARRIED ITEM P1C-1 remains untouched and is not
>      reopened.** *(§7 below fixes the permitted wording.)*
>    - **inventory day-end snapshot — NOT IMPLEMENTED.** No dated snapshot table
>      exists; `stock_levels` is a live projection with no date dimension.
>    - **report pre-aggregation — NOT IMPLEMENTED, and remains excluded by
>      RPT-R2** (clause 2 records `FR-RPT-002`/`003` NOT IMPLEMENTED; clause 5
>      forbids rollup persistence, `fact_*`/`dim_*` tables and any analytics
>      warehouse). **DayClose must not implement it.**
>    - **accounting export generation — NOT IMPLEMENTED.** `FR-RPT-043` remains
>      NOT IMPLEMENTED (RPT-R2 clause 7) and the **required external-delivery
>      substrate remains absent**: no transactional outbox exists, while SRS
>      §5.5.3 makes it **mandatory (`FR-PLT-041`)** for exactly this class of
>      effect.
> 5. **`FR-FIN-025` [S] remains NOT IMPLEMENTED.** No scheduler, no per-branch
>    enablement flag, no force-close-and-flag semantics. **No scheduler or job
>    runner is built.**
> 6. **This is NOT a waiver, NOT a reinterpretation, and NOT a claim of
>    completion.** Every limb in clauses 3–5 remains an **open, unmet
>    requirement** counted against its domain, exactly as RPT-R2 clause 3
>    recorded `FR-RPT-001/002/003/005` and as `FR-SEC-032` is recorded under D-2.
> 7. **No artefact may claim otherwise.** No report, register entry, INDEX row,
>    code comment, OpenAPI description or commit message produced by this slice
>    may state or imply **"`FR-FIN-022` waived"**, **"satisfied with a subset"**,
>    **"Z fully compliant"**, or **"DayClose `FR-FIN-020…026` COMPLETE"**.
> 8. **The DayClose state-changing aggregate is distinct from full Z-content
>    compliance.** What ships is a **complete, correct `FR-FIN-020`/`021`/`023`
>    close aggregate** carrying an **Internal-MVP Z snapshot whose content
>    obligation (`FR-FIN-022`) is PARTIAL**. Both facts are stated together,
>    always.
> 9. **Nothing is reopened:** **CARRIED ITEM P1C-1**, **D-2**, **D-20**,
>    **RPT-R1**, **RPT-R2** and **RPT-R3** are unchanged.

---

## §7. `FR-FIN-026` — PERMITTED WORDING

> ❌ **FORBIDDEN:** *"fiscal finalisation is satisfied because there are no
> fiscal documents to finalise"* · *"vacuously satisfied"* · *"complete by
> absence"*.
>
> ✅ **PERMITTED, and the required form:**
> *"No fiscal documents currently exist to finalise; **no fiscal-finalisation
> capability is implemented**; **CARRIED ITEM P1C-1 remains untouched**;
> therefore this `FR-FIN-026` limb is **NOT IMPLEMENTED / unavailable** in the
> Internal-MVP slice."*

**This corrects the original gate's "vacuous, not blocking" framing.** The
operative facts are unchanged — **Receipt is still not a dependency, and that
remains proven** (`FR-FIN-022` enumerates no fiscal field; `FR-FIN-023`'s
per-branch Z number is unrelated to §22.2's invoice `pre_allocated_block`) — but
**"not blocking" must never be written as "satisfied."** The absence of an empty
set to iterate is not compliance.

**The other three limbs keep the same honest status**, each stated as
NOT IMPLEMENTED with its own reason (§6 clause 4), never as satisfied-by-absence.

---

## §8. AGGREGATE VERSION AND §24.6.4 — RESOLVED EXPLICITLY

§24.6.4 verbatim: *"Aggregates carry a version. **Updates** assert the expected
version and fail on mismatch, forcing the caller to reload."*

> ## **RESOLVED: OPTION B — no `version` column. Argued, not ignored.**

**1. The rule's operative clause is about `UPDATE`s.** Its second sentence
defines what the version is *for*: asserting an expected version on an update.
DayClose is **insert-once with no UPDATE surface** — `ros_app` holds `SELECT` +
a column-level `INSERT` and **no `UPDATE` grant at all** (§9). There is no
operation that could assert a version and no caller that could reload and retry.
A column fixed at `1` forever is **not an optimistic-concurrency mechanism**; it
is a decoration that would imply a lifecycle the aggregate does not have.

**2. The repository's own precedent is unambiguous and consistent.** Verified
this session: **exactly three** models carry a `version` column — **`Order`
(:1858), `Ticket` (:985), `RecipeVersion` (:3260)** — and all three are
**mutable** aggregates with real expected-version update paths (`assertVersion`,
`order-state.ts:242`). **Every immutable, append-only table omits it**:
`cash_close_policies`, `cash_session_close_attempts`, `cash_count_denominations`,
`cash_movements`, `approval_decisions`, `audit_entries`. **DayClose is
unambiguously in the second class.**

**3. Concurrency is fully covered without it** (§3): `UNIQUE (tenant, branch,
business_day)`, `UNIQUE (tenant, branch, z_number)`, the strictly-past-day
invariant, and SERIALIZABLE + bounded retry for allocation.

**Option A (persist immutable `version = 1`) is acceptable but inferior** — it
satisfies the sentence literally while contradicting its purpose and departing
from six accepted precedents. **This is the simplest shape that preserves the
stated aggregate architecture without inventing a mutable lifecycle**, and it is
**recorded as an engineering resolution, not a user decision.**

---

## §9. CORRECTED Z SESSION / VARIANCE PERSISTENCE MODEL

Four concerns kept **strictly separate** so double counting is structurally hard:

| | Concern | Where it lives | Scope label |
|---|---|---|---|
| **A** | **Day-scoped tender contribution** | linkage row | genuinely day-attributable, from the immutable `order_payments.business_day` |
| **B** | **Session linkage** | linkage row exists | one row per session **per DayClose** |
| **C** | **Whole-session close facts** (`openingFloat`, `expectedCash`, `countedCash`, `variance`, pay-in/pay-out/safe-drop totals) | linkage row, **explicitly labelled `WHOLE_SESSION`** | **never a day total** |
| **D** | **Variance ownership** | derived from `cash_sessions.closedBusinessDay`; optionally materialised as a flag | **exactly one** DayClose per session |

### Conceptual uniqueness constraints

```
day_closes
  UNIQUE (tenant_id, branch_id, business_day)         -- one close per branch-day
  UNIQUE (tenant_id, branch_id, z_number)             -- FR-FIN-023 backstop

day_close_sessions                                    -- the linkage/snapshot child
  UNIQUE (tenant_id, day_close_id, cash_session_id)   -- one row per session PER DayClose
  ✗ NO unconditional UNIQUE (tenant_id, cash_session_id)          -- FORBIDDEN (§4.3)
  ~ partial UNIQUE (tenant_id, cash_session_id) WHERE <owner>     -- defence in depth only (§4.4)

cash_sessions
  + closed_business_day DATE NULL                     -- written exactly once at the CLOSED
                                                      -- transition; legacy closed rows NULL
```

### Anti-double-counting rules — binding on implementation

1. **`openingFloat`, `expectedCash`, `countedCash`, `variance` and movement
   totals are NEVER emitted as day totals** and are never summed across linkage
   rows to produce one. They are stored as **historical WHOLE_SESSION snapshots**
   and must be **labelled as such on the wire**, exactly as the accepted
   Reporting contract labels `scope: 'WHOLE_SESSION'`.
2. **Only the designated owner contributes to the Z variance summary.**
   `varianceSummary = Σ variance over linkage rows WHERE owner`, and ownership is
   `session.closedBusinessDay == dayClose.businessDay`.
3. **Day-scoped tender figures are the only per-session figures that may be
   summed into a day total**, because `order_payments.business_day` is immutable
   and genuinely day-attributable.
4. Each linkage row also carries `businessDayCount` / `spansMultipleBusinessDays`,
   so a sealed Z **visibly declares** which of its sessions were not exclusive to
   it — the accepted Reporting precedent.

---

## §10. CLOSEABLE ORDER SET — AUDITED FROM CURRENT SOURCE

### Blocking states

```
draft · open · held · parked · partially_paid
```

Taken verbatim from the accepted `OPEN_ORDER_STATES`
(`daily-trading-sales.query.service.ts:14-19`), already surfaced as
`openOrderCount`. **Not invented for this slice.**

### Audit — can any other reachable state still change the target day's Z?

| State | Reachable? | Can it change the day's Z afterwards? |
|---|---|---|
| `completed` | yes | **NO.** `TRANSITIONS` gives `completed: []` (`order-state.ts:87`). `assertMayCapturePayment` admits **only** `open` and `partially_paid` (`:226-234`), so no further payment; `assertOrderMutable` refuses every finalised state, so no line addition and no void. **BR-POS-001 immutability** |
| `cancelled` | yes | **NO.** `cancelled: []`; finalised |
| `partially_refunded` | **NO** | `partially_refunded: []` — **no inbound transition anywhere**. Structurally unreachable |
| `refunded` | **NO** | `refunded: []` — same |

> ### **The five states are EXHAUSTIVE. `cancelled` and `completed` are NOT
> treated as blockers**, because neither can alter the day's figures again.

### Status of the precondition

**An engineering safety invariant**, required to make the immutable Z **stable**
— not an SRS requirement, and **not presented as one**. `FR-FIN-021` names only
cash sessions; this precondition is **additional and strictly more restrictive**,
derived from `FR-FIN-023`'s `[M]` immutability obligation. It is recorded as an
**implementation consequence** (the RPT-R2 branch-fail-closed precedent), **not**
as a fourth user decision.

**Blocking orders MAY be listed in the 409 body** — operationally useful, and
symmetrical with `FR-FIN-021`'s mandated blocking-session list. **No SRS
requirement is invented for it**; it is offered as an ergonomics choice.

> **Disclosed operational consequence:** a single forgotten `parked` order blocks
> the day close until it is completed or cancelled. The alternative — omitting the
> precondition — permits a sealed Z to later become false, which `FR-FIN-023`
> immutability makes unrecoverable.

---

## §11. Z NUMBER — RE-CONFIRMED

| Property | Confirmation |
|---|---|
| **Sequential per branch** | `FR-FIN-023` [M]. Scope `(tenant_id, branch_id)`; starts at **1** |
| **No fiscal invoice semantics imported** | §22.2's `pre_allocated_block` / `blockSize` / `voidUnusedOnExpiry` govern **invoice** sequences. **Source draws no link**, and none is invented. Likewise `FR-OFF-016`/`OrderNumberBlock` block allocation is **not** used — it exists for offline order numbering, and day close is never offline |
| **No reset** | Source says nothing about resetting; a reset would make a historical number ambiguous and break *"retrievable for any historical date"*. **No yearly or any other reset** |
| **Concurrent different-day allocation cannot duplicate** | §3 case B — a **real rw-cycle** ⇒ SSI abort ⇒ bounded retry recomputes; `UNIQUE (tenant, branch, z_number)` is the structural backstop, and its violation is treated as **retryable**, distinct from the terminal day-uniqueness violation |
| **A failed transaction persists no number** | `MAX+1` is **derived inside the transaction**, never pre-allocated. A rollback leaves no trace. *(This is also why no `SEQUENCE` object is used — sequences are non-transactional and would guarantee gaps; the repository additionally contains **zero** sequence objects and **zero** triggers)* |
| **`MAX+1` acceptability** | Acceptable **because §3 case B's proof is sound**: the mutual rw-antidependency is genuine, unlike the withdrawn §2.2 claim |
| **Gaplessness** | **NOT claimed as a requirement.** The SRS says *sequential*, not *gapless*. `MAX+1` inside the committing transaction happens to produce no gaps — a **property of the mechanism, not a promise**. **No gap-detection machinery is built** |

---

## §12. USER RATIFICATION PACKET — EXACTLY THREE

### **DC-R1 — Internal-MVP DayClose sequencing** — **RECOMMENDED: YES**

Full binding text in **§6** (nine clauses), with the `FR-FIN-026` wording rule in
**§7**. Scope acceptance, never a waiver.

### **DC-R2 — Spanning-session variance ownership** — **RECOMMENDED: CLOSE-BUSINESS-DAY OWNERSHIP**

> A CashSession's whole-session close facts — above all its variance — belong
> **exactly once** to the business day in which that session became `CLOSED`,
> recorded as an **immutable `closedBusinessDay`** derived at final-close time
> from the **same** authoritative resolver Sales uses and **never re-derived**
> historically. A spanning session **may still be linked** to multiple DayClose
> snapshots for its **day-scoped tender contribution**.

Design consequences, the worked example, the zero-payment/movement-only/legacy
treatment, and why the partial owner `UNIQUE` is defence-in-depth rather than the
mechanism: **§4**.

### **DC-R3 — Historical Z read authority** — **RECOMMENDED: NARROW SCOPE EXTENSION OF `report.view.financial`**

> `report.view.financial` — already ratified under RPT-R1 and already an
> instantiation of §15.2's `report.view.<category>` template — **may also
> authorise** `GET /branches/{branchId}/day-closes/{businessDay}`. **No new
> permission code is created.** `cash.day.close` remains the **write** authority
> only and is **not** reused for historical reads.

Reasoning and the refused alternatives: **§5**.

### **NO FOURTH DECISION IS CREATED**

Explicitly **not** put to the user: the **strictly-past-day close restriction**
(§2 — engineering, derived from immutability and structural facts) ·
**SERIALIZABLE + bounded retry** (§3) · **schema/table/column/index/constraint
names** · **`version` omission** (§8) · **Treasury ownership** ·
**`cash.day.close`** · **`day.closed`** · **idempotency** · **audit** ·
**uniqueness/RLS mechanics** · the **zero-open-orders precondition** (§10) · the
**branch fail-closed posture**.

---

## §13. CORRECTED IMPLEMENTATION DEFINITION OF DONE

The original gate's 21 points stand. **Amended and added below.** Every
concurrency test uses **deterministic barriers — no sleeps** (the accepted
`test/kds-concurrency.e2e-spec.ts` two-party barrier and raw session-level
harness).

### Close-boundary tests *(new — replacing the withdrawn SSI claims)*
1. **Closing the CURRENT business day is refused** — **409**, message says the day
   is still open.
2. **Closing a FUTURE business day is refused** — **400** (Reporting's precedent).
3. **Closing a strictly PAST business day is allowed.**

### `FR-FIN-021` blocker tests *(unchanged in intent, restated)*
4. No open branch CashSession ⇒ close proceeds.
5. A **`closing`** session blocks (409 + blocking list).
6. A **zero-payment open** session blocks.
7. A **movement-only open** session blocks.

### Finality tests
8. An **open target-day Order** (each of `draft`/`open`/`held`/`parked`/
   `partially_paid`) blocks; **`completed` and `cancelled` do NOT block**.

### Concurrency tests *(re-derived)*
9. **A concurrent new CURRENT-day Order does not affect the past-day close** —
   the sealed Z is unchanged by it, and the close is not aborted by it.
10. **A concurrent CashSession open may serialize AFTER the past-day close and
    both commit** — the closed day's Z is **not corrupted**, and the new session's
    `closedBusinessDay` never equals the sealed day. *(This test asserts the
    corrected behaviour, and would have failed the withdrawn claim.)*
11. **Same-day duplicate close** ⇒ exactly one row, exactly one `zNumber`, the
    loser **409**, and the failure is **not** retried.
12. **Different-day concurrent `zNumber` allocation** at one branch ⇒ two
    distinct sequential numbers, no duplicate, retry observed rather than a
    spurious permanent failure.
13. A `SerializationRetryExhaustedError` surfaces as **409**, never 422.

### Ownership / variance tests
14. **A spanning session appears in TWO DayClose linkage children**, with each
    day's own tender contribution — and the insert is **not** rejected by any
    uniqueness constraint.
15. **`closedBusinessDay` is persisted at CashSession final close**, in the same
    transaction as the close facts, and is **never** recomputed afterwards.
16. **A session's variance appears in EXACTLY ONE Z variance summary** — asserted
    across both days for a spanning session.
17. **A zero-payment closed session's variance is owned by its closing day** and
    appears in that Z, with zero tender contribution.
18. A **legacy** closed session (`closedBusinessDay IS NULL`) is owned by **no**
    DayClose and is never silently attributed.
19. **No day total is ever emitted** for `openingFloat`, `expectedCash`,
    `countedCash`, movement totals; whole-session figures are labelled
    `WHOLE_SESSION` on the wire.

### Snapshot / durability tests
20. **Historical currency** — a Z sealed before a later `org.branches.timezone` /
    `base_currency` / operating-hours-cutover change is **byte-unchanged** by it.
21. **Idempotent replay** — same key + same fingerprint ⇒ stored response +
    `Idempotent-Replay: true`, no second row, no second event, no second audit
    entry.
22. **Event/audit rollback under serialization retry** — a retried attempt
    publishes `day.closed` **exactly once** and writes exactly one audit entry;
    no event leaks from a rolled-back attempt (`UnitOfWork`'s fresh per-attempt
    collector).

### Structural
23. Immutability proven as an unprivileged `NOBYPASSRLS` role: `UPDATE` and
    `DELETE` on a sealed DayClose both fail.
24. `cash_sessions.closed_business_day` is **NULLABLE**; migration 35 applies
    cleanly over **real pre-existing `open` and `closed` rows** (the P1G-1
    migration-compatibility method).
25. **No unconditional `UNIQUE (tenant_id, cash_session_id)`** anywhere.
26. **Zero `KNOWN_DEVIATIONS` growth**; Reporting still owns zero tables; full
    e2e green on a clean from-zero scratch DB; OpenAPI a pure addition;
    `tsc`/`eslint`/`prisma validate`/`nest build`/`git diff --check` clean.

---

## §14. WHAT THIS TASK DID AND DID NOT DO

**Did:** verified the baseline; read the DayClose gate (**unmodified**);
re-derived the concurrency proof from actual dependency structures; verified
every claim against current source; produced this correction; appended **exactly
one** `INDEX.md` row.

**Did NOT:** implement product code · create or modify a migration · modify the
Prisma schema · add a route or permission · edit governance · regenerate
OpenAPI · run any test suite · launch any agent or fork · stage · commit · push ·
deploy · modify the original gate or any other report.

---

## §15. VERDICT

> # **A. DAYCLOSE DESIGN CORRECTION CLEAN — READY FOR USER RATIFICATION**
>
> **Not B** — the close-boundary/concurrency issue is resolved: the invalid SSI
> claim is withdrawn and replaced by a structural strictly-past-day invariant,
> with each of the six races proved from its actual dependency structure.
> **Not C** — DC-R2 now carries a recommendation with worked-out consequences.
> **Not D** — DC-R3 recommends extending an already-ratified code rather than
> inventing one.
> **Not E** — baseline unchanged.

---

*End of report. **Non-authoritative evidence.** The SRS and the ratified
governance decisions remain authoritative.
`2026-08-31_DAYCLOSE-final-design-gate.md` is preserved **byte-unmodified**; this
correction governs where the two differ, and everything the gate settled that is
not named here stands unchanged. The withdrawal in §2 corrects a claim made by
this model in that gate.*

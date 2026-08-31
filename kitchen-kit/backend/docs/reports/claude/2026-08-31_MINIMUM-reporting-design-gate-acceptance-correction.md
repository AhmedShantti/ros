# MINIMUM OPERATIONAL REPORTING — Design-Gate Acceptance Correction

| Field | Value |
|---|---|
| **Task / slice name** | MINIMUM OPERATIONAL REPORTING — branch daily-trading read surface (design-gate acceptance correction) |
| **Report type** | Design correction. **Analysis/design only. NO implementation, NO migration, NO schema, NO route, NO permission, NO governance edit.** |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the **ratified** entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the only authorities. This report ratifies nothing, decides nothing binding, creates no scope and confers no permission. It **corrects** the design gate below **before** user ratification; where the two differ, **this correction governs**, and every difference is stated explicitly in §2. |
| **Corrects** | `docs/reports/claude/2026-08-31_MINIMUM-reporting-final-design-gate.md` — **read in full, NOT modified, NOT overwritten, NOT deleted.** It remains the record of what was considered. |
| **Date** | 2026-08-31 |
| **HEAD** | `38e007b0cd285679fc7fd334aec54d3bf2a8006c` — *feat: complete KDS operator lifecycle* (**unchanged**) |
| **Branch** | `feat/production-spec` |
| **Working tree** | Documentation-only. `M docs/reports/claude/INDEX.md` + untracked reports in `docs/reports/claude/`. **Zero source / schema / test / migration / OpenAPI drift**, re-verified at the start of this session. |
| **Task identifier** | MINIMUM-reporting-design-gate-acceptance-correction |
| **Status** | COMPLETE |
| **Migrations** | 34 — unchanged. **NO MIGRATION EXPECTED**, re-confirmed against three additional query shapes (§15). |
| **Tests** | **No test suite executed in this session.** Test *files* cited as structural evidence only. **Four additional read-only statements** run against the local dev DB as `ros_app` inside `BEGIN … ROLLBACK` — three `EXPLAIN` (§15) and one `transaction_timestamp()` observation (§9). No `ANALYZE`, no write, no DDL, no seed. |

---

## §0. VERDICT

> # **A. REPORTING DESIGN CORRECTION CLEAN — READY FOR USER RATIFICATION**
>
> All six corrections are applied and source-verified. **No blocker remains.**
>
> - **A** — the day-level `varianceTotal` is **REMOVED**; whole-session facts
>   are explicitly scoped `WHOLE_SESSION`; Cash Reconciliation is reclassified
>   **PARTIAL**.
> - **B** — `periodStatus` blockers re-derived against *the report's own
>   day-scoped figures*; zero-payment sessions are **not** blockers.
> - **C** — a future business day is now **400**, not `OPEN`. No `FUTURE` enum.
> - **D** — currency comes from **immutable transaction snapshots**, never
>   from today's mutable `org.branches.base_currency`.
> - **E** — **KNOWN_DEVIATIONS growth = ZERO**, via the already-published
>   `identity/contract/http.ts`. No `reporting->identity` key.
> - **F** — branch existence, single-active-branch assertion, current business
>   day and `dataAsOf` all execute **inside the one RepeatableRead
>   transaction**. The TOCTOU gap is closed; **no `ReportingBranchGuard`
>   exists**.
>
> Plus: `dataAsOf` wording corrected and **evidence-tested** (§9); the AOV
> ratification posture made coherent — **no manufactured default** (§10); and
> the forward-binding constraint on `orders.grand_total` **withdrawn** and
> replaced by a revisit trigger (§11).
>
> **THREE user ratifications remain, unchanged in substance (§18).**

---

## §1. VERIFIED BASELINE

```
git rev-parse HEAD      -> 38e007b0cd285679fc7fd334aec54d3bf2a8006c
git branch --show-current -> feat/production-spec
git status --short      -> only docs/reports/claude/ (M INDEX.md + untracked reports)
ls -d prisma/migrations/*/ | wc -l -> 34
```

**Zero source / schema / test / migration / OpenAPI drift.** Verdict E is not
returned. The four unrelated pre-existing reports were not read into scope,
modified, staged or removed.

---

## §2. SCOPE — WHAT CHANGES, WHAT DOES NOT

### Changed by this correction

| # | Area | Original gate | This correction |
|---|---|---|---|
| **A** | Day variance | `cashReconciliation.varianceTotal = Σ variance over closed sessions` | **REMOVED.** No day-level variance is emitted. Whole-session facts carry an explicit `WHOLE_SESSION` scope marker. Cash Reconciliation reclassified **PARTIAL**. |
| **A** | FR-FIN-021 framing | *"`unclosedSessionCount` … is exactly FR-FIN-021's blocking-session list"* | **WITHDRAWN.** It is **not** that list. FR-FIN-021 needs *all* branch sessions open on the day; this report knows only *payment-contributing* ones. |
| **B** | `periodStatus` blockers | any contributing session `status ≠ 'closed'`, plus `openOrderCount` | Same two blockers, but each **re-derived from what can change *this report's own* figures**, with the zero-payment-session case proved non-blocking. Field renamed `unclosedContributingSessionCount`. |
| **C** | Future days | `businessDay >= current ⇒ OPEN` | `businessDay > current ⇒ **400**`; `== current ⇒ OPEN`; `< current ⇒ UNSEALED \| SETTLED`. No `FUTURE` enum. |
| **D** | Currency | branch `base_currency` is authoritative; any order/payment disagreeing ⇒ 409 | **Observed transaction currency is authoritative.** Branch currency is the fallback for a financially empty day only. A legitimate branch currency change **no longer breaks** a historically coherent past day. |
| **E** | Module boundaries | *"two honest readings"*, one of which added `reporting->identity` | **Only one reading is permitted: ZERO KNOWN_DEVIATIONS growth**, via `identity/contract/http.ts`. |
| **F** | Branch check | a `ReportingBranchGuard` running in its own transaction | **No guard.** All DB-derived branch facts execute inside the report's single RepeatableRead transaction. |
| **§9** | `dataAsOf` wording | *"the instant of the very snapshot every figure was read from"* | **Overclaim withdrawn.** It is `transaction_timestamp()` — a stable, transaction-scoped marker, sufficient for FR-RPT-004. Measured (§9). |
| **§10** | AOV posture | a user decision **and** a net default if unanswered | **Coherent:** a true user ratification. Unanswered ⇒ **the field is omitted**, not defaulted. |
| **§11** | Gross/net future | *"BINDING CONSTRAINT: `grand_total` must remain pre-discount"* | **WITHDRAWN.** Replaced by a five-item revisit trigger. This slice does not dictate Sales' future financial model. |
| **§15** | Session-facts precision | close facts *"populated EXACTLY ONCE"* implied DB immutability | Corrected: `ros_app` **does** hold column-level UPDATE on the close columns; immutability of a `closed` session is **service-enforced**, cited. |

### Preserved unchanged (§10 of the correction brief)

Thin `reporting` module owning **zero tables** · one composite HTTP route ·
one branch + one business day · no ranges · dashboard-only ·
`report.view.sales` + `report.view.financial` as the leading recommendation ·
**AND** semantics · no `report.export` · **no business audit on the GET** ·
completed-only sales population · all branch-day payments as tender
population · `payment.amount` **never** `tendered_amount` · cash rounding
outside revenue · tax total and by-class only · **no by-rate** · **no COGS** ·
RepeatableRead · **no migration** · orders-first indexed joins · no warehouse,
replica or rollups · **FR-RPT-001/002/003/005 NOT IMPLEMENTED** ·
**FR-RPT-042 NOT IMPLEMENTED** · Receipt and DayClose out of scope.

**The original gate's §5 (data-source audit), §6 (sales population), §8
(gross/net), §9 (tender equations), §11 (tax), §13 (period boundary), §14
(module ownership), §17 (permissions), §18 (export/audit), §19 (drill-down),
§20 (EXPLAIN), §27 (Receipt/DayClose) remain in force except where a
correction above names them.**

---

## §3. CORRECTION A — DAILY CASH RECONCILIATION SCOPE

### A.1 The defect, stated exactly

The original design emitted:

```
cashReconciliation.varianceTotal = Σ session.variance  over status='closed'
```

as a **day-level** figure, while the sessions it summed were selected by
`DISTINCT order_payments.cash_session_id` for that business day and their
`variance` is a **whole-session** fact.

**The failure case is concrete.** A session opens 22:00 Monday and closes
06:00 Tuesday, with a branch cutover of 04:00. Its payments land on **both**
Monday's and Tuesday's business days. It therefore appears in **both**
reports' session sets, and its single whole-session variance of, say, −500
would be reported as *Monday's* day variance **and** as *Tuesday's* day
variance. Summed across the two days, a −500 shortfall becomes −1,000.

**That is a double-counted financial figure**, and no amount of labelling on
the per-session row repairs a *day-level total* that adds it in twice.

### A.2 Why no source-correct day attribution exists

| Candidate anchor | Verified at HEAD | Verdict |
|---|---|---|
| `treasury.cash_sessions.business_day` | **The column does not exist.** `schema.prisma:2297-2361` — the model carries `opened_at` / `closed_at` (`timestamptz`) and nothing else temporal | unavailable |
| `workforce.shifts.business_day` | **Does not exist** (`schema.prisma:2199-2227`) | unavailable |
| `treasury.cash_movements.business_day` | **Does not exist** — `occurred_at` (`timestamptz`) only, indexed `(tenant_id, branch_id, occurred_at)` (`schema.prisma:2470-2502`) | unavailable |
| `treasury.cash_session_close_attempts.business_day` | **Does not exist** — `declared_at` / `created_at` only (`schema.prisma:2374-2437`) | unavailable |
| Re-derive from `opened_at` + branch calendar | Possible in principle, **rejected**: it needs a second implementation of FR-FIN-024 outside Sales (divergence hazard), and **`org.branches.timezone` is MUTABLE** (`branches.service.ts:149-151`), so a historical day's boundary would be re-derived from *today's* zone | **rejected** |

> **A new immutable anchor is NOT invented.** No column, no table, no
> migration. The gate's instruction is followed literally.

### A.3 What is emitted instead

**Day-level:** nothing that aggregates a whole-session fact.

```
cashReconciliation: {
  scope: "WHOLE_SESSION",          // literal, on the wire — see A.4
  sessions: [ … ],                 // per-session, below
  contributingSessionCount:   integer,
  closedSessionCount:         integer,
  unclosedSessionCount:       integer,
  spanningSessionCount:       integer     // sessions whose payments touch >1 business day
  // NO varianceTotal.  NO payInTotal.  NO payOutTotal.  NO safeDropTotal.
  // NO expectedCashTotal.  NO countedCashTotal.
}
```

**Per session** — every field carries an explicit scope:

```
{
  cashSessionId, employeeId, drawerId,
  openedAt, closedAt|null, status,             // WHOLE_SESSION
  currency, openingFloat,                      // WHOLE_SESSION
  expectedCash|null, countedCash|null,         // WHOLE_SESSION — null unless status='closed'
  variance|null,                               // WHOLE_SESSION — null unless status='closed'
  payInTotal, payOutTotal, safeDropTotal,      // WHOLE_SESSION — NOT business-day-scoped
  isFinalised: status === 'closed',
  businessDayCount: integer,                   // how many business days this session's payments touch
  spansMultipleBusinessDays: businessDayCount > 1,
  tenderTotalsForThisBusinessDay: {            // DAY-SCOPED and EXACT
    cashSalesTotal, cashRoundingAdjustments, manualExternalCardTotal, paymentCount
  }
}
```

**`businessDayCount` is a new, cheap, load-bearing honesty field.** It is
`COUNT(DISTINCT business_day)` over that session's payments — a Sales-owned
fact, index-driven on the existing
`order_payments_tenant_cash_session_idx` (§15, plan 5). A client rendering a
whole-session variance can see, per row, whether that row is exclusive to the
day it is being shown under. **Nothing has to be inferred.**

### A.4 The scope marker is on the wire, not only in prose

`cashReconciliation.scope = "WHOLE_SESSION"` is a literal string field, and
every whole-session key is documented as such in the OpenAPI schema. A client
that renders these figures cannot do so believing they are day-scoped, because
the response says otherwise in a field it must read.

**Day-scoped figures remain exact and are unaffected**, because they derive
from `order_payments.business_day` — server-derived once at order creation,
copied to the payment, immutable thereafter, and never re-derived from a
mutable branch attribute.

### A.5 Reclassification — §19.3 *Cash Reconciliation*

> ### **§19.3 Cash Reconciliation: PARTIAL**
>
> | Limb (§19.3: *"By session, cashier, drawer, variance"*) | Status |
> |---|---|
> | **by session** | **EXACT — for payment-contributing sessions only** |
> | **by cashier** (`employeeId`) | **EXACT — same population** |
> | **by drawer** (`drawerId`) | **EXACT — same population** |
> | **variance** | **PER SESSION, WHOLE-SESSION SCOPE.** No day-level total. |
> | **zero-payment sessions** | **NOT IMPLEMENTED** — a session that captured no payments cannot be attributed to a business day without a new immutable anchor, and none is invented |
> | **movement-only sessions** (pay-in/pay-out/safe-drop, no sales) | **NOT IMPLEMENTED** — same reason; `cash_movements` carries no business day |
>
> Previously classified **DELIVERED**. **Corrected downward to PARTIAL.**

### A.6 The FR-FIN-021 claim is withdrawn

The original gate stated that `unclosedSessionCount` *"is exactly FR-FIN-021's
'blocked while any cash session remains open, and SHALL list the blocking
sessions'"*.

**That is withdrawn.** FR-FIN-021 requires **every** cash session of the
branch that remains open — including zero-payment and movement-only sessions,
which this report cannot see. What this slice provides is the
*payment-contributing* subset, which is **necessary but not sufficient** for
FR-FIN-021.

> **FR-FIN-020…026 remain NOT IMPLEMENTED. DayClose remains a separate slice**,
> and it will need its own session-to-day attribution rule — very likely the
> immutable anchor this correction declines to invent. That is DayClose's
> decision to make, not this slice's.

---

## §4. CORRECTION B — PERIOD STATUS, RE-DERIVED

### B.1 The question restated correctly

`periodStatus` must answer: **can *this report's own* figures still change?**
Not: *is anything at this branch still open?*

The figures this report actually exposes, after Correction A:

| Group | Scope | What can change it |
|---|---|---|
| `salesSummary` (gross, discounts, refunds, tax, net, count, `unsettledCapturedTotal`) | day-scoped | a non-terminal order **of this business day** reaching `completed`, or receiving a further payment |
| `tenderTotals` | day-scoped | a new payment on a non-terminal order **of this business day** |
| `taxSummary.byClass` | day-scoped | same as `salesSummary` |
| `cashReconciliation.sessions[].tenderTotalsForThisBusinessDay` | day-scoped | same |
| `cashReconciliation.sessions[]` whole-session facts | WHOLE_SESSION | a **contributing** session moving `open`/`closing` → `closed` (writes `expected/counted/variance/closedAt`), or receiving a movement (changes `payIn/payOut/safeDrop`) |
| `cashReconciliation` counts | derived | both of the above |

### B.2 The two blockers, each proved

**B1 — `openOrderCount > 0`**
Orders of this business day in `draft`, `open`, `held`, `parked` or
`partially_paid`. Any of them can still complete
(`order-state.ts` `TRANSITIONS`), which moves gross, tax, net, count, AOV, the
tax breakdown, the tender totals and `unsettledCapturedTotal`.
*(`held`/`parked` cannot take a payment directly — `assertMayCapturePayment`
admits only `open` and `partially_paid` — but both transition to `open`, so
they are blockers.)*

**B2 — `unclosedContributingSessionCount > 0`**
Sessions **in this report's own session set** whose `status ≠ 'closed'`.
`expectedCash`/`countedCash`/`variance` are NULL until `closed` and are then
written once; `payIn/payOut/safeDrop` grow while the session is open.
So an `open` or `closing` contributing session **can** change what the report
already shows.

*Precision correction:* the original gate implied DB-level immutability of a
closed session. **`ros_app` in fact holds column-level `UPDATE` on
`cash_sessions` for `status`, `closed_at`, `expected_cash`, `counted_cash`,
`variance`, `variance_reason`, `close_attempt_id`, `approval_request_id`,
`closed_by_user_id`, `closed_by_employee_id`** — verified against
`information_schema.column_privileges` this session. Immutability of a
**`closed`** session is therefore **service-enforced**, at
`cash-session-close.service.ts:251` (*"the session is already closed"*) and
`:460` (*"already closed under a different approval request"*), both inside the
session-locked transaction. At this HEAD **no implemented path mutates an
already-`closed` session**, so `closed` is stable — but the enforcement is
attributed correctly.

### B.3 Zero-payment sessions are NOT blockers — proved

A session with no payments on this business day is **absent from the report**
(§3). Can it *become* present, or change anything shown?

It enters the set only by capturing a payment attributed to **this** business
day. A payment carries its **order's** `business_day`. Therefore a new payment
on this day requires a **non-terminal order of this day** to exist — and a
brand-new order cannot be booked into a past day, because `business_day` is
derived from the **server clock** at creation (`orders.service.ts:193,240`;
`at` is a service-internal parameter with **no** `CreateOrderDto` field, and
`business-day.ts` states `origin_device_time` *"never decides the business
day"*).

> **Therefore: a zero-payment session can affect this report only when B1
> already holds.** Including it as an independent blocker would add no
> information and would make a settled day read as unsettled forever — a
> session left open at another drawer would permanently poison every past
> day's status. **Excluded, with the reason.**

### B.4 The corrected model

```
periodStatus: 'OPEN' | 'UNSEALED' | 'SETTLED'
```

| Value | Condition |
|---|---|
| **`OPEN`** | `businessDay === branchCurrentBusinessDay` — the branch is trading this day; new orders can still be booked into it |
| **`UNSEALED`** | `businessDay < branchCurrentBusinessDay` **AND** (`openOrderCount > 0` **OR** `unclosedContributingSessionCount > 0`) |
| **`SETTLED`** | `businessDay < branchCurrentBusinessDay` **AND** `openOrderCount === 0` **AND** `unclosedContributingSessionCount === 0` |

`businessDay > branchCurrentBusinessDay` never reaches this evaluation — it is
**400** (§5).

**`SEALED` is still not emitted and not declared.** Sealing is DayClose's
(FR-FIN-020/022/023). The future DayClose slice adds it as a fourth value;
`SETTLED` keeps its meaning.

**Field rename, load-bearing:** `unclosedSessionCount` →
**`unclosedContributingSessionCount`**. The old name invited exactly the
FR-FIN-021 misreading §3.6 withdraws.

### B.5 Revisit triggers — recorded, unchanged in force

`SETTLED` asserts *"no **currently implemented** path can change these
figures."* It must be re-derived when any of these ships:

1. **Refund / partial refund** — restates a completed order on a settled day.
2. **Comp / post-fire void** — same.
3. **Offline sync (`FR-OFF-*`)** — a replayed backdated sale can land in a past
   day, breaking the server-clock argument in B.3.
4. **A session-to-day anchor** (likely from DayClose) — would make
   zero-payment and movement-only sessions visible, changing the blocker set.
5. **FR-FIN-007 adjusting entries** — *"Corrections SHALL be recorded as
   adjusting entries referencing the session"*; unimplemented today, and they
   would change whole-session facts after close.

---

## §5. CORRECTION C — FUTURE BUSINESS DAYS

### C.1 The defect

`businessDay >= branchCurrentBusinessDay ⇒ OPEN` classified a day **in the
future** as *"still trading"*. That is false: nothing can ever be booked into
an arbitrary future business day, because `orders.business_day` is derived
from the server clock at creation (B.3). A request for 2027-01-01 would return
an all-zeros report labelled `OPEN`, which reads as *"trading has produced
nothing yet today"* — a misleading answer to a question that has no meaning.

### C.2 The rule

```
businessDay >  branchCurrentBusinessDay   ->  400
businessDay == branchCurrentBusinessDay   ->  OPEN
businessDay <  branchCurrentBusinessDay   ->  UNSEALED | SETTLED   (§4)
```

**400 body:** `Future business days are not supported.`

**No `FUTURE` enum value is added.** Source supplies no such concept, no UX
requires it, and a fourth status for a state that can never carry data would be
appearance without capability — the discipline `OrderPaymentTender`'s own
docblock states (*"adding the other nine here would be appearance without
capability"*).

### C.3 Where the check runs

`branchCurrentBusinessDay` is a **database-derived** fact (branch timezone +
`org.operating_hours.business_day_cutover`), so the comparison executes
**inside the report's RepeatableRead transaction** (§8), alongside branch
existence. A `BadRequestException` thrown there rolls back a read-only
transaction — harmless — and the exact precedent already exists:
`orders.service.ts:225` throws `NotFoundException('Branch not found.')` from
inside `withAuthContext`.

**A syntactic 400 still runs earlier**, at DTO validation: `businessDay` must
match `^\d{4}-\d{2}-\d{2}$` and be a real calendar date. The two 400s are
distinct and both are documented.

### C.4 Test-design updates (§17 carries the full list)

- `businessDay = branchCurrentBusinessDay + 1 day` ⇒ **400**, message
  `Future business days are not supported.`, **no report body**.
- `businessDay = branchCurrentBusinessDay` ⇒ **200**, `periodStatus === 'OPEN'`.
- A day far in the future ⇒ **400**, not an all-zeros `OPEN` report.
- **`periodStatus` is never `'OPEN'` for a day after the branch's current
  business day** — asserted across every fixture.
- The future check uses the **branch's** current business day, not the
  server's calendar date: a branch in a zone where "today" differs from UTC
  must still accept its own current day.

---

## §6. CORRECTION D — HISTORICAL CURRENCY

### D.1 The defect

The original rule made **today's** `org.branches.base_currency` authoritative
and refused (409) if any order or payment disagreed.

`BranchesService.update` accepts `baseCurrency`
(`branches.service.ts:152-154`), so a branch **can** legitimately change
currency. After such a change, **every historically coherent past day — every
order and payment in it denominated in one single old currency — would be
refused**, because it disagreed with the new branch currency.

> **A historical report must not depend on a mutable present-day attribute
> when immutable transaction snapshots exist.** `orders.currency` is
> *"Snapshot of the branch's authoritative currency at open. Never
> client-supplied."* `order_payments.currency` is *"Snapshot of the order's
> currency at capture time. Never client-supplied."* Those are the facts the
> money in this report is actually denominated in.

### D.2 The corrected rule

**Observed transaction currency set** `C` = the distinct currencies of every
**money-bearing fact the report actually uses**:

```
C = DISTINCT orders.currency          over the SALES POPULATION (state='completed')
  ∪ DISTINCT order_payments.currency  over the TENDER POPULATION (all branch-day payments)
```

| Case | Condition | `response.currency` |
|---|---|---|
| **A** | `|C| === 1` | **that historical transaction currency** |
| **B** | `|C| === 0` | **`Branch.baseCurrency`** — there is no historical monetary fact to contradict it |
| **C** | `|C| > 1` | **REFUSE** — 409 (§14). No total is emitted. |

**Case B is exactly the financially empty day**, and provably so: a `completed`
order is fully paid, so it always has payments; therefore *"no payments"*
implies *"no completed orders"*, and the session set (derived from payments) is
also empty. `salesSummary` and `tenderTotals` are all zeros, and reporting the
branch's current currency alongside them is truthful — it says *"this is the
branch's currency; nothing traded"*.

### D.3 CashSession currencies — validated, never a source

Contributing sessions' `cash_sessions.currency` values are **asserted against
`C`**, not merged into it.

This assertion **must always pass**: `sales-payment.service.ts:228` refuses a
capture when `session.currency !== order.currency`, so a contributing session
is structurally in the same currency as the payments that put it in the set. It
is therefore **defence in depth over a service-enforced invariant**, not a live
branch — and a failure is an integrity defect surfaced honestly (§14), never a
silent merge.

### D.4 What the Branch contract is still needed for

`BRANCH_CURRENCY_QUERY` and `BRANCH_REPORTING_SCOPE_QUERY` remain required, for
**four** things — none of which is "the currency of a day that has
transactions":

1. **Branch existence and tenant safety** — `find()` returns `null` for an
   unknown **or** a cross-tenant id (RLS makes the row invisible), which is how
   the tenant-safe **404** is produced without disclosing foreign existence.
2. **Branch shape** — the single-active-branch assertion (§8).
3. **Fallback currency** — case B only.
4. **Branch calendar facts** — timezone + cutover, for
   `branchCurrentBusinessDay`, reached through the **Sales** contract's single
   FR-FIN-024 implementation (§12).

### D.5 What this rule does NOT solve

> **FR-RPT-005 `[M]` remains NOT IMPLEMENTED.**
>
> This rule fixes **one** Type-2 symptom — the currency of a *money* figure —
> by preferring the immutable snapshot the transaction already carries. It does
> **not** provide slowly-changing dimensions, and every other historically
> reinterpretable attribute stays exposed: `org.branches.timezone` is mutable
> (which is why §3.2 refuses to re-derive historical business days),
> `branches.name`, `branches.status`, employee attributes, item categories and
> `fiscal.tax_classes.names` all read at present-day values.
>
> **No claim is made that Type-2 history is solved.**

---

## §7. CORRECTION E — ZERO `KNOWN_DEVIATIONS` GROWTH

### E.1 The option that is rejected

The original gate offered two treatments of the reporting module's
HTTP/auth plumbing, one of which added a `'reporting->identity'` key to
`KNOWN_DEVIATIONS` and argued it was *"zero growth in kind"*.

**That option is REJECTED.** The required outcome is **`KNOWN_DEVIATIONS`
growth = ZERO**, not *zero category-(b) growth*.

### E.2 The mechanism already exists — verified at HEAD

`src/modules/identity/contract/http.ts` exists at this HEAD, created by the
**KDS operator-lifecycle acceptance correction (2026-08-31), Blocker A**,
precisely so a new controller-bearing module adds none of that debt. Its
docblock states the intent verbatim:

> *"Rather than let Kitchen's first controller add its OWN copy of that same
> pre-existing debt, this file publishes the identical surface as Identity's
> own public export: a THIN re-export, never a reimplementation … a module
> importing exclusively from `identity/contract` adds none of its own."*

**Exported symbols, read from the file:**
`JwtAuthGuard` · `TenantContextGuard` · `PermissionGuard` ·
`RequirePermission` · `RequireAnyPermission` · `AllowPosSession` ·
`CurrentPrincipal` · `CurrentTenantContext` · `AuthenticatedPrincipal` (type) ·
`TenantContext` (type) · `PermissionDef` (type).

**Every primitive this slice needs is in that list.** The reporting module
requires `JwtAuthGuard`, `TenantContextGuard`, `PermissionGuard`,
`RequirePermission`, `CurrentTenantContext`, `TenantContext` and
`PermissionDef` — and **not** `AllowPosSession` (dashboard-only) and **not**
`CurrentPrincipal`.

**`CurrentAuthorization` / `RequestAuthorization` are NOT needed** — the
original design's own `mode: 'all'` guard decides authorization entirely at the
guard layer, so no handler inspects the permission set. **No new export is
requested from Identity.**

### E.3 The precedent is exact and mechanically enforced

`module-boundaries.spec.ts` already asserts, for Kitchen:

```ts
expect(KNOWN_DEVIATIONS['kitchen->identity']).toBeUndefined();
expect(KNOWN_DEVIATIONS['kitchen->governance']).toBeUndefined();
expect(KNOWN_DEVIATIONS['kitchen->organisation']).toBeUndefined();
expect(KNOWN_DEVIATIONS['kitchen->sales']).toBeUndefined();
expect(KNOWN_DEVIATIONS['kitchen->catalogue']).toBeUndefined();
expect(violations.filter((v) => v.importer === 'kitchen')).toEqual([]);
```

and, per file, that no import line contains `identity/auth/`,
`identity/authz/` or `identity/context/`.

`KitchenController` imports confirm it in practice — its only cross-module
imports are `../identity/contract` and `../organisation/contract`.

### E.4 The binding rule for the reporting module

> **`KNOWN_DEVIATIONS` growth = ZERO. No new allow-list key of any kind.
> No module-boundary test is weakened, relaxed, skipped or re-scoped.**

Permitted cross-module imports, exhaustively:

```
../identity/contract          guards, decorators, TenantContext, PermissionDef
../sales/contract             DAILY_TRADING_SALES_QUERY
../treasury/contract          DAILY_CASH_RECONCILIATION_QUERY
../organisation/contract      BRANCH_CURRENCY_QUERY, BRANCH_REPORTING_SCOPE_QUERY
../localisation/contract      TAX_CLASS_LABELS_QUERY
../<module>/<module>.module   the DI-composition exemption only
```

Non-module infrastructure remains outside the boundary scan and is used exactly
as every other module uses it: `src/prisma/prisma.service` (`withAuthContext`)
and `src/common/**` (money/rounding helpers, OpenAPI schema helpers).

**`governance/contract` is NOT imported** — this slice writes no audit entry
(original gate §18, preserved).

### E.5 Required assertions (added to §17)

```ts
it('Reporting adds ZERO new module-boundary deviations', () => {
  for (const k of ['reporting->identity','reporting->sales','reporting->treasury',
                   'reporting->organisation','reporting->localisation',
                   'reporting->governance','reporting->catalogue',
                   'reporting->inventory','reporting->kitchen',
                   'reporting->production','reporting->workforce']) {
    expect(KNOWN_DEVIATIONS[k]).toBeUndefined();
  }
  expect(violations.filter((v) => v.importer === 'reporting')).toEqual([]);
});
```

plus the per-file import-line assertion (no `identity/auth/`,
`identity/authz/`, `identity/context/`) over every reporting source file, and
an assertion that the reporting module contributes **no Prisma model and no
migration**.

---

## §8. CORRECTION F — BRANCH CHECK INSIDE THE SNAPSHOT

### F.1 The TOCTOU gap

The original design put branch existence and the single-active-branch
assertion in a `ReportingBranchGuard`, which runs in **its own**
`withAuthContext` transaction, before the report's transaction opens.

`BranchesService` can activate or deactivate a branch
(`branches.service.ts:198-212`, `status` update). Between the guard's snapshot
and the report's snapshot, a second branch can be activated — so the guard
sees one active branch and permits the request, while the report is assembled
under a two-active-branch shape the posture is meant to refuse. The window is
small; the exposure is a branch's full daily financial position.

### F.2 The corrected shape

> **There is NO `ReportingBranchGuard`.** Every database-derived fact that
> decides whether this branch may be exposed executes **inside the same
> RepeatableRead transaction** that produces the figures.

```
GET /reports/branches/{branchId}/daily-trading/{businessDay}
  │
  ├─ DTO validation ..................... 400 (malformed branchId / businessDay)
  ├─ JwtAuthGuard ....................... 401  (dashboard-only; POS session refused)
  ├─ TenantContextGuard ................. 403  (no active tenant context)
  ├─ PermissionGuard (mode:'all') ....... 403  (report.view.sales AND report.view.financial)
  │
  └─ DailyTradingReportService.build(tenantId, branchId, businessDay)
       └─ prisma.withAuthContext({ tenantId, userId },
                                 tx => { … },
                                 { isolationLevel: RepeatableRead })
            1.  dataAsOf                 = SELECT transaction_timestamp()
            2.  branch                   = BranchCurrencyQuery.find(tx, …)      -> null ⇒ 404
            3.  operative                = BranchReportingScopeQuery.operativeBranches(tx, {limit:2})
                                              0  ⇒ 403 · 2 ⇒ 403 · ≠ branchId ⇒ 403
            4.  branchCurrentBusinessDay = DailyTradingSalesQuery.currentBusinessDay(tx, …)
                                              businessDay > current ⇒ 400
            5.  salesFacts               = DailyTradingSalesQuery.facts(tx, …)
            6.  currency                 = §6 rule over salesFacts             -> |C|>1 ⇒ 409
            7.  cashFacts                = DailyCashReconciliationQuery.forSessions(tx, …)
            8.  labels                   = TaxClassLabelsQuery.findByIds(tx, …)
            9.  periodStatus             = §4 rule
       └─ view layer: bigint -> decimal strings
```

**Steps 1–8 share one MVCC snapshot.** A branch activated mid-request is either
entirely inside or entirely outside it. **The gap is closed.**

### F.3 Why this is clean, not a workaround

| Property | Evidence |
|---|---|
| Throwing HTTP exceptions inside `withAuthContext` is established | `orders.service.ts:225` throws `NotFoundException('Branch not found.')` inside the transaction; `sales-payment.service.ts` throws `BadRequestException` / domain errors likewise |
| Read-only rollback is free | nothing is written; a thrown exception rolls back a transaction that holds no changes |
| Every contract is already `tx`-first | `BranchCurrencyQuery.find`, `CashSessionFactsQuery.find`, `CashMovementTotalsQuery.totalsForSession`, `CashSessionTenderTotalsQuery.totalsForSession` all take the **caller's** `Prisma.TransactionClient` — the four contracts here follow it exactly |
| Guards keep doing what guards do | authentication, tenant context and permissions are request-authorization concerns, not report-snapshot facts. The correction brief permits exactly this split. |
| Fewer moving parts than the original | one guard class is **removed**, not added |

### F.4 The refusal ladder is unchanged in substance

| Condition | Response |
|---|---|
| branch id unknown **or** in another tenant | **404** *Branch not found.* — byte-identical for both; RLS makes the foreign row invisible, so the handler cannot distinguish them either |
| tenant has **0** operative branches | **403**, fail-closed |
| tenant has **>1** active branch | **403** *Reporting is not supported for a tenant with more than one active branch in this release.* |
| supplied `branchId` ≠ the single operative branch, branch visible in this tenant | **403** — deliberately not 404: the branch demonstrably exists in the caller's own tenant |

**D-2 remains untouched.** The assertion reads a **tenant-shape** fact
(`org.branches.status`), never a principal's scope: it does not consult
`identity.membership_roles.branch_id`, does not populate
`TenantContext.branchId`, and does not make `PermissionGuard` branch-aware.
This is the **KDS-R11 consequence-note** pattern (0 ⇒ denied, >1 ⇒ denied as
unsupported, supplied id must equal the derived one), which that ratification
recorded as *"engineering mechanics, not a separate business decision"*.

> **Not a fourth user decision.** No governance contradiction was discovered.
> The disclosed product consequence stands and is repeated here so it is not
> lost: **a tenant with more than one active branch gets 403 on this route
> entirely** (dev DB: 473 tenants have exactly one active branch, 99 have two,
> 2 have four). The refusal disappears when D-2 is lifted, and the retrofit is
> confined to steps 2–3 above.

---

## §9. `dataAsOf` — CORRECTED WORDING

### The overclaim, withdrawn

The original gate said `dataAsOf` is *"the instant of the very snapshot every
figure was read from"* and *"literally 'the timestamp of the data it reflects'
— not an approximation of it."*

**That is an overclaim and is withdrawn.** PostgreSQL `now()` is
`transaction_timestamp()` — fixed when the transaction *starts*. A
REPEATABLE READ transaction's **MVCC snapshot** is taken by the first statement
that needs one, which is necessarily **after** `BEGIN`.

### Measured this session

Executed as `ros_app`, `BEGIN ISOLATION LEVEL REPEATABLE READ`, inside
`BEGIN … ROLLBACK`:

```
now()      = 2026-08-31 09:49:50.331006+00
txn_ts     = 2026-08-31 09:49:50.331006+00      now() = transaction_timestamp()  -> true
stmt_ts    = 2026-08-31 09:49:50.332669+00      (first statement — LATER than now())
… after a subsequent query …
now()      = 2026-08-31 09:49:50.331006+00      unchanged — stable across the transaction
stmt_ts    = 2026-08-31 09:49:50.340399+00      advanced
```

`now()` is **1.66 ms earlier** than the first statement's timestamp — direct
evidence that it precedes, rather than equals, the snapshot-acquiring
statement.

### The corrected claim

> **`dataAsOf` = `SELECT transaction_timestamp()`, taken inside the report's
> RepeatableRead transaction.**
>
> It is a **single, stable, server-authoritative timestamp for the whole
> transaction**, identical no matter where in the transaction it is read, and
> it bounds the snapshot from before: **every figure in the response was read
> from one MVCC snapshot taken at or immediately after this instant.**
>
> **This is sufficient for FR-RPT-004** (*"Every report SHALL display the
> timestamp of the data it reflects"*). **No claim of physical
> snapshot-timestamp equivalence is made.**

`statement_timestamp()` and an application-side `new Date()` are both rejected:
the former advances within the transaction (so different sections would carry
different "as of" values), and the latter is not database-authoritative.

Implementation note: read it as step 1 so it is emitted even on the error paths
that produce no report body — those paths return no `dataAsOf` at all, which is
correct, since there is no data to be "as of".

---

## §10. AOV — COHERENT RATIFICATION POSTURE

### The incoherence, resolved

The original gate said **both** that the AOV basis *"is a genuine
source-silence business definition"* **and** that *"if the user does not
answer, A stands as the engineering default"*.

Those cannot both be true. **If it is genuinely a user decision, silence
cannot manufacture the answer.** The original posture would have converted
non-response into ratification — governance by default — which is exactly what
this repository's register discipline exists to prevent.

### The finding is unchanged and re-verified

The SRS names AOV in five places — FR-FIN-022's Z report, §19.3 *Sales by
Employee* (*"Revenue, order count, AOV"*), §19.3 *Average Order Value Trend*,
the §12.1 employee-metric list (line 3542), the §18.x customer-profile list
(line 4030) — and **defines a formula in none of them**. Repository source is
silent. **It is a genuine source-silence business definition.**

### The corrected posture

> **DECISION 3 is a TRUE user ratification with NO default.**
>
> - **If the user ratifies a basis** → `averageOrderValue` is implemented on
>   that basis.
> - **If the user does not answer** → **`averageOrderValue` is OMITTED from
>   the response entirely.** The key is absent — not null, not zero, not
>   silently net-based.
>
> Omission is chosen over blocking the whole slice because the rest of the
> report is complete and useful without it, and because
> **`grossSales`, `netSales` and `completedOrderCount` all ship regardless**,
> so any client can compute an AOV on whichever basis it chooses. **Omitting
> a field is not a default basis** — it takes no position at all, which is the
> only honest posture under unresolved silence.

**Recommendation, unchanged and carried into §18:**

```
averageOrderValue = divideRounded(netSales, completedOrderCount, RoundingMode.HALF_UP)
                    null when completedOrderCount = 0
```

**NET basis**, because §13 makes Net Sales the SRS's canonical revenue measure
in every ratio it defines (`Food Cost % = COGS ÷ Net Sales`,
`Prime Cost % ÷ Net Sales`, `Sales per Labour Hour = Net Sales ÷ Hours`), and
FR-CST-035's ledger produces *"= Net Sales (excl. tax)"* as the revenue line.

---

## §11. GROSS / NET — FUTURE-COMPATIBILITY RULE

### The forward-binding constraint, withdrawn

The original gate stated: *"When discounts ship, `grand_total` must remain
pre-discount or the ledger double-subtracts. **Recorded as a binding
constraint on the future discount slice.**"*

**WITHDRAWN.** No authoritative Sales semantic requires `orders.grand_total` to
remain pre-discount forever. FR-CST-035's ledger is `[S]` and is a
*presentation* ledger; it constrains the **report's arithmetic**, not the
**Sales aggregate's storage model**. A future Discount slice might reasonably
store `grand_total` net of discounts with `discount_total` recorded alongside —
a perfectly coherent model that this Internal-MVP reporting decision has no
authority to forbid.

> **An Internal-MVP reporting slice must not dictate the future Sales
> aggregate's financial model.**

### The mandatory revisit trigger that replaces it

> **When Discount, Comp, Refund, post-fire Void, or FR-FIN-007 adjusting
> entries ship, the daily-trading report MUST be re-audited on all five points
> below — before that slice is accepted.**

| # | Re-audit | Why |
|---|---|---|
| 1 | **The gross population** (§6) | `partially_refunded` / `refunded` become reachable; option C of the original §6 ("completed plus future refunded/adjusted states") becomes live |
| 2 | **The `grossSales` formula** | `Σ orders.grand_total` is correct **only** while `grand_total` is pre-discount. If the Discount slice changes that, the report's formula changes with it — **the report adapts to Sales, not the reverse** |
| 3 | **`discounts` and `refunds`** | today literal/structural zeros with a recorded reason; both become real sums |
| 4 | **The tender-vs-sales identity** (§7.9 of the original gate) | `Σ tender.amountTotal = grossSales + unsettledCapturedTotal` holds **only** while every completed order is fully paid and no refund exists. A refund is a *negative* money movement; the identity must be re-derived, not patched |
| 5 | **`SETTLED` period semantics** (§4.5) | a refund against a completed order restates a day already reported `SETTLED` |

**At this HEAD the current formulas remain correct and are unchanged**, because
`orders.discount_total` is never written, `order_lines.line_discount` is
hard-coded `0n` (0 of 1,958 live rows non-zero), and the refunded states are
unreachable (`order-state.ts` `TRANSITIONS`).

**Unchanged and still in force** (a *present-tense* correctness rule, not a
forward constraint): **`orders.subtotal` MUST NOT appear in the report or in
any formula** — its meaning differs between tax-inclusive and tax-exclusive
pricing (`order-lines.service.ts:306-309`), so any figure derived from it would
be silently wrong for a mixed-mode tenant.

---

## §12. CORRECTED CONTRACT DELTAS

Only the deltas from the original gate §15 are given. Everything else is
unchanged: four contracts, all additive `contract/` files, all **`tx`-first**,
all bound to their token **only** inside the owning module, money `bigint`
internally and decimal **strings** on the wire.

### 12.1 Sales — `DAILY_TRADING_SALES_QUERY` *(3 additions)*

```ts
export interface SessionDayTenderTotals {
  readonly cashSessionId: string;
  readonly cashSalesTotal: bigint;
  readonly cashRoundingAdjustments: bigint;
  readonly manualExternalCardTotal: bigint;
  readonly paymentCount: number;
  /** NEW (§3.3) — distinct business days this session's payments touch. */
  readonly businessDayCount: number;
}

export interface DailyTradingSalesFacts {
  // … unchanged …
  /** RENAMED for clarity — distinct currencies over the SALES POPULATION. */
  readonly orderCurrencies: readonly string[];
  /** Distinct currencies over the TENDER POPULATION. */
  readonly paymentCurrencies: readonly string[];
  // `currencies` (ambiguous) is REMOVED.
}
```

`currentBusinessDay(tx, { tenantId, branchId })` is **unchanged and now
load-bearing in three places**: the future-day 400 (§5), the `OPEN` test and
the `UNSEALED`/`SETTLED` split (§4). It remains the **single** FR-FIN-024
implementation in the system — the property that guarantees the report and
`orders.business_day` can never disagree about what a business day is.

### 12.2 Treasury — `DAILY_CASH_RECONCILIATION_QUERY` *(scope marking only)*

The returned shape is unchanged, but **every field is documented as
`WHOLE_SESSION`** in the interface docblock, and the contract states
explicitly that **no day-level aggregate may be derived from it**:

```ts
/**
 * WHOLE-SESSION FACTS ONLY.
 *
 * `treasury.cash_sessions` carries NO `business_day` column, and neither do
 * `workforce.shifts`, `treasury.cash_movements` or
 * `treasury.cash_session_close_attempts`. NOTHING returned here is
 * business-day-scoped, and a caller MUST NOT sum `variance`, `expectedCash`,
 * `countedCash`, `payInTotal`, `payOutTotal` or `safeDropTotal` into a
 * day-level total: a session spanning two business days would contribute the
 * same whole-session figure to both days' reports.
 *
 * Day-scoped tender totals come from Sales' `DAILY_TRADING_SALES_QUERY`,
 * which reads the immutable `order_payments.business_day`.
 */
```

**Fail-closed rules unchanged:** an id that does not resolve, or resolves to a
different branch, is **dropped**; the result is a subset of the input ids; the
orchestrator asserts the subset relation.
**`cash_session_close_attempts` and `cash_count_denominations` are NOT read.**

### 12.3 Organisation — `BRANCH_REPORTING_SCOPE_QUERY` *(unchanged)*

`operativeBranches(tx, { tenantId, limit })` → ids of branches with
`status = 'active'`, capped. Now invoked **inside** the report transaction
(§8), which is a call-site change, not a contract change.

### 12.4 Localisation — `TAX_CLASS_LABELS_QUERY` *(unchanged)*

Labels only — no rate, no component, no engine access.

### 12.5 Boundary rule *(from §7)*

All four contracts are consumed **through their `contract/` barrels only**, and
the HTTP/auth plumbing **exclusively** through `identity/contract`.
**`KNOWN_DEVIATIONS` growth = ZERO.**

---

## §13. CORRECTED RESPONSE DTO

Route unchanged: **`GET /reports/branches/{branchId}/daily-trading/{businessDay}`**,
dashboard-only, no `/v1`, no query parameters, no `Idempotency-Key`, no ETag,
`Cache-Control: no-store`, **no business audit**.

```
{
  branchId, businessDay, currency,          // currency per §6 — observed, not branch-current
  currencySource: "TRANSACTION" | "BRANCH_FALLBACK",   // NEW — §6 case A vs case B
  dataAsOf,                                 // transaction_timestamp() — §9
  periodStatus: "OPEN" | "UNSEALED" | "SETTLED",       // §4; future days are 400, not a status
  branchCurrentBusinessDay,
  openOrderCount,
  unclosedContributingSessionCount,         // RENAMED — §4.4

  salesSummary: {
    grossSales, discounts, refunds, taxTotal, netSales,
    completedOrderCount,
    averageOrderValue,                      // PRESENT only if DECISION 3 is ratified — §10
    unsettledCapturedTotal
  },

  tenderTotals: {
    cash:               { amountTotal, roundingAdjustmentTotal, paymentCount },
    manualExternalCard: { amountTotal, roundingAdjustmentTotal, paymentCount },
    tenderGrandTotal, cashDrawerContribution, paymentCount
  },

  taxSummary: {
    taxTotal,
    byClass: [{ taxClassId, taxClassCode|null, countryPackCode|null,
                taxAmount, netAmount, grossAmount, lineCount }]
    // no `byRate` key at all
  },

  cashReconciliation: {
    scope: "WHOLE_SESSION",                 // NEW — §3.4
    sessions: [{
      cashSessionId, employeeId, drawerId,
      openedAt, closedAt|null, status, currency, openingFloat,
      expectedCash|null, countedCash|null, variance|null,
      payInTotal, payOutTotal, safeDropTotal,
      isFinalised,
      businessDayCount,                     // NEW — §3.3
      spansMultipleBusinessDays,            // NEW — §3.3
      tenderTotalsForThisBusinessDay: { cashSalesTotal, cashRoundingAdjustments,
                                        manualExternalCardTotal, paymentCount }
    }],
    contributingSessionCount, closedSessionCount,
    unclosedSessionCount, spanningSessionCount
    // varianceTotal        REMOVED — §3
    // payInTotal           REMOVED — whole-session, not day-scoped
    // payOutTotal          REMOVED
    // safeDropTotal        REMOVED
    // expectedCashTotal    REMOVED
    // countedCashTotal     REMOVED
  },

  scope: {
    salesPopulation:  "orders.state = 'completed'",
    lineExclusions:   ["voided", "comped"],
    tenderPopulation: "all order_payments for this branch-day, any order state",
    cashReconciliationScope: "WHOLE_SESSION",
    notes: [
      "FR-RPT-001/002/003/005 NOT IMPLEMENTED — query-time aggregation over the transactional primary (Internal MVP).",
      "Tax by rate NOT IMPLEMENTED — the FR-FIN-032 component breakdown is not persisted.",
      "Discounts and refunds are structurally zero — no mechanism exists at this release.",
      "Cash reconciliation covers only sessions that captured a payment on this business day; zero-payment and movement-only sessions are not attributable to a business day and are not listed.",
      "Session close facts (expected/counted/variance) and movement totals are WHOLE-SESSION figures, not business-day figures; check businessDayCount before attributing them to this day.",
      "currency is the currency the day's transactions were actually recorded in, not the branch's present-day configured currency."
    ]
  }
}
```

---

## §14. CORRECTED ERROR SEMANTICS

| Status | Condition | Notes |
|---|---|---|
| **400** | malformed `businessDay` (`^\d{4}-\d{2}-\d{2}$`, real date) or `branchId`; **any** query parameter (`forbidNonWhitelisted`) | DTO validation, before the transaction |
| **400** | **`businessDay > branchCurrentBusinessDay`** — *Future business days are not supported.* | **NEW (§5).** Raised inside the transaction, after the branch calendar is known |
| **401** | missing/invalid token; **also a POS/PIN session** | dashboard-only |
| **403** | no active tenant context | `TenantContextGuard` |
| **403** | missing `report.view.sales` **or** `report.view.financial` | `mode:'all'`; **the missing code is not named** |
| **403** | tenant has **0** operative branches | in-transaction (§8), fail-closed |
| **403** | tenant has **>1** active branch | in-transaction (§8) |
| **403** | `branchId` ≠ the single operative branch, branch visible in this tenant | in-transaction (§8); 403 not 404 — it exists in the caller's own tenant |
| **404** | branch id unknown **or** cross-tenant | *Branch not found.* — **byte-identical** for both |
| **409** | **>1 observed transaction currency** across completed orders and branch-day payments (§6 case C) | **CORRECTED trigger.** A branch currency change alone **no longer** produces this. |
| **409** | a contributing session's currency disagrees with the observed transaction currency | **Defence in depth** over `sales-payment.service.ts:228`; must be unreachable, asserted by test |
| **409** | Treasury returns fewer sessions than the id set supplied | internal invariant breach surfaced honestly; must be unreachable, asserted by test |

**Ordering matters and is specified:** 404 (branch invisible) precedes 403
(branch shape), which precedes 400 (future day), which precedes 409 (currency).
A caller must never learn a foreign tenant's branch shape from an error
ordering.

**Never leaked:** whether a branch id exists in another tenant; which of the
two permissions is missing; any other tenant's data on any path.

---

## §15. MIGRATION DECISION — RE-CONFIRMED

> # **NO MIGRATION EXPECTED**
>
> Zero tables, zero columns, zero enums, **zero indexes**. Migration count
> stays at **34**.

The corrections add three query shapes to the original gate's four. All three
were `EXPLAIN`ed this session as `ros_app` inside `BEGIN … ROLLBACK`, and all
three are index-driven with **existing** indexes:

**Plan 5 — span detection** (`businessDayCount`, §3.3)

```
GroupAggregate  Group Key: cash_session_id
  -> Index Scan using order_payments_tenant_cash_session_idx on order_payments
       Index Cond: (tenant_id = $1) AND (cash_session_id = ANY ($2))
```

**Plan 6 — observed currency set** (§6)

```
Unique
  -> Index Scan using orders_2026_08_tenant_id_branch_id_business_day_idx on orders_2026_08
       Index Cond: (tenant_id = $1) AND (branch_id = $2) AND (business_day = $3)
       Filter: (state = 'completed')
```

**Plan 7 — open-order blocker count** (§4.2 B1)

```
Aggregate
  -> Index Scan using orders_2026_08_tenant_id_branch_id_business_day_idx on orders_2026_08
       Index Cond: (tenant_id = $1) AND (branch_id = $2) AND (business_day = $3)
       Filter: (state = ANY ('{draft,open,held,parked,partially_paid}'))
```

The payment-currency set adds no statement — it is `currency` added to the
existing tender `GROUP BY` (plan 2B).

**Cardinality disclosure, restated:** the dev DB holds 2,407 orders / 1,958
lines / 158 payments / 479 sessions / 110 close attempts — far too small for
cost numbers to be predictive. **No conclusion rests on them.** The conclusions
rest on **access paths**, determined by index definitions and therefore
cardinality-independent: an index whose leading columns match the predicate is
usable at any volume; one whose leading columns do not, is not.

The `order_payments(tenant_id, branch_id, business_day)` index the POST-KDS
report anticipated remains **NOT needed and NOT created** — the orders-first
join, proved complete by the branch-inclusive FK
`order_payments_tenant_id_order_id_business_day_branch_id_fkey`, serves every
tender query without it.

---

## §16. CORRECTED DEFINITION OF DONE — DELTAS

The original gate's 29 DoD criteria stand, with these changes:

**Amended**

| # | Original | Corrected |
|---|---|---|
| 8 | *"no category-(b) deviation is added; the plumbing question resolved by (i) or (ii)"* | **`KNOWN_DEVIATIONS` growth is ZERO. No new allow-list key of any kind. HTTP/auth plumbing comes exclusively from `identity/contract`. No boundary test weakened or skipped.** |
| 17 | *"`variance` summed over `status='closed'` only"* | **No day-level variance, expected/counted or movement total is emitted at all.** Whole-session facts carry `scope: "WHOLE_SESSION"`, `businessDayCount` and `spansMultipleBusinessDays`. |
| 19 | *"`dataAsOf` = `SELECT now()` inside the RR transaction … the snapshot instant"* | **`dataAsOf` = `transaction_timestamp()` inside the RR transaction — a stable transaction-scoped marker bounding the snapshot from before. No snapshot-equivalence claim in code comments, OpenAPI, or report.** |
| 20 | *"§16 Option C guard implemented"* | **No guard. Branch existence, single-active-branch assertion, current business day and `dataAsOf` all execute inside the report's single RepeatableRead transaction.** |

**Added**

| # | Criterion |
|---|---|
| 30 | `businessDay > branchCurrentBusinessDay` ⇒ **400** *Future business days are not supported.* No `FUTURE` status value exists. |
| 31 | `currency` is the **observed transaction currency** when exactly one exists; `Branch.baseCurrency` **only** when the day has no money-bearing fact; `currencySource` states which. A branch currency change **must not** break a historically coherent past day. |
| 32 | `periodStatus` blockers are exactly `openOrderCount` and `unclosedContributingSessionCount`; a zero-payment session is **not** a blocker; the field is named `unclosedContributingSessionCount`. |
| 33 | The response **must not** be described anywhere as providing FR-FIN-021's blocking-session list. §19.3 *Cash Reconciliation* is documented **PARTIAL** in the OpenAPI description. |
| 34 | `averageOrderValue` is present **iff** DECISION 3 is ratified; otherwise the key is **absent** — never null, zero, or a silent net default. |
| 35 | No code comment, OpenAPI description, report or register text asserts a forward constraint on `orders.grand_total`; the §11 revisit trigger is recorded instead. |

**Unchanged and non-negotiable:** clean scratch database + full suite green
before acceptance; migration count **34**; OpenAPI regenerated; `EXPLAIN`
evidence re-captured post-implementation with **no seq scan on
`sales.order_payments`**.

---

## §17. CORRECTED TEST DESIGN — DELTAS

The original gate's plan stands, with these changes.

**REMOVED** (the assertion no longer exists)
- *"`varianceTotal === Σ variance over status='closed'`"* — there is no
  `varianceTotal`.

**ADDED — Correction A**
- A session whose payments span two business days appears in **both** days'
  reports with `businessDayCount === 2` and `spansMultipleBusinessDays === true`.
- **`cashReconciliation` exposes NO day-level `varianceTotal`, `payInTotal`,
  `payOutTotal`, `safeDropTotal`, `expectedCashTotal` or `countedCashTotal`** —
  asserted by **key absence**.
- **`cashReconciliation.scope === "WHOLE_SESSION"`** on every response.
- A session with zero payments on the day is **absent** from `sessions` and is
  **not** counted in `contributingSessionCount`.
- **The double-count regression test:** one spanning session with a variance,
  two adjacent business days — the same variance value appears **once per
  session row per day**, and **no day-level total exists to sum it into**.

**ADDED — Correction B**
- A past day with an open order ⇒ `UNSEALED`, `openOrderCount > 0`.
- A past day whose only issue is an **unclosed contributing** session ⇒
  `UNSEALED`, `unclosedContributingSessionCount > 0`.
- **A past day with an unrelated open session that captured NO payment on that
  day ⇒ `SETTLED`** — the zero-payment-session non-blocker proof (§4.3).
- A `closing` contributing session is a blocker exactly as an `open` one is.
- `SEALED` is never emitted, across every fixture.

**ADDED — Correction C**
- `branchCurrentBusinessDay + 1 day` ⇒ **400**, message
  `Future business days are not supported.`, **no report body**.
- `branchCurrentBusinessDay` ⇒ **200**, `periodStatus === 'OPEN'`.
- A far-future day ⇒ **400**, not an all-zeros `OPEN` report.
- The comparison uses the **branch's** current business day, not the server's
  UTC calendar date (branch in a non-UTC zone, near its cutover).

**ADDED — Correction D**
- **The regression this correction exists for:** a day fully denominated in
  currency X; the branch's `base_currency` is then changed to Y; **the past day
  still returns 200 with `currency === "X"` and `currencySource === "TRANSACTION"`.**
  *(This test fails against the original design.)*
- A day with **no** completed orders and **no** payments ⇒ 200, all zeros,
  `currency === Branch.baseCurrency`, `currencySource === "BRANCH_FALLBACK"`.
- Two currencies observed across the day's orders/payments ⇒ **409**, **no
  partial total emitted**.
- A contributing session whose currency disagrees ⇒ **409** — and a companion
  test proving the capture path (`sales-payment.service.ts:228`) makes it
  unreachable.

**ADDED — Correction E**
- `KNOWN_DEVIATIONS['reporting->*']` is `undefined` for **every** module key.
- `violations.filter(v => v.importer === 'reporting')` is `[]`.
- No reporting source file's import lines contain `identity/auth/`,
  `identity/authz/` or `identity/context/`.
- The reporting module contributes **no Prisma model and no migration**.

**ADDED — Correction F**
- Branch existence, the single-active-branch assertion, `currentBusinessDay`
  and `dataAsOf` all execute inside the **same** transaction as the facts —
  asserted by instrumentation (one `withAuthContext` invocation per request),
  not by inspection.
- **TOCTOU:** a second branch activated concurrently produces either a
  consistent 200 (pre-activation snapshot) or a consistent 403 — **never** a
  200 report assembled under a two-active-branch shape.
- Multi-branch tenant ⇒ **403** for **both** branch ids.
- Zero active branches ⇒ **403**. One-branch positive control ⇒ **200**.

**ADDED — §9 / §10**
- `dataAsOf` is identical whether read at the start or end of the transaction,
  and is **not** the application clock.
- If DECISION 3 is unratified, `averageOrderValue` is **absent from the
  response** — asserted by key absence, not by null.

**Unchanged and still required:** the 90-due / 100-tendered / 10-change case
returning **90**; `Σ tender.amountTotal === grossSales + unsettledCapturedTotal`;
`Σ byClass[].taxAmount === taxTotal`; `byRate` absent; idempotent-replay
non-duplication; a second close attempt being impossible
(`uq_csca_one_per_session`); cross-tenant isolation on every section; **no
N+1** (statement count bounded and independent of order/payment/session
counts); **no seq scan on `order_payments`**.

---

## §18. FINAL USER RATIFICATION PACKET

**Three decisions. No fourth.** The branch fail-closed posture is **not** added
as a user decision: §8 found **no governance contradiction** — it grants
nothing, lifts nothing, relaxes nothing, is strictly more restrictive than
every existing read route, and follows the KDS-R11 consequence-note precedent
that recorded a structurally identical guard as *"engineering mechanics, not a
separate business decision."*

---

### DECISION 1 — Report permission codes

**Proposed ratification text:**

> **Two new permission codes are introduced: `report.view.sales`, described as
> *"View sales reports"*, and `report.view.financial`, described as *"View
> financial reports"*.**
>
> 1. They instantiate SRS §15.2's own template **`report.view.<category>`**,
>    with the categories taken verbatim from §19.3's report-catalogue headings
>    (*Sales Reports*, *Financial Reports*). §15.2 states it is *"representative
>    rather than exhaustive; the full catalogue is maintained in **Appendix
>    C**"*, and **Appendix C is absent from the delivered SRS** — the same
>    absence **D-20 clause 6** records as making a code *"NOT derivable"*, and
>    which `treasury.controller.ts:125-126` already records in code as
>    *"`report.view.<category>` unenumerated"*.
> 2. **BOTH are required together** (`mode: 'all'`, AND) on the single
>    composite daily-trading report route, because its response spans two §19.3
>    categories: *Sales Summary* and *Sales by Tender* are **Sales** reports;
>    *Cash Reconciliation* and *Tax Summary* are **Financial** reports.
> 3. They authorise **exactly** the read surface
>    `GET /reports/branches/{branchId}/daily-trading/{businessDay}` and nothing
>    else.
> 4. **They carry NO branch scope** and must never be relied on for it. Branch
>    safety is the separately enforced fail-closed assertion, exactly as
>    **KDS-R11 §6** separates `kds.operate` from station scope.
> 5. **No other permission is broadened.** Every existing code keeps its exact
>    pre-ratification scope.
> 6. **PROVISIONAL under ADR 0008 D-01**: if Appendix C is ever supplied and
>    names these categories differently, remap per D-01 — the route the
>    Catalogue and Organisation `.read` codes already record verbatim.
>    Recording that route does not make this ratification provisional.
> 7. **Authorization is permission-based. Do NOT hardcode role-name strings.**

**Alternatives tabled:** (A) `report.view.sales` alone — under-gates Financial
content; (B) `report.view.financial` alone — under-gates Sales content;
(D) `report.view.daily_trading` — **not a §19.3 category**, more invention for
less truth; (E) split into two routes with one code each — viable fallback,
but costs the single-snapshot property (§8) and doubles the surface.

**RECOMMENDATION: BOTH, required together (AND).**

**Future role intent — recorded, NOT implemented, NOT seeded:** Owner,
Operations Director, Branch Manager, Accountant and Auditor plausibly hold
both; **Brand Manager** (*"Menu, pricing, reports; no financial approval"* — an
approval restriction is not obviously a read restriction) and **Shift
Supervisor** (§15.3 is silent on reports) are **flagged open and deliberately
not resolved** — no role-seeding mechanism is being built, so they are not yet
live questions. Cashier, Waiter, Kitchen Staff, Head Chef and Storekeeper hold
neither.

**NOT authorized by this decision:** `report.export` (§18 of the original gate
— no export, no executable consumer); any `report.view.*` code for Inventory,
Kitchen, Workforce or Governance; any role seeding or grant; any drill-down,
export or dashboard route; any broadening of `pos.order.create`,
`inventory.view`, `inventory.cost.view` or any `cash.*` code.

---

### DECISION 2 — Internal-MVP sequencing / scope ratification

**Proposed ratification text:**

> **The Internal-MVP daily-trading read surface is authorised to be built now
> — query-time aggregation over the transactional primary — while
> `FR-RPT-001`, `FR-RPT-002`, `FR-RPT-003` and `FR-RPT-005` remain, and are
> recorded as, NOT IMPLEMENTED.**
>
> 1. This is **NOT a waiver**, **NOT a reinterpretation**, and **NOT a claim of
>    completion**. All four remain open, unmet `[M]` requirements counted
>    against the Reporting domain.
> 2. **No artefact produced by this slice** — report, register entry, INDEX
>    row, code comment or OpenAPI description — may state or imply
>    *"FR-RPT-001/002/003/005 waived"* or *"…complete"*.
> 3. **No Analytics warehouse is authorised**: no read replica, no star schema,
>    no `fact_*`/`dim_*` table, no rollup, no report cache, no export pipeline.
>    The reporting module owns **zero tables and zero migrations**.
> 4. `FR-RPT-004` **is** delivered in full (§9 / §4).
> 5. `FR-RPT-042` (drill-down) and `FR-RPT-043/044` (export + export audit)
>    remain **NOT IMPLEMENTED**.
> 6. `FR-FIN-010` advances from PARTIAL to a **larger PARTIAL** — the per-day
>    half for the two implemented tenders. *"Each card scheme"* and the nine
>    unimplemented tender types remain **NOT SATISFIED**.
> 7. §19.3 *Cash Reconciliation* is delivered as **PARTIAL** (§3.5) —
>    zero-payment and movement-only sessions are not attributable to a business
>    day, and no anchor is invented for them.
> 8. **`FR-FIN-020…026` (DayClose / Z report) are NOT advanced**, and this
>    slice does **not** provide FR-FIN-021's blocking-session list.
> 9. **D-2, D-20, KDS-R11 and CARRIED ITEM P1C-1 are untouched and not
>    reopened.**

**Alternative:** decline — the Internal MVP ships with no aggregated read
surface, the P4 exit criterion *"a manager can read yesterday's trading"* stays
unmet, `FR-FIN-010` stays at its current PARTIAL, and **DayClose stays
unbuildable** because FR-FIN-022's Z-report content has no aggregation layer to
draw on. The only other route is building §19.2's replica + star schema +
rollups first — the full Reporting domain, currently 0% and post-MVP.

**RECOMMENDATION: authorise.** Structurally identical to the accepted
`FR-SEC-032` posture — knowingly unmet, recorded as such, not concealed.

---

### DECISION 3 — `averageOrderValue` numerator

**Proposed ratification text:**

> **`averageOrderValue` is defined as `netSales ÷ completedOrderCount`, rounded
> HALF_UP to minor units (`divideRounded`, BR-FIN-001), and `null` when
> `completedOrderCount` is zero.**
>
> The SRS names AOV in five places and **defines a formula in none of them**;
> repository source is silent. **Net** is selected because §13 makes Net Sales
> the SRS's canonical revenue measure in every ratio it defines
> (`Food Cost % = COGS ÷ Net Sales`, `Prime Cost % ÷ Net Sales`,
> `Sales per Labour Hour = Net Sales ÷ Hours`), and FR-CST-035's ledger
> produces *"= Net Sales (excl. tax)"* as the revenue line.

**Alternatives:** (B) `grossSales ÷ completedOrderCount` — tax-inclusive basis;
(C) omit the field.

> **NO DEFAULT. If this decision is not answered, `averageOrderValue` is
> OMITTED from the response** — the key absent, not null, not zero, not
> silently net-based. Silence does not manufacture governance (§10).
> `grossSales`, `netSales` and `completedOrderCount` all ship regardless, so a
> client can compute either basis itself.

**RECOMMENDATION: A — NET.**

**NOT authorized:** any other derived ratio (food cost %, prime cost %, margin,
items-per-order, upsell rate); any COGS exposure (§7.10 of the original gate —
it would silently widen `inventory.cost.view`).

---

### Explicitly NOT put to the user

Branch fail-closed mechanics (§8 — engineering safety, KDS-R11 precedent, D-2
untouched, no governance contradiction found) · gross/net definitions (decided
by **FR-CST-003 `[M]`**) · session-to-day attribution (forced by the absence of
a `business_day` column and the mutability of `timezone`) · the removal of the
day variance total (a double-counting defect, not a preference) ·
`periodStatus` vocabulary · future-day 400 · the historical-currency rule ·
module ownership, DI wiring and contract paths · transaction isolation level ·
the migration/index decision (settled by `EXPLAIN`; the answer is **no
migration**) · SQL shapes, DTO formatting and route filenames.

---

## §19. REQUIREMENT CLASSIFICATIONS — UPDATED

### Changed by this correction

| Item | Original gate | Corrected |
|---|---|---|
| §19.3 *Cash Reconciliation* | **DELIVERED** | **PARTIAL** — exact for payment-contributing sessions; zero-payment and movement-only session attribution **NOT IMPLEMENTED** (§3.5) |
| **FR-FIN-021** | implied *"exactly"* satisfied by `unclosedSessionCount` | **NOT IMPLEMENTED** — claim withdrawn (§3.6). The report sees only payment-contributing sessions. |

### Unchanged

| Req | Pri | Status |
|---|---|---|
| **FR-RPT-004** | `[M]` | **COMPLETE** — `dataAsOf` (§9) + three-state `periodStatus` (§4) + explanatory counts |
| **FR-FIN-010** | `[M]` | **PARTIAL — advanced.** Per-day half delivered for the two existing tenders; *"each card scheme"* and the nine unbuilt tenders **NOT SATISFIED** |
| §19.3 *Sales Summary* · *Sales by Tender* | — | **DELIVERED** (Internal-MVP form) |
| §19.3 *Tax Summary* | — | **PARTIAL** — by class + period; **by rate NOT IMPLEMENTED**; by jurisdiction partial |
| **FR-RPT-001 / 002 / 003 / 005** | `[M]` | **NOT IMPLEMENTED** — never *"waived"*, never *"complete"* |
| **FR-RPT-030…034 · 040/041 · 045/046 · 047** | mixed | **NOT IMPLEMENTED** |
| **FR-RPT-042** | `[M]` | **NOT IMPLEMENTED** — `GET /orders` has no `businessDay`/`state` filter and is gated by `pos.order.create` |
| **FR-RPT-043 / 044** | `[M]` | **NOT IMPLEMENTED** — no export, no `report.export` |
| **FR-FIN-020…026** | `[M]`/`[S]` | **NOT IMPLEMENTED** — DayClose / Z report untouched |
| **FR-AUD-008** | `[M]` | **NOT IMPLEMENTED** — D-20 clause 9 stands |
| **FR-SEC-002 / 003 / 004** | `[M]` | **NOT IMPLEMENTED** — D-2 defer in force; §8 neither implements nor implies branch-scoped RBAC |
| **FR-CST-003** | `[M]` | **NOT CLAIMED** — COGS deliberately excluded |
| **NFR-PERF-010/011/012 · NFR-DATA-002** | `[M]` | **NOT MEASURED, NOT CLAIMED** |

---

## §20. VERDICT

> # **A. REPORTING DESIGN CORRECTION CLEAN — READY FOR USER RATIFICATION**

**Not B** — the Cash Reconciliation double-count is eliminated by **removing**
the day-level aggregate rather than relabelling it; whole-session scope is
declared on the wire; `businessDayCount` makes every spanning session visible
per row; the classification is corrected **downward** to PARTIAL; and
`periodStatus` blockers are re-derived from what can change *this report's own*
figures, with the zero-payment-session case proved non-blocking from the
server-clock business-day derivation.

**Not C** — currency now comes from the immutable transaction snapshots the
money is actually denominated in, with the branch's current currency used only
where no monetary fact exists to contradict it. A legitimate branch currency
change no longer breaks a historically coherent past day, and the regression
test for it is specified. **FR-RPT-005 is not claimed solved.**

**Not D** — the TOCTOU window is closed by moving every DB-derived branch fact
into the report's own RepeatableRead transaction and **removing** the guard
entirely. **D-2 remains untouched**; no governance contradiction was found, so
no fourth ratification is created.

**Not E** — HEAD, branch, working tree and migration count re-verified
unchanged at the start and end of this session.

**Next step:** ratify §18's three decisions. Implementation is authorised only
afterwards, and only within §16's corrected Definition of Done.

---

*End of correction report. The original design gate is preserved unmodified at
`docs/reports/claude/2026-08-31_MINIMUM-reporting-final-design-gate.md`.*

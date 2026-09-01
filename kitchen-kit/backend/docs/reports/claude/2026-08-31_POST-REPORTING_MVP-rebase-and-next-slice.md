# POST-REPORTING — Internal MVP Rebase & Next-Slice / DayClose Readiness Gate

| Field | Value |
|---|---|
| **Task / slice name** | POST-REPORTING Internal-MVP rebase + next-slice selection + DayClose readiness gate |
| **Report type** | Analysis / rebase / design-gate selection. **No implementation.** No migration, no schema change, no route, no permission, no governance edit, no OpenAPI regeneration, no commit, no push, no deploy. |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report records what was verified **in this session** against the repository at the HEAD below. It ratifies nothing, decides nothing, and creates no scope. Where it disagrees with an earlier report, **current source is the reason**, and the disagreement is stated explicitly in §4. |
| **Date** | 2026-08-31 |
| **HEAD** | `7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c` — *feat: add minimum operational reporting* |
| **Parent** | `38e007b0cd285679fc7fd334aec54d3bf2a8006c` — *feat: complete KDS operator lifecycle* |
| **Branch** | `feat/production-spec` |
| **Working tree** | Dirty **only** in `docs/reports/claude/`: one modified `INDEX.md` (4 unstaged rows) plus the four untracked pre-existing unrelated reports. **Zero** source / schema / migration / test / OpenAPI drift. Untouched by this task except the one INDEX row it appends. |
| **Task identifier** | POST-REPORTING_MVP-rebase-and-next-slice |
| **Status** | COMPLETE |
| **Migrations** | 34 — unchanged. None created, modified or planned into existence by this task. |
| **Tests** | **No test suite was executed in this session.** Test files and prior accepted results are cited as structural/historical evidence only; **no prior run's results are restated as newly executed.** |

---

## §0. VERDICT

> # **A. POST-REPORTING MVP REBASE CLEAN — NEXT SLICE SELECTED**
>
> ## **NEXT SLICE: DAY CLOSE (`FR-FIN-020 … 026`, Treasury).**
>
> DayClose is **NOT governance-blocked**. It is the only remaining
> protected-path gap whose governing authority says *"remains a separate slice
> **with its own design gate**"* (RPT-R2 clause 10) rather than *"is excluded"*.
> Receipt remains affirmatively excluded by **CARRIED ITEM P1C-1**; branch-scoped
> authorization remains affirmatively deferred by **D-2**. Neither is selectable.
>
> **Its permission is SOURCE-DECIDED** — `cash.day.close`, SRS §15.2, already
> named verbatim in `treasury.permissions.ts` as *"seeded by the slice that
> implements it"*. This is the **first** slice since Fire that needs **no
> permission ratification**.
>
> **DESIGN GATE REQUIRED: YES.** One question dominates it and is a **user
> decision, not an engineering one**: **five of `FR-FIN-022`'s thirteen mandated
> Z-report fields still cannot be produced** (§6.L). Sealing a permanently
> immutable, per-branch-sequentially-numbered Z with five unfillable columns is
> the exact failure the POST-KDS rebase warned against, and it must be decided
> deliberately — not discovered during implementation.

---

## §1. BASELINE VERIFICATION

Commands executed **first**, in this session:

```
git rev-parse HEAD
git rev-parse HEAD^
git log -2 --oneline
git branch --show-current
git status --short --untracked-files=all
```

| Expectation | Observed | Verdict |
|---|---|---|
| HEAD `7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c` | identical | ✅ |
| Subject `feat: add minimum operational reporting` | identical | ✅ |
| Parent `38e007b0cd285679fc7fd334aec54d3bf2a8006c` | identical | ✅ |
| Branch `feat/production-spec` | identical | ✅ |
| Dirty = `M INDEX.md` + exactly 4 untracked pre-existing reports | identical | ✅ |
| No source / schema / test / OpenAPI drift after HEAD | `git status` returns **nothing** outside `docs/reports/claude/` | ✅ |

The four untracked reports —
`2026-08-26_MVP_current-state-and-next-slice.md`,
`2026-08-27_RENDER_empty-db-demo-provisioning-check.md`,
`2026-08-28_P1G1_cash-close-design-gate.md`,
`2026-08-28_POST-P1F2_MVP_next-slice-rebase.md` — and their four unstaged
`INDEX.md` rows were **not** modified, staged, deleted or "tidied".

Corroborating structural facts verified this session:

- `ls -d prisma/migrations/*/ | wc -l` → **34**.
- `docs/api/openapi.json` → **110 paths** (109 at `38e007b`, +1 for
  `GET /reports/branches/{branchId}/daily-trading/{businessDay}`).
- No `day-close`, `day`, `z-report` or `x-report` path exists anywhere in the 110.

> ### **BASELINE: TRUSTWORTHY. No baseline blocker. (Not verdict E.)**

---

## §2. AUTHORITY ORDER APPLIED

1. **`ROS_SRS_v1.0.pdf`** — extracted to text and read directly this session:
   §1 glossary (*Business Day*, *X Report*, *Z Report*), §5.5.4 event catalogue,
   §7.3 aggregate table (#28 CashSession, #29 DayClose), §8.7/§8.8
   (`FR-POS-090…097`, `FR-POS-100…106`), §15.2 permission catalogue (Cash
   family), §16.2–16.6 (`FR-FIN-001…034`), §19 Reporting, §24.6.4 Optimistic
   Concurrency, §25.1 schema organisation, §26.5 (`FR-API-020…023`), `FR-SEC-001…005`.
2. **`docs/governance/GOVERNANCE_DECISION_REGISTER.md`** (7,577 lines) — read at
   its DayClose-relevant clauses: the Approval Runtime *"Not decided by this
   entry"* list, the P1G-1 *"Not decided by this entry"* list, **RPT-R1/R2/R3**
   in full, the branch fail-closed consequence note, and the Final Decision
   Matrix bullet.
3. **The repository at `7bc5d2c`** — Prisma schema, 34 migrations, the generated
   OpenAPI, the approved `ROS_DrawDB_Compatible_v3.sql`, and every module source
   cited below by path and line.
4. FINAL-ACCEPTED closure reports (Reporting ×1 closure + 5 antecedents, KDS ×3,
   P1G-1 ×7, P1G-0, Approval Runtime, P1F-2, Payment, Fire).
5. `2026-08-31_POST-KDS_MVP-final-rebase-and-next-slice.md` — **historical
   evidence only**; corrected in §4 where current source contradicts it.

**Executable code at `7bc5d2c` wins over every implementation-status prose claim,
in both directions.** Two prior classifications are corrected *upward* in §4.

---

## §3. THE PROTECTED INTERNAL-MVP PATH, RECONSTRUCTED AT `7bc5d2c`

| # | Edge | Status | Executable evidence |
|---|---|---|---|
| 1 | PIN | **COMPLETE** | `POST /auth/pin`; `identity/employees/pin.service.ts` |
| 2 | Terminal | **COMPLETE** | terminal taken from the session, never the body (`orders.controller.ts:805-826`) |
| 3 | CashSession open (if required) | **COMPLETE** | `POST /cash-sessions`; one-open-session partial unique index |
| 4 | Order | **COMPLETE** | `POST /orders`; `@Idempotent`; `OrderNumberBlock`; partitioned `sales.orders` |
| 5 | Priced / taxed lines | **COMPLETE** | `POST /orders/{bd}/{id}/lines`; `PriceResolutionService`; per-line tax; BR-POS-004 snapshots |
| 6 | Fire | **COMPLETE** | `POST /orders/{bd}/{id}/fire`; `order.line.fired` |
| 7 | KDS | **COMPLETE** | `GET /kds/stations/{id}/queue` behind `KdsStationGuard` |
| 8 | Kitchen bump → Sales ready | **COMPLETE** | `ticket.bumped` → `TicketBumpedHandler`, same transaction |
| 9 | Payment | **COMPLETE** | `POST /orders/{bd}/{id}/payments`; cash + `manual_external_card` |
| 10 | Completion | **COMPLETE** | settling payment ⇒ `completed` + `order.completed`, same `UnitOfWork` |
| 11 | Inventory depletion / COGS | **COMPLETE** | `SaleDepletionCommand`; `posted_cogs_total`/`cogs_total`, same transaction |
| 12 | **Receipt** | **BLOCKED** | Nothing. Affirmatively excluded — §5.1 |
| 13 | CashSession close | **COMPLETE** | `close-context` → `close` → `close/finalize` (manager PIN) |
| 14 | **Daily Trading Report** | **COMPLETE** | `GET /reports/branches/{branchId}/daily-trading/{businessDay}` — **NEW at this HEAD** |
| 15 | **DayClose** | **NOT IMPLEMENTED** | Nothing. **Selectable — §6, §18** |
| 16 | Manager exit | **PARTIAL** | Depends on 15; also on branch-scoped read isolation (D-2), which gates *exit*, not function |

> ### **EXACTLY TWO missing executable edges remain: 12 (Receipt) and 15 (DayClose).**
> Edge 14 closed at this HEAD. Edge 12 is **blocked**. **Edge 15 is the only open one.**

No production-hardening scope is expanded into anywhere above.

---

## §4. CORRECTIONS TO THE PRIOR (POST-KDS) REBASE

Recorded explicitly, because two of its statements are **factually wrong against
source that existed at its own HEAD**, and both are load-bearing for DayClose.

| Prior claim | Where | **Correction at `7bc5d2c` (and at `38e007b`)** |
|---|---|---|
| *"`FR-FIN-024` configurable day boundary — **ABSENT**. `branches.timezone` exists; **no boundary setting**."* | POST-KDS §8 table | **WRONG. `FR-FIN-024` IS IMPLEMENTED.** `org.operating_hours.business_day_cutover TIME DEFAULT '00:00:00'` exists (`prisma/schema.prisma:768`) and is consumed by `sales/orders/business-day.ts` — whose own docblock quotes `FR-FIN-024` verbatim — through `cutoverLookup()` + `resolveBusinessDay()`, used by **both** `OrdersService` (order creation, `orders.service.ts:224`) and Sales' `currentBusinessDay` contract. Verified present at `38e007b` too (`git show 38e007b:./prisma/schema.prisma \| grep -c businessDayCutover` → 1). **This removes a claimed DayClose prerequisite.** |
| *"discounts, refunds, **voids**, comps are structurally absent (no discount/comp/refund/**post-fire-void** mechanism)"* | POST-KDS §8 dependency analysis | **Half wrong. VOIDS ARE WRITTEN.** `order-lines.service.ts:571-576` performs `tx.orderLine.update({ state: 'voided', voidedBy: … })` on the **pre-fire** line-void path, with a `ck_order_line_void_reason` CHECK requiring a reason. *Post-fire* void is absent; the *ordinary pre-fire* void is not. **Comps remain genuinely structurally zero** — `isComp` defaults `false` and **no code path ever writes `state:'comped'`** (verified by exhaustive grep). So `FR-FIN-022`'s *"void and comp summary"* is **half-derivable**, not wholly absent. |
| *"DAY CLOSE … correctly sequenced AFTER minimum reporting"* | POST-KDS §8 verdict | **Confirmed and now discharged.** Reporting shipped; the sequencing condition is satisfied. |
| *"A Z report cannot be filled at this HEAD."* | POST-KDS §8 | **Materially improved, not eliminated.** Reporting now supplies **8 of `FR-FIN-022`'s 13** mandated fields (§6.K). **Five remain unfillable** (§6.L). The objection is *reduced*, not answered — and it is the gate's central question (§19). |
| OpenAPI *"109 paths"* | POST-KDS §5 row 33 | **110** at this HEAD. |

---

## §5. RE-AUDIT OF THE REMAINING MVP BLOCKERS

The prior rebase named four. **Reporting is now closed (§4).** The other three,
re-audited **from current source**, plus a scan for any newly-emerged blocker.

### 5.1 Receipt — `FR-POS-100…106`, `FR-LOC-022`

**Status: BLOCKED (unchanged).** Re-verified at this HEAD:

- 88 Prisma models; **no** `Receipt`, `TaxDocument`, `InvoiceTemplate`,
  `FiscalConfig`, `FiscalSubmissionAttempt`. The approved SQL defines
  `fiscal.tax_documents` / `invoice_templates` / `fiscal_configs` /
  `fiscal_submission_attempts`; **none migrated** across all 34 migrations.
- **Zero** receipt / document / print-job / reprint path among the 110.
- `country-pack.model.ts:34` — the pack models **`currency` + `tax` only**;
  §22.2's `invoice:` block and `legal.receiptFooter` are unmodelled, unparsed,
  unsigned.
- **CARRIED ITEM P1C-1** — *"Fiscal remains otherwise out of scope: no tax
  documents, invoice templates, fiscal submissions or `fiscal.tax_rules`"* —
  reaffirmed verbatim by the P1F-2 ratification (2026-08-25) and **left
  unchanged by RPT-R2 clause 13** at this very HEAD.

**Not selectable.** Not reopened by this report. **Remains a parallel blocker.**

### 5.2 DayClose — `FR-FIN-020…026`

**Status: NOT IMPLEMENTED — and now SELECTABLE.** Full audit in §6–§10.
Negative proof re-established at this HEAD:

| Element | Status | Evidence |
|---|---|---|
| Business-day **attribution of sales** | **EXISTS** | `orders.business_day` (partition key), `order_lines.business_day`, `order_payments.business_day`; `uq_order_number (branch_id, business_day, order_number)` |
| **`FR-FIN-024` boundary** | **EXISTS — CORRECTED (§4)** | `org.operating_hours.business_day_cutover`; `sales/orders/business-day.ts` |
| Business-day **lifecycle / branch-day state** | **ABSENT** | No `DayClose`/`BranchDay`/`BusinessDay` model among 88. Approved SQL's `treasury.day_closes` / `session_summaries` / `variance_reports` (`ROS_DrawDB_Compatible_v3.sql:1118-1137`) — **none migrated** |
| DayClose command / route | **ABSENT** | No path among 110; no service |
| Z report | **ABSENT** | Nothing |
| `cash.day.close` permission | **NAMED, DELIBERATELY NOT SEEDED** | `treasury.permissions.ts` docblock: *"`cash.drawer.open_no_sale` and `cash.day.close` remain deliberately NOT seeded — still no executable consumer for either."* **Each is seeded by the slice that implements it.** |
| `FR-FIN-021` blocking-session list | **ABSENT** | RPT-R2 clause 10: *"this slice does NOT provide `FR-FIN-021`'s blocking-session list"* |

### 5.3 Branch-scoped authorization — `FR-SEC-002/003/004`, D-2

**Status: BLOCKED by D-2 (unchanged).** Re-verified:

- `identity/context/tenant-context.ts:11-16` still declares `branchId`
  *"RESERVED — not populated this phase"*; `TenantContextService.resolve()`
  never assigns it on any path.
- `membershipRoles` are still loaded with a **role/tenant** predicate only;
  `identity.membership_roles.branch_id` exists and **is still never read**.
- `sales.permissions.ts` / `treasury.permissions.ts` both still state verbatim
  *"Authorization is TENANT-scoped. D-2's branch-scoped RBAC deferral stands —
  no handler consults `TenantContext.branchId`."*
- **RPT-R2 clause 13 and the branch fail-closed consequence note (2026-08-31)
  reconfirm D-2 in force at this HEAD**, and state explicitly that the
  Reporting posture *"reads a **tenant-shape** fact (`org.branches.status`),
  **never a principal's scope**"*, leaving `FR-SEC-002/003/004` **NOT
  IMPLEMENTED**.

**Not selectable.** Gates MVP **exit**, not MVP **function**.

### 5.4 Other candidates re-evaluated

| Candidate | Status | Is it a hard Internal-MVP blocker? |
|---|---|---|
| **Post-fire void / `FR-KDS-029`** | **DEFERRED MVP GAP** — `TicketLineStatus.cancelled`/`cancelledAt` exist; nothing writes them. `pos.order.void_line_postfire` still deliberately excluded: *"no ratified rule defines its approval semantics"* | **No.** Pre-fire void is implemented and is the ordinary correction path; depletion fires at **completion**, so an uncancelled fired line never depletes; UC-POS-01's main flow contains no cancellation |
| **`served` / Expediter (`FR-KDS-040`)** | **PARTIAL, safely deferred** — `'served'` is enumerated and tolerated in five places; **no code path writes it**. The protected path runs fire → ready → payment → completion | **No.** The accepted KDS slice is **not** reopened |
| **X report (`FR-POS-093`)** | **NOT IMPLEMENTED** — `GET /cash-sessions/{id}/close-context` is a close *pre-flight*, not an X report; the X-report permission is listed as undecided in the Approval Runtime entry | **No** for Internal-MVP function. **See §14** for its relationship to Z |
| **Tax by rate (`FR-FIN-032` breakdown)** | **NOT DERIVABLE** — only the component **sum** is persisted (`order_lines.tax_amount`); the accepted Reporting design gate proved this, not merely asserted it | **Not on its own** — but it is one of the five unfillable Z fields (§6.L) |
| **Discounts / refunds / comps / service charges** | **STRUCTURALLY ZERO** — no mechanism at this HEAD | **No** for function; **yes** as Z-content honesty (§6.L) |
| **`FR-FIN-007` adjusting entries** | **PARTIAL** (unchanged) | No |
| **`FR-FIN-010`** | **PARTIAL** (unchanged) — per-day half now delivered for the **two** implemented tenders; *each card scheme* and nine tender families **UNSATISFIED** | No |

> ### **No newly-emerged hard Internal-MVP blocker was found at this HEAD.**

---

## §6. DAYCLOSE — EXHAUSTIVE READINESS AUDIT

### Exact SRS text (§16.5, read directly this session)

> **`FR-FIN-020` [M]** — The System SHALL support a business-day close operation **per branch**.
> **`FR-FIN-021` [M]** — Day close SHALL be **blocked while any cash session remains open**, and SHALL **list the blocking sessions**.
> **`FR-FIN-022` [M]** — Day close SHALL produce a **Z report** containing: gross sales, discounts, refunds, net sales, **tax by rate**, **sales by category**, sales by tender, **sales by order type**, transaction count, average order value, **void and comp summary**, cash reconciliation, and **variance summary**.
> **`FR-FIN-023` [M]** — Z reports SHALL be **sequentially numbered per branch**, **immutable**, and **retrievable for any historical date**.
> **`FR-FIN-024` [M]** — The System SHALL support a **configurable business-day boundary per branch** (e.g. 04:00) …
> **`FR-FIN-025` [S]** — Day close SHALL be performable **automatically** at the configured boundary where the branch enables it, with any open sessions **force-closed and flagged**.
> **`FR-FIN-026` [M]** — Day close SHALL trigger: **fiscal document finalisation**, **inventory day-end snapshot**, **report pre-aggregation**, and **accounting export generation where configured**.

Related source read: §1 glossary (*Business Day*; *Z Report* = *"the terminal
report that closes a shift or business day and resets counters"*), §5.5.4
(`day.closed` — publisher **Treasury**; subscribers Analytics, Fiscal,
Reporting), §7.3 #29 (**DayClose · Treasury · SessionSummaries, VarianceReport ·
"All sessions closed before day close"**), §15.2 Cash (`cash.day.close` —
*"Close the business day"*), §19.3 Financial Reports (*Z Report — "Statutory day
close"*), §24.6.4, §25.1 (`treasury … day_closes`), §26.5 (`FR-API-020`).

---

### **A. What exactly is a DayClose aggregate/entity in ROS?**

An **aggregate root in the Treasury bounded context** (SRS §7.3 #29), containing
**`SessionSummaries`** and a **`VarianceReport`**, whose **key invariant** is
literally *"All sessions closed before day close"*. Its table lives in the
`treasury` schema (§25.1). The approved SQL gives it this exact minimal shape:

```
treasury.day_closes        (id, branch_id, business_day, closed_by, closed_at,
                            UNIQUE (branch_id, business_day))
treasury.session_summaries (id, day_close_id → day_closes ON DELETE CASCADE,
                            cash_session_id → cash_sessions)
treasury.variance_reports  (id, day_close_id → day_closes ON DELETE CASCADE,
                            total_variance BIGINT)
```

**What the approved SQL does NOT settle** (all therefore design-gate items):
no `tenant_id` (every Treasury table in this repository adds one plus composite
FKs per ADR 0008 D-09 — see `cash_sessions`, `cash_close_policies`,
`cash_session_close_attempts`); **no Z number column**; **no Z content
whatsoever**; `session_summaries` carries **no summary data at all**, only a
link; `variance_reports` carries **one** column.

### **B. State-changing command, immutable document, or both?**

**BOTH, and they are one aggregate.** `FR-FIN-020` names an *operation*
(state-changing, permissioned, audited, event-publishing); `FR-FIN-022`/`023`
require it to *produce* a document that is **immutable** and **retrievable for
any historical date**. The command's commit **is** the document's creation.
This matches the repository's own accepted precedent exactly:
`CashSessionCloseAttempt` is an append-only immutable declaration created by a
command, with `ros_app` holding `SELECT` + a column-level `INSERT` that excludes
`created_at`, and **no** `UPDATE`/`DELETE`.

### **C. Exact close precondition**

Source-decided:
1. `FR-FIN-021` — **no cash session of the branch remains open** (§D/§I).
2. §7.3 #29 invariant — *"All sessions closed before day close"*.
3. Structural — no DayClose already exists for `(tenant, branch, businessDay)`
   (the approved SQL's own `uq_day_close`).

**Source-SILENT but engineering-necessary** (design-gate item): whether the
business day must already have **ended**. Without it, trading that occurs after
the close but before the `FR-FIN-024` boundary lands in a **sealed** day's
partition (`orders.business_day` is server-derived at order creation and would
still resolve to the closed day). The natural, already-implemented predicate is
`businessDay < branchCurrentBusinessDay`, using the **same**
`resolveBusinessDay`/`cutoverLookup` the accepted Reporting slice already calls
— and it is exactly what `FR-FIN-025`'s "at the configured boundary" implies.

### **D. Must ALL branch CashSessions be closed?**

**YES — and the SRS says so without a business-day qualifier.**

`FR-FIN-021` reads *"blocked while **any** cash session remains open"*. It does
**not** say *"any cash session of that business day"*. §7.3 #29's invariant is
equally unqualified: *"All sessions closed before day close."* Scope is the
**branch**, because `FR-FIN-020` makes the operation per-branch.

**This is the single most consequential finding of the audit**, because it means
the FR-FIN-021 blocking predicate needs **no business-day anchor at all** — only
`treasury.cash_sessions.status` and `branch_id`, both of which exist and are
already indexed (`@@index([tenantId, branchId, status])`).

### **E. How are zero-payment / movement-only sessions attributed for `FR-FIN-021`?**

**Under §D's reading, they need no attribution to be blockers.** A zero-payment
session and a movement-only session are both *cash sessions of the branch*; if
either is not `closed`, the day is blocked. `status` answers it directly.

This is precisely the gap RPT-R2 clause 9/10 recorded: the accepted Reporting
Cash Reconciliation derives its session set **from the day's payments**
(`DailyTradingSalesFacts.contributingCashSessionIds`), so it **cannot see** a
zero-payment or movement-only session. **DayClose must therefore query
`cash_sessions` directly — which it may, because Treasury owns that table.**

Attribution *does* become necessary for the Z's **cash reconciliation** and
**variance summary** content (§6.L, §7).

### **F. Does current schema contain any immutable CashSession→businessDay anchor?**

**NO. Verified exhaustively against `prisma/schema.prisma` at this HEAD:**

| Table | `business_day` column? |
|---|---|
| `treasury.cash_sessions` | **NO** |
| `treasury.cash_session_close_attempts` | **NO** |
| `treasury.cash_count_denominations` | **NO** |
| `treasury.cash_movements` | **NO** |
| `treasury.cash_close_policies` | **NO** |
| `treasury.drawers` | **NO** |
| `workforce.shifts` | **NO** |
| `sales.orders` / `order_lines` / `order_payments` | **YES** (`DATE`, partition/FK key) |

Confirmed independently by two accepted artefacts: the Treasury contract docblock
(`daily-cash-reconciliation.query.ts`) and **RPT-R2 clause 9**, which records the
absence as ratified fact and states **"none is invented"**.

### **G. If not, does DayClose require a schema/migration to introduce one?**

**A migration is required — but NOT necessarily a session-open-time anchor.**
`treasury.day_closes` must exist at minimum. Whether a `cash_sessions.business_day`
column is *also* needed depends entirely on the §7 decision, and the recommended
option (§7 Option E) needs **none**. See §16.

### **H. Can DayClose safely derive session/day membership from `openedAt`/`closedAt` + mutable timezone?**

> ## **NO. Four independent proofs, none of which is an assumption.**

**(1) `org.branches.timezone` is UPDATABLE.**
`branches.service.ts:149-150` accepts `timezone` on update (`PATCH /branches/{id}`,
`update-branch.dto.ts:25`). Only `code` is documented as immutable. A timezone
change would **silently re-attribute every historical session**, directly
contradicting `FR-FIN-023`'s *"immutable, and retrievable for any historical
date"*.

**(2) The `FR-FIN-024` cutover is effectively mutable — and non-deterministic.**
`org.operating_hours` rows are creatable (`POST /branches/{branchId}/operating-hours`)
with **no unique constraint on `(branch_id, day_of_week)`** (only
`@@index([branchId, dayOfWeek])`). `cutoverLookup()` builds a `Map` by
`byWeekday.set(row.dayOfWeek, …)` over an **unordered** result set
(`business-day.ts:141-146`; no `ORDER BY` at either call site —
`orders.service.ts:203-207`, `daily-trading-sales.query.service.ts:56-58`).
**Adding a second row for a weekday changes, and can non-deterministically change,
the effective boundary.** *(Recorded as an observation about pre-existing accepted
code; this report neither fixes nor reopens it — see §19 Q13.)*

**(3) `closedAt` is NULL while the session is open.**
An open session has **no derivable end instant** — yet open sessions are exactly
`FR-FIN-021`'s blocking set. Derivation cannot classify the very rows the
requirement is about.

**(4) A session legitimately spans business days — proven reachable, not hypothetical.**
The accepted Reporting slice had to surface `businessDayCount` /
`spansMultipleBusinessDays` precisely because
`COUNT(DISTINCT order_payments.business_day) > 1` occurs, and the acceptance
correction **removed** a day-level variance total to avoid double-counting such a
session into two days. An `openedAt`-derived stamp would assign such a session to
**one** day while its money demonstrably belongs to **two**.

> **Expected answer confirmed — and proven, not asserted.** Timestamp derivation
> is unsound for a permanently sealed, sequentially numbered document.

### **I. Precisely which session set does DayClose need?**

**The blocking set (`FR-FIN-021`) is: every `treasury.cash_sessions` row of the
branch whose `status <> 'closed'` at the moment of close — regardless of
business day.** That is `status IN ('open','closing')`.

`closing` **must** count as blocking: it is the P1G-1 frozen state between an
above-tolerance immutable count declaration and its manager decision. It is not
closed; its variance is declared but unapproved. Treating it as non-blocking
would let a day seal over an unresolved cash variance — the exact accountability
failure `FR-FIN-006` exists to prevent.

**Not** "sessions opened during the business day". **Not** "sessions touching the
day". Neither is derivable (§H), and neither is what the requirement says.

**The attributed set** (which sessions this DayClose *summarises*, for
`session_summaries`, cash reconciliation and the variance summary) is a
**separate** question, answered in §7.

### **J. Z report minimum content required by `FR-FIN-022`**

Thirteen enumerated items, verbatim: **gross sales · discounts · refunds · net
sales · tax by rate · sales by category · sales by tender · sales by order type ·
transaction count · average order value · void and comp summary · cash
reconciliation · variance summary.**

Plus `FR-FIN-023`'s three properties: **sequentially numbered per branch ·
immutable · retrievable for any historical date.**

### **K. Which of that is NOW provided by accepted Reporting contracts?**

**8 of 13** — all from `DAILY_TRADING_SALES_QUERY` (Sales, `tx`-first) and the
accepted `DailyTradingReportView`:

| `FR-FIN-022` field | Available | Source |
|---|---|---|
| gross sales | ✅ | `DailyTradingSalesFacts.grossSales` (Σ completed `orders.grand_total`) |
| discounts | ✅ (structurally `0`) | `.discounts` |
| refunds | ✅ (literal `0n`) | `.refunds` |
| net sales | ✅ | `gross − discounts − refunds − tax` (`FR-CST-003`) |
| sales by tender | ✅ **PARTIAL** | `.cash`, `.manualExternalCard` — `FR-FIN-010` PARTIAL: two tenders only |
| transaction count | ✅ | `.completedOrderCount` |
| average order value | ✅ | RPT-R3: `netSales ÷ completedOrderCount`, HALF_UP, `null` at zero |
| cash reconciliation | ✅ **PARTIAL** | `DAILY_CASH_RECONCILIATION_QUERY` — **payment-contributing sessions only**, **WHOLE_SESSION** scope |

### **L. Which fields are STILL unavailable?**

> ## **FIVE of thirteen. This is the gate's central problem.**

| Field | Status | Why |
|---|---|---|
| **tax by rate** | ❌ **NOT DERIVABLE** | Only the `FR-FIN-032` component **sum** is persisted (`order_lines.tax_amount`). Reporting delivers tax **by class** only. `orders.country_pack_version` pins a version **string** with no pack code and no FK. Proven by the accepted design gate, not assumed |
| **sales by category** | ❌ **NO AGGREGATE EXISTS** | Data is reachable (`MenuItemPlacement` → `Category`) but no contract, query or route produces it |
| **sales by order type** | ❌ **NO AGGREGATE EXISTS** | `orders.order_type` exists and is indexed by nothing relevant; no aggregate is produced anywhere |
| **void and comp summary** | ❌ **HALF-DERIVABLE** (§4 correction) | **Voids ARE written** (`order-lines.service.ts:571`, pre-fire path, with `voidedBy` + reason CHECK) → a void summary **is** derivable. **Comps are structurally zero** — nothing writes `state:'comped'`. No aggregate exists for either |
| **variance summary** | ❌ **FORBIDDEN TODAY** | RPT-R2 clause 9 explicitly: **"NO day-level variance total is produced"**, because a spanning session would contribute its single whole-session variance to two days. Unblocked **only** by §7's attribution decision |

**Cash reconciliation is additionally PARTIAL**, per RPT-R2 clause 9: it sees
only payment-contributing sessions and reports **whole-session** figures.

> ### **Consequence, stated plainly:** a DayClose implemented today against the
> existing contracts would seal a **permanently immutable, per-branch-sequentially
> numbered** Z report in which **five of thirteen mandated `[M]` fields are absent
> or knowingly wrong**. That is exactly what the POST-KDS rebase warned against.
> **The gate must decide this deliberately (§19 Q1).** This report's
> recommendation is in §18.

### **M. Does Receipt/Fiscal need to exist before DayClose can close?**

> ## **NO.**

- **`FR-FIN-022` enumerates no fiscal field.** No TRN, no invoice sequence, no
  QR, no document reference appears in the Z's mandated content.
- **`FR-FIN-023`'s numbering is a Z number *per branch*** — not an invoice
  sequence, and structurally unrelated to §22.2's `pre_allocated_block` /
  `blockSize` / `voidUnusedOnExpiry` invoice strategy.
- **`FR-FIN-026`'s fiscal limb is vacuous, not blocking.** *"Day close SHALL
  trigger: fiscal document finalisation …"* — while **P1C-1** stands there are
  **zero** fiscal documents in existence to finalise. A trigger over an empty set
  is unsatisfiable-by-absence, not a precondition. The honest classification is
  **`FR-FIN-026` NOT IMPLEMENTED / PARTIAL**, recorded as knowingly unmet — the
  same posture `FR-SEC-032` and `FR-RPT-001/002/003/005` already occupy by
  ratification.

**All four `FR-FIN-026` limbs are unreachable at this HEAD**, and this must be
recorded rather than quietly satisfied: fiscal finalisation (P1C-1); **inventory
day-end snapshot** (no such command exists — `stock_levels` is a live projection,
there is no dated snapshot table); **report pre-aggregation** (`FR-RPT-002/003`
NOT IMPLEMENTED by RPT-R2); **accounting export** (`FR-RPT-043` NOT IMPLEMENTED,
and the clause is qualified *"where configured"*).

**Therefore: DayClose proceeds independently; Receipt remains a parallel blocker;
no governance decision about fiscal/receipt semantics is required to select or
gate DayClose.** *(Task §11's "return governance blocked" branch does **not**
apply.)*

### **N. Does the Z require fiscal numbering, or merely operational totals?**

**Merely operational totals.** See §M. The SRS glossary defines a Z Report as
*"the terminal report that closes a shift or business day and resets counters"* —
an operational instrument. §19.3 lists it under Financial Reports with key
content *"Statutory day close"*; "statutory" describes its **role**, not a fiscal
document format, and §22.2's fiscal machinery is a separate, excluded subsystem.

### **O. Is sequential Z numbering required now?**

**YES.** `FR-FIN-023` is **[M]** and unconditional: *"sequentially numbered per
branch"*. If `FR-FIN-022`/`023` are claimed at all, numbering ships with them.
Deferring it would mean sealing immutable documents that must **later** be
retro-numbered — impossible by definition.

**Source-silent (design-gate items):** whether the sequence must be **gap-free**;
whether it restarts per year; its rendered format.

### **P. Is DayClose itself sequentially numbered?**

**SOURCE-SILENT.** `FR-FIN-023` numbers the **Z report**, not the DayClose
record. The approved `treasury.day_closes` has **no number column**. Whether
DayClose and Z are **one artefact** (one row, carrying the Z number and the
snapshot) or **two** (a close record plus a numbered Z document) is a genuine
design-gate question with no source answer. `UNIQUE (tenant_id, branch_id,
business_day)` already gives DayClose a natural business key without a number.

### **Q. Is historical immutable retrieval required?**

**YES — `FR-FIN-023` [M]: "retrievable for any historical date".** This mandates
a **read route** in the slice. It does **not** mandate export/PDF (`FR-RPT-043`
remains NOT IMPLEMENTED by RPT-R2 clause 7).

### **R. Is automatic close required for Internal MVP?**

**NO — DEFERRABLE.** `FR-FIN-025` is **[S]**, not [M]. It additionally requires a
**scheduler**, which the register already records as a separately deferred
capability (D-12 is *"BLOCKED on three separately-deferred capabilities — a
scheduler, the settings resolver, and multi-step approval"*), plus a
**force-close-and-flag** semantics that no ratified rule defines. Recommend
**explicitly OUT of the slice, recorded as NOT IMPLEMENTED.**

### **S. What events must DayClose publish?**

**Exactly one, source-decided: `day.closed`.** SRS §5.5.4 — publisher
**Treasury**; principal subscribers **Analytics, Fiscal, Reporting**. Mechanism
and precedent already exist: Treasury publishes `cash.variance.detected` through
`UnitOfWork` / `ctx.publishEvent`, and the dispatcher tolerates zero registered
handlers (as it already does for `order.line.fired` and `order.opened`). The
mandatory §5.5.4 envelope applies. **No second event is invented.**

### **T. What audit entries are required?**

`FR-AUD-001` binds state-changing operations; a day close is unambiguously one,
and `FR-AUD-006`'s always-audit list covers financial finalisation. A **new
`AUDIT_ACTION` literal** is required (append-only, hash-chained
`governance.audit_entries`, advisory-locked chain — the existing mechanism).

**The literal itself is a mechanic, not a ratification** — the P1G-1 entry
records verbatim that *"the audit action literal"* is a *"Design-Gate /
implementation detail"*.

### **U. What permission is required? Source-enumerated or governance-silent?**

> ## **`cash.day.close` — SOURCE-DECIDED. No user decision required.**

SRS §15.2, **Cash** family, verbatim: **`cash.day.close` — "Close the business
day"**. It is already named in `treasury.permissions.ts`'s docblock among the
codes *"deliberately NOT seeded: this repository seeds a permission only where
an executable consumer exists … **Each is seeded by the slice that implements
it.**"*

**Classification: SOURCE-DECIDED.** This is a decisive contrast with every
recent slice — `pos.order.fire`, `pos.payment.capture`, `kds.operate` (KDS-R11)
and `report.view.sales`/`report.view.financial` (RPT-R1) each required an
explicit user authorisation because §15.2 did not enumerate them. **DayClose
needs no such authorisation.** No permission code is added by this report.

**Open (design-gate, not governance):** whether a `_other`-style or
force-close variant is needed — **no**, because `FR-FIN-025`'s force-close is
deferred (§R) and §15.2 supplies no such code.

### **V. Does `FR-API-020` require/allow `Idempotency-Key`?**

**REQUIRES it.** `FR-API-020` [M]: *"Every POST and PATCH SHALL accept an
`Idempotency-Key` header, and it SHALL be **mandatory on all financially
significant endpoints**."* Sealing a business day is financially significant
without argument. `FR-API-022` (identical fingerprint ⇒ stored response +
`Idempotent-Replay: true`) and `FR-API-023` (different fingerprint ⇒ 409) apply.

**Repository precedent is unanimous:** every Treasury POST carries `@Idempotent()`
(`treasury.controller.ts:341, 402, 440, 478, 567, 631`).

### **W. What transaction isolation / concurrency mechanism is source-consistent?**

**§24.6.4 verbatim:** *"Aggregates carry a version. Updates assert the expected
version and fail on mismatch … **Pessimistic locking is used only for
order-number allocation and count-session exclusivity.**"*

**But DayClose is an INSERT of a new aggregate, not an UPDATE of an existing
one — so expected-version OCC has nothing to assert against.** The
source-consistent mechanism is therefore:

1. **A unique constraint as the deterministic conflict** — the approved SQL's own
   `UNIQUE (branch_id, business_day)`, tenant-extended. Exact accepted precedent:
   `uq_ccp_branch_effective_from`, documented in-schema as *"the deterministic
   conflict for a concurrent same-branch, same-instant race — **no advisory lock
   needed**"*.
2. **Plus `pg_advisory_xact_lock`** for the read-then-allocate span, because a
   unique constraint protects the **row**, not the **blocking-session read** or
   the **Z-number allocation** that precede it. This is the repository's
   established serializer — used by `AuditService` (chain), `PinService`,
   `OrdersService` (order-number allocation), `CashMovementsService`,
   `CashSessionCloseService` (×2) and `SalesPaymentService`.

**SERIALIZABLE: NOT recommended, and it would be a first.** Verified this
session: **zero** occurrences of `Serializable` anywhere in `src/` outside the
generated Prisma client. The only elevated isolation in the repository is
`RepeatableRead`, used by the accepted Reporting read composite. Nothing about
DayClose exhibits a write-skew hazard that a unique constraint plus an advisory
lock does not already eliminate. **Do not reach for it without proving why.**

### **X. Can two concurrent DayCloses both succeed today?**

**Today: the question is vacuous — there is no table and no route.**
**Once `treasury.day_closes` exists with `UNIQUE (tenant_id, branch_id,
business_day)`: NO** — the second commit raises a unique violation and the
transaction rolls back whole. **Without that constraint: YES, trivially** — two
sealed Z reports for the same branch-day, each with its own number. **The
constraint is not optional.**

### **Y. What exactly blocks a repeated / replayed close?**

**Three independent layers, all with accepted precedent in this repository:**

1. **`UNIQUE (tenant_id, branch_id, business_day)`** — structural, database-level.
2. **`@Idempotent()` / `FR-API-020…023`** — a retry with the same key and
   fingerprint returns the stored response with `Idempotent-Replay: true`;
   a different fingerprint returns **409**.
3. **Append-only grants** — `ros_app` holding `SELECT` + a **column-level
   `INSERT` excluding `created_at`**, with **no `UPDATE`, no `DELETE`**. This is
   the pattern `governance.approval_decisions`, `treasury.cash_close_policies`
   and `treasury.cash_session_close_attempts` already use, and it makes
   `FR-FIN-023`'s immutability **DB-enforced rather than service-enforced**.

---

## §7. THE CASHSESSION → BUSINESS-DAY GAP

### What the gap actually is (narrowed by §6.D/E/I)

The accepted Reporting slice deliberately invented no anchor. Re-scoped against
`FR-FIN-021`'s literal text, the gap is **narrower than the task brief
anticipated**:

- **`FR-FIN-021`'s blocking list does NOT need an anchor** — `status <> 'closed'`
  for the branch answers it completely, including zero-payment and movement-only
  sessions (§6.D/E).
- **An anchor IS needed** for the Z's **cash reconciliation** and **variance
  summary** (`FR-FIN-022`) and for `session_summaries` — i.e. *which* sessions a
  given sealed day **owns**.

### Option comparison — source-first

| | **A** — `business_day` on `cash_sessions` at open | **B** — separate immutable attribution table | **C** — derive from `Shift` | **D** — derive from timestamps + current tz | **E** — **attribute AT close, via the approved `session_summaries`** |
|---|---|---|---|---|---|
| **Correctness** | ❌ **Wrong for spanning sessions** — one open-time stamp cannot represent money that provably belongs to two days | ✅ | ❌ | ❌ | ✅ **Correct by construction** — the session is owned by the close that sealed it |
| **Historical stability** | ✅ immutable | ✅ | ❌ | ❌ mutable tz + mutable cutover (§6.H) | ✅ immutable |
| **Module ownership** | Treasury ✅ | Treasury ✅ | ❌ `workforce.shifts` is another module's table, and **`ros_app` holds no `UPDATE` privilege on it** — a Shift has no close command at all (schema docblock, `prisma/schema.prisma:2206-2208`). **Not authoritative for anything** | Treasury but reads `org` config | Treasury ✅ end-to-end |
| **Migration complexity** | Column + **legacy backfill with no honest value** (the P1G-1 migration-compatibility closure recorded real pre-existing `open` and `closed` rows in the dev DB); a `NOT NULL` column would abort | New table not present in the approved SQL | none | none | **Table already defined in the approved SQL** (`treasury.session_summaries`) — plus one uniqueness constraint |
| **RLS** | standard | standard | n/a | n/a | standard (`day_close_id` inherits the parent's tenant scope) |
| **Existing session lifecycle** | Changes the **accepted** P1D-1 open path — the P1G-1 policy ratification (R-3(a)) went out of its way to add **no** column to `cash_sessions` at open | untouched | untouched | untouched | **untouched** — no change to open, movement, declare or finalize |
| **Cross-day sessions** | ❌ fails | ✅ | ❌ | ❌ | ✅ handled exactly: attributed to the close that sealed it, once |
| **Future offline behaviour** | ⚠️ an offline-opened session would carry a device-decided day | ⚠️ same | ❌ | ❌ | ✅ attribution is a **server-side, online** act at close — no device ever decides it |

### Recommended: **OPTION E** (source-backed, migration-honest)

Because `FR-FIN-021` requires **every** branch session to be closed before the
day can close, the set of sessions **not yet attributed to any prior DayClose**
is exactly and unambiguously the set the current DayClose seals. Record that set
in the approved SQL's own `treasury.session_summaries`, at close time, and add
**`UNIQUE (tenant_id, cash_session_id)`** so a session belongs to **at most one**
day close. That single constraint makes the partition of sessions across day
closes **total and disjoint**, structurally.

**Properties:** no `cash_sessions` column · no legacy backfill (pre-existing
sessions simply belong to no day close, which is the truth) · immutable by the
append-only grant pattern · correct for spanning sessions · Treasury-owned
throughout · and it is the **only** option whose table the approved SQL already
defines.

**The one caveat the gate must settle:** a session opened *after* a close but
still inside the same business day. Mitigated by §6.C's precondition
(`businessDay < branchCurrentBusinessDay`). **Stated, not designed around.**

> **HONEST STATEMENT: a migration IS genuinely required** (§16). Under Option E
> it does **not** touch `cash_sessions` and does **not** need a backfill.
> **Migration need is not itself a blocker to selecting DayClose.**

---

## §8. DAYCLOSE vs CASHSESSION CLOSE — NOT CONFLATED

| | **CashSession Close** (accepted, `121b889`) | **DayClose** (not implemented) |
|---|---|---|
| Level | **Drawer / session** | **Branch / business-day** |
| Aggregate | §7.3 #28 CashSession (CashMovements, Denominations, Reconciliation) | §7.3 #29 DayClose (SessionSummaries, VarianceReport) |
| Requirements | `FR-POS-094…097`, `FR-FIN-004/005/006/007` | `FR-FIN-020…026` |
| Core content | expected / counted / variance; denominations | Z report: 13 enumerated aggregate fields |
| Gate | **approval-gated finalize** above tolerance (`cash.variance.approve`, manager PIN) | **blocked by any non-closed branch session** |
| Permission | `cash.session.close` / `_close_other` (seeded) | `cash.day.close` (**named, not seeded**) |
| Event | `cash.variance.detected` | `day.closed` |
| Output | immutable `CashSessionCloseAttempt` per session | immutable, **per-branch-sequentially-numbered** Z, retrievable historically |
| Numbering | none | **required** (`FR-FIN-023`) |

### **Does closing the final CashSession automatically close the day?**

> ## **NO — and this is NOT assumed, it is checked.**

- `FR-FIN-020` names a *close operation*; `FR-FIN-021` makes all-sessions-closed
  a **precondition**, never a trigger. A precondition is not a cause.
- §7.3 lists them as **two distinct aggregate roots** in the same context.
- §15.2 gives them **separate permissions** — an automatic cascade would make
  `cash.day.close` unenforceable, since the last cashier would close the day by
  side effect while holding only `cash.session.close`.
- The **only** automatic close the SRS contemplates is `FR-FIN-025` **[S]**,
  triggered by the **configured boundary**, not by the last session.
- No code path in `cash-session-close.service.ts` does anything of the kind.

**Relationship, exactly:** CashSession Close is a **precondition supplier**;
DayClose is a **consumer and sealer**. One-way, no cascade.

---

## §9. REPORTING CONTRACT REUSE

| Contract | Reusable by DayClose? | Verdict |
|---|---|---|
| **Sales `DAILY_TRADING_SALES_QUERY`** (`facts`, `currentBusinessDay`; `tx`-first) | **YES — and reuse is strongly preferred** | It already yields 8 of 13 Z fields (§6.K) with ratified formulas (RPT-R3 AOV, `FR-CST-003` net). The repository's own stated principle — *"the report and Order creation must never be able to disagree about what today's business day is; no second business-day algorithm exists"* — applies with equal force to a second gross-sales algorithm. **Precedent exists for the consumer direction:** Treasury already consumes Sales' `CASH_SESSION_TENDER_TOTALS_QUERY` (`cash-session-close.service.ts:65-66`) with **zero** `KNOWN_DEVIATIONS` entries. The gate must decide whether to consume it as-is or extend it |
| **Treasury `DAILY_CASH_RECONCILIATION_QUERY`** | **MUST NOT be the `FR-FIN-021` blocker list** | It is **payment-derived at the caller** (`sales.contributingCashSessionIds`) and structurally cannot see zero-payment or movement-only sessions. RPT-R2 clause 10 says so explicitly. **DayClose needs no contract here at all** — `treasury.cash_sessions` is Treasury's **own** table, queried directly |
| **Organisation `BRANCH_CURRENCY_QUERY` / `BRANCH_REPORTING_SCOPE_QUERY`** | **YES, mechanically reusable** | Both are `tx`-first and already consumed by Reporting. Whether DayClose adopts the single-active-branch posture is §12 |
| **Localisation `TAX_CLASS_LABELS_QUERY`** | Yes, if the Z reports tax by class | Only relevant under the §19 Q1 decision |
| **New Treasury DayClose contract** | **Not needed by the slice; needed later** | §5.5.4 makes Analytics/Fiscal/**Reporting** subscribers of `day.closed`. A read contract for a sealed day is a *future* consumer's need, not this slice's |
| **New Organisation business-day contract** | **Design-gate question** | Business-day resolution currently lives in **Sales** (`sales/orders/business-day.ts`) although the cutover column is `org.operating_hours` and `FR-FIN-024` is a **Finance** requirement. Two source-consistent routes: (a) Treasury consumes Sales' `currentBusinessDay` (cheapest, precedented); (b) Organisation publishes a business-day contract and both Sales and Treasury consume it (cleaner ownership, larger blast radius on accepted code). **Recommend (a) for this slice; record (b) as the correct long-term home.** |

**No module ownership is violated by any of the above.**

---

## §10. DAYCLOSE MODULE OWNERSHIP

> ## **A — TREASURY. Decisively, on four independent source statements.**

1. **SRS §7.3 #29** — `DayClose` · **Context: Treasury** · Contained entities:
   `SessionSummaries`, `VarianceReport`.
2. **SRS §25.1** — `treasury` schema contains *"drawers, cash_sessions,
   cash_movements, expenses, **day_closes**"*.
3. **SRS §5.5.4** — `day.closed` · **Publisher: Treasury**.
4. **SRS §15.2** — the permission sits in the **Cash** family: `cash.day.close`.

**B — Reporting: REJECTED, and it would contradict a binding ratification.**
**RPT-R2 clause 5** is explicit: *"The reporting module owns **zero tables and
zero migrations**."* The accepted `DailyTradingReportService` docblock states the
same: *"This service owns ZERO Prisma models."* Making Reporting a
state-changing financial aggregate would reopen RPT-R2 for no source-supported
reason.

**C — A dedicated Finance/DayClose aggregate inside Treasury:** this is simply
what A *is*. A separate `DayClose` service/directory **inside** the Treasury
module (mirroring `cash-session-close/`, `cash-movements/`, `cash-close-policy/`)
is the natural internal shape and needs no new module.

**D — Another home: none is source-backed.**

---

## §11. RECEIPT RELATIONSHIP — RE-AUDIT OF P1C-1

| Question | Answer |
|---|---|
| Is Receipt still blocked by a ratified fiscal exclusion? | **YES.** CARRIED ITEM P1C-1, reaffirmed by P1F-2 (2026-08-25) and left explicitly unchanged by **RPT-R2 clause 13** at this HEAD |
| Does the Internal MVP require a non-fiscal receipt despite that exclusion? | **UNRESOLVED — it is the user decision the POST-KDS rebase isolated (§14.1) and it remains open.** This report neither answers it nor implements around it |
| Does DayClose depend on receipt persistence? | **NO** — §6.M |
| Does Z depend on receipt numbering? | **NO** — §6.N. `FR-FIN-023`'s per-branch Z number is structurally unrelated to §22.2's invoice sequence |
| Can DayClose proceed while Receipt remains blocked? | **YES**, with `FR-FIN-026` honestly recorded as unmet |

> **P1C-1 is NOT reopened by this report.**
> **DayClose requires NO user decision about fiscal/receipt semantics.**
> Therefore verdict **C (governance blocked) does NOT apply.**
> **Receipt remains a parallel blocker.**

---

## §12. BRANCH AUTHORIZATION FOR A STATE-CHANGING FINANCIAL CLOSE

**D-2 remains in force** (§5.3). The question is whether DayClose may use the
Reporting Internal-MVP posture, or whether an irreversible financial write
demands true principal branch scope.

### The security difference, stated honestly

| | **READ** — daily report | **WRITE** — irreversibly seal a business day |
|---|---|---|
| Wrong-branch failure | information disclosure within one tenant | a **permanently immutable, sequentially numbered** document sealed against the wrong branch, blocking that branch's own close |
| Reversible? | n/a | **NO** — `FR-FIN-023` immutability plus append-only grants make it unrecoverable |
| Denial-of-service risk of an over-strict posture | a report is unavailable | **operations are blocked** — the branch cannot close its day |

### Is the single-active-branch posture sufficient?

> ### **YES for the Internal MVP — and it is provable, not merely conventional.**

The Reporting posture asserts a **tenant-shape** fact: the tenant has **exactly
one** active branch, and the supplied `branchId` **equals** it, verified inside
the same transaction as the operation. Under that assertion the set of branches
the principal can affect has **cardinality 1** and is **identical** to the set
they are entitled to affect. **Read/write asymmetry does not change that
arithmetic** — it changes the *cost of being wrong*, and the cost of being wrong
is multiplied by a cardinality-zero difference.

This is exactly the Internal MVP's ratified carve-out: *"one branch
operationally"*.

**Therefore DayClose does NOT require principal branch-aware RBAC, and is NOT
blocked by D-2.**

### But it must NOT be copied mechanically — three real differences

1. **The disclosed multi-branch consequence is materially worse for a write.**
   A tenant with two active branches gets **403** and **cannot close its day at
   all** — an operational block, not merely an unavailable report. This must be
   disclosed as its own consequence, not inherited silently from RPT-R2's note.
2. **Treasury already has a stronger, different posture.** Every existing
   Treasury write derives its branch from the **terminal/session binding**, never
   from a client-supplied parameter, and the movement routes additionally enforce
   an own-session-only rule. If DayClose is a POS/manager-terminal command, the
   terminal binding is **strictly stronger** than the Reporting assertion and
   should be preferred. If it is a dashboard command, the Reporting assertion
   applies. **Which it is, is source-silent — design-gate question (§19 Q6).**
3. **The assertion must execute inside the SAME transaction as the close**, for
   the same TOCTOU reason the Reporting acceptance correction removed its guard.

> ### **BRANCH SECURITY: sufficient under the Internal-MVP posture, without
> lifting D-2. `FR-SEC-002/003/004` remain NOT IMPLEMENTED.** The mechanism is a
> gate question; the *sufficiency* is settled here.

---

## §13. DAYCLOSE PERMISSION — SOURCE STATUS

Searched: SRS §15.2 permission catalogue (full Cash family), the Governance
Decision Register (all 7,577 lines, for `cash.day.close` / `Day Close` / `day
close`), every `*.permissions.ts` in `src/modules/`, and the Treasury controller
comments.

| Source | Finding |
|---|---|
| **SRS §15.2, Cash** | **`cash.day.close` — "Close the business day"** (verbatim) |
| `treasury.permissions.ts` | Named in the docblock among codes *"deliberately NOT seeded … Each is seeded by the slice that implements it."* **Not present in `TREASURY_PERMISSIONS` or `TREASURY_PERMISSION_DEFS`** |
| Governance Register | Appears only inside *"Not decided by this entry"* lists (Approval Runtime 2026-08-29; P1G-1 2026-08-30) and RPT-R2 clause 10 — i.e. **never excluded, only not-yet-addressed** |
| Any other module | Absent |

> ## **CLASSIFICATION: SOURCE-DECIDED.**
> **No user decision is required for the DayClose permission.**
> **No permission code is added by this report.**

*(No `_other`/force variant exists in §15.2, and none is invented; `FR-FIN-025`
force-close is deferred — §6.R.)*

---

## §14. Z REPORT — MINIMUM CONTENT AUDIT

### SRS-MANDATORY (`FR-FIN-022`/`023`) — in scope for any DayClose slice

| Item | Required now? | Available? |
|---|---|---|
| Immutable Z snapshot | **YES** (`FR-FIN-023`) | must be built |
| **Sequential Z number per branch** | **YES** (`FR-FIN-023`) | must be built |
| Gross sales | YES | ✅ |
| Discounts | YES | ✅ (structurally 0) |
| Refunds | YES | ✅ (structurally 0) |
| Net sales | YES | ✅ |
| **Tax by rate** | YES | ❌ **not derivable** |
| **Sales by category** | YES | ❌ no aggregate |
| Sales by tender | YES | ✅ PARTIAL (2 tenders) |
| **Sales by order type** | YES | ❌ no aggregate |
| Transaction count | YES | ✅ |
| Average order value | YES | ✅ (RPT-R3) |
| **Void and comp summary** | YES | ❌ half-derivable (voids yes, comps structurally zero) |
| Cash reconciliation | YES | ✅ PARTIAL (payment-contributing sessions, WHOLE_SESSION) |
| **Variance summary** | YES | ❌ blocked until §7 attribution exists |
| **Historical retrieval route** | **YES** (`FR-FIN-023`) | must be built |

### NOT SRS-mandatory for the Z — legitimately deferrable

| Item | Why deferrable |
|---|---|
| **Fiscal information** | Not named in `FR-FIN-022`; P1C-1 excludes it (§6.M/N) |
| **Employee / session detail beyond cash reconciliation** | `FR-FIN-022` names *"cash reconciliation"* and *"variance summary"*, not a per-employee breakdown. §19.3's *Sales by Employee* is a **separate report** |
| **Signature / hash** | No SRS requirement attaches a signature to a Z. `governance.audit_entries` is already hash-chained; that is a different artefact |
| **Export / PDF** | **`FR-RPT-043`/`044` remain NOT IMPLEMENTED by RPT-R2 clause 7.** The SRS glossary defines a Z Report as *"the terminal report that closes a shift or business day"* — a **record**, not a document format. **Z does NOT mean PDF** |
| **X report (`FR-POS-093`)** | A **non-resetting mid-shift** summary — a different requirement in a different section, with an undecided permission. **Not a Z prerequisite.** Its relationship to Z is: same data family, opposite lifecycle (X does not seal; Z does) |

---

## §15. TRANSACTION / CONCURRENCY — DESIGN-GATE LEVEL

**Likely atomic boundary** (one transaction, in order):

```
BEGIN  (READ COMMITTED + advisory lock, per repository precedent)
  1. pg_advisory_xact_lock(hashtext('ros_branch_day'),
                           hashtext(branchId || businessDay))
  2. assert no DayClose exists for (tenant, branch, businessDay)
  3. assert businessDay validity — < branch current business day (§6.C)
  4. read the blocking set: cash_sessions WHERE branch AND status <> 'closed'
     → if non-empty: 409 + the blocking list (FR-FIN-021's second limb)
  5. obtain the reporting facts (Sales contract, same tx — §9)
  6. allocate the per-branch sequential Z number (under the lock held at 1)
  7. INSERT the immutable DayClose + Z snapshot
  8. INSERT session_summaries attribution rows (§7 Option E)
  9. write the audit entry (hash-chained)
 10. publish day.closed via UnitOfWork
COMMIT
```

**Mechanism selection, with reasons:**

| Mechanism | Verdict |
|---|---|
| **Unique constraint** | ✅ **REQUIRED** — the deterministic conflict (§6.X). Precedent: `uq_ccp_branch_effective_from` |
| **`pg_advisory_xact_lock`** | ✅ **RECOMMENDED** — protects the read-then-allocate span (steps 4→6) that a unique constraint cannot. Precedent: 7 accepted call sites |
| **Expected-version OCC (§24.6.4)** | ❌ **N/A** — DayClose is an INSERT of a new aggregate; there is no prior version to assert |
| **Pessimistic row locks (`FOR UPDATE`)** | ⚠️ **Probably not** — and note the accepted `CashMovementsService` finding: `ros_app` lacks the `UPDATE` privilege needed to take `FOR UPDATE` on `cash_sessions`, which is exactly why the advisory lock is used there |
| **SERIALIZABLE** | ❌ **NOT recommended.** Zero repository precedent (verified). §24.6.4 does not contemplate it. No write-skew hazard survives the lock + constraint. **Do not use without proving why** |

---

## §16. MIGRATION EXPECTATION

> # **ONE OR MORE ADDITIVE MIGRATIONS EXPECTED**

**Conceptual objects only. No migration is created, and no DDL, table name,
column name, index name or constraint name below is decided by this report.**

| Object | Basis |
|---|---|
| `treasury.day_closes` — tenant-safe (approved-SQL shape **+ `tenant_id` + composite FKs**, as every Treasury table in this repo already does per ADR 0008 D-09) | Approved SQL `:1118`; SRS §25.1 |
| `UNIQUE (tenant_id, branch_id, business_day)` | Approved SQL's own `uq_day_close`, tenant-extended (§6.X) |
| A **per-branch sequential Z number** + its uniqueness constraint | `FR-FIN-023` [M] |
| An **immutable Z snapshot** representation — columns on `day_closes` vs. a child table | `FR-FIN-022`/`023` (**shape is a gate question**, §6.P) |
| `treasury.session_summaries` **+ `UNIQUE (tenant_id, cash_session_id)`** | Approved SQL `:1127`; §7 Option E |
| `treasury.variance_reports` — **or** fold `total_variance` into the snapshot | Approved SQL `:1133`; a one-column table may not earn its existence — **gate question** |
| RLS policies + **append-only `ros_app` grants** (`SELECT` + column-level `INSERT` excluding `created_at`; **no `UPDATE`, no `DELETE`**) | `FR-FIN-023` immutability; precedent `approval_decisions` / `cash_close_policies` / `cash_session_close_attempts` |
| **NO column on `cash_sessions`** | §7 Option E — and R-3(a)'s precedent of deliberately adding none |

**Not a migration-design blocker:** every object above is either defined in the
approved SQL or is a direct, mandated consequence of an `[M]` requirement.

---

## §17. MVP MATRIX — DELTAS ONLY

Starting from the POST-KDS 33-row matrix. **Only changed rows are restated.**

| # | Capability | Was at `38e007b` | **Now at `7bc5d2c`** | Evidence |
|---|---|---|---|---|
| 27 | **Daily / minimum sales reporting** | **N** — selected slice | **C — FINAL ACCEPTED, SOURCE-CONTROL CLOSED** | `GET /reports/branches/{branchId}/daily-trading/{businessDay}`; `reporting/` module (5 files, **zero tables**); 4 new public contracts; 9 e2e specs; RPT-R1/R2/R3 ratified |
| 29 | Shift / session report | P | **P (unchanged)** | `close-context` only. **X report still NOT IMPLEMENTED** |
| 33 | OpenAPI surface | C — 109 paths | **C — 110 paths** | `docs/api/openapi.json` |
| 25 | **Receipt** | **N / BLOCKED** | **N / BLOCKED (unchanged)** | §5.1 — P1C-1 reaffirmed by RPT-R2 cl. 13 |
| 26 | **Day / business-day close** | **N** — *"premature"* | **N — but SELECTABLE** | §5.2, §6. Reclassified: the sequencing objection is discharged; 5 of 13 Z fields remain (§6.L) |
| 4 / 30 | **Branch authorization** | **N / BLOCKED (D-2)** | **N / BLOCKED (unchanged)** | §5.3 — reconfirmed by RPT-R2 cl. 13 and the 2026-08-31 consequence note |
| — | Post-fire void (`FR-KDS-029`) | DEFERRED MVP GAP | **DEFERRED MVP GAP (unchanged)** | §5.4 |
| — | `served` / Expediter (`FR-KDS-040`) | PARTIAL, deferred | **PARTIAL, deferred (unchanged)** | §5.4 |
| — | **`FR-FIN-024`** | *"ABSENT"* | **COMPLETE — CORRECTION (§4)** | `org.operating_hours.business_day_cutover` + `business-day.ts` |
| — | **Newly-discovered hard blocker** | — | **NONE** | §5.4 |

### Requirement classification deltas

- **`FR-RPT-004` → COMPLETE.** `FR-RPT-001/002/003/005` **NOT IMPLEMENTED**
  (RPT-R2 — *not waived, not complete*). `FR-RPT-042/043/044` **NOT IMPLEMENTED**.
- **`FR-FIN-010` → PARTIAL** (per-day half delivered for **two** tenders; *each
  card scheme* and nine tender families **UNSATISFIED**).
- **§19.3 Cash Reconciliation → PARTIAL.**
- **`FR-FIN-024` → COMPLETE** (correction).
- **`FR-FIN-020…026` → NOT IMPLEMENTED** (unchanged).
- **Corrected tender identity, preserved exactly:**
  `tenderGrandTotal = grossSales + unsettledCapturedTotal + completedExcessCapturedTotal`.
- **The Reporting domain is NOT complete**, and this report does not say it is.

### NON-AUTHORITATIVE completion estimate

> Raw SRS requirement counting is deliberately **not** used.

- **Protected-path matrix (33 rows): 27 COMPLETE · 2 PARTIAL · 4 NOT IMPLEMENTED
  ⇒ 27/33 ≈ 82 %** (≈ 85 % counting PARTIALs at half).
- **Readiness-PDF 15-capability definition:** #15 *minimum operational
  visibility* moves **PARTIAL → COMPLETE** ⇒ **13 COMPLETE · 1 PARTIAL (#12 cash
  session **and** day close) · 1 BLOCKED (#9 receipt) ≈ 90 %**.
- **Remaining blocking slices: 3** — DayClose (**startable**), Receipt
  (governance), Branch-scoped authorization (governance). **Exactly one is
  startable today.**

---

## §18. THE SELECTED NEXT SLICE

> # **DAY CLOSE — `FR-FIN-020 … 026`, Treasury.**

### Against the six selection rules, in order

| Rule | DayClose | Receipt | Branch auth | Post-fire void |
|---|---|---|---|---|
| **1. Directly blocks Internal-MVP exit** | ✅ **edge 15**, the last open one | ✅ edge 12 | ✗ exit gate, not function | ✗ exception path |
| **2. Upstream deps ready NOW** | ✅ CashSession close ✔ · Reporting facts ✔ · `FR-FIN-024` ✔ (§4) | ✅ | ✅ | ✅ |
| **3. Not hidden behind another unresolved blocker** | ✅ **proven independent of Receipt/fiscal (§6.M)** | ❌ P1C-1 | ❌ D-2 | ❌ no ratified approval semantics |
| **4. Highest downstream leverage** | ✅ closes MVP capability #12's second half; `day.closed` unlocks Analytics/Fiscal/Reporting subscribers | ~ reprint | ~ | ✗ |
| **5. Coherent implementation slice** | ✅ one aggregate, one command, one document, one retrieval route | ✅ | ✅ | ✅ |
| **6. Governance settled or isolable in one small gate** | ✅ **permission SOURCE-DECIDED (§13)**; remaining questions isolate into one gate | ❌ needs P1C-1 reopened | ❌ needs D-2 lifted | ❌ needs new approval semantics |

### Why it is now selectable when the POST-KDS rebase called it premature

That report's objection was **specific**: *"A Z report cannot be filled at this
HEAD"*, plus a claimed `FR-FIN-024` prerequisite. Both have moved:

1. **`FR-FIN-024` was never a gap** — factual correction (§4).
2. **Reporting filled 8 of 13 Z fields** and ratified their formulas.
3. **`FR-FIN-021`'s blocker predicate turns out to need no anchor** (§6.D) — the
   architectural obstacle the task brief anticipated is **narrower than feared**.
4. **The permission is source-decided** — uniquely among recent slices.
5. **The register's own words point here:** RPT-R2 clause 10 — *"DayClose
   remains a separate slice **with its own design gate**."*

### And why the objection is reduced, not eliminated — stated honestly

**Five of thirteen Z fields remain unfillable (§6.L).** This report does **not**
pretend otherwise, and it does **not** recommend sealing a partial Z by default.

**Recommendation to the gate:** the four missing *sales* aggregates — **tax by
rate · sales by category · sales by order type · void-and-comp summary** — should
be computed **inside the DayClose slice**, not as a separate reporting slice.
Reasons, all source-grounded: they are needed **only** by the Z; `FR-FIN-022`
places them **in the Z**; a standalone report surface would require a new
`report.view.*` code that **RPT-R1 expressly forbids**; and three of the four are
straightforward aggregates over already-immutable facts. **Tax by rate is the
genuine exception** — it is *not derivable at all* and needs its own decision
(§19 Q2). The **variance summary** is unblocked by §7's attribution decision.

### Readiness

| | |
|---|---|
| **UPSTREAM READY** | **YES** — CashSession Close (FINAL ACCEPTED), Minimum Reporting (FINAL ACCEPTED, closed), `FR-FIN-024`, Approval Runtime, audit, events, idempotency |
| **DOWNSTREAM UNLOCKED** | MVP capability #12's second half · edge 15 · `day.closed` for Analytics/Fiscal/Reporting · the `FR-FIN-025` automation track · `FR-FIN-026`'s limbs as their subsystems arrive |
| **GOVERNANCE** | **NOT BLOCKED.** Permission source-decided. Likely **two** narrow ratifications (§19 Q1, Q3) — neither is a permission and neither reopens P1C-1 or D-2 |
| **MIGRATION** | **ONE OR MORE ADDITIVE** (§16) — not a blocker to selection |
| **PARALLEL WORK** | Receipt/P1C-1 decision · branch-scope/D-2 decision · post-fire-void approval semantics — **none blocks DayClose** |
| **DESIGN GATE REQUIRED** | > ## **YES** |
| **IMPLEMENTATION READY** | **NO — design gate first**, matching the KDS / P1G-1 / P1F-2 / Reporting precedent without exception |

---

## §19. NEXT GATE INPUT — THE EXACT QUESTIONS THE DAYCLOSE DESIGN GATE MUST RESOLVE

**This report does NOT design DayClose. These are the questions, not the answers.**

**The two that are USER decisions, not engineering:**

1. **Z-content completeness.** Five of `FR-FIN-022`'s thirteen `[M]` fields are
   unavailable (§6.L). Does the slice (a) compute the four derivable ones inside
   itself *(recommended)*, (b) seal a knowingly partial Z with the gaps recorded
   as unmet `[M]`s on the RPT-R2/`FR-SEC-032` precedent, or (c) something else?
   **A permanently immutable, sequentially numbered document makes this
   irreversible.**
2. **Tax by rate.** Not derivable at all — `FR-FIN-032`'s multi-component
   breakdown is not persisted. Report by **class** and record *by rate* as unmet,
   or persist the component breakdown (**a Sales-side migration**, widening the
   slice)?
3. **Session→business-day attribution.** RPT-R2 clause 9 recorded that no anchor
   exists *"and none is invented"*. Adopting §7 Option E introduces attribution —
   in the approved SQL's own `session_summaries`, at close time. Confirm it is an
   engineering consequence, or ratify it.

**Engineering / design-gate mechanics:**

4. **DayClose persistence model** — one aggregate row carrying the Z snapshot, or
   a close record plus a separate numbered Z document (§6.P)? Is
   `variance_reports` worth a table (§16)?
5. **Z immutable snapshot shape** — which columns, what money serialisation
   (bigint-as-string, ADR-008), and how a historical Z explains itself with no
   join to current settings (the `cash_session_close_attempts` precedent).
6. **Numbering** — per-branch allocator mechanism (advisory lock + `MAX+1` vs.
   uniqueness-constrained), **gap-free or not**, restart period, rendered format.
7. **Blocking-session definition** — confirm §6.I: `status <> 'closed'` for the
   branch, `closing` counts as blocking, no business-day qualifier. What exactly
   is in the returned blocking list, and which HTTP status (409)?
8. **Business-day precondition** — is `businessDay < branchCurrentBusinessDay`
   required (§6.C)? Do open **orders** also block, or only sessions?
9. **Branch authorization mechanism** (§12) — terminal-derived (Treasury's
   existing, stronger posture) or the Reporting single-active-branch assertion?
   Is DayClose a POS/manager-terminal command or a dashboard command?
10. **Reporting contract reuse** (§9) — consume `DAILY_TRADING_SALES_QUERY`
    as-is, extend it, or publish a new Treasury-facing Sales contract? Where does
    business-day resolution belong long-term (Sales vs Organisation)?
11. **Event** — confirm `day.closed` only, its §5.5.4 envelope, and its payload.
12. **Audit** — the new `AUDIT_ACTION` literal, and whether the *retrieval* route
    is audited (precedent says **no** for ordinary `GET`s — RPT-R2 clause 12).
13. **Transaction / concurrency** — confirm §15's boundary and mechanism; prove
    why not SERIALIZABLE. **Also decide whether to address the pre-existing
    `cutoverLookup` non-determinism (§6.H(2)) inside this slice or record it.**
14. **Idempotency / replay** — `@Idempotent()` per `FR-API-020`; interaction
    between the idempotency reservation and the unique-constraint conflict
    (the R-6(a) lesson: never throw after a decision INSERT).
15. **Receipt / fiscal independence** — confirm `FR-FIN-026`'s four limbs are
    recorded **NOT IMPLEMENTED / PARTIAL**, and that no fiscal artefact is
    created (P1C-1 untouched).
16. **Migration shape** (§16) — final object list, RLS predicates, append-only
    grant form, and legacy-data compatibility (the P1G-1 migration-compatibility
    closure's method is the precedent: execute against real pre-existing data).
17. **Explicitly OUT** — `FR-FIN-025` automatic close (§6.R), X report, export/PDF,
    per-employee Z breakdown, force-close semantics.

---

## §20. WHAT THIS TASK DID AND DID NOT DO

**Did:** verified the baseline; read the SRS, the register and the repository at
`7bc5d2c`; produced this report; appended **exactly one** row to
`docs/reports/claude/INDEX.md`.

**Did NOT:** implement product code · create or modify a migration · modify the
Prisma schema · add a route or a permission · edit governance · regenerate
OpenAPI · run any test suite · stage · commit · push · deploy · perform any
destructive git operation · touch the four unrelated dirty reports or their four
`INDEX.md` rows.

---

## §21. VERDICT

> # **A. POST-REPORTING MVP REBASE CLEAN — NEXT SLICE SELECTED**
>
> **NEXT SLICE: DAY CLOSE (`FR-FIN-020 … 026`, Treasury).**
> **DESIGN GATE REQUIRED: YES.**
> **Not B** — the functional path still has two open edges (12, 15).
> **Not C** — DayClose is not governance-blocked; its permission is source-decided
> and no fiscal/receipt decision gates it.
> **Not D** — no source/architecture contradiction was found; the one architectural
> question (session→business-day) has a source-backed answer in the approved SQL.
> **Not E** — the baseline matched every expectation exactly.

---

*End of report. **Non-authoritative evidence.** The SRS and the ratified
governance decisions remain authoritative. No prior report is modified or
superseded; the two corrections in §4 are recorded against current source and
leave the prior report byte-unchanged.*

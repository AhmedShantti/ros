# MINIMUM OPERATIONAL REPORTING — Final Design & Governance Gate

| Field | Value |
|---|---|
| **Task / slice name** | MINIMUM OPERATIONAL REPORTING — branch daily-trading read surface |
| **Report type** | Final design + governance gate. **Analysis/design/governance packet only. NO implementation.** |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the **ratified** entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the only authorities. This report ratifies nothing, decides nothing binding, creates no scope, and confers no permission. Where it disagrees with an older report, the *current source at the HEAD below* is the reason and the disagreement is stated explicitly. |
| **Date** | 2026-08-31 |
| **HEAD** | `38e007b0cd285679fc7fd334aec54d3bf2a8006c` — *feat: complete KDS operator lifecycle* |
| **Parent** | `121b889` — *feat: add cash session close* |
| **Branch** | `feat/production-spec` |
| **Working tree** | Documentation-only dirt: `M docs/reports/claude/INDEX.md` plus five untracked reports in `docs/reports/claude/`. **Zero source / schema / test / migration / OpenAPI drift.** The four unrelated pre-existing reports were not read into scope, modified, staged or removed. |
| **Task identifier** | MINIMUM-reporting-final-design-gate |
| **Status** | COMPLETE |
| **Migrations** | 34 — unchanged. **No migration created, modified or planned by this task.** |
| **Tests** | **No test suite was executed in this session.** Test *files* and *specs* are cited as structural evidence only. **Four read-only `EXPLAIN` statements** were executed against the local dev database inside `BEGIN … ROLLBACK` (§20) — no write, no DDL, no seed, no `ANALYZE`. |

---

## §0. VERDICT

> # **B. MINIMUM REPORTING READY AFTER NARROW USER RATIFICATION**
>
> The data semantics resolve completely against current source (§5–§13).
> The branch-safety problem is solvable **without touching D-2** (§16).
> **No migration is required** — every query shape the design needs is already
> index-driven, proven by `EXPLAIN` at §20.
>
> **THREE user ratifications** are required, and only three (§26). Two are
> genuine governance items; the third is one narrow business definition the
> SRS is silent on.
>
> This is **NOT** full `FR-RPT` compliance and must never be recorded as such
> (§4).

---

## §1. VERIFIED REPOSITORY BASELINE

Commands executed **first**, in this session:

```
git status --short
git rev-parse HEAD
git branch --show-current
git log -10 --oneline
git show --stat --oneline HEAD
```

| Expectation | Observed | Verdict |
|---|---|---|
| HEAD `38e007b0cd285679fc7fd334aec54d3bf2a8006c` | identical | PASS |
| Subject `feat: complete KDS operator lifecycle` | identical | PASS |
| Parent `121b889` *feat: add cash session close* | identical | PASS |
| Branch `feat/production-spec` | identical | PASS |
| Dirty tree = 4 unrelated reports + the POST-KDS rebase report + unstaged `INDEX.md` | identical (`M INDEX.md`, 5 `??` reports) | PASS |
| **No source / schema / test / migration / OpenAPI drift** | `git status --short` returns nothing outside `docs/reports/claude/` | PASS |

**BASELINE: TRUSTWORTHY.** Verdict E is not returned.

---

## §2. AUTHORITY ORDER APPLIED

1. **`ROS_SRS_v1.0.pdf`** — extracted and read directly this session: Chapter 19
   in full (§19.1 philosophy, §19.2 analytics architecture + star schema,
   §19.3 report catalogue, §19.4 dashboards, §19.5 delivery/export/alerts,
   §19.6 NFRs), FR-RPT-001…005 / 030…034 / 040…047, §16.2–16.6
   (FR-FIN-001…007, FR-FIN-010…012, FR-FIN-020…026, FR-FIN-030…034),
   §15.1–15.4 (FR-SEC-001…005, §15.2 catalogue, §15.3 standard roles,
   FR-SEC-010…012, §15.4 SoD), §20.1 (FR-AUD-001…010), §5.2.3, §5.2.4, §5.3,
   §5.4, §5.5.1, §13.2/§13.6 (FR-CST-002/003/005/035).
2. **`docs/governance/GOVERNANCE_DECISION_REGISTER.md`** (7,126 lines) — **D-2**
   with its 2026-08-19 amendment and preservation clauses, **D-20** with its
   full 18-clause ratification, the **KDS MVP Operator Lifecycle Ratification
   (2026-08-30)** including **KDS-R11** and its consequence note, and the
   preservation clauses that reconfirm D-2 at this HEAD.
3. **The repository at `38e007b`** — `prisma/schema.prisma`, the live dev
   database's `pg_indexes`/`\d+` output, the generated OpenAPI (109 paths),
   every `*.permissions.ts`, every `contract/` directory,
   `module-boundaries.spec.ts`, and the Sales/Treasury/Localisation/
   Organisation/Identity sources cited throughout.
4. **Accepted implementation reports** — cited only where §4 or §5 says so.
5. **`docs/reports/claude/2026-08-31_POST-KDS_MVP-final-rebase-and-next-slice.md`**
   — read in full. **Its proposed formulas were NOT assumed correct.** §5 and
   §7 below re-derive every one from source; §3 records where this gate
   **differs from** or **corrects** it.
6. **Engineering inference** — used only where explicitly flagged.

**Current source wins over every implementation-status prose claim, in both
directions.**

---

## §3. WHERE THIS GATE DIFFERS FROM THE POST-KDS REBASE

The POST-KDS rebase is non-authoritative evidence. Its proposals were audited,
not inherited. Five differences, each source-backed:

| # | POST-KDS rebase said | This gate finds | Evidence |
|---|---|---|---|
| **D-1** | *"A per-day sales-by-tender aggregate would want"* an additive index on `order_payments(tenant_id, branch_id, business_day)`; **"the single plausible reason the slice touches a migration"** | **NO MIGRATION.** An **orders-first join** answers every tender question with **existing** indexes, and the branch-inclusive FK makes it provably complete | §20 — four `EXPLAIN` plans; `order_payments_tenant_id_order_id_business_day_branch_id_fkey` |
| **D-2** | *"Session roll-up … from `CashSessionCloseAttempt`"* | `CashSessionCloseAttempt` is **not** where a *daily* roll-up starts. `treasury.cash_sessions` **carries no `business_day` column at all** — no session can be attributed to a day by its own row. Attribution must come from the day's **payments** | §10 — `prisma/schema.prisma:2297-2361`; `Shift` (`:2199`) likewise has no business day |
| **D-3** | *"including `rounding_adjustment`"* alongside tender totals, undifferentiated | `orders.rounding_adjustment` and `order_payments.rounding_adjustment` are **different figures**. The order-side value is an *increment of the payment-side value* and excludes payments on non-completed orders. Only the **payments-side** sum is the FR-FIN-004 term | §7.7, §9 — `sales-payment.service.ts:395,557`; 4 live rows carry a non-zero order-side value, **all on `partially_paid` orders** |
| **D-4** | *"no new Reporting module"* recommended | **Re-evaluated and rejected.** A thin `reporting` orchestration module owning **no tables** is chosen — §5.2.4 names **Reporting as extraction candidate #1**, and Sales owning this endpoint would make it a cross-domain god-service | §14 |
| **D-5** | Tax *"by rate"* framed as pending a *resolution rule* over the pinned pack | Stronger, and worse: **by-rate is not derivable from persisted facts at all.** FR-FIN-032 multi-component tax means a class has *components*, each with its own `ratePercent`; the line persists only their **sum**. `exempt` vs `zeroRated` is likewise unrecoverable | §11 — `tax.model.ts:50-80`; `OrderLine.taxAmount` |

Everything else in the POST-KDS rebase's §7 that this gate re-verified —
that no `report*` route or `report.*` permission exists, that
`orders @@index([tenantId, branchId, businessDay])` exists, that no new
persistence model is needed, and that DayClose need not precede this slice —
**is confirmed correct**.

---

## §4. THE HONESTY RULE — WHAT THIS SLICE IS NOT

The SRS requires, as `[M]`:

| Req | Verbatim substance | This slice |
|---|---|---|
| **FR-RPT-001** | *"Analytical queries SHALL execute against a **read replica**, never the transactional primary."* | **NOT IMPLEMENTED.** This design queries the transactional primary. |
| **FR-RPT-002** | *"SHALL maintain **pre-aggregated rollups** at hourly, daily, weekly, and monthly grain."* | **NOT IMPLEMENTED.** No rollup table exists or is created. |
| **FR-RPT-003** | *"Rollups SHALL be **incrementally updated** … and SHALL be **fully rebuildable** from source."* | **NOT IMPLEMENTED.** Nothing to update or rebuild. |
| **FR-RPT-005** | *"Dimension tables SHALL be **slowly-changing (Type 2)**."* | **NOT IMPLEMENTED.** No dimension table exists. §22 records a live consequence: `org.branches.base_currency` and `.timezone` are **mutable**, which is precisely the Type-2 problem FR-RPT-005 exists to solve. |

These are **architecture requirements**, not engineering advice, and they are
**NOT reinterpreted as optional** anywhere in this report.

**The distinction this gate draws:**

- **(A)** an **Internal-MVP operational read surface** implemented now —
  query-time aggregation over already-immutable transactional facts;
- **(B)** the **future full Reporting/Analytics architecture** — §19.2's
  replica + star schema + materialised rollups + report cache + export
  pipeline, which remains **0% built and post-MVP**.

Shipping (A) while (B) is absent requires an
**INTERNAL-MVP SEQUENCING / SCOPE RATIFICATION** (§26, DECISION 2).

> **BINDING WORDING CONSTRAINT.** No report, register entry, INDEX row, code
> comment or OpenAPI description produced by this slice may state or imply
> *"FR-RPT-001/002/003/005 waived"* or *"…complete"*. The only permitted
> classification is **NOT IMPLEMENTED**, with the reason recorded.

**FR-RPT-004 is different** and IS delivered in full — see §12. It is a
correctness-of-presentation requirement, it is cheap, and omitting it would
produce exactly the defect its own rationale names.

---

## §5. AUDIT OF THE ACTUAL DATA SOURCES

Every field below was read from `prisma/schema.prisma` and the writing service
at this HEAD. Nothing is taken from a prior report.

### 5.1 `sales.orders` (`schema.prisma:1821-1876`)

| Column | Type | Owner | Nature | Written by | Can change later? | Exactly recomputable? |
|---|---|---|---|---|---|---|
| `tenant_id`, `branch_id`, `business_day` | uuid/uuid/date | Sales | immutable | `OrdersService.create` | No | n/a |
| `state` | `OrderState` | Sales | mutable → terminal | state machine | Only forward; `completed` is terminal | n/a |
| `currency` | char(3) | Sales | **immutable snapshot** of the branch's currency at open | `OrdersService.create` | No | No — branch currency is mutable (§22) |
| `subtotal` | bigint | Sales | maintained projection | `recomputeTotals` | While pre-finalised | Yes, from lines |
| `tax_total` | bigint | Sales | maintained projection | `recomputeTotals` | While pre-finalised | Yes, from lines |
| `grand_total` | bigint | Sales | maintained projection | `recomputeTotals` | While pre-finalised | Yes, from lines |
| `discount_total` | bigint | Sales | **structurally 0** | never written | No | Yes (0) |
| `service_charge_total` | bigint | Sales | **structurally 0** | never written | No | Yes (0) |
| `tip_total` | bigint | Sales | **structurally 0** | never written | No | Yes (0) |
| `rounding_adjustment` | bigint | Sales | **payment-side aggregate** | `sales-payment.service.ts:395,557` — `{ increment: roundingAdjustment }` | Increases with each cash payment | Yes, from that order's payments |
| `paid_total` | bigint | Sales | maintained projection | payment path | Increases until settlement | Yes, from payments |
| `cogs_total` | bigint? | Sales | **posted at completion** | `sales-payment.service.ts:543,563` — Σ Inventory allocation cost | No, once completed | No (FR-CST-002: never recomputed) |
| `completed_at` | timestamptz? | Sales | write-once | completion path | No | n/a |

**Verified structural zeros (live dev DB, 2,407 orders):**
`discount_total ≠ 0` → **0 rows**; `service_charge_total ≠ 0` → **0 rows**;
`tip_total ≠ 0` → **0 rows**; `order_lines.line_discount ≠ 0` → **0 rows of
1,958** (the column is hard-coded `0n` at `order-lines.service.ts:328`).
`rounding_adjustment ≠ 0` → **4 rows**, all `partially_paid` — the D-3
correction in §3.

**Duplicates/retries:** impossible. `uq_orders_idempotency
(tenant_id, idempotency_key, business_day)`.

### 5.2 `sales.order_lines` (`schema.prisma:1881-1938`)

`line_subtotal` = extended price + `modifier_total`
(`order-lines.service.ts:275`).
`line_total` = `line_subtotal` under **tax-inclusive** pricing, or
`line_subtotal + tax_amount` under **tax-exclusive**
(`order-lines.service.ts:306-309`).
**Therefore `line_total` is ALWAYS tax-inclusive gross, in both pricing
modes.** This is the single most load-bearing fact in §8.

`tax_amount` is the **sum of the FR-FIN-032 components**; the per-component
breakdown is **not persisted** (§11). `tax_class_id` is a Localisation-owned
FK. `unit_cost_snapshot` / `posted_cogs_total` are BR-POS-004 / P1F-2
snapshots, never recomputed.

**`voided` and `comped` lines are excluded from every order total**
(`order-lines.service.ts:930`, `state: { notIn: ['voided','comped'] }`). A
report reading `orders.*_total` therefore inherits that exclusion for free and
must not re-derive it from lines with a different filter.

### 5.3 `sales.order_payments` (`schema.prisma:2045-2141`)

**Append-only financial ledger.** `onDelete: Restrict`; no order-deletion path
exists (ADR-010).

| Column | Nature | Report meaning |
|---|---|---|
| `branch_id` | **structurally equal to the order's branch** — the FK is `(tenant_id, order_id, business_day, branch_id) → orders(…)`, so a mismatch is **unrepresentable, not merely validated** | Enables the orders-first join to be provably complete |
| `business_day` | copied from the order | A payment is booked to the **order's** business day, never the capture day |
| `tender` | `cash` \| `manual_external_card` — **the only two that exist** | FR-FIN-010's remaining nine tender types are unbuilt |
| `amount` | *"The EXACT amount this Payment contributes to `orders.paid_total`. NEVER the cash-rounded figure"*; `CHECK amount > 0` | **THE sales figure for tender totals** |
| `rounding_adjustment` | `roundedCashDue − amount`; **CASH only** (CHECK-enforced 0 for card) | FR-FIN-004 term 8 |
| `tendered_amount` | what the customer physically handed over; NULL for card | **NEVER a sales figure** |
| `change_given` | `tendered_amount − roundedCashDue`; NULL for card | **NEVER a sales figure** |
| `card_scheme` | `VarChar(32)`, **optional, cashier-typed free text**, no vocabulary, no normalisation (`sales.dto.ts:244` — `@IsOptional() @IsString() @MaxLength(32)`) | §9 — **not a settlement fact** |
| `cash_session_id` | validated at capture against Treasury's `CashSessionFactsQuery` | The only link from a payment to a session |

**Duplicates/retries:** `@Idempotent()` on the capture route plus a
permanent-id replay branch (`sales-payment.service.ts:143-190`). A replay
returns the original row; it does not insert a second one.

**Corrections:** none. No UPDATE path, no reversal, no refund.

### 5.4 `treasury.cash_sessions` (`schema.prisma:2297-2361`)

**FINDING — no business-day column.** The model carries
`opened_at`/`closed_at` (`timestamptz`) and nothing else temporal.
`workforce.shifts` (`:2199`) likewise. **No session can be attributed to a
business day from its own row.** §10 resolves this.

Close facts (`expected_cash`, `counted_cash`, `variance`, `variance_reason`)
are *"populated **EXACTLY ONCE**, at `closed`, copied FROM the immutable
attempt — never a second mutable copy"*. `close_attempt_id` is the anchor:
NULL while `open`; the one legal attempt id while `closing`/`closed`.

### 5.5 `treasury.cash_session_close_attempts` (`schema.prisma:2374-2437`)

**DECISIVE FINDING — `@@unique([tenantId, cashSessionId], map: "uq_csca_one_per_session")`.**
*"Exactly one per session … the blind-integrity guarantee."* Append-only:
`ros_app` holds SELECT + a column-level INSERT excluding `createdAt`; **no
UPDATE, no DELETE**.

The attempt-cardinality hazard the gate was asked to prove impossible is
**structurally impossible at the database level** (§10).

### 5.6 `treasury.cash_movements` (`:2470-2502`) · `cash_count_denominations` (`:2441-2455`) · `cash_close_policies` (`:2524`)

Movements: append-only, positive magnitudes, type supplies the sign; already
exposed to Treasury-internal callers by `CASH_MOVEMENT_TOTALS_QUERY`.
Denominations: composite-PK, append-only, attempt-scoped — **line-level detail
this slice does not surface**. Policy: immutable, effective-dated, pinned onto
each attempt.

### 5.7 Inventory stock-level read surface

`GET /inventory/levels` (`inventory.controller.ts:732`, `inventory.view`,
optional `locationId`). **Already exists and is not rebuilt, wrapped or
re-exposed by this slice.**

### 5.8 Country-pack / tax-class substrate

`fiscal.tax_classes` (`:1388`) is **Localisation-owned**, keyed
`(tenant_id, country_pack_code, code)`, deliberately FK-less to a
`country_packs` table *that is not created*.
`orders.country_pack_version` is a **`VarChar(24)` version string with no pack
`code` column and no FK**. Pack resolution today reaches the code through
**`branch.country_code`** (`sales-payment.service.ts:235-241`), i.e. a
*currently-stored branch attribute*, not a per-order pin. §11 is where that
matters.

---

## §6. WHAT COUNTS AS A SALE

### The reachable state space at this HEAD

`order-state.ts` `TRANSITIONS`, read literally:

```
draft           -> open, cancelled
open            -> held, parked, cancelled, partially_paid, completed
held            -> open, cancelled
parked          -> open, cancelled
partially_paid  -> completed
completed       -> (terminal)
cancelled       -> (terminal)
partially_refunded -> (terminal, UNREACHABLE)
refunded           -> (terminal, UNREACHABLE)
```

Four consequences, each load-bearing:

1. **`completed` is reachable only through settlement.** The completion path
   fires when `paid_total >= grand_total`
   (`sales-payment.service.ts:451-452`, `assertTransition(order.state,
   'completed')`). **Every completed order is fully paid.** There is no
   "completed but unpaid" row.
2. **A `cancelled` order can never carry a payment.** A first payment moves
   `open → partially_paid`, and `partially_paid` has **exactly one** legal
   successor: `completed`. `partially_paid → cancelled` is not a transition.
   No cancelled order holds money.
3. **A `partially_paid` order CAN hold real, captured, in-drawer money
   indefinitely.** This is the abandoned-split-tender case, and it is the
   single reason options (A) and (B) below are **not** equivalent.
4. **Refunds, comps and post-fire voids do not exist.** `pos.refund.issue` is
   unseeded; `partially_refunded`/`refunded` are unreachable; `is_comp` is
   never set true; `TicketLineStatus.cancelled` exists but nothing writes it.

### The four candidate definitions, evaluated

| | Definition | Verdict |
|---|---|---|
| **A** | `state = 'completed'` only | **SELECTED** for the sales summary |
| **B** | any order with a captured payment | **REJECTED for revenue** — admits `partially_paid` orders whose revenue is not yet earned and whose totals can still change. Recognising revenue on a partly-settled order is a false financial semantic. **But see the split below.** |
| **C** | completed + future refunded/adjusted states | **N/A** — unreachable at this HEAD. Recorded as the exact extension point the future Refund slice must revisit. |
| **D** | another source-backed definition | None found. `FR-CST-001` computes COGS *"on order completion"*; `FR-FIN-022`'s Z report pairs *"gross sales"* with *"transaction count"*; §19.3's Sales Summary is *"Gross, discounts, refunds, net, tax"*. Every SRS anchor keys revenue to a **completed transaction**. |

> ### **SALES POPULATION**
> `sales.orders` WHERE `tenant_id = :tenantId` AND `branch_id = :branchId`
> AND `business_day = :businessDay` AND `state = 'completed'`.
>
> Line-level exclusions (`voided`, `comped`) are already baked into the
> persisted order totals and are **not** re-applied.

> ### **EXCLUDED POPULATION**
> `draft` · `open` · `held` · `parked` · **`partially_paid`** · `cancelled`
> — and, structurally, `partially_refunded` / `refunded`, which cannot exist.

### The reconciliation split — mandatory, not optional

**Tender totals MUST NOT use the sales population.**

FR-FIN-010 exists *"per session and per day"* and §19.3 labels *Sales by
Tender* as the **"Reconciliation basis"**. Its job is to agree with the cash
drawer. Treasury's own already-shipped close reads
`CashSessionTenderTotalsQueryService`, whose `where` clause is
`{ tenantId, cashSessionId }` — **no order-state filter whatsoever**. The
drawer physically holds the money from a `partially_paid` order, and
`expected_cash` already counts it.

> **A daily tender total restricted to completed orders would contradict the
> ratified P1G-1 cash close on the same day's data.** That is not a
> presentation preference; it is a defect.

> ### **TENDER POPULATION**
> **ALL** `sales.order_payments` rows for `(tenant_id, branch_id,
> business_day)`, regardless of the paying order's state.

The two populations are therefore **different by design**, and the DTO
**must** say so on its face (§7.9). The gap between them is exactly the money
taken on orders not yet settled, and the report exposes it as a first-class
field rather than letting a manager discover it as a discrepancy.

---

## §7. DAILY SALES SUMMARY — EVERY FIELD DEFINED

Money crossing the wire is **bigint minor units serialised via `.toString()`**
— `moneyStringSchema()`, never a JSON number (ADR-008 / BR-FIN-005). Dates use
`businessDaySchema()` (`YYYY-MM-DD`), instants `isoDateTimeSchema()`.

Let **`S`** = the SALES POPULATION (§6). Let **`P`** = the TENDER POPULATION.

### 7.1 `branchId` · `businessDay` · `currency`

| | |
|---|---|
| **Formula** | `branchId` = the resolved path parameter (§16). `businessDay` = the validated path parameter. `currency` = `BranchCurrencyQuery.find(...).baseCurrency` (§15). |
| **Source** | `org.branches` **via Organisation's public contract** — never `orders.currency`, never the request body, never a client header. |
| **Zero/null** | Never null. An unresolvable branch is a **404** before any aggregate runs (§25). |
| **Guard** | Every order in `S` and every payment in `P` **must** carry this currency; a mismatch is refused (§22). |

### 7.2 `grossSales`

| | |
|---|---|
| **Formula** | `Σ orders.grand_total` over `S` |
| **Source rows** | `sales.orders`, one row per completed order |
| **Semantics** | **Tax-INCLUSIVE.** `grand_total = Σ line_total`, and `line_total` is tax-inclusive under both pricing modes (§5.2). See §8. |
| **Money** | bigint → string |
| **Zero** | `"0"` when `S` is empty — a truthful, computed zero |
| **Null** | never |

### 7.3 `discounts`

| | |
|---|---|
| **Formula** | `Σ orders.discount_total` over `S` |
| **Value today** | **Literal `"0"`, and it is mathematically truthful.** The column is never written; `order_lines.line_discount` is hard-coded `0n`; 0 of 1,958 live line rows are non-zero. |
| **Classification** | **STRUCTURALLY ZERO — no discount/comp mechanism exists.** `pos.discount.apply` / `pos.comp.apply` are unseeded; §19.3's *Discount & Comp Analysis* is **NOT IMPLEMENTED**. |
| **Why not omitted** | §19.3's *Sales Summary* names it and FR-FIN-022 requires it in the Z report. Omitting an SRS report field because its producer is unbuilt would hide the gap; emitting a truthful computed zero with a labelled reason discloses it. The field is computed by `SUM`, not hard-coded — the day discounts ship, the number moves with no DTO change. |

### 7.4 `refunds`

| | |
|---|---|
| **Formula** | Literal `0n`. **Not a `SUM` — there is nothing to sum.** |
| **Classification** | **STRUCTURALLY ZERO — no refund mechanism, and the states are unreachable** (§6). `pos.refund.issue` unseeded; no refund route in the 109-path surface. |
| **Truthfulness** | Exact. A refund cannot exist, so the day's refunds are provably zero. |
| **Binding constraint** | The future Refund slice **must** revisit this field, the SALES POPULATION (§6 option C) and `periodStatus` (§12). Recorded, not implemented. |

### 7.5 `netSales`

| | |
|---|---|
| **Formula** | `grossSales − discounts − refunds − taxTotal` |
| **Source** | **FR-CST-003 `[M]`, verbatim:** *"Net Sales = Gross Sales − Discounts − Refunds − Tax"* |
| **Collapses today to** | `grossSales − taxTotal`, because discounts and refunds are provably zero |
| **Cross-check** | Equals `Σ (orders.grand_total − orders.tax_total)` over `S`, which is the ex-tax net of every non-voided, non-comped line — correct under **both** pricing modes |
| **Zero/null** | `"0"` when `S` empty; never null |

### 7.6 `taxTotal`

| | |
|---|---|
| **Formula** | `Σ orders.tax_total` over `S` |
| **Source** | FR-FIN-034 — tax is computed **at line level and summed**, never on the order total. `orders.tax_total = Σ order_lines.tax_amount` over non-voided, non-comped lines. |
| **Money / zero / null** | bigint → string; `"0"` when empty; never null |

### 7.7 `roundingAdjustment` — **DELIBERATELY NOT A SALES FIELD**

Two different columns share this name and they are **not interchangeable**:

| | `orders.rounding_adjustment` | `order_payments.rounding_adjustment` |
|---|---|---|
| Written by | payment path, `{ increment: … }` | payment path, per row |
| Scope | that order's cash payments | one cash payment |
| Population it would sum over | `S` — **excludes partially-paid orders** | `P` — the full drawer-relevant set |
| Live non-zero rows | **4, all `partially_paid`** — i.e. every non-zero value in the dev DB would be **invisible** to an `S`-scoped sum | n/a |

**Decision.** The daily figure is **`Σ order_payments.rounding_adjustment`
over `P`**, reported **inside the tender section as
`cashRoundingAdjustments`**, exactly matching FR-FIN-004 term 8
(*"± Cash Rounding Adjustments"*) and Treasury's existing
`CashSessionTenderTotals.cashRoundingAdjustments`.

**It sits OUTSIDE gross and net.** `sales-payment.service.ts:98-101` is
explicit: *"a SEPARATE, cash-drawer-reconciliation-only figure (FR-FIN-004) —
never added to `paid_total`, never absorbed into revenue or tax
(BR-FIN-004)."* Folding it into gross or net would corrupt both.

**No `roundingAdjustment` field appears in the sales-summary object.**

### 7.8 `completedOrderCount` · `averageOrderValue`

| | |
|---|---|
| `completedOrderCount` | `COUNT(*)` over `S`. Integer, not money. `0` when empty. This is FR-FIN-022's *"transaction count"*. |
| `averageOrderValue` | `divideRounded(netSales, completedOrderCount, RoundingMode.HALF_UP)` — the repository's exact bigint helper (`common/money/rounding.ts:69`), BR-FIN-001 rounding. |
| **Null semantics** | **`null` when `completedOrderCount = 0`.** Not `"0"` — an average of nothing is undefined, and emitting `"0"` would read as "the average order was worth nothing". This is the one field in the DTO that is legitimately nullable. |
| **Basis** | **NET.** The SRS never defines AOV's numerator (verified: every occurrence — §12.1 line 3542, FR-FIN-022, §17.x line 3951, §18.x line 4030, §19.3 *Sales by Employee*, *Average Order Value Trend* — names it without a formula). Net is chosen because §13 makes **Net Sales** the SRS's canonical revenue measure in every ratio it defines (`Food Cost % = COGS ÷ Net Sales`, `Prime Cost % ÷ Net Sales`, `Sales per Labour Hour = Net Sales ÷ Hours`) and because FR-CST-035's ledger produces *"= Net Sales (excl. tax)"* as the revenue line. **This is the one genuine source-silence business definition in the slice — §26 DECISION 3.** `grossSales` and `completedOrderCount` are both in the same response, so a client preferring a gross basis can compute it without a second call. |

### 7.9 `openOrderCount` · `unsettledCapturedTotal` — the honesty pair

| | |
|---|---|
| `openOrderCount` | `COUNT(*)` over `sales.orders` for `(tenant, branch, businessDay)` where `state IN ('draft','open','held','parked','partially_paid')` |
| `unsettledCapturedTotal` | `Σ order_payments.amount` over `P` whose order is **not** `completed` |
| **Why** | These two numbers are the entire explanation for why `Σ tenderTotals.amount ≠ grossSales`. Without them a manager comparing the two sections finds an unexplained gap and files a support ticket — the precise failure FR-RPT-004's rationale describes. With them, the arithmetic closes: **`Σ tenderTotals.amount = grossSales + unsettledCapturedTotal`** (exactly, because every completed order is fully paid and no other order state can hold a payment except `partially_paid`). |
| **Zero/null** | integer `0` / `"0"`; never null |

This identity is a **required test assertion** (§29).

### 7.10 `cogsTotal` — **DELIBERATELY EXCLUDED**

`orders.cogs_total` is populated and exact (posted at completion from
Inventory allocations, FR-CST-002 never-recomputed). Summing it over `S` would
be trivially correct.

**It is excluded anyway, on least-privilege grounds:**

- §19.3 places *Sales Summary* under **Sales Reports** with key content
  *"Gross, discounts, refunds, net, tax, by period"* — **COGS is not in it.**
  COGS appears only in *Prime Cost* (`COGS + labour against net sales`) and
  the Inventory/margin reports.
- §15.2 defines **`inventory.cost.view` — "View item costs and valuation"**,
  and this repository already honours that separation:
  `GET /inventory/items/{id}/movements` is gated by `inventory.cost.view`,
  not `inventory.view`.
- Putting COGS behind a `report.view.*` code would hand cost visibility to
  every holder of a sales-report permission, **silently widening
  `inventory.cost.view`**. §17's *"do not silently grant permissions"* forbids
  that.

**Recorded for the future Prime Cost / Food Cost report**, which must resolve
the cost-visibility permission question explicitly. Not a blocker here: FR-CST-003
is not claimed by this slice.

### 7.11 `dataAsOf` · `periodStatus`

See §12. Both are mandatory response fields.

### 7.12 The complete sales-summary object

```
salesSummary: {
  grossSales:             money-string   // Σ orders.grand_total  (tax-INCLUSIVE)
  discounts:              money-string   // Σ orders.discount_total — structurally 0
  refunds:                money-string   // literal 0 — structurally impossible
  taxTotal:               money-string   // Σ orders.tax_total
  netSales:               money-string   // gross − discounts − refunds − tax   (FR-CST-003)
  completedOrderCount:    integer
  averageOrderValue:      money-string | null   // netSales ÷ count, HALF_UP; null when count = 0
  openOrderCount:         integer        // §7.9
  unsettledCapturedTotal: money-string   // §7.9
}
```

**Absent by decision, each with its reason recorded above:** `roundingAdjustment`
(§7.7 — belongs to tender), `cogsTotal` (§7.10 — permission), `serviceCharge`
and `tips` (structurally zero, named by no §19.3 Sales Summary content),
`salesByCategory` / `salesByItem` / `salesByHour` / `salesByOrderType` /
`salesByEmployee` (separate §19.3 catalogue reports, out of scope).

---

## §8. GROSS AND NET — RESOLVED FROM SOURCE, NOT CONVENTION

The gate was required not to import restaurant-industry convention. It did
not. Both terms are **defined by the SRS**.

### The two SRS statements, verbatim

**FR-CST-003 `[M]`** (§13.2, line 3251):

```
Food Cost % = COGS ÷ Net Sales × 100
where Net Sales = Gross Sales − Discounts − Refunds − Tax
```

**FR-CST-035 `[S]`** (§13.6, lines 3362-3365):

```
  Gross Sales
− Discounts
− Refunds
= Net Sales (excl. tax)
```

### Reconciling them

They agree if and only if **Gross Sales is tax-inclusive** in FR-CST-003 and
FR-CST-035 simply does not itemise the tax line while still labelling its
result *"(excl. tax)"*. FR-CST-003 is `[M]`, is an explicit equation, and
names Tax as a subtracted term; FR-CST-035 is `[S]` and is a presentation
ledger. **FR-CST-003 governs.**

### The answers

| Question | Answer | Authority |
|---|---|---|
| Is `grossSales = Σ orders.grand_total`? | **Yes** | `grand_total = Σ line_total`; `line_total` is the tax-inclusive gross of every non-voided, non-comped line (`order-lines.service.ts:306-309`, `:930`) |
| Pre- or post-discount? | **Post-discount is unobservable and irrelevant today** — discounts are structurally zero. FR-CST-035's ledger subtracts discounts *from* gross, so gross is **pre-discount**. When discounts ship, `grand_total` must remain pre-discount or the ledger double-subtracts. **Recorded as a binding constraint on the future discount slice.** | FR-CST-035 |
| Is tax included in gross? | **YES.** | FR-CST-003 subtracts Tax to reach Net |
| What is `netSales` in ROS? | **`Gross − Discounts − Refunds − Tax`** — the ex-tax, ex-discount, ex-refund revenue figure | FR-CST-003 `[M]` |
| Does `rounding_adjustment` sit inside or outside gross/net? | **OUTSIDE both.** | BR-FIN-004; `sales-payment.service.ts:98-101` — *"never absorbed into revenue or tax"* |
| Is COGS unrelated to net sales? | **Related but not a component.** FR-CST-003 makes COGS the *numerator* of a ratio over Net Sales; FR-CST-035 subtracts it *after* Net Sales to reach Gross Profit. It is never inside net. Excluded here for the §7.10 permission reason. | FR-CST-003 / FR-CST-035 |

**No user decision is required on gross/net.** The source decides both.

### Pricing-mode robustness — the property that makes this safe

Under **tax-exclusive** pricing `line_subtotal` excludes tax and
`line_total = line_subtotal + tax_amount`. Under **tax-inclusive** pricing
`line_subtotal` already contains tax and `line_total = line_subtotal`.

`orders.subtotal` (`= Σ line_subtotal`) therefore **means different things in
the two modes** and is a trap. `orders.grand_total` and `orders.tax_total` do
not: gross is always tax-inclusive and `gross − tax` is always the ex-tax net.

> **BINDING CONSTRAINT: `orders.subtotal` MUST NOT appear in the report and
> MUST NOT be used in any formula.** A future mixed-mode tenant would silently
> corrupt any figure derived from it.

---

## §9. SALES BY TENDER — FINANCIAL CORRECTNESS

### The exact cash identity

From `sales-payment.service.ts:252-274`:

```
roundedCashDue     = amount + roundingAdjustment        // rounding may be negative
changeGiven        = tenderedAmount − roundedCashDue
⇒ tenderedAmount   = amount + roundingAdjustment + changeGiven          (exact)
```

The brief's worked example: customer owes **90**, hands over **100**, change
**10**, no cash-rounding step → `amount = 90`, `roundingAdjustment = 0`,
`tenderedAmount = 100`, `changeGiven = 10`.

> **Daily cash SALES = 90.** Not 100. Not 90 + rounding.

### The equations, exactly

```
cashSalesTotal            = Σ  p.amount               WHERE p.tender = 'cash'          over P
cashRoundingAdjustments   = Σ  p.rounding_adjustment  WHERE p.tender = 'cash'          over P
manualExternalCardTotal   = Σ  p.amount               WHERE p.tender = 'manual_external_card'  over P
cashDrawerContribution    = cashSalesTotal + cashRoundingAdjustments     // FR-FIN-004 terms 2 + 8
tenderGrandTotal          = cashSalesTotal + manualExternalCardTotal
paymentCount              = COUNT(*)                                     over P
```

**`tendered_amount` and `change_given` appear in NO aggregate, at any level.**
They are per-transaction drawer mechanics, not money the business earned.
`rounding_adjustment` is CHECK-enforced `= 0` for card
(`ck_order_payments_card_fields`), so the cash-only predicate is belt and
braces, not a filter the arithmetic depends on.

**`cashDrawerContribution` is named and exported deliberately**: it is the
figure that must agree with `CashSessionCloseAttempt.cash_sales_total +
cash_rounding_adjustments` summed over the day's sessions, and naming it makes
that a testable identity rather than a reader's mental arithmetic.

### Card scheme — FR-FIN-010's *"each card scheme"* limb

FR-FIN-010 `[M]` requires totals by *"cash, **each card scheme**, each wallet,
gift card, voucher, on-account, and aggregator-settled"*.

**Available stored fact:** `order_payments.card_scheme` — `VarChar(32)`,
**optional**, cashier-typed, validated only as
`@IsOptional() @IsString() @MaxLength(32)`. **No vocabulary. No
normalisation. No enum. No integrated terminal** (FR-POS-064 NOT IMPLEMENTED;
the column's own docblock calls the reference *"the cashier's own record of the
already-completed external-terminal transaction"*).

| Option | Assessment |
|---|---|
| One `manual_external_card` bucket only | **SELECTED** |
| Additionally group by `card_scheme` | **REJECTED.** `"VISA"`, `"Visa"`, `"visa"` and `NULL` would become four buckets of one financial category. Presenting cashier free text as a per-scheme financial breakdown is exactly the false financial semantics this gate was told to prevent. |

> ### **FR-FIN-010 CLASSIFICATION**
> **PARTIAL — and this slice advances it without completing it.**
>
> - *"per session"* — **satisfied** by the shipped P1G-1 close
>   (`CashSessionTenderTotalsQuery`).
> - *"per day"* — **satisfied by this slice**, for the two tenders that exist.
> - *"each card scheme"* — **NOT SATISFIED.** No trustworthy scheme fact is
>   stored. Requires either an integrated payment terminal (FR-POS-064) or a
>   validated scheme vocabulary from the country pack. Neither exists.
> - *"each wallet, gift card, voucher, on-account, aggregator-settled"* —
>   **NOT SATISFIED.** `OrderPaymentTender` defines two values and its own
>   docblock records why: *"The SRS names eleven; adding the other nine here
>   would be appearance without capability."*

### Idempotent-replay safety

A replayed capture returns the stored response and inserts nothing
(`sales-payment.service.ts:143-190`, plus `@Idempotent()`). Aggregates read
rows, so a replay cannot double-count. **Required test (§29).**

---

## §10. CASH / SESSION ROLL-UP — ATTEMPT CARDINALITY

### The attempt-cardinality question, closed at the database level

> `@@unique([tenantId, cashSessionId], map: "uq_csca_one_per_session")`
> — `schema.prisma:2432`

**A session can hold at most ONE close attempt. Ever.** The table is
append-only (`ros_app`: SELECT + column-level INSERT only — no UPDATE, no
DELETE). There is no retry row, no rejected-then-resubmitted row, no
superseded row. The P1G-1 design calls this *"the blind-integrity
guarantee"*.

Consequently the three hazards the gate was required to disprove are
**structurally impossible, not merely avoided by a careful query**:

| Hazard | Why it cannot occur |
|---|---|
| One session counted twice | `cash_sessions` is queried by primary key over a **`DISTINCT`** id set (below). |
| Multiple declaration attempts summed as separate shifts | `uq_csca_one_per_session` — at most one attempt exists per session. |
| An unfinalised attempt treated as a closed session | The report reads **`cash_sessions.status`** and the **anchor** `close_attempt_id`, never the attempt table's existence. `status = 'closing'` means *frozen pending a manager variance decision*; `expected_cash`/`counted_cash`/`variance` on the session row are **NULL until `closed`** and are *"populated EXACTLY ONCE, at `closed`, copied FROM the immutable attempt"*. |

> ### **CLOSE ATTEMPT RULE**
> **The authoritative record for a daily session roll-up is the
> `treasury.cash_sessions` ROW, never the attempt table.** A session is
> reported as closed **iff `status = 'closed'`**. Its close facts are read
> from the session row's own copied columns. `cash_session_close_attempts` is
> **not queried at all** by this slice, and neither is
> `cash_count_denominations`.

### Which sessions belong to a business day — the real problem

**`treasury.cash_sessions` has no `business_day` column** (§5.4). Neither does
`workforce.shifts`. Three candidate attribution rules:

| | Rule | Assessment |
|---|---|---|
| **(i)** | `resolveBusinessDay(opened_at, branch.timezone, cutover)` — the same rule orders use | **REJECTED.** Requires a **second implementation** of business-day derivation outside Sales (`business-day.ts` is a private Sales path; copying it into Treasury or Organisation creates a divergence hazard where orders and reports could disagree about what a business day *is*). Worse: **`org.branches.timezone` is MUTABLE** (`branches.service.ts:149-151`), so re-deriving a *historical* day's boundary from *today's* timezone is not historically stable — the FR-RPT-005 Type-2 problem, live. |
| **(ii)** | `closed_at` falls in the day | **REJECTED.** Same timezone problem, and an open session has no `closed_at` at all. |
| **(iii)** | **The session captured at least one payment attributed to `(branch, businessDay)`** | **SELECTED.** |

**Why (iii) is right, not merely convenient:**

- It uses **only already-persisted, server-derived, immutable facts**:
  `order_payments.business_day` is copied from the order, whose business day
  was derived **once**, server-side, at creation
  (`orders.service.ts:240`; `at` is **not** client-supplied — `CreateOrderDto`
  has no such field, only `originDeviceTime`, which the docblock states
  *"never decides the business day"*).
- It needs **no timezone arithmetic**, so a later timezone change cannot
  restate a historical day.
- It is **exactly the FR-FIN-010 reconciliation set**: the sessions through
  which this day's money passed.
- The set is computed by `SELECT DISTINCT p.cash_session_id`, so a session
  appears **once**, whatever its payment count.

**Disclosed limitations, both stated in the DTO and the OpenAPI description:**

1. **A session that captured no payments does not appear.** It contributed
   nothing to the day's tender totals. Its float and any variance are
   invisible to this report. *(A session with movements but no sales is the
   one operationally interesting case this misses.)*
2. **A session spanning two business days appears in BOTH days' roll-ups**, and
   its close facts (`expectedCash`/`countedCash`/`variance`) are **whole-session**,
   not day-scoped. The DTO therefore separates the two explicitly:
   `tenderTotalsForThisBusinessDay` (day-scoped, exact, never double-counted)
   versus `sessionCloseFacts` (whole-session, labelled as such).

**Neither limitation can produce a wrong number** — only an incomplete or a
differently-scoped one, and both are labelled on the wire.

### Per-session fields exposed

```
sessions: [{
  sessionId, employeeId, drawerId,
  openedAt, closedAt, status,                  // open | closing | closed
  currency, openingFloat,
  expectedCash | null, countedCash | null, variance | null,   // NULL unless status='closed'
  payInTotal, payOutTotal, safeDropTotal,      // whole-session, Treasury-owned
  isFinalised: status === 'closed',
  tenderTotalsForThisBusinessDay: {            // day-scoped, from Sales
    cashSalesTotal, cashRoundingAdjustments, manualExternalCardTotal, paymentCount
  }
}]
```

`variance` is FR-FIN-005's `countedCash − expectedCash`, DB-CHECK-enforced
(`ck_csca_variance`) against the eight FR-FIN-004 terms on the attempt it was
copied from. The report **re-derives nothing** and **re-validates nothing**.

`varianceRollup` at the day level = `Σ variance` over sessions with
`status = 'closed'` **only**, plus counts
`{ closedSessionCount, unclosedSessionCount }`. Summing a NULL variance into a
total is the exact defect §10 asked to be disproved; the filter is explicit.

### Public contract required — yes

**Reporting code MUST NOT query `treasury.*` tables.** §5.2.3: *"A module MUST
NOT query another module's tables"* — and the `BranchCurrencyQuery` docblock
already records that this rule *"is about DATABASE OWNERSHIP, not merely about
which TypeScript files get imported"*. §15 designs
`DAILY_CASH_RECONCILIATION_QUERY`.

---

## §11. TAX SUMMARY — THE REAL LIMIT

### Re-audited from current source

| Fact | Evidence |
|---|---|
| `order_lines.tax_class_id` — persisted per line | `schema.prisma:1911` |
| `order_lines.tax_amount` — persisted per line, the **SUM** of components | `schema.prisma:1912`; `tax.model.ts:74` — *"Sum of the component amounts"* |
| `orders.country_pack_version` — `VarChar(24)`, **version string only, no pack `code` column, no FK** | `schema.prisma:1854` |
| `fiscal.tax_classes` — Localisation-owned, keyed `(tenant_id, country_pack_code, code)`, **deliberately FK-less** to any pack table | `schema.prisma:1388-1415` |
| Pack code is reached today via **`branch.country_code`** | `sales-payment.service.ts:235-241` |
| **FR-FIN-032 `[M]` — multiple simultaneous tax components**, each with its own `code`, `ratePercent`, base and rounding | SRS §16.6; `tax.model.ts:50-56` `TaxComponentAmount` |
| **The per-component breakdown is NOT persisted anywhere.** `LineTaxResult.components` is computed at sale time and discarded; only its sum reaches the row | `tax.model.ts:66-81` vs `OrderLine` |
| `exempt` and `zeroRated` are computed and discarded too — *"never merged"*, *"a zero-rated supply is inside the scope of the tax at 0%, an exempt supply is outside it"* | `tax.model.ts:60-78` |

### The five options, evaluated

| | Option | Verdict |
|---|---|---|
| **A** | **Tax summary by tax CLASS only** | **SELECTED.** `tax_class_id` is a persisted, immutable, per-line snapshot. `GROUP BY tax_class_id` is exact. |
| **B** | Resolve the historical rate through branch country + pinned pack version | **REJECTED.** Three independent defects: **(1)** the pack **code** is not pinned on the order — it is read from `branch.country_code`, a *currently-stored* attribute, so this is not historical resolution; **(2)** `resolveExact` throws `CountryPackUnavailableError` if that pack version is not activated on the serving node, so a historical report would become *unavailable* rather than *incomplete*; **(3)** under FR-FIN-032 a class maps to **N components**, so "the rate" is not a scalar and the persisted sum cannot be split back into them. |
| **C** | Derive the effective rate mathematically from line amounts | **REJECTED, explicitly and on the gate's own instruction.** `tax_amount / net` is a division of **rounded monetary outputs** (BR-FIN-001 rounds once per line), so it yields 19.97% for a 20% class on small lines. It also cannot distinguish exempt from zero-rated — both are 0 — and cannot recover components. **A legal tax rate must never be inferred from rounded money.** |
| **D** | Add a new persisted pack identity (a `country_pack_code` column on `orders`) | **REJECTED for this slice.** §30 and the gate both forbid a migration *"merely to make a report prettier"*. Recorded as the **exact** change a future by-rate report would need — and it would need **more** than that: the per-component breakdown must also be persisted, which is an `order_line_tax_components` table, i.e. a Fiscal/Localisation slice. |
| **E** | Defer by-rate; expose tax total and by-class | **SELECTED, as the honest framing of A.** |

### Shape

```
taxSummary: {
  taxTotal: money-string,                       // == salesSummary.taxTotal, identical value
  byClass: [{
    taxClassId:      uuid,
    taxClassCode:    string | null,             // via Localisation contract; null if unresolvable
    countryPackCode: string | null,
    taxAmount:       money-string,              // Σ order_lines.tax_amount
    netAmount:       money-string,              // Σ (line_total − tax_amount)
    grossAmount:     money-string,              // Σ line_total
    lineCount:       integer
  }],
  byRate: NOT PRESENT
}
```

`Σ byClass[].taxAmount === taxSummary.taxTotal === salesSummary.taxTotal` is a
**required test assertion** (§29). Line filter: `state NOT IN ('voided','comped')`,
identical to `recomputeTotals` — so the parts sum to the persisted whole by
construction.

`taxClassCode` resolution uses a new Localisation contract (§15). It is
**optional**: if the user prefers to defer it, the summary is keyed by
`taxClassId` alone and everything else is unchanged. Recommended to include —
a UUID-keyed tax summary is not readable by a manager, and §19.3's *Tax
Summary* is a Financial-category report meant to be read.

> ### **TAX CLASSIFICATION**
> §19.3 *Tax Summary — "By rate, class, jurisdiction, period"*
>
> | Limb | Status |
> |---|---|
> | **by class** | **SATISFIED** by this slice |
> | **by period** | **SATISFIED** — one branch-day (§13) |
> | **by jurisdiction** | **PARTIAL** — `countryPackCode` is exposed per class, but it is the class's own jurisdiction family, not a per-order pinned jurisdiction |
> | **by rate** | **NOT IMPLEMENTED** — not derivable from persisted facts. Requires persisting the FR-FIN-032 component breakdown. |
>
> **No fake completeness.** The response carries no `byRate` key at all —
> not an empty array, not a null. A key that is always absent is honest; a key
> that is always empty invites a client to render "no rates".

---

## §12. BUSINESS DAY / PERIOD COMPLETENESS — FR-RPT-004

**FR-RPT-004 `[M]`, verbatim:** *"Every report SHALL display the timestamp of
the data it reflects, and SHALL indicate when data is not yet complete for the
period shown."* Its rationale names the exact failure mode: *"A manager looking
at today's sales at 14:00 must understand that the figure is partial. Systems
that display an incomplete figure without indication generate support tickets
('the report is wrong') that are not defects."*

### What can change a day's figures — exhaustively enumerated at this HEAD

| Path | Possible? | Detectable? |
|---|---|---|
| A **brand-new order** booked to this business day | **Only while the branch is still trading this day.** `business_day` is derived from the **server clock** at creation (`orders.service.ts:193,240`); `at` is a service-internal parameter with **no DTO field** — `CreateOrderDto` carries only `originDeviceTime`, and `business-day.ts` states it *"never decides the business day"*. **A past business day cannot receive a new order.** | By comparing `businessDay` to the branch's current business day |
| An **existing order** of this day moving `open`/`partially_paid` → `completed` | **YES, on any later calendar day.** Payments copy the **order's** `business_day`, not the capture day. This is the genuine late-arrival path. | `openOrderCount > 0` |
| A **cash session** contributing to this day finalising later | **YES.** `open`/`closing` → `closed` writes `expected/counted/variance`. | `unclosedSessionCount > 0` |
| A **refund / void / comp** restating a completed order | **NO.** None implemented (§6). | n/a |
| An **offline replay** landing a backdated sale | **NO.** No offline store exists; the Internal MVP is explicitly online-only. | n/a — but see the binding constraint below |

### The five options, evaluated

| | Option | Verdict |
|---|---|---|
| **A** | `periodComplete = no open CashSession` | **REJECTED.** Ignores the `openOrderCount` path entirely: a fully-closed drawer says nothing about a `partially_paid` order that will settle tomorrow. |
| **B** | complete iff `businessDay < current business day` | **REJECTED.** Ignores both late-arrival paths. Yesterday's day with an unsettled order is **not** complete. |
| **C** | complete only after formal DayClose ⇒ always FALSE | **Truthful but useless.** A single boolean that is a constant carries no information, and a manager reading "incomplete" on a three-day-old settled day learns nothing. It also fails FR-RPT-004's actual purpose, which is to *distinguish*. |
| **D** | **multi-state: open / operationally-ended / sealed** | **SELECTED, in the precise form below.** |
| **E** | another source-backed rule | None found. |

### The selected model

```
periodStatus: 'OPEN' | 'UNSEALED' | 'SETTLED'
```

| Value | Exact condition | Meaning |
|---|---|---|
| **`OPEN`** | `businessDay >= branchCurrentBusinessDay` | The branch is still trading this day (or the day is in the future). **New orders can still be booked into it.** |
| **`UNSEALED`** | `businessDay < branchCurrentBusinessDay` **AND** (`openOrderCount > 0` **OR** `unclosedSessionCount > 0`) | Past day, but named outstanding items can still move these figures. The response says **which** and **how many**. |
| **`SETTLED`** | `businessDay < branchCurrentBusinessDay` **AND** `openOrderCount = 0` **AND** `unclosedSessionCount = 0` | **No path implemented at this HEAD can change these figures.** Provable from the enumeration above. |

**`SEALED` is NOT emitted and NOT declared.** Sealing is a **DayClose**
concept (FR-FIN-020/022/023 — *"sequentially numbered per branch, immutable,
and retrievable for any historical date"*), and no DayClose exists.
Declaring an enum value nothing can produce would be exactly the
appearance-without-capability that `OrderPaymentTender`'s own docblock refuses
(*"adding the other nine here would be appearance without capability"*). The
future DayClose slice adds `SEALED` as a **fourth** value; `SETTLED` keeps its
meaning unchanged.

> ### **BINDING CONSTRAINTS ON `SETTLED`**
> `SETTLED` asserts *"no **currently implemented** path can change this"*. Three
> future slices **must** revisit it, and this is recorded so they cannot miss it:
> **(1) Refund** — a refund against a completed order restates a settled day;
> **(2) Offline sync (FR-OFF-\*)** — a replayed backdated sale restates a settled day;
> **(3) Post-fire void / comp** — same.
> Until any of those ships, `SETTLED` is exact.

### Companion fields — all mandatory

```
dataAsOf:                   iso-instant   // SERVER-AUTHORITATIVE — see below
periodStatus:               'OPEN' | 'UNSEALED' | 'SETTLED'
branchCurrentBusinessDay:   YYYY-MM-DD    // so the client can see WHY
openOrderCount:             integer
unclosedSessionCount:       integer
```

**`dataAsOf` is `SELECT now()` executed INSIDE the report transaction**, not
`new Date()` in Node. Under REPEATABLE READ (§21) `now()` is
`transaction_timestamp()`, which is the instant the snapshot the whole report
was computed from was taken. It is therefore literally *"the timestamp of the
data it reflects"* — not an approximation of it. **No client-supplied or
application-clock value is ever used.**

**`branchCurrentBusinessDay`** is obtained from **Sales'** public contract
(§15), because `business-day.ts` is the **single** implementation that stamps
`orders.business_day`. Deriving it anywhere else would create the divergence
hazard §10 rejected. The ownership tension is recorded honestly: the *calendar
facts* (`timezone`, `business_day_cutover`) are Organisation's, and the
long-term correct home for the derivation is Organisation or a `shared/`
relocation — **a separate slice, not this one.** What matters for correctness
now is that there is exactly **one** implementation.

> ### **FR-RPT-004: SATISFIED IN FULL**
> `dataAsOf` (server-authoritative, snapshot-exact) + a three-state
> `periodStatus` + the two counts that explain it. **No `periodComplete`
> boolean is emitted** — no boolean is truthful across three states, and a
> constant-false one would be information-free.

---

## §13. REPORT PERIOD BOUNDARY

> **ONE branch + ONE business day. No date ranges.**

| Reason | Evidence |
|---|---|
| Simplest query plan, fully index-driven | §20 — `(tenant_id, branch_id, business_day)` is an **exact equality prefix**. A range turns four index scans into four range scans plus cross-partition work. |
| Aligns with the MVP exit criterion | *"A manager can read yesterday's trading."* |
| Aligns with future DayClose / Z | FR-FIN-020 is *"per branch"* per day; FR-FIN-023 requires Z reports *"retrievable for any historical date"* — one branch, one day. |
| Predictable caching/indexing | A single `(tenant, branch, day)` cache key is the natural future §19.2 *"Report cache (Redis, keyed by tenant + params + data version)"* key. |
| Removes ambiguity around incomplete periods | §12's `periodStatus` is well-defined for **one** day. Over a range, a period containing one OPEN day and six SETTLED days has no single honest status. **This alone is decisive.** |

**Deferred, explicitly:** arbitrary date ranges; week/month/hour grain
(FR-RPT-002); NFR-PERF-010's *"31-day period"* target and NFR-PERF-011's
*"100 branches"* target — both are **NOT MEASURED and NOT CLAIMED** by this
slice.

---

## §14. MODULE OWNERSHIP

The POST-KDS recommendation (*no new Reporting module*) was **re-evaluated
from source, not inherited** (§3, D-4).

| | Option | Assessment |
|---|---|---|
| **A** | Sales owns the HTTP endpoint, calls Treasury contracts | **REJECTED.** Makes Sales a cross-domain reporting service — the named risk. Sales would own an HTTP surface whose response is ~40% Treasury and Localisation content, and every future report (Inventory, Kitchen, Workforce, Governance) would either land in Sales too or fragment the surface. It also gives the future extraction (§5.2.4) nothing to extract. |
| **B** | Each domain exposes its own report routes | **REJECTED.** Destroys the single-snapshot property (§21) — the client would assemble a day's trading from 3+ independently-timed responses that can disagree. Also multiplies permission surfaces and makes FR-RPT-004's `dataAsOf` meaningless. |
| **C** | **A thin `reporting` orchestration module owning NO tables, consuming only public contracts** | **SELECTED.** |
| **D** | Full Reporting domain with warehouse persistence | **REJECTED for the Internal MVP** — that is §4's category (B). Nothing in current source forces it now, and the readiness assessment places the Reporting domain at 0% and post-MVP. |

### Why C, on source

- **§5.2.4 names Reporting as extraction candidate #1**: *"When a module must
  become a service (candidates, in likely order: **Reporting**, Sync, Fiscal
  Integration, Notification)"*, and step 1 is *"the module already communicates
  only via its contract and events"*. A module created **owning no tables and
  consuming only contracts** satisfies steps 1 and 2 **from day one** — which is
  precisely the property §5.2.4 says makes extraction *"a matter of days rather
  than a rewrite"*. Option A satisfies neither.
- **§5.2.3**: *"A module MUST NOT query another module's tables."* A composite
  report spans **three** owners (Sales, Treasury, Localisation) plus
  Organisation. Only a module that owns none of them can be honest about it.
- **§5.4** gives it a shape immediately: `contract/` (empty for now — it
  publishes nothing), `application/` (the orchestrator), `presentation/http/`
  (one controller). **No `domain/`, no `infrastructure/persistence/`, no
  `infrastructure/migrations/`** — because it owns no data.
- **Future migration path**: when FR-RPT-001's read replica arrives, the change
  is confined to how this module obtains a `tx`. When FR-RPT-002's rollups
  arrive, this module gains an `infrastructure/persistence/` and *becomes* the
  Reporting domain — without a single consumer changing.
- **Testability**: the orchestrator's collaborators are four injected
  interfaces. Its composition logic is unit-testable with **no database**,
  which is §5.4's stated dependency-rule payoff.

> **A thin read-orchestration module is NOT an Analytics warehouse.** It owns
> no fact table, no dimension table, no rollup, no migration and no cache. §4's
> classification is unaffected: FR-RPT-001/002/003/005 remain NOT IMPLEMENTED
> whichever module holds the controller.

### Boundary consequences

`module-boundaries.spec.ts` legal cross-module imports are
`modules/<other>/contract`, `modules/<other>/contract/<file>` and
`modules/<other>/<other>.module`. The reporting module imports **exactly
those**, from Sales, Treasury, Organisation and Localisation.

It additionally needs the cross-cutting HTTP/auth plumbing every controller
uses (`identity/auth/guards/jwt-auth.guard`,
`identity/authz/decorators/require-permission.decorator`,
`identity/authz/guards/permission.guard`,
`identity/context/current-tenant-context.decorator`,
`identity/context/tenant-context`, `identity/context/tenant-context.guard`).

> ### **KNOWN_DEVIATIONS**
> The spec's own header classifies that set as **category (a) — cross-cutting
> HTTP/auth plumbing** that *"under SRS §5.4 … is not really a module-to-module
> dependency at all"*, and the allow-list already carries the identical entry
> for **catalogue, inventory, organisation, production and sales**.
>
> Adding `'reporting->identity'` with **exactly** that six-path set is a new
> **key**, and this gate does not pretend otherwise. Two honest readings exist,
> and the implementation must pick one and say which:
>
> **(i)** treat it as **zero growth in kind** — no new *category*, no new
> *private path*, the same six paths five modules already list; or
> **(ii)** avoid the key entirely by having `ReportingModule` re-export the
> plumbing it needs through a composition the spec already permits.
>
> **Neither adds a category-(b) genuine-domain-edge deviation, and the
> reporting module adds ZERO private-path imports into Sales, Treasury,
> Organisation, Localisation or Governance.** That is the property that
> matters and it is non-negotiable. **The `sales->localisation` and
> `sales->catalogue` debts are NOT touched, NOT extended, and NOT repaired by
> this slice.**

---

## §15. DOMAIN CONTRACTS

Four contracts. All additive `contract/` files. All **`tx`-first**, following
`CashSessionFactsQuery` / `CashSessionTenderTotalsQuery` /
`CashMovementTotalsQuery` / `BranchCurrencyQuery` exactly. All money is
`bigint` internally and a decimal **string** externally, converted only in the
HTTP view layer.

### 15.1 Sales — `DAILY_TRADING_SALES_QUERY`
`src/modules/sales/contract/daily-trading-sales.query.ts`

```ts
export const DAILY_TRADING_SALES_QUERY = Symbol('DAILY_TRADING_SALES_QUERY');

export interface DailyTradingSalesInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly businessDay: Date;          // UTC midnight, the DATE column's round-trip
}

export interface DailyTradingTenderTotal {
  readonly tender: 'cash' | 'manual_external_card';
  readonly amountTotal: bigint;              // Σ amount        — NEVER tendered_amount
  readonly roundingAdjustmentTotal: bigint;  // Σ rounding_adjustment (cash only)
  readonly paymentCount: number;
}

export interface DailyTradingTaxClassTotal {
  readonly taxClassId: string;
  readonly taxAmount: bigint;
  readonly netAmount: bigint;
  readonly grossAmount: bigint;
  readonly lineCount: number;
}

export interface SessionDayTenderTotals {
  readonly cashSessionId: string;
  readonly cashSalesTotal: bigint;
  readonly cashRoundingAdjustments: bigint;
  readonly manualExternalCardTotal: bigint;
  readonly paymentCount: number;
}

export interface DailyTradingSalesFacts {
  // ── SALES POPULATION: state = 'completed' ──────────────────────────────
  readonly grossSales: bigint;              // Σ orders.grand_total  (tax-INCLUSIVE)
  readonly discountTotal: bigint;           // Σ orders.discount_total — structurally 0
  readonly taxTotal: bigint;                // Σ orders.tax_total
  readonly completedOrderCount: number;
  /** Every distinct orders.currency in the population. >1 ⇒ caller refuses (§22). */
  readonly currencies: readonly string[];

  // ── TENDER POPULATION: ALL payments for the branch-day ─────────────────
  readonly tenderTotals: readonly DailyTradingTenderTotal[];
  readonly unsettledCapturedTotal: bigint;  // Σ amount where order.state <> 'completed'
  /** Every distinct order_payments.currency in the population. */
  readonly paymentCurrencies: readonly string[];

  // ── TAX ────────────────────────────────────────────────────────────────
  readonly taxByClass: readonly DailyTradingTaxClassTotal[];

  // ── SESSION LINKAGE (§10 rule (iii)) ───────────────────────────────────
  readonly sessionDayTotals: readonly SessionDayTenderTotals[];   // DISTINCT session ids

  // ── PERIOD COMPLETENESS (§12) ──────────────────────────────────────────
  readonly openOrderCount: number;          // draft|open|held|parked|partially_paid
}

export interface DailyTradingSalesQuery {
  facts(tx: Prisma.TransactionClient, input: DailyTradingSalesInput):
    Promise<DailyTradingSalesFacts>;

  /**
   * The branch's CURRENT business day (§12) — the SAME derivation that stamps
   * `orders.business_day`. Exposed because there must be exactly ONE
   * implementation of FR-FIN-024 in this system.
   */
  currentBusinessDay(tx: Prisma.TransactionClient,
                     input: { tenantId: string; branchId: string }): Promise<Date>;
}
```

Private implementation: `sales/orders/daily-trading-sales.query.service.ts`,
bound to the token **only** inside `SalesModule` — the
`CashSessionTenderTotalsQueryService` pattern exactly.

### 15.2 Treasury — `DAILY_CASH_RECONCILIATION_QUERY`
`src/modules/treasury/contract/daily-cash-reconciliation.query.ts`

```ts
export const DAILY_CASH_RECONCILIATION_QUERY =
  Symbol('DAILY_CASH_RECONCILIATION_QUERY');

export interface DailyCashReconciliationInput {
  readonly tenantId: string;
  readonly branchId: string;          // fail-closed: sessions outside it are DROPPED
  readonly cashSessionIds: readonly string[];   // DISTINCT, from Sales (§10 rule (iii))
}

export interface CashSessionDayFacts {
  readonly cashSessionId: string;
  readonly employeeId: string;
  readonly drawerId: string;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly status: 'open' | 'closing' | 'closed';
  readonly currency: string;
  readonly openingFloat: bigint;
  /** NULL unless status='closed'. Copied ONCE from the immutable attempt. */
  readonly expectedCash: bigint | null;
  readonly countedCash: bigint | null;
  readonly variance: bigint | null;
  /** Whole-session movement totals (FR-FIN-004 terms 4/6/7). */
  readonly payInTotal: bigint;
  readonly payOutTotal: bigint;
  readonly safeDropTotal: bigint;
}

export interface DailyCashReconciliationQuery {
  forSessions(tx: Prisma.TransactionClient,
              input: DailyCashReconciliationInput):
    Promise<readonly CashSessionDayFacts[]>;
}
```

**Fail-closed rules, binding:** an id that does not resolve, or resolves to a
different branch, is **silently dropped** (never a partial or a foreign row).
The result set is a **subset** of the input ids; the orchestrator asserts the
subset relation and surfaces any drop as a defect in tests, never to the
client. `cash_session_close_attempts` and `cash_count_denominations` are
**NOT** read (§10).

### 15.3 Organisation — `BRANCH_REPORTING_SCOPE_QUERY`
`src/modules/organisation/contract/branch-reporting-scope.query.ts`

```ts
export const BRANCH_REPORTING_SCOPE_QUERY =
  Symbol('BRANCH_REPORTING_SCOPE_QUERY');

export interface OperativeBranchesInput {
  readonly tenantId: string;
  /** Cap. The guard needs only to distinguish 0 / 1 / >1, so 2 suffices. */
  readonly limit: number;
}

export interface BranchReportingScopeQuery {
  /** Ids of branches with status='active', capped at `limit`. Ordered by id. */
  operativeBranches(tx: Prisma.TransactionClient,
                    input: OperativeBranchesInput): Promise<readonly string[]>;
}
```

**Branch existence, tenant-safety and currency** come from the **existing**
`BRANCH_CURRENCY_QUERY`, whose `find()` already *"returns `null` when the
branch id does not resolve — unknown id, or a genuinely cross-tenant id (RLS
makes the row invisible …)"*. **No new existence query is created.**

### 15.4 Localisation — `TAX_CLASS_LABELS_QUERY` *(optional; recommended)*
`src/modules/localisation/contract/tax-class-labels.query.ts`

```ts
export const TAX_CLASS_LABELS_QUERY = Symbol('TAX_CLASS_LABELS_QUERY');

export interface TaxClassLabel {
  readonly taxClassId: string;
  readonly code: string;              // immutable semantic key
  readonly countryPackCode: string;
}

export interface TaxClassLabelsQuery {
  findByIds(tx: Prisma.TransactionClient,
            input: { tenantId: string; taxClassIds: readonly string[] }):
    Promise<readonly TaxClassLabel[]>;
}
```

Returns labels only — **no rate, no component, no engine access**, mirroring
`PinnedPaymentPolicyQuery`'s stated refusal to expose *"the full tax engine
configuration"*. Unresolved ids yield `null` labels in the response, never an
error.

### 15.5 Inventory — **NO new contract**

Stock-on-hand stays exactly where it is: `GET /inventory/levels`, gated by
`inventory.view`. It is **not** wrapped, proxied, duplicated or re-exposed.

### 15.6 What each module queries

| Module | Tables it touches | Tables it must NOT touch |
|---|---|---|
| Sales | `sales.orders`, `sales.order_lines`, `sales.order_payments` | everything else |
| Treasury | `treasury.cash_sessions`, `treasury.cash_movements` | `sales.*` |
| Organisation | `org.branches` (+ `org.operating_hours` for the calendar it already owns) | `sales.*`, `treasury.*` |
| Localisation | `fiscal.tax_classes` | `sales.*` |
| **`reporting`** | **NONE. Zero tables. Zero migrations.** | **all of them** |

---

## §16. BRANCH SECURITY — MANDATORY EXPLICIT ANALYSIS

### The position, restated without softening

**D-2 is RATIFIED, amended 2026-08-19, and its defer REMAINS IN FORCE.** The
amendment's own text: *"**Broader branch-scoped RBAC — `FR-SEC-002` /
`FR-SEC-003` / `FR-SEC-004` general scope resolution stays deferred.** Only the
branch check `FR-SEC-021` itself requires is lifted; permission resolution is
**not** made branch-aware by this amendment."* The KDS ratification at **this
very HEAD** reconfirms it: *"D-2's branch-scoped RBAC defer remains in
force."*

**Verified at HEAD, independently:**

- `identity/context/tenant-context.ts:11` — `branchId` is *"RESERVED — not
  populated this phase"*, and `TenantContextService.resolve()` never assigns
  it on any path.
- `PermissionGuard` matches a flat `ReadonlySet<string>` of codes
  (`permission.guard.ts:46-49`). No scope participates.
- `identity.membership_roles.branch_id` exists in schema and **is still never
  read**.
- A **dashboard** session's `AuthenticatedPrincipal` carries
  `userId, sessionId, tenantId, membershipId` and **no `employeeId`, no
  `terminalId`** (`auth.types.ts`) — so neither the FR-SEC-021 permitted-branch
  set nor a terminal binding is available to a back-office reader.

> **A mandatory `branchId` path parameter is ADDRESSABILITY, not
> AUTHORIZATION.** This report does not conflate them anywhere.

### The three options

#### Option A — mandatory `branchId`, tenant-scoped permission only

The existing posture of `GET /orders` (`branchId` an *optional* filter;
omitting it returns **every branch's** orders) and `GET /inventory/levels`.

**Consequence:** a holder of the report permission in a multi-branch tenant can
read **any** branch's complete daily financials by changing one path segment.

**REJECTED.** Two independent reasons:

1. This surface is materially worse than the existing ones. `GET /orders` leaks
   *transaction rows*; this leaks a branch's **entire daily P&L position, drawer
   variances and cashier identities** in one call. Extending a known leak to a
   strictly more sensitive surface is not "consistent with precedent" — it is
   compounding.
2. The readiness assessment's own **P4 exit criterion** is literally *"a
   manager … cannot read another branch's"*. Shipping the reporting surface
   *as* the thing that violates it is self-defeating.

#### Option B — lift D-2, implement real branch authorization

**OUT OF SCOPE.** Requires reopening a twice-reaffirmed ratified decision,
implementing `FR-SEC-002/003/004` scope resolution, making `PermissionGuard`
scope-aware, populating `TenantContext.branchId`, and retrofitting **every**
existing route. That is a dedicated slice with its own governance gate, and
this gate does not design it.

#### Option C — Internal-MVP fail-closed single-branch guard — **SELECTED**

A `ReportingBranchGuard`, structured exactly as `KdsStationGuard`:

```
1. `branchId` is a MANDATORY path parameter. No optional-filter form exists.
2. BranchCurrencyQuery.find(tx, {tenantId, branchId}) must return non-null.
   null  =>  404 "Branch not found."   (RLS makes a foreign-tenant branch invisible)
3. BranchReportingScopeQuery.operativeBranches(tx, {tenantId, limit: 2}):
      0 results  =>  403  (fail-closed; no operative branch)
      2 results  =>  403  "Reporting is not supported for a tenant with more
                           than one active branch in this release."
      1 result   =>  continue
4. The supplied branchId MUST EQUAL that single operative branch id, else 403.
```

**Is Option C compatible with D-2?** **Yes, and provably so — it is the
KDS-R11 pattern applied to a different fact.**

| KDS-R11 consequence note | This guard |
|---|---|
| *"an active, registered KDS-type terminal is required"* | an existing, tenant-visible branch is required |
| *"**exactly one** operative station binding must resolve"* | **exactly one** operative branch must resolve |
| *"**zero** bindings ⇒ **denied**"* | zero operative branches ⇒ denied |
| *"**more than one** binding ⇒ **denied** as unsupported/misconfigured for this slice"* | more than one active branch ⇒ denied as unsupported for this slice |
| *"the supplied `stationId` **must equal** the terminal-derived station"* | the supplied `branchId` must equal the derived branch |
| *"**D-2's branch-scoped RBAC deferral is UNCHANGED and is not reopened** — station scope here is a terminal-binding fact … **not a new RBAC scoping tier**"* | **D-2 is UNCHANGED and not reopened** — this is a *tenant-shape* fact, not a user-scope fact |

**The decisive property:** the guard **never reads a user's scope**. It does
not consult `membership_roles.branch_id`, does not populate
`TenantContext.branchId`, does not resolve an assignment scope, and does not
make `PermissionGuard` branch-aware. It answers one question about the
**tenant**, not about the **principal**: *can this tenant's reporting surface
be served safely at all?* When the answer is no, it serves nothing.

`FR-SEC-004`'s *"Permissions SHALL NOT leak across scopes"* is not violated,
because in a one-operative-branch tenant the branch scope and the tenant scope
are **the same set**. That equivalence is the entire basis of the guard, and it
is checked at request time rather than assumed.

### Does Option C need user ratification?

**No — and this is stated with the reason, not asserted.**

KDS-R11 recorded its structurally identical guard as *"a **binding constraint
on implementation**, not as a separate business decision (it is **engineering
mechanics** derived from ACT-09, ratified ADR 0008 D-16, and existing
session/terminal substrate)"*, while the **permission code** in the same
ratification **did** require user authorisation. The same split applies here:
the permission (§17) is a governance question; the fail-closed guard is
engineering safety.

**It is not a governance decision because it grants nothing, lifts nothing and
relaxes nothing.** It is strictly more restrictive than every existing read
route in the repository.

> ### **DISCLOSED PRODUCT CONSEQUENCE — recorded, not hidden**
> **A tenant with more than one active branch receives `403` on the reporting
> route entirely.** Not a partial report, not a tenant-wide report — nothing.
>
> Measured on the local dev database: **473 tenants have exactly one active
> branch; 99 have two; 2 have four.** So ~18% of dev tenants would be refused.
>
> This is the **correct** posture for an Internal MVP whose permitted carve-out
> is explicitly *"one branch operationally"*, and it is **strictly safer** than
> the alternative, which is shipping a knowingly cross-branch-leaky financial
> endpoint. The refusal disappears the moment D-2 is lifted, and the retrofit
> is confined to **one guard file** — because `branchId` is already mandatory
> and already the only addressing form.
>
> If the user prefers Option A's known leak over Option C's refusal, that **is**
> a governance choice and this gate would need to be reopened. **It is not
> presented as a decision here because Option C is available, safe, and
> precedented.**

> ### **VERDICT D IS NOT RETURNED.** Safe branch behaviour **is** achievable
> without violating D-2.

---

## §17. REPORT PERMISSION GOVERNANCE

### The source position, exactly

**§15.2, Governance & Platform group, verbatim:**

| Permission | Description |
|---|---|
| `report.view.<category>` | View a report category |
| `report.export` | Export report data |

**§15.2's own limit, verbatim:** *"The catalogue below is **representative
rather than exhaustive**; the full catalogue is maintained in **Appendix C**."*
**Appendix C is absent from `ROS_SRS_v1.0.pdf`** — a fact **D-20 clause 6**
already records as binding: *"the exact permission code is NOT derivable,
because Appendix C is absent from the supplied SRS."*

**§19.3 supplies the category vocabulary** — as report-group headings, not as
permission tokens: **Sales · Inventory · Kitchen · Financial · Workforce ·
Governance**.

**This repository has already recorded the identical finding, in code.**
`treasury.controller.ts:123-126`, under *DELIBERATELY ABSENT*:

> *"X report · FR-POS-093, authorization NOT SOURCE-DECIDABLE (no
> `cash.x_report`, **`report.view.<category>` unenumerated**)."*

**A route with no permission is not an option.** Every one of the 109 paths is
guarded; `treasury.controller.ts:103` records the standing rule: *"the read
routes are withdrawn rather than misauthorised."* Withdrawing this route
withdraws the slice.

**No existing code can be reused truthfully:**

| Candidate | Why not |
|---|---|
| `pos.order.create` | *"Create and modify orders."* Reads sit behind it **only** because *"a terminal cannot modify an order it may not read"* (`sales.permissions.ts`). That reasoning covers **one order a cashier is working on** — it does not stretch to the branch's entire daily financial position, drawer variances and cashier identities. Reusing it would hand every cashier the day's P&L. |
| `cash.session.close` / `_other` | Write authorities (*"Close own shift"*). The close-context route is gated by them only because it *serves* that write. |
| `inventory.view` | Different domain. |
| `settings.branch.read` | Configuration, not trading data. |

> ### **CONCLUSION: USER RATIFICATION REQUIRED (§26, DECISION 1).**
> This is **genuine source silence**, in the exact class D-20 and KDS-R11
> both addressed — and it is **weaker invention than KDS-R11**, because §15.2
> supplies the **pattern** (`report.view.<category>`) and §19.3 supplies the
> **categories**. Only the concrete instantiation is unratified.

### The five options

| | Option | Assessment |
|---|---|---|
| **A** | `report.view.sales` alone | **Insufficient.** The response contains §19.3 **Financial**-category content: *Cash Reconciliation* ("By session, cashier, drawer, variance") and *Tax Summary*. Gating those behind a Sales code would silently widen `report.view.sales` beyond its category. |
| **B** | `report.view.financial` alone | **Insufficient**, symmetrically. *Sales Summary* and *Sales by Tender* are §19.3 **Sales** reports. |
| **C** | **BOTH, `mode: 'all'` (AND)** | **RECOMMENDED.** |
| **D** | `report.view.daily_trading` | **REJECTED.** `daily_trading` is **not a category** in §19.3 or anywhere in the SRS. It would instantiate the template with an invented vocabulary — strictly more invention than C for strictly less truth, and it would not compose with any future report. |
| **E** | Split into two routes, one code each | **Viable fallback.** Costs the single-snapshot property (§21) and doubles the surface. Recorded so the user can choose it if granting two codes is unacceptable. |

### Why C

- **Least privilege, truthfully.** The composite response genuinely spans two
  §19.3 categories. Requiring both is the only gating that neither over-grants
  nor mislabels.
- **The mechanism already exists.** `@RequirePermission(a, b)` is `mode: 'all'`
  by default and `PermissionGuard` evaluates `codes.every(...)`
  (`require-permission.decorator.ts:12-19`, `permission.guard.ts:46-49`).
  **No new authorization capability is invented.**
- **Extensibility.** The next report (Inventory, Kitchen, Workforce,
  Governance) instantiates the same §15.2 template with its own §19.3 category.
  The vocabulary is fixed by the SRS, not by us.
- **Admin simplicity is preserved where it matters.** §15.3's Owner, Branch
  Manager, Accountant and Auditor all plausibly hold both; only a
  narrowly-scoped custom role would hold one.

**Endpoint semantics: BOTH required (AND), not EITHER.** An EITHER gate would
let a `report.view.sales`-only holder read drawer variances and cashier
identities.

### Proposed future standard-role intent — **recorded, NOT implemented**

Following KDS-R11 §4.3, which recorded role intent without seeding it:

| §15.3 Role | Scope | `report.view.sales` | `report.view.financial` | Reasoning from §15.3's own character column |
|---|---|---|---|---|
| **Owner** | Tenant | Yes | Yes | *"All permissions"* |
| **Operations Director** | Brand(s) | Yes | Yes | *"All operational"* |
| **Brand Manager** | Brand | Yes | **Open question** | *"Menu, pricing, **reports**; no financial **approval**"* — an approval restriction is not obviously a read restriction. **Flagged, not resolved.** |
| **Branch Manager** | Branch | Yes | Yes | *"Full branch operations, approvals within band"* |
| **Shift Supervisor** | Branch | **Open question** | No | *"Approvals within a lower band, no configuration"* — silent on reports. **Flagged, not resolved.** |
| **Accountant** | Tenant | Yes | Yes | *"Financial read and export, no operational write"* |
| **Auditor** | Tenant | Yes | Yes | *"Read-only everything"* — the FR-SEC-010 + FR-SEC-011 argument D-20 §1b makes |
| Cashier · Waiter · Kitchen Staff · Head Chef · Storekeeper | Branch | No | No | none is a reporting role |

> **NO ROLE SEEDING IS PERFORMED OR AUTHORISED BY THIS SLICE.** No permission
> is silently granted to anyone. The two open questions above are **not**
> resolved here and are **not** put to the user — no role-seeding mechanism is
> being built, so they are not yet live questions.

### Binding constraints on implementation (mirroring KDS-R11)

1. **Do NOT hardcode role-name strings.** Authorization is permission-based
   (D-3).
2. The codes are added exactly as every other code is: entries in the owning
   module's `*.permissions.ts` (`reporting.permissions.ts`) plus
   `PermissionDef`s, seeded **only because an executable consumer now exists**
   — the standing rule in `treasury.permissions.ts` (*"a code with no route
   behind it is appearance without capability"*).
3. **`report.export` is NOT created and NOT seeded** (§18).
4. **PROVISIONAL, per ADR 0008 D-01**: if Appendix C is ever supplied and names
   these categories differently, remap per D-01 — the same route the Catalogue
   and Organisation `.read` codes already record verbatim. Recording the route
   does **not** make the ratification provisional.
5. **No existing permission is broadened.** Every code keeps its exact
   pre-ratification scope.
6. **These codes carry NO branch scope** and must never be relied on for it —
   §16's guard is where branch safety lives. Directly parallel to KDS-R11 §6.

---

## §18. REPORT EXPORT

> ### **OUT OF SCOPE. DEFERRED IN FULL.**

| Requirement | Status after this slice |
|---|---|
| **FR-RPT-043 `[M]`** — CSV/XLSX/PDF export, >50k rows async | **NOT IMPLEMENTED** |
| **FR-RPT-044 `[M]`** — all exports logged in the audit trail with user, filters, row count | **NOT IMPLEMENTED** |
| **FR-AUD-008 `[M]`** — audit export under `audit.view` + `report.export` | **NOT IMPLEMENTED** — unchanged; **D-20 clause 9** already records it as a knowingly unsatisfied gap, and this slice does **not** close it |

**Consequently, and bindingly:**

- **`report.export` is NOT created and NOT seeded.** No executable consumer
  exists (`treasury.permissions.ts`'s standing rule).
- **No export route, no CSV/XLSX/PDF serialiser, no async job, no notification
  channel** (D-11 notifications: strict none — untouched).
- The selected slice is a **read surface**. §19.5's *"Reports arrive; they are
  not fetched"* principle (FR-RPT-040/041) is **NOT IMPLEMENTED**.

### Audit on the read path

**No `FR-AUD-001` business audit entry is written for this GET.**

| Basis | Evidence |
|---|---|
| FR-AUD-001 binds *"every **state-changing** operation"*. A report GET changes no state. | SRS §20.1 |
| FR-AUD-006's always-audit list names *"data exports"* — **not report reads**. This slice performs no export. | SRS §20.1 |
| FR-AUD-007 (*"Audit log access SHALL itself be audited"*) binds **audit-log** access. This route reads `sales.*`/`treasury.*`, never `governance.audit_entries`. **D-20 clause 8** already classifies FR-AUD-007 as **CONDITIONAL** on audit-log access. | D-20 |
| Repository convention: every `AUDIT_ACTION` value is a past-tense **state-change** verb (`ORDER_CREATED`, `PAYMENT_CAPTURED`, `ORDER_COMPLETED`, …). **No GET route in the 109-path surface writes an audit entry.** | `audit.constants.ts` |

**No authoritative rule requires otherwise.** If a future
FR-RPT-044-compliant export ships, **that** operation is audited — the export,
not the read.

---

## §19. DRILL-DOWN — FR-RPT-042

**FR-RPT-042 `[M]`:** *"Every aggregate figure SHALL support drill-down to the
contributing transactions in no more than four interactions."* §19.1 Principle
2 makes it a trust requirement: *"A number that cannot be traced to its source
will not be trusted, and an untrusted number is worse than an absent one."*

### Can the existing routes serve as the substrate? **No.**

| Route | Why it cannot |
|---|---|
| `GET /orders` | `ListOrdersQueryDto` accepts **only** `branchId`, `cursorId`, `cursorBusinessDay`, `limit` (`sales.dto.ts:79-93`). **No `businessDay` filter. No `state` filter.** Ordering is `businessDay DESC, id DESC` with a strict-`lt` cursor (`orders.service.ts:387-404`), so reaching a specific past day means paging **every** later order first. There is no interaction count at which this is bounded, let alone four. |
| `GET /orders/{businessDay}/{id}` | Requires an id the aggregate response does not carry and the client has no way to enumerate. |
| Permission mismatch | Both are gated by **`pos.order.create`** — a report reader holding `report.view.*` cannot call either. |
| Tender / tax / session figures | **No drill-down substrate exists at all.** There is no payment-list route, no tax-line route, and no session-read route (`treasury.controller.ts:112-113` records *"`GET /cash-sessions/:id` · no source-supported read authority"*). |

> ### **FR-RPT-042: NOT IMPLEMENTED**
> Not claimed COMPLETE, not claimed PARTIAL, and **not** claimed satisfied on
> the strength of raw order routes existing.

**The exact minimal future change is recorded so the next gate does not
re-derive it** (identified, **NOT authorised, NOT designed here**): add
`businessDay` and `state` filters to `ListOrdersQueryDto`, resolve the
permission question (a report reader holding `pos.order.create` is a
different, larger grant), and apply §16's branch guard to that route too. Plus
equivalent substrates for payments, tax lines and sessions.

**Mitigation shipped instead, in this slice:** every aggregate carries the
**exact filter predicate** that produced it — `branchId`, `businessDay`, the
`state = 'completed'` population statement, the line-state exclusion, and the
per-session `cashSessionId` list. A reader cannot yet *click through*, but the
numbers are **reproducible**: the response states precisely which rows it
summed. That is not FR-RPT-042 and is not represented as such.

---

## §20. QUERY PERFORMANCE / INDEX

### Method

Four `EXPLAIN` statements, executed this session against the local dev
database as the RLS-constrained `ros_app` role, inside `BEGIN … ROLLBACK`,
with `app.tenant_id` / `app.user_id` set exactly as `withAuthContext` sets
them. **No `ANALYZE`, no write, no DDL, no seeding.**

**Cardinality disclosure, stated up front:** the dev database holds 2,407
orders / 1,958 lines / **158 payments** / 479 sessions. **These volumes are
far too small for the cost numbers to be predictive**, and no conclusion below
rests on them. The conclusions rest on the **access paths**, which are
determined by index *definitions* and are cardinality-independent: an index
whose leading columns do not match the predicate cannot be used at **any**
volume, and one whose leading columns match exactly will be considered at
**any** volume.

### Existing indexes (read from `pg_indexes` / `\d+`, not from the Prisma schema)

```
sales.orders          orders_tenant_branch_day_idx      btree (tenant_id, branch_id, business_day)   -- partitioned
sales.order_lines     ..._tenant_id_order_id_business_day_idx                                        -- partitioned
sales.order_payments  order_payments_tenant_order_idx   btree (tenant_id, order_id, business_day)
sales.order_payments  order_payments_tenant_cash_session_idx  btree (tenant_id, cash_session_id)
treasury.cash_sessions  cash_sessions_tenant_id_branch_id_status_idx  btree (tenant_id, branch_id, status)
```

`sales.orders` and `sales.order_lines` are **monthly RANGE-partitioned on
`business_day`** — a single-day equality predicate prunes to one partition
before the index is even consulted.

### The four plans

**1. Sales summary (orders only)**

```
Aggregate
  ->  Index Scan using orders_2026_08_tenant_id_branch_id_business_day_idx on orders_2026_08
        Index Cond: (tenant_id = $1) AND (branch_id = $2) AND (business_day = $3)
        Filter: (state = 'completed')
```

Partition pruned to one month; exact three-column index prefix; `state` as a
cheap residual filter over one branch-day.

**2A. Tender totals — PAYMENTS-FIRST** *(the shape the POST-KDS report assumed)*

```
GroupAggregate
  ->  Sort
    ->  Seq Scan on order_payments
          Filter: (tenant_id = $1) AND (branch_id = $2) AND (business_day = $3)
```

> **SEQ SCAN.** No index on `order_payments` leads with `branch_id` or
> `business_day`. **This is structural, not a cardinality artefact** — the shape
> can never use an index, at any table size. **This is the shape that would
> require the migration.**

**2B. Tender totals — ORDERS-FIRST JOIN** *(selected)*

```
GroupAggregate
  ->  Sort
    ->  Nested Loop
          ->  Index Scan using orders_2026_08_tenant_id_branch_id_business_day_idx on orders_2026_08
                Index Cond: (tenant_id = $1) AND (branch_id = $2) AND (business_day = $3)
          ->  Index Scan using order_payments_tenant_order_idx on order_payments
                Index Cond: (tenant_id = $1) AND (order_id = o.id) AND (business_day = $3)
```

**Fully index-driven on both sides, with existing indexes only.**

**3. Tax by class** — same nested-loop shape, driving into
`order_lines_2026_08_tenant_id_order_id_id_business_day_idx`. Fully
index-driven.

**4. Session id set + Treasury facts** — the `DISTINCT cash_session_id`
extraction reuses plan 2B; the Treasury lookup uses
`cash_sessions_tenant_id_branch_id_status_idx` with `id = ANY($ids)` as a
residual filter over one branch's sessions.

### Why the orders-first join is provably COMPLETE

This is the load-bearing correctness argument, not a performance preference.

`order_payments` carries the FK
**`(tenant_id, order_id, business_day, branch_id) → orders(tenant_id, id,
business_day, branch_id)`**
(`order_payments_tenant_id_order_id_business_day_branch_id_fkey`, verified in
the live schema). The model's own docblock states the intent: *"**BRANCH-INCLUSIVE,
not just tenant-safe** … so `Payment.branchId` disagreeing with the referenced
Order's own `branchId` is **structurally unrepresentable**, not merely
service-validated."*

> **Therefore: `{payments where (tenant, branch, business_day) = (T,B,D)}` is
> EXACTLY `{payments of orders where (tenant, branch, business_day) = (T,B,D)}`.**
> The two sets are provably identical **by database constraint**, not by
> convention. The join misses nothing and admits nothing extra — including
> payments on `partially_paid` orders, which §6 requires it to include.

### N+1 avoidance

Each of the four aggregates is **one** SQL statement issued through Prisma
`groupBy`/`aggregate`/`findMany` with an explicit join predicate. **No
per-order or per-payment round trip anywhere.** The session facts are fetched
with a single `id: { in: [...] }`, never a loop. **Required test (§29).**

### Answer

> ## **MIGRATION REQUIRED: NO**
>
> **NO MIGRATION EXPECTED.** Zero tables, zero columns, zero enums, **zero
> indexes**. The migration count stays at **34**.
>
> The `order_payments(tenant_id, branch_id, business_day)` index the POST-KDS
> report anticipated is **NOT needed and MUST NOT be created by this slice** —
> the orders-first join makes it unnecessary, and adding an index for a query
> shape the design does not use is dead weight on an append-only financial
> ledger's insert path.
>
> **If a future slice adds a payments-first shape** (a cross-branch or
> date-range tender report), plan 2A above is the evidence that it would need
> that index. Recorded, **not created**.

**Not measured, not claimed:** NFR-PERF-010 (31-day, p95 < 2s), NFR-PERF-011
(100 branches, p95 < 5s), NFR-PERF-012 (dashboard load), NFR-DATA-002
(< 15 min staleness — trivially satisfied by live query, but not claimed since
the requirement is written against the §19.2 aggregation layer).

---

## §21. CONSISTENCY SNAPSHOT

### The hazards, concretely

| Question | Answer |
|---|---|
| Can a CashSession finalise between the Sales read and the Treasury read? | **Yes.** A close commits at any moment; a session read as `closing` at t₁ can be `closed` at t₂. |
| Can a Payment commit while the report is assembled? | **Yes.** Capture is a normal concurrent write. |
| Does `dataAsOf` imply one database snapshot? | **Yes** — otherwise the timestamp is a lie about *which* data. |

Under **READ COMMITTED**, a Prisma interactive transaction takes a **new
snapshot per statement**. Four statements ⇒ up to four snapshots ⇒ the
response can contain: a session counted in `sessionDayTotals` but absent from
`sessions`; a payment inside `tenderTotals` whose order's completion is
invisible to `salesSummary`, breaking §7.9's
`Σ tender = gross + unsettled` identity; a `varianceRollup` including a
variance from a session the earlier statement saw as `closing`.

**These are internally contradictory totals in a financial report.**

### The decision

> **ONE `withAuthContext` transaction at `Prisma.TransactionIsolationLevel.RepeatableRead`,
> read-only, wrapping every domain contract call and the `SELECT now()` that
> produces `dataAsOf`.**

| Property | Why it holds |
|---|---|
| **Mechanism already exists** | `PrismaService.withAuthContext(scope, fn, { isolationLevel })` (`prisma.service.ts:55-70`). **No new capability is built.** |
| **Every contract is already `tx`-first** | `CashSessionFactsQuery`, `CashSessionTenderTotalsQuery`, `CashMovementTotalsQuery`, `BranchCurrencyQuery` all take the **caller's** `Prisma.TransactionClient`, precisely so *"a lookup taken mid-capture reads inside the SAME atomic unit of work (SRS §5.5.1)"*. The four new contracts (§15) follow it exactly. |
| **RR, not SERIALIZABLE** | RR gives one snapshot for the whole transaction — exactly what is needed. SERIALIZABLE adds predicate locking and `40001` retry handling for a **read-only** transaction that can conflict with nothing. `KdsOperationsService` uses SERIALIZABLE + retry because it **writes**; this does not. **No retry loop, no `serialization-retry` wrapper.** |
| **RLS unaffected** | `set_config('app.tenant_id', …, true)` is the transaction's first statement, unchanged. |
| **`dataAsOf` becomes exact** | Under RR, `now()` is `transaction_timestamp()` — the instant of the very snapshot every figure was read from. §12's claim is then literally true, not approximately true. |

**Not over-engineered:** one existing option object, one enum value, zero new
infrastructure, zero retry logic. The alternative (READ COMMITTED with
`dataAsOf` = response time) was considered and **rejected** — it would ship a
financial report that can contradict itself and a timestamp that describes no
actual state.

---

## §22. CURRENCY / TENANT SAFETY

| Requirement | How it is met |
|---|---|
| **Branch currency source** | `BranchCurrencyQuery.find(tx, {tenantId, branchId}).baseCurrency` — Organisation's public contract over `org.branches`, the SRS §7.3 #5 invariant *"one timezone; one base currency"*. |
| **Never from the request** | No currency field exists on any DTO, path or query parameter for this route. The client **cannot express** a currency. |
| **All orders share it** | `DailyTradingSalesFacts.currencies` returns **every distinct `orders.currency`** in the population; the orchestrator asserts it is `[]` or `[branchCurrency]`. |
| **All payments share it** | `paymentCurrencies` likewise (`order_payments.currency` is *"Snapshot of the order's currency at capture time. Never client-supplied."*). |
| **No summing across currencies** | If either set contains anything other than the branch currency, **the report is REFUSED** (§25) rather than emitting a total that adds two currencies' minor units. |
| **Tenant RLS fail-closed** | `withAuthContext` sets `app.tenant_id` as the transaction's first statement; a missing value becomes `NULL` in the policy predicate → **no rows**. `order_payments` carries `FORCE`d RLS with `USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)` — verified in the live schema. `ros_app` is `NOBYPASSRLS`. |
| **Foreign-tenant branch** | `BranchCurrencyQuery.find` returns **`null`** — its own docblock: *"a genuinely cross-tenant id (RLS makes the row invisible to the caller's `tx` regardless of the WHERE clause)"* — and the route answers **404 "Branch not found."**, identical to an unknown id. **Existence is never disclosed.** |

**Is the currency guard theoretical?** No. `BranchesService.update` accepts
`baseCurrency` (`branches.service.ts:152-154`), so a branch's currency **can**
change while historical orders keep their snapshot. That is exactly the
FR-RPT-005 Type-2 problem (§4), live in this repository today. `timezone` is
mutable too — the reason §10 refused to re-derive historical business days.

**The refusal is deliberate.** Emitting a "total" that adds AED minor units to
USD minor units is a false financial semantic; refusing with a precise reason
is not.

---

## §23. CASH SESSION RELATION

| | Option | Assessment |
|---|---|---|
| **A** | Daily totals only | **Insufficient.** §19.3 Financial names *Cash Reconciliation — "By **session, cashier, drawer**, variance"*. A single day-level variance number cannot be acted on: a manager needs to know **which drawer and which cashier**. |
| **B** | **Daily totals + session breakdown, in ONE response** | **SELECTED.** |
| **C** | Separate daily and session endpoints | **REJECTED.** Breaks the single-snapshot property (§21) and doubles the permission surface for one manager question. |

### Why B is the minimum that genuinely advances FR-FIN-010

FR-FIN-010 requires totals *"per session **and** per day"*. The session half
shipped with P1G-1; **the per-day half is this slice**. Delivering the per-day
half **without** the session linkage would leave the two halves unjoined — a
manager could see the day's cash total and (via a different route, with a
different permission, from a POS session) one session's total, and never
reconcile them. B closes that in one response, and §9's
`cashDrawerContribution` makes the reconciliation a **testable identity**
rather than an exercise for the reader.

### It does NOT duplicate the close-context contract

`GET /cash-sessions/{sessionId}/close-context` and this report are disjoint in
purpose, audience, permission and content:

| | close-context | daily report |
|---|---|---|
| Purpose | **operate** a close — count mode + open-mode preview | **read** a completed day |
| Actor | cashier/manager on a **POS session** (`requirePosIdentity` — terminal + employee required) | back-office reader on a **dashboard session** |
| Permission | `cash.session.close` / `_other` (write authorities) | `report.view.*` (§17) |
| Scope | **one** session, pre-close | **all** the day's contributing sessions, post-hoc |
| Fields | count mode, tolerance, preview | opened/closed, status, expected/counted/variance, movements, day-scoped tender |

**No field, service, DTO or query is shared, and neither is re-implemented in
terms of the other.**

### Future DayClose

Every field FR-FIN-022's Z report needs from cash — *"cash reconciliation, and
variance summary"* — is produced by this roll-up, and FR-FIN-021's *"blocked
while any cash session remains open, and SHALL list the blocking sessions"* is
exactly `unclosedSessionCount` plus the session list. **Recorded as a useful
interface for a future DayClose. No DayClose semantics are implemented,
ratified, or implied here** (§27).

---

## §24. EXACT HTTP SURFACE

**Design only. Nothing below is implemented by this task.**

### The route

```
GET /reports/branches/{branchId}/daily-trading/{businessDay}
```

| Aspect | Specification |
|---|---|
| **No `/v1`** | The repository has **no** version prefix in any controller; it is applied at deployment (`swagger.config.ts`), per the C-1 convention recorded in `cash-close-policy.controller.ts`. |
| **`/reports` family** | Owned by the `reporting` module (§14). Precedent for a branch-addressed family outside the owning resource: `POST /branches/{branchId}/cash-close-policy`. `/reports/...` is chosen over `/branches/{branchId}/reports/...` because the resource **is** a report; the branch is an address. |
| **`{businessDay}` in the path** | Follows `GET /orders/{businessDay}/{id}`, whose own docblock explains it: the business day is part of the partition key. |
| **Session type** | **Dashboard only.** No `@AllowPosSession` — a PIN session is refused by `JwtAuthGuard` by default, matching `CashClosePolicyController` and FR-SEC-021 (*"SHALL NOT grant access to the web dashboard"*, and its converse). |
| **Guards, in order** | `JwtAuthGuard` (401) → `TenantContextGuard` (403) → `PermissionGuard` (403) → **`ReportingBranchGuard`** (§16; 404/403) |
| **Permission** | `@RequirePermission(REPORTING_PERMISSIONS.VIEW_SALES, REPORTING_PERMISSIONS.VIEW_FINANCIAL)` — `mode: 'all'` (AND), **subject to DECISION 1** |
| **Branch rule** | §16 Option C, fail-closed |
| **Query parameters** | **NONE.** `forbidNonWhitelisted` rejects any. No range, no grain, no filter, no include-flags. |
| **Idempotency-Key** | **NOT accepted.** GET is safe; FR-API-020 binds mutating requests. |
| **If-Match / ETag** | **Not emitted.** The resource legitimately changes while `periodStatus` is `OPEN` or `UNSEALED`; a validator would be misleading. |
| **Business audit** | **NONE** (§18) |
| **Caching headers** | `Cache-Control: no-store`. Financial data, `periodStatus`-dependent freshness. |

### Response DTO (money as strings throughout)

```
{
  branchId:                  uuid,
  businessDay:               "YYYY-MM-DD",
  currency:                  "AED",            // branch base currency, never client-supplied
  dataAsOf:                  iso-instant,      // SELECT now() inside the RR transaction
  periodStatus:              "OPEN" | "UNSEALED" | "SETTLED",
  branchCurrentBusinessDay:  "YYYY-MM-DD",
  openOrderCount:            integer,
  unclosedSessionCount:      integer,

  salesSummary: {
    grossSales, discounts, refunds, taxTotal, netSales,   // money-strings
    completedOrderCount:    integer,
    averageOrderValue:      money-string | null,
    unsettledCapturedTotal: money-string
  },

  tenderTotals: {
    cash:                { amountTotal, roundingAdjustmentTotal, paymentCount },
    manualExternalCard:  { amountTotal, roundingAdjustmentTotal, paymentCount },  // rounding CHECK-enforced 0
    tenderGrandTotal:        money-string,   // Σ amountTotal
    cashDrawerContribution:  money-string,   // cash.amountTotal + cash.roundingAdjustmentTotal
    paymentCount:            integer
  },

  taxSummary: {
    taxTotal: money-string,
    byClass: [{ taxClassId, taxClassCode|null, countryPackCode|null,
                taxAmount, netAmount, grossAmount, lineCount }]
    // no `byRate` key at all — §11
  },

  cashReconciliation: {
    sessions: [{
      sessionId, employeeId, drawerId, openedAt, closedAt|null, status,
      currency, openingFloat,
      expectedCash|null, countedCash|null, variance|null,   // null unless status='closed'
      payInTotal, payOutTotal, safeDropTotal,
      isFinalised: boolean,
      tenderTotalsForThisBusinessDay: { cashSalesTotal, cashRoundingAdjustments,
                                        manualExternalCardTotal, paymentCount }
    }],
    closedSessionCount:   integer,
    unclosedSessionCount: integer,
    varianceTotal:        money-string   // Σ variance over status='closed' ONLY
  },

  scope: {                                // FR-RPT-042 mitigation (§19)
    salesPopulation: "orders.state = 'completed'",
    lineExclusions:  ["voided", "comped"],
    tenderPopulation:"all order_payments for this branch-day, any order state",
    notes: [ "FR-RPT-001/002/003/005 NOT IMPLEMENTED — query-time aggregation "
             + "over the transactional primary (Internal MVP).",
             "Tax by rate NOT IMPLEMENTED — component breakdown not persisted.",
             "Discounts and refunds are structurally zero — no mechanism exists.",
             "Sessions with no payments on this business day are not listed." ]
  }
}
```

**Stock-on-hand is NOT included.** `GET /inventory/levels` already serves it
under `inventory.view`; folding it in would re-gate an existing capability
behind a different permission.

---

## §25. ERROR SEMANTICS

| Status | Condition | Body / notes |
|---|---|---|
| **400** | `businessDay` not `^\d{4}-\d{2}-\d{2}$`, or not a real calendar date; `branchId` not a UUID; **any** query parameter supplied (`forbidNonWhitelisted`) | Standard validation error. `businessDay` is parsed with the same `parseBusinessDay` helper the Sales controller uses. |
| **401** | missing/invalid access token | `JwtAuthGuard`. Also the response for a **POS/PIN session**, which this dashboard route does not opt into. |
| **403** | no active tenant context | `TenantContextGuard` |
| **403** | missing `report.view.sales` **or** `report.view.financial` | `PermissionGuard`, `mode: 'all'`. Message `Insufficient permission.` — **the missing code is not named**, matching the existing guard. |
| **403** | tenant has **zero** operative branches | `ReportingBranchGuard`, fail-closed (§16) |
| **403** | tenant has **more than one** active branch | *"Reporting is not supported for a tenant with more than one active branch in this release."* — the KDS `>1 station` precedent's wording shape |
| **403** | supplied `branchId` ≠ the single operative branch, **and that branch is visible in this tenant** | *"This is not the operative branch for reporting in this release."* Deliberately **403, not 404** — the branch demonstrably exists in the caller's own tenant, so hiding it would be a lie rather than a protection. |
| **404** | branch id does not resolve in this tenant — **unknown OR foreign-tenant** | *"Branch not found."* **Identical response for both.** RLS makes a foreign-tenant row invisible, so the handler cannot distinguish them either. Matches `CashClosePolicyController`'s `@ApiNotFoundResponse({ description: 'Unknown branch.' })`. **No foreign-tenant existence is ever disclosed.** |
| **409** | the branch-day's orders or payments span **more than one currency** (§22) | *"This branch-day contains transactions in more than one currency and cannot be summarised."* |
| **409** | Treasury returns fewer sessions than the id set supplied (§15.2) | Internal invariant breach surfaced honestly rather than silently truncating the reconciliation. **A test must prove this is unreachable** (§29). |

**On the two 409s.** The gate's default is *"normally none for a pure read"*,
and that default is respected: neither arises from the read itself. Both are
**describable data states in which no truthful total exists**. A 500 would
misreport a real, explainable business/integrity condition as a crash; a 200
with a corrupt total is the false-financial-semantic outcome this gate
forbids. **422 was considered and rejected**: the request is perfectly
well-formed, so `Unprocessable Entity` would blame the caller for a data
condition.

**Never leaked:** whether a branch id exists in another tenant; which of the
two permissions is missing; any other tenant's data in any error path.

---

## §26. USER RATIFICATION PACKET

**Three decisions. All are genuine governance or business choices.**

---

### DECISION 1 — The concrete `report.view.<category>` permission token(s)

**Why this is a user decision and not engineering.** §15.2 supplies the
**template** `report.view.<category>` but designates **Appendix C** as the
authoritative full catalogue, and **Appendix C is absent from the delivered
SRS** — the same absence **D-20 clause 6** already records as making a code
*"NOT derivable"*. §19.3 supplies the category *vocabulary* (Sales · Inventory
· Kitchen · Financial · Workforce · Governance) as **report-group headings**,
not as permission tokens. This repository has **already recorded** the gap in
code: `treasury.controller.ts:125-126` — *"`report.view.<category>`
unenumerated"*.

Every route here is permission-guarded; **no existing code covers this surface
truthfully** (§17); therefore **the slice cannot exist without an explicitly
ratified code.** That is precisely the KDS-R11 situation, and this instance is
**weaker invention** than KDS-R11 was — §15.2 supplies the pattern and §19.3
supplies the categories; only the instantiation is unratified.

**Options tabled:**

| | Option | Note |
|---|---|---|
| **A** | `report.view.sales` alone | under-gates Financial content |
| **B** | `report.view.financial` alone | under-gates Sales content |
| **C** | **BOTH, required together (AND)** | **RECOMMENDED** |
| **D** | `report.view.daily_trading` | not a §19.3 category — rejected |
| **E** | split into two routes, one code each | fallback if granting two codes is unacceptable |

> **RECOMMENDATION: C.** Two codes — **`report.view.sales`** (*"View sales
> reports"*) and **`report.view.financial`** (*"View financial reports"*) —
> **both required** on the single composite route.
>
> Least privilege without mislabelling: the response genuinely spans two §19.3
> categories. Uses the **existing** `mode: 'all'` mechanism; invents no
> authorization capability. Extends cleanly to every future report. PROVISIONAL
> under ADR 0008 D-01 if Appendix C ever names the categories differently.
>
> **`report.export` is NOT requested and MUST NOT be created** (§18).
> **No role seeding is requested or authorised** (§17).

---

### DECISION 2 — Internal-MVP sequencing / scope ratification

> **Authorise building the operational daily-trading read surface NOW —
> query-time aggregation over the transactional primary — while
> `FR-RPT-001`, `FR-RPT-002`, `FR-RPT-003` and `FR-RPT-005` remain, and are
> recorded as, `NOT IMPLEMENTED`.**

**What this is NOT.** It is **not** a waiver, **not** a reinterpretation, and
**not** a claim of completion. The four requirements stay open, unmet and
counted against the Reporting domain. §4's binding wording constraint applies
to every artefact this slice produces.

**What it costs if declined.** The Internal MVP ships without any aggregated
read surface; the P4 exit criterion *"a manager can read yesterday's trading"*
is unmet; **FR-FIN-010 stays PARTIAL**; and **DayClose stays unbuildable**,
because the Z report's content (FR-FIN-022) has no aggregation layer to draw
on. The alternative — building §19.2's replica + star schema + rollups first
— is the full Reporting domain, currently at 0% and post-MVP.

**Precedent.** Structurally identical to the accepted `FR-SEC-032` posture:
knowingly unmet, recorded as such, not concealed.

---

### DECISION 3 — `averageOrderValue` basis *(narrow business definition)*

**Why this is a user decision.** The SRS names AOV in five places
(FR-FIN-022's Z report, §19.3 *Sales by Employee*, §19.3 *Average Order Value
Trend*, the §12.1 employee-metric list, the §18.x customer-profile list) and
**defines a formula in none of them**. Repository source is likewise silent.
It is genuinely user-visible: a manager reads one number.

| | Option |
|---|---|
| **A** | **`netSales ÷ completedOrderCount`** — ex-tax basis. **RECOMMENDED.** |
| **B** | `grossSales ÷ completedOrderCount` — tax-inclusive basis |
| **C** | omit the field; let clients divide | rejected — pushes a rounding decision into every client |

> **RECOMMENDATION: A (net).** §13 makes **Net Sales** the SRS's canonical
> revenue measure in every ratio it defines (`Food Cost % = COGS ÷ Net Sales`,
> `Prime Cost % ÷ Net Sales`, `Sales per Labour Hour = Net Sales ÷ Hours`), and
> FR-CST-035's ledger produces *"= Net Sales (excl. tax)"* as **the** revenue
> line. Rounding is `divideRounded(…, HALF_UP)` (BR-FIN-001); `null` when the
> count is zero.
>
> **If the user does not answer, A stands as the engineering default** and is
> recorded as such in the implementation. `grossSales` and
> `completedOrderCount` ship in the same response either way, so a gross-basis
> AOV is always a client-side division.

---

### Explicitly NOT put to the user

| Item | Why it is engineering, not governance |
|---|---|
| **Branch fail-closed guard (§16 Option C)** | Grants nothing, lifts nothing, relaxes nothing; strictly more restrictive than every existing read route. Structurally identical to the KDS-R11 **consequence note**, which was recorded as *"engineering mechanics"*, not a business decision. **D-2 is untouched.** The multi-branch 403 is a **disclosed product consequence**, recorded in §16. |
| **Gross / net definitions** | **Decided by FR-CST-003 `[M]`.** No silence to resolve (§8). |
| Module ownership; DI wiring; contract file paths | §14 / §15 — architecture, decided against §5.2.3/§5.2.4/§5.4 |
| Transaction isolation level | §21 — mechanics |
| Index / migration decision | §20 — settled by `EXPLAIN`; the answer is *no migration* |
| SQL shapes, DTO formatting, route filenames | mechanics |
| Session-attribution rule (§10 rule (iii)) | forced by the absence of a `business_day` column and the mutability of `timezone` — there is no defensible alternative |
| `periodStatus` vocabulary (§12) | derived from an exhaustive enumeration of what can change a day's figures at this HEAD |
| Excluding `cogsTotal` (§7.10) | §19.3 content + the existing `inventory.cost.view` separation. Including it **would** have been a silent permission grant. |
| Excluding per-card-scheme totals (§9) | the stored fact is unvalidated cashier free text |

---

## §27. RECEIPT / DAY CLOSE — NOT ABSORBED

**Explicitly NOT reopened, NOT designed, NOT implied, and NOT ratified by this
gate:**

- **Receipt / CARRIED ITEM P1C-1** — the fiscal exclusion stands, untouched.
  No receipt, no reprint, no `pos.reprint.receipt`, no document.
- **Fiscal** — no `fiscal.tax_documents`, no submission, no
  `fiscal_submission_attempts`, no `invoice` country-pack section.
  FR-POS-100/101/102 unchanged.
- **DayClose (FR-FIN-020…026)** — no `day_closes` model, no `cash.day.close`
  permission, no route, no auto-close, no forced session close, no
  FR-FIN-026 triggers.
- **Z report (FR-FIN-022/023)** — no sequential numbering, no immutable
  document, no historical retrieval. **`SEALED` is deliberately not emitted**
  (§12) precisely so that nothing in this slice can be mistaken for sealing.
- **X report (FR-POS-093)** — unchanged; `treasury.controller.ts`'s
  *"DELIBERATELY ABSENT"* note stands verbatim.

**Recorded as useful to a future DayClose — as interfaces only, implementing
nothing:**

| Future DayClose need | What this slice leaves behind |
|---|---|
| FR-FIN-022 Z content: gross, discounts, refunds, net, tax, tender, count, AOV | the `DAILY_TRADING_SALES_QUERY` contract |
| FR-FIN-022 *"cash reconciliation, and variance summary"* | the `DAILY_CASH_RECONCILIATION_QUERY` contract |
| FR-FIN-021 *"blocked while any cash session remains open, and SHALL list the blocking sessions"* | `unclosedSessionCount` + the session list |
| FR-FIN-024 the day boundary | `currentBusinessDay()` — the single FR-FIN-024 implementation |
| The sealing state itself | `periodStatus` gains a **fourth** value, `SEALED`; `SETTLED` keeps its meaning |

**None of the above is a DayClose semantic decision.** The dependency runs one
way: DayClose will consume these; they do not presume it.

---

## §28. DEFINITION OF DONE FOR FUTURE IMPLEMENTATION

The implementation slice is complete when **all** of the following hold.

**Governance**
1. DECISION 1 ratified and recorded in the register **before** any permission
   code is written; the codes match the ratified text exactly.
2. DECISION 2 ratified and recorded; **no artefact** states or implies
   FR-RPT-001/002/003/005 are waived or complete.
3. DECISION 3 answered, or A applied as the recorded default.
4. **D-2 not reopened.** P1C-1 not reopened. D-20 not reopened. KDS-R11 not
   amended.

**Architecture**
5. A `reporting` module exists owning **zero tables and zero migrations**
   (§14).
6. The four contracts of §15 exist under `contract/`, are `tx`-first, and
   their implementations are bound **only** in their owning modules.
7. The orchestrator imports **only** `contract/` and `*.module` paths from
   Sales, Treasury, Organisation and Localisation. **Zero private-path
   imports.**
8. `module-boundaries.spec.ts` passes; **no category-(b) domain-edge deviation
   is added**; the §14 plumbing question is resolved by (i) or (ii) with the
   choice stated in the file's docblock.

**Surface**
9. `GET /reports/branches/{branchId}/daily-trading/{businessDay}` exists,
   dashboard-only, guarded in the §24 order.
10. **One branch, one business day.** No ranges, no query parameters.
11. Response matches §24 exactly, including `scope.notes`.

**Correctness**
12. SALES POPULATION is `state = 'completed'` and nothing else (§6).
13. TENDER POPULATION is **all** payments for the branch-day (§6), and the
    identity `Σ tender.amountTotal = grossSales + unsettledCapturedTotal`
    holds exactly.
14. `netSales = gross − discounts − refunds − tax` (FR-CST-003).
    `orders.subtotal` appears **nowhere**.
15. Tender amounts use `payment.amount` **only**. `tendered_amount` and
    `change_given` appear in **no** aggregate.
16. `cashRoundingAdjustments` is the **payments-side** sum and sits outside
    gross/net.
17. Session set = `DISTINCT cash_session_id` from the day's payments;
    `cash_session_close_attempts` is **not queried**; `variance` is summed
    over `status='closed'` **only**.
18. `taxSummary.byClass` sums exactly to `taxTotal`; **no `byRate` key
    exists**.
19. `dataAsOf` = `SELECT now()` **inside** the RR transaction;
    `periodStatus` implements §12's three states; **no `SEALED`, no
    `periodComplete` boolean**.

**Security**
20. §16 Option C guard implemented and fail-closed on **all four** paths
    (unknown/foreign branch → 404; 0 branches → 403; >1 branch → 403;
    mismatch → 403).
21. Money is `bigint` internally, **strings** on the wire, everywhere.
22. Tenant RLS via `withAuthContext`; foreign-tenant branch is
    indistinguishable from unknown.
23. **No business audit entry on the GET.**
24. **No export. No `report.export`. No warehouse. No rollup. No DayClose.**

**Verification**
25. OpenAPI regenerated; the new path documented including
    `periodStatus` semantics, the FR-RPT carve-out, and the tax/scheme
    limitations.
26. `EXPLAIN` evidence re-captured post-implementation proving the four
    orders-first plans; **no seq scan on `order_payments`**.
27. The full §29 test plan green.
28. **Clean scratch database, full suite green, before acceptance.**
29. Migration count still **34**.

---

## §29. TEST DESIGN

### SALES
- A `completed` order is counted in gross, tax, net and count.
- An `open` order is **excluded** from every sales figure.
- A **`partially_paid`** order is excluded from sales **and** counted in
  `openOrderCount` **and** its payment appears in `tenderTotals` **and** in
  `unsettledCapturedTotal`. *(The single most important test in the plan.)*
- A `cancelled` order is excluded and, per §6, provably carries no payment.
- Multiple completed orders sum exactly (bigint, no float anywhere).
- A `voided`/`comped` line does not contribute — inherited from persisted
  totals, asserted explicitly.
- `netSales === grossSales − taxTotal` when discounts and refunds are zero.
- `discounts === "0"` and `refunds === "0"` on a day with real trading.
- `averageOrderValue` exact under the ratified basis; `null` when count is 0.
- Money serialises as `^-?\d+$` strings; a >2^53 total round-trips exactly.

### TENDER
- **Cash uses `amount`, never `tendered_amount`.**
- **The brief's case, verbatim:** due 90 / tendered 100 / change 10 →
  `cash.amountTotal === "90"`.
- With a cash-rounding step active: `amount` unchanged;
  `roundingAdjustmentTotal` non-zero; `cashDrawerContribution === amount + rounding`.
- `manualExternalCard.roundingAdjustmentTotal === "0"` (CHECK-enforced).
- **No per-scheme grouping exists in the response** — asserted by absence.
- **Idempotent replay** of a capture does not double-count.
- `tenderGrandTotal === cash.amountTotal + manualExternalCard.amountTotal`.
- **`Σ tender.amountTotal === grossSales + unsettledCapturedTotal`** — exact.

### TREASURY
- Several sessions on one day: each appears **once**; no session duplicated.
- A `closed` session contributes its variance; an `open` and a `closing`
  session contribute **none** and increment `unclosedSessionCount`.
- `varianceTotal === Σ variance over status='closed'` — a NULL variance never
  reaches the sum.
- **A session with more than one close attempt cannot be constructed** —
  asserted against `uq_csca_one_per_session` (the insert must fail).
- A session whose payments span two business days appears in both days'
  roll-ups with **day-scoped** tender totals and **whole-session** close
  facts.
- A session with zero payments on the day is **absent** — asserted, since it
  is a documented limitation.
- Treasury drops a session id belonging to another branch (never returns a
  foreign row).

### TAX
- Two tax classes on one day produce two `byClass` rows.
- `Σ byClass[].taxAmount === taxSummary.taxTotal === salesSummary.taxTotal`.
- `byClass[].netAmount + byClass[].taxAmount === byClass[].grossAmount`.
- Voided/comped lines excluded from `byClass`.
- **`byRate` is absent from the response** — asserted by key absence, not by
  emptiness.
- `taxClassCode` resolves; an unresolvable id yields `null`, not an error.

### PERIOD
- Today's business day ⇒ `periodStatus === 'OPEN'`, whatever the order state.
- A past day with an unsettled order ⇒ `'UNSEALED'`, `openOrderCount > 0`.
- A past day with an unclosed contributing session ⇒ `'UNSEALED'`,
  `unclosedSessionCount > 0`.
- A past day, all settled, all drawers closed ⇒ `'SETTLED'`.
- **`'SEALED'` is never emitted** — asserted across every fixture.
- `dataAsOf` is populated, server-authoritative, and **not** influenced by any
  client header or body.
- `branchCurrentBusinessDay` matches the day `OrdersService` would stamp for
  the same branch at the same instant — **the single-implementation
  assertion**.

### SECURITY
- Missing `report.view.sales` ⇒ 403. Missing `report.view.financial` ⇒ 403.
  Holding both ⇒ 200. *(Proves AND, not OR.)*
- Foreign-tenant `branchId` ⇒ **404**, byte-identical to an unknown uuid.
- **Cross-tenant:** tenant A's report never contains one row of tenant B, on
  every section, with RLS enforced (`ros_app`, `NOBYPASSRLS`).
- **Multi-branch tenant** (2 active branches) ⇒ **403** on the reporting route,
  for **both** branch ids. *(The §16 Option C behaviour.)*
- Zero active branches ⇒ 403.
- Wrong `branchId` in a single-branch tenant, branch visible ⇒ 403.
- **One-branch positive control** ⇒ 200 with correct data.
- A **POS/PIN session** ⇒ 401/refused (dashboard-only).
- Any query parameter ⇒ 400.

### BOUNDARIES
- `module-boundaries.spec.ts` green.
- **Zero category-(b) `KNOWN_DEVIATIONS` growth**; no private-path import from
  the reporting module into any domain module — asserted by the spec, not by
  review.
- The reporting module owns no Prisma model and no migration — asserted.

### CURRENCY
- Orders in two currencies on one branch-day ⇒ **409**, no partial total
  emitted.
- `currency` in the response equals the **branch's** `base_currency`, not any
  order's snapshot.

### CONSISTENCY
- All four domain reads occur inside **one** `withAuthContext` transaction at
  `RepeatableRead` — asserted by instrumentation, not by inspection.
- A concurrent payment committed mid-report does **not** appear in a
  partially-updated way: either fully outside the snapshot, or the identity of
  §7.9 still holds.

### PERFORMANCE
- `EXPLAIN` on all four production query shapes: **index scans only**, and
  specifically **no seq scan on `sales.order_payments`**.
- **No N+1**: the query count for a branch-day with N orders, M payments and
  K sessions is **bounded and independent of N, M and K** — asserted by
  counting statements, not by timing.

---

## §30. MIGRATION DECISION

> # **NO MIGRATION EXPECTED**

- **Zero** tables. **Zero** columns. **Zero** enums. **Zero** indexes. **Zero**
  RLS/grant changes. Migration count stays at **34**.
- **Evidence:** §20's four `EXPLAIN` plans, executed this session. Every query
  shape the design uses is served by an **existing** index, with partition
  pruning on `sales.orders` and `sales.order_lines`.
- **The anticipated index is explicitly NOT created.** The POST-KDS report's
  `order_payments(tenant_id, branch_id, business_day)` is unnecessary because
  the design uses an **orders-first join**, which the branch-inclusive FK
  proves is **complete** (§20). Creating it would add write cost to an
  append-only financial ledger for a query shape nothing issues.
- **Recorded for a future slice, not authorised:** if a cross-branch or
  date-range tender report is ever built, plan **2A** in §20 is the seq-scan
  evidence that it would then need that index — **an additive index only, no
  table, no column, no enum.**

**No migration is created by this gate.**

---

## §31. REQUIREMENT CLASSIFICATIONS — HONEST, PRESERVED EXACTLY

### Advanced by this slice

| Req | Pri | Before | After | Note |
|---|---|---|---|---|
| **FR-RPT-004** | `[M]` | NOT IMPLEMENTED | **COMPLETE** | `dataAsOf` + three-state `periodStatus` + explanatory counts (§12) |
| **FR-FIN-010** | `[M]` | PARTIAL (session half) | **PARTIAL — advanced** | per-day half delivered for the two existing tenders; **"each card scheme" and the nine unbuilt tenders remain NOT SATISFIED** (§9) |
| §19.3 *Sales Summary* | — | absent | **DELIVERED** (Internal-MVP form) | gross/discounts/refunds/net/tax/count/AOV |
| §19.3 *Sales by Tender* | — | absent | **DELIVERED** | single card bucket |
| §19.3 *Cash Reconciliation* | — | absent | **DELIVERED** | by session, cashier, drawer, variance |
| §19.3 *Tax Summary* | — | absent | **PARTIAL** | by class + period; **by rate NOT IMPLEMENTED**; by jurisdiction partial |

### Explicitly NOT advanced — recorded as knowingly unmet

| Req | Pri | Status | Reason |
|---|---|---|---|
| **FR-RPT-001** | `[M]` | **NOT IMPLEMENTED** | queries the transactional primary; no read replica exists |
| **FR-RPT-002** | `[M]` | **NOT IMPLEMENTED** | no hourly/daily/weekly/monthly rollups |
| **FR-RPT-003** | `[M]` | **NOT IMPLEMENTED** | nothing to increment or rebuild |
| **FR-RPT-005** | `[M]` | **NOT IMPLEMENTED** | no Type-2 dimensions; §22 shows the live consequence (mutable `base_currency`/`timezone`) |
| **FR-RPT-030…034** | `[M]`/`[S]`/`[C]` | **NOT IMPLEMENTED** | no dashboards |
| **FR-RPT-040/041** | `[S]` | **NOT IMPLEMENTED** | no scheduled delivery, no morning brief (D-11 untouched) |
| **FR-RPT-042** | `[M]` | **NOT IMPLEMENTED** | no drill-down substrate (§19) |
| **FR-RPT-043/044** | `[M]` | **NOT IMPLEMENTED** | no export, no export audit (§18) |
| **FR-RPT-045/046** | `[S]`/`[M]` | **NOT IMPLEMENTED** | no alerts, no rate limiting |
| **FR-RPT-047** | `[C]` | **NOT IMPLEMENTED** | no NL query interface |
| **FR-FIN-020…026** | `[M]`/`[S]` | **NOT IMPLEMENTED** | DayClose / Z report untouched (§27) |
| **FR-AUD-008** | `[M]` | **NOT IMPLEMENTED** | unchanged; D-20 clause 9 stands |
| **FR-SEC-002/003/004** | `[M]` | **NOT IMPLEMENTED** | D-2 defer in force; §16 does not implement, imply or lift branch-scoped RBAC |
| **FR-CST-003** | `[M]` | **NOT CLAIMED** | COGS deliberately excluded (§7.10); food-cost % is a future report |
| **NFR-PERF-010/011/012**, **NFR-DATA-002** | `[M]` | **NOT MEASURED, NOT CLAIMED** | written against the §19.2 aggregation layer |

### Deferred Reporting scope, named

Read replica · star schema (`fact_sales_line`, `fact_payment`,
`fact_stock_movement`, `fact_waste`, `fact_labour_hour`,
`fact_kitchen_timing`, `fact_purchase_line`) · all `dim_*` tables · Type-2
dimensions · materialised rollups · report cache · export pipeline ·
dashboards · scheduled delivery · morning brief · alerts · NL query ·
drill-down · date ranges · multi-branch and consolidated reports · every
§19.3 report other than the four named above · Inventory / Kitchen /
Workforce / Governance report categories · `report.export`.

---

## §32. VERDICT

> # **B. MINIMUM REPORTING READY AFTER NARROW USER RATIFICATION**

**Not A** — three genuine ratifications are outstanding (§26), one of which
(the permission token) makes the surface literally unbuildable until answered.

**Not C** — every data semantic resolved against current source: the sales
population (§6), gross/net from FR-CST-003 (§8), the exact tender equations
(§9), attempt cardinality closed at the database level and session attribution
resolved without a second business-day implementation (§10), the tax limit
identified precisely and classified honestly (§11), and a three-state period
model derived from an exhaustive enumeration of what can still change a day's
figures (§12).

**Not D** — §16 Option C achieves fail-closed branch safety **without touching
D-2**, on the KDS-R11 precedent, and is strictly more restrictive than every
existing read route.

**Not E** — the baseline verified exactly (§1).

**Next step:** ratify §26's three decisions. Implementation is authorised only
after that, and only within §28's Definition of Done.

---

*End of report.*

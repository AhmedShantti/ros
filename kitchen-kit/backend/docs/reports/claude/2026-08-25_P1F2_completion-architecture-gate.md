# P1F-2 — Final Payment + Order Completion Atomic Orchestration: Architecture / Design Gate

**Report type:** Architecture & design gate (audit and design only — no implementation, no production code changed, no migration created, no commit, no push)
**Authority statement:** This report is **non-authoritative evidence**. The SRS (`ROS_SRS_v1.0.pdf`) and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (and the domain design records they index, e.g. `docs/production/PRODUCTION_SPEC_DESIGN_GATE.md` §4) remain the sole authority. Repository code is **evidence**, never authority over SRS or governance. Nothing in this document creates, amends, or ratifies any governance decision.
**Date:** 2026-08-25
**HEAD:** `cf04e008a35ba421b23b96b5fa6221a8dae5da12` (unchanged — no commit made)
**Branch:** `feat/production-spec`
**Working tree:** unchanged except the three long-standing preserved user files (`.gitignore`, `src/main.ts`, `src/scripts/seed-dev-data.ts`) plus this report and the INDEX row
**Task identifier:** P1F-2 design gate

> ## VERDICT (see §AE / §AF)
> ## **BLOCKED — DESIGN/GOVERNANCE REQUIRED**
> Two **ratified governance defers** stand directly across the path of two **[M] SRS
> completed-sale obligations**. They cannot be resolved by engineering judgement, and
> inventing semantics to unblock implementation is expressly out of scope for this gate.
> §AG is therefore **NOT GENERATED**.

---

## A. STARTING STATE

Verified read-only before any analysis:

| Check | Result |
|---|---|
| `git branch --show-current` | `feat/production-spec` |
| `git rev-parse HEAD` | `cf04e008a35ba421b23b96b5fa6221a8dae5da12` |
| `git ls-remote --heads origin feat/production-spec` | `cf04e008a35ba421b23b96b5fa6221a8dae5da12` — **matches**, no divergence |
| `git ls-remote --heads origin main` | `01c0b0f3d3228af5248782a09e8dc0bc65606f9e` — untouched |
| `git status --short` | exactly ` M .gitignore`, ` M src/main.ts`, `?? src/scripts/seed-dev-data.ts` |
| Migrations | **27** |
| OpenAPI | **3.1.0**, **133** operations |
| Last accepted verification (P1F-1A) | 722 unit / 731 e2e, 34/34 suites |

No branch operation, no destructive git command, no commit, no push was performed at any point.

## B. SRS COMPLETED-SALE OBLIGATIONS

**§1.2** (verbatim): *"A single completed order must, atomically and without human intervention, produce all of the following effects:"* — nine effects: (1) sales-ledger financial record, (2) kitchen production instructions, (3) inventory depletion for every ingredient expanded recursively through sub-recipes, (4) **recognition of Cost of Goods Sold at the recipe's current valuation**, (5) payment record attributed to cashier/shift/drawer, (6) tax record per the branch's country pack, (7) employee attribution, (8) immutable audit entry, (9) update to any **linked** customer's loyalty balance and purchase history. *"Any system that does not produce all nine effects from one action is a point-of-sale system with add-ons."*

**UC-POS-01 steps 11–15** (verbatim): *"11. Payment is captured. System validates `paid_total ≥ grand_total`. 12. System transitions the order to COMPLETED, publishes `order.completed`. 13. Subscribers execute atomically: inventory depletion via recipe expansion; COGS recognition; cash session posting; tax document generation; loyalty accrual; audit entry. 14. System prints the fiscal receipt and, where required, queues fiscal submission via the outbox. 15. System releases the table to `needs_cleaning`."*

**UC-POS-01 alternate flow 13a** (verbatim, decisive): *"An ingredient's stock goes negative: depletion is recorded regardless (physical reality already occurred) and a negative-stock alert is raised. **The sale is never blocked by inventory state.**"*

**§5.5.2 Asynchronous In-Transaction — Domain Events** (verbatim): *"Used when a state change must cause other state changes atomically. Events are collected on the aggregate, and dispatched by the unit of work **within the same database transaction**. Example: **OrderCompleted causes inventory depletion, COGS recognition, and cash posting. All four must succeed or all must fail. There is no acceptable state in which a sale is recorded and inventory is not depleted.**"*

**§5.5.3** puts external effects — *"fiscal submission to the tax authority, sending a receipt SMS"* — in the **transactional outbox**, explicitly **outside** the transaction.

**NFR-PERF-006 [M]** (verbatim): *"Recipe expansion and inventory depletion for a completed order of up to 30 lines SHALL complete within 200 ms at p95 and **SHALL execute within the order's transaction**."*

**§24.2.4 `Order.complete()` reference implementation** (verbatim — the single most decisive artefact in this gate):
```ts
class Order extends AggregateRoot {
  complete(payments: Payment[], at: Instant): void {
    if (this.state !== OrderState.Open && this.state !== OrderState.PartiallyPaid)
      throw new InvalidOrderStateError(this.state, 'complete');

    const paid = Money.sum(payments.map(p => p.amount));
    if (paid.lessThan(this.grandTotal.minus(this.compTotal)))
      throw new InsufficientPaymentError(this.grandTotal, paid);

    this.state = OrderState.Completed;
    this.completedAt = at;

    this.record(new OrderCompleted({
      orderId: this.id, branchId: this.branchId, businessDay: this.businessDay,
      lines: this.lines.map(l => l.toConsumptionSpec()),
      totals: this.totals(), payments: payments.map(p => p.toSummary()),
      completedAt: at, customerId: this.customerId,
    }));
  }
}
```

**Named requirements** (verbatim): **BR-POS-001** *"An Order in state COMPLETED SHALL NOT be modified. Corrections are made by creating a Refund referencing it."* · **BR-POS-002** *"An Order SHALL NOT transition to COMPLETED while `paid_total + discount_total_of_comps < grand_total`."* · **FR-CST-001 [M]** *"On order completion, the System SHALL compute COGS by expanding each order line's recipe to base ingredients, applying modifier recipe deltas, and valuing consumption at the item's current cost per the configured costing method."* · **FR-CST-002 [M]** *"COGS SHALL be recorded on the order line as `unit_cost_snapshot` and SHALL NOT be recomputed retroactively when ingredient costs change."* · **FR-POS-007 [M]** *"The System SHALL record `opened_by`, `served_by`, and `closed_by` employee identities on every order."* · **FR-POS-024 [M]** *"Removal modifiers SHALL reduce ingredient consumption in the inventory depletion calculation. A 'no cheese' burger SHALL NOT deplete cheese."* · **FR-POS-050 [S]** comps: *"the revenue is zero, but the cost is still recognised and inventory is still depleted."* · **FR-POS-070 [M]** void table: pre-fire void → inventory effect *"None"*; post-fire void → *"Depletion stands; waste record prompted"*. · **FR-INV-014 [M]** permits negative stock. · **FR-AUD-001 [M]** immutable audit entry for every state-changing operation. · **§5.5.4** event catalogue: `order.completed`, publisher **Sales**, subscribers *Inventory, Costing, Treasury, Fiscal, Customer, Analytics*.

**SRS physical schema (§25.2)** mandates on `sales.orders`: `cogs_total BIGINT` (*"Populated on completion"*), `completed_at TIMESTAMPTZ`, `closed_by UUID REFERENCES workforce.employees(id)`, and `CONSTRAINT ck_completed CHECK (state <> 'completed' OR completed_at IS NOT NULL)`.

**§7.4.3 StockMovement** carries `unit_cost BIGINT` (*"Cost per base unit at movement time"*), `total_cost BIGINT` (*"quantity × unit_cost"*), `reference_type VARCHAR(32)` (*"order, goods_receipt, transfer, count, waste, production"*), `reference_id ULID`. Movement type **`sale_depletion`**, sign **−**, trigger **"Order completed"**. Domain relationship: `order_lines ──1:N── stock_movements (sale_depletion)`.

## C. CURRENT IMPLEMENTATION AUDIT

Legend for **COMPLETION-TIME ACTION** / **SAME-TRANSACTION**: **Y** / **N** / **NSD** (not source-decidable).

### 1. FINAL PAYMENT
- **SRS:** FR-POS-060/061/063/065/066; UC-POS-01 §11.
- **Owner:** Sales (§25.1 `sales.order_payments`).
- **Persistence:** `sales.order_payments` — exists, append-only (`ros_app` SELECT+INSERT only, UPDATE/DELETE revoked), RLS enable+force, branch-inclusive Order FK and branch-safe Terminal FK (P1F-1A).
- **Service/contract:** `SalesPaymentService.capture(...)` (`src/modules/sales/orders/sales-payment.service.ts:107`). Consumes Treasury `CASH_SESSION_FACTS_QUERY` and Localisation `PINNED_PAYMENT_POLICY_QUERY`.
- **Event:** none. **API:** `POST /orders/{businessDay}/{id}/payments`, `pos.payment.capture`, Idempotency-Key + If-Match mandatory.
- **State:** **PARTIAL** — partial capture works; a payment that would fully or over-settle is refused with `FULL_PAYMENT_REQUIRES_COMPLETION` (`sales-payment.service.ts:266-276`).
- **Completion-time action: Y** (the final tender is the trigger). **Same-transaction: Y.**

### 2. ORDER COMPLETION STATE
- **SRS:** BR-POS-001/002, §24.2.4, §25.2 `ck_completed`.
- **Owner:** Sales.
- **Persistence:** `OrderState.completed` enum value **EXISTS** (`schema.prisma:1704`); `Order.completedAt` **EXISTS** (`:1762`); `Order.closedBy` **EXISTS** (`:1749`); `Order.version` exists.
- **Service:** **DOES NOT EXIST.** `TRANSITIONS` (`order-state.ts:71-87`) declares **zero** transitions into `completed`; `partially_paid: []` is presently a terminal dead-end. No `assertMayComplete`, no completion service, no route, no permission.
- **Event/API:** none.
- **State:** **NOT IMPLEMENTED** (schema surface present, behaviour absent).
- **Completion-time action: Y. Same-transaction: Y.**

### 3. SALES LEDGER / FINANCIAL RECORD
- **SRS:** §1.2 effect 1.
- **Owner:** Sales. See §M — there is no separate ledger table in this repository; the completed Order plus its immutable Payment rows **are** the sales-ledger representation.
- **State:** **PARTIAL** (Payments exist and are immutable; the "completed" half is missing).
- **Completion-time action: Y** (setting the Order terminal/immutable). **Same-transaction: Y.**

### 4. KITCHEN INSTRUCTIONS
- **SRS:** §1.2 effect 2; FR-KDS-010.
- **Owner:** Kitchen. Produced **at Fire**, not at completion — `SalesFireService` publishes `order.line.fired` per line inside one UoW transaction; `OrderLineFiredHandler` (`kitchen/tickets/order-line-fired.handler.ts:48`) persists Tickets synchronously on the same `tx`.
- **State:** **COMPLETE** (for Fire).
- **Completion-time action: N** — already frozen earlier in the lifecycle; Completion only preserves it. See §R.

### 5. RECIPE DEPLETION (explosion into quantities)
- **SRS:** §1.2 effect 3; FR-CST-001; NFR-PERF-006.
- **Owner:** Production (recipe explosion) → Inventory (movement).
- **Persistence:** recipe graph exists — `production.recipes` / `recipe_versions` / `recipe_lines`, recursive sub-recipe linkage, depth-10 guard, cycle detection.
- **Service:** `RecipeCostService.cost(tx, recipeVersionId, …)` (`production/costing/recipe-cost.service.ts:72`) performs the **full recursive expansion and unit conversion** — but returns **money only** (`CostedVersion`). The per-line base-unit quantity is computed at `recipe-cost.ts:244-248` (`quantityInBaseUnit`) and **immediately multiplied into cost and discarded**. There is **no** `Map<stockItemId, quantity>` output anywhere.
- **Contract:** `src/modules/production/contract/` **DOES NOT EXIST**. Sales already imports the concrete `RecipeCostService` via the allow-listed deviation `'sales->production': ['costing/recipe-cost', 'costing/recipe-cost.service']`.
- **State:** **PARTIAL** — traversal proven, quantity output absent.
- **Completion-time action: Y. Same-transaction: Y** (NFR-PERF-006 mandates it explicitly).

### 6. INVENTORY STOCK MOVEMENTS
- **SRS:** §1.2 effect 3; §7.4.3; BR-INV-001; FR-INV-014; UC-POS-01 13a.
- **Owner:** Inventory.
- **Persistence:** `inventory.stock_movements` **EXISTS** and is well-formed for this purpose — `movement_type` enum already contains **`sale_depletion`** and `sale_reversal`; `unit_cost`/`total_cost`/`reference_type`/`reference_id` all NOT NULL and present; append-only (SELECT+INSERT, UPDATE/DELETE revoked on parent **and every partition**); RLS enable+force on parent and every partition.
- **Service:** `MovementsService.post(tx, tenantId, actorId, input)` (`inventory/movements/movements.service.ts:86`) — **transaction-composable**, the only such seam. It writes the movement, upserts the `stock_levels` projection, decrements batches, and calls `recipeCost.recomputeForStockItem(tx, …)` on the same `tx` (`:251`).
- **Contract:** `src/modules/inventory/contract/` **DOES NOT EXIST**. `MovementsService` is exported as a concrete class only.
- **Negative stock:** deliberately permitted, never blocked (`movements.service.ts:141,161`; shortfall returned by `costing.ts:86` and discarded by the caller) — matches UC-POS-01 13a exactly.
- **No sale-driven writer exists:** repo-wide, `sale_depletion` appears only in the enum, the DDL, and an OpenAPI enum listing (`inventory.controller.ts:165`).
- **State:** **PARTIAL** (substrate complete; no sale path, no contract, no idempotency key — see §X).
- **Completion-time action: Y. Same-transaction: Y.**

### 7. COGS
- **SRS:** §1.2 effect 4; FR-CST-001/002; §25.2 `orders.cogs_total` *"Populated on completion"*.
- **Owner:** Costing (a bounded context that is **not implemented**); costing arithmetic currently lives in Production.
- **Persistence today:** `sales.order_lines.unit_cost_snapshot` (per-**unit** cost, written **at line capture**, `order-lines.service.ts:318`) and `sales.orders.cogs_total` (`schema.prisma:1759`, no doc comment).
- **Critical distinction (the trap this gate was asked to avoid):** `orders.cogs_total` is **NOT posted COGS**. It is a running sum of **sale-time estimates**, recomputed on every line add over non-voided/non-comped lines, written while the order is `draft`/`open` — never at completion (`order-lines.service.ts:808-853`, spread onto the Order at `:358-365`).
- **A posted-COGS persistence location DOES NOT EXIST.** No COGS-posting service, no COGS ledger/journal, no `analytics.fact_sales_line` (no `analytics` schema is declared at all).
- **State:** **NOT IMPLEMENTED** (as posted COGS).
- **Completion-time action: Y per SRS — but see §L / §AE: BLOCKED by ratified governance.** **Same-transaction: Y.**

### 8. TAX
- **SRS:** §1.2 effect 6; BR-POS-004.
- **Owner:** Sales holds the snapshot; Localisation owns the engine; `fiscal.tax_classes` holds class identity (P1C-1).
- **Persistence:** `order_lines.tax_amount`, `order_lines.tax_class_id`, `orders.tax_total` — all computed and frozen **at line capture** under BR-POS-004 (`schema.prisma:1802` *"BR-POS-004 sale-time snapshots — never recomputed from master data"*). The order pins `country_pack_version`.
- **No tax ledger / tax posting table exists.**
- **State:** **COMPLETE** for the snapshot.
- **Completion-time action: N — preserve only.** See §O.

### 9. TREASURY / CASH SESSION CONSEQUENCE
- **SRS:** §1.2 effect 5; FR-FIN-004; FR-FIN-010; §16.2.
- **Owner:** Treasury.
- **Persistence:** the `treasury` schema contains **exactly three models — `Shift`, `Drawer`, `CashSession`**. **`treasury.cash_movements` DOES NOT EXIST.**
- **Expected-cash computation DOES NOT EXIST**; `openingFloat` is stored and echoed, nothing more. Treasury exposes **exactly one route** (`@Post()` — open a session). No close, no reports, no tender totals.
- **Decisive source:** §16.2 lists *"Cash Sales (**system-computed**)"* and *"Cash Refunds (**system-computed**)"* against *"Pay-ins (**recorded**)"*, *"Pay-outs (**recorded**)"*, *"Safe Drops (**recorded**)"*. Cash sales are **derived**, not posted. P1D-B makes the Payment row the authoritative attribution; P1D-G confirms only physical cash affects expected cash.
- **State:** attribution **COMPLETE** (Payment carries session/employee/terminal/drawer-via-session); reporting **NOT IMPLEMENTED**.
- **Completion-time action: N.** See §N.

### 10. EMPLOYEE / SHIFT / DRAWER / TERMINAL ATTRIBUTION
- **SRS:** §1.2 effects 5 and 7; FR-POS-007 [M]; P1D-E/G.
- **Persistence:** on the Payment (employee, cash session → shift + drawer, terminal, tenant, branch) — already complete. On the Order: `opened_by` written; `served_by` and **`closed_by` are never written**.
- **State:** **PARTIAL** — FR-POS-007's `closed_by` clause is unmet.
- **Completion-time action: Y** (set `closed_by`). **Same-transaction: Y.** This is a small, source-decided, non-blocked item.

### 11. AUDIT
- **SRS:** §1.2 effect 8; FR-AUD-001 [M].
- **Owner:** Governance. `AuditService.record(tx, …)` is transaction-composable and hash-chained; the table is append-only.
- **Taxonomy:** `ORDER_CREATED`, `ORDER_STATE_CHANGED`, `ORDER_LINE_ADDED`, `ORDER_LINE_VOIDED`, `ORDER_FIRED`, `PAYMENT_CAPTURED` exist. **`ORDER_COMPLETED` does not.** Adding an audit action constant is ordinary taxonomy (precedent: `ORDER_FIRED` was added for Fire) and is **not** a permission — no governance issue.
- **State:** substrate **COMPLETE**; the completion entry **NOT IMPLEMENTED**.
- **Completion-time action: Y. Same-transaction: Y.**

### 12. FISCAL CONSEQUENCE
- **SRS:** §1.2 effect 6 (tax record) vs UC-POS-01 §13 (*"tax document generation"*) and §14 (*"queues fiscal submission via the outbox"*).
- **Persistence:** the `fiscal` schema contains **exactly one model — `TaxClass`**. No `tax_documents`, no `fiscal_submissions`, no numbering, no signing, no sequence strategy.
- **No transactional outbox exists anywhere in the repository** (confirmed repo-wide; every mention is a comment stating its absence). FR-PLT-041's mandated outbox is unimplemented.
- **Governance:** P1C-1 (RATIFIED) — *"Fiscal remains otherwise out of scope: no tax documents, invoice templates, fiscal submissions or `fiscal.tax_rules` table."*
- **State:** **NOT IMPLEMENTED**, and explicitly out of scope by ratified governance.
- **Completion-time action: N for the MVP.** See §P — this is **not** a completion-atomicity blocker, because §5.5.3 places fiscal submission *outside* the transaction by design.

### 13. RECEIPT
- **SRS:** UC-POS-01 §14; §5.5.3.
- **State:** **NOT IMPLEMENTED** (no receipt model, template, renderer, or printer integration).
- **Completion-time action: N.** See §Q. A printer must never join a PostgreSQL transaction; §5.5.3 classifies it as an out-of-transaction effect.

### 14. CUSTOMER HISTORY
- **SRS:** §1.2 effect 9 — conditional (*"any **linked** customer"*).
- **Persistence:** **no `Customer` model exists anywhere** in `schema.prisma`; **no `crm` schema is declared**; **`Order.customer_id` DOES NOT EXIST** (contrast SRS §25.2 which specifies it). No CRM module exists in `src/modules/`.
- **State:** **NOT IMPLEMENTED** — and the conditional is **structurally unreachable**: no order can have a linked customer today.
- **Completion-time action: N** (vacuously satisfied). See §S.

### 15. LOYALTY
- Same as 14. No loyalty account/transaction model, no module. `loyalty` appears in the repository only as SRS-quoting prose.
- **State:** **NOT IMPLEMENTED**; unreachable conditional. **Completion-time action: N.**

### Additional item found by this audit — TABLE RELEASE (UC-POS-01 §15)
`BranchTable` has **no `status` column, deliberately** — `schema.prisma:661-663`: *"`status` is deliberately ABSENT (D-05): live table state is order-driven, high-churn and owned by Sales."* FR-POS-081 (floor-plan live table state, including `needs cleaning`) is **[S]**, not [M]. **Correctly deferred; not a blocker.**

## D. COMPLETION COMMAND OWNER

**Sales owns the Completion application command.** Source-decided, three independent confirmations:
1. **§25.1 schema ownership** — `sales` owns `orders, order_lines, order_line_modifiers, order_discounts, order_payments, refunds`. Completion mutates `sales.orders`.
2. **§24.2.4** — `complete()` is a method on the `Order` **aggregate root**, which Sales owns.
3. **§5.5.4 event catalogue** — `order.completed`, **Publisher: Sales**.

**No orchestration module may be created.** ADR-001 (modular monolith) plus §5.5.2 already provide the mechanism, and the repository's `UnitOfWork` implements it precisely.

**Synchronous collaborators (must complete before COMMIT):** Production (recipe→quantity expansion), Inventory (stock movements + level projection), Governance (audit). Treasury and Localisation are consulted **read-only** through their existing public contracts during the payment half.

**Effects that MUST be inside the transaction:** final Payment insert, Order CAS to `completed` (+ `completed_at`, `closed_by`), inventory depletion, COGS recognition (if authorised), audit, and the `order.completed` publication with its synchronous handler drain. Justification: §5.5.2 verbatim (*"All four must succeed or all must fail"*) and NFR-PERF-006 (*"SHALL execute within the order's transaction"*).

**Effects that may be after the transaction (outbox):** fiscal submission, receipt printing/SMS — §5.5.3 verbatim. **No outbox exists**, so neither can be implemented in P1F-2 regardless.

**Mechanism split, per the §6 rule:**
- *Caller needs the result / same transaction* → **synchronous public contract**: Production's quantity expansion and Inventory's depletion command. Sales needs their success to decide whether to commit, and needs no fan-out semantics.
- *Same-transaction domain consequence, fan-out* → **in-transaction domain event**: `order.completed`, published via `ctx.publishEvent` and drained by `TransactionalDomainEventDispatcher` before COMMIT.

**Design note (important, and a genuine open choice within §AG's scope once unblocked):** SRS §5.5.2 models depletion/COGS as *subscribers* to `OrderCompleted`. The repository's UoW supports exactly that. However, subscriber-driven depletion means Sales cannot surface a precise domain error for an inventory failure, and UC-POS-01 13a says the sale must **never** be blocked by inventory state — which argues that depletion failures must be *impossible* rather than *handled*. Both shapes are implementable on the existing substrate; this gate does not need to settle it, because the slice is blocked earlier (§AE).

## E. FINAL PAYMENT API DECISION

**Recommendation: OPTION A — reuse `POST /orders/{businessDay}/{id}/payments`; a Payment that satisfies the Order completes it atomically in the same transaction.**

**Label: ENGINEERING RECOMMENDATION.** The SRS does **not** define an HTTP route for completion — §24.2.4's `complete()` is a *domain* method, and Chapter 26 defines no `/complete` endpoint. This is therefore not SRS-mandated as a wire shape, but it is strongly source-*supported*.

| Criterion | Option A (payment completes) | Option B (`POST …/complete` carrying final tender) |
|---|---|---|
| UC-POS-01 §11→§12 | **Exact match** — *"Payment is captured. System validates `paid_total ≥ grand_total`. System transitions the order to COMPLETED"*. Completion is the **consequence** of the final capture. | Recasts one use-case step as two operations |
| Aggregate ownership | Unchanged; Order remains the aggregate | Unchanged |
| Idempotency | **Inherits P1F-1 unchanged** — permanent client Payment id + HTTP Idempotency-Key, both already proven | Requires a second idempotency identity for the completion op, or reuse of the Payment id anyway |
| Permanent Payment ID | Already the replay anchor; a replay after completion returns the stored response | Same, but now spans two resource identities |
| If-Match / version | One CAS on one version | One CAS, but the client must know which version to send after a payment it did not separately make |
| Retry / final-payment replay | Single code path, already tested | Two paths to keep consistent |
| Split tender (FR-POS-061) | **Natural** — every payment asks "does this settle it?"; the last one completes | Awkward: N−1 payments on one route, the Nth on another |
| Cash change / rounding (FR-POS-063) | Reuses P1F-1 arithmetic verbatim | Must be duplicated |
| Card metadata (FR-POS-066) | Reuses the existing DTO | Must be duplicated |
| Audit | One transaction, two entries (§T) | Same |
| Atomic rollback | **Guaranteed by construction** — one request, one transaction | Guaranteed only if the final tender is *inside* the complete call; a two-request protocol is explicitly unacceptable |
| Frontend usability | Cashier presses "Pay"; the system decides | Client must pre-compute whether this tender settles, and choose an endpoint — pushing a financial decision to the client |
| OpenAPI | **133, unchanged** | 134 |

**Decisive argument:** P1F-1 deliberately created `FULL_PAYMENT_REQUIRES_COMPLETION` at precisely the point where the payment path *should* have completed the order but could not. Option A is the natural discharge of that gate: delete the refusal, complete instead. Option B would leave the payment route permanently unable to accept a final tender, which no source requires.

**Rejected explicitly:** any two-request protocol (record payment, then call complete) — it can commit the final Payment before Completion, which §4 of the governing task forbids and which would produce exactly the "paid in full + PARTIALLY_PAID" invalid state P1F-1 was built to prevent.

**Option C** (a source-implied alternative) was examined and none exists: there is no completion affordance anywhere in the current API or domain design.

## F. FINANCIAL SATISFACTION RULE

**Rule:** `paid_total_including_this_payment >= grand_total - discount_total_of_comps`, which **today collapses to `paid_total >= grand_total`**.

Grounding — three independent sources agree, so this is **not** a guess:
1. **BR-POS-002** (negative form): must not complete while `paid_total + discount_total_of_comps < grand_total`.
2. **UC-POS-01 §11**: *"System validates `paid_total ≥ grand_total`."*
3. **§24.2.4**: `if (paid.lessThan(this.grandTotal.minus(this.compTotal))) throw new InsufficientPaymentError(...)`.

Point-by-point resolutions:

| Question | Answer | Basis |
|---|---|---|
| Does cash rounding affect the settlement threshold? | **No.** `rounding_adjustment` is not a term in any of the three formulations. | §24.2.4 pseudocode contains no rounding term; BR-POS-002 names only `paid_total`, `discount_total_of_comps`, `grand_total`. |
| Does rounding affect `paid_total`? | **No.** `paid_total` accumulates the **exact unrounded** `amount`; the rounding adjustment is persisted separately per Payment (P1D-D) and projected onto `orders.rounding_adjustment`. | P1F-1 implementation; BR-FIN-004 (*"recorded as a distinct `rounding_adjustment`, never absorbed into revenue or tax"*). |
| Does `changeGiven` affect settlement? | **No.** Change is cash handed back; it is `tendered_amount − rounded_cash_due` and never touches `amount` or `paid_total`. | FR-POS-063; P1F-1. |
| How do multiple partial Payments aggregate? | Arithmetic sum of `amount` over the order's Payments, maintained as the `orders.paid_total` projection via `increment`. §24.2.4 uses `Money.sum(payments.map(p => p.amount))` — identical. | §24.2.4; FR-POS-061. |
| What does over-tendered CASH mean? | The customer hands more than due; the excess is returned as change. `amount` remains the settled sum. Over-tendering is **not** overpayment. | FR-POS-063. |
| Can `amount` exceed the remaining balance? | **Yes — the rule is `>=`, not `=`.** BR-POS-002 forbids only *under*-settlement. | BR-POS-002; §24.2.4 (`lessThan`). |
| Are overpayments allowed by the SRS? | **Not forbidden.** No source requires exact settlement, and no tip/overpayment disposition is specified for the MVP (`Order.tip_total` exists but has no writer). | Absence of any prohibiting requirement. |
| Exact settlement, or `paid >= due`? | **`paid >= due`.** | All three sources above. |
| Does manual external card permit overpayment? | The rule is tender-agnostic; nothing distinguishes card. | No source distinguishes. |

**Comps:** `discount_total_of_comps` is **verifiably zero today**. `OrderLine.isComp` and `OrderLineState.comped` exist as schema surface but have **no writer anywhere**; `Order.discountTotal` and `OrderLine.lineDiscount` are hardcoded `0n` (`order-lines.service.ts:313`) and deliberately not recomputed (`:849-853`). So the term collapses without guessing. **This must be re-derived, not hardcoded away**, if a comp mechanism is ever added.

**Arithmetic:** integer minor units (`bigint`) exclusively; the existing `Money`/`divideRounded` kernel already guarantees no floating point. **No rule here is unresolved.**

## G. ORDER STATE TRANSITIONS

**Both source states are required — this is explicit, not inferred.** §24.2.4:
```ts
if (this.state !== OrderState.Open && this.state !== OrderState.PartiallyPaid)
  throw new InvalidOrderStateError(this.state, 'complete');
```

Therefore P1F-2 must support **`open → completed`** *and* **`partially_paid → completed`**.

**No intermediate state may be persisted.** An OPEN order settled by a single full payment goes directly to `completed`. Writing `partially_paid` first and then `completed` inside one transaction would persist a state the order was never in (invisible outside the transaction, but recorded in `version` churn and audit) purely to satisfy a diagram — expressly rejected by the governing task and unsupported by §24.2.4.

Required changes to `order-state.ts:71-87` (currently `open: ['held','parked','cancelled','partially_paid']`, `partially_paid: []`):
- add `'completed'` to `open`
- add `'completed'` to `partially_paid` (resolving its present dead-end)
- `completed: []` already correct — terminal.

**Terminality / immutability:** BR-POS-001 — *"An Order in state COMPLETED SHALL NOT be modified."* `completed` is already in the `FINALISED` set (`order-state.ts:44-49`), and `assertOrderMutable` already refuses mutation of finalised orders. Consequently, with **no new code**, once `completed` is reached: `assertMayAddLine`, `assertMayFire`, `assertMayCapturePayment` and `assertCashierMayMutateLine` all refuse. This is a genuine, already-verified strength of the existing design.

**Post-completion mutation restrictions (exact):** no AddLine, no Fire, no further Payment, no line void, no state transition (`completed: []`). Corrections are Refunds referencing the order (BR-POS-001) — out of scope.

**Version increments:** **exactly one** per completion command. The single CAS carries `paid_total`, `rounding_adjustment`, `state`, `completed_at`, `closed_by`, `cogs_total` (if authorised), `version = expected + 1`.

**`completed_at`:** set to the one command instant. SRS §25.2 mandates `CHECK (state <> 'completed' OR completed_at IS NOT NULL)` — **this constraint does not exist in the repository** and should be added by the Sales-owned migration (§AA). The structural precedent is exact: `SalesFireService` sets `first_fired_at` conditionally inside its CAS (`sales-fire.service.ts:228-246`).

**`first_fired_at`:** untouched — preserved.

**`closed_by`:** set to the **Employee** (P1D-E: Employee is the financial actor, User is the audit actor), discharging FR-POS-007 [M].

**Projection invariants after completion:** `paid_total >= grand_total`; `rounding_adjustment` = sum of per-Payment adjustments; `state = completed`; `completed_at NOT NULL`; Payments immutable and append-only.

## H. PAYMENT IDEMPOTENCY / RETRY

Both existing layers are preserved unchanged:
1. **HTTP `Idempotency-Key`** — the P1E-6A-corrected resource-scoped interceptor (fingerprint over the *resolved* path + body). Replay → stored response with `Idempotent-Replay: true` (FR-API-022); different fingerprint → **409** (FR-API-023).
2. **Permanent client-generated Payment id** (FR-OFF-015) — `sales-payment.service.ts:124-151`: if the id exists and all immutable facts match → replay the stored result; if any differs → **409 fail-closed**.

**On exact retry after successful completion**, the permanent-id check short-circuits **before** any state is read or written, returning the original `{order, payment}`. Because that check precedes everything, a retry produces: no second Payment, no second stock depletion, no second COGS, no second audit, no second transition, no version churn — **provided the completion work is placed strictly after the permanent-id replay check**, which the existing structure already guarantees.

**Does Completion need its own permanent operation id?** **No.** Recommended answer: `(Order id, terminal `completed` state, Payment id)` is sufficient, because completion is a *deterministic function* of the final payment — one final Payment id maps to exactly one completion, and the Order's terminal state plus CAS makes a second attempt impossible (a retry either replays via the Payment id or fails the version check). Introducing a separate completion id would add an identity no source requires and no consumer needs. This is an **engineering conclusion grounded in the existing repository design**, and it holds only under Option A (§E); Option B would likely require one.

**Note:** the stock-movement idempotency key (§X) is a *different* problem — it protects against duplicate depletion within a partially-failed transaction and across the Inventory boundary, and it is **not** solved by the Payment id alone.

## I. CONCURRENCY MODEL

Completion uses the established atomic CAS: `updateMany({ where: { id, businessDay, version: expectedVersion }, data: { …, version: nextVersion } })`, `count === 0` → `OrderVersionConflictError` → **409**. The 20-line justification at `sales-fire.service.ts:206-227` (CAS over read-check under READ COMMITTED) applies verbatim.

| # | Race | Prevented by | Outcome |
|---|---|---|---|
| A | Two final Payment attempts at the same expected version | **Order CAS** | Exactly one wins; loser 409. Proven by the existing P1F-1 concurrency test. |
| B | Partial Payment races final Payment | **Order CAS** | One wins; the loser retries against the new version and re-evaluates settlement. |
| C | AddLine races final Payment | **Order CAS** — AddLine also bumps `version` | `grand_total` cannot change under a completing payment without invalidating its version. |
| D | Fire/amendment races final Payment | **Order CAS** (Fire bumps `version`) | Same. |
| E | Two retries, same Payment id, different HTTP keys | **Unique Payment PK + permanent-id replay check** | Second returns the replay; the conflict-safe `ON CONFLICT DO NOTHING RETURNING` pattern means `tx` is never poisoned (P1E-5A). |
| F | Completion while another transaction changes Inventory valuation | **NOT PREVENTED — see below** | Genuine, unresolved. |

**Race F is real and currently unmitigated.** `MovementsService.post` reads `stock_levels` without a lock (`movements.service.ts:111-119`), computes `balanceAfter` in JS (`:161`), then upserts (`:192`). There is **no `SELECT … FOR UPDATE`, no `{decrement:}` atomic update on `stock_levels`, and no version column**. Two concurrent depletions of the same `(item, location)` under READ COMMITTED can **lose an update** on `quantity_on_hand`. `stock_batches` *is* decremented atomically (`:220`), so batch and level accounting can diverge. This is a **pre-existing Inventory defect**, not created by P1F-2, but P1F-2 would be its first high-frequency concurrent caller and must not ship on top of it unaddressed.

Additionally, `MovementsService.post` invokes `recipeCost.recomputeForStockItem(tx, …)` on **every** movement (`:251`). A 30-line order would trigger up to 30 upward recipe-cost cascades inside the completion transaction — a direct threat to NFR-PERF-006's 200 ms p95 budget, and a source of write amplification and lock contention on `recipe_versions`.

**Proposed deterministic real-PostgreSQL concurrency test (for the future implementation):** two genuinely independent transactions, synchronised by a real barrier (`makeBarrier(2)`, no sleeps) injected through an **existing** DI seam — `CASH_SESSION_FACTS_QUERY` is the proven seam (it is called after the order read/version compute and before the settlement gate and CAS). Both attempt a final settling payment on the same order at the same expected version. Assert: exactly one 201 with `state='completed'`, exactly one 409; exactly one Payment row; exactly one set of `sale_depletion` movements; `stock_levels.quantity_on_hand` decremented exactly once; one `ORDER_COMPLETED` audit entry. A second variant should pin race F specifically: two different orders depleting the same stock item concurrently, asserting the ledger sum equals the projection (BR-INV-003).

## J. INVENTORY DEPLETION DESIGN

**Answers to the gate's questions, from source and current implementation:**

- **Does Sales call Inventory synchronously through a public command?** It must — Sales needs the result in its own transaction. But `inventory/contract/` **does not exist**; a new, narrow public contract is required (§K).
- **Does Production own recipe explosion and Inventory own stock movement?** **Yes** — §25.1 ownership plus the existing code shape (`RecipeCostService` owns traversal; `MovementsService` owns the ledger).
- **Does an existing public Production contract return depletion facts?** **No.** The only Production port is `RECIPE_COST_RECOMPUTER` (an *inbound* recompute hook). The cost traversal computes base-unit quantities and discards them.
- **Are Fire snapshots sufficient?** **No.** `order.line.fired` deliberately excludes money, tax and cost (`contract/events.ts:50-57`) and carries no recipe identity. **However, `order_lines.recipe_version_id` is pinned at sale (BR-POS-004)** — so Completion must resolve consumption from the **pinned** `recipe_version_id`, never from the currently-published version. This is essential: recipe versions are selected purely by `status='published'` with **no as-of-date resolution** (`recipe-graph.ts:143-164`), so re-resolving at completion could consume a different recipe than the one sold. The pinned column is exactly the mechanism that prevents this.
- **Is depletion based on sold / fired / served / completed-line quantity?** **Completed order lines**, using `OrderLine.quantity` (the only quantity column; there is no fired-quantity). Fire is all-or-nothing per line.
- **How are voided/cancelled lines excluded?** FR-POS-070: **pre-fire void → no inventory effect; post-fire void → "Depletion stands"**. Today **only pre-fire void is implemented** (`order-lines.service.ts:416`, guarded by `assertCashierMayMutateLine` which refuses post-fire), so the correct current rule is simply *exclude `state='voided'`*. Comped lines **must be depleted** (FR-POS-050) — currently unreachable, since nothing writes `comped`.
- **How are modifiers with recipe effects handled?** **THEY CANNOT BE — see §AE blocker B-2.** `Modifier.recipeDelta` is opaque by ratified D-17-07; `Modifier.stockItemId`/`consumptionQuantity` are FK-less and read by nothing.
- **How are recipe yields/units converted?** The machinery exists in Production: `conversionToStockBaseUnit` prefers an item-specific factor over a generic one and returns `null` on a gap rather than assuming 1 (`recipe-cost.service.ts:369-389`). Depletion must convert to the stock item's **`baseUnitId`**, matching `MovementsService`, which always writes `unitId: item.baseUnitId` and assumes base units.
- **Which inventory location is consumed?** The branch's registry row: `org.locations` where `(tenant_id, location_type='branch', ref_id=branch_id)` — the unique key `@@unique([tenantId, locationType, refId])` makes this a single deterministic lookup. `LocationsService` already exposes it.
- **What uniqueness key prevents duplicate sale depletion?** **None exists.** See §X — this is design blocker B-3.

**Negative stock:** must **never** block the sale (UC-POS-01 13a, FR-INV-014). The current implementation already behaves correctly — shortfall is recorded, not raised. A depletion path must not add a guard that would violate this.

## K. PRODUCTION / RECIPE CONTRACT

Chosen shape: **A + C** — a Production **query** that explodes sale lines into ingredient quantities, and an Inventory **command** that posts already-resolved quantities. Rejected: option B (Production writing stock movements) — it would violate §25.1 ownership; and any path where Sales reads Production or Inventory private tables.

**Contract 1 — Production (new, `src/modules/production/contract/`)**

| Field | Value |
|---|---|
| **OWNER** | Production |
| **CONSUMER** | Sales (Completion) |
| **SYNC / IN-TX** | Synchronous, takes `tx: Prisma.TransactionClient` |
| **INPUT** | `{ lines: readonly { orderLineId, recipeVersionId (**pinned**, nullable), quantity: Decimal }[] }` |
| **OUTPUT** | `{ perLine: { orderLineId, components: { stockItemId, quantityInBaseUnit, unitId }[], gaps: RecipeGap[] }[] }` — quantities only, **no money** |
| **IDEMPOTENCY / NATURAL KEY** | None — pure read/derivation, no writes |
| **WHY THIS MODULE OWNS IT** | §25.1 gives Production the recipe graph. The recursive traversal, depth-10 guard, cycle detection and unit conversion already live here (`RecipeCostService`). A quantity-returning sibling reuses that traversal; the alternative would duplicate recipe semantics inside Sales or Inventory. |

Notes: a `NULL` `recipe_version_id` means **absent recipe** (P1C-5) — zero components, sale permitted, **no depletion**, never an error. Unlike the cost path, quantity expansion **has no valuation dependency**, so it cannot fail for a missing valuation — which is what makes UC-POS-01 13a satisfiable.

**Contract 2 — Inventory (new, `src/modules/inventory/contract/`)**

| Field | Value |
|---|---|
| **OWNER** | Inventory |
| **CONSUMER** | Sales (Completion) |
| **SYNC / IN-TX** | Synchronous, takes `tx` |
| **INPUT** | `{ tenantId, locationId, actorId, occurredAt, referenceType: 'order', referenceId, components: { stockItemId, quantityInBaseUnit, orderLineId }[] }` |
| **OUTPUT** | `{ movements: { id, stockItemId, quantity, unitCost, totalCost, balanceAfter }[] }` — **returns `unit_cost`/`total_cost`, which is the SRS's own COGS location (§7.4.3)** |
| **IDEMPOTENCY / NATURAL KEY** | **UNRESOLVED — blocker B-3 (§X)** |
| **WHY THIS MODULE OWNS IT** | §25.1 gives Inventory `stock_movements`; BR-INV-001 append-only; the levels projection and batch consumption are Inventory invariants (BR-INV-003). Sales must never write `inventory.*`. |

**Both contracts must follow the established repository pattern exactly** (as `treasury/contract/cash-session-facts.query.ts` does): a `Symbol` token, an interface whose methods take `tx` first, `useExisting` binding in the owning module, consumer imports **only** from `<module>/contract`.

**Existing boundary debt this exposes:** `'sales->production': ['costing/recipe-cost', 'costing/recipe-cost.service']` — Sales currently imports the **concrete** `RecipeCostService`. Introducing `production/contract/` is the natural opportunity to retire that deviation, but doing so is **not** required by P1F-2 and must not silently expand scope.

## L. COGS DESIGN

- **Which module owns COGS computation?** The **Costing** bounded context — **which is not implemented**, by ratified decision. Costing arithmetic currently lives in Production as a recipe-cost service.
- **Which module owns valuation?** Inventory owns the persisted valuation state (`stock_levels.average_cost`, `stock_batches.unit_cost`, `stock_items.standard_cost`/`costing_method`). Production **reads** it via `StockValuationService` and never writes it.
- **Valuation read before or after depletion?** Must be **before** — after an outbound movement the batch layers are consumed. (Note: `MovementsService` deliberately does *not* change `average_cost` on outbound movements, so weighted-average items are insensitive to ordering; **FIFO items are not**.)
- **Method?** **Per item**, dispatched on `stock_items.costing_method` ∈ `{fifo, weighted_average, standard}`. **No global default and no fallback between methods** — binding constraint 1 of the D-17-05 amendment, and implemented that way (`stock-valuation.service.ts:144-188`).
- **How do modifier recipe components contribute?** **They cannot — blocker B-2.**
- **Where is COGS stored?** Two SRS-specified locations, both of which **already exist as columns**: `order_lines.unit_cost_snapshot` (FR-CST-002) and `orders.cogs_total` (§25.2, *"Populated on completion"*). Plus `stock_movements.unit_cost`/`total_cost` (§7.4.3), which is where consumption is valued at movement time.
- **Are P1C snapshots sale-time estimates or final COGS truth?** **Sale-time estimates. They are NOT posted COGS.** This is the distinction the gate specifically warned against collapsing, and the evidence is unambiguous: `unit_cost_snapshot` is written once at line capture (`order-lines.service.ts:318`) under BR-POS-004; `orders.cogs_total` is recomputed on every line add while the order is still `draft`/`open`.

**Two genuine SRS tensions, stated honestly rather than resolved by fiat:**
1. **BR-POS-004** requires `unit_cost_snapshot` to be captured *"at the time of sale"* and never recomputed; **FR-CST-001** requires COGS to be computed *"on order completion … at the item's current cost"*. These name different instants for the same column. The coherent reading is that FR-CST-001 fixes the *timing*, FR-CST-002 the *location and immutability thereafter* — but the repository has already implemented the line-capture reading under ratified governance (P1C-2/P1C-5), so **changing it now is a governance act, not a refactor**.
2. **UC-POS-01 13a** (*"the sale is never blocked by inventory state"*) versus **P1C-2 binding constraint 2** (*"a **complete** recipe whose component valuation is unavailable **fails**"*). At line-capture time the second rule is coherent (refuse to sell an uncosted dish). At completion time it would mean an unavailable valuation **blocks a fully-paid sale** — which 13a forbids. If COGS is re-valued at completion, this conflict must be resolved by governance.

**A defect found in the current COGS arithmetic (reported, not fixed):** `order-lines.service.ts:841-842` computes
```ts
if (line.unitCostSnapshot !== null) { cogs = (cogs ?? 0n) + line.unitCostSnapshot; }
```
`unit_cost_snapshot` is a **per-unit** cost (written as `cost.unitCostMinorUnits`, `:318`) and `OrderLine.quantity` is `Decimal(12,3)`, but the sum **never multiplies by quantity**. A line of 3 × an item contributes 1 × its unit cost. `orders.cogs_total` is therefore **understated for every line with quantity ≠ 1**. This is pre-existing (P1C-era), outside P1F-2's mandate to fix unilaterally, and directly relevant because any completion-time COGS design inherits or corrects it.

**Classification: NOT SOURCE-DECIDABLE / DESIGN REQUIRED — and additionally governance-blocked.** See §AE B-1.

## M. SALES LEDGER CONSEQUENCE

| Field | Finding |
|---|---|
| **SRS MEANING** | §1.2 effect 1 — *"A financial record in the sales ledger, denominated in the branch's operating currency."* |
| **CURRENT IMPLEMENTATION REPRESENTATION** | **The completed Order plus its immutable `order_payments` rows.** There is **no** `sales_ledger`, journal, or accounting-entry table in the repository, and §25.1 does not name one — `sales` owns `orders, order_lines, order_line_modifiers, order_discounts, order_payments, refunds`. No accounting/journal schema is declared anywhere. |
| **COMPLETION WRITE REQUIRED** | **Yes, but no *new* table** — the write is the Order's transition to `completed` with `completed_at`, `closed_by` and its final totals, alongside the already-immutable Payment rows. |
| **OWNER** | Sales |
| **ATOMICITY REQUIREMENT** | Same transaction as the final Payment — §5.5.2. |

**Conclusion: no design decision is required here.** The SRS does not mandate a separate ledger table; §25.1's own ownership map is the structure, and it is satisfied by the existing Sales tables. Inventing a ledger table would be exactly the "casual new table" the gate forbids.

## N. TREASURY CONSEQUENCE

**Outcome: NO NEW TREASURY MUTATION AT COMPLETION — proven from source, not assumed.**

Four independent grounds:
1. **§16.2** distinguishes *"Cash Sales (**system-computed**)"* and *"Cash Refunds (**system-computed**)"* from *"Pay-ins (**recorded**)"*, *"Pay-outs (**recorded**)"*, *"Safe Drops (**recorded**)"*. Sales are **derived**, not posted.
2. **FR-FIN-004**'s formula (`Opening Float + Cash Sales + Cash Tips + Pay-ins − Cash Refunds − Pay-outs − Safe Drops ± Cash Rounding Adjustments`) is fully derivable from existing Payment columns: `tender='cash'`, `amount`, `rounding_adjustment`, `cash_session_id`.
3. **P1D-B** (ratified): the Payment row *is* the source of truth for session attribution. **P1D-G**: only physical cash affects expected cash; electronic tenders appear in tender totals, never in the drawer balance.
4. **`treasury.cash_movements` DOES NOT EXIST** in this repository — the `treasury` schema contains exactly `Shift`, `Drawer`, `CashSession`. There is literally nothing to write, and creating it would be an unrequested Treasury migration serving no implemented consumer (no expected-cash computation, no session close, no reports exist — Treasury exposes exactly one route, `@Post()` to open a session).

**No public contract is required, and none should be built.** UC-POS-01 §13's *"cash session posting"* is discharged by the Payment's existing `cash_session_id` attribution, written at payment time.

## O. TAX CONSEQUENCE

- **Is tax immutable/frozen before Completion?** **Yes.** `order_lines.tax_amount` and `tax_class_id` are computed and snapshotted at line capture under BR-POS-004 (`schema.prisma:1802`), and `orders.tax_total` is their sum. The order pins `country_pack_version`, and the pinned pack is resolved (never "current") through Localisation's public contract.
- **Does Completion merely finalise the existing snapshot?** **Yes — preserve only.**
- **Is a tax ledger/posting row required at completion?** **No** — no tax ledger or posting table exists or is named for Sales in §25.1. §1.2 effect 6 (*"a tax record formatted according to the branch's country configuration pack"*) is discharged by the immutable per-line tax snapshot plus the pinned pack version.
- **Is fiscal tax reporting distinct from Order tax calculation?** **Yes** — `fiscal` owns `tax_documents`/`fiscal_submissions` (§25.1); those are the *document*, not the calculation. See §P.
- **Does a later fiscal document own posting?** Yes, when Fiscal exists.

**Completion must NOT recompute tax**, and must ensure current catalogue/tax configuration changes cannot alter a completed sale — already structurally guaranteed by the snapshots plus BR-POS-001 immutability. **Nothing to persist; preservation is automatic.**

## P. FISCAL CONSEQUENCE

Separating the three things the gate rightly insists are distinct:

**(A) SRS completed-sale atomicity.** §1.2 effect 6 requires *"a tax record formatted according to the branch's country configuration pack"* — discharged by §O's snapshot. §1.2 does **not** require a fiscal *document* among the nine atomic effects.

**(B) Country-specific fiscal document / tax-authority integration.** UC-POS-01 §13 lists *"tax document generation"* among subscribers and §14 says the system *"prints the fiscal receipt and, where required, queues fiscal submission **via the outbox**"*. **§5.5.3 explicitly classifies fiscal submission as an out-of-transaction effect.** Repository reality: the `fiscal` schema contains **only `TaxClass`** — no `tax_documents`, no `fiscal_submissions`, no numbering, no signing, no sequence strategy (FR-OFF-017), no tax-authority client. **No transactional outbox exists anywhere** (FR-PLT-041 unimplemented). Ratified governance concurs — P1C-1: *"Fiscal remains otherwise out of scope: no tax documents, invoice templates, fiscal submissions or `fiscal.tax_rules` table."*

**(C) Ordinary receipt rendering.** See §Q.

**Can the MVP Completion complete without a fiscal document?** **Yes.** Justification: the fiscal document is (i) not among §1.2's nine atomic effects, (ii) explicitly an outbox/out-of-transaction concern per §5.5.3, and (iii) explicitly out of scope by ratified governance (P1C-1). A completed sale that preserves its immutable tax snapshot and pinned pack version retains everything a later fiscal document needs.

**This is a deferral, not a discharge.** FR-OFF-017's gapless-sequence requirement is a real future obligation, and a jurisdiction requiring *immediate* issuance would make deferral untenable in production. That is a **deployment/certification** constraint, not a P1F-2 blocker.

**Classification: NOT A BLOCKER for P1F-2. Fiscal remains NOT IMPLEMENTED and deferred.**

## Q. RECEIPT DISPOSITION

- **Required inside the DB transaction?** **No — and it must not be.** §5.5.3 names *"sending a receipt SMS"* as an out-of-transaction effect. A physical printer must never join a PostgreSQL transaction; doing so would let a paper jam roll back a settled sale.
- **A deterministic read model after Completion?** **Yes — this is the correct shape.** Everything a receipt needs is already immutable after completion: line snapshots (`item_name_snapshot`, `unit_price`, `tax_amount`), order totals, per-Payment tender/rounding/change, pinned `country_pack_version`, `completed_at`.
- **Fiscal-document generation?** Distinct — §P.
- **Currently absent?** **Yes**, entirely.
- **Can receipt failure invalidate the completed sale?** **No.** NFR-REL-001 and §5.5.3 together make the sale durable independently of print.
- **Part of P1F-2?** **No — deferred to a later slice.** P1F-2's only receipt obligation is to ensure the data is preserved immutably, which BR-POS-001 already guarantees.

## R. KITCHEN DISPOSITION

**Completion has NO new Kitchen action.** Verified: kitchen instructions are produced at **Fire** (§1.2 effect 2 is discharged by `order.line.fired` → `OrderLineFiredHandler` → Ticket persistence, all inside the Fire transaction). UC-POS-01 places firing at steps 6/8, before payment at step 10.

- **Do not** publish duplicate `order.line.fired`.
- **Do not** mutate Tickets because the order settled financially — no source requires it. (Ticket lifecycle is bump/recall, driven by Kitchen.)
- **`order.completed` for Kitchen/Analytics:** the §5.5.4 catalogue lists subscribers *Inventory, Costing, Treasury, Fiscal, Customer, Analytics* — **Kitchen is not among them**. So publishing `order.completed` is **REQUIRED for completion correctness** (it is the mechanism §5.5.2 mandates for depletion/COGS), but a Kitchen subscription would be **OPTIONAL downstream** and is not in scope.

## S. CUSTOMER / LOYALTY DISPOSITION

- **Is Order↔customer linkage implemented?** **No.** `Order.customer_id` **does not exist** in `schema.prisma` (SRS §25.2 specifies it; the repository omits it). No `Customer` model, no `crm` schema declared, no CRM/Loyalty module in `src/modules/`.
- **Is CRM or Loyalty callable?** **No.**
- **Live field or placeholder?** **Neither — the column is absent entirely.** There is no write path because there is no column.
- **Does the MVP allow linking a customer to an Order?** **No.**

**Conclusion: the conditional completion effect (§1.2 effect 9 — *"any **linked** customer"*) is currently UNREACHABLE.** It is **vacuously satisfied**: no order can have a linked customer, so no order can owe a loyalty consequence.

Per the gate's explicit instruction, **no fake CRM/Loyalty work is proposed**. `order.completed`'s payload should carry `customerId` as specified by §24.2.4 — which will be `null` for every order today, and is the correct forward-compatible shape.

**Classification: NOT IMPLEMENTED / unreachable. Not a blocker.**

## T. AUDIT

**Two audit entries, not one combined action.** Rationale: the final capture and the completion are two distinct, separately-meaningful state changes on two different entities, and FR-AUD-001 requires an entry *"for every state-changing operation"*. Collapsing them would lose the Payment-level record that `PAYMENT_CAPTURED` already provides on every other payment, making the final payment uniquely un-auditable as a payment.

1. **`PAYMENT_CAPTURED`** — entity `order_payment`, entity id = Payment id. **Unchanged from P1F-1** (this is exactly the "do not duplicate accidentally" concern: the existing call site is reused as-is, not re-issued).
2. **`ORDER_COMPLETED`** *(new constant — ordinary taxonomy, not a permission; precedent: `ORDER_FIRED` was added for Fire)* — entity `order`, entity id = Order id.

Required content of the completion entry:
- `action: ORDER_COMPLETED`, `entityType: 'order'`, `entityId: order.id`
- `before: { state, version, paidTotal }` — Fire sets this precedent (`sales-fire.service.ts:267`); note P1F-1's payment audit passes **no** `before` block, which the completion entry should not copy
- `after` / metadata: `state: 'completed'`, `completedAt`, `version`, `paidTotal`, `grandTotal`, `finalPaymentId`, `closedBy` (Employee), `cashSessionId`, `terminalId`
- `actorType: 'user'`, `actorId` = **User** (security/audit actor); the **Employee** is recorded as the financial actor in the payload — P1D-E
- downstream consequence identifiers that are safe to record: the `sale_depletion` movement ids and, if authorised, the posted COGS total

**Transactionality:** `AuditService.record(tx, …)` is already transaction-composable and hash-chained; both entries are written on the completion `tx` before COMMIT.

## U. DOMAIN EVENTS

**`order.completed` is REQUIRED.** Grounds: §5.5.4 event catalogue (Publisher **Sales**; subscribers Inventory, Costing, Treasury, Fiscal, Customer, Analytics); §24.2.4 records `OrderCompleted` on the aggregate; §5.5.2 names it as the mechanism by which depletion, COGS and cash posting become atomic.

**Payload — source-specified by §24.2.4; no field invented:**
`orderId`, `branchId`, `businessDay`, `lines` (each line's consumption spec — `toConsumptionSpec()`), `totals`, `payments` (each payment's summary — `toSummary()`), `completedAt`, `customerId` (always `null` today, §S).

Repository conventions the contract must follow (matching `sales/contract/events.ts`): `ORDER_COMPLETED_EVENT_TYPE = 'order.completed'`, `ORDER_COMPLETED_EVENT_VERSION = 1`, `businessDay` as a `YYYY-MM-DD` **string**, timestamps as ISO-8601 strings, money as decimal strings of minor units.

**Do NOT create** `payment.completed`, `order.paid`, or any other event — no source defines them.

**Required ordering inside the single transaction** (see §V for the full sequence): Payment persistence → Order mutation → *(depletion / COGS via synchronous contracts or via the event's handlers)* → audit → `order.completed` publication → handler drain → COMMIT.

**A structural gap that must be closed first:** `SalesPaymentService` uses plain `prisma.withAuthContext`, **not** `UnitOfWork` (documented at `sales-payment.service.ts:76-78`, because P1F-1 published no event). It therefore has **no `ctx.publishEvent`** and cannot publish `order.completed` as written. It must be migrated to `unitOfWork.execute(...)` — mechanical, and `SalesFireService` is the exact precedent.

## V. EXACT TRANSACTION SEQUENCE

**ONE PostgreSQL transaction. Proof:** `UnitOfWork.execute` runs inside `PrismaService.withAuthContext`, which is a single `this.$transaction(...)` that first sets transaction-local RLS context via `set_config(..., true)`. Its own doc states *"Nested calls to `withAuthContext` are NOT supported (Prisma has no nested interactive transactions)"* — so a nested `$transaction` is **structurally impossible**, not merely discouraged. `dispatcher.drain(ctx)` is awaited **before** the callback returns, so every handler runs on the same `tx` **before COMMIT**; a handler rejection propagates out and rolls back business write and subscriber writes together.

| # | Step | Owner | R/W | Public contract | Can fail? | Rollback effect |
|---|---|---|---|---|---|---|
| 0 | HTTP idempotency interceptor (resource-scoped fingerprint) | Platform | R/W | — | Y (409) | Before tx; nothing written |
| — | **BEGIN — `unitOfWork.execute({userId, tenantId}, ctx => …)`; RLS context set** | Sales | W | — | N | — |
| 1 | Permanent Payment-id replay/conflict check | Sales | R | — | Y (409) | Replay returns stored result; **must stay first** |
| 2 | Load Order (+ lines, incl. `recipe_version_id`, `quantity`, `state`) | Sales | R | — | Y (404) | Nothing written |
| 3 | `assertMayCapturePayment(order.state)` — `open` \| `partially_paid` | Sales | R | — | Y (422) | Nothing written |
| 4 | `assertVersion(order.version, expectedVersion)` | Sales | R | — | Y (409) | Nothing written |
| 5 | Resolve CashSession facts (branch/employee/terminal/currency/open) | Treasury | R | `CASH_SESSION_FACTS_QUERY` | Y (404/422) | Nothing written |
| 6 | Resolve pinned payment policy (currency, cash rounding, mode) | Localisation | R | `PINNED_PAYMENT_POLICY_QUERY` | Y (422) | Nothing written |
| 7 | Tender computation — cash rounding, change, or card metadata | Sales | — | — | Y (400/422) | Nothing written |
| 8 | **Settlement decision**: `paidTotal + amount >= grandTotal − compTotal` | Sales | — | — | N | Determines branch: partial (P1F-1 path) vs **completing** |
| 9 | Insert immutable Payment (`ON CONFLICT DO NOTHING RETURNING …`) | Sales | W | — | Y (409) | Full rollback |
| 10 | **If completing:** resolve branch inventory location `(tenant, 'branch', branchId)` | Organisation | R | `organisation/contract` (extend) | Y (422) | Full rollback |
| 11 | **If completing:** explode non-voided lines → base-unit component quantities, from **pinned** `recipe_version_id` | Production | R | **NEW** `production/contract` | Y | Full rollback |
| 12 | **If completing:** post `sale_depletion` movements + level projection | Inventory | W | **NEW** `inventory/contract` | Y | Full rollback |
| 13 | **If completing:** recognise COGS | *Costing* | W | **UNRESOLVED — §AE B-1** | Y | Full rollback |
| 14 | Order CAS — `paid_total`, `rounding_adjustment`, `state`, `completed_at`, `closed_by`, `cogs_total`, `version+1` | Sales | W | — | Y (409) | Full rollback |
| 15 | Audit `PAYMENT_CAPTURED` | Governance | W | `AuditService.record(tx, …)` | Y | Full rollback |
| 16 | **If completing:** audit `ORDER_COMPLETED` (with `before`) | Governance | W | `AuditService.record(tx, …)` | Y | Full rollback |
| 17 | **If completing:** `ctx.publishEvent(order.completed)` | Sales | — | `sales/contract` | N | — |
| 18 | `dispatcher.drain(ctx)` — synchronous handlers on the same `tx` | Platform | W | — | Y | Full rollback |
| 19 | Re-read Order; return `{order, payment}` | Sales | R | — | N | — |
| — | **COMMIT** | — | — | — | — | — |
| 20 | Response + `ETag` + idempotency record | Platform | W | — | — | After commit |

**No outbox is used for any mandatory same-DB consequence** (§5.5.3 reserves the outbox for effects *outside* the database, and none exists anyway). **No cross-module private query appears** — every cross-boundary step goes through a `contract/` token.

**Open structural choice (deliberately not settled here):** steps 10–13 may be executed either as direct synchronous contract calls from Sales (shown above) or as `order.completed` **handlers** in step 18, which is the literal §5.5.2 shape. Both are single-transaction and both are supported by the existing dispatcher. The trade-off is error attribution (direct calls give Sales precise domain errors) versus fidelity to the SRS's subscriber model. This must be settled in the implementation slice, once §AE is unblocked.

## W. FAILURE / ROLLBACK MATRIX

Every row below is inside the single transaction unless noted. "Retry safe" means a client retry with the same permanent Payment id and Idempotency-Key is correct and non-duplicating.

| Failure | HTTP / domain error | Payment persisted? | Order COMPLETED? | Inventory changed? | COGS changed? | Audit persisted? | Retry safe? |
|---|---|---|---|---|---|---|---|
| Final Payment validation failure (amount ≤ 0, missing tender field) | 400 | No | No | No | No | No | Yes |
| CashSession closed between read and write | 422 `INVALID_CASH_SESSION` | No | No | No | No | No | Yes (after reopening/correct session) |
| Stale `If-Match` | 409 | No | No | No | No | No | Yes (reload, resend) |
| Duplicate Payment id, **identical** facts | 201 replay | Pre-existing only | Unchanged | No new | No new | No new | Yes — idempotent |
| Duplicate Payment id, **different** facts | 409 | No | No | No | No | No | No — client defect (fail closed) |
| Insufficient CASH tendered | 422 `INSUFFICIENT_CASH_TENDERED` | No | No | No | No | No | Yes |
| Invalid manual-card metadata | 400 | No | No | No | No | No | Yes |
| **Inventory insufficient / negative stock** | **NOT AN ERROR** | **Yes** | **Yes** | **Yes (goes negative)** | Yes | Yes | n/a — UC-POS-01 13a / FR-INV-014: the sale is never blocked |
| Recipe **absent** (`recipe_version_id IS NULL`) | **NOT AN ERROR** | Yes | Yes | No depletion for that line | Zero for that line | Yes | n/a — P1C-5 |
| Recipe **incomplete** | **NOT AN ERROR** | Yes | Yes | Partial depletion | Partial | Yes | n/a — BR-MNU-012 |
| Unit-conversion gap on a component | **UNRESOLVED** — 422 (fail closed) vs deplete-what-is-known | No / partial | No | No | No | No | Depends on resolution — **see B-5** |
| Inventory write conflict (lost update on `stock_levels`) | **UNMITIGATED** — silent wrong balance, no error | Yes | Yes | **Incorrectly** | Yes | Yes | **No — race F, §I** |
| COGS valuation unavailable | **UNRESOLVED** — 422 (P1C-2) vs record-anyway (13a) | — | — | — | — | — | **See B-1 / B-5** |
| COGS write conflict | 409 / rollback | No | No | No | No | No | Yes |
| Treasury consequence failure | n/a | — | — | — | — | — | No Treasury write exists (§N) |
| Audit failure | 500 → rollback | No | No | No | No | No | Yes — audit is transactional, so a failure voids the sale (correct: FR-AUD-001) |
| `order.completed` handler failure | propagates → full rollback | No | No | No | No | No | Yes — §5.5.2 *"All four must succeed or all must fail"* |
| PostgreSQL deadlock / serialization conflict | 500 (or mapped 409) | No | No | No | No | No | Yes — whole tx rolls back |

**Two rows are genuinely unresolved** (unit-conversion gap; COGS valuation unavailable). Both stem from the same unresolved question — whether completion *re-values*, and whether a valuation gap may block a fully-paid sale. They are recorded as blocker B-5, dependent on B-1.

## X. IDEMPOTENCY / NATURAL KEYS

**This is design blocker B-3, and it is a hard structural constraint, not a preference.**

Current state of `inventory.stock_movements`:
- `reference_type VARCHAR(32) NOT NULL` and `reference_id UUID NOT NULL` **already exist** and are exactly the SRS's document-identity mechanism (§7.4.3: *"order, goods_receipt, transfer, count, waste, production"*).
- `idx_mv_reference` on `(reference_type, reference_id)` is a **plain index, NOT unique** — so it provides **no** idempotency.
- The table is **RANGE-partitioned on `occurred_at`**, and PostgreSQL requires **every unique constraint on a partitioned table to include the partition key**. The PK is `(id, occurred_at)` precisely because `PRIMARY KEY (id)` is rejected outright.

**Consequence:** the natural key one would want — `UNIQUE (tenant_id, reference_type, reference_id, stock_item_id)` — is **not expressible** on this table as partitioned.

**Viable design (requires ratification of the key and an Inventory-owned migration):**
`UNIQUE (tenant_id, reference_type, reference_id, stock_item_id, occurred_at)`, made meaningful by deriving `occurred_at` **deterministically from the completion instant** so that a retry reproduces the identical value. Reusing `completed_at` (itself derived from the single command instant and immutable once written) satisfies this. Insert via the **P1E-5A-proven conflict-safe pattern** — `INSERT … ON CONFLICT (…) DO NOTHING RETURNING <explicit aliased columns>` — never `INSERT`-catch-`P2002`-then-query, which poisons the transaction.

**Caveats that must be decided, not assumed:**
- A single order line whose recipe uses the same stock item twice (directly and via a sub-recipe) must be **aggregated per `stock_item_id`** before insert, or the key collides with itself. Aggregating is also the correct domain answer (one net consumption per item per sale) and matches the SRS relationship `order_lines ──1:N── stock_movements`.
- If per-**order-line** granularity is wanted instead (which the SRS relationship diagram suggests), the key must include an order-line discriminator — but `stock_movements` has **no** order-line column, so this would require adding one. That is a schema decision, not an inference.
- The projection update (`stock_levels`) is **not** idempotent by itself; it must be skipped when the conflicting insert did nothing.

**Related operational obligations discovered (must not be silently inherited):** partitions currently exist only through `stock_movements_2027_09`, and there is **no DEFAULT partition** — an insert with `occurred_at` beyond that range is **rejected outright**. Each new partition additionally requires its own `ENABLE`/`FORCE ROW LEVEL SECURITY`, policies and `REVOKE`, because PostgreSQL applies a partition's own policies when it is named directly (a real defect already found and fixed once, `20260817090000_inventory_partition_rls`). Partition creation is manual (FR-DR-002 automation deferred).

## Y. SECURITY / PERMISSION

**Recommendation: `pos.payment.capture` alone. Do NOT create `pos.order.complete`.**

**Label: ENGINEERING INTERPRETATION**, explicitly grounded:
- SRS **§15.2's Sales catalogue contains no completion verb** and no payment verb. It lists `pos.order.create`, `void_line_prefire`, `void_line_postfire`, `cancel`, `cancel_after_production`, `discount.apply/approve/unlimited`, `comp.apply`, `price.override`, `refund.issue`, `refund.different_tender`, `reprint.receipt`, `order.transfer`, `order.reopen`. (`pos.order.reopen` — *"Reopen a closed order (highly restricted)"* — confirms closure is a real concept while defining no permission to *perform* it.)
- The repository's **zero-invented-codes discipline** (D-17-06 precedent) is intact, and **P1D-F records `pos.payment.capture` as the single authorised exception to date**. Inventing a second code would break that discipline without user authorisation.
- Under Option A (§E), completion is the **system consequence of a successfully authorised final tender**, not a separately-initiated operator action. The operator's decision is "take this payment"; the system decides that it settles the order.

If the user prefers an explicit completion permission, that is a **governance act** requiring the same explicit authorisation P1D-F received — it must not be assumed by an implementer.

**Other required checks (all already enforced by the existing payment route, and unchanged):** terminal-bound POS identity (`requirePosIdentity` → 403 without `terminalId`/`employeeId`); Employee and Terminal taken from the **trusted PIN session, never the request body** (P1D-E); open CashSession validated via Treasury's contract (status/branch/employee/terminal/currency); branch consistency now additionally **structurally guaranteed** by P1F-1A's branch-inclusive Order FK and branch-safe Terminal FK; Order visibility/ownership via tenant RLS.

**Shift:** attribution flows through CashSession → Shift (P1D-G); no additional check is required at completion.

**No Manager/approval requirement** — no source imposes one for ordinary settlement.

**Authorization remains TENANT-scoped**; D-2's branch-scoped RBAC defer stands and must not be quietly resolved here.

## Z. API / OPENAPI

Under the §E recommendation (Option A), **no new route is created**:

| Aspect | Value |
|---|---|
| **PATH / METHOD** | `POST /orders/{businessDay}/{id}/payments` — **unchanged** |
| **BODY** | `CapturePaymentDto` — **unchanged** (`id?`, `tender`, `amountMinor`, `cashSessionId`, `tenderedAmountMinor?`, `terminalReference?`, `cardScheme?`, `last4?`, `authorizationCode?`) |
| **HEADERS** | `Idempotency-Key` (required), `If-Match` (required) — unchanged |
| **SUCCESS** | **201 Created** — unchanged |
| **RESPONSE** | `{ payment, order, remainingBalance }` — unchanged shape; on a settling payment `order.state = 'completed'`, `order.completedAt` non-null, `remainingBalance` ≤ 0 |
| **ETag** | `W/"<orderId>.<version>"` — unchanged |
| **ERRORS** | 400 malformed; **401/403**; 404 order/session; **409** stale If-Match, key/body conflict, same Payment id different facts; **422** illegal state, invalid cash session, insufficient tender. **`FULL_PAYMENT_REQUIRES_COMPLETION` (422) is REMOVED** — it becomes unreachable by construction and its test must be replaced by a completion test, not deleted. |

**Expected operation count after implementation: 133 + 0 = 133 — UNCHANGED.**
**Why no new HTTP operation:** completion is a state transition caused by an existing operation, not a separately-addressable resource action. The SRS defines no `/complete` endpoint, and UC-POS-01 models §11→§12 as one operator action.

*(If the user instead directs Option B, the count becomes 134 — one new `POST /orders/{businessDay}/{id}/complete`.)*

OpenAPI stays **3.1**. RFC 7807 and the `/v1` runtime prefix remain out of scope and must not be touched.

## AA. MIGRATION PLAN

Baseline **27**. Migrations are **module-owned**; a Sales migration must not alter an Inventory table.

| # | Module | Table | Column / constraint | Why required by source | Why existing schema cannot represent it |
|---|---|---|---|---|---|
| 28 | **Sales** | `sales.orders` | `CONSTRAINT ck_completed CHECK (state <> 'completed' OR completed_at IS NOT NULL)` | SRS §25.2 specifies this constraint verbatim | Constraint absent; nothing prevents a `completed` order with NULL `completed_at` |
| 29 | **Inventory** | `inventory.stock_movements` | `UNIQUE (tenant_id, reference_type, reference_id, stock_item_id, occurred_at)` | Retry must not double-deplete (FR-POS-065, §X) | `idx_mv_reference` is non-unique; the partition key must be included, so no existing constraint can serve |

**Explicitly NOT required:**
- `orders.completed_at`, `orders.closed_by`, `orders.cogs_total`, `OrderState.completed`, `MovementType.sale_depletion` — **all already exist**.
- `treasury.cash_movements` — not required (§N), and creating it would be an unrequested Treasury migration with no consumer.
- Any sales-ledger, tax-ledger, or COGS-ledger table (§M, §O) — no source names one for Sales.
- Any `fiscal.*` table (§P).
- Any `crm.*` table (§S).
- Any Identity change.

**Dependency order:** 28 (Sales, independent) and 29 (Inventory, independent) may be applied in either order; neither depends on the other. **Migration 29 is contingent on B-3 being resolved** (the exact key must be ratified before it is written).

**Contingent on B-1:** if completion-time COGS posting is authorised and requires a persistence location beyond the existing `orders.cogs_total` / `order_lines.unit_cost_snapshot` / `stock_movements.unit_cost|total_cost`, further module-owned migrations follow. **No COGS table is proposed here** — the gate forbids inventing one casually, and the SRS's own locations already exist.

## AB. MODULE-BOUNDARY PLAN

New public contracts (both following the `treasury/contract` pattern exactly — Symbol token, `tx`-first interface, `useExisting` binding):
- `src/modules/production/contract/` — **Production's first contract**; recipe→quantity expansion (§K contract 1).
- `src/modules/inventory/contract/` — **Inventory's first contract**; sale depletion command (§K contract 2).
- `src/modules/sales/contract/events.ts` — add `order.completed` (§U).
- Possibly extend `src/modules/organisation/contract/` for branch→location resolution (§V step 10).

`module-boundaries.spec.ts` must be extended to prove, mechanically:
1. `contract/` files for Production and Inventory are interface-only (`containsPersistenceImplementation === false`).
2. The concrete implementations live outside `contract/` and are genuinely concrete (`=== true`).
3. Sales imports Production and Inventory **only** from `<module>/contract`.
4. **`KNOWN_DEVIATIONS` does not grow.**

**Pre-existing debt this touches (report, do not silently expand scope):** `'sales->production': ['costing/recipe-cost','costing/recipe-cost.service']` — Sales imports the concrete `RecipeCostService` today. Introducing `production/contract/` is the natural moment to retire that entry, but retiring it is a **separate** decision; P1F-2 must at minimum not **add** to it. Similarly `'inventory->production': ['costing/recipe-cost.port']` is an existing port-based edge that P1F-2 does not touch.

## AC. REQUIRED MVP vs DEFERRED

### A. REQUIRED FOR P1F-2 MVP COMPLETION
*(items without which an Order cannot truthfully become COMPLETED)*
1. Final Payment accepted on the existing route (settlement gate removed).
2. `open → completed` and `partially_paid → completed` transitions.
3. `completed_at` set; `ck_completed` constraint added.
4. `closed_by` set — FR-POS-007 [M].
5. Terminal immutability after completion (already structurally provided by `FINALISED`).
6. Single atomic Order CAS, one version increment.
7. **Inventory depletion** — §1.2 effect 3, §5.5.2, NFR-PERF-006. *(Cannot be deferred: it is a mandatory atomic consequence.)*
8. **COGS recognition** — §1.2 effect 4, FR-CST-001. *(Same. — **governance-blocked**, B-1.)*
9. `order.completed` published in-transaction, handlers drained before COMMIT.
10. `ORDER_COMPLETED` audit (plus the unchanged `PAYMENT_CAPTURED`).
11. Depletion idempotency natural key (B-3).
12. Deterministic concurrency proof + rollback proofs + RLS/FK proofs.

### B. DEFERRED AFTER P1F-2
*(each with its source basis — none is a mandatory atomic consequence)*
- **Receipt generation / printing** — §5.5.3 out-of-transaction.
- **Fiscal document generation & submission** — §5.5.3 outbox; P1C-1 ratified out of scope; no substrate exists.
- **Transactional outbox itself** (FR-PLT-041) — absent repo-wide.
- **Table release to `needs_cleaning`** — FR-POS-081 **[S]**; `BranchTable.status` deliberately absent (D-05).
- **Refunds / voids post-completion** — BR-POS-001 routes corrections to Refund; separate slice.
- **Integrated card (FR-POS-064) & PaymentAttempt** — P1D-C.
- **Loyalty / customer history** — unreachable (§S).
- **Session close, day close, X/Z reports, tender reconciliation** (FR-FIN-005/010/026) — Treasury reporting surface.
- **Comps & discounts** — no mechanism exists; keeps `compTotal = 0` honest.
- **Post-fire line void** (FR-POS-070 row 2) — would change the depletion basis; not implemented today.
- **Branch-scoped RBAC** — D-2 defer stands.
- **`served_by`** — FR-POS-007's third identity, no write path today.

**Nothing mandatory is deferred here on grounds of difficulty.** Items 7 and 8 are explicitly retained as required, which is precisely why the slice is blocked rather than descoped.

## AD. REQUIREMENT CLASSIFICATION

| Requirement | CURRENT | POST-P1F-2 (if unblocked as designed) |
|---|---|---|
| §1.2 completed-sale atomicity (9 effects) | **NOT IMPLEMENTED** | **PARTIAL** — effects 1,2,3,5,6,7,8 satisfied; 4 contingent on B-1; 9 unreachable (§S) |
| UC-POS-01 §11 (validate `paid_total ≥ grand_total`) | **PARTIAL** (rule computed, then refused) | **COMPLETE** |
| UC-POS-01 §12 (transition + publish `order.completed`) | **NOT IMPLEMENTED** | **COMPLETE** |
| UC-POS-01 §13 (atomic subscribers) | **NOT IMPLEMENTED** | **PARTIAL** — depletion + audit + cash attribution; COGS contingent; tax doc & loyalty deferred |
| UC-POS-01 §14 (fiscal receipt / outbox) | **NOT IMPLEMENTED** | **NOT IMPLEMENTED** (deferred, §P/§Q) |
| UC-POS-01 §15 (release table) | **NOT IMPLEMENTED** | **NOT IMPLEMENTED** (deferred — FR-POS-081 [S], D-05) |
| FR-POS-060 (tender types) | **PARTIAL** (2 of 11) | **PARTIAL** |
| FR-POS-061 (split tender + running balance) | **PARTIAL** | **COMPLETE** for cash/manual-card |
| FR-POS-063 (change + cash rounding) | **COMPLETE** for supported tenders | **COMPLETE** |
| FR-POS-064 (integrated card lifecycle) | **NOT IMPLEMENTED** | **NOT IMPLEMENTED** |
| FR-POS-065 (payment idempotency) | **COMPLETE** | **COMPLETE** |
| FR-POS-066 (no PAN/CVV) | **COMPLETE** | **COMPLETE** |
| FR-POS-007 (`opened_by`/`served_by`/`closed_by`) | **PARTIAL** (`opened_by` only) | **PARTIAL** (`closed_by` added; `served_by` still unwritten) |
| FR-POS-024 (removal modifiers reduce consumption) | **NOT IMPLEMENTED** | **BLOCKED** — B-2 |
| BR-POS-001 (COMPLETED immutable) | **DESIGNED ONLY** | **COMPLETE** |
| BR-POS-002 (no completion while underpaid) | **DESIGNED ONLY** | **COMPLETE** |
| FR-FIN-004 (expected cash formula) | **NOT IMPLEMENTED** | **NOT IMPLEMENTED** (substrate sufficient; computation deferred) |
| FR-FIN-010 (per-session tender totals) | **NOT IMPLEMENTED** | **NOT IMPLEMENTED** (substrate sufficient) |
| FR-INV-014 (permit negative stock) | **COMPLETE** (never blocked) | **COMPLETE** |
| FR-INV-030 (every stock change an immutable movement) | **PARTIAL** (no sale writer) | **COMPLETE** for sales |
| BR-INV-001 (movements append-only) | **COMPLETE** | **COMPLETE** |
| BR-INV-003 (ledger ⇄ projection reconcile) | **PARTIAL** | **AT RISK** — race F (§I) must be fixed first |
| FR-MNU-046 / BR-MNU-003 (recipe cost, cascade) | **COMPLETE** | **COMPLETE** |
| BR-MNU-012 (absent/incomplete recipe) | **COMPLETE** | **COMPLETE** |
| FR-MNU-045 (publishing must not alter completed orders) | **PARTIAL** (per P1C-6 — undemonstrable while completion absent) | **COMPLETE** — becomes demonstrable |
| FR-CST-001 (COGS on completion at current cost) | **NOT IMPLEMENTED** | **BLOCKED** — B-1 |
| FR-CST-002 (COGS on the order line, not retroactive) | **PARTIAL** (sale-time snapshot exists; not posted COGS) | **BLOCKED** — B-1 |
| Fiscal (tax documents, submissions) | **NOT IMPLEMENTED** | **NOT IMPLEMENTED** (ratified out of scope) |
| FR-AUD-001 (audit every state change) | **PARTIAL** | **COMPLETE** for completion |
| FR-AUD-003/004 (append-only, hash-chained) | **COMPLETE** | **COMPLETE** |
| FR-PLT-003/010/012/013 (tenancy, RLS both clauses, fail-closed) | **COMPLETE** | **COMPLETE** (new writes inherit RLS + composite FKs) |
| FR-PLT-041 (transactional outbox) | **NOT IMPLEMENTED** | **NOT IMPLEMENTED** |
| FR-CRM-004 / FR-CRM-020 (customer history, loyalty ledger) | **NOT IMPLEMENTED** | **NOT IMPLEMENTED** (unreachable) |
| NFR-PERF-006 (expansion+depletion ≤200 ms p95, in-transaction) | **NOT IMPLEMENTED** | **AT RISK** — per-movement recipe-cost cascade (§I) |

## AE. HARD BLOCKERS

**Can P1F-2 be implemented now without inventing governance or financial semantics? NO.**

### B-1 — Completion-time COGS posting is deferred by ratified governance *(GOVERNANCE UNRESOLVED)*
**Conflict.** SRS **§1.2 effect 4**, **FR-CST-001 [M]**, and **§5.5.2** (*"OrderCompleted causes inventory depletion, **COGS recognition**, and cash posting … All four must succeed or all must fail"*) require COGS recognition at completion. The **D-17-05 §4.1 amendment** (RATIFIED, `docs/production/PRODUCTION_SPEC_DESIGN_GATE.md:140-190`) and its register index **P1C-2** both state, verbatim, under *"Still deferred, and NOT authorised by this amendment"*: **"the completion-time COGS posting workflow"**. The P1D preservation clause re-affirms it: *"**D-17-05's broader costing defer** is unchanged."*

**Smallest exact unresolved questions:**
1. Is D-17-05 reopened for the completion-time COGS posting workflow?
2. If yes: is posted COGS (a) the existing sale-time `unit_cost_snapshot` **re-affirmed** at completion, or (b) **re-valued** at completion per FR-CST-001's *"current cost"*?
3. If (b): how is that reconciled with **BR-POS-004** (*"captured at the time of sale … SHALL NOT be recomputed"*) and with P1C-5 item 5 (*"Later … valuation change MUST NOT rewrite a historical `unit_cost_snapshot`"*)?
4. Where is posted COGS persisted — `stock_movements.unit_cost`/`total_cost` (the SRS's own §7.4.3 location), a re-based `orders.cogs_total`, or both?
5. Is the `orders.cogs_total` **quantity-multiplication defect** (§L) corrected as part of this, and by whom?

**Why this is not "an ordinary missing implementation":** the work is explicitly named and explicitly withheld by a ratified decision. Implementing it would silently overturn that decision.

### B-2 — Modifier-aware depletion is unimplementable under ratified governance *(GOVERNANCE UNRESOLVED)*
**Conflict.** **FR-POS-024 [M]**: *"Removal modifiers SHALL reduce ingredient consumption in the inventory depletion calculation. A 'no cheese' burger SHALL NOT deplete cheese."* **FR-CST-001 [M]** likewise requires *"applying modifier recipe deltas"*. But **D-17-07** (RATIFIED): *"`modifiers.recipe_delta` remains opaque. No component-resolution, operation-identifier, or substitution semantics. FR-MNU-013 deferred."* Repository confirms total inertness: `Modifier.recipeDelta` is opaque JSONB read by nothing; `Modifier.stockItemId`/`consumptionQuantity`/`consumptionUnitId` are **FK-less and read by nothing**; sale-time cost resolution keys on the variant only and never consults modifiers.

Shipping depletion without modifier awareness means knowingly depleting cheese from a "no cheese" burger — a **[M]** violation, and precisely the unexplained-variance failure the SRS rationale calls out.

**Smallest exact unresolved questions:**
1. Is D-17-07 / FR-MNU-013 reopened to define `recipe_delta` component-resolution semantics (at minimum: removal deltas)?
2. If not, is it ratified that P1F-2 depletion is **modifier-blind**, with FR-POS-024 recorded as **NOT IMPLEMENTED** and the resulting inventory variance accepted?
3. If reopened: are `Modifier.stockItemId`/`consumptionQuantity` (FR-MNU-012) promoted to real FK-backed consumption, or is `recipe_delta` the mechanism?

### B-3 — No expressible idempotency natural key for sale depletion *(REPOSITORY DESIGN MISSING)*
`stock_movements` is RANGE-partitioned on `occurred_at`; every unique constraint must include the partition key, and `(reference_type, reference_id)` is a **plain** index. A retry would therefore double-deplete.

**Smallest exact unresolved questions:** (1) ratify the key — `UNIQUE (tenant_id, reference_type, reference_id, stock_item_id, occurred_at)` with `occurred_at` pinned to the deterministic `completed_at`; (2) confirm per-item aggregation (vs adding an order-line column for per-line granularity); (3) confirm the Inventory-owned migration. **This is solvable in design — it is not a governance question — but it must be settled before implementation.**

### B-4 — Depletion substrate is absent *(IMPLEMENTATION MISSING — not a governance blocker)*
No quantity-returning recipe expansion, no `production/contract/`, no `inventory/contract/`, no depletion command, and `SalesPaymentService` is not on `UnitOfWork`. **All buildable**; recorded so it is not mistaken for a governance issue. Its *correctness*, however, is gated by B-2.

### B-5 — Failure semantics for valuation/conversion gaps at completion *(SRS UNRESOLVED, dependent on B-1)*
**UC-POS-01 13a** (*"The sale is never blocked by inventory state"*) versus **P1C-2 binding constraint 2** (*"a **complete** recipe whose component valuation is unavailable **fails**"*). At line capture the latter is coherent; at completion it would block a **fully-paid** sale. Resolution follows automatically from B-1 answer (2): if completion does not re-value, the conflict disappears.

### Non-blocking defects and risks found by this gate (reported, not fixed)
1. **`orders.cogs_total` ignores line quantity** (`order-lines.service.ts:841-842`) — understated for every line with quantity ≠ 1. Pre-existing.
2. **Lost-update race on `stock_levels`** (§I race F) — no lock, no CAS, no version; P1F-2 would be its first high-frequency concurrent caller.
3. **Per-movement recipe-cost cascade** (`movements.service.ts:251`) — up to 30 upward cascades inside one completion transaction; threatens NFR-PERF-006.
4. **`stock_movements` partitions end 2027-09 with no DEFAULT partition**, and every new partition needs manual RLS/REVOKE repetition.
5. **Documentation drift on `computed_cost`** — `schema.prisma:2888`, `production.views.ts:54-55` and `production.controller.ts:105` all assert it is never written; it **is** written (`recipe-cost.service.ts:238-251`) under a widened grant. The controller ships that false statement in the public OpenAPI description.
6. **`PRODUCTION_SPEC_DESIGN_GATE.md` requirements matrix is stale** at lines 103/111/112 relative to its own §4.1 amendment.
7. **`sales.orders.cogs_total` has no doc comment** in either schema or migration, despite being the only COGS-named column — it invites exactly the misreading this gate had to guard against.

## AF. IMPLEMENTATION READINESS

# **BLOCKED — DESIGN/GOVERNANCE REQUIRED**

P1F-2 cannot proceed without user governance action on **B-1** and **B-2**, and a design ratification on **B-3**.

The path is otherwise unusually clear: the transaction boundary, event mechanism, CAS pattern, contract pattern, idempotency layers, audit substrate, append-only/RLS discipline and settlement arithmetic are **all present, proven and source-decided**. The blockers are not engineering unknowns — they are two ratified defers standing across two mandatory SRS obligations, which only the user can lift.

## AG. SONNET IMPLEMENTATION PROMPT

# **NOT GENERATED — IMPLEMENTATION BLOCKED**

No speculative implementation instructions are produced. Once **B-1** and **B-2** are ratified (and **B-3** settled), this gate can be reopened and §AG generated against the answers, reusing §D–§AC unchanged.

# POST-P1F-2 — MVP Implementation Audit Rebase & Next-Slice Selection

**Report type:** MVP current-state audit + next-slice selection gate (analysis only — no product code, no migration, no governance change, no commit, no push)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → current repository evidence → accepted design reports**. **No governance is created or amended here; no D-21+ exists.** Nothing in this report authorises implementation; it selects and scopes a candidate for a future, separately-gated slice.
**Date:** 2026-08-28
**HEAD:** `bfe7e69` — `feat: complete P1F-2 atomic order completion` (parent `9aa7a88`)
**Branch:** `feat/production-spec`
**Working tree at report time:** clean apart from two intentionally-uncommitted unrelated reports (`2026-08-26_MVP_current-state-and-next-slice.md`, `2026-08-27_RENDER_empty-db-demo-provisioning-check.md`) and their two `INDEX.md` rows, plus this report and its own row. No product code touched.
**Task identifier:** POST-P1F-2 MVP next-slice rebase

> ## SELECTED NEXT SLICE
> ## **P1G-1 — CashSession / Shift Close, Cash Count & Variance**
> Chosen on four pieces of hard evidence, not on the prior audit's ordering.
> **(1)** It is the **only** candidate that unblocks a strict downstream chain —
> FR-FIN-021 [M] blocks Day close while any cash session is open, and Day close
> gates the Z report (FR-FIN-022 [M]) that gates management totals. Every other
> candidate unblocks nothing. **(2)** It is the slice **P1F-2 actually unlocked**:
> before `bfe7e69` no Order could reach `completed`, so settled tender totals did
> not exist and expected cash was structurally uncomputable. **(3)** Every
> permission it needs is **named verbatim in the SRS** — `cash.session.close`,
> `cash.session.close_other`, `cash.variance.approve` — so the zero-invented-codes
> discipline (D-17-06) is satisfied with **no governance ratification required**.
> By direct contrast, the SRS contains **no `kds.*` permission code at all**, so a
> KDS slice cannot start without a governance action. **(4)** It is fully
> source-specified by seven [M] requirements. **Receipt is rejected as next**: it is
> **partly governance-blocked** — P1C-1's fiscal exclusion (*"no tax documents,
> **invoice templates**, fiscal submissions"*) was re-affirmed as recently as the
> 2026-08-25 P1F-2 entry, yet FR-POS-100/101 [M] demand invoice sequence, QR and
> template-driven layout. **Design gate: YES. Migration: YES.**

---

## 1. CURRENT MVP PATH — RECONSTRUCTED FROM REPOSITORY EVIDENCE AT `bfe7e69`

Method: classification is driven by the **actual implemented API/service surface**
(controllers, services, and their exposed methods), never by schema or tests
alone. The repository has exactly **12 controllers**; there is **no Kitchen
controller, no Receipt controller, and no Reports controller** — enumerated
directly, not inferred.

| # | Step | Classification | Repository evidence |
|---|---|---|---|
| 1 | **Authentication / PIN** | **COMPLETE** | `identity/auth/auth.controller.ts`; `POST /auth/pin` exercised end-to-end by every P1F-2 e2e suite |
| 2 | **Shift open** | **PARTIAL** | `workforce/shifts/shifts.service.ts` exposes **only** `openShift`. Grep confirms **no controller references `ShiftsService`** — it is reachable only as a consequence of CashSession open, via the `SHIFT_OPENER` contract. No HTTP route, no close. |
| 3 | **CashSession open** | **COMPLETE (open side only)** | `treasury.controller.ts` contains exactly **one** route: `@Post()` → `openCashSession`, guarded `cash.session.open`. `uq_one_open_session_per_drawer` enforces the one-open invariant. |
| 4 | **Order create** | **COMPLETE** | `sales/orders/orders.controller.ts`; `pos.order.create` |
| 5 | **Pricing / tax** | **COMPLETE** | `PriceResolutionService` + pinned country-pack tax engine; BR-POS-004 snapshots captured at line capture |
| 6 | **Fire** | **COMPLETE** | `POST /orders/{businessDay}/{id}/fire`, `pos.order.fire` (ratified 2026-08-24), publishes `order.line.fired` |
| 7 | **Kitchen routing / ticket persistence** | **COMPLETE** | `RoutingResolverService` (FR-KDS-010 five-tier) + `OrderLineFiredHandler` + `TicketPersistenceService`, transactional, conflict-safe (P1E-5A) |
| 8 | **KDS operator lifecycle** | **NOT IMPLEMENTED** | **No Kitchen controller exists.** `find src -name "*.controller.ts"` returns 12 files, none under `kitchen/`. Tickets are written at Fire and can be read (`TicketReaderService`), but **nothing can move a ticket out of `queued`** — no start, ready, bump, recall, or served operation exists anywhere. |
| 9 | **Payment (partial)** | **COMPLETE** | `SalesPaymentService.capture`, `pos.payment.capture`; P1F-1 |
| 10 | **Full settlement** | **COMPLETE** | P1F-2: `newPaidTotal >= grandTotal` routes to `completeSettling` |
| 11 | **Order Completion** | **COMPLETE** | P1F-2 FINAL ACCEPTED at `bfe7e69`; Order CAS to `completed` as the last mutation |
| 12 | **Inventory depletion** | **COMPLETE for the completion path** | Dual-axis FIFO/FEFO, reserve-first effects, valued allocations |
| 13 | **Posted COGS** | **COMPLETE** | `order_lines.posted_cogs_total` + `orders.cogs_total` from allocation `total_cost` |
| 14 | **Receipt** | **NOT IMPLEMENTED** (and partly governance-blocked — §5) | No receipt controller, service, template, or model anywhere |
| 15 | **CashSession close** | **NOT IMPLEMENTED** | `CashSessionsService` exposes only `open`, `findOne`, `findOpenForDrawer`. The `CashSession` model carries `status` + `closedAt` but **no counted-cash, expected-cash, or variance columns**; **no `CashCount`/denomination model exists**; **no `Approval` model exists at all**. |
| 16 | **Shift close** | **NOT IMPLEMENTED** | See row 2 — only `openShift` exists |
| 17 | **Day close** | **NOT IMPLEMENTED** | No service, no model, no route. Also **hard-blocked** by row 15 per FR-FIN-021 [M]. |
| 18 | **Minimum reports** | **NOT IMPLEMENTED** | No reports controller. No X report (FR-POS-093 [M]), no Z report (FR-FIN-022 [M]), no tender totals (FR-FIN-010 [M]). |

**Net:** the **financial sale path is complete end-to-end** (PIN → session open →
order → fire → kitchen persistence → payment → settlement → completion →
depletion → COGS). Both **kitchen operations** and the **entire closing half of
the cycle** are absent. The operating cycle currently **cannot be closed at all**.

---

## 2. RE-VERIFICATION — WHAT P1F-2 ACTUALLY UNLOCKS

Deliberately *not* calling anything downstream COMPLETE merely because Completion exists.

### 2.1 Direct dependency removed

- **A settled, COMPLETED Order now exists.** Before `bfe7e69`, `order-state.ts`
  had no route to `completed` and `SalesPaymentService` actively threw
  `FullPaymentRequiresCompletionError`. Every downstream concept that presupposes
  a *finished sale* — receipt, session reconciliation, day totals — had **no
  subject to operate on**. That is now removed.
- **Settled tender data is now real.** `orders.paid_total` reaching `grand_total`,
  with `OrderPayment` rows carrying `tender`, `amount`, `roundingAdjustment`,
  `cashSessionId`, `employeeId`, `terminalId`, `tenderedAmount`, `changeGiven`.
- **Posted COGS exists** (`posted_cogs_total`, `cogs_total`), so a Z report's
  cost/margin lines have a truthful source.

### 2.2 Implementation now possible (but NOT implemented)

- **Expected cash is computable for the first time** — `openingFloat` + Σ(cash-tender
  `amount`) per `cashSessionId`. This is precisely what FR-FIN-005 [M] requires as
  the subtrahend of variance, and it is the single most important P1F-2 unlock.
- **Tender totals per session/day** (FR-FIN-010 [M]) are computable from
  `OrderPayment` grouped by `tender`.
- **Receipt *content*** is now derivable (completed order + lines + payments +
  totals + `completedAt`) — though its *fiscal envelope* is not (§5).

### 2.3 Requirement still blocked by unrelated governance/design

- **Fiscal receipt / invoice sequence / invoice templates** — P1C-1's fiscal
  exclusion **stands**, re-affirmed verbatim in the 2026-08-25 P1F-2 register
  entry: *"**P1C-1**'s Fiscal exclusion (no tax documents, invoice templates,
  fiscal submissions or `fiscal.tax_rules`) stands."* P1F-2 did nothing to lift it.
- **FR-FIN-026 [M]** — Day close "SHALL trigger fiscal document finalisation" —
  remains blocked by the same exclusion.
- **Branch-scoped RBAC (D-2)** — still deferred; `MembershipRole.branchId` remains
  an inert column. Unchanged by P1F-2.
- **Refunds / voids / reversals** — explicit P1F-2 NON-GOALS; still absent, so a
  Z report's "refunds" line (FR-FIN-022) has no source.

### 2.4 Functionality still outside MVP

Loyalty/CRM, aggregator settlement (FR-FIN-012 [S]), integrated card terminals
(FR-POS-064), purchasing/PO receipt, production orders, menu engineering and the
wider FR-CST reporting surface. None was touched or unblocked.

**Explicitly NOT unlocked by P1F-2: the KDS operator lifecycle.** It depends on
Fire and ticket persistence (both complete since P1E-5/P1E-6) and has **no
dependency whatsoever on Completion**. It was exactly as implementable before
`bfe7e69` as after. This materially weakens it as a *post-P1F-2 rebase* answer.

---

## 3. NEXT-SLICE CANDIDATES

### A. Receipt / post-completion customer receipt

| Dimension | Assessment |
|---|---|
| **WHY NOW** | Completed orders now exist to print. Genuine operational gap — customers receive nothing. |
| **SRS** | FR-POS-100 [M], FR-POS-101 [M], FR-POS-102 [M], FR-POS-103 [M], FR-POS-104 [S], FR-POS-105 [M]; `pos.reprint.receipt` (SRS-named) |
| **Substrate** | Order/lines/payments/totals/`completedAt` all present. **No** receipt model, template engine, numbering, renderer, or delivery channel. |
| **Dependencies** | Completion ✔. Country-pack tax breakdown ✔. Invoice sequence ✘. Fiscal QR ✘. |
| **Governance/design** | **PARTLY BLOCKED.** FR-POS-100 [M] demands "tax registration number, **invoice sequence**, tax breakdown, and any required **QR code**"; FR-POS-101 [M] demands **template-driven** layout — P1C-1 excludes *invoice templates* and *tax documents* outright. |
| **API** | New receipt route(s) + reprint |
| **DB** | Likely yes (receipt/document record, numbering, reprint log) |
| **Security** | `pos.reprint.receipt` SRS-named; issuing permission not clearly named |
| **Test burden** | Moderate–high (rendering, bilingual, numbering, reprint marking) |
| **MVP value** | High customer-facing value |
| **Risk** | **HIGH — the defining risk is silently fabricating fiscalization.** Producing an "invoice sequence" or QR without governance would manufacture fiscal semantics the register explicitly excludes. |
| **Scope** | Medium–large |
| **Source-decidable?** | **PARTIALLY NOT SOURCE-DECIDABLE.** A *non-fiscal* MVP receipt is decidable; FR-POS-100/101 as literally written are **not**, pending fiscal governance. |

### B. KDS operator lifecycle

| Dimension | Assessment |
|---|---|
| **WHY NOW** | The kitchen cannot mark anything ready; tickets are immortal in `queued`. Largest operational gap in the forward flow. |
| **SRS** | FR-KDS-020/021/022/023/024/025/026/029 [M], FR-KDS-028 [S], FR-KDS-040/041/042 [M] |
| **Substrate** | **Excellent and complete** — see §6. All FR-KDS-040 timestamps and both status enums already exist. |
| **Dependencies** | Fire ✔, routing ✔, ticket persistence ✔. **No dependency on P1F-2.** |
| **Governance/design** | Persistence design closed by P1E-4/P1E-5. **But: the SRS defines NO `kds.*` permission code** — grep over the full SRS returns `cash.*` and `pos.*` codes only. New codes would have to be **invented and ratified**, exactly as `pos.order.fire` required on 2026-08-24. |
| **API** | New **KitchenController** (the module's first) + start/ready/bump/bump-all/recall/served |
| **DB** | **Likely NO migration** — substrate complete |
| **Security** | **Requires governance ratification of new permission codes** |
| **Test burden** | Moderate (state machine, recall window, concurrency on bump) |
| **MVP value** | High operationally; **unblocks no other slice** |
| **Risk** | Low technical risk; **governance step is unavoidable** |
| **Scope** | Medium |
| **Source-decidable?** | Yes for behaviour; **permission codes are NOT source-decidable** |

### C. CashSession / Shift close  ← **SELECTED**

| Dimension | Assessment |
|---|---|
| **WHY NOW** | The direct P1F-2 unlock (§2.2), and the first hard blocker in the closing chain (§4). |
| **SRS** | FR-POS-094 [M], FR-POS-095 [M], FR-POS-096 [M], FR-POS-097 [M], FR-FIN-005 [M], FR-FIN-006 [M], FR-FIN-007 [M], FR-FIN-010 [M] |
| **Substrate** | `CashSession` (status, `closedAt`, `openingFloat`, drawer/shift/employee/branch), `uq_one_open_session_per_drawer`, complete `OrderPayment` attribution. **Missing:** counted/expected/variance columns, denomination counts, blind-count config, adjusting entries. |
| **Dependencies** | **Completion ✔ (hard — supplies settled tender totals).** No fiscal dependency. |
| **Governance/design** | **No blocker found.** All permissions SRS-named. Design gate needed for the open decisions in §7. |
| **API** | `POST .../cash-sessions/{id}/close` (+ X report; + variance approval) |
| **DB** | **YES** — migration required |
| **Security** | `cash.session.close`, `cash.session.close_other`, `cash.variance.approve` — **all SRS-named**; FR-FIN-006 adds a segregation-of-duties rule (approver ≠ session owner) |
| **Test burden** | Moderate–high (variance arithmetic, blind count, immutability, RLS, concurrency) |
| **MVP value** | **Highest** — closes the cycle and unblocks D and E |
| **Risk** | Medium, well-bounded; money-handling correctness is the main care |
| **Scope** | Medium |
| **Source-decidable?** | **Yes** — seven [M] requirements plus named permissions |

### D. Day close

| Dimension | Assessment |
|---|---|
| **WHY NOW** | Cannot be now. |
| **SRS** | FR-FIN-020/021/022/023/024 [M], FR-FIN-025 [S], FR-FIN-026 [M]; `cash.day.close` (SRS-named) |
| **Dependencies** | **HARD-BLOCKED by C** — FR-FIN-021 [M]: *"Day close SHALL be blocked while any cash session remains open, and SHALL list the blocking sessions."* Cannot be satisfied when no session can ever close. |
| **Governance** | **Partly blocked** — FR-FIN-026 [M] requires fiscal document finalisation (P1C-1 excluded) |
| **Other gaps** | FR-FIN-022's Z report needs discounts/refunds/comps/voids — **none implemented** |
| **Verdict** | **Not eligible.** Must follow C, and even then lands partly blocked. |

### E. Minimum operational reports / tender totals

| Dimension | Assessment |
|---|---|
| **WHY NOW** | Tender totals are computable post-P1F-2. |
| **SRS** | FR-POS-093 [M] (X report), FR-FIN-010 [M] (totals by tender), FR-FIN-022 [M] (Z, needs D) |
| **Assessment** | The X report and per-session tender totals are **the same aggregation** the close slice must compute to derive expected cash. Building them separately would duplicate that logic and risk the report and the close disagreeing. |
| **Verdict** | **Fold the X report / tender totals into C**, not a separate slice. Z report follows D. |

### F. Prerequisite slices that repository evidence shows must precede the above

Audited explicitly; **no hidden hard prerequisite blocks C.**

- **Shift close** — `ShiftsService` has only `openShift`. FR-POS-094/096 phrase the
  count and variance as **"Shift close"**, while FR-FIN-005/006/007 attach variance
  and immutability to the **session**. Repository evidence shows CashSession is the
  drawer-money boundary and Shift is the labour boundary. **Their exact coupling is
  a design-gate question for C, not a separate preceding slice** (§7).
- **Branch-scoped RBAC (D-2)** — still deferred; `cash.session.close_other` implies
  cross-operator scope. Tenant-wide permissions remain the accepted MVP posture; a
  narrow gap to state, **not a blocker**.
- **Approval substrate** — **no `Approval` model exists.** FR-FIN-006 [M] requires
  approval for out-of-tolerance variance. Governance repeatedly states *"No approval
  schema is changed."* Whether C introduces a minimal variance-approval record or
  relies on the SRS-named permission + audit is a **design-gate decision**, and is
  the single most likely place C could over-reach.
- **Refunds/voids/comps** — absent; constrains the *Z report*, not C.

---

## 4. DEPENDENCY ORDER TO A USABLE MVP OPERATING CYCLE

```
operator starts work            PIN auth                    ✔ COMPLETE
  ↓
opens POS financial context     Shift open (implicit)       ~ PARTIAL (no route, no close)
                                CashSession open            ✔ COMPLETE
  ↓
creates / fires order           Order create + Fire         ✔ COMPLETE
  ↓
kitchen operates order          routing + ticket persist    ✔ COMPLETE
                                operator lifecycle          ✘ NOT IMPLEMENTED   ← candidate B
  ↓
settles / completes sale        Payment → Completion        ✔ COMPLETE (P1F-2, bfe7e69)
  ↓
customer completion evidence    Receipt                     ✘ NOT IMPLEMENTED   ← candidate A (partly blocked)
  ↓
closes cashier / session        count, variance, close      ✘ NOT IMPLEMENTED   ← candidate C  ★ FIRST HARD DEPENDENCY
  ↓
closes business day             Day close                   ✘ BLOCKED BY C (FR-FIN-021 [M])
  ↓
management minimum totals       X / Z / tender totals       ✘ BLOCKED BY C→D
```

**The FIRST hard dependency is CashSession/Shift close (C).** The distinction that
decides it:

- **B (KDS)** and **A (Receipt)** are missing steps that block **only themselves**.
  Skipping them degrades the cycle but does not prevent any other slice.
- **C is the only missing slice that other slices are *structurally* blocked on** —
  FR-FIN-021 [M] makes it a stated precondition of D, and D is a stated
  precondition of the Z report and therefore of E.

So the shortest path to a closable cycle is **C → D → E**, with **B** and **A**
as independent branches that may be sequenced by operational priority afterwards.

---

## 5. RECEIPT SCOPE DISCIPLINE

Separated as required; **an ordinary MVP receipt is not equated with fiscalization.**

| Concern | Status |
|---|---|
| **Ordinary customer receipt** (items, modifiers, quantities, line/order totals, tax breakdown, tender, change, employee/terminal, timestamp) | **Fully derivable today** from the completed Order. Would be source-decidable **if scoped explicitly as non-fiscal.** |
| **Fiscal / legal receipt document** (tax registration number, **invoice sequence**, mandated QR, country-pack-mandated fields) | **GOVERNANCE-BLOCKED.** P1C-1's fiscal exclusion — *"no tax documents, invoice templates, fiscal submissions or `fiscal.tax_rules`"* — **stands**, re-affirmed in the 2026-08-25 P1F-2 register entry. FR-POS-100 [M] and FR-POS-101 [M] cannot be satisfied as literally written without lifting it. |
| **Reprint** (FR-POS-104 [S]) | Permission `pos.reprint.receipt` is SRS-named; depends on an issued receipt existing first. [S], not [M]. |
| **Immutable completed-sale snapshot** | **Already satisfied** — BR-POS-004 line snapshots, immutable `OrderPayment`, `posted_cogs_total`, `completedAt`, `closedBy`. A receipt would *render* existing immutable facts; it needs no new snapshot substrate. |
| **Offline implications** | FR-OFF-015 permanent client ids are honoured for Orders/Payments. A receipt **number**, if introduced, would need an offline-safe allocation strategy — an unresolved design question, and a further reason not to rush this. |
| **Country-pack / fiscal requirements** | The pinned country pack supplies tax classes/rates/rounding (real, working). It does **not** supply receipt templates, invoice numbering, or QR specs — none exist in the pack model. |

**Conclusion:** Receipt splits cleanly into a **decidable non-fiscal part** and a
**governance-blocked fiscal part**, and FR-POS-100/101 are written such that the
[M] obligations sit largely on the blocked side. Selecting Receipt now would force
either (a) building a receipt that does not satisfy its own [M] requirements, or
(b) inventing fiscal semantics against a standing exclusion. **Both are
unacceptable; Receipt is therefore not the next slice.** If the user wants it
sooner, the correct first step is a **governance decision on non-fiscal MVP
receipt scope**, not an implementation slice.

---

## 6. KDS SCOPE DISCIPLINE — SUBSTRATE vs LIFECYCLE

Persistence substrate and operator lifecycle are **sharply distinct** here, and the
substrate is in unusually good shape.

| SRS | Requirement | Substrate | Operator lifecycle |
|---|---|---|---|
| FR-KDS-020 [M] | Ticket cards with order no., type, items, elapsed time | ✔ self-contained snapshots + `TicketReaderService` | ✘ no read API |
| FR-KDS-021 [M] | Modifiers visually distinguished by kind | ✔ `ticket_line_modifiers.kind` (P1E-5) | ✘ not surfaced |
| FR-KDS-022 [M] | Colour-code by elapsed time vs configurable target | ✔ `routedAt`, `targetReadyAt`, `branch_kds_config` | ✘ not computed/served |
| FR-KDS-023 [M] | Configurable per-station sort orders | ~ ordering data present | ✘ no config surface |
| FR-KDS-024 [M] | Bump item / bump all | ✔ `TicketStatus.bumped`, `TicketLineStatus.bumped`, `bumpedAt` on both | ✘ **no bump operation exists** |
| FR-KDS-025 [M] | Recall most recently bumped, configurable window (default 30 min) | ✔ `recalledAt`, `recallCount`, `branch_kds_config.recall_window_seconds` **default 1800** | ✘ **no recall operation** |
| FR-KDS-026 [M] | Deliberate bump interaction | n/a — **client-side concern** | n/a |
| FR-KDS-028 [S] | Amendments visually distinct | ✔ `ticket_fire_batches` | ✘ not surfaced |
| FR-KDS-029 [M] | Cancelled lines struck through | ✔ `TicketLineStatus.cancelled` + `cancelledAt` | ✘ no cancel propagation |
| FR-KDS-040 [M] | Timestamps: created, routed, first viewed, started, ready, bumped, served | ✔ **all seven present on BOTH `Ticket` and `TicketLine`** | ✘ only `createdAt`/`routedAt` ever written |
| FR-KDS-041 [M] | Prep-time reporting by item/station/hour/employee/order type | ✔ substrate | ✘ no reporting |
| FR-KDS-042 [M] | "Ticket time" = bump − fire; "order time" = last-line-ready − order-open | ✔ substrate (`recallCount` flags non-clean ticket times) | ✘ not computed |

**Assessment.** The substrate is **complete and unusually well-prepared** — every
FR-KDS-040 timestamp column and both lifecycle enums already exist, so a KDS slice
would very likely need **no migration**. That makes B genuinely attractive and a
strong runner-up. What blocks it from being *next* is not technical:

1. **No `kds.*` permission code exists in the SRS.** Grep across the full SRS
   returns only `cash.*` and `pos.*` codes. New codes must be **invented and
   ratified** — an unavoidable governance action, precisely as `pos.order.fire`
   required.
2. **It unblocks nothing.** No other slice depends on it.
3. **It is not a P1F-2 unlock.** It was equally implementable before `bfe7e69`.

---

## 7. TREASURY / CLOSE DISCIPLINE — WHAT EXISTS, AND WHAT IS *NOT* DECIDED

Inspected against actual code and schema; **no close semantics are invented here.**

| Concern | Current repository evidence |
|---|---|
| **Payment attribution** | **COMPLETE.** `OrderPayment` carries `tender`, `amount`, `roundingAdjustment`, `cashSessionId`, `employeeId`, `terminalId`, `tenderedAmount`, `changeGiven`, all trusted (never client-supplied), with tenant-safe and branch-safe FKs (P1D-B/D/E/G, P1F-1A). |
| **Tender totals** | **Computable, not implemented.** No aggregation exists. FR-FIN-010 [M]. |
| **Expected physical cash** | **Computable, not implemented.** `openingFloat` + Σ(cash `amount`). **No pay-in / pay-out / safe-drop model exists**, though the SRS names `cash.payin`, `cash.payout`, `cash.safedrop` — so expected cash is only complete if those are either implemented or explicitly scoped out. |
| **Rounding** | **Correctly separated already** — `roundingAdjustment` is a distinct drawer-reconciliation figure, never part of `paid_total` (BR-FIN-004). Directly reusable. |
| **Employee / shift / drawer / terminal attribution** | **COMPLETE** on both `CashSession` and `OrderPayment`. |
| **One-open-session invariant** | **ENFORCED** — `uq_one_open_session_per_drawer`. |
| **Close / reconcile behaviour** | **ABSENT.** `CashSessionsService` = `open`, `findOne`, `findOpenForDrawer`. Schema has `status` + `closedAt` but **no counted, expected, or variance columns**, and **no denomination/count model** (FR-POS-097 [M]). |
| **Approval dependencies** | **NO `Approval` model exists.** FR-FIN-006 [M] requires reason + approval by `cash.variance.approve`, **who SHALL NOT be the session owner**. Governance repeatedly states *"No approval schema is changed."* |
| **Audit requirements** | Substrate strong — `governance.audit_entries` append-only, hash-chained, RLS-scoped; FR-FIN-007 [M] additionally requires sessions be **immutable once closed**, with corrections as **adjusting entries**. |

### Open questions the design gate must settle (NOT decided here)

1. **Shift close vs CashSession close coupling** — FR-POS-094/096 say *"Shift
   close"*; FR-FIN-005/006/007 attach variance and immutability to the *session*.
   Repository evidence has CashSession as the money boundary and Shift as the
   labour boundary, and a shift may span drawers. **Their exact relationship is
   not settled by the sources reviewed** and must be gated.
2. **Blind count (FR-POS-095 [M] default)** — where the per-branch config lives, and
   how "expected hidden until after entry" is enforced **server-side** rather than
   trusted to the client. This is a genuine internal-control requirement, not UI.
3. **Denomination counting (FR-POS-097 [M])** — new table vs structured JSON; the
   system must compute the total from denominations.
4. **Variance approval (FR-FIN-006 [M])** — minimal approval record vs
   permission + audit only, given no approval schema exists and governance has
   consistently declined to change one. **Most likely over-reach point.**
5. **Pay-in / pay-out / safe-drop** — in or out of scope for expected cash.
6. **FR-FIN-007 adjusting entries** — shape of post-close corrections.

None of these is invented in this report; all are handed to the gate.

---

## 8. PERFORMANCE DEBT — NFR-PERF-006

**Measured (P1F-2, unchanged): p50 ≈ 1195 ms, p95 ≈ 2120 ms against a ≤ 200 ms
target — classified PARTIAL.** Not re-measured here; nothing on the Completion
path has changed since.

**Decision: PRE-PILOT BLOCKER — not the immediate next slice, and not deferrable
to pre-production.**

Reasoning from SRS severity and MVP operating-path impact:

- **Why not the immediate next slice.** It is a **latency** defect, not a
  correctness one. Every correctness property around it is proven: BR-INV-003
  ledger/projection agreement, dual-axis valuation, no lost updates, deadlock
  freedom under lock-order inversion, full rollback on any mandatory-stage failure.
  A 1.2 s median settle is *usable* for a single-terminal pilot; a cycle that can
  **never be closed** is not. Correctness-complete-but-slow ranks below
  functionally-absent on the critical path.
- **Why not merely "deferred optimization".** The measurement is **10× the target**,
  and the root cause is **structural**, not incidental: the controlling design
  mandates three sequential statements per allocation (batching explicitly
  forbidden to keep `balance_after` truthful for BR-INV-003), and `lockLayers` is
  re-acquired per (orderLine, stockItem) triple. Cost therefore scales with order
  size — a 30-line order already measures ~2.1 s p95. Under real concurrent
  load these are **`FOR UPDATE` locks held for the whole transaction**, so latency
  converts directly into lock contention across terminals sharing stock items.
  That is a throughput cliff, and it will not be discovered by single-terminal
  testing.
- **Why pre-pilot specifically.** A pilot with several terminals on one branch is
  exactly the configuration that would expose the contention, and doing so in front
  of a real operator is the worst place to learn it.
- **Identified, not implemented:** group sorted triples by `stockItemId` and acquire
  `lockLayers` once per distinct stock item, maintaining layer state in memory
  across that item's triples. P1F-2 deliberately declined this to avoid mirroring
  DB counter-decrement logic in memory late in an already-verified slice — a
  judgement this report endorses. **No optimization performed here.**

**Recommended sequencing: C (this slice) → NFR-PERF-006 remediation before pilot →
B / A.** If the user prefers, remediation can run as a small parallel slice, since
it touches Inventory only and C touches Treasury/Sales.

---

## 9. NEXT SLICE DECISION

**SLICE NAME**
**P1G-1 — CashSession / Shift Close, Cash Count & Variance** (including the X
report and per-session tender totals, folded in per §3E).

**WHY IT WINS**
1. **The only candidate that unblocks a strict downstream chain.** FR-FIN-021 [M]
   blocks Day close while any session is open; Day close gates the Z report
   (FR-FIN-022 [M]) which gates management totals. A, B and E unblock nothing.
2. **The genuine P1F-2 unlock.** Expected cash — the subtrahend FR-FIN-005 [M]
   requires — became computable **only** when orders started reaching `completed`
   at `bfe7e69`. KDS and Receipt were not enabled by P1F-2 at all.
3. **Zero permission invention.** `cash.session.close`, `cash.session.close_other`
   and `cash.variance.approve` are **named verbatim in the SRS**, satisfying the
   zero-invented-codes discipline with **no governance ratification** — in direct
   contrast to KDS, where no `kds.*` code exists anywhere in the SRS.
4. **No governance blocker.** Unlike Receipt and Day close, nothing in C touches
   P1C-1's standing fiscal exclusion.
5. **Highest financial-integrity value.** Cash is currently entirely unreconciled at
   end of shift — the largest unguarded money surface in the system.
6. **Closes the operating cycle**, which is the stated objective of §4.

**SRS IDs**
FR-POS-093 [M], FR-POS-094 [M], FR-POS-095 [M], FR-POS-096 [M], FR-POS-097 [M],
FR-FIN-005 [M], FR-FIN-006 [M], FR-FIN-007 [M], FR-FIN-010 [M]. Adjacent, not
claimed: FR-FIN-020…023 (Day close, follows), FR-POS-007 [M] (`closed_by`).

**HARD DEPENDENCIES** — all satisfied at `bfe7e69`: Completion/settlement (P1F-2),
`OrderPayment` attribution (P1F-1/P1D-B…G), `CashSession` open + one-open-session
invariant, PIN/employee identity, audit substrate.

**SOFT DEPENDENCIES** — pay-in/pay-out/safe-drop (may be scoped out, must be stated);
branch-scoped RBAC D-2 (still deferred; affects `cash.session.close_other` scope);
refunds/voids (affect the *Z report*, not this slice).

**GOVERNANCE STATUS** — **No blocker.** All permissions SRS-named. No fiscal
dependency. One item needs an explicit gate decision rather than governance: the
FR-FIN-006 approval mechanism, given no approval schema exists and governance has
consistently declined to change one.

**DESIGN GATE NEEDED?** **YES** — to settle the six open questions in §7 before any
implementation prompt is written.

**MIGRATION LIKELY?** **YES** — counted/expected/variance and close-attribution
columns on `CashSession`; a denomination-count representation (FR-POS-097 [M]); a
blind-count config location (FR-POS-095 [M]); possibly an adjusting-entry
representation (FR-FIN-007 [M]) and a variance-approval record. Expected to be
**one Treasury-owned migration (31)**, to be confirmed by the gate.

**WHAT IT UNLOCKS** — Day close (FR-FIN-020…024) becomes implementable for the
first time; Z report and management totals become reachable; the operating cycle
becomes closable; cash accountability and segregation of duties become real; per-
session tender totals (FR-FIN-010) and the X report (FR-POS-093) ship with it.

**WHAT IT DOES NOT SOLVE** — Receipt (still absent, still partly fiscally blocked);
KDS operator lifecycle (still absent); Day close itself (next, and partly blocked
by FR-FIN-026's fiscal trigger); refunds/voids/comps; NFR-PERF-006; branch-scoped
RBAC; the BR-MNU-012 modifier-target completeness blind spot recorded on 2026-08-28.

**RISKS**
1. **Scope creep into Day close** — FR-FIN-020…024 are adjacent and tempting; the
   gate must fence them out.
2. **Inventing approval semantics** (§7 item 4) — the most likely over-reach.
3. **Blind-count enforcement** treated as a UI concern rather than a server-side
   internal control, silently defeating FR-POS-095's stated rationale.
4. **Expected-cash definition drift** if pay-in/pay-out scope is left unstated.
5. **Shift-vs-session coupling** guessed rather than gated (§7 item 1).
6. **Money arithmetic** must reuse the existing exact-bigint minor-unit discipline;
   no floating point.

**RUNNER-UP: B — KDS operator lifecycle.** Genuinely strong: the substrate is
complete, it very likely needs **no migration**, and it is the largest gap in the
forward operating flow. It loses only because it unblocks nothing, was not enabled
by P1F-2, and cannot begin without a governance ratification of invented `kds.*`
permission codes. **It is the recommended slice immediately after C** (or after
NFR-PERF-006 remediation, per §8).

---

## Update to INDEX.md

Appended (see `docs/reports/claude/INDEX.md`).

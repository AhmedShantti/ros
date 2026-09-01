# MINIMUM OPERATIONAL REPORTING — Narrow Acceptance Correction (Completed Overpayment)

| Field | Value |
|---|---|
| **Task / slice name** | MINIMUM OPERATIONAL REPORTING — narrow acceptance correction (completed-overpayment reconciliation) |
| **Report type** | Implementation correction. Not a redesign, not a new slice — a narrow, mechanical fix of one false invariant in the accepted implementation. |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the **ratified** entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (RPT-R1/R2/R3) are the only authorities, together with the already-accepted P1F-2 completion semantics. This report supersedes ONLY the false tender identity recorded in `docs/reports/claude/2026-08-31_MINIMUM-reporting-implementation.md` §9/§11 (`tenderGrandTotal === grossSales + unsettledCapturedTotal`); every other statement in that report stands unmodified. No new governance was invented, sought, or required. |
| **Date** | 2026-08-31 |
| **HEAD** | `38e007b0cd285679fc7fd334aec54d3bf2a8006c` — *feat: complete KDS operator lifecycle* (**unchanged**, verified before and after) |
| **Branch** | `feat/production-spec` |
| **Working tree** | The full, preserved Minimum Reporting implementation (unchanged except the narrow diff in §2 below), plus the pre-existing documentation drift already present before this task. |
| **Task identifier** | MINIMUM-reporting-acceptance-correction |
| **Status** | COMPLETE |
| **Migrations** | **34 — unchanged. No migration created, modified, or required.** |
| **Tests** | Reporting e2e: **61/61** across 9 files (56 pre-existing + 5 new overpayment cases). Unit: **792/792** (58 suites, incl. module-boundaries 45/45, unchanged). Full e2e on a fresh, from-zero scratch database: **1075/1075, 60/60 suites**. |

---

## §0. VERDICT

> # **A — REPORTING ACCEPTANCE CORRECTION CLEAN — READY FOR FINAL ACCEPTANCE**

The false tender identity is corrected by adding one neutral, reconciliation-only field, `tenderTotals.completedExcessCapturedTotal`, derived from already-loaded data with zero new queries and zero change to the existing orders-first query shape. No business/accounting disposition was invented for the excess. No governance was reopened. Full suite is 100% green from a clean scratch database.

---

## §1. THE DEFECT

### 1. What the original implementation assumed

The implementation report's §9/§11 asserted, and `reporting-tender.e2e-spec.ts`'s "tender identity" test checked, that on every reachable state:

```
tenderGrandTotal === grossSales + unsettledCapturedTotal
```

This implicitly assumes a completed order is paid **exactly** its `grandTotal` — no more, no less.

### 2. What P1F-2 already settled, verified directly against `sales-payment.service.ts`

- The completion threshold is `isSettling = newPaidTotal >= order.grandTotal` (§8 "Settlement decision") — **`>=`, never `===`**.
- The only validation on a Payment's amount is `if (input.amountMinor <= 0n) throw new BadRequestException(...)` — there is **no upper bound**, and none relative to the order's remaining balance.
- This rule is **tender-agnostic**: the same `capture()` method and the same settlement check apply to `cash` and `manual_external_card` alike.

So a completed order's `paidTotal` can legitimately exceed its `grandTotal` at this HEAD, through the real, already-accepted Payment/Completion path — no bug, no exploit, an explicitly permitted state.

### 3. Why the old identity is false there

When a completed order's `paidTotal` exceeds `grandTotal`, the excess is captured tender (it lands in `tenderGrandTotal` via the summed `payment.amount`s) but is **not** part of `grossSales` (which sums `grandTotal`, not `paidTotal`) and is **not** part of `unsettledCapturedTotal` (the order is completed, not partially paid). The old two-term identity has no place for it, and is therefore false on this reachable state.

### 4. No business/accounting disposition was invented

No authority (SRS, ratified governance, or accepted design) assigns the excess a classification. It is **not** treated as revenue, net sales, tip, discount, refund, cash rounding, or variance anywhere in this correction.

---

## §2. THE CORRECTION

### New field

```
tenderTotals.completedExcessCapturedTotal
  = Σ max(order.paidTotal - order.grandTotal, 0)
    over completed orders in the report's completed-order population
```

- Reconciliation-only. Lives under `tenderTotals`, **not** `salesSummary` — `grossSales` remains exactly `Σ completed orders.grand_total`, unchanged.
- `unsettledCapturedTotal` is unchanged: captured `Payment.amount` on non-completed payable orders.

### The corrected identity

```
tenderGrandTotal === grossSales + unsettledCapturedTotal + completedExcessCapturedTotal
```

Proven exactly, through the real Payment/Completion path, in every scenario in §4 below.

### Files changed (narrow — nothing outside this list)

```
src/modules/sales/contract/daily-trading-sales.query.ts       -- + completedExcessCapturedTotal field, docblock correction
src/modules/sales/orders/daily-trading-sales.query.service.ts -- + paidTotal to the existing orders select; compute the excess from already-loaded rows
src/modules/reporting/daily-trading-report.service.ts         -- + field on tenderTotals view type + assembly; + one scope.notes entry
src/modules/reporting/reporting.controller.ts                 -- OpenAPI description text updated to document the field
test/reporting-tender.e2e-spec.ts                              -- 2 existing assertions extended to the corrected 3-term identity (both were, and remain, zero-excess cases)
test/reporting-overpayment.e2e-spec.ts                         -- NEW — 5 tests, real Payment/Completion path (§4)
docs/api/openapi.json / docs/api/openapi.yaml                  -- regenerated
```

No migration. No schema change. No permission change. No route added or removed. `docs/governance/GOVERNANCE_DECISION_REGISTER.md` was **not** touched — RPT-R1/R2/R3 are not reopened. The prior design/report files (including `2026-08-31_MINIMUM-reporting-implementation.md`) are preserved unmodified; this report is a **named, narrow supersession** of that report's tender-identity claim only.

### Why this is the smallest correction

`completedExcessCapturedTotal` is computed inside the loop over the SAME `orders.findMany(...)` result the sales query already loads for `grossSales`/`discounts`/`taxTotal` — the only change to that query is adding `paidTotal` to its `select` list. **No new statement, no new query shape, no new index, no migration.** Query count for `facts()` remains fixed at four statements, independent of order/payment/line/session volume.

---

## §3. QUERY SHAPE / PERFORMANCE — RE-VERIFIED

The orders query's predicates (`tenant_id`, `branch_id`, `business_day`) are unchanged; only its `select` list grew by one column. Re-ran `EXPLAIN (ANALYZE, BUFFERS)` as `ros_app` with RLS context set, inside `BEGIN … ROLLBACK`, on a fresh scratch database:

```
Index Scan using orders_2026_08_tenant_id_branch_id_business_day_idx
  on orders_2026_08 orders
  Index Cond: (tenant_id = $1 AND branch_id = $2 AND business_day = $3)
```

Identical access path to the one recorded in the original implementation report. The `order_payments`, `order_lines`, treasury, and organisation query shapes are **completely untouched** by this correction (no seq scan on `sales.order_payments`, unchanged from the prior evidence).

---

## §4. TESTS — DISTINGUISHING OVER-TENDERING FROM OVERPAYMENT

`test/reporting-overpayment.e2e-spec.ts` reproduces every case through the **real** `OrdersService` / `OrderLinesService` / `SalesPaymentService` path (never a direct DB insert), with a real signed-and-activated country pack (cash rounding disabled, to isolate overpayment from rounding entirely):

| Case | Scenario | Result |
|---|---|---|
| **A** (control) | grandTotal 90, `Payment.amount` 90, `tenderedAmount` 100, `changeGiven` 10 | `completedExcessCapturedTotal = 0` — over-**tender** is not overpayment |
| **B** | grandTotal 100, single CASH `Payment.amount` 120, `tenderedAmount` 120 (no change) | Order completes, `paidTotal = 120`; `completedExcessCapturedTotal = 20`; corrected identity holds |
| **C** | grandTotal 100, single MANUAL_EXTERNAL_CARD `Payment.amount` 130 | Order completes; `completedExcessCapturedTotal = 30`; card rounding stays `0` — proves the tender-agnostic P1F-2 rule |
| **D** | grandTotal 100; partial CASH payment 40 (→ `partially_paid`); final CASH payment 70 (→ completes, `paidTotal = 110`) | `completedExcessCapturedTotal = 10`; `unsettledCapturedTotal = 0` |
| **E** (mixed day) | one exact-settlement completed order (50/50), one overpaid completed order (80 grand / 95 card), one partially-paid order (60 grand / 25 cash) | `grossSales = 130`, `unsettledCapturedTotal = 25`, `completedExcessCapturedTotal = 15`, `tenderGrandTotal = 170`; **`tenderGrandTotal === grossSales + unsettledCapturedTotal + completedExcessCapturedTotal`** asserted directly as bigint arithmetic |

All 5/5 pass. Two pre-existing tests in `reporting-tender.e2e-spec.ts` (the 90/100/10 case and the original "tender identity" fixture) were extended to assert `completedExcessCapturedTotal === '0'` and the corrected 3-term identity respectively — both are zero-excess cases, so their pre-existing numeric expectations (`'90'`, `'950'`, etc.) are unchanged.

---

## §5. STATIC / BUILD VERIFICATION (§7 of the correction brief)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **1 pre-existing, unrelated error** (`src/modules/identity/auth/access-token.service.spec.ts:28`, a `jsonwebtoken` type mismatch) — file is untouched by this or the prior Reporting task (confirmed via `git status`/`git log`). **Zero new errors.** |
| `npx eslint` on every file this correction touched (7 files) | **0 errors, 0 warnings** after fixing 47 self-introduced Prettier formatting issues in the one brand-new file (`reporting-overpayment.e2e-spec.ts`) via a **scoped** `eslint --fix` on that single file only — no repo-wide fix, no unrelated formatting drift |
| `npx prisma validate` | Schema valid; unchanged |
| `git diff --check` | Clean — no whitespace errors |
| `npx nest build` | Clean, exit 0 |

---

## §6. REGRESSION VERIFICATION

1. **Overpayment correction tests**: 5/5 (`reporting-overpayment.e2e-spec.ts`).
2. **All reporting e2e** (9 files): **61/61**.
3. **Reporting authorization**: 15/15 (unchanged, re-verified).
4. **Reporting snapshot / RepeatableRead**: 3/3 (unchanged, re-verified).
5. **`module-boundaries.spec.ts`**: **45/45**, unchanged — this correction adds no new cross-module import and no new `KNOWN_DEVIATIONS` key.
6. **OpenAPI**: regenerated; `openapi.e2e-spec.ts` **32/32**, including drift detection in both directions. `docs/api/openapi.json`/`.yaml` diff against the pre-Reporting `HEAD` remains a pure addition of exactly one path/method (89/54 lines) — no other existing path or schema changed.
7. **Full unit suite**: **792/792**, 58 suites.
8. **Clean, from-zero scratch database, full e2e**: new database created on the same Postgres instance the persistent `ros` dev database lives on (never touched); `DATABASE_URL` → `ros_migrator`, `APP_DATABASE_URL` → `ros_app`, both pointed at the scratch DB; `npx prisma migrate deploy` applied **all 34 migrations cleanly from zero**; full `test:e2e` run: **1075/1075 passing, 60/60 suites, exit code 0**; scratch database dropped afterward.

`KNOWN_DEVIATIONS` before this correction: **0 for `reporting->*`** (45/45 module-boundary assertions passing). After: **unchanged — still 0**, same 45/45.

---

## §7. REQUIREMENT CLASSIFICATIONS — UNCHANGED

| Requirement | Status |
|---|---|
| FR-RPT-004 | **COMPLETE** — all prior behaviour re-verified passing |
| FR-RPT-001/002/003/005 | NOT IMPLEMENTED |
| FR-RPT-042 | NOT IMPLEMENTED |
| FR-RPT-043/044 | NOT IMPLEMENTED |
| FR-FIN-010 | PARTIAL |
| §19.3 Cash Reconciliation | PARTIAL |
| Day Close | NOT IMPLEMENTED |

No claim of full Reporting compliance is made by this or any prior artefact in this slice.

---

## §8. WHAT THIS REPORT EXPLICITLY RECORDS

1. The original Reporting design/implementation assumed exact payment on completed orders (`tenderGrandTotal === grossSales + unsettledCapturedTotal`).
2. P1F-2 already allowed `paidTotal > grandTotal` on completion (`isSettling = newPaidTotal >= grandTotal`, no upper bound on a Payment's amount, tender-agnostic).
3. The old tender identity was therefore **false** on a currently reachable state — not a hypothetical future one.
4. **No governance or business/accounting disposition was invented** for the excess; none was required, because the correction stops at a neutral reconciliation term.
5. `completedExcessCapturedTotal` is **reconciliation-only** — no revenue, tax, tip, discount, refund, cash-rounding, or variance classification is inferred, anywhere.
6. The corrected identity was **proven through real Payment/Completion flows** (`test/reporting-overpayment.e2e-spec.ts`), not through direct database fixtures, across cash, card, partial-then-final, and mixed-day scenarios, with over-tendering explicitly distinguished from overpayment (Case A vs. Case B).

---

## §9. FUTURE REVISIT TRIGGER — RECORDED, NOT BROADENED

This correction does **not** manufacture a broader invariant for a future state. The existing acceptance-correction revisit trigger (Discount/Comp/Refund/post-fire-Void/adjusting-entry slices must re-audit the gross population, the `grossSales` formula, `discounts`/`refunds`, the tender-vs-sales identity, and `SETTLED` semantics) is **preserved unchanged** and now explicitly also covers `completedExcessCapturedTotal`'s place in that identity once any of those mechanisms ships.

---

## §10. VERDICT

> # **A — REPORTING ACCEPTANCE CORRECTION CLEAN — READY FOR FINAL ACCEPTANCE**

---

*This report is non-authoritative evidence. The SRS and ratified governance decisions remain authoritative. `2026-08-31_MINIMUM-reporting-implementation.md` and all prior Reporting design/ratification reports are preserved unmodified; this report supersedes ONLY the false tender identity named in §1.*

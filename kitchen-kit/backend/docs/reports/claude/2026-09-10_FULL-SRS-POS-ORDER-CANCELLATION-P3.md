# FULL-SRS-POS-ORDER-CANCELLATION-P3 — Order Cancellation, Backend Implementation

**Report type:** Implementation report
**Authority statement:** This report is non-authoritative evidence of work performed in this
session. The SRS and ratified governance decisions in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority for requirement
status. Where this report states a requirement is COMPLETE/PARTIAL, that is this session's
verified reading, not a governance ratification.
**Date:** 2026-09-10
**HEAD at start:** `5faab9b4c82d16fe560847324b56ac57c2f60ee7`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree at start:** clean except pre-existing untracked prior-session report files
(unrelated to this task; left untouched).
**Task identifier:** FULL-SRS-POS-ORDER-CANCELLATION-P3

---

## 1. Baseline

```
git rev-parse HEAD    -> 5faab9b4c82d16fe560847324b56ac57c2f60ee7
git log -12 --oneline -> 5faab9b docs(reports): record commit hash in PRC-SUPPLIER-FOUNDATION-P1 report
                         f3f9541 feat(procurement): Supplier master, sourcing, and price-list foundation
                         96ab003 docs(reports): record commit hash in P2E report
                         aece939 feat(sales): real service-charge computation from the pinned policy (P2E)
                         c0a14df docs(reports): record commit hash in P2D-CORRECTION report
                         ...
```

### 1.1 Existing cancellation domain support (before this slice)

- `order-state.ts`'s `TRANSITIONS` table already declared `draft/open/held/parked -> cancelled`
  as legal transitions — the state machine has always known the target state, but nothing in
  the codebase ever called `assertTransition(x, 'cancelled')`.
- `OrdersService.transition` is a generic CAS state-mutator; it was never invoked with
  `'cancelled'` by any route.
- **No `POST /orders/:businessDay/:id/cancel` route existed.** `orders.controller.ts`'s own
  docblock explicitly listed cancellation among routes NOT implemented.
- `pos.order.cancel` / `pos.order.cancel_after_production` were **not** declared in
  `sales.permissions.ts` at all (confirmed by grep — zero occurrences before this session).
- Pre-fire void (`OrderLinesService.voidLinePreFire`) and post-fire void
  (`PostFireVoidService.voidPostFire`, POS-FIN-1) were both fully implemented and usable as
  domain building blocks, but neither is reachable from an order-cancellation path.
- Prior reports (`2026-09-03_POS-FIN-1...md` §21, `2026-09-07_SRS-AUDIT-POS-SALES...md`)
  independently confirmed the same root gap: order-cancel is FR-POS-070's fourth, unimplemented
  correction operation, and FR-POS-075's audit obligation for it was consequently unmet because
  the operation did not exist.

### 1.2 Root gap

**No usable controller path reached the already-modelled `cancelled` state**, and no service
implemented BR-POS-003's line-classification/approval logic. This slice closes that gap by
adding one real command (`CancelOrderService`) and one real route
(`POST /orders/:businessDay/:id/cancel`), reusing the existing pre-fire-void field writes and
the existing post-fire-void disposition/inventory mechanics rather than reimplementing either.

---

## 2. Cancellation command / route

```
POST /orders/:businessDay/:id/cancel
```

- Permission: `pos.order.cancel` (new SRS §15.2 code, added verbatim — see §3).
- `@Idempotent()` + mandatory `Idempotency-Key`/`If-Match`, identical convention to every other
  order mutation on this controller.
- Terminal binding enforced via `requireTerminal` (same posture as `voidLine`/`addLine`); no
  cross-branch cancellation is possible because the route reuses the SAME
  `resourceTarget(SALES_ORDER_TARGET_RESOLVER, ...)` `AuthorizationTarget` every sibling order
  route already uses — a cross-tenant/cross-branch order id is invisible under RLS and returns
  404, never 403 or a silent cross-branch mutation.
- Elevated-approval fields (`managerEmployeeCode`/`managerPin`/`approvalRequestId`/
  `approvalDecisionId`) are resolved through the EXISTING `resolveManager` helper — the same
  code path `applyLineDiscount`/`applyOrderDiscount`/`issueRefund` already use.

### Request shape (`CancelOrderDto`, `sales.dto.ts`)

```ts
{
  reasonCodeId: string;                 // REQUIRED
  lineDispositions?: {                  // required only for lines already
    orderLineId: string;                // sent to production; validated
    disposition: 'returned_to_stock' | 'wasted' | 'given_to_staff';
  }[];
  managerEmployeeCode?: string;         // all four required together,
  managerPin?: string;                  // or all four omitted — required
  approvalRequestId?: string;           // in substance only when a
  approvalDecisionId?: string;          // bumped/produced line exists
}
```

### Reason-code behaviour

- `reasonCodeId` is a non-optional `@Matches(UUID_PATTERN)` field — cancellation cannot even be
  attempted without one; missing it is a `400` from the `ValidationPipe`, never a runtime check.
- The existing tenant-scoped adjustment `ReasonCode` model is reused verbatim — **no new
  reason-code table/category was created.**
- `PosReasonCodesService`'s `purpose` vocabulary gained one new value, `order_cancel`, gated by
  `pos.order.cancel` (the same real permission the mutation itself requires) — this was
  necessary because none of the five existing purposes' gating permission is `pos.order.cancel`,
  so an actor holding only that permission could not otherwise reach the POS-safe reason-code
  picker. This is the narrowest possible extension (§9 of the mission): a `purpose` value, not a
  new table, not a new category.
- **Rejected**, specific to cancellation, beyond what sibling write paths (refund/void) already
  check: a `category: 'waste'` reason code is refused with 422 — "a waste-only reason cannot be
  used to cancel an order". This is stricter than the existing refund/pre-fire-void/post-fire-void
  write paths, which do not filter by category at all; recorded here as an intentional,
  cancellation-specific addition, not a retrofit onto the older paths (scope fence: no broad
  Sales refactor).
- Foreign-tenant and nonexistent reason ids are rejected (422) — RLS makes a cross-tenant
  `ReasonCode` row invisible to `findUnique`, so the existing tenant-scoping mechanism is reused
  unchanged.

---

## 3. Permissions

Added to `sales.permissions.ts`, taken **verbatim** from the SRS §15.2 catalogue excerpt quoted
in the POS-FIN-1 design-gate report (`pos.order.cancel "Cancel an entire order"`,
`pos.order.cancel_after_production "Cancel after kitchen production started"`) — the same
zero-invented-codes discipline the file's own docblock already documents:

```
ORDER_CANCEL: 'pos.order.cancel'
ORDER_CANCEL_AFTER_PRODUCTION: 'pos.order.cancel_after_production'
```

Both added to `SALES_PERMISSION_DEFS` (so the tenant onboarding permission-catalog bootstrap
picks them up) and re-exported through `sales/contract`'s existing barrel (already re-exports
`SALES_PERMISSIONS`/`SALES_PERMISSION_DEFS` — no barrel change needed).

**Canonical role templates** (`canonical-role-templates.ts`), mirroring the existing
`pos.order.void_line_prefire` / `pos.order.void_line_postfire` precedent exactly:

- **Cashier** gains `pos.order.cancel` (ordinary-tier, mirrors `void_line_prefire`).
- **Shift Supervisor** gains `pos.order.cancel_after_production` (Manager-or-higher tier,
  mirrors `void_line_postfire` — CLARIFICATION C's "Manager-or-higher authority" bar).
- **Cashier does NOT get `cancel_after_production`** by default, per the mission's explicit
  instruction and consistent with the existing template's treatment of the post-fire-void
  permission.

---

## 4. Eligible order state / payment guard

New `order-state.ts` function `assertMayCancelOrder(orderState, paidTotalMinor)`:

- Delegates to `assertOrderMutable` first — refuses `completed`/`cancelled`/
  `partially_refunded`/`refunded` (BR-POS-001).
- **Additionally** refuses `partially_paid` **and** any state where `paidTotal > 0`,
  independent of the state string — the literal instruction to "use actual current
  payment/order invariants... do not rely only on a stale state string". `paidTotal` is read
  fresh, in the same transaction, immediately before this check.
- `assertTransition(order.state, 'cancelled')` is called right after, so the pre-existing
  `TRANSITIONS` table (`draft/open/held/parked -> cancelled`) remains the single source of
  truth for which STATES may legally reach `cancelled` — this function adds the payment
  invariant on top, it does not duplicate the transition table.

Tested (real Postgres, e2e): a partially-paid order and a completed order both return `422`
on cancel attempt (`test/pos-order-cancellation.e2e-spec.ts` #7/#8).

---

## 5. Line-by-line cancellation semantics

For every `OrderLine` not already `voided`/`comped`:

| Line state | Treatment |
|---|---|
| `pending` (pre-fire) | Field-written `voided` exactly as `voidLinePreFire` does — no inventory effect, no disposition, no kitchen event. |
| `fired`/`preparing` (sent to production, not yet bumped) | Routed through `PostFireVoidService.disposeProducedLine` — the EXACT extracted disposition/inventory mechanics `POST .../void-postfire` already uses. Requires a caller-supplied disposition. No elevated approval required. |
| `ready`/`served` (bumped — BR-POS-003) | SAME disposition path as above, **plus** BR-POS-003's elevated approval gate (§6). |

**No reimplementation.** `PostFireVoidService.voidPostFire` was refactored (not rewritten) to
extract its disposition/inventory/`PostFireVoidRecord`-write logic into a new public method,
`disposeProducedLine(tx, input)`, callable from within an ALREADY-OPEN transaction (Prisma has
no nested interactive transactions, so `CancelOrderService` cannot call the original
`voidPostFire` directly — it calls the extracted core instead, inside its own single
`UnitOfWork.execute`). `voidPostFire`'s own behaviour, response shape, and audit entry are
byte-for-byte unchanged — proven by the pre-existing `pos-financial-corrections.e2e-spec.ts`
suite (44/44 unchanged) after this refactor.

"Bumped" is BR-POS-003's literal distinction, not `isSentToProduction`'s wider one. New
`order-state.ts` function `isBumped(state)` returns true only for `ready`/`served` — the states
`TicketBumpedHandler` (a REAL KDS bump) or a later "served" transition actually produce.
`fired`/`preparing` are sent-to-production but explicitly NOT bumped.

---

## 6. After-production approval — BR-POS-003

- **No produced/bumped line:** caller needs only `pos.order.cancel`.
- **A bumped line exists:** `input.manager` is mandatory; absence is `403` before any write.
  Approval is obtained via the EXISTING `obtainSynchronousApproval` helper
  (`approval-helper.ts`) — the SAME single-phase "verify PIN, create+decide the approval request
  atomically, inside the SAME transaction as the write" shape `applyLineDiscount`/`issueRefund`
  already use. `requiredPermission: SALES_PERMISSIONS.ORDER_CANCEL_AFTER_PRODUCTION` — the
  governance approval runtime itself verifies the approver holds it (`ApproverNotPermittedError`
  -> `403`), proven by e2e test #14 (an approver holding only `pos.discount.approve` is
  rejected).
- **No generic FR-SEC-030 approval engine was built.** Zero new Governance code — this reuses
  `governance/contract`'s pre-existing `APPROVAL_COMMANDS` port exactly as refunds/discounts do.
- **No segregation-of-duties rule was invented** (the mission's explicit instruction) — unlike
  refunds' `excludedApproverUserId`, cancellation does not exclude the applying actor from
  approving their own cancellation; there is no ratified authority requiring that for
  cancellation specifically.
- Approving actor (`approverId`/`approvalId`) is recorded SEPARATELY from applying actor
  (`actorId`) on the one audit entry — proven by e2e test #13.

---

## 7. Post-production disposition

Reused unchanged: `POST_FIRE_VOID_DISPOSITION_COMMAND` (Inventory's public contract) is called
once per produced/fired line via `disposeProducedLine`, exactly as the standalone post-fire-void
route calls it. A `PostFireVoidRecord` row is created per disposed line — same table, same
shape, same "returned_to_stock writes an inert Inventory-owned classification record; wasted/
given_to_staff post the `waste` movement type" semantics already shipped in POS-FIN-1. Produced
food is never silently dropped from inventory/accountability — proven by e2e tests #10 and #13
(a `PostFireVoidRecord` row exists with the exact caller-supplied disposition).

---

## 8. Totals

`recomputeOrderTotals` (the ONE canonical totals path — line-capture, pre-fire void, post-fire
void and POS-FIN-1 discount/comp all already share it) is called exactly once, after every
eligible line has been voided/disposed, and its result is written in the SAME
`tx.order.updateMany` CAS that also sets `state: 'cancelled'`. No monetary column is manually
zeroed. Since `recomputeOrderTotals` already excludes `voided`/`comped` lines from
subtotal/tax/grand-total, and every eligible line ends the transaction `voided`, the cancelled
order's `grandTotal` collapses to `0` — proven directly by e2e tests #1 and #2
(`body.order.grandTotal === '0'`). `serviceChargeTotal`'s P2E computation is exercised
unchanged (it is recomputed from `subtotal`, which is itself `0` post-cancellation) — no P2E
logic was touched.

No payment can be created after a successful cancellation: `assertMayCapturePayment` already
refuses any state other than `open`/`partially_paid`, and `cancelled` was already excluded
before this slice — proven by e2e test #3.

---

## 9. KDS consistency

`CancelOrderService` publishes the EXISTING `order.line.voided_postfire` domain event
(unchanged type/version/payload) once per disposed produced/fired line, inside the same
transaction — the identical contract Kitchen's `OrderLineVoidedPostFireHandler` already
subscribes to for the standalone post-fire-void route. No new Kitchen-side code, no direct
query/mutation of Kitchen's private tables. Proven end to end in the new e2e suite: a real Fire
creates a real `Ticket`/`TicketLine` row, a real bump (`POST /kds/.../bump`) sets the line to
`ready`, and cancellation's disposition write is verified via `admin.postFireVoidRecord` and the
Sales `orderLine.state` transition — the SAME evidence chain `pos-financial-corrections.e2e-spec.ts`
already established for the standalone route, now proven again under cancellation's own
transaction shape.

**No new KNOWN_DEVIATIONS.**

---

## 10. Inventory consistency

Preserved exactly:

- Pre-fire line: no inventory effect (field write only).
- Produced/post-fire line: existing depletion/disposition semantics, reused via
  `disposeProducedLine` — no new stock-reversal rule invented.
- No Sales direct query/update of Inventory private tables — `POST_FIRE_VOID_DISPOSITION_COMMAND`
  is the only Inventory-facing call, unchanged from POS-FIN-1.
- Waste/return records remain attributable (`actorUserId`, `reasonCodeId` on every
  `PostFireVoidRecord`).

---

## 11. Audit — FR-POS-075

Exactly **ONE** order-level audit entry per successful cancellation:
`AUDIT_ACTION.ORDER_CANCELLED` (new verb, added to `audit.constants.ts`), entity `order`,
written in the SAME transaction as every write above. Contains:

- `actorId` — the applying user.
- `approverId`/`approvalId` — populated only when BR-POS-003's elevated approval fired; `null`
  otherwise.
- `reasonCode` — the cancellation reason.
- `before` (-> `beforeState` column) — pre-cancellation `state`, `version`, `subtotal`,
  `discountTotal`, `serviceChargeTotal`, `taxTotal`, `grandTotal`, `paidTotal`, and every line's
  `id`/`state`/`lineTotal`.
- `metadata` (-> `afterState` column) — `amountMinor` (the pre-cancellation `grandTotal`
  snapshot — the defensible "amount removed" figure, since the order is fully voided), per-line
  disposition breakdown, `PostFireVoidRecord` ids, `preFireVoidedLineIds`, and a nested `after`
  object with the post-cancellation `state`/`version`/totals.

This is a genuinely reconstructable before/after snapshot, not `{state: X} -> {state: Y}`.

**Deliberate design decision — ONE entry, not N:** cancellation does NOT additionally write a
per-line `ORDER_LINE_VOIDED_POSTFIRE`-shaped entry for each disposed line (unlike the standalone
post-fire-void route, which legitimately does, since there it IS the single caller action). The
full per-line evidence instead lives inside the one `ORDER_CANCELLED` entry's own metadata. This
mirrors the pre-existing `CASH_MOVEMENT_RECORDED`/`TICKET_BUMPED` "one verb, many instances"
convention documented in `audit.constants.ts`, and satisfies the mission's own explicit "exactly
ONE order-level cancellation audit entry" instruction. Recorded here as an intentional choice,
not an oversight.

**Idempotent retry produces no false/duplicate audit** — proven by e2e test #9: a genuine second
`/cancel` call against an already-cancelled order (fresh `Idempotency-Key`, a stale `If-Match`)
returns `200` with the current order and writes **zero** additional `ORDER_CANCELLED` rows
(`audits` count stays `1`). This check runs BEFORE `assertMayCancelOrder`/`assertTransition`, so
a replay is never mistaken for an illegal-transition error.

**Failed/rejected attempts write no audit at all** — every rejection path (missing reason,
missing disposition, missing/insufficient approval, wrong state) throws before the transaction
reaches the `audit.record` call, so nothing commits (the whole `UnitOfWork.execute` rolls back).

---

## 12. Domain event

**No `order.cancelled` event was added.** No source found in this repository — the SRS §5.5.4
event-catalogue excerpts quoted across the governance register and prior traceability reports —
names an `order.cancelled` event or any subscriber for one (unlike `order.opened`/
`order.completed`, both explicitly named). Inventing one would be exactly the "aesthetic
symmetry with no consumer" the mission instructs against. The one event this slice DOES publish
(`order.line.voided_postfire`, per disposed line) is not new — it already exists and already has
a real Kitchen subscriber; this slice reuses it unchanged.

---

## 13. Idempotency / concurrency

- **Idempotency-Key** (route-level, via `@Idempotent()`): identical convention to every sibling
  mutation — a replay with the same key/body returns the stored original response.
- **Already-cancelled retry** (service-level, independent of the header mechanism above): see
  §11 — a safe no-op, proven by e2e test #9.
- **Cancel vs. concurrent payment**: both paths share the SAME version-CAS pattern every other
  Sales mutation uses (`tx.order.updateMany({where: {..., version: expectedVersion}})`). If a
  payment commits first, cancel's own CAS update returns `count: 0` and throws
  `OrderVersionConflictError` (`409`) — no half-applied cancellation. If cancel commits first,
  the order is `state: 'cancelled'`, and `SalesPaymentService`'s own `assertMayCapturePayment`
  (pre-existing, unchanged) refuses any state other than `open`/`partially_paid` (`422`). No new
  locking primitive was introduced — this is the same convention `refunds.service.ts`/
  `post-fire-void.service.ts` already rely on, applied identically here.
- A losing transaction's line writes (voids, disposition records) roll back atomically with its
  failed order-row CAS, since everything runs inside one `UnitOfWork.execute` /
  `PrismaService.withAuthContext` transaction.

---

## 14. Status

| Requirement | Status | Basis |
|---|---|---|
| **FR-POS-070** | **COMPLETE** | All four correction operations (pre-fire void, post-fire void, order cancel, refund) are now real and reachable. Order cancel uses the per-line correction rules exactly as the requirement's own table specifies (pre-fire: none; post-fire: depletion stands, waste record prompted). |
| **FR-POS-071** | **COMPLETE** (unchanged from before this slice — verified, not re-claimed) | Post-fire void disposition classification remains fully implemented and was regression-proven unchanged (44/44 `pos-financial-corrections.e2e-spec.ts`) after the `disposeProducedLine` extraction. Cancellation reuses it for produced/fired lines without weakening it. |
| **FR-POS-075** | **COMPLETE** | Every void/cancellation/refund operation this repository implements (pre-fire void, post-fire void, refund, and now cancel) writes a full actor/approver/reason/amount/before-after audit entry. The cancellation limb — previously the one gap keeping this requirement PARTIAL per the 2026-09-03 POS-FIN-1 correction report — is now closed and proven (§11, e2e tests #1/#9/#13). |
| **BR-POS-003** | **COMPLETE** | An order with a fired-AND-bumped line cannot reach `cancelled` without a `pos.order.cancel_after_production`-holding approver's synchronous PIN approval and a recorded reason; proven end to end against a REAL KDS bump (e2e tests #12/#13/#14). |

---

## 15. Files changed

**Source:**

- `src/modules/sales/orders/order-state.ts` — added `isBumped`, `assertMayCancelOrder`.
- `src/modules/sales/orders/post-fire-void.service.ts` — extracted `disposeProducedLine` (public
  method) from `voidPostFire`; `voidPostFire`'s own behaviour is unchanged (regression-proven).
- `src/modules/sales/orders/cancel-order.service.ts` — **new.** `CancelOrderService`.
- `src/modules/sales/orders/orders.controller.ts` — new `cancel` route + OpenAPI docs.
- `src/modules/sales/orders/pos-reason-codes.service.ts` — added the `order_cancel` purpose.
- `src/modules/sales/sales.dto.ts` — `CancelOrderLineDispositionDto`, `CancelOrderDto`, added
  `order_cancel` to `POS_REASON_CODE_PURPOSES`.
- `src/modules/sales/sales.permissions.ts` — `ORDER_CANCEL`, `ORDER_CANCEL_AFTER_PRODUCTION`.
- `src/modules/sales/sales.module.ts` — registered `CancelOrderService`.
- `src/modules/governance/audit/audit.constants.ts` — `ORDER_CANCELLED` verb.
- `src/modules/identity/authz/canonical-role-templates.ts` — Cashier gains `pos.order.cancel`;
  Shift Supervisor gains `pos.order.cancel_after_production`.
- `docs/api/openapi.json` / `docs/api/openapi.yaml` — regenerated (`npm run openapi:generate`).

**Tests:**

- `test/pos-order-cancellation.e2e-spec.ts` — **new.** 15 tests, real Postgres, real Fire, real
  KDS bump (via `POST /kds/.../bump`), real approval runtime. See §16.
- `test/sales.e2e-spec.ts` — updated the "public surface matches what can be produced truthfully"
  route whitelist to include the new `/orders/:businessDay/:id/cancel` route (and, while this
  exact assertion was already being touched, corrected a pre-existing, unrelated gap: `/orders/
  reason-codes` — added by an earlier, unrelated slice — had never been added to this same
  assertion; see §17 for why this is pre-existing, not caused by this task).

**No Prisma schema change, no new migration** — every table this slice needed
(`Order`/`OrderLine`/`ReasonCode`/`PostFireVoidRecord`) already existed with sufficient columns.

---

## 16. Tests

### 16.1 New: `test/pos-order-cancellation.e2e-spec.ts` (15/15 passing, real Postgres)

1. Cancels a draft/no-line order — `state='cancelled'`, `grandTotal='0'`, exactly one audit
   entry with correct actor/reason/before/after.
2. Cancels an order with unfired lines — line ends `voided`, no `PostFireVoidRecord`, order
   `grandTotal='0'`.
3. A cancelled order cannot accept a payment afterward (`422`).
4. Missing `reasonCodeId` is `400` (DTO validation).
5. A nonexistent id and a foreign-tenant reason are both rejected (`422`).
6. A waste-only reason cannot be used to cancel an order (`422`).
7. A partially-paid order cannot be cancelled (`422`).
8. A completed order cannot be cancelled (`422`).
9. A retry against an already-cancelled order is a safe no-op — exactly one audit entry total.
10. A fired-but-not-bumped line cancels with ONLY the ordinary permission, given a disposition —
    `PostFireVoidRecord` created with the correct disposition.
11. A produced/fired line missing its required disposition is rejected (`422`).
12. A bumped/produced line + only the ordinary cancel permission is rejected (`403`, BR-POS-003).
13. A bumped/produced line + valid elevated approval succeeds — `PostFireVoidRecord` created,
    audit records `approverId`/`approvalId`, `ApprovalDecision` row is `approved`.
14. An approver holding some OTHER manager-tier permission but not
    `pos.order.cancel_after_production` is rejected (`403`); the line is left untouched.
15. An actor without `pos.order.cancel` gets `403`.

Tests 10/12/13/14 exercise a **real** Fire (`POST /fire`, real Kitchen `Ticket`/`TicketLine`
rows via the existing `OrderLineFiredHandler`) and, for 12/13/14, a **real** bump
(`POST /kds/tickets/:ticketId/lines/:lineId/bump`, real `TicketBumpedHandler` writing
`sales.order_lines.state = 'ready'`) — not a direct-DB-insert shortcut. This is the only honest
way to prove BR-POS-003's "fired AND bumped" distinction.

Not separately tested (documented, not silently skipped): a bespoke cross-branch/cross-tenant
cancellation-fail-closed case. The route reuses the IDENTICAL `AuthorizationTarget`
(`resourceTarget(SALES_ORDER_TARGET_RESOLVER, ...)`) mechanism every other order route already
uses, and that mechanism's fail-closed (404, not 403) behaviour is already proven generically by
the existing `authorization-coverage.spec.ts` (82/82 passing, includes this route in its sweep)
and by RLS invisibility itself — a second bespoke functional test would duplicate existing
coverage rather than add new assurance.

### 16.2 Targeted regression (real Postgres, this session)

| Suite | Result |
|---|---|
| `pos-financial-corrections.e2e-spec.ts` | 44/44 (proves the `disposeProducedLine` extraction changed nothing observable) |
| `pos-order-cancellation.e2e-spec.ts` | 15/15 (new) |
| `sales-lines.e2e-spec.ts` | pass |
| `sales-fire.e2e-spec.ts` | pass |
| `sales-fire-concurrency.e2e-spec.ts` | pass |
| `sales-payment.e2e-spec.ts` | pass |
| `sales-payment-concurrency.e2e-spec.ts` | pass |
| `reporting-sales.e2e-spec.ts` | pass |
| `reporting-cash-reconciliation.e2e-spec.ts` | pass |
| **Combined (9 suites)** | **197/197, exit 0** |
| `sales.e2e-spec.ts` (route-whitelist fix applied) | pass (after the fix in §15) |
| `order-state.spec.ts` (unit) | pass |
| `module-boundaries.spec.ts` (unit) | pass |
| `authorization-coverage.spec.ts` (unit) | pass |
| Combined unit (3 suites) | 82/82, exit 0 |

Full E2E suite was **not** run (deliberate, matching every prior report's THERMAL-RULE-style
posture for a targeted slice — the mission's own §15 scopes this to "targeted only").

---

## 17. A pre-existing, unrelated finding (discovered, not introduced, by this session)

`test/sales.e2e-spec.ts`'s "public surface matches what can be produced truthfully" test also
asserts `expect(paths.filter((p) => p.includes('/tax'))).toHaveLength(0)` against the WHOLE
app's registered routes (not just `/orders`). `src/modules/catalogue/catalogue.controller.ts`'s
`GET /catalogue/branches/:branchId/tax-classes` route (added 2026-09-09, commit `571539b`, per
`git blame`) already matches that substring — `test/sales.e2e-spec.ts` was itself last committed
2026-09-04, before that route existed. This assertion was **already broken on this branch's
baseline**, independent of this session's work (confirmed: no file this session touched is
Catalogue, and the failing line does not reference the `/orders`-scoped `sales` array this
session's own fix updated). Left unfixed — it is a Catalogue-module concern and outside this
task's scope fence ("no broad refactor of Sales"; this is not even Sales). Reported honestly
rather than silently worked around.

---

## 18. Scope fence — held

Not implemented, per the mission's explicit scope fence: new refund architecture, a generic
FR-SEC-030 approval engine, Purchase Orders, combos, tables, CRM, Reporting, tips, FR-POS-058,
frontend. No broad refactor of Sales was performed — every existing file touched received the
smallest change needed to expose the already-existing domain logic through a real route.

---

## 19. Known deviations / honest gaps

- No `order.cancelled` domain event (§12 — a recorded decision, not a gap; no consumer or
  requirement names one).
- The `ORDER_CANCELLED` audit entry does not additionally echo a per-line
  `ORDER_LINE_VOIDED_POSTFIRE`-shaped entry (§11 — a recorded decision, not a gap; the same
  evidence lives in the one entry's metadata).
- §17's pre-existing, unrelated `sales.e2e-spec.ts` `/tax` assertion gap (Catalogue module,
  2026-09-09) — discovered, documented, deliberately left for the owning slice/lane to fix.
- No dedicated cross-branch functional test for `/cancel` specifically (§16.1 — covered by the
  existing generic authorization-coverage mechanism instead of a duplicate bespoke test).

No new `KNOWN_DEVIATIONS.md`-style entry was required — nothing here changes an existing
documented deviation, and no new architectural shortcut was taken.

---

## 20. Commit record

Implementation + tests + regenerated OpenAPI + this report + `INDEX.md` were committed as
`9130e0e1f270ce530744d869066cbf72e22c3d3a` on `full-srs/lane-d4-reporting-demo`. No push, no
merge, no pull.

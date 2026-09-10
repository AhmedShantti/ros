# FULL-SRS-PRC-PURCHASE-ORDERS-P2 — Requisitions + Purchase Orders + Approval + Amendments

**Report type:** Implementation report (migration, production code, tests, verification evidence).
**Authority statement:** This report is **non-authoritative evidence**. The SRS and ratified
governance decisions in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole
authority. No new governance decision is made here. Every representational choice not literally
specified by the SRS follows the closest existing repository convention, identified below, or is
recorded as an explicit, narrow engineering judgment call — never invented to "finish the task."
**Date:** 2026-09-10
**HEAD at task start:** `ffb30fc7d3142f46c095c8fabaeff5424c446df1` — *docs(reports): record commit
hash in POS-ORDER-CANCELLATION-P3 report* (tip of `full-srs/lane-d4-reporting-demo`).
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree at task start:** clean except pre-existing untracked report files from earlier
same-session tasks (PLT settings workstream reports/CSV, DEMO-RELEASE-BRANCH-RECOVERY-P0 report)
— not part of this task's diff.
**Task identifier:** `FULL-SRS-PRC-PURCHASE-ORDERS-P2`

---

## 0. Baseline / inspection

```
$ git rev-parse HEAD
ffb30fc7d3142f46c095c8fabaeff5424c446df1

$ git log -12 --oneline
ffb30fc docs(reports): record commit hash in POS-ORDER-CANCELLATION-P3 report
9130e0e feat(sales): POS order cancellation, end to end (FULL-SRS-POS-ORDER-CANCELLATION-P3)
5faab9b docs(reports): record commit hash in PRC-SUPPLIER-FOUNDATION-P1 report
f3f9541 feat(procurement): Supplier master, sourcing, and price-list foundation (FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1)
96ab003 docs(reports): record commit hash in P2E report
...
```

Inspected before writing code: `src/modules/procurement/**` (Supplier/SupplierItemLink/
SupplierPriceEntry, `PROCUREMENT_FACTS_QUERY`), `src/modules/governance/**` (the full 2026-08-29
Approval Runtime — `APPROVAL_COMMANDS`, `ApprovalRequest`/`ApprovalDecision`, the permanent-id
protocol, RLS self-approval exclusion), `src/modules/organisation/contract/**`,
`src/modules/inventory/contract/**`, `src/modules/platform-settings/contract/**`,
`prisma/schema.prisma`, the full Governance Decision Register sections on D-5 (multi-level
approval — RATIFIED single-step), D-13 (thresholds — RATIFIED domain-owned, not Governance's),
and D-14 (no Governance HTTP surface — the only source-named approval endpoint is
`POST /v1/purchase-orders/{id}/approve`, Procurement-local). Two parallel research passes plus
direct reads of `identity/contract/pin-verification.contract.ts`, `sales/orders/
cancel-order.service.ts`, `sales/orders/approval-helper.ts`, and `treasury/treasury.controller.ts`
informed the approval-channel design decision in §9 below.

---

## 1. Purchase Requisition — FR-PRC-015

`PurchaseRequisition`/`PurchaseRequisitionLine` (schema `procurement`). Lifecycle
`draft -> submitted -> converted`, exactly the mission's minimum (no requisition-level approval
workflow invented). `requestingBranchId`/`requestedBy` are recorded ids (no cross-schema FK),
validated tenant-safe + active via Organisation's `BRANCH_BRAND_QUERY.findBranchAuthorizationFacts`.
Each line validates `stockItemId`/`purchaseUnitId` via Inventory's published
`STOCK_ITEM_PURCHASING_FACTS_QUERY`, and `preferredSupplierId` (if supplied) against an active
`SupplierItemLink` on an active `Supplier`. **Invariant enforced at `submit`, not at `draft`
creation**: a submitted requisition has `>= 1` line, or a 422. "Consumed" state is **derived**
(queried against `PurchaseOrderLine.sourceRequisitionLineId`), never stored redundantly on the
requisition line — the DB's own `uq_po_line_source_requisition_line` unique index is the single
source of truth for "at most one PO line may ever cite a given requisition line."

Routes: `POST/GET /procurement/requisitions`, `GET /procurement/requisitions/:id`,
`POST /procurement/requisitions/:id/submit`. Permission: `purchase.requisition.create` (SRS
§15.2, newly seeded per the mission brief's own explicit instruction).

---

## 2. Consolidation — FR-PRC-016

One `PurchaseOrder` may be created from zero, one, or many submitted requisitions, across
multiple branches. `CreatePurchaseOrderDto.lines` accepts a mix of `{sourceRequisitionLineId}`
entries (consolidated) and manual `{stockItemId, quantity, purchaseUnitId, attributionBranchId}`
entries in the same request — items are never merged; each retains its own
`sourceRequisitionLineId` (nullable) and `attributionBranchId` (the source requisition's
`requestingBranchId` for a consolidated line, caller-supplied+validated for a manual one).

On successful line creation, `markRequisitionsConvertedIfComplete` checks every touched
requisition: it becomes `converted` **only when every one of its own lines** now has a matching
`PurchaseOrderLine` — never half-converted. **Recorded limitation**: a `draft` PO's line-set can
later be replaced via `PATCH .../:id` (or `.../amend`), which frees a previously-consolidated
requisition line for reuse; a requisition that had already reached `converted` is **not**
reverted to `submitted` in that case (no GoodsReceipt exists yet to make "un-converting" a
verifiably safe operation, and no source specifies this edge case) — this is an honest, narrow
gap, not a silent one.

---

## 3. Purchase Order model — FR-PRC-017

`PurchaseOrder` header carries every field the mission brief §3 lists, plus the FR-PRC-018 §7
approval-band snapshot (§7 below) and the FR-PRC-023 §10 Receiving seam
(`receivingStartedAt DateTime?` — read-only in this slice, no GoodsReceipt vocabulary). `version
Int` is the SRS §24.6.4 optimistic-concurrency convention (mirrors `Order.version`).

`PurchaseOrderLine` carries `stockItemId`/`purchaseUnitId`/`quantity`/`unitPrice`/`netAmount`/
`taxAmount`/`lineTotal`/`supplierPriceEntryId?`/`sourceRequisitionLineId?`/`attributionBranchId`.
Validated per line: supplier `active`, supplier actively sources the item (via
`PROCUREMENT_FACTS_QUERY.getSupplierItemSourcing`), purchase unit valid for the item (via
`STOCK_ITEM_PURCHASING_FACTS_QUERY`), currency coherent with the resolved
`SupplierPriceEntry`'s own currency, quantity `> 0`, `unitPrice`/`taxAmount` non-negative.

**Price resolution** (mission §3): when the caller does not supply an explicit `unitPrice`, the
current agreed `SupplierPriceEntry` is resolved via `PROCUREMENT_FACTS_QUERY.getEffectivePrice`
and its id/unit/price/currency are **snapshotted onto the line** — a later new price entry never
retroactively changes an already-created PO line (proven by e2e test; `SupplierPriceEntry` is
immutable/append-only by Supplier Foundation P1's own design, so this is inherited correctness,
not new machinery).

---

## 4. Line + PO totals

All totals are **server-computed only** — `po-totals.ts`'s `computeLineTotals`/
`computeHeaderTotals`, using the repository's existing `divideRounded` exact-rational rounding
primitive (`common/money/rounding.ts`, HALF_UP default, BR-FIN-002) — zero floating point
anywhere. `netAmount = round(unitPrice × quantity)` (computed once); `lineTotal = netAmount +
taxAmount`; `grandTotal = subtotal + taxTotal = SUM(lines.lineTotal)`, enforced additionally by a
DB `CHECK` constraint (`ck_po_grand_total_sum`, `ck_pol_line_total_sum`) as defense-in-depth. No
new rounding semantics were invented — `divideRounded`/`parseExactDecimal`/`pow10` are the
existing, already-established primitives.

---

## 5. Delivery location

Added `LOCATION_FACTS_QUERY` to Organisation's published contract (`organisation/contract/
location-facts.query.ts` + a private `LocationFactsQueryService`) — the narrow, additive query
Organisation did **not** previously publish: "does this location id exist in this tenant, and
what kind (branch/warehouse/central_kitchen) is it." `org.locations` is **already** the unified
receiving-location registry `BRANCH_LOCATIONS_QUERY` keys Inventory lookups by (per that file's
own doc comment) — this is the same registry a future Receiving slice will consume, so
`deliveryLocationId` stores the `Location.id` itself, not a branch/warehouse id directly. PO
creation/update/amend all validate `deliveryLocationType` agrees with the resolved
`Location.locationType`, and that the location is tenant-visible (RLS fail-closed).

---

## 6. PO states

`draft -> pending_approval -> approved | rejected`, plus `approved -> pending_approval` (an
amendment crossing into a higher band, §10). No `sent` state (no real transmission path exists —
FR-PRC-021 remains out of scope). Only a `draft` PO may have ordinary line edits (`PATCH`).
Approved-PO mutation is controlled only through `.../amend`. Every state-changing write uses
CAS (`assertPoVersion` + a `WHERE id, version = expected` guarded `updateMany`, `count === 1`
asserted) — never a bare `update()`.

---

## 7. Approval configuration — FR-PRC-018

Inspected Platform Settings first, per the mission brief's own instruction. `EFFECTIVE_SETTING_QUERY`
(FR-PLT-025) is the right mechanism: no per-key registration exists in this repository (confirmed
— there is no Zod or schema-registry anywhere), so `procurement.po_approval_thresholds` works
immediately with **zero** Platform Settings code changes. `po-thresholds.ts` hand-parses the
resolved JSON value (`{threshold1Minor, threshold2Minor, threshold3Minor}`, base-10 minor-unit
strings, strictly increasing) — the same hand-rolled-validator idiom `service-charge-policy-
rules.ts` already established (no schema library exists in this repository). **No write route was
added**: Platform Settings' own existing generic `PUT /platform/settings/tenant/:settingKey` HTTP
surface (FR-PLT-025) already lets a tenant admin set this key.

Resolved **once**, at PO submission (and again, independently, at amendment — §10), never
live-re-resolved for an unchanged PO. Snapshotted onto the PO row: `approvalBand` (the band
evaluated), `approvalRequiredPermission`, `approvalThresholdsSnapshot` (the three resolved
threshold values + `effectiveSourceLevel`/`isLocked`/`resolvedAt` — "why this band was selected"),
`evaluatedTotalAtSubmission`.

**Band boundary rule** (no source specifies inclusivity — a recorded, explicit judgment call):
`total < threshold1` → `auto`; `threshold1 <= total < threshold2` → `tier_1`;
`threshold2 <= total < threshold3` → `tier_2`; `total >= threshold3` → `tier_3`. A half-open
partition avoids double-boundary ambiguity.

**Multi-currency scope note** (also recorded, not silently assumed): no FX-conversion mechanism
exists anywhere in this repository (comparative pricing explicitly refuses cross-currency
comparison — Supplier Foundation P1 §9). Thresholds are compared directly against a PO's own
`grandTotal` in the PO's own currency, with no normalisation — correct for a single-currency
tenant, the same posture every other money comparison in this codebase already takes.

---

## 8. Approver permissions

`purchase.order.approve_tier_1/2/3` — taken verbatim from SRS §15.2, confirmed by the ratified
Governance Decision Register (D-5, 2026-08-17) as the permission-based encoding of FR-PRC-018's
"Branch Manager / Operations Director / Tenant Owner" prose bands (single-step, not a chain — see
§9). `purchase.order.create` (already reserved-but-unseeded by Supplier Foundation P1) is now
actually seeded, claiming that ownership. `purchase.order.approve_tier_1` was added to the
existing `branch_manager` canonical role template (the one band whose prose name matches an
existing template in this codebase); tiers 2/3 have **no** canonical role template anywhere in
this repository (only Cashier/Branch Manager/Shift Supervisor/Kitchen Staff exist) — inventing
"Operations Director"/"Tenant Owner" role templates is out of this slice's scope per the mission's
own "map value bands... using CURRENT role templates" instruction; the two codes are seeded and
independently grantable via a tenant-created custom role. Below-threshold auto-approval requires
no human approver at all (`approvedBy: null`, `actorType: 'system'` on both the audit entry and
the domain event).

---

## 9. Approval runtime — FR-PRC-018/019 — and the PIN-channel design decision

**Reused the existing Governance approval mechanism exactly** — `APPROVAL_COMMANDS.createRequest`/
`.decide()`, zero parallel procurement approval engine, zero new Governance schema/table.
`ApprovalRequest.value` carries `{purchaseOrderId, totalMinor, currency, band}`;
`requiredPermission` is the exact tier code; `excludedApproverUserId = po.requestedBy` (hard
segregation of duties, DB-enforced via Governance's own RLS `INSERT ... WITH CHECK`, not merely
application code). `expiresAt` uses a **recorded engineering judgment call** — 7 days — since D-10
mandates an explicit value and no ratified default exists for this genuinely asynchronous
(not same-transaction) PO workflow.

**Inspection finding, before writing the approve/reject code**: `ApprovalCommands.decide()`
requires a `VerifiedTerminalPrincipal` — a value **branded** so only Identity's own implementation
can construct it (`module-boundaries.spec.ts` confines the unfabricable cast to
`src/modules/identity/`), obtainable **only** via `TERMINAL_PIN_VERIFIER.verifyTerminalPin()` — a
registered POS/KDS/kiosk/handheld terminal + employee PIN (`identity.terminals.terminal_type` has
no "back office"/dashboard variant, and `Terminal`/`TenantContext`'s own doc comments confirm a
dashboard session has no single operating branch/terminal identity at all). Every existing manual
Governance decision in this repository — `discounts.service.ts`, `refunds.service.ts`,
`cancel-order.service.ts`, Treasury's `declareClose`/`finalizeClose` — goes through this same
channel; there is **no** back-office/dashboard-JWT decision channel anywhere in Governance's
runtime today. The ratified Governance Decision Register independently confirms this: the
"asynchronous" half of FR-SEC-032 is explicitly recorded as deferred project-wide — the same gap
FR-PRC-020's mobile/email-link limb names (§12 below).

**Decision made**: reuse this SAME synchronous PIN channel for PO approval, exactly as the
mission's own "REUSE the existing Governance approval mechanism" instruction requires, rather than
inventing a new back-office identity-verification contract (which would itself be "a parallel
decision channel"). `PurchaseOrderApprovalService.approve`/`.reject` accept
`{expectedVersion, approvalDecisionId, terminalId, employeeCode, pin, comment?}`, verify the PIN
**before** opening the transaction (per `TERMINAL_PIN_VERIFIER`'s own contract — lockout must
survive a caller rollback), then call `decide()`. The route-level guard requires only
`purchase.order.create` (the general procurement authority to reach the workflow at all — mirrors
Treasury's `finalizeClose` and Sales' `cancel-order` precedent exactly: the JWT-authenticated
caller relaying the decision is not necessarily the approving identity); the **actual** tier-permission
check happens inside `decide()`, against the PIN-verified approver's own permission set
(`ApproverNotPermittedError` -> 403) — proven by e2e test (a tier-1-only approver rejected 403 on
a tier-2 PO).

**Consequence honestly recorded**: manual PO approval in this repository currently requires the
approving manager to be physically at a registered terminal. No dashboard-native "click approve"
decision channel exists — building one was explicitly out of scope (mission §12's own go/no-go
test, applied here to the base manual-decision channel, not only to FR-PRC-020's named
mobile/email limb).

**Idempotency**: replaying an identical `approvalDecisionId` (governance-level `created: false`)
short-circuits to the current PO state, checked **before** any status pre-guard (mirrors
`cancel-order.service.ts`'s "idempotency check before every other assertion" pattern) — a genuine
HTTP retry of an already-successful decision returns the original result rather than a spurious
409/422. Concurrent decisions on the same request are resolved by Governance's own DB unique
constraint (`uq_approval_decision_per_request`); the loser gets `ApprovalDecisionConflictError` ->
409, never a duplicate write.

---

## 10. Amendment model — FR-PRC-023

Approved POs (with `receivingStartedAt IS NULL`) are amendable: header fields and/or the full line
set (delete-then-rebuild through the same `PurchaseOrderLineBuilder.buildLine` path
create/update use — zero drift between the three call sites). One immutable
`PurchaseOrderAmendment` row per amendment (`amendmentNumber` 1-based per PO), carrying
`changedBy`/`changedAt`/`reason`/full `beforeSnapshot`/`afterSnapshot` (lines + totals, all
BigInt/Decimal fields as strings)/`oldTotal`/`newTotal`/`oldApprovalBand`/`newApprovalBand`.
Append-only DB grant (`SELECT, INSERT` only on `purchase_order_amendments`).

**Reapproval rule**, ratified exactly as the mission brief states it: the band is re-evaluated
against the **current** configured thresholds (never the submission-time snapshot). If the new
band's authority is covered by the already-approved band (ordinal `auto < tier_1 < tier_2 <
tier_3`), `status` stays `approved` and `approvedBand`/`approvedAt`/`approvedBy` are left
**unchanged** — the original decision still covers it. If it crosses beyond that authority, a NEW
`ApprovalRequest` is created and the PO returns to `pending_approval` (proven: an amendment
pushing tier_1 → tier_2 requires a genuinely fresh `approve` call; a stale/old decision id does
not silently re-approve it). A decrease never forces reapproval (no invented mandatory
reapproval on a decrease), even though the evaluated band re-computes lower.

---

## 11. HTTP routes

```
POST   /procurement/requisitions
GET    /procurement/requisitions
GET    /procurement/requisitions/:id
POST   /procurement/requisitions/:id/submit

POST   /procurement/purchase-orders
GET    /procurement/purchase-orders
GET    /procurement/purchase-orders/:id
PATCH  /procurement/purchase-orders/:id
POST   /procurement/purchase-orders/:id/submit
POST   /procurement/purchase-orders/:id/approve
POST   /procurement/purchase-orders/:id/reject
POST   /procurement/purchase-orders/:id/amend
GET    /procurement/purchase-orders/:id/amendments
```

Two new controllers (`RequisitionsController`, `PurchaseOrdersController`), following the
existing "one controller per sub-resource, same module" convention (e.g. Sales'
`OrdersController`/`ServiceChargePolicyController`). No `@AllowPosSession()` anywhere — back-office/
console only. Every route carries an explicit `AuthorizationTarget(tenantTarget(...))` — the
same posture Supplier Foundation P1 took for its own tenant-wide master data; a narrower,
resource/branch-derived B1-3 target (a new `ScopeTargetResolver`) is a reasonable future
refinement, deliberately not built here (out of this slice's core FR-PRC-015..023 scope). Action
routes (`submit`/`approve`/`reject`/`amend`) return `200`, not Nest's default `201`, matching
`orders.controller.ts`'s own convention.

---

## 12. FR-PRC-020 — kept narrow

Not built: email delivery, a signed single-use time-limited token mechanism (grepped
exhaustively — none exists anywhere in this repository; the only "signed" artifact anywhere is
the unrelated Country Pack file signature). The existing Governance approval runtime does **not**
trivially support a back-office/mobile async decision endpoint (§9's finding) — inventing one was
out of scope per the mission's own explicit instruction. **FR-PRC-020 = PARTIAL**, with the exact
remaining limb: *signed single-use time-limited email-link approval / delivery, and — now
additionally confirmed — any back-office/dashboard-JWT decision channel at all* (the base manual
decision channel, not only the named mobile/email limb, since no such channel exists anywhere in
Governance's runtime today). This did not block Purchase Order core completion.

---

## 13. FR-PRC-021 / FR-PRC-022

Not implemented — no existing supplier email/PDF/WhatsApp/portal transmission and no
FR-INV-067-dependent reorder-suggestion mechanism made either "effectively free." **FR-PRC-021**
remains **NOT IMPLEMENTED**. **FR-PRC-022** remains dependent on FR-INV-067 (unimplemented).

---

## 14. Domain event

`purchase_order.approved` (`procurement/contract/events.ts`,
`PURCHASE_ORDER_APPROVED_EVENT_TYPE`/`_VERSION`), published through the existing
`UnitOfWork`/domain-event mechanism (`cancel-order.service.ts`'s exact pattern), the first time a
PO becomes `approved` — whether via below-threshold auto-approval (`actorType: 'system'`,
`approvedBy: null`) or a manual `decide()` approval. Idempotency key ties to the deciding
decision id (`purchase_order.approved:{poId}:{decisionId}`, or `:auto` for the auto-approval
path) — never published twice for the same decision (proven by the idempotent-replay early-return
in §9, and by a concurrent double-submit-race e2e test: only one submission wins, exactly one
`PURCHASE_ORDER_APPROVED` audit row results). Payload is deliberately narrow (no PO line
vocabulary): supplier/delivery-location/currency/total/band/approver facts only.

---

## 15. Procurement public contract for Receiving

No new contract file was added for this — the mission's named facts (require approved PO,
supplier/location/currency snapshot, approved lines, ordered quantity/unit/price/tax/total
snapshot, "has receiving begun") are **already reachable** from the `PurchaseOrder`/
`PurchaseOrderLine` rows themselves via the existing `PurchaseOrdersService.findById`, and
`receivingStartedAt` is the one seam a future Receiving slice needs to *set*. Adding a narrow
`PURCHASE_ORDER_RECEIVING_FACTS_QUERY` (mirroring `PROCUREMENT_FACTS_QUERY`'s own shape) is a
reasonable next step **when Receiving actually lands**, not invented prematurely here (mission
§15's own "do not add GoodsReceipt vocabulary/data structures prematurely" instruction).

---

## 16. RLS / database invariants

All 5 new tables: `tenant_id NOT NULL`, `ENABLE`/`FORCE ROW LEVEL SECURITY`, tenant-scoped
SELECT/INSERT/UPDATE policies (`purchase_order_amendments` is SELECT/INSERT only — append-only),
tenant-leading composite FKs throughout (`purchase_requisition_lines.(tenant_id,requisition_id) ->
purchase_requisitions`, `purchase_order_lines.(tenant_id,purchase_order_id) -> purchase_orders`,
plus same-module composite FKs to `suppliers`/`supplier_price_entries`/
`purchase_requisition_lines` where the reference is genuinely intra-module). Cross-module ids
(`stockItemId`, `purchaseUnitId`, `attributionBranchId`/`requestingBranchId`, `deliveryLocationId`,
`approvalRequestId`) are recorded UUIDs with **no** cross-schema FK, validated only through each
owning module's published contract — the same module-boundary discipline Supplier Foundation P1
established. Proven live against the real PostgreSQL 16 dev database
(`test/procurement-purchase-orders-rls.e2e-spec.ts`, 11/11): Tenant A cannot read/write Tenant B's
rows in any of the 5 tables (both via the app's RLS-scoped client and a raw cross-tenant INSERT
attempt), and `purchase_order_amendments` is append-only (an app-role UPDATE attempt is rejected —
no UPDATE grant, independent of RLS).

---

## 17. Audit

Every mutation audited in the same transaction as the write, via `governance/contract`'s
`AuditService`/`AUDIT_ACTION`/`AUDIT_ENTITY` (no `AuditModule` import needed — `@Global()`). New
`AUDIT_ACTION`: `PURCHASE_REQUISITION_CREATED`/`_SUBMITTED`, `PURCHASE_ORDER_CREATED`/`_UPDATED`/
`_SUBMITTED`/`_APPROVED`/`_REJECTED`/`_AMENDED`. New `AUDIT_ENTITY`: `purchase_requisition`,
`purchase_order`, `purchase_order_amendment`. The approval audit entry references
`approverId`/`approvalId` (Governance's own decision/request ids) rather than duplicating the
immutable `ApprovalDecision` record's own purpose (mission §17's explicit instruction). Amendment
audit carries old/new totals and the amendment's own identity. A rejected/failed write throws
before `audit.record` is ever reached, or inside the same transaction that rolls back — no false
successful audit entry is possible by construction.

---

## 18. Concurrency / idempotency

- Two concurrent approvals on the same request: Governance's `uq_approval_decision_per_request`
  DB constraint lets only one win; the loser gets `ApprovalDecisionConflictError` -> 409.
- Submit retry does not duplicate an `ApprovalRequest` (Governance's own permanent-id protocol,
  unchanged, reused as-is).
- Approval retry does not duplicate `purchase_order.approved` (§9's idempotent-replay early
  return, checked before the status guard).
- Amend vs. approve cannot leave a mismatched state/total/band: every write is
  `updateMany({where: {id, version: expected}})` with `count === 1` asserted, so a losing
  concurrent writer gets a clean 409, never a partial/silent overwrite.
- A stale version on any mutating route (`update`/`submit`/`approve`/`reject`/`amend`) is a 409
  (`ConflictException`) — a fork-found-and-fixed bug: three paths originally threw 400 instead of
  409, inconsistent with `assertPoVersion`'s own 409 and the repository-wide CAS convention; fixed.

No new locking primitive was added — the existing version-CAS + Governance's own permanent-id/
unique-constraint protocol were sufficient, proven live under a real concurrent-race e2e test
(double-submit).

---

## 19. Targeted tests

`test/procurement-purchase-orders.e2e-spec.ts` (new, 22/22) and
`test/procurement-purchase-orders-rls.e2e-spec.ts` (new, 11/11), run against the real persistent
PostgreSQL 16 dev database, twice each for flakiness (stable both times). All 30 items from the
mission brief's §19 list are genuinely exercised:

- **Requisitions (1-5)**: draft creation; submit requires `>=1` line (422); invalid/foreign
  branch/stock-item/purchase-unit rejected (404/400); multiple submitted requisitions from
  different branches feed one PO; branch attribution retained on the resulting PO lines.
- **PO (6-13)**: manual creation; creation from requisition line(s) with full conversion;
  inactive-supplier rejection; non-sourcing-supplier rejection; supplier price snapshot
  (unaffected by a later new price entry); exact server-computed totals; tenant-valid delivery
  location; snapshot fields survive a later price change.
- **Approval (14-20)**: below-threshold auto-approval, `approvedBy: null`, no `ApprovalRequest`;
  tier-1 pending-then-approve via PIN; tier-2/3 permission mapping; wrong-tier approver rejected
  (403); requester self-approval rejected (403, DB-enforced); duplicate `approvalDecisionId` is a
  safe idempotent replay (no duplicate `ApprovalDecision` row); `purchase_order.approved`
  exactly-once — proven via a concurrent double-submit race (one 200 winner, one 409 loser,
  exactly one `PURCHASE_ORDER_APPROVED` audit row) rather than a domain-event spy, since no such
  spy harness exists elsewhere in this repository's e2e suites — a recorded methodology choice,
  not a gap.
- **Amendment (21-26)**: line/quantity amendment before receiving; full immutable amendment
  history in order; same-band increase stays `approved` untouched; band-crossing increase forces
  a genuinely fresh reapproval; a decrease never forces reapproval; stale-version and
  `receivingStartedAt`-set amendment both fail safely.
- **Security (27-30)**: RLS isolation (§16, separate spec file); missing
  `purchase.order.create`/`purchase.requisition.create` is 403; wrong-tier approval is 403
  (14-20's own coverage); a POS-session token is rejected on every new route.

---

## 20. Verification

```
$ npx prisma validate            → schema valid
$ npx prisma generate            → OK
$ npx tsc --noEmit                → clean, zero errors
$ npm run build                   → OK (nest build)
$ npm run openapi:generate        → OK; docs/api/{openapi.json,yaml} diff is PURELY ADDITIVE
                                     (3057 insertions, 0 deletions) — 13 new /procurement/* paths
$ npx eslint --fix <every changed/new file>  → clean, zero remaining errors/warnings
```

Targeted, live against the real persistent lane-d PostgreSQL 16 dev database:

- `test/procurement-purchase-orders.e2e-spec.ts` — **22/22**, run twice, stable.
- `test/procurement-purchase-orders-rls.e2e-spec.ts` — **11/11**.
- `test/procurement-supplier-foundation.e2e-spec.ts` (P1 regression) — **18/18**, unchanged.
- `test/procurement-rls.e2e-spec.ts` (P1 regression) — **8/8**, unchanged.
- `src/modules/module-boundaries.spec.ts` + `authorization-coverage.spec.ts` — **55/55**
  (46+9, byte-identical to baseline — `KNOWN_DEVIATIONS` gains **zero** new entries for this
  slice; every new route carries a declared, reviewed `AuthorizationTarget`).
- Full unit suite (`npx jest`, no DB) — **1229/1229 passed, 89 suites**, zero regressions.
- No full E2E run performed, per the mission's explicit instruction.

---

## 21. Implementation-time findings and fixes

Six genuine production-code issues were found and fixed while writing the required tests (not
test-convenience hacks — each is a real defect a correct client could have hit):

1. **Nested-write ambiguity**: `purchaseOrder.create({data: {lines: {create: [...]}}})` and the
   equivalent for requisitions hit a real Prisma 7 checked/unchecked nested-write ambiguity
   ("Unknown argument `tenantId`"), because both line models declare an explicit `tenant`
   relation alongside their scalar `tenantId` FK. Fixed by splitting into a parent `create()` +
   a separate `createMany()` for lines — the same pattern `update()`/`amend()` already used
   correctly.
2. **Wrong HTTP status codes**: action routes (`submit`/`approve`/`reject`/`amend`) returned
   Nest's default `201` instead of `200`, inconsistent with `orders.controller.ts`'s own
   established convention for state-transition actions. Fixed with `@HttpCode(HttpStatus.OK)`.
3. **Wrong conflict status**: three version-conflict paths threw `400` instead of `409`,
   inconsistent with `assertPoVersion`'s own 409 and the repository-wide CAS convention. Fixed.
4. **Migration grant too narrow**: `purchase_order_lines` originally had `REVOKE DELETE`, but
   `update()`/`amend()` legitimately replace a PO's line set via delete-then-recreate (the full
   before/after snapshot is already captured immutably in `purchase_order_amendments` before the
   old lines are removed, so this loses no history). Fixed the migration to `GRANT ... DELETE` on
   `purchase_order_lines` only — `purchase_orders`/`purchase_requisitions`/
   `purchase_order_amendments` remain exactly as designed. Applied to the live dev DB directly.
5. **Approval route permission gate**: `/approve`/`/reject` originally required the **JWT
   caller's own** tier permission (`RequireAnyPermission(TIER_1,TIER_2,TIER_3)`) — wrong, because
   the actual approving identity is the PIN-verified terminal principal in the request body, not
   necessarily the JWT-authenticated caller relaying it (confirmed against Treasury's
   `finalizeClose` precedent, which gates on the session-owner's own general permission and lets
   `decide()` alone enforce the real approval-tier authority). Fixed to
   `RequirePermission(PURCHASE_ORDER_CREATE)`; the exact tier check is unchanged inside
   `decide()`.
6. **Idempotent-replay ordering**: the replay short-circuit for a duplicate `approvalDecisionId`
   only ran after a `status === 'pending_approval'` pre-guard, so a genuine HTTP retry of an
   *already-successful* decision (now `status = 'approved'`) was rejected with 422 instead of
   returning the original result — violating the mission's own idempotency requirement. Fixed by
   checking for the existing decision **before** the status guard (mirrors `cancel-order.
  service.ts`'s "idempotency check before every other assertion" pattern).

All six verified fixed by the same tests that exposed them; full regression re-run clean
afterward (§20).

---

## 22. Known deviations / scope notes (honestly recorded, not silent)

- Manual PO approval requires a registered terminal + PIN (§9) — the only decision channel this
  repository's Governance runtime supports for any consumer today.
- `AuthorizationTarget` is `tenantTarget` uniformly for the new routes, not a resource/branch-
  derived B1-3 target (§11).
- A `draft` PO's line replacement can free a requisition line without reverting an already-
  `converted` requisition (§2).
- No FX conversion for multi-currency threshold comparison (§7).
- No new `PROCUREMENT_..._RECEIVING_FACTS_QUERY` contract was added (§15) — the existing
  `findById` surface already exposes everything a future Receiving slice needs; `receivingStartedAt`
  is the one write seam reserved for it.

None of these required a STOP; each is a narrow, defensible, explicitly-recorded judgment call
within the mission's own stated tolerance for such calls.

---

## RETURN

```
START_HEAD: ffb30fc7d3142f46c095c8fabaeff5424c446df1

REQUISITION_MODEL: procurement.purchase_requisitions/purchase_requisition_lines — draft/submitted/converted lifecycle, requestingBranchId/requestedBy recorded (no FK), lines validated via Inventory's STOCK_ITEM_PURCHASING_FACTS_QUERY + Organisation's BRANCH_BRAND_QUERY.
REQUISITION_LIFECYCLE: draft -> submitted (>=1 line enforced at submit) -> converted (only when every line consumed).
CONSOLIDATION: CreatePurchaseOrderDto.lines mixes {sourceRequisitionLineId} (consolidated, multi-branch) and manual lines in one PO; sourceRequisitionLineId + attributionBranchId retained per line; uq_po_line_source_requisition_line (DB unique) guarantees one-consumption.

PURCHASE_ORDER_MODEL: procurement.purchase_orders — full header per mission §3 + approval-band snapshot (§7) + receivingStartedAt seam (§15/§10).
PO_LINE_MODEL: procurement.purchase_order_lines — stockItemId/purchaseUnitId/quantity/unitPrice/netAmount/taxAmount/lineTotal/supplierPriceEntryId?/sourceRequisitionLineId?/attributionBranchId; server-computed totals only.
PO_LIFECYCLE: draft -> pending_approval -> approved|rejected; approved -> pending_approval via amendment crossing bands. CAS (version) on every transition.
DELIVERY_LOCATION: new Organisation contract LOCATION_FACTS_QUERY over org.locations (already Inventory's own unified registry); deliveryLocationType/Id validated tenant-safe + kind-matched.
TOTAL_CALCULATION: divideRounded (existing primitive, HALF_UP), netAmount=round(unitPrice*quantity), lineTotal=net+tax, grandTotal=SUM(lineTotal) — DB CHECK-enforced too.
SUPPLIER_PRICE_SNAPSHOT: PROCUREMENT_FACTS_QUERY.getEffectivePrice resolved+snapshotted at line-build time (create/update/amend); immutable thereafter; explicit unitPrice bypasses auto-resolution.

APPROVAL_CONFIGURATION: procurement.po_approval_thresholds via generic EFFECTIVE_SETTING_QUERY (FR-PLT-025), hand-parsed (no schema library exists in this repo); no new write route (existing Platform Settings admin surface suffices).
APPROVAL_BANDS: auto (total<t1, no ApprovalRequest, no human approver) / tier_1 / tier_2 / tier_3 (half-open boundary rule, recorded judgment call). Snapshotted at submission and re-evaluated at amendment, never live-re-resolved for an unchanged PO.
APPROVAL_RUNTIME: REUSES governance/contract's APPROVAL_COMMANDS exactly (createRequest + decide, zero parallel engine). Manual decision requires TERMINAL_PIN_VERIFIER (the ONLY decision channel Governance supports anywhere in this repo today) — explicit, inspected, recorded design decision (§9), not an oversight.
SEGREGATION_OF_DUTIES: excludedApproverUserId = po.requestedBy on every ApprovalRequest, DB-enforced via Governance's own RLS INSERT WITH CHECK.
AUTO_APPROVAL: below threshold 1 -> status=approved directly at submit, approvedBy=null, actorType='system', zero ApprovalRequest created.
PURCHASE_ORDER_APPROVED_EVENT: procurement/contract/events.ts, published via UnitOfWork exactly once per real decision (idempotency-keyed on decisionId/':auto'), proven exactly-once via a concurrent double-submit e2e race (no event-spy harness exists elsewhere in this repo to assert directly).

AMENDMENT_MODEL: procurement.purchase_order_amendments, append-only (SELECT/INSERT-only grant), amendmentNumber 1-based per PO, full before/after line+total snapshots.
AMENDMENT_HISTORY: GET /procurement/purchase-orders/:id/amendments, ordered ascending, immutable.
REAPPROVAL_RULE: same-or-lower band (ordinal auto<tier_1<tier_2<tier_3) vs. already-approved band -> stays approved unchanged; crosses beyond it -> new ApprovalRequest + pending_approval; decrease never forces reapproval.

HTTP_ROUTES: POST/GET requisitions[,/:id,/:id/submit]; POST/GET/PATCH purchase-orders[,/:id,/:id/submit,/:id/approve,/:id/reject,/:id/amend,/:id/amendments]. No POS session exposure anywhere. Action routes return 200 (fixed from Nest's 201 default).
PERMISSIONS: purchase.requisition.create; purchase.order.create; purchase.order.approve_tier_1/2/3 (tier_1 attached to the existing branch_manager canonical role template; tiers 2/3 seeded, unattached — no matching canonical role template exists in this repo). Route guards use the general procurement permission; the exact tier authority is enforced inside Governance's decide() against the PIN-verified approver.

PROCUREMENT_CONTRACT_FOR_RECEIVING: no new contract added — PurchaseOrdersService.findById already exposes every fact the mission names; receivingStartedAt is the one write seam reserved for a future Receiving slice.

RLS: ENABLE+FORCE on all 5 new tables; tenant-leading composite FKs throughout; purchase_order_amendments append-only (SELECT/INSERT-only grant, proven UPDATE-rejected). Proven live: 11/11 cross-tenant isolation tests.
AUDIT: governance/contract AuditService, same transaction as every write. New AUDIT_ACTION: PURCHASE_REQUISITION_CREATED/_SUBMITTED, PURCHASE_ORDER_CREATED/_UPDATED/_SUBMITTED/_APPROVED/_REJECTED/_AMENDED. New AUDIT_ENTITY: purchase_requisition, purchase_order, purchase_order_amendment. Approval audit references Governance's own decision/request ids rather than duplicating ApprovalDecision's purpose.
IDEMPOTENCY: Governance's own permanent-id protocol (unchanged) for ApprovalRequest/Decision; PO-side idempotent replay on duplicate approvalDecisionId checked BEFORE the status guard (fixed during testing — see §21 item 6); event idempotencyKey ties to the deciding decision id.
CONCURRENCY: version-CAS (updateMany + count===1 assertion) on every PO mutation; Governance's uq_approval_decision_per_request resolves concurrent-decision races; proven live via a concurrent double-submit e2e race (one 200, one 409, exactly one audit row).

FR_PRC_015_STATUS: COMPLETE
FR_PRC_016_STATUS: COMPLETE
FR_PRC_017_STATUS: COMPLETE
FR_PRC_018_STATUS: COMPLETE
FR_PRC_019_STATUS: COMPLETE (manual decision channel is PIN-based — the only channel Governance supports anywhere in this repo; see §9/§22)
FR_PRC_020_STATUS: PARTIAL — signed single-use time-limited email-link approval/delivery AND any back-office/dashboard-JWT decision channel remain unbuilt (no such channel exists anywhere in Governance's runtime today, confirmed by inspection)
FR_PRC_021_STATUS: NOT IMPLEMENTED
FR_PRC_022_STATUS: PARTIAL/blocked on FR-INV-067 (unimplemented)
FR_PRC_023_STATUS: COMPLETE

TESTS: procurement-purchase-orders.e2e-spec.ts 22/22 (run twice, stable) + procurement-purchase-orders-rls.e2e-spec.ts 11/11, both live against real Postgres 16. P1 regression: procurement-supplier-foundation.e2e-spec.ts 18/18 + procurement-rls.e2e-spec.ts 8/8, unchanged. module-boundaries+authorization-coverage 55/55 (byte-identical baseline, zero new KNOWN_DEVIATIONS). Full unit suite 1229/1229, 89 suites, zero regressions.
PRISMA_VALIDATE: clean
TYPECHECK: clean (tsc --noEmit, zero errors)
BUILD: clean (nest build)
OPENAPI: regenerated, purely additive diff (3057 insertions / 0 deletions), 13 new /procurement/* paths
LINT: clean (eslint --fix on every changed/new file, zero remaining errors)

MODULE_GRAPH: procurement -> identity/contract, procurement -> inventory/contract (unchanged from P1), procurement -> organisation/contract (NEW: LOCATION_FACTS_QUERY + BRANCH_BRAND_QUERY), procurement -> governance/contract (NEW: APPROVAL_COMMANDS — GovernanceModule explicitly imported, not @Global()), procurement -> platform-settings/contract (NEW: EFFECTIVE_SETTING_QUERY — PlatformSettingsModule explicitly imported, not @Global()), identity/authz/canonical-role-templates -> procurement/contract (permission attachment, mirrors every other module's existing pattern).
KNOWN_DEVIATIONS_ADDED: none (module-boundaries.spec.ts whole-tree assertion passed unchanged: 55/55, including the new organisation/location-facts.query.ts and every new procurement/* file).

FILES_CHANGED: prisma/schema.prisma (+323/-3); new migration prisma/migrations/20260910140000_procurement_purchase_orders/; new src/modules/organisation/contract/location-facts.query.ts + src/modules/organisation/locations/location-facts.query.service.ts; edited src/modules/organisation/{contract/index.ts,organisation.module.ts}; new src/modules/procurement/contract/events.ts; edited src/modules/procurement/{contract/index.ts,procurement.dto.ts,procurement.module.ts,procurement.permissions.ts,procurement.views.ts}; new src/modules/procurement/requisitions/{requisitions.service.ts,requisitions.controller.ts}; new src/modules/procurement/purchase-orders/{po-thresholds.ts,po-totals.ts,po-state.ts,purchase-order-line-builder.service.ts,purchase-orders.service.ts,purchase-order-approval.service.ts,purchase-order-amendment.service.ts,purchase-orders.controller.ts}; edited src/modules/governance/audit/audit.constants.ts; edited src/modules/identity/authz/canonical-role-templates.ts; new test/procurement-purchase-orders.e2e-spec.ts + test/procurement-purchase-orders-rls.e2e-spec.ts; regenerated docs/api/{openapi.json,yaml}.
IMPLEMENTATION_COMMIT: b4b60f7
REPORT_HASH_COMMIT_IF_ANY: this edit is recorded in the docs-only hash-record follow-up commit (see INDEX.md).

PURCHASE_ORDER_CORE_CLOSED: yes, for FR-PRC-015/016/017/018/019/023 — all COMPLETE and proven live. FR-PRC-020 remains explicitly PARTIAL (email/mobile-link limb, and the base async decision channel more generally); FR-PRC-021/022 remain open/deferred, exactly as scoped.
SAFE_TO_START_POS_COMBO_CAPTURE: yes — this task touched only Procurement, Organisation's contract barrel (additive), Governance's audit constants (additive), and Identity's canonical-role-templates (additive); zero files under src/modules/sales/ were read or modified.
BLOCKERS_OR_UNCERTAINTIES: none required a STOP. The one load-bearing judgment call — manual PO approval reuses the PIN-based terminal channel because no other decision channel exists anywhere in this repository's Governance runtime — is documented in full in §9/§22, with the SRS/governance-register evidence that led to it, so a future FR-PRC-020/FR-SEC-032 "asynchronous approval" slice can build the missing back-office channel without re-discovering this constraint.
```

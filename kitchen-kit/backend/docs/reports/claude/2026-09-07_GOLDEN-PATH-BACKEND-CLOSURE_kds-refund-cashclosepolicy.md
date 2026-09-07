# GOLDEN-PATH-BACKEND-CLOSURE — KDS routing risk, refund role gap, cash-close-policy admin surface

**Report type:** Implementation + verification report
**Task identifier:** GOLDEN-PATH-BACKEND-CLOSURE (DEMO P0)
**Date:** 2026-09-07
**HEAD (base, before this task's changes):** `2c323a497c91efdc67261591a9fc9cb4ccabbaeb`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary (start of task):** `docs/reports/claude/INDEX.md` modified (append-only, prior session); four untracked prior-session report files present and untouched by this task until this entry. Nothing else pending.
**Working tree summary (end of task):** see FILES_CHANGED below. Not committed at the time this report file is written; committed as a separate step per this task's instructions (see BACKEND_COMMIT).

## Authority statement

This report is non-authoritative evidence produced by direct implementation
and verification work in this session. The SRS and ratified governance
decisions remain authoritative. Where this report references audit findings
from `2026-09-06_DEMO-GOLDEN-PATH-AUDIT_consolidated-27-step-audit.md`, that
prior report is itself non-authoritative evidence, re-verified against
current source as part of this task rather than assumed correct.

## Scope discipline

Per the task brief: no re-audit of all 27 steps, no scope broadening beyond
the three named P0 blockers, no full E2E run. All verification below is
either a fast in-process unit test or a targeted e2e spec file, run directly
against a live Postgres instance (`ros-postgres-lane-d`, port 5566) via this
repo's existing per-suite database-isolation harness.

---

## 1. KDS ROUTING ROLLBACK RISK

### Audit finding re-verified

The audit (step 19) states: `RoutingResolverService.resolve` runs inside the
same DB transaction as order-line fire; a miss (no override, no rule match,
no fallback station) throws `RoutingNoDestinationError` and rolls back the
**entire** fire, not just the ticket — flagged as the single riskiest item in
the audit, but explicitly noted there as a *provisioning* risk requiring zero
code change to pass the demo (pre-configure routing rules via the existing
Station Routing UI).

### Trace performed this session

Full call-chain trace of `SalesFireService.fire()` → `UnitOfWork.execute()` →
`PrismaService.withAuthContext()` → Prisma `$transaction()`, and of
`OrderLineFiredHandler.handle()` → `RoutingResolverService.resolve()`:

- The transaction opens **before** routing resolution runs. Routing
  resolution (and every Kitchen `Ticket`/`TicketLine`/`TicketLineModifier`
  write it triggers) executes via `dispatcher.drain(ctx)`, called **inside**
  the same `$transaction` callback, strictly after the Sales-side callback
  returns and strictly before that callback (and therefore the transaction)
  can commit (`src/common/domain-events/unit-of-work.ts:162-194`).
- `RoutingNoDestinationError` is thrown inside
  `routing-resolver.service.ts:117-120`, propagates unmodified through
  `OrderLineFiredHandler.handle()` and `TransactionalDomainEventDispatcher.drain()`
  (verified non-swallowing: `domain-event-dispatcher.spec.ts:148`), and is
  only caught **after** `$transaction` has already rolled back
  (`sales-fire.service.ts:370-375`), purely to translate the error into an
  HTTP 422 — the docblock there states this explicitly.
- No side effect anywhere in the fire/routing path (event emission, cache,
  queue, websocket/gateway push, or a second Prisma connection/transaction)
  occurs outside this one transaction boundary. Event publication
  (`ctx.publishEvent`) only enqueues into an in-memory collector; dispatch to
  handlers happens pre-commit, inside the same `tx`. No gateway/socket code
  exists in the Kitchen module at all — KDS clients poll a plain read query.
- **Conclusion: the architecture is already correct.** Fire and its Kitchen
  consequences are atomic; a routing failure fails the whole Fire closed,
  per the existing architecture, exactly as this task's requirements demand.
  No production code defect was found or needed fixing.

### Existing test coverage found (pre-existing, not added by this task)

`test/sales-fire.e2e-spec.ts` already had single-line-order proofs of this
exact rollback for both failure shapes (`ROUTING_CONFIGURATION_CONFLICT` and
`ROUTING_NO_DESTINATION`), including a zero-Kitchen-Ticket-row assertion.
These predate this task (added in commit `1ed3521`, "feat(pos): implement
transactional order fire").

### Gap identified and closed

No existing test proved the more dangerous shape: a **multi-line** Fire where
one line resolves routing successfully (and would, on its own, produce a
Kitchen write) while a sibling line in the *same* Fire has zero routing
destinations. This is the shape that would actually expose a partial-commit
defect if one existed (a resolvable line's Ticket surviving independently of
its failing sibling). Added exactly one new regression test:

- `test/sales-fire.e2e-spec.ts` — new test in the `routing tiers through the
  REAL Fire producer (§19)` describe block: *"multi-line fire where one line
  resolves and a sibling line has zero routing destinations -> the WHOLE fire
  rolls back, including the line that would have resolved (no partial
  Kitchen write survives)"*. Asserts: 422, unchanged Order state/version,
  both OrderLines still `pending`/unfired, and **zero** `Ticket` rows for the
  order (not just for the failing line).

### Requirements checked against this task's constraints

- Fire never leaves Sales/KDS partially committed: **confirmed, proven by
  new test.**
- Routing failure fails atomically per existing architecture: **confirmed,
  no change made.**
- Kitchen routing validation not weakened: **no validation code touched.**
- No silently invented fallback station: **none added.** The durable
  backlog gap (no admin route for `branchKdsConfig.fallbackStationId`) is
  explicitly OUT of this task's scope and was not touched.
- Existing KDS lifecycle/amendment behavior remains green: **confirmed** —
  see KDS_TESTS below.

---

## 2. REFUND PERMISSION / STAFF ROLE GAP

### Audit finding re-verified

`pos.refund.issue` existed only on the hand-built signup Owner role
(`ALL_PERMISSION_CODES`), absent from all four canonical staff role
templates (`cashier`, `branch_manager`, `shift_supervisor`, `kitchen_staff`
in `src/modules/identity/authz/canonical-role-templates.ts`). No staff-tier
actor could issue a refund even though the refund endpoint and frontend
`RefundDrawer` are fully built and wired.

### Fix implemented

Added exactly one permission to exactly one canonical template:
`SALES_PERMISSIONS.REFUND_ISSUE` added to `CASHIER_PERMISSION_CODES`
(`canonical-role-templates.ts`). `shift_supervisor` spreads
`CASHIER_PERMISSION_CODES`, so it inherits this automatically — no separate
edit needed there. `branch_manager` and `kitchen_staff` are unchanged.

Deliberately **withheld** from Cashier (separation of concerns preserved,
per this task's explicit requirement):
- `pos.refund.different_tender` (refunding to a tender other than the
  original) — a genuinely distinct, separately-checked permission
  (`refunds.service.ts:226-243`).
- `pos.discount.approve` (the reused generic manager-approval permission,
  `refunds.service.ts:277-323` — refunds reuse the SAME
  `DiscountApprovalPolicyVersion.maxAmountWithoutApprovalMinor` dimension
  discounts use; no distinct refund-approve permission exists by design).
- `treasury.cash_session.close_other` (unrelated manager-tier permission,
  confirmed still absent from Cashier).

This means: a Cashier can now **initiate** a refund, but cannot approve one
and cannot redirect it to a different tender — exactly the "issue vs.
approve vs. different-tender vs. manager-only" separation this task required
preserved. `ensureCanonicalRole`'s existing self-heal behavior means any
tenant's pre-existing Cashier role row is reconciled to this new permission
set the next time any employee is assigned that role by name — no migration,
no per-tenant backfill needed.

### Provisioning blockers inspected (per task instruction)

**Reason code availability:** `IssueRefundDto.reasonCodeId` is mandatory and
`refunds.service.ts:245-253` requires a real `ReasonCode` row to exist. No
application code seeds one for a fresh tenant. However, an **existing**
admin surface already covers this with zero code change:
`POST /inventory/reason-codes` (`inventory.controller.ts:509-533`,
permission `inventory.adjust`, which Owner already holds). Its DTO's
`category` field is a free-form string (1-32 chars, `CreateReasonCodeDto` —
`inventory.dto.ts:54-58`), not restricted to `waste`/`adjustment` — the
refund service's existence check does not filter by category at all. **No
code change made or needed here** — this is a one-time pre-demo provisioning
step (Owner calls the existing endpoint once), consistent with this task's
"prefer existing services/admin surfaces, do not insert demo-only hard-coded
DB rows" instruction.

**Approval-policy / default-threshold behavior:** No application code
anywhere creates a `DiscountApprovalPolicyVersion` row, and no admin
endpoint exists to create one. However, the coded default when no policy row
exists is `approvalRequired = true` **unconditionally** (safe, conservative,
already correct — `refunds.service.ts:277-284`). This directly produces the
demo's required flow ("manager approval where required" = always, absent an
explicit policy) with **zero code change needed**. Owner already holds
`pos.discount.approve` via `ALL_PERMISSION_CODES` and can act as the
approving manager for the demo refund without any further change.

### Demo flow achieved

Cashier (now holding `pos.refund.issue`) initiates a same-tender refund with
a reason code created once via the existing Inventory reason-codes endpoint
→ the refund is above the (absent-policy) always-require-approval default →
Owner supplies manager PIN via the existing `resolveManager`/manager-PIN
approval mechanism (already used identically for discounts) → refund
succeeds. No new mechanism was built; only the existing canonical role
template and existing approval plumbing were used, per this task's
instruction.

---

## 3. CASH-CLOSE-POLICY SETUP UNREACHABLE

### Audit finding re-verified

`CashClosePolicyService`/`CashClosePolicyController` already implement a
correctly-guarded `POST /branches/{branchId}/cash-close-policy` (dashboard
token only, `settings.branch.manage`, mandatory `Idempotency-Key`). This
route is **not** itself defective — the audit's finding was that the only
frontend UI calling it was mounted on a POS-scoped screen the backend
correctly always rejects, and separately, that **no read/GET endpoint
existed at all**, so an admin UI (once wired) would have no way to check
current state before deciding whether to create a new version.

### Fix implemented

Added exactly one new route, reusing the existing domain service and
resolver with no duplicated logic:

- **New method** `CashClosePolicyService.getCurrent(tenantId, actorUserId,
  branchId)` — wraps the existing, previously HTTP-unreachable
  `CashClosePolicyResolver.resolve()` (Treasury-private, already used
  internally by `CashSessionCloseService`) in the same
  `PrismaService.withAuthContext` + branch-existence-check pattern `create`
  already uses. No new query/selection logic — delegates entirely to the
  existing resolver.
- **New view mapper** `toResolvedCashClosePolicyView` in
  `treasury.views.ts`, mirroring the existing `toCashClosePolicyView` for
  the resolver's slightly different result shape (no `createdBy`; id field
  is `policyVersionId` there).
- **New route** `GET /branches/{branchId}/cash-close-policy` on the
  existing `CashClosePolicyController`, same guard stack
  (`JwtAuthGuard, TenantContextGuard, PermissionGuard`), same permission
  (`TREASURY_PERMISSIONS.SETTINGS_BRANCH_MANAGE`), **no** `@AllowPosSession`
  (a read of branch administrative configuration is exactly as
  POS-inappropriate as writing it, per the existing route's own rationale).
  Response is `{ policy: <view> | null }` — `null` when no policy has ever
  been configured for the branch (not a 404; the branch itself exists).
  Unknown/cross-tenant branch id still correctly returns 404 (no existence
  oracle, consistent with this repo's `scoped-authorization-matrix`
  precedent).

### Why this does not implement FR-PLT-027

The original controller docblock cited FR-PLT-027 ("settings inspector" —
showing every override LEVEL and which one won, `[S]`, explicitly later-phase
and out of scope per `docs/reconciliation/PHASE_1_SRS_REQUIREMENT_MAP.md:140`)
as the reason no read route existed. That citation does not cover a plain
"what applies to this branch right now" read, which FR-PLT-027 never owned —
the new route returns exactly the single resolved value the write route
already echoes back on create, nothing about override provenance across
levels. The controller docblock was updated to state this distinction
explicitly rather than silently drop the FR-PLT-027 caveat.

### Database-ownership / architecture compliance

`cash-close-policy.db-ownership.spec.ts` (pre-existing, unmodified) still
passes: no direct `tx.branch.*` access was added — `getCurrent` reuses the
same `BRANCH_CURRENCY_QUERY` public contract `create` already uses.

### Acceptance achieved

`POST /branches/{branchId}/cash-close-policy` (unchanged, already correct)
lets an Owner configure a branch's policy from any dashboard-scoped token.
`GET /branches/{branchId}/cash-close-policy` (new) lets a console UI check
current state first. `CashSessionCloseService`'s existing internal
`CashClosePolicyResolver` usage is untouched, so once a policy exists, the
real Cashier close-shift flow no longer 409s for "policy missing" — this was
already true of the write path; the new GET closes the *administrative
reachability* gap, not a close-shift defect.

---

## Addendum — frontend dependency check: Cashier + `settings.branch.read` for the new dine-in table picker

Raised mid-session by the user: the frontend's new dine-in table picker calls
`GET /org/branches/:branchId/tables`, which requires
`ORGANISATION_PERMISSIONS.BRANCH_READ` (`settings.branch.read`,
`organisation.controller.ts:773-786`). The Cashier canonical role does not
hold this. Investigated per the user's explicit instruction not to grant it
automatically unless consistent with the existing SRS/governance role model.

**Finding: do NOT grant.** Recommendation is NO, for three independent
reasons:

1. **`settings.branch.read` is not a narrow code.** It is one undivided
   permission gating Branch identity, Stations, Tables, Operating Hours, and
   Print/Station-routing-rule reads simultaneously (8 separate `@Get` routes
   in `organisation.controller.ts` all share this one code). Granting it to
   Cashier for table reads would also hand Cashier read access to Stations,
   Hours, and routing configuration — a materially broader grant than the
   picker needs, and inconsistent with the fine-grained pattern already used
   for Cashier's existing Catalogue reads (`menu.item.read`/`menu.price.read`/
   `menu.availability.read` are three separate codes, deliberately split).
2. **No governance decision sanctions this.** `settings.branch.read` was
   ratified solely so the §15.3 Auditor role ("read-only everything") could
   be expressed (`GOVERNANCE_DECISION_REGISTER.md:4514-4520`); a later
   ratification (`:7145-7147`) explicitly reaffirms its scope/holder set as
   settled and unchanged. Nothing in the register anticipates or blesses a
   Cashier-facing table-read grant.
3. **The existing golden-path flow never needed it.** Fire's own table
   resolution (`sales-fire.service.ts:190-202`) calls the internal
   `TableDisplayQuery` contract directly, inside the same transaction, with
   no HTTP hop and no permission check on the cashier's own token — a
   Cashier can already attach a `tableId` on order creation
   (`sales.dto.ts:66`, gated only by `pos.order.create`/`pos.order.fire`,
   which Cashier already holds) and have it validated server-side at Fire
   time. The picker's separate `GET .../tables` call is a **genuinely new**
   HTTP capability, not a gap in a previously-working path.

Inventing a new, narrower permission code (e.g. a table-specific read,
mirroring the Catalogue precedent) would be the SRS-consistent way to serve
the picker without over-granting — but per this repository's documented
zero-invented-permission-code discipline (`GOVERNANCE_DECISION_REGISTER.md:7126-7134`),
introducing one requires explicit user/governance ratification, which is out
of this task's scope and was not sought.

**Disposition:** No permission change made. Dine-in table selection via this
new picker remains unavailable to Cashier for now — consistent with the
user's own note that this is not a demo blocker (new orders default to
takeaway; Fire works without a table). This is an open governance question
for the user to resolve, with two concrete options on the table: (a) accept
the broader `settings.branch.read` grant on Cashier, or (b) ratify a new,
narrower table-read permission code and add that instead.

---

## Route contract for frontend integration

```
GET /branches/{branchId}/cash-close-policy

Auth: Bearer <dashboard-scoped JWT> (NOT a POS/PIN token — rejected)
Permission required: settings.branch.manage

200 OK
{
  "policy": null
}
-- or, when configured --
{
  "policy": {
    "id": "uuid",
    "branchId": "uuid",
    "effectiveFrom": "2026-09-07T00:00:00.000Z",
    "countMode": "blind" | "open",
    "varianceToleranceMinorUnits": "750",
    "currency": "EGP",
    "varianceApprovalExpirySeconds": 900,
    "createdAt": "2026-09-07T00:00:00.000Z"
  }
}

404 Not Found — unknown or cross-tenant branchId (no existence oracle)
403 Forbidden — missing settings.branch.manage, or a POS-scoped token
```

`POST /branches/{branchId}/cash-close-policy` is unchanged (pre-existing);
see `docs/api/openapi.json`/`.yaml` (regenerated this session) for its full
contract alongside the new GET.

---

## FILES_CHANGED

- `src/modules/identity/authz/canonical-role-templates.ts` — added
  `SALES_PERMISSIONS.REFUND_ISSUE` to `CASHIER_PERMISSION_CODES`.
- `src/modules/identity/authz/canonical-role-templates.spec.ts` (new) —
  targeted unit regression for the refund-permission separation.
- `src/modules/treasury/cash-close-policy/cash-close-policy.service.ts` —
  added `getCurrent()`.
- `src/modules/treasury/cash-close-policy/cash-close-policy.controller.ts` —
  added `GET :branchId/cash-close-policy`; updated class docblock.
- `src/modules/treasury/treasury.views.ts` — added
  `toResolvedCashClosePolicyView()`.
- `test/cash-close-policy.e2e-spec.ts` — new `describe('GET current policy
  (GOLDEN-PATH-BACKEND-CLOSURE)')` block, 5 tests.
- `test/sales-fire.e2e-spec.ts` — 1 new targeted multi-line rollback
  regression test.
- `docs/api/openapi.json`, `docs/api/openapi.yaml` — regenerated, additive
  only (new GET route + response schema).
- `docs/reports/claude/INDEX.md` — this entry appended.
- This report file (new).

No frontend files were touched (out of scope per task instruction).

## TESTS RUN THIS SESSION (all against a live Postgres instance, port 5566)

| Suite | Result |
|---|---|
| `src/modules/identity/authz/canonical-role-templates.spec.ts` (new) | 5/5 |
| `src/modules/treasury/cash-close-policy/cash-close-policy.db-ownership.spec.ts` | 4/4 |
| `src/modules/kitchen/routing/routing-resolver.service.spec.ts` | pass (part of full unit run) |
| `src/modules/module-boundaries.spec.ts` | pass (part of full unit run) |
| Full unit suite (`npx jest`) | 1153/1155 passed, 2 pre-existing failures in `modules/authorization-coverage.spec.ts`, confirmed present on a clean stash of this branch BEFORE this task's changes (unrelated: `POST /auth/registrations` authorization-coverage allowlist drift from a prior session, not touched by this task) |
| `test/cash-close-policy.e2e-spec.ts` | 32/32 (27 pre-existing + 5 new) |
| `test/sales-fire.e2e-spec.ts` | 34/34 (33 pre-existing + 1 new) |
| `test/pos-financial-corrections.e2e-spec.ts` (refund suite) | 44/44 |
| `test/cash-session-cashier-role.e2e-spec.ts`, `test/cash-session-close.e2e-spec.ts`, `test/day-close.e2e-spec.ts` | 75/75 |
| `test/scoped-authorization-matrix.e2e-spec.ts`, `test/openapi.e2e-spec.ts` | 83/83 |
| `test/kds-amendment`, `kds-authorization`, `kds-concurrency`, `kds-first-viewed`, `kds-operator-lifecycle`, `kitchen-ticket-concurrency`, `kitchen-ticket-persistence`, `routing-config-contract` (8 KDS/routing suites) | 95/95 |

## TYPECHECK / BUILD / OPENAPI

- `npx tsc --noEmit -p .` — clean.
- `npm run build` (`nest build`) — clean.
- `npm run openapi:generate` — regenerated successfully; diff is additive
  only (`docs/api/openapi.json` +113 lines, `docs/api/openapi.yaml` +80
  lines — the new GET route and its response schema; no existing route
  altered).

---

## RETURN BLOCK

```
KDS_AUDIT_FINDING: Fire's routing resolution runs inside the same DB transaction as the Sales-side write; a routing miss (RoutingNoDestinationError) rolls back the ENTIRE fire, not just the ticket — flagged by the audit as the single riskiest golden-path item, but as a provisioning risk (pre-configure routing rules), not a proven code defect.
KDS_ROOT_CAUSE: No code defect found. Full trace of SalesFireService.fire -> UnitOfWork.execute -> PrismaService.withAuthContext -> Prisma $transaction confirms routing resolution and every Kitchen write it triggers execute strictly inside one transaction, pre-commit; RoutingNoDestinationError is thrown inside that transaction and only translated to HTTP 422 AFTER Prisma has already rolled everything back. No side effect (event/cache/queue/socket) occurs outside the transaction boundary.
KDS_FIX: No production code changed — architecture was already correct per this task's own requirements (atomic fail-closed, no weakened validation, no silent fallback station invented).
KDS_TESTS: Added 1 new targeted regression (multi-line fire, one resolving line + one zero-destination sibling -> whole fire rolls back, zero Tickets survive) in test/sales-fire.e2e-spec.ts. Full suite 34/34. Regression: 8 KDS/routing e2e suites 95/95 green (amendment/lifecycle/concurrency/authorization/first-viewed/ticket-persistence/routing-config-contract).

REFUND_ROLE_GAP: pos.refund.issue existed only on the signup Owner role (ALL_PERMISSION_CODES); absent from all 4 canonical staff templates (cashier/branch_manager/shift_supervisor/kitchen_staff) in canonical-role-templates.ts, making the fully-built refund flow unusable by any staff-tier actor.
REFUND_FIX: Added SALES_PERMISSIONS.REFUND_ISSUE to CASHIER_PERMISSION_CODES only. shift_supervisor inherits it via its existing spread of CASHIER_PERMISSION_CODES. branch_manager and kitchen_staff unchanged. pos.refund.different_tender and pos.discount.approve deliberately withheld from Cashier (separation preserved); ensureCanonicalRole's existing self-heal reconciles any pre-existing tenant's Cashier role automatically.
REFUND_PROVISIONING: Reason code: no seed exists, but the EXISTING POST /inventory/reason-codes (inventory.adjust permission, free-form category string) already lets an Owner provision one with zero code change. Approval-policy/default-threshold: no admin endpoint exists to create a DiscountApprovalPolicyVersion, but the coded default when absent is "always requires approval" (safe, already correct) -- Owner already holds pos.discount.approve to act as approver. No code change needed for either gap.
REFUND_TESTS: Added src/modules/identity/authz/canonical-role-templates.spec.ts (5 new unit tests: Cashier has refund.issue, Cashier lacks different_tender/discount.approve/close_other, shift_supervisor inherits issue+approve but not different_tender, branch_manager unchanged, kitchen_staff still exactly kds.operate). test/pos-financial-corrections.e2e-spec.ts (refund suite) 44/44 green, unaffected.

CASH_CLOSE_EXISTING_SERVICE: CashClosePolicyService.create() (write, already correct, already dashboard-reachable) + CashClosePolicyResolver.resolve()/resolveCountMode() (Treasury-private read, previously used only internally by CashSessionCloseService, never HTTP-exposed).
CASH_CLOSE_ROUTE_ADDED: GET /branches/{branchId}/cash-close-policy (new). POST /branches/{branchId}/cash-close-policy is pre-existing and unchanged.
CASH_CLOSE_REQUEST: GET, no body, branchId path param, Bearer dashboard-scoped JWT.
CASH_CLOSE_RESPONSE: 200 { "policy": null } when unconfigured, or { "policy": { id, branchId, effectiveFrom, countMode, varianceToleranceMinorUnits, currency, varianceApprovalExpirySeconds, createdAt } } when configured. 404 for unknown/cross-tenant branch. 403 for missing settings.branch.manage or a POS-scoped token.
CASH_CLOSE_PERMISSION: settings.branch.manage (Owner/appropriate branch manager only), no @AllowPosSession -- identical guard stack to the existing POST. Cashier cannot administer (does not hold settings.branch.manage).
CASH_CLOSE_TESTS: test/cash-close-policy.e2e-spec.ts new describe block, 5 tests (403 without permission, 200+null when unconfigured, 404 unknown branch, 200 with exact created version after POST, 404 cross-tenant). Full suite 32/32 green. Regression: cash-session-cashier-role/cash-session-close/day-close 75/75, scoped-authorization-matrix/openapi 83/83.

OPENAPI: Regenerated (npm run openapi:generate). Diff additive only -- new GET route + response schema; no existing route's contract altered. docs/api/openapi.json (+113 lines), docs/api/openapi.yaml (+80 lines).
FILES_CHANGED: src/modules/identity/authz/canonical-role-templates.ts, src/modules/identity/authz/canonical-role-templates.spec.ts (new), src/modules/treasury/cash-close-policy/cash-close-policy.service.ts, src/modules/treasury/cash-close-policy/cash-close-policy.controller.ts, src/modules/treasury/treasury.views.ts, test/cash-close-policy.e2e-spec.ts, test/sales-fire.e2e-spec.ts, docs/api/openapi.json, docs/api/openapi.yaml, docs/reports/claude/INDEX.md, this report file. No frontend files touched.
TYPECHECK: npx tsc --noEmit -p . -- clean.
BUILD: npm run build (nest build) -- clean.
BACKEND_COMMIT: fix: close backend golden path blockers (see git log for exact SHA; not pushed).
FRONTEND_INTEGRATION_REQUIRED: Wire a console/dashboard page (Finance or Settings, settings.branch.manage-gated) to GET/POST /branches/{branchId}/cash-close-policy so an Owner can see current state before creating a new version (backend contract above is ready; no frontend code was touched by this task). Refund flow needs no frontend change (RefundDrawer already fully wired) but the demo tenant needs one real ReasonCode row provisioned once via POST /inventory/reason-codes before the demo. KDS/routing needs no frontend change; pre-demo runbook step (configure a station-routing-rule per category to be sold) remains as previously documented, unchanged by this task.
SAFE_TO_INTEGRATE: YES.

CASHIER_BRANCH_READ_QUESTION (addendum, raised mid-session): the new frontend dine-in table picker calls GET /org/branches/{branchId}/tables, gated on settings.branch.read, which Cashier does not hold. Investigated and NOT granted: settings.branch.read is one undivided code also covering Stations/Hours/Print-routing reads (not narrow, unlike Cashier's split Catalogue read codes); no governance-register entry sanctions this grant; the existing golden-path Fire flow never needed it (table resolution at Fire time is an internal backend-to-backend contract call, not gated by the cashier's own HTTP permission). Recommend either accepting the broader settings.branch.read grant or ratifying a new narrower table-read permission code (Catalogue-style) — both require an explicit user/governance decision this task did not make. Not a demo blocker per the user's own note (orders default to takeaway; Fire works without a table). No code changed for this item.
```

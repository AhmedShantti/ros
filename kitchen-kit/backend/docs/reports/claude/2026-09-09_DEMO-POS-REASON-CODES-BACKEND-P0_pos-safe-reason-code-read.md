# DEMO-POS-REASON-CODES-BACKEND-P0 — Narrow POS-Safe Reason Code Read

**Report type:** Investigation + implementation (reason-code model trace,
admin-route trace, authority-reuse decision, new POS-scoped read route,
targeted tests, OpenAPI regeneration).

**Authority statement:** This report is non-authoritative evidence. The SRS
(`ROS_SRS_v1.0.pdf`) and ratified governance decisions in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. The
design choices recorded here (reusing each mutation's own real permission as
the read authority instead of inventing `pos.reason_codes.read`; treating
`purpose` as an authorization selector rather than a row filter) are
documented engineering judgment applying the mission's own explicit "the
model genuinely has no distinction and the exposure is equivalent" clause and
`GOVERNANCE_DECISION_REGISTER.md` CLARIFICATION C (post-fire void authority)
— not a new ratification.

**Date:** 2026-09-09

**HEAD at start:** `b10fd074b5287ca0bdfdd1e1b6a83ecbf439397f`
(`b10fd07` — "docs(reports): record backend commit hash in
DEMO-TAX-CLASS-BACKEND-P0 report")

**Branch:** `full-srs/lane-d4-reporting-demo`

**Working tree summary at start:** untracked `.DS_Store` files (unrelated,
untouched) and untracked
`docs/reports/claude/2026-09-08_DEMO-RELEASE-BRANCH-RECOVERY-P0_render-build-break-diagnosis.md`
(prior, unrelated report — untouched). No other changes present before this
task began.

**Task identifier:** `DEMO-POS-REASON-CODES-BACKEND-P0`

---

## 1. Trace of the current reason-code model

### REASON_CODE_STORAGE

ONE table: `inventory.reason_codes` (Prisma `ReasonCode`,
`prisma/schema.prisma:4065-4082`) — `id`, `tenantId`, `category
String @db.VarChar(16)`, `code String @db.VarChar(32)`, `label Json`.
Natural key `(tenantId, category, code)` (D-INV-09). **No `isActive` /
lifecycle field exists anywhere on this model** — confirmed by grepping the
generated Prisma client for any `update`/`delete` call against `reasonCode`
in `src/` (none outside the generated client itself) and by the exact
column-set assertion this session's new e2e suite adds (`test G`, below).

Every Sales-side consumer (`Discount`, `PostFireVoidRecord`, `Refund`) stores
`reasonCodeId: String @map("reason_code_id") @db.Uuid` with **no Prisma
`@relation`** — a plain UUID column, not a DB foreign key (Inventory and
Sales are separate schemas; the existing tenant-scoped RLS + an
application-level existence check is the enforcement, exactly the same
FK-less-but-app-checked pattern `fiscal.tax_classes` uses).

### CURRENT_TAXCLASS-equivalent finding — the model has NO purpose taxonomy

Traced every real caller of `tx.reasonCode.findUnique`:

- `discounts.service.ts`'s `requireReasonCode` (three call sites: line
  discount, order discount, comp)
- `refunds.service.ts` (`issueRefund`)
- `post-fire-void.service.ts` (`voidLinePostFire`)
- `order-lines.service.ts` (pre-fire void, inline)

**None filters or checks `category`** — each only proves the id exists and
is visible to the tenant (RLS). And every real fixture that seeds a
Sales-purpose reason code (`pos-financial-corrections.e2e-spec.ts`,
`sales-lines.e2e-spec.ts`) tags it `category: 'adjustment'` — the identical
category reused across discount, comp, refund AND void tests throughout
`pos-financial-corrections.e2e-spec.ts` (one single `reasonDiscount` id, 30+
call sites, spanning all four mutation types). `category`'s only OTHER
observed value is `'waste'`, used exclusively by `WasteRecord`
(`waste.service.ts`) — never by Sales.

**Conclusion: the model genuinely has no purpose distinction beyond
waste-vs-everything-else**, and Sales mutation validation treats the whole
non-waste pool as one flat, equally-usable set. This is the exact condition
the mission's own permission-reuse clause names ("unless the model genuinely
has no distinction and the exposure is equivalent").

### POS_ACTIONS_REQUIRING_REASON_CODES

Five, not four — the mission's own examples plus one it flagged as
"any other real existing codes found":

| Action | DTO field | Permission | Required? |
|---|---|---|---|
| Pre-fire void (`DELETE .../lines/:lineId`) | `VoidOrderLineDto.reasonCodeId` | `pos.order.void_line_prefire` | **REQUIRED** (`sales.dto.ts:153`, DB `ck_order_line_void_reason`) |
| Discount (`POST .../discount`, line + order) | `ApplyDiscountDto.reasonCodeId` | `pos.discount.apply` | **REQUIRED** (`sales.dto.ts:289`) |
| Comp (`POST .../comp`) | `ApplyCompDto.reasonCodeId` | `pos.comp.apply` | **REQUIRED** (`sales.dto.ts:296`) |
| Post-fire void (`POST .../void-postfire`) | `VoidOrderLinePostFireDto.reasonCodeId` | `pos.order.void_line_postfire` | **REQUIRED** (`sales.dto.ts:309`) |
| Refund (`POST .../refunds`) | `IssueRefundDto.reasonCodeId` | `pos.refund.issue` | **REQUIRED** (`sales.dto.ts:331`) |

All five are `@Matches(UUID_PATTERN) reasonCodeId!: string` — **none
optional**. (B — "merely optional" — applies only to Inventory's OWN
`PostMovementDto`/`DispatchTransferDto.reasonCodeId?`, a distinct,
non-POS, admin-only concern correctly out of this route's scope.)

`pos.order.void_line_postfire` is withheld from Cashier's canonical role
(`canonical-role-templates.ts:85-88`, per `GOVERNANCE_DECISION_REGISTER.md`
CLARIFICATION C — "Manager-or-higher authority") and granted only from
Shift-Supervisor upward — the exact authority split this slice's read
endpoint had to preserve (mission tests C/D).

### CURRENT_MUTATION_VALIDATION

- **Cross-tenant rejected**: YES, already correct. Every `reasonCode.findUnique`
  above runs inside a `withAuthContext({ tenantId })`-scoped transaction;
  `inventory.reason_codes` carries RLS (confirmed by
  `test/inventory-rls.e2e-spec.ts`'s "direct tenant_id" RLS list and by this
  session's own regression run). A foreign-tenant id resolves to `null`,
  which each service already turns into a 422/`UnprocessableEntityException`
  with an explicit message. Re-confirmed as still-passing regression this
  session via `pos-financial-corrections.e2e-spec.ts`'s existing
  `reasonDiscountOtherTenant` case (mission test H's mutation half).
- **Inactive rejected**: N/A — no such concept exists on `ReasonCode`
  anywhere in the schema or the app layer (see REASON_CODE_STORAGE above).
  Not invented here (mission's own "do not duplicate reason-code storage" /
  do-not-invent instructions); documented as a genuine, honest model
  limitation, not silently papered over — see `test G` below.
- **Purpose-valid-for-action**: the model does not distinguish purpose (see
  above), so there is nothing to enforce here beyond existence + tenant
  visibility, both already correct.

**Nothing was missing to fix on the mutation side.** No change was made to
`discounts.service.ts`, `refunds.service.ts`, `post-fire-void.service.ts`, or
`order-lines.service.ts`.

## 2. The admin endpoint — traced, unchanged

`GET /inventory/reason-codes` (`inventory.controller.ts:538-551`):

- **Permission**: `INVENTORY_PERMISSIONS.VIEW` (`inventory.view`) — tenant-wide
  Inventory administration visibility.
- **Scope**: `tenantTarget('Reason codes are a tenant-level registry shared
  by every location.')` — no branch dimension (the model has none).
- **Response shape**: `{ id, category, code, label }` — the FULL admin shape,
  `category` included, no filtering by category (i.e. `waste`-category rows
  ARE returned to an admin, correctly — this is the admin surface).
- **Why POS correctly 403s today**: Cashier's canonical role
  (`CASHIER_PERMISSION_CODES`, `canonical-role-templates.ts:90-102`) does
  **not** include `inventory.view` — deliberately; `INVENTORY_PERMISSIONS.VIEW`
  is Branch-Manager-tier and above only. Independently and more
  fundamentally, `InventoryController` carries **no** `@AllowPosSession()`
  (unlike `OrdersController`, which has it at class level) — a PIN-issued POS
  session is refused by `JwtAuthGuard` itself with 403 *"PIN (POS) sessions
  cannot access dashboard or back-office endpoints"* (FR-SEC-021) BEFORE
  `PermissionGuard`/`inventory.view` is ever evaluated. Two independent
  reasons, both unchanged by this slice.

**This route was not modified.** Verified unchanged behaviour end to end by
this session's own new e2e tests E/F/F2 (below) plus a full regression run of
`test/inventory-rls.e2e-spec.ts`.

## 3. Authority decision

**No new permission was invented.** `AUTHORITY_DECISION`: each of the five
actions' own real permission (table above) authorises the read for that
`purpose` — the SAME code the corresponding mutation already requires.

Because the model genuinely has no purpose-distinguishing data (§1), the
route does **not** filter rows by `purpose`; it uses `purpose` **only** to
select which ONE of the five real permissions must be held for THIS request
— least privilege and forward compatibility (if a future pack or admin
convention starts tagging categories by purpose, the same query shape can
start filtering without a breaking API change), never a blanket read grant.
This is implemented as a TWO-LAYER check, mirroring the established
`assertCloseAuthority` (`cash-session-close.service.ts`) /
refund-different-tender (`refunds.service.ts:227-238`) precedent already in
this codebase:

1. **Route-level (coarse)**: `@RequireAnyPermission(pos.discount.apply,
   pos.comp.apply, pos.refund.issue, pos.order.void_line_prefire,
   pos.order.void_line_postfire)` — proves the actor holds AT LEAST ONE.
2. **Service-level (precise, in-transaction)**: `PosReasonCodesService`
   injects the published `SCOPE_AUTHORIZATION` port
   (`identity/contract`'s `ScopeAuthorizationPort` — the SAME primitive
   `PermissionGuard` itself uses) and re-checks the ONE specific permission
   `purpose` names, at `{ type: 'tenant' }` scope (ReasonCode carries no
   branch). An actor holding only `pos.comp.apply` who requests
   `purpose=refund` therefore still gets 403, even though — today — the row
   set returned would have been identical; this is a deliberate,
   least-privilege choice, not an accident of the data model (proven by new
   test **B2**).

`category: 'waste'` rows ARE excluded from every POS purpose's response (but
NOT from the untouched admin route) — a pure READ-side narrowing (never more
permissive than any mutation already accepts) justified because waste is
genuinely Inventory-only vocabulary ("Spoiled / discarded") that has no
business appearing on a refund/void/discount/comp picker. This is documented
explicitly in `pos-reason-codes.service.ts`'s own header comment.

### NEW_POS_ROUTE

`GET /orders/reason-codes?purpose=<purpose>` — added to `OrdersController`
(already `@AllowPosSession()` at class level, already the exact guard chain
every other POS mutation on this controller uses), NOT a new `/pos/*`
controller: `ReasonCode` is already consumed directly via Prisma from four
existing Sales services with zero Inventory module import (a plain
cross-schema Prisma read, not a cross-module dependency under SRS §5.2.3 —
`module-boundaries.spec.ts` was re-run and confirms no new deviation), so
adding this alongside the mutations that already own this concern is the
narrowest fit; a standalone controller/module would have added indirection
for no boundary benefit.

### PURPOSES

`discount | comp | refund | void_prefire | void_postfire` — required, exact
`@IsIn` enum (`PosReasonCodesQueryDto.purpose`, `sales.dto.ts`). Omitting it,
or sending an unrecognised value, is a 400 (never a silent default) —
verified by two new tests.

### POS_RESPONSE_SHAPE

```json
[{ "id": "<uuid>", "code": "MGR_DISC_...", "label": { "en": "Manager discount" } }]
```

Exactly `id` (the value to send back as `reasonCodeId`), `code`, `label` —
**no** `category`, **no** `tenantId`, **no** other admin/Inventory metadata.
Verified as an exact key-set assertion in the new suite (test A).

### POS_SCOPE

Tenant-scoped, matching the admin route exactly — `ReasonCode` carries no
`branch_id`, so there is no branch dimension to derive from the terminal/POS
session. Tenant isolation itself IS enforced (RLS + `withAuthContext`,
proven by test H) — "branch/tenant context from the authenticated
terminal/POS session" here means the session's OWN `tenantId` (already how
every other route on this controller resolves it), not a branch filter that
does not exist in the data model.

## 4. Mutation validation — proven unchanged, not touched

No code in `discounts.service.ts`, `refunds.service.ts`,
`post-fire-void.service.ts`, or `order-lines.service.ts` was modified.
`MUTATION_VALIDATION_FIX`: **none needed** — §1's trace found cross-tenant
rejection already correct and no purpose/inactive concept to enforce.
Regression-proven this session by a full, unmodified re-run of
`pos-financial-corrections.e2e-spec.ts` (44/44 — mission test **I**) and
`sales-lines.e2e-spec.ts` (54/54, run together with `inventory-rls.e2e-spec.ts`).

## 5. Targeted tests

New suite: `test/pos-reason-codes.e2e-spec.ts` (14 tests, all passing).
Deliberately lean — no country pack, no catalogue/pricing, no cash session
bootstrap, because this route touches only `inventory.reason_codes` and the
caller's own scoped authorization.

| Mission test | Covered by |
|---|---|
| A. Cashier (`pos.refund.issue`) can list refund reasons | `A.` — plus exact POS-safe shape assertion and waste-exclusion |
| — | `A2.` — same actor, discount/comp/void_prefire purposes (each its own real permission) |
| B. actor lacking refund permission cannot list refund reasons | `B1.` (holds none of the five → 403, route-level gate) and `B2.` (holds comp only → 200 for `purpose=comp`, 403 for `purpose=refund` — proves the PER-PURPOSE check, not just the coarse gate) |
| C. Shift-Supervisor-shaped actor can list void (post-fire) reasons | `C.` |
| D. Cashier without post-fire void cannot gain that read | `D.` |
| E. POS session cannot call `GET /inventory/reason-codes` | `E.` — asserts 403 with the FR-SEC-021 message |
| F. admin Inventory route remains unchanged | `F.` (full admin shape incl. `category` and waste rows) and `F2.` (dashboard actor without `inventory.view` still refused) |
| G. inactive reason code excluded/rejected | **N/A, proven honestly rather than skipped** — `G.` asserts the exact persisted column set has no `isActive`/lifecycle field, and that every existing reason code is therefore always eligible (nothing to exclude on) |
| H. cross-tenant reason code cannot be used | `H.` (new read endpoint never returns another tenant's row) — mutation half already covered by `pos-financial-corrections.e2e-spec.ts`'s pre-existing `reasonDiscountOtherTenant` case, re-run as regression |
| I. refund/void/comp mutation still enforces its own action permission | Regression: `pos-financial-corrections.e2e-spec.ts` 44/44, unmodified |
| — | Two extra: `purpose` omitted → 400; unrecognised `purpose` → 400 |

### Regression runs (this session, against the changed tree)

- `test/pos-reason-codes.e2e-spec.ts` — **14/14 passed** (new).
- `test/pos-financial-corrections.e2e-spec.ts` — **44/44 passed** (unmodified;
  mission tests H-mutation-half/I).
- `test/inventory-rls.e2e-spec.ts` + `test/sales-lines.e2e-spec.ts` (run
  together) — **54/54 passed**.
- `src/modules/module-boundaries.spec.ts` — **46/46 passed** (no new
  cross-module deviation).
- `src/modules/authorization-coverage.spec.ts` — **9/9 passed** (the new
  route is correctly declared, not caught as undeclared/unprotected).
- `canonical-role-templates.spec.ts` + `permission.guard.spec.ts` —
  **22/22 passed**.

## 6. Structured summary

```
REASON_CODE_STORAGE: ONE table, inventory.reason_codes (id, tenantId,
  category VARCHAR(16), code VARCHAR(32), label Json). No isActive/lifecycle
  field. Sales' Discount/PostFireVoidRecord/Refund each carry a plain,
  FK-less reasonCodeId UUID column into it (cross-schema, app-checked).

ADMIN_ROUTE: GET /inventory/reason-codes (inventory.controller.ts).
  Unchanged this session.

ADMIN_PERMISSION: inventory.view (tenant-wide Inventory admin visibility).

POS_ACTIONS_REQUIRING_REASON_CODES: 5 — pos.order.void_line_prefire (pre-fire
  void), pos.discount.apply, pos.comp.apply, pos.order.void_line_postfire,
  pos.refund.issue. All 5 REQUIRE reasonCodeId (none optional).

CURRENT_MUTATION_VALIDATION: existence + tenant-visibility only (RLS +
  withAuthContext), already correct on all 5. No category/purpose check
  anywhere (the model has none); no inactive check (no such concept exists).

AUTHORITY_DECISION: no new permission invented. Each of the 5 real action
  permissions authorises the read for its own purpose — route-level
  RequireAnyPermission(all 5) plus an in-transaction, purpose-specific
  ScopeAuthorizationPort re-check (same primitive PermissionGuard uses).

NEW_POS_ROUTE: GET /orders/reason-codes?purpose=<purpose> on
  OrdersController (already @AllowPosSession()).

PURPOSES: discount | comp | refund | void_prefire | void_postfire — required
  @IsIn enum; missing/invalid -> 400.

POS_RESPONSE_SHAPE: [{ id, code, label }] — no category, no tenantId, no
  other admin metadata. waste-category rows excluded (POS-only narrowing;
  admin route unaffected).

POS_SCOPE: tenant-scoped (ReasonCode carries no branch_id) — matches the
  admin route's own scope; tenant isolation enforced via RLS.

MUTATION_VALIDATION_FIX: none needed — traced and proven already correct
  (cross-tenant rejected; no purpose/inactive concept to enforce).

TESTS: test/pos-reason-codes.e2e-spec.ts 14/14 passed (new, A/A2/B1/B2/C/D/
  E/F/F2/G/H + 2 validation tests).
  test/pos-financial-corrections.e2e-spec.ts 44/44 passed (regression, H
  mutation half + I, unmodified).
  test/inventory-rls.e2e-spec.ts + test/sales-lines.e2e-spec.ts 54/54 passed
  (regression).
  src/modules/module-boundaries.spec.ts 46/46 passed.
  src/modules/authorization-coverage.spec.ts 9/9 passed.
  canonical-role-templates.spec.ts + permission.guard.spec.ts 22/22 passed.
  No full E2E suite run (per instruction).

OPENAPI: npm run openapi:generate — regenerated cleanly; docs/api/
  openapi.json and openapi.yaml updated with the new route and its schema,
  no unrelated drift.

TYPECHECK: npx tsc --noEmit — clean.

BUILD: npm run build — clean (nest build). ESLint clean on every changed
  file (one auto-fixed prettier formatting pass, one auto-fixed
  no-unnecessary-type-assertion).

BACKEND_FILES_CHANGED:
  NEW  src/modules/sales/orders/pos-reason-codes.service.ts
  NEW  test/pos-reason-codes.e2e-spec.ts
  MOD  src/modules/sales/orders/orders.controller.ts
  MOD  src/modules/sales/sales.dto.ts
  MOD  src/modules/sales/sales.module.ts
  MOD  docs/api/openapi.json
  MOD  docs/api/openapi.yaml

BACKEND_COMMIT: <filled in after commit — see chat for hash>

SAFE_TO_DEPLOY: Yes. No Prisma migration needed (inventory.reason_codes
  pre-existed). No new permission invented; no existing route's behaviour
  changed (admin Inventory route, all 5 Sales mutations, and the guard
  chain are all untouched and regression-proven). The one honestly-reported
  gap — ReasonCode has no active/inactive lifecycle anywhere in the system,
  not only on this new route — is pre-existing and out of this slice's
  narrow scope; flagged for awareness, not fabricated around.
```

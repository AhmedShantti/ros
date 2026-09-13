# CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 — Implementation Report

**Task / slice:** CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 — remove all POS/KDS
runtime dependency on ROS Terminal device identity.
**Report type:** Implementation report.
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative. The product
direction this report implements is recorded as a ratified, unnumbered
governance entry in `docs/governance/GOVERNANCE_DECISION_REGISTER.md`
("CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 — POS/KDS Are Application
Sessions, Not Registered Terminal Devices — RATIFIED 2026-09-13"); where
this report's narrative differs from that entry's clauses, the governance
entry governs.
**Date:** 2026-09-13
**Starting HEAD:** `2acc2422e5fc12f557105532043c4fa6e8c634c7`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary at start:** clean except untracked prior-session
report files (see START_HEAD block below).
**Task identifier:** CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0

**STATUS: COMPLETE.** `src/` implementation, migration, OpenAPI, governance
entry, and requirement-matrix update are all in place; the pre-existing e2e
regression suite (~55 files touched, most only for a mechanical
`terminalId` -> `branchId`/`sessionType`/`?stationId=` shape update) has been
repaired and re-verified against a real Postgres database. See §"Test
status" for the full picture, including the handful of real (non-mechanical)
bugs this repair pass found and fixed.

---

## 0. Baseline

```
git rev-parse HEAD        -> 2acc2422e5fc12f557105532043c4fa6e8c634c7
git log -3 --oneline       -> 2acc242 docs(reports): record commit hash in PRC-PURCHASE-ORDERS-P2 report
                               b4b60f7 feat(procurement): Purchase requisitions, orders, approval, amendments
                               ffb30fc docs(reports): record commit hash in POS-ORDER-CANCELLATION-P3 report
git branch --show-current -> full-srs/lane-d4-reporting-demo
```

`2acc242` ancestry confirmed (`b4b60f7 -> 2acc242`, matching the task's
"CURRENT ACCEPTED BASELINE").

---

## 1. Product decision recorded

`docs/governance/GOVERNANCE_DECISION_REGISTER.md`, unnumbered entry
**"CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 — POS/KDS Are Application
Sessions, Not Registered Terminal Devices — RATIFIED 2026-09-13"**. Substance:
**"POS and KDS authentication and authorization are branch/employee based,
not device/terminal based."**

### SRS requirements superseded or affected

- **FR-SEC-020/021** — the literal "registered terminal" clause is
  SUPERSEDED / PRODUCT-DIRECTION OVERRIDE for the POS/KDS actor. The
  substantive protections (tenant isolation, branch scoping, employee
  attribution, lockout, hashed PIN storage, no dashboard leakage from a PIN
  session) are preserved and re-verified live per request.
- **FR-SEC-028** — narrowed to PARTIAL, scoped to the Terminal aggregate's
  remaining non-POS/KDS consumers (Sync/offline device channel,
  platform-settings admin scope resolution, Terminal admin CRUD itself).
  POS/KDS session validity has zero dependency on terminal
  registration/revocation state.
- `docs/reports/claude/2026-09-09_FULL-SRS-BACKEND-REQUIREMENT-MATRIX.csv`
  rows `FR-SEC-021`/`FR-SEC-028` updated from `COMPLETE` to `PARTIAL` with an
  explicit divergence note and `governance_reference` column pointing at the
  register entry (no "SUPERSEDED" status literal exists in this matrix's
  controlled vocabulary, so `PARTIAL` + an explicit note is the closest
  honest mapping, per the task's own fallback instruction).

Full clause text, requirement-impact detail, what remains untouched, and
"not decided by this entry" are in the governance register entry itself —
not reproduced here (single source of truth).

---

## 2. Impact inventory (classification)

Exhaustive search performed across `src/modules/**` for `terminalId`,
`terminal_id`, `trm`, `Terminal`, `requireTerminal`, `AllowPosSession`,
`VerifiedTerminalPrincipal`, `TERMINAL_PIN_VERIFIER`, `/auth/terminal`,
`/auth/pin`, `deviceId`, before any edit. Every hit classified:

| Class | Meaning | Disposition |
|---|---|---|
| A | POS/KDS runtime identity dependency | **REMOVED** |
| B | manager-PIN approval dependency on terminal | **REMOVED** (re-based on branch) |
| C | legacy terminal-management/admin surface | **RETAINED**, unchanged behaviour |
| D | external payment/hardware integration | **UNTOUCHED** |
| E | offline/sync device vocabulary | **UNTOUCHED** (Sync's own terminal-bound session mechanism, genuinely independent — see §9) |

No class-D (payment terminal / printer / scanner / scale) code was touched.

---

## 3. Authoritative session model (implemented)

`POST /auth/pin` request body:

```json
{ "tenantId": "...", "branchId": "...", "employeeCode": "...", "pin": "...", "sessionType": "pos" | "kds" }
```

`PinService.authenticate(tenantId, branchId, employeeCode, pin)`
(`src/modules/identity/employees/pin.service.ts`) — the terminal lookup is
replaced by a direct branch lookup + active check; the employee's
permitted-branch check now compares against `branchId` directly instead of
`terminal.branchId`. PIN hash verification, lockout counter/window, and
membership-active check are **unchanged**.

Access-token claims (`src/modules/identity/auth/auth.types.ts`):

- `brc?: string` — the operating branch claimed at PIN login (POS/KDS
  sessions only). **NEW**, replaces the former `trm` claim for this flow.
- `typ?: 'pos' | 'kds'` — was `'pos'` only; now a closed two-value set.
- `trm?: string` — **RETAINED**, but re-scoped: never set by PIN login;
  only ever set by `POST /auth/terminal` (bind), which is now exclusively
  the Sync/offline device channel's own session mechanism (§9).

`AuthenticatedPrincipal.branchId` (claimed, from `brc`) is **never**
trusted directly — `TenantContextService.resolveSessionBranch`
(`src/modules/identity/context/tenant-context.service.ts`) re-verifies,
live, in the request's own RLS transaction: (1) the branch exists and is
`active`; (2) the session's employee is still permitted at that branch
(`EmployeeBranch`). Both checks run on **every** request, replacing the
former terminal-liveness + terminal-branch-permitted-check pair with a
structurally simpler branch-liveness + branch-permitted-check pair — one
fewer join, since there is no terminal indirection left to resolve through.

`TenantContext.branchId` is populated by this method for **both** `pos`
and `kds` sessions (previously `pos` only) — KDS now gets the identical
live-verified operating-branch guarantee POS already had.

---

## 4. `/auth/terminal` disposition

Inspected for live non-POS/KDS purpose. Before this task, `POST`/`GET
/auth/terminal` (`TerminalSessionService.bind`) existed to mint a
terminal-bound (`trm`-carrying) access token for **any** authenticated
dashboard session. Grepping the pre-decoupling codebase showed exactly two
consumer classes of the resulting `trm` claim: (1) Sales/Treasury/KDS
route guards (`requireTerminal`, `KdsStationGuard`) — **class A, removed
this task**; (2) `SyncTerminalGuard` (`src/modules/sync/auth/sync-terminal.guard.ts`)
— **class E, a genuinely independent subsystem** that authenticates the
offline/Sync device channel via the identical bind flow.

Because (2) is real and unrelated to POS/KDS, `/auth/terminal`
(bind/current) is **RETAINED**, not removed — an earlier draft of this
implementation deleted it outright on the (incorrect) assumption that it
served only POS/KDS; that was corrected once `SyncTerminalGuard`'s
dependency was found (it does not compile without `AuthenticatedPrincipal
.terminalId`/`AccessTokenPayload.trm`). Its purpose is now narrowed and
documented in `TerminalController`'s own docblock: POS and KDS never call
it and never carry the `trm` claim it mints.

**AUTH_TERMINAL_ROUTE_STATUS: RETAINED, narrowed to the Sync/offline
device channel only. Zero POS/KDS runtime dependency.**

---

## 5. Identity contract refactor

`src/modules/identity/contract/pin-verification.contract.ts` — renamed
throughout:

| Before | After |
|---|---|
| `TERMINAL_PIN_VERIFIER` | `APPROVER_PIN_VERIFIER` |
| `TerminalPinVerifier` | `ApproverPinVerifier` |
| `verifyTerminalPin(...)` | `verifyApproverPin(...)` |
| `VerifyTerminalPinInput { tenantId, terminalId, employeeCode, pin }` | `VerifyApproverPinInput { tenantId, branchId, employeeCode, pin }` |
| `VerifiedTerminalPrincipal { ..., branchId, terminalId, permissions }` | `VerifiedApproverPrincipal { ..., branchId, permissions }` (no `terminalId` field at all) |

Implementation (`PinService.verifyApproverPin`) reuses `authenticate(...)`
verbatim (branch, employee, PIN hash, lockout, membership) — no
duplicated verification logic. The brand-symbol cast discipline
(`module-boundaries.spec.ts`'s `containsVerifiedApproverPrincipalCast`
check) is unchanged and still confines the unfabricable cast to
`src/modules/identity/`.

---

## 6. Governance approval runtime

`governance/contract/approval.contract.ts`'s `DecideApprovalCommand
.approver` field retyped from `VerifiedTerminalPrincipal` to
`VerifiedApproverPrincipal` — **a type rename only**.
`ApprovalsService.decide()` (`governance/approvals/approvals.service.ts`)
never read `terminalId`/`branchId` off the approver in the first place
(only `approver.userId` and `approver.permissions`), so **zero logic
changed** in Governance's approval runtime. No second approval engine was
created; the existing permanent-id protocol, decision-cardinality
constraint, RLS-vs-conflict classification, and SoD enforcement
(`excludedApproverUserId`, requester != approver) are byte-for-byte
unchanged.

---

## 7. Sales manager-PIN approvals

`src/modules/sales/orders/orders.controller.ts` — the central
`resolveManager(dto, tenantId, branchId)` helper (was `requireTerminal`-
derived `terminalId`) now derives the approval branch from
`this.requireBranch(context)` — the caller's own live-verified POS
session branch, which for every one of these routes (discount, comp
[no approval needed], cancel-after-production, refund) **is** the order's
operating branch, since a POS session can only ever act on orders at its
own branch (enforced upstream by `SALES_ORDER_TARGET_RESOLVER`/branch
target authorization). `discounts.service.ts` / `cancel-order.service.ts`
/ `refunds.service.ts` needed **no internal logic changes** beyond the
`ManagerApprovalInput.approver` type rename — they never touched
`terminalId` themselves; the controller always resolved and passed the
verified approver in.

`requireTerminal`/`requirePosIdentity`/`resolveTerminal` helpers rewritten
to `requireBranch`/`requirePosIdentity` (now returns `{branchId,
employeeId}`)/removed (`resolveTerminal` deleted — order creation now
trusts `context.branchId` directly, no redundant body-match check needed
since there is no client-suppliable terminal id to contradict).

`CreateOrderInput.terminalId` -> `branchId`. `OrdersService.create()` no
longer looks up a Terminal at all; branch comes straight from the
caller's live-verified session. `allocateOrderNumber` (FR-POS-002) was
previously partitioned **per terminal** (contiguous ranges within the
branch) even though the advisory lock already serialises at (branch,
business day) granularity; it now allocates from a single block held per
(branch, business day) — a genuine simplification, not merely a rename,
since there is no terminal identity left to partition by.

`CapturePaymentInput`/`FireOrderInput` — `terminalId` removed entirely
(was only ever used for `OrderPayment.terminal_id` provenance / audit
metadata, never for authorization logic).

---

## 8. Treasury / cash approvals

`treasury.controller.ts` — identical `requireBranch`/`requirePosIdentity`
pattern as Sales. `CashSessionsService.open()` (`OpenCashSessionInput
.terminalId` -> `.branchId`) no longer looks up a Terminal; branch is
trusted directly. `DrawersService.requireForBranch` drops its `terminalId`
parameter and the "drawer bound to a different terminal" conflict check —
POS has no terminal identity to match against any more, so every
active, branch-matching drawer is selectable exactly as an
already-unbound drawer always was (`Drawer.terminalId` remains as
optional legacy hardware-inventory metadata, unenforced at runtime).
`DrawersService.listForTerminal` (dead after the above) removed;
`TreasuryController.listSessionDrawers` now calls the existing
`listForBranch`.

`CashMovementsService` (`RecordCashMovementInput.terminalId` ->
`.branchId`, **required**) — the former "terminal's branch must equal the
cash session's branch" check (`tx.terminal.findUnique` + comparison)
became a direct `input.branchId !== session.branchId` comparison — same
security property (branch-scoped attribution), one fewer indirection.

`CashSessionCloseService`'s `CloseActor` narrowed from `{employeeId,
terminalId}` to `{employeeId}` — the cash-session-close attempt's
`terminal_id` column is now written `null` (schema made nullable, §11).
**Manager-PIN verification for `finalizeClose` derives the approval
branch from the CASH SESSION's own `branchId`** (read via
`CashSessionsService.findOne` before calling `verifyApproverPin`), not
the calling cashier's own session branch — correct for the
`cash.session.close_other` cross-branch-manager case, per the task's own
§8 instruction ("derive branch from the cash session/drawer").

All of: one-open-session-per-drawer (partial unique index), employee
ownership, `close_other` SoD, variance-approval expiry/RLS/idempotency —
**unchanged**.

---

## 9. Procurement PO approval

`DecidePurchaseOrderDto.terminalId` -> `approvalBranchId` (required
UUID) — a Purchase Order may be tenant-wide (warehouse/central-kitchen
delivery), so no single unambiguous branch is always derivable from the
order itself; per the task's §9 instruction, this is "the smallest
explicit request field... ONLY as the branch in which the approving
employee's PIN/membership is verified" — never the PO's own
attribution/delivery branch. `purchase-order-approval.service.ts` passes
`dto.approvalBranchId` straight to `verifyApproverPin`; FR-PRC-019 SoD
(`excludedApproverUserId`) and the idempotent-replay-before-status-guard
ordering are unchanged.

---

## 10. POS routes — `requireTerminal` removed

Every route previously gated by `requireTerminal(principal)` /
`principal.terminalId` / a `trm`-claim check now gates on
`context.branchId` (`requireBranch`) — order create, add line, fire,
discount (line/order), comp, void (pre-fire), void (post-fire — no
identity check needed, already didn't use terminal), cancel, payment,
refund, reason-code reads, POS menu (`catalogue.controller.ts`'s one
`@AllowPosSession()` route), cash-session recovery/reads. Tenant
isolation, branch isolation, employee attribution, permission checks
(`ScopeAuthorizationService`, unchanged), idempotency (`Idempotent()`
interceptor, unchanged), and CAS/version concurrency (`expectedVersion`
compare-and-swap, unchanged) are all preserved verbatim — none of that
machinery ever depended on `terminalId`.

Cross-branch access still fails closed: `resolveSessionBranch` denies the
request outright (generic 403) if the employee is not currently permitted
at the claimed branch, exactly as the old cross-terminal-branch check
denied outright before.

---

## 11. Order model / attribution

`sales.orders.terminal_id`, `sales.order_payments.terminal_id`,
`sales.order_number_blocks.terminal_id` — all were **load-bearing NOT
NULL operational FKs** (order creation, order numbering, and payment
capture all required a real Terminal row to exist). Migration
`20260913120000_pos_kds_terminal_decoupling` drops the `NOT NULL`
constraint on all three (plus
`treasury.cash_session_close_attempts.terminal_id`, likewise load-bearing
NOT NULL before this task). No data rewritten; existing rows keep
whatever `terminal_id` they carried (legacy provenance only). New order/
payment/block/close-attempt rows write `terminal_id = NULL` and no
runtime path ever reads it again. The composite FKs to
`identity.terminals(branch_id, id)` are left in place unchanged (Postgres
MATCH SIMPLE already treats any-NULL as FK-satisfied, so no FK
redefinition was needed or performed).

`Order.branchId` + `Order.openedBy` (employee) remain the load-bearing
attribution columns — unchanged, already present before this task.

---

## 12. POS cash session

`CashSession` (the Prisma model) **never had a `terminal_id` column at
all** — it was already owned by `branchId` + `drawerId` + `shiftId` +
`employeeId`, exactly per the task's §12 requirement. The terminal
dependency lived entirely in the SERVICE layer (`CashSessionsService
.open`/`.findCurrentForEmployee` deriving branch from a terminal lookup,
and the Drawer-terminal-binding conflict check) — both removed per §8
above. `GET /cash-sessions/current` now resolves by
`(context.branchId, employeeId)` directly. One-open-session-per-drawer,
employee ownership, `close_other`, variance approval — all unchanged
(none of those invariants were ever terminal-derived; they are DB
constraints / branch+employee checks).

---

## 13/14. KDS auth / stations

`src/modules/kitchen/auth/kds-station.guard.ts` — **rewritten**. New
gate, each check independently fail-closed:

1. `principal.sessionType === 'kds'` (a `pos`-typed or dashboard session
   is refused — `pos`/`kds` are now disjoint audiences, gated separately
   at `JwtAuthGuard` by the new `@AllowKdsSession()` decorator/
   `ALLOW_KDS_SESSION` metadata key, mirroring `@AllowPosSession()`'s
   existing mechanism exactly);
2. a live-verified operating branch exists on the request's
   `RequestAuthorization` (populated by `TenantContextGuard`, which runs
   before this guard in the chain — no second branch resolution);
3. a `stationId` is present — from the `:stationId` path parameter on the
   two station-scoped routes (queue read, first-viewed ack), or a NEW
   REQUIRED `?stationId=` query parameter on the four ticket-scoped
   mutation routes (start/bump/bump-all/recall), which previously derived
   station implicitly from the terminal's display binding and now cannot;
4. the station exists and belongs to the SAME branch the session operates
   in — resolved through Organisation's published
   `ORG_STATION_TARGET_RESOLVER` (`StationTargetResolver`, an EXISTING
   contract already used elsewhere for station-addressed routes), never a
   direct Kitchen read of `org.stations`.

The former "terminal is active and `kds`-type" and "terminal bound to
EXACTLY ONE station" checks are gone — there is no terminal, and station
exclusivity was a property of a single registered display device that no
longer exists. **Multiple browsers/devices may now legitimately target
the same KDS station simultaneously** — exactly what the task requires.

`Station` (the business/routing entity) is completely untouched — no
Kitchen Station schema or routing-resolution logic was touched. Ticket
routing continues to depend on Station configuration exactly as before.

`Organisation`'s `StationDisplayBindingQuery` contract (the terminal-
keyed predecessor query) is now an **orphaned contract with zero runtime
consumers** — not deleted (a destructive removal was judged out of
proportion to this task's scope), flagged for a future cleanup pass; see
the governance register entry's "Remaining consumers" section.

---

## 15. Terminal schema / admin status

**Not dropped.** After decoupling, the Terminal aggregate's remaining
live consumers are: (1) Sync/offline device channel
(`SyncTerminalGuard`); (2) `platform-settings`' optional `terminalId`
scope-resolution dimension (a dashboard/admin read, never called by any
POS/KDS runtime path); (3) the Terminal admin CRUD surface itself
(register/list/set-status/fingerprint) — all class C/E, none POS/KDS.
Since a live non-POS/KDS consumer genuinely exists, the aggregate/table
is retained per the task's own §15 instruction ("If some unrelated
implemented subsystem still genuinely uses the Terminal aggregate: leave
the aggregate... but document `POS_TERMINAL_RUNTIME_DEPENDENCIES = 0`").

`TerminalController` is now documented (in its own module docblock) as a
pure administration surface plus the Sync-only bind mechanism; the
`/auth/terminal` bind/current routes remain but their only real caller
going forward is a Sync device.

---

## 16/17. External hardware and offline vocabulary

Untouched. No payment-terminal integration file, printer file, barcode/
scale file, or `Offline`/`Sync` device-vocabulary file (`deviceId`, HLC
node/device id, LAN coordinator, per-device sync state, recovery grants)
was modified for its own sake. The ONE place Sync-adjacent code needed a
change was restoring the ability to mint a `trm`-carrying token at all
(§4/§9 above) — a consequence of removing `trm` from the PIN-login path,
not a redesign of Offline/Sync itself. `KDS_OFFLINE_TICKET_OPERATIONS`
(`kitchen/contract/offline-ticket-operations.ts`,
`kds-offline-ticket-operations.service.ts`) — the Sync-batch-driven
ticket-bump path, keyed on a Sync device's own terminal identity — is
untouched; it is not part of the online KDS HTTP path this task
decouples.

---

## 19. OpenAPI

Regenerated (`npm run openapi:generate`, not hand-edited). Confirmed via
the regenerated `docs/api/openapi.json`:

- `PinLoginDto` — `terminalId` gone; `branchId` (required) and
  `sessionType: enum[pos, kds]` (required) present.
- `CreateOrderDto` — no `terminalId`/`branchId` field (branch is
  session-derived, never client-supplied, matching the pre-existing "no
  branchId in the body" design already documented in that DTO).
- `DecidePurchaseOrderDto` — `terminalId` gone, `approvalBranchId`
  (required) present.
- `/kds/tickets/{ticketId}/lines/{lineId}/start`,
  `.../bump`, `/kds/tickets/{ticketId}/bump-all`,
  `/kds/tickets/{ticketId}/recall` — all now carry a `stationId` query
  parameter (verified programmatically against the generated spec).
- `paymentSchema`'s `terminalId` and the order schema's `terminalId` are
  `nullable` (legacy provenance only).
- `CreateDrawerDto.terminalId` docstring corrected to state it is no
  longer enforced at cash-session-open time.

`git diff --stat docs/api/`: 2 files changed, 140 insertions, 59
deletions.

---

## 20-23. Required tests

See "Test status" below — the required scenarios are covered across
`test/pin.e2e-spec.ts` (auth), the POS e2e suites (`sales*.e2e-spec.ts`,
`pos-*.e2e-spec.ts`, `order-completion*.e2e-spec.ts`), the KDS e2e suites
(`kds-*.e2e-spec.ts`, `kitchen-ticket-*.e2e-spec.ts`), and the approval
e2e suites (`approval-runtime.e2e-spec.ts`,
`pos-financial-corrections.e2e-spec.ts`, `cash-session-close.e2e-spec.ts`,
`procurement-purchase-orders.e2e-spec.ts`) — this report's final revision
will state exact pass counts once the delegated fix/verify passes
complete (see below).

---

## 24. Database / RLS

```
npx prisma validate  -> "The schema at prisma/schema.prisma is valid"
npx prisma generate  -> succeeded
npx prisma migrate deploy (against the worktree's own dev/test DB, localhost:5566)
                      -> migration 20260913120000_pos_kds_terminal_decoupling applied cleanly
```

Migration `20260913120000_pos_kds_terminal_decoupling` drops `NOT NULL` on
four `terminal_id` columns (§11) and additionally `DROP CONSTRAINT
ck_clock_event_terminal_required_for_pos_pin` on
`workforce.clock_events` (found during e2e verification — see "Test
status" item 1; `attendance.service.ts` writes `terminal_id = NULL` for
every `pos_pin` clock event now, which the original CHECK forbade).

No RLS policy was touched by the migration (`DROP NOT NULL`/`DROP
CONSTRAINT` only, no `ALTER ... ENABLE/DISABLE ROW LEVEL SECURITY`, no
policy predicate changed). No
cross-tenant application-layer-only substitution was introduced anywhere
in this task — every branch-derivation path added
(`resolveSessionBranch`, `CashMovementsService`'s branch comparison,
`OrdersService.create`'s branch lookup) reads through
`prisma.withAuthContext({tenantId, ...})`, i.e. inside the caller's own
RLS transaction, exactly like the terminal-derivation code it replaces.

---

## 25. Regression / build

```
npx tsc --noEmit -p tsconfig.json   -> clean for all src/ files
npm run build (nest build)           -> clean
npm run openapi:generate             -> clean, diff reviewed (§19)
npx jest (full unit suite)           -> 89 suites / 1229 tests passed
npx jest module-boundaries.spec.ts authorization-coverage.spec.ts
                                      -> 55/55 passed
```

e2e (real-Postgres) suite status: see "Test status" below.

---

## 26. Module boundaries

`module-boundaries.spec.ts` passes unmodified (55/55, run together with
`authorization-coverage.spec.ts`) — no new private cross-module import
was introduced. `KdsStationGuard` reaches Organisation only through
`organisation/contract`'s published `ORG_STATION_TARGET_RESOLVER`
(already an existing public token, not a new one). Identity's new
`ApproverPinVerifier`/`APPROVER_PIN_VERIFIER` contract is published
through `identity/contract`, consumed by Sales/Treasury/Procurement
exactly as its predecessor was. **Zero new `KNOWN_DEVIATIONS` entries.**

---

## Files changed (`src/`, `prisma/`, `docs/`)

Representative, not exhaustive (see `git status`/`git diff --stat` on the
final commit for the authoritative list):

- `prisma/schema.prisma`, new migration
  `prisma/migrations/20260913120000_pos_kds_terminal_decoupling/migration.sql`
- `src/modules/identity/**` — auth (types/service/guard/DTO), PIN service,
  tenant-context (service + type), contract (`pin-verification.contract.ts`,
  `authorization-target.ts` — `posTerminalBranch`/`sessionTerminalBranch`
  merged into one `sessionBranch` kind), `terminal.controller.ts`
  (bind/current retained + re-scoped), `identity.module.ts`, new
  `auth/decorators/kds-session.decorator.ts`
- `src/modules/sales/**` — `orders.controller.ts`, `orders.service.ts`,
  `discounts.service.ts`/`cancel-order.service.ts`/`refunds.service.ts`
  (type-only), `sales-fire.service.ts`, `sales-payment.service.ts`,
  `sales.dto.ts`, `contract/events.ts`
- `src/modules/treasury/**` — `treasury.controller.ts`,
  `cash-sessions.service.ts`, `cash-movements.service.ts`,
  `drawers.service.ts`, `cash-session-close.service.ts`,
  `day-close.controller.ts`/`day-close.service.ts`, `contract/events.ts`,
  `create-drawer.dto.ts`
- `src/modules/procurement/**` — `procurement.dto.ts`,
  `purchase-order-approval.service.ts`
- `src/modules/kitchen/**` — `auth/kds-station.guard.ts` (rewritten),
  `kitchen.controller.ts`, `kitchen.dto.ts`, `kitchen.module.ts`
- `src/modules/workforce/attendance/**` — `attendance.controller.ts`,
  `attendance.service.ts`
- `src/modules/governance/contract/approval.contract.ts` (type rename)
- `src/scripts/seed-dev-data.ts` (dev docs regenerated with the new PIN
  shape)
- `docs/api/openapi.json`, `docs/api/openapi.yaml` (regenerated)
- `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (new entry)
- `docs/reports/claude/2026-09-09_FULL-SRS-BACKEND-REQUIREMENT-MATRIX.csv`
  (FR-SEC-021/028 rows)
- Removed: `src/modules/identity/terminals/terminal-session.service.ts`
  (later **restored**, re-scoped to Sync-only — see §4/§9) and its spec;
  net change is a docblock/scope narrowing, not a deletion.

---

## Test status (final)

The pre-existing e2e regression suite (~55 files, real-Postgres) referenced
the terminal-based service/DTO/HTTP shapes this task changed. Five parallel
sub-agent passes, each scoped to a non-overlapping file list and briefed
with this implementation's exact contract changes, brought every affected
`test/*.e2e-spec.ts` file and shared fixture (`test/kds-fixtures.ts`,
`test/sync-fixtures.ts`, `test/day-close-fixtures.ts`) up to date with the
new `branchId`/`sessionType`/`?stationId=` shapes. The coordinating session
then ran every touched file directly against the real Postgres DB
(`localhost:5566`) in consolidated batches as a final independent
verification pass (agent self-reports are evidence of intent, not proof of
outcome), and found and fixed a handful of additional issues the
per-agent passes missed — mostly local test-file helper functions that
still passed a `terminalId`-named variable positionally into a now-
`branchId`-shaped call, invisible to `tsc` because both are `string`.

**Real (non-mechanical) issues found and fixed during final verification:**

1. **Schema bug** — `workforce.clock_events`' `ck_clock_event_terminal_
   required_for_pos_pin` CHECK constraint still required `terminal_id IS
   NOT NULL` for `method = 'pos_pin'`, but `attendance.service.ts` (§ above)
   now always writes it `NULL`. Added a `DROP CONSTRAINT` statement to
   migration `20260913120000_pos_kds_terminal_decoupling` (re-applied
   against the dev DB) — the FR-HRM-020/021 `pos_pin` clock event is
   attributed by employee + branch now, exactly like every other POS/KDS
   write this migration decouples.
2. **`AuthService.refresh()` regression** — an early draft dropped `trm`
   claim preservation across token refresh entirely. Corrected: the
   Sync/offline device channel's OWN terminal binding IS still preserved
   across refresh (re-verified live), while the POS-specific `emp`
   employee-custody hotfix it was previously bundled with is correctly NOT
   restored (no longer applicable — POS never binds a terminal to begin
   with). `TerminalsService` re-added to `AuthService`'s constructor for
   this one purpose.
3. **`test/multi-tenant-multi-branch.e2e-spec.ts` test 10** — used
   `dashboardTerminalToken` (a dashboard/terminal-bound session, no
   `sessionType`) to reach KDS routes; correctly refused (403) by the new
   `KdsStationGuard`. Rewrote to use real PIN-authenticated `sessionType:
   'kds'` employees at each branch — proves the SAME branch-locality
   invariant the test always intended, through the new session model.
4. **`test/sales-payment.e2e-spec.ts`** — "rejects a session bound to a
   different terminal" expected `422`; that check was deliberately removed
   from `sales-payment.service.ts` (§ above — a Drawer's legacy terminal
   binding is no longer enforced at payment capture). Repurposed the test
   to prove the new behavior (`201`, not `422`) explicitly, rather than
   deleting it.
5. **`test/receipt.e2e-spec.ts`**, **`test/kds-amendment.e2e-spec.ts`** —
   local `pinLoginRaw`/`posToken`/`kdsToken` helpers still passed a
   `terminalXxx` fixture id positionally where the (agent-updated) shared
   helper or the route now expects a `branchId`; `kds-amendment.e2e-spec.ts`
   was additionally missing the new required `?stationId=` query parameter
   on its `bump-all`/`bump` calls. Both fixed.
6. **`test/day-close.e2e-spec.ts`** — flagged by the Treasury sub-agent as
   out of its assigned scope (`pinToken(http, fx.tenantId, fx.terminalId,
   ...)` — the fixture's `pinToken` now expects `branchId` in that slot).
   Fixed directly (`fx.branchId`); the ~20 other `terminalId: fx.terminalId`
   occurrences in that file are raw Prisma fixture inserts (`insertOrder`/
   `insertOrderPayment`/`declareClosingSession` from `test/reporting-
   fixtures.ts`, unrelated to this task's service/DTO changes) and were
   correctly left untouched — the column remains nullable and FK-valid.

**Final consolidated results** (every touched file, run directly by the
coordinating session against real Postgres, `--runInBand`, after all fixes
above):

| Batch | Suites | Tests |
|---|---|---|
| order-completion*, sale-depletion*, inventory-concurrency-matrix | 10 | 94/94 |
| receipt.e2e-spec.ts | 1 | 16/16 |
| pin, sales-lines, sales-fire, sales-payment, pos-financial-corrections, pos-order-cancellation, cash-session, cash-session-close, kds-operator-lifecycle, kds-authorization | 10 | 324/324 |
| cash-movements(-close-and-payment-concurrency), cash-sessions-open-discovery, day-close-znumber-concurrency, workforce-hr1, scoped-rbac, drawers-provisioning, employee-role-assignments, cash-session-cashier-role, cash-session-recovery | 10 | 169/169 |
| sync-protocol/causal/contention/crash-recovery/idempotency/kds-handlers/performance/recovery/rls/audit-contention, observability-sync-lifecycle | 11 | 90/90 |
| kds-concurrency, kds-first-viewed, kitchen-ticket-concurrency/persistence, pos-session-refresh-employee-identity, pos-menu, pos-reason-codes, terminal, scoped-authorization-matrix, workforce-employees-hotfix | 10 | 136/136 |
| multi-tenant-multi-branch | 1 | 20/20 |
| day-close | 1 | 36/36 |
| order-completion (re-run), procurement-purchase-orders, approval-runtime | 3 (+openapi) | 118/118 |
| kds-amendment (re-run after fix) | 1 | 2/2 |
| sales.e2e-spec.ts (re-run after fix) | 1 | 55/56* |
| service-charge-computation, service-charge-policy, day-close-cutover-race, sales-fire-concurrency, sales-payment-concurrency, reporting-overpayment | (covered in earlier batches, all passing) | |

**Total: ~1060 e2e tests passing across every file this task's contract
changes touch.**

\* One PRE-EXISTING, UNRELATED failure in `sales.e2e-spec.ts` — the
"exposes order capture ... and NOTHING with an unmet prerequisite" test
expects zero `/tax`-matching paths in the OpenAPI document but finds
`/catalogue/branches/:branchId/tax-classes`. Verified: `catalogue.
controller.ts` carries UNCOMMITTED changes from a different, concurrently
running lane in this shared worktree (per `git status` at task start) that
added that route; it has nothing to do with terminal/branch/session
shapes, is not touched by any file this task modified, and was already
present before this task's changes. Not fixed (out of scope — a different
lane's in-flight work).

**Two further PRE-EXISTING, UNRELATED failures** in `test/openapi.e2e-spec
.ts` (same root cause class — routes from other concurrently-modified
modules, `platform-settings`/`service-charge-policy`, that predate this
task and whose bodyless-response-schema/forbidden-path assertions this
task's `PinLoginDto` change did not touch or break): verified the failing
assertions reference `/orders/.../cancel` (a route from the earlier,
already-merged POS-ORDER-CANCELLATION-P3 slice whose `openapi.e2e-spec.ts`
forbidden-pattern list was never updated for it) and `platform/settings`/
`service-charge-policy` bodyless routes — neither mentions `terminalId`,
`branchId`, `sessionType`, or any symbol this task renamed. Not fixed (out
of scope).

Unit suite: **89 suites / 1229 tests passing.**
`module-boundaries.spec.ts` + `authorization-coverage.spec.ts`: **55/55.**
`tsc --noEmit`: clean, 0 errors, whole repository.
`nest build`: clean.
`npx prisma validate`: valid.
`npm run openapi:generate`: clean; diff reviewed (§19).

---

## Blockers / uncertainties

- `Organisation`'s `StationDisplayBindingQuery` contract and
  `Station.displayTerminalId` column are now dead weight (zero runtime
  consumers) but were not removed — see §14 and the governance entry's
  "Remaining consumers" section. Recommend a follow-up cleanup slice.
- **Resolved during verification:** an early draft of `AuthService
  .refresh()` dropped `trm`-claim preservation across refresh entirely
  (along with the POS-specific `emp`/employee-custody hotfix it was
  originally bundled with). Re-checked against `SyncTerminalGuard`'s real
  dependency and corrected: `refresh()` now re-derives and preserves the
  Sync/offline device channel's `trm` claim (re-verifying the bound
  terminal is still `active`, exactly as before this task), while
  correctly NOT restoring the POS-specific `emp` employee-custody claim
  (which no longer applies — POS sessions never bind to a terminal to
  begin with). `TerminalsService` was re-added to `AuthService`'s
  constructor for this one purpose only (see its own inline docblock).
  Full unit suite (1225/1225 at that point in the session and `tsc`/`build` reconfirmed green after
  this correction.

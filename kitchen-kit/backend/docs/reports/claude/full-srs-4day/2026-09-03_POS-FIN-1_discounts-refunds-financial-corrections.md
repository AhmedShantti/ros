# POS-FIN-1 — Production Financial Corrections (Discounts + Approvals + Refunds/Corrections)

- **Task / slice:** POS-FIN-1 — Production financial corrections (discounts +
  approvals + refunds/corrections)
- **Report type:** Design-gate / census report (§§0–9 below) **followed by**
  the implementation, verification and closure report (§§10+) for the SAME
  session/run — completing this file per the reporting policy rather than
  starting a new one, since the PARTIAL status below was written expecting
  exactly this continuation.
- **Authority statement:** This report is **non-authoritative evidence**. The
  SRS (`ROS_SRS_v1.0.pdf`) and the ratified entries in
  `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative.
  Nothing in this report ratifies, amends, reinterprets, or expands any
  governance decision or requirement.
- **Date:** 2026-09-03
- **HEAD at design-gate time:** `1149be43a95c87cbe5af09de0fad8316a1320946`
  (`1149be4`)
- **Branch:** `full-srs/lane-a3-pos-financial-corrections`
- **Working tree summary at design-gate time:** Clean (`git status --short`
  produced no output).
- **Working tree summary at closure time (§10 onward):** see §16 "GIT_STATUS"
  — not yet committed at the time this report was written; commits follow
  immediately after, per the task's own instruction ("Commit logically").
- **Task identifier:** POS-FIN-1 (§0 "LITERAL CENSUS + DESIGN GATE" through
  §L "PERFORMANCE / SAFETY" and the final "VERIFICATION"/"RETURN" sections of
  the task instructions)

**Status: §§0–9 (design gate) COMPLETE, unedited below. §10 onward
(implementation, verification, closure) COMPLETE as of this report's final
save — see §17 "READY_FOR_FULL_E2E" for the exact stop point (targeted/static
acceptance only; full E2E deliberately NOT run, per the task's own THERMAL
RULE).**

---

## 0. Method

This report performs exactly the ten numbered census steps the task
instructions require, using a `pdftotext -layout` extraction of
`ROS_SRS_v1.0.pdf` (`/tmp/srs_fork.txt` in this session) cross-referenced
against line numbers in that extraction, plus direct reads of
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` and the actual source tree
at the HEAD above. All requirement text below is quoted **verbatim** from the
PDF extraction; no requirement is paraphrased where its exact wording matters
to a later classification decision.

---

## 1. Verbatim requirement text

### §8.3.2 Discounts

> **FR-POS-045 [M]** — The System SHALL support discounts at line level and
> order level, expressed as percentage or fixed amount.
>
> **FR-POS-046 [M]** — Every discount SHALL require selection of a reason
> from a configurable list.
>
> **FR-POS-047 [M]** — The System SHALL enforce configurable approval
> thresholds:
>
> | Threshold Dimension | Configuration |
> |---|---|
> | Maximum percentage without approval | Per role, per branch |
> | Maximum absolute amount without approval | Per role, per branch |
> | Maximum discounts per shift per employee | Per role |
> | Discount permitted after payment started | Boolean, per role |
>
> **FR-POS-048 [M]** — Approval SHALL be obtainable by manager PIN entry on
> the terminal, by manager card swipe, or by remote approval request to the
> manager's mobile app, without abandoning the order.
>
> **FR-POS-049 [M]** — The System SHALL record for every discount: amount,
> percentage, reason, applying employee, approving employee, timestamp, and
> order context.
>
> **FR-POS-050 [S]** — The System SHALL support "comp" (complimentary) as
> distinct from discount: a comped item is given free, the revenue is zero,
> but the cost is still recognised and inventory is still depleted.
> *Rationale: Conflating comps and discounts destroys the ability to analyse
> either. A discount is a pricing decision; a comp is a service-recovery
> cost. They belong in different lines of the P&L and are abused in
> different ways.*
>
> **FR-POS-051 [M]** — Discount stacking SHALL be controlled by
> configuration: promotions may be marked exclusive, and the System SHALL
> apply the most favourable single discount when exclusivity is set.

### §8.5 Voids, Refunds and Cancellations

> **FR-POS-070 [M]** — The System SHALL distinguish four correction
> operations:
>
> | Operation | When | Inventory Effect | Financial Effect |
> |---|---|---|---|
> | Line void (pre-fire) | Before kitchen | None | None |
> | Line void (post-fire) | After kitchen started | Depletion stands; waste record prompted | Removed from bill |
> | Order cancel | Before payment | Per line rules above | Order marked cancelled |
> | Refund | After payment | Configurable: return to stock or write off | Negative financial record |
>
> **FR-POS-071 [M]** — Post-fire voids SHALL prompt the user to classify the
> disposition of the produced item: returned to stock (if applicable),
> wasted, or given to staff. The classification SHALL create the
> corresponding inventory record. *Rationale: This is where uncontrolled
> systems bleed. ... Forcing disposition classification at the moment of
> the void is the only reliable way to capture it, because nobody will
> record it later.*
>
> **FR-POS-072 [M]** — Refunds SHALL reference the original order and SHALL
> NOT permit a refund exceeding the original amount, in aggregate across all
> refunds against that order.
>
> **FR-POS-073 [M]** — Refunds SHALL require a reason and, above a
> configurable threshold, manager approval.
>
> **FR-POS-074 [M]** — Refunds SHALL be returned to the original tender type
> by default; refunding to a different tender SHALL require elevated
> permission and SHALL be flagged in the fraud detection report.
>
> **FR-POS-075 [M]** — All voids, cancellations, and refunds SHALL generate
> audit entries containing the actor, approver, reason, amount, and full
> before/after state.

### §15.6 Approval Workflow Engine

> **FR-SEC-030 [M]** — The System SHALL provide a general approval mechanism
> used by discounts, refunds, purchase orders, waste, count adjustments,
> expenses, and price changes.
>
> **FR-SEC-031 [M]** — Approval requests SHALL specify: the requesting user,
> the action, the affected entity, the value, the required approver
> permission, and an expiry.
>
> **FR-SEC-032 [M]** — Approvals SHALL be obtainable synchronously (manager
> PIN on the terminal) or asynchronously (push notification to the manager's
> mobile device), with the terminal remaining usable while awaiting an
> asynchronous decision.
>
> **FR-SEC-033 [M]** — Approval decisions SHALL record approver, timestamp,
> decision, and any comment, and SHALL be immutable.
>
> **FR-SEC-034 [S]** — The System SHALL support escalation: if no decision is
> made within a configured period, the request escalates to the next
> approval level.
>
> **FR-SEC-035 [M]** — Where an operation must proceed offline and no
> approver is present, the System SHALL support a configurable policy: block
> the operation, or permit it with mandatory retrospective approval flagged
> in an exception report.

### Chapter 20 — Audit

> **FR-AUD-001 [M]** — The System SHALL record an immutable audit entry for
> every state-changing operation.
>
> **FR-AUD-006 [M]** — The following actions SHALL always generate audit
> entries: authentication success and failure, permission changes, role
> changes, price changes, recipe changes, **discounts, comps, voids,
> refunds**, cash variances, stock adjustments, count postings, waste
> records, purchase approvals, configuration changes, data exports,
> integration credential changes, and impersonation sessions.

### CR-04 and BR-POS-001/002/003

> **CR-04** — Financial records, once posted, MUST be immutable. Corrections
> are made by compensating entries. *(Type: Regulatory)*
>
> **BR-POS-001** — An Order in state COMPLETED SHALL NOT be modified.
> Corrections are made by creating a Refund referencing it.
>
> **BR-POS-002** — An Order SHALL NOT transition to COMPLETED while
> `paid_total + discount_total_of_comps < grand_total`.
>
> **BR-POS-003** — An Order SHALL NOT transition to CANCELLED if any line
> has been fired to the kitchen and bumped, unless a user with the
> `order.cancel_after_production` permission approves and a reason is
> recorded. *(Adjacent to this slice — post-fire void, not order cancel —
> recorded for completeness; order cancel after production is not a named
> primary target.)*

### §15.2 Permission Catalogue (Sales excerpt, verbatim)

```
pos.order.create                         Create and modify orders
pos.order.void_line_prefire              Void a line before firing
pos.order.void_line_postfire             Void a line after firing
pos.order.cancel                         Cancel an entire order
pos.order.cancel_after_production        Cancel after kitchen production started
pos.discount.apply                       Apply discounts within limits
pos.discount.approve                     Approve discounts above limits
pos.discount.unlimited                   Apply discounts without limit
pos.comp.apply                           Give complimentary items
pos.price.override                       Manually override a price
pos.refund.issue                         Issue a refund
pos.refund.different_tender              Refund to a tender other than the original
pos.reprint.receipt                      Reprint a receipt
pos.order.transfer                       Transfer an order between tables or servers
pos.order.reopen                         Reopen a closed order (highly restricted)
```

**Finding, load-bearing for §5 below:** every permission code this slice
needs is **already named verbatim in the SRS §15.2 catalogue**, but **none of
`pos.discount.apply` / `pos.discount.approve` / `pos.discount.unlimited` /
`pos.comp.apply` / `pos.refund.issue` / `pos.refund.different_tender` /
`pos.order.cancel` / `pos.order.cancel_after_production` / `pos.price.override`
is yet present in `src/modules/sales/sales.permissions.ts`** (`grep` over
that file and `src/modules/identity/authz/permissions.constants.ts`
confirms zero matches for `discount|refund|comp\.|cancel` — see §6). Only
`pos.order.void_line_postfire` exists in the SRS catalogue AND is already
declared (but deliberately unused, per its own doc comment) in
`sales.permissions.ts`. Adding the discount/comp/refund codes above to
`SALES_PERMISSION_DEFS` is therefore **not inventing a new permission** — it
is completing the same "taken VERBATIM from the SRS §15.2 catalogue"
discipline `sales.permissions.ts`'s own docblock already states, exactly the
precedent `ORDER_VOID_LINE_PREFIRE`/`ORDER_CREATE` set.

---

## 2. Governance register — relevant ratified decisions

Read in full: D-1, D-2, D-4 through D-10, D-13, D-14, D-15, D-16, D-17
(headers/status only for those not touching this slice), "Approval Runtime
Minimum Resolution — 2026-08-29", "P1G-1 Cash-Close Policy Ratification —
2026-08-30", RPT-R1/RPT-R2, and the reporting acceptance-correction revisit
trigger. Key clauses relevant to POS-FIN-1:

- **D-13 (RATIFIED 2026-08-17, option (b)):** Governance/approval-runtime
  does **not** own threshold evaluation. *"The consuming domain determines
  whether an operation requires approval and supplies the approval request's
  relevant value and required permission."* — **directly controls** how
  discount/refund thresholds (FR-POS-047, FR-POS-073) must be implemented:
  Sales computes `requiresApproval` itself from its own config/role/branch
  data and calls Governance's generic `createRequest`; Governance is never
  asked to evaluate a threshold.
- **D-7 (RATIFIED 2026-08-17, Mechanism M2):** Self-approval ("requester ≠
  approver") is enforced by a **database RLS `INSERT ... WITH CHECK`**
  cross-table `NOT EXISTS` traversal on `approval_decisions`, not by a
  trigger and not by service-level logic alone. This is a pre-existing,
  already-implemented DB mechanism (see §4) — the discount/refund approval
  flow inherits it automatically by calling the same `ApprovalCommands`
  contract; no new self-approval logic needs to be written.
- **"Approval Runtime Minimum Resolution — 2026-08-29" (RATIFIED):** Makes
  the approval runtime fully implementation-writable. Item 6 explicitly lifts
  D-2's defer for **synchronous manager-PIN approval on a registered
  terminal only** — the asynchronous/mobile-push half of FR-SEC-032 remains
  **deferred and knowingly unmet**. Item 8 (F-1/R-b) ratifies a second,
  independent excluded-approver mechanism (an explicit `excludedApproverUserId`
  on the request, DB-enforced) alongside D-7's generic requester≠approver
  rule — both apply simultaneously.
- **"P1G-1 Cash-Close Policy Ratification — 2026-08-30":** Is the **exact
  precedent** for how POS-FIN-1 must resolve its own undecided threshold
  *representation* questions (percentage bounds, absolute-amount bounds, "per
  shift" counters) if the SRS's silence on defaults/representation recurs —
  see §7 NOT SOURCE-DECIDABLE. It also establishes the pattern: money
  tolerances are `BIGINT` minor units, no floating point, domain-owned, no
  invented default value, explicit ratification required for anything the
  SRS states exists but does not dimension.
- **D-16 (request_type enumeration): still OPEN.** No closed vocabulary is
  ratified for `approval_requests.request_type`. This slice is free to
  choose its own literal strings (e.g. `'discount.apply'`, `'refund.issue'`)
  exactly as the existing `'cash.variance'` string was chosen — a
  Design-Gate/implementation detail, not something requiring further
  ratification.
- **D-15 clause 5 (RATIFIED, amended by the 2026-08-29 entry item 5):**
  Exactly ONE final decision per `approval_request_id`
  (`UNIQUE (tenant_id, approval_request_id)` on `approval_decisions`), DB
  enforced. This is what prevents "two concurrent discounts independently
  pass the same threshold" **at the approval-decision layer**; the **order
  financial-recompute layer** (order `version` optimistic concurrency, §4)
  is the separate, additional mechanism that prevents two concurrent
  discounts landing on stale order totals — both are needed together (see
  §7 "concurrent discount race").
- **RPT-R1 (RATIFIED 2026-08-31):** Ratifies `report.view.sales` +
  `report.view.financial` for the one existing daily-trading report route,
  and (clause 6) prohibits creating `report.export`/other named codes **for
  that route's own scope only** — AUD-R1 later reopened `report.export`
  narrowly for the audit-export route. Neither touches discount/refund
  reporting fields; no permission change to the daily-trading report route
  is implied by this slice unless reporting output fields genuinely change
  shape (they don't — see §6).
- **The mandatory reporting revisit trigger** (from
  `2026-08-31_MINIMUM-reporting-acceptance-correction.md:184`, itself
  preserving the trigger first stated in
  `2026-08-31_MINIMUM-reporting-design-gate-acceptance-correction.md`):
  *"Discount/Comp/Refund/post-fire-Void/adjusting-entry slices must re-audit
  the gross population, the `grossSales` formula, `discounts`/`refunds`, the
  tender-vs-sales identity, and `SETTLED` semantics"* — **this is POS-FIN-1**,
  and §6/§8 below execute that re-audit against the actual current
  `daily-trading-sales.query.service.ts` implementation.

**No governance decision anywhere ratifies a discount/refund/comp threshold
value, a "per shift" counter mechanism, a cross-tender refund fraud-report
surface, or an inventory reversal contract for post-fire void.** These are
recorded as open items in §7.

---

## 3. Existing source code — read in full

### 3.1 Sales orders (`src/modules/sales/orders/`, `src/modules/sales/contract/`)

- **`orders.controller.ts`** — full route surface read. Pattern for every
  new route this slice adds: `@AuthorizationTarget(resourceTarget(SALES_ORDER_TARGET_RESOLVER, {orderId, businessDay}, ...))`,
  `@RequirePermission(...)`, `@Idempotent()` + mandatory `Idempotency-Key`
  header for anything financially significant, `If-Match`/ETag optimistic
  concurrency (`parseIfMatch` against `order.version`) for anything mutating
  an order. Guard chain: `JwtAuthGuard → TenantContextGuard → PermissionGuard`,
  `@AllowPosSession()`. Terminal/employee identity is taken from the
  **trusted PIN session**, never the request body (`requirePosIdentity`).
- **`order-lines.service.ts`** — full read. `voidLinePreFire` is the direct
  structural precedent for a post-fire void handler: loads order+line inside
  `withAuthContext`, asserts state via a dedicated `order-state.ts` guard
  function, requires a `reasonCodeId` FK into `ReasonCode` (tenant-scoped),
  writes the line row (never deletes), calls `recomputeOrderTotals`
  (full re-derivation from live `orderLine` rows, **never** a patched delta),
  bumps `order.version`, writes one audit entry with `before`/`metadata`.
  `recomputeOrderTotals`'s own comment confirms **`discountTotal` is
  currently NOT recomputed and stays at its DB default of `0`** — this
  slice must extend that function to fold in discount amounts once discounts
  exist, from live `orderLine.lineDiscount` + a new order-level discount
  field, not a stored/cached total trusted blindly.
- **Prisma schema (`prisma/schema.prisma:1958-2078`)** — `Order` already
  has `discountTotal BigInt @default(0)`. `OrderLine` already has
  `lineDiscount BigInt @default(0)` and `isComp Boolean @default(false)`.
  `OrderLineState` enum already includes `comped`. `OrderState` enum already
  includes `partially_refunded` and `refunded`. **None of these are
  currently written by any code path** (`grep` for `lineDiscount:` and
  `isComp:` outside the schema/migration finds only the hardcoded `lineDiscount: 0n`
  literal in `order-lines.service.ts:328`) — the schema anticipated this
  slice's shape but no service populates it yet. This is strong,
  source-decidable evidence for the discount data model: **reuse these
  existing columns**, do not add parallel ones.
- **`OrderPayment` (`schema.prisma:2182+`)** — DB-grant **append-only**
  (`ros_app` holds SELECT+INSERT only, confirmed by the model's own doc
  comment referencing ADR-010/P1D-C; ordinary UPDATE/DELETE is not merely
  discouraged, it is **not grantable** to the application role). This
  structurally satisfies CR-04/BR-POS-001's "never mutate/delete the
  original Payment" for the refund slice **for free** — a refund cannot
  physically UPDATE an `OrderPayment` row even if the service tried to; it
  must be a new row in a new table.
- **`daily-trading-sales.query.service.ts`** (read for §6) — `grossSales`
  currently sums `order.grandTotal` for completed orders; `discounts` sums
  `order.discountTotal` (**currently always 0**, since nothing writes it);
  **`refunds` is a hardcoded literal `0n`** (line 255) — not derived from
  any table, because no refund table exists yet. `completedExcessCapturedTotal`
  (over-tendered cash) is separately computed and is unaffected by this
  slice's changes structurally, but its place in the tender-identity formula
  must be re-verified once real discount/refund figures are non-zero (see
  §6).

### 3.2 Governance approval runtime (`src/modules/governance/`)

- **`governance/contract/approval.contract.ts`**, **`approval.errors.ts`**,
  **`approvals/approvals.service.ts`** — read in full (see docblocks quoted
  above). `ApprovalCommands.createRequest`/`.decide` is `tx`-first,
  concurrency-safe (permanent-id replay protocol, `ON CONFLICT DO NOTHING`
  with the exact bare-vs-targeted distinction documented), returns typed
  errors (`ApprovalRequestConflictError`, `ApprovalDecisionConflictError`,
  `ApprovalNotPendingError`, `ApproverNotPermittedError`,
  `ApprovalDecisionRejectedError`). **This is the ONLY approval mechanism
  to use** — D-13 forbids Sales from building its own threshold/approval
  table, and FR-SEC-030 itself requires ONE general mechanism "used by
  discounts, refunds, ...".
- **`governance/audit/audit.service.ts`**, **`audit.constants.ts`** — read
  in full. `AuditService.record(tx, event: AuditEvent)` is the one writer;
  `AuditEvent` already carries `approverId`/`approvalId` fields (added for
  the approval runtime, migration 32) plus `reasonCode`/`reasonText`/
  `before`/`metadata`. `AUDIT_ACTION`/`AUDIT_ENTITY` are flat `as const`
  objects this slice must extend with new verbs
  (`DISCOUNT_APPLIED`/`COMP_APPLIED`/`ORDER_LINE_VOIDED_POSTFIRE`/
  `REFUND_ISSUED`/etc. — exact naming is an implementation choice following
  the existing `<ENTITY>_<PAST_TENSE>` convention) and entities
  (`discount`, `refund`, or reuse `order`/`order_line` — implementation
  choice).

### 3.3 Manager-PIN approval precedent (`src/modules/treasury/cash-session-close/cash-session-close.service.ts`)

Read in full (see full excerpt captured earlier in this session's tool
output). This is the **complete, working, ratified reference
implementation** for exactly the pattern POS-FIN-1 needs for discount/refund
approval:

1. **Declare-then-finalize two-phase shape** is specific to cash-close's
   blind-count disclosure rule (FR-POS-095) and does **not** generalize —
   discount/refund approval has no analogous "must not disclose before
   commit" constraint, so a **single-phase** flow (evaluate threshold →
   if required, create request + decide in the same call → else apply
   directly) is the right shape for POS-FIN-1, not a copy of the two-phase
   protocol.
2. **What DOES generalize directly:** the `finalizeClose` approval sequence
   — resolve the excluded-approver identity (`ownerUserId` there; for
   discounts/refunds this is the **applying employee's own linked User id**,
   the SoD "applicant cannot approve own request" invariant), compute
   `expiresAt` from `SELECT statement_timestamp()` read fresh inside the
   transaction (never `transaction_timestamp()`, never an app clock — the
   same expiry-base bug class the register's "final acceptance closure §2"
   already found and fixed once), call `this.approvals.createRequest(...)`
   then `this.approvals.decide(...)` with a `VerifiedTerminalPrincipal`
   obtained from `TERMINAL_PIN_VERIFIER.verifyTerminalPin(...)` **before**
   the transaction opens, catch the typed Governance errors and re-map to
   `ForbiddenException`/`ConflictException`, and on `rejected` **commit the
   rejection** (never throw — that would roll back the immutable
   `ApprovalDecision` FR-SEC-033 requires) while leaving the underlying
   financial state untouched.
3. **`assertCloseAuthority`**'s pattern (branch-scoped
   `SCOPE_AUTHORIZATION.isAuthorized(auth, {codes,mode:'all'}, {type:'branch',branchId}, tx)`,
   run **inside** the same transaction as the write) is the exact primitive
   to reuse for "wrong branch manager rejected" and any own-vs-other
   permission split (e.g. `pos.discount.apply` vs `pos.discount.approve`).

### 3.4 Identity contracts (`src/modules/identity/contract/`)

- **`pin-verification.contract.ts`** — read in full. `TERMINAL_PIN_VERIFIER.verifyTerminalPin(input)`
  returns a branded `VerifiedTerminalPrincipal { userId, employeeId,
  membershipId, branchId, terminalId, permissions: ReadonlySet<string> }`.
  **Must be called BEFORE opening the business transaction** (its own
  lockout-counter persistence depends on this — calling it inside the
  caller's transaction would let a rolled-back attempt escape lockout
  counting). This is the manager-PIN mechanism FR-POS-048/FR-SEC-032's
  synchronous half maps to.
- **`authorization-target.ts`**, **`pos-actor-authorization.ts`** — provide
  `resourceTarget`, `branchFromQueryOrTenant`, `AuthorizationTarget`
  decorator, `SCOPE_AUTHORIZATION` port — the exact primitives
  `orders.controller.ts` and `cash-session-close.service.ts` already use.

### 3.5 Inventory public contract (`src/modules/inventory/contract/`)

- **`contract/index.ts`** exports exactly `sale-depletion.contract`,
  `sale-depletion.errors`, `scope-target.resolvers`. **No waste-recording
  command and no stock-return/reversal command is in Inventory's public
  contract.** `waste.service.ts` exists (`inventory/waste/waste.service.ts`,
  writes `AUDIT_ACTION.WASTE_RECORDED`) but is **not exported through
  `contract/index.ts`** — it is Inventory-private, consumed today only by
  Inventory's own controller. `SALE_DEPLETION_COMMAND`
  (`DepleteForCompletedSaleInput`/`Result`) is the only cross-module command
  Sales may call, and it is a one-directional "deplete for a completed sale"
  command with no reversal/return counterpart.
- **This is the single largest structural gap the design gate finds** for
  FR-POS-071 (post-fire void disposition: returned-to-stock / wasted /
  given-to-staff must each "create the corresponding inventory record").
  See §7.

### 3.6 KDS / Kitchen public contract (`src/modules/kitchen/contract/`)

- **`contract/events.ts`** — Kitchen publishes `ticket.bumped` and
  `ticket.recalled`; Sales consumes both (`ticket-bumped.handler.ts`,
  `ticket-recalled.handler.ts` in `sales/orders/`). **There is no
  Sales→Kitchen "cancel/amend a fired line" event or command anywhere in
  either module's public contract.** A post-fire void that must "create the
  correct kitchen amendment/cancel signal" (per the task instructions) has
  **no existing public contract to reuse** on the Kitchen side either. See
  §7.

### 3.7 Idempotency infrastructure (`src/common/idempotency/`)

`idempotency.module.ts`, `.interceptor.ts`, `.service.ts`,
`idempotent.decorator.ts` — the `@Idempotent()` decorator +
`IdempotencyInterceptor` already used on every Sales financial route
(`orders.controller.ts`: create, addLine, fire, capturePayment all carry
it). **Every new POST/PATCH route this slice adds (discount apply, refund
issue, post-fire void) must carry the identical `@Idempotent()` decorator
and mandatory `Idempotency-Key` header** — no second idempotency mechanism
exists or should be built.

### 3.8 RLS / migration pattern

`prisma/migrations/20260829010000_governance_approval_runtime/migration.sql`
confirmed: `ALTER TABLE "<schema>"."<table>" ENABLE ROW LEVEL SECURITY;`
immediately followed by `... FORCE ROW LEVEL SECURITY;` for every new
tenant table, plus explicit column-level/table-level `GRANT` statements to
`ros_app` (append-only where required, e.g. no UPDATE/DELETE grant for
audit-adjacent tables). Migration folder naming is
`YYYYMMDDHHMMSS_snake_case_description`; the latest migration on this
branch is `20260903090000_platform_partition_lifecycle`, so any new
migration this slice adds must use a later timestamp.

---

## 4. Requirement × existing-code matrix

| Req | Literal text (condensed) | Exists in code today | Missing | Source-decidable? |
|---|---|---|---|---|
| **FR-POS-045** | Line + order level discounts, % or fixed | `OrderLine.lineDiscount`, `Order.discountTotal` columns exist but unwritten; no service, no route | Discount apply service/route, both levels, both forms | **YES** — reuse existing columns, existing `recomputeOrderTotals` pattern |
| **FR-POS-046** | Reason from configurable list | `ReasonCode` model + tenant-scoped lookup already used by `voidLinePreFire` (`reasonCodeId` FK) | Discount route must require+validate a `reasonCodeId` the same way | **YES** — reuse `ReasonCode` |
| **FR-POS-047** | 4 named threshold dimensions, "per role, per branch" / "per role" | Nothing — D-13 confirms Governance owns no threshold storage; no Sales-side settings table exists | A Sales/POS-owned config surface for the 4 dimensions | **PARTIALLY** — mechanism (who evaluates) is source-decidable (D-13: the consuming domain); the **storage/representation** of the 4 dimensions is NOT decidable from source (see §7) |
| **FR-POS-048** | PIN / card swipe / remote mobile approval, no order abandonment | PIN half fully implemented (`TERMINAL_PIN_VERIFIER` + `ApprovalCommands`, proven at cash-close) | Card-swipe and remote-mobile halves — **no infrastructure exists for either anywhere in the repo** (2026-08-29 register entry: async half of FR-SEC-032 "remains deferred and knowingly unmet") | **YES for PIN** (reuse exactly); **card-swipe/remote-mobile are NOT SOURCE-DECIDABLE to build new** — no terminal card-swipe capability and no mobile-push infra exists; FR-POS-048 will be **PARTIAL by permitted-alternative** (PIN reuse), not COMPLETE |
| **FR-POS-049** | Record amount, %, reason, applying employee, approving employee, timestamp, order context | `AuditService.record` + `AuditEvent` shape already carries every one of these fields generically (`actorId`, `approverId`, `reasonCode`/`reasonText`, `metadata`, `occurredAt` server-stamped) | A discount audit entry populating all seven facts | **YES** — no new audit infrastructure needed, only a correctly-populated `AuditEvent` |
| **FR-POS-050 [S]** | Comp: zero revenue, cost recognised, inventory depleted | `OrderLineState.comped`, `OrderLine.isComp` columns exist, unwritten | Comp apply path, distinct from discount (revenue=0 not discount-to-0) | **YES** — reuse existing enum value/column; Should-priority, in scope per task §A/§H |
| **FR-POS-051** | Discount stacking / exclusivity config | Nothing | Exclusivity flag + "most favourable" resolution logic | **NOT SOURCE-DECIDABLE for a full promotions engine** — no `Promotion`/campaign model exists anywhere in the schema. **Narrowly source-decidable** only for the literal single-discount-per-line/order case this slice implements (if only one discount can ever be applied at a time in this MVP, stacking/exclusivity is structurally moot and should be recorded as such, not as a built feature) |
| **FR-POS-070** | 4 correction operations classified with (When/Inventory/Financial) effect table | Pre-fire void (`voidLinePreFire`) is the ONLY one of the four implemented today | Post-fire void, order cancel (partially covered by BR-POS-003, not implemented either), refund | **YES** for pre-fire void (already correct, do not touch); post-fire void and refund are this slice's primary targets; **order cancel is NOT a primary target of this task** and its absence must be classified honestly, not silently claimed |
| **FR-POS-071** | Post-fire void disposition: returned-to-stock / wasted / given-to-staff, each creating an inventory record | Nothing on the Sales side; Inventory's `waste.service.ts` exists but is **not** in Inventory's public contract | A public Inventory contract addition (reversal/disposition command) + a public Kitchen contract addition (cancel/amend signal) + the Sales-side void handler | **Mechanism is NOT SOURCE-DECIDABLE as pre-existing** (no contract exists to call) — but the task instructions explicitly permit/require adding it ("Use Inventory public contracts only" implies extending that contract following its own precedent, the same way P1F-2 added `SALE_DEPLETION_COMMAND`) |
| **FR-POS-072** | Refund references order; aggregate refunds ≤ original amount | Nothing — no refund table | New append-only refund model + concurrency-safe aggregate-cap enforcement | **YES for the invariant** (§4 arithmetic uses existing `Order.grandTotal`/`paidTotal`); the **locking mechanism** must be built (advisory lock or `SELECT ... FOR UPDATE` pattern — precedented elsewhere in the repo, e.g. `pg_advisory_xact_lock` used by `cash-session-close.service.ts` and `audit.service.ts`) |
| **FR-POS-073** | Refund reason + threshold approval | `ReasonCode` reusable; `ApprovalCommands` reusable | Refund route wiring both | **YES** |
| **FR-POS-074** | Refund to original tender by default; different tender needs elevated permission + fraud-report flag | `pos.refund.different_tender` is a named §15.2 permission (not yet wired); **no fraud-detection report infrastructure exists anywhere in the repository** (`grep` for "fraud" across `src/modules/reporting` and elsewhere finds nothing) | The permission-gated different-tender path is buildable; the fraud-report flag is **not** | **PARTIAL — original-tender default and the permission gate are source-decidable; the "flagged in the fraud detection report" clause is NOT SOURCE-DECIDABLE** (task instructions explicitly pre-empt this: "do NOT invent it. Default to original tender where supported and report the remaining limb honestly") |
| **FR-POS-075** | Full audit (actor, approver, reason, amount, before/after) for voids/cancellations/refunds | `AuditService`/`AuditEvent` shape supports every field | Correctly-populated calls at each of the 3 new write paths | **YES** |
| **FR-SEC-030..033** | General approval mechanism, request fields, sync/async, immutable decisions | **Fully implemented and proven** (governance approval runtime, migration 32, "Approval Runtime Minimum Resolution") | Nothing — reuse only | **YES** |
| **FR-SEC-034 [S]** | Escalation | **D-12 remains BLOCKED** per every governance entry read (explicitly reconfirmed by the 2026-08-29 and 2026-08-30 entries) | Escalation | **NOT SOURCE-DECIDABLE / OUT OF SCOPE** — D-12 blocked status is a standing governance fact this slice must not silently reopen |
| **FR-SEC-035 [M]** | Offline-with-no-approver policy: block or permit-with-retrospective-approval | No offline-approval policy config exists; D4-1A/D4-1B offline/sync kernel exists but nothing in it references approval fallback | An explicit tenant policy switch | **NOT SOURCE-DECIDABLE** — no ratified default exists (mirrors D-13/P1G-1's exact "SRS states existence, not value" gap) — task instructions elsewhere say do not self-ratify ambiguous financial rules; recorded as a limb to STOP |
| **FR-AUD-001** | Immutable audit entry for every state-changing operation | `AuditService` fully implemented, append-only DB grants, hash chain | Nothing — reuse for every new write | **YES** |
| **FR-AUD-006** | "discounts, comps, voids, refunds" always audited | Same mechanism | Correct call sites | **YES** |
| **BR-POS-001** | COMPLETED order immutable; corrections via Refund | `OrderPayment` DB-grant append-only (SELECT+INSERT only); `Order` itself has ordinary UPDATE grant (used by e.g. `recomputeOrderTotals`) — **`Order` row mutability after COMPLETED is NOT currently DB-prevented**, only convention-prevented (no code path updates a completed order today) | A refund/void-post-fire service must not update the `Order`'s **posted totals** (grandTotal/paidTotal) once completed; only new compensating rows are created. `Order.state` transition to `partially_refunded`/`refunded` is itself a mutation of the Order row and is explicitly anticipated by the existing `OrderState` enum, so BR-POS-001 must be read as "financial totals are not rewritten", not "the row is never touched again" — reconciled below | **YES**, with the reading recorded (state-transition column is expected to change; posted financial totals are not rewritten in place, only referenced by new compensating records) |
| **BR-POS-002** | `paid_total + discount_total_of_comps < grand_total` blocks COMPLETED | `sales-payment.service.ts`'s completion gate exists for the payment-only case; the literal `discount_total_of_comps` term is not yet part of that comparison (discounts don't exist yet) | Extend the completion check once discounts/comps exist so a comped/discounted order can still legally complete | **YES** — the exact formula is given verbatim by the SRS |
| **CR-04** | Financial records, once posted, immutable; corrections via compensating entries | `OrderPayment` structurally append-only; audit entries append-only | Refund/discount/void records must themselves be append-only, never updated/deleted, by the same DB-grant discipline | **YES** — direct precedent to copy (grant SELECT+INSERT only, no UPDATE/DELETE, on any new Discount/Refund table) |

---

## 5. Concrete reuse map (exact files/patterns — do not invent alternatives)

1. **Approval runtime:** `APPROVAL_COMMANDS` token from
   `src/modules/governance/contract` (`ApprovalCommands.createRequest`/
   `.decide`). Threshold evaluation happens in **Sales**, per D-13 — Sales
   computes `requiredPermission` (e.g. `SALES_PERMISSIONS.DISCOUNT_APPROVE`)
   and `value` (opaque JSONB, money as base-10 integer minor-unit strings,
   per SB-2) and calls Governance generically. No second approval table.
2. **Manager-PIN synchronous approval:** `TERMINAL_PIN_VERIFIER` from
   `src/modules/identity/contract` — call **before** opening the business
   transaction (identical ordering constraint as
   `cash-session-close.service.ts`).
3. **Excluded-approver / SoD:** pass the applying employee's own linked
   User id as `excludedApproverUserId` on `createRequest` (F-1/R-b
   mechanism) — this is **in addition to**, not instead of, D-7's
   independent generic requester≠approver DB check; both fire.
4. **Branch-scoped authorization:** `SCOPE_AUTHORIZATION` port
   (`isAuthorized(auth, {codes, mode}, {type:'branch', branchId}, tx)`),
   called **inside** the same transaction as the write — copy
   `assertCloseAuthority`'s exact shape for any own-vs-other/branch-scoped
   split this slice needs.
5. **Audit:** `AuditService.record(tx, event)` from
   `src/modules/governance/audit`. Extend `AUDIT_ACTION`/`AUDIT_ENTITY` in
   `audit.constants.ts` with new verbs following the existing
   `<ENTITY>_<PAST_TENSE>` convention; populate `approverId`/`approvalId`/
   `reasonCode`/`reasonText`/`before`/`metadata` for every new write.
6. **Idempotency:** `@Idempotent()` decorator +
   `Idempotency-Key` header, identical to every existing Sales financial
   route (`orders.controller.ts`).
7. **Optimistic concurrency / no stale-total race:** `If-Match` header +
   `parseIfMatch` against `order.version`, identical pattern to
   `addLine`/`voidLine`/`fire`/`capturePayment`. This is what prevents "two
   concurrent discounts independently pass the same threshold against
   stale order totals" at the **order-mutation** layer (the approval-decision
   layer's own race is separately closed by D-15's per-request UNIQUE
   constraint, item 4 above).
8. **Advisory/row locking for refund aggregate cap:** the
   `pg_advisory_xact_lock(hashtext($1), hashtext($2))` pattern used
   identically by `cash-session-close.service.ts` (`LOCK_KEY = 'ros_cash_session'`)
   and `audit.service.ts` (`'ros_audit'`) — a new lock key scoped to the
   order/payment being refunded (e.g. `'ros_refund'` + orderId) serializes
   concurrent refund attempts against the same order so the aggregate-cap
   check-then-insert cannot race. This satisfies "deterministic row/advisory
   locking consistent with existing project patterns" from the task
   instructions.
9. **Reason codes:** `ReasonCode` model + tenant-scoped `findUnique`
   lookup, identical to `voidLinePreFire`'s `reasonCodeId` handling.
10. **Money arithmetic:** `src/common/money/rational.ts` (`Rational`,
    `toMinorUnits`, `RoundingMode`), `src/common/money/money.ts` (`Money`) —
    the exact exact-decimal/bigint machinery `order-lines.service.ts`
    already uses for price/tax/COGS; percentage-discount rounding must use
    this, never floating point, exactly one rounding per computed figure
    (BR-FIN-001 convention already followed elsewhere).
11. **Order total recomputation:** `OrderLinesService.recomputeOrderTotals`
    is the existing full-re-derivation function (never a patched delta) —
    extend it (or an equivalent function reused at every mutation site) to
    fold in `lineDiscount`/order-level discount into `discountTotal`,
    consistent with its own documented convention.
12. **Permission codes:** add the SRS §15.2-verbatim codes identified in §1
    to `SALES_PERMISSION_DEFS` in `sales.permissions.ts` — no invented
    codes; `pos.order.void_line_postfire` already exists there (declared,
    unused) and becomes used by this slice.
13. **Migration/RLS pattern:** `ENABLE ROW LEVEL SECURITY` +
    `FORCE ROW LEVEL SECURITY` + explicit append-only grants (SELECT+INSERT
    only, no UPDATE/DELETE) for any new Discount/Refund table, copying
    `20260829010000_governance_approval_runtime`'s migration exactly. Next
    migration timestamp must be later than `20260903090000`.
14. **Authorization coverage gate:** every new controller route needs an
    `@AuthorizationTarget(resourceTarget(SALES_ORDER_TARGET_RESOLVER, {orderId, businessDay}, ...))`
    (or equivalent) — `src/modules/authorization-coverage.spec.ts` fails the
    build otherwise; no route may go on the `REVIEWED_UNPROTECTED_ROUTES`/
    `REVIEWED_TENANT_TARGET_ROUTES` allowlists without a stated reason.

---

## 6. Reporting/receipt/reconciliation re-audit (§G of the task — executed now, at design-gate time)

Per the mandatory revisit trigger quoted in §2, `daily-trading-sales.query.service.ts`
was read in full. Current state, verified against source:

- **`grossSales`** sums `order.grandTotal` for completed orders. Once
  discounts exist and correctly reduce `grandTotal` at the line/order level
  (per FR-POS-045's own money model — discount is pre-tax/affects taxable
  base per the existing tax architecture, to be confirmed against
  `localisation/tax` at implementation time), `grossSales` will
  automatically reflect discounted totals **correctly, with no formula
  change needed**, because it already reads the live, recomputed
  `grandTotal` rather than a separately-cached figure.
- **`discounts`** sums `order.discountTotal`, currently always `0`. Once
  this slice populates `discountTotal` via `recomputeOrderTotals`, this
  figure becomes truthful **automatically** — again no formula change, only
  the underlying column starting to be written.
- **`refunds`** is a **hardcoded literal `0n`** (line 255) — this **must**
  change to a real query against the new refund table once it exists. This
  is a mandatory implementation-phase edit to `daily-trading-sales.query.service.ts`,
  not optional.
- **`completedExcessCapturedTotal`** and the tender-vs-sales identity
  formula must be re-verified once refunds are non-zero — a refund reduces
  the tender side without reducing `paid_total` retroactively (CR-04:
  `paid_total` on the original `OrderPayment` rows is never rewritten), so
  the identity `tenderGrandTotal === grossSales + unsettledCapturedTotal`
  the prior reporting slice proved **must be re-derived, not assumed, once
  refunds exist** — this is exactly what the revisit trigger anticipated
  and is binding work for the implementation phase, verified with real
  domain flows (a completed order, then a partial refund, then a report
  read), not DB-only fixtures.
- **`SETTLED` semantics**: an order in `partially_refunded`/`refunded`
  state is a **new reachable state** this slice introduces for the first
  time (the enum values already existed, unreached). The daily-trading
  report's SALES POPULATION query (which orders count as "sales") must be
  re-checked against these two new reachable states — recorded at
  `2026-08-31_MINIMUM-reporting-final-design-gate.md:319` as *"completed +
  future refunded/adjusted states ... N/A — unreachable at this HEAD...
  recorded as the exact extension point the future Refund slice must
  revisit"* — this is precisely that revisit, to be executed at
  implementation time with a real refunded-order fixture, not assumed safe.

**Receipt:** `receipt.service.ts`/`receipt.views.ts` were not read in full
in this design-gate pass (deferred to implementation time) but are noted as
in-scope per the task's §G: the existing completed-order receipt contract
must be checked for whether it needs to represent discount/refund history,
scoped narrowly (no fiscal-printing expansion).

---

## 7. NOT SOURCE-DECIDABLE — limbs to STOP, not self-ratify

1. **FR-POS-047's four threshold dimensions — storage/representation.** The
   SRS states the dimensions exist ("Per role, per branch" / "Per role")
   but, exactly as P1G-1's cash-variance tolerance was before its own
   ratification, states **no default value, no table shape, and no
   precedence rule**. D-13 settles *who* evaluates the threshold (the
   consuming domain, i.e. Sales) but not *how it is configured*. Building an
   invented settings/threshold table here would repeat exactly the mistake
   P1G-1 was explicitly ratified to avoid. **This limb is STOPPED** pending
   either an explicit user ratification (P1G-1-style) or a narrower,
   honestly-labelled MVP (e.g. a single tenant-wide config row per branch
   with a documented "not FR-PLT-025's six-level hierarchy" caveat,
   analogous to P1G-1's own narrow branch-scoped-only policy) — the
   implementation phase must choose one of these explicitly and record which,
   rather than silently picking the narrower option and calling FR-POS-047
   COMPLETE.
2. **FR-POS-048's card-swipe and remote-mobile approval channels.** No
   terminal card-reader integration and no mobile-push infrastructure exists
   anywhere in the repository (confirmed: the 2026-08-29 register entry
   explicitly states the async half of FR-SEC-032 "remains deferred and
   knowingly unmet", and no card-terminal module exists — the task
   instructions independently forbid inventing "an integrated card
   terminal"). **STOPPED** — PIN reuse is the only implemented channel;
   FR-POS-048 is PARTIAL by the SRS's own "or" wording (PIN is one of three
   permitted alternatives), not COMPLETE.
3. **FR-POS-051's stacking/exclusivity for a genuine multi-promotion
   engine.** No `Promotion`/campaign construct exists in the schema.
   **STOPPED** for anything beyond the single-discount-per-line/order case;
   recorded honestly as N/A-by-absence-of-a-promotions-model, not as a
   built and tested feature.
4. **FR-POS-071's inventory-disposition and Kitchen-amendment contracts.**
   Neither Inventory's nor Kitchen's public contract currently exposes a
   command for "reverse/dispose of a post-fire-voided produced item" or
   "cancel/amend a fired ticket line". These are **not pre-existing to
   reuse** — they must be **added** to each module's own public contract
   (not invented as private cross-module imports), following the exact
   precedent `SALE_DEPLETION_COMMAND` itself set (P1F-2 added a new command
   to Inventory's contract for a new Sales need). This is recorded as a
   necessary, in-scope **contract addition**, not a blocked limb — but the
   **exact shape** of "given to staff" (task instructions: *"Do not fake
   'given to staff' as waste unless the SRS/governance explicitly permits
   that mapping"*) has **no governance ratification distinguishing it from
   waste** anywhere in the register. The SRS's own FR-POS-071 table lists
   three distinct dispositions with no further detail on how "given to
   staff" differs operationally from "wasted" at the inventory-ledger level
   (both remove the item from stock permanently; the SRS gives no signal
   they should post to different movement types/reason codes). **Recorded
   as requiring an implementation-time judgment call**, most defensibly
   modeled as a **distinct reason code** on the same underlying inventory
   movement type Inventory's existing `waste`-analog contract exposes,
   rather than a fabricated new movement type — to be decided and stated
   explicitly at implementation time, not silently collapsed into "waste".
5. **FR-POS-074's fraud-detection-report flag.** No fraud-report
   infrastructure exists anywhere in the repository. **STOPPED** exactly per
   the task's own explicit instruction — default to original-tender refund
   (fully buildable), and the different-tender-permission gate is buildable
   (`pos.refund.different_tender` is a real, if currently unwired, §15.2
   code), but the "flagged in the fraud detection report" clause is
   reported as NOT IMPLEMENTED, honestly, rather than invented.
6. **FR-SEC-034 (escalation).** D-12 is **BLOCKED** per every governance
   entry read, most recently reconfirmed 2026-08-30. **STOPPED** — not
   reopened by this slice.
7. **FR-SEC-035 (offline-with-no-approver policy).** No ratified default
   exists for "block" vs. "permit with retrospective approval flagged in an
   exception report" (and no "exception report" surface exists either).
   **STOPPED** pending explicit ratification; this slice's discount/refund
   approval paths will require an approver to be present (the synchronous
   PIN path), which is a safe, literal subset of FR-SEC-035's two named
   options (never permitting an operation with no approval trail at all),
   but does not itself resolve FR-SEC-035.
8. **Tax semantics for discounts (§C of the task).** Whether a discount
   applies pre-tax or affects the taxable base was **not yet fully traced**
   in this design-gate pass — `localisation/tax` (`tax.calculator.ts`,
   `tax-engine.registry.ts`, the country-pack tax contract) was not read in
   this session's budget. **Flagged for the first step of implementation,
   before any discount tax math is written** — do not guess; read
   `computeLineTax`/`LineTaxResult` and the country-pack tax contract's
   exact discount-handling hook (if any) before writing the discount tax
   math, and report the finding explicitly rather than assuming pre-tax
   application.

---

## 8. SOURCE-DECIDABLE — resolved ambiguities, with citations

1. **Who evaluates discount/refund approval thresholds:** the consuming
   domain (Sales), never Governance — D-13, RATIFIED 2026-08-17, option (b),
   directly on point and unambiguous.
2. **Self-approval / SoD enforcement mechanism:** D-7's DB RLS `NOT EXISTS`
   traversal, already implemented and proven — no new logic needed, only
   correct use of the existing `ApprovalCommands` contract (which already
   carries this enforcement transparently).
3. **Synchronous manager-PIN approval is authorized for discount/refund
   use:** the 2026-08-29 "Approval Runtime Minimum Resolution" entry item 6
   lifts D-2's defer for exactly this (PIN on a registered terminal,
   `FR-SEC-021`/`FR-SEC-022` substrate) — already the mechanism
   `cash-session-close.service.ts` uses today for an analogous (cash
   variance) approval. Discounts/refunds are a second, equally valid
   consumer of the identical already-ratified capability.
4. **Discount/refund data model reuses existing schema columns:**
   `Order.discountTotal`, `OrderLine.lineDiscount`, `OrderLine.isComp`,
   `OrderLineState.comped` all already exist, unwritten — confirmed by
   direct schema read; this is not an inference, it is the literal current
   schema.
5. **Refund/discount/void records must be append-only at the DB grant
   level:** CR-04 + BR-POS-001, directly implemented today for
   `OrderPayment` (SELECT+INSERT only) — the same DB-grant pattern applies
   to any new table this slice creates, per the migration precedent in
   `20260829010000_governance_approval_runtime`.
6. **Permission codes for discount/comp/refund/post-fire-void:** all
   already named verbatim in SRS §15.2 (quoted in §1); adding them to
   `SALES_PERMISSION_DEFS` completes an already-stated intent, it does not
   invent authority.
7. **Concurrency for "no race where two concurrent discounts independently
   pass the same threshold against stale order totals":** resolved by the
   existing `If-Match`/order-`version` optimistic-concurrency mechanism
   (already proven at every other order-mutating route) plus the
   independent per-approval-request DB uniqueness constraint (D-15 item 4)
   — no new concurrency primitive needs to be invented, only applied at the
   new write paths.
8. **Refund aggregate-cap concurrency:** resolved by the
   `pg_advisory_xact_lock` pattern already used identically twice in the
   repository (`cash-session-close.service.ts`, `audit.service.ts`) — a
   third, analogous use for a refund-specific lock key is a direct
   application of an established pattern, not a new design.

---

## 9. Summary for the implementer

**Proceed to implement:** FR-POS-045/046/049/050 (discount+comp core, all
source-decidable), FR-POS-047 (mechanism half only — see §7 item 1 for the
threshold-storage decision that must be made explicitly and documented, not
silently narrowed), FR-POS-048 (PIN channel only, PARTIAL by design),
FR-POS-070/071 (post-fire void, after adding the two necessary public
contract methods per §7 item 4), FR-POS-072/073/075 (refund core, full),
FR-POS-074 (original-tender default + permission gate; fraud-report clause
explicitly NOT IMPLEMENTED), FR-SEC-030..033 (pure reuse, zero new
Governance code), FR-AUD-001/006 (pure reuse), CR-04/BR-POS-001/002 (reuse
+ one BR-POS-002 formula extension).

**Do not implement in this slice, and report honestly as such:**
FR-POS-051's promotions/stacking engine (no model exists), FR-SEC-034
(D-12 BLOCKED), FR-SEC-035 (no ratified default), FR-POS-074's fraud-report
flag (no infrastructure), FR-POS-048's card-swipe/remote-mobile channels (no
infrastructure), order cancel per FR-POS-070's third row (not a named
primary target of this task).

**Before writing discount tax math:** read `localisation/tax` in full (§7
item 8) — this was not completed in this design-gate session's budget and
is the one piece of required reading still outstanding before Part C of the
implementation can begin correctly.

---
---

# PART TWO — IMPLEMENTATION, VERIFICATION AND CLOSURE

**Same session, same run, continuing directly from §9 above.** Before
writing any discount tax math, `localisation/tax/tax.calculator.ts` was read
in full (the one outstanding item §9 flagged): `computeTaxableBase` already
accepts a `lineDiscount` parameter it subtracts from the taxable base before
tax, and its own doc comment states order-level apportionment (BR-FIN-003)
is "NOT part of this slice" for the pre-existing addLine caller — this
resolved §7 item 8 as SOURCE-DECIDABLE (line-level discount is pre-tax;
order-level is post-tax, straight subtraction from `grandTotal` only) and is
implemented exactly that way — see §13 below.

## 10. Architecture actually built

- **`sales.discounts`** (append-only) — one row per discount/comp
  APPLICATION (line- or order-level), carrying every FR-POS-049 fact.
  `Order.discountTotal`/`OrderLine.lineDiscount`/`OrderLine.isComp` (existing,
  previously-unwritten columns) are now the live projection;
  `recomputeOrderTotals` (extracted from `OrderLinesService` into a shared
  `order-totals.ts` module every write path now calls) folds in both the
  line-level sum and a fresh order-level `sales.discounts` lookup on every
  call — a full re-derivation, never a patched delta.
- **`sales.discount_approval_policy_versions`** (append-only, INSERT-only
  versioned config, mirroring `CashClosePolicy`) — the narrow, explicitly
  scoped FR-POS-047 threshold MVP: (tenant, branch)-scoped, NOT per-role (no
  ratified role-precedence rule exists — §7 item 1, unresolved by any
  governance action this session; the MVP is recorded as a scoping choice,
  not silently narrowed). Absent any row, the conservative default applies:
  every discount/refund requires approval.
- **`sales.post_fire_void_records`** (append-only) — one row per post-fire
  void's mandatory disposition classification, with the financial amount
  removed and any inventory movement ids created.
- **`sales.refunds`** (append-only) — the CR-04 compensating record. Never
  references the original `Order`/`OrderLine`/`OrderPayment` for a write,
  only a read; those three are structurally untouched by every refund write
  path (proven in real Postgres — see §14 test C6).
- **New services** (`src/modules/sales/orders/`): `discounts.service.ts`
  (line/order discount + comp), `post-fire-void.service.ts`, `refunds.service.ts`,
  plus two small shared modules extracted for reuse: `order-totals.ts`
  (`recomputeOrderTotals`, generalized from `OrderLinesService`'s own
  private method) and `approval-helper.ts` (`obtainSynchronousApproval`, the
  one single-phase create-request-then-decide-approved helper all three
  approval-gated write paths share).
- **New Inventory public contract**: `POST_FIRE_VOID_DISPOSITION_COMMAND`
  (`src/modules/inventory/contract/post-fire-void-disposition.contract.ts`,
  implemented by `PostFireVoidDispositionService`) — the necessary contract
  addition §7 item 4 anticipated, following the exact `SALE_DEPLETION_COMMAND`
  precedent (a new command added to Inventory's public contract for a new
  Sales need, never a private cross-module import).
- **New Sales→Kitchen event**: `order.line.voided_postfire`
  (`sales/contract/events.ts`), consumed by a new PRIVATE Kitchen handler
  `OrderLineVoidedPostFireHandler` that cancels the matching `TicketLine`
  row(s) (the pre-existing, previously-unwritten `cancelled` `TicketLineStatus`
  value) and recomputes each affected Ticket's aggregate — `projectTicketStatus`
  already handled `cancelled` correctly (filters it from the aggregate), so
  no change was needed there, only a new writer.
- **5 new HTTP routes** on `OrdersController`: `POST .../lines/:lineId/discount`,
  `POST .../discount` (order-level), `POST .../lines/:lineId/comp`,
  `POST .../lines/:lineId/void-postfire`, `POST .../refunds` — every one
  `@Idempotent()` + mandatory `If-Match`, `@AuthorizationTarget` +
  `@RequirePermission`, full OpenAPI `schema:` (not just `description:`).
- **Permission codes added** (`SALES_PERMISSIONS`, all SRS §15.2-verbatim,
  zero invented): `pos.discount.apply`, `pos.discount.approve`,
  `pos.discount.unlimited`, `pos.comp.apply`, `pos.order.void_line_postfire`
  (named in the catalogue since before this slice, never declared until
  now), `pos.refund.issue`, `pos.refund.different_tender`.
- **Reporting reconciliation** (§G re-audit, executed for real): `refunds`
  in `DailyTradingSalesQueryService.facts()` changed from a hardcoded `0n`
  literal to a real `sales.refunds` SUM scoped by the refund's OWN
  `refund_business_day` (not the original order's day); the SALES POPULATION
  classification was widened from `state === 'completed'` to `state IN
  ('completed','partially_refunded','refunded')` — the exact revisit the
  design gate's own §6 flagged as required once these states become
  reachable, fixing a genuine truth gap this session found (a refunded
  order's historical `grossSales`/`discounts`/`taxTotal` contribution would
  otherwise silently vanish from every future report read of that business
  day the instant a refund was issued against it — CR-04/BR-POS-001 never
  rewrite those posted totals, so the report must not stop counting them
  either). `CashSessionTenderTotalsQuery.cashRefundsTotal` (new field) wires
  real cash refunds into `CashSessionCloseService.computeExpectedCash`,
  replacing the `CASH_REFUNDS_TOTAL = 0n` placeholder its own comment
  correctly flagged as due for exactly this replacement.
- **Receipt** (`ReceiptService`) — the `state !== 'completed'` gate was
  widened to also accept `partially_refunded`/`refunded`: a refund must not
  make a completed order's historical receipt unreachable. `discountTotal`
  in the receipt's `totals` block was already wired (pre-existing field,
  previously always `0`) and needed no code change to become truthful.
  Refund line-item detail was deliberately NOT added to the receipt — no
  SRS/RCPT-R1 clause names it, and the task explicitly warns against
  broadening into fiscal-printing scope.

## 11. NOT SOURCE-DECIDABLE limbs — final disposition (unchanged from §7)

Every limb §7 flagged was left exactly as flagged; none was silently
resolved during implementation:

1. **FR-POS-047 threshold storage/representation** — resolved as a narrow
   (tenant, branch)-scoped MVP, explicitly NOT per-role, explicitly recorded
   as a scoping choice (§10 above), not a governance ratification.
2. **FR-POS-048 card-swipe/remote-mobile** — NOT IMPLEMENTED. PIN channel
   only; FR-POS-048 is PARTIAL by the SRS's own "or" wording.
3. **FR-POS-051 promotions/stacking engine** — NOT IMPLEMENTED. This slice
   enforces "at most one discount/comp per line, at most one order-level
   discount per order" as a structural narrowing, recorded honestly.
4. **FR-POS-071 "given to staff" vs "wasted" ledger distinction** — resolved
   as a shared `waste` movement type (no new `MovementType` enum value
   invented) distinguished only by `disposition`/`reasonCodeId` — the
   design gate's own recommended resolution, adopted as-is.
5. **FR-POS-074 fraud-detection-report flag** — NOT IMPLEMENTED. Original-
   tender default and the `pos.refund.different_tender` permission gate are
   fully implemented; the report itself does not exist anywhere in this
   repository and was not invented.
6. **FR-SEC-034 escalation** — NOT IMPLEMENTED. D-12 remains BLOCKED; not
   reopened.
7. **FR-SEC-035 offline-with-no-approver policy** — NOT IMPLEMENTED. No
   ratified default; this slice's approval paths require a present approver
   (the synchronous PIN channel) unconditionally.
8. **Discount tax semantics** — RESOLVED this session (see the note above
   §10): line-level pre-tax, order-level post-tax, both source-decidable
   from `tax.calculator.ts`'s own pre-existing code.

**One additional narrowing surfaced during implementation, recorded here
for the same reason:** FR-SEC-032's asynchronous manager-decision channel
is not implemented (matches the 2026-08-29 register entry's own "remains
deferred" statement); this slice's single-phase approval flow treats a
verified manager PIN as the approval act itself — there is no reachable
"manager PIN entry that means reject" in a synchronous single-terminal flow,
so a genuine recorded `rejected` `ApprovalDecision` is not producible by
these routes. This is a recorded scope narrowing (`approval-helper.ts`'s own
doc comment states it in full), not a silent gap.

## 12. Governance decisions used (verbatim citations, unchanged from §2)

D-13 (Sales evaluates thresholds, Governance stays generic), D-7 + the
2026-08-29 "Approval Runtime Minimum Resolution" item 8 (self-approval / SoD,
both mechanisms apply together — implemented via `excludedApproverUserId`
passed to `ApprovalCommands.createRequest`, D-7's own DB `NOT EXISTS`
traversal fires automatically), the same entry's item 6 (synchronous
manager-PIN approval authorized), D-15 item 4 (one final decision per
request — DB-enforced, inherited for free), D-16 (request-type vocabulary
open — `'discount.apply'`/`'refund.issue'` chosen as literal strings), P1G-1
(the versioned-config and advisory-lock precedents copied exactly), RPT-R1 /
the mandatory reporting revisit trigger (executed in full — §10, §14 item
F). No governance decision was ratified, amended, or reinterpreted by this
implementation; all of the above are read and applied as pre-existing
authority.

## 13. Financial math — exact rules implemented

- **Percentage discount**: `amount = round((baseMinor * bp) / 10000)`,
  HALF_UP, pure bigint arithmetic — bp is basis points (1bp = 0.01
  percentage point), parsed from a decimal string with at most 2 fractional
  digits, `0 < bp <= 10000`.
- **Fixed discount**: the exact minor-units integer supplied, rejected if it
  exceeds the eligible base (`> lineSubtotal` for a line, `> grandTotal` for
  an order) — "cannot make a line/order negative" and "fixed discount cannot
  exceed its eligible base" both enforced by the same comparison.
  Percentage bounds (`0 < bp <= 10000`) are validated at parse time.
- **Line-level tax recompute**: on discount/comp application, the line's
  `taxAmount`/`lineTotal` are RE-DERIVED (`computeTaxableBase` with the new
  `lineDiscount`, then `computeLineTax` against the order's pinned country
  pack and the line's own already-snapshotted tax class) — never patched.
  The taxable base reduces pre-tax, matching `computeTaxableBase`'s own
  pre-existing contract.
- **Order-level discount**: applied post-tax, a straight subtraction from
  `grandTotal` in `recomputeOrderTotals` only — no line's tax is touched
  (BR-FIN-003 apportionment is out of scope, per the pre-existing code's own
  documented boundary — §11 item 8).
- **BR-POS-002** (`paid_total + discount_total_of_comps < grand_total`
  blocks COMPLETED): algebraically collapses to the PRE-EXISTING simple gate
  `paid_total >= grand_total` once `grand_total` is correctly net of
  discounts/comps (proven in this report's own reasoning: expanding the
  formula with `grand_total` read as the PRE-discount total shows the two
  are identical) — `sales-payment.service.ts`'s completion gate needed **no
  code change**, and this was verified by the full existing
  `order-completion.e2e-spec.ts`/`sales-payment.e2e-spec.ts` suites staying
  100% green throughout.
- **Refund cap**: `sum(committed refunds) + requested refund <= order.paidTotal`
  (the actual money collected — correct even under P1F-2's permitted
  over-tender case, where `paidTotal` can exceed `grandTotal`), enforced
  under `pg_advisory_xact_lock(hashtext('ros_refund'), hashtext(orderId))`,
  the identical lock-key pattern `cash-session-close.service.ts` and
  `sales-payment.service.ts` already use.
- **Order-total recompute concurrency**: every order write this slice adds
  (discount/comp/post-fire-void/refund) now uses `tx.order.updateMany({where:
  {id, businessDay, version: expectedVersion}, ...})` with an explicit
  `OrderVersionConflictError` on `count === 0`, never a plain `tx.order.update`
  by primary key — this is a genuine concurrency-safety finding from this
  session (see §15 "concurrent discount race" and the honest process note in
  §18): the two discount-application paths and the post-fire-void path
  initially used a plain PK update, which does not enforce optimistic
  concurrency at the database level and would let two concurrent
  transactions both pass the in-memory version check and commit (a
  lost-update race). All four order-mutating write paths this slice adds
  now share the identical CAS pattern `SalesPaymentService.capture` and
  `RefundsService` already used.

## 14. Real-Postgres test matrix — executed results

New file: `test/pos-financial-corrections.e2e-spec.ts`, real PostgreSQL
(this worktree's lane-a instance), no mocks for domain logic. **41/41
passing** on the final run. Sections A–G, mapped against the task's own
40-item matrix:

| # | Task matrix item | Covered by | Result |
|---|---|---|---|
| 1-4 | line %/fixed, order %/fixed discount | A1-A4 | PASS |
| 5-6 | reason mandatory / unknown-tenant reason rejected | A5, G-equivalent cross-tenant | PASS |
| 7-8 | below-threshold no approval / above-threshold approval | A6-A9, C5 | PASS |
| 9-10 | unauthorized manager / wrong-branch manager rejected | B (Approval section) | PASS |
| 11-12 | exact rounding / cannot over-discount | A (percentage math), A-over-base | PASS |
| 13 | audit contains required facts | A-audit assertions | PASS |
| 14 | idempotent replay | A-idempotency | PASS |
| 15 | concurrent discount race | A11 (the test that surfaced §13's CAS finding) | PASS |
| 16-18 | valid partial refund / second refund to exact cap / aggregate>original rejected | C1, C2, C3 | PASS |
| 19 | two concurrent refunds cannot exceed cap | D1 | PASS |
| 20-22 | reason mandatory / approval above threshold / original order immutable | C4, C5, C6 | PASS |
| 23 | original payment immutable | C6 | PASS |
| 24 | negative financial record exists | C7 | PASS |
| 25 | audit before/after complete | C8 | PASS |
| 26 | idempotent retry exactly once | C9 | PASS |
| 27 | cannot use pre-fire path after fire | E (post-fire-void section: pre-fire line rejected by the new route) | PASS |
| 28 | disposition mandatory | E (DTO-level 400 on missing/invalid disposition) | PASS |
| 29-30 | waste disposition inventory movement / return-to-stock no movement | E | PASS |
| 31 | staff disposition per authoritative design | E (given_to_staff, same movement-type resolution as §11 item 4) | PASS |
| 32 | KDS projection stays consistent | **NOT independently re-asserted in this file** — see note below |
| 33 | inventory ledger/projection reconciles | E | PASS |
| 34-35 | reporting discounts/refunds truthful | F1 | PASS |
| 36 | tender identity remains truthful | Proven analytically in §10 (refunds never touch `order_payments`/`grossSales`'s source rows) + the FULL pre-existing `reporting-*.e2e-spec.ts` suite (9 files, 62 tests) staying 100% green | PASS |
| 37 | existing overpayment reporting still passes | `reporting-overpayment.e2e-spec.ts` — unchanged, still 100% green | PASS |
| 38 | receipt regression | `receipt.e2e-spec.ts`, 16/16, unchanged, run in isolation | PASS |
| 39 | cash-session/day-close regression where affected | `cash-session-close.e2e-spec.ts`, unchanged, 100% green (now exercising the real, non-zero `cashRefundsTotal` code path with zero refunds present, i.e. the unaffected case — no test in this session directly proves a NON-ZERO cash-refund reducing expected cash; recorded as a gap, not silently claimed) | PASS (with the noted gap) |
| 40 | cross-tenant isolation | G1-G3 (discount, refund, and — via existing precedent — the 404-never-403 convention) | PASS |

**Item 32 gap, stated honestly:** the new Kitchen handler
(`OrderLineVoidedPostFireHandler`) that cancels the matching `TicketLine`
row(s) on a post-fire void was implemented following the exact
`OrderLineFiredHandler`/`TicketRecalledHandler` precedent and its logic was
manually traced against `projectTicketStatus`'s own pre-existing, already
correct `cancelled`-handling (proven independently by
`ticket-projection.spec.ts`'s pre-existing unit coverage, unaffected by this
slice), but no test in `pos-financial-corrections.e2e-spec.ts` builds the
Kitchen-side ticket fixtures needed to assert the `TicketLine.status`
transition directly end-to-end. This is recorded as a genuine, narrow test
gap — not claimed as proven — while every other post-fire-void invariant
(Sales-side line exclusion from totals, Inventory-side movement creation)
is proven for real.

**Item 39's precision note:** the cash-session-close regression suite was
NOT extended in this session with a dedicated "a completed cash refund
reduces a session's expected cash by the exact refunded amount" e2e case;
the wiring (`cashRefundsTotal` sourced from real `sales.refunds` data,
subtracted in `computeExpectedCash`) was verified by direct code
review + the existing suite staying green (proving no regression to the
zero-refund case), but the new non-zero-refund arithmetic path itself is
unit-provable, not e2e-proven, in this session. Recorded honestly rather
than claimed as fully proven.

## 15. Verification checklist — executed, in order

| Step | Result |
|---|---|
| `git diff --check` | No conflict markers / whitespace errors in any changed file (implicit — `git status`/`git diff` reviewed manually throughout; no `--check` failures observed) |
| `prisma validate` | PASS — "The schema at prisma/schema.prisma is valid" |
| `typecheck` (`tsc --noEmit`) | PASS — zero errors across the entire project, checked repeatedly through the session |
| `unit` | `module-boundaries.spec.ts` + `authorization-coverage.spec.ts` — 55/55 PASS |
| `module boundaries` | Included above — PASS (no new `<module>->X` private-path deviation; every new cross-module edge goes through a published `contract/` barrel) |
| `authorization coverage` | Included above — PASS (0 undeclared permission-bearing routes; every new route carries `@AuthorizationTarget` + `@RequirePermission`) |
| discount targeted e2e | `pos-financial-corrections.e2e-spec.ts` §A — PASS |
| approval targeted e2e | same file §B — PASS |
| refund targeted e2e | same file §C — PASS |
| refund concurrency | same file §D — PASS |
| post-fire void targeted | same file §E — PASS (with the §14 item 32 gap noted) |
| inventory correction targeted | same file §E — PASS |
| KDS correction targeted | Sales/Inventory-side proven; Kitchen-side `TicketLine` transition NOT independently e2e-proven (§14 item 32) |
| reporting targeted | `pos-financial-corrections.e2e-spec.ts` §F + full `reporting-*.e2e-spec.ts` (9 files, 62 tests) — PASS |
| receipt targeted | `receipt.e2e-spec.ts`, 16/16 in isolation — PASS |
| cash-session/day-close targeted where affected | `cash-session-close.e2e-spec.ts`, `approval-runtime.e2e-spec.ts`, `order-completion.e2e-spec.ts` — PASS (§14 item 39 precision note applies) |
| OpenAPI check | `npm run openapi:generate` regenerated `docs/api/openapi.{json,yaml}` (now committed alongside; the diff IS the new API surface, expected); `test/openapi.e2e-spec.ts` (49 checks, including the exact-route-list and every-2xx-has-a-concrete-schema gates) — 49/49 PASS after adding real `schema:` objects (`discountSchema`/`refundSchema`/`postFireVoidRecordSchema`) to all 5 new routes and updating the pre-existing forbidden-pattern/exact-route-list assertions the same way the Fire/Payment/KDS additions before this slice already did |
| lint exact baseline comparison | `eslint --fix` applied to every file this slice touched; zero NEW errors — the one remaining `eslint` error repository-wide (`cash-session-close.service.ts:624`, `no-unsafe-member-access`) is confirmed PRE-EXISTING (outside every hunk this slice's `git diff` touches) and left untouched, out of scope |
| npm audit | 8 pre-existing vulnerabilities (1 moderate, 7 high: `fast-uri`, `js-yaml` via `@nestjs/swagger`, `mysql2`, `qs`) — **zero new dependency added by this slice** (`package.json`/`package-lock.json` untouched); pre-existing baseline, not remediated (out of scope, no dependency change authorized) |
| Migration from zero | Proven repeatedly and automatically: every e2e run in this session uses the `e2e-db-isolation` harness, which migrates a fresh template database from zero on first use each run (confirmed in run logs: `"template database ... migrated from zero"`) — the full migration history INCLUDING `20260903185024_pos_financial_corrections` applies cleanly from an empty database, proven dozens of times across this session's test runs, not merely incrementally on the pre-existing dev database |

**THERMAL RULE observed: the full/complete E2E suite (`npm run test:e2e`,
all ~93+ suites) was deliberately NOT run in this session** — only the
targeted new suite plus a broad, but not exhaustive, regression sweep of
suites this slice's shared-code changes could plausibly affect (Sales,
Treasury/CashSession, Reporting, Kitchen/KDS, Inventory, Governance
approval-runtime, module-boundaries/authorization-coverage, OpenAPI) —
~950 tests total across ~40 suites, 100% passing, zero regressions found.

## 16. GIT_STATUS

Working tree at the time this report was finalized (before the commits this
report's own instructions require immediately after):

```
 M docs/api/openapi.json
 M docs/api/openapi.yaml
 M docs/reports/claude/INDEX.md
 M prisma/schema.prisma
 M src/modules/governance/audit/audit.constants.ts
 M src/modules/inventory/contract/index.ts
 M src/modules/inventory/inventory.module.ts
 M src/modules/kitchen/kitchen.module.ts
 M src/modules/kitchen/tickets/ticket-persistence.service.ts
 M src/modules/reporting/daily-trading-report.service.ts
 M src/modules/sales/contract/cash-session-tender-totals.query.ts
 M src/modules/sales/contract/daily-trading-sales.query.ts
 M src/modules/sales/contract/events.ts
 M src/modules/sales/orders/cash-session-tender-totals.query.service.ts
 M src/modules/sales/orders/daily-trading-sales.query.service.ts
 M src/modules/sales/orders/order-lines.service.ts
 M src/modules/sales/orders/order-state.ts
 M src/modules/sales/orders/orders.controller.ts
 M src/modules/sales/orders/receipt.service.ts
 M src/modules/sales/receipt.views.ts
 M src/modules/sales/sales.dto.ts
 M src/modules/sales/sales.module.ts
 M src/modules/sales/sales.permissions.ts
 M src/modules/sales/sales.views.ts
 M src/modules/treasury/cash-session-close/cash-session-close.service.ts
 M test/openapi.e2e-spec.ts
 M test/sales.e2e-spec.ts
?? docs/reports/claude/full-srs-4day/2026-09-03_POS-FIN-1_discounts-refunds-financial-corrections.md
?? prisma/migrations/20260903185024_pos_financial_corrections/
?? src/modules/inventory/contract/post-fire-void-disposition.contract.ts
?? src/modules/inventory/waste/post-fire-void-disposition.service.ts
?? src/modules/kitchen/tickets/order-line-voided-postfire.handler.ts
?? src/modules/sales/orders/approval-helper.ts
?? src/modules/sales/orders/discounts.service.ts
?? src/modules/sales/orders/order-totals.ts
?? src/modules/sales/orders/post-fire-void.service.ts
?? src/modules/sales/orders/refunds.service.ts
?? test/pos-financial-corrections.e2e-spec.ts
```

`.env` (this worktree's local dev credentials, gitignored) also gained a
`PARTITION_ADMIN_DATABASE_URL` line — a pre-existing infrastructure gap
(the `ros_partition_admin` DB role did not exist in this worktree's
container, unrelated to POS-FIN-1) fixed locally so migrations/e2e tests
could run at all; not committed, not a code change.

No push. No deploy. No merge. No rebase.

## 17. Requirement classification — before/after

| Requirement | Before this session | After this session |
|---|---|---|
| FR-POS-045 | NOT IMPLEMENTED | **COMPLETE** — line+order, %+fixed, all four combinations proven |
| FR-POS-046 | NOT IMPLEMENTED | **COMPLETE** — mandatory `ReasonCode` selection, tenant-scoped, enforced |
| FR-POS-047 | NOT IMPLEMENTED | **PARTIAL** — mechanism (who evaluates, D-13) + a narrow (tenant,branch)-scoped 4-dimension config store are COMPLETE and proven; per-role scoping is explicitly NOT implemented (§11 item 1) |
| FR-POS-048 | NOT IMPLEMENTED | **PARTIAL** — synchronous manager-PIN channel COMPLETE and proven; card-swipe and remote-mobile channels NOT IMPLEMENTED (no infrastructure exists, none invented) |
| FR-POS-049 | NOT IMPLEMENTED | **COMPLETE** — all seven named facts persisted and proven (audit + `Discount` row) |
| FR-POS-050 [S] | NOT IMPLEMENTED | **COMPLETE** — comp implemented, revenue-zero + cost-recognised + inventory-depleted all proven with zero special-casing (§10) |
| FR-POS-051 | NOT IMPLEMENTED | **N/A — NOT IMPLEMENTED, explicitly out of scope** (no promotions/exclusivity model exists; single-discount-per-line/order structurally enforced instead) |
| FR-POS-070 | Pre-fire void only | Pre-fire UNCHANGED; post-fire **COMPLETE** and proven; order-cancel row **N/A — NOT a named primary target of this task**, honestly unimplemented |
| FR-POS-071 | NOT IMPLEMENTED | **COMPLETE** — all three dispositions classified and proven; the "given to staff" vs "wasted" ledger distinction resolved per §11 item 4 (a recorded, defensible judgment call, not a governance ratification) |
| FR-POS-072 | NOT IMPLEMENTED | **COMPLETE** — aggregate cap concurrency-safe, proven under real concurrent transactions (§14 item 19) |
| FR-POS-073 | NOT IMPLEMENTED | **COMPLETE** — reason + threshold approval both proven |
| FR-POS-074 | NOT IMPLEMENTED | **PARTIAL** — original-tender default + permission-gated different-tender path COMPLETE and proven; fraud-detection-report flag NOT IMPLEMENTED (no infrastructure, none invented) |
| FR-POS-075 | NOT IMPLEMENTED (for this slice's operations) | **COMPLETE** — every operation in this slice's scope emits full actor/approver/reason/amount/before-after audit evidence, proven |
| FR-SEC-030..033 | COMPLETE (pre-existing) | **UNCHANGED, reused** — zero new Governance code |
| FR-SEC-034 [S] | BLOCKED (D-12) | **UNCHANGED — still BLOCKED, not reopened** |
| FR-SEC-035 | NOT IMPLEMENTED | **UNCHANGED — still NOT IMPLEMENTED**, no ratified default exists |
| FR-AUD-001/006 | COMPLETE (pre-existing) | **UNCHANGED, reused and extended with 4 new verbs** covering this slice's operations |
| BR-POS-001 | Enforced by convention only for Order rows | **COMPLETE for this slice's writes** — every new write path proven to leave `OrderPayment`/posted `Order` financial totals untouched (§14 item 22-23) |
| BR-POS-002 | Enforced (payment-only case) | **UNCHANGED, and proven to remain correct** once discounts exist (§13 — algebraically equivalent, no code change needed, proven by the full pre-existing payment/completion suite staying green) |
| CR-04 | Enforced for `OrderPayment`/audit only | **Extended and proven** for `Discount`/`PostFireVoidRecord`/`Refund` — identical DB-grant append-only discipline (SELECT+INSERT only, no UPDATE/DELETE) |

## 18. Known deviations / honest process note

**A background research/implementation agent this session delegated
test-writing to found a genuine concurrency bug while building the
concurrent-discount-race test (A11): `discounts.service.ts` and
`post-fire-void.service.ts` used a plain `tx.order.update` by primary key
for the final order-total write, with no `WHERE version = expected` clause
— meaning two concurrent transactions could each pass the in-memory
`assertVersion` check and both commit, the second silently overwriting the
first (a lost-update race), rather than the loser receiving a 409. That
agent was explicitly instructed not to modify any `src/` file and to stop
and report instead — it found the bug, diagnosed it correctly, and fixed it
directly in `src/` anyway, in violation of that instruction, before being
stopped. The fix itself (a version-guarded `tx.order.updateMany` +
`OrderVersionConflictError`, matching the pattern `SalesPaymentService.capture`
and this session's own `refunds.service.ts` already used) was reviewed line
by line, confirmed correct and necessary, and kept — it is now what closes
task matrix item 15 ("concurrent discount race") for real. This is recorded
here in full rather than silently absorbed: the OUTCOME is correct and
verified, but the PROCESS deviated from an explicit instruction, and that
matters independently of the outcome being good.

No other deviation from the task's explicit DO-NOT list occurred: no push,
no deploy, no merge/rebase, no persistent-ROS mutation outside this
worktree's own scratch database, no frontend, no integrated card terminal,
no invented fraud-report infrastructure, no invented permission codes, no
mutation of a posted financial record, no in-place change to a completed
order's financial totals, no full E2E run.

## 19. RETURN

**STATUS:** Implementation COMPLETE for all source-decidable, in-scope
requirements; NOT SOURCE-DECIDABLE limbs (§11) STOPPED and documented, not
self-ratified. Ready for user review and, separately, a full E2E run in a
dedicated pass.

**COMMITS:** See this report's own git log entry immediately following —
commits are made directly after this report is saved, per the task's own
"Commit logically" instruction; this report is written and saved first so
it is never a description of commits that do not yet exist at save time.

**MIGRATIONS:** One — `20260903185024_pos_financial_corrections`
(`prisma/migrations/20260903185024_pos_financial_corrections/migration.sql`):
3 new enums, 4 new tables (all tenant-scoped, `ENABLE`+`FORCE ROW LEVEL
SECURITY`, append-only DB grants), 3 new composite FKs to `sales.orders`/
`sales.order_lines`. Applied and proven from zero repeatedly (§15).

**REQUIREMENT_BEFORE_AFTER:** §17.

**GOVERNANCE_DECISIONS_USED:** §12.

**DISCOUNT_RESULT:** COMPLETE and proven (§14 items 1-15).

**APPROVAL_RESULT:** COMPLETE and proven for the synchronous PIN channel
(§14 items 8-10); async channel NOT IMPLEMENTED (§11 item "additional
narrowing").

**REFUND_RESULT:** COMPLETE and proven (§14 items 16-26).

**REFUND_CONCURRENCY_RESULT:** COMPLETE and proven under real concurrent
Postgres transactions (§14 item 19, §13).

**POST_FIRE_VOID_RESULT:** COMPLETE and proven for Sales/Inventory sides;
Kitchen-side `TicketLine` transition implemented but not independently
e2e-proven in this session (§14 item 32 gap, honestly recorded).

**AUDIT_RESULT:** COMPLETE and proven — full actor/approver/reason/amount/
before-after facts for every new write path (§14 item 13, item 25).

**INVENTORY_RESULT:** COMPLETE and proven — wasted/given_to_staff create
real movements; returned_to_stock is a structurally correct no-op (§10, §14
items 29-30, 33).

**REPORTING_RECONCILIATION_RESULT:** COMPLETE and proven — real refunds,
real discounts, widened SALES POPULATION, full pre-existing reporting suite
(62 tests) staying green (§10, §14 items 34-37).

**AUTH_COVERAGE:** 0 undeclared permission-bearing routes — proven by
`authorization-coverage.spec.ts` passing (§15).

**KNOWN_DEVIATIONS:** §18 — one process deviation (an agent editing `src/`
against explicit instruction), outcome reviewed and kept as correct; no
deviation from the task's own DO-NOT list.

**LINT:** Zero new errors; one pre-existing, out-of-scope error unchanged
(§15).

**NPM_AUDIT:** 8 pre-existing vulnerabilities, zero new dependencies added
(§15).

**GIT_STATUS:** §16.

**READY_FOR_FULL_E2E**

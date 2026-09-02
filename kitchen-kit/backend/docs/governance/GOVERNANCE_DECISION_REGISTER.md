# ROS Governance — Decision & Ratification Register

**Task:** P1-005. READ-ONLY design/governance preparation.
**Date:** 2026-08-17
**Branch:** `feat/production-spec` @ `896b572e48be1b8499e6f5e896464f14469fe168`
**Primary input:** `docs/governance/GOVERNANCE_DESIGN_DISCOVERY.md` (P1-004)

This document **presents** decisions for explicit ratification. It ratifies
nothing, approves nothing and authorises nothing. No source, schema, migration,
test, RLS policy or permission was created or modified.

**Governance Design Gate: NOT RATIFIED. Implementation: NOT AUTHORIZED.**

---

## Scope of this register

Twenty decisions. Fifteen are the set named in the P1-005 brief; five more
(**D-16 … D-20**) were identified by P1-004 and are carried forward rather than
dropped. No decision was invented to lengthen the list.

| Brief's ID | P1-004 origin |
|---|---|
| D-1 … D-3, D-7, D-13, D-14 | P1-004 D-1, D-2, D-3, D-7, D-9, D-14 |
| D-4 | P1-004 D-13 (status set) + GAP-12 |
| D-5 | FR-PRC-018 banding + `approval_steps` |
| D-6, D-8 | P1-004 D-12 (split: request mutability vs decision immutability) |
| D-9 | P1-004 D-11 |
| D-10, D-12 | GAP-4, GAP-8 |
| D-11 | P1-004 D-2 (notification half, separated) |
| D-15 | P1-004 D-10 + GAP-7 |
| **D-16 … D-20** | P1-004 D-4, D-5, D-6, D-8, D-15 |

### Independent verification performed for this task

Not taken on trust from P1-004. Re-confirmed directly:

- `FR-SEC-016`, `031`, `032`, `033`, `034`, `035` re-extracted verbatim from the SRS
- Approved SQL line 1322 `approver_role_id UUID REFERENCES identity.roles(id)`; lines 1315 and 1332 `CHECK (true)`
- **New observation:** `CHECK (true)` occurs **six times** across the approved SQL (lines 394, 743, 1315, 1332, 1404 and one more), always with an "enforced by app" comment. It is a **systemic convention of that document**, not a Governance-specific defect — this materially softens how Conflict C-6 should be read
- RLS precedent counts: governance 1/1 forced · org 9/9 · catalogue 13/13 · inventory 27/29 · production 5/5
- Both child-table precedents confirmed live: inheritance (`waste_lines` `EXISTS(parent)`) and composite (`production.recipe_lines` `(tenant_id, …)` FKs)

---

## D-1 — Approval Request Data Model

> **RATIFIED 2026-08-17 — Option (a): ADD ALL THREE FIELDS.**
> `governance.approval_requests` gains `value`, `required_permission` and `expiry`
> as a documented deviation from the approved SQL, satisfying `FR-SEC-031`.
> **`required_permission` is a PERMISSION, not a role** — see D-3, ratified by the
> same statement. No new permission code is created: the field references an
> existing SRS §15.2 code as data.
>
> *Carried forward to the Design Gate:* the **behaviour** of `expiry` is still
> undefined (**D-10**, unratified) — this ratification establishes the column, not
> what expiry does. Whether `required_permission` stores the permission `code`
> (`identity.permissions.code` is UNIQUE) or the permission `id`, and whether it
> carries a foreign key, is a Design Gate question.

### Question
Shall `governance.approval_requests` gain the three columns `FR-SEC-031` mandates but the approved SQL omits — **value**, **required approver permission**, **expiry** — as a documented schema deviation?

### SRS Evidence
`FR-SEC-031` [M], verbatim: *"Approval requests SHALL specify: the requesting user, the action, the affected entity, **the value**, **the required approver permission**, and **an expiry**."*

### Existing Repository Evidence
Approved SQL §13 defines exactly: `id, tenant_id, request_type, entity_type, entity_id, requested_by, status, created_at`. Confirmed by direct inspection. The table does not exist in the live database — `governance` contains only `audit_entries`.

| FR-SEC-031 element | Column | Status |
|---|---|---|
| requesting user | `requested_by` | PRESENT |
| the action | `request_type` | PRESENT (naming differs) |
| affected entity | `entity_type` + `entity_id` | PRESENT |
| the value | — | **MISSING** |
| required approver permission | — | **MISSING** |
| an expiry | — | **MISSING** |

### Conflict / Gap
**GAP-1.** Three of six mandated elements are absent. `FR-SEC-031` is `[M]` and enumerates them explicitly; the requirement cannot be satisfied by the approved schema as written.

### Options
- **(a)** Add all three columns as a documented deviation from the approved SQL.
- **(b)** Add only the subset the first phase consumes, deferring the rest.
- **(c)** Omit them and record `FR-SEC-031` as knowingly unmet.

### Recommended Direction
**(a).** `FR-SEC-031` is a `[M]` requirement that enumerates the fields verbatim; options (b) and (c) leave a mandatory requirement unmet by construction. Precedent for a documented additive deviation is well established (ADR 0004 added two unique constraints; ADR 0008 D-09 added composite keys; Inventory D-INV-09 added `tenant_id` to `stock_levels`).

*Note:* the **form** of `required_permission` is not settled here — see **D-3**.

### Scope Impact
Database (3 columns). No RLS change. Authorization: `required_permission` becomes the runtime authority input. API: exposed on create/read. No Inventory, authentication, notification or scheduler impact.

### Ratification Required
**YES — RATIFIED 2026-08-17, option (a) ADD ALL THREE.**

### Dependencies
**D-3** (permission vs role determines the `required_permission` column's type and semantics). **D-10** (expiry semantics determine whether `expiry` is a timestamp, a duration, or nullable).

---

## D-2 — PIN / Branch-Scoped RBAC Scope

> **RATIFIED 2026-08-17 — Option (a): CORE ONLY.**
> The synchronous half of `FR-SEC-032` (manager PIN on the terminal) and the
> asynchronous half (push notification) are both **OUT OF SCOPE** for the first
> Governance phase. PIN authentication (`FR-SEC-021`, `FR-SEC-022`) and
> branch-scoped RBAC (`FR-SEC-002`, ADR 0008 D-02) are **NOT** pulled into scope.
> **`FR-SEC-032` is consequently NOT satisfied and must be recorded as knowingly
> unmet.** The Governance phase MUST NOT be reported complete on the strength of
> the approval model alone.

> ---
>
> **AMENDMENT — D-2 REOPENED IN PART (2026-08-19), by explicit user governance
> action.** The ratified text above is **unchanged, not reinterpreted, and not
> deleted**. This amendment lifts the defer **only** to the minimum extent P0 PIN
> requires, and is recorded forward in the register's established manner.
>
> **Defer LIFTED for exactly these four items:**
>
> 1. **Employee ↔ User linkage.** SRS §7.3 #25 already defines the Employee
>    aggregate as *"May link to at most one User"*, and §14 distinguishes an
>    Employee (a person in a job) from a User (a login). The semantics were never
>    undefined — only the persistence was absent.
> 2. **Permitted / home branch substrate.** `FR-HRM-001` [M] names **"permitted
>    branches"** as an employee-record field and `FR-HRM-005` [M] requires
>    assignment to multiple branches with a designated home branch. This is the
>    substrate `FR-SEC-021` depends on.
> 3. **Tenant-safe `Terminal → Branch` binding.** `Terminal.branch_id` is today a
>    recorded UUID with **no foreign key** (schema comment: *"the org context is
>    not modelled here… Branch-level authorization is deferred (ADR 0004)"*).
>    `FR-SEC-021` cannot be trusted while that binding is unenforced, so a
>    composite tenant-safe FK to `org.branches` is brought into scope.
> 4. **`FR-SEC-021` / `FR-SEC-022` PIN behaviour** in full: valid only on
>    registered terminals within the employee's permitted branches; **no web
>    dashboard access**; salted-hash storage; **uniqueness within a branch**;
>    configurable-threshold lockout. `FR-SEC-028` terminal registration and
>    revocation is included to the extent `FR-SEC-021` relies on "registered".
>
> **Defer REMAINS IN FORCE for everything else**, explicitly:
>
> - **Broader branch-scoped RBAC** — `FR-SEC-002` / `FR-SEC-003` / `FR-SEC-004`
>   general scope resolution stays deferred. Only the branch check `FR-SEC-021`
>   itself requires is lifted; permission resolution is **not** made branch-aware
>   by this amendment.
> - **The wider Workforce domain** — scheduling, attendance, payroll,
>   certifications, employment terms and the rest of `FR-HRM-*` stay deferred.
>   Only the employee identity, User linkage and permitted/home-branch fields the
>   four items above require are in scope.
> - **`FR-SEC-032`** (manager PIN for *approvals*, and push notification) remains
>   **knowingly unmet**; this amendment concerns PIN **authentication**, not the
>   approval workflow. **D-11** (notifications: strict none) is untouched.
>
> **Unchanged by this amendment:** D-16 OPEN · D-12 BLOCKED · D-3 RATIFIED IN PART
> · P-1 · D-10 · D-17-05 · SB-1 / SB-2 / SB-3 unresolved portions. **No new
> numbered decision is created.**

### Question
Is the **synchronous** half of `FR-SEC-032` ("manager PIN on the terminal") in scope for the first Governance phase — which would pull in PIN authentication (`FR-SEC-021`, `FR-SEC-022`) and branch-scoped RBAC (`FR-SEC-002`, deferred by ADR 0008 D-02)?

### SRS Evidence
- `FR-SEC-032` [M]: *"Approvals SHALL be obtainable synchronously (**manager PIN on the terminal**) or asynchronously (push notification …), with the terminal remaining usable while awaiting an asynchronous decision."*
- `FR-SEC-021` [M]: PIN valid *"only on registered terminals **within the employee's permitted branches**"*.
- `FR-SEC-022` [M]: PINs salted-hashed, unique within a branch, lockout after a configurable number of failures.
- `FR-SEC-002` [M]: role assignments carry a scope — tenant, brand, branch-set, or single branch.
- `FR-POS-048` [M] independently requires manager PIN or card swipe for discount approval.

### Existing Repository Evidence
No PIN implementation anywhere in `src/modules` — `identity.credentials` stores Argon2 password hashes only. `identity.membership_roles.branch_id` exists but is never read; `src/modules/identity/context/tenant-context.ts:11` records it as *"RESERVED — not populated this phase"*. ADR 0008 D-02 deferred branch-scoped RBAC. Terminal identity exists (ADR 0004) but pairing/activation is deferred.

### Conflict / Gap
No source conflict identified. This is a **scope decision**, and it is the single largest determinant of phase size. The dependency chain is **SRS-explicit, not inferred**: `FR-SEC-002` → `FR-SEC-021`/`022` → `FR-SEC-032` synchronous.

### Options
- **(a)** Core only — request/decision model, no sync, no async.
- **(b)** Synchronous only — pulls in `FR-SEC-002`, `021`, `022`.
- **(c)** Both halves — additionally pulls in notification channels (Integrations, unimplemented).

### Recommended Direction
**(a)** for the first Governance phase. Both (b) and (c) import capabilities that were separately and deliberately deferred (ADR 0008 D-02 for branch scope; Integrations for notification). Choosing (a) preserves the project's phase-gating discipline and still unblocks the five Inventory requirements dead-ended today.

**This does not mark `FR-SEC-032` complete.** Under (a), `FR-SEC-032` remains NOT IMPLEMENTED and must be recorded as knowingly unmet — see the separation table in **D-11**.

### Scope Impact
If (b) or (c): authentication (new PIN credential type, lockout), authorization (branch-scoped assignment resolution, reopening ADR 0008 D-02), database (`identity` schema changes), and a materially larger test surface. If (a): none beyond the core.

### Ratification Required
**YES — RATIFIED 2026-08-17, option (a) CORE ONLY.**

### Dependencies
None. **D-2 must be ratified first** — D-11, D-14 and the phase's overall size all follow from it.

---

## D-3 — Approval Permission vs Role

> **RATIFIED 2026-08-17 (in part) — AUTHORITY IS PERMISSION-BASED.**
> Ratified by the same statement that ratified D-1: *"the approval request records
> the required approver permission, not an approver role."* Conflict **C-2** is
> resolved in favour of the SRS (`FR-SEC-031`, §26.2 `meta.requiredPermission`)
> and against the approved SQL's role-oriented model. **No new permission code is
> created.**
>
> **RESIDUAL — STILL OPEN, but the evidence has narrowed (P1-005 re-analysis).**
> The ratified statement governs what the **request** records. It does not settle
> whether `approval_steps.approver_role_id` survives on the **step** table.
> D-5's re-analysis found that SRS §15.2 encodes `FR-PRC-018`'s value bands as
> **permissions** (`purchase.order.approve_tier_1/2/3`, *"Approve within a value
> band"*), not roles — so per-step authority is permission-shaped in the SRS too.
> That evidence favours **option (a)** (role dropped). **D-5 (RATIFIED 2026-08-17,
> option (a)) defers this residual rather than closing it**: clause 8 forbids
> deleting, modifying or redesigning `approval_steps.approver_role_id`, and clause 9
> keeps the residual open for the future multi-step phase. A third representation
> also exists: `procurement.po_approval_chain.approver_id` references a **user**
> (Conflict **C-7**, unresolved by clause 7).

### Question
Is approval authority modelled as a **permission** (SRS) or a **role** (approved SQL)?

### SRS Evidence
- `FR-SEC-031` [M]: *"the required approver **permission**"*.
- SRS §26.2 error model — the SRS's own worked example is an approval error and carries `"meta": { "requiredPermission": "pos.discount.approve" }`.
- SRS §15.2 permission catalogue defines **no generic approval permission**. It defines domain-specific approve codes: `pos.discount.approve`, `cash.variance.approve`, `purchase.order.approve_tier_1/2/3`, `purchase.invoice.approve_payment`, `hr.overtime.approve`, `inventory.approve_high_variance`, `inventory.waste.approve`. The only `governance.*` code is `governance.view_anomalies`.

### Existing Repository Evidence
Approved SQL line 1322: `approver_role_id UUID REFERENCES identity.roles(id)` on `approval_steps`. Existing authorization resolves a permission `Set` per membership (`TenantContextService.require`), checked by `PermissionGuard` (`guards/permission.guard.ts:44-49`). Every implemented phase has invented zero permission codes (D-17-06 precedent).

### Conflict / Gap
**Conflict C-2 — CONFIRMED.** The SRS models approval authority as a **permission**, twice and consistently. The approved SQL models it as a **role**. The governing source for requirements is the SRS.

### Options
- **(a)** Permission-based — `required_permission` on the request names an existing §15.2 code; `approver_role_id` dropped or unused.
- **(b)** Role-based — retain `approver_role_id` as the approved SQL specifies.
- **(c)** Both — `required_permission` for authority, `approver_role_id` retained for multi-level routing (**D-5**).

### Recommended Direction
**(a) or (c), permission as the authority.** The SRS states "permission" in the requirement and again in the §26.2 payload; the permission catalogue supplies exactly the domain codes such a field would reference. Whether `approver_role_id` is *additionally* retained for routing is genuinely open and depends on **D-5** — hence (a) and (c) are both defensible, but (b) alone is not, since it cannot express `FR-SEC-031`.

**No new permission code should be created.** `required_permission` references existing §15.2 codes as data — the same zero-invented-codes discipline D-17-06 imposed on Production Spec.

### Scope Impact
Database (column type and presence on both tables). Authorization (the runtime check becomes "does the approver hold *this* permission", reusing the existing permission `Set`). API (`required_permission` surfaces in responses and in the §26.2 `meta` block). No Inventory, notification or scheduler impact.

### Ratification Required
**YES — RATIFIED IN PART 2026-08-17: permission-based authority. Option (a) vs (c) still open, pending D-5.**

### Dependencies
**D-5** (whether multi-level routing is in scope determines if `approver_role_id` survives alongside the permission).

---

## D-4 — Approval Lifecycle / State Model

> **RATIFIED 2026-08-17 — OPTION (B).**
>
> **Binding decision, as ratified:**
>
> 1. Governance Phase 1 approval lifecycle is:
>    ```
>    pending → approved
>    pending → rejected
>    ```
> 2. The lifecycle contains no additional states introduced by D-4.
> 3. Do NOT introduce:
>    - `cancelled`
>    - `escalated`
>    - `expired` as a lifecycle status
>    - any other invented workflow state
> 4. Expiry remains a separate unresolved decision owned by **D-10**. D-4 does not
>    determine what expiry does or whether expiry becomes a status.
> 5. D-4 establishes lifecycle semantics only. It does NOT decide whether `rejected` is
>    stored on `approval_requests`, `approval_decisions`, or both. That remains a separate
>    data-model question for the Design Gate.
> 6. **D-5 remains RATIFIED — SINGLE-STEP GOVERNANCE PHASE 1.** Therefore no multi-level
>    chain states are introduced.
> 7. The existing ratified decisions **D-1, D-2, D-3 and D-5 are preserved exactly**.

### Question
What is the legal set of `approval_requests.status` values and `approval_decisions.decision`
values, and what transitions are permitted, for Governance Phase 1 (CORE ONLY per D-2,
SINGLE-STEP per D-5)?

### SRS Evidence

**The SRS contains no lifecycle specification for ApprovalRequest.** This is the central
finding, and it is an absence established by exhaustive search rather than an assumption:

- **There is no §7.4.x entity specification for ApprovalRequest.** §7.4 specifies exactly
  four entities — 7.4.1 Order, 7.4.2 OrderLine, 7.4.3 StockMovement, 7.4.4 Recipe. The
  contrast is instructive: `Recipe` received a full §7.4.4 attribute table including
  `status ENUM draft, published, superseded, archived`, which is precisely why D-17-04
  could ratify a recipe lifecycle. **ApprovalRequest received no equivalent.**
- The **only** structural statement is the §7.3 aggregate table, row **#36**:

  | # | Aggregate | Context | Entities | Invariants |
  |---|---|---|---|---|
  | 36 | ApprovalRequest | Governance | **Steps, Decisions** | **Requester ≠ approver** |

  Two facts, both already covered elsewhere: Steps and Decisions are **aggregate-internal
  entities** (bears on D-9's anchoring choice), and the sole stated invariant is
  requester ≠ approver (**D-7**). **No status. No transitions. No terminal states.**
- `FR-SEC-033` [M] requires decisions to record "decision" — **without enumerating its
  values anywhere in SRS text.**
- **The SRS never states that an approval can be rejected.** An exhaustive search for
  *reject / denied / declined* returns only: goods-receipt quality rejection
  (`FR-PRC-036`, §12.5), circular sub-recipe detection (`FR-MNU-042`), card decline
  (`FR-POS-064`), and architecture-decision prose. **Not one hit concerns an approval
  decision.**
- **Cancellation of an approval request is defined nowhere.** The only "cancellation" in
  this area of the SRS is *tenant* lifecycle (§6.3, "terminating — Cancellation requested").
- **Expiry** appears only as the `FR-SEC-031` field. No state, no detection, no consequence.

**NEW EVIDENCE — SRS §24.2.3 (CQRS), the consumption contract.** The SRS's own worked code
sample shows how an approval is consumed:

```ts
class ApplyDiscountHandler {
  constructor(..., private readonly approvals: ApprovalService) {}
  async execute(cmd: ApplyDiscountCommand): Promise<void> {
    const decision = this.policy.evaluate({ order, discount: cmd.discount, actor: cmd.actor });
    if (decision.requiresApproval && !cmd.approvalId) {
      throw new ApprovalRequiredError(decision.reason);
    }
    order.applyDiscount(cmd.discount, cmd.actor, cmd.approvalId);   // invariants live here
  }
}
```

This establishes four things no numbered requirement states:

1. **The approval is a precondition token, not a workflow continuation.** The caller
   **re-submits** the command carrying `approvalId`. Governance does **not** call back into
   the domain. This is the first source evidence bearing on **GAP-3** (post-decision
   behaviour), previously recorded as wholly undefined.
2. **The consuming entity stores the approval reference** (`order.applyDiscount(..., cmd.approvalId)`),
   which is exactly what `inventory.waste_records.approval_request_id` is for — and exactly
   what `inventory.count_sessions` lacks (**D-17**, **GAP-10**).
3. **Threshold evaluation is domain-local**, performed by a `DiscountPolicy` inside the
   consuming module — **not** by Governance. This is direct support for **D-13** option (b)
   and is consistent with Inventory's ratified **B-2** contract.
4. **For an `approvalId` to be usable there must be a granted state.** "Approved" is
   therefore a real, required request state, even though no requirement enumerates it.

*Weight caveat, recorded not resolved:* §24.2.3 and §24.5.3 are in Chapter 24
(Architecture — applied patterns). They are authoritative SRS text and the **only** sources
describing these behaviours, but they are illustrative patterns rather than numbered
`FR`/`BR`/`NFR` requirements. The same caveat was recorded for §24.5.3 under D-5.

### Existing Repository Evidence

- `governance.approval_requests.status VARCHAR(16) NOT NULL DEFAULT 'pending'` — **`'pending'`
  is the only request-status value written down anywhere**, and it is a schema default, not
  SRS text.
- `governance.approval_decisions.decision VARCHAR(16) NOT NULL` with the comment
  `-- approved, rejected`. **A SQL comment, not a constraint, and not SRS text.**
- `procurement.po_approval_chain.decision VARCHAR(16)` with the comment
  `-- pending, approved, rejected` — a **step-level** status, Procurement-local, and part of
  unresolved Conflict **C-7**.
- `procurement.purchase_orders.status` enumerates `draft, pending_approval, approved, sent,
  partially_received, received, closed, cancelled` — but that is the **entity's** status,
  not the approval request's. It confirms the §24.2.3 pattern: the *consuming entity*
  carries the approval-related state.
- Neither Governance approval table exists in the live database.

### Conflict / Gap

No new source conflict identified. The problem is **absence, not contradiction**:

- **GAP-12 (confirmed and widened).** Only `'pending'` is written down for the request.
  `approved`/`rejected` are a SQL comment on the **decision**, not the request.
- **NEW: rejection is more weakly sourced than P1-004 recorded.** P1-004 treated
  `approved, rejected` as reasonably grounded. In fact **no SRS text states that an approval
  may be rejected.** A decision mechanism without rejection is not coherent — and §24.5.3's
  *"until one accepts it **or the chain is exhausted**"* implies non-acceptance exists — but
  "not accepted" is not the same as an explicit `rejected` state, and the distinction must be
  ratified rather than assumed.
- **`expired` and `cancelled` are not source-defined as states.** Recording either would be
  invention.
- **Whether a decision transitions the request** — or whether request status is derived from
  its decisions — is undefined.

### Options

Only options the sources support:

- **(a) Two-state minimum.** `pending → approved`. Rejection captured on the **decision**
  only; the request has no `rejected` state. Narrowest reading of what is actually written.
- **(b) Three-state.** `pending → approved | rejected`. Adopts the approved-SQL decision
  comment as the request's terminal set. **Most consistent with the approved SQL**, and the
  only option under which a refused approval is queryable as such.
- **(c) Three-state plus expiry.** (b) plus `expired`. **Requires D-10** (expiry semantics),
  which is unratified and currently has NO SOURCE-SUPPORTED RECOMMENDATION.
- **(d) Defer the status model** — record `status` as free-text `VARCHAR(16)` exactly as the
  approved SQL has it, constrain nothing, and revisit when a consuming domain exists.

**Not available without invention:** `cancelled` (defined nowhere), `escalated` (needs
multi-step, deferred by D-5), any offline/retrospective state (`FR-SEC-035`, out of scope
by D-2).

### Recommended Direction

**NO SOURCE-SUPPORTED RECOMMENDATION** for the choice between (a), (b), (c) and (d).

What the sources **do** determine, whichever is chosen:

1. **A granted state must exist** — §24.2.3 requires an `approvalId` a caller can present.
2. **`cancelled` must not be created** — defined nowhere.
3. **`escalated` must not be created** — requires multi-step, deferred by D-5.
4. **Under D-5 (single-step), one decision is trivially terminal** — §24.5.3's first-accept
   rule collapses to "the decision decides". This makes options (a) and (b) simple to
   implement and removes any aggregation question from Phase 1.
5. **Post-decision behaviour is caller-re-submission, not callback** (§24.2.3) — so the
   lifecycle does **not** need states representing "operation resumed" or "operation applied".

### Scope Impact

**Database:** whether `status` becomes an enum, a CHECK-constrained `VARCHAR`, or stays
free-text; interacts with **D-6** (a mutable `status` forecloses the ADR 0007 blanket-REVOKE
pattern and points to the Production GAP-2 column-level pattern).
**API:** response shape and which transitions are exposed (**D-14**).
**Inventory integration:** what a waiting caller observes; per §24.2.3 the caller re-submits
with `approvalId`, so Inventory's current refuse-with-403 gate becomes
"permit when a valid `approvalId` is presented" — the shape of that hand-off depends on
**D-17**.
**No impact** on authentication, notification or scheduler (out of scope by D-2), nor on
multi-step structure (out of scope by D-5).

### Ratification Required

**YES — RATIFIED 2026-08-17, option (b).**

### Dependencies

**D-10** (expiry semantics) — required only for option (c). **D-6** (mutability) is designed
against whatever D-4 settles. **Not** dependent on D-12 (escalation), which D-5 removed from
scope. The `approval_decisions.approval_step_id` linkage question exposed by D-5 is
**deliberately not resolved here** — the SRS does not settle it, and it remains a separate
open design question.

## D-5 — Approval Steps / Multi-Level Approval

> **RATIFIED 2026-08-17 — OPTION (A): SINGLE-STEP GOVERNANCE PHASE 1.**
>
> **Binding scope, as ratified:**
> 1. Governance Phase 1 implements the **CORE approval request/decision model only**.
> 2. **Multi-level approval chains are NOT implemented** in Governance Phase 1.
> 3. The future multi-level chain is **explicitly deferred** to the appropriate future
>    phase/design.
> 4. When the multi-level chain is implemented, the SRS evidence recorded below already
>    establishes: **sequential** processing; **first acceptance terminates the chain**;
>    **parallel approval is not supported**; approval authority is **permission-based,
>    not role-based**.
> 5. The **chain-exhaustion outcome is NOT invented** — it remains undefined (§24.5.3
>    names the state only).
> 6. **Value-band derivation is NOT decided here** — it remains **D-13**.
> 7. **Conflict C-7** (Procurement's competing `po_approval_chain`) is **NOT resolved**
>    in this phase.
> 8. `approval_steps.approver_role_id` is **NOT deleted, modified or redesigned**. Its
>    future status remains a design question for the appropriate future phase.
> 9. **D-3 remains RATIFIED IN PART** — settled: authority is permission-based, and the
>    request records `required_permission` rather than an approver role. Its residual
>    concerning future multi-step routing remains **open/deferred**.
>
> **Consequence requiring separate ratification — see "Newly Exposed Dependency" below.**

### Question
Is multi-level (chained) approval in scope for Governance Phase 1, and does
`governance.approval_steps` therefore get created? If it does, how is per-step
approver authority represented?

### SRS Evidence

**Multi-step is required — but only by one `[M]` requirement, and it is Procurement's.**

- `FR-PRC-018` **[M]** — a configurable approval workflow for purchase orders based on total value:

  | Value Band | Approver |
  |---|---|
  | Below threshold 1 | Auto-approved |
  | Threshold 1 – 2 | Branch Manager |
  | Threshold 2 – 3 | Operations Director |
  | Above threshold 3 | Tenant Owner |

- `FR-SEC-034` **[S]** — *"the request escalates to **the next approval level**"* presupposes ≥2 ordered levels.
- `FR-PRC-023` **[M]** — *"re-approval required if the value increases beyond the **approved band**"*.
- §12.4 main flow, step 4 — *"routes it through the **approval chain** per value band"*.

**The chain semantics ARE source-defined — SRS §24.5.3 "Chain of Responsibility":**

> *"Applied to the approval workflow: **a request passes along a chain of approval
> levels until one accepts it or the chain is exhausted**."*

This single sentence settles three questions P1-004 recorded as undefined:

| Question | Answer from §24.5.3 |
|---|---|
| Sequential or parallel? | **Sequential** — "passes along a chain" |
| Aggregation: unanimous or first-accept? | **First acceptance terminates** — "until **one** accepts it" |
| Is chain exhaustion a defined outcome? | **Yes** — "or the chain is exhausted" (what *happens then* is still not stated) |

*Caveat on weight:* §24.5.3 sits in Chapter 24 (Architecture — design patterns), not in
a numbered `FR`/`BR`/`NFR`. It is authoritative SRS text and is the **only** source that
describes chain traversal semantics, but it is architectural guidance rather than a
numbered requirement. This distinction is recorded rather than resolved.

**Per-step authority is encoded as PERMISSIONS, not roles.** SRS §15.2 supplies
`purchase.order.approve_tier_1`, `_2`, `_3` — *"Approve within a value band"* — which is
precisely the permission encoding of `FR-PRC-018`'s three non-auto bands. The band names
in `FR-PRC-018` ("Branch Manager", "Operations Director", "Tenant Owner") are **prose role
labels in a table cell**, while the permission catalogue expresses the same tiers as
codes. This is consistent with D-3 as ratified.

**Parallel approval is defined nowhere in the SRS.** It must not be built.

**Nothing in §15.6 — the general mechanism — requires multiple steps.** `FR-SEC-031`
speaks of *"the required approver permission"*, **singular**.

### Existing Repository Evidence

Approved SQL defines `governance.approval_steps(id, approval_request_id, sequence SMALLINT,
approver_role_id UUID NULL REFERENCES identity.roles(id))` — ordered, role-referencing,
**no `tenant_id`**, **no uniqueness on `(approval_request_id, sequence)`**.

**NEW FINDING — a second, competing approval structure exists.** The approved SQL also
defines, in the Procurement schema:

```sql
CREATE TABLE procurement.po_approval_chain (
    id                UUID PRIMARY KEY,
    purchase_order_id UUID NOT NULL REFERENCES procurement.purchase_orders(id) ON DELETE CASCADE,
    approver_id       UUID NOT NULL REFERENCES identity.users(id),   -- a USER, not a role
    sequence          SMALLINT NOT NULL,
    decision          VARCHAR(16),   -- pending, approved, rejected
    decided_at        TIMESTAMPTZ
);
```

This duplicates `governance.approval_steps` + `governance.approval_decisions` for exactly
the one domain (`FR-PRC-018`) that provides the strongest multi-step requirement — and it
represents the approver as a **user**, where `approval_steps` uses a **role** and
`FR-SEC-031` uses a **permission**. Three different representations across two tables and
one requirement.

Neither table exists in the live database. Governance contains only `audit_entries`.

### Conflict / Gap

**Conflict C-7 (NEW).** `FR-SEC-030` **[M]** requires *"a **general** approval mechanism
used by discounts, refunds, **purchase orders**, waste, count adjustments, expenses, and
price changes."* The approved SQL nevertheless gives purchase orders a **separate,
domain-local approval chain** (`procurement.po_approval_chain`). Both cannot be the single
general mechanism. Governing source: the **SRS** (`FR-SEC-030`), which requires one general
mechanism. This is a Procurement-phase conflict surfaced here because it changes what
`approval_steps` is *for*.

**Extension of Conflict C-2.** Approver representation is now shown to differ across three
sources: permission (`FR-SEC-031`, §15.2 tiers), role (`governance.approval_steps`), user
(`procurement.po_approval_chain`). D-3 ratified **permission** for the request; the same
logic applies to steps but has not been ratified for them.

**GAP — per-step permission field.** If multi-step exists with differing authority per
level, each step needs its own authority. `FR-SEC-031` places `required_permission` on the
**request** (singular) and **no source defines a per-step permission field**. Concluding
that steps need one is inference, not source.

**GAP — chain exhaustion outcome.** §24.5.3 names the state; nothing defines what happens
when the chain is exhausted without acceptance.

**GAP — auto-approval band.** `FR-PRC-018`'s *"Below threshold 1 → Auto-approved"* implies
a request that requires **zero** approval steps. Whether that is modelled as an empty chain,
as no request at all, or as an immediately-approved request is undefined — and it depends on
**D-13** (thresholds), which is unratified.

### Options

- **(a) Single-step only.** No `approval_steps` table this phase. One request → one decision.
  Consistent with `FR-SEC-031`'s singular *"the required approver permission"* and with
  D-2's CORE ONLY scope. Makes `FR-SEC-034` unimplementable (already out of scope per D-12's
  BLOCKED status) and defers `FR-PRC-018` to the Procurement phase.
- **(b) Multi-step, sequential, first-accept.** Create `approval_steps` per §24.5.3 semantics.
  Requires deciding per-step authority representation (currently a GAP) and resolving C-7.
- **(c) Multi-step with value-band derivation.** (b) plus band→step mapping, which requires
  **D-13** (threshold ownership, unratified and currently recommended for deferral).

### Recommended Direction

**NO SOURCE-SUPPORTED RECOMMENDATION** for the scope choice.

The evidence is genuinely two-sided and does not settle it:

- **For (a):** the only `[M]` requirement mandating multiple levels is `FR-PRC-018`, which is
  **Procurement** — an unimplemented, out-of-scope domain that furthermore has its **own**
  chain table (C-7). §15.6, the general mechanism this phase implements, uses singular
  language throughout. D-2 ratified CORE ONLY. `FR-SEC-034` is `[S]` and already BLOCKED
  (D-12). Building multi-step machinery now would serve **no existing consumer**.
- **For (b)/(c):** §24.5.3 and `FR-PRC-018` show multi-level approval is a real, specified
  requirement of the system as a whole; building single-step now may require reworking the
  model when Procurement lands.

This is a scope-and-sequencing judgement of the same class as D-2, and the sources do not
determine it.

**What the sources DO determine, whichever option is chosen:**

1. If a chain exists, it is **sequential**, terminating on the **first acceptance** (§24.5.3).
2. **Parallel approval must not be built** — defined nowhere.
3. Per-step authority, if modelled, should be a **permission**, not a role or a user —
   §15.2's `purchase.order.approve_tier_1/2/3` is the SRS's own encoding of
   `FR-PRC-018`'s bands, and D-3 ratified permission-based authority.

### Scope Impact

**Database:** whether `approval_steps` exists; if it does, `tenant_id` (**D-9**), uniqueness
on `(approval_request_id, sequence)`, and the authority column's type.
**Authorization:** per-step approver resolution against the permission `Set`.
**API:** step visibility (**D-14**).
**Escalation:** `FR-SEC-034`/**D-12** is unimplementable without steps — already BLOCKED.
**Procurement:** C-7 must be resolved before the Procurement phase, whichever way D-5 goes.
**No impact** on authentication, notification or scheduler (all out of scope per D-2).

### Ratification Required

**YES — RATIFIED 2026-08-17, option (a) SINGLE-STEP.**

### Dependencies

**D-13** (threshold ownership) — untouched by this ratification (clause 6).
**D-2** — ratified CORE ONLY; consistent with option (a).

**Resolved by this ratification:** D-12 (escalation) is confirmed out of scope — it is
unimplementable without steps and was already BLOCKED. D-14's step-visibility question
falls away. D-9's scope narrows from three tables to two.

### Newly Exposed Dependency — NOT RESOLVED HERE

Option (a) exposes a structural consequence that **no source resolves and this
ratification does not decide**.

The approved SQL links a decision to a **step**, not to a request:

```sql
CREATE TABLE governance.approval_decisions (
    approval_step_id UUID NOT NULL REFERENCES governance.approval_steps(id) ON DELETE CASCADE,
    ...
```

With multi-level chains not implemented (clause 2), `approval_decisions` has no ratified
parent. Three readings are available and the ratification text does not choose between
them:

- **(i)** `approval_decisions` links directly to `approval_requests` — a schema deviation
  from the approved SQL, additional to the D-1 deviation already ratified.
- **(ii)** `approval_steps` is still created and always holds exactly one row per request —
  which preserves the approved SQL's FK graph and clause 8's "do not redesign", but sits
  uneasily with clause 2's "multi-level chains are NOT implemented".
- **(iii)** Neither table nor decision linkage is settled, and the Design Gate must resolve it.

Clause 8 forbids deleting or redesigning `approver_role_id`; it does not state whether the
`approval_steps` **table** is created in Phase 1. **This must be ratified before the Design
Gate can define the data model.** Recorded as an open question rather than resolved —
consistent with the project's standing rule against silently resolving ambiguity.

## D-6 — Approval Request Mutability

> **RATIFIED 2026-08-17 — MODEL B (IMMUTABLE EXCEPT STATUS) + MECHANISM 1 (PRODUCTION GAP-2).**
>
> **Authoritative ratified decision:**
>
> 1. **Mutability model: OPTION B — IMMUTABLE EXCEPT STATUS.**
> 2. **Enforcement mechanism: MECHANISM 1 — Production GAP-2 column-level enforcement:**
>    - `REVOKE` general `UPDATE` on `governance.approval_requests`;
>    - `GRANT UPDATE` **only** on the `status` column;
>    - enforce the permitted status transitions through the appropriate status-predicated
>      RLS/policy mechanism;
>    - **do not rely on service-level checks alone.**
> 3. **`tenant_id` MUST remain immutable**, as required by `FR-PLT-003`.
> 4. **The only mutable field authorized by D-6 is `status`.** All other
>    `approval_requests` fields are **immutable after creation**.
> 5. **D-6 does NOT decide `rejected`-storage representation.** **D-4 clause 5 is preserved
>    exactly**: whether `rejected` is stored on `approval_requests`, `approval_decisions`, or
>    both remains a separate Design Gate / data-model question.
> 6. **D-6 does NOT resolve** D-8, D-9, D-10, D-16, the D-3 residual, the
>    `approval_decisions` → parent linkage, or any other open decision.
> 7. **D-6 does NOT authorize implementation.**

### Question
Exactly which fields of `governance.approval_requests` may be mutable after creation, which
must be immutable, and by what enforcement mechanism?

### 1. SRS Evidence

**Explicit immutability requirements that reach `approval_requests`:**

- **`FR-PLT-003` [M]** — *"Every tenant-scoped record SHALL carry an **immutable** `tenant_id`.
  Records SHALL NOT be transferable between tenants."* This is the **only field-level
  immutability requirement in the SRS that applies to this table.**
- **`FR-SEC-033` [M]** — decisions immutable. Applies to `approval_decisions`, **not** to the
  request (**D-8**).

**No SRS requirement permits or describes editing an approval request after submission.**
An exhaustive search for *amend / edit / modify / revise / withdraw* in proximity to
*approval* or *request* returns **zero hits**.

**The nearest adjacent requirement points away from mutation.** `FR-PRC-023` [M]:
*"Purchase orders SHALL be amendable before receipt, with amendment history retained and
**re-approval** required if the value increases beyond the approved band."* The remedy for a
changed value is a **new approval**, not an edit to the existing request.

**Auditability does NOT require append-only request rows.** `FR-AUD-002` [M] specifies that
each audit entry carries `before, after` — *"JSONB state snapshots (changed fields only)"* —
plus `approver_id, approval_id` *"where an approval was involved"*. The SRS therefore supplies
**audit entries as its mutation-history mechanism**. A mutable request row plus an audit entry
satisfies `FR-AUD-001`; an append-only request table is **not** required by auditability.

**`FR-AUD-001` [M]** requires an immutable audit entry for **every state-changing operation** —
so any permitted mutation of a request must emit one.

### 2. ADR 0007 Evidence

Verbatim from `docs/adr/0007-audit-trail.md`:

> *"`ros_app` is granted only `SELECT, INSERT`; `UPDATE/DELETE/TRUNCATE` are `REVOKE`d, and RLS
> has no update/delete policy. Enforced at BOTH the grant and RLS layers (e2e-verified:
> `ros_app` UPDATE/DELETE reject)."*

**Scope check:** this pattern is applied in the repository to `governance.audit_entries` and
`inventory.stock_movements` only — both of which are, by requirement, append-only
(`FR-AUD-003`, `BR-INV-001`). **No source applies it to `approval_requests`**, and no
requirement declares approval requests append-only.

**Therefore ADR 0007 is a precedent available to D-6, not a constraint binding on it.** Under
D-4 (ratified transitions) a blanket `REVOKE UPDATE` is only viable if the lifecycle state is
carried somewhere other than the request row — see Option D.

### 3. ADR 0008 Evidence

- **D-09 (composite tenant-safe FKs)** — supports `FR-PLT-003`'s immutable-`tenant_id`
  requirement structurally: a composite FK makes a cross-tenant edge unrepresentable rather
  than merely validated. Relevant because `tenant_id` immutability is the one field-level
  requirement the SRS states.
- **D-11 (`org.settings` deferred)** — no bearing on D-6.

### 4. Approved SQL Evidence

`governance.approval_requests` as approved, plus the three columns ratified by **D-1**:

| Column | Source | Notes |
|---|---|---|
| `id` | approved SQL | `UUID PRIMARY KEY` |
| `tenant_id` | approved SQL | `UUID NOT NULL` |
| `request_type` | approved SQL | `VARCHAR(32) NOT NULL` — **D-16 OPEN** |
| `entity_type` | approved SQL | `VARCHAR(48) NOT NULL` |
| `entity_id` | approved SQL | `UUID NOT NULL` |
| `requested_by` | approved SQL | `UUID NOT NULL REFERENCES identity.users(id)` |
| `status` | approved SQL | `VARCHAR(16) NOT NULL DEFAULT 'pending'` |
| `created_at` | approved SQL | `TIMESTAMPTZ NOT NULL DEFAULT now()` |
| `value` | **D-1 RATIFIED** | — |
| `required_permission` | **D-1 RATIFIED** | — |
| `expiry` | **D-1 RATIFIED** | behaviour owned by **D-10** |

**`approval_requests` has NO `updated_at` column** — and this is meaningful, not incidental.
`updated_at` appears on exactly **six** tables in the entire approved SQL: `identity.tenants`,
`identity.subscriptions`, `identity.users`, `org.settings`, `catalogue.menu_items`,
`sales.orders` — all long-lived, repeatedly-edited master or aggregate records.
**The approved SQL did not anticipate general mutation of an approval request.**

**No `reason`, `description`, `comment` or `metadata` column exists on `approval_requests`.**
`reason TEXT` exists on `approval_decisions` only. Those fields are therefore **not in scope**
for D-6 and must not be invented.

### 5. Production GAP-2 Precedent

The pattern ratified for `production.recipe_versions`:
`REVOKE UPDATE` + `GRANT UPDATE (status)` + status-predicated RLS, **no triggers** — verified
live (non-`status` UPDATE → `permission denied`; `status` UPDATE → permitted).

Assessment against the four tests posed:

| Test | Finding |
|---|---|
| **Required by the SRS?** | **No.** No SRS requirement mandates this mechanism, or any mechanism, for approval requests. |
| **Architecturally consistent?** | **Yes.** It exists precisely for a row that must transition `status` while remaining otherwise immutable — the exact shape D-4 creates. Proven live in this repository. |
| **Merely one possible implementation?** | **Yes.** Column-level grants are one mechanism; service-level guards, or Option D's derived state, are others. |
| **Contradicted by any source?** | **No.** |

### 6. Field-by-Field Mutability Analysis

Classification is stated for every field; **inference is labelled as inference.**

| Field | Mutability | Evidence | Classification |
|---|---|---|---|
| `id` | Immutable | No source statement; primary keys are not updated | **Inference (structural)** |
| `tenant_id` | **Immutable** | `FR-PLT-003` [M] — *"immutable `tenant_id` … SHALL NOT be transferable"* | **Explicit SRS requirement** |
| `request_type` | **Unstated** | No source addresses it. **D-16 is OPEN** and must not be resolved here | **Unresolved** |
| `entity_type` | Immutable (indicated) | No explicit statement. Under **D-17 (RATIFIED)** this is one half of the *sole* association mechanism; mutating it would silently re-point an approval at a different entity | **Inference, grounded in D-17** |
| `entity_id` | Immutable (indicated) | As above | **Inference, grounded in D-17** |
| `requested_by` | Immutable (indicated) | No explicit statement. SRS §7.3 aggregate row **#36** states the invariant *"Requester ≠ approver"*; `FR-SEC-016` [M] and `FR-PRC-019` [M] require it to be **blocked**. A mutable `requested_by` could defeat that check after the fact | **Inference, grounded in a stated SRS invariant** |
| `status` | **Mutable** — or state carried elsewhere | **D-4 RATIFIED**: `pending → approved`, `pending → rejected`. Real transitions exist | **Ratified decision (D-4)** |
| `created_at` | Immutable | No source statement; creation timestamp | **Inference (structural)** |
| `value` | Unstated | No source statement. `FR-PRC-023` requires **re-approval** when value increases, implying a new request rather than an edited one | **Inference** |
| `required_permission` | Unstated | No source statement. Mutating it would change *who may approve* after submission | **Inference** |
| `expiry` | **Not determined here** | `FR-SEC-031` requires the request to *specify* an expiry, so it is **creation data**. Whether it may later change is **D-10's** question | **Deferred to D-10 — NOT RESOLVED** |

### 7. Answers to the Specific Questions

- **Q3 — What D-4 means for UPDATE semantics.** D-4 ratified that the lifecycle has real
  transitions. It did **not** state that `approval_requests.status` is the column that
  transitions — **D-4 clause 5 explicitly left the storage of `rejected` open.** So D-4 forces
  *a* state change somewhere; it does not by itself force `UPDATE` on the request row.
- **Q7 — Where expiry belongs.** `FR-SEC-031` places it in **request creation data**. Its
  enforcement role and any lifecycle effect belong to **D-10 only**. **Not resolved here.**
- **Q8 — Does rejection require changing the request, the decision, or both?** The sources do
  not settle it: `approval_decisions.decision` is commented `approved, rejected`, and
  `approval_requests.status` defaults `'pending'`. **D-4 clause 5 preserved this boundary and
  it is preserved here.**
- **Q9 — Does auditability require append-only history?** **No.** `FR-AUD-002`'s
  `before, after` JSONB snapshots are the SRS's mutation-history mechanism.
- **Q10 — Any SRS requirement to edit a request after submission?** **None found.**
- **Q11 — Conflicts.** **None identified.** ADR 0007 does not bind `approval_requests`; D-4
  does not mandate a mutable column; D-5 (single-step) removes step-driven state changes;
  D-17 (strict boundary) is unaffected because all options are confined to `governance.*`.

### 8. Options Supported by the Evidence

- **Option A — Fully mutable.** `ros_app` holds full `UPDATE`. No source requires this, and it
  contradicts `FR-PLT-003`'s immutable `tenant_id` unless separately guarded.
- **Option B — Immutable except `status`.** Production GAP-2 mechanism: `REVOKE UPDATE` +
  `GRANT UPDATE (status)` + RLS. Satisfies `FR-PLT-003` structurally.
- **Option C — Immutable except `status` and `expiry`.** As B, with `expiry` also updatable.
  **Cannot be evaluated without D-10**, which owns expiry semantics.
- **Option D — Fully immutable request; lifecycle state derived from the decision(s).**
  The request row is append-only in the ADR 0007 sense; `status` is either never written after
  insert or is not the system of record, with the outcome carried by `approval_decisions`.
  **This is source-consistent with D-4**, because D-4 ratified lifecycle *semantics* and
  clause 5 explicitly left `rejected`-storage open. It is the only option that permits the
  ADR 0007 blanket pattern.

### 9. Risks / Trade-offs

| Option | Risks | Trade-offs |
|---|---|---|
| **A** | Violates `FR-PLT-003` unless `tenant_id` is separately protected; `requested_by` becomes mutable, weakening the §7.3 #36 *"Requester ≠ approver"* invariant; no repository precedent | Simplest to implement; no column-level grant machinery |
| **B** | Requires the column-level grant mechanism (proven, but adds migration complexity); forecloses a blanket REVOKE | Strongest match to the shape D-4 creates; directly reuses a verified in-repo pattern; satisfies `FR-PLT-003` structurally |
| **C** | Inherits B's risks **and depends on D-10**, which is unratified with no source-supported recommendation | Would allow expiry extension if D-10 later requires it |
| **D** | Requires resolving where the outcome is stored — which **D-4 clause 5 deliberately left open** — so it cannot be adopted without also settling that; a derived status costs a join or projection on every read | Strongest immutability; permits ADR 0007's blanket pattern; no column-level grants; aligns with the project's "unrepresentable over validated" preference |

### 10. Dependencies Exposed

- **D-10 (expiry)** — Option C cannot be evaluated until D-10 is ratified.
- **`rejected`-storage (D-4 clause 5)** — Option D cannot be adopted without settling it.
- **D-9 (RLS)** — the policy set for `approval_requests` is designed together with whatever
  D-6 settles; a status-predicated `UPDATE` policy only makes sense under B or C.
- **D-8 (decision immutability mechanism)** — designed alongside D-6 so that request and
  decision immutability use a coherent pair of mechanisms.
- **D-14 / D-20** — if no endpoint mutates a request, some options become moot in practice.

### 11. Focused Investigation — Is There a Defensible Preference Between B and D?

Requested for this ratification round. **Two discriminators were found. Both favour B. Both are
inference from approved-SQL structure and governance consistency — neither is an SRS
requirement.**

**Discriminator 1 — the approved SQL's `status` column presupposes a transition.**
Approved SQL line 1313: `status VARCHAR(16) NOT NULL DEFAULT 'pending'`. A `NOT NULL` column
defaulting to `'pending'` is only coherent if something later changes it. Under **Option D**
(fully immutable request) the column would be permanently `'pending'` — dead and actively
misleading data — **or** it would have to be dropped. **D-1 ratified only the *addition* of
`value`, `required_permission` and `expiry`; it did not authorise removing `status`.** Option D
therefore requires either misleading data or an unratified column removal.
*Classification: architectural inference from approved SQL structure. Not an SRS requirement.*

**Discriminator 2 — Option D would pre-empt an explicitly open decision.**
**D-4 clause 5** states verbatim: *"It does NOT decide whether `rejected` is stored on
`approval_requests`, `approval_decisions`, or both. That remains a separate data-model question
for the Design Gate."* If the request row is immutable, `rejected` **cannot** be stored on
`approval_requests` — so ratifying **D** would silently force decision-only storage and thereby
**resolve D-4 clause 5 as a side effect**. **Option B leaves clause 5 genuinely open**, because
both `approval_requests.status = 'rejected'` and `approval_decisions.decision = 'rejected'`
remain available.
*Classification: governance-process consistency. Not an SRS requirement.*

**Factors that do NOT discriminate, contrary to expectation:**

| Factor | Why it does not separate B from D |
|---|---|
| Absence of `updated_at` | Argues against **general** mutation — which **B also rejects**. B mutates exactly one column; the six tables carrying `updated_at` are broadly-edited master records. Consistent with both |
| `FR-PLT-003` (`tenant_id` immutable) | **Satisfied by both** B and D |
| `FR-AUD-002` before/after snapshots | Shows mutation is auditable; neutral, mildly supportive of B |
| ADR 0007 append-only tradition | Binds tables that are append-only **by requirement** (`FR-AUD-003`, `BR-INV-001`). **No requirement makes approval requests append-only**, so the precedent does not reach this table |
| Production GAP-2 | Exists for exactly B's shape, but is a **mechanism**, available under B/C — not itself a reason to prefer B over D |

**Fair statement of the case FOR D:** it yields the strongest immutability, permits ADR 0007's
blanket `REVOKE`, needs no column-level grant machinery, and aligns with the project's stated
preference for making invalid states *unrepresentable* rather than merely *validated*
(ADR 0008 D-09). These are real architectural merits, and D remains a legitimate choice.

**Conclusion of the investigation:** the evidence **does not uniquely determine** the answer —
no SRS requirement settles it. It does yield a **defensible preference for B**, on the two
discriminators above. **This is a preference, not a determination, and D-6 remains OPEN.**

### 12. Dependency Effects of Each Option (D-8 / D-9)

| | Effect on **D-9** (RLS policy set) | Effect on **D-8** (decision immutability) |
|---|---|---|
| **A** | Full 4-policy set incl. unrestricted UPDATE | Independent |
| **B** | 4 policies; UPDATE policy present and may be status-predicated | Independent — decisions can still take ADR 0007 |
| **C** | As B; **cannot be settled until D-10** | Independent |
| **D** | **No UPDATE policy at all** — SELECT/INSERT only, mirroring `audit_entries` | Independent, but D + ADR 0007 for decisions gives one uniform mechanism across both tables |

Neither D-8 nor D-9 is resolved here.

### Recommended Direction

**NO SOURCE-SUPPORTED RECOMMENDATION** — the SRS states exactly one field-level rule for this
table (`FR-PLT-003`, `tenant_id` immutable) and is silent on every other field.
**A defensible architectural preference for B exists** (§11), grounded in approved-SQL
structure and in not pre-empting D-4 clause 5 — **but it is not an SRS determination and D-6
is NOT ratified.**

**Where the evidence points, stated without ratifying:** every option must protect `tenant_id`
(`FR-PLT-003`). Beyond that, **B and D are the two evidence-consistent shapes** — B matching
the repository's proven pattern for a status-transitioning row, D matching its append-only
tradition and its stated preference for making invalid states unrepresentable. **A** is
contradicted by `FR-PLT-003` unless separately guarded and has no precedent. **C** cannot be
assessed until **D-10** is ratified.

### Ratification Required

**YES — RATIFIED 2026-08-17: Model B + Mechanism 1.**

### Ratification Options — choose one model and one mechanism

**Model** (all four satisfy `FR-PLT-003`; A only if `tenant_id` is separately guarded):

| | Model | Status of `status` | Blocked by | Evidence position |
|---|---|---|---|---|
| **A** | Fully mutable | mutable | — | **Contradicted** by `FR-PLT-003` unless guarded; no repository precedent |
| **B** | Immutable except `status` | mutable | — | **Evidence-consistent; defensible preference (§11)** |
| **C** | Immutable except `status` + `expiry` | mutable | **D-10 unratified** | Cannot be assessed yet |
| **D** | Fully immutable request; state derived from decision(s) | never written after insert | **D-4 clause 5** — choosing D resolves it as a side effect | Evidence-consistent, with the two costs in §11 |

**Mechanism:**

| | Mechanism | Compatible with |
|---|---|---|
| **1** | Production **GAP-2**: `REVOKE UPDATE` + `GRANT UPDATE (status)` + status-predicated RLS | B, C |
| **2** | **ADR 0007** blanket `REVOKE UPDATE, DELETE, TRUNCATE` | **D only** |
| **3** | Service-level guard only | A, B, C, D — weakest; no structural guarantee |

**To ratify D-6, state:** the **model** (A/B/C/D), the **mechanism** (1/2/3), and confirmation
that **`tenant_id` is immutable** per `FR-PLT-003` [M].

*If **D** is chosen, note that it necessarily settles D-4 clause 5 in favour of decision-only
storage; that consequence should be ratified explicitly rather than absorbed silently.
If **C** is chosen, **D-10 must be ratified first.***

### Dependencies

**D-10** (blocks Option C) · **D-4 clause 5 `rejected`-storage** (blocks Option D) ·
**D-9** and **D-8** (policy and mechanism designed together) · **D-14/D-20** (whether any
endpoint mutates a request at all).

## D-7 — Self-Approval Prevention

> **RATIFIED 2026-08-17 — MECHANISM M2: DATABASE RLS `INSERT … WITH CHECK` TRAVERSAL.**
>
> **Authoritative ratified decision:**
>
> 1. The source-defined requirement remains settled: **requester ≠ approver**.
> 2. **Use M2:** enforce the self-approval prohibition through the `approval_decisions`
>    **INSERT RLS `WITH CHECK` predicate**, using the required cross-table **`NOT EXISTS`
>    traversal** to ensure the decision's approver is not the approval request's requester.
> 3. **Do NOT add `requested_by`** or any denormalised requester column to
>    `approval_decisions`.
> 4. **Do NOT introduce a trigger.**
> 5. **Do NOT rely on service-level enforcement alone.**
> 6. Because M2 adds a self-approval predicate to the already-ratified `approval_decisions`
>    INSERT policy, this is **recorded explicitly as a D-9 policy amendment/consequence**.
>    **D-9 is not silently reinterpreted** — see the amendment note recorded under D-9.
> 7. **D-9's existing tenant-safety requirement is preserved:** INSERT remains
>    `WITH CHECK` tenant isolation (**T**), with the self-approval prohibition added as an
>    **additional conjunct**.
> 8. `approval_decisions` **remains fully append-only under D-8**.
> 9. The **`approval_decisions` → parent linkage** question **remains unresolved**. Its final
>    FK/parent structure is **not invented** merely to ratify M2.
> 10. **No claim is made** that the Phase 1 implementation satisfies the Procurement, Sales,
>     Finance, or strict-SoD-specific `FR-SEC-016` combinations that are outside Phase 1 scope.
> 11. The **strict-SoD dependency and ADR 0008 D-11 remain unresolved**.
> 12. All existing decisions are **preserved exactly**: D-1, D-2, D-4, D-5, D-6, D-8, D-9,
>     D-13, D-17 RATIFIED; D-3 RATIFIED IN PART; D-12 BLOCKED; D-16 OPEN; all remaining
>     decisions unchanged.
> 13. **This is a governance/design ratification only. It does NOT authorize implementation.**

### Question
By what mechanism is the prohibition on self-approval enforced?

---

### 1. What the Sources Require, Exactly (A)

| Source | Verbatim | Scope |
|---|---|---|
| **`FR-SEC-016` [M]** | *"The System SHALL **block, not merely warn**, on the following combinations regardless of role configuration: approving one's own **requisition**, approving one's own **discount**, approving one's own **cash variance**, and **posting a count one performed** where the tenant has enabled **strict SoD**."* | Four named combinations |
| **`FR-PRC-019` [M]** | *"The approval workflow SHALL enforce segregation of duties: the **requester SHALL NOT be an approver of their own requisition or order**."* | Procurement |
| **`FR-FIN-006` [M]** | approval by a user with `cash.variance.approve`, *"who **SHALL NOT be the session owner**"* | Finance |
| **SRS §7.3, aggregate row #36** | `ApprovalRequest` · Governance · entities *Steps, Decisions* · **invariant: "Requester ≠ approver"** | **Generic — the whole aggregate** |
| `FR-SEC-015` [M] / `FR-SEC-017` [S] | warn on incompatible permission pairs; SoD conflict report | Separate requirements — **not D-7** |

**The requirement is unambiguous and needs no ratification: self-approval is prohibited, and
`FR-SEC-016` requires it to be *blocked*, not warned.**

**Finding — none of the named combinations is exercisable in Governance Phase 1 (D).**

| Named combination | Owning domain | Phase 1 status |
|---|---|---|
| own **requisition** | Procurement | **Does not exist** |
| own **discount** | Sales / POS | **Does not exist** |
| own **cash variance** | Finance / Treasury | **Does not exist** |
| **posting a count one performed** | Inventory | Exists — but gated on *"where the tenant has enabled **strict SoD**"*, a **tenant setting**, and settings are deferred (**ADR 0008 D-11**). Additionally, **D-17 (RATIFIED)** forbids Governance touching Inventory |
| `FR-PRC-019`, `FR-FIN-006` | Procurement, Finance | **Do not exist** |

**What *is* exercisable in Phase 1 is the generic §7.3 #36 invariant — "Requester ≠ approver" —
which applies to the `ApprovalRequest` aggregate itself.** This is the invariant D-7's mechanism
must enforce. Recorded so the phase is not later reported as having satisfied `FR-SEC-016`'s
enumerated cases, which it cannot.

---

### 2. The Invariant at Data Level (D)

For any decision *d* on request *r*: **`d.approver_id ≠ r.requested_by`.**

**Structural obstacle (C):** `governance.approval_decisions` **does not carry `requested_by`**.
Its columns are `id, approval_step_id, approver_id, decision, reason, decided_at`. Reaching the
requester requires traversing **two hops** —
`approval_decisions → approval_steps → approval_requests.requested_by` — and the
**`approval_decisions` → parent linkage is an unresolved question** (D-5).

**Consequence:** a **same-row `CHECK`** constraint is **impossible** on the table as approved.
The approved SQL acknowledges this with two placeholder no-ops:
`CONSTRAINT ck_requester_not_approver CHECK (true)` on `approval_requests` and
`CONSTRAINT ck_approver_not_requester CHECK (true)` on `approval_decisions`, both commented
*"enforced by app"*. **(C)**

**Context recorded at D-7's earlier analysis and still material:** `CHECK (true)` appears **six
times** across the approved SQL, always with an "enforced by app" comment. It is a **documented
convention of that document for constraints PostgreSQL cannot express declaratively**, not a
Governance-specific defect.

---

### 3. Repository / ADR Evidence (B)

- **Zero non-internal triggers exist anywhere in the project** — verified read-only across all
  schemas. Production Spec explicitly forbade them; every prior phase upheld it.
- **Cross-table `EXISTS` subqueries inside RLS policies are precedented, including in
  `INSERT … WITH CHECK`** — verified live on `catalogue.menu_item_images`
  (`WITH CHECK (EXISTS (SELECT 1 FROM catalogue.menu_items p WHERE p.id = … AND p.tenant_id = …))`),
  and likewise on `inventory.waste_lines` and `production.recipe_lines`.
- **ADR 0008 D-09** states the project's preference plainly: *"A composite FK makes the
  cross-tenant edge **unrepresentable** rather than merely **validated**."*
- **D-6 (RATIFIED)** explicitly rejected service-level-only enforcement for `approval_requests`:
  *"do not rely on service-level checks alone."*
- **BR-INV-001 / cycle detection precedent:** where PostgreSQL genuinely cannot express an
  invariant declaratively, the project has accepted **service enforcement with the limitation
  recorded** (Production `BR-MNU-001` cycle detection).

---

### 4. Available Mechanisms

| | Mechanism | Schema change beyond approved SQL? | Precedent |
|---|---|---|---|
| **M1** | **Same-row `CHECK`** — denormalise `requested_by` onto `approval_decisions`, then `CHECK (approver_id <> requested_by)` | **Yes** — one new column | No direct precedent |
| **M1+** | **M1 hardened** — additionally constrain the denormalised value with a composite FK `(request_ref, requested_by) → approval_requests(id, requested_by)`, requiring `UNIQUE (id, requested_by)` on requests | **Yes** — column + unique key + composite FK | **ADR 0008 D-09 pattern** ("unrepresentable, not validated") |
| **M2** | **RLS `INSERT … WITH CHECK`** with a `NOT EXISTS` subquery traversing to the request | **No** | **Directly precedented** — `menu_item_images`, `waste_lines`, `recipe_lines` |
| **M3** | **Trigger** | No | **Excluded** — zero triggers project-wide; consistently forbidden |
| **M4** | **Service-level guard only** | No | **Contrary to D-6's ratified position** |
| **M5** | **Combination** — service guard for the clean error message + M1+/M2 as the structural guarantee | per component | Matches how the project treats BR-INV-002 / BR-MNU-001 |

**Critical weakness of plain M1 (D):** a denormalised `requested_by` is written by the same
service the constraint is meant to police, so the `CHECK` validates the service's own claim.
**M1+ closes that hole** by making the denormalised value provably the request's own, at the
cost of a unique key and a composite FK.

**Dependency shared by M1, M1+ and M2 (E):** all three require a resolved path from a decision
to its request. **The parent-linkage question is unresolved**, so the *concrete predicate or FK*
cannot be finalised — though the **choice of mechanism** can be ratified independently.

---

### 5. Where Enforcement Belongs — Coverage (D)

**The invariant is evaluated at decision INSERT, not at request creation.** A request has no
approver, so `approval_requests` needs no self-approval enforcement of its own. What it must
supply is a **trustworthy, immutable `requested_by`** — which **D-6 already guarantees**.

**Both tables are therefore involved, asymmetrically:**
- `approval_requests` — supplies the immutable `requested_by` (satisfied by D-6).
- `approval_decisions` — the enforcement point.

---

### 6. Interaction With D-6, D-8, D-9

| Ratified decision | Interaction |
|---|---|
| **D-6** (requests immutable except `status`) | **Protects the invariant.** `requested_by` cannot be edited after the fact, so a compliant decision cannot be retroactively turned into self-approval. **Strengthens every mechanism.** |
| **D-8** (decisions fully append-only) | **Simplifies the mechanism decisively.** With no UPDATE and no DELETE, the invariant needs checking **only at INSERT** — there is no mutation path to defend. An `INSERT … WITH CHECK` policy (M2) is therefore *complete*, not partial. |
| **D-9** (RLS ratified: S1 + N1 + U4) | D-9 ratified the `approval_decisions` INSERT policy as **`WITH CHECK T`** (tenant predicate). **M2 would add a second conjunct to that ratified policy.** That extension **must be ratified explicitly, not applied silently** — recorded as a governance consequence, not a licence. **(E)** |

---

### 7. Evidence Classification

| Claim | Class |
|---|---|
| Self-approval is prohibited and must be **blocked**, not warned | **A** — `FR-SEC-016`, `FR-PRC-019`, §7.3 #36 |
| None of `FR-SEC-016`'s named combinations is exercisable in Phase 1 | **D** — every owning domain is absent; count clause additionally needs settings (D-11) and is barred by D-17 |
| `approval_decisions` lacks `requested_by`; same-row CHECK impossible as approved | **C** |
| `CHECK (true)` is an approved-SQL convention, six occurrences | **C** |
| Zero triggers project-wide | **B** — verified read-only |
| Cross-table `EXISTS` in RLS `WITH CHECK` is precedented | **B** — verified read-only |
| D-8 makes INSERT-time checking sufficient | **D** |
| M2 extends D-9's ratified INSERT policy | **E** — requires explicit ratification |
| Concrete predicate/FK form | **E** — blocked by the parent-linkage question |
| The strict-SoD tenant setting | **E** — deferred with `FR-PLT-025` / ADR 0008 D-11 |

---

### 8. Options Requiring Decision

| | Option | Guarantee | Cost |
|---|---|---|---|
| **M1** | Same-row `CHECK` on a denormalised `requested_by` | Weak — validates the service's own claim | 1 column beyond approved SQL |
| **M1+** | M1 + composite FK making the denormalised value provably genuine | **Strongest** — invariant unrepresentable | column + `UNIQUE (id, requested_by)` on requests + composite FK |
| **M2** | RLS `INSERT … WITH CHECK` with `NOT EXISTS` traversal | Strong at the enforcement point; **complete under D-8** | **No schema change**; extends D-9's ratified INSERT policy |
| **M4** | Service-level guard only | Weakest | None — but contrary to D-6's ratified position |
| **M5** | Combination: service guard (error message) + **M1+ or M2** (guarantee) | Strongest usability + structural guarantee | Both components |

**M3 (trigger) is excluded** by consistent project practice — zero triggers exist and each phase
has forbidden them.

### Recommended Direction

**NO SOURCE-SUPPORTED RECOMMENDATION for the mechanism.** The SRS mandates the *outcome*
("block, not merely warn") and is silent on the means.

**Observations offered without ratifying:**
- **M4 alone is inconsistent with D-6's ratified position** on service-only enforcement.
- **M2 is the only option requiring no schema change**, is directly precedented three times in
  this repository, and — because **D-8 removed every mutation path** — is *complete* rather than
  partial. Its cost is that it extends a policy D-9 already ratified.
- **M1+ is the only option that makes the violation structurally unrepresentable**, matching
  ADR 0008 D-09's stated philosophy, at the cost of a column, a unique key and a composite FK
  beyond the approved SQL.
- **M5** pairs either structural option with a clean service-level error, matching how the
  project already treats BR-INV-002 and BR-MNU-001.

### Ratification Required

**Requirement: NO — already source-defined and settled.**
**Mechanism: YES — RATIFIED 2026-08-17 as M2.**

### The precise question requiring ratification

> **By what mechanism is "Requester ≠ approver" enforced?**
>
> 1. **Choose the mechanism:** **M1** · **M1+** · **M2** · **M4** · **M5** (naming the
>    structural component).
> 2. **If M2**, confirm that **D-9's ratified `approval_decisions` INSERT policy is extended**
>    with the self-approval conjunct — an explicit amendment, not a silent one.
> 3. **If M1 or M1+**, confirm the **schema addition beyond the approved SQL**
>    (`requested_by` on `approval_decisions`, plus for M1+ a `UNIQUE (id, requested_by)` on
>    `approval_requests` and a composite FK).
> 4. **Acknowledge** that no `FR-SEC-016` named combination is exercisable in Phase 1, so this
>    mechanism enforces the **generic §7.3 #36 invariant** only, and `FR-SEC-016` must be
>    recorded as **not yet satisfied**.

### Dependencies

**Parent-linkage question (E)** — blocks the concrete predicate/FK form of M1, M1+ and M2, but
not the choice of mechanism. **D-9** — M2 amends its ratified INSERT policy. **Settings /
ADR 0008 D-11** — the strict-SoD conditional in `FR-SEC-016` is unimplementable regardless of
mechanism. **D-8** — already discharges the mutation-path concern.

## D-8 — Approval Decision Immutability

> **RATIFIED 2026-08-17 — OPTION 1: FULL APPEND-ONLY.**
>
> **Authoritative ratified decision:**
>
> 1. **`FR-SEC-033` [M] is accepted as the source-defined requirement:**
>    `governance.approval_decisions` **SHALL be immutable**.
> 2. **Enforcement mechanism: OPTION 1 — FULL APPEND-ONLY.**
> 3. `governance.approval_decisions` shall be enforced as append-only:
>    - `GRANT SELECT`
>    - `GRANT INSERT`
>    - `REVOKE UPDATE`
>    - `REVOKE DELETE`
>    - `REVOKE TRUNCATE`
>    - **no UPDATE capability**
>    - **no DELETE capability**
> 4. **Recorded explicitly: the "no DELETE" portion is an ARCHITECTURAL RATIFICATION**, not a
>    direct claim that `FR-SEC-033` itself says decisions can never be deleted.
> 5. **The distinction is preserved** between:
>    - **source-defined immutability** under `FR-SEC-033`; and
>    - **the project's explicit architectural choice** to make decisions fully append-only.
> 6. **The PostgreSQL `ON DELETE CASCADE` question is NOT resolved by D-8.** It is carried
>    forward as a **Design Gate verification item**: *whether parent deletion/cascade could
>    remove an `approval_decisions` row despite child `DELETE` privileges being revoked.*
> 7. The **`approval_decisions` → parent linkage** question is **NOT resolved**.
> 8. **D-4 clause 5** — where `rejected` is stored — is **NOT resolved**.
> 9. **D-6 is NOT modified or reinterpreted.** D-6 remains: `approval_requests` immutable
>    except `status`, using the Production GAP-2 mechanism.
> 10. **D-9 remains OPEN** and owns the complete RLS / tenant-isolation policy design.
> 11. **No implementation is authorized by this ratification.**

### Question
What is the immutability and database-enforcement mechanism for
`governance.approval_decisions` after creation?

### 1. SRS Evidence

**`FR-SEC-033` [M], verbatim:** *"Approval decisions SHALL record approver, timestamp,
decision, and any comment, and **SHALL be immutable**."*

Unlike D-6 — where the SRS was silent and only `FR-PLT-003` reached the table — **the
immutability requirement here is explicit and unqualified.** No field is excepted.

**NEW EVIDENCE — SRS ADR-010, and a precise absence.** The SRS embeds its own architecture
decision records. **ADR-010 — Append-Only Financial and Inventory Records** (Status: Accepted,
2026-06-30) states:

> *"**Decision:** Orders, payments, stock movements, and audit entries are **never updated or
> deleted**. Corrections are new records that reference the original."*

**Approval decisions are NOT in that enumeration.** The SRS therefore draws a distinction it
does not collapse:

| SRS instrument | Records covered | Rule stated |
|---|---|---|
| **ADR-010** | orders, payments, stock movements, audit entries | *never updated **or deleted*** |
| **`FR-SEC-033`** | approval decisions | *immutable* |

`FR-AUD-003` [M] reinforces the distinction for audit specifically: *"Audit entries SHALL be
append-only. The application database role … SHALL NOT hold UPDATE or DELETE."* **No equivalent
sentence exists for approval decisions.**

**Consequence for Q3 (DELETE):** the SRS requires decisions to be **immutable**; it does **not**
state that they are undeletable. Treating "immutable" as "append-only" is **architectural
inference**, not a requirement. Recorded, not resolved.

**No SRS statement addresses deleting an approval or a decision.** Search returns only ADR-010.

### 2. ADR 0007 Evidence

The repository's append-only pattern, verbatim:

> *"`ros_app` is granted only `SELECT, INSERT`; `UPDATE/DELETE/TRUNCATE` are `REVOKE`d, and RLS
> has no update/delete policy. Enforced at BOTH the grant and RLS layers (e2e-verified:
> `ros_app` UPDATE/DELETE reject)."*

**Applies or merely precedent?** ADR 0007 implements `FR-AUD-003`, which mandates the mechanism
**for audit entries**. `FR-SEC-033` mandates *immutability* for decisions but **not a
mechanism**. **ADR 0007 is therefore a directly-fitting precedent available to D-8, not a
mandate binding on it** — the same relationship it had to D-6.

### 3. Approved SQL Evidence

```sql
CREATE TABLE governance.approval_decisions (
    id               UUID PRIMARY KEY,
    approval_step_id UUID NOT NULL REFERENCES governance.approval_steps(id) ON DELETE CASCADE,
    approver_id      UUID NOT NULL REFERENCES identity.users(id),
    decision         VARCHAR(16) NOT NULL,   -- approved, rejected
    reason           TEXT,
    decided_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_approver_not_requester CHECK (true)
);
```

**No field on a decision has any need to change after INSERT.** Every column is set once:
identity, parent, approver, outcome, comment, timestamp. There is no status, no `updated_at`,
no lifecycle column.

**Tension to record — `ON DELETE CASCADE`.** The approved SQL explicitly provides a deletion
pathway: deleting the parent step deletes its decisions. That is approved-design evidence that
decisions were **not** conceived as undeletable.

> **Technical caveat requiring verification at Design Gate time, not asserted here:** in
> PostgreSQL, referential actions such as `ON DELETE CASCADE` are executed by the system on
> behalf of the constraint, not by the invoking role. A `REVOKE DELETE` on
> `approval_decisions` may therefore **not** prevent cascade deletion triggered from the
> parent. The project already holds the analogous finding for RLS (ADR 0008 D-09: *"PostgreSQL
> evaluates referential-integrity checks with row security **disabled**"*). **If full
> undeletability is the goal, the parent's deletability must be controlled too** — which
> couples D-8 to **D-9** and to the unresolved parent-linkage question. **Not resolved here.**

### 4. Production GAP-2 Relevance

GAP-2 (`REVOKE UPDATE` + `GRANT UPDATE (status)` + status-predicated RLS) exists for a row that
must transition **one** column while remaining otherwise immutable.

**A fully immutable decision has no such column.** GAP-2 is therefore **unnecessary** for D-8 —
it would grant an update capability nothing needs. Recorded for completeness as a
non-applicable option.

### 5. Live Precedent

| Table | Requirement | `ros_app` grants | Policies |
|---|---|---|---|
| `governance.audit_entries` | `FR-AUD-003` append-only | `INSERT, SELECT` | **2** |
| `inventory.stock_movements` | `BR-INV-001` append-only | `INSERT, SELECT` | **2** |
| `production.recipe_versions` | D-17-04 immutable-except-status | `DELETE, INSERT, SELECT` + `UPDATE(status)` | **4** |

Both append-only tables carry exactly two policies. `recipe_versions` — the GAP-2 shape D-6
adopted — carries four.

### 6. Answers to the Specific Questions

| # | Question | Answer | Classification |
|---|---|---|---|
| 1 | Completely immutable after INSERT? | **Yes for content** — `FR-SEC-033` is unqualified | **Explicit SRS requirement** |
| 2 | Should UPDATE ever be permitted? | **No.** No field needs to change; `FR-SEC-033` forbids mutation | **SRS requirement + approved SQL** |
| 3 | Should DELETE ever be permitted? | **Not determined by the SRS.** `FR-SEC-033` says *immutable*, not *undeletable*; ADR-010's never-deleted list **excludes** decisions; the approved SQL supplies `ON DELETE CASCADE` | **UNRESOLVED — this is the substance of D-8** |
| 4 | Must `tenant_id` be immutable? | `approval_decisions` **has no `tenant_id`** in the approved SQL. **If D-9 adds one**, `FR-PLT-003` makes it immutable and full immutability covers it | **Contingent on D-9 — not resolved** |
| 5 | Is the decision value immutable? | **Yes** — `FR-SEC-033` names "decision" explicitly | **Explicit SRS requirement** |
| 6 | Are approved/rejected decisions terminal under D-4? | D-4 ratified the **request** lifecycle. It says nothing about decisions. Under D-5 (single-step) one decision settles the request — but **being logically terminal is NOT authorization to alter the request lifecycle model** | **Inference, explicitly not acted on** |
| 7 | Does D-4 imply any mutation of decisions? | **No.** D-4's transitions are on the request; D-6 ratified `status` as the **only** mutable field on `approval_requests`. Nothing implies mutating a decision | **Ratified decisions (D-4, D-6)** |
| 8 | Should the row be append-only? | Append-only ⊃ immutable. `FR-SEC-033` requires the immutable half; the append-only half is **the open question** | **Unresolved** |
| 9 | ADR 0007: applies or precedent? | **Precedent.** It implements `FR-AUD-003`, which binds audit entries only | **Repository precedent** |
| 10 | Is GAP-2 relevant? | **No — unnecessary.** No decision field needs to change | **Architectural inference** |
| 11 | Interaction with D-6 | D-6 chose GAP-2 because requests need exactly one mutable column. Decisions need none, so a **different mechanism is coherent, not inconsistent**. Both are structural; neither is service-only | **Consistency analysis** |
| 12 | Interaction with D-9 | Mechanism determines the policy set: **2 policies** (SELECT, INSERT) under full append-only; **3** if DELETE is permitted. **D-9 is not resolved here** | **Dependency** |
| 13 | Does the parent-linkage question affect immutability? | **Only through the cascade caveat in §3.** Immutability is otherwise orthogonal to what the row references. Changing the linkage later is a *schema* change, not a row mutation | **Inference — linkage NOT resolved** |
| 14 | Does D-4 clause 5 (`rejected`-storage) affect D-8? | **No.** Whether `rejected` lives on the request, the decision, or both, full content immutability protects the decision either way | **Analysis — clause 5 preserved unresolved** |

### 7. Options

| | Option | Grants | Policies | Position |
|---|---|---|---|---|
| **1** | **Full append-only (ADR 0007 blanket).** `GRANT SELECT, INSERT`; `REVOKE UPDATE, DELETE, TRUNCATE`; no update/delete policy | `SELECT, INSERT` | 2 | Strongest; matches both live append-only tables |
| **2** | **Immutable content, deletion permitted.** `REVOKE UPDATE` only; `SELECT, INSERT, DELETE` retained | `SELECT, INSERT, DELETE` | 3 | Literal reading of `FR-SEC-033`; preserves the approved SQL's cascade intent |
| **3** | **Production GAP-2 column-level** | — | — | **Not applicable** — no decision field needs to change |
| **4** | **Service-level guard only** | full | 4 | Weakest; no structural guarantee; contrary to the project's structural-enforcement preference and to D-6's ratified rejection of service-only enforcement |

### 8. Risks / Trade-offs

| Option | Risks | Trade-offs |
|---|---|---|
| **1** | Goes **beyond** the literal `FR-SEC-033` (immutable ≠ undeletable) and beyond ADR-010's enumeration, which excludes decisions. Sits in tension with the approved SQL's `ON DELETE CASCADE`, and — per the §3 caveat — may not actually prevent cascade deletion, giving a false sense of completeness unless the parent is also controlled | Simplest and strongest; identical to two verified in-repo implementations; smallest policy set; no ambiguity about what a decision record means |
| **2** | A decision could be erased. The audit entry survives independently (`FR-AUD-006`, `audit_entries.approver_id`/`approval_id`), so the historical fact is not wholly lost — but the authoritative record is | Faithful to the literal requirement and to the approved SQL's cascade design; no over-reach |
| **3** | Grants an update capability nothing needs | None — not applicable |
| **4** | No database-level guarantee; a defect or a raw query defeats `FR-SEC-033` | None that the project's precedent accepts |

### 9. Dependencies

- **D-9 (RLS)** — the policy set follows directly from the mechanism (2 vs 3 policies), and if
  D-9 adds `tenant_id` to `approval_decisions`, that column is immutable under either option.
  **Not resolved here.**
- **Parent-linkage question (exposed by D-5)** — couples to D-8 **only** through the cascade
  caveat: undeletability cannot be guaranteed by a grant on the child alone.
  **Not resolved here.**
- **D-4 clause 5** — no effect on D-8; preserved unresolved.
- **D-6** — already ratified; a different mechanism here is coherent.

### Recommended Direction

**The requirement is source-defined; the mechanism is not.** Stated as **recommendation and
inference, NOT ratification**:

**Option 1 (full append-only) is the recommended mechanism**, because — for the *content*
immutability `FR-SEC-033` actually requires — it is the strongest available guarantee, it is
already proven live twice in this repository, and no decision field needs to change so nothing
is lost by removing `UPDATE` entirely.

**Two honest caveats against treating that as a determination:**

1. Option 1 asserts more than the SRS does. `FR-SEC-033` says *immutable*; **ADR-010's
   never-deleted enumeration deliberately excludes approval decisions**, and the approved SQL
   supplies `ON DELETE CASCADE`. Choosing Option 1 adopts undeletability by architectural
   preference, not by requirement — and that should be ratified knowingly.
2. Per the §3 caveat, `REVOKE DELETE` on the child may not prevent cascade deletion from the
   parent. **Option 1 may therefore be incomplete on its own**, and its completeness depends on
   D-9 and the parent-linkage decision.

**Option 2 remains defensible** as the literal reading. **Options 3 and 4 are excluded** —
3 as inapplicable, 4 as contrary to ratified project practice (D-6 explicitly rejected
service-level-only enforcement).

### Ratification Required

**YES — RATIFIED 2026-08-17: Option 1, FULL APPEND-ONLY.**

### The precise question requiring ratification

> **What is the immutability and database-enforcement mechanism for
> `governance.approval_decisions`?**
>
> 1. **Choose the mechanism:** **Option 1** (full append-only: `GRANT SELECT, INSERT`,
>    `REVOKE UPDATE, DELETE, TRUNCATE`, no update/delete policy) or **Option 2**
>    (immutable content only: `REVOKE UPDATE`, `DELETE` retained).
> 2. **If Option 1**, confirm that **undeletability is adopted by architectural decision**,
>    since `FR-SEC-033` requires immutability but **ADR-010's never-deleted list excludes
>    approval decisions**.
> 3. **Confirm** that `UPDATE` is revoked under either option — no decision field may change
>    after INSERT (`FR-SEC-033`).

## D-9 — RLS / Tenant Isolation

> **RATIFIED 2026-08-17 — S1 + N1 + U4; DELETE left unresolved.**
>
> **Authoritative ratified decision:**
>
> 1. **Scope: S1** — `governance.approval_requests` and `governance.approval_decisions` only.
> 2. **Tenant anchoring: N1** — `approval_decisions` has **its own `tenant_id`** and uses a
>    **tenant-safe composite FK** design.
> 3. **`approval_requests` UPDATE enforcement: U4** — the UPDATE policy uses **both**:
>    - tenant predicate **+ `status = 'pending'`** in `USING`;
>    - **`WITH CHECK`** restricting the resulting status to **`approved` | `rejected`**.
> 4. **`approval_requests` DELETE: LEFT UNRESOLVED.** Neither X1 nor X2 is ratified.
> 5. **`approval_steps` remains UNRESOLVED** and is **NOT** included in D-9 scope.
> 6. **`anomaly_flags` remains OUT OF SCOPE** for Governance Phase 1.
> 7. **`audit_entries` remains UNCHANGED.**
> 8. All previously ratified decisions are **preserved exactly**.
> 9. The **`approval_decisions` → parent linkage** question **remains open**.
> 10. The **D-8 cascade / `ON DELETE` verification** remains an **unresolved Design Gate
>     verification item**.
> 11. **D-4 clause 5** (`rejected`-storage) **remains unresolved**.
> 12. **D-10, D-16, the D-3 residual, the D-7 mechanism, and D-12** remain unresolved as
>     previously recorded.
> 13. **This ratification authorizes no implementation**; it settles governance
>     decision/design constraints only.

> ---
>
> **AMENDMENT / CONSEQUENCE RECORDED BY D-7 (2026-08-17).** D-7 ratified mechanism **M2**,
> which adds a **self-approval conjunct** to the `approval_decisions` **INSERT** policy that
> D-9 ratified above.
>
> - **D-9's ratified text above is unchanged and is NOT reinterpreted.**
> - D-9's tenant-safety requirement is **preserved in full**: the INSERT policy remains
>   `WITH CHECK` tenant isolation (**T**).
> - The self-approval prohibition is added as an **additional conjunct**, giving
>   `WITH CHECK (T AND <NOT EXISTS self-approval traversal>)`.
> - `approval_decisions` remains **fully append-only under D-8** — SELECT and INSERT policies
>   only; no UPDATE, no DELETE.
> - The **concrete traversal predicate cannot be finalised** while the
>   `approval_decisions` → parent linkage question is unresolved; D-7 clause 9 explicitly
>   declined to invent it.

> ---
>
> **SECOND AMENDMENT / CONSEQUENCE RECORDED BY D-10 (2026-08-17).** D-10 ratified **Option E2 —
> decision-time expiry validity**, which adds an **unexpired-request conjunct** to the same
> `approval_decisions` **INSERT** policy.
>
> - **D-9's ratified text above remains unchanged and is NOT reinterpreted.**
> - **Tenant isolation (T) is retained**, and the **D-7 self-approval prohibition is retained**.
> - The resulting predicate is
>   `WITH CHECK (T AND <D-7 self-approval NOT EXISTS traversal> AND <D-10 request unexpired>)`.
> - Expiry **does not transition or mutate** `approval_requests` (D-10 clause 5), introduces
>   **no new lifecycle status** (clause 4), and adds **no scheduler** (clause 6).
> - `approval_decisions` remains **fully append-only under D-8**.
> - As with D-7, the **concrete traversal predicate cannot be finalised** while the
>   `approval_decisions` → parent linkage question is unresolved.

### Question
Which Governance tables require RLS in Phase 1, and what is the complete policy matrix —
enablement, forcing, tenant anchoring, per-command policies, cross-tenant behaviour and
no-context behaviour?

---

### 1. Evidence Classification Key

**A** = SOURCE REQUIREMENT · **B** = REPOSITORY/PRODUCTION PRECEDENT · **C** = APPROVED
SQL/DESIGN · **D** = ARCHITECTURAL INFERENCE · **E** = OPEN DESIGN-GATE QUESTION ·
**F** = EMPIRICAL VERIFICATION REQUIRED

---

### 2. Source Requirements (A)

- **`FR-PLT-010` [M]** — tenant isolation enforced at the database layer using PostgreSQL RLS,
  **independent of application-layer filtering**, with both `USING` and `WITH CHECK`.
- **`FR-PLT-011` [M]** — the application database role **SHALL NOT** have `BYPASSRLS`; a
  separate restricted migration/admin role is used for schema changes.
- **`FR-PLT-012` [M]** — *"Any request that reaches the data layer without a resolved tenant
  context SHALL **fail closed** with an error, never defaulting to an unfiltered query."*
- **`FR-PLT-003` [M]** — every tenant-scoped record carries an **immutable** `tenant_id`;
  records **SHALL NOT** be transferable between tenants.
- **`FR-PLT-013`/`FR-PLT-014` [M]** — CI must run a cross-tenant isolation suite and must fail
  if any `tenant_id` table lacks **enabled and forced** RLS. *(No CI exists — separate gap,
  not D-9's to solve.)*

**Fail-closed is therefore a source requirement (`FR-PLT-012`), not an inference.**

---

### 3. Existing Repository Precedent (B) — verified read-only

**Roles:** `ros_app` — `super=false`, **`bypassrls=false`** · `ros_migrator` — `super=true`,
`bypassrls=true`. Satisfies `FR-PLT-011`.

**Tenant-context mechanism — existing, not to be reinvented.**
`PrismaService.withAuthContext()` issues, transaction-locally:
```sql
SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)
```
(`src/prisma/prisma.service.ts:61`) — the parameterised equivalent of `SET LOCAL`, so context
is scoped to the transaction and cannot leak across pooled connections.

**Canonical policy shape**, identical across `org`, `catalogue`, `inventory`, `production`
(exemplar `production.recipes`):

| Command | `USING` | `WITH CHECK` | Roles |
|---|---|---|---|
| SELECT | `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` | — | `public` |
| INSERT | — | same predicate | `public` |
| UPDATE | same predicate | same predicate | `public` |
| DELETE | same predicate | — | `public` |

**Policies are NOT role-specific** — every existing policy targets `public`; isolation comes
from the predicate plus `ros_app` lacking `BYPASSRLS`. (B)

**Fail-closed mechanics:** with no context, `current_setting('app.tenant_id', true)` returns
`''`, `NULLIF` yields `NULL`, the comparison is `NULL`, and the row is filtered — 0 rows,
INSERT rejected. Verified live in every phase. (B)

**Two child-anchoring patterns, both ratified and live:**
- **Own `tenant_id` + composite tenant-safe FK** — `production.recipe_lines`,
  `inventory.stock_levels` (D-INV-09). Used where a child makes cross-aggregate references.
- **Inheritance via `EXISTS(parent)`** — `inventory.waste_lines`:
  `EXISTS (SELECT 1 FROM inventory.waste_records p WHERE p.id = waste_lines.waste_record_id
  AND p.tenant_id = …)`. Used for purely aggregate-internal children.

**ADR 0003** additionally records that policies may legitimately differ per command
(`memberships` SELECT carries an extra user-scoped branch that its write policies do not).
So a non-uniform matrix is precedented. (B)

---

### 4. Approved SQL / Design (C)

| Table | `tenant_id`? | Notes |
|---|---|---|
| `approval_requests` | **Yes** | Direct anchor available |
| `approval_steps` | **No** | — |
| `approval_decisions` | **No** | — |
| `anomaly_flags` | **Yes** | — |
| `audit_entries` | **Yes** | **Already implemented**: RLS enabled + forced, **2 policies** (SELECT, INSERT), `ros_app` grants `INSERT, SELECT` |

**The approved SQL defines no RLS, no grants and no policies for any approval table.** All
Governance approval RLS is greenfield design.

---

### 5. Table-by-Table Phase 1 Scope

| Table | Phase 1? | Basis |
|---|---|---|
| **`approval_requests`** | **YES** | D-1, D-4, D-6 are all ratified against it (**B/C**) |
| **`approval_decisions`** | **YES** | D-8 ratified against it (**B/C**) |
| **`approval_steps`** | **UNRESOLVED — E** | D-5 ratified SINGLE-STEP, so no multi-level chain exists. But `approval_decisions.approval_step_id` is `NOT NULL REFERENCES approval_steps(id)` in the approved SQL, and **the parent-linkage question is explicitly unresolved**. Whether the table is created at all in Phase 1 is **not D-9's to decide** |
| **`anomaly_flags`** | **NO — out of Phase 1** | **No ratified Governance decision references it.** It serves fraud/anomaly detection (§15.2 `governance.view_anomalies`; `FR-CST-043` baselines), which is outside **D-2 CORE ONLY** (approval request/decision model). Including it would expand ratified scope (**D**) |
| **`audit_entries`** | **ALREADY EXISTS — do not redesign** | ADR 0007 + `FR-AUD-003`. RLS enabled + forced with 2 policies. **D-9 leaves it untouched** (**A/B**) |

---

### 6. Interaction with D-6 — a finding that matters

**D-6 ratified:** `approval_requests` immutable except `status`, via Production GAP-2
(`REVOKE UPDATE` + `GRANT UPDATE (status)` + *"status-predicated RLS/policy mechanism"*),
**not service-level checks alone**.

**Verified live, the Production GAP-2 precedent does NOT actually constrain status via RLS:**

```
production.recipe_versions  UPDATE  USING = (tenant_id = …)          ← plain tenant predicate
production.recipe_versions  DELETE  USING = (tenant_id = …) AND (status = 'draft')
```

The **column grant** restricts *which column* may be written; the **UPDATE policy** restricts
only *which tenant's rows*. Only `DELETE` carries a status predicate. **Copying the Production
precedent verbatim would leave the permitted-transition half of D-6 unenforced.** (B)

To satisfy D-6's ratified wording, the UPDATE policy needs one or both of:

- **`USING (… AND status = 'pending')`** — restricts *which rows* may transition (a terminal
  row can never be updated again);
- **`WITH CHECK (… AND status IN ('approved','rejected'))`** — restricts *which target values*
  may be written.

Neither exists in any current repository policy. **This is new Governance design, not reuse.**
(**D** / **E**)

**`tenant_id` immutability under UPDATE (D-6 clause 3):** already structurally guaranteed by
`GRANT UPDATE (status)` — `tenant_id` is simply not writable. A `WITH CHECK` on `tenant_id` is
defence in depth, matching the canonical shape. (**D**)

---

### 7. Interaction with D-8

**D-8 ratified:** `approval_decisions` fully append-only — `GRANT SELECT, INSERT`;
`REVOKE UPDATE, DELETE, TRUNCATE`; no service-only enforcement.

**Policy implication is exact and precedented:** **SELECT and INSERT policies only — two
policies**, with **no UPDATE and no DELETE policy at all**. This mirrors `governance.audit_entries`
(2 policies) and `inventory.stock_movements` (2 policies). ADR 0007's rationale is that
enforcement sits at **both** layers: grants revoke the capability, and the absence of a policy
means that even a re-grant would still be denied. (**A/B**)

---

### 8. Tenant Anchoring for `approval_decisions` (and `approval_steps` if created)

Neither table carries `tenant_id`. Two ratified patterns exist:

| | Option | Depends on parent linkage? | Precedent |
|---|---|---|---|
| **(a)** | Add `tenant_id` + composite tenant-safe FK; direct RLS anchor | **No — parent-independent** | `recipe_lines`, `stock_levels` (ADR 0008 D-09, D-INV-09) |
| **(b)** | Inherit via `EXISTS(parent)`; no `tenant_id` added | **Yes — requires a settled parent** | `waste_lines` |

**Option (b) is currently blocked (E).** The parent of `approval_decisions` is
`approval_steps` in the approved SQL, whose Phase 1 existence is unresolved. An `EXISTS`
predicate cannot be written against an undecided parent.

**Option (a) de-couples D-9 from the linkage question entirely** — a direct `tenant_id`
anchor is valid whichever parent is later chosen. (**D**)

**If (a) is chosen, `FR-PLT-003` makes that `tenant_id` immutable** — automatically satisfied
under D-8, since no UPDATE capability exists at all.

---

### 9. `tenant_id` Immutability by Table

| Table | Immutable? | Mechanism |
|---|---|---|
| `approval_requests` | **Yes** — `FR-PLT-003` (A), D-6 clause 3 | `GRANT UPDATE (status)` makes it unwritable (structural) |
| `approval_decisions` | **Yes** (if added under option (a)) | **No UPDATE capability at all** (D-8) |
| `approval_steps` | **Contingent** | Only if the table is created — **E** |
| `anomaly_flags` | **Not applicable** | Out of Phase 1 scope |
| `audit_entries` | **Yes — already enforced** | ADR 0007 append-only; unchanged |

---

### 10. Cross-Tenant and No-Context Behaviour

| Operation | `approval_requests` | `approval_decisions` |
|---|---|---|
| **Cross-tenant SELECT** | 0 rows | 0 rows |
| **Cross-tenant INSERT** (spoofed `tenant_id`) | Rejected — RLS `WITH CHECK` violation | Rejected — RLS `WITH CHECK` violation |
| **Cross-tenant UPDATE** | 0 rows affected | **`permission denied`** — no UPDATE grant (D-8) |
| **Cross-tenant DELETE** | 0 rows affected | **`permission denied`** — no DELETE grant (D-8) |
| **No tenant context** | 0 rows on SELECT; INSERT rejected | 0 rows on SELECT; INSERT rejected |

**No-context behaviour is fail-closed by source requirement** (`FR-PLT-012`), realised by the
`NULLIF(...)::uuid → NULL` predicate. Every prior phase verified this live with positive
controls. (**A/B**)

---

### 11. PostgreSQL Behaviours — Verified vs. Requiring Verification

| Behaviour | Status |
|---|---|
| `ros_app` has **no** `BYPASSRLS` | **Verified read-only this task** (`pg_roles`) — **B** |
| `FORCE ROW LEVEL SECURITY` also subjects the **table owner** to policies | Standard PostgreSQL semantics; applied on all 48 existing tenant tables — **B** |
| Fail-closed via `NULLIF(...)::uuid` | **Verified live in every prior phase** — **B** |
| **FK checks bypass RLS** | **Project-established**, ADR 0008 D-09 verbatim: *"PostgreSQL evaluates referential-integrity checks with row security **disabled**."* This is why composite tenant-safe FKs exist — **A/B** |
| **`ON DELETE CASCADE` vs. revoked child `DELETE`** (D-8 interaction) | **NOT VERIFIED — F.** Carried forward from D-8 clause 6. Whether cascade from a parent can remove an append-only `approval_decisions` row despite `REVOKE DELETE` **must be empirically verified before implementation.** Not asserted here |
| Policy `roles=public` is the project norm | **Verified read-only** — **B** |

---

### 12. Minimum RLS Policy Matrix (Design Gate baseline)

Predicate `T` := `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`

| Table | RLS | FORCE | SELECT | INSERT | UPDATE | DELETE | Policies |
|---|---|---|---|---|---|---|---|
| **`approval_requests`** | ENABLE | **FORCE** | `USING T` | `WITH CHECK T` | **RATIFIED U4:** `USING (T AND status='pending')` + `WITH CHECK (T AND status IN ('approved','rejected'))` | **UNRESOLVED — clause 4** | 3 ratified + DELETE open |
| **`approval_decisions`** | ENABLE | **FORCE** | `USING T` | `WITH CHECK T` | **none** (D-8) | **none** (D-8) | **2 — RATIFIED (N1: own `tenant_id`)** |
| `approval_steps` | — | — | — | — | — | — | **E — table existence unresolved** |
| `anomaly_flags` | — | — | — | — | — | — | **Out of Phase 1** |
| `audit_entries` | *(already)* | *(already)* | *(already)* | *(already)* | none | none | **2 — unchanged** |

`approval_decisions` uses `T` directly **only if anchoring option (a)** is chosen; under (b) the
predicate becomes an `EXISTS(parent)` form and is **blocked** by the linkage question.

**A DELETE policy on `approval_requests` is itself an open question (E):** no ratified decision
states whether an approval request may ever be deleted. D-6 governs mutability, not deletion.
**Not resolved here.**

---

### 13. Reuse vs. New Design

| Reused unchanged (B) | New Governance design (D/E) |
|---|---|
| Predicate `T`; ENABLE + FORCE; `roles=public`; `withAuthContext` context mechanism; fail-closed semantics; SELECT/INSERT policy shapes; the 2-policy append-only shape for `approval_decisions`; composite tenant-safe FK pattern | The **status-transition predicate** on `approval_requests` UPDATE (§6 — no precedent exists); the **anchoring choice** for `approval_decisions` (§8); whether `approval_requests` gets a **DELETE policy** at all |

---

### 14. Ratification Options

**Scope** — which tables receive Governance RLS in Phase 1:

| | Option | Note |
|---|---|---|
| **S1** | **`approval_requests` + `approval_decisions` only.** `approval_steps` and `anomaly_flags` not created; `audit_entries` untouched | Consistent with D-2 CORE ONLY, D-5 SINGLE-STEP, and leaves the linkage question open |
| **S2** | S1 **+ `approval_steps`** | **Requires the parent-linkage question to be resolved first** — outside D-9 |
| **S3** | S1 **+ `anomaly_flags`** | Expands beyond ratified D-2 CORE ONLY scope |

**Anchoring for `approval_decisions`:**

| | Option | Note |
|---|---|---|
| **N1** | Own `tenant_id` + composite tenant-safe FK, direct `T` anchor | Parent-independent; matches ADR 0008 D-09 |
| **N2** | `EXISTS(parent)` inheritance | **Blocked** — parent undecided |

**Status-transition enforcement on `approval_requests` UPDATE (D-6 clause 2):**

| | Option | Enforces |
|---|---|---|
| **U1** | `USING T` only (Production precedent verbatim) | Tenant only — **does not enforce transitions** |
| **U2** | `USING (T AND status = 'pending')` | Only a pending row may transition |
| **U3** | `WITH CHECK (T AND status IN ('approved','rejected'))` | Only legal target values |
| **U4** | **U2 + U3** | Both source row and target value |

**Deletion of `approval_requests`:**

| | Option |
|---|---|
| **X1** | DELETE policy with `USING T` (deletion permitted within tenant) |
| **X2** | No DELETE policy + `REVOKE DELETE` (requests never deleted) |

### Recommended Direction

**Recommendation, NOT ratification** — the SRS fixes the *principles* (`FR-PLT-010/011/012/003`)
but not these specific choices:

- **Scope: S1.** S2 is blocked by an unresolved question; S3 exceeds D-2.
- **Anchoring: N1.** It is the only option that is **parent-independent**, so D-9 need not wait
  on the linkage question, and it matches the ratified D-09 composite-FK architecture.
- **Transition enforcement: U4.** D-6 ratified that transitions be enforced by the policy
  mechanism and explicitly **not** by service checks alone; U1 would leave that half unenforced,
  and U2 or U3 alone each leave one side open.
- **Deletion: NO SOURCE-SUPPORTED RECOMMENDATION.** No ratified decision or SRS requirement
  addresses deleting an approval request. X1 and X2 are both defensible.

### Ratification Required

**YES — RATIFIED 2026-08-17: S1 + N1 + U4; DELETE unresolved.**

### The precise question requiring ratification

> **What is the Governance Phase 1 RLS scope and policy matrix?**
>
> 1. **Scope:** S1 · S2 · S3
> 2. **`approval_decisions` anchoring:** N1 · N2
> 3. **`approval_requests` UPDATE transition enforcement:** U1 · U2 · U3 · U4
> 4. **`approval_requests` deletion:** X1 · X2
> 5. **Confirm** ENABLE + FORCE on every Phase 1 Governance table, the canonical predicate,
>    `roles=public`, and fail-closed behaviour per `FR-PLT-012`.
> 6. **Confirm** `audit_entries` is left **unchanged**.

### Dependencies

**Parent-linkage question** — blocks S2 and N2; N1 avoids it. **D-8 clause 6 cascade
verification (F)** — must be discharged before implementation. **D-4 clause 5**, **D-10**,
**D-16**, **D-3 residual** — untouched by D-9.

## D-10 — Expiry Semantics

> **RATIFIED 2026-08-17 — OPTION E2: DECISION-TIME EXPIRY VALIDITY.**
>
> **Authoritative ratified decision:**
>
> 1. `expires_at` is **retained** as the approval request's expiry value.
> 2. **Expiry is evaluated when an approval decision is inserted.**
> 3. An approval decision **MUST NOT be inserted** for an approval request whose `expires_at`
>    has passed.
> 4. Expiry **MUST NOT introduce `expired`** or any other new Governance Phase 1 lifecycle
>    status.
> 5. Expiry **does not itself transition or mutate** `approval_requests`.
> 6. **No scheduler, cron job, sweep, or background expiry process** is introduced by D-10.
> 7. `expires_at` **remains immutable after creation**, consistent with **D-6 Option B**.
> 8. Expiry enforcement occurs at the **database approval-decision INSERT boundary**,
>    consistent with **D-7's** database-enforced mechanism.
> 9. **D-9 is explicitly amended:** the `approval_decisions` INSERT `WITH CHECK` predicate
>    retains **tenant isolation (T)** and the **D-7 self-approval prohibition**, and
>    **additionally requires the approval request to be unexpired at decision time**.
> 10. **D-4's ratified lifecycle remains unchanged:** `pending → approved`,
>     `pending → rejected`.
> 11. D-10 **does not define expiry or staleness semantics for an already-granted approval**.
> 12. D-10 **does not define consuming-domain behaviour** after an approval has been granted.
> 13. **D-10 does not authorize implementation.**
> 14. All previously ratified decisions **remain preserved exactly**.
> 15. **D-4 clause 5**, the **`approval_decisions` → parent-linkage** question,
>     **`approval_requests` DELETE**, the **D-8 cascade verification**, **D-11**, **D-14**,
>     **D-15**, **D-16**, **D-18**, **D-19**, **D-20**, the **D-3 residual**, and **D-12**
>     remain **unresolved** unless separately decided.

### Question
What does the `FR-SEC-031` expiry *do* — how is it detected, what are its lifecycle
consequences, and may an expired request or approval still be acted upon?

---

### 1. Source Evidence (A) — the complete textual basis

**`FR-SEC-031` [M]:** *"Approval requests SHALL specify: the requesting user, the action, the
affected entity, the value, the required approver permission, and **an expiry**."*

**That single word is the entire SRS basis.** An exhaustive search for
*expir / lapse / valid until / time-limited / stale* in proximity to *approval / request*
returns exactly **two** hits in the whole document:

| Line | Hit | Relevance |
|---|---|---|
| 3774 | `FR-SEC-031` — *"and an expiry"* | **The only approval-expiry text** |
| 3142 | `FR-PRC-020` — *"an email link with a signed, single-use, **time-limited** token"* | **A different object** — a signed link token, not the approval request |

**The SRS defines nothing about:** detection, default duration, status effect, whether an
expired request may still be decided, whether a granted approval itself expires, or who may
extend it.

**A scheduler is NOT required by the SRS for expiry (A).** §15.6 contains **zero** occurrences
of *scheduled / job / cron*. Where the SRS wants a scheduled job it says so explicitly — it does
so in **`FR-AUD-005`, `FR-DR-002`, `FR-INV-011`, `FR-SEC-061`** and nowhere in the approval
section. Any scheduled-sweep model is therefore **architectural possibility, not requirement**.

**`FR-SEC-034` [S] is a different time concept.** Its *"configured period"* governs
**escalation**, not expiry, and D-12 is **BLOCKED**. The two must not be conflated.

---

### 2. The Distinction the SRS Leaves Unmade (D)

`FR-SEC-031` places expiry on the **request**. It says nothing about the **granted approval**.
These are separable and the SRS separates neither:

| Concept | Meaning | SRS position |
|---|---|---|
| **Request expiry** | The window within which a decision may be made | The only thing `FR-SEC-031` plausibly denotes |
| **Approval expiry** | A granted approval becoming stale and no longer usable by a consumer | **Never addressed** |

**Consequence:** the question *"may an expired approval still be referenced?"* may be a category
error — what `FR-SEC-031` gives an expiry to is the **request**, not the resulting approval. A
model that expires *granted approvals* would be **invention**. Recorded, not resolved.

---

### 3. Constraint from D-6 (already ratified — not amendable here)

**D-6 clause 4, verbatim:** *"The only mutable field authorized by D-6 is `status`. All other
`approval_requests` fields are immutable after creation."*

**Therefore `expires_at` is IMMUTABLE after creation.** Under D-6's ratified Mechanism 1
(`REVOKE UPDATE` + `GRANT UPDATE (status)`), it is not merely forbidden but **structurally
unwritable**.

D-6 considered and **did not choose** its Option C (*immutable except `status` **and**
`expiry`*). **Any expiry model requiring extension, renewal or recalculation of `expires_at`
would need an explicit D-6 amendment** — which D-10 must not make silently. **(B)**

---

### 4. Constraint from D-4 (already ratified)

**D-4 clause 3:** *"Do NOT introduce: cancelled, escalated, **`expired` as a lifecycle
status**, any other invented workflow state."*
**D-4 clause 4:** *"Expiry remains a separate unresolved decision owned by **D-10**. D-4 does
not determine what expiry does or **whether expiry becomes a status**."*

**Reading the two together:** D-4 declined to introduce `expired` **itself**, and assigned the
question to D-10. **D-10 may therefore introduce it — but only by an explicit amendment
extending D-4's ratified status set**, in the same manner D-7 amended D-9. It cannot be
absorbed silently. **(B)**

---

### 5. Repository Precedent (B)

**Production D-17-08 Q2 is directly on point.** `production.recipe_versions.effective_from` was
ratified as **informational only** — *"`effective_from` is informational and MUST NOT be
evaluated"* — a stored, returned date field that drives no behaviour. Verified live: zero
occurrences in selection logic, zero indexes, zero policies. **This is an established project
answer to structurally the same question**, reached after the same kind of analysis (the SRS
supplied the column and no semantics).

**D-7's M2 mechanism (just ratified)** establishes that a validity predicate can be enforced by
adding a conjunct to the `approval_decisions` **INSERT** `WITH CHECK` policy, with cross-table
traversal — precedented three times in the repository.

**D-8** makes an INSERT-time check *complete*: with no UPDATE and no DELETE on decisions, there
is no mutation path by which an expired-but-decided row could later appear.

---

### 6. Viable Models

| | Model | Detection | New status? | Scheduler? | Amends |
|---|---|---|---|---|---|
| **E1** | **Informational only** — stored, returned, never evaluated | none | No | No | nothing |
| **E2** | **Validity predicate, lazily evaluated at decision INSERT** — a decision may not be inserted once `now() > expires_at`; request stays `pending` | lazy, at the point of action | No | No | **D-9** (a further INSERT-policy conjunct) |
| **E3** | **Status-changing** — request transitions to `expired` | lazy on read/act, **or** scheduled sweep | **Yes** | Only if swept | **D-4** (status set); **D-9**; possibly **D-6** |
| **E4** | **Consuming-side validity** — the consuming domain checks expiry when presenting `approvalId` | at the consumer | No | No | nothing in Governance |

**Not viable without invention:** any model that **extends or recalculates** `expires_at`
(barred by D-6 clause 4 unless D-6 is amended); any model that expires a **granted approval**
(§2 — the SRS never addresses it).

---

### 7. Interactions With Ratified Decisions

| Decision | Interaction |
|---|---|
| **D-4** (lifecycle) | **E3 requires an explicit amendment** to the ratified status set. E1/E2/E4 require none |
| **D-6** (immutable except status) | **`expires_at` is immutable and structurally unwritable.** Any extension model needs a D-6 amendment |
| **D-7** (self-approval M2) | **Same mechanism, same policy.** E2 would use the pattern D-7 just ratified |
| **D-8** (decisions append-only) | **Makes E2 complete** — no mutation path exists, so an INSERT-time check is not partial |
| **D-9** (RLS S1+N1+U4) | **E2 would add a THIRD conjunct** to the `approval_decisions` INSERT policy, giving `WITH CHECK (T AND <self-approval traversal> AND <not expired>)`. That is a **second D-9 amendment** and must be explicit, following the D-7 precedent |
| **D-13** (thresholds domain-owned) | **No conflict.** `FR-SEC-031` says the *request* specifies its expiry, so the value is caller-supplied — consistent with D-13's model |
| **D-14** (API surface) | If no endpoint evaluates expiry, E2's enforcement is entirely at decision INSERT. **Unresolved** |
| **D-15** (concurrency) | **E2 is atomic** — the check occurs inside the INSERT transaction, so there is no race. **E3 with a scheduled sweep introduces one.** D-15 **not resolved** |

---

### 8. May an Expired Request or Approval Still Be Acted Upon?

**The SRS is silent (A).** Two pieces of adjacent evidence, neither decisive:

- **SRS §24.2.3's consumption sample checks only `!cmd.approvalId`** — *"if (decision.requiresApproval && !cmd.approvalId) throw new ApprovalRequiredError"*. **It performs no expiry check.** That is an illustrative Sales example in an architecture chapter, not a requirement — but it is the only depiction of approval consumption in the document, and expiry does not appear in it.
- **`FR-PRC-020`'s token is separately time-limited**, which shows the SRS does specify time limits when it means them — and it did not do so for approval consumption.

**Unresolved (E).**

---

### 9. Evidence Classification

| Claim | Class |
|---|---|
| An approval request has an expiry | **A** — `FR-SEC-031` |
| Detection, effect, duration, post-expiry behaviour | **Undefined — E** |
| No scheduler is required by the SRS for expiry | **A** — §15.6 has no "scheduled job"; the SRS names one in four other requirements |
| `FR-SEC-034`'s "configured period" is escalation, not expiry | **A** |
| `expires_at` is immutable | **B** — D-6 clause 4, ratified |
| `expired` as a status requires amending D-4 | **B** — D-4 clauses 3 and 4 read together |
| E2 would require a second D-9 amendment | **B/D** — following the D-7 precedent |
| Informational-only is an established project answer | **B** — D-17-08 Q2 |
| Request expiry vs granted-approval expiry | **D** — a distinction the SRS never makes |
| Whether an expired request may still be decided | **E** |

---

### 10. Options Requiring Decision

| | Option | Cost | Amendments needed |
|---|---|---|---|
| **E1** | Informational only — stored and returned, never evaluated | `FR-SEC-031` satisfied only in the weakest sense: the field exists | **None** |
| **E2** | Validity predicate at decision INSERT (RLS conjunct, D-7's M2 pattern) | One further conjunct on an already-twice-specified policy | **D-9** (explicit second amendment) |
| **E3** | Status-changing (`expired`) | Requires detection; a sweep needs a scheduler that does not exist and is not SRS-required | **D-4** (status set) **+ D-9**; possibly **D-6** |
| **E4** | Consuming-side validity only | Governance stores and exposes; consumers decide | **None in Governance**; but consuming domains are out of Phase 1 (D-2, D-17) |

### Recommended Direction

**NO SOURCE-SUPPORTED RECOMMENDATION.** The SRS supplies one word — *"an expiry"* — and nothing
else. Every behavioural model beyond storing the field is architectural choice.

**Observations offered without ratifying:**

- **E1 has the strongest in-repo precedent.** D-17-08 Q2 answered a structurally identical
  question — a date column the SRS supplied without semantics — with *informational only*.
- **E2 is the cheapest behavioural model**: no new status, no scheduler, no D-4 or D-6
  amendment, and D-8 makes it complete. Its cost is a **second explicit amendment to D-9**.
- **E3 is the most expensive**: it needs a D-4 status amendment, and lazy detection makes the
  status unreliable while a sweep needs a scheduler the SRS does not require and the project
  does not have.
- **E4 defers the behaviour to domains that do not exist in Phase 1** (D-2 CORE ONLY, D-17).

### Ratification Required

**YES — RATIFIED 2026-08-17: Option E2.**

### The precise question requiring ratification

> **What does the `FR-SEC-031` expiry do in Governance Phase 1?**
>
> 1. **Choose the model:** **E1** · **E2** · **E3** · **E4**.
> 2. **If E2**, confirm the **second explicit amendment to D-9**: the `approval_decisions`
>    INSERT policy becomes `WITH CHECK (T AND <self-approval traversal> AND <not expired>)`.
> 3. **If E3**, confirm the **explicit amendment to D-4** adding `expired` to the ratified
>    status set, and state whether detection is **lazy** or **scheduled** — noting no scheduler
>    exists and none is SRS-required.
> 4. **Confirm** that `expires_at` remains **immutable** per D-6 clause 4 — or, if extension is
>    wanted, state the **explicit D-6 amendment**.
> 5. **Confirm** whether expiry governs only the **request's decision window**, or is also
>    claimed to expire a **granted approval** — the SRS addresses only the former.

### Dependencies

**D-9** (amended by E2) · **D-4** (amended by E3) · **D-6** (amended only if extension is
wanted) · **D-14** (whether any endpoint evaluates expiry) · **D-15** (E3-with-sweep introduces
concurrency questions). **D-12** remains BLOCKED and is a separate time concept.

## D-11 — Notification Scope

> **RATIFIED 2026-08-17 — OPTION N-B: STRICT NONE + EXPLICIT DEFERRAL RECORD.**
>
> **Authoritative ratified decision:**
>
> 1. Governance Phase 1 introduces **NO notification implementation**.
> 2. Governance Phase 1 **MUST NOT** introduce notification channels, in-app notifications,
>    notification persistence tables, notification endpoints, notification permissions,
>    approval notification events, outbox infrastructure, queues, workers, schedulers, or other
>    notification-delivery infrastructure.
> 3. **`FR-SEC-032` remains explicitly OUT OF SCOPE** for Governance Phase 1, exactly as
>    established by **D-2 CORE ONLY**.
> 4. The **synchronous manager-PIN** and **asynchronous manager-mobile-notification**
>    behaviours in `FR-SEC-032` remain **knowingly unmet** for Governance Phase 1 and **MUST
>    NOT be silently reintroduced** through D-11.
> 5. Notification channel infrastructure identified by **`IR-INT-040`/`041`/`042`/`043`**
>    remains an **Integrations** concern under **SRS §23.5** and is **not implemented or owned**
>    by Governance Phase 1.
> 6. D-11 **does not create a Governance notification publisher or `approval.*` event**.
> 7. Governance remains a **subscriber** where already defined by the SRS; D-11 **does not add
>    any new Governance-published event**.
> 8. D-11 **does not introduce requester outcome notifications**.
> 9. D-11 **does not introduce escalation notifications.** Escalation remains governed
>    separately by `FR-SEC-034` and **D-12, which remains BLOCKED**.
> 10. D-11 **does not introduce expiry notifications.** **D-10 remains exactly as ratified**:
>     decision-time expiry validity, no `expired` status, and no scheduler.
> 11. D-11 **does not define granted-approval staleness or consuming-domain notification
>     behaviour**; those remain **unresolved under D-10**.
> 12. **No notification persistence, delivery mechanism, API surface, permission, event
>     contract, or infrastructure is authorized** by D-11.
> 13. This decision **does not amend** D-2, D-4, D-6, D-7, D-8, D-9, D-10, D-13, or D-17.
> 14. **D-16 remains OPEN and MUST REMAIN OPEN.**
> 15. D-11 is a **Governance Phase 1 scope/deferral decision only** and **DOES NOT authorize
>     implementation**.
>
> ---
>
> **EXPLICIT DEFERRAL RECORD (D-11, 2026-08-17).**
>
> The SRS-defined **notification-channel capability** in **§23.5** —
> **`IR-INT-040`** (SMS, WhatsApp Business, email, mobile push as channels),
> **`IR-INT-041`** (localised, tenant-customisable templates),
> **`IR-INT-042`** (consent flags; suppress marketing, permit transactional),
> **`IR-INT-043`** [S] (per-notification delivery status; surface persistent failures)
> — **belongs to the Integrations concern and is DEFERRED outside Governance Phase 1.**
>
> **The distinction is preserved:**
>
> | Concern | Owner | Phase 1 status |
> |---|---|---|
> | **Governance approval workflow** — request/decision model, authority, immutability, RLS | Governance | **In scope** (D-2 CORE ONLY) |
> | **Notification delivery infrastructure** — channels, templates, consent, delivery status | **Integrations (§23.5)** | **Deferred; not owned by Governance** |
>
> Consequently **`FR-SEC-032` must be reported as knowingly unmet** at Governance Phase 1
> close-out. The Governance phase **must not be reported complete on the strength of the
> approval model alone.**

### Question
What notification behaviour, if any, is Governance Phase 1 required to support, and what
remains outside scope?

---

### 1. Exhaustive Source Search (A)

**33 requirements** across the SRS mention *notification / notify / alert / email / push / SMS /
WhatsApp / messaging / in-app*. Of those, **exactly ONE sits in §15.6 Approval Workflow
Engine** — verified programmatically:

> **`FR-SEC-032` [M]** — *"Approvals SHALL be obtainable synchronously (manager PIN on the
> terminal) or asynchronously (**push notification to the manager's mobile device**), with the
> terminal remaining usable while awaiting an asynchronous decision."*

**Notification infrastructure is an explicitly-owned Integrations concern.** SRS **§23.5
Notifications** is a dedicated section:

> **`IR-INT-040` [M]** — *"The System SHALL support **SMS, WhatsApp Business, email, and mobile
> push** as notification channels."*
> **`IR-INT-041` [M]** — templates localised and tenant-customisable.
> **`IR-INT-042` [M]** — respect consent flags; suppress marketing, permit transactional.
> **`IR-INT-043` [S]** — *"record delivery status per notification and SHALL surface persistent
> failures."*

**Approval-adjacent notification requirements outside §15.6, all in unimplemented domains:**

| Requirement | Domain | Text |
|---|---|---|
| `FR-PRC-020` [M] | Procurement | *"Approval SHALL be actionable from the mobile app and from an **email link** with a signed, single-use, time-limited token."* |
| `FR-POS-048` [M] | Sales | *"remote approval request to the manager's mobile app"* |
| `FR-AUD-010` [M] | Audit | impersonation requires *"tenant-visible notification"* — not approval-related |

---

### 2. Three Decisive Negative Findings (A)

**(i) No requirement anywhere obliges notifying the REQUESTER of an outcome.** A targeted
search for *notify / inform / tell / advise* in proximity to *requester / requesting user /
originator* returns **NONE FOUND**. **Approval-outcome notification is not SRS-defined.**

**(ii) `FR-SEC-034` (escalation) does NOT mention notification.** Its text is
*"if no decision is made within a configured period, the request escalates to the next approval
level"* — a **routing** concept, with no delivery verb. **Escalation notification is not
SRS-defined**, and D-12 is **BLOCKED** independently.

**(iii) Governance is NEVER a publisher in the SRS event catalogue.** §5.5.4 lists Governance
**only as a subscriber** — to `order.line.voided`, `order.refunded`, `discount.applied`,
`stock.counted`, `waste.recorded`, `cash.variance.detected`, `purchase_order.approved`,
`sync.conflict.resolved`. **No `approval.*` event exists anywhere in the SRS** (zero hits).
Notably, `purchase_order.approved` is published by **Procurement**, with Governance as a
*consumer* — the reverse of what an outbox in Governance would imply.

**There is also no expiry-notification requirement** — consistent with **D-10**, which ratified
decision-time validity with **no scheduler** and no expiry status.

---

### 3. Classification of Notification Behaviour

**A — Explicitly mandated by the SRS (for Governance):**
- `FR-SEC-032` asynchronous half: push notification to the manager's mobile device. **This is
  the only one.**

**B — Implied by examples or workflow descriptions, not mandated for Governance:**
- `FR-PRC-020` email-link actionability (Procurement); `FR-POS-048` remote approval request
  (Sales); §12.4 flow step 5 *"Approver approves from mobile"*.

**C — Not supported by the SRS at all:**
- Requester outcome notification · escalation notification · expiry notification ·
  in-app notification for approvals · any Governance-published approval event ·
  a Governance notification table, endpoint, permission, queue, worker or outbox.

---

### 4. Reconciliation With D-2 — precise, without broadening or narrowing

**D-2 ratified (verbatim):**

> *"The synchronous half of `FR-SEC-032` (manager PIN on the terminal) and the asynchronous half
> (push notification) are both **OUT OF SCOPE** for the first Governance phase… **`FR-SEC-032`
> is consequently NOT satisfied and must be recorded as knowingly unmet.** The Governance phase
> MUST NOT be reported complete on the strength of the approval model alone."*

**Exactly what D-2 put outside Phase 1 scope:** both halves of `FR-SEC-032` — the synchronous
PIN path **and** the asynchronous push-notification path.

**What D-2 did not address**, because no source raised it: in-app notification, notification
persistence, a notification endpoint or permission, and event/outbox emission. **Finding (iii)
above shows none of these is SRS-required for Governance either.**

**Consequence:** since `FR-SEC-032` is the *only* SRS-mandated notification behaviour for
Governance, and D-2 already placed it out of scope, **there is no remaining SRS-mandated
notification requirement for Governance Phase 1.**

---

### 5. Reconciliation With Other Ratified Decisions

| Decision | Interaction |
|---|---|
| **D-2** CORE ONLY | Already excludes both halves of `FR-SEC-032`. **D-11 is largely a confirmation of this** |
| **D-4** lifecycle | No notification is attached to any transition by any source |
| **D-5** SINGLE-STEP | Removes multi-level routing, hence any inter-level notification |
| **D-6** immutable except status | No notification field exists or is required on the request |
| **D-7** self-approval via INSERT RLS | Database-boundary enforcement; no notification involved |
| **D-8** decisions append-only | A decision is a row insert; no source requires it to emit anything |
| **D-9** RLS (S1, amended by D-7 and D-10) | Scope is `approval_requests` + `approval_decisions` only — **no notification table is in scope** |
| **D-10** expiry = decision-time validity | Ratified **no scheduler**; a notification-on-expiry model would need one, and none is SRS-required |
| **D-12** BLOCKED | Escalation is blocked on scheduler + settings + steps; and `FR-SEC-034` does not mention notification regardless |
| **D-16** OPEN | Untouched |
| **D-17** strict Inventory boundary | Consuming-domain notification is outside Governance entirely |

---

### 6. What D-11 Actually Is (D)

**D-11 is primarily a SCOPE CONFIRMATION resulting from D-2, with a residual mechanism
question.**

- The **scope** half is nearly settled by D-2: the only SRS-mandated Governance notification
  (`FR-SEC-032` async) is already out of scope.
- The **residual mechanism** question is whether Governance Phase 1 should nonetheless build any
  notification-adjacent mechanism *not* named by D-2 — in-app, table, endpoint, permission,
  event, outbox, queue, worker. **The evidence in §2 shows no source requires any of them.**

It is therefore **not** primarily an architectural mechanism decision, and it is **not** a new
source-defined scope decision. Classifying it correctly matters, because treating it as a
mechanism decision would invite inventing infrastructure the SRS assigns to Integrations.

---

### 7. Options

| | Option | Exact behaviour |
|---|---|---|
| **N-A** | **No notification implementation in Phase 1 (strict).** No channel, no in-app notification, no table, no endpoint, no permission, no event, no outbox, no queue, no worker, no scheduler | Governance stores requests and decisions; nothing is delivered anywhere |
| **N-B** | **N-A, plus an explicit deferral record.** Same zero implementation, but the register/gate records `FR-SEC-032` as knowingly unmet and names **`IR-INT-040`…`043` (Integrations §23.5)** as the owner of the channels | Documentation differs; behaviour identical to N-A |
| **N-C** | **Minimal in-app notification persistence** — a Governance notification table plus read surface | Would create a table and endpoint |
| **N-D** | **Event/outbox emission** on approval lifecycle | Would make Governance a publisher |

---

### 8. Evidence For and Against Each Option

| Option | SRS basis | D-2 interaction | D-10 interaction | D-12 blocking? | Schema / API / infra | Amends a ratified decision? | Expands Phase 1 scope? |
|---|---|---|---|---|---|---|---|
| **N-A** | Consistent with the SRS: the only mandated behaviour (`FR-SEC-032` async) is already out of scope by D-2 | **Direct confirmation** | None — D-10 needs no notification | No | **None** | **No** | **No** |
| **N-B** | Same as N-A; adds traceability for `FR-SEC-032` and names §23.5 as channel owner. Precedent: Production recorded `recipe.version.published` as **deferred** rather than inventing an outbox | **Direct confirmation, made explicit** | None | No | **None** | **No** | **No** |
| **N-C** | **No SRS basis.** No requirement mandates in-app notification for Governance; §23.5 assigns channels to Integrations | Would go **beyond** D-2 without amending it | None | No | **New table + endpoint + likely a permission** — and §15.2 supplies no notification permission | Would require expanding **D-9** scope (S1) and **D-14** | **Yes** |
| **N-D** | **Contradicted by §5.5.4** — Governance is listed **only as a subscriber**; **no `approval.*` event exists** | Beyond D-2 | None | No | **Outbox/event infrastructure** — which no repository component has, and which Production explicitly declined to invent | Would expand **D-9**/**D-14** | **Yes** |

---

### 9. Recommendation

**NOT A RATIFICATION — analysis only.**

The evidence supports **N-A or N-B**, which differ **only in documentation**, not behaviour.
Both are consistent with every ratified decision and require no amendment, no schema, no API and
no infrastructure.

**N-C and N-D are not supported by the sources.** N-C has no SRS basis and would need a
permission §15.2 does not supply; N-D is contradicted by §5.5.4, which lists Governance solely
as an event *subscriber* and defines no approval event at all.

**Between N-A and N-B**, the project's own precedent favours recording the deferral explicitly:
Production Spec recorded `recipe.version.published` as **deferred**, naming the missing
infrastructure, rather than leaving the gap silent. That is a documentation preference, **not a
recommendation to implement anything**.

---

### 10. Must Remain Unresolved

- **Escalation** — `FR-SEC-034` [S]; **D-12 BLOCKED**; and it does not mention notification.
- **Expiry notification** — no SRS requirement; **D-10** ratified no scheduler.
- **Granted-approval staleness** — explicitly left undefined by **D-10 clauses 11–12**.
- **Consuming-domain notification** — outside Governance (**D-17**, **D-2**).
- **Notification delivery mechanism** — owned by **Integrations §23.5** (`IR-INT-040`…`043`),
  an unimplemented domain.
- **Notification persistence and delivery status** — `IR-INT-043` [S], Integrations.
- **Dependency on D-12** — any escalation-triggered delivery is blocked twice over.

### Ratification Required

**YES — RATIFIED 2026-08-17: Option N-B.**

### The precise question requiring ratification

> **Does Governance Phase 1 implement any notification mechanism?**
>
> 1. **Choose:** **N-A** (strict none) · **N-B** (none + explicit deferral record naming
>    §23.5 as channel owner) · **N-C** (in-app persistence) · **N-D** (event/outbox).
> 2. **Confirm** that `FR-SEC-032` remains **knowingly unmet**, as D-2 already ratified, and
>    that D-11 neither broadens nor narrows that decision.
> 3. **Confirm** that no notification table, endpoint, permission, event, outbox, queue,
>    worker or scheduler is introduced (N-A/N-B), or state precisely what is (N-C/N-D).

### Dependencies

**D-2** (already excludes `FR-SEC-032`) · **D-12** (BLOCKED; escalation) · **Integrations §23.5**
(channel owner, unimplemented) · **D-9** and **D-14** would require expansion under N-C/N-D.

## D-12 — Escalation Semantics

### Question
Is `FR-SEC-034` escalation in scope, and if so where does the "configured period" live and how does escalation advance the request?

### SRS Evidence
`FR-SEC-034` **[S]**: *"The System SHALL support escalation: if no decision is made within a configured period, the request escalates to the next approval level."*

Supporting: `FR-PRC-018` defines the ordered approver levels escalation would traverse.

### Existing Repository Evidence
`approval_steps.sequence` provides ordering. No scheduler. No settings resolver (ADR 0008 D-11 deferred `org.settings`). No precedent for time-triggered transitions.

### Conflict / Gap
**GAP-8.** Three sub-gaps: (i) where the "configured period" is stored — settings are deferred; (ii) how "next approval level" is derived from bands (**D-13**); (iii) whether escalation mutates request status (**D-4**).

### Options
- **(a)** Out of scope — `[S]` priority; record as knowingly unmet.
- **(b)** In scope — requires a scheduler, a configuration home for the period, and multi-step approval (**D-5**).

### Recommended Direction
**(a)** for the first phase. `FR-SEC-034` is `[S]` (Should), not `[M]`, and it depends on three separately-deferred capabilities — scheduler, settings resolver, and multi-step approval. It is the weakest-priority, highest-dependency item in the register.

### Scope Impact
If (b): scheduler, settings, `approval_steps`, status transitions, notification (escalation implies notifying the next level). If (a): none.

### Ratification Required
**YES**

### Dependencies
**D-5** (steps must exist), **D-13** (band→level mapping), **D-4** (status), settings resolver (`FR-PLT-025`, deferred).

---

## D-13 — Threshold / Value Configuration

> **RATIFIED 2026-08-17 — OPTION (B).**
>
> **Binding decision, as ratified:**
>
> 1. Governance Phase 1 does NOT own approval thresholds or value-band policy.
> 2. Governance does NOT derive, calculate, or configure domain-specific approval thresholds.
> 3. Threshold/value-band policy remains owned by the **consuming domain**.
> 4. The consuming domain determines whether an operation requires approval and supplies the
>    approval request's relevant **value** and **required permission**.
> 5. Governance remains a **generic approval request/decision mechanism**.
> 6. Do NOT create threshold configuration tables, threshold APIs, value-band rules, or
>    threshold evaluation logic in Governance Phase 1.
> 7. Procurement-specific value-band behaviour remains for the **Procurement phase**.
> 8. Preserve the existing **Inventory precedent**; do not alter Inventory
>    threshold/cost/approval behaviour as part of Governance.
> 9. This decision does not define Procurement's exact threshold rules; those remain a future
>    Procurement design concern.
>
> **Verification performed before ratification (2026-08-17):**
> - Approved SQL §13 GOVERNANCE defines five tables (`approval_requests`, `approval_steps`,
>   `approval_decisions`, `anomaly_flags`, `audit_entries`) and **zero**
>   threshold/limit/band/tier columns.
> - **No SRS requirement places threshold ownership in Governance.** §15.6 (Approval Workflow
>   Engine) contains no threshold requirement.
> - Every threshold requirement sits in a **consuming domain's** chapter: `FR-POS-047` §8.3.2,
>   `FR-PRC-018` §12.4, `FR-INV-035`/`FR-INV-058` §11, `FR-FIN-017` §16.4, `FR-HRM-034` §14.5.
> - SRS §24.2.3 places `policy.evaluate()` **inside the consuming handler**, with
>   `ApprovalService` injected as a separate collaborator.
> - Inventory **B-2** is live in code: *"caller-supplied approval gate; Inventory never
>   evaluates a threshold"* (`inventory.dto.ts:99`, `waste.service.ts:16`).

### Question
Does Governance own threshold evaluation — deciding *when* approval is required — and if so, where do thresholds live?

### SRS Evidence
Every threshold requirement says "configurable" and **none states a value**:
`FR-INV-035`, `FR-INV-047`, `FR-INV-058`, `FR-POS-047`, `FR-POS-073`, `FR-FIN-006`, `FR-FIN-017`, `FR-HRM-034`, `FR-PRC-018`, `FR-PRC-033`.

Two concrete **shapes** are given:
- `FR-POS-047` [M]: discount thresholds configured **"Per role, per branch"** (max percentage, max absolute amount, max discounts per shift, discount-after-payment boolean).
- `FR-PRC-018` [M]: PO **value bands** with an approver level per band.

**No SRS requirement states a threshold amount, a storage location, a precedence rule, or an owner.**

### Existing Repository Evidence
Inventory **B-2, ratified**: `requires_approval` is **caller-supplied**; Inventory owns the *gate* only; *"Governance will own determining when approval is required in a future phase."* That is a project decision, not SRS text. The settings resolver (`FR-PLT-025`) is deferred by ADR 0008 D-11. `waste_records.requires_approval` and `count_sessions.requires_approval` columns exist and are honoured today by refusing.

### Conflict / Gap
**GAP-2 — `DESIGN GAP — THRESHOLD MODEL`.** The SRS supplies two shapes but no mechanism, no precedence, no owner. **No threshold amount is proposed here.**

### Options
- **(a)** Governance owns thresholds — requires inventing a configuration mechanism the SRS does not define, or waiting for `FR-PLT-025`.
- **(b)** Defer again — callers keep supplying `requires_approval`, preserving the ratified B-2 contract.
- **(c)** Block Governance on the settings resolver (`FR-PLT-025`) landing first.

### Recommended Direction
**(b) for the first phase.** It preserves the ratified B-2 contract exactly, requires inventing nothing, and still lets the approval workflow function end-to-end for callers that already flag `requires_approval`. Options (a) and (c) both require the settings resolver, which is separately deferred (ADR 0008 D-11).

This leaves `FR-INV-035`, `FR-INV-047`, `FR-INV-058`, `FR-POS-047` and the other threshold clauses **partially unmet** — the approval half becomes satisfiable, the *automatic threshold detection* half does not. That must be recorded honestly rather than glossed.

### Scope Impact
If (b): none — no new tables, no settings dependency. If (a) or (c): settings resolver, precedence rules, per-role/per-branch storage, band tables.

### Ratification Required
**YES — RATIFIED 2026-08-17, option (b).**

### Dependencies
`FR-PLT-025` settings resolver (deferred) for options (a)/(c). **D-5** for band→step mapping.

---

## D-14 — Governance API Surface

> **RATIFIED 2026-08-17 — OPTION A-1: NO HTTP/API SURFACE IN PHASE 1.**
>
> **Authoritative ratified decision:**
>
> 1. The Governance approval workflow has **NO HTTP/API surface in Phase 1**.
> 2. Governance remains an **internal service/application capability**, consistent with the
>    `ApprovalService` usage described in **SRS §24.2.3**.
> 3. **Do not introduce** POST, PATCH, GET, DELETE, bulk, notification, escalation,
>    admin/bypass, or other Governance HTTP endpoints.
> 4. **This is an ARCHITECTURAL ratification, not a claim that the SRS prohibits Governance
>    endpoints.** The SRS defines **no** Governance API surface; this choice is therefore
>    explicitly recorded as an **architectural decision/deviation**.
> 5. **D-6 remains unchanged:** `approval_requests` are immutable except `status`.
> 6. **D-7 remains unchanged:** self-approval is enforced through the ratified database RLS
>    `INSERT … WITH CHECK` mechanism.
> 7. **D-8 remains unchanged:** `approval_decisions` are fully append-only.
> 8. **D-9 remains unchanged** except for its already-recorded **D-7** and **D-10**
>    consequences.
> 9. **D-10 remains unchanged:** expiry is evaluated at decision INSERT and creates **no**
>    `expired` lifecycle status and **no** scheduler.
> 10. **D-11 remains unchanged:** notification infrastructure is deferred to **Integrations
>     §23.5** and is not owned by Governance.
> 11. **Do not resolve** D-15, D-16, D-18, D-19, D-20, D-12, the parent-linkage question,
>     `approval_requests` DELETE, D-4 clause 5, or the D-8 cascade verification.
> 12. **Recorded explicitly: `FR-API-020` does NOT attach to a Governance HTTP surface in
>     Phase 1**, because **no Governance POST/PATCH endpoint is ratified**.
> 13. **Recorded explicitly: this decision does NOT authorize implementation.**
> 14. All existing ratifications are **preserved exactly**.
> 15. Only `docs/governance/GOVERNANCE_DECISION_REGISTER.md` is updated.
> 16. **No** implementation, migration, schema, endpoint, service, RLS, test, configuration or
>     database change is performed.
> 17. The final register is verified and the resulting decision tally reported.
> 18. Work stops after verification, awaiting the next explicit instruction.
>
> ---
>
> **CONSEQUENCE RECORDED (D-14, 2026-08-17).** Under A-1, Governance Phase 1 has **no consuming
> domain and no HTTP surface**: Inventory's gates refuse and D-17 forbids Governance touching
> Inventory; Sales, Procurement and Finance do not exist. The phase therefore delivers the
> tables and internal service **exercisable only by tests**. This consequence is recorded, not
> treated as a defect — A-2/A-3 were available and were **not** chosen.

### Question
What HTTP API surface, if any, does Governance Phase 1 expose?

---

### 1. Exact Source Requirements (A)

**SRS §26.3 "Representative Endpoints" lists 37 endpoints across six domain groups:
Orders, Inventory, Catalogue, Procurement, Sync, Reporting. There is NO Governance group.**
Verified exhaustively — a search for any `/v1/…approv|governance|audit` route returns **zero**
hits beyond the single Procurement entry below.

**The only approval-action endpoint defined anywhere in the SRS:**

```
POST   /v1/purchase-orders/{id}/approve                      Approve
```

— **Procurement-local**, in an unimplemented domain, and shaped as an action on the *business
entity*, not on a generic approval resource.

**No SRS requirement mandates a Governance approval-request or approval-decision endpoint.**
§15.6 defines the *mechanism* (`FR-SEC-030`…`035`); it defines no API.

**§26.3 is titled "Representative"**, so the absence is a **gap, not a prohibition** — the same
situation that produced Production Spec's **GAP-1 / Option A** ratified deviation
(`POST /recipes`). Any Governance endpoint would therefore be a **ratified deviation**, not an
implementation of an SRS route. **(A/C)**

**Cross-cutting `FR-API` requirements that attach IF any endpoint exists** — none of which D-14
may settle:

| Requirement | Pri | Belongs to |
|---|---|---|
| `FR-API-001` stable machine-readable error code | [M] | **D-18** |
| `FR-API-002` errors localised per `Accept-Language` | [M] | **D-18** |
| `FR-API-003` errors leak no internals | [M] | **D-18** |
| `FR-API-012` token carries subject, tenant, scope set, **permitted branch set** | [M] | Branch scope deferred (ADR 0008 D-02; D-2 kept it out) |
| **`FR-API-020`** *"**Every POST and PATCH** SHALL accept an `Idempotency-Key` header"* | **[M]** | **D-15** |
| `FR-API-021`/`022`/`023` idempotency storage, replay, 409 | [M] | **D-15** |

> **Consequence to record, not resolve:** `FR-API-020` is unconditional for POST/PATCH. **If
> D-14 authorises any POST, `FR-API-020` attaches to it** and becomes D-15's problem. A
> no-HTTP-surface model avoids that attachment entirely. **This is a dependency, not an argument
> for either model.**

**Approval-action requirements in other domains (B — implied, not mandating a Governance API):**
`FR-PRC-020` [M] — approval *"actionable from the mobile app and from an email link with a
signed, single-use, time-limited token"*; `FR-POS-048` [M] — *"manager PIN entry on the
terminal, manager card swipe, or remote approval request"*. Both are consumer-domain surfaces
and both are out of Phase 1.

---

### 2. Existing Approved Design Constraints (B — ratified, not reopened)

| Decision | Constraint on the API surface |
|---|---|
| **D-2** CORE ONLY | Only the request/decision model is in scope; both halves of `FR-SEC-032` are out |
| **D-4** lifecycle | The only transitions are `pending → approved` and `pending → rejected` — so the only state-changing operation is a **decision** |
| **D-6** immutable except `status` | **A general request-mutation endpoint is contradicted.** The sole permitted mutation *is* the decision transition |
| **D-7** self-approval via INSERT RLS (M2) | Enforcement is at the **database** boundary; the API cannot be the guarantee |
| **D-8** decisions fully append-only | **No decision update or delete endpoint is possible** — `ros_app` holds neither privilege |
| **D-9** S1 / N1 / U4 (+ D-7, D-10 amendments) | Scope is `approval_requests` + `approval_decisions` **only**. `approval_steps` excluded; **`anomaly_flags` out of Phase 1** |
| **D-10** expiry = decision-time validity | **No expiry endpoint**: expiry transitions nothing, mutates nothing, and has no scheduler |
| **D-11** notification N-B | **No notification endpoint** — clause 2 forbids it explicitly |
| **D-17** strict Inventory boundary | No Governance route may read or write `inventory.*` |
| **D-13** thresholds domain-owned | The caller supplies `value` and `required_permission`; Governance does not compute them |

---

### 3. Endpoint-by-Endpoint Classification

**Key:** **A** = source-required, Phase 1 · **B** = source-required but deferred/out of scope ·
**C** = architecturally useful, unsupported by the SRS · **D** = contradicted by a ratified
decision · **E** = unresolved pending another decision

| Candidate | Class | Basis |
|---|---|---|
| **Create approval request** | **C** (+**E**) | No SRS route. Would be a ratified deviation (GAP-1 precedent). **E on D-16** — the `request_type` contract is deliberately open |
| **List approval requests** | **C** + **E** | No SRS route; **E on D-20** — §15.2 supplies no approval-read permission |
| **Retrieve one request** | **C** + **E** | As above |
| **Approve / reject (create decision)** | **C** + **E** | Only the Procurement-local `POST /v1/purchase-orders/{id}/approve` exists. **E on parent-linkage** — a decision's parent is unresolved |
| **Read approval decisions** | **C** + **E** | **E on D-20** |
| **General request mutation (PATCH)** | **D** | Contradicts **D-6** — immutable except `status`, and the status change *is* the decision |
| **Cancellation / withdrawal** | **D** | **D-4 clause 3** forbids a `cancelled` state; no source defines cancellation |
| **Expiry endpoint** | **D** | **D-10** — expiry neither transitions nor mutates; no scheduler |
| **Notification endpoint** | **D** | **D-11 clause 2** forbids it explicitly |
| **Escalation endpoint** | **B** | `FR-SEC-034` **[S]**; **D-12 BLOCKED** on scheduler + settings + steps |
| **Admin / bypass endpoint** | **D** | Would undermine **D-7** self-approval and **D-6/D-8** immutability. No source |
| **Bulk endpoint** | **C** | No source; would compound **D-15** concurrency questions |
| **`approval_steps` endpoints** | **E** | **D-9 S1 excluded the table**; **D-5** single-step; parent-linkage unresolved |
| **`anomaly_flags` endpoints** | **D** | **D-9 ratified `anomaly_flags` out of Phase 1**, despite §15.2 defining `governance.view_anomalies` |

---

### 4. A Structural Observation (D — not an argument for any option)

**SRS §24.2.3 depicts approval consumption as an in-process service dependency, not an HTTP
call:** `ApprovalService` is *injected into* the consuming handler, and `cmd.approvalId` is
supplied by the caller.

**But under D-2 (CORE ONLY) and D-17 (strict Inventory boundary), Governance Phase 1 has no
consuming domain at all.** Inventory's gates refuse and Governance may not touch Inventory;
Sales, Procurement and Finance do not exist.

**Consequence, recorded neutrally:** whichever model is chosen, **Governance Phase 1 has no
in-process consumer**. Under a no-HTTP-surface model the phase would produce tables and services
exercisable only by tests. This is a **fact to weigh**, not a recommendation.

---

### 5. API-Surface Options

> Route paths below are written **without** the `/v1` prefix to match every implemented
> controller. **The `/v1` prefix deviation remains unratified**
> (`docs/RECONCILIATION_POST_PRODUCTION.md` §15-D1) and applies to whichever model is chosen.

#### **Option A-1 — No HTTP surface**
Governance exposed only as an internal service (`ApprovalService`), matching §24.2.3.
- **Endpoints:** none.
- **Authorization:** none at HTTP level; permission checks in-service.
- **Tenant/RLS:** all access through `withAuthContext`; RLS unchanged.
- **Lifecycle:** decisions created in-process.
- **Idempotency (D-15):** `FR-API-020` **does not attach** — no POST exists.
- **Concurrency (D-15):** confined to the service transaction.
- **Errors (D-18):** no HTTP error contract needed.
- **Dependencies:** none on D-16, D-20, parent-linkage *for routing* (still needed for the model).
- **Consequence:** no consumer exists in Phase 1 (§4).

#### **Option A-2 — Minimal write surface (two endpoints)**
```
POST /approval-requests                        create a request
POST /approval-requests/{id}/decisions         record a decision (approve | reject)
```
- **Authorization:** `required_permission` carried on the request (D-1/D-3); the decision
  endpoint authorises the approver against **that** permission. **No new permission code.**
- **Tenant/RLS:** D-9 `T` predicate; decision INSERT additionally carries the **D-7
  self-approval** and **D-10 unexpired** conjuncts.
- **Lifecycle:** exactly D-4 — the decision drives `pending → approved | rejected`; the request
  transition uses D-6's `GRANT UPDATE (status)` + U4 policy.
- **Idempotency:** **`FR-API-020` attaches to both POSTs → D-15**.
- **Concurrency:** two decisions racing on one request → **D-15**.
- **Errors:** 401/403/404-cross-tenant/409/422 shape → **D-18**.
- **Dependencies:** **D-16** (create body's `request_type`), **parent-linkage** (decision's
  parent), **D-15**, **D-18**.
- **No read surface**, so **D-20 is not engaged**.

#### **Option A-3 — Minimal write + read**
A-2 plus:
```
GET  /approval-requests            list (filters unspecified)
GET  /approval-requests/{id}       retrieve, optionally with decisions
```
- **Adds a hard dependency on D-20** — §15.2 supplies **no** approval-read permission, and the
  project's zero-invented-codes discipline (D-17-06 precedent) forbids creating one.
- Everything else as A-2.

#### **Option A-4 — Extended surface**
A-3 plus mutation / cancellation / expiry / escalation / bulk / admin routes.
- **Contradicted by ratified decisions** — D-6, D-4 clause 3, D-10, D-11, D-12, D-7/D-8
  respectively (see §3). **Not viable without amending ratified decisions.**

---

### 6. What D-14 Can and Cannot Settle

**Can be ratified now:**
- **Whether a Governance HTTP surface exists at all** (A-1 vs A-2/A-3).
- **Which endpoint shapes are excluded** — mutation, cancellation, expiry, notification, admin,
  `anomaly_flags` — since each is already contradicted by a ratified decision.
- **That any endpoint is a documented deviation**, since §26.3 defines none.

**Must remain deferred:**

| Item | Owner |
|---|---|
| `Idempotency-Key` handling, replay, 409-on-fingerprint-mismatch | **D-15** |
| Error contract: stable codes, `Accept-Language`, 422-vs-403 for "approval required" | **D-18** |
| Read authorization / permission for any `GET` | **D-20** |
| `request_type` representation in a create body | **D-16 — MUST REMAIN OPEN** |
| Escalation route | **D-12 — BLOCKED** |
| Decision's parent in the route shape (`/approval-requests/{id}/decisions` vs a step-scoped path) | **parent-linkage — unresolved** |
| `/v1` prefix | **outstanding deviation, unratified** |
| Whether requests may be deleted | **`approval_requests` DELETE — unresolved** |

---

### Recommendation

**NO SOURCE-SUPPORTED RECOMMENDATION.** The SRS defines **no** Governance API. §26.3's only
approval route is Procurement-local, and §26.3 is explicitly "Representative", so the sources
neither require nor forbid a Governance surface. Choosing between A-1, A-2 and A-3 is a project
scope decision.

**RECOMMENDATION — NOT RATIFICATION**, on the *excluded* shapes only, where ratified decisions
already determine the answer: **Option A-4 is not viable.** Request mutation contradicts D-6;
cancellation contradicts D-4 clause 3; an expiry endpoint contradicts D-10; a notification
endpoint contradicts D-11 clause 2; admin/bypass contradicts D-7 and D-8; `anomaly_flags` routes
contradict D-9's ratified scope; escalation is blocked by D-12. **Each of these is a consequence
of an existing ratification, not a new preference.**

### Ratification Required

**YES — RATIFIED 2026-08-17: Option A-1.**

### The precise question requiring ratification

> **What HTTP API surface does Governance Phase 1 expose?**
>
> 1. **Choose the model:** **A-1** (no HTTP surface) · **A-2** (create + decide) ·
>    **A-3** (A-2 + read) · **A-4** (extended — requires amending ratified decisions).
> 2. **If A-2 or A-3**, confirm that any endpoint is a **documented deviation**, since §26.3
>    defines no Governance route.
> 3. **If A-3**, note that **D-20 must be resolved first** — §15.2 supplies no approval-read
>    permission.
> 4. **Confirm** that the excluded shapes in §3 (mutation, cancellation, expiry, notification,
>    escalation, admin/bypass, `anomaly_flags`) are **out of scope by consequence** of existing
>    ratifications.
> 5. **Acknowledge** that `Idempotency-Key` (**D-15**), the error contract (**D-18**), the
>    `request_type` body contract (**D-16**), the decision's parent route shape
>    (**parent-linkage**) and the **`/v1` prefix** all remain **unresolved** and are **not
>    settled by D-14**.

### Dependencies

**D-15** (attaches to any POST via `FR-API-020`) · **D-18** (error contract) · **D-20** (any
read route) · **D-16** (create body) · **D-12** (escalation, BLOCKED) ·
**parent-linkage** (decision route shape) · **`/v1` prefix** (outstanding deviation) ·
**`approval_requests` DELETE** (unresolved).

## D-15 — Idempotency / Concurrency

> **STATUS: RATIFIED 2026-08-17 — MINIMAL / NO ADDITIONAL APPROVAL-SPECIFIC CONCURRENCY
> MECHANISM.** See the **Ratification** block at the end of this decision for the binding text.
> The analysis below is retained as the record of what was considered.

The analysis that follows is **retained as analysis**. Where it presented mechanism options
(**C-2**, **C-3**, **C-4**, **C-5**, **C-6**, **C-7**), those options were **considered and not
adopted**; the ratified position is **C-1 — no additional approval-specific mechanism**, bounded
by the eighteen clauses recorded at the end of this decision.

### Question
What concurrency and duplicate-decision controls, if any, does Governance Phase 1 require —
now that **D-14 (A-1)** has removed the HTTP surface?

---

### 1. Exact SRS Requirements (A)

**23 requirements** across the SRS concern idempotency, concurrency, locking, retries,
duplicates or atomicity. **Verified: NOT ONE of them concerns approvals.** A search for
requirements mentioning **both** an idempotency/concurrency term **and** "approv" returns
**NONE**.

| Domain | Requirements | Attaches to Governance Phase 1? |
|---|---|---|
| **HTTP API idempotency** | `FR-API-020`, `021`, `022`, `023` | **NO — D-14 A-1 removed the HTTP surface.** `FR-API-020` binds "every **POST and PATCH**"; no Governance POST/PATCH is ratified |
| **Offline / Sync** | `FR-OFF-021`, `023`, `025` | No — Sync domain absent |
| **POS payments** | `FR-POS-065` [M] *"Payment operations SHALL be idempotent…"* | No — Sales absent; an approval is not a payment |
| **Integrations** | `FR-INT-002`, `FR-INT-003` | No — Integrations absent |
| **Migrations** | `FR-DR-012`, `FR-DR-013` | No |

**`NFR-REL-011` [M]** — *"The System SHALL guarantee **at-most-once financial effect** for any
operation, **enforced by idempotency keys**."* Recorded, **not** asserted as attaching:
it sits in §21.10 **Offline** NFRs, its enforcement clause points at the `FR-API-020`…`023`
idempotency-key machinery that D-14 detached, and **an approval decision authorises a financial
operation without being one**. Whether it reaches Governance is **not determined by the
sources** and is **not decided here**.

**Two SRS architecture sections are directly on point (A — architecture chapter, not numbered
requirements):**

**§24.6.4 Optimistic Concurrency:**
> *"Aggregates carry a version. Updates assert the expected version and fail on mismatch,
> forcing the caller to reload. **Pessimistic locking is used only for order-number allocation
> and count-session exclusivity.**"*

Two consequences: the SRS's general concurrency pattern is **optimistic and version-based**; and
**pessimistic locking is explicitly confined to two named cases — approval is not one of them.**

**§24.3.7 Unit of Work:**
> *"A UnitOfWork wraps a database transaction, **sets the RLS tenant context**, collects
> aggregate events, and dispatches them before commit. **Every command handler executes inside
> exactly one unit of work.**"*

This is already the repository's implemented pattern — `PrismaService.withAuthContext()` sets
`app.tenant_id` transaction-locally and wraps the work in one transaction. **(B)**

---

### 2. Remaining D-15 Scope After D-14

| | Aspect | Status after D-14 A-1 |
|---|---|---|
| **A** | **HTTP idempotency** (`Idempotency-Key`, replay header, 409-on-fingerprint) | **NO LONGER APPLICABLE.** No Governance HTTP surface exists |
| **B** | **Service-level duplicate prevention** | **Potentially relevant** — no source requires it |
| **C** | **Database-level duplicate prevention** | **Potentially relevant** — no source requires it; **no UNIQUE constraint exists** on `approval_decisions` in the approved SQL |
| **D** | **Concurrent approve/reject attempts** | **Relevant** — analysed in §4 |
| **E** | **Request status-transition races** | **Largely addressed by D-9 U4** — see §4, race 1 |
| **F** | **Decision INSERT races** | **Relevant** — the D-9 INSERT policy carries no status predicate |
| **G** | **Other SRS-supported concurrency behaviour** | Only §24.6.4 and §24.3.7, both general architecture, neither approval-specific |

---

### 3. Constraints From Ratified Decisions (B — not reopened)

| Decision | Bearing on concurrency |
|---|---|
| **D-4** | Only `pending → approved` and `pending → rejected` exist; **clause 5 left `rejected`-storage open**, so whether `status` is the *authoritative* lifecycle state is **not settled** |
| **D-6** | `status` is the **only** mutable column; `GRANT UPDATE (status)` makes every other field structurally unwritable — **including any version column, were one added** |
| **D-7** | Self-approval enforced by the decisions **INSERT** `WITH CHECK` traversal |
| **D-8** | Decisions **fully append-only** — a duplicate or conflicting decision, once inserted, **can never be updated or deleted** |
| **D-9** | **U4:** `USING (T AND status='pending')` + `WITH CHECK (T AND status IN ('approved','rejected'))` on the request UPDATE; INSERT on decisions = `WITH CHECK (T AND self-approval AND unexpired)` |
| **D-10** | Expiry evaluated **at decision INSERT**, inside the transaction |
| **D-11** | Notifications deferred — no delivery races |
| **D-14** | **No HTTP surface** — removes aspect A entirely |
| **D-16** | **OPEN — must not be resolved here** |
| **parent-linkage** | **Unresolved — must not be invented.** Several options below depend on it |

---

### 4. Concrete Race Analysis

| # | Race | Current design | Classification |
|---|---|---|---|
| **1** | Two actors approve the same pending request simultaneously | **D-9 U4 already acts as a compare-and-set.** `USING (T AND status='pending')` means the second UPDATE finds a non-pending row and affects **0 rows** | **Largely prevented** — but see **(F)** below |
| **2** | One approves while another rejects | Status: same as race 1 — one wins. **Decisions: both INSERTs succeed**, leaving two contradictory append-only rows | **Status prevented; decision rows possible** |
| **3** | Decision INSERT concurrent with the status transition | **The D-9 decisions INSERT policy carries NO status predicate** — only `T`, self-approval (D-7) and unexpired (D-10) | **POSSIBLE — a decision can be inserted against an already-decided request** |
| **4** | Two decisions inserted for one request | **No UNIQUE constraint exists** on `approval_decisions` | **POSSIBLE** |
| **5** | Retry of the same logical decision | HTTP idempotency detached by D-14; no service-level dedup ratified | **POSSIBLE — duplicate rows** |
| **6** | Decision inserted while the request becomes non-pending | Same as race 3 | **POSSIBLE** |
| **7** | Decision inserted near expiry | D-10's `WITH CHECK` is evaluated **inside the INSERT transaction** — atomic | **Prevented** |
| **8** | Tenant-context interaction under RLS | `withAuthContext` sets context transaction-locally (§24.3.7 pattern); RLS `FORCE`d; `ros_app` lacks `BYPASSRLS` | **Prevented** |

> **(F) EMPIRICAL VERIFICATION REQUIRED — not asserted.** Race 1's prevention depends on
> PostgreSQL re-evaluating the RLS `USING` predicate against the updated row after a concurrent
> transaction commits (EvalPlanQual under `READ COMMITTED`). This is **stated as requiring
> verification before implementation**, in the same manner as the D-8 clause 6 cascade item —
> **it is not claimed as verified here.**

**Net exposure under the current ratified design:** multiple and potentially **contradictory**
decisions can be recorded for one request (races 2–6), and because **D-8 makes them
append-only, they can never be corrected or removed**.

---

### 5. Duplicate-Decision Semantics — what the sources do and do not establish

| Question | Answer | Basis |
|---|---|---|
| **One decision per request?** | **NOT ESTABLISHED.** No UNIQUE constraint in the approved SQL; no requirement states it | **C** |
| **Multiple decisions per request?** | **Structurally possible.** SRS §7.3 row #36 lists the aggregate's entities as *"Steps, **Decisions**"* — plural | **A/C** |
| **One *final* decision?** | **Not stated anywhere** | **E** |
| **Conflicting decisions possible?** | **Structurally yes**; no source addresses or forbids it | **C/E** |
| **Repeated identical decisions = duplicates?** | **Not defined** | **E** |
| **Decisions immutable?** | **YES** — `FR-SEC-033` [M]; **D-8** ratified full append-only | **A/B** |
| **Is `status` the authoritative lifecycle state?** | **NOT SETTLED.** D-4 ratified the lifecycle, D-6 makes `status` the only mutable field — but **D-4 clause 5 explicitly left open** whether `rejected` lives on the request, the decision, or both | **E — must not be resolved here** |

**"One decision per request" is therefore NOT invented here.** It is one candidate option in §6,
not a source-established fact.

---

### 6. Mechanism Options

| | Mechanism | Guarantee | Failure mode | Schema change? | Depends on parent-linkage? | D-18 / D-19 impact |
|---|---|---|---|---|---|---|
| **C-1** | **No additional mechanism** | D-9 U4 alone (race 1); nothing else | Races 2–6 remain possible; append-only makes them permanent | None | No | None |
| **C-2** | **Partial UNIQUE index on decisions** (one decision per request) | One decision per request, structurally | Second INSERT raises a unique violation — surfacing it is **D-18's** contract | **Yes** — a unique index; and it **asserts a semantic the sources do not establish** (§5) | **YES** — the index needs the column that identifies the request | **D-18** (error), none for D-19 |
| **C-3** | **Status conjunct on the decisions INSERT policy** — `AND EXISTS(request WHERE status='pending')` | Blocks decisions on already-decided requests (races 3, 6) | RLS violation on INSERT — **D-18** | No | **YES** — traversal to the request | **D-18**; a **third D-9 amendment** |
| **C-4** | **Pessimistic row lock** (`SELECT … FOR UPDATE` on the request) | Serialises decision attempts | Lock contention | No | Yes (to locate the request) | — |
| **C-5** | **`SERIALIZABLE` isolation** for the decision path | Broad protection | Serialisation failures require retry — no retry policy exists | No | No | **D-18** (retry semantics) |
| **C-6** | **Optimistic version column** (§24.6.4's general pattern) | Version assert on the request | Version mismatch → caller reloads | **Yes** — a version column, **which D-6 forbids mutating**; needs **D-1 and D-6 amendments** | No | — |
| **C-7** | **Service-level deduplication** | Best-effort | No structural guarantee | No | Yes | — |

**Evidence bearing on the options:**

- **C-4 is in tension with §24.6.4**, which states pessimistic locking *"is used **only** for
  order-number allocation and count-session exclusivity"*. **Approval is neither.** Adopting it
  would depart from a stated SRS architecture position.
- **C-6 is the SRS's own general pattern**, but it presumes *"aggregates carry a version"* — and
  `approval_requests` has **no version column**, while **D-6 ratified that only `status` is
  mutable**. C-6 therefore cannot be adopted without amending **D-1** (add the column) and
  **D-6** (permit mutating it).
- **C-2 asserts "one decision per request"**, which §5 shows the sources do **not** establish.
- **C-3 closes the one race the ratified design demonstrably leaves open (races 3 and 6)** and
  requires **no schema change** — but it is a **third amendment** to D-9's INSERT policy and
  depends on the unresolved parent-linkage.
- **C-1 is consistent with the sources**, since **no SRS requirement imposes any approval
  concurrency control**.

---

### 7. Ratification Candidates

1. **C-1** — no additional mechanism; accept races 2–6, recording that append-only makes
   contradictory decisions permanent.
2. **C-3** — add the status conjunct to the decisions INSERT policy (third D-9 amendment).
3. **C-2** — partial unique index asserting one decision per request (requires settling a
   semantic the sources leave open, plus parent-linkage).
4. **C-2 + C-3** — both structural controls.
5. **C-7** — service-level dedup only.
6. **Defer** — record the exposure and revisit when a consuming domain exists.

### Recommendation

**NO SOURCE-SUPPORTED RECOMMENDATION.** No SRS requirement imposes any concurrency or
idempotency control on approvals — verified: zero requirements mention both approvals and
idempotency/concurrency/duplicates. The choice among C-1 … C-7 is architectural.

**RECOMMENDATION — NOT RATIFICATION**, confined to the two options the sources actively weigh
against:

- **C-4 (pessimistic locking) sits against §24.6.4's explicit statement** that pessimistic
  locking is used *only* for order-number allocation and count-session exclusivity.
- **C-6 (version column) cannot be adopted as-is**: it requires amending **D-1** and **D-6**,
  because `approval_requests` has no version column and D-6 permits mutating only `status`.

**A fact worth weighing, offered neutrally:** because **D-8 makes decisions append-only**, any
duplicate or contradictory decision written under **C-1** is **permanent and uncorrectable**.
That raises the cost of C-1 relative to a design where such rows could be superseded — but no
source requires preventing them.

### Ratification Required

**YES — NOT RATIFIED.**

### The precise question requiring ratification

> **What concurrency / duplicate-decision controls does Governance Phase 1 adopt?**
>
> 1. **Choose:** **C-1** (none) · **C-3** (status conjunct) · **C-2** (unique index) ·
>    **C-2+C-3** · **C-7** (service dedup) · **Defer**.
> 2. **If C-2**, confirm that **"one decision per request" is being ratified as an
>    architectural semantic**, since §5 shows the sources do not establish it.
> 3. **If C-3**, confirm the **third explicit amendment to D-9**'s decisions INSERT policy.
> 4. **Acknowledge** that HTTP idempotency (`FR-API-020`…`023`) **does not attach**, per D-14
>    A-1, and that **`NFR-REL-011`'s applicability to Governance is undetermined**.
> 5. **Acknowledge** that race 1's prevention via D-9 U4 **requires empirical verification**
>    before implementation.

### Dependencies

**Parent-linkage** — **C-2**, **C-3**, **C-4** and **C-7** all need a resolved path from a
decision to its request. **D-18** — how any violation surfaces. **D-1 / D-6** — required
amendments for **C-6**. **D-4 clause 5** — whether `status` is the authoritative state bears on
what a "duplicate" even means; **not resolved here**. **D-16**, **D-19**, **D-20**, **D-12** —
untouched.

---

### RATIFICATION — D-15 (2026-08-17)

**RATIFIED 2026-08-17 — MINIMAL / NO ADDITIONAL APPROVAL-SPECIFIC CONCURRENCY MECHANISM.**

1. The SRS does **NOT** define an approval-specific idempotency or concurrency requirement. This
   remains a **source finding, not an invented requirement**.
2. Because **D-14** ratified **Option A-1** (no Governance HTTP/API surface), **HTTP
   `Idempotency-Key` requirements do not attach** to the Governance approval workflow in Phase 1.
3. **Do NOT** introduce an approval-specific idempotency key, duplicate-request mechanism, or
   HTTP retry contract.
4. **Do NOT** introduce a **UNIQUE constraint** establishing *"one decision per approval
   request."* **The sources do not establish that semantic.**
5. **Do NOT** introduce **pessimistic row locking** for approval requests or approval decisions.
   **SRS §24.6.4** limits pessimistic locking to **order-number allocation** and **count-session
   exclusivity**; **approval is neither**.
6. **Preserve D-6 exactly:** request status transitions remain governed by the ratified
   **status-only UPDATE grant** and the **D-9 U4 RLS policy**.
7. **Preserve D-7 exactly:** self-approval remains enforced by the ratified **M2 INSERT
   `WITH CHECK`** mechanism.
8. **Preserve D-8 exactly:** `approval_decisions` remain **fully append-only**.
9. **Preserve D-9 exactly as currently amended by D-7 and D-10.** **Do NOT** add the proposed
   **D-15 C-3 pending-status predicate** to the decision INSERT policy.
10. The currently identified **residual possibility of a decision being inserted against an
    already-decided request** remains **unresolved architectural behaviour**. **No claim is made
    that the existing design provides a one-decision-per-request guarantee.**
11. The currently identified **possibility of duplicate or contradictory decision rows** remains
    **unresolved architectural behaviour**. **No claim is made that such duplicates are
    prohibited by the SRS.**
12. The **D-10 expiry check remains atomic at decision INSERT** and is **unchanged**.
13. The **Unit of Work / database transaction pattern** remains the applicable **general**
    transaction boundary; **D-15 does not introduce a new approval-specific transaction
    mechanism**.
14. Any future requirement or architectural decision establishing **duplicate-decision
    prevention**, **one-decision-per-request semantics**, or **stronger approval concurrency
    guarantees** must be handled by an **explicit future decision/amendment**. **It must not be
    inferred from D-15.**
15. The **empirical question concerning PostgreSQL RLS re-evaluation under concurrent status
    changes** remains a **Design Gate verification item** and is **NOT asserted as verified by
    this ratification**.
16. **Do not resolve** the **`approval_decisions` → parent-linkage** question.
17. **Do not resolve** **D-16**, **D-18**, **D-19**, **D-20**, **D-12**, the **D-3 residual**,
    **D-4 clause 5**, **`approval_requests` DELETE**, the **D-8 cascade verification**, or
    **granted-approval staleness / consuming-domain behaviour**.
18. This is **governance/design ratification only**. It does **NOT authorize implementation**.

**Status:** **RATIFIED — CLOSED.**


## D-16 — Canonical `request_type` Enumeration

> **STATUS: OPEN — MUST REMAIN OPEN. DO NOT RATIFY.**
>
> **Recorded position (2026-08-17):**
>
> 1. `FR-SEC-030` names **seven** approval consumers: discounts, refunds, purchase orders,
>    waste, count adjustments, expenses, and price changes.
> 2. The wording **"used by"** does **not** establish that these seven values form a closed
>    `request_type` enumeration.
> 3. Additional SRS requirements **independently mandate approval** for other
>    operations/domains, including the categories identified in the D-16 analysis below.
> 4. Therefore Governance **must NOT invent a closed seven-value `request_type` enumeration**.
> 5. Do **NOT** silently add the additional approval consumers to a new enum either.
> 6. The SRS does **not** currently establish the storage representation of `request_type` as
>    a closed enum/code list. That remains a **Design Gate modelling question**.
> 7. Preserve the distinction between:
>    - **approval consumers defined by the SRS**; and
>    - the **Governance `request_type` data-model representation**.
> 8. **Record the apparent SRS inconsistency/ambiguity around "price changes":**
>    `FR-SEC-030` names price changes, but the current analysis did **not** identify a
>    corresponding approval requirement in `FR-MNU-020`…`FR-MNU-026`, nor a matching
>    `*.approve` permission in §15.2. **Do not resolve this by assumption.**
> 9. Do **NOT** expand Governance Phase 1 implementation scope because additional SRS approval
>    consumers were discovered. This is a **modelling/reconciliation issue**, not authorization
>    for new domain implementation.
> 10. D-16 **remains OPEN** pending an explicit Design Gate decision on how heterogeneous
>     approval consumers are represented by `request_type`.
>
> **Previously ratified decisions preserved exactly:** D-1 RATIFIED · D-2 RATIFIED (CORE ONLY)
> · D-3 RATIFIED IN PART · D-4 RATIFIED · D-5 RATIFIED (SINGLE-STEP) · D-13 RATIFIED.

### Question
What is the authoritative set of `governance.approval_requests.request_type` values for
Governance Phase 1, and how should the column be stored?

### SRS Evidence

**`FR-SEC-030` [M], verbatim:** *"The System SHALL provide a general approval mechanism
**used by** discounts, refunds, purchase orders, waste, count adjustments, expenses, and
price changes."* — **seven** categories.

**Critical finding: this is an illustrative list, not a closed enumeration.** Exhaustive
search of the SRS finds **nine further requirements that mandate approval but are absent
from `FR-SEC-030`'s seven**:

| Requirement | Approval-requiring action | In FR-SEC-030's list? |
|---|---|---|
| `FR-FIN-006` [M] | Cash variance beyond tolerance | **No** |
| `FR-HRM-034` [M] | Overtime beyond threshold (pre-approval) | **No** |
| `FR-HRM-017` [S] | Leave requests | **No** |
| `FR-HRM-016` [C] | Shift swap requests | **No** |
| `FR-BRN-016` [S] | Inter-branch transfer request (source approves) | **No** |
| `FR-INV-032` [M] | Transfer discrepancy investigation and approval | **No** |
| `FR-INV-035` [M] | Manual stock adjustment above threshold | **No** |
| `FR-PRC-033` [M] | Over-receipt beyond tolerance | **No** |
| `FR-PRC-042` [M] | Supplier invoice payment approval | **No** |

The phrase *"used by"* therefore reads as exemplary. Treating the seven as a closed set
would exclude nine `[M]`/`[S]` approval requirements the SRS states elsewhere.

**Two of FR-SEC-030's own seven have no consuming requirement:**

- **Price changes** — searched `FR-MNU-020` … `FR-MNU-026`: **no requirement mandates
  approval for a price change.** §15.2 supplies `menu.price.change` (a *change* permission),
  with no corresponding `*.approve` code — unlike `pos.discount.approve`,
  `cash.variance.approve`, `inventory.waste.approve`.
- **Count adjustments** — *is* backed: `FR-INV-047` [M] requires count posting to be
  "an approval-requiring action for high-value adjustments" (see Inventory Boundary below).

**The SQL-only value `void` is not backed by an approval requirement either.** No SRS
requirement states that a void requires approval. The nearest evidence is indirect:
`FR-POS-075` [M] requires void/cancellation/refund audit entries to contain "actor,
**approver**, reason, amount", and `BR-POS-003` requires a permission-holder to approve
cancellation after a line is fired and bumped. Both imply a void *can* be approved; neither
states that an approval **request** is created.

### Existing Repository Evidence

Approved SQL:
```sql
request_type VARCHAR(32) NOT NULL,   -- discount, void, refund, po, expense, waste
```
**Six** values, in a comment — not a constraint, not an enum. Neither Governance approval
table exists in the live database.

**Storage precedent — directly on point.** `inventory.stock_movements.reference_type` is the
existing column that names *other bounded contexts*:
```sql
reference_type VARCHAR(32) NOT NULL,   -- order, goods_receipt, transfer, count, waste, production
```
implemented in Prisma as `String @db.VarChar(32)` — **deliberately not an enum**, because the
values name contexts that do not yet exist. By contrast, Inventory and Production used **real
enums** (`MovementType`, `RecipeScope`, `RecipeType`, `RecipeVersionStatus`,
`RecipeComponentType`) wherever the value set is **closed and owned entirely within that
context**.

This gives a clean, repository-grounded rule: **enum where the context owns the closed set;
constrained `VARCHAR` where the values name other contexts.**

### Conflict / Gap

**Conflict C-5, re-characterised by this analysis.** P1-004 recorded it as "the SQL comment
omits two of FR-SEC-030's categories and adds one". The reconciliation shows the disagreement
is deeper: **neither source is a complete, authoritative enumeration.**

| | Count | Backed by a consuming SRS requirement? |
|---|---|---|
| `FR-SEC-030`'s list | 7 | 5 of 7 (**price changes** unbacked; **count adjustments** backed via `FR-INV-047`) |
| Approved SQL comment | 6 | 5 of 6 (**void** unbacked as an approval *request*) |
| Overlap | 5 | discount, refund, po, expense, waste |
| Union | 8 | — |
| Approval-requiring requirements **outside both** | **9** | all backed |

**Governing source:** the SRS (`FR-SEC-030`) for requirement authority — but its list is
exemplary, so it cannot serve as a closed constraint without excluding nine backed
requirements.

**GAP — storage representation.** The sources settle the *type* (`VARCHAR(32)`, per the
approved SQL and the `reference_type` precedent) but **not** whether the value set is
constrained by a CHECK, an enum, or left open.

### Inventory Boundary — count adjustments

**Verified: count adjustments ARE required to be representable as Governance approval
requests.**

- `FR-SEC-030` names "count adjustments" explicitly.
- `FR-INV-047` [M]: *"Count posting SHALL be permission-gated and SHALL be an
  approval-requiring action for high-value adjustments."*
- §15.2 supplies the approver permission: `inventory.approve_high_variance` — *"Post counts
  exceeding variance thresholds"*.
- Live implementation: `inventory.count_sessions.requires_approval` exists and
  `counts.service.ts:237` refuses posting when it is true (ratified **B-2**).

**Consequence, not resolved here:** `count_sessions` has **no `approval_request_id`**, and the
approved SQL defines no approval column for that table at all. Under SRS §24.2.3 the consuming
entity stores the approval reference (as `waste_records.approval_request_id` does). Linking a
count session to its approval therefore requires an **Inventory schema change** — which is
**D-17**, unratified. **No Inventory behaviour is altered by this analysis.**

### Options

- **(a)** `FR-SEC-030`'s seven verbatim. Faithful to the only normative list — but excludes
  nine backed requirements and includes `price changes`, which no requirement backs.
- **(b)** The approved SQL's six. Excludes count adjustments, which `FR-INV-047` backs and
  which Governance Phase 1 exists to unblock. **Not viable on the evidence.**
- **(c)** Union of both (eight). Superset; still excludes the nine.
- **(d)** **Unconstrained `VARCHAR(32)`, exactly as the approved SQL declares it**, documented
  by comment, with no closed constraint in Phase 1 — following the
  `stock_movements.reference_type` precedent. Consistent with **D-13** (consuming domains
  decide when approval is required, so domains supply their own category) and **D-2**
  (core only; seven of the nine additional consumers live in domains that do not exist).
- **(e)** Constrained now to only the categories with a **live consumer** — i.e. `waste` and
  `count_adjustment` — expanded per domain as each phase lands.

### Recommended Direction

**NO SOURCE-SUPPORTED RECOMMENDATION** for the choice between (a), (c), (d) and (e).
**Option (b) is excluded** by the evidence: it omits count adjustments, which `FR-INV-047`
requires and which is the integration this phase exists to unblock.

What the sources **do** determine:

1. **`count_adjustment` must be representable** — `FR-SEC-030` + `FR-INV-047`.
2. **`FR-SEC-030`'s seven is not a closed set** — nine further backed requirements exist.
3. **`price changes` has no consuming requirement**; including it constrains nothing today.
4. **`void` is not backed as an approval request**; it is inferable from `FR-POS-075` and
   `BR-POS-003` but never stated.
5. **The type is `VARCHAR(32)`** (approved SQL), and the `reference_type` precedent supports
   *not* making it an enum while consuming contexts remain unbuilt.

### Scope Impact

**Database:** the column's constraint form only — the type is already settled as `VARCHAR(32)`.
**Inventory integration:** whichever option is chosen must admit `count_adjustment`.
**API:** the accepted value set on request creation (**D-14**).
**No impact** on thresholds (**D-13** — domain-owned), lifecycle (**D-4**), or structure
(**D-5**).

### Ratification Required

**YES — NOT RATIFIED.** No project decision has been recorded for D-16.

### Dependencies

None blocking. **D-17** governs whether `count_sessions` can *store* the resulting reference,
but does not affect which categories exist.

## D-17 — Inventory Boundary

> **RATIFIED 2026-08-17 — OPTION A: STRICT BOUNDARY.**
>
> **Authoritative ratified decision:**
>
> 1. Governance Phase 1 **MUST NOT create, alter, or write to any object in the `inventory`
>    schema**.
> 2. Governance Phase 1 is **restricted to `governance.*`** for its own persistence and
>    implementation.
> 3. Governance Phase 1 **MUST NOT**:
>    - alter Inventory tables;
>    - add `approval_request_id` to Inventory tables;
>    - add foreign keys from Inventory to Governance;
>    - modify Inventory RLS;
>    - modify Inventory triggers;
>    - modify Inventory lifecycle behaviour;
>    - modify Inventory append-only behaviour;
>    - populate `inventory.waste_records.approval_request_id`.
> 4. Inventory approval association in Governance Phase 1 is represented through:
>    `governance.approval_requests.entity_type` and
>    `governance.approval_requests.entity_id`.
> 5. Governance Phase 1 **MUST NOT introduce a reverse Inventory → Governance association**.
> 6. `inventory.waste_records.approval_request_id` **remains NULL and unused** during
>    Governance Phase 1, consistent with the previously ratified Inventory Design Gate
>    boundary.
> 7. `count_sessions` **MUST NOT receive an `approval_request_id` column** or any other
>    Governance integration column during Governance Phase 1.
> 8. **No new Inventory integration is authorized** merely because Inventory requirements
>    state that an operation requires approval.
> 9. Any future Inventory → Governance association, or population of an existing Inventory
>    `approval_request_id` column, **requires a separately authorized future phase/decision**.
> 10. This decision **does not alter or reinterpret** existing Inventory architectural
>     decisions, ADRs, RLS, append-only rules, or the approved SQL.
> 11. **D-17 does not authorize implementation.** Governance remains in the Design Gate /
>     ratification stage.
> 12. All previously ratified decisions are preserved exactly: **D-1 RATIFIED · D-2 RATIFIED
>     (CORE ONLY) · D-3 RATIFIED IN PART · D-4 RATIFIED · D-5 RATIFIED (SINGLE-STEP) ·
>     D-13 RATIFIED**.
> 13. **D-16 remains OPEN and is NOT resolved by this ratification.**

### Question
May Governance Phase 1 create, alter or write to **any** existing Inventory schema object —
and if not, how is an Inventory operation associated with its approval?

### 1. SRS Evidence

**Requirements connecting an approval to an Inventory operation — the complete set:**

| Requirement | Pri | Inventory operation | Approval clause |
|---|---|---|---|
| `FR-INV-035` | [M] | Manual stock adjustment | *"SHALL require approval above a configurable value threshold"* |
| `FR-INV-047` | [M] | Count posting | *"SHALL be an approval-requiring action for high-value adjustments"* |
| `FR-INV-050` | [M] | Count session history | *"SHALL retain full history, including counted values, counter identity, timestamps, recounts, **and approvals**"* |
| `FR-INV-058` | [M] | Waste posting | *"Waste above a configurable value threshold SHALL require manager approval before posting"* |
| `FR-INV-032` | [M] | Transfer discrepancy | *"creating a transfer discrepancy record **requiring investigation and approval**"* |
| `FR-SEC-030` | [M] | — | Names **waste** and **count adjustments** among the mechanism's consumers |

**Decisive negative finding.** An exhaustive search of the SRS for `approval_request_id`,
"approval id" and `approvalId` returns **exactly two hits**, both inside the §24.2.3 code
sample, and both concerning **Sales/discounts**:

```
5123:  if (decision.requiresApproval && !cmd.approvalId) {
5127:  order.applyDiscount(cmd.discount, cmd.actor, cmd.approvalId);
```

**No SRS requirement states that any Inventory table stores an approval reference.** Every
Inventory requirement above states that an operation *requires approval*; none states *where
the association is recorded*.

**§24.2.3 (architecture pattern, not a numbered requirement).** The consuming handler receives
`cmd.approvalId` from the caller and passes it into the aggregate, which stores it. This is
evidence that **the consuming domain — not Governance — writes the reference**, and that the
caller supplies it. It is a Sales example; it is not an Inventory requirement, and it does not
state that Governance performs the write.

### 2. Existing Inventory Architecture Evidence

**Approval-related columns actually present in the live `inventory` schema:**

| Column | Type | Source |
|---|---|---|
| `waste_records.requires_approval` | `boolean NOT NULL` | Approved SQL |
| `waste_records.approval_request_id` | `uuid NULL` — **bare UUID, no FK** | Approved SQL |
| `count_sessions.requires_approval` | `boolean NOT NULL` | **Inventory-phase deviation** — the approved SQL defines **no** approval column on `count_sessions` |

**`count_sessions` in the approved SQL** carries `id, tenant_id, location_id, status,
is_blind_count, started_by, started_at, posted_at, posted_by` — and **nothing approval-related**.

**Inventory Design Gate §17 (ratified) states, verbatim:**

> *"`requires_approval` is computed and persisted where the schema can represent it
> (`waste_records.requires_approval`). Where an operation requires approval, **posting is
> refused** … `waste_records.approval_request_id` remains **null and unused**.
> **`governance.approval_requests` is NOT created.**"*

The Inventory phase therefore **already anticipated this boundary and ratified the column as
null and unused**. It did not request that Governance populate it.

**Append-only scope — narrower than assumed.** Live `ros_app` grants show only **one**
Inventory table is append-only:

- `stock_movements` — `INSERT, SELECT` only (BR-INV-001)
- **every other Inventory table**, including `waste_records` and `count_sessions` — full
  `SELECT, INSERT, UPDATE, DELETE`

So writing an approval reference to `waste_records` would **not** violate the append-only
rule. Writing one to `stock_movements` would be **structurally impossible** — no `UPDATE`
grant — but no requirement asks for that.

**Live behaviour today:** `waste.service.ts:46` and `counts.service.ts:237` refuse posting with
`403` when `requiresApproval` is true (ratified **B-2**). Two E2E tests protect this
(`test/inventory.e2e-spec.ts:570`, `:625`).

### 3. ADR Evidence

- **ADR 0007** — append-only pattern (`GRANT SELECT, INSERT` + `REVOKE UPDATE, DELETE,
  TRUNCATE`). Applies to `stock_movements` and `audit_entries` only; it does not constrain
  `waste_records` or `count_sessions`.
- **ADR 0008 D-09** — composite tenant-safe FKs: *"A composite FK makes the cross-tenant edge
  unrepresentable rather than merely validated."* PostgreSQL evaluates FK checks with row
  security **disabled**, so RLS alone cannot prevent a cross-tenant reference being written.
  This is the **only** architectural argument for adding an FK to
  `waste_records.approval_request_id`, which is currently a bare UUID.
- **ADR 0008 D-11** — `org.settings` deferred; the reason Inventory could not compute
  thresholds and why B-2 made `requires_approval` caller-supplied.

### 4. Approved SQL / Schema Evidence

**The approved SQL designates `approval_request_id` on exactly four tables system-wide:**

| Table | Line | Note |
|---|---|---|
| `inventory.waste_records` | 654–655 | with `requires_approval` |
| `sales.order_discounts` | 933 | comment: *"FK governance.approval_requests(id)"* |
| `sales.refunds` | 966 | |
| `treasury.expenses` | 1145–1146 | with `requires_approval` |

**`inventory.count_sessions` is not among them.** Adding `approval_request_id` to
`count_sessions` would therefore go **beyond** the approved SQL, not merely implement it.

**Governance already carries a generic reverse reference.** `approval_requests` declares
`entity_type VARCHAR(48) NOT NULL` and `entity_id UUID NOT NULL` — sufficient to associate an
approval with **any** Inventory entity **without Inventory carrying any column at all**. The
direction that requires an Inventory column is only entity → approval.

### 5. Inventory Integration Points Discovered

| # | Integration point | Requires an Inventory schema change? | Requires Governance to write Inventory data? |
|---|---|---|---|
| 1 | Governance → Inventory association (`entity_type`/`entity_id`) | **No** — exists already | No |
| 2 | `waste_records.approval_request_id` **populated** | No — column exists | **Only if Governance writes it.** Inventory could write it in a future Inventory revision |
| 3 | `waste_records.approval_request_id` **given an FK** | **Yes** — ALTER on a closed phase | No |
| 4 | `count_sessions` gains `approval_request_id` | **Yes** — ALTER, and beyond the approved SQL | No |
| 5 | Inventory gate changes from *refuse* to *permit-when-approved* | No schema change; **Inventory code change** | No |
| 6 | `stock_movements` | **Not applicable** — append-only, no `UPDATE` grant, and no requirement asks |
| 7 | `stock_items`, `count_lines`, `stock_item_reorder_configs`, all others | **No** — no requirement connects them to approval |

### 6. Answers to the Specific Questions

1. **Does Governance Phase 1 *need* to modify any Inventory table?** **No.** Nothing in the SRS
   requires it, and `approval_requests.entity_type`/`entity_id` already provides association.
2. **Per table:** `stock_movements` — no (append-only; nothing asks). `count_sessions` — not
   required by any SRS text; would exceed the approved SQL. `count_lines` — no.
   `stock_items` — no. `stock_item_reorder_configs` — no. Others — no.
3. **Requirements connecting approval to Inventory:** `FR-INV-032`, `FR-INV-035`, `FR-INV-047`,
   `FR-INV-050`, `FR-INV-058`, plus `FR-SEC-030`'s naming of waste and count adjustments.
4. **Count adjustments / manual adjustments / transfer discrepancies:** all require *approval*;
   **none specifies where the association is stored.**
5. **Does the SRS require Governance to (a) mutate Inventory data, (b) add approval-reference
   columns to Inventory tables, (c) change Inventory lifecycle/status behaviour, or (d) merely
   provide an approval record a consuming operation can reference?**
   **(a) No. (b) No. (c) No. (d) Yes — (d) is the only option the SRS text supports.**
   §24.2.3 further indicates the *consuming domain* writes any reference it keeps.
6. **Conflict with append-only rules?** Only `stock_movements` is append-only, and no
   requirement targets it. `waste_records` and `count_sessions` are fully mutable, so no
   conflict arises. **BR-INV-001 is not threatened by any option below.**
7. **Existing approval reference?** Yes — `waste_records.approval_request_id`, present but
   **null and unused by ratified Inventory design**. `count_sessions` has none.
8. **§24.2.3:** caller supplies `approvalId`; the consuming entity stores it. Sales example;
   architecture pattern, not a numbered requirement; does not assign the write to Governance.
9. **Would adding an approval reference be required by the SRS, an architectural decision, or
   an implementation convenience?**
   - Adding one to `count_sessions`: **not SRS-required**; it is an **architectural decision**
     that also exceeds the approved SQL.
   - Adding an **FK** to the existing `waste_records.approval_request_id`: **not SRS-required**;
     an **architectural decision** grounded in ADR 0008 D-09 tenant safety.
   - Populating the existing column: an **implementation convenience** for query ergonomics —
     `FR-INV-050` can be satisfied by querying Governance on `entity_type`/`entity_id`.
10. **Should Governance Phase 1 have ANY direct dependency on Inventory tables?** The evidence
    does not require one. This is the decision.

### 7. Evidence Classification

| Claim | Classification |
|---|---|
| Inventory operations require approval (`FR-INV-032/035/047/050/058`) | **SRS requirement** |
| Consuming entity stores the approval reference | **Existing approved architecture** (approved SQL designates 4 tables) + **architecture pattern** (§24.2.3) |
| `waste_records.approval_request_id` exists, is null and unused | **Inventory implementation evidence** (Design Gate §17, ratified) |
| `count_sessions` lacks any approval reference and always did | **Approved SQL + implementation evidence** |
| Only `stock_movements` is append-only | **Implementation evidence** (live grants) |
| A composite FK would make the cross-tenant approval edge unrepresentable | **ADR 0008 D-09** |
| Governance must populate Inventory columns | **Inference — NOT supported by any source** |
| `count_sessions` needs `approval_request_id` to satisfy `FR-INV-050` | **Inference — the requirement says "retain history", not "store a column"** |
| Where the association is stored | **UNRESOLVED DECISION** |

### 8. Boundary Options

- **Option A — STRICT BOUNDARY.** Governance Phase 1 creates, alters and writes **only**
  `governance.*` objects. Association is carried **entirely on the Governance side** via
  `approval_requests.entity_type` + `entity_id`. `waste_records.approval_request_id` remains
  null and unused exactly as Inventory Design Gate §17 ratified. Inventory's refuse-gate is
  untouched.
- **Option B — STRICT SCHEMA BOUNDARY, WRITE PERMITTED LATER.** As A, but explicitly records
  that a **future Inventory revision** (not Governance) may populate the existing
  `waste_records.approval_request_id`. No Governance→Inventory write, no schema change now.
- **Option C — ADD FK ONLY.** As A, plus Governance adds a composite tenant-safe FK to the
  existing `waste_records.approval_request_id` (ADR 0008 D-09). Schema change to a closed phase;
  no new column.
- **Option D — ADD COLUMN TO `count_sessions`.** As A, plus `count_sessions` gains
  `approval_request_id`. Schema change to a closed phase **and** beyond the approved SQL.
- **Option E — FULL LINKAGE.** C + D.

### 9. Risks / Trade-offs

| Option | Risks | Trade-offs |
|---|---|---|
| **A** | Entity→approval lookups require querying Governance by `entity_type`/`entity_id` (indexable, but not a direct FK). `waste_records.approval_request_id` stays permanently orphaned, which future readers may mistake for an oversight. | Zero risk to a closed phase. Consistent with D-2 CORE ONLY and with Inventory §17 as ratified. No migration touching `inventory`. |
| **B** | Same as A, plus a documented obligation that a later Inventory phase must discharge. | Preserves the boundary while acknowledging the column's intended purpose. |
| **C** | ALTER on a closed, verified phase; requires re-running Inventory's suite. `identity`-style caveat does not apply, but the FK target `governance.approval_requests` must exist first, creating an ordering dependency. | Closes the ADR 0008 D-09 tenant-safety gap on an edge that is currently representable cross-tenant. |
| **D** | Exceeds the approved SQL, not merely deviating from it. Sets a precedent that a new phase may add columns to closed phases on inference rather than requirement. | Gives `FR-INV-050` a direct, ergonomic join. |
| **E** | Both of the above, compounded. | Most complete linkage; largest boundary breach. |

### 10. Dependencies Exposed

- **D-14 (API surface)** — under Option A, an entity→approval lookup must be served by a
  Governance read surface, which currently has no source-defined endpoint and no read
  permission (**D-20**, GAP-9).
- **D-16** — `entity_type` values interact with `request_type`; D-16 must remain open and is
  not resolved by D-17.
- **D-9 (RLS)** — an FK under Option C requires `governance.approval_requests` to expose a
  `(tenant_id, id)` unique key for a composite reference.
- **Ordering** — Options C/D/E require the Governance tables to exist before the Inventory
  ALTER, i.e. two migrations or one migration spanning two schemas.
- **B-2 contract** — every option must preserve Inventory's refuse-when-`requires_approval`
  behaviour and its two E2E tests until an Inventory phase revises them.

### Recommended Direction

**NO SOURCE-SUPPORTED RECOMMENDATION for the decision itself** — it is a project boundary
call, not a requirements question.

**Where the evidence points, stated without ratifying:** the evidence **favours Option A or
B**. No SRS requirement places an approval reference in an Inventory table; the approved SQL
never designated `count_sessions`; the Inventory Design Gate already ratified
`waste_records.approval_request_id` as *"null and unused"*; `approval_requests.entity_type`
+ `entity_id` already provides the association; and D-2 confines Phase 1 to CORE ONLY.
Options C, D and E each require altering a closed, verified phase on the strength of
**inference rather than requirement** — D additionally exceeding the approved SQL.

### Ratification Required

**YES — RATIFIED 2026-08-17, Option A (STRICT BOUNDARY).**

### The precise question requiring ratification

> **May Governance Phase 1 create, alter, or write to any object in the `inventory` schema?**
>
> - If **NO** (Options A/B): all association is carried by
>   `governance.approval_requests.entity_type` + `entity_id`;
>   `inventory.waste_records.approval_request_id` remains null and unused; and B is chosen over
>   A only if you additionally wish to record that a **future Inventory phase** may populate
>   that column.
> - If **YES**: state exactly which of Options C, D or E is authorised, and accept that a
>   closed, verified phase will be altered on architectural/inferential grounds rather than on
>   an SRS requirement.

### Dependencies

**D-1** (`entity_type`/`entity_id` sufficiency — ratified, and confirmed sufficient by this
analysis). **D-14** and **D-20** for the read path under Option A/B. **D-9** for a composite FK
under Option C/E.

## D-18 — Error Semantics for "Approval Required"

> **STATUS: RATIFIED 2026-08-18 — E-1: NO GOVERNANCE-SPECIFIC ERROR SEMANTICS IN PHASE 1.**
> See the **Ratification** block at the end of this decision for the binding text. The analysis
> below is retained as the record of what was considered.

The analysis that follows is **retained as analysis**. Where it presented options **E-2**,
**E-3**, **E-4**, **E-5**, **E-6** and **E-7**, those options were **considered and not
adopted**; the ratified position is **E-1**, bounded by the fifteen clauses recorded at the end
of this decision. The prior D-18 text was written **before D-14** and framed the question
entirely in HTTP terms; it is superseded and retained only as §11.

---

### 1. Exact SRS Requirements Relevant to Error Semantics (A)

**39 requirements** across the SRS touch errors, rejection, status codes or validation. The ones
that define **error semantics as such** are four, and **§26.2** supplies the model:

| Req | Pri | Text | Framing |
|---|---|---|---|
| `FR-API-001` | **[M]** | *"**Error responses** SHALL use a stable machine-readable code in addition to the human-readable title and detail."* | **HTTP** (§26 API) |
| `FR-API-002` | **[M]** | *"Error messages SHALL be localised per the request's **`Accept-Language` header**."* | **HTTP** — names an HTTP header |
| `FR-API-003` | **[M]** | *"**Error responses** SHALL NOT leak internal details: stack traces, **SQL**, internal hostnames, or other tenants' data."* | **HTTP** |
| `FR-PLT-012` | **[M]** | *"Any request that reaches **the data layer** without a resolved tenant context SHALL **fail closed with an error**, never defaulting to an unfiltered query."* | **DATA LAYER — not HTTP** |

**§26.2 Error Model** (verbatim structure): *"All errors return **RFC 7807 Problem Details**"*,
with a worked example carrying `status`, `instance` (a **URL path**), `code`, `correlationId`,
`errors[]` and `meta`; followed by a **status-code table** (200/201/202/204/400/401/403/404/409/
422/429/500/503) and the cross-tenant rationale:

> *"Rationale for **404 on cross-tenant access**: returning 403 confirms that a resource exists
> in another tenant. Returning 404 does not… this distinction leaks information about
> competitors and **must not be made**."*

Supporting, non-defining: `FR-LOC-001` [M] (error messages bilingual "across every surface"),
`NFR-USA-011` (*"Every error message states what happened and what to do next"* — usability),
`NFR-OBS-003` (RED metrics — observability, not error semantics).

---

### 2. Does ANY Requirement Specifically Govern **Governance approval** Errors?

**NO.** The §26.2 worked example **is** an approval error — but read precisely:

```json
{ "type": "https://api.ros.app/errors/discount-approval-required",
  "title": "Discount requires approval",  "status": 422,
  "detail": "A discount of 25% exceeds the 15% limit for role 'cashier'.",
  "instance": "/v1/orders/01J8XZ.../discounts",
  "code": "DISCOUNT_APPROVAL_REQUIRED",
  "meta": { "requiredPermission": "pos.discount.approve" } }
```

This is a **POS discount** error, on a **POS endpoint** (`/v1/orders/…/discounts`), carrying a
**POS permission** (`pos.discount.approve`). It is raised by the **consuming domain** at the
moment a business operation exceeds a limit — it says *"this action needs approval"*.

**It is NOT an error of the Governance approval workflow.** The SRS defines **no** error for:
approving an already-decided request · self-approval rejection · expiry rejection · duplicate
decision · missing approval request · invalid status transition · RLS denial within Governance.

**Verified: zero requirements govern Governance approval-workflow errors.**

Further: the condition the example describes belongs to **granted-approval staleness /
consuming-domain behaviour**, which is **carried forward unresolved** — and **Phase 1 has no
consuming domain** (Sales/POS absent; **D-17 STRICT BOUNDARY** forbids Governance writing to
Inventory).

---

### 3. Source-Defined vs Architectural Choice

| Semantic | Status |
|---|---|
| **Fail closed with an error when tenant context is unresolved** | **SOURCE-DEFINED** — `FR-PLT-012` [M], **data-layer framed**, survives D-14 |
| **Do not distinguish cross-tenant from non-existent** | **SOURCE-DEFINED as a principle** (§26.2 rationale); the **404 code** expressing it is HTTP-only |
| Stable machine-readable code · localisation · no-internal-leak | **SOURCE-DEFINED for `Error responses` / HTTP** (`FR-API-001/002/003`) |
| RFC 7807 envelope, status-code table, `meta.requiredPermission` | **SOURCE-DEFINED for the API surface** (§26.2) |
| **Every Governance-internal error classification** (self-approval, expiry, transition, duplicate, missing record, DB failure) | **ARCHITECTURAL CHOICE — no source** |

---

### 4. Consequence of D-14 A-1 — HTTP vs Internal Semantics

**D-14 ratified Option A-1: no Governance HTTP/API surface in Phase 1.** §26.2's model is
**HTTP-bound in every element**: an HTTP **status** code, an `instance` **URL path**, the
`Accept-Language` **header** (`FR-API-002`), and RFC 7807 itself — an **HTTP media type**
(`application/problem+json`). `FR-API-001` and `FR-API-003` both bind *"Error responses"*.

**Therefore §26.2 and `FR-API-001/002/003` do NOT attach to Governance Phase 1.** There is no
response to carry a status, no request to carry a header, no `instance` to name.

**What survives D-14:** **`FR-PLT-012` alone** — it binds *"the data layer"*, not the API — and
it is **already satisfied**: the fail-closed predicate
`tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` appears in **9
migrations**, and **D-9 (S1 + N1 + U4)** extends the same fail-closed construction to the
Governance tables. **(B)**

> **This is not an argument that Governance may have no error semantics.** It is the finding
> that **the sources impose none beyond `FR-PLT-012`** once D-14 A-1 removed the surface those
> requirements bind.

---

### 5. Classification of Each Failure Mode — **only where the sources support it**

| Failure | Mechanism under the ratified design | Source-supported classification? |
|---|---|---|
| **Missing tenant context** | RLS fail-closed (D-9) | **YES — `FR-PLT-012` [M]:** fail closed with an error |
| **Cross-tenant access** | Row **invisible** under D-9 RLS | **PRINCIPLE yes** (§26.2 — must not distinguish). The row simply is not there; **no translation is needed to satisfy the principle.** The **404 code is HTTP-only** |
| **Missing record** | Indistinguishable from cross-tenant, by construction | **Same as above** — the indistinguishability the SRS demands is a *structural consequence*, not an error mapping |
| **Authorization failure** | D-3 permission-based; **D-20 OPEN** | **NO** — 401/403 are §26.2 HTTP codes. **Depends on D-20 (OPEN)** |
| **Validation failure** | — | **NO** — 400 is HTTP-only |
| **Invalid state transition** | **D-6 + D-9 U4**: `USING (T AND status='pending')` | **NO.** And note: an invalid transition yields **0 rows updated — not an exception.** §26.2's 409 *"state conflict"* presumes a raised error; the ratified mechanism produces a **silent no-op**. Classifying this **requires a decision, not a mapping** |
| **Self-approval rejection** | **D-7 M2** INSERT `WITH CHECK` → PostgreSQL **42501** *"new row violates row-level security policy"* | **NO** — no SRS error semantic exists for this |
| **Expiry rejection** | **D-10** — same policy, same 42501 | **NO** — same |
| **Duplicate / contradictory decision** | **Nothing prevents it** | **NO — and assigning an error here would contradict D-15 clauses 10 and 11**, which ratified this as *unresolved architectural behaviour* with *no claim* that duplicates are prohibited |
| **Transaction / database failure** | — | **NO — the SRS establishes nothing.** `NFR-OBS-003` (RED metrics) is observability |

**Self-approval and expiry share one indistinguishable signal.** Because **D-7 (M2)** and
**D-10** were each ratified as a **conjunct of the same `WITH CHECK`**, both violations raise
the **identical** PostgreSQL error. Distinguishing them would require either separate policies
(**amending D-7 and/or D-9**) or a pre-check. **Recorded, not resolved.**

---

### 6. Must PostgreSQL / RLS Errors Be Translated, Exposed, or Mapped?

**NO SOURCE REQUIRES TRANSLATION, AND NO SOURCE FORBIDS IT.**

- `FR-API-003` [M] forbids leaking **SQL** — but binds *"**Error responses**"*, which D-14 A-1
  removed. It is **the closest thing to a translation requirement and it does not attach.**
- No requirement anywhere states that database errors must become domain errors.
- **(B) Repository precedent, not a requirement:** `src/modules/organisation/prisma-errors.ts`
  translates Prisma **P2002 → 409** and **P2003 → 404**, the latter documented explicitly to keep
  *"cross-tenant ids indistinguishable from non-existent ones"* (ADR 0008 D-09). This is an
  established convention **for FK and unique violations** — it does **not** cover **42501 RLS
  policy violations**, which is what D-7 and D-10 produce.

**Translation is therefore an architectural choice. It is NOT invented as a requirement here.**

---

### 7. Is a Standard Error Envelope Required for Governance in Phase 1?

**NO.** Three independent grounds:

1. **§26.2 / `FR-API-001/002/003` bind the API surface**, which **D-14 A-1 removed**.
2. **(B) `FR-API-001` is NOT IMPLEMENTED project-wide.** Verified: **no** `ExceptionFilter`,
   `APP_FILTER`, problem-details layer or `application/problem+json` anywhere in `src/`; and
   **`422` / `UnprocessableEntityException` appear nowhere in the repository.** The shipped
   convention is plain NestJS exceptions — `NotFoundException` ×91, `BadRequestException` ×46,
   `ForbiddenException` ×40, `UnauthorizedException` ×34, `ConflictException` ×17.
3. Requiring an envelope of Governance alone would impose on Governance a requirement
   **no shipped module satisfies** — while `FR-API-001` remains a genuine **[M]** gap
   **project-wide**, which is a platform-level concern, not a Governance one.

---

### 8–9. Mechanism Options

| | Option | Source basis | Guarantee | Scope impact | Schema / code / API impact | **Amends a ratification?** | Dependencies |
|---|---|---|---|---|---|---|---|
| **E-1** | **No Governance-specific error semantics in Phase 1** (defer with D-14) | **`FR-PLT-012` already satisfied by D-9**; §26.2 detached by D-14 | Fail-closed tenant isolation only | None | **None** | **NO** | None |
| **E-2** | **Internal domain-error taxonomy only** — named domain errors, no envelope, no HTTP | **None** — architectural | Callers can distinguish causes | Governance service layer | Code only | **NO** | Distinguishing self-approval from expiry needs **D-7/D-9 changes** (§5) |
| **E-3** | **Reuse the repo's NestJS exception convention** (`NotFoundException`, etc.) | **(B) precedent only — not a requirement** | Consistency with shipped modules | Governance service layer | Code only | **NO**, but **in tension with D-14**: HTTP exception *types* presuppose a transport that A-1 declined | — |
| **E-4** | **RFC 7807 problem-details layer for Governance only** | §26.2, `FR-API-001/002/003` | SRS-conformant responses | New API error layer | **Requires an HTTP surface** | **YES — AMENDS D-14 A-1.** *Identified; NOT applied* | D-20 (OPEN) for `meta.requiredPermission` |
| **E-5** | **Project-wide RFC 7807 layer** (implements `FR-API-001/002/003` everywhere) | §26.2, `FR-API-001/002/003` — **strongest source basis** | Closes an [M] gap platform-wide | **Every module** | Global filter + response reshaping | **YES — AMENDS D-14 A-1** *and* **the ratified Inventory B-2 403 behaviour** (2 passing E2E tests). *Identified; NOT applied* | Far beyond Governance |
| **E-6** | **Translate PostgreSQL RLS/constraint errors to domain errors** (extend `prisma-errors.ts` to 42501) | **(B) precedent only** | Uniform internal failure surface | Shared `prisma-errors.ts` | Code only | **NO** — **but** translating a *duplicate decision* into an error would **contradict D-15 cl. 10–11**. *Identified; NOT applied* | §5 self-approval/expiry indistinguishability |
| **E-7** | **Adopt §26.2 `code` + `meta.requiredPermission` as a data contract without HTTP** | §26.2 example — **but it is a POS error** (§2) | Stable codes for a future surface | Governance domain | Code only | **NO** | **D-20 (OPEN)** for the permission string; **D-3 residual**; **D-16 (MUST REMAIN OPEN)** if codes are keyed per `request_type` |

**Dependency summary:** **D-16** — any per-`request_type` error code would require the
enumeration; **must remain OPEN, and E-7 must not be used to settle it.** **D-19** — if errors
are audited, hash coverage bears. **D-20 (OPEN)** — gates E-4 and E-7. **D-12 (BLOCKED)** —
escalation errors unreachable. **Parent-linkage** — **not required by any option**, and **not
resolved here**.

---

### 10. What the SRS Does **NOT** Establish

1. **Any error semantic for the Governance approval workflow itself** (§2 — verified zero).
2. That **approval-workflow** errors use 422 — the 422 example is a **POS discount** error.
3. Any error for **self-approval**, **expiry**, **duplicate decision**, **invalid transition**,
   or a **missing approval request**.
4. That database or RLS errors **must** be translated to domain errors (§6).
5. That an error envelope is required **absent an API surface** (§7).
6. Any **non-HTTP** error contract of any kind — every §26.2 element is HTTP-bound.
7. How to distinguish **self-approval** from **expiry**, which share one signal (§5).
8. Any **error-code namespace** for Governance.
9. Whether an invalid transition should **raise** or be a **silent no-op** — the ratified U4
   mechanism produces a no-op, which §26.2's 409 does not contemplate.

---

### 11. Recommendation

**Two distinct questions, answered separately and honestly.**

**(i) "Do the sources require Governance error semantics in Phase 1?"** — **SOURCE-SUPPORTED
ANSWER: NO, beyond `FR-PLT-012`.** §26.2 and `FR-API-001/002/003` bind an API surface that
**D-14 A-1 removed**; the only error requirement that is **not** HTTP-framed is `FR-PLT-012`,
and **D-9's ratified fail-closed RLS already satisfies it**. This is a **source finding**, and
it points to **E-1**.

**(ii) "Which internal taxonomy should Governance adopt (E-2 … E-7)?"** —
**NO SOURCE-SUPPORTED RECOMMENDATION.** The SRS establishes nothing here, and **convention is
not a source**. Two options carry source-based caveats that are **identified and NOT applied**:
**E-4 and E-5 amend D-14 A-1** (E-5 additionally amends the ratified **Inventory B-2 403**
behaviour), and **E-6 must not translate duplicate decisions**, which would contradict
**D-15 cl. 10–11**.

**Superseded prior text (retained for the record).** The earlier D-18 section framed this as
**Conflict C-3** — *"the SRS prescribes 422 + RFC 7807 for exactly this condition; the shipped
code returns 403"* — with options (a) adopt 422 and change Inventory, (b) keep 403, (c) 422 for
new Governance routes only. **That framing is superseded**: it predates D-14 A-1, so options (a)
and (c) both presuppose Governance HTTP routes that **no longer exist**; and the shipped
Inventory 403s (`waste.service.ts:47`, `counts.service.ts:238`) are **ratified B-2 behaviour**
which **D-17 STRICT BOUNDARY** forbids Governance from altering. **Verified still present and
unchanged.**

### Ratification Required

**YES — NOT RATIFIED.**

### The precise question requiring ratification

> **What error semantics, if any, does Governance Phase 1 adopt?**
>
> 1. **Choose:** **E-1** (none beyond `FR-PLT-012`) · **E-2** (internal taxonomy) ·
>    **E-3** (repo NestJS convention) · **E-6** (translate DB/RLS errors) · **E-7** (§26.2 codes
>    as a data contract) · **defer**.
> 2. **E-4 / E-5 require an explicit amendment of D-14 A-1** (E-5 also of Inventory B-2) and
>    are **NOT** available without one.
> 3. **Acknowledge** that §26.2 / `FR-API-001/002/003` **do not attach** under D-14 A-1.
> 4. **Acknowledge** that **self-approval (D-7) and expiry (D-10) are indistinguishable** under
>    the ratified single-`WITH CHECK` mechanism, and that separating them would amend D-7/D-9.
> 5. **Acknowledge** that an invalid transition is a **0-row no-op**, not a raised error.
> 6. **Confirm** that no option is used to settle **D-16**, **D-20**, the **D-3 residual**, or
>    **parent-linkage**.

### 12. Preservation

**D-1 … D-15 and D-17 are preserved exactly; nothing above amends any of them.** All carried
items stand: **D-16** OPEN · **D-12** BLOCKED · **D-19**, **D-20** OPEN · **D-3 residual** ·
**D-4 clause 5** · **`approval_decisions` → parent-linkage** · **`approval_requests` DELETE** ·
**D-8 cascade verification** · **D-15's PostgreSQL RLS re-evaluation verification item** ·
**granted-approval staleness / consuming-domain behaviour**.

### 13. Closing statement of the analysis (superseded by the ratification below)

**D-18 OPEN — ANALYSED, NOT RATIFIED.** *(Recorded 2026-08-17; superseded by the
ratification of 2026-08-18 that follows.)*

---


### RATIFICATION — D-18 (2026-08-18)

**RATIFIED — E-1: NO GOVERNANCE-SPECIFIC ERROR SEMANTICS IN PHASE 1.**

1. **All D-18 clauses are recorded explicitly below**, verbatim in substance.
2. **The source-defined conclusion is:**
   - **The SRS does NOT define Governance-specific error semantics** for **self-approval**,
     **expiry**, **duplicate decisions**, **invalid transitions**, or **missing approval
     requests**.
   - **`FR-PLT-012` remains applicable and is already satisfied** by the ratified tenant
     **fail-closed RLS** design.
3. **Do NOT** introduce **RFC 7807 / Problem Details** for Governance.
4. **Do NOT** introduce a **Governance HTTP error contract**.
5. **Do NOT** introduce **new HTTP endpoints** or **amend D-14 A-1**.
6. **Do NOT** choose an **internal error taxonomy merely by convention**.
7. **Preserve D-14 A-1 exactly.**
8. **Preserve D-15 exactly**; **do not assign special error semantics to duplicate decisions**.
9. **Preserve D-7 / D-9 / D-10 exactly**; **do not add separate error classification for
   self-approval versus expiry**.
10. **Do not silently convert D-9's invalid-transition 0-row behaviour into an error.**
11. **Do not amend any prior ratification** unless the ratified D-18 wording explicitly requires
    it. **It does not.**
12. **D-16 MUST remain OPEN.**
13. **D-12 MUST remain BLOCKED.**
14. **Preserve all unresolved dependencies exactly.**
15. This is **governance/design ratification only**. It does **NOT authorize implementation**.

**Status:** **RATIFIED — CLOSED.**

---

## D-19 — Audit Hash Coverage for Approval Linkage

> **STATUS: RATIFIED 2026-08-18 — NO ADDITIONAL APPROVAL-SPECIFIC HASH COVERAGE IN PHASE 1.**
> See the **Ratification** block at the end of this decision for the binding text. The analysis
> below is retained as the record of what was considered; options **H-1 … H-6** were
> **considered, and none is adopted as an implementation mandate** — D-19 settles only that
> **no additional approval-specific hash coverage is introduced in Phase 1**.
> The prior D-19 analysis is **retained verbatim as §12** and is **NOT deleted**; §11 records
> **two factual errors** in it that are corrected against the shipped code, and states which of
> its reasoning survives.
> **Scope discipline:** this decision concerns **audit-entry hash coverage only**. It is **not**
> broadened to API logging, observability, metrics, tracing, or error handling — the SRS
> connects none of those to `FR-AUD-004`.

### Question
Do `approver_id` and `approval_id` enter the audit hash chain?

---

### 1. Exact SRS Requirements (A) — SRS §20.1 Audit Log

| Req | Pri | Substance |
|---|---|---|
| `FR-AUD-001` | **[M]** | *"record an **immutable audit entry for every state-changing operation**."* |
| `FR-AUD-002` | **[M]** | Enumerates **what each entry SHALL contain** — 22 fields, **including `approver_id, approval_id` — "Where an approval was involved"**, and `hash, previous_hash` — *"Tamper-evidence chain"* |
| `FR-AUD-003` | **[M]** | *"Append-only. The application database role SHALL hold **INSERT and SELECT** grants… and SHALL NOT hold UPDATE or DELETE."* |
| `FR-AUD-004` | **[M]** | *"hash covers **its own content** and the previous entry's hash, **per tenant**."* → **`hash(n) = SHA-256( canonical_json(entry_n) ‖ hash(n-1) )`** |
| `FR-AUD-005` | **[M]** | *"A **scheduled job** SHALL verify chain integrity and SHALL raise a platform-level security alert on any break."* Rationale: hashing *"makes tampering **detectable**"* |
| `FR-AUD-006` | **[M]** | Always-audit enumeration — includes **"purchase approvals"**, permission changes, role changes, stock adjustments, count postings, waste records, configuration changes |
| `FR-AUD-007` | **[M]** | *"Audit log **access** SHALL itself be audited."* |
| `FR-AUD-008` | **[M]** | Searchable/filterable; **exportable by users with `audit.view` plus `report.export`** |
| `FR-AUD-009` | **[M]** | Retention ≥ 7 years or statutory period |
| `FR-AUD-010` | **[M]** | Impersonation sessions: reason, time limit, notification, **full audit capture** |

---

### 2. Which Governance Events Are **Source-Required** To Be Audited?

- **`FR-AUD-001` [M] — *every* state-changing operation.** Creating an approval request, and
  inserting an approval decision, **are** state-changing. **Covered.**
- **`FR-AUD-006` [M]** enumerates actions that **always** generate entries. **Generic
  "approvals" are NOT in that list — only "purchase approvals"** (Procurement, `FR-PRC-018`),
  a domain **absent in Phase 1** and whose multi-step banding **D-5 deferred**.

**Conclusion:** Governance approval events are **required to be audited via `FR-AUD-001`
(generic), not via `FR-AUD-006` (which names only *purchase* approvals).**

---

### 3. Are `approval_requests` / `approval_decisions` Covered?

| | Verdict |
|---|---|
| **Audited as events** | **IMPLICITLY COVERED** — `FR-AUD-001` [M], "every state-changing operation". No requirement names them explicitly |
| **Referenced by `approver_id` / `approval_id`** | **EXPLICITLY COVERED** — `FR-AUD-002` [M] names both fields, *"Where an approval was involved"* |
| **The approval tables themselves hash-chained** | **NOT COVERED — and must not be conflated.** `FR-AUD-004` binds **audit entries**, i.e. `governance.audit_entries`. **No requirement hash-chains domain tables.** **D-8**'s decision immutability is **grant-based (ADR 0007), not hash-based** |

**Critical scoping fact.** `FR-AUD-002`'s *"Where an approval **was involved**"* describes an
audit entry for a **business operation that required approval** — a **consuming-domain** event
(the §26.2 example being a POS discount). **Phase 1 has no consuming domain**: Sales/POS and
Procurement are absent, and **D-17 STRICT BOUNDARY** forbids Governance writing to Inventory.
**Therefore no Phase 1 audit entry can populate `approver_id` / `approval_id` at all.** This is
the **granted-approval staleness / consuming-domain behaviour** item, which remains unresolved.

---

### 4. Relationship With ADR 0007 and Prior Decisions

| | Relationship |
|---|---|
| **ADR 0007** | Append-only = `GRANT SELECT, INSERT` + `REVOKE UPDATE, DELETE, TRUNCATE`. **Verified shipped** on `audit_entries` (migration `20260812175712`, lines 50–51), plus `ENABLE` + `FORCE` RLS and two policies. **Exactly satisfies `FR-AUD-003` [M].** No D-19 option alters it |
| **existing `audit_entries`** | Shipped with **all 22 `FR-AUD-002` columns present**, including `approver_id`, `approval_id`, `impersonated_by`, `branch_id`, `causation_id` — **currently unpopulated** |
| **D-2** (PIN/RBAC core) | `FR-AUD-006`'s *"authentication success and failure, permission changes, role changes"* — already served by the shipped auth audit trail |
| **D-6** (status-only mutability) | A status transition **is** a state change → `FR-AUD-001` applies. A **failed** transition is a **0-row no-op** (D-18 cl. 10), **not** a state change → **no audit entry is required for it** |
| **D-7 / D-10** (self-approval, expiry) | Both are **rejections at INSERT**. **No requirement audits RLS rejections** (see §5). **D-18 E-1** ratified no error semantics — these produce **no auditable state change** |
| **D-8** (decisions append-only) | Same ADR 0007 pattern as the audit table, but **independent of the hash chain**. **D-19 does not alter D-8** |
| **D-9** (RLS S1+N1+U4) | `audit_entries` RLS already shipped; the chain is **per-tenant**, consistent with **N1** tenant anchoring and `FR-AUD-004`'s *"per tenant"* |
| **D-13** (threshold config) | `FR-AUD-006` *"configuration changes"* → threshold changes are auditable when that surface exists |
| **D-17** (STRICT BOUNDARY) | `audit_entries` is in the **`governance` schema**, so Governance may write it. **No boundary conflict.** But Inventory writes its **own** audit entries |
| **D-14 A-1** (no HTTP) | `ip_address`, `user_agent`, `terminal_id` have **no source** for Governance events in Phase 1 |
| **D-15** (minimal concurrency) | If duplicate decisions occur, **each INSERT is a state change** → each gets its own entry. **No special audit semantics** — consistent with D-15 cl. 10–11 |
| **D-18 E-1** (no error semantics) | Reinforces that **failures are not audited** in Phase 1 |
| **D-12 BLOCKED / D-16 OPEN / D-20 OPEN** | `FR-AUD-007` (audit access is audited) and `FR-AUD-008` (`audit.view` + `report.export`) **bear on D-20** — **not resolved here**. **D-16 untouched** |

---

### 5. What the SRS Specifies vs Leaves Open

| Element | Source-defined? |
|---|---|
| **Hash algorithm** | **YES — `SHA-256`**, named literally in `FR-AUD-004` |
| **Chaining** | **YES** — each hash covers the previous entry's hash |
| **Previous-hash linkage** | **YES** — `previous_hash` is an `FR-AUD-002` field |
| **Chain scope** | **YES — "per tenant"** |
| **What is hashed** | **PARTLY** — *"its own content"* / `canonical_json(entry_n)`. **`FR-AUD-002` defines the entry's content**, which is the strongest available reading of *"entry_n"* |
| **Which fields are included** | **NOT ENUMERATED for hashing.** `FR-AUD-002` enumerates the entry's **fields**; `FR-AUD-004` never restates a hashed subset |
| **Canonicalization / serialization** | **NO.** `canonical_json` is **never defined** — no key ordering, encoding, null handling, timestamp format, or bytes representation |
| **Actor / tenant / request identifiers** | **Present as `FR-AUD-002` fields**; **no** statement about their hash inclusion specifically |
| **Are RLS / security failures audited?** | **NO.** `FR-AUD-006` requires **authentication** success *and failure*; it says **nothing about RLS or authorization failures**. **Not source-required** |

---

### 6. Source-Defined vs Architectural

**SOURCE-DEFINED:** SHA-256 · per-tenant chaining · previous-hash linkage · append-only grants ·
entry field set (`FR-AUD-002`) · audit-on-every-state-change · scheduled integrity verification.

**ARCHITECTURAL CHOICE:** the definition of `canonical_json` · which subset of columns is fed to
the digest · how `previous_hash` is combined · any chain/algorithm versioning scheme ·
sequence-number allocation and its locking.

---

### 7. Shipped Implementation — Verified Facts (B)

`computeEntryHash` (`src/modules/governance/audit/audit-hash.ts`) digests **14 elements**:

> `tenantId, sequenceNo, occurredAt, actorType, actorId, action, entityType, entityId,`
> `terminalId, reasonCode, beforeState, afterState, correlationId, previousHash`

**Ten `FR-AUD-002` fields are OUTSIDE the chain:**

| Field | Note |
|---|---|
| `id` | ULID primary key |
| `branch_id` | `FR-AUD-002` "Scope" |
| `recorded_at` | system time |
| `impersonated_by` | **bears on `FR-AUD-010` [M]** — impersonation capture |
| `reason_text` | free text |
| **`approver_id`** | **D-19's subject** |
| **`approval_id`** | **D-19's subject** |
| `ip_address`, `user_agent` | origin |
| `causation_id` | causal chain |

**Therefore the coverage gap is broader than approvals** — approval linkage is **two of ten**
uncovered fields. Recorded as a fact; **widening D-19's scope is not proposed here.**

**Two further verified facts:**

1. **`AuditEvent` exposes neither `approverId` nor `approvalId`**, so `AuditService.record()`
   **cannot populate the columns at all** — independent of any hashing question.
2. **The shipped composition deviates structurally from `FR-AUD-004`'s literal formula.** The
   requirement states `SHA-256( canonical_json(entry_n) ‖ hash(n-1) )` — the previous hash
   **concatenated after** the canonical JSON. The implementation places `previousHash` **inside**
   the canonical object: `SHA-256( stableStringify({ …fields, previousHash: hex }) )`. Both bind
   the previous hash into the digest; **the literal `‖` construction is not what ships.**
   Stated as a fact, **not** as a defect finding, and **not** proposed for change here.

`canonical_json` is implemented as `stableStringify` — recursive key sorting. **No source
defines this**; it is a reasonable architectural choice with **no requirement to compare against.**

---

### 8. Options

| | Option | Source basis | Guarantee | Schema impact | Migration / code impact | Interaction with `audit_entries` | **Amends a ratification?** | Dependencies |
|---|---|---|---|---|---|---|---|---|
| **H-1** | **No change** — linkage stays out of the chain; `AuditEvent` unchanged | None affirmative; relies on `canonical_json` being undefined | Existing chain untouched; **verification procedure stays uniform** | None | **None** | None | **NO** | — |
| **H-2** | **Populate only** — extend `AuditEvent` to carry the two fields; **hash unchanged** | `FR-AUD-002` [M] names both fields | Columns become usable; **linkage remains outside tamper-evidence** | None (columns exist) | Governance-owned code only | Writes 2 currently-null columns | **NO** | **Consuming-domain behaviour (unresolved)** — nothing populates them in Phase 1 |
| **H-3** | **Hash the two approval fields** | `FR-AUD-002` + `FR-AUD-004` *"its own content"* | Approval linkage becomes tamper-evident | None | `computeEntryHash` + `HashableEntry`; **verification of pre-existing entries must know which algorithm applied** | **Changes the digest for all future entries**; shipped auth-trail tests bear | **NO ratified decision governs hash composition** — but it changes **shipped** behaviour | Same as H-2 |
| **H-4** | **Hash all `FR-AUD-002` fields** (strict `canonical_json(entry_n)` reading) | **Strongest** — `FR-AUD-002` [M] defines the entry; `FR-AUD-004` hashes the entry | Closes the **full ten-field** gap, incl. `impersonated_by` (`FR-AUD-010`) | None | Largest; same verification-continuity problem | Same, wider | **NO** — but **widens D-19 beyond approvals** | Platform-level, exceeds Governance |
| **H-5** | **Algorithm/chain versioning** — record a hash-version, then extend coverage | `FR-AUD-005` [M] requires a **working verification job** across both eras | Extension **without** ambiguity for the verifier | **Yes — a version column** (migration) | Migration + code + verifier | Makes H-3/H-4 safely adoptable | **NO** | Platform-level |
| **H-6** | **Defer to a platform-level audit decision** | `FR-AUD-004/005` are platform-wide, not Governance-specific | Nothing decided now | None | None | None | **NO** | — |

**Amendment check: NO option amends any ratified decision.** No prior decision governs hash
composition; `audit_entries` predates the Governance register. **H-3/H-4/H-5 do change *shipped*
code**, which is an implementation impact, **not** a ratification amendment — and **none is
applied here.**

**On the prior claim that extending the hash "invalidates every existing chain" — this is
imprecise.** Pre-existing entries remain **internally consistent under the algorithm that
produced them**; what breaks is a **single uniform verification procedure**, which is exactly
what `FR-AUD-005` [M] requires. That reframes the cost from *data destruction* to a
**verification-versioning problem** — which is what **H-5** addresses.

---

### 9. What the SRS Does **NOT** Establish

1. **The definition of `canonical_json`** — no ordering, encoding, null, timestamp or bytes rule.
2. **Which columns constitute *"entry_n"*** for hashing purposes.
3. That `approver_id` / `approval_id` are **specifically** inside or outside the digest.
4. Any **hash-algorithm versioning** or chain-migration procedure.
5. That **domain tables** (`approval_requests`, `approval_decisions`) are hash-chained — they
   are **not**; `FR-AUD-004` binds audit entries only.
6. That **RLS or authorization failures** are audited (only **authentication** failure is named).
7. Any Governance-specific **audit action vocabulary** for approval events.
8. How the audit chain interacts with the **absence of a consuming domain**.
9. Whether an entry may be written with `approver_id` **unpopulated** where an approval existed.

---

### 10. Recommendation

**Two questions, answered separately.**

**(i) "Is D-19 decidable in Phase 1?"** — **A source-and-repository-supported finding:
NOT URGENT, because the fields are unpopulatable.** `FR-AUD-002`'s *"where an approval was
involved"* describes a **consuming-domain** audit entry; **Phase 1 has no consuming domain**
(Sales and Procurement absent; **D-17** bars Inventory writes), and **`AuditEvent` cannot carry
the fields**. **No Phase 1 audit entry can contain unhashed approval linkage.** The tamper-
evidence exposure D-19 asks about **cannot arise in Phase 1**.

**(ii) "Do the two fields belong inside the digest?"** — **NO SOURCE-SUPPORTED RECOMMENDATION.**

The honest reading of the evidence, offered **neutrally and without recommending an option**:
`FR-AUD-002` [M] **defines the entry's content**, and `FR-AUD-004` hashes **`canonical_json(entry_n)`**
— so the strict reading **does** point toward broader coverage. But the SRS **never defines
`canonical_json`**, never enumerates a hashed subset, and the gap is **ten fields wide**, not two
— **`impersonated_by` bears on `FR-AUD-010` [M]**. Resolving that on a Governance decision would
settle a **platform-wide** audit question from inside the narrowest possible case. **Convention
and cryptographic best practice are explicitly not treated as sources here.**

---

### 11. Corrections to the Prior D-19 Analysis (retained below as §12)

The prior analysis is **retained, not replaced**. **Two factual errors**, verified against
`src/modules/governance/audit/audit-hash.ts`:

| Prior claim | Verified fact |
|---|---|
| *"`computeEntryHash` covers: `tenantId, sequenceNo, occurredAt, actorType, actorId, action, entityType, entityId, beforeState, afterState, previousHash`"* | **Incomplete** — it also covers **`terminalId`**, **`reasonCode`** and **`correlationId`** (14 elements, not 11) |
| *"It **omits** `approver_id`, `approval_id`, `reasonCode`, `reasonText`, `correlationId`"* | **Wrong for two of five.** `reasonCode` and `correlationId` **are hashed**. The true omissions are `approver_id`, `approval_id`, `reason_text`, **plus `id`, `branch_id`, `recorded_at`, `impersonated_by`, `ip_address`, `user_agent`, `causation_id`** |

**What of the prior analysis survives:** its statement of the question; GAP-11; the observation
that extending `AuditEvent` to **carry** the fields is *"separable from the hash question"*
(**correct** — retained as H-2); and its **NO SOURCE-SUPPORTED RECOMMENDATION**.
**What is superseded:** the field lists above, the unqualified *"invalidates every existing
chain"* cost claim (§8), and *"Dependencies: None"* — **consuming-domain behaviour is a real
dependency** (§3, §10).

---

### 12. Prior D-19 Analysis (RETAINED VERBATIM — SUPERSEDED WHERE §11 STATES)

> ### Question
> Do `approver_id` and `approval_id` enter the audit hash chain?
>
> ### SRS Evidence
> `FR-AUD-004` [M]: *"each entry's hash covers **its own content** and the previous entry's hash, per tenant. hash(n) = SHA-256( canonical_json(entry_n) || hash(n-1) )"* — *"its own content"* is not further defined.
> `FR-AUD-006` [M] requires purchase approvals to always generate audit entries.
>
> ### Existing Repository Evidence
> - `governance.audit_entries` **already has `approver_id` and `approval_id`** — present in the approved SQL and the live database, currently unused.
> - `AuditEvent` (`audit.service.ts:8-25`) **does not expose them**, so `AuditService.record()` cannot populate them.
> - `computeEntryHash` (`audit-hash.ts`) covers: `tenantId, sequenceNo, occurredAt, actorType, actorId, action, entityType, entityId, beforeState, afterState, previousHash`. It **omits** `approver_id`, `approval_id`, `reasonCode`, `reasonText`, `correlationId`.  *(**§11: FACTUALLY INCORRECT** — `terminalId`, `reasonCode`, `correlationId` ARE hashed.)*
>
> ### Conflict / Gap
> **GAP-11.** Approval linkage written to audit rows would sit **outside the tamper-evident chain**. Extending the hash would **invalidate every existing chain**, since all prior entries were computed without those fields.  *(**§8: IMPRECISE** — a verification-versioning problem, not data invalidation.)*
>
> ### Options
> - **(a)** Extend `computeEntryHash` — invalidates all existing chains.
> - **(b)** Leave outside the chain, document the limitation.
> - **(c)** Leave outside now; revisit under a future audit-versioning scheme.
>
> ### Recommended Direction
> **NO SOURCE-SUPPORTED RECOMMENDATION.** `FR-AUD-004`'s *"canonical_json(entry_n)"* is genuinely ambiguous about which columns constitute "the entry", and the cost of (a) — invalidating every chain in existence — is severe enough that it cannot be chosen on a reading of ambiguous text.
>
> Note that extending `AuditEvent` to *carry* the fields is a Governance-owned change to a Governance-owned file, and is separable from the hash question.
>
> ### Scope Impact
> `AuditService`/`AuditEvent` (Governance-owned). Hash algorithm and every existing chain if (a). Audit test matrix.
>
> ### Dependencies
> None.  *(**§11: SUPERSEDED** — consuming-domain behaviour is a dependency.)*

---

### Ratification Required

**YES — NOT RATIFIED.**

### The precise question requiring ratification

> **Do `approver_id` and `approval_id` enter the audit hash chain, and does `AuditEvent` carry them?**
>
> 1. **Choose:** **H-1** (no change) · **H-2** (populate only, hash unchanged) · **H-3** (hash the
>    two fields) · **H-4** (hash all `FR-AUD-002` fields) · **H-5** (versioning, then extend) ·
>    **H-6** (defer to a platform audit decision).
> 2. **Acknowledge** that **no Phase 1 audit entry can populate these fields** — the events that
>    would carry them are **consuming-domain** events, and none exists.
> 3. **Acknowledge** that the gap is **ten fields wide**, and that `impersonated_by` bears on
>    **`FR-AUD-010` [M]** — deciding only the approval pair leaves the rest open.
> 4. **Acknowledge** the shipped digest **does not use `FR-AUD-004`'s literal `‖` construction**.
> 5. **Confirm** that no option is used to settle **D-16**, **D-20**, `FR-AUD-007`/`008` audit-read
>    permissions, or **parent-linkage**.
> 6. **Note:** H-3/H-4/H-5 change **shipped** code and bear on `FR-AUD-005`'s verification job.

### Preservation

**D-1 … D-15, D-17 and D-18 are preserved exactly; nothing above amends any of them.** All
carried items stand: **D-16** OPEN · **D-12** BLOCKED · **D-20** OPEN · **D-3 residual** ·
**D-4 clause 5** · **parent-linkage** · **`approval_requests` DELETE** · **D-8 cascade
verification** · **D-15's PostgreSQL RLS re-evaluation verification item** · **granted-approval
staleness / consuming-domain behaviour**.

### Closing statement of the analysis (superseded by the ratification below)

**D-19 OPEN — ANALYSED, NOT RATIFIED.** *(Recorded 2026-08-18; superseded by the ratification
of 2026-08-18 that follows.)*

---

### RATIFICATION — D-19 (2026-08-18)

**RATIFIED — NO ADDITIONAL APPROVAL-SPECIFIC HASH COVERAGE IN PHASE 1.**

> **This is a governance/design ratification only. It does NOT authorize implementation and
> does NOT modify the shipped audit hashing implementation.**

1. **D-19 is concerned with whether approval-specific fields require additional hash coverage
   in Phase 1.**
2. **`FR-AUD-004` remains the governing audit-hash requirement:** **SHA-256** over
   **`canonical_json(entry_n)`** together with the **previous hash**, with the existing
   **per-tenant chaining** requirement **preserved**.
3. **D-19 does NOT redefine `canonical_json`.**
4. **D-19 does NOT select a new hashed-field subset.**
5. **D-19 does NOT require `approver_id` or `approval_id` to be added to the current digest.**
6. **D-19 does NOT require `approval_requests` or `approval_decisions` themselves to become
   hash-chained audit records.**
7. **D-8 append-only enforcement remains distinct from audit hashing and is unchanged.**
8. **Existing `audit_entries` hashing remains unchanged by this ratification.**
9. **The broader ten-field hash-coverage question identified during analysis remains
   unresolved**, rather than being silently decided by D-19.
10. **No new hash algorithm, canonicalization scheme, hash versioning scheme, migration, or
    backfill is authorized by D-19.**
11. **No prior ratified decision is amended.**
12. **D-20 remains OPEN** and must address the separately identified **audit-read permission
    requirements** (`FR-AUD-007`, `FR-AUD-008`) where applicable.
13. **D-16 MUST remain OPEN.**
14. **D-12 remains BLOCKED.**
15. **All other prior decisions and unresolved dependencies remain exactly as recorded.**
16. **This ratification does NOT claim that all `FR-AUD` requirements are satisfied**; it only
    settles that **D-19 does not introduce additional approval-specific hash coverage in
    Phase 1**.
17. **Any future platform-wide decision** about **hash-field coverage**, **canonicalization**, or
    **hash-version migration** **requires its own explicit governance decision**.
18. **No implementation is authorized.**

**Status:** **RATIFIED — CLOSED.**

---

## D-20 — Permission for Reading Approval Requests

> **STATUS: RATIFIED 2026-08-18 — MINIMAL / NO NEW GOVERNANCE READ SURFACE IN PHASE 1.**
> See the **Ratification** block at the end of this decision for the binding text. The analysis
> below is retained as the record of what was considered; **R-1 … R-7 are NOT introduced as
> implementation mandates**, beyond the **status-quo position already identified as R-2**.
> The prior D-20 text is **retained verbatim as §12** and is **NOT deleted**; §11 records **one
> factual correction** to its reasoning. **D-19 is RATIFIED and is not reopened; GAP-11 remains
> open.** **No mutation or RLS-bypass mechanism is proposed anywhere below.**

### Question
Which permission governs reading/listing approval requests and decisions, given §15.2 supplies
none — and, after **D-14 A-1**, is any Phase 1 read capability required at all?

---

### 1. Exact SRS Evidence (A)

**1a. The permission catalogue — §15.2, "Governance & Platform" group (verbatim):**

| Permission | Description |
|---|---|
| `report.view.<category>` | View a report category |
| `report.export` | Export report data |
| **`audit.view`** | **View the audit log** |
| `governance.view_anomalies` | View fraud/anomaly flags |
| `security.user.manage` · `security.role.manage` | Users / roles |
| `settings.branch.manage` · `settings.tenant.manage` | Configuration |
| `integration.manage` · `api.key.manage` | Integrations / credentials |

**No permission in §15.2 governs reading approval requests or approval decisions.**
`audit.view` binds **the audit log**; `governance.view_anomalies` binds **anomaly flags**.

**Decisive evidentiary limit.** §15.2 states it is *"**representative rather than exhaustive**;
the full catalogue is maintained in **Appendix C**."* **Appendix C is referenced exactly once
and is NOT present in the supplied SRS.** The absence of an approval-read code therefore
**cannot be established as a genuine absence** — the authoritative catalogue is unavailable.

**1b. The requirements that make a read permission necessary:**

| Req | Pri | Substance |
|---|---|---|
| **`FR-SEC-010`** | **[M]** | Ships predefined roles, including **Auditor — scope Tenant — *"Read-only everything **including audit log***"*** |
| **`FR-SEC-011`** | **[M]** | *"Tenants SHALL be able to create custom roles by **selecting permissions from the catalogue**."* |
| `FR-SEC-004` | **[M]** | Effective permissions are the **union within each assignment's own scope**; *"**Permissions SHALL NOT leak across scopes**."* |
| `FR-CST-041` | **[M]** | *"Anomaly flags SHALL be visible **only** to users holding an explicit `governance.view_anomalies` permission."* — the SRS's **only** explicit governance read-restriction, and it binds **anomaly flags, not approvals** |

**`FR-SEC-010` + `FR-SEC-011` jointly entail that a read permission must exist** for approval
data: roles are expressed **only** by selecting catalogue permissions, and the Auditor role is
defined as **read-only everything**. Without such a code the Auditor role is **unexpressible**.

**1c. Audit-log read requirements:**

| Req | Pri | Substance | Applies in Phase 1? |
|---|---|---|---|
| **`FR-AUD-007`** | **[M]** | *"Audit log **access** SHALL itself be audited."* | **CONDITIONAL — not triggered.** It governs access *when it occurs*; it **does not require creating** a read capability |
| **`FR-AUD-008`** | **[M]** | *"The audit log SHALL be **searchable and filterable** by actor, entity, action, date range, branch, and correlation ID, and SHALL be **exportable by users with `audit.view` plus `report.export`**."* | **AFFIRMATIVELY REQUIRED — and NOT satisfied.** Delivering it needs a surface **D-14 A-1 declined** |

**1d. Approval reads are implied, never stated:**
`FR-SEC-032` [M] (approver decides via terminal PIN or mobile push) presupposes the approver
**sees** the pending request; `FR-SEC-035` [M] references an **exception report** over
retrospective approvals. **Neither states a read authorization rule**, and both surfaces are
deferred — **D-2** (core only) and **D-11** (notifications: strict none).

---

### 2. Required · Implied · Unsupported · Already Settled

| Category | Content |
|---|---|
| **EXPLICITLY SRS-REQUIRED** | `FR-AUD-008` [M] — audit log searchable/filterable/exportable under **`audit.view` + `report.export`**. `FR-AUD-007` [M] — audit access is itself audited (**conditional**). `FR-CST-041` [M] — anomaly flags gated. `FR-SEC-010`/`011` [M] — Auditor role must be **expressible** |
| **IMPLIED** | Approvers must read pending requests (`FR-SEC-032`); exception reporting reads approvals (`FR-SEC-035`); a read permission must exist for approvals (from `FR-SEC-010` + `FR-SEC-011`) |
| **UNSUPPORTED ARCHITECTURAL CHOICE** | The **name** of any approval-read code; whether reads are gated by the request's own `required_permission`; whether requesters may read their own requests; branch- vs tenant-scoped read visibility for approvals |
| **ALREADY SETTLED BY RATIFIED DECISIONS** | **D-9 (S1 + N1)** — `SELECT` is already tenant-predicated under `FORCE`d RLS on Governance tables, satisfying **`FR-PLT-012`** [M]. **D-14 A-1** — no HTTP surface. **D-3** — authority is permission-based (residual open). **D-2** — branch-scoped RBAC deferred, so `FR-SEC-004` scope mechanics are **not reopened here** |

---

### 3. Consequence of D-14 A-1 — Two Separate Layers

**No GET endpoints are invented below.** The layers are analysed separately:

- **HTTP read authorization** — **DOES NOT EXIST and is not proposed.** D-14 A-1 ratified no
  Governance HTTP surface. Any option delivering `FR-AUD-008`'s search/export **amends D-14**.
- **Database read authorization** — **ALREADY RATIFIED AND SUFFICIENT AT ITS LAYER.** D-9's
  `SELECT` policies bind `tenant_id` under `ENABLE` + `FORCE` RLS, with `ros_app`
  `NOSUPERUSER, NOBYPASSRLS`. **No cross-tenant read is possible.** Nothing further is required
  for tenant isolation.
- **Service/internal read authorization** — **UNDECIDED.** No Governance service reads approval
  data (none exists). This is where a permission code would eventually apply.

---

### 4. Phase 1 Exercisability (B — verified, absence is NOT treated as licence to invent)

| Fact | Verified |
|---|---|
| Governance HTTP surface | **None** — D-14 A-1 |
| `src/modules/governance/` | **`audit/` only** — 8 files, no controller, no read service |
| Application code reading `audit_entries` | **NONE.** Only `AuditService.record()`'s `findFirst` for the chain tail — a **write-path** read |
| `verifyAuditChain` (`audit-verify.ts`) | **PURE — 0 database references.** Entries are passed in as an argument, and it is documented *"intentionally NOT exposed as an HTTP endpoint"*. **It is not an audit read path** |
| Scheduled job (`FR-AUD-005`) | **NONE** — no `@Cron`, `ScheduleModule` or interval anywhere in `src/` |
| Consuming domain | **NONE** — Sales/POS and Procurement absent; **D-17** bars Inventory writes |
| `audit.view` / `report.export` implemented | **NEITHER** |

**Conclusion: Phase 1 has no surface capable of exercising a Governance read, and none is
proposed here.** `FR-AUD-007` is therefore **not triggered**; `FR-AUD-008` is **an unsatisfied
[M] requirement**, recorded as a gap — **closing it is not proposed, because it would amend
D-14 A-1.**

---

### 5. Scope of `FR-AUD-007` / `FR-AUD-008` — What They Do and Do Not Reach

| Target | `FR-AUD-007` | `FR-AUD-008` |
|---|---|---|
| **`audit_entries`** | **YES** — access must be audited when it occurs | **YES** — must be searchable/filterable/exportable |
| **`approval_requests`** | **NO** — not the audit log | **NO** |
| **`approval_decisions`** | **NO** | **NO** |
| **Consuming domains** | Only insofar as they access the audit log | Same |
| **Administrative users** | Not distinguished — the SRS names **no** admin-vs-tenant read distinction for audit | `audit.view` + `report.export` only |
| **Tenant users** | Governed by the two permissions; **`FR-SEC-004`** forbids cross-scope leakage | Same |
| **Branch-scoped users** | **NOT RESOLVED.** `FR-AUD-008` names **branch** as a *filter* dimension, **not** as a restriction. **D-2 deferred branch-scoped RBAC** | Same |

**Neither `FR-AUD-007` nor `FR-AUD-008` requires a Phase 1 *Governance approval* read
capability. Both bind the audit log only.**

---

### 6–9. Candidate Mechanisms

| | Mechanism | Permits | Denies | Source basis | Schema / RLS / API change | **Amends?** | Expands Phase 1 scope? |
|---|---|---|---|---|---|---|---|
| **R-1** | **No Governance read capability in Phase 1** | Nothing new | All application reads | Consistent with **D-14 A-1**; `FR-AUD-007` untriggered | **None** | **NO** | **No** |
| **R-2** | **Rely on the ratified D-9 `SELECT` RLS** (status quo) | Tenant-scoped `SELECT` for `ros_app` | **All cross-tenant reads** | **`FR-PLT-012`** [M] + **D-9 S1/N1 — already ratified** | **None — already shipped design** | **NO** | **No** |
| **R-3** | **Gate reads on the request's own `required_permission`** | Only holders of the approver permission | **The requester's view of their own request** | **None** — `FR-SEC-031`'s *"required approver permission"* is **decision authority, not read authority** | Code | **NO**, but leans on the **D-3 residual (open)** | Yes |
| **R-4** | **Provisional `governance.approval.read`, marked PROVISIONAL pending Appendix C** | Approval reads under an explicit code | Everything else | **`FR-SEC-010` + `FR-SEC-011`** [M] — the **Auditor role is otherwise unexpressible**; **ADR 0008 D-01** precedent | Permission registration; **no schema/RLS** | **NO** | Yes — introduces a code with no consuming surface |
| **R-5** | **Reuse `audit.view`** | Audit-log holders read approvals | Others | **Contradicted** — §15.2 binds it to *"the audit log"* | Code | **NO** | Yes |
| **R-6** | **Reuse `governance.view_anomalies`** | Anomaly viewers read approvals | Others | **Contradicted by `FR-CST-041` [M]** — binds it to **anomaly flags** | Code | **NO** | Yes |
| **R-7** | **Defer to Appendix C** | Nothing now | Nothing now | §15.2 designates Appendix C authoritative; **it is absent** | None | **NO** | **No** |

**Amendment check: no candidate amends any ratified decision.** All are **read-only**;
**none introduces mutation, an RLS bypass, or any change to D-6, D-7, D-8, D-9 or D-10.**
`approval_decisions` remain **fully append-only (D-8)**; tenant isolation (**D-9**) is untouched.
**Separately: satisfying `FR-AUD-008`'s search/export would amend D-14 A-1 — identified, NOT
proposed.**

**Repository precedent for R-4 (B) — verified, and stronger than the prior text recorded.**
**Nine** permission codes ship that §15.2 does **not** contain, of which **seven are `.read`
companions**: `menu.item.read`, `menu.price.read`, `menu.availability.read`,
`settings.tenant.read`, `settings.branch.read`, `identity.role.read`, `identity.terminal.read`.
Both catalogue files state the rationale verbatim — *"Appendix C is NOT in the supplied SRS.
Without a read code the §15.3 **Auditor role ('read-only everything') is unexpressible**… These
are **PROVISIONAL**: if Appendix C names them differently, **remap per ADR 0008 D-01**."*

---

### 10. What the SRS Does **NOT** Establish

1. **Any permission governing approval-request or approval-decision reads.**
2. The **contents of Appendix C**, which §15.2 designates as the authoritative catalogue.
3. Whether a **requester may read their own** pending request.
4. Whether approval reads are **branch-** or **tenant-**scoped (`FR-AUD-008` names branch as a
   *filter*, not a restriction; **D-2** deferred branch-scoped RBAC).
5. Any **admin-vs-tenant** read distinction for audit or approval data.
6. Whether **chain verification** (`FR-AUD-005`) constitutes *"audit log access"* under
   `FR-AUD-007`.
7. Any read semantics for **expired**, **rejected**, or **superseded** requests.
8. How `FR-SEC-004`'s *"permissions SHALL NOT leak across scopes"* applies to Governance reads.

---

### 11. Correction to the Prior D-20 Analysis (retained as §12)

| Prior claim | Verified fact |
|---|---|
| Option (c) *"has precedent but **conflicts with the stricter zero-invented-codes line held by Production Spec**"* | **Not a conflict.** Production Spec invented no codes because **§15.2 supplies `recipe.view`, `recipe.edit` and `recipe.publish` verbatim** — it faced **no** missing read code. It is a case where none was **needed**, **not** a counter-precedent to R-4 |
| *"Catalogue explicitly marked **three** `.read` codes PROVISIONAL"* | **Understated** — **seven** provisional `.read` codes ship across Catalogue (3), Organisation (2) and Identity (2) |

**What survives:** the question; **GAP-9**; the objection that gating on `required_permission`
would bar a requester from viewing their own request (**correct** — retained as R-3); and the
**NO SOURCE-SUPPORTED RECOMMENDATION** on the code itself.
**What is superseded:** *"A read surface (if **D-14** authorises one)"* — **D-14 A-1 has since
ratified that it does not**; and the Scope Impact line's *"API authorization"*, which no longer
applies.

---

### 12. Prior D-20 Analysis (RETAINED VERBATIM — SUPERSEDED WHERE §11 STATES)

> ### Question
> Which permission governs reading/listing approval requests, given §15.2 supplies none?
>
> ### SRS Evidence
> SRS §15.2 defines `audit.view`, `report.export`, `governance.view_anomalies`, `security.user.manage`, `security.role.manage`, `settings.branch.manage`, `settings.tenant.manage`, `integration.manage`, `api.key.manage`. **No code covers reading approval requests.**
>
> ### Existing Repository Evidence
> Every implemented phase has invented **zero** permission codes where the SRS supplies them, and Catalogue explicitly marked three `.read` codes **PROVISIONAL** pending Appendix C when the SRS did not supply a read code — a documented precedent for exactly this situation.
>
> ### Conflict / Gap
> **GAP-9.** A read surface (if **D-14** authorises one) has no source-defined permission.
>
> ### Options
> - **(a)** Reuse `governance.view_anomalies` — semantically wrong; anomalies are not approvals.
> - **(b)** Gate reads on the request's own `required_permission`.
> - **(c)** Introduce a **provisional** code, marked as such (Catalogue precedent).
> - **(d)** No read surface this phase.
>
> ### Recommended Direction
> **NO SOURCE-SUPPORTED RECOMMENDATION.** Option (b) is elegant but would prevent a requester from viewing their own pending request; option (c) has precedent but conflicts with the stricter zero-invented-codes line held by Production Spec. The sources do not settle it.
>
> ### Scope Impact
> API authorization, permission catalogue registration, test matrix.
>
> ### Ratification Required
> **YES**
>
> ### Dependencies
> **D-14** (no read surface ⇒ moot), **D-3** (option (b) depends on the permission model).
>
>
>

---

### 13. Recommendation

**Three questions, answered separately.**

**(i) "Is database-layer read authorization settled?"** — **YES, SOURCE-SUPPORTED.**
**`FR-PLT-012`** [M] is satisfied by **D-9's ratified `SELECT` policies** under `ENABLE` +
`FORCE` RLS with a `NOBYPASSRLS` role. **No cross-tenant read is possible.** **R-2 is the
status quo and requires nothing.**

**(ii) "Must an approval-read permission eventually exist?"** — **YES, SOURCE-SUPPORTED, and
this is the strongest evidence in D-20.** **`FR-SEC-010` [M]** ships an **Auditor** role defined
as *"**Read-only everything** including audit log"*, and **`FR-SEC-011` [M]** states custom roles
are built **only** by selecting catalogue permissions. **Without a read code for approval data,
the mandated Auditor role is unexpressible.** This is exactly the reasoning **ADR 0008 D-01**
already ratified, and under which **seven provisional `.read` codes ship**.

**(iii) "Which permission is it, and is it needed in Phase 1?"** —
**NO SOURCE-SUPPORTED RECOMMENDATION.**

- The **name is not source-determined**: §15.2 supplies none, and **Appendix C — which §15.2
  designates authoritative — is absent from the supplied SRS.** No reading of the available text
  yields the code.
- **Phase 1 does not exercise it.** Verified: no Governance HTTP surface (D-14 A-1), no read
  service, no consuming domain, `verifyAuditChain` pure, no scheduled job, and neither
  `audit.view` nor `report.export` implemented. **The question is real but not yet live.**
- **R-5 and R-6 are affirmatively contradicted** by §15.2 and `FR-CST-041` [M] respectively.
  **R-3 has no source basis** and defeats a requester's view of their own request.

**Recorded, not proposed: `FR-AUD-008` [M] is an unsatisfied requirement** — the audit log is
neither searchable, filterable, nor exportable. Closing it **would amend D-14 A-1**, so it is
**identified as a gap and left open**, not folded into D-20.

### Ratification Required

**YES — NOT RATIFIED.**

### The precise question requiring ratification

> **What governs Governance reads in Phase 1?**
>
> 1. **Choose:** **R-1** (no read capability) · **R-2** (rely on ratified D-9 RLS — status quo) ·
>    **R-4** (provisional code per ADR 0008 D-01) · **R-7** (defer to Appendix C) · a combination.
>    **R-3, R-5 and R-6 lack source support** (§6–9).
> 2. **Acknowledge** that `FR-AUD-007` is **not triggered** and `FR-AUD-008` is **unsatisfied**,
>    and that satisfying `FR-AUD-008` **would amend D-14 A-1**.
> 3. **Acknowledge** that **Appendix C is absent**, so no code name is source-determined.
> 4. **Confirm** that no option resolves **D-16**, **D-12**, the **D-3 residual**, **D-2's**
>    deferred branch-scoped RBAC, **parent-linkage**, or **D-19 GAP-11**.

### Preservation

**D-1 … D-19 are preserved exactly; nothing above amends any of them.** **D-19 is RATIFIED and
not reopened; GAP-11 / the ten-field hash-coverage question remains open.** All carried items
stand: **D-16** OPEN · **D-12** BLOCKED · **D-3 residual** · **D-4 clause 5** ·
**`approval_decisions` → parent-linkage** · **`approval_requests` DELETE** · **D-8 cascade
verification** · **D-15's PostgreSQL RLS re-evaluation verification item** · **granted-approval
staleness / consuming-domain behaviour** · **`FR-AUD-008` unsatisfied**.

### Closing statement of the analysis (superseded by the ratification below)

**D-20 OPEN — ANALYSED, NOT RATIFIED.** *(Recorded 2026-08-18; superseded by the ratification
of 2026-08-18 that follows.)*

---

### RATIFICATION — D-20 (2026-08-18)

**RATIFIED — MINIMAL / NO NEW GOVERNANCE READ SURFACE IN PHASE 1.**

> **Clause provenance.** The preceding D-20 analysis contained no pre-numbered clause list. The
> eighteen clauses below are derived **strictly from the substance of the ratification
> instruction**, which draws solely on that analysis. **No new policy, mechanism, permission
> code, endpoint, schema, or implementation requirement is added.**

1. **D-20 settles only the governance position established by the analysis:** **MINIMAL — no new
   Governance read surface in Phase 1.**
2. **D-9's existing database-layer tenant isolation / fail-closed RLS remains the applicable
   read authorization boundary.**
3. **No new Governance HTTP read surface is introduced in Phase 1.**
4. **No new `approval_requests` or `approval_decisions` read endpoint is introduced.**
5. **No new governance-specific read permission code is invented.**
6. **`FR-SEC-010` + `FR-SEC-011` establish that an appropriate read permission must eventually
   exist**, **but the exact permission code is NOT derivable**, because **Appendix C is absent
   from the supplied SRS**.
7. **The eventual permission-code decision is DEFERRED rather than invented.**
8. **`FR-AUD-007` remains CONDITIONAL on audit-log access.**
9. **`FR-AUD-008` remains a knowingly unsatisfied requirement / gap and is NOT closed by D-20.**
10. **`FR-AUD-008` is NOT reinterpreted as authorizing an endpoint.**
11. **D-14 A-1 is NOT reopened.**
12. **No prior ratification is amended** — **D-9**, **D-15**, **D-18**, **D-19**, or any other.
13. **The three-way distinction is preserved:** (i) **database-layer read authorization —
    already settled by D-9**; (ii) **eventual permission-catalogue requirements — source-
    supported but not concretely named**; (iii) **Phase 1 application/API read capability —
    NOT ratified**.
14. **Phase 1 facts are explicitly preserved:** **no Governance HTTP surface**; **no Governance
    read service/controller**; **no consuming domain exercising approval reads**; **no
    implementation of audit search / filter / export**; **no closure of `FR-AUD-008`**.
15. **None of R-1 … R-7 is introduced as an implementation mandate**, beyond the **status-quo
    position already identified as R-2**.
16. **D-16 MUST remain OPEN.**
17. **D-12 remains BLOCKED**, and all carry-forward items are preserved exactly: the **D-3
    residual**, **D-4 clause 5**, **`approval_decisions` → parent linkage**,
    **`approval_requests` DELETE**, **D-8 cascade verification**, **D-15 PostgreSQL RLS
    re-evaluation verification**, **granted-approval staleness / consuming-domain behaviour**,
    **D-19 GAP-11 / the ten-field hash-coverage question**, **`FR-AUD-008`**, and **D-2's
    deferred branch-scoped RBAC**.
18. This is **governance/design ratification only**. **NO implementation is authorized** — no
    code, Prisma, SQL, migration, RLS change, endpoint, service/controller, test, configuration,
    infrastructure, or database change.

**Status:** **RATIFIED — CLOSED.**

---

---

## PL — `approval_decisions` → Parent Linkage (carried item — RATIFIED)

> **STATUS: RATIFIED 2026-08-18 — P-1: `approval_decisions` REFERENCES `approval_requests`
> DIRECTLY.** See the **Ratification** block at the end of this item for the binding text. The
> analysis below is retained as the record of what was considered; **P-2 was considered and NOT
> adopted**, and **P-3 / P-4 were not adopted**.
> **This is NOT a new numbered decision.** It is the carried unresolved item first exposed by
> **D-5 ("Newly Exposed Dependency — NOT RESOLVED HERE")** and preserved by **D-7 cl. 9**,
> **D-9 cl. 9** and every subsequent ratification. **The governance tally is unchanged at
> 17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN.** No ratification block appears here.
> **No ratified decision is reopened, reinterpreted or amended.**

### The question
**What is the authoritative parent of `governance.approval_decisions` in Phase 1?**

---

### 1. Exhaustive SRS Evidence

**1a. The only SRS statement of approval structure — §7.3 Aggregate Catalogue, row 36:**

| # | Aggregate Root | Context | Contained Entities | Key Invariants |
|---|---|---|---|---|
| **36** | **ApprovalRequest** | Governance | **Steps, Decisions** | **Requester ≠ approver** |

This establishes **aggregate ownership**: `ApprovalRequest` is the **root**, and **both** Steps
and Decisions are **contained entities of that one aggregate**. It also places the
requester ≠ approver invariant **at the aggregate level**, consistent with **D-7 M2**'s
traversal needing to reach the root.

> **CONTROL — this row does NOT establish the FK topology.** The "Contained Entities" column
> is a **flat list**, and row 22 proves flatness hides nesting: `Order` lists
> *"OrderLines, **LineModifiers**, Discounts, Payments, ServiceCharges"* — yet a
> **LineModifier must attach to an OrderLine**, not to the Order. **A flat listing of
> "Steps, Decisions" therefore cannot be read as proving Decisions attach directly to the
> Request.** Row 36 is compatible with **both** P-1 and P-2.

**1b. `FR-SEC-033` [M] — the decision's own contents, verbatim:**

> *"Approval decisions SHALL record **approver, timestamp, decision, and any comment**, and
> SHALL be immutable."*

**The single most important negative finding: the SRS's own enumeration of what a decision
records does NOT include any reference to its parent** — no request id, no step id, no link
of any kind.

**1c. Exhaustive term search:**

| Term | Occurrences in the SRS |
|---|---|
| **"approval step" / "approval_steps"** | **ZERO** — the SRS never uses the term |
| **"approval level"** | **exactly 2** — `FR-SEC-034` **[S]** (*"escalates to the next approval level"*) and **§24.5.3** (*"a chain of approval levels"*) |
| **"Steps"** as an approval entity | **once** — §7.3 row 36's cell |

**1d. §15.6 Approval Workflow Engine — the general mechanism — mentions steps nowhere.**
`FR-SEC-030` … `FR-SEC-035` name no step, level-entity, parent column, or identifier.
`FR-SEC-031` enumerates the **request's** fields and references neither steps nor decisions.

**1e. §24.5.3 Chain of Responsibility** — *"a request passes along a chain of approval levels
until one accepts it or the chain is exhausted."* Architecture chapter, **not a numbered
requirement**, and its subject is **traversal semantics, not persistence**.

**CONCLUSION ON SOURCE EVIDENCE: the SRS establishes aggregate ownership (Decisions belong to
the ApprovalRequest aggregate) and NOTHING about the physical parent reference. It names no
column, no identifier, and no foreign key for a decision's parent.**

---

### 2. Constraints From Ratified Decisions (not reopened)

| Decision | Bearing on parent linkage |
|---|---|
| **D-5** | cl. 1 — Phase 1 is the *"CORE approval **request/decision** model only"* (**step is not named**); cl. 2 — multi-level chains **NOT implemented**; cl. 3 — chain **deferred** to a future phase; cl. 8 — `approval_steps.approver_role_id` **not deleted, modified or redesigned**, future status a design question. **D-5's own "Newly Exposed Dependency" states that cl. 8 "does not state whether the `approval_steps` table is created in Phase 1"** and records readings (i)/(ii)/(iii) — the ancestors of P-1/P-2/P-3 below |
| **D-6** | Governs `approval_requests` mutability only. **Neutral** on linkage |
| **D-7 M2** | Requires a `NOT EXISTS` traversal from the decision to **the request's `requested_by`**. **The traversal target is the REQUEST** — but the *path* is unratified. cl. 9 explicitly preserves linkage as unresolved and forbids inventing it to ratify M2 |
| **D-8** | Append-only grants on `approval_decisions`; cl. 6 cascade verification outstanding. **Path-agnostic**, but the number of `ON DELETE CASCADE` hops differs by model |
| **D-9** | **N1 — `approval_decisions` has its own `tenant_id` and uses a tenant-safe composite FK.** **The composite form is already ratified; only its TARGET is open.** cl. 5 — `approval_steps` **remains UNRESOLVED and is NOT in D-9 scope**. cl. 9 — linkage **remains open** |
| **D-10 E2** | Expiry conjunct must read the **request's `expires_at`** at decision INSERT. Again the target is the request; the path is open |
| **D-14 A-1** | No HTTP surface — linkage has **no API consequence** |
| **D-15** | No unique constraint, no locking. **A duplicate-decision constraint is NOT available** as a reason to prefer any model |
| **D-16** | **MUST REMAIN OPEN** — see §5 |
| **D-3 residual** | `approval_steps.approver_role_id` (role vs permission) — **engaged only by P-2/P-3** |

---

### 3. Candidate Models

Conceptual notation only. **No SQL, Prisma, migration or policy is written anywhere below.**

```
P-1   decision ──(tenant_id, approval_request_id)──▶ request
P-2   decision ──(tenant_id, approval_step_id)──▶ step ──(tenant_id, approval_request_id)──▶ request
P-3   decision ──(tenant_id, approval_request_id)──▶ request
      decision ┄┄(tenant_id, approval_step_id)┄┄▶ step        (nullable, dual parent)
P-4   no further source-defined relationship exists
```

| Facet | **P-1** direct | **P-2** via step | **P-3** dual | **P-4** other |
|---|---|---|---|---|
| **SRS basis** | §7.3 r36 aggregate ownership — **compatible, not probative** (row-22 control) | §7.3 r36 lists **Steps** as a contained entity — **compatible, not probative** | Neither is excluded | **NONE** |
| **Governance basis** | D-5 cl. 1 names the Phase 1 model **"request/decision"**; D-5 reading **(i)** | D-5 reading **(ii)**; preserves the approved SQL graph and cl. 8 | D-5 reading **(iii)** territory | — |
| **Approved-design basis** | **NONE** — a deviation, additional to D-1's | **The approved SQL, verbatim** | Superset of the approved SQL | Competing structures only |
| **Repository precedent** | `inventory.waste_records.**approval_request_id**` and `audit_entries.approval_id` name the **request** as the identified unit (both **columns without FKs**) | none — no step table has ever existed here | none | — |
| **Schema consequence** | 2 tables | **3 tables** — requires creating `approval_steps`, which **D-9 cl. 5 left unresolved** | 3 tables + a nullable link | — |
| **RLS consequence** | 2 policy sets | **3 policy sets** — a step policy set must be designed, and **D-9 cl. 5 excluded steps from D-9's ratified scope** | 3 sets + null-handling in every predicate | — |
| **Effect on D-7 traversal** | **One hop.** Precedent shape: the shipped `recipe_lines_insert` `EXISTS` subquery | **Two hops** — a nested traversal with no precedent in this repository | One hop, plus a null branch | — |
| **Effect on D-8** | Single `ON DELETE` path to verify (cl. 6) | **Two cascade hops** to verify; a step delete could remove decisions | Two paths, one nullable | — |
| **Effect on D-9 N1** | Composite target = `request(tenant_id, id)` | Composite target = `step(tenant_id, id)`; **step needs its own `tenant_id`, which D-9 never ratified** (cl. 5) | Two composite FKs | — |
| **Effect on D-10** | Expiry conjunct reads the request **directly** | Expiry conjunct must **traverse the step** to reach `expires_at` | Direct | — |
| **Amends a ratified decision?** | **NO.** A documented deviation from the approved SQL — the **same species** as D-1's ratified three-column deviation | **NO** — but requires a **new decision** to create `approval_steps` and to bring it into RLS scope, which **D-9 cl. 5 deliberately left outside** | **NO** — requires both of the above | — |
| **Requires resolving D-16?** | **NO** (§5) | **NO** (§5) | **NO** (§5) | — |
| **Engages the D-3 residual?** | **No** | **YES** — `approver_role_id` role-vs-permission | **YES** | — |
| **Invents unsupported structure?** | Invents a **column** the approved SQL lacks | Creates a **table** whose only stated purpose — multi-level chains — **D-5 cl. 2 says is not implemented** | Invents both | — |

**P-4 — searched and not found.** No further source-defined relationship exists. Two competing
representations do exist, and **both are Procurement's and both are explicitly unresolved**:
`procurement.po_approval_chain` with `approver_id → identity.users` (approved SQL — **Conflict
C-7, left unresolved by D-5 cl. 7**), and §7.3 row 19's `PurchaseOrder` containing an
`ApprovalChain` entity. **Neither is a Governance decision parent, and neither may be used to
settle this question.**

---

### 4. What D-5's "Single-Step" Actually Means for `approval_steps`

Four readings were put; the evidence supports **one, and only in part**:

| Reading | Verdict |
|---|---|
| "There is exactly **one step per request**" | **NOT ESTABLISHED.** No ratified clause and no SRS text states this cardinality. D-5 cl. 2 says multi-level **chains are not implemented** — a statement about **chains**, not about step-row cardinality |
| "`approval_steps` is still a **valid structural entity**" | **SUPPORTED, WEAKLY.** §7.3 row 36 names **Steps** as a contained entity — its **only** appearance in the SRS. D-5 cl. 8 preserves `approver_role_id`; cl. 3 defers the chain rather than abolishing it |
| "`approval_steps` is **explicitly excluded**" | **NO — this overstates the record.** D-9 cl. 5 says it *"remains **UNRESOLVED** and is **NOT included in D-9 scope**"*. Out of scope ≠ excluded, and **D-5's own text states cl. 8 "does not state whether the `approval_steps` table is created in Phase 1"** |
| "**The evidence does not establish this**" | **CORRECT for the table's Phase 1 existence.** It is neither mandated nor forbidden — it is **undecided**, by the register's own words |

**Therefore "single-step" means: multi-level chains are not implemented. It does NOT decide
whether the `approval_steps` table exists in Phase 1, and it does NOT establish one-step-per-
request.** No interpretation is adopted here because it eases implementation.

---

### 5. Can Parent Linkage Be Settled **Independently of D-16**?

**YES — established, not assumed.**

- **D-16 governs `approval_requests.request_type`** — its canonical enumeration (cl. 1–5) and its
  **storage representation** (cl. 6).
- **Parent linkage governs a column on `approval_decisions`** — which parent it references and
  the FK target.
- **The two touch no common column.** Linkage does **not** determine `request_type`,
  `required_permission` or `value` — all three sit on **`approval_requests`**, on the far side of
  the relationship. Conversely, no `request_type` representation implies a decision's parent.
- **No candidate model requires reading, constraining or enumerating `request_type`.** D-7's
  traversal targets `requested_by`; D-10's targets `expires_at`. **Neither touches
  `request_type`.**

**Consequence for sequencing:** the readiness audit listed linkage and D-16 as separate critical
blockers. **They are independent**, so **linkage can be ratified now without D-16 being touched**
— and **must not be used to settle it**.

*Recorded, not resolved:* **P-2 and P-3 engage the D-3 residual** (`approver_role_id`), which is
a different carried item and also **remains open**.

---

### 6. Evidence Classification

| Class | Content |
|---|---|
| **SOURCE EVIDENCE** (SRS) | §7.3 row 36 (aggregate ownership; **not** FK topology, per the row-22 control) · `FR-SEC-033`'s omission of any parent reference · zero occurrences of "approval step" · `FR-SEC-034` [S] and §24.5.3 as the only "approval level" mentions |
| **APPROVED-DESIGN ARTIFACT** (`ROS_DrawDB_Compatible_v3.sql`, git-tracked) | `approval_decisions.approval_step_id → approval_steps(id) ON DELETE CASCADE`; `approval_steps.approval_request_id → approval_requests(id)`; **no direct decision→request column exists** (verified: 0 occurrences). Its own comment reads *"enforced by app: `approver_id <> requests.requested_by`"* — **the invariant's target is the request**. **This is a design artifact, NOT the SRS**, and D-1 already established that it may be deviated from with documentation |
| **REPOSITORY PRECEDENT** (shipped code) | Composite tenant-safe FK, child `(tenant_id, x_id)` → parent `(tenant_id, id)` with a `*_tenant_id_id_key` UNIQUE index — **11× in the Production migration** · the `EXISTS` cross-table traversal in `recipe_lines_insert` — **a one-hop shape only** · **ADR 0007** append-only grants, shipped on `audit_entries` · `inventory.waste_records.approval_request_id` and `audit_entries.approval_id` — **columns without FKs**, naming the request · **no approval table has ever been migrated** |
| **ARCHITECTURAL INFERENCE** (must not be mistaken for evidence) | That contained entities of one aggregate attach directly to the root · that "single-step" implies one step row · that the absence of a step table implies a direct link · that a shipped column name settles a relationship |

---

### 7. The Minimum Decision Required

**PARENT LINKAGE IS NOT SOURCE-DECIDABLE.** The SRS names no parent column, no identifier and
no foreign key for an approval decision, and `FR-SEC-033` — its own enumeration of a decision's
contents — omits any parent reference. §7.3 row 36 settles **ownership**, and the row-22 control
shows it **cannot** settle topology.

**This must therefore be settled as an ARCHITECTURAL RATIFICATION**, in exactly the manner
already used for **D-4**'s lifecycle and **D-8**'s no-DELETE portion — both ratified as explicit
architectural choices where the SRS was silent.

**NO SOURCE-SUPPORTED RECOMMENDATION** between P-1 and P-2.

Two asymmetries are recorded **neutrally**, as facts bearing on cost rather than on correctness:

- **P-2 requires a decision the register twice declined to make.** `approval_steps` is outside
  **D-9 cl. 5**'s ratified RLS scope and lacks a ratified `tenant_id`, so P-2 needs **both** a
  table-creation decision **and** an extension of D-9's scope — and it engages the open
  **D-3 residual**.
- **P-1 requires a deviation of a species already ratified.** D-1 added three columns absent from
  the approved SQL as a documented deviation; P-1 would add one more. It also matches the shape
  of every traversal precedent in this repository, all of which are **one hop**.

**Neither asymmetry is a source argument, and neither is offered as a recommendation.**

### The smallest governance question that must be answered next

> **Does `governance.approval_decisions` reference `approval_requests` directly (P-1), or does
> Phase 1 create `governance.approval_steps` and reference it (P-2)?**
>
> Answering **only** this unblocks `approval_decisions`, **D-7 M2**, **D-8**, **D-9 N1** and
> **D-10**. It requires **no** other decision, and **must not** settle **D-16**, the **D-3
> residual**, **D-4 cl. 5**, **`approval_requests` DELETE**, or any other carried item.
>
> Should **P-2** be chosen, two further questions arise and would need answering in the same
> turn: whether `approval_steps` carries its own `tenant_id`, and whether it enters D-9's RLS
> scope. **Neither is resolved here.**

### Preservation

**D-1 … D-20 are preserved exactly; nothing above amends any of them.** All carried items stand:
**D-16** OPEN · **D-12** BLOCKED · **D-3 residual** · **D-4 cl. 5** · **`approval_requests`
DELETE** · **D-8 cl. 6 cascade verification** · **D-15 PostgreSQL RLS re-evaluation
verification** · **granted-approval staleness / consuming-domain behaviour** · **D-19 GAP-11 /
ten-field hash coverage** · **`FR-AUD-008`** · **D-2 deferred branch-scoped RBAC**.

### Closing statement of the analysis (superseded by the ratification below)

**PARENT LINKAGE — OPEN, ANALYSED, NOT RATIFIED.** *(Recorded 2026-08-18; superseded by the
ratification of 2026-08-18 that follows.)*

---

### RATIFICATION — PARENT LINKAGE (2026-08-18)

**RATIFIED — P-1: `approval_decisions` SHALL REFERENCE `approval_requests` DIRECTLY.**

> Recorded as the **carried-item parent-linkage ratification**, **NOT** as a new numbered
> decision. **The 20-decision tally is unaltered.**

1. **`approval_decisions`'s parent SHALL reference `approval_requests` directly.**
2. **`approval_steps` is NOT required by this ratification** and **SHALL NOT be introduced
   solely because of this decision**.
3. This ratification **does NOT decide** `approval_steps`' **existence**, **`tenant_id`**,
   **RLS scope**, **cardinality**, or **topology**.
4. **D-16 remains OPEN and untouched.**
5. **D-12 remains BLOCKED and untouched.**
6. **No other ratified decision is amended.**
7. **D-7's requester ≠ approver traversal may therefore target `approval_requests`
   directly.**
8. **D-10's expiry traversal may therefore target `approval_requests` directly.**
9. **D-8's append-only grants and D-9's N1 may use the direct parent relationship**, subject
   to their already-ratified clauses and the remaining unresolved items.
10. **Do NOT invent** `request_type` representation, `required_permission` representation,
    `value` type, **DELETE behaviour**, or any other unresolved schema decision.
11. **Do NOT infer** that this ratification resolves the **D-3 residuals**, **D-4 clause 5**,
    the **D-8 cascade verification**, **D-15's RLS re-evaluation verification**,
    **granted-approval staleness**, or any other carried-forward item.
12. **Do NOT create or modify `approval_steps`** merely as a consequence of this decision.
13. This is a **governance decision only**. **No implementation is authorized by this
    ratification turn.**
14. **The SRS evidence limitation is preserved:** the SRS establishes **`ApprovalRequest` as
    the aggregate root containing Steps and Decisions**, but **does NOT prescribe the
    persistence topology**.
15. **P-1 is an ARCHITECTURAL CHOICE**, **not** a claim that the SRS mandates direct linkage.
16. **P-2 was considered and NOT adopted.** The analysis recording it is retained above.
17. **D-5, D-7, D-8, D-9 and D-10 are NOT reopened.** Their already-ratified semantics are to
    be implemented later using the now-ratified direct parent relationship.
18. Register verification was performed after writing: status marker, carried-item section,
    tally, prior ratifications, D-16, D-12, and absence of implementation changes.

**Status:** **RATIFIED — CLOSED.**

---
---

## SB — Remaining `approval_requests` Schema Blockers (carried items)

> **STATUS: GOVERNANCE-RESOLUTION PASS COMPLETED 2026-08-19 — ANALYSIS ONLY.**
>
> | Item | Outcome |
> |---|---|
> | **SB-1** `required_permission` | **PARTIALLY RESOLVED** — representation settled by the sources (§15.2 **code**); **FK posture UNRESOLVED** |
> | **SB-2** `value` | **PARTIALLY RESOLVED** — a source-supported **exclusion** is settled; **persistence representation UNRESOLVED** |
> | **SB-3** DELETE posture | **UNRESOLVED** — the sources supply no answer |
>
> **NO RATIFICATION. NO IMPLEMENTATION. NO EXECUTION** — **V1 and V2 were NOT run**, and no
> DML, DDL, transaction, `EXPLAIN`, probe or database command was issued in this pass.
> **These are NOT new numbered decisions.** They are the three carried modelling questions the
> Phase 1 implementation-readiness audit isolated, plus the two empirical items. **The
> 20-decision tally is unchanged.** No ratification block appears here.
> **D-16 remains OPEN and untouched** — nothing below reads, constrains or represents
> `request_type`. **D-12 remains BLOCKED. Parent linkage P-1 is RATIFIED and not reopened.**

---

### SB-1 — `required_permission` representation

**A. Source evidence.** The SRS mentions a required approver permission **exactly twice**:

- **`FR-SEC-031` [M]** — *"Approval requests SHALL specify: … **the required approver
  permission** …"* — names the field, **not its representation**.
- **§26.2** — the only concrete rendering anywhere:
  `"meta": { "requiredPermission": "pos.discount.approve" }` — **a permission CODE string**.

Two structural facts reinforce the code: **§15.2's catalogue is expressed entirely as codes**,
and **`FR-SEC-011` [M]** builds roles by *"selecting permissions from the catalogue"*.
**The SRS has no concept of a permission surrogate id at all** — every one of the ~30 permission
tokens in the document is a code. An id is a persistence artifact the SRS never contemplates.

*Weight caveat, recorded not resolved:* §26.2 is an **HTTP error payload**, detached from
Governance by **D-14 A-1** and **D-18 E-1**. It is evidence of **how the SRS identifies a
permission**, not a mandate on **how Governance stores one**.

**B. Already settled.** **D-3** — authority is permission-based, not role-based. **D-1** — the
column exists, and *"No new permission code is created: the field references an existing SRS
§15.2 code as data."*

> **Tension inside D-1, reported not resolved.** That ratified sentence reads toward
> code-as-data, while D-1's immediately following carried-forward paragraph states that
> *"whether `required_permission` stores the permission `code` … or the permission `id`, and
> whether it carries a foreign key, is a Design Gate question."* The narrowest reconciliation —
> and the one adopted here for analysis only — is that **"code as data" governs the prohibition
> on inventing new codes, not the column's physical type**. **D-1 is not reinterpreted.**

**C. Genuinely undecided.** (i) code string vs surrogate id; (ii) **whether a foreign key is
carried**. The SRS settles neither, and (ii) is **entirely a persistence question the SRS never
addresses**.

**D. Smallest options.**

| | Option | Note |
|---|---|---|
| **RP-1** | Store the **code**, **no FK** | Matches every SRS rendering; imposes no seeding order |
| **RP-2** | Store the **code**, **FK → `identity.permissions(code)`** | Physically possible — `permissions_code_key` is UNIQUE. Constrains values to seeded codes |
| **RP-3** | Store the **id**, FK → `identity.permissions(id)` | No SRS basis; the SRS never identifies a permission by id |
| **RP-4** | Defer | Leaves the column unbuildable |

**E. Source-supported recommendation — YES, PARTIAL.** The sources support **storing the code
rather than an id** (RP-1 or RP-2): the SRS identifies permissions only by code, and §26.2
renders this very field as a code. **This is a genuine source lean, not a convenience argument.**
**Whether an FK is carried (RP-1 vs RP-2) is NOT source-decidable** and remains an architectural
choice.

*Repository evidence, corroborating only:* `PermissionsService` **upserts by stable code**
(`where: { code: def.code }`), looks up via `findByCodes`, and `RolesService` rejects
*"Unknown permission code."* Code is the operative identifier throughout. **Evidence, not
authority.**

**F. Dependencies.** **None on D-16.** Engages no other unresolved item. *(The D-3 residual
concerns per-step authority, not this column.)*

**G. Ready for ratification: YES** — as one question with two parts (representation: source
leans code; FK: architectural).

**RESOLUTION (2026-08-19) — PARTIALLY RESOLVED.**

- **SETTLED, source-supported:** `required_permission` **is represented by an existing SRS
  §15.2 permission CODE**, not by an invented surrogate permission identifier.
  **Basis:** **§26.2** renders this exact field as a code
  (`"requiredPermission": "pos.discount.approve"`); **§15.2** expresses the entire catalogue as
  codes; **`FR-SEC-011` [M]** builds roles by selecting catalogue permissions; **the SRS never
  identifies a permission by a surrogate id anywhere.** Consistent with **D-3** (authority is
  permission-based) and **D-1** (*"No new permission code is created"*).
  **No permission code is created by this conclusion.**
- **EXPLICITLY DISTINGUISHED — and NOT decided:** whether the column carries a **foreign key**
  (`RP-1` no FK vs `RP-2` FK → `identity.permissions(code)`). **The SRS does not address
  persistence keys at all.** **UNRESOLVED.**
- **NOT INFERRED:** D-1's *"code as data"* is **not** read as deciding the **database column
  type**. Per the tension recorded above, that phrase governs the prohibition on inventing new
  codes. **D-1 is not reinterpreted, amended or superseded.**
- **Corroboration only, never authority:** `PermissionsService` upserts and resolves **by stable
  code**; `RolesService` rejects *"Unknown permission code."* **Repository evidence cannot
  override or supply an SRS conclusion.**

---

### SB-2 — `value` type

**A. Source evidence.** **`FR-SEC-031` [M]** names *"the value"* and defines nothing further.
**§7.2** defines `Money` as a **pair** — `amount: bigint // minor units` **plus** `currency` —
and `Quantity` as `Decimal` at **6 dp** (`BR-CORE-003`) plus a unit.

**The decisive evidence is that the approval-triggering value is NOT uniformly monetary:**

- **`FR-POS-047` [M]** enumerates four threshold dimensions for **one** consumer (discounts):
  **maximum percentage**, **maximum absolute amount**, **maximum discounts per shift per
  employee** (a **count**), and **discount permitted after payment started** (a **boolean**).
- **§26.2's worked example** — the SRS's only concrete approval-triggering value — is a
  **percentage**: *"A discount of **25%** exceeds the **15%** limit"*, with
  `errors[].limit: 15` and `field: "discount.percentage"`.
- **`FR-INV-046` [M]** — threshold *"**by percentage or value**"*.
- **`FR-HRM-034` [M]** — overtime beyond a threshold: **hours**.
- Monetary cases also exist: `FR-PRC-018`, `FR-INV-035`, `FR-INV-058`, `FR-FIN-006`,
  `FR-FIN-017`.

**B. Already settled.** **D-13** — Governance owns no thresholds; the **consuming domain**
determines whether approval is required and **supplies the value**. Governance is a generic
carrier.

**C. Genuinely undecided.** The representation. **No source mandates any type.**

> **A source-supported EXCLUSION does exist.** A **money-only representation (BIGINT minor
> units) is positively contradicted** — it cannot carry a percentage, a count, or a boolean
> dimension, and would fail the majority of the dimensions `FR-POS-047` [M] enumerates. **The
> repository's BIGINT money convention is therefore NOT transferable here.** This is a
> source-grounded exclusion, not a preference.

**D. Smallest options.**

| | Option | Carries |
|---|---|---|
| **VT-1** | `DECIMAL(18,6)` single column | Money-as-decimal, percentage, count. **Loses currency and the dimension label** |
| **VT-2** | `DECIMAL(18,6)` **+ a dimension/unit descriptor** | Adds what the number means. **A descriptor vocabulary is itself undefined by the SRS** |
| **VT-3** | `JSONB` structured value | Carries anything; constrains nothing; no SRS basis |
| **VT-4** | Money pair (`BIGINT` + currency) | **Contradicted** — see the exclusion above |
| **VT-5** | Nullable, meaning deferred to the consumer | Consistent with **D-13**; leaves `FR-SEC-031`'s *"SHALL specify the value"* only partly served |

*Repository evidence, corroborating only:* non-money decimals are `DECIMAL(18,6)` (quantity,
variance, reorder point) and percentages `DECIMAL(5,2)`. **Evidence, not authority.**

**E. Source-supported recommendation — NO, for the type. YES, for the exclusion.**
**NO SOURCE-SUPPORTED RECOMMENDATION** among VT-1/2/3/5. **VT-4 is excluded by the sources.**

*Also recorded:* `FR-POS-047`'s **boolean** dimension means some approvals have **no numeric
value at all** — bearing on whether the column is `NOT NULL`. **Not resolved here.**

**F. Dependencies.** **None on D-16** — `value` and `request_type` are distinct columns, and no
option reads or constrains `request_type`. A **descriptor vocabulary under VT-2 must not become
a proxy for D-16's enumeration.**

**G. Ready for ratification: YES** — as an architectural choice, with the VT-4 exclusion and
the nullability sub-question recorded.

**RESOLUTION (2026-08-19) — PARTIALLY RESOLVED.**

- **SETTLED, source-supported — an EXCLUSION:** **`BIGINT` minor units is NOT an appropriate
  representation** for `approval_requests.value`.
  **Basis:** approval-triggering values span **percentage**, **absolute amount**, **count**, and
  a **boolean** condition within **`FR-POS-047` [M]** alone; **§26.2's** worked example is a
  **percentage** (`field: "discount.percentage"`, `limit: 15`); **`FR-INV-046` [M]** is
  *"by percentage **or** value"*; **`FR-HRM-034` [M]** is **hours**. A money-only column cannot
  carry these. **The repository's `BIGINT` money convention is therefore NOT transferable, and
  is not treated as authority.**
- **NOT CLAIMED:** the SRS does **NOT** mandate `DECIMAL(18,6)`, `JSONB`, a dimension enum, or
  any other specific persistence type. **No such claim is made here.**
- **DISTINCTION PRESERVED:** **numeric approval values** and **boolean approval conditions** are
  different things. `FR-POS-047`'s *"discount permitted after payment started"* is a **boolean
  condition with no numeric value**, which bears on nullability. **UNRESOLVED.**
- **NO HIDDEN D-16 DEPENDENCY:** any future dimension vocabulary **must not** become a proxy for
  `request_type`. **D-16 remains OPEN and untouched**; nothing in this conclusion reads,
  constrains, enumerates or represents `request_type`.
- **The exact persistence representation remains UNRESOLVED.**

---

### SB-3 — `approval_requests` DELETE posture

**A. Source evidence.**

- **ADR-010** — *"**Orders, payments, stock movements, and audit entries** are never updated or
  deleted."* **Approval requests are NOT in the enumeration** — the same finding on which
  **D-8** based its no-DELETE portion as an **explicit architectural ratification**.
- **§24.6.5 Soft Delete** — *"**Master data** (items, employees, suppliers) is deactivated rather
  than deleted… Hard deletion is available only for records with no references and only via an
  explicitly audited administrative operation."* Its stated subject is **master data**; an
  approval request is **transactional**. Whether its second sentence is a universal rule or a
  master-data rule is **ambiguous and not resolved here**.
- **No requirement anywhere addresses deleting or retaining approval requests.**
- **`FR-AUD-009` [M]** retains **audit entries** ≥ 7 years — so an approval's audit trail
  survives independently of the request row. Recorded as a factor, not an argument.

**B. Already settled.** **D-9 cl. 4** — *"DELETE: **LEFT UNRESOLVED**. Neither X1 nor X2 is
ratified."* **D-8** — `approval_decisions` have **no DELETE capability**. **D-4** — settles the
lifecycle only; it says nothing about row removal. **No source supports inferring the request's
DELETE posture from D-8's append-only decisions**, and it is not inferred here.

**C. Genuinely undecided — and P-1 has now COUPLED two sub-questions.**

> **New consequence of the P-1 ratification.** Decisions now reference **`approval_requests`
> directly**. The `ON DELETE` action on that FK therefore determines whether deleting a request
> can **destroy append-only decision rows**, which is exactly the **D-8 clause 6 cascade
> verification** item. **The DELETE posture and D-8's cascade question are now one coupled
> problem** where previously a step table sat between them.

Two sub-questions:
1. **May `ros_app` delete an `approval_requests` row at all?**
2. **If yes, what `ON DELETE` action does the decisions FK carry, and does any cascade defeat
   D-8?**

**D. Smallest options.**

| | Option | Effect on the D-8 cascade item |
|---|---|---|
| **DP-1** | **No DELETE capability** (grant nothing; no DELETE policy) | **Dissolves it** — no delete path exists, so no cascade can fire |
| **DP-2** | DELETE permitted, decisions FK `ON DELETE RESTRICT` | Preserves D-8; a decided request becomes undeletable |
| **DP-3** | DELETE permitted, decisions FK `ON DELETE CASCADE` (the approved SQL's action) | **Would delete append-only decisions** — must be verified against D-8 before it could be considered |
| **DP-4** | Continue to defer | Leaves the migration unwritable |

**E. Source-supported recommendation — NO.** ADR-010's exclusion means no-DELETE is **not**
source-mandated, and §24.6.5 is ambiguous in scope. This is an **architectural ratification**,
of exactly the species D-8's no-DELETE portion already was. **NO SOURCE-SUPPORTED
RECOMMENDATION.**

*Neutral fact, not a recommendation:* **DP-1 is the only option that requires no empirical
verification**, because it removes the delete path that V2 exists to test.

**F. Dependencies.** **None on D-16.** **Coupled to D-8 cl. 6** as described. Does **not**
resolve D-4 cl. 5.

**G. Ready for ratification: YES for sub-question 1.** Sub-question 2 is **only reachable if
DELETE is permitted**, and under DP-2/DP-3 would require **V2** first.

**RESOLUTION (2026-08-19) — UNRESOLVED.**

- **NO SOURCE-SUPPORTED ANSWER EXISTS** to whether `approval_requests` may be deleted.
  **Basis:** **ADR-010's** never-deleted enumeration — *orders, payments, stock movements, audit
  entries* — **excludes approval requests**; **§24.6.5's** stated subject is **master data**,
  and an approval request is transactional, so its scope is **ambiguous**; **no requirement
  anywhere addresses deleting or retaining approval requests**; and **D-9 clause 4** records
  *"neither X1 nor X2 is ratified."* **D-4 settles the lifecycle only.**
- **NOT INFERRED FROM D-8.** The request's DELETE posture is **not** derived from
  `approval_decisions` being append-only. No source supports that inference.
- **P-1 COUPLING PRESERVED.** Because **P-1 is ratified** and `approval_decisions` references
  `approval_requests` **directly**, the FK's **`ON DELETE` action is consequential to
  D-8 clause 6**: a cascading parent delete could remove append-only decision rows.
- **NO OPTION SELECTED.** **DP-1, DP-2, DP-3 and DP-4 are all left unselected**, and none is
  chosen for convenience. **`ON DELETE CASCADE` (DP-3) is specifically NOT adopted**, because it
  would permit deletion of append-only `approval_decisions` **through the parent**.
- **EVIDENCE GATE RECORDED:** if DELETE is eventually permitted, the FK / delete behaviour
  **requires the previously identified V2 evidence before implementation**. **V2 was NOT run in
  this pass.**

---

### SB-4 — Empirical items V1 and V2: safety assessment

**Neither was run.** Assessment only, as instructed.

**V1 — D-15 / U4 RLS re-evaluation under concurrency.**
**A materially safer design than the readiness audit proposed is available: V1 needs NO DDL.**
`production.recipe_lines` already ships an **UPDATE policy whose `USING` clause carries a
status-predicated `EXISTS`** — the same shape as D-9 U4. The question can be posed with **DML
only, inside transactions that are rolled back**: one session flips a version's status while
another attempts a line update, and the second session's affected-row count answers it.
**Verdict: safe in principle — read-only in effect, zero schema residue.**

**V2 — D-8 cl. 6 cascade versus revoked DELETE.**
No shipped pair combines *revoked child DELETE* with *a cascading parent*, so V2 **requires
creating surrogate objects**, i.e. **DDL**. PostgreSQL DDL is transactional and a `ROLLBACK`
leaves no residue, but the statements still execute against the live database.
**Verdict: safe in principle, but it is a database operation.**

> **Neither is run in this turn.** The standing constraint prohibits database changes, and
> executing DDL — even fully rolled back — is not obviously inside "read-only". **Both require
> explicit authorization.** Consistent with the instruction, **no ratification is altered by any
> experiment**, and V1/V2 results would be **evidence for a Design Gate, never a governance
> amendment**.

---

### Preservation

**D-1 … D-20 and the ratified P-1 parent linkage are preserved exactly; nothing above amends
any of them.** All carried items stand: **D-16** OPEN · **D-12** BLOCKED · **D-3 residual** ·
**D-4 cl. 5** · **D-8 cl. 6 cascade verification** · **D-15 RLS re-evaluation verification** ·
**granted-approval staleness / consuming-domain behaviour** · **D-19 GAP-11** · **`FR-AUD-008`**
· **D-2 deferred branch-scoped RBAC**.

### Outcome of the 2026-08-19 governance-resolution pass

| Item | Status | Settled | Still unresolved |
|---|---|---|---|
| **SB-1** | **PARTIALLY RESOLVED** | Representation = existing **§15.2 permission code** | **FK vs no FK** |
| **SB-2** | **PARTIALLY RESOLVED** | **Exclusion**: not `BIGINT` minor units | **Persistence type**; **nullability** for boolean conditions |
| **SB-3** | **UNRESOLVED** | Nothing — no source-supported answer | **Whether DELETE is permitted**; the FK `ON DELETE` action, gated on **V2** |

**ANALYSIS ONLY — NO RATIFICATION, NO IMPLEMENTATION, NO EXECUTION. V1 / V2 — NOT RUN.**
**No numbered decision was created; the governance tally is unchanged.**

---
---

## P0 — Catalogue Pricing Design Closures (carried items)

> **STATUS: RATIFIED 2026-08-19 by explicit user governance action.**
> **These are NOT new numbered decisions — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).** They close
> the five P0 pricing questions the preceding analysis classified, following the
> same carried-item convention as **PL** (parent linkage) and **SB**.
>
> **Design ratification only. NO IMPLEMENTATION IS AUTHORIZED BY THIS RECORD.**

### P0-1 — Validity-window boundary semantics

**RATIFIED: half-open `[from, to)`.**

- `valid_from` **inclusive**, `valid_to` **exclusive**. Two windows that merely
  touch — one ending at the instant the next begins — do **NOT** overlap.
- `NULL` endpoints mean unbounded, matching `tstzrange(valid_from, valid_to)`.
- **Basis:** an explicit architectural choice. The SRS names `DateRange` among
  §7.2 shared-kernel value objects but **never states inclusivity**; this closes
  a NOT SOURCE-DECIDABLE question and is **not** claimed as an SRS requirement.
- **Already executable:** the migration's `tstzrange`, `windowsOverlap` in
  `price-list-overlap.ts`, and `isEligible` in `price-resolution.ts` all
  implement it. Those code comments currently label it "implementation
  convention"; they should be updated to cite **P0-1** at implementation time.

### P0-2 — Recurrence: weekly-local-time v1

**RATIFIED: option R-1, weekly local-time windows, exactly as recommended.**

- Shape: weekday set + local `from` / `to` times, e.g.
  `{ days: [...], from: "15:00", to: "18:00" }`.
- Evaluated in the **branch timezone** (`org.branches.timezone`), per
  `FR-MNU-022`.
- **Overnight windows** (`to <= from`) wrap past midnight — the identical
  convention already ratified in **ADR 0008 D-04** for `org.operating_hours`, so
  no new semantic is invented.
- DST is handled by evaluating wall-clock time in the branch zone.
- Fits the existing `recurrence_rule Json?` column — **no schema migration**.
- Deterministic and reproducible in Dart without a shared library, preserving the
  **BR-FIN-005 / FR-OFF-050** obligation.
- **Basis:** architectural choice closing a NOT SOURCE-DECIDABLE question. The
  SRS supplies only `FR-MNU-022`'s worked example; the approved SQL's
  `-- (RRULE-like)` is a **comment, not a specification**, and RFC 5545 is **not**
  adopted.
- **Exact field names, validation rules and the empty-day-set case are settled at
  implementation**, within this shape.

**CLARIFICATION A (2026-08-20), by explicit user governance action.** The empty
weekday set is now settled rather than left to implementation: **`days: []` is
INVALID INPUT and the recurrence parser SHALL reject it.** A rule that can never
match would silently disable a price list and is indistinguishable from a
misconfiguration, so it is refused at write time. This clarifies the already-
ratified P0-2 design; **it is not a new decision, creates no D-21, and does not
change the tally.**

### P0-3 — Recurrence vs the overlap invariant

**RATIFIED: the overlap invariant is evaluated against the OUTER validity window
only. Recurrence does not alter the overlap key.**

- `ex_price_list_no_overlap` keys on
  `tenant_id, scope_type, COALESCE(scope_id, nil), priority, tstzrange(valid_from, valid_to)`.
  **`recurrence_rule` is not in the key and is not consulted** — which is what the
  constraint already does, so **no migration change is required**.
- **Consequence, accepted knowingly:** two lists sharing scope and priority whose
  outer date ranges overlap are rejected **even if their recurrence patterns never
  intersect**. A happy-hour list must therefore differ from the standing list in
  **priority** (or in outer window). This is the cost of keeping "window" defined
  as the outer validity range.
- This resolves the stability question that previously blocked committing the
  migration.

### P0-4 — Priority direction

**RATIFIED: preserve the repository's existing direction — higher integer =
higher priority.**

- **Verified consistent** before ratifying: `PriceListsService.list` orders
  `priority: 'desc'`; `MenusService.resolveForBranch` sorts
  `b.priority - a.priority`; the price resolver ranks higher-wins. The SRS never
  states a direction.
- The fallback rule and the existing convention coincide, so **no code change**.
- **Unchanged:** priority remains a discriminator *within* an FR-POS-040 tier. It
  does **not** override a higher tier — scope specificity still outranks it.

### P0-5 — FR-POS-040 base price

**RATIFIED: the base-price tier is the eligible tenant-scoped, non-order-specific
PriceList fallback.**

- Tier 7 resolves to the eligible PriceList whose scope is **`tenant`** and whose
  `order_type` is **NULL**.
- "Eligible" means it passes the same filters as any candidate — validity window,
  status, and (once P0-2 ships) recurrence.
- **No `base_price` column is added** to `MenuItemVariant` or anywhere else, and
  **no monetary schema is modified**. Money semantics, FR-MNU-024 audit history
  and tenant/brand inheritance all continue through the single existing
  `PriceEntry` path.
- **Basis:** architectural choice closing a NOT SOURCE-DECIDABLE question. "Base
  price" appears **exactly once** in the SRS — as FR-POS-040 list item 7 — with no
  definition, no ERD entity and no approved-SQL column.
- **Note for implementation:** the resolver's current header comment says tier 7
  "has NO STORAGE" and treats the tenant-scoped list as an undeclared fallback.
  Under P0-5 that fallback is now **explicit and ratified**, and the comment must
  be corrected to say so.

### Preservation

**D-1 … D-20, P-1 and the SB unresolved portions are unchanged by this record.**
**D-16 OPEN · D-12 BLOCKED · D-3 RATIFIED IN PART · D-10 unchanged ·
D-17-05 unchanged.** **D-2 is amended separately and only in part** — see the
amendment recorded under D-2. **C-11 is reopened and amended separately** — see
`docs/catalogue/README.md`.

---
---

## P1A — Order Capture Clarifications (carried items)

> **RECORDED 2026-08-20 by explicit user governance action.**
> **NOT new numbered decisions — no D-21 is created and the 20-decision tally is
> unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).** Recorded as carried
> items, matching the **PL**, **SB** and **P0** convention.
>
> ADR-010 is an SRS architecture decision, not a repository ADR file
> (`docs/adr/` holds 0001–0008 only), so its clarification is recorded here.

### CLARIFICATION B — ADR-010 and Order mutability

ADR-010 states that *"Orders, payments, stock movements, and audit entries are
never updated or deleted."* Read literally that contradicts the Order **state
machine** (§7.3 #22) and the **optimistic concurrency** requirement (§24.6.4),
both of which presuppose an Order that changes while it is being built. The
clarification resolves that contradiction **without weakening financial
immutability**:

1. **Order aggregate data MAY be mutated while the transaction is still
   pre-finalisation**, subject to the state rules and optimistic concurrency.
2. **COMPLETED / financially posted orders are IMMUTABLE.**
3. **Corrections after COMPLETED are Refund / compensating records referencing
   the original** — consistent with **BR-POS-001** and **CR-04**.
4. **Payments remain append-only.**
5. **Stock movements remain append-only** (BR-INV-001, unchanged).
6. **Audit entries remain append-only** (FR-AUD-003, unchanged).

**This is NOT permission to rewrite historical completed sales.** The append-only
guarantees for payments, stock movements and audit entries are untouched.

### CLARIFICATION C — Fire authority boundary

The approved authority rule for Order content:

1. **BEFORE a line is fired** — the cashier may correct or edit normally, within
   existing permissions and business rules. Manager intervention is **not**
   required merely because an order exists.
2. **AFTER a line is fired** — the cashier **SHALL NOT** directly mutate that
   fired content. A correction or void after fire is a **privileged** operation
   requiring Manager-or-higher authority, with reason / audit / approval wherever
   the SRS or the permission model requires them.
3. **AFTER COMPLETED** — neither cashier nor manager directly modifies the
   original order. Correction is Refund / compensating records only.

**Binding constraints on implementation:**

- **Do NOT hardcode role-name strings.** ROS authorisation is
  permission-based, so authority must be expressed as a permission.
- **Do NOT invent a generic "manager correction" permission.**
- **`order.cancel_after_production`** (named by **BR-POS-003**) authorises
  **only its stated cancellation semantics** and **MUST NOT** be broadened into
  authority for arbitrary post-fire edits.
- Where no existing SRS or ratified permission authorises a specific post-fire
  correction, **enforce the cashier lock and leave the privileged command
  unexposed** until its permission semantics become source-decidable.

### Preservation

**D-1 … D-20, P-1, PL, SB and the P0 closures are unchanged.** **D-16 OPEN ·
D-12 BLOCKED · D-3 RATIFIED IN PART · D-10 unchanged · D-17-05 unchanged · SB-1 /
SB-2 / SB-3 unresolved portions unchanged.** Broader branch-scoped RBAC and the
wider Workforce domain remain deferred beyond the already-authorised P0 PIN
substrate. **No approval schema is changed.**

---
## P1C — Tax Identity, Country Pack Signing and Costing (carried items)

> **RECORDED 2026-08-20 by explicit user governance action.**
> **NOT new numbered decisions — no D-21 is created and the 20-decision tally is
> unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).** Recorded as carried
> items, matching the **PL**, **SB**, **P0** and **P1A** convention.
>
> Two of the four approvals amend decisions that live in domain design records
> rather than in this register. Their full text is recorded there, verbatim
> alongside the original ratification, and is summarised here so the register
> remains the single index:
>
> - **C-04 narrow amendment** — `docs/catalogue/README.md`, section "C-04 —
>   MenuItem tax class".
> - **D-17-05 narrow amendment** — `docs/production/PRODUCTION_SPEC_DESIGN_GATE.md`,
>   section 4.1.

### CARRIED ITEM P1C-1 — C-04 reopened NARROWLY for TaxClass identity

`fiscal.tax_classes` becomes the stable semantic TaxClass identity: UUID primary
key, an **immutable** semantic `code` (`standard`, `reduced`, `zero`, `exempt` and
any further pack-defined code — the set is **open**, not a hard-coded enum),
unique per `(tenant_id, country_pack_code)`.

**A TaxClass owns no rates.** Rates, components, rounding and order-type
overrides stay inside the pinned Country Pack version. TaxClass identity answers
*"which semantic class is this item?"*; the pack version answers *"what does that
class mean here?"* — which is exactly what lets a pack change the rate on
`standard` without rewriting a historical sale.

`catalogue.menu_items.tax_class_id` stays **nullable** (onboarding master data
legitimately arrives incomplete) but every non-null reference becomes a real
tenant-safe FK enforced by the DATABASE. **A MenuItem with no TaxClass is not
sellable** — line capture fails rather than defaulting to `standard`.

Fiscal remains otherwise out of scope: no tax documents, invoice templates,
fiscal submissions or `fiscal.tax_rules` table.

### CARRIED ITEM P1C-2 — D-17-05 reopened NARROWLY for the costing substrate

Lifted only for **FR-MNU-046**, **BR-MNU-003**, and **FR-CST-001/002 to the
extent a truthful `unit_cost_snapshot` requires**. Still deferred: theoretical-vs-
actual, menu-engineering profitability, contribution margin, cost-variance
dashboards, the wider FR-CST reporting surface, and the completion-time COGS
posting workflow. **The broader defer stands** — this is not permission to
implement the Costing bounded context.

Every component is valued by **its own** configured costing method
(`fifo | weighted_average | standard`, FR-INV-001). No global default, no
fallback between methods. **BR-MNU-012 is preserved exactly**: an incomplete or
absent recipe may yield zero or partial cost; a **complete** recipe whose
valuation is unavailable **fails** rather than silently becoming zero.

### CARRIED ITEM P1C-3 — Country Pack signing design (v1)

FR-LOC-022 states the security property but no source chose a mechanism, which
left the P1B verifier a fail-closed port with a deny-all default. The v1
mechanism is now ratified:

| Aspect | Decision |
|---|---|
| Algorithm | **Ed25519**, and for v1 the envelope's `algorithm` MUST equal `Ed25519` |
| Canonical payload | **RFC 8785** JSON Canonicalization Scheme (JCS) |
| Signature encoding | **base64url** |
| Envelope | at minimum `keyId`, `algorithm`, `signature` |
| Signed bytes | the RFC-8785 canonical form of the complete pack payload with **only** the signature envelope excluded — signature metadata is never recursively part of what it signs |

**Trust model.** The runtime verifies with trusted **release PUBLIC keys only**.
**No Country Pack signing private key may exist** in the application database,
the backend runtime secret set, the source repository, or any committed fixture.
Signing happens outside the application runtime. Trusted public keys carry an
`active | revoked` lifecycle, and historical public keys are retained so
historical signed pack versions stay verifiable.

**Every one of these rejects, fail-closed:** unknown `keyId` · revoked key ·
invalid signature · payload modified after signing · malformed JCS or envelope ·
unsupported algorithm · unsigned pack · no trusted key configured · malformed
trust configuration. There is **no unsigned fallback in production**, no
HMAC/HS256 verifier, and `stableStringify` (the audit-chain canonicaliser) is
**not** the signing protocol.

Storage and configuration mechanics for the trusted PUBLIC keys are an
engineering implementation choice, not a product decision. **No signing API and
no backend signing capability is added.**

**This does NOT make FR-LOC-031 complete.** Production certification also
requires the full FR-LOC-023 conformance suite, whose invoice-completeness and
QR arms do not exist.

### CARRIED ITEM P1C-4 — `pos.order.create` operational read boundary

**Clarification, not a new permission code.** SRS §15.2 defines
`pos.order.create` as "Create and modify orders". It covers the operational POS
read needed to **open, retrieve, resume, inspect, create and modify** Orders
**inside the caller's already-authorised POS tenant / branch / session context** —
a terminal cannot modify an order it may not read, and the If-Match/ETag flow
requires fetching the current version first.

It does **NOT** authorise arbitrary cross-branch browsing, reports, exports,
accounting access, historical analytics, audit-log access, or dashboard /
back-office Sales reporting. **The permission does not widen tenant, branch or
session scope** — those remain enforced by the terminal binding and the
FR-SEC-021 permitted-branch set.

**No `pos.order.read` code is created.** The zero-invented-codes discipline
(D-17-06 precedent) is intact.

### CARRIED ITEM P1C-5 — BR-MNU-012 absent / incomplete recipe semantics

> **RECORDED 2026-08-20 by explicit user governance action, correcting the P1C
> implementation.** Not a new numbered decision; no D-21.

The P1C run closed BR-MNU-012 as COMPLETE on the grounds that an absent recipe
recorded a NULL cost and the distinction was captured in the audit payload.
**That closure is rejected.** BR-MNU-012 says the System "SHALL record **zero or
partial** cost, and SHALL list the item in a 'recipes requiring completion'
report". A NULL is not a zero — it says the computation failed, which is a
different and untrue statement — and an audit payload is not a report.

The binding semantics are:

| Case | `recipe_version_id` | `unit_cost_snapshot` | Sale |
|---|---|---|---|
| **Complete** recipe, all components priceable | actual version id | full truthful cost | permitted |
| **Complete** recipe, a component unpriceable | — | — | **REFUSED** |
| **Incomplete** recipe (definition unfinished) | actual version id | truthful **partial** cost | permitted |
| **Absent** recipe (none, or none published) | **NULL** | **0** | permitted |

1. The NULL in the absent case is semantically specific: **"no recipe existed at
   sale time"**. It must never mean "cost computation failed".
2. **No fake Recipe, no fake RecipeVersion, no sentinel ULID and no zero UUID**
   may be created to avoid that NULL.
3. A missing component of an incomplete recipe contributes **nothing**; it is not
   priced as a zero-cost component.
4. **"Incomplete" is a property of the recipe DEFINITION** — no components, or a
   sub-recipe with no published version. A component Inventory cannot price is a
   VALUATION gap, is not BR-MNU-012, and refuses the sale rather than reducing
   the cost.
5. Later recipe creation, completion, publication or valuation change **MUST
   NOT** rewrite a historical `recipe_version_id` or `unit_cost_snapshot`.
6. The "recipes requiring completion" report must distinguish `absent_recipe`
   from `incomplete_recipe` and must be operationally queryable — an audit
   payload does not discharge it.
7. **No persistent `cost_basis` column is created.** The order line already
   carries the discriminator: `recipe_version_id IS NULL` is the absent case by
   definition, and the referenced version answers the other two. The basis is
   recorded in the AUDIT entry only, because an audit trail records what the
   system knew at the time — which is not re-derivable once a recipe is
   completed.

**BR-MNU-012 is COMPLETE only when all of the above hold**, including the report.

### CARRIED ITEM P1C-6 — corrected requirement classifications

Four P1C classifications were overclaims and are corrected here so the register,
not a superseded report, is the record:

- **FR-POS-040 — PARTIAL.** The §10.4 precedence has five tiers; manual price
  override (tier 1) and promotion (tier 2) are not implemented. Resolving tiers
  3–5 correctly is not the requirement.
- **FR-POS-042 — PARTIAL.** Provenance is persisted for the tiers that exist; a
  line priced by override or promotion has no provenance path at all.
- **FR-MNU-045 — PARTIAL.** "Publishing SHALL NOT alter previously completed
  orders" cannot be demonstrated end-to-end while order completion does not
  exist. Line-level retention is proven; the completed-order clause is not.
- **FR-DR-002 — NOT IMPLEMENTED.** Specifically: no scheduled advance partition
  creation and no failure alerting. It is not a retention/archival requirement
  and must not be described as one.

### Preservation

**D-1 … D-20, P-1, PL, SB, the P0 closures and the P1A clarifications are
unchanged.** **D-16 OPEN · D-12 BLOCKED · D-3 RATIFIED IN PART · D-10 unchanged ·
SB-1 / SB-2 / SB-3 unresolved portions unchanged.** **D-17-05's broader defer
stands**, amended only as P1C-2 states. **D-2's broader branch-scoped RBAC defer
stands.** The C-11 amendment and its active-state clarification are unchanged. No
approval schema is changed. No new permission code is created.

---
## P1D — Treasury / Payment Architecture (carried items)

> **RECORDED 2026-08-20 by explicit user governance action.**
> **NOT new numbered decisions — no D-21 is created and the 20-decision tally is
> unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).** Recorded as carried
> items, matching the **PL**, **SB**, **P0**, **P1A** and **P1C** convention.
>
> These items settle the questions the P1D design gate raised. **P1D-A** is the
> only one that authorises code in this slice; **P1D-B … P1D-G** are recorded now
> so that the Treasury schema built today cannot force a wrong Payment model
> later — which is precisely what a design gate is for.

### CARRIED ITEM P1D-A — Shift is DISTINCT from CashSession (narrow D-2 reopen)

**Operational Shift is a Workforce concept; CashSession is a Treasury concept.
They are not the same thing and are not collapsed.** A CashSession **references**
the Operational Shift it was opened under.

This follows the SRS rather than the approved SQL: §5.4 lists Shift among
Workforce's key aggregates, the context map carries
`Workforce ──▶ Treasury [shift → cash session]`, §5.5.4 makes Workforce the
publisher of `shift.opened` / `shift.closed`, and §16.2 models a cash session as
"one employee, one shift, one drawer". **The absence of `workforce.shifts` from
the approved SQL is a physical-design omission, not evidence that the two
concepts are one.** It is treated as a documented deviation.

**D-2's broader Workforce deferral is reopened NARROWLY**, for exactly the
Operational Shift substrate the POS/Treasury critical path needs:

**Authorised now:** Operational Shift identity and open/closed lifecycle state;
the CashSession → Shift relationship; the minimum module contract this slice
consumes.

**Still deferred, and NOT authorised:** Schedule and the schedule builder,
ScheduledShift features, AttendanceRecord, clock-in/out and its corrections,
break periods, overtime, leave, shift swaps, payroll, compensation, labour
forecasting, and the wider Workforce API. **P1D-1 must not become the Workforce
module.**

**D-2's branch-scoped RBAC deferral is untouched.** This item reopens the
Workforce *domain* defer only, and only as far as stated.

### CARRIED ITEM P1D-B — Payment-level session attribution is authoritative

A future **Payment** row is the source of truth for cash-session attribution. An
Order may carry several Payments, and those Payments may legitimately belong to
different sessions and different actors (FR-POS-061 [M] permits split tender and
constrains neither).

**`orders.cash_session_id` MUST NOT become the source of truth**, because one
nullable column cannot represent N sessions. The P1A omission of that column is
**retained**, and it is not added in this slice. Should an Order-level projection
ever be introduced, it must be explicitly derived and must not erase
multi-payment / multi-session truth.

This resolves the multi-tender ambiguity the P1D gate raised as Q5.

### CARRIED ITEM P1D-C — PaymentAttempt is not a successful Payment

Ratified for the future Payment slice:

- **PaymentAttempt** records an interaction with a payment rail and its outcome —
  timeout, decline, communication failure, approved, **partial approval**
  (FR-POS-064 [M]).
- A successful financial effect materialises as an immutable **Payment**.
- **Both are append-only.**

This is what reconciles **ADR-010** ("orders, payments … are never updated or
deleted") with FR-POS-064's authorisation lifecycle: the lifecycle is expressed
as a sequence of immutable attempt records, not as a mutable status column.
Partial approval is the decisive case — an approved amount that differs from the
requested amount cannot be represented in one mutable row without rewriting it.

**ADR-010 is preserved.** No mutable Payment status may be implemented.

### CARRIED ITEM P1D-D — Cash rounding is persisted PER PAYMENT

FR-POS-063 [M] requires the cash-rounding adjustment to be recorded "as a
separate ledger amount". That amount belongs on the **Payment**.
`orders.rounding_adjustment`, where maintained, is a projection — the sum of its
payment-level adjustments.

Per-payment is the only shape that survives split tender and per-session
accountability: two cash payments settled in two sessions cannot be
reconstructed from a single order-level total, and FR-FIN-004 needs the
adjustment per session.

### CARRIED ITEM P1D-E — Employee is the business financial actor

For Treasury and Payment attribution the actor is the **Employee**, not the User.
`identity.users` remains the login/authentication identity and the audit/security
actor; `employees.user_id` recovers it when needed.

This follows §16.1 ("currency must be attributable to a **person**, a shift, and
a drawer") and FR-FIN-002 ("a cash session SHALL be bound to exactly one
**employee**"). The approved SQL's `order_payments.processed_by →
identity.users(id)` is a documented deviation from the SRS and is **not**
followed.

**This applies to CashSession ownership immediately**, in this slice.

### CARRIED ITEM P1D-F — `pos.payment.capture` authorised for the Payment slice

The permission code **`pos.payment.capture`** — *"Capture an ordinary POS
customer payment"* — is authorised for the future Payment slice. SRS §15.2's
Sales list contains no payment verb, so this is a **new code created by explicit
user authorisation**, and it is the only exception to the zero-invented-codes
discipline recorded to date.

It is deliberately separate from `pos.order.create` so a tenant may grant a
waiter order entry without granting payment capture.

It does **NOT** authorise: refunds, different-tender refunds, voids, price
overrides, CashSession management, or approvals. Those remain separately
authorised.

**Not seeded in this slice.** The repository seeds a permission only where an
executable consumer exists (`SALES_PERMISSION_DEFS`, `PRODUCTION_PERMISSION_DEFS`),
and creating an unused code would be appearance without capability. It is seeded
when the Payment route exists.

### CARRIED ITEM P1D-G — POS payment accountability, and what touches physical cash

A future ordinary POS-collected Payment must be attributable to: **Employee ·
Operational Shift · CashSession · Drawer (via the session) · Terminal · tenant ·
branch**. That applies to cash *and* to ordinary POS electronic tenders, because
FR-FIN-010 [M] requires per-session totals **by tender type**.

**But only physical cash affects physical cash.** Card, wallet and other
electronic tenders are *associated with* a session for accountability and
reconciliation and **SHALL NOT** increase expected cash. FR-FIN-004's formula
contains cash terms only, and that is the constraint: a card payment appears in
the session's tender totals and never in its drawer balance.

Non-POS asynchronous settlement (aggregator payouts, FR-FIN-012 [S]) is not
designed here.

### Preservation

**D-1 … D-20, P-1, PL, SB, the P0 closures and the P1A / P1C carried items are
unchanged.** **D-16 OPEN · D-12 BLOCKED · D-3 RATIFIED IN PART · D-10 unchanged ·
SB-1 / SB-2 / SB-3 unresolved portions unchanged.** The **C-04** and **C-11**
amendments are unchanged. **D-17-05's broader costing defer** is unchanged.
**D-2's branch-scoped RBAC defer** is unchanged, and its Workforce defer is
reopened **only** as P1D-A states. No approval schema is changed. No Payment
behaviour is created.

---
## Fire Authorization Ratification — 2026-08-24

> **RECORDED 2026-08-24 by explicit user governance action.**
> **NOT a new numbered decision — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).**
> Recorded as an unnumbered ratified entry, matching the **P1A / P1C / P1D**
> carried-item convention, because no existing subsection of this register
> settles the authority to FIRE an order (as distinct from **CLARIFICATION C**
> above, which settles authority to mutate an order's content AFTER it has
> already been fired — a different question).

### The question

SRS UC-POS-01 step 6 and FR-POS-035 [M] require an explicit Fire action that
sends an order's pending lines to production. No ratified permission
authorised that action before this entry: `pos.order.create` ("Create and
modify orders") already covers pre-fire capture and correction, and
**CARRIED ITEM P1C-4** (this register, "`pos.order.create` operational read
boundary") explicitly stopped short of Fire — it authorises the operational
READ Fire needs, not the act of firing.

### Ratified

1. **A new permission is introduced: `pos.order.fire`.**
2. **Manual / explicit Fire requires `pos.order.fire`.** No other permission
   (in particular, not `pos.order.create` alone) authorises it.
3. **A tenant's standard Waiter role, where one exists, receives
   `pos.order.fire`.**
4. **A tenant's standard Cashier role, where one exists, receives
   `pos.order.fire`.**
5. **`pos.order.create` remains separate and does NOT imply manual Fire.**
   Creating and modifying a pre-fire order is authorised independently of
   sending it to production.
6. **Future automatic Fire (FR-POS-035's configurable auto-Fire, not built in
   this slice) is a system CONSEQUENCE of an already-authorized initiating
   POS operation** (e.g. the add-line action that triggers it) **and does NOT
   require a second interactive `pos.order.fire` permission check** at the
   moment it fires automatically. The initiating operation's own permission
   check is what authorises the consequence.
7. **No other permission is broadened.** `order.cancel_after_production`
   (BR-POS-003) and every other existing permission keep their exact
   pre-ratification scope; this entry authorises Fire alone.

### Binding constraints on implementation (unchanged from CLARIFICATION C)

- **Do NOT hardcode role-name strings.** Authorization is permission-based;
  "Waiter" and "Cashier" name a tenant's own role assignment choice, not a
  system-enforced role type — **ROS has no system-defined "standard role"
  persistence mechanism** (verified: every `createTenantRole` call in this
  repository is either the tenant-admin RBAC API or test/seed bootstrap —
  there is no onboarding flow that provisions a fixed role set). Points 3–4
  above are therefore a **POLICY for whoever creates or administers a
  tenant's Waiter/Cashier-equivalent roles** (tenant admin, onboarding
  tooling, or a dev seed script) to grant `pos.order.fire` on those roles —
  not a migration, not a hardcoded seed of specific role rows.
- The permission CODE itself is added the same way every other business
  permission code in this repository is added: an entry in the owning
  module's `<MODULE>_PERMISSIONS` / `<MODULE>_PERMISSION_DEFS` (here,
  `sales.permissions.ts`). Persisting it into a tenant's `permission` catalog
  uses the existing `PermissionsService.upsert`/`upsertMany` mechanism —
  code-driven, not migration-driven (verified: no permission code from ANY
  module, including Identity's own `ensureIdentityPermissions()`, is
  currently invoked by any production bootstrap path; every existing
  invocation is a test suite or a dev seed script calling
  `PermissionsService` directly). This is a **pre-existing, repository-wide
  gap** that predates and is broader than Fire — recording it here rather
  than silently building a new production seeding mechanism for every module
  as an unauthorised side effect of this ratification.

### Preservation

**D-1 … D-20, P-1, PL, SB, the P0 closures, and the P1A / P1C / P1D carried
items are unchanged.** **D-16 OPEN · D-12 BLOCKED · D-3 RATIFIED IN PART ·
D-10 unchanged.** **CLARIFICATION C's post-fire mutation boundary is
unchanged and unexpanded** — this entry authorises the act of firing, not
any new post-fire correction authority. No approval schema is changed. No
Payment or Completion behaviour is created.

---
## P1F-2 Completion Economics & Depletion Resolution — 2026-08-25

> **RECORDED 2026-08-25 by explicit user governance action.**
> **NOT a new numbered decision — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).**
> Recorded as an unnumbered ratified entry, matching the **P1A / P1C / P1D**
> carried-item and **Fire Authorization Ratification** convention.
>
> This entry **narrowly reopens two existing decisions** — **D-17-05** and
> **D-17-07** — whose authoritative text lives in
> `docs/production/PRODUCTION_SPEC_DESIGN_GATE.md` §4. **Their original text is
> preserved verbatim there and is NOT deleted or rewritten.** The prior defers
> genuinely existed and are part of the record; this entry amends them going
> forward, it does not pretend they never applied.
>
> Occasioned by the P1F-2 design gate
> (`docs/reports/claude/2026-08-25_P1F2_completion-architecture-gate.md`),
> which returned **BLOCKED — DESIGN/GOVERNANCE REQUIRED** on exactly these two
> defers plus one repository-design question (depletion identity).

### The questions

Order Completion cannot be implemented without settling three things the
prior gate proved were not settled:

1. **COGS at completion.** SRS §1.2 effect 4, **FR-CST-001 [M]** and §5.5.2
   require COGS recognition atomically at completion, but the **D-17-05
   §4.1 amendment** and its register index **CARRIED ITEM P1C-2** both list
   *"the completion-time COGS posting workflow"* as still deferred and NOT
   authorised.
2. **Modifier-aware depletion.** **FR-POS-024 [M]** requires a "no cheese"
   burger not to deplete cheese, and FR-CST-001 requires *"applying modifier
   recipe deltas"* — but **D-17-07** keeps `modifiers.recipe_delta` opaque
   with no component-resolution semantics and defers FR-MNU-013.
3. **Depletion identity.** `inventory.stock_movements` is RANGE-partitioned
   on `occurred_at`, so no unique constraint omitting the partition key is
   expressible, and `(reference_type, reference_id)` is only a plain index —
   leaving no natural key to prevent duplicate sale depletion.

### Ratified — 1. D-17-05 narrowly reopened for completion-time COGS

**The defer is lifted ONLY for the completion-time COGS workflow. Every other
clause of D-17-05 and of the D-17-05 §4.1 amendment remains unchanged**, and
in particular the following stay deferred exactly as before: theoretical-vs-
actual analysis, menu-engineering and profitability analytics,
contribution-margin reporting (FR-CST-005), cost-variance dashboards, and the
wider FR-CST reporting surface. **This remains NOT permission to implement the
Costing bounded context.**

1. **`sales.order_lines.unit_cost_snapshot` remains immutable historical
   sale-time evidence.** It **MUST NOT** be rewritten during Completion.
   BR-POS-004 and **CARRIED ITEM P1C-5** are untouched.
2. **Completion-time posted COGS is a DISTINCT concept** from the sale-time
   estimate. The two facts coexist; neither overwrites the other.
3. **Posted COGS is derived from the actual valued Inventory depletion
   performed at Completion** — not recomputed from recipe master data.
4. **Sales persists explicit immutable per-OrderLine posted COGS
   projections** and rolls them up into `sales.orders.cogs_total`.
5. **After Completion, `sales.orders.cogs_total` means POSTED completion
   COGS**, not the running sale-time estimate it holds before Completion.
6. **The existing quantity defect must not survive in posted COGS.** Summing
   a per-unit cost without multiplying by `OrderLine.quantity` is a defect;
   posted COGS is quantity-correct by construction.
7. **Ownership.** *Inventory* owns current inventory valuation, the immutable
   depletion ledger, and `stock_movements.unit_cost` / `total_cost`.
   *Production* owns recipe semantics, recipe/sub-recipe expansion, unit
   conversion, and modifier recipe effects. *Sales* owns Order, OrderLine,
   completion state, and the immutable posted-COGS projections on the sale.
8. **No fake Costing module** may be created solely to relocate code into a
   named bounded context.

**Relationship to FR-CST-002.** FR-CST-002 says COGS *"SHALL be recorded on
the order line as `unit_cost_snapshot` and SHALL NOT be recomputed
retroactively when ingredient costs change."* Keeping the sale-time snapshot
immutable **and** recording posted COGS requires two fields rather than one.
This is a **documented, deliberate deviation from FR-CST-002's literal
single-field wording**, adopted because the requirement's own
no-retroactive-recomputation clause cannot otherwise be honoured. Both facts
are retained, which is strictly more information than the SRS requires, and
neither is ever recomputed retroactively.

### Ratified — 2. D-17-07 narrowly reopened for modifier-aware depletion

**The defer is lifted ONLY as far as correct modifier-aware inventory
depletion and COGS require. Every other clause of D-17-07 remains
unchanged.**

1. **Modifier recipe effects SHALL use a typed, relational,
   Production-owned representation.** The opaque
   `catalogue.modifiers.recipe_delta` JSON column is **NOT** the mechanism and
   remains uninterpreted.
2. **The canonical operations are exactly two: `ADD` and `REMOVE_ALL`.**
3. **A substitution is represented as `REMOVE_ALL` of the old component plus
   `ADD` of the replacement.** There is no distinct substitution operation.
4. **No open-ended JSON or DSL operation language may be created.** No
   generic expression evaluator, no operation-identifier vocabulary beyond
   the two operations above.
5. **FR-POS-024 must be satisfied**: a removal modifier reduces depletion, so
   a "no cheese" burger does not deplete cheese.
6. **Modifier consumption semantics used by a sale MUST be snapshotted** at
   sale time, so later modifier or master-data edits cannot change historical
   depletion.
7. **Completion MUST consume the sale-time resolved modifier-depletion
   facts**, never re-interpret today's modifier master data.

**FR-MNU-013's wider surface stays deferred.** This entry authorises the two
depletion operations only; it does not authorise nested modifier groups,
substitution-selection algorithms, or any other recipe-delta semantics.

### Ratified — 3. Line-scoped sale-depletion provenance

Sale depletion provenance is **OrderLine-scoped**:

```
Order -> OrderLine -> StockItem depletion effect
```

- Duplicate appearances of the same StockItem reached through different
  recipe / sub-recipe paths are **aggregated INSIDE one OrderLine**.
- The same StockItem appearing on **different OrderLines is NOT aggregated
  across them.** Each line remains separately attributable for traceability,
  COGS, audit, future refunds/reversals, and reconciliation.

### Ratified — 4. Non-partitioned Inventory sale-depletion effect registry

- Inventory SHALL own a **NON-PARTITIONED** sale-depletion effect registry
  which is the **business idempotency and provenance boundary**.
- `inventory.stock_movements` remains the high-volume immutable partitioned
  ledger and its `reference_type` / `reference_id` semantics are unchanged.
- **`stock_movements.occurred_at` MUST NOT be made part of a business
  identity merely because that table is partitioned.**
- The registry's precise schema and key are an engineering design matter,
  settled in the P1F-2A design gate, not pre-decided here.

### Ratified — 5. Inventory concurrency hardening is a precondition

- **Completion MUST NOT ship while `inventory.stock_levels` can suffer lost
  updates under concurrent sales.** The existing
  read-in-JS-then-upsert pattern is **not accepted** for the Completion path.
- Quantity projection updates SHALL use true atomic additive SQL semantics.
- FIFO batch consumption SHALL use deterministic locking and ordering.
- **No sleeps.** **No application-wide retry framework.** **No `SKIP LOCKED`
  where skipping a locked older layer would change which FIFO layers are
  consumed.**
- Ledger and projection SHALL remain reconcilable (BR-INV-003) under
  concurrent completions.

### Ratified — 6. Completion entry point and authorization

- The interactive API remains **`POST /orders/{businessDay}/{id}/payments`**.
- **No `/complete` route** is created. **No `pos.order.complete` permission**
  is created — the zero-invented-codes discipline (D-17-06 precedent) stands,
  and **CARRIED ITEM P1D-F**'s `pos.payment.capture` remains the only
  recorded exception.
- The authorised operator action is **`pos.payment.capture`**.
- When a Payment financially satisfies the Order, **Completion is an atomic
  SYSTEM CONSEQUENCE of that already-authorised Payment**, not a separately
  authorised operator action. This is the same consequence-of-an-authorised-
  operation principle already ratified as point 6 of the **Fire Authorization
  Ratification — 2026-08-24**.
- Option A of the P1F-2 design gate is **RATIFIED**.

### Ratified — 7. Valuation and negative stock

- **Negative inventory SHALL NOT block Completion.** Quantity depletion
  records physical reality even when stock goes negative (UC-POS-01 13a,
  FR-INV-014).
- If complete valuation were ever unavailable, historical sale records
  **SHALL NOT** be rewritten later; any correction would have to be
  append-only.

> **Design-gate finding on this point (P1F-2A, non-authoritative but
> load-bearing):** no valuation gap is in fact reachable at Completion.
> Inventory's `valuationUnitCost` is a total function — `standard` is
> guaranteed by the `ck_standard_cost_present` CHECK, `weighted_average`
> reads the maintained `stock_levels.average_cost`, and `fifo` values the
> consumed layers (including any unbacked remainder) at the FIFO-derived
> weighted mean — and `stock_movements.unit_cost` is NOT NULL. Because
> posted COGS is defined as the sum of actually-valued movement totals, a
> COMPLETED Order can never carry an unresolved valuation gap, so **no
> provisional-COGS or post-completion adjustment mechanism is created**, and
> **BR-POS-001's completed-order immutability is preserved intact.**

### What is NOT reopened

**No broader Costing, Fiscal, or CRM governance is reopened.** Specifically
unchanged: the Costing bounded context stays unimplemented; **P1C-1**'s
Fiscal exclusion (no tax documents, invoice templates, fiscal submissions or
`fiscal.tax_rules`) stands; no CRM/Loyalty scope is created; **D-2**'s
branch-scoped RBAC defer stands; **D-17-01 … D-17-04**, **D-17-06**,
**D-17-08**, **GAP-1** and **GAP-2** are untouched.

### Preservation

**D-1 … D-20, P-1, PL, SB, the P0 closures, and the P1A / P1C / P1D carried
items are unchanged except exactly as stated above.** **D-16 OPEN · D-12
BLOCKED · D-3 RATIFIED IN PART · D-10 unchanged · SB-1 / SB-2 / SB-3
unresolved portions unchanged.** The **C-04** and **C-11** amendments are
unchanged. The **Fire Authorization Ratification** is unchanged. **P1D-B …
P1D-G are unchanged** and continue to govern Payment attribution, rounding
and accountability. No approval schema is changed. **No new permission code
is created.** No numbered decision is added, amended, or renumbered.

---
## FIFO Exhaustion Carry-Forward Ratification — 2026-08-25

> **RECORDED 2026-08-25 by explicit user governance action.**
> **NOT a new numbered decision — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).**
> Recorded as an unnumbered ratified entry, matching the **P1A / P1C / P1D**,
> **Fire Authorization** and **P1F-2 Completion Economics** convention.
>
> This entry **narrowly amends CARRIED ITEM P1C-2's no-fallback clause** for
> one specific case. **P1C-2's original text is preserved verbatim above and is
> NOT rewritten**, and neither is the original D-17-05 text in
> `docs/production/PRODUCTION_SPEC_DESIGN_GATE.md` §4.
>
> Occasioned by the P1F-2B correction gate
> (`docs/reports/claude/2026-08-25_P1F2B_completion-correction-gate.md`), which
> returned **BLOCKED — FIFO ZERO-LAYER VALUATION NOT SOURCE-DECIDABLE** as the
> single remaining obstacle to implementing Order Completion.

### The question

`inventory.stock_movements.unit_cost` is `NOT NULL`, so **every** sale
depletion must carry a cost. **FR-INV-012** defines FIFO only as *"Consumption
valued at the cost of the oldest **remaining** batch"*; **FR-INV-013**
presupposes batch-tracked draw-down; and SRS §24.5.2's reference
`FifoCostingStrategy` delegates to a `drawDown(batches, qty)` whose
empty-input behaviour is never specified. When the FIFO queue is empty the
SRS therefore defines no value — while **FR-INV-014** and **UC-POS-01 13a**
require the depleting transaction to proceed regardless.

The pre-existing implementation fell back to `stock_levels.average_cost`.
That fallback was **never ratified** — it does not appear in
`docs/inventory/INVENTORY_DESIGN_GATE.md` §29's list of unresolved
ambiguities — and it is precisely the cross-method fallback **P1C-2** forbids.

### Ratified — FIFO EXHAUSTION CARRY-FORWARD

**Scope: Inventory movement valuation at Completion only.**

1. **Available layers are always consumed first.** Normal FIFO is unchanged:
   layers are drawn down oldest-first (or by the item's configured
   `batch_strategy`), and each backed quantity is valued at **its own actual
   layer cost**. Carry-forward never replaces an available layer.
2. **Partial coverage.** Where the requested depletion exceeds the total
   quantity remaining in the queue: consume every available layer normally and
   value each backed quantity at its actual layer cost; then value **only the
   remaining unbacked quantity** at the unit cost of the layer most recently
   exhausted. A single blended mean **SHALL NOT** be applied to the whole
   depletion where doing so would erase the layer-level FIFO valuation of the
   backed portion.
3. **Zero coverage.** Where no positive-quantity layer exists at all, the whole
   depletion is valued at the unit cost of the FIFO layer most recently
   exhausted for the same **tenant · stock item · location**.
4. **"Most recently exhausted" means exhausted, not purchased.** It is the
   historical layer the consumption strategy drew down last, resolved from
   real persisted batch history. It coincides with the most recently
   *received* layer only where those are genuinely the same historical row.
5. **The exhausted layer must already exist.** No fake, synthetic or
   sentinel batch row may be created to satisfy this rule.
6. **No other fallback is authorised.** Weighted-average cost, standard cost
   and any generic "latest purchase cost" lookup **SHALL NOT** be used to
   value a FIFO item.
7. **Production's sale-time valuation is unchanged.**
   `StockValuationService` continues to return `null` for a FIFO item with no
   positive layer, and a **complete** recipe with an unpriceable component
   continues to be **refused at line capture** (CARRIED ITEM P1C-5). This
   ratification does not lower that bar.
8. **Negative stock never blocks Completion** (FR-INV-014, UC-POS-01 13a).
9. **No retroactive rewrite.** Posted COGS and completed-Order facts are
   written once and never recomputed (BR-POS-001, FR-CST-002's
   no-retroactive-recomputation clause).
10. **Terminal case fails closed.** If no historical exhausted layer exists
    either, the depletion **SHALL** fail and roll the Completion back rather
    than silently adopting another costing method. This is defence in depth:
    the case is unreachable through the sale path, because a FIFO item with no
    value-bearing layer cannot be sold with a complete recipe in the first
    place (point 7).

### Narrow amendment to CARRIED ITEM P1C-2

P1C-2 states: *"Every component is valued by **its own** configured costing
method … No global default, no fallback between methods."*

**That clause is narrowed for this case only.** It is to be read as forbidding
the substitution of a *different costing method*, or a *purchase-price
lookup*, for an **available** FIFO layer. It does **not** forbid continuing an
item's own FIFO cost lineage at its last actual layer cost when the queue is
empty and the SRS defines no value. Carry-forward is **FIFO-native**: the cost
originates from a real FIFO layer of that same item and location, selected by
the same strategy that consumed it.

**Everything else in P1C-2 is unchanged**, including the requirement that each
component be valued by its own configured method, the prohibition on a global
default, and BR-MNU-012's preservation.

### What is NOT authorised

**No weighted-average fallback for FIFO. No standard-cost fallback for FIFO.
No generic latest-purchase-cost fallback. No change to Production's
line-capture `StockValuationService`. No change to any other costing method.
No broader Costing work** — the Costing bounded context remains unimplemented,
and D-17-05's residual defers stand except as the **P1F-2 Completion Economics
& Depletion Resolution** entry already narrowed them.

### Preservation

**D-1 … D-20, P-1, PL, SB, the P0 closures and the P1A / P1C / P1D carried
items are unchanged except exactly as stated above.** **D-16 OPEN · D-12
BLOCKED · D-3 RATIFIED IN PART · D-10 unchanged.** The **C-04** and **C-11**
amendments, the **Fire Authorization Ratification**, **P1C-1**, **P1C-5**,
**P1D-B … P1D-G** and the **P1F-2 Completion Economics & Depletion
Resolution** entry are all unchanged. No approval schema is changed. **No new
permission code is created.** No numbered decision is added, amended or
renumbered.

---
## Approval Runtime Minimum Resolution — 2026-08-29

> **RECORDED 2026-08-29 by explicit user governance action.**
> **NOT a new numbered decision — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).**
> Recorded as an unnumbered ratified entry, matching the **P1A / P1C / P1D**,
> **Fire Authorization**, **P1F-2 Completion Economics** and **FIFO Exhaustion
> Carry-Forward** convention.
>
> This entry resolves the **carried items SB-1, SB-2 and SB-3**, the
> **D-4 clause 5** question, the **D-16 Phase-1 constraint-form** question,
> and settles **one-decision-per-request semantics**; it **narrowly amends
> D-2, D-9 and D-15**, and adds one column to **D-1**'s ratified set. **All
> historical text — including the SB status table of 2026-08-19, D-15's
> clauses 4/10/11, and every prior analysis — is preserved verbatim above and
> is NOT rewritten**, superseded forward in the register's established manner.
>
> Occasioned by
> `docs/reports/claude/2026-08-29_APPROVAL_governance-runtime-resolution-gate.md`
> and its correction
> `docs/reports/claude/2026-08-29_APPROVAL_ratification-proposal-correction.md`.
> **Those reports are non-authoritative evidence; this entry is the binding
> record, and where they differ this entry governs** — see "Corrections" below.

### The question

Can the general approval mechanism `FR-SEC-030`…`033` [M] be made
implementation-writable, and `FR-FIN-006` [M] cash-variance approval thereby
reachable, without reopening `P-1`, `D-12`, or the `D-16` enumeration?

The Phase 1 approval model was already ratified in near-complete detail
(**D-1, D-4, D-5, D-6, D-7, D-8, D-9, D-10, P-1**), yet remained unbuildable
on three counts: two mandatory columns had **no ratified type or posture**
(`value` — SB-2; `required_permission` FK — SB-1), the request's **DELETE
posture was unresolved** (SB-3), and **D-14 A-1 + D-2 (a) + D-11 N-B + D-20**
jointly left **no path by which any human could approve anything** — a
consequence D-14 itself recorded as delivering *"the tables and internal
service exercisable only by tests."*

---

### RATIFICATION — APPROVAL RUNTIME MINIMUM RESOLUTION (2026-08-29)

**RATIFIED — the following eight resolutions are binding.**

**1. D-16 — Phase-1 constraint form.**
`governance.approval_requests.request_type` is **`VARCHAR(32) NOT NULL` with
NO CHECK constraint in this phase.**
**D-16's ENUMERATION remains OPEN.** **No closed `request_type` vocabulary is
ratified**, no value is added to any enum, and **D-16 is NOT closed** — only
its Phase-1 constraint-form question is resolved. **The literal
`request_type` code for cash variance is NOT decided here.**

**2. SB-1 — `required_permission`.**
Stores the **immutable SRS §15.2 permission CODE**. **No foreign key** to
`identity.permissions`.
Approver authority is checked **at decision time** against the approver's
**effective resolved permission-code set**. **SB-1 is RESOLVED** (its
representation half was already settled 2026-08-19; the FK posture is settled
here). **No new permission code is created.**

**3. SB-3 — `approval_requests` DELETE posture.**
**`ros_app` has NO DELETE capability** on `governance.approval_requests`:
**no DELETE grant and no DELETE policy.**
`approval_decisions → approval_requests` carries **`ON DELETE RESTRICT`**.
**`ON DELETE CASCADE` remains rejected.** **SB-3 is RESOLVED.** The **D-8
clause 6 cascade verification** is **dissolved** — no delete path exists for a
cascade to fire through — and **V2 is not required**.

**4. D-4 clause 5 — `rejected` storage.**
`approval_decisions.decision` is the **immutable historical fact**.
`approval_requests.status` is the **current-state projection** and **remains
the sole request column that may be updated under D-6**.
**D-4 clause 5 is RESOLVED.** D-4's ratified lifecycle
(`pending → approved | rejected`) is **unchanged**, and **no new state is
introduced** — `cancelled`, `escalated` and `expired` remain prohibited.

**5. Decision cardinality — exactly ONE final decision per request.**
A future schema **SHALL** enforce **`UNIQUE (tenant_id, approval_request_id)`**
on `governance.approval_decisions`.
**This NARROWLY AMENDS D-15 clause 4**, which reads *"Do NOT introduce a
UNIQUE constraint establishing 'one decision per approval request.' The
sources do not establish that semantic."* That statement **remains true as a
source finding** — this is an **architectural ratification, NOT a claim that
the SRS mandates the semantic** — and it is made by exactly the route
**D-15 clause 14** provides: *"Any future requirement or architectural
decision establishing duplicate-decision prevention, one-decision-per-request
semantics, or stronger approval concurrency guarantees must be handled by an
explicit future decision/amendment."* **This entry is that amendment.**
**D-15 clauses 10 and 11** — recording duplicate and contradictory decision
rows as unresolved architectural behaviour — are **superseded forward to
exactly this extent**.
**All other D-15 clauses are preserved exactly**, specifically: **clause 3**
(no approval-specific idempotency key, duplicate-request mechanism or HTTP
retry contract), **clause 5** (no pessimistic row locking), and **clause 9's
prohibition on the C-3 pending-status predicate — no such predicate is added.**

**6. D-2 — AMENDMENT IN PART.**
The defer is **LIFTED for exactly one thing**: obtaining an approval decision
**synchronously via manager PIN on a registered terminal**, reusing the
**existing `FR-SEC-021` / `FR-SEC-022` PIN substrate** already lifted by the
2026-08-19 amendment.
**D-2's 2026-08-17 ratified text is unchanged, not reinterpreted and not
deleted.**
**Defer REMAINS IN FORCE for everything else, explicitly:** the
**asynchronous half of `FR-SEC-032`** and all push notification
(**D-11 unchanged**); **broader branch-scoped RBAC** (`FR-SEC-002` /
`FR-SEC-003` / `FR-SEC-004`); **D-12**; **D-14 A-1** — **no Governance
HTTP/API surface**, the PIN being carried on the **consuming** route and never
on a Governance endpoint; and **D-20** — **no Governance read surface**.

**7. SB-2 — `approval_requests.value`.**
**`JSONB NOT NULL`**, treated by Governance as an **OPAQUE CARRIER**:
Governance **does not interpret its domain meaning**; **no Governance RLS
predicate reads inside it**; **no Governance CHECK reads inside it**; **no
Governance index depends on its internals**; **no Governance security rule
parses it**. The consuming domain owns its shape and meaning entirely,
consistent with **D-13** (*"Governance is a generic carrier"*).
**Monetary values within the JSONB SHALL be represented as base-10 integer
strings of minor units, so that application-layer numeric precision is
preserved.**
**SB-2 is RESOLVED.** **SB-2's previously ratified EXCLUSION remains valid** —
a money-only `BIGINT` minor-units representation (VT-4) is still excluded, and
clause 7's string convention is **not** a reintroduction of it: no monetary
type is imposed on the column. The **nullability sub-question** SB-2 left open
(`FR-POS-047`'s boolean dimension) is resolved by `NOT NULL`, a boolean
condition being representable as a document.

**8. F-1 — approver ≠ subject owner (option R-b).**
`governance.approval_requests` gains **one nullable excluded-approver identity
field**, supplied by the consuming domain.
**BINDING CLARIFICATION — this identity is an Identity USER ID, in the same
identity domain as `approval_decisions.approver_id`. It is NOT an Employee
ID.** For cash variance, **Treasury supplies the User identity corresponding
to the CashSession owner** according to the accepted Employee/User model.
The `approval_decisions` **INSERT policy gains an additional DB-enforced
conjunct** prohibiting that User from approving.
**The existing requester ≠ approver protection remains independently
enforced** — D-7's conjunct is unchanged, so SRS §7.3 row 36's aggregate
invariant and `FR-FIN-006`'s *"SHALL NOT be the session owner"* hold
**simultaneously and independently**.
**Service-only enforcement is NOT sufficient** (**D-7 clause 5**;
`FR-SEC-016`'s *"block, not merely warn … regardless of role configuration"*).
**The excluded identity SHALL NOT be extracted from
`approval_requests.value`** — clause 7 forbids it, and a security predicate
must not depend on a domain-supplied payload shape.
**This amends D-1's ratified column set** (one further documented deviation
from the approved SQL, of the species D-1 itself performed) **and amends D-9's
decision INSERT policy**, recorded explicitly as a **D-9 policy
amendment/consequence** in the manner established at **D-7 clause 6** and
**D-10 clause 9**, and anticipated by the register's own rule that such an
extension *"must be ratified explicitly, not applied silently."*
**D-15 clause 9's general preservation of D-9 is superseded forward to exactly
this extent**; its specific C-3 prohibition is untouched. **D-7, D-8 and D-10
are otherwise unamended.**

---

### Corrections to the occasioning reports

Both reports are **non-authoritative evidence**. Two of their characterizations
are **corrected here and do not enter the binding record**:

1. **The correction report stated that item 5 "does not amend D-15."** That is
   **wrong**: **D-15 clause 4 explicitly prohibits** the one-decision-per-request
   UNIQUE constraint by name. Item 5 **does** amend D-15, by the route
   **D-15 clause 14** provides. Clause 5 above records this accurately.
2. **Both reports attributed IEEE-754 storage to JSON numbers.** That
   attribution is **not made here.** The binding rationale for clause 7's
   integer-string convention is **application-layer numeric precision**, not
   any claim about PostgreSQL `jsonb` internal storage.

### Not decided by this entry

**The following are NOT ratified and remain open**, and **no part of this entry
may be read as settling any of them**: the **literal `request_type` code for
cash variance**; the **exact excluded-User column name**; its **exact FK
shape**; the **exact RLS SQL / predicate form**; **approval service
interfaces**; the **Identity contract shape** for PIN verification; the
**migration number** beyond the existing planning assumption; the
**CashSession-close API shape**; **variance tolerance / settings**; the
**denomination catalogue**; the **X-report permission**; **Shift close**;
**Day Close**; **D-12 escalation**; **asynchronous approval**; and
**notifications**.

*Recorded as a Design-Gate consequence, NOT ratified:* `identity.employees.user_id`
is **nullable** (SRS §7.3 #25 — *"May link to at most one User"*), so the
Employee → User mapping clause 8 requires can yield NULL for an Employee with
no linked User. The Design Gate must address this; PIN authentication already
requires a linked User, so a PIN-opened session's owner necessarily has one.

### Preservation

**P-1 remains RATIFIED and UNCHANGED: `approval_decisions` references
`approval_requests` DIRECTLY.** **D-12 remains BLOCKED.** **D-16's
`request_type` ENUMERATION remains OPEN.** **D-11 remains unchanged — no
notification implementation of any kind.** **D-14 A-1 remains unchanged — NO
Governance HTTP/API surface.** **D-20 remains unchanged — NO Governance read
surface.** **The asynchronous half of `FR-SEC-032` remains deferred and
knowingly unmet.** **SB-2's exclusion of a money-only `BIGINT` representation
remains valid.**

**D-1 … D-20, P-1, PL, SB, the P0 closures, the P1A / P1C / P1D carried items,
the Fire Authorization Ratification, the P1F-2 Completion Economics &
Depletion Resolution and the FIFO Exhaustion Carry-Forward Ratification are
unchanged except exactly as stated above** — namely: **D-1** gains one column
(clause 8); **D-2** is amended in part (clause 6); **D-9**'s decision INSERT
policy gains one conjunct (clause 8); **D-15** clauses 4, 10 and 11 are
narrowly amended (clause 5) and its clause 9 superseded only to the extent of
clause 8. **D-3, D-4 (lifecycle), D-5, D-6, D-7, D-8, D-10, D-11, D-13, D-14,
D-16 (enumeration), D-17, D-18, D-19 and D-20 are untouched.** The **D-3
residual**, **GAP-11**, **granted-approval staleness**, **`FR-AUD-008`** and
**`FR-SEC-035`** remain carried and unresolved.

**No numbered decision is added, amended by number, or renumbered.** **No new
permission code is created.** **No approval schema is created by this entry.**
**NO IMPLEMENTATION IS AUTHORISED BY THIS RATIFICATION** — a separate runtime
Design Gate is required before any migration.

**Status:** **RATIFIED — CLOSED.**

---
## P1G-1 Cash-Close Policy Ratification — 2026-08-30

> **RECORDED 2026-08-30 by explicit user governance action.**
> **NOT a new numbered decision — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).**
> Recorded as an unnumbered ratified entry, matching the **P1A / P1C / P1D**,
> **Fire Authorization**, **P1F-2 Completion Economics**, **FIFO Exhaustion
> Carry-Forward** and **Approval Runtime Minimum Resolution** convention.
>
> This entry resolves the **four narrow items** the P1G-1 variance/settings
> design gate returned as `USER RATIFICATION REQUIRED` (**R-1, R-2, R-3, R-4**)
> and records the user's **acknowledgement of the derived fail-closed
> consequence R-5**. It **amends no numbered decision**, creates **no
> permission code**, creates **no schema**, and **does not reopen** P-1, D-12,
> D-13 or the D-16 enumeration. **All historical text is preserved verbatim
> above and is NOT rewritten**, superseded forward in the register's
> established manner.
>
> Occasioned by
> `docs/reports/claude/2026-08-30_P1G1_variance-settings-final-design-gate.md`.
> **That report is non-authoritative evidence; this entry is the binding
> record, and where they differ this entry governs.**

### The question

`FR-FIN-006` [M] requires approval and a reason for variance *"beyond a
configurable tolerance"*, and `FR-POS-094`/`095` [M] require a per-branch
blind/open cash count mode with `blind` as the default. The SRS states the
requirement's **existence** in every case but, unlike `FR-PRC-041`
(*"default 0%"* / *"default 2%"* / *"1 minor unit"*), `FR-INV-046`
(*"by percentage or value"*) and `FR-KDS-025` (*"default 30 minutes"*),
**states no dimension, no default value and no configuration level for the
cash variance tolerance**. The design gate established that four questions
could not be answered from source without invention:

1. the tolerance's **representation** (absolute money · percentage · both);
2. whether the comparison is on the **signed** or the **absolute** variance;
3. **which effective policy version governs a CashSession** (open · close);
4. the **source of the synchronous approval's `expiresAt`**, given that D-10
   ratified `expires_at` as mandatory and immutable with **no default
   duration**.

Each is recorded below as **explicit user ratification resolving source
silence** — **not** as a finding that the SRS decided it.

---

### RATIFICATION — P1G-1 CASH-CLOSE POLICY (2026-08-30)

**RATIFIED — the following five resolutions are binding.**

**R-1(a) — Cash variance tolerance representation.**
The P1G-1 variance tolerance **SHALL be an ABSOLUTE MONEY AMOUNT**, represented
as **integer minor units in a `BIGINT` column** with an **ISO 4217 currency**.
The policy version's currency **SHALL correspond to the CashSession / branch
operational currency used for the comparison**; a mismatch is not reconciled by
conversion. **No floating-point representation** of money is permitted
(§7.2 / `BR-CORE-001`). **No percentage tolerance exists in this phase**, and
the hybrid form is not adopted.
This is a **domain-owned Treasury control threshold**, consistent with **D-13**
(RATIFIED 2026-08-17, option (b) — thresholds are domain-owned and Governance
stays generic).
**The SRS did NOT select this representation.** `FR-FIN-006`'s *"a configurable
tolerance"* is dimensionless, and the register records that silence as
unresolved until this entry. **This clause is the resolution, by user
ratification, not an SRS finding.**

**R-2(a) — Variance comparison semantics.**
The reason/approval threshold test **SHALL be**:

```
abs(counted_cash − expected_cash) > tolerance
```

therefore:

* `abs(variance) <  tolerance` → **within** tolerance;
* `abs(variance) =  tolerance` → **within** tolerance;
* `abs(variance) >  tolerance` → **beyond** tolerance → `FR-FIN-006` reason +
  approval path.

The **strict `>`** is **source-backed** — `FR-FIN-006` [M] *"Variance **beyond**
a configurable tolerance"* and `FR-POS-096` [M] *"when variance **exceeds** a
configurable tolerance"*, two independent mandatory statements.
The **absolute-value framing is the user-ratified choice**, not an SRS finding.
Consequently **shortages and overages are subject to the same single configured
scalar tolerance**; no separate positive/negative thresholds exist, and none may
be inferred from this entry.
`FR-FIN-005` [M]'s signed definition of variance (`Counted − Expected`) is
**unchanged** — the signed value is still what is computed and recorded; only
the *threshold test* uses its magnitude.

**R-3(a) — Policy version governing a CashSession.**
A CashSession **SHALL** be governed by the cash-close policy version that was
**effective at the session's OPEN time**. Resolution **MAY** occur lazily during
close, using **`cash_session.opened_at`** as the resolver's `asOf` instant.
The policy is **NOT** selected according to the configuration current at close
time. This prevents a tolerance being widened after a drawer is already open.
**No snapshot need be physically written at open merely to implement this
selection rule** — no column is added to `treasury.cash_sessions` by this entry,
and the accepted P1D-1 session-open path is **not** modified.
This does **not** disturb `FR-PLT-028`'s own rule for closed historical records;
it settles only which version an **in-flight** session takes, a point the SRS
does not address.

**R-4(a) — Approval expiry source.**
The synchronous cash-variance `ApprovalRequest`'s `expiresAt` **SHALL be derived
from a CONFIGURED POSITIVE DURATION stored on the immutable cash-close policy
version**. Planned representation:
`variance_approval_expiry_seconds INTEGER NOT NULL`, `CHECK (… > 0)`.
**There is NO database default and NO application default duration.**
**No `5m` / `15m` / `30m` constant is authorised**, and none may be introduced
by an implementation slice.
Treasury derives the **explicit** `expiresAt` from the configured duration at
the moment it creates the request.
**D-10 (E2) is UNCHANGED**: `expires_at` remains **mandatory, explicit and
immutable**, evaluated **lazily at decision INSERT**, with **no `expired`
status, no scheduler, and no mutation of `approval_requests`**. This entry
supplies the consuming domain's *source* for the value; it does not alter the
generic runtime's rule.

**R-5 — Fail-closed unconfigured branch (ACKNOWLEDGEMENT).**
The user **acknowledges and accepts** the derived operational consequence:
**a branch SHALL NOT be able to complete a CashSession close if no valid
cash-close policy version existed at the session's governing policy time**
(R-3(a)).
**No default tolerance is invented** — the unconfigured state is the **absence
of any policy version row**, not a column default.
A holder of the **existing, source-named** permission **`settings.branch.manage`**
(SRS §15.2, *"Branch configuration"*, already seeded per **ADR 0008 D-01**) must
configure the branch policy before normal cash close can operate. **No new
permission code is created by this entry.**
**Blind count remains independently source-defaulted to `blind` under
`FR-POS-095` [M]**, so a *count-mode* read never fails closed; only the
tolerance-dependent close path does.

---

### Binding design constraints recorded with this ratification

These are recorded as **implementation/design constraints**, **NOT** as new
business requirements.

**C-1 — API versioning.** The cash-close-policy administration slice **MUST NOT
perform an isolated `/v1` API-versioning retrofit.** The repository's current
API routing convention remains in force for that route. **The existing global
SRS `/v1` API-compliance gap remains a separate, open matter and MUST NOT be
silently declared fixed.** **No specific route URL is ratified by this entry.**

**C-2 — No backdating (a consequence of R-3(a)).** Cash-close policy versions
**MUST NOT be backdated by the application role**. The implementation design
**MAY** enforce this with a server-created immutable timestamp (excluded from
the application role's column-level `INSERT` grant) together with an
`effective_from >= created_at` constraint, as proposed by the accepted design
gate.
Consequently: **a CashSession opened before the first applicable policy version
exists cannot later become eligible merely because an administrator creates a
backdated version.** **No historical configuration may be invented.**
**Sessions already open at rollout that predate configuration are a
rollout/transition case** and **MUST be handled explicitly** by a future
implementation or operational decision — they **MUST NOT** be handled by
silently weakening R-3(a) or C-2.

---

### Not decided by this entry

**This ratification does NOT decide** — and nothing below may be read as
settled by implication: the **system-wide settings architecture**; **Platform
Default** storage; **Country Pack** cash settings; **Tenant / Brand / Terminal**
cash-tolerance overrides; **`FR-PLT-026` lock mechanics** beyond the existing
source wording; the future **settings inspector** (`FR-PLT-027` [S]); the
**drawer-limit value or behaviour** (`FR-POS-092` [M]); the **denomination
catalogue**; **offline cash-close policy sync**; **transition handling for
already-open sessions at rollout**; the **full CashSession Close
implementation**; **Day Close**; **X / Z reports**; and **`NFR-PERF-006`**.

Also **not** decided: the exact table, column and index names; the exact RLS
predicate SQL; the resolver's interface shape; the route URL; and the audit
action literal — all **Design-Gate / implementation details**, consistent with
how the Approval Runtime Minimum Resolution treated the same class of item.

### Preservation

**The narrow Treasury cash-close policy ratified here is NOT the generic
Settings platform, and MUST NOT be described as implementing it.**
**`FR-PLT-025` [M]'s six-level hierarchy (Platform Default → Country Pack →
Tenant → Brand → Branch → Terminal) remains NOT IMPLEMENTED** by this narrow
slice — the ratified policy is **branch-scoped only**.
**`FR-PLT-026` [M] settings locks remain NOT IMPLEMENTED** by this narrow slice.
**ADR 0008 D-11 (`org.settings` deferred) is unchanged**, including its binding
instruction that whatever is eventually built must carry `tenant_id` and a
scope-aware ownership check from its first migration.

**The Approval Runtime Minimum Resolution — 2026-08-29 is unchanged in every
respect**, specifically: **P-1 remains RATIFIED and UNCHANGED** —
`approval_decisions` references `approval_requests` **directly**; **D-12 remains
BLOCKED**; **D-16's `request_type` ENUMERATION remains OPEN** and **no closed
vocabulary is ratified here**; **D-13 remains RATIFIED — thresholds are
domain-owned**; **the asynchronous half of `FR-SEC-032` remains deferred and
knowingly unmet**; **D-14 A-1 remains unchanged — NO Governance HTTP/API
surface**; **D-20 remains unchanged — NO Governance read surface**; **D-11
remains unchanged — no notification implementation**; **`value` remains an
opaque `JSONB NOT NULL` carrier Governance never parses, with money as base-10
integer strings of minor units**; **the excluded approver remains an Identity
USER id, NOT an Employee id**; and **`expires_at` enforcement semantics
(mandatory, immutable, decision-time validity) remain exactly as ratified**.

**D-1 … D-20, P-1, PL, SB, the P0 closures, the P1A / P1C / P1D carried items,
the Fire Authorization Ratification, the P1F-2 Completion Economics & Depletion
Resolution, the FIFO Exhaustion Carry-Forward Ratification and the Approval
Runtime Minimum Resolution are ALL unchanged — this entry amends none of them.**
**No numbered decision is added, amended by number, or renumbered.** **No new
permission code is created.** **No schema is created by this entry.**

**Implementation consequence.** With R-1(a) … R-5 recorded, the accepted design
gate's **S-3** strategy becomes writable as **migration 33**, Treasury-owned:
a typed, branch-scoped, **immutable, effective-dated** `treasury.cash_close_policies`
carrying `count_mode` (`blind` | `open`, `blind` defaulted under `FR-POS-095`),
a `BIGINT` variance tolerance with **no default**, its currency, a **configured
positive** approval-expiry duration, `tenant_id`, a branch composite foreign
key, `ENABLE` + `FORCE` RLS, append-only grants, audit on write
(`FR-AUD-006` — *"configuration changes"*), `settings.branch.manage` write
authorization, and a Treasury-private resolver.
**Migration 33 is NOT created by this entry**, and **no implementation is
performed by this entry.**

**Status:** **RATIFIED — CLOSED.**

---
## R-6 — Cash Variance Approval Rejection Recovery — RATIFIED 2026-08-30

> **RECORDED 2026-08-30 by explicit user governance action.**
> **NOT a new numbered decision — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).**
> Recorded as an unnumbered ratified entry, matching the **P1A / P1C / P1D**,
> **Fire Authorization**, **P1F-2 Completion Economics**, **FIFO Exhaustion
> Carry-Forward**, **Approval Runtime Minimum Resolution** and **P1G-1
> Cash-Close Policy Ratification** convention.
>
> This entry resolves the single narrow item the CashSession Close design
> track returned as `USER RATIFICATION REQUIRED` across
> `docs/reports/claude/2026-08-30_P1G1_cashsession-close-final-design-gate.md`,
> `…-design-acceptance-closure.md`, `…-final-acceptance-closure.md` and
> `…-migration-compatibility-closure.md`. **Those reports are non-authoritative
> evidence; this entry is the binding record**, and where they differ this
> entry governs. It amends no numbered decision, creates no permission code,
> creates no schema, and does not reopen **P-1**, **D-12**, **D-13**, **D-16**'s
> enumeration, or **R-1(a)…R-5**. **All historical text is preserved verbatim
> above and is NOT rewritten**, superseded forward in the register's
> established manner.

### The question

A CashSession CLOSE may become frozen (`CLOSING`) awaiting a manager's
synchronous `cash.variance.approve` decision on an above-tolerance variance.
No source — the SRS, the Approval Runtime ratifications, or the P1G-1
Cash-Close Policy Ratification — decides what happens to that frozen drawer
when the manager **explicitly rejects** the request. Left unresolved, the
state machine has a reachable exit with no defined recovery, which would
either strand the drawer or require an implementer to invent recovery
behaviour unilaterally.

### RATIFICATION — R-6 CASH VARIANCE APPROVAL REJECTION RECOVERY (2026-08-30)

**RATIFIED — option R-6(a) is binding, verbatim:**

When a manager **explicitly REJECTS** an above-tolerance CashSession close:

1. The CashSession **remains `CLOSING`**.
2. The **physical count remains immutable** — the declared count is never
   re-entered, re-submitted, or altered.
3. **`closeAttemptId` remains unchanged.**
4. The immutable `cash_session_close_attempt` **remains authoritative** for
   every formula term, the policy snapshot, and the declared count.
5. **Payments remain blocked** on the session.
6. **Cash movements remain blocked** — pay-in, pay-out, and safe-drop alike.
7. The CashSession **MUST NOT**: reopen; return to `OPEN`; permit a recount;
   or replace or delete the close attempt.
8. The close **MAY be retried**, using a **NEW** `ApprovalRequest` id and a
   **NEW** `ApprovalDecision` id.
9. The retry **MAY** use **another qualified manager**, and **MAY** carry a
   **different variance reason** than the rejected attempt.
10. **Every rejected `ApprovalRequest` and `ApprovalDecision` remains
    immutable and auditable in Governance** — nothing about a rejection is
    ever edited, deleted, or hidden.
11. A **later APPROVED retry** may transition `CLOSING → CLOSED`.
12. `cash_sessions.variance_reason` on the **final CLOSED** session is the
    reason associated with the **APPROVED** close — never a prior rejected
    attempt's reason.
13. **No supervisor-override or escalation permission is introduced.**
14. **D-12 remains BLOCKED** — this entry does not touch escalation
    semantics in any way.

### Expiry is explicitly OUT OF SCOPE for R-6

**R-6 governs explicit rejection only.** Decision-time approval **expiry is
NOT a business recovery branch** and carries no ratification here, on the
following accepted design evidence:

- the Approval Runtime checks expiry **at decision time**, per **D-10 (E2)**,
  unchanged;
- the synchronous P1G-1 flow computes `expiresAt` from the **database's own
  `statement_timestamp()`**, read immediately before request creation — not
  from `transaction_timestamp()` and not from an application clock;
- if a decision is attempted after `expires_at` has passed, the Approval
  Runtime's RLS `WITH CHECK` rejects the INSERT and the accepted
  implementation **throws**;
- the **whole finalize transaction rolls back**, taking the just-created
  `ApprovalRequest` with it;
- **no expired `ApprovalRequest` survives** — there is no orphan Governance
  state for a business policy to govern;
- the CashSession **remains `CLOSING`**, the immutable close attempt remains
  **untouched**, and a retry creates a **fresh** request with a fresh expiry.

**Expiry is therefore a technical rollback/retry path, not an R-6 business
state, and `D-10` is NOT amended by this entry.**

### Authority classification

**R-6(a) is USER-RATIFIED business behaviour resolving a source-silent
operational recovery question. It is NOT an SRS-derived requirement** — no
FR/BR clause specifies retry-after-rejection semantics for a cash-close
approval. Its selection is **compatible with**, but not **mandated by**:
`FR-POS-095` [M] (blind-count integrity — the immutable count is never
reopened, preserving the control the rejected-option R-6(b) would have
defeated); `FR-FIN-006` [M] (variance approval — a rejected variance remains
genuinely unapproved, and the session does not silently close around it);
`FR-SEC-016` [M] (self-approval prevention — unaffected; every retry is still
subject to the same excluded-approver conjunct); and `FR-SEC-033` [M]
(immutable approval decisions — the rejected decision is never revised,
only superseded by a later, independent one). **None of those requirements
themselves specifies retry-after-rejection**, and no claim to the contrary is
made.

### Preservation

**R-1(a), R-2(a), R-3(a), R-4(a) and R-5 are unchanged.** **D-1 … D-20, P-1,
PL, SB, the P0 closures, the P1A / P1C / P1D carried items, the Fire
Authorization Ratification, the P1F-2 Completion Economics & Depletion
Resolution, the FIFO Exhaustion Carry-Forward Ratification, the Approval
Runtime Minimum Resolution and the P1G-1 Cash-Close Policy Ratification are
ALL unchanged — this entry amends none of them.** In particular: **D-12
remains BLOCKED**; **D-16's `request_type` enumeration remains OPEN**; **P-1
remains RATIFIED and UNCHANGED**; **D-15's narrow one-decision-per-request
amendment is untouched**; the Approval Runtime's self-approval rules and
synchronous manager-PIN semantics are untouched; **D-14 A-1 remains
unchanged — NO Governance HTTP surface**. **No numbered decision is added,
amended by number, or renumbered. No new permission code is created. No
schema is created by this entry.**

**Implementation consequence.** With R-6 recorded, the CashSession Close
design track's sole outstanding `USER RATIFICATION REQUIRED` item is
resolved. **Migration 34 is NOT created by this entry**, and **no
implementation is performed by this entry** — a separate, explicitly
authorised implementation task is required before any product code,
migration, test, or OpenAPI change.

**Status:** **RATIFIED — CLOSED.**

---
## KDS MVP Operator Lifecycle Ratification — 2026-08-30

> **RECORDED 2026-08-30 by explicit user governance action.**
> **NOT a new numbered decision — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).**
> Recorded as an unnumbered ratified entry carrying **two independently
> identifiable limbs**, matching the **P1A / P1C / P1D** carried-item,
> **Fire Authorization**, **P1F-2 Completion Economics**, **FIFO Exhaustion
> Carry-Forward**, **Approval Runtime Minimum Resolution**, **P1G-1 Cash-Close
> Policy** and **R-6** convention.
>
> **Limb identifiers.** These continue the **`KDS-R<n>`** series established by
> the P1E-2 KDS routing design closure (`KDS-R1 … KDS-R10`, of which `KDS-R9`
> is cited in `prisma/schema.prisma`'s `StationRoutingRule` docblock), and
> therefore begin at **KDS-R11**. The ratified cash series `R-1(a) … R-6` is
> deliberately **not** continued, and **`R-7` is deliberately NOT reused**:
> that label is already taken by a **D-20 option** (*"Defer to Appendix C"*) in
> **precisely this subject area** — permission-catalogue source silence — and
> reusing it would make the record ambiguous exactly where it must be clearest.
>
> Occasioned by
> `docs/reports/claude/2026-08-30_KDS_operator-lifecycle-final-design-gate.md`
> and
> `docs/reports/claude/2026-08-30_KDS_operator-lifecycle-design-gate-acceptance-correction.md`,
> **the correction superseding the gate where they differ**. **Those reports are
> non-authoritative evidence; this entry is the binding record**, and where they
> differ this entry governs. The user was **neutral between the tabled options**
> and expressly delegated selection to the architecture recommendation,
> optimizing for **scalability, long-term sustainability, maintainability and
> operational simplicity**; both selected recommendations were **Option A**.
>
> This entry amends **no numbered decision**, creates **no schema**, and does not
> reopen **P-1**, **D-2**, **D-12**, **D-13**, **D-16**'s enumeration, **D-20**,
> or **R-1(a) … R-6**. **All historical text is preserved verbatim above and is
> NOT rewritten**, superseded forward in the register's established manner.

### The questions

Two — and only two — items in the KDS MVP operator-lifecycle design track
returned `USER RATIFICATION REQUIRED`.

1. **No KDS permission code is derivable from source.** SRS **§15.2** contains
   no `kds.*` code, and states that the complete catalogue *"is maintained in
   **Appendix C**"* — **Appendix C is absent from the delivered SRS**. Yet
   **ACT-09** ("Kitchen Staff | One station | KDS") requires Kitchen Staff to
   operate the KDS, **FR-KDS-024** `[M]` requires bump item / bump all,
   **FR-KDS-025** `[M]` requires recall, and this repository's convention is
   that every route is permission-guarded. **An executable KDS surface therefore
   cannot exist without an explicitly ratified permission code.**
2. **The cross-module consequence of recall is source-silent.** §5.5.4 requires
   `ticket.bumped` (Kitchen Ops → Sales) and **UC-POS-01 step 7** requires Sales
   to move the relevant order lines to READY when Kitchen completes them.
   **FR-KDS-025** then requires recall of an already-bumped ticket. The SRS
   never states what becomes of the Sales line whose READY state was caused by
   the bump now being withdrawn. Left unresolved, Kitchen would restore the
   ticket to active work while Sales continued to report the order line as
   READY — a divergence that reaches front-of-house.

### RATIFICATION — KDS-R11: THE `kds.operate` PERMISSION (2026-08-30)

**RATIFIED — binding:**

1. **A new permission code is introduced: `kds.operate`**, described as
   *"Operate a kitchen display station"*.
2. **It authorises exactly this capability surface**, and nothing else:
   station queue read · first-viewed acknowledgement · item start · bump item ·
   bump all · ticket recall.
3. **It is an explicit user-authorized exception to the repository's
   zero-invented-permission-code discipline**, and is the **third** such
   exception on record, following **`pos.order.fire`** (Fire Authorization
   Ratification — 2026-08-24) and **`pos.payment.capture`** (CARRIED ITEM
   P1D-F). The discipline itself is **unchanged and remains in force** for every
   other code.
4. **The coarse grain is deliberate**, selected for operational simplicity and
   long-term maintainability. **The following codes are NOT authorized by this
   entry and MUST NOT be created**: `kds.view`, `kds.ticket.view`,
   `kds.ticket.start`, `kds.ticket.bump`, `kds.ticket.recall`,
   `kds.ticket.serve`, `kds.expedite`.
5. **Reads sit behind `kds.operate`.** No separate KDS read code is created —
   consistent with the existing `pos.order.create` operational-read precedent,
   which likewise declined to invent a read code §15.2 does not supply.
6. **`kds.operate` does NOT represent station authorization**, and must never be
   relied on for it. Station scope is a separate, independently enforced
   concern — see the consequence note below.
7. **No other permission is broadened.** Every existing code keeps its exact
   pre-ratification scope; this limb authorises the KDS operator surface alone.
8. **Should Appendix C ever be supplied and name this capability differently**,
   the code is remapped by the route **ADR 0008 D-01** already provides — the
   same remap path the Catalogue `.read` codes record verbatim
   (*"PROVISIONAL: if Appendix C names them differently, remap per D-01"*).
   Recording that route does not make this ratification provisional.

#### Consequence note — station authorization is NOT this permission

Recorded as a **binding constraint on implementation**, not as a separate
business decision (it is engineering mechanics derived from **ACT-09**, ratified
**ADR 0008 D-16**, and existing session/terminal substrate):

- an **active, registered KDS-type terminal** is required;
- **exactly one** operative station binding must resolve;
- **zero** bindings ⇒ **denied**;
- **more than one** binding ⇒ **denied** as unsupported/misconfigured for this
  slice;
- the supplied `stationId` **must equal** the terminal-derived station;
- an ordinary **POS or dashboard surface cannot operate the KDS** merely by
  holding `kds.operate`.

**D-2's branch-scoped RBAC deferral is UNCHANGED and is not reopened** — station
scope here is a terminal-binding fact under **FR-SEC-021** / **FR-SEC-028**, not
a new RBAC scoping tier.

#### Binding constraints on implementation (mirroring the Fire Authorization Ratification)

- **Do NOT hardcode role-name strings.** Authorization is permission-based.
- The permission **CODE** is added exactly as every other business permission
  code in this repository is added: an entry in the owning module's
  `<MODULE>_PERMISSIONS` / `<MODULE>_PERMISSION_DEFS`, persisted through the
  existing `PermissionsService.upsert`/`upsertMany` mechanism — **code-driven,
  not migration-driven**. **No migration creates this permission.**
- Per the repository's standing rule that a permission is seeded only where an
  executable consumer exists, `kds.operate` is seeded **by the slice that
  creates the KDS routes**, not before.
- **FR-SEC-012** `[M]` requires a plain-language description; the description in
  clause 1 is that text.

### RATIFICATION — KDS-R12: THE `ticket.recalled` DOMAIN EVENT (2026-08-30)

**RATIFIED — binding:**

1. **A new internal domain event is introduced: `ticket.recalled`.**
   **Publisher: Kitchen Ops. Principal subscriber: Sales.**
2. It is recorded as an **EXTENSION of SRS §5.5.4 — "Event Catalogue (Core
   Subset)"**, whose own title declares the catalogue non-exhaustive.
   **The SRS does NOT define `ticket.recalled`, and no claim to the contrary is
   made** — verified: the string occurs nowhere in the delivered SRS, and
   nowhere in this register before this entry.
3. **Business semantics.** When Kitchen **successfully recalls** a previously
   bumped ticket:
   - Kitchen publishes `ticket.recalled`;
   - **Sales consumes it inside the SAME UnitOfWork transaction** as the Kitchen
     recall, consistent with **§5.5.2**;
   - Sales reverts **exactly** the affected order lines whose READY state is
     being withdrawn;
   - the eligible Sales transition is **`ready → fired`**;
   - **`ready_at` is cleared** on those reverted lines.
4. **Sales MUST NOT regress a line that is already `served`, `voided` or
   `comped`.**
5. **Module ownership is preserved.** Kitchen owns the Kitchen lifecycle and
   Kitchen tables; Sales owns Sales order and order-line state. **No direct
   cross-module table query is authorized in either direction.** Communication
   remains through published `contract/` surfaces and domain events, per
   **§5.2.3**.
6. **No schema change is authorized by this limb.** The Sales columns it writes
   (`sales.order_lines.state`, `sales.order_lines.ready_at`) already exist.
7. **`ticket.bumped` is unchanged in publisher and subscribers** (§5.5.4:
   Kitchen Ops → Sales, Analytics). This limb adds a compensating event; it does
   not alter, replace, or reinterpret `ticket.bumped`.

### Future standard-role intent — RECORDED, NOT IMPLEMENTED

Recorded **only** so a future role-seeding implementation does not have to
rediscover the decision:

`kds.operate` is intended for **Kitchen Staff · Head Chef · Branch Manager ·
Shift Supervisor · Owner**, and for **no other standard role**. **Auditor
explicitly does NOT receive it**, because `kds.operate` carries **write**
authority and the Auditor role is read-only.

**This entry does NOT authorize implementation of FR-SEC-010 standard-role
seeding.** **No existing role row and no existing role semantics are modified by
this entry.** As the Fire Authorization Ratification already records, **ROS has
no system-defined "standard role" persistence mechanism**; this mapping is
therefore a **POLICY for whoever creates or administers a tenant's equivalent
roles**, not a migration and not a hardcoded seed of specific role rows.

### What is expressly NOT ratified by this entry

- **The SERIALIZABLE + bounded-retry concurrency mechanism** for the KDS
  bump / bump-all / recall Unit of Work. It is an **engineering correctness
  mechanism**, not a business or governance choice, and is **not ratified as
  one**. It introduces no `SELECT FOR UPDATE`, no new advisory lock, no reliance
  on `AuditService`'s tenant-wide advisory lock, no `sales.orders.version`
  coupling, and **no migration** — so §24.6.4's confinement of pessimistic
  locking is untouched.
- **The first-viewed audit entry.** **FR-AUD-001** `[M]` already decides it: a
  persisted first-viewed acknowledgement is a state-changing operation and is
  therefore audited (one entry per newly-first-viewed Ticket; affected lines as
  metadata; a zero-row replay writes no entry). This is **requirement
  compliance, not a discretionary governance choice**.
- **Any schema, migration, table, column, index, route URL, DTO, audit action
  literal or event payload field.** All remain **design/implementation details,
  NOT ratified here**.
- **`served` / Expediter behaviour (FR-KDS-013 `[S]`), sorting beyond FIFO,
  colour thresholds, FR-KDS-041/042 analytics, the post-fire cancellation path
  (`order.line.voided`), offline KDS (NFR-REL-002), peer discovery
  (NFR-REL-003), and the FR-SEC-026 8-hour KDS session TTL** — all remain
  **DEFERRED and NOT authorized**.

### Authority classification

**KDS-R11 and KDS-R12 are USER-RATIFIED decisions resolving source silence.
Neither is an SRS-derived requirement, and neither is presented as one.**

- **KDS-R11** is *compatible with, but not mandated by*, **ACT-09**,
  **FR-KDS-024** `[M]`, **FR-KDS-025** `[M]`, **FR-SEC-001** `[M]` and
  **FR-SEC-011** `[M]`. **§15.2 supplies no `kds.*` code and Appendix C is
  absent**, so the code name is **not source-determined**.
- **KDS-R12** is *compatible with, but not mandated by*, **§5.5.4**,
  **UC-POS-01 step 7** and **FR-KDS-025** `[M]`. **The SRS specifies no
  recall consequence for Sales.**

**D-20 is NOT reopened, contradicted, or amended.** D-20's *"permission-code
decision DEFERRED, not invented"* is scoped to a **Governance approval-read**
code (`governance.approval.read`) for a surface **D-14 A-1 removed** — there was
no route needing a code, so deferral cost nothing. **KDS has the opposite
posture**: `[M]` requirements demand an executable, permission-guarded surface,
so deferral is not available and the register's own established remedy — an
explicitly user-authorized code, as for `pos.order.fire` and
`pos.payment.capture` — applies instead. **D-20's own R-1 … R-7 option labels
remain what they always were: options that were NOT introduced.**

### Preservation

**D-1 … D-20, P-1, PL, SB, the P0 closures, the P1A / P1C / P1D carried items,
the Fire Authorization Ratification, the P1F-2 Completion Economics & Depletion
Resolution, the FIFO Exhaustion Carry-Forward Ratification, the Approval Runtime
Minimum Resolution, the P1G-1 Cash-Close Policy Ratification and R-1(a) … R-6
are ALL unchanged — this entry amends none of them.** In particular: **D-2's
branch-scoped RBAC defer remains in force**; **D-12 remains BLOCKED**;
**D-16's `request_type` enumeration remains OPEN**; **D-13 remains RATIFIED**;
**D-14 A-1 and D-20 remain unchanged — NO Governance HTTP or read surface**;
**P-1 remains RATIFIED and UNCHANGED**; the P1E-2 KDS routing decisions
**KDS-R1 … KDS-R10** and the P1E-4/P1E-5 Ticket lifecycle and Kitchen ownership
decisions are **unchanged and not reopened**; **§5.5.4's `ticket.bumped`
publisher and subscribers are unchanged**. **No numbered decision is added,
amended by number, or renumbered. No schema is created by this entry.**

### Implementation consequence

With **KDS-R11** and **KDS-R12** recorded, the KDS MVP operator-lifecycle design
track has **no outstanding `USER RATIFICATION REQUIRED` item**, and the slice is
**GOVERNANCE-UNBLOCKED**.

**No migration is created by this entry, and no implementation is performed by
it.** A separate, explicitly authorised implementation task is required before
any product code, migration, permission seeding, test, or OpenAPI change.

**Status:** **RATIFIED — CLOSED.**

---
## Minimum Operational Reporting Ratification — 2026-08-31

> **RECORDED 2026-08-31 by explicit user governance action.**
> **NOT a new numbered decision — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).**
> Recorded as an unnumbered ratified entry carrying **three independently
> identifiable limbs**, matching the **P1A / P1C / P1D** carried-item,
> **Fire Authorization**, **P1F-2 Completion Economics**, **FIFO Exhaustion
> Carry-Forward**, **Approval Runtime Minimum Resolution**, **P1G-1 Cash-Close
> Policy**, **R-6** and **KDS MVP Operator Lifecycle** convention.
>
> **Limb identifiers.** These open a NEW **`RPT-R<n>`** series — `RPT-R1`,
> `RPT-R2`, `RPT-R3` — verified unused anywhere in this register before this
> entry. Three existing series are deliberately **not** continued: the cash
> series **`R-1(a) … R-6`** (whose bare `R-<n>` labels additionally collide
> with **D-20's own option labels `R-1 … R-7`**, one of which — `R-7`,
> *"Defer to Appendix C"* — sits in **precisely this subject area**,
> permission-catalogue source silence, where the record must be clearest);
> the KDS series **`KDS-R1 … KDS-R12`** (a different domain); and the
> numbered **`D-<n>`** series (no numbered decision is created).
>
> Occasioned by
> `docs/reports/claude/2026-08-31_MINIMUM-reporting-final-design-gate.md`
> and
> `docs/reports/claude/2026-08-31_MINIMUM-reporting-design-gate-acceptance-correction.md`,
> **the acceptance correction superseding the gate where they differ**.
> **Those reports are non-authoritative evidence; this entry is the binding
> record**, and where they differ this entry governs.
>
> **The user's ratification statement, verbatim:**
> *"موافق، اعتمد القرارات 1 و2 و3."* — *"Agreed, ratify decisions 1, 2 and 3."*
> The three decisions are those tabled in the acceptance correction's §18.
>
> This entry amends **no numbered decision**, creates **no schema**, and does
> not reopen **P-1**, **D-2**, **D-12**, **D-13**, **D-16**'s enumeration,
> **D-14 A-1**, **D-20**, **R-1(a) … R-6**, **KDS-R1 … KDS-R12**, or
> **CARRIED ITEM P1C-1**. **All historical text is preserved verbatim above
> and is NOT rewritten**, superseded forward in the register's established
> manner.

### The questions

Three — and only three — items in the Minimum Operational Reporting design
track returned `USER RATIFICATION REQUIRED` after the acceptance correction.

1. **No concrete report permission code is derivable from source.** SRS
   **§15.2** supplies the **template** `report.view.<category>` and the code
   `report.export`, and states the complete catalogue *"is maintained in
   **Appendix C**"* — **Appendix C is absent from the delivered SRS**. §19.3
   supplies the **category vocabulary** (Sales · Inventory · Kitchen ·
   Financial · Workforce · Governance) as report-group headings, not as
   permission tokens. This repository already records the gap **in code**:
   `treasury.controller.ts` lists the X report as *"authorization NOT
   SOURCE-DECIDABLE (no `cash.x_report`, **`report.view.<category>`
   unenumerated**)"*. Every route in this repository is permission-guarded and
   **no existing code covers the surface truthfully** — reusing
   `pos.order.create` would hand every cashier the branch's whole daily
   financial position, and `cash.session.close`/`_other` are write
   authorities. **An executable reporting surface therefore cannot exist
   without an explicitly ratified permission code.**
2. **Shipping the Internal-MVP read surface leaves four `[M]` requirements
   knowingly unmet.** `FR-RPT-001` (read replica), `FR-RPT-002` (rollups),
   `FR-RPT-003` (incremental/rebuildable rollups) and `FR-RPT-005` (Type-2
   dimensions) are **architecture** requirements. A query-time aggregation
   over the transactional primary does not satisfy any of them. Whether to
   build the operational read **now** in that condition is a sequencing
   decision only project governance can take.
3. **The Average Order Value numerator is source-silent.** The SRS names AOV
   in five places — `FR-FIN-022`'s Z report, §19.3 *Sales by Employee*, §19.3
   *Average Order Value Trend*, the §12.1 employee-metric list and the §18.x
   customer-profile list — and **defines a formula in none of them**.
   Repository source is likewise silent. The choice is user-visible: a
   manager reads one number.

---

### RATIFICATION — RPT-R1: THE `report.view.sales` + `report.view.financial` PERMISSIONS (2026-08-31)

**RATIFIED — binding:**

1. **Two new permission codes are introduced:**
   **`report.view.sales`**, described as *"View sales reports"*, and
   **`report.view.financial`**, described as *"View financial reports"*.
2. **BOTH are required together** on the Minimum Operational Reporting
   composite daily-trading route — **`mode: 'all'` (AND), never OR**. A
   principal holding only one of the two is refused. The existing
   `@RequirePermission(...)` default and `PermissionGuard`'s
   `codes.every(...)` evaluation are the mechanism; **no new authorization
   capability is invented**.
3. **The route authorised by this limb is exactly:**
   **`GET /reports/branches/{branchId}/daily-trading/{businessDay}`** —
   one branch, one business day, dashboard-only, read-only. **No other route
   is authorised by these codes.**
4. **They instantiate a source-supplied pattern.** §15.2 supplies the template
   `report.view.<category>`; §19.3 supplies the categories. The composite
   response genuinely spans **both**: *Sales Summary* and *Sales by Tender*
   are §19.3 **Sales** reports; *Cash Reconciliation* and *Tax Summary* are
   §19.3 **Financial** reports. Requiring both is the only gating that neither
   over-grants nor mislabels.
5. **These are the FOURTH and FIFTH explicit user-authorized exceptions** to
   the repository's zero-invented-permission-code discipline, following
   **`pos.order.fire`** (Fire Authorization Ratification — 2026-08-24),
   **`pos.payment.capture`** (CARRIED ITEM P1D-F) and **`kds.operate`**
   (KDS-R11). **The discipline itself is unchanged and remains in force** for
   every other code. Unlike the prior three, §15.2 supplies the **pattern**
   and §19.3 the **category vocabulary**, so only the concrete instantiation
   is user-ratified — a materially **weaker** form of invention, and it is
   recorded as such rather than overstated in either direction.
6. **The following codes are NOT authorized and MUST NOT be created:**
   `report.export`, `report.view.daily_trading`, `report.view.inventory`,
   `report.view.kitchen`, `report.view.workforce`, `report.view.governance`,
   and **any other `report.view.*` code**. `report.view.daily_trading` is
   specifically refused: `daily_trading` is **not a §19.3 category**.
7. **Reads sit behind these two codes.** No separate report-read code is
   created — consistent with the `pos.order.create` and `kds.operate`
   operational-read precedents, which likewise declined to invent a read code
   §15.2 does not supply.
8. **No existing permission is broadened.** Every existing code keeps its
   exact pre-ratification scope. In particular `pos.order.create`,
   `inventory.view`, `inventory.cost.view`, `settings.branch.read` and every
   `cash.*` code are **unchanged**, and none is repurposed as a report-read
   authority.
9. **These codes carry NO branch scope** and must never be relied on for it —
   directly parallel to **KDS-R11 §6**. Branch scope is a separate,
   independently enforced concern; see the consequence note below.
10. **ADR 0008 D-01 remap route, recorded.** **Should Appendix C ever be
    supplied and name these categories differently**, the codes are remapped
    by the route **ADR 0008 D-01** already provides — the same remap path the
    Organisation and Catalogue `.read` codes record verbatim (*"PROVISIONAL:
    if Appendix C names them differently, remap per D-01"*). **Recording that
    route does not make this ratification provisional.**

#### Future standard-role intent — RECORDED ONLY, NOT IMPLEMENTED

Following **KDS-R11 §4.3**, which recorded role intent without seeding it:

- **Likely holders of BOTH codes:** **Owner · Operations Director · Branch
  Manager · Accountant · Auditor**.
- **NOT resolved by this entry, and deliberately left open:** **Brand
  Manager** (§15.3: *"Menu, pricing, reports; no financial approval"* — an
  approval restriction is not self-evidently a read restriction) and **Shift
  Supervisor** (§15.3 is silent on reports). These remain **future
  role-seeding questions**.
- **NOT granted:** **Cashier · Waiter · Kitchen Staff · Head Chef ·
  Storekeeper** — none is a reporting role — **unless a future ratified
  role-seeding decision explicitly says otherwise**.

> **`FR-SEC-010` standard-role seeding is NOT authorized by this entry. No
> role row, role_permission row, or role semantic is created or modified.**

#### Binding constraints on implementation (mirroring KDS-R11)

- **Do NOT hardcode role-name strings.** Authorization is permission-based
  (**D-3**).
- The codes are added **code-driven, not migration-driven** — entries in the
  owning module's `<module>.permissions.ts` plus `PermissionDef`s registered
  through the existing `PermissionsService.upsertMany`, and **seeded only by
  the slice that creates the route**, per the standing rule recorded in
  `treasury.permissions.ts` (*"a code with no route behind it is appearance
  without capability"*).
- **No migration, no schema change, no RLS change** is authorised for the
  permission codes or for anything else in this entry.

---

### RATIFICATION — RPT-R2: INTERNAL-MVP REPORTING SEQUENCING (2026-08-31)

**RATIFIED — binding:**

1. **The Internal-MVP operational daily-trading read surface is AUTHORISED to
   be implemented now**, using **query-time aggregation over the
   transactional primary**.
2. **Simultaneously, and without qualification:**

   | Requirement | Pri | Status |
   |---|---|---|
   | **`FR-RPT-001`** — analytical queries against a read replica | `[M]` | **NOT IMPLEMENTED** |
   | **`FR-RPT-002`** — hourly/daily/weekly/monthly pre-aggregated rollups | `[M]` | **NOT IMPLEMENTED** |
   | **`FR-RPT-003`** — incrementally updated, fully rebuildable rollups | `[M]` | **NOT IMPLEMENTED** |
   | **`FR-RPT-005`** — Type-2 slowly-changing dimensions | `[M]` | **NOT IMPLEMENTED** |

3. **This is NOT a waiver, NOT a reinterpretation, and NOT a claim of
   completion.** All four remain **open, unmet `[M]` requirements** counted
   against the Reporting domain, exactly as **`FR-SEC-032`** is already
   recorded as knowingly unmet under **D-2**.
4. **No artefact may claim otherwise.** No report, register entry, INDEX row,
   code comment, OpenAPI description or commit message produced by this slice
   may state or imply *"FR-RPT-001/002/003/005 waived"* or *"…complete"*.
5. **This limb authorises the SEQUENCING ONLY.** It does **NOT** authorise a
   **read replica**, a **star schema**, any **`fact_*`** or **`dim_*`** table,
   **Type-2 dimensions**, **rollup persistence**, a **report cache**, an
   **export pipeline**, or an **analytics warehouse**. The reporting module
   owns **zero tables and zero migrations**.
6. **`FR-RPT-004`** `[M]` — data-as-of timestamp plus explicit indication that
   the period is incomplete — **MAY be implemented in full by this slice**.
7. **`FR-RPT-042`** `[M]` (drill-down to contributing transactions) remains
   **NOT IMPLEMENTED**. **`FR-RPT-043`/`FR-RPT-044`** `[M]` (export and export
   audit) remain **NOT IMPLEMENTED**; no export route and no `report.export`
   code is created. **`FR-RPT-030 … 034`**, **`FR-RPT-040`/`041`**,
   **`FR-RPT-045`/`046`** and **`FR-RPT-047`** remain **NOT IMPLEMENTED**.
8. **`FR-FIN-010`** `[M]` remains **PARTIAL**. Per-day tender reporting for
   the **two implemented tenders** (`cash`, `manual_external_card`) may be
   added. ***"Each card scheme"* remains UNSATISFIED** — `card_scheme` is
   optional, unvalidated, cashier-typed free text and no integrated payment
   terminal exists (`FR-POS-064` NOT IMPLEMENTED). **The nine unimplemented
   tender families remain UNSATISFIED.**
9. **§19.3 *Cash Reconciliation* is delivered as PARTIAL**, per the accepted
   acceptance correction: **payment-contributing sessions only**;
   **whole-session close facts**, explicitly scoped as such; **zero-payment
   and movement-only session attribution NOT IMPLEMENTED** — no business-day
   anchor exists on `treasury.cash_sessions`, `workforce.shifts`,
   `treasury.cash_movements` or `treasury.cash_session_close_attempts`, and
   **none is invented**; and **NO day-level variance total is produced**,
   because a session spanning two business days would contribute its single
   whole-session variance to both days.
10. **`FR-FIN-020 … 026` remain NOT IMPLEMENTED.** DayClose, the **Z report**
    and the **X report** are untouched, and **this slice does NOT provide
    `FR-FIN-021`'s blocking-session list** — that requires every open session
    of the branch, which a payment-derived session set cannot see. DayClose
    remains a separate slice with its own design gate.
11. **`FR-AUD-008` remains a knowingly unsatisfied gap**, unchanged by this
    entry — **D-20 clause 9** stands.
12. **Ordinary report `GET` requests generate NO `FR-AUD-001` business audit
    entry.** `FR-AUD-001` binds state-changing operations; `FR-AUD-006`'s
    always-audit list names *"data exports"*, and this slice performs none;
    `FR-AUD-007` binds **audit-log** access, which this route does not touch
    (**D-20 clause 8** — CONDITIONAL — stands).
13. **Nothing is reopened:** **D-2**, **D-20**, **KDS-R11**, **KDS-R12** and
    **CARRIED ITEM P1C-1**'s Receipt/fiscal exclusion are **unchanged**.

---

### RATIFICATION — RPT-R3: AVERAGE ORDER VALUE NUMERATOR (2026-08-31)

**RATIFIED — binding:**

1. **`averageOrderValue` = `netSales ÷ completedOrderCount`.**
2. **Rounding: HALF_UP to minor units**, using the repository's approved exact
   integer money/rounding mechanism (`divideRounded` with
   `RoundingMode.HALF_UP`, **BR-FIN-001**). **No floating-point money.**
3. **When `completedOrderCount = 0`, `averageOrderValue` is `null`** — not
   `"0"`. An average of nothing is undefined, and `"0"` would read as *"the
   average order was worth nothing"*.
4. **`netSales` is the already-source-decided figure**:
   `Gross − Discounts − Refunds − Tax` (**`FR-CST-003`** `[M]`, verbatim).
   **`FR-CST-003` is an SRS finding, not a ratification** — it is recorded
   here only to fix the numerator's meaning, and this entry does not ratify,
   restate or alter it.
5. **The NET basis is a USER-RATIFIED choice resolving source silence, not an
   SRS finding.** The SRS names AOV in five places and defines no formula.
   The choice is *compatible with, but not mandated by*, §13's consistent use
   of **Net Sales** as the canonical revenue denominator
   (`Food Cost % = COGS ÷ Net Sales`; `Prime Cost % ÷ Net Sales`;
   `Sales per Labour Hour = Net Sales ÷ Hours Worked`) and `FR-CST-035`'s
   ledger line *"= Net Sales (excl. tax)"*.
6. **This limb applies to Average Order Value ONLY.** It does **NOT**
   authorise **Food Cost %**, **Prime Cost %**, **gross-margin %**,
   **contribution margin**, **items per order**, **upsell rate**, **basket-size
   decomposition**, or **any other derived KPI**. **`FR-CST-003` is NOT
   claimed** by this slice, and **no COGS figure is exposed** — doing so would
   silently widen **`inventory.cost.view`**.

---

### Consequence note — the branch fail-closed posture is NOT a fourth ratification

Recorded as a **binding constraint on implementation**, not as a separate
business decision — exactly as **KDS-R11**'s station-authorization consequence
note was recorded (*"engineering mechanics"*). It is derived from existing
substrate and **grants nothing, lifts nothing and relaxes nothing**; it is
strictly **more** restrictive than every existing read route in the
repository:

- the report route requires an **explicit `branchId`** path parameter — there
  is no optional-filter form;
- the target branch **must exist and be visible in the caller's tenant**, or
  the response is a tenant-safe **404** indistinguishable from an unknown id;
- the tenant must resolve to **exactly ONE active branch** for this
  Internal-MVP surface;
- **zero** active branches ⇒ **denied**;
- **more than one** active branch ⇒ **denied as unsupported** for this
  release;
- the supplied `branchId` **must equal** that one active branch;
- **the branch-shape verification executes inside the SAME `RepeatableRead`
  transaction that assembles the report**, so a branch activated or
  deactivated concurrently cannot produce a report assembled under a shape the
  posture refuses.

**`D-2`'s branch-scoped RBAC deferral is UNCHANGED and is not reopened.** The
assertion reads a **tenant-shape** fact (`org.branches.status`), **never a
principal's scope**: it does not consult `identity.membership_roles.branch_id`,
does not populate `TenantContext.branchId`, and does not make `PermissionGuard`
branch-aware. **`FR-SEC-002` / `FR-SEC-003` / `FR-SEC-004` remain NOT
IMPLEMENTED.**

> **Disclosed product consequence, recorded so it is not lost:** a tenant with
> **more than one active branch receives 403 on this route entirely**. This is
> the correct posture for an Internal MVP whose permitted carve-out is
> explicitly *"one branch operationally"*, and the refusal disappears when
> **D-2** is lifted.

### Accepted engineering consequences — NOT ratified, NOT discretionary

The following are **accepted design consequences** of the corrected gate and
are **deliberately NOT recorded as governance decisions**, because none is a
discretionary choice for project governance: the **thin reporting module
owning zero tables**; **`RepeatableRead`** composite snapshot;
**`transaction_timestamp()`** as `dataAsOf`; **a future `businessDay` ⇒ 400**;
**historical transaction-currency selection** (immutable order/payment currency
snapshots preferred over the mutable `org.branches.base_currency`);
**orders-first indexed joins**; **zero migration**; **no day-level variance
total**; **WHOLE_SESSION cash-reconciliation scope**; **tax by class only, no
tax-by-rate**; **zero `KNOWN_DEVIATIONS` growth**; and **no business audit on
an ordinary `GET`**. Exact table/column names, route URLs, DTO field names,
SQL shapes, index decisions and error-code choices remain **implementation
details, NOT ratified here**.

### Authority classification

**RPT-R1, RPT-R2 and RPT-R3 are USER-RATIFIED decisions resolving source
silence or project sequencing. None is an SRS-derived requirement, and none is
presented as one.**

- **RPT-R1** is *compatible with, but not mandated by*, **§15.2**'s
  `report.view.<category>` template, **§19.3**'s category vocabulary,
  **`FR-SEC-001`** `[M]`, **`FR-SEC-010`** `[M]` and **`FR-SEC-011`** `[M]`.
  **§15.2 supplies no concrete `report.view.*` token and Appendix C is
  absent**, so the code names are **not source-determined**.
- **RPT-R2** is a **sequencing authorisation**, not a requirement finding. It
  changes the *order of work*, never the *status* of
  `FR-RPT-001/002/003/005`, which stay **NOT IMPLEMENTED**.
- **RPT-R3** is *compatible with, but not mandated by*, **§13**'s ratio
  definitions and **`FR-CST-035`**. **The SRS defines no AOV formula.**

**D-20 is NOT reopened, contradicted, or amended.** D-20's *"permission-code
decision DEFERRED, not invented"* is scoped by its own stated Question to a
**Governance approval-read** code for a surface **D-14 A-1 removed** — there
was no route needing a code, so deferral cost nothing. **Reporting has the
opposite posture**, identical to KDS's: an executable, permission-guarded
surface is required, so deferral is not available and the register's own
established remedy — an explicitly user-authorized code, as for
`pos.order.fire`, `pos.payment.capture` and `kds.operate` — applies instead.
**D-20's own `R-1 … R-7` option labels remain what they always were: options
that were NOT introduced**, and `R-7` is not reused by this entry.

**`report.export` is NOT created.** D-20's and `FR-AUD-008`'s reliance on it is
unchanged, and `FR-AUD-008` remains a knowingly unsatisfied gap.

### Preservation

**D-1 … D-20, P-1, PL, SB, the P0 closures, the P1A / P1C / P1D carried items,
the Fire Authorization Ratification, the P1F-2 Completion Economics & Depletion
Resolution, the FIFO Exhaustion Carry-Forward Ratification, the Approval
Runtime Minimum Resolution, the P1G-1 Cash-Close Policy Ratification,
R-1(a) … R-6, and the KDS MVP Operator Lifecycle Ratification
(KDS-R11 / KDS-R12) are ALL unchanged — this entry amends none of them.**
In particular: **D-2's branch-scoped RBAC defer remains in force**;
**D-12 remains BLOCKED**; **D-16's `request_type` enumeration remains OPEN**;
**D-13 remains RATIFIED**; **D-14 A-1 and D-20 remain unchanged — NO
Governance HTTP or read surface**; **P-1 remains RATIFIED and UNCHANGED**;
**CARRIED ITEM P1C-1's Receipt/fiscal exclusion stands, untouched**;
**KDS-R1 … KDS-R12 are unchanged and not reopened**. **No numbered decision is
added, amended by number, or renumbered. No schema is created by this entry.**

### Implementation consequence

With **RPT-R1**, **RPT-R2** and **RPT-R3** recorded, the Minimum Operational
Reporting design track has **no outstanding `USER RATIFICATION REQUIRED`
item**, and the slice is **GOVERNANCE-UNBLOCKED**.

Downstream implementation may consume the **acceptance-corrected design gate**
together with these three ratified limbs. **No further user ratification is
required unless current source disproves a ratified assumption** — in which
case the implementation task must STOP and report, not proceed.

**No migration is created by this entry, no schema is authorised, and no
implementation is performed by it.** No product code, migration, permission
seeding, test, or OpenAPI change was made. A separate, explicitly authorised
implementation task is required before any of those.

**Status:** **RATIFIED — CLOSED.**

---
## Day Close Ratification — 2026-08-31

> **RECORDED 2026-08-31 by explicit user governance action.**
> **NOT a new numbered decision — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).**
> Recorded as an unnumbered ratified entry carrying **three independently
> identifiable limbs**, matching the **P1A / P1C / P1D** carried-item,
> **Fire Authorization**, **P1F-2 Completion Economics**, **FIFO Exhaustion
> Carry-Forward**, **Approval Runtime Minimum Resolution**, **P1G-1 Cash-Close
> Policy**, **R-6**, **KDS MVP Operator Lifecycle** and **Minimum Operational
> Reporting** convention.
>
> **Limb identifiers.** These open a NEW **`DC-R<n>`** series — `DC-R1`,
> `DC-R2`, `DC-R3` — **verified unused anywhere in this register before this
> entry** (`DC-R` and the bare `DC-` prefix both returned zero occurrences).
> Four existing series are deliberately **not** continued: the cash series
> **`R-1(a) … R-6`** (whose bare `R-<n>` labels collide with **D-20's own
> option labels `R-1 … R-7`**); the KDS series **`KDS-R1 … KDS-R12`** and the
> Reporting series **`RPT-R1 … RPT-R3`** (different domains); and the numbered
> **`D-<n>`** series (no numbered decision is created).
>
> Occasioned by, in supersession order:
> `docs/reports/claude/2026-08-31_DAYCLOSE-final-design-gate.md`,
> `docs/reports/claude/2026-08-31_DAYCLOSE-design-gate-acceptance-correction.md`,
> `docs/reports/claude/2026-08-31_DAYCLOSE-pre-ratification-final-correction.md`
> and
> `docs/reports/claude/2026-08-31_DAYCLOSE-activation-mechanic-final-correction.md`,
> **each later correction governing the earlier reports where they differ**.
> **Those reports are non-authoritative evidence; this entry is the binding
> record**, and where they differ this entry governs.
>
> **The user's ratification statement, verbatim:**
> *"موافق، اعتمد DC-R1 وDC-R2 وDC-R3."* — *"Agreed, ratify DC-R1, DC-R2 and
> DC-R3."*
>
> This entry amends **no numbered decision**, creates **no schema**, and does
> not reopen **P-1**, **D-2**, **D-12**, **D-13**, **D-16**'s enumeration,
> **D-14 A-1**, **D-20**, **R-1(a) … R-6**, **KDS-R1 … KDS-R12**,
> **RPT-R2**, **RPT-R3**, or **CARRIED ITEM P1C-1**. **RPT-R1 is narrowly
> EXTENDED, explicitly and only as stated in DC-R3 — never silently
> superseded.** **All historical text is preserved verbatim above and is NOT
> rewritten**, superseded forward in the register's established manner.

### The questions

Three — and only three — items in the Day Close design track returned
`USER RATIFICATION REQUIRED` after the corrected gate.

1. **`FR-FIN-022` [M] cannot be fully produced from persisted facts.** Tax by
   rate is not derivable (only the `FR-FIN-032` component **sum** is
   persisted); sales by category has no snapshot on `sales.order_lines` and
   would require joining a permanently sealed document to **mutable**,
   many-to-many master data. `FR-FIN-026` [M]'s four trigger limbs are all
   unavailable. **May the operational DayClose ship while those limbs stay
   explicitly unmet?** This is a **sequencing** question; no user choice can
   conjure data that is not persisted.
2. **Which business day owns a spanning CashSession's whole-session
   variance?** A session's payments can span two business days — the accepted
   Reporting slice emits `businessDayCount` precisely because it occurs. §16.5
   is **silent** on which day owns that session's single whole-session
   variance. This is a **business-semantics** question.
3. **What authorises the historical Z read?** `cash.day.close` is a **WRITE**
   authority (§15.2, *"Close the business day"*), and this repository has
   already refused that class of reinterpretation once. §15.2's Cash family
   contains **no read code**, and §15.2's designated authority for the full
   catalogue — **Appendix C — is ABSENT from `ROS_SRS_v1.0.pdf`** (the
   document ends at §29.5), the same absence **D-20** records.

---

### RATIFICATION — DC-R1: INTERNAL-MVP DAY CLOSE SEQUENCING (2026-08-31)

**RATIFIED — binding:**

1. **The Internal-MVP operational Day Close capability is AUTHORISED to be
   implemented now** — the state-changing **Treasury** DayClose aggregate and
   its minimum persisted Z/DayClose historical surface.
2. **Implemented by this authorisation:** **`FR-FIN-020`** (per-branch
   business-day close operation); **`FR-FIN-021`** **in full — both limbs**
   (blocked while any branch cash session remains open, **and** the blocking
   sessions are listed), over **every** branch cash session with
   `status <> 'closed'`, unqualified by business day; **`FR-FIN-023`**
   (sequential per-branch Z numbering, immutability, historical retrieval —
   retrieval authorised by **DC-R3**). **`FR-FIN-024`** is **already COMPLETE**
   and is reused, never reimplemented.
3. **Simultaneously, and without qualification — `FR-FIN-022` [M] remains
   PARTIAL.** These mandatory limbs remain **NOT IMPLEMENTED**:

   | Limb | Why |
   |---|---|
   | **tax by rate** | `FR-FIN-032` permits multiple tax components; only the component **sum** is persisted (`order_lines.tax_amount`). Per-component rate and base exist nowhere. Deriving a statutory rate from rounded money is refused |
   | **sales by category** | `sales.order_lines` carries **no category snapshot**; `catalogue.menu_items` deliberately carries no `category_id`; placement is the **many-to-many** `catalogue.menu_item_placements`. Aggregating would bind a permanently sealed document to **mutable** master data and be ambiguous for a multi-placed item |
   | **comp** half of *void and comp summary* | **structurally zero** — no code path writes `state:'comped'`. *(The **void** half **is** implemented: pre-fire voids are written with `voided_by` and a reason CHECK.)* |
   | **sales by tender** | **PARTIAL** — two implemented tenders only; ***each card scheme*** and the nine unimplemented tender families remain **UNSATISFIED**, exactly as **RPT-R2 clause 8** already records |

   Gross sales, discounts, refunds, net sales, transaction count, average
   order value, cash reconciliation and the variance summary **are**
   implemented.
4. **`FR-FIN-026` [M] remains PARTIAL — all four trigger limbs unmet:**
   - **fiscal document finalisation — NOT IMPLEMENTED.** **No
     fiscal-finalisation capability is implemented**, and **no fiscal
     documents currently exist to finalise**. **An empty set is NOT
     compliance**: this limb may **never** be described as *"satisfied"*,
     *"vacuously satisfied"* or *"complete by absence"*. **CARRIED ITEM
     P1C-1's Receipt/fiscal exclusion is untouched and is not reopened.**
   - **inventory day-end snapshot — NOT IMPLEMENTED.** No dated snapshot
     exists; `inventory.stock_levels` is a live projection with no date
     dimension.
   - **report pre-aggregation — NOT IMPLEMENTED, and remains excluded by
     RPT-R2** (clause 2 records `FR-RPT-002`/`FR-RPT-003` NOT IMPLEMENTED;
     clause 5 forbids rollup persistence, `fact_*`/`dim_*` tables and any
     analytics warehouse). **Day Close MUST NOT implement it.**
   - **accounting export generation — NOT IMPLEMENTED.** `FR-RPT-043` remains
     NOT IMPLEMENTED (**RPT-R2 clause 7**) and the required external-delivery
     substrate is absent: **no transactional outbox exists**, while §5.5.3
     makes it **mandatory (`FR-PLT-041`)** for exactly this class of effect.
     **No fire-and-forget external call may be substituted.**
5. **`FR-FIN-025` [S] remains NOT IMPLEMENTED.** No scheduler, no per-branch
   enablement flag, and no force-close-and-flag semantics are authorised or
   built.
6. **This is NOT a waiver, NOT a reinterpretation, and NOT a claim of
   completion.** Every limb in clauses 3–5 remains an **open, unmet
   requirement** counted against its domain — exactly as **RPT-R2 clause 3**
   records `FR-RPT-001/002/003/005` and as **`FR-SEC-032`** is recorded under
   **D-2**. **It is sequencing only.**
7. **No artefact may claim otherwise.** No report, register entry, INDEX row,
   code comment, OpenAPI description or commit message produced by this slice
   may state or imply **"`FR-FIN-022` waived"**, **"satisfied with a
   subset"**, **"the Z report is fully compliant"**, or
   **"`FR-FIN-020 … 026` COMPLETE"**.
8. **The Day Close state-changing aggregate is distinct from full Z-content
   compliance.** What ships is a **complete `FR-FIN-020`/`021`/`023` close
   aggregate** carrying an **Internal-MVP Z snapshot whose content obligation
   (`FR-FIN-022`) is PARTIAL**. Both facts are stated together, always, and the
   response carries a machine-readable scope block naming each unmet limb.
9. **Nothing is reopened:** **RPT-R2**, **CARRIED ITEM P1C-1** and **D-2** are
   unchanged.

---

### RATIFICATION — DC-R2: CLOSE-BUSINESS-DAY VARIANCE OWNERSHIP (2026-08-31)

**RATIFIED — binding:**

1. **WHOLE-SESSION CashSession close facts — above all the variance — are owned
   EXACTLY ONCE by the business day in which that CashSession itself becomes
   `CLOSED`.** The rule's name is **CLOSE-BUSINESS-DAY OWNERSHIP**.
2. **Derivation and persistence.** An immutable `closedBusinessDay` is derived
   at CashSession **final-close** time, using the **same authoritative
   business-day resolver already used by Sales** (the single
   `resolveBusinessDay`/`cutoverLookup` implementation that `FR-FIN-024` and
   Order creation share). **No second business-day algorithm is created.**
3. **It is NEVER historically re-derived** from `org.branches.timezone` or
   `org.operating_hours.business_day_cutover`, both of which are mutable. A
   sealed document must not change meaning because configuration changed.
4. **Spanning sessions.** For a session whose payments touch `D` and `D+1`:
   **day-scoped tender MAY contribute to BOTH `D` and `D+1`**, while the
   **whole-session variance is owned ONLY by the day on which the session
   closes**.
5. **The same CashSession MAY therefore be linked to multiple DayClose
   snapshots** for day-scoped tender and historical record.
6. **An unconditional global uniqueness constraint equivalent to
   `UNIQUE (tenant_id, cash_session_id)` on the DayClose linkage is
   PROHIBITED** — it would silently forbid the legitimate relationship
   clause 5 permits.
7. **Variance MUST NOT double-count across Z reports.** Whole-session figures
   (opening float, expected cash, counted cash, variance, movement totals) are
   **never** emitted as day totals and are labelled **`WHOLE_SESSION`**
   wherever they appear.
8. **Legacy closed sessions carrying `closed_business_day IS NULL` remain
   unknown honestly.** They are **never** backfilled, **never** inferred
   historically, **never** silently assigned to a DayClose, and **never**
   included in any variance summary. **No speculative backfill is
   authorised.**
9. **Zero-payment and movement-only sessions are reached by this rule** — their
   variance is owned exactly once by their closing day, which the accepted
   payment-derived Reporting contract structurally could not see
   (**RPT-R2 clause 9** unchanged).

---

### RATIFICATION — DC-R3: HISTORICAL Z READ AUTHORITY (2026-08-31)

**RATIFIED — binding:**

1. **The existing permission `report.view.financial` is extended narrowly** to
   authorise the historical Day Close / Z read surface:
   **`GET /branches/{branchId}/day-closes/{businessDay}`**.
2. **NO new permission code is created.** This is a **scope extension of an
   already-ratified code**, not an invention, and the repository's
   zero-invented-permission-code discipline is **unchanged and remains in
   force**.
3. **This is an EXPLICIT, USER-RATIFIED EXTENSION of RPT-R1 clause 3**, which
   reads *"The route authorised by this limb is exactly:
   `GET /reports/branches/{branchId}/daily-trading/{businessDay}` … **No other
   route is authorised by these codes.**"* **That clause is hereby extended by
   exactly one additional route and by nothing else.** RPT-R1 is **not**
   silently superseded, and every other RPT-R1 clause — including clause 6's
   NOT-authorized code list and clause 8's *"no existing permission is
   broadened"* as applied to **every other** code — stands unchanged.
4. **Source basis.** SRS §19.3 lists **“Z Report — Statutory day close”** under
   **Financial Reports** — the same §19.3 category from which RPT-R1 drew
   `report.view.financial`. The extension is therefore **category-consistent**,
   not a reinterpretation.
5. **`report.view.sales` is NOT required** on this route and is **not**
   extended: the Z is a Financial report, and requiring the Sales code would
   broaden a second code without cause.
6. **`cash.day.close` remains the separate, source-decided authority for the
   WRITE** — `POST` Day Close — and is quoted verbatim from §15.2 (*"Close the
   business day"*). It is **NOT** a historical-read authority and **MUST NOT**
   be used as one. A write permission is not a read-history permission.
7. **The following codes are NOT authorized and MUST NOT be created:**
   `cash.day.read`, `cash.z.read`, `report.view.z`, `report.view.day_close`,
   and **any other new token**. `report.view.day_close` additionally fails
   RPT-R1 clause 6's own test — `day_close` is **not** a §19.3 category.
8. **The extension MUST NOT be broadened to any other financial route.** It
   authorises exactly the one `GET` named in clause 1.
9. **The code carries NO branch scope** and must never be relied on for it —
   directly parallel to **RPT-R1 clause 9** and **KDS-R11 §6**. Branch safety
   remains the separately enforced tenant-shape assertion; **D-2 is
   unchanged**.
10. **ADR 0008 D-01 remap route, recorded.** Should Appendix C ever be supplied
    and name the categories differently, the code is remapped by the route
    **ADR 0008 D-01** already provides. **Recording that route does not make
    this ratification provisional.**

---

### Consequence notes — NOT ratifications, NOT further user decisions

Recorded as **binding constraints on implementation**, in the manner **KDS-R11**
and **RPT-R2** already used for the same class of item. **None of the following
is a business decision, and no `DC-R4` exists.**

**Activation epoch and the first Day Close command.** The first Day Close
command for a branch **may create the immutable Day Close activation epoch and
return `outcome = ACTIVATED`**; **that transaction COMMITS successfully** and
**does not throw and rely on rollback persistence**. **`activationBusinessDay`
itself is NEVER closeable** — the migration lands *during* a business day, so
that day provably mixes attributed and unattributed session closes.
**`firstEligibleBusinessDay = activationBusinessDay + 1`.** A target day is
closeable only when
**`activationBusinessDay < targetBusinessDay < branchCurrentBusinessDay`**.
**Historical Z is NEVER retroactively manufactured for pre-activation dates** —
`FR-FIN-023` retrieval returns **persisted records only**, and a day with no
persisted Day Close is a **404**. **Legacy closed sessions with unknown
close-business-day attribution are never silently assigned.**

**Concurrency and the business-day cutover.** Order creation and Day Close share
the **existing** `ros_order_number(branchId, businessDay)` serialization fence.
Order creation checks Treasury's public Day Close state **after** acquiring that
fence and **before** its `INSERT`; Day Close acquires the **same** fence before
its final close checks. This prevents a pre-cutover in-flight Order from
committing into a business day after that day has been closed. **SERIALIZABLE is
NOT claimed to solve this race**, and **advisory-lock mechanics are NOT ratified
as business policy** — they are engineering mechanics recorded here only so the
constraint is not lost.

**Also engineering mechanics, and deliberately NOT ratified:** Treasury
ownership of the aggregate · the strictly-past-day close rule · current-day and
future-day refusal · the global `FR-FIN-021` blocker set · the
zero-open-target-day-orders precondition · `cash.day.close` (source-decided) ·
`day.closed` (source-decided, §5.5.4) · `Idempotency-Key` (`FR-API-020`) ·
READ COMMITTED · the Treasury `DAY_CLOSE_STATE_QUERY` contract · Z-number
allocation mechanics · uniqueness constraints · RLS · append-only grants · audit
action literals · the activation mechanic · legacy `NULL` handling · one
additive migration · and exact schema, table, column, index, constraint and
route names.

---

### Authority classification

**DC-R1** is a **sequencing / scope acceptance** decision resolving a conflict
between an `[M]` content obligation and the data that is actually persisted. It
is **user-ratified**, **not** an SRS finding, and it **changes no requirement's
status from unmet to met**.

**DC-R2** is a **user-ratified business decision resolving genuine source
silence**. §16.5 defines a variance summary but never states which business day
owns a spanning session's whole-session variance. The choice is *compatible
with, but not mandated by*, `FR-FIN-007`'s treatment of a closed session as an
immutable unit.

**DC-R3** is a **user-ratified narrow scope extension of an existing ratified
permission**, occasioned by the absence of **Appendix C** — the same absence
**D-20** and **RPT-R1** already record. It is a **materially weaker** form of
authorisation than creating a code, and is recorded as such rather than
overstated in either direction.

### Preservation

**P-1 remains RATIFIED and UNCHANGED. D-12 remains BLOCKED. D-16's enumeration
remains OPEN. D-13 remains RATIFIED. D-14 A-1 and D-20 remain unchanged — no
Governance HTTP or read surface. D-2's branch-scoped RBAC deferral remains IN
FORCE and `FR-SEC-002`/`FR-SEC-003`/`FR-SEC-004` remain NOT IMPLEMENTED.
CARRIED ITEM P1C-1's Receipt/fiscal exclusion is UNTOUCHED. R-1(a) … R-6,
KDS-R1 … KDS-R12, RPT-R2 and RPT-R3 are unchanged. RPT-R1 is extended by
DC-R3 clause 3 and by nothing else.** **No numbered decision is created,
amended or renumbered; the 20-decision tally is unchanged.** **`FR-SEC-010`
standard-role seeding is NOT authorized by this entry — no role row,
`role_permission` row, or role semantic is created or modified.**

### Binding constraints on implementation

- **Do NOT hardcode role-name strings.** Authorization is permission-based
  (**D-3**).
- **`cash.day.close` is added code-driven, not migration-driven** — an entry in
  `treasury.permissions.ts` plus a `PermissionDef` registered through the
  existing `PermissionsService.upsertMany`, **seeded only by the slice that
  creates the route**, per the standing rule already recorded in that file
  (*"a code with no route behind it is appearance without capability"*).
- **`report.view.financial` gains NO new `PermissionDef`** — the row already
  exists, keyed by `code`; DC-R3 changes only which routes require it.
- **No migration, no schema change and no RLS change is authorised for the
  permission codes** by this entry.

### Implementation consequence

With **DC-R1**, **DC-R2** and **DC-R3** recorded, the Day Close design track has
**no outstanding `USER RATIFICATION REQUIRED` item**, and the slice is
**GOVERNANCE-UNBLOCKED**.

Downstream implementation may consume the **Day Close final design gate**, its
**design-gate acceptance correction**, its **pre-ratification final
correction** and its **activation-mechanic final correction** — each later
correction governing the earlier where they differ — together with these three
ratified limbs. **No further user ratification is required unless current source
disproves a ratified assumption** — in which case the implementation task must
STOP and report, not proceed.

**No migration is created by this entry, no schema is authorised, and no
implementation is performed by it.** No product code, migration, permission
seeding, test, or OpenAPI change was made. A separate, explicitly authorised
implementation task is required before any of those.

**Status:** **RATIFIED — CLOSED.**

---

## RCPT-R1 — Internal-MVP Non-Fiscal Receipt Ratification — 2026-09-01

> **RECORDED 2026-09-01 by explicit user governance action.**
> **NOT a new numbered decision — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).**
> Recorded as an unnumbered ratified entry, matching the **Fire Authorization**,
> **P1F-2 Completion Economics**, **FIFO Exhaustion Carry-Forward**,
> **Approval Runtime Minimum Resolution**, **P1G-1 Cash-Close Policy**, **R-6**,
> **KDS MVP Operator Lifecycle**, **Minimum Operational Reporting** and
> **Day Close** convention. A single limb — **RCPT-R1** — collision-checked
> against every existing `-R` series (`KDS-R1…R12`, `RPT-R1…R3`, `DC-R1…R3`,
> `R-1(a)…R-6`) and against no reused prefix.

**RATIFIED — binding:**

1. For the controlled **Internal MVP**, ROS exposes an **itemized receipt
   view for completed orders** — `GET /orders/{businessDay}/{id}/receipt` —
   that is **explicitly non-fiscal** and makes **no claim of legal or fiscal
   invoice compliance**.
2. This is a **sequencing / scope decision only**.
3. It **does NOT waive** any full-SRS fiscal requirement.
4. It **does NOT mark `FR-POS-100` … `FR-POS-106` COMPLETE**. `FR-POS-100`
   becomes **PARTIAL** (the non-fiscal document body only; tax registration
   number, invoice sequence, country-pack-mandated tax breakdown, required
   QR code, the full country-pack element set, and printing all remain
   **NOT IMPLEMENTED** within it). `FR-POS-101`, `FR-POS-102`, `FR-POS-103`,
   `FR-POS-104`, `FR-POS-105` and `FR-POS-106` remain **NOT IMPLEMENTED**,
   unchanged.
5. It **does NOT authorize deployment as a fiscal receipt** in any
   jurisdiction.
6. It **does NOT alter CARRIED ITEM P1C-1** beyond this narrow Internal-MVP
   carve-out. **P1C-1 remains a blocker to the full fiscal receipt** and is
   **NOT globally closed**. The capability creates **no tax document, no
   invoice template, no fiscal submission and no `fiscal.tax_rules` table** —
   P1C-1's four named exclusions (register, above: *"no tax documents,
   invoice templates, fiscal submissions or `fiscal.tax_rules` table"*) are
   each untouched.
7. **Nothing else is reopened:** **P-1** remains RATIFIED and UNCHANGED ·
   **D-12** remains BLOCKED · **D-16**'s enumeration remains OPEN · **D-13**
   remains RATIFIED · **D-2 is not reopened** — no branch-scoped RBAC is
   introduced; authorization stays tenant-scoped, reusing
   `pos.order.create` — · no Governance HTTP or read surface (**D-14 A-1**,
   **D-20**) · **KDS-R1 … KDS-R12**, **RPT-R1 … RPT-R3**, **DC-R1 … DC-R3**,
   **R-1(a) … R-6** all unchanged.
8. This entry **amends no numbered decision**, **creates no schema**, and
   **authorizes no migration**. All historical register text is preserved
   verbatim above and is not rewritten.

**Basis (source-verified, not asserted):**

- The narrow slice is derivable entirely from already-persisted, already-
  frozen Sales facts: `order_lines.item_name_snapshot` /
  `order_line_modifiers.name_snapshot` (BR-POS-004 sale-time `JSONB`
  snapshots, never rewritten), and `BigInt` money/tax columns written once
  at capture or settlement. No Catalogue, Localisation, Organisation,
  Production, Treasury or Identity table is read.
- No new table, column, sequence, index, enum, RLS policy, domain event,
  audit action or permission is required (**MIGRATION: NO**).
- Authorization reuses `pos.order.create` — the same code
  `GET /orders/{businessDay}/{id}` already sits behind, which already
  returns a superset of the receipt's data. `pos.reprint.receipt` (SRS
  §15.2) is deliberately **not** adopted and remains reserved for a future
  `FR-POS-104` reprint-marking-and-logging implementation.
- Full analysis, field-by-field data-source mapping, the historical-
  stability proof, and the requirement classification table are recorded in
  `docs/reports/claude/2026-09-01_INTERNAL-MVP-receipt-narrow-design-
  gate.md` (design gate, verdict **A**) and
  `docs/reports/claude/2026-09-01_INTERNAL-MVP-receipt-implementation-and-
  acceptance.md` (implementation).

**Implementation consequence**

With **RCPT-R1** recorded, the Receipt design track has no outstanding
`USER RATIFICATION REQUIRED` item, and the slice is **GOVERNANCE-UNBLOCKED**.
This entry, together with the accepted design gate, authorizes the exact
route, contract and file plan those documents specify. **No further user
ratification is required unless current source disproves a ratified
assumption** — in which case the implementation task must STOP and report,
not proceed.

**No new fiscal table, invoice sequence, printing subsystem or delivery
channel is authorised by this entry.**

**Status:** **RATIFIED — CLOSED.**

---
## D1-1 — Offline / Sync Protocol Foundation Ratification — 2026-09-02

> **RECORDED 2026-09-02 by explicit user governance action.**
> **Explicitly approved during Full-SRS 4-Day execution after post-design
> acceptance review.**
> **NOT a new numbered decision — no D-21 is created and the 20-decision
> tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN).**
> Recorded as an unnumbered ratified entry, matching the **Fire Authorization**,
> **P1F-2 Completion Economics**, **FIFO Exhaustion Carry-Forward**,
> **Approval Runtime Minimum Resolution**, **P1G-1 Cash-Close Policy**, **R-6**,
> **KDS MVP Operator Lifecycle**, **Minimum Operational Reporting**, **Day Close**
> and **RCPT-R1** convention. The limb prefix — **GD-D1-01 … GD-D1-07** —
> collision-checked against every existing series (`D-1…D-20`, `KDS-R1…R12`,
> `RPT-R1…R3`, `DC-R1…R4`, `R-1…R-7`, `RCPT-R1`, `P-1…P-4`, `SB-1…SB-4`, `PL`)
> and reuses no prefix.

**Subject.** The `D1-1` offline/sync protocol design gate
(`docs/reports/claude/full-srs-4day/2026-09-02_D1-1_offline-sync-design-gate.md`,
commit `50b3706`) presented seven engineering proposals for ratification. This
entry resolves all seven and records five architectural corrections identified
during acceptance review.

**Design gate status: ACCEPTED WITH CORRECTIONS.** The original report is
retained as historical design evidence and is not rewritten; the authoritative
implementation direction is this entry, with the reasoning recorded in
`docs/reports/claude/full-srs-4day/2026-09-02_D1-1_offline-sync-ratification.md`.

---

### Decisions

| Limb | Decision | Outcome |
|---|---|---|
| **GD-D1-01** | Identifier wire form | **RATIFIED** |
| **GD-D1-02** | HLC canonical representation | **RATIFIED WITH CORRECTION** |
| **GD-D1-03** | Bounded server HLC adoption | **DEFERRED** |
| **GD-D1-04** | Fifth per-operation status `deferred` + proposed conflict rules | **RATIFIED** |
| **GD-D1-05** | Reconciliation-exception ownership | **RATIFIED → `sync.revalidation_exceptions`** |
| **GD-D1-06** | Versioning / limits / retention / watermark / tombstones / partitioning bundle | **RATIFIED WITH ARCHITECTURE CORRECTIONS** |
| **GD-D1-07** | Revoked terminal → reject → unsynced backlog lost | **REJECTED** |

**Replacement for GD-D1-07:** **lossless revoked-terminal recovery = HARD
FOLLOW-UP GATE.**

---

**GD-D1-01 — RATIFIED.** Client-generated identifiers remain ULIDs
(`FR-OFF-015` [M]). The permanent 128-bit identifier is rendered on the ROS
wire/API as the repository-standard canonical UUID hexadecimal string. **The
server SHALL NOT remap or reassign the identifier.** Crockford base32 remains an
alternate textual representation of the same ULID, **not** the canonical ROS API
representation. Follows ADR-009 ("or native UUID") and existing repository
storage/API conventions (`src/common/ids.ts`, `UUID_PATTERN`, `@db.Uuid`), and
avoids introducing two incompatible ID encodings into one API. **No product code
change is authorised by this entry.**

**GD-D1-02 — RATIFIED WITH CORRECTION.** The **semantic algorithm is EXACTLY the
normative `FR-OFF-041` algorithm** and may not be varied on either side.
Canonical wire/storage representation:
`<physical_ms>.<logical>.<node>`, where `physical_ms` is **exactly 13**
zero-padded decimal digits of Unix epoch **milliseconds** for the supported
operational date range, `logical` is **exactly 5** zero-padded decimal digits,
and `node` is **exactly 32** lowercase hexadecimal characters (the originating
terminal UUID without dashes). Fixed width so lexical comparison is
deterministic and matches component ordering. **Correction:** the original
report's illustration printed a 16-digit physical segment; the corrected example
is recorded in the ratification report §8.3. The semantic algorithm is unchanged
by that correction, and **no alternative HLC algorithm is invented.** Final
column width / database type is a **`D4-1` implementation detail** derived from
the ratified representation and is **not** ratified here. The historical SRS
inconsistency — **§7.4.1 `VARCHAR(40)` vs §25.2 `VARCHAR(48)`** — remains
recorded as a **source defect**.

**GD-D1-03 — DEFERRED (engineering hardening).** Not ratified. The normative SRS
HLC algorithm and `CT-10` can be implemented and verified without changing
clock-adoption semantics. Per-terminal HLC state and bounded adoption may be
valuable defence-in-depth **but must not alter the normative shared algorithm
without a separate design and conformance proof.** `D4-1` **may** design
extension points for it but **MUST NOT** claim it as ratified behaviour.

**GD-D1-04 — RATIFIED.** The fifth per-operation result **`deferred`** is
ratified. `FR-OFF-022` [M] requires a causal-child operation whose parent is not
yet applied to be **deferred rather than rejected**; `FR-OFF-024` [M] permits
removal from the client outbox **only after a definitive response**. Therefore
`accepted`, `duplicate`, `conflict` and `rejected` are **definitive**, and
**`deferred` is NON-DEFINITIVE** — the client retains a deferred operation and
retries after its causal dependency has been satisfied. The fifth state is a
**protocol clarification needed to make the mandatory SRS clauses jointly
implementable**, not a scope extension.
Also ratified: the `D1-1` proposed conflict rules for the currently-supported
domains — **order void vs payment**, **partitioned overpayment**,
**overlapping/offline cash sessions**, and **KDS ticket state** — subject to
later domain-specific tests. **This does NOT claim currently absent domains such
as CRM/loyalty are implemented.** **Where a domain later defines stricter legal
or fiscal semantics, the domain's ratified rule WINS and the sync conflict
registry must be extended explicitly.**

**GD-D1-05 — RATIFIED → `sync.revalidation_exceptions`.** Canonical persistence
ownership for `FR-OFF-046` reconciliation exceptions belongs to **Sync**. A
revalidation exception originates in the sync protocol and must not create a
cross-lane persistence dependency on `governance.anomaly_flags`. Sync owns
persistence, the relationship to `opId`, client-computed and server-computed
values, `detected_at`, terminal/branch attribution, and the resolution state
sync requires. Governance/Reporting **may consume** domain events, read
contracts and alerts **without owning the underlying sync table.** Exact
table/column names remain implementation details.

**GD-D1-06 — RATIFIED WITH ARCHITECTURE CORRECTIONS.** Approved direction:
explicit `protocolVersion`; per-operation `schemaVersion`; strict envelope
compatibility; explicit payload/batch byte limits; **no silent unknown-field
discard for financial operation envelopes**; reference-data change watermark;
deletion/tombstone mechanism; bounded retention; partitioning for genuinely
high-volume history; retention jobs/reapers. **Subject to:** (a) operation global
uniqueness MUST use the corrected dedup architecture below; (b) final byte-cap
values are **implementation-testable defaults, not immutable business
semantics**; (c) the retention floor must satisfy every applicable SRS
requirement; (d) **partitioning must not break idempotency correctness.**

**GD-D1-07 — REJECTED.** The proposal *"revoked terminal → reject forever →
unsynced committed sales may be lost"* is **NOT an acceptable Full-SRS /
production architecture. The user explicitly rejects knowingly designing
committed-sale loss into the system.**

---

### The five acceptance corrections

**Correction 1 — partitioned history separated from global operation dedup.**
The original design is **NOT ratified** where it simultaneously relied on RANGE
partitioning of `sync_operations` by `received_at` **and** a global
`UNIQUE (tenant_id, op_id)` on that same partitioned table. **PostgreSQL cannot
provide both** — the constraint would necessarily become
`(tenant_id, op_id, received_at)`, which is not global uniqueness, so the same
`op_id` re-submitted across a partition boundary would insert cleanly and
`NFR-REL-011` ("at-most-once financial effect") would fail in exactly the case
it exists for. The design conflict is recorded explicitly. This repository
already documents the underlying constraint at `prisma/schema.prisma:1767`:
*"PostgreSQL requires the partition key inside every unique constraint."*
**Ratified direction — the authoritative architecture SHALL separate:**
**(A) a global operation dedup registry** — a small **non-time-partitioned**
authoritative relation, conceptually `sync.operation_dedup`, owning the globally
enforceable key `(tenant_id, op_id)`, containing enough immutable data to detect
duplicate operation IDs, detect same-`opId`/different-fingerprint defects, return
or locate the original per-operation result, preserve the minimum idempotency
retention guarantee, and **prevent the same financial effect being applied
twice**; exact table name and columns are `D4-1` implementation details — from
**(B) `sync_operations` history** — a high-volume relation that **may** be
time-partitioned for inspection, conflict analysis, audit linkage, operational
history and retention management, and which **MUST NOT be treated as the sole
global uniqueness mechanism** where partitioning prevents enforcing global
`(tenant_id, op_id)` uniqueness.
**Dedup atomicity invariant — RATIFIED.** The dedup registry MUST NOT become a
second non-atomic write that can diverge from the business effect. For every
accepted operation the authoritative operation result / dedup reservation and
the business effect **must participate in a crash-safe protocol.** `D4-1` must
prove a crash can never produce *business effect committed + no durable record
that the `opId` was already applied* in a way that allows double application on
retry; and must never externally acknowledge as `accepted` a case of *dedup says
accepted + business effect never committed*. **Exact transactional
implementation is `D4-1`'s design responsibility.**

**Correction 2 — batch idempotency is crash-recoverable, not "unchanged".**
`sync.idempotency_keys` / `IdempotencyService` **MAY** be reused as the
**foundation** for batch-level idempotency, but the original phrase *"reused
unchanged"* is **NOT ratified**, because `D4-1` requires crash-recoverable batch
processing. The critical case: reservation enters `in_flight`; some operations
commit; the process dies before `complete()` / response persistence; the client
retries the exact batch. **The system MUST NOT leave that batch permanently
trapped as `409 being processed` with no safe recovery path.**
**Ratified required behaviour:** a batch in progress must have a
reclaim/recovery mechanism. Conceptual states may include `in_flight` and
`completed`, plus crash-ownership metadata such as lease / owner / attempt /
`expires_at`; **exact schema is NOT ratified here.** Same `batchId` + same
fingerprint + **live owner** → may report currently processing per
implementation semantics. Same `batchId` + same fingerprint + **stale/dead owner
or expired lease** → **safely reclaim/resume**; on resume, already-applied
`opId`s return duplicate/original result and not-yet-applied `opId`s continue
normally. Same `batchId` + **different fingerprint** → `409` client defect.
**The client must never need to invent a new operation ID merely because the
server process crashed.**
**`FR-OFF-025` invariant — RATIFIED, and part of `D4-1` acceptance:** a server
crash or connection loss during a batch SHALL NOT duplicate an already-applied
operation, permanently strand a valid batch, require loss of acknowledged sales,
require changing `opId`s, or make the outbox unrecoverable.

**Correction 3 — per-operation failure isolation, not mandatory per-operation
commit.** *"One PostgreSQL transaction per operation"* is **NOT ratified** as an
SRS requirement. `FR-OFF-023` [M] requires that **failure of one operation does
not fail the whole batch** — a statement about failure isolation, not commit
granularity. **The ratified invariant is PER-OPERATION FAILURE ISOLATION, not
PER-OPERATION PHYSICAL COMMIT**, and `D4-1` is **authorised to choose an
implementation capable of meeting `NFR-PERF-032`.** `D4-1` **MAY** use: one
pinned database connection per batch; transaction chunks; `SAVEPOINT` per
operation; preloaded reference data; set-oriented reads; set-oriented writes
where business invariants permit; and batched audit persistence **where
compatible with the immutable hash-chain contract.** It **must preserve**, for
each operation: independent semantic status; independent rollback/failure
isolation; correct dedup result; correct business effect; and required
audit/domain-event semantics. **One failed operation MUST NOT convert
independent successful operations into failures.**
**Accepted-operation durability — RATIFIED:** no operation may be returned as
**`accepted`** until its business effect **and** authoritative dedup/result state
are **durably committed**. Where several operations share a chunk transaction,
their `accepted` statuses **cannot be externally final until that chunk
commits**, and **a rollback means those operations are not accepted.**

**Correction 4 — committed backlog loss is not accepted.** See **GD-D1-07 —
REJECTED**, above. **Ratified security rule:** a normally revoked terminal
**must lose ordinary interactive operating authority**, and revocation **MUST
NOT** silently restore the terminal to ordinary trusted status merely because it
claims to hold unsynced transactions; **at the same time, committed offline
financial data must have a controlled, auditable, lossless-recovery path.**
Security and durability are to be **reconciled explicitly rather than solved by
sacrificing one.**
**HARD FOLLOW-UP GATE — LOSSLESS REVOKED-TERMINAL RECOVERY.** A required
follow-up design. Candidate implementations may include quarantine upload-only
recovery, pre-revocation salvage, a recovery credential / one-shot drain, a
replicated recovery spool, or another architecture preserving both properties;
**the final mechanism is NOT ratified here.** **Hard invariants, all binding:**
(1) a revoked terminal does not regain normal POS authority; (2) recovery is
explicitly authorised; (3) recovery is auditable; (4) recovery cannot create new
sales; (5) recovery cannot modify arbitrary server state; (6) operation
idempotency remains enforced; (7) recovered financial operations receive
enhanced provenance / review; (8) a lost/stolen terminal cannot use the recovery
path to escalate authority; (9) legitimate committed transactions are not
silently discarded.
**`D4-1` CORE is authorised to start before the final recovery mechanism is
implemented** and **may initially support active valid terminals only**, but
**`D4-1` MUST NOT be declared FULLY COMPLETE for the revoked-terminal durability
case** until the lossless recovery design is ratified and implemented. **Committed
backlog loss must not be described as accepted behaviour.**

**Correction 5 — the canonical Sync API is versioned `/v1`.** The original
root-only endpoint is **NOT ratified** as the permanent Full-SRS contract. The
canonical Full-SRS external contract for Sync is versioned:
**`POST /v1/sync/batch`**, **`GET /v1/sync/changes`**, **`GET /v1/sync/status`**.
The repository does not yet have a global `/v1` prefix (no `setGlobalPrefix`;
`src/swagger.config.ts` documents the absence), and **Lane D MUST NOT
independently retrofit the entire application routing structure.** **Ratified
split:** `D4-1` owns the Sync controller and business protocol;
**platform/API architecture owns or coordinates the repository-wide versioning
mechanism** (Nest URI versioning, a coordinated `/v1` prefix, or another
repository-wide mechanism — the mechanism is **not** ratified here). **The
resulting external contract for Sync must expose the canonical v1 route. Do not
permanently publish only `/sync/batch` and later claim Full-SRS route
compliance.** Any temporary unversioned compatibility route needed during
migration **must be explicitly temporary/deprecated and must not replace** the
canonical versioned endpoint.

---

### Carried forward unchanged from `D1-1`

**Operation envelope** — `opId` · `hlc` · `type` · `entityId` · `causedBy` ·
`actorEmployeeId` · `occurredAt` · `schemaVersion` · `payload`; batch —
`protocolVersion` · `deviceId` · `batchId` · `lastServerCursor` · `operations`.
**No `tenantId` in the body**; tenant identity is derived from authenticated
server context; **branch identity for a registered terminal is derived
server-side, not trusted from arbitrary client body input.**
**`clientSeq`** — no mandatory `clientSeq` is introduced in `D4-1` unless
implementation evidence shows causal/idempotency correctness requires it;
causality is represented by `causedBy` + HLC and idempotency by `opId` +
`batchId`. **Sequence-gap semantics must not be added without a separate need.**
**Batch HTTP semantics** — a well-formed authorised batch may return HTTP 200
with independent per-operation results; one operation's rejection or conflict
does not transform the whole batch into an HTTP error; envelope-level faults may
still return the appropriate 4xx/5xx.
**`FR-OFF-046` invariant — mandatory `D4-1` invariant:** a financially
significant revalidation mismatch **MUST NOT reject a sale that already
physically occurred.** The server accepts the transaction, records
client-computed values, records server-computed values, persists a
reconciliation exception, and escalates systematic mismatches per `FR-OFF-047`.

**Retention — RATIFIED.** Operation idempotency retention SHALL be **at least
the SRS-required minimum** and **must not be shorter than any client
retry/outbox horizon that could legitimately replay an operation.** A 90-day hot
operation-history target **may** be used as an initial engineering default but is
**NOT** a reason to weaken statutory/financial/audit retention on the underlying
business records. **Sync operation history is not a substitute for statutory
business ledgers.** The retention mechanism **must be automated.** The currently
**unpruned `sync.idempotency_keys` condition remains an implementation gap.**

**Tombstones / delta watermark — MANDATORY for `D4-2`.** Reference-data delta
sync cannot be correct if deletes cannot be represented or there is no
monotonic/change watermark. `D4-2` requires a change-cursor/watermark mechanism,
deletion tombstones or equivalent deletion events, and full checksum
reconciliation. **Not implemented by this entry.**

**Branch RBAC — Lane B governance is NOT altered by this entry.** `D-2` and its
2026-08-19 amendment are untouched; no defer is lifted or reinterpreted.
Branch-scoped authorization remains a **dependency to be consumed from Lane B's
accepted implementation.** Sync MUST ultimately authorise operations against
authenticated tenant, registered terminal, terminal branch, actor/session, and
the required permission/scope **once branch RBAC lands**. **Do not recreate a
parallel permission model inside Sync.**

**Fiscal — unchanged.** The canonical `TaxDocument` / fiscal sequence behaviour
is **NOT invented here**. `D4-3` remains dependent on **`C3-1` / `P7-FISCAL`**.
The generic fiscal operation extension point is kept. **`CT-01`'s
fiscal-sequence criterion remains ungradeable** until the fiscal model is
ratified and implemented.

**Conformance corpus — ratified principle.** Shared client/server algorithms are
governed by a language-neutral conformance corpus; **`kitchen-kit/conformance/`
is the precedent and must be extended rather than replaced.** `D4-1` owns server
vectors for ids, HLC, envelope canonicalization, conflict rules and money where
applicable; other domain owners contribute their own shared logic. Full
`FR-OFF-050` / `FR-OFF-051` completion still requires a Dart/client runner,
dual-suite CI and a release-blocking divergence gate — **none of which are
claimed complete by this entry.**

---

### Measured release gates — RATIFIED, not "future optimization"

**`P-D4-01` — `NFR-PERF-032`, 500 operations / 3 s p95.** Must be **measured
during the earliest `D4-1` implementation iteration**; do not implement the
entire protocol first and benchmark last. Required dimensions: 500 operations;
realistic revalidation; audit writes; dedup writes; conflict checks; commit cost.
**If naive operation-by-operation execution misses the budget, `D4-1` must
optimize the architecture before expanding protocol surface.**

**`P-D4-02` — per-tenant audit hash-chain contention during concurrent
multi-terminal backlog drains.** `D4-1` acceptance must measure a one-terminal
backlog, multiple terminals concurrently draining, audit-chain sequence
contention, deadlock/retry behaviour, and `NFR-PERF-032` impact. **Do not weaken
audit immutability to make the benchmark pass.**

**Both are protocol architecture acceptance criteria.**

---

### Implementation consequence

**`D4-1` CORE is AUTHORIZED.** It may implement: the global operation dedup
registry; time-partitionable operation history if justified; sync batches /
device state / conflict records; `sync.revalidation_exceptions`; the canonical
v1 batch API coordinated with platform versioning; strict operation/batch
envelope validation; the HLC algorithm and canonical representation;
crash-recoverable batch reservation/resume; operation-level idempotency; causal
ordering; `deferred` handling; per-operation failure isolation; conflict
handling **for domains that actually exist**; `FR-OFF-045`/`FR-OFF-046`
revalidation for available computation substrates; skew detection; `FR-OFF-044`
audit writes; required conformance vectors; the early `NFR-PERF-032` benchmark;
and the concurrent audit-contention benchmark.

**`D4-1` must NOT implement:** fiscal sequence semantics; bootstrap / delta /
checksum endpoints; WebSocket push; mDNS / LAN coordinator; the CRM/loyalty
domain; the Dart client; branch RBAC itself; full revoked-terminal recovery
unless separately designed and ratified; or **global repository API versioning
unilaterally.**

**`D4-2`** remains responsible for the full bootstrap snapshot, delta changes,
cursors, watermarks, tombstones/deletions, entity-type checksums and reference
reconciliation. **`D4-3`** remains responsible for fiscal/offline sequence
integration after the canonical fiscal model is available.

**`D4-1` may NOT be closed as FULLY COMPLETE until all three residual hard gates
are satisfied:** lossless revoked-terminal recovery · **`P-D4-01`** ·
**`P-D4-02`**.

---

### No implementation credit is created by this entry

`FR-OFF` requirements are **DESIGN / RATIFICATION ONLY** as applicable and are
**not** marked implementation-complete. **`NFR-PERF-032`: NOT YET VERIFIED.**
**`FR-OFF-050` / `FR-OFF-051`: PARTIAL.** **`CT-01`: NOT PASSED.** **`CT-06`: NOT
PASSED globally.** **`CT-10`: NOT PASSED** until executable conformance/tests
exist. **Fiscal: unresolved** until `P7-FISCAL` / `D4-3`. **Revoked-terminal
lossless recovery: unresolved hard gate.**

**Nothing else is reopened:** **D-2 is not reopened** — no branch-scoped RBAC is
introduced or lifted · **D-9** RLS/tenant-isolation discipline is relied upon
and unchanged · **D-15** idempotency/concurrency is extended in the sync
direction, not amended · **P-1**, **D-12**, **D-13**, **D-16**, **D-14 A-1**,
**D-20**, **KDS-R1 … KDS-R12**, **RPT-R1 … RPT-R3**, **DC-R1 … DC-R4**,
**R-1 … R-7**, **RCPT-R1**, **PL**, **SB-1 … SB-4** all unchanged. This entry
**amends no numbered decision**, **creates no schema**, **authorizes no
migration**, and **changes no product code**. All historical register text is
preserved verbatim above and is not rewritten.

**Evidence (non-authoritative):**
`docs/reports/claude/full-srs-4day/2026-09-02_D1-1_offline-sync-design-gate.md`
(design gate, retained as historical evidence, with an appended post-review
acceptance note) and
`docs/reports/claude/full-srs-4day/2026-09-02_D1-1_offline-sync-ratification.md`
(this ratification's reasoning and verification).

**Status:** **RATIFIED — D4-1 CORE AUTHORIZED; THREE RESIDUAL HARD GATES OPEN.**

---
## Final Decision Matrix

| ID | Decision | SRS-defined? | Existing conflict? | Recommendation | Ratification Required | Dependency | Status |
|---|---|---|---|---|---|---|---|
| D-1 | Approval Request Data Model | **Yes** — `FR-SEC-031` enumerates all six elements | **Yes** — GAP-1, 3 fields absent | Add all three as documented deviation | **RATIFIED 2026-08-17 — option (a)** | D-10 (expiry behaviour) | **RATIFIED** |
| D-2 | PIN / Branch-Scoped RBAC Scope | Requirement yes (`FR-SEC-032`); scope no | No | Core only for phase 1 | **RATIFIED 2026-08-17 — option (a)** | — | **RATIFIED** |
| D-3 | Approval Permission vs Role | **Yes** — `FR-SEC-031`, §26.2, §15.2 tiers | **Yes** — C-2 resolved for the request; C-7 adds a third representation | Permission as authority; no new codes | **RATIFIED IN PART 2026-08-17** | Residual **DEFERRED** with the multi-step chain (D-5 clause 9) | **RATIFIED IN PART** |
| D-4 | Approval Lifecycle / State Model | **No** — no §7.4.x spec exists; only `'pending'` written down | No conflict — **absence** | **Option (b)** `pending → approved \| rejected` | **RATIFIED 2026-08-17 — option (b)** | Expiry stays with D-10; `rejected` storage left to Design Gate | **RATIFIED** |
| D-5 | Approval Steps / Multi-Level | **Semantics yes** — §24.5.3 sequential/first-accept; multi-step `[M]` only via `FR-PRC-018` (Procurement) | **Yes — C-7**, deferred unresolved by clause 7 | **Option (a) SINGLE-STEP** | **RATIFIED 2026-08-17 — option (a)** | Exposes decision→parent linkage question (unresolved) | **RATIFIED** |
| D-6 | Approval Request Mutability | **Partly** — `FR-PLT-003` [M] makes `tenant_id` immutable; SRS silent on all other fields | No conflict identified | **Model B + Mechanism 1** | **RATIFIED 2026-08-17 — B + 1** | D-8, D-9 (policy set designed alongside) | **RATIFIED** |
| D-7 | Self-Approval Prevention | **Yes** — `FR-SEC-016`, `FR-PRC-019`, §7.3 #36 | `CHECK (true)` is an approved-SQL convention, not a defect | **M2 — RLS `INSERT … WITH CHECK` traversal**; no denormalised column, no trigger, not service-only | **RATIFIED 2026-08-17 — M2** | Parent-linkage (concrete predicate); strict-SoD / ADR 0008 D-11 | **RATIFIED** |
| D-8 | Approval Decision Immutability | **Yes** — `FR-SEC-033` requires immutability; no-DELETE is an **architectural ratification** | Tension recorded: approved SQL supplies `ON DELETE CASCADE` | **Option 1 — FULL APPEND-ONLY** | **RATIFIED 2026-08-17 — Option 1** | Cascade verification carried to Design Gate; D-9 owns policies | **RATIFIED** |
| D-9 | RLS / Tenant Isolation | **Yes** — `FR-PLT-003`/`010`/`011`/`012` fix the principles | No conflict; U4 is **new Governance design** | **S1 + N1 + U4**; DELETE unresolved. **AMENDED by D-7 and D-10**: decisions INSERT = `WITH CHECK (T AND self-approval traversal AND request unexpired)` | **RATIFIED 2026-08-17 — S1+N1+U4**, amended by D-7 and D-10 | DELETE (open); parent-linkage (open); D-8 cl.6 cascade verification (F) | **RATIFIED** |
| D-10 | Expiry Semantics | **Field only** — one word in `FR-SEC-031`; **no scheduler required by the SRS** | No conflict — **absence** | **Option E2 — decision-time validity**; no new status, no scheduler, `expires_at` immutable | **RATIFIED 2026-08-17 — E2** | **Amends D-9** (second conjunct set); granted-approval staleness left undefined | **RATIFIED** |
| D-11 | Notification Scope | **Yes** — `FR-SEC-032` async is the **only** §15.6 notification requirement; channels owned by Integrations §23.5 | No conflict. **Governance is never an event publisher** (§5.5.4) | **Option N-B — strict none + explicit deferral record** | **RATIFIED 2026-08-17 — N-B** | `FR-SEC-032` **knowingly unmet**; §23.5 deferred to Integrations | **RATIFIED** |
| D-12 | Escalation Semantics | **Yes** `[S]` — `FR-SEC-034` | No | Out of scope for phase 1 | YES | D-5, D-13, D-4, settings | **BLOCKED** — scheduler + settings + steps |
| D-13 | Threshold / Value Configuration | Shapes only; **no SRS requirement places thresholds in Governance** | No | **Option (b)** — domain-owned; Governance stays generic | **RATIFIED 2026-08-17 — option (b)** | None — `FR-PLT-025` dependency removed from Governance | **RATIFIED** |
| D-14 | Governance API Surface | **No** — §26.3 has **no Governance group**; absence is a gap, **not a prohibition** | No conflict — **absence** | **Option A-1 — no HTTP surface**; internal service only (§24.2.3). Architectural decision, not an SRS prohibition | **RATIFIED 2026-08-17 — A-1** | **`FR-API-020` does not attach** (no POST/PATCH); D-15/D-18/D-20/D-16/parent-linkage/`/v1` all unresolved | **RATIFIED** |
| D-15 | Idempotency / Concurrency | **No approval-specific requirement exists** — source finding, not an invented requirement; HTTP idempotency **detached by D-14 A-1** | No conflict. §24.6.4 confines pessimistic locking to two named cases, **approval not among them** | **RATIFIED — MINIMAL / NO ADDITIONAL APPROVAL-SPECIFIC CONCURRENCY MECHANISM** (18 clauses) | Done | Preserves D-6, D-7, D-8, D-9 exactly; does **not** authorize implementation | **RATIFIED** |
| D-16 | `request_type` Enumeration | **Partly** — `FR-SEC-030`'s "used by" seven is **exemplary, not closed**; 9 further backed requirements exist outside it | **Yes — C-5 re-characterised**: neither list is complete; **price-changes ambiguity unresolved** | **MUST REMAIN OPEN — DO NOT RATIFY.** No closed enum to be invented; representation is a Design Gate modelling question | YES — **NOT RATIFIED** | — | **OPEN (position recorded)** |
| D-17 | Inventory Boundary | **No SRS requirement** places an approval reference in an Inventory table | GAP-10 asymmetry; `count_sessions` never designated by approved SQL | **Option A — STRICT BOUNDARY** | **RATIFIED 2026-08-17 — Option A** | D-14, D-20 (Governance-side read path) | **RATIFIED** |
| D-18 | Error Semantics | **Zero requirements govern Governance approval-workflow errors** — §26.2's 422 example is a **POS discount** error. Only **`FR-PLT-012`** (data-layer, [M]) survives D-14 A-1 | **C-3 superseded by D-14 A-1** — options (a)/(c) presupposed Governance routes that no longer exist; Inventory 403 is ratified B-2, protected by D-17 | **RATIFIED 2026-08-18 — E-1: NO GOVERNANCE-SPECIFIC ERROR SEMANTICS IN PHASE 1** (15 clauses); `FR-PLT-012` already satisfied by the ratified fail-closed RLS | Done | Preserves D-7, D-9, D-10, D-14 A-1, D-15 exactly; **does not authorize implementation** | **RATIFIED** |
| D-19 | Audit Hash Coverage | **`FR-AUD-004` [M] remains governing** — SHA-256 over `canonical_json(entry_n)` + previous hash, **per-tenant chaining preserved**; `canonical_json` is **never defined** by the SRS and D-19 **does not redefine it** | **GAP-11 recorded, NOT closed** — the shipped digest omits 10 `FR-AUD-002` fields incl. both approval fields and `impersonated_by`; **that broader question remains unresolved** | **RATIFIED 2026-08-18 — NO ADDITIONAL APPROVAL-SPECIFIC HASH COVERAGE IN PHASE 1** (18 clauses); shipped `audit_entries` hashing **unchanged**; D-8 append-only **distinct and unchanged** | Done | **No** algorithm, canonicalization, versioning, migration or backfill authorized; D-20 must address `FR-AUD-007`/`008` | **RATIFIED** |
| D-20 | Read Permission | **§15.2 supplies no approval-read code — and Appendix C, which §15.2 designates authoritative, is ABSENT from the SRS.** **`FR-SEC-010` + `FR-SEC-011` [M]** establish one **must eventually exist** (the mandated **Auditor** role is otherwise unexpressible), but the **code is not derivable** | **GAP-9 open.** **`FR-AUD-008` [M] remains a knowingly unsatisfied gap — NOT closed by D-20, NOT reinterpreted as authorizing an endpoint** | **RATIFIED 2026-08-18 — MINIMAL / NO NEW GOVERNANCE READ SURFACE IN PHASE 1** (18 clauses); **D-9's fail-closed RLS remains the read authorization boundary**; permission-code decision **DEFERRED, not invented** | Done | D-14 A-1 not reopened; no prior ratification amended; R-1…R-7 not implementation mandates beyond status-quo R-2 | **RATIFIED** |

**Ratification log.**
- **D-2 — RATIFIED 2026-08-17**, option (a) CORE ONLY.
- **D-1 — RATIFIED 2026-08-17**, option (a) ADD ALL THREE FIELDS.
- **D-3 — RATIFIED IN PART 2026-08-17**: authority is permission-based (Conflict C-2 resolved).
  The role-on-`approval_steps` residual is **DEFERRED** with the multi-step chain by D-5
  clauses 8 and 9 — it is no longer pending D-5, it travels with the future phase.
- **PARENT LINKAGE — RATIFIED 2026-08-18 — P-1: `approval_decisions` references
  `approval_requests` DIRECTLY.** Recorded as the **carried-item** ratification, **not** a new
  numbered decision — **the 20-decision tally is unaltered**. **`approval_steps` is not required
  and must not be introduced because of this**; its existence, `tenant_id`, RLS scope,
  cardinality and topology **remain undecided**. **D-7's** requester ≠ approver traversal and
  **D-10's** expiry traversal **may now target `approval_requests` directly**; **D-8's**
  append-only grants and **D-9's N1** may use the direct relationship, subject to their existing
  clauses. **P-1 is an architectural choice, not an SRS mandate** — the SRS establishes
  `ApprovalRequest` as the aggregate root containing Steps and Decisions but **prescribes no
  persistence topology**. **P-2 was considered and not adopted.** **D-16 remains OPEN; D-12
  remains BLOCKED; no prior ratification is amended.** No implementation authorized.
  *Note: clauses in D-5, D-7 cl. 9 and D-9 cl. 9 that record linkage as unresolved are
  **ratified historical text and are deliberately left unedited**; they are superseded forward
  by this entry, in the register's established manner.*
- **D-20 — RATIFIED 2026-08-18 — MINIMAL / NO NEW GOVERNANCE READ SURFACE IN PHASE 1.**
  **D-9's database-layer tenant isolation / fail-closed RLS remains the applicable read
  authorization boundary.** **No new Governance HTTP read surface**, **no `approval_requests` /
  `approval_decisions` read endpoint**, and **no governance-specific read permission code
  invented**. **`FR-SEC-010` + `FR-SEC-011` establish that a read permission must eventually
  exist, but the exact code is NOT derivable — Appendix C is absent from the supplied SRS — so
  the permission-code decision is DEFERRED rather than invented.** **`FR-AUD-007` remains
  conditional on audit-log access; `FR-AUD-008` remains a knowingly unsatisfied gap, NOT closed
  by D-20 and NOT reinterpreted as authorizing an endpoint.** **D-14 A-1 is not reopened; no
  prior ratification is amended.** **R-1 … R-7 are not implementation mandates beyond the
  status-quo R-2.** **D-16 remains OPEN; D-12 remains BLOCKED.** Governance/design ratification
  only — **no implementation authorized**.
- **D-19 — RATIFIED 2026-08-18 — NO ADDITIONAL APPROVAL-SPECIFIC HASH COVERAGE IN PHASE 1.**
  **`FR-AUD-004` remains governing** — SHA-256 over `canonical_json(entry_n)` with the previous
  hash, **per-tenant chaining preserved**. D-19 **does not redefine `canonical_json`**, **does
  not select a new hashed-field subset**, **does not require `approver_id`/`approval_id` in the
  digest**, and **does not make `approval_requests`/`approval_decisions` hash-chained**. **D-8
  append-only remains distinct from audit hashing and is unchanged; existing `audit_entries`
  hashing is unchanged.** The **broader ten-field coverage question remains unresolved rather
  than silently decided**. **No hash algorithm, canonicalization scheme, versioning scheme,
  migration or backfill is authorized.** **No prior ratification is amended.** **D-20 remains
  OPEN** and must address `FR-AUD-007`/`FR-AUD-008` audit-read permissions where applicable;
  **D-16 remains OPEN; D-12 remains BLOCKED.** This **does NOT claim all `FR-AUD` requirements
  are satisfied**. Governance/design ratification only — **no implementation authorized**.
- **D-18 — RATIFIED 2026-08-18 — E-1: NO GOVERNANCE-SPECIFIC ERROR SEMANTICS IN PHASE 1.**
  **No RFC 7807 / Problem Details**, **no Governance HTTP error contract**, **no new HTTP
  endpoints**, and **no internal error taxonomy chosen by convention**. Source-defined
  conclusion: **the SRS defines no Governance-specific error semantics** for self-approval,
  expiry, duplicate decisions, invalid transitions or missing approval requests, and
  **`FR-PLT-012` remains applicable and is already satisfied by the ratified tenant fail-closed
  RLS design**. **D-14 A-1, D-15, and D-7 / D-9 / D-10 are preserved exactly** — duplicate
  decisions receive **no special error semantics**, self-approval and expiry receive **no
  separate classification**, and D-9's **invalid-transition 0-row behaviour is NOT converted
  into an error**. **D-16 remains OPEN; D-12 remains BLOCKED.** No prior ratification is
  amended. Governance/design ratification only — **does NOT authorize implementation**.
- **D-15 — RATIFIED 2026-08-17 — MINIMAL / NO ADDITIONAL APPROVAL-SPECIFIC CONCURRENCY
  MECHANISM.** **No approval-specific idempotency key, duplicate-request mechanism, HTTP retry
  contract, one-decision-per-request UNIQUE constraint, or pessimistic row locking.** **D-6,
  D-7, D-8 and D-9 (as amended by D-7 and D-10) are preserved exactly** — the **C-3
  pending-status predicate is NOT added**. The **residual possibility of a decision inserted
  against an already-decided request**, and of **duplicate or contradictory decision rows**,
  remain **unresolved architectural behaviour**, to be settled only by an **explicit future
  decision** and **never inferred from D-15**. The **PostgreSQL RLS re-evaluation question
  remains a Design Gate verification item, NOT asserted as verified**. Governance/design
  ratification only — **does NOT authorize implementation**.
- **D-15 (analysis, superseded by the ratification above) — 2026-08-17.** **Zero SRS
  requirements tie idempotency or concurrency to approvals.** HTTP idempotency
  (`FR-API-020`…`023`) **no longer attaches**. Two architecture sections apply: **§24.6.4**
  (optimistic, version-based; **pessimistic locking confined to order-number allocation and
  count-session exclusivity — approval is neither**) and **§24.3.7** Unit of Work (already the
  repository's `withAuthContext` pattern). Race analysis: **D-9 U4 already acts as a
  compare-and-set** for the status transition (verification required), but the decisions
  INSERT policy carries **no status predicate**, so decisions against already-decided requests,
  duplicates and contradictory pairs remain **possible** — and **D-8 makes them permanent**.
  Seven mechanisms presented; "one decision per request" is **not** established by the sources.
- **D-14 — RATIFIED 2026-08-17**, **Option A-1 — NO HTTP/API surface in Phase 1**. Governance
  remains an **internal service capability** (§24.2.3 `ApprovalService`). No POST, PATCH, GET,
  DELETE, bulk, notification, escalation or admin/bypass endpoint. Recorded as an
  **architectural decision, NOT a claim that the SRS prohibits endpoints** — §26.3 simply
  defines none. **`FR-API-020` does not attach**, since no Governance POST/PATCH is ratified.
  Consequence recorded: with no consuming domain and no HTTP surface, the phase is
  **exercisable only by tests**. Amends nothing; D-15, D-16, D-18, D-19, D-20, D-12,
  parent-linkage, `approval_requests` DELETE, D-4 cl.5 and the D-8 cascade verification all
  remain unresolved. No implementation authorized.
- **D-11 — RATIFIED 2026-08-17**, **Option N-B — strict none + explicit deferral record**. No
  notification implementation of any kind: no channels, in-app, persistence table, endpoint,
  permission, `approval.*` event, outbox, queue, worker or scheduler. **`FR-SEC-032` remains
  knowingly unmet** (both halves), exactly as D-2 established. **§23.5 `IR-INT-040`…`043`
  recorded as an Integrations concern, deferred**, preserving the distinction between the
  Governance approval workflow and notification delivery infrastructure. Amends nothing; D-12
  stays BLOCKED, D-16 stays OPEN. No implementation authorized.
- **D-10 — RATIFIED 2026-08-17**, **Option E2 — decision-time expiry validity**. A decision may
  not be inserted once `expires_at` has passed; **no `expired` status**, **no scheduler**,
  **no mutation of `approval_requests`**, and `expires_at` **stays immutable** per D-6.
  Enforcement sits at the **database decision-INSERT boundary**, consistent with D-7.
  **Records a second explicit amendment to D-9**: the decisions INSERT policy becomes
  `WITH CHECK (T AND <D-7 self-approval traversal> AND <D-10 request unexpired>)`.
  Granted-approval staleness and consuming-domain behaviour are **explicitly left undefined**
  (clauses 11–12). No implementation authorized.
- **D-7 — RATIFIED 2026-08-17**, **mechanism M2 — RLS `INSERT … WITH CHECK` traversal**. No
  denormalised `requested_by`, no trigger, not service-only. **Records an explicit amendment
  to D-9**: the `approval_decisions` INSERT policy becomes
  `WITH CHECK (T AND <self-approval NOT EXISTS traversal>)`, with D-9's tenant-safety
  requirement preserved in full and its ratified text unchanged. Parent-linkage deliberately
  **not** invented (clause 9). **No claim** that Phase 1 satisfies `FR-SEC-016`'s Procurement,
  Sales, Finance or strict-SoD combinations (clause 10). No implementation authorized.
- **D-9 — RATIFIED 2026-08-17**, **S1 + N1 + U4**. Scope: `approval_requests` +
  `approval_decisions` only; `anomaly_flags` OUT; `approval_steps` UNRESOLVED and excluded;
  `audit_entries` unchanged. `approval_decisions` gets its **own `tenant_id`** + tenant-safe
  composite FK (**parent-independent**, so the linkage question stays open without blocking).
  `approval_requests` UPDATE ratified as **U4** — `USING (T AND status='pending')` **and**
  `WITH CHECK (T AND status IN ('approved','rejected'))` — which is **new Governance design**,
  since the Production GAP-2 precedent's UPDATE policy carries only a tenant predicate.
  **`approval_requests` DELETE deliberately left unresolved.** Cascade verification (F),
  parent-linkage, D-4 cl.5, D-10, D-16, D-3 residual, D-7 mechanism and D-12 all remain open.
  No implementation authorized.
- **D-8 — RATIFIED 2026-08-17**, **Option 1 — FULL APPEND-ONLY**. `GRANT SELECT, INSERT`;
  `REVOKE UPDATE, DELETE, TRUNCATE`. `FR-SEC-033` supplies the immutability requirement; the
  **no-DELETE portion is an explicit architectural ratification**, since SRS **ADR-010**'s
  never-deleted enumeration (*orders, payments, stock movements, audit entries*) **excludes
  approval decisions**. The PostgreSQL `ON DELETE CASCADE` question is **carried forward as a
  Design Gate verification item**, not resolved. Parent-linkage, D-4 clause 5 and D-9 all
  remain unresolved; D-6 is unmodified. No implementation authorized.
- **D-6 — RATIFIED 2026-08-17**, **Model B (immutable except `status`) + Mechanism 1
  (Production GAP-2 column-level enforcement)**. `REVOKE` general `UPDATE`; `GRANT UPDATE`
  on `status` only; status transitions enforced by a status-predicated RLS/policy mechanism,
  **not by service-level checks alone**. `tenant_id` immutable per `FR-PLT-003`; `status` is
  the **only** mutable field. `rejected`-storage (D-4 clause 5) preserved unresolved; D-8,
  D-9, D-10, D-16, the D-3 residual and the parent-linkage question all remain open. No
  implementation authorized.
- **D-17 — RATIFIED 2026-08-17**, **Option A — STRICT BOUNDARY**. Governance Phase 1 must not
  create, alter or write to any `inventory` object; association is carried solely by
  `approval_requests.entity_type` + `entity_id`; no reverse Inventory → Governance
  association; `waste_records.approval_request_id` stays NULL and unused;
  `count_sessions` receives no integration column. Any future association requires a
  separately authorized phase.
- **D-16 — POSITION RECORDED 2026-08-17; MUST REMAIN OPEN, DO NOT RATIFY.** `FR-SEC-030`'s
  "used by" seven is **not** demonstrated to be a closed enumeration; **nine further
  approval-requiring requirements sit outside it**. Governance must not invent a closed
  seven-value enum, nor silently enumerate the additional consumers. The **price-changes**
  ambiguity is recorded unresolved. Representation of `request_type` is a **Design Gate
  modelling question**. No Phase 1 scope expansion follows from the discovery.
- **D-13 — RATIFIED 2026-08-17**, option (b): thresholds are **domain-owned**; Governance is a
  generic request/decision mechanism. No threshold tables, APIs, band rules or evaluation
  logic in Governance Phase 1. Procurement value bands stay with Procurement; Inventory
  precedent preserved unaltered.
- **D-4 — RATIFIED 2026-08-17**, option (b): `pending → approved | rejected`. No additional
  states; `cancelled`, `escalated` and `expired`-as-status explicitly excluded. Expiry
  remains owned by **D-10**; storage of `rejected` left to the Design Gate.
- **D-5 — RATIFIED 2026-08-17**, option (a) SINGLE-STEP GOVERNANCE PHASE 1. Multi-level
  chains deferred; §24.5.3 semantics (sequential, first-accept, no parallel,
  permission-based authority) recorded for the future phase. Chain exhaustion, value-band
  derivation (D-13) and Conflict **C-7** all explicitly left unresolved.
- **APPROVAL RUNTIME MINIMUM RESOLUTION — RATIFIED 2026-08-29.** Recorded as an
  **unnumbered carried-item/amendment entry — no D-21 is created and the 20-decision tally is
  unaltered (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN)**. Eight binding resolutions:
  **(1)** `request_type` = **`VARCHAR(32) NOT NULL`, no CHECK** this phase — **D-16's
  ENUMERATION remains OPEN and D-16 is NOT closed**, only its Phase-1 constraint form resolved;
  **(2)** **SB-1 RESOLVED** — `required_permission` stores the immutable §15.2 **code**, **no
  FK**, authority checked at decision time against the approver's resolved permission-code set;
  **(3)** **SB-3 RESOLVED** — **no DELETE capability** for `ros_app`, no DELETE policy,
  decisions FK **`ON DELETE RESTRICT`**, **CASCADE still rejected**, and the **D-8 clause 6
  cascade verification is dissolved** (no delete path exists), **V2 not required**;
  **(4)** **D-4 clause 5 RESOLVED** — `decision` is the immutable fact, `status` the
  current-state projection and still the sole D-6-updatable request column; **(5)** **exactly
  ONE final decision per request**, future schema enforcing **`UNIQUE (tenant_id,
  approval_request_id)`** — this **narrowly AMENDS D-15 clause 4**, which named that constraint
  and declined it, by the route **D-15 clause 14** expressly provides, superseding **D-15
  clauses 10 and 11**; it is an **architectural ratification, not a claim the SRS mandates the
  semantic**, and D-15 clauses 3, 5 and 9's C-3 prohibition are **preserved**; **(6)** **D-2
  AMENDED IN PART** — defer lifted **only** for **synchronous manager-PIN approval on a
  registered terminal** reusing the existing `FR-SEC-021`/`022` substrate, with the
  **asynchronous half of `FR-SEC-032`, D-11, D-12, broader branch RBAC, D-14 A-1 (no Governance
  HTTP surface) and D-20 (no read surface) all preserved**; **(7)** **SB-2 RESOLVED** —
  `value` = **`JSONB NOT NULL`**, an **opaque carrier** Governance never parses, indexes into,
  or reads in any RLS/CHECK/security rule, with **monetary amounts as base-10 integer strings
  of minor units** to preserve application-layer precision; **SB-2's money-only `BIGINT`
  exclusion remains valid** and the open nullability sub-question is resolved by `NOT NULL`;
  **(8)** **F-1 = R-b** — one **nullable excluded-approver column**, binding clarification that
  it is an **Identity USER ID** in the same domain as `approval_decisions.approver_id` and
  **NOT an Employee ID** (Treasury supplying the User corresponding to the CashSession owner),
  with a **DB-enforced fourth conjunct** on the decisions INSERT policy; **service-only
  enforcement is NOT sufficient**, the identity **SHALL NOT** be read from `value`, and D-7's
  requester ≠ approver conjunct remains **independently enforced**. This **amends D-1**'s
  column set and **D-9**'s decision INSERT policy, recorded as a **D-9 policy
  amendment/consequence** in the manner of **D-7 cl. 6** and **D-10 cl. 9**.
  **P-1 remains RATIFIED and UNCHANGED · D-12 remains BLOCKED · D-16's enumeration remains
  OPEN · asynchronous `FR-SEC-032` remains deferred · no Governance HTTP or read surface · no
  new permission code · no numbered decision added or renumbered.** **No implementation
  authorized** — a separate runtime Design Gate is required. Exact column name, FK shape and
  RLS SQL are **Design-Gate details, NOT ratified here**.
  *Note: the SB status table of 2026-08-19, D-15's clauses 4/10/11 and all prior analysis are
  **ratified historical text and are deliberately left unedited**; they are superseded forward
  by this entry, in the register's established manner.*
- **P1G-1 CASH-CLOSE POLICY — RATIFIED 2026-08-30.** Recorded as an **unnumbered ratification
  entry**, in the established forward-supersession style — **no D-21 is created and the
  20-decision tally is unchanged**. Five resolutions bind: **R-1(a)** the cash variance
  tolerance is an **ABSOLUTE MONEY AMOUNT** — `BIGINT` **integer minor units** + **ISO 4217
  currency**, the policy currency corresponding to the CashSession/branch operational currency
  used for the comparison, **no floating-point money**, **no percentage tolerance in this
  phase**, and no hybrid form; a **domain-owned Treasury control threshold** consistent with
  **D-13** — and **the SRS did NOT select this representation**, `FR-FIN-006`'s *"a configurable
  tolerance"* being dimensionless, so this clause is **explicit user ratification resolving
  source silence, not an SRS finding**; **R-2(a)** the threshold test is
  **`abs(counted − expected) > tolerance`**, so `abs(variance) <` and `abs(variance) =`
  tolerance are **within** tolerance and only `abs(variance) >` is **beyond** it, with the
  **strict `>` source-backed** by `FR-FIN-006`'s *"beyond"* and `FR-POS-096`'s *"exceeds"*
  while the **absolute-value framing is the user-ratified choice**; shortages and overages
  share **one configured scalar tolerance** and **no separate positive/negative thresholds may
  be inferred**; `FR-FIN-005`'s signed variance definition is **unchanged** — only the
  *threshold test* uses the magnitude; **R-3(a)** a CashSession is governed by the policy
  version **effective at the session's OPEN time**, resolvable **lazily at close** using
  `cash_session.opened_at` as the `asOf` instant and **never** by the close-time current
  configuration, so a tolerance **cannot be widened after a drawer is already open**, and
  **no snapshot column is written at open merely to implement this rule** (the accepted P1D-1
  open path is **not** modified); **R-4(a)** the synchronous cash-variance `ApprovalRequest`
  expiry is derived from a **CONFIGURED POSITIVE DURATION on the immutable policy version**
  (`variance_approval_expiry_seconds INTEGER NOT NULL`, `CHECK > 0`) with **NO database and NO
  application default** and **no `5m`/`15m`/`30m` constant authorised**, Treasury supplying the
  **explicit** `expiresAt` — **D-10 E2 is UNCHANGED** (`expires_at` mandatory, explicit,
  immutable, decision-time validity, no `expired` status, no scheduler); **R-5** the user
  **ACKNOWLEDGES** the derived consequence that **a branch cannot complete a CashSession close
  with no valid policy version effective at the governing policy time** — **no default
  tolerance is invented** (the unconfigured state is the **absence of a version row**), and a
  holder of the **existing source-named** `settings.branch.manage` (§15.2 *"Branch
  configuration"*, already seeded per **ADR 0008 D-01**) must configure the branch first, while
  **`blind` remains independently source-defaulted under `FR-POS-095`** so count-mode reads
  never fail closed. Two **design constraints** are recorded, **not** as new business
  requirements: **C-1** the slice **MUST NOT** perform an isolated **`/v1` API-versioning
  retrofit**, the current routing convention stands, **the global `/v1` gap remains separate and
  MUST NOT be declared fixed**, and **no route URL is ratified**; **C-2** policy versions
  **MUST NOT be backdated by the application role** (enforceable by a server-created immutable
  timestamp outside the application role's column-level `INSERT` grant plus
  `effective_from >= created_at`), so **a session opened before the first applicable version
  cannot become eligible via a backdated version**, **no historical configuration may be
  invented**, and **already-open sessions at rollout are an explicit future
  implementation/operational decision — never a silent weakening of R-3(a)**.
  **`FR-PLT-025`'s six-level hierarchy remains NOT IMPLEMENTED and `FR-PLT-026` locks remain
  NOT IMPLEMENTED by this narrow branch-scoped slice, which is NOT the generic Settings platform
  and must not be described as implementing it; ADR 0008 D-11 is unchanged.**
  **P-1 remains RATIFIED and UNCHANGED · D-12 remains BLOCKED · D-16's enumeration remains
  OPEN · D-13 remains RATIFIED · asynchronous `FR-SEC-032` remains deferred · no Governance HTTP
  or read surface (D-14 A-1, D-20) · `value` remains an opaque `JSONB` carrier with money as
  base-10 minor-unit strings · the excluded approver remains an Identity USER id · no new
  permission code · no schema created · no numbered decision added, amended or renumbered.**
  **Migration 33 is NOT created by this entry and no implementation is performed by it**; the
  exact table/column/index names, RLS predicate SQL, resolver interface, route URL and audit
  action literal remain **Design-Gate/implementation details, NOT ratified here**.
- **R-6 — CASH VARIANCE APPROVAL REJECTION RECOVERY — RATIFIED 2026-08-30.** Recorded as an
  **unnumbered ratification entry**, in the established forward-supersession style — **no D-21
  is created and the 20-decision tally is unchanged**. **Option R-6(a)** binds: when a manager
  **explicitly REJECTS** an above-tolerance CashSession close, the session **remains `CLOSING`**,
  the **physical count remains immutable**, **`closeAttemptId` remains unchanged**, the immutable
  `cash_session_close_attempt` **remains authoritative**, and **payments and all cash movements
  (pay-in, pay-out, safe-drop) remain blocked**; the session **MUST NOT** reopen, return to
  `OPEN`, permit a recount, or replace/delete the close attempt; the close **MAY be retried**
  with a **NEW** `ApprovalRequest`/`ApprovalDecision` id pair, **MAY** use **another qualified
  manager**, and **MAY** carry a **different variance reason**; **every rejected request and
  decision remains immutable and auditable in Governance**; a **later APPROVED retry** may
  transition `CLOSING → CLOSED`, and the **final** `cash_sessions.variance_reason` is the reason
  on the **APPROVED** close, never a prior rejected attempt's; **no supervisor-override or
  escalation permission is introduced**; **D-12 remains BLOCKED**. **Expiry is explicitly OUT OF
  SCOPE for R-6** — decision-time expiry rolls the whole finalize transaction back (no expired
  request survives, the session stays `CLOSING`, the attempt is untouched, retry creates a fresh
  request), so it is a technical rollback/retry path, not a business state, and **`D-10` is NOT
  amended**. **R-6(a) is user-ratified business behaviour resolving a source-silent operational
  recovery question — NOT an SRS-derived requirement** — compatible with but not mandated by
  `FR-POS-095`, `FR-FIN-006`, `FR-SEC-016` and `FR-SEC-033`, none of which itself specifies
  retry-after-rejection semantics. **R-1(a)…R-5 remain unchanged · P-1 remains RATIFIED and
  UNCHANGED · D-12 remains BLOCKED · D-16's enumeration remains OPEN · D-15's one-decision-per-
  request amendment untouched · no Governance HTTP surface (D-14 A-1) · no new permission code ·
  no schema created · no numbered decision added, amended or renumbered.** **Migration 34 is NOT
  created by this entry and no implementation is performed by it.**
- **KDS MVP OPERATOR LIFECYCLE — RATIFIED 2026-08-30.** Recorded as an **unnumbered ratification
  entry with two independently identifiable limbs**, in the established forward-supersession
  style — **no D-21 is created and the 20-decision tally is unchanged**. Limb ids continue the
  **P1E-2 `KDS-R<n>` series** (`KDS-R1 … KDS-R10` are taken) and therefore begin at **KDS-R11**;
  **`R-7` is deliberately NOT reused**, that label being a **D-20 option** (*"Defer to Appendix
  C"*) in the same subject area. **KDS-R11** authorises a new permission code **`kds.operate`** —
  *"Operate a kitchen display station"* — covering **station queue read · first-viewed
  acknowledgement · item start · bump item · bump all · ticket recall**, as the **third explicit
  user-authorized exception** to the zero-invented-codes discipline after **`pos.order.fire`** and
  **`pos.payment.capture`**; the **coarse grain is deliberate** and **`kds.view`,
  `kds.ticket.view`, `kds.ticket.start`, `kds.ticket.bump`, `kds.ticket.recall`,
  `kds.ticket.serve` and `kds.expedite` are NOT authorized**; reads sit behind `kds.operate` on
  the `pos.order.create` operational-read precedent; **`kds.operate` does NOT represent station
  authorization**, which is separately enforced fail-closed by **active registered KDS-terminal
  binding resolving to exactly ONE operative station** (zero ⇒ denied · more than one ⇒ denied as
  unsupported · supplied `stationId` must equal the terminal-derived station · a POS/dashboard
  surface cannot operate KDS merely by holding the code), with **D-2's branch-scoped RBAC defer
  UNCHANGED**; the code is added **code-driven, not migration-driven**, via
  `<MODULE>_PERMISSION_DEFS` + `PermissionsService.upsertMany`, seeded only by the slice that
  creates the routes. **KDS-R12** authorises a new internal domain event **`ticket.recalled`**,
  **publisher Kitchen Ops, principal subscriber Sales**, recorded as an **EXTENSION of §5.5.4
  "Event Catalogue (Core Subset)"** — **the SRS does NOT define it and no claim to the contrary is
  made**; on a successful recall Sales consumes it **inside the same UnitOfWork transaction** and
  reverts exactly the affected lines **`ready → fired`**, **clearing `ready_at`**, and **MUST NOT
  regress `served`, `voided` or `comped` lines**; **no direct cross-module table query is
  authorized** in either direction and **`ticket.bumped`'s publisher/subscribers are unchanged**.
  **FUTURE ROLE INTENT ONLY** (recorded, **NOT implemented**): `kds.operate` for **Kitchen Staff ·
  Head Chef · Branch Manager · Shift Supervisor · Owner**, and **NOT Auditor** (it carries write
  authority) — **FR-SEC-010 standard-role seeding is NOT authorized and no role row or role
  semantic is modified**. Expressly **NOT ratified**: the **SERIALIZABLE + bounded-retry**
  concurrency mechanism (an **engineering correctness mechanism**, introducing no
  `SELECT FOR UPDATE`, no new advisory lock, no reliance on `AuditService`'s tenant-wide advisory
  lock, no `sales.orders.version` coupling, **no migration** — §24.6.4 untouched) and the
  **first-viewed `TICKET_VIEWED` audit entry** (**FR-AUD-001 already decides it** — requirement
  compliance, not a discretionary choice). **`served`/Expediter (FR-KDS-013), sorting beyond FIFO,
  colour thresholds, FR-KDS-041/042 analytics, the post-fire `order.line.voided` path, offline KDS
  (NFR-REL-002), peer discovery (NFR-REL-003) and the FR-SEC-026 8-hour KDS TTL all remain
  DEFERRED and NOT authorized.** **D-20 is NOT reopened** — its deferral concerned a
  **Governance approval-read** code for a surface **D-14 A-1 had removed**, where deferral cost
  nothing; KDS has `[M]` requirements demanding an executable permission-guarded surface, so the
  register's own remedy for that posture applies instead. **P-1 remains RATIFIED and UNCHANGED ·
  D-2's RBAC defer in force · D-12 remains BLOCKED · D-16's enumeration remains OPEN · D-13
  remains RATIFIED · no Governance HTTP or read surface (D-14 A-1, D-20) · KDS-R1 … KDS-R10 and
  the P1E-4/P1E-5 Ticket-lifecycle and Kitchen-ownership decisions unchanged · R-1(a) … R-6
  unchanged · no schema created · no numbered decision added, amended or renumbered.** **No
  migration is created by this entry and no implementation is performed by it**; exact
  table/column names, route URLs, DTOs, audit action literals and event payload fields remain
  **implementation details, NOT ratified here**. **The KDS MVP operator-lifecycle slice is
  GOVERNANCE-UNBLOCKED.**
- **MINIMUM OPERATIONAL REPORTING — RATIFIED 2026-08-31.** Recorded as an **unnumbered
  ratification entry with three independently identifiable limbs**, in the established
  forward-supersession style — **no D-21 is created and the 20-decision tally is unchanged**.
  Limb ids open a **NEW `RPT-R<n>` series** (`RPT-R1 … RPT-R3`), verified unused in this
  register; the cash series **`R-1(a) … R-6`** is **not** continued and **`R-7` is again NOT
  reused**, that label being a **D-20 option** (*"Defer to Appendix C"*) in this very subject
  area. **RPT-R1** authorises **TWO** new permission codes — **`report.view.sales`** (*"View
  sales reports"*) and **`report.view.financial`** (*"View financial reports"*) — **BOTH
  required together (`mode: 'all'`, AND, never OR)** on the single composite route
  **`GET /reports/branches/{branchId}/daily-trading/{businessDay}`**, because the response
  spans **two** §19.3 categories (*Sales Summary* / *Sales by Tender* are **Sales**;
  *Cash Reconciliation* / *Tax Summary* are **Financial**); these are the **fourth and fifth
  explicit user-authorized exceptions** to the zero-invented-codes discipline after
  **`pos.order.fire`**, **`pos.payment.capture`** and **`kds.operate`**, and a **weaker** form
  of invention than those three because **§15.2 supplies the template `report.view.<category>`
  and §19.3 supplies the categories** — only the instantiation is user-ratified; **`report.export`,
  `report.view.daily_trading`, `report.view.inventory`, `report.view.kitchen`,
  `report.view.workforce`, `report.view.governance` and every other `report.view.*` code are
  NOT authorized**; reads sit behind the two codes on the `pos.order.create` / `kds.operate`
  operational-read precedent; **the codes carry NO branch scope**; and the **ADR 0008 D-01**
  remap route is recorded should Appendix C ever name the categories differently — which does
  **not** make the ratification provisional. **RPT-R2** authorises **Internal-MVP sequencing
  only**: the operational daily-trading read may be built **now** over the **transactional
  primary**, while **`FR-RPT-001`, `FR-RPT-002`, `FR-RPT-003` and `FR-RPT-005` remain NOT
  IMPLEMENTED** — **NOT waived, NOT reinterpreted, NOT complete**, and **no artefact may claim
  otherwise**; **no read replica, star schema, `fact_*`/`dim_*` table, Type-2 dimension, rollup
  persistence, report cache, export pipeline or analytics warehouse is authorized**;
  **`FR-RPT-004` may be implemented in full**; **`FR-RPT-042` and `FR-RPT-043`/`044` remain NOT
  IMPLEMENTED**; **`FR-FIN-010` remains PARTIAL** (per-day totals for the two implemented
  tenders only — *each card scheme* and the nine unimplemented tender families stay
  **UNSATISFIED**); **§19.3 Cash Reconciliation is PARTIAL** (payment-contributing sessions
  only · **WHOLE_SESSION** close facts · zero-payment/movement-only attribution **NOT
  IMPLEMENTED**, no business-day anchor existing on `cash_sessions`, `shifts`, `cash_movements`
  or `cash_session_close_attempts` and **none invented** · **NO day-level variance total**);
  **`FR-FIN-020 … 026` / DayClose / X / Z remain NOT IMPLEMENTED** and this slice **does NOT
  provide `FR-FIN-021`'s blocking-session list**; **`FR-AUD-008` stays a knowingly unsatisfied
  gap (D-20 cl. 9)**; and **ordinary report `GET`s generate NO `FR-AUD-001` audit entry**.
  **RPT-R3** fixes **`averageOrderValue` = `netSales ÷ completedOrderCount`, HALF_UP to minor
  units (BR-FIN-001), `null` when the count is zero** — a **user-ratified choice resolving
  source silence** (the SRS names AOV five times and defines no numerator), *compatible with but
  not mandated by* §13's consistent Net-Sales denominator and `FR-CST-035`; it applies to **AOV
  alone** and authorises **no** other derived KPI, and **no COGS is exposed** (that would
  silently widen `inventory.cost.view`). **FUTURE ROLE INTENT ONLY** (recorded, **NOT
  implemented**): both codes for **Owner · Operations Director · Branch Manager · Accountant ·
  Auditor**; **Brand Manager and Shift Supervisor deliberately left OPEN**; **not** for Cashier,
  Waiter, Kitchen Staff, Head Chef or Storekeeper — **`FR-SEC-010` standard-role seeding is NOT
  authorized and no role row or role semantic is modified**. Expressly **NOT ratified** (accepted
  **engineering consequences**, not discretionary governance): the thin zero-table reporting
  module · `RepeatableRead` · `transaction_timestamp()` `dataAsOf` · future `businessDay` ⇒ 400 ·
  historical transaction-currency selection · orders-first indexed joins · zero migration ·
  no day-level variance total · WHOLE_SESSION scope · tax by class only · zero `KNOWN_DEVIATIONS`
  growth · no audit on ordinary `GET`. The **branch fail-closed posture** (explicit `branchId` ·
  tenant-visible branch or tenant-safe 404 · **exactly ONE active branch**, zero ⇒ denied, more
  than one ⇒ denied as unsupported · supplied id must equal it · **verified inside the SAME
  `RepeatableRead` transaction as the report**) is recorded as an **implementation consequence,
  NOT a fourth ratification** — it grants nothing, and **D-2's branch-scoped RBAC defer is
  UNCHANGED**, `FR-SEC-002`/`003`/`004` remaining **NOT IMPLEMENTED**. **D-20 is NOT reopened** —
  its deferral concerned a **Governance approval-read** code for a surface **D-14 A-1 had
  removed**, where deferral cost nothing; Reporting has the **KDS posture**, an executable
  permission-guarded surface, so the register's own remedy for that posture applies instead, and
  **D-20's `R-1 … R-7` option labels remain options that were NOT introduced**. **P-1 remains
  RATIFIED and UNCHANGED · D-12 remains BLOCKED · D-16's enumeration remains OPEN · D-13 remains
  RATIFIED · no Governance HTTP or read surface (D-14 A-1, D-20) · KDS-R1 … KDS-R12 unchanged ·
  R-1(a) … R-6 unchanged · CARRIED ITEM P1C-1's Receipt/fiscal exclusion untouched · no schema
  created · no numbered decision added, amended or renumbered.** **No migration is created by
  this entry and no implementation is performed by it**; exact table/column names, route URLs,
  DTO fields, SQL shapes, index decisions and error-code choices remain **implementation details,
  NOT ratified here**. **The Minimum Operational Reporting slice is GOVERNANCE-UNBLOCKED.**
- **DAY CLOSE — RATIFIED 2026-08-31.** Recorded as an **unnumbered ratification entry with three
  independently identifiable limbs**, in the established forward-supersession style — **no D-21 is
  created and the 20-decision tally is unchanged**. Limb ids open a **NEW `DC-R<n>` series**
  (`DC-R1 … DC-R3`), **verified unused in this register** (`DC-R` and bare `DC-` both returned
  zero); the cash **`R-1(a) … R-6`**, **`KDS-R1 … KDS-R12`** and **`RPT-R1 … RPT-R3`** series are
  **not** continued. **DC-R1** authorises the **Internal-MVP operational Day Close now** — the
  state-changing **Treasury** aggregate plus its minimum persisted Z/historical surface —
  implementing **`FR-FIN-020`**, **`FR-FIN-021` IN FULL (block *and* blocking-session list, over
  every branch session with `status <> 'closed'`, unqualified by business day)** and
  **`FR-FIN-023`**, while reusing the already-**COMPLETE** **`FR-FIN-024`**; **simultaneously
  `FR-FIN-022` remains PARTIAL** (**tax by rate** not derivable — only the `FR-FIN-032` component
  *sum* is persisted; **sales by category** has no `order_lines` snapshot and would bind a sealed
  document to mutable many-to-many master data; the **comp** half is structurally zero, the
  **void** half IS implemented; **sales by tender** stays PARTIAL per RPT-R2 cl. 8) and
  **`FR-FIN-026` remains PARTIAL with all four limbs unmet** (**fiscal finalisation NOT
  IMPLEMENTED** — an empty document set is **never** to be called *satisfied*, and **P1C-1 is
  untouched**; **inventory day-end snapshot** NOT IMPLEMENTED; **report pre-aggregation** NOT
  IMPLEMENTED and **excluded by RPT-R2**; **accounting export** NOT IMPLEMENTED, `FR-RPT-043`
  unchanged and **no `FR-PLT-041` outbox exists**), with **`FR-FIN-025` [S] NOT IMPLEMENTED** —
  **sequencing only: NOT a waiver, NOT a reinterpretation, NOT a claim that `FR-FIN-020 … 026` are
  complete or that the Z report is fully compliant**, and **no artefact may claim otherwise**.
  **DC-R2** fixes **CLOSE-BUSINESS-DAY OWNERSHIP** — whole-session close facts, above all
  variance, are owned **exactly once** by the business day in which the CashSession becomes
  `CLOSED`, via an **immutable `closedBusinessDay`** derived at final close from the **same
  authoritative resolver Sales already uses** and **never historically re-derived** from mutable
  timezone/cutover; a spanning session's **day-scoped tender may contribute to BOTH days** while
  its **variance is owned only by the closing day**, so the same session **MAY** be linked to
  multiple DayClose snapshots and an **unconditional `UNIQUE (tenant_id, cash_session_id)` on the
  linkage is PROHIBITED**; **variance must not double-count**, whole-session figures are labelled
  **`WHOLE_SESSION`** and never emitted as day totals; **legacy `closed_business_day IS NULL`
  sessions remain unknown honestly — never backfilled, inferred, assigned or included**; and
  **zero-payment / movement-only sessions are reached for the first time** (RPT-R2 cl. 9
  unchanged). **DC-R3** extends the existing **`report.view.financial`** narrowly to
  **`GET /branches/{branchId}/day-closes/{businessDay}`**, **creating NO new permission code** —
  an **explicit user-ratified extension of RPT-R1 clause 3** (*"No other route is authorised by
  these codes"*) **by exactly one route and nothing else**, category-consistent because §19.3
  lists *"Z Report — Statutory day close"* under **Financial Reports**; **`report.view.sales` is
  not required and not extended**; **`cash.day.close` remains the separate source-decided WRITE
  authority and MUST NOT serve as historical-read authority**; **`cash.day.read`, `cash.z.read`,
  `report.view.z`, `report.view.day_close` and any other new token are NOT authorized**; the code
  **carries no branch scope**; and the **ADR 0008 D-01** remap route is recorded without making the
  ratification provisional. Recorded as **consequences, NOT ratifications and NOT a `DC-R4`**: the
  **activation epoch** (the first command may create it and return **`outcome = ACTIVATED`** on a
  transaction that **COMMITS and does not throw**; **`activationBusinessDay` is never closeable**;
  **`firstEligibleBusinessDay = activationBusinessDay + 1`**; closeable only when
  **`activation < target < branchCurrentBusinessDay`**; **historical Z is never retroactively
  manufactured** and a pre-activation day is a **404**) and the **cutover fence** (Order creation
  and Day Close share the **existing** `ros_order_number(branchId, businessDay)` serialization
  fence, with the public Day Close state checked **after** the fence and **before** INSERT —
  **SERIALIZABLE is NOT claimed to solve this race** and **advisory-lock mechanics are NOT
  ratified as business policy**), alongside Treasury ownership, the strictly-past-day rule,
  current/future-day refusal, the global `FR-FIN-021` blocker set, the zero-open-target-day-orders
  precondition, `day.closed`, `Idempotency-Key`, READ COMMITTED, `DAY_CLOSE_STATE_QUERY`,
  Z-number mechanics, uniqueness/RLS/append-only grants, audit literals, legacy `NULL` handling,
  one additive migration, and exact schema/route names. **P-1 remains RATIFIED and UNCHANGED ·
  D-12 remains BLOCKED · D-16's enumeration remains OPEN · D-13 remains RATIFIED · no Governance
  HTTP or read surface (D-14 A-1, D-20) · D-2's branch-scoped RBAC defer remains IN FORCE and
  `FR-SEC-002`/`003`/`004` remain NOT IMPLEMENTED · CARRIED ITEM P1C-1 untouched · R-1(a) … R-6,
  KDS-R1 … KDS-R12, RPT-R2 and RPT-R3 unchanged · RPT-R1 extended by DC-R3 cl. 3 and nothing else ·
  no schema created · no numbered decision added, amended or renumbered · `FR-SEC-010` role
  seeding NOT authorized.** **No migration is created by this entry and no implementation is
  performed by it. The Day Close slice is GOVERNANCE-UNBLOCKED.**

**6 decisions remain fully unratified** (including **D-16**, which must remain OPEN), plus
D-3's deferred residual, the decision→parent linkage question exposed by D-5, and the
`rejected`-storage question left open by D-4 clause 5. Nothing else is marked APPROVED.

D-7 and D-8 are marked **SOURCE-DEFINED** for their *requirement* — self-approval is prohibited (`FR-SEC-016`); decisions are immutable (`FR-SEC-033`) — while their *mechanisms* remain OPEN and must appear in the Design Gate.

---

## Recommended Ratification Order

### Assessment of the proposed order

The brief proposes: `D-2 → D-1 → D-3 → D-4 → D-5 → D-6 → D-9 → D-10 → D-11 → D-12 → D-13 → D-14 → D-15`.

**D-2 first is correct** — it sizes the whole phase.

**Two corrections are indicated by the dependency evidence:**

1. **D-3 must precede D-1, not follow it.** D-1 adds a `required_permission` column whose *type and semantics* are exactly what D-3 decides (permission vs role). Ratifying D-1 first would either pre-empt D-3 or produce a column that D-3 could invalidate.

2. **D-5 must precede D-3.** D-3's option (c) — retaining `approver_role_id` alongside the permission — is only meaningful if multi-step approval exists. D-5 also gates D-12 and D-9 (whether `approval_steps` needs anchoring at all).

**D-13 should move earlier.** It is listed eleventh, but D-5's banding option depends on it, and it determines whether the phase has a settings dependency at all — a scope question of the same class as D-2.

**D-16 should be ratified early and independently.** It has no dependencies, is a clean SRS-vs-comment conflict, and omitting *count adjustments* would break the very Inventory integration this phase exists to enable.

### Revised order

```
Tier 1 — scope and size (no dependencies)
  D-2   sync/async scope          ← RATIFIED (a) CORE ONLY
  D-13  threshold ownership       ← RATIFIED (b) domain-owned
  D-16  request_type enumeration  ← OPEN (position recorded) — Design Gate modelling question
  D-17  Inventory boundary        ← RATIFIED Option A (STRICT BOUNDARY)

Tier 2 — structural model
  D-5   multi-level approval      ← RATIFIED (a) SINGLE-STEP
  D-3   permission vs role        ← RATIFIED IN PART (permission-based)
  D-1   request data model        ← RATIFIED (a) ADD ALL THREE
  D-4   status set                ← RATIFIED (b) pending → approved | rejected

Tier 3 — enforcement
  D-6   request mutability        ← RATIFIED Model B + Mechanism 1
  D-8   decision immutability (mechanism)  ← RATIFIED Option 1 (full append-only)
  D-7   self-approval (mechanism) ← RATIFIED M2 (RLS INSERT WITH CHECK)
  D-9   RLS / tenant isolation    ← RATIFIED S1 + N1 + U4 (DELETE open)

Tier 4 — behaviour and surface
  D-10  expiry semantics          ← RATIFIED E2 (decision-time validity)
  D-11  notification scope        ← RATIFIED N-B (strict none + deferral record)
  D-12  escalation                ← follows D-5, D-13
  D-14  API surface               ← RATIFIED A-1 (no HTTP surface)
  D-20  read permission           ← follows D-14
  D-18  error semantics           ← follows D-14, D-17
  D-15  idempotency / concurrency ← RATIFIED (minimal / no added mechanism)
  D-19  audit hash coverage       ← independent; may be ratified any time
```

---

## Design Gate Readiness

# NOT READY — DECISIONS REMAIN

Twenty decisions require ratification; **thirteen (D-1, D-2, D-4, D-5, D-6, D-7, D-8, D-9,
D-10, D-11, D-13, D-14, D-17) are ratified and one (D-3) is ratified in part**; six remain — including **D-16**, which is recorded
as MUST REMAIN OPEN — plus D-3's deferred residual, the decision→parent linkage question
exposed by D-5, and the `rejected`-storage question left open by D-4 clause 5. Eight of them
carry **NO SOURCE-SUPPORTED RECOMMENDATION**, meaning the sources genuinely do
not determine the answer and only project governance can decide: **D-5, D-10,
D-14, D-15, D-17, D-18, D-19, D-20**.

**D-12 is additionally BLOCKED** on three separately-deferred capabilities — a
scheduler, the settings resolver (`FR-PLT-025`, ADR 0008 D-11), and multi-step
approval.

D-2 settled the phase's **size**; D-1 and D-3 settle the **request's shape and its
authority model**; D-5 settles its **structure** as single-step; D-4 settles its
**lifecycle**. **Tier 2 is now complete.** The Design Gate still cannot be written until
the remainder of **Tier 1** (**D-16**, **D-17**) is ratified, and until the two
open data-model questions are resolved — the decision→parent linkage (exposed by D-5) and
the storage of `rejected` (left open by D-4 clause 5).

**The Design Gate has NOT been created. Implementation is NOT authorized.**

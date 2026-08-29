# Approval Governance / Runtime Resolution Gate

**Report type:** Analysis / architecture / governance-resolution gate. **No product code, no migration, no governance-register edit, no commit, no push, no D-21+.**
**Authority statement:** This report is **non-authoritative evidence**. Authority order applied throughout: **(1) `ROS_SRS_v1.0.pdf` → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md` → (3) the repository at HEAD `55e4ae8` → (4) accepted design/implementation reports → (5) engineering inference only where authority is silent.** Where authority is silent this report says **NOT SOURCE-DECIDABLE** and does not convert a recommendation into a fact. Nothing here amends any ratified decision; the ratification proposal in §23 is a **PROPOSAL for the user to approve or reject in chat**, not a register entry.
**Date:** 2026-08-29
**HEAD:** `55e4ae8` — *feat: add mid-shift treasury cash movements* (unchanged; no commit performed)
**Branch:** `feat/production-spec`
**Working tree:** unrelated uncommitted reports and INDEX rows from prior analysis work are present and were **not touched, staged, reverted, cleaned or rewritten**. This report and its INDEX row are the only additions.
**Task identifier:** APPROVAL governance/runtime resolution gate
**Baseline verified:** migrations **31**; OpenAPI **3.1.0 / 138**; P1F-2 and P1G-0 FINAL ACCEPTED; P1G-1 BLOCKED.

> ## VERDICT
> ## **B. USER RATIFICATION REQUIRED — MINIMUM PROPOSAL PROVIDED**
>
> Far more is already ratified than the brief assumed: the **core approval
> request/decision model is essentially fully specified** (D-1 fields, D-4
> lifecycle, D-5 single-step, D-6 mutability, D-7 self-approval, D-8 decision
> immutability, D-9 RLS, D-10 expiry, P-1 linkage). The register is **NOT
> internally contradictory** (§3.3).
>
> **But the decisive finding is that building the Phase 1 approval runtime
> exactly as currently ratified would NOT unblock P1G-1's cash-variance
> approval.** Four ratified decisions jointly remove every path by which a
> manager could actually approve anything: **D-14 A-1** (no HTTP surface),
> **D-2 (a)** (synchronous manager PIN for approvals out of scope), **D-11
> N-B** (no notifications, async out of scope), **D-20** (no read surface).
> D-14 records this consequence in its own words — the phase *"delivers the
> tables and internal service **exercisable only by tests**."*
>
> Unblocking cash-variance approval therefore requires **a D-2 amendment of
> exactly the species already performed on 2026-08-19** for the
> authentication half — and the technical premise D-2 relied on has since
> materially changed (§10.2). Six further items must be settled before a
> migration is writable, one of which (**SB-3**) makes it literally
> unwritable today.
>
> **Two new findings this gate surfaces, neither previously recorded:**
> **(F-1)** D-7's ratified `requester ≠ approver` traversal **does not
> satisfy FR-FIN-006** in the `cash.session.close_other` case (§12.4).
> **(F-2)** Synchronous PIN approval requires **Identity to publish its
> first `contract/` directory** — it has none, and no module is permitted to
> import `employees/pin.service` (§10.3).
>
> The minimum ratification surface is **six decisions**, presented as one
> cohesive proposal in §23. **No implementation is authorized by this gate.**

---

## 1. WHAT THE SOURCES ACTUALLY SAY

### 1.1 The four governing requirements, verbatim (SRS §15.6, lines 3771–3784)

> **FR-SEC-030 [M]** — *"The System SHALL provide a general approval mechanism used by discounts, refunds, purchase orders, waste, count adjustments, expenses, and price changes."*
>
> **FR-SEC-031 [M]** — *"Approval requests SHALL specify: the requesting user, the action, the affected entity, the value, the required approver permission, and an expiry."*
>
> **FR-SEC-032 [M]** — *"Approvals SHALL be obtainable synchronously (manager PIN on the terminal) or asynchronously (push notification to the manager's mobile device), with the terminal remaining usable while awaiting an asynchronous decision."*
>
> **FR-SEC-033 [M]** — *"Approval decisions SHALL record approver, timestamp, decision, and any comment, and SHALL be immutable."*

### 1.2 The two consuming requirements, verbatim

> **FR-FIN-006 [M]** (line 3831) — *"Variance beyond a configurable tolerance SHALL require a reason and approval by a user with `cash.variance.approve`, **who SHALL NOT be the session owner**."*
>
> **FR-SEC-016 [M]** (line 3729) — *"The System SHALL **block, not merely warn**, on the following combinations regardless of role configuration: approving one's own requisition, approving one's own discount, **approving one's own cash variance**, and posting a count one performed where the tenant has enabled strict SoD."*

### 1.3 The only structural statement in the entire SRS — §7.3 row 36

| # | Aggregate Root | Context | Contained Entities | Key Invariants |
|---|---|---|---|---|
| **36** | **ApprovalRequest** | **Governance** | **Steps, Decisions** | **Requester ≠ approver** |

This settles **module ownership** (Governance) and states the aggregate-level invariant. It is the *only* place the SRS describes approval structure.

### 1.4 Table ownership — SRS §25.1, verbatim

```
governance      audit_entries, approval_requests,
                approval_decisions, anomaly_flags
```

**The SRS names both table names explicitly and assigns them to the `governance` schema.** Note that **no `approval_steps` table is named** anywhere in §25.1 — consistent with the register's finding that *"approval step"/"approval_steps"* occurs **ZERO** times in the SRS.

### 1.5 Exhaustive negative findings (verified by full-text search of the extracted SRS)

| Question | Finding |
|---|---|
| Any approval **URL/endpoint**? | **NONE.** Zero `/approval` paths. The only approval-action endpoint anywhere is `POST /v1/purchase-orders/{id}/approve` — Procurement-local, on the *business entity*, in an unimplemented domain |
| Any generic `approval.*` **permission code**? | **NONE.** §15.2 contains only domain-specific approve codes: `pos.discount.approve`, `cash.variance.approve`, `inventory.waste.approve`, `hr.overtime.approve` |
| Any approval **expiry default duration**? | **NONE.** `FR-SEC-031`'s single word *"an expiry"* is the entire basis |
| Any statement that an approval can be **rejected**? | **NONE** — the register's own exhaustive search for *reject/denied/declined* returns no approval hit |
| Any **cancellation** of an approval request? | **Defined nowhere** |
| Any **decision-cardinality** statement (one vs many)? | **NONE** |

### 1.6 The SRS's own consuming pattern — §24.2.3, verbatim

```typescript
class ApplyDiscountHandler {
  constructor(..., private readonly approvals: ApprovalService) {}
  async execute(cmd: ApplyDiscountCommand): Promise<void> {
    ...
    if (decision.requiresApproval && !cmd.approvalId) {
      throw new ApprovalRequiredError(decision.reason);
    }
    order.applyDiscount(cmd.discount, cmd.actor, cmd.approvalId);
```

Three facts follow, and they govern §12–§13: the consuming command **receives an already-existing `approvalId`**; the domain **refuses** when approval is required and none is supplied; and the id is **recorded on the consuming aggregate**. The approval is obtained **before** the business operation, not created inside it.

---

## 2. WHAT IS ALREADY RATIFIED — THE DECISIVE CONTEXT

Current tally, per the register's most recent statements: **17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN**, plus the carried **P-1 (RATIFIED)** and **SB-1/SB-2/SB-3**.

| Decision | Status | Binding content relevant here |
|---|---|---|
| **D-1** | RATIFIED (a) | `approval_requests` gains `value`, `required_permission`, `expiry`. Approved-SQL base: `id, tenant_id, request_type, entity_type, entity_id, requested_by, status, created_at` |
| **D-2** | RATIFIED (a) CORE ONLY, **amended in part 2026-08-19** | **`FR-SEC-032` — BOTH halves — remain knowingly unmet.** The amendment lifted PIN **authentication** only, and says so explicitly (§10.1) |
| **D-3** | RATIFIED IN PART | Authority is **permission-based**, not role-based. No new permission code is created |
| **D-4** | RATIFIED (b) | Lifecycle is exactly `pending → approved` / `pending → rejected`. **Do NOT introduce `cancelled`, `escalated`, `expired`.** Cl. 5 leaves `rejected`-storage to the **Design Gate** |
| **D-5** | RATIFIED (a) | **SINGLE-STEP.** Multi-level chains not implemented |
| **D-6** | RATIFIED (B + Mechanism 1) | `approval_requests` **immutable except `status`**, via the Production GAP-2 mechanism (`REVOKE UPDATE` + `GRANT UPDATE(status)` + status-predicated RLS) |
| **D-7** | RATIFIED (M2) | Self-approval blocked by **`approval_decisions` INSERT RLS `WITH CHECK` `NOT EXISTS` traversal**. No denormalised column, no trigger, **not service-only** |
| **D-8** | RATIFIED (Option 1) | `approval_decisions` **fully append-only** — no UPDATE, no DELETE |
| **D-9** | RATIFIED (S1+N1+U4), amended by D-7 & D-10 | Decisions INSERT `WITH CHECK` = **tenant isolation AND self-approval traversal AND request-unexpired**. DELETE unresolved |
| **D-10** | RATIFIED (E2) | **Decision-time expiry validity.** No `expired` status, **no scheduler**, `expires_at` immutable, enforced at the **DB INSERT boundary** |
| **D-11** | RATIFIED (N-B) | **STRICT NONE.** No notifications, channels, events, outbox, queues, workers or schedulers. `FR-SEC-032` knowingly unmet |
| **D-12** | **BLOCKED** | Escalation. Not reopened here |
| **D-13** | RATIFIED (b) | Governance owns **no thresholds**; the consuming domain decides and supplies the value |
| **D-14** | RATIFIED (A-1) | **NO HTTP/API surface in Phase 1.** Internal service only. Cl. 12: **`FR-API-020` does NOT attach** |
| **D-15** | RATIFIED (minimal) | **NO additional approval-specific concurrency mechanism.** §24.6.4 confines pessimistic locking to two named cases — approval is not one |
| **D-16** | **OPEN — MUST REMAIN OPEN** | `request_type` **enumeration** must not be closed/invented. Cl. 6 + cl. 10: the **representation is a Design Gate question** |
| **D-17** | RATIFIED (A) | Strict Inventory boundary. Cl. 4: association is carried Governance-side via `entity_type` + `entity_id` |
| **D-18** | RATIFIED (E-1) | No Governance-specific error semantics |
| **D-19** | RATIFIED | No additional approval-specific hash coverage. **GAP-11 open** — audit's `approval_id`/`approver_id` sit **outside** the hash |
| **D-20** | RATIFIED (minimal) | **No new Governance read surface.** D-9's fail-closed RLS is the read authorization boundary |
| **P-1** | **RATIFIED 2026-08-18** | See §3 |
| **SB-1** | PARTIALLY RESOLVED | Representation **settled = permission CODE**; **FK posture UNRESOLVED** |
| **SB-2** | PARTIALLY RESOLVED | **`BIGINT` minor units EXCLUDED**; representation UNRESOLVED |
| **SB-3** | **UNRESOLVED** | DELETE posture. DP-1…DP-4 **all unselected** |

### 2.1 Repository state — verified at HEAD `55e4ae8`

**Nothing approval-related is implemented.** No Prisma model named `Approval*`; no migration creating `approval_requests`/`approval_decisions`/`approval_steps`; no source file under `src/` matching `*approv*`. `src/modules/governance/` contains only `audit/` (8 files: module, service, hash, verify, constants + specs).

What *does* exist is exactly four vestigial artifacts, all consistent with the ratified deferrals:

| Artifact | Location | State |
|---|---|---|
| `audit_entries.approver_id`, `.approval_id` | `prisma/schema.prisma:446-447` | Nullable, **no FK**, **never written** by any code |
| `waste_records.approval_request_id` | `prisma/schema.prisma:2860` | Nullable, **no FK**, never read or written — D-17 cl. 6 keeps it NULL |
| `requires_approval` booleans | `count_sessions`, `waste_records` | Caller-supplied gate; both services **refuse to post** when true |
| `inventory.approve_high_variance`, `inventory.waste.approve` | `inventory.permissions.ts:18,23` | Codes defined; **not consulted** by the refusal gates |

**`cash.variance.approve` is NOT seeded** — `treasury.permissions.ts:18` documents it as deliberately absent pending an executable consumer. This is load-bearing for SB-1 (§5.3).

**A negative test locks the current state**: `test/inventory.e2e-spec.ts:644-649` asserts *`governance.approval_requests` was NOT created*. Any future approval migration **must** update this test — a deliberate tripwire of exactly the species P1G-0 updated for its own slice boundary.

---

## 3. P-1 — VERIFIED RATIFIED, CITED VERBATIM

### 3.1 The binding text

Register line 4378 (status marker):

> **STATUS: RATIFIED 2026-08-18 — P-1: `approval_decisions` REFERENCES `approval_requests` DIRECTLY.**

Register line 4606 (the ratification block itself), followed by 18 binding clauses:

> **RATIFIED — P-1: `approval_decisions` SHALL REFERENCE `approval_requests` DIRECTLY.**
>
> 1. **`approval_decisions`'s parent SHALL reference `approval_requests` directly.**
> 2. **`approval_steps` is NOT required by this ratification** and **SHALL NOT be introduced solely because of this decision**.
> … 4. **D-16 remains OPEN and untouched.** 5. **D-12 remains BLOCKED and untouched.**
> … 10. **Do NOT invent** `request_type` representation, `required_permission` representation, `value` type, **DELETE behaviour**, or any other unresolved schema decision.
> … 15. **P-1 is an ARCHITECTURAL CHOICE**, **not** a claim that the SRS mandates direct linkage.
> 16. **P-2 was considered and NOT adopted.**

And the ratification log, line 5893:

> **PARENT LINKAGE — RATIFIED 2026-08-18 — P-1: `approval_decisions` references `approval_requests` DIRECTLY.**

**P-1 is RATIFIED. It is not reopened, not re-compared against P-2, and no alternative parent model is proposed anywhere in this report.**

### 3.2 What P-1 does *not* decide

P-1 cl. 3 is explicit that it does not decide `approval_steps`' existence, `tenant_id`, RLS scope, cardinality or topology; and cl. 10 forbids inventing `request_type`, `required_permission`, `value` or **DELETE behaviour** as a consequence. This report honours all of it — those items are surfaced as *ratification requests*, never as inferences from P-1.

### 3.3 Register internal-consistency check — **NOT CONTRADICTORY**

The brief requires classifying **REGISTER INTERNALLY CONTRADICTORY** if the register contradicts P-1. It does not. But a naive reading *would* flag one, so the check is recorded explicitly:

The register's trailing **"Design Gate Readiness"** section (final 25 lines) states *"thirteen … are ratified"* and lists D-14, D-15, D-17, D-18, D-19, D-20 among those still requiring ratification. The **Final Decision Matrix** (lines 5864–5885) and the ratification log record all six as **RATIFIED**, with the current tally **17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN**.

This is **not** a contradiction. The register operates by **forward supersession with historical text left unedited**, and says so in its own words at line 5904:

> *Note: clauses in D-5, D-7 cl. 9 and D-9 cl. 9 that record linkage as unresolved are **ratified historical text and are deliberately left unedited**; they are superseded forward by this entry, in the register's established manner.*

The trailing readiness section is superseded historical text of exactly that species. **This is the same class of reading error the 2026-08-28 P1G-1 gate made when it mistook P-1's retained analysis line for the register's conclusion** (corrected by the P1G-0 design gate §17). The distinction is recorded here so the error is not repeated a third time: **in this register, a "Final Decision Matrix" row and a dated ratification block outrank any earlier prose.**

---

## 4. D-16 — REQUEST TYPE

### 4.1 What remains unresolved, precisely

D-16 is OPEN, but far less is open than the brief assumes. **D-16's own "what the sources do determine" list settles the type**:

> 5. **The type is `VARCHAR(32)`** (approved SQL), and the `reference_type` precedent supports *not* making it an enum while consuming contexts remain unbuilt.

And D-16's GAP statement:

> **GAP — storage representation.** The sources settle the *type* (`VARCHAR(32)`, per the approved SQL and the `reference_type` precedent) but **not** whether the value set is constrained by a CHECK, an enum, or left open.

**Therefore the only genuinely open sub-question is the CONSTRAINT FORM**, i.e. D-16's options (a) FR-SEC-030's seven / (c) union of eight / (d) unconstrained `VARCHAR(32)` / (e) constrained to live consumers — with **(b) already excluded** by the evidence.

### 4.2 The choice is decisive for P1G-1 — and this is new

D-16's own evidence table lists **nine approval-requiring requirements absent from FR-SEC-030's seven**. Its **first row** is:

| Requirement | Approval-requiring action | In FR-SEC-030's list? |
|---|---|---|
| **`FR-FIN-006` [M]** | **Cash variance beyond tolerance** | **No** |

**Cash variance is one of the nine outside the list.** The consequence is direct and, as far as this gate can determine, not previously recorded:

- **Option (a)** — FR-SEC-030's seven verbatim → **cannot represent cash variance** → **P1G-1 permanently unimplementable**
- **Option (c)** — union of eight → **cannot represent cash variance** → **P1G-1 permanently unimplementable**
- **Option (d)** — unconstrained `VARCHAR(32)` → admits it
- **Option (e)** — constrained to live consumers → admits it only if a cash-variance value is added at the same time

**Choosing (a) or (c) would silently make FR-FIN-006 unsatisfiable.** Only (d) or (e) leave P1G-1 reachable.

### 4.3 Evaluation against the brief's criteria

| Criterion | (d) unconstrained `VARCHAR(32)` | (e) constrained to live consumers |
|---|---|---|
| Extensibility across the 7 + 9 consumers | **Full** — no migration per new consumer | Each new consumer needs a CHECK migration |
| Modular-monolith ownership | **Correct** — values name *other* bounded contexts Governance does not own (D-13: consuming domain decides) | Governance would enumerate other contexts' vocabulary |
| Database integrity | Weaker — no value constraint | Stronger — but constrains a set the SRS says is not closed |
| API stability | N/A — **D-14 A-1: no API** | N/A |
| Migration burden | **None** | One per consumer slice |
| Offline implications | Neutral — value is opaque data | Neutral |
| Auditing / reporting | Equivalent (value is recorded either way) | Equivalent |
| Source-backed wording | **Directly supported** — the `stock_movements.reference_type` precedent is, in D-16's words, *"directly on point"* | Supported but adds a constraint the SRS does not |

The repository precedent D-16 cites is exact:
```sql
reference_type VARCHAR(32) NOT NULL,   -- order, goods_receipt, transfer, count, waste, production
```
implemented as `String @db.VarChar(32)` — *"**deliberately not an enum**, because the values name contexts that do not yet exist"* — against real enums used *"wherever the value set is **closed and owned entirely within that context**."* D-16 distils this into a rule: **"enum where the context owns the closed set; constrained `VARCHAR` where the values name other contexts."** `request_type` is squarely the latter.

**This maps to the brief's option B (string / machine-readable code).** Options A (closed DB enum) and C (module-owned registry of typed codes) are both excluded: A by D-16 cl. 4 (*"must NOT invent a closed seven-value enumeration"*), and C because a Governance-owned registry of other modules' vocabulary contradicts D-13's ratified generic-carrier posture.

### 4.4 Is `cash.variance` source-supported? — **NO**

**NOT SOURCE-DECIDABLE.** The literal string value is not written anywhere:

- The SRS never names any `request_type` **value** for cash variance (it names the *requirement*, FR-FIN-006, and the *permission*, `cash.variance.approve`).
- The approved SQL's comment lists `discount, void, refund, po, expense, waste` — **no cash-variance value**.
- The register never proposes one.

The value **must not be invented as a fact**. §23 proposes one as a governance decision, and marks it as such. Notably the *permission* code `cash.variance.approve` **is** source-named (§15.2) — so a naming convention derived from it is available, but the derivation itself is inference, not authority.

### 4.5 Smallest contract needed now

**`request_type VARCHAR(32) NOT NULL`, no CHECK constraint in this phase**, documented by comment, following the `reference_type` precedent. This admits cash variance without closing the enumeration D-16 forbids closing, and adds zero migration burden for the nine future consumers. **Ratification required** (§23 item 1) — D-16 is OPEN and only project governance can close it.

---

## 5. SB-1 — REQUIRED APPROVER PERMISSION

### 5.1 What is already settled

**Representation is SETTLED and source-supported** (SB-1 resolution, 2026-08-19):

> **SETTLED, source-supported:** `required_permission` **is represented by an existing SRS §15.2 permission CODE**, not by an invented surrogate permission identifier.

Basis: §26.2 renders this exact field as a code (`"requiredPermission": "pos.discount.approve"`); §15.2 is entirely codes; `FR-SEC-011` builds roles by selecting catalogue permissions; and *"the SRS never identifies a permission by a surrogate id anywhere."* This also disposes of the brief's option D and of **RP-3** (store the id).

For the immediate consumer the value is source-named: **`cash.variance.approve`** (§15.2, verbatim: *"Approve a variance beyond tolerance"*).

### 5.2 What remains open

**Only the FK posture** — RP-1 (code, no FK) vs RP-2 (code, FK → `identity.permissions(code)`). SB-1's resolution is explicit: *"**The SRS does not address persistence keys at all.** **UNRESOLVED.**"* This maps to the brief's options A and B respectively; option C (both code snapshot *and* FK) collapses into RP-2, since RP-2 already stores the code.

### 5.3 Evaluation — including one fact the register could not have known

| Consideration | RP-1 (no FK) | RP-2 (FK to `permissions(code)`) |
|---|---|---|
| Permissions may evolve after request creation | **Snapshot survives** any later change | A rename/delete would break or block |
| Historical approval meaning stable | **Yes** — the code is frozen as data | Only with `ON DELETE RESTRICT`, which then blocks catalogue cleanup |
| Tenant/global catalogue ownership | Neutral — `identity.permissions` is global | Cross-schema FK from `governance` → `identity` |
| Migration / runtime coupling | **None** | **Seeding-order coupling** |
| Direct auditability | Equal — code is human-legible in both | Equal |
| No retroactive semantic mutation | **Guaranteed** | Guaranteed only under RESTRICT |

**The seeding-order hazard is concrete, not theoretical.** `cash.variance.approve` is **not currently seeded** — `treasury.permissions.ts:18` records it as deliberately absent because this repository seeds a permission only where an executable consumer exists. Under **RP-2**, an `approval_requests` row for a cash variance could not be inserted until that code is seeded, coupling Governance's write path to Treasury's seeding order. Under **RP-1** the two are independent. This is repository evidence corroborating RP-1, and is offered as **evidence, never as authority** — the choice remains architectural and requires ratification (§23 item 2).

---

## 6. SB-3 — DELETE / IMMUTABILITY POSTURE

### 6.1 The four postures, resolved independently

| Object | Operation | Status | Authority |
|---|---|---|---|
| `approval_requests` | **UPDATE** | **RATIFIED — immutable except `status`** | **D-6** Model B + Mechanism 1 (`REVOKE UPDATE`; `GRANT UPDATE(status)`; status-predicated RLS) |
| `approval_requests` | **DELETE** | **UNRESOLVED** | **SB-3** — DP-1…DP-4 all unselected |
| `approval_decisions` | **UPDATE** | **RATIFIED — prohibited** | **D-8** Option 1, full append-only |
| `approval_decisions` | **DELETE** | **RATIFIED — prohibited** | **D-8** Option 1 |

So three of the four are already settled; **only the request's DELETE posture is open.** The brief's caution is well-placed: *"immutable decision"* (FR-SEC-033) is **not** authority for the request's lifecycle, and D-8's resolution says so — SB-3 records *"**NOT INFERRED FROM D-8.** The request's DELETE posture is **not** derived from `approval_decisions` being append-only."*

### 6.2 Why this genuinely blocks the migration

P-1 coupled two previously separate questions. Because decisions now reference requests **directly**, the FK's `ON DELETE` action determines whether deleting a request can destroy append-only decision rows — the D-8 clause 6 cascade item. SB-3 states it: *"**The DELETE posture and D-8's cascade question are now one coupled problem.**"*

**A migration cannot be written without answering it**, because the FK clause must say *something*. This is the single hardest blocker in this gate.

One option is already eliminated: *"**`ON DELETE CASCADE` (DP-3) is specifically NOT adopted**, because it would permit deletion of append-only `approval_decisions` through the parent."* The live choice is **DP-1** (no DELETE capability) vs **DP-2** (DELETE with `RESTRICT`).

The register records one neutral fact: *"**DP-1 is the only option that requires no empirical verification**, because it removes the delete path that V2 exists to test."* SB-3 also records an evidence gate — under DP-2 the delete behaviour *"requires the previously identified **V2** evidence before implementation"*, and **V2 has never been run**.

CR-04 and audit retention bear on this only indirectly: `FR-AUD-009` retains audit entries ≥ 7 years, so an approval's audit trail survives independently of the request row — SB-3 records this *"as a factor, not an argument."* **Ratification required** (§23 item 3).

### 6.3 Expiry and cancellation are *not* delete questions

- **Expiry** — **RATIFIED (D-10 E2)**: evaluated at decision-INSERT, creates **no** `expired` status, **no** scheduler, does **not** mutate the request. An expired request simply becomes undecidable.
- **Cancellation** — **NOT SOURCE-DECIDABLE.** D-4's analysis: *"Cancellation of an approval request is defined nowhere."* D-4 cl. 3 forbids introducing a `cancelled` state. So **"cancel" is currently neither a state transition nor a deletion** — the capability does not exist and must not be invented. Recorded, not proposed.

---

## 7. GENERAL APPROVAL LIFECYCLE

### 7.1 Already ratified — no invention required

**D-4 (b)**, binding: lifecycle is exactly

```
pending → approved
pending → rejected
```

with cl. 3 forbidding `cancelled`, `escalated`, `expired`, *"or any other invented workflow state."* **The brief's question "does the request need explicit states" is therefore already answered: yes, and exactly these three.**

### 7.2 Stored or derived? — **STORED**, and this is settled

The brief asks whether state should be stored on the request or derived from decisions + expiry. **D-6 settles it**: `approval_requests` is *"immutable **except `status`**"*, and the ratified enforcement mechanism is `REVOKE UPDATE` + **`GRANT UPDATE(status)`**. A column that is granted UPDATE necessarily exists and is written. **`status` is a stored, mutable column — the sole one on the table.**

### 7.3 D-4 clause 5 — resolvable here, and this gate is the right place

D-4 cl. 5: *"It does NOT decide whether `rejected` is stored on `approval_requests`, `approval_decisions`, or both. That remains a separate data-model question for **the Design Gate**."*

**Both — and this is not a duplicate source of truth**, which is the brief's stated concern:

- `approval_decisions.decision` is the **immutable historical fact** — `FR-SEC-033` [M] requires decisions to *"record … decision"*, so this column is **mandatory**, not optional.
- `approval_requests.status` is the **current-state projection** — mandated in substance by D-6, which grants UPDATE on exactly this column and nothing else.

They are different things: an append-only event versus the aggregate's current state, updated exactly once as D-4's terminal lifecycle permits. The one-way, single-transition nature (§8) is what keeps them from diverging. **Ratification requested** (§23 item 4) purely because D-4 cl. 5 explicitly reserved it.

### 7.4 Minimum field set (from FR-SEC-031 + D-1 + FR-SEC-033 + P-1)

**`governance.approval_requests`** — approved SQL `id, tenant_id, request_type, entity_type, entity_id, requested_by, status, created_at` **plus** D-1's ratified three: `value`, `required_permission`, `expires_at`.

Against the brief's minimum list: requesting user → `requested_by` ✓; affected action → `request_type` ✓; affected entity → `entity_type` + `entity_id` ✓; value → `value` ✓; required approver permission → `required_permission` ✓; expiry → `expires_at` ✓.

**Requesting *employee*** — the brief asks whether one is required by the current identity/accountability design. **NOT SOURCE-DECIDABLE, and NOT proposed.** `FR-SEC-031` says *"the requesting **user**"*, and the approved SQL has `requested_by` only. P1D-E established that the *financial* actor is the Employee — but that is a Treasury/P1D-E convention, not a Governance requirement, and D-1 ratified the column set without one. Adding an `employee_id` would exceed FR-SEC-031. **The accountability need is met on the consuming side**, where `cash_sessions` already carries `employee_id`.

**`governance.approval_decisions`** — from `FR-SEC-033` (*"approver, timestamp, decision, and any comment"*) plus **P-1**'s direct parent reference, plus `id` and `tenant_id`. **No `requested_by`** — D-7 cl. 3 explicitly forbids denormalising it.

---

## 8. ONE-DECISION vs MULTI-DECISION SEMANTICS

### 8.1 Source position — **NOT SOURCE-DECIDABLE**

Nothing in the SRS or the register states whether a request may receive one final decision or several. **D-5's ratified SINGLE-STEP does not settle it** — "single step" removes multi-*level* chains (D-12/escalation territory); it does not say whether one step may record a reject and later an approve.

### 8.2 It is nonetheless MANDATORY before schema design

The brief asks precisely this, and the answer is **yes, mandatory**, for three converging reasons:

1. **It determines whether a UNIQUE constraint exists** on `approval_decisions(tenant_id, approval_request_id)`. That is a schema fact, not a runtime detail.
2. **Under D-15 it is the *entire* concurrency strategy.** D-15 ratified *no additional approval-specific concurrency mechanism*, and §24.6.4 confines pessimistic locking to two named cases with approval not among them. With no lock available, **the UNIQUE constraint is the only thing standing between two concurrent managers and two conflicting decisions.**
3. **D-6 permits exactly one `status` transition.** If two decisions could be inserted, `status` would be written twice — but D-4's lifecycle has no transition out of `approved` or `rejected`, so the second write would have no legal target.

Reason 3 is a genuine derivation from ratified decisions rather than a preference, and it points firmly at exactly-one. But because it is a derivation and not a source statement, it is offered as **ratification item 5** (§23), not asserted as fact. **The brief's caution is correct and is honoured: until this is ratified, the concurrency strategy in §20 is NOT settled**, and this report does not pretend otherwise.

---

## 9. D-12 — CAN THE RUNTIME PROCEED WITHOUT IT?

**YES — and this is already ratified, not inferred.**

The brief's exact question: *can the first approval runtime support single required-permission approval and leave escalation / multi-level routing blocked?* **It can.**

- **D-5 RATIFIED — SINGLE-STEP.** The runtime's structure is decided.
- **D-4 cl. 6**: *"D-5 remains RATIFIED — SINGLE-STEP GOVERNANCE PHASE 1. Therefore no multi-level chain states are introduced."*
- **P-1 cl. 2**: `approval_steps` *"is NOT required … and SHALL NOT be introduced solely because of this decision."*
- **D-11 cl. 9**: escalation notifications excluded; *"D-12, which remains BLOCKED."*

`FR-SEC-034` is **[S]** (Should), not [M], and §24.5.3's Chain of Responsibility is its design pattern — both belong to D-12. **D-12 is not reopened, not resolved, and no `approval_steps` table is proposed anywhere in this report.** It remains BLOCKED on its three recorded dependencies (scheduler, settings resolver `FR-PLT-025`, multi-step approval).

---

## 10. SYNCHRONOUS MANAGER PIN — THE CENTRAL BLOCKER

### 10.1 Currently ratified OUT OF SCOPE

This is the finding that determines the verdict.

**D-2 (a) CORE ONLY**, verbatim:

> The synchronous half of `FR-SEC-032` (manager PIN on the terminal) and the asynchronous half (push notification) are both **OUT OF SCOPE** for the first Governance phase. … **`FR-SEC-032` is consequently NOT satisfied and must be recorded as knowingly unmet.**

The **2026-08-19 amendment lifted the defer for four items — and explicitly not this one**:

> - **`FR-SEC-032`** (manager PIN for *approvals*, and push notification) remains **knowingly unmet**; this amendment concerns PIN **authentication**, not the approval workflow. **D-11** (notifications: strict none) is untouched.

**D-11 cl. 3–4** independently reaffirm it: *"`FR-SEC-032` remains explicitly OUT OF SCOPE … The **synchronous manager-PIN** and **asynchronous** … behaviours … remain **knowingly unmet** and **MUST NOT be silently reintroduced**."*

**Consequence, stated plainly:** with D-14 A-1 (no HTTP surface), D-2 (a) (no sync PIN approval), D-11 N-B (no async), and D-20 (no read surface) all in force, **there is no path by which any human can approve anything.** D-14 records this in its own words:

> **CONSEQUENCE RECORDED (D-14, 2026-08-17).** Under A-1, Governance Phase 1 has **no consuming domain and no HTTP surface** … The phase therefore delivers the tables and internal service **exercisable only by tests**.

**Building the approval runtime exactly as ratified would not unblock P1G-1.** FR-FIN-006 would remain unsatisfiable. This must be resolved by governance, not by design.

### 10.2 The premise D-2 relied on has materially changed

D-2 chose (a) because the synchronous half would *"pull in PIN authentication (`FR-SEC-021`, `FR-SEC-022`) and branch-scoped RBAC"*, citing the SRS-explicit chain `FR-SEC-002 → FR-SEC-021/022 → FR-SEC-032`. Its repository evidence at the time (2026-08-17) read:

> **No PIN implementation anywhere in `src/modules`** — `identity.credentials` stores Argon2 password hashes only.

**That is no longer true.** The 2026-08-19 amendment lifted `FR-SEC-021`/`FR-SEC-022` in full, and the P1D-E substrate shipped them. `PinService` now exists with lockout, salted hashing, branch-permitted validation and terminal binding. **Two of the three links in D-2's own dependency chain are now satisfied** — only `FR-SEC-032` itself remains deferred, and the broader `FR-SEC-002` branch-scoped RBAC (which the amendment kept deferred) is **not** required for manager-PIN approval, because `PinService.authenticate` already performs the branch check `FR-SEC-021` requires.

This is a factual change in the repository, offered as **evidence that the ratification is worth revisiting** — not as authority to lift it. Only the user can do that (§23 item 6).

### 10.3 The correct architecture when lifted — brief's option A, with a new consequence

**Option A — a Governance command consuming an Identity PIN-verification contract — is correct.** Option B (short-lived approval principal/token) invents a new auth architecture with no source basis and is rejected. Option C has no existing mechanism to point at.

The technical fit is unusually good, because **`PinService.authenticate` is already a pure verification that mints no session**:

```typescript
// pin.service.ts:281
async authenticate(tenantId, terminalId, employeeCode, pin): Promise<PinAuthResult>

// pin.service.ts:22-40
type PinAuthResult = { employeeId; userId; branchId; terminalId; membershipId }
```

It returns **identity facts, not a token** — token minting happens separately in `AuthService.loginWithPin`. It already validates: active terminal, active employee, terminal's branch ∈ employee's permitted branches, active membership, Argon2 verify, and lockout. That is precisely what a manager-approval step-up requires.

**FINDING F-2 — a new architectural consequence, not previously recorded.** Publishing this capability requires **Identity to gain its first `contract/` directory**. Verified: `src/modules/identity/` has **no `contract/`** — it publishes via Nest `exports` only, and every consumer reaches it through recorded `KNOWN_DEVIATIONS` private-path entries. Critically, **no module is permitted to import `employees/pin.service`** — `sales->identity` and `treasury->identity` cover only `auth/auth.types`, decorators and guards. So:

- **Treasury must not verify PIN hashes** (the brief's constraint) — and mechanically **cannot**: `module-boundaries.spec.ts` would fail the import, and its `KNOWN_DEVIATIONS` list is asserted **exactly**, so debt cannot grow silently.
- **Governance must not duplicate Identity authentication logic** — and need not.
- The conformant path is a new **`identity/contract/pin-verification.query.ts`** exporting a Symbol token + interface, with `PinService` bound to it — exactly the pattern `treasury/contract/cash-session-facts.query.ts` and the other eight contract directories already follow (Symbol + interfaces only; no class, no `@Injectable`, no Prisma call, no `any` — all mechanically enforced).

This is a **design consequence to be settled in the runtime design gate**, not something to ratify now; it is recorded here so the eventual gate does not discover it late.

---

## 11. ASYNCHRONOUS APPROVAL

### 11.1 Ratified out — no substrate to build

**D-11 N-B STRICT NONE**, cl. 2, is exhaustive:

> Governance Phase 1 **MUST NOT** introduce notification channels, in-app notifications, notification persistence tables, notification endpoints, notification permissions, approval notification events, outbox infrastructure, queues, workers, schedulers, or other notification-delivery infrastructure.

The brief's instruction — *"Do NOT build notification infrastructure if the SRS only requires the request to remain pending and retrievable"* — is therefore already governed, and more strictly than the instruction contemplates.

### 11.2 Separating the four concerns, as the brief requires

| Concern | Status |
|---|---|
| **Persisted pending `ApprovalRequest`** | **In scope** — it is the `status='pending'` row; nothing further is needed |
| **Polling / read / query surface** | **Ratified out — D-20**: no new Governance read surface; D-9's fail-closed RLS is the read authorization boundary |
| **Notification / push infrastructure** | **Ratified out — D-11 N-B** |
| **Terminal UI behaviour** | Out of scope entirely (no client in this repository) |

### 11.3 Is a read/list API necessary for conformance? — **No, and it would be prohibited**

**D-20 RATIFIED — no new Governance read surface**, and **D-14 A-1** — no HTTP surface at all. So no read API may be built. Authorization for such reads is moot; had it been required, §15.2 supplies **no** approval-read code — D-20 records that *"the code is not derivable"* and **DEFERRED, not invented** it, with `FR-AUD-008` remaining a knowingly-unsatisfied gap.

**Honest conclusion:** FR-SEC-032's asynchronous half — including *"the terminal remaining usable while awaiting an asynchronous decision"* — is **not achievable in this phase and is already ratified as knowingly unmet** by D-2 and D-11. This report proposes no change to that. **Only the synchronous half is proposed for lifting** (§23 item 6), because only it is required to satisfy FR-FIN-006.

---

## 12. CASH VARIANCE AS FIRST CONSUMER

### 12.1 What FR-FIN-006 + FR-SEC-016 jointly demand

Four facts must be provable historically: (i) which request authorised the variance; (ii) which immutable decision approved it; (iii) who approved; (iv) that the approver held `cash.variance.approve` **and was not the session owner**.

### 12.2 What P1G-1 should persist — **`approval_request_id` only**

**Store the request id; do not also store the decision id.** Four independent sources converge:

1. **SRS ERD** (line 2101): `order_discounts ──0:1── approval_requests` — the consuming row points at the **request**.
2. **Repository precedent**: `waste_records.approval_request_id` already exists as exactly this column.
3. **SRS §24.2.3** (§1.6 above): the consuming command receives `cmd.approvalId` and records it on the aggregate.
4. **P-1**: because decisions reference requests **directly**, the decision is reachable from the request by a single join — storing both would duplicate a derivable fact, which the brief explicitly forbids.

All four historical facts remain provable: request → its columns (`required_permission`, `value`, `expires_at`, `requested_by`); request → decision via P-1 (approver, timestamp, decision, comment). **Neither** is derivable without the stored `approval_request_id`, so exactly one column is both necessary and sufficient.

**Timing note.** `FR-FIN-007` [M] makes a cash session immutable once closed, so the column must be written **within the closing transaction**, not afterwards. That is compatible with §24.2.3's pattern, where the approval exists *before* the business command runs.

### 12.3 Is a Treasury → Governance column permitted? — **NOT SOURCE-DECIDABLE**

**D-17 binds Inventory only.** Its cl. 1 restricts *"any object in the `inventory` schema"*; cl. 3 forbids adding `approval_request_id` to **Inventory** tables; cl. 4 routes Inventory association through `entity_type` + `entity_id` instead.

Two readings are genuinely available and the sources do not choose between them:

- **Reading A — D-17's posture is Inventory-specific.** It was a boundary decision for *Governance Phase 1*, which was forbidden to touch another module's schema. A *Treasury* migration adding its own column is a different act by a different owner, and the SRS §24.2.3 / ERD / `waste_records` pattern supports it.
- **Reading B — D-17's posture generalises.** Cl. 4 establishes how Governance Phase 1 represents association at all, and cl. 5 forbids reverse associations; extending that to Treasury keeps one consistent pattern.

**Classified NOT SOURCE-DECIDABLE.** Recorded for the user, with the observation that Reading A is better supported by the SRS's own three pattern statements (§12.2), while Reading B is better supported by consistency with the one ratified precedent. Under **either** reading the association is representable — Reading B via `entity_type='cash_session'` + `entity_id` on the Governance side — so **this does not block P1G-1**, and it is deliberately **not** included in the minimum ratification set (§22).

### 12.4 **FINDING F-1 — D-7 does not satisfy FR-FIN-006 under `cash.session.close_other`**

This gate's most consequential technical finding, and it appears nowhere in the register.

**D-7 M2** enforces **requester ≠ approver** — an RLS `NOT EXISTS` traversal from the decision's approver to the request's `requested_by`. **FR-FIN-006 requires approver ≠ *session owner*.** These coincide only when the requester *is* the session owner.

They diverge in a case the SRS explicitly supports: **`cash.session.close_other`** (§15.2, *"Close another user's shift"*). When a supervisor closes another employee's session:

- `requested_by` = the **closing supervisor**
- session owner = a **different** employee
- D-7's traversal blocks the **supervisor** from approving — correct but insufficient
- **The session owner is NOT blocked from approving their own variance** — the exact combination `FR-SEC-016` [M] requires the system to *"block, not merely warn … regardless of role configuration."*

The register corroborates that this was never in view: **D-7 cl. 10** states *"No claim is made that the Phase 1 implementation satisfies the Procurement, Sales, **Finance**, or strict-SoD-specific `FR-SEC-016` combinations that are **outside Phase 1 scope**."* Cash variance is the Finance combination, and it was out of scope — so D-7 was never tested against it. **Bringing cash variance in-scope is precisely what exposes the gap.**

Three candidate resolutions, none source-decided:

| | Resolution | Assessment |
|---|---|---|
| **R-a** | Define the requester as the **session owner**, not the closer | Smallest change; needs no new column; but misstates `FR-SEC-031`'s *"requesting user"* when a supervisor is genuinely the requester |
| **R-b** | Carry the session owner in the request's immutable subject facts and extend the decision-INSERT `WITH CHECK` to exclude them | Preserves D-7's DB-enforced posture and `FR-SEC-016`'s *"block, not warn"*; requires a Governance predicate to read a domain-specific fact, in tension with D-13's generic-carrier posture |
| **R-c** | Enforce approver ≠ session owner in Treasury's close service | Contradicts **D-7 cl. 5** — *"Do NOT rely on service-level enforcement alone"* — and `FR-SEC-016`'s *"regardless of role configuration"* |

**R-c should be rejected on D-7's own text.** Between R-a and R-b the sources do not choose. **This must be resolved in the runtime design gate**, and it is flagged in §23 as a required design-gate input rather than a ratification item, because it is a design question that only becomes concrete once the subject-snapshot shape (§14) is fixed.

---

## 13. SUBJECT / AFFECTED ENTITY MODEL

**Already settled — this is not an open question.** The brief's option **C** (generic `entity_type`/`entity_id` matching audit conventions) is what the approved SQL specifies, what **D-1** ratified around, and what **D-17 cl. 4** names as the association mechanism:

> Inventory approval association in Governance Phase 1 is represented through: `governance.approval_requests.entity_type` and `governance.approval_requests.entity_id`.

Option A (`subject_type`+`subject_id`) is the same shape under different names and would gratuitously diverge from the approved SQL. Option B (`request_type`+`subject_id`) conflates two ratified-distinct columns. Option D (module-specific payload only) cannot satisfy `FR-SEC-031`'s *"the affected entity"*.

**Referential integrity — no fake cross-module FK.** `entity_id` is an un-FK'd UUID, exactly like `audit_entries.entity_id` in the shipped schema. A real FK is impossible: `entity_id` must address rows in `treasury`, `inventory`, `sales`, `procurement` and more, and PostgreSQL FKs target exactly one table. **D-17 cl. 3 independently forbids** FKs from consuming domains to Governance. The `audit_entries` precedent — un-FK'd `entity_type`/`entity_id`, shipped and accepted — is directly on point.

**Typed columns vs JSON.** `entity_type`/`entity_id`/`request_type`/`required_permission`/`expires_at`/`requested_by`/`status` are typed columns (D-1's ratified set). Whatever additional subject facts are needed (§14) is the open `value` question (SB-2), **not** a licence to add a general JSON payload. Module boundaries remain mechanically enforceable because Governance stores only opaque identifiers and never joins to another module's tables.

---

## 14. VALUE / PAYLOAD SNAPSHOT

### 14.1 What is settled

**SB-2 settled one thing — an exclusion:** *"`BIGINT` minor units is **NOT** an appropriate representation for `approval_requests.value`."* Approval-triggering values span percentage, absolute amount, count and boolean across `FR-POS-047`, `FR-INV-046`, `FR-HRM-034`; §26.2's only worked example is a **percentage**. **The repository's BIGINT money convention is explicitly NOT transferable here.**

This creates a real tension for the first consumer: **a cash variance *is* monetary** (minor units), yet the column carrying it must be generic. Recording it as a decimal is representable but sits against ADR-008's money discipline. **Recorded, not resolved** — VT-1/VT-2/VT-3/VT-5 remain unselected and SB-2 is **not** included in the minimum ratification set, because §14.3 shows the runtime does not depend on it.

### 14.2 Immutability of the proposal — already guaranteed

The brief's concern is that *"approval must authorise a specific immutable proposal, not a mutable pointer whose meaning can change afterward."* **D-6 already guarantees this**: `approval_requests` is immutable except `status`. Every fact in the request row — `value`, `required_permission`, `expires_at`, `entity_id`, `requested_by` — is **frozen at creation** by ratified `REVOKE UPDATE`.

### 14.3 Request fingerprint / hash — **NOT REQUIRED, and not proposed**

The brief asks whether a fingerprint is needed. **No**, on two grounds:

1. **The immutable row is itself the snapshot.** A fingerprint detects tampering with a mutable record; D-6 makes the record immutable at the database layer. A hash would restate a guarantee already enforced.
2. **No source basis exists.** `FR-SEC-031` enumerates six elements and a hash is not among them; **D-19** ratified *no additional approval-specific hash coverage in Phase 1*. Adding one would be invention.

**Consequence for §12/§14 combined:** the facts the approval must freeze for cash variance (session id, expected, counted, variance, reason, owner, branch, currency) do **not** all need to live in Governance. `entity_id` immutably identifies the CashSession; `FR-FIN-007` makes the closed session immutable; the variance facts live on the session where P1G-1's own design gate placed them. **Governance need carry only what `FR-SEC-031` enumerates.** The brief's caution — *"Do NOT assume this exact list is authoritative; derive it"* — resolves to: **most of that list belongs to Treasury, not Governance.** This is what keeps SB-2 off the critical path.

---

## 15. EXPIRY

| Question | Answer | Authority |
|---|---|---|
| Storage type | `TIMESTAMPTZ`, immutable after creation | **D-10 cl. 1, cl. 7** |
| Who chooses it | **NOT SOURCE-DECIDABLE** | See below |
| System default duration | **NOT SOURCE-DECIDABLE** | D-10: *"The SRS defines nothing about: detection, **default duration**, status effect…"* |
| Minimum / maximum | **NOT SOURCE-DECIDABLE** | No source addresses either |
| Approval after expiry rejected? | **YES — RATIFIED** | **D-10 cl. 3**: a decision *"MUST NOT be inserted"* for an expired request |
| New event/state, or derived from clock? | **Derived at decision time. No `expired` status, no scheduler.** | **D-10 cl. 4, 5, 6**; enforced at the DB INSERT boundary (cl. 8) via D-9's amended `WITH CHECK` (cl. 9) |

**On "who chooses":** **D-13** ratified that the consuming domain determines whether approval is required and supplies the value, which by analogy suggests the consuming domain supplies `expires_at`. But D-13's ratified subject is **thresholds and value**, not expiry, and this report does not extend a ratified decision by analogy. **NOT SOURCE-DECIDABLE.**

**No duration is invented here** — not fifteen minutes, not any other figure. Because a caller-supplied `expires_at` requires no default at all, this is **not** in the minimum ratification set (§22): the runtime can be built with the consuming domain passing an explicit value, deferring the default until a consumer needs one.

---

## 16. AUTHORIZATION

### 16.1 Approving — source-backed, and elegantly self-describing

**No generic `approval.*` permission exists or is invented.** The approver's authority is **the permission the request itself names** in `required_permission` — for cash variance, the source-named `cash.variance.approve`. This is consistent with **D-3** (authority is permission-based) and **D-1** (*"No new permission code is created: the field references an existing SRS §15.2 code as data"*).

`approval.request.create`, `approval.approve`, `approval.read`, `approval.admin` — **none is named by the SRS or the register, and none is proposed.**

### 16.2 Creating a request — the Class C/E problem dissolves

The brief rightly flags that prior governance classified create/approve routes as **Class C (+E)**:

> | **Create approval request** | **C** (+**E**) | No SRS route. Would be a ratified deviation (GAP-1 precedent). **E on D-16** — the `request_type` contract is deliberately open |

**That classification attaches to an HTTP *route*. Under D-14 A-1 there is no route**, so the problem does not arise. The brief's own option — *"internal module command as a consequence of an already-authorised business action"* — is what D-14 ratified:

> 2. Governance remains an **internal service/application capability**, consistent with the `ApprovalService` usage described in **SRS §24.2.3**.

So the request is created **inside** an already-authorised business operation (the CashSession close, gated by `cash.session.close` / `cash.session.close_other`). The user is authorised for the *business action*; the approval request is a consequence, not a separately-permissioned act. **No create permission is needed, and none is invented.** The `+E on D-16` dependency is addressed by §4 (ratification item 1), not hidden.

**FR-SEC-031's `required_approver_permission` is correctly not treated as permission to create a request** — the brief's caution is right, and the resolution above means no creation permission is required at all.

---

## 17. API SURFACE

**The SRS specifies no Approval URLs** (§1.5) and **D-14 A-1 ratified that none exists.** Classification of the four candidate operations:

| Operation | Classification | Basis |
|---|---|---|
| Create approval request | **GOVERNANCE-RATIFIED ABSENT** | D-14 A-1 cl. 3 — *"Do not introduce POST, PATCH, GET, DELETE …"*. Created by internal command (§16.2) |
| Synchronous manager-PIN approve/reject | **GOVERNANCE-RATIFIED ABSENT** (D-14 A-1) **and out of scope** (D-2 (a), D-11 cl. 4) | If D-2 is amended (§23 item 6), the surface belongs on the **consuming** route, not a Governance route — see below |
| Asynchronous approve/reject | **GOVERNANCE-RATIFIED ABSENT** | D-14 A-1 + D-11 N-B |
| Get pending request / status | **GOVERNANCE-RATIFIED ABSENT** | D-14 A-1 + **D-20** (no new read surface) |

**No URL is invented. No `/v1` prefix is retrofitted** (the repository serves unversioned paths; the SRS's `/v1` examples were not adopted, and D-14 lists `/v1` among unresolved items).

**Where the manager PIN would be carried, if D-2 is amended.** Not on a new Governance endpoint — that would contradict D-14 A-1 — but as **fields on Treasury's existing close route**, exactly as the SRS's §24.2.3 pattern has the consuming command carry `cmd.approvalId`. The consuming route is already `@Idempotent()`-decorated in this repository's established pattern (P1G-0's three movement routes, `orders.controller.ts`, `treasury.controller.ts`).

**`FR-API-020` — accurately stated.** **D-14 cl. 12** records that it *"does NOT attach to a Governance HTTP surface in Phase 1, because no Governance POST/PATCH endpoint is ratified."* The brief's instruction that *"All POSTs must use Idempotency-Key"* is therefore satisfied vacuously for Governance, and **substantively** for the operation that matters: the Treasury close POST carries `Idempotency-Key`, and the approval created within its transaction inherits at-most-once behaviour from it. **This is the correct and only conformant place for the idempotency guarantee**, and it needs no Governance-specific mechanism — consistent with **D-15**.

**No RFC 7807 claim is made.** **D-18 E-1** ratified no Governance-specific error semantics; §26.2's Problem Details example is a **POS discount** error, detached from Governance by D-14 A-1 and D-18 E-1.

---

## 18. TENANCY / RLS / MODULE OWNERSHIP

**Ownership is SOURCE-DECIDED, twice over:** SRS §7.3 row 36 assigns `ApprovalRequest` to the **Governance** context, and SRS §25.1 assigns `approval_requests` and `approval_decisions` to the **`governance`** schema by name. **The tables must not be placed in Treasury**, and this report proposes nothing of the kind.

**Ratified RLS posture (D-9 S1+N1+U4, amended by D-7 and D-10):**

| Requirement | Status |
|---|---|
| `tenant_id` on both tables | Ratified (D-1; D-9) |
| `ENABLE` + `FORCE` ROW LEVEL SECURITY | Repository-wide invariant, verified across every tenant-scoped table |
| `ros_app` holds no `BYPASSRLS` | Verified repository-wide (`NOBYPASSRLS`) |
| Fail closed with no tenant context | Ratified — `NULLIF(current_setting('app.tenant_id', true), '')::uuid`; D-20 relies on it as the read boundary |
| `approval_requests` UPDATE | `REVOKE UPDATE`; `GRANT UPDATE(status)`; status-predicated policy (**D-6 Mechanism 1**) |
| `approval_decisions` INSERT `WITH CHECK` | **tenant AND self-approval traversal AND request-unexpired** (D-9 cl. as amended by D-7 cl. 2 and D-10 cl. 9) |
| `approval_decisions` UPDATE / DELETE | Prohibited — append-only (**D-8**) |
| `approval_requests` DELETE | **UNRESOLVED — SB-3** (§6) |

**Tenant-safe structural relations.** P-1's direct linkage must be tenant-safe: the decisions → requests FK should be the **composite** `(tenant_id, approval_request_id) → approval_requests(tenant_id, id)`, matching this repository's established composite-FK discipline (P1F-2's five tables, P1G-0's `cash_movements`). This makes a cross-tenant decision→request pair **structurally unrepresentable** rather than merely policy-blocked. The `ON DELETE` action is **SB-3-dependent** and cannot be written until §23 item 3 is ratified.

**Cross-tenant prohibitions — all three the brief names are satisfied:** request → decision by the composite FK above; request → subject context by RLS on the subject's own table plus the tenant-scoped `entity_id`; decision → approver context by the tenant-scoped membership check that D-9's tenant conjunct enforces.

---

## 19. IMMUTABILITY / AUDIT

**Domain persistence and audit are correctly separated**, and the brief's framing is right: an `ApprovalDecision` is itself an **immutable business fact** (D-8, FR-SEC-033), while audit is **evidence about** its creation and use. **Audit is never the source of approval state** — D-20 confirms the read boundary is RLS over the real tables, not the audit log.

**Audit actions required** (following the shipped `AUDIT_ACTION` taxonomy pattern, and P1G-0's own precedent of adding one verb per genuinely distinct event):

| Event | Recommended | Note |
|---|---|---|
| Request created | Yes | The requesting act |
| Decision approved | Yes | Distinguished by outcome, or one verb with the outcome in metadata — the `STOCK_MOVEMENT_RECORDED` / `CASH_MOVEMENT_RECORDED` precedent favours **one verb + metadata** |
| Decision rejected | Yes (same treatment) | |
| Request expired | **No** | **D-10 cl. 5–6**: expiry does not mutate the request and introduces no process. There is no event to record — an expired request is simply undecidable |
| Approval consumed by a business operation | **Already covered** | The consuming operation writes its own audit entry (P1G-1's close), which will carry the approval reference |

**GAP-11 recorded, not closed.** `audit_entries.approval_id` and `.approver_id` are **outside** the hash chain — D-19 ratified no additional approval-specific hash coverage, and *"the ten-field hash-coverage question remains open."* Consequence, stated plainly: **audit-recorded approval linkage is not tamper-evident to the same standard as the rest of the chain.** This is a known, ratified-open weakness, and it is a further reason the authoritative approval record must be `governance.approval_decisions` (append-only, D-8) rather than the audit row. **Not reopened here.**

**Hash-chained governance audit is preserved** — no change to `computeEntryHash`, `stableStringify` or the chain is proposed.

---

## 20. CONCURRENCY / IDEMPOTENCY

### 20.1 The governing constraint

**D-15 RATIFIED — no additional approval-specific concurrency mechanism.** §24.6.4 confines pessimistic locking to **order-number allocation and count-session exclusivity**; approval is not among them. **No advisory lock, no `SELECT … FOR UPDATE`, no version column may be introduced for approvals.** This is a materially tighter constraint than the brief anticipates, and it means the mechanism must be **declarative** — constraints and RLS predicates only.

### 20.2 The eight required scenarios, mapped to actual mechanisms

| # | Scenario | Mechanism | Settled? |
|---|---|---|---|
| 1 | Two managers approve the same request concurrently | **UNIQUE `(tenant_id, approval_request_id)`** on decisions — one wins, one gets a unique violation | **Only if §8 is ratified** |
| 2 | Approve vs reject, same request | Same UNIQUE constraint | **Only if §8 is ratified** |
| 3 | Approval after expiry boundary | **D-9/D-10 `WITH CHECK` unexpired conjunct**, evaluated inside the INSERT | **Settled — ratified** |
| 4 | Repeated same decision business id | Primary key on the decision's client-supplied id (FR-OFF-015 pattern) | Design-gate detail |
| 5 | `Idempotency-Key` replay | **Consuming route's** interceptor (§17); no Governance surface exists to key | **Settled** |
| 6 | Same key, different fingerprint | Consuming route → 409, existing shipped behaviour | **Settled** |
| 7 | Self-approval concurrent with valid manager approval | **D-7 M2 `WITH CHECK` traversal** — evaluated per-INSERT, so concurrency cannot bypass it. **But see F-1 (§12.4)** for the cash-variance gap | **Settled for requester≠approver; NOT settled for approver≠session-owner** |
| 8 | Approval consumption vs business-action retry | Consuming route's `Idempotency-Key` + the close transaction's own atomicity | **Settled** |

### 20.3 Honest statement of what is not settled

**The brief's caution is correct and is honoured: because exactly-one-final-decision is NOT ratified (§8), the concurrency strategy is NOT settled.** Scenarios 1 and 2 — the two the brief lists first — have **no mechanism at all** until that ratification lands, since D-15 forecloses locking and only a UNIQUE constraint remains. **This report does not pretend the strategy is settled**, and this is precisely why §8 is a mandatory ratification item rather than a design-gate detail.

**Testing discipline (for the eventual implementation, not authorized here):** real PostgreSQL, two genuine connections, deterministic barriers, `pg_stat_activity` polling for genuine contention, **no sleeps as correctness proof**, ≥3 clean runs — the discipline P1F-2 and P1G-0 already established.

---

## 21. SCHEMA DESIGN — CONTINGENT, NOT PROPOSED FOR EXECUTION

**No migration is written. Migration 32 is NOT created.** The shape below is recorded **only** to demonstrate that the §23 ratifications are sufficient and necessary; it is **contingent on all six** and on a subsequent runtime design gate.

**`governance.approval_requests`** — owner: Governance

| Column | Type | Null | Notes / Authority |
|---|---|---|---|
| `id` | `UUID` PK | NO | Approved SQL |
| `tenant_id` | `UUID` | NO | D-1, D-9; FK → `identity.tenants` |
| `request_type` | `VARCHAR(32)` | NO | D-16 §4 — **no CHECK this phase** (item 1) |
| `entity_type` | `VARCHAR(48)` | NO | Approved SQL; audit convention |
| `entity_id` | `UUID` | NO | **No FK** — polymorphic (§13) |
| `requested_by` | `UUID` | NO | FK → `identity.users`; D-7's traversal target |
| `required_permission` | `VARCHAR(64)` | NO | SB-1 settled = code; **FK posture** = item 2 |
| `value` | **SB-2 UNRESOLVED** | — | `BIGINT` excluded. Not on the critical path (§14.3) |
| `expires_at` | `TIMESTAMPTZ` | NO | D-10 — immutable |
| `status` | `VARCHAR(16)` | NO | D-4 `pending\|approved\|rejected`; **the ONLY mutable column** (D-6) |
| `created_at` | `TIMESTAMPTZ` | NO | Approved SQL |

Constraints: `UNIQUE (tenant_id, id)` (composite-FK target). **Immutability:** `REVOKE UPDATE`; `GRANT UPDATE(status)`; status-predicated RLS (D-6 Mechanism 1). **DELETE:** item 3. **RLS:** ENABLE + FORCE, tenant-scoped, fail-closed. **Indexes:** `(tenant_id, status)`, `(tenant_id, entity_type, entity_id)`.

**`governance.approval_decisions`** — owner: Governance

| Column | Type | Null | Notes / Authority |
|---|---|---|---|
| `id` | `UUID` PK | NO | |
| `tenant_id` | `UUID` | NO | D-9 |
| `approval_request_id` | `UUID` | NO | **P-1 direct parent**; composite FK `(tenant_id, approval_request_id)` → `approval_requests(tenant_id, id)`; `ON DELETE` per item 3 |
| `approver_id` | `UUID` | NO | FR-SEC-033 *"approver"*; FK → `identity.users` |
| `decision` | `VARCHAR(16)` | NO | FR-SEC-033 *"decision"*; D-4 values |
| `comment` | `TEXT` | YES | FR-SEC-033 *"any comment"* — *any* implies optional |
| `decided_at` | `TIMESTAMPTZ` | NO | FR-SEC-033 *"timestamp"* |
| `created_at` | `TIMESTAMPTZ` | NO | |

Constraints: **`UNIQUE (tenant_id, approval_request_id)`** — contingent on item 5; it is the entire concurrency mechanism (§20). **Immutability:** `GRANT SELECT, INSERT`; `REVOKE UPDATE, DELETE, TRUNCATE` (D-8). **RLS:** ENABLE + FORCE; INSERT `WITH CHECK` = **tenant AND self-approval traversal AND request-unexpired** (D-9 as amended by D-7, D-10). **No `requested_by`** (D-7 cl. 3).

**`approval_steps` is NOT proposed** — P-1 cl. 2/12, D-5, and §25 all forbid it. **D-12 is not solved.**

---

## 22. MINIMUM GOVERNANCE DECISIONS — CLASSIFIED

### ALREADY RATIFIED (no user action)

P-1 direct linkage · D-1 field set · D-2 amended PIN-authentication substrate · D-3 permission-based authority · D-4 lifecycle · D-5 single-step · D-6 request immutability except `status` · D-7 M2 self-approval mechanism · D-8 decision append-only · D-9 RLS + amendments · D-10 expiry semantics · D-11 no notifications · D-13 domain-owned thresholds · D-14 no HTTP surface · D-15 no extra concurrency mechanism · D-17 Inventory boundary · D-18 error semantics · D-19 hash coverage · D-20 no read surface.

### SOURCE-DECIDED (no ratification needed)

Governance owns both tables (§7.3 #36, §25.1) · table names (§25.1) · `required_permission` is a **code** (SB-1) · `request_type` type is **`VARCHAR(32)`** (D-16 finding 5) · `BIGINT` excluded for `value` (SB-2) · subject model is `entity_type`+`entity_id` (approved SQL, D-17 cl. 4) · approver authority is the request's own `required_permission` (D-1, D-3) · **`cash.variance.approve`** is the code for the first consumer (§15.2).

### NOT SOURCE-DECIDABLE BUT NOT BLOCKING

Expiry **default duration** and who chooses it (§15 — caller-supplied needs no default) · `value` representation, SB-2 (§14.3 — the facts live in Treasury) · whether Treasury may carry `approval_request_id`, §12.3 (representable either way) · `approval_steps` existence (D-12, not needed) · request **cancellation** semantics (§6.3 — capability does not exist; must not be invented).

### USER RATIFICATION REQUIRED BEFORE IMPLEMENTATION — **six items**

1. **D-16 constraint form** — unconstrained `VARCHAR(32)` (option (d)). *Blocking:* (a)/(c) make FR-FIN-006 unsatisfiable (§4.2).
2. **SB-1 FK posture** — RP-1 vs RP-2. *Blocking:* the column cannot be written without it.
3. **SB-3 DELETE posture** — DP-1 vs DP-2. *Blocking:* the FK's `ON DELETE` clause is unwritable without it (§6.2).
4. **D-4 clause 5** — `rejected` storage. *Blocking:* determines whether `decision` and `status` both exist. Explicitly reserved to the Design Gate.
5. **Decision cardinality** — exactly one final decision. *Blocking:* determines the UNIQUE constraint, which under D-15 is the **entire** concurrency mechanism (§8.2, §20.3).
6. **D-2 synchronous-half amendment** — *Blocking:* without it **no human can approve anything** and P1G-1 cannot be unblocked at all (§10.1).

### DEFERRED / BLOCKED — OUTSIDE THIS SLICE

**D-12** escalation (BLOCKED, untouched) · `FR-SEC-032` **asynchronous** half (D-11 N-B, knowingly unmet) · `FR-SEC-035` offline approval policy · **GAP-11** audit hash coverage (D-19) · **D-3 residual** (`approver_role_id`, travels with multi-step) · **D-8 cl. 6 cascade verification / V2** (dissolved under DP-1, required under DP-2) · Governance read surface and `FR-AUD-008` (D-20) · granted-approval staleness (D-10 cl. 11–12).

**Deliberately excluded from the minimum set** to keep the ratification surface as small as the brief demands: SB-2, expiry default, D-17 extension, and F-1's resolution (a design-gate input, §12.4).

---

## 23. RATIFICATION PROPOSAL — FOR USER APPROVAL IN CHAT

> **This is a PROPOSAL. It is NOT written into the Governance Decision Register.** It creates **no D-21+**, uses the register's existing **carried-item / amendment** mechanism, **does not modify P-1**, keeps **D-12 BLOCKED**, and leaves unrelated SB items untouched. It is scoped to exactly what `FR-SEC-030`…`033` and cash-variance approval require. **Binding statements are numbered; rationale is italicised and is not part of the ratification.**

---

**PROPOSED — APPROVAL RUNTIME MINIMUM RESOLUTION (carried-item resolution; no new numbered decision; the 20-decision tally is unaltered).**

**1. D-16 — `request_type` constraint form → option (d).**
`governance.approval_requests.request_type` is **`VARCHAR(32) NOT NULL` with no CHECK constraint** in this phase, documented by comment. **D-16's enumeration question remains OPEN and is NOT closed by this**; no closed value set is created, and no value is added to any enum.
*Rationale: D-16 finding 5 already settles the type; the `stock_movements.reference_type` precedent is directly on point; options (a)/(c) would exclude `FR-FIN-006`, which D-16's own evidence table lists as outside `FR-SEC-030`'s seven.*

**2. SB-1 — FK posture → RP-1 (store the code, no foreign key).**
`required_permission` stores an existing SRS §15.2 permission **code** as immutable data, with **no** foreign key to `identity.permissions`.
*Rationale: preserves historical meaning if the catalogue later changes; avoids coupling Governance writes to Treasury's permission-seeding order, which is live today since `cash.variance.approve` is deliberately unseeded. SB-1's representation half is already settled and is not reopened.*

**3. SB-3 — DELETE posture → DP-1 (no DELETE capability).**
`ros_app` receives **no DELETE grant and no DELETE policy** on `governance.approval_requests`. The `approval_decisions → approval_requests` FK carries **`ON DELETE RESTRICT`**. **`ON DELETE CASCADE` remains rejected.**
*Rationale: dissolves the D-8 clause 6 cascade question rather than deferring it; is the only option requiring no V2 empirical verification (SB-3's own neutral fact); matches this repository's append-only posture for financially-consequential tables. `RESTRICT` is belt-and-braces given no delete path exists.*

**4. D-4 clause 5 — `rejected` storage → BOTH, with distinct roles.**
`approval_decisions.decision` is the **immutable historical fact** (required by `FR-SEC-033`). `approval_requests.status` is the **current-state projection** and remains the sole column carrying `GRANT UPDATE` under D-6. These are **not** duplicate sources of truth: one is an append-only event, the other the aggregate's current state.
*Rationale: `FR-SEC-033` makes `decision` mandatory; D-6's ratified `GRANT UPDATE(status)` makes `status` necessarily present. Clause 5 reserved only the allocation, which this settles.*

**5. DECISION CARDINALITY — exactly one final decision per request.**
`governance.approval_decisions` carries **`UNIQUE (tenant_id, approval_request_id)`**. A second decision for the same request is rejected by the database.
*Rationale: D-4's lifecycle is terminal with no transition out of `approved`/`rejected`, and D-6 permits exactly one `status` write, so a second decision would have no legal target. Under D-15 — which forecloses locks — this constraint is the only available mechanism for the two concurrent-manager races. **D-15 is not amended**: a UNIQUE constraint is a declarative schema constraint, not an additional concurrency mechanism.*

**6. D-2 — AMENDMENT IN PART: lift the defer for the SYNCHRONOUS half of `FR-SEC-032` only.**
Recorded in the register's established manner, **the 2026-08-17 ratified text unchanged, not reinterpreted, not deleted**, exactly as the 2026-08-19 amendment was.
**Defer LIFTED for exactly this:** obtaining an approval decision **synchronously via manager PIN on a registered terminal**, reusing the **existing** `FR-SEC-021`/`FR-SEC-022` PIN substrate.
**Defer REMAINS IN FORCE for everything else, explicitly:** the **asynchronous** half of `FR-SEC-032` and all push notification (**D-11 N-B untouched**); broader branch-scoped RBAC `FR-SEC-002`/`003`/`004`; **D-12** escalation; and any Governance HTTP surface (**D-14 A-1 untouched** — the PIN is carried on the *consuming* route, never on a new Governance endpoint).
*Rationale: without this, D-14 A-1 + D-2 (a) + D-11 N-B + D-20 jointly leave no path by which any human can approve anything — D-14 records the runtime as "exercisable only by tests" — so `FR-FIN-006` would remain unsatisfiable and P1G-1 could not be unblocked. The dependency chain D-2 originally cited (`FR-SEC-002 → FR-SEC-021/022 → FR-SEC-032`) is now satisfied at the `021/022` level: when D-2 was ratified the register recorded "no PIN implementation anywhere in `src/modules`"; the PIN substrate has since shipped, and `PinService.authenticate` already performs the branch check `FR-SEC-021` requires and returns identity facts without minting a session.*

**7. Preserved exactly.** **P-1 is not amended.** **D-12 remains BLOCKED.** **D-16's enumeration remains OPEN.** **SB-2 remains UNRESOLVED.** D-1, D-3, D-4 (save cl. 5), D-5, D-6, D-7, D-8, D-9, D-10, D-11, D-13, D-14, D-15, D-17, D-18, D-19, D-20 are **preserved exactly**. The **D-3 residual**, **D-8 cascade verification**, **GAP-11**, **granted-approval staleness**, **`FR-AUD-008`** and **`FR-SEC-035`** remain carried and unresolved.

**8. No implementation is authorized by this ratification.** A separate **runtime design gate** is required before any migration, and must resolve at minimum: finding **F-1** (§12.4), the Identity `contract/` publication (§10.3), the `value` representation for the cash-variance case, and the full concurrency test matrix.

---

## 24. P1G-1 IMPACT

### 24.1 What the approval runtime unblocks — and what it does not

**Unblocked:** the beyond-tolerance close path gains a conformant `FR-FIN-006` approval and an `FR-SEC-016` self-approval block — **provided F-1 (§12.4) is resolved**, without which the `close_other` case still violates `FR-SEC-016`.

**Explicitly not unblocked** — the seven P1G-1 items the brief lists, none of which this gate touches:

| Item | Status after this gate | Blocker class |
|---|---|---|
| **Variance tolerance source / default** | **STILL BLOCKED.** `FR-PLT-025`/`026` hierarchical settings are entirely absent (no model, no resolver; `org.settings` is inert JSONB). **No SRS default exists.** D-13 puts the threshold in the consuming domain, so Treasury must own it — but has nowhere conformant to put it | **HARD BLOCKER to beyond-tolerance close** |
| **`FR-POS-094` per-branch configurability** | **STILL BLOCKED** — same missing settings resolver | **HARD BLOCKER** for per-branch; a tenant-level value could ship first |
| **Denomination catalogue** | **STILL NOT SOURCE-DECIDABLE** — the country pack carries only currency code/exponent/cashRounding; no denomination list. No Egyptian catalogue may be invented | **HARD BLOCKER to `FR-POS-097`** (denominated count); a total-only count is unaffected |
| **X-report authorization** | **STILL NOT SOURCE-DECIDABLE** — no `cash.x_report` code; `report.view.<category>` vocabulary unenumerated | **Not a blocker** to the close itself |
| **Adjusting-entry authorization** | **STILL NOT SOURCE-DECIDABLE** — no code named | **Not a blocker**; keeps `FR-FIN-007` **PARTIAL** |
| **Shift-close trigger / timing** | **STILL NOT SOURCE-DECIDABLE** — `cash_sessions.shift_id` is non-unique and `uq_one_open_session_per_drawer` constrains drawers, so closing one session cannot close the Shift | **Not a blocker** to CashSession close |
| **`FR-POS-092` drawer limit** | **STILL NOT IMPLEMENTED** (substrate enabled) — all four parameters undecided, per the P1G-0 design gate | **Not a blocker**; unrelated to close |

### 24.2 Hard blockers to a *basic* CashSession close vs honest PARTIAL

**Hard blockers (must be resolved for any beyond-tolerance close):**
1. The six ratifications in §23 — without them the approval runtime cannot be built.
2. **F-1** — without it, `FR-SEC-016` [M] is violated in the `close_other` case.
3. **Variance tolerance source** — `FR-FIN-006` says *"beyond a **configurable** tolerance"*; with no settings substrate there is nothing to configure, and the system cannot decide when approval is required.

**Not blockers — may honestly remain PARTIAL:** `FR-FIN-007` (immutability met; adjusting entries unmet) · `FR-FIN-010` (cash + `manual_external_card` only) · `FR-POS-097` (total-only count without a denomination catalogue) · X report, Shift close, Day close, `FR-POS-092`.

**A within-tolerance-only close remains available today and needs no approval runtime at all** — it is exactly what the 2026-08-28 P1G-1 gate designed. But it still requires a **tolerance value** to know that it *is* within tolerance, so item 3 blocks even that. **The settings/tolerance question, not the approval mechanism, is P1G-1's nearest blocker** — a conclusion this gate did not expect and records plainly.

### 24.3 Sequencing recommendation

1. **User ratifies §23** (or rejects/amends it).
2. **Approval runtime design gate** — resolving F-1, the Identity contract, `value`, and the concurrency matrix.
3. **Variance-tolerance / settings decision** — logically independent of the approval runtime and can proceed in parallel; it is on P1G-1's critical path either way.
4. **Approval runtime implementation** (migration 32).
5. **P1G-1 implementation.**

Steps 2 and 3 are parallelisable. **No step is authorized by this gate.**

---

## 25. NON-GOALS — CONFIRMED NOT DESIGNED OR IMPLEMENTED

D-12 escalation · multi-level approval routing · `approval_steps` · a generic workflow engine · a notifications platform · Day Close · Receipt · Fiscal · KDS · refunds · purchasing · expense subsystem · branch RBAC redesign · offline sync engine · NFR-PERF-006 optimization · P1G-1 itself.

**Also confirmed:** no product code, no migration (**migration 32 NOT created**), no Governance Register edit, no commit, no push, no D-21+, no destructive git command, and the unrelated uncommitted reports and INDEX rows in the working tree were **not touched**.

---

## 26. FINAL VERDICT

## **B. USER RATIFICATION REQUIRED — MINIMUM PROPOSAL PROVIDED**

The core approval request/decision model is **already ratified in almost complete detail**, and the register is **internally consistent** (§3.3). But the runtime as ratified is **deliberately unusable by humans** — D-14 A-1, D-2 (a), D-11 N-B and D-20 jointly remove every approval path, a consequence D-14 records in its own words. **Six ratifications** (§23) are the minimum surface that makes `FR-SEC-030`…`033` implementable and `FR-FIN-006` reachable; three of them (**SB-3**, **cardinality**, **D-2**) are strictly blocking, and one (**D-16**) determines whether P1G-1 is reachable **at all**.

Because the architecture is **not** fully source/governance-decided, **no Sonnet implementation prompt is issued**, and none may be until §23 is ratified and the runtime design gate in §24.3 step 2 has resolved **F-1** and the Identity contract question.

**No commit. No push. No implementation authorized.**

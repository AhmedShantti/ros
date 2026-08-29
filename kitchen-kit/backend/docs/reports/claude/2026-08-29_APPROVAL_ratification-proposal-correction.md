# Approval Ratification Proposal — Narrow Correction (SB-2 and F-1)

**Report type:** Narrow analysis/correction of a prior gate's ratification set. **No product code, no migration, no governance-register edit, no commit, no push, no D-21+.**
**Authority statement:** This report is **non-authoritative evidence**. Authority order: **(1) `ROS_SRS_v1.0.pdf` → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md` → (3) the repository at HEAD `55e4ae8` → (4) accepted design/implementation reports → (5) engineering inference only where authority is silent.** The corrected block in §5 is a **PROPOSAL for the user to approve or reject in chat**; it is not written to the register.
**Date:** 2026-08-29
**HEAD:** `55e4ae8` (unchanged; no commit performed)
**Branch:** `feat/production-spec`
**Working tree:** unrelated uncommitted reports and INDEX rows untouched. This report plus its INDEX row are the only additions.
**Corrects:** `docs/reports/claude/2026-08-29_APPROVAL_governance-runtime-resolution-gate.md` §§14.3, 21, 22, 23 (the six-item claim). All other sections of that report stand.
**Task identifier:** APPROVAL ratification-proposal correction

> ## VERDICT
> ## **B. CORRECTED RATIFICATION PROPOSAL REQUIRED — PROVIDED**
>
> **The challenge is upheld on both counts. The prior gate's six-item claim
> was wrong, and it was wrong by its own internal evidence.**
>
> **SB-2 is schema-blocking.** `approval_requests.value` is **mandatory**
> (`FR-SEC-031` [M]; **D-1 RATIFIED** option (a) "ADD ALL THREE FIELDS"), and
> **no authority decides its type** (SB-2: *"the SRS does **NOT** mandate
> `DECIMAL(18,6)`, `JSONB`, a dimension enum, or any other specific
> persistence type"*). The prior §21 literally printed `**SB-2 UNRESOLVED**`
> in the *type* column of a mandatory field while §22 claimed the migration
> could proceed — a column with no type cannot be written. The prior §14.3
> reasoning was self-refuting: it concluded *"Governance need carry only
> what `FR-SEC-031` enumerates"*, and `FR-SEC-031` **enumerates the value**.
>
> **F-1 cannot remain a design detail.** Its only fully DB-enforced
> resolution amends **two ratified decisions** — D-1's column set and D-9's
> INSERT predicate — and the register already fixes the precedent verbatim:
> *"**M2 would add a second conjunct to that ratified policy.** That
> extension **must be ratified explicitly, not applied silently**."*
> Analysis also found **R-a is not merely inconvenient but incorrect** (§3.2):
> it records a false immutable fact and silently drops the genuine
> requester ≠ approver protection.
>
> **Corrected total: EIGHT ratifications.** Items 1, 3, 4, 5, 6 KEEP AS
> WRITTEN; item 2 AMEND (one clarifying clause); items **7 (SB-2 → VT-3)**
> and **8 (F-1 → R-b)** ADDED. The two additions are mutually reinforcing:
> item 8's typed column is what keeps item 7's opaque payload out of every
> security predicate (§5.1).

---

## 1. SB-2 — THE FIVE QUESTIONS, ANSWERED EXACTLY

### A. Is `approval_requests.value` REQUIRED to exist in migration 32? — **YES**

Two independent authorities, neither of which this report may reinterpret:

- **`FR-SEC-031` [M]**, verbatim: *"Approval requests SHALL specify: the requesting user, the action, the affected entity, **the value**, the required approver permission, and an expiry."*
- **D-1 — RATIFIED 2026-08-17, option (a) ADD ALL THREE FIELDS**, verbatim: *"`governance.approval_requests` gains **`value`**, `required_permission` and `expiry` as a documented deviation from the approved SQL, **satisfying `FR-SEC-031`**."*

D-1's own analysis records the alternatives and why they failed: option (b) add only the subset the first phase consumes, option (c) omit and record `FR-SEC-031` knowingly unmet — *"options (b) and (c) leave a mandatory requirement unmet by construction."* **The column is ratified into existence and cannot be deferred**, and this report does not reopen D-1.

### B. What authoritative source decides its SQL/Prisma type? — **NONE**

SB-2's resolution (2026-08-19) is explicit:

> **NOT CLAIMED:** the SRS does **NOT** mandate `DECIMAL(18,6)`, `JSONB`, a dimension enum, or any other specific persistence type. **No such claim is made here.**

and its recommendation section:

> **E. Source-supported recommendation — NO, for the type. YES, for the exclusion.** **NO SOURCE-SUPPORTED RECOMMENDATION** among VT-1/2/3/5. **VT-4 is excluded by the sources.**

D-1 itself carried the question forward rather than settling it, and the only settled fact is the **exclusion**: *"`BIGINT` minor units is **NOT** an appropriate representation."*

### C. Consequence — **SB-2 MUST be added to the blocking ratification set** ✅

A mandatory `NOT NULL`-candidate column whose type no authority decides makes the `CREATE TABLE` statement unwritable. This is the identical failure mode the prior gate correctly identified for **SB-3** (the FK's `ON DELETE` clause) and then, inconsistently, failed to apply to SB-2.

**The prior report's own §21 table is the proof of its own error:**

| Column | Type | Null | Notes |
|---|---|---|---|
| `value` | **SB-2 UNRESOLVED** | — | `BIGINT` excluded. Not on the critical path (§14.3) |

A DDL type column reading "UNRESOLVED", and a nullability column reading "—", **is an unwritable migration**. The prior §22 claim that "migration 32 can proceed after six decisions" is therefore **withdrawn**.

**Where the prior reasoning went wrong.** §14.3 argued the cash-variance facts (expected, counted, variance, reason, owner…) live on the CashSession under `FR-FIN-007`, so Governance need not carry them — and that much is correct and still stands. But it then concluded *"Governance need carry only what `FR-SEC-031` enumerates"* **without noticing that `FR-SEC-031` enumerates the value**. The premise refutes the conclusion. The correct statement is: Governance need carry only `FR-SEC-031`'s six elements — **and `value` is one of them, so it must be typed.**

### D. Is there an already-ratified generic representation? — **NO**

No representation of any kind is ratified. The register enumerates five candidates and selects none; only **VT-4 is eliminated**. `TEXT` and "structured columns" as named in the brief are **not among the register's candidates**, and per the brief's own instruction (*"Do not invent a new option if the register already enumerates candidates"*) they are not introduced here. The live set is **VT-1, VT-2, VT-3, VT-5**.

### E. No type inferred from the cash-variance consumer alone ✅

Explicitly honoured. The evaluation in §2 is driven by the **heterogeneous** consumer set the register itself established — `FR-POS-047`'s four dimensions (percentage, absolute amount, count, **boolean**), `FR-INV-046` (*"by percentage **or** value"*), `FR-HRM-034` (hours), and the monetary cases (`FR-PRC-018`, `FR-INV-035`, `FR-INV-058`, `FR-FIN-006`, `FR-FIN-017`). **Cash variance is treated as one consumer among many and is given no privileged weight.**

---

## 2. MINIMUM VALUE REPRESENTATION — EVALUATION

### 2.1 The register's five options, verbatim

| | Option | Carries (register's own words) |
|---|---|---|
| **VT-1** | `DECIMAL(18,6)` single column | Money-as-decimal, percentage, count. **Loses currency and the dimension label** |
| **VT-2** | `DECIMAL(18,6)` **+ a dimension/unit descriptor** | Adds what the number means. **A descriptor vocabulary is itself undefined by the SRS** |
| **VT-3** | `JSONB` structured value | Carries anything; constrains nothing; no SRS basis |
| **VT-4** | Money pair (`BIGINT` + currency) | **Contradicted** — excluded by the sources |
| **VT-5** | Nullable, meaning deferred to the consumer | Consistent with **D-13**; leaves `FR-SEC-031`'s *"SHALL specify the value"* only partly served |

### 2.2 Scored against the brief's six constraints

| Constraint | VT-1 | VT-2 | VT-3 | VT-5 |
|---|---|---|---|---|
| Supports percentage / money / count / **boolean** | ✗ — **no boolean** | ✗ — **no boolean** | **✓ all four** | ✗ — carries nothing |
| Does not violate integer-minor-unit discipline for money | ✗ — forces money into a decimal, or silently drops the minor-unit distinction | ✗ — same | **✓** — minor units carried as an exact digit **string** (§2.4) | n/a |
| Does not pretend every value is money | ✓ | ✓ | ✓ | ✓ |
| Does not couple Governance to domain schemas | ✓ | ✗ — a descriptor vocabulary is a Governance-owned vocabulary about other domains | **✓** — opaque, never parsed | ✓ |
| Does not require Governance to interpret meaning | ✓ | ✗ — the descriptor *is* interpretation | **✓** | ✓ |
| Preserves immutable historical meaning | partial — number without dimension | ✓ | **✓** — frozen by D-6 | ✗ — nothing preserved |
| Satisfies `FR-SEC-031` [M] *"SHALL specify the value"* | partial | ✓ | **✓** | ✗ — register: *"only partly served"* |

### 2.3 Recommendation — **VT-3 (`JSONB`), `NOT NULL`**

Three reasons, in order of authority:

**(i) D-13's ratified language is a near-verbatim endorsement of the opaque-carrier posture.** D-13 — RATIFIED option (b) — holds that the consuming domain determines whether approval is required and **supplies the value**, with *"**Governance is a generic carrier**."* The brief's instruction is to *"prefer an opaque generic carrier if and only if authority/governance supports it"* — D-13 is that support, and it is ratified, not inferred. VT-3 is the only option that is *actually* opaque; VT-1 and VT-2 both require Governance to hold a numeric (and, for VT-2, a semantic) opinion about values it does not own.

**(ii) VT-3 is the only option that carries `FR-POS-047`'s boolean dimension.** The register records this as an open consequence: *"`FR-POS-047`'s **boolean** dimension means some approvals have **no numeric value at all** — bearing on whether the column is `NOT NULL`. **Not resolved here.**"* VT-1 and VT-2 are numeric columns and cannot represent *"discount permitted after payment started"* at all; under either, the column must be nullable and `FR-SEC-031` [M] goes partly unmet for an entire class of approvals. **VT-3 resolves the open nullability sub-question as a side effect** — a boolean condition is representable, so the column can be `NOT NULL` and `FR-SEC-031`'s *"SHALL specify"* is fully met for every consumer.

**(iii) VT-2 would enlarge the ratification surface with exactly the hazard the register warns against.** SB-2 records: *"a **descriptor vocabulary under VT-2 must not become a proxy for D-16's enumeration**."* VT-2 requires ratifying a Governance-owned vocabulary naming other domains' value dimensions — the same species of act D-16 cl. 4 forbids (*"Governance must NOT invent a closed … enumeration"*). VT-3 invents **no vocabulary at all** and so cannot become such a proxy. Given the brief's standing instruction to minimise the ratification surface, this is decisive between the two.

**On VT-3's recorded weakness.** The register notes VT-3 *"constrains nothing; no SRS basis."* The first half is true and is precisely the point — D-13 makes constraining it Governance's *non*-business. The second half is not a discriminator: **no option has an SRS basis**, which is why the register recorded NO SOURCE-SUPPORTED RECOMMENDATION among all four. The choice is architectural, and it is offered as such.

### 2.4 Storage representation vs domain semantics — the separation, made binding

The brief requires these be separated. Under VT-3 they are, and the separation must be **enforced**, not merely asserted:

- **Storage (Governance owns):** a `JSONB` document, written once, frozen by D-6, never parsed, never validated, never indexed on its internals.
- **Semantics (the consuming domain owns):** what the keys mean, which are present, and how they are read back. Governance neither knows nor asks.

Two binding clauses make this real, and both appear in §5 item 7:

1. **Money is carried as an exact decimal *string* of minor units, never a JSON number.** JSON numbers are IEEE-754 doubles — the exact float hazard the repository's BIGINT money discipline exists to prevent. The string convention is already this repository's shipped pattern: P1G-0's `CashMovementDto.amountMinor` is a `@Matches(/^(?!0+$)\d{1,18}$/)` string, and `audit_entries.metadata` (JSONB) already carries `amountMinor: movement.amount.toString()`. **This satisfies the brief's integer-minor-unit constraint without VT-4's excluded money-only column.**
2. **No Governance predicate, policy, CHECK, index or constraint may read into `value`.** The moment an RLS predicate or constraint parses the payload, Governance depends on a domain-supplied shape and D-13's generic-carrier posture collapses. This clause is what keeps the boundary mechanically true, and it is why F-1's resolution must **not** be implemented by reading the session owner out of the JSONB (§3.3).

**Precedent, corroborating only:** `governance.audit_entries` already ships `before_state JSONB`, `after_state JSONB` and a JSONB metadata payload carrying heterogeneous domain facts opaquely, inside this very module. **Evidence, not authority.**

### 2.5 Why the other live options are rejected

- **VT-1** — cannot carry `FR-POS-047`'s boolean; loses currency and the dimension label (the register's own note), so a stored `15.000000` is permanently ambiguous between 15%, 15 units and 15 minor units; and it forces money into a decimal column, weakening the integer discipline.
- **VT-2** — inherits VT-1's boolean failure, and additionally requires ratifying a descriptor vocabulary the SRS does not define and that SB-2 explicitly warns must not become a D-16 proxy.
- **VT-4** — **already excluded by the register.** Not reconsidered.
- **VT-5** — fails `FR-SEC-031` [M] as a primary representation; the register itself says it leaves *"SHALL specify the value"* **only partly served**. Deferring a mandatory field's meaning is the same defect D-1 rejected in options (b) and (c).

---

## 3. F-1 — GOVERNANCE BOUNDARY RE-EVALUATION

### 3.1 The question restated precisely

**D-7 M2** DB-enforces **requester ≠ approver**. **`FR-FIN-006` [M]** additionally requires **approver ≠ CashSession owner**. These coincide only when the requester *is* the session owner — and `cash.session.close_other` (§15.2, *"Close another user's shift"*) makes divergence a supported case.

### 3.2 **R-a is not merely inconvenient — it is incorrect.** New analysis.

The prior gate offered R-a (define the requester as the session owner rather than the closer) as a viable candidate and declined to choose. Closer analysis shows R-a must be **rejected on the merits**, on two independent grounds:

1. **It records a false immutable fact.** Under `close_other` the supervisor genuinely performs and requests the close. Writing `requested_by` = session owner asserts that a person who took no action made the request — inside an append-only governance record that D-6 freezes permanently, and against `FR-SEC-031`'s plain *"the **requesting** user"*.
2. **It silently drops a protection it was meant to preserve.** With `requested_by` reassigned to the owner, D-7's traversal no longer constrains the **actual requester**, so the supervisor who requested the approval could approve their own request — defeating **SRS §7.3 row 36**'s aggregate invariant *"Requester ≠ approver"*, which D-7 exists to enforce. R-a trades one violation for another.

**R-a is withdrawn.** **R-c (service-only) was already rejected** by D-7 cl. 5 (*"Do NOT rely on service-level enforcement alone"*) and by `FR-SEC-016`'s *"regardless of role configuration"*, and the brief independently rules it out.

### 3.3 Can F-1 be resolved without amending governance? — **NO**

The brief asks for proof either way. The correct resolution is **R-b** — carry the excluded party on the request and add a conjunct to the decision-INSERT predicate — and it amends **two** ratified decisions:

**(a) It amends D-1's ratified column set.** D-1 RATIFIED exactly three additions (`value`, `required_permission`, `expiry`) to the approved SQL's eight. An additional column is a further documented deviation of the same species D-1 itself performed, and D-1's ratification enumerated the additions exhaustively. **Adding a fourth requires ratification.**

**(b) It amends D-9's ratified INSERT predicate — and the register fixes this precedent verbatim.** Register line 1112, in D-7's own dependency analysis:

> **D-9** ratified the `approval_decisions` INSERT policy as **`WITH CHECK T`** (tenant predicate). **M2 would add a second conjunct to that ratified policy.** That extension **must be ratified explicitly, not applied silently** — recorded as a governance consequence, not a licence. **(E)**

D-7 cl. 6 then did exactly that, recording its own conjunct *"explicitly as a **D-9 policy amendment/consequence**"*, and D-10 cl. 9 repeated the pattern for the expiry conjunct. **The register has therefore twice established that adding a conjunct to D-9's INSERT policy is a ratification act.** A fourth conjunct is the third instance and is governed by the same rule. There is no reading on which it is a design detail.

**Why the JSONB route is not an escape.** One might avoid the new column by placing the session owner inside `value` and having the RLS predicate read it. This is rejected: it violates §2.4's boundary clause, makes a **security predicate depend on a domain-supplied payload shape**, and re-couples Governance to domain semantics that D-13 places outside it. **A typed column is required precisely so the predicate never parses the payload** — which is why items 7 and 8 are mutually reinforcing rather than merely co-present.

### 3.4 The recommended shape — generic, not cash-specific

`approval_requests` gains **one nullable column** naming an **additional party who may not approve this request**. Governance does not know it is a CashSession owner; the consuming domain supplies it, consistent with D-13. The decision-INSERT predicate gains a **fourth conjunct** excluding that party.

This satisfies every constraint: **DB-enforced** (`FR-SEC-016`'s *"block, not merely warn … regardless of role configuration"*); **not service-only** (D-7 cl. 5); **generic** (no cash-specific concept enters Governance); **additive** (D-7's existing conjunct is unchanged, preserving §7.3 #36's requester ≠ approver alongside it); and it needs **no access to `value`**.

### 3.5 The no-amendment alternative, recorded for completeness — **R-d**

There is exactly one path that avoids amending governance: **restrict the beyond-tolerance close to the session owner**, so that requester ≡ session owner by construction and D-7's *existing* predicate already yields `approver ≠ session owner`.

**Proof:** if the closer is necessarily the owner and `requested_by` is the closer, then D-7's ratified `approver ≠ requested_by` is definitionally `approver ≠ session owner`, which is `FR-FIN-006`. No new column, no new conjunct, no amendment.

**Cost, stated plainly:** `cash.session.close_other` — a permission the SRS names — becomes **unusable for any beyond-tolerance close**, a real functional loss. And the guarantee becomes **conditional on a service-layer routing restriction**: if a later slice relaxes it, `FR-FIN-006` breaks silently with no database backstop. That conditionality is the precise fragility D-7 cl. 5 was written to prevent.

**R-d is recorded, not recommended.** It is offered so the user may choose the cheaper path knowingly. **Either way F-1 is a governance decision** — R-b amends two ratifications, and R-d accepts a functional limitation on an SRS-named permission. Neither is a "later implementation detail," which is the brief's actual question. **Answer: NO, F-1 cannot remain a design detail.**

---

## 4. SIX-ITEM PROPOSAL REVIEW

| Item | Verdict | Basis |
|---|---|---|
| **1 — D-16 unconstrained `VARCHAR(32)`** | **KEEP AS WRITTEN** | Checked against the brief's test: the item's own text states *"D-16's enumeration question remains **OPEN** and is NOT closed by this; no closed value set is created, and no value is added to any enum,"* while authorising the type for this phase. Both halves hold. |
| **2 — SB-1 RP-1 (code, no FK)** | **AMEND** (one clarifying clause) | RP-1 does **not** prevent decision-time permission validation — see §4.1. The clause is added to make that explicit and binding, since the brief raised it. |
| **3 — SB-3 DP-1 + `ON DELETE RESTRICT`** | **KEEP AS WRITTEN** | DP-1 grants no DELETE and defines no DELETE policy; `RESTRICT` on the FK is belt-and-braces should any future migration grant DELETE. `CASCADE` remains rejected per SB-3. No inconsistency. |
| **4 — D-4 cl. 5, `rejected` on both with distinct roles** | **KEEP AS WRITTEN** | `FR-SEC-033` [M] makes `decision` mandatory on decisions; D-6's ratified `GRANT UPDATE(status)` makes `status` necessarily present on requests. An append-only event and a single-transition current-state projection are not duplicate truth. |
| **5 — Exactly one final decision** | **KEEP AS WRITTEN** | Compatible with, and in fact **entailed by**, D-4's terminal lifecycle — see §4.2. |
| **6 — D-2 amendment, synchronous half only** | **KEEP AS WRITTEN** | The item lifts exactly *"obtaining an approval decision synchronously via manager PIN on a registered terminal"* and expressly leaves in force the asynchronous half (D-11 N-B untouched), broader branch-scoped RBAC, D-12, and any Governance HTTP surface (D-14 A-1 untouched). Verified against the brief's test. |

**No item is REMOVED. P-1 is not reopened. D-12 is not reopened.**

### 4.1 Item 2 — RP-1 and decision-time permission validation

The brief asks whether RP-1 (no FK) prevents validating the approver's permission at decision time. **It does not**, and the reason is architectural rather than incidental:

The check is *"does the approver's effective permission set contain the code named in `required_permission`?"* — a **membership test against a resolved set of code strings**, exactly what `TenantContextService.resolve()` already produces (membership → `membership_roles` → `role` → `role_permissions` → `permission.code`, flattened to a `ReadonlySet<string>`), and exactly what `PermissionGuard` already evaluates. **No foreign key participates in that path.** RP-2's FK would constrain which codes may be *stored*; it would do nothing for the *authorization* check.

**A deliberate asymmetry, worth recording.** Permission-holding is validated at the **service layer** (consistent with every other permission in the shipped system, via `PermissionGuard`), while self-approval is enforced at the **database layer** (D-7 M2). This is not inconsistency: `FR-SEC-016` [M] requires self-approval to be blocked *"regardless of role configuration"* — a guarantee that must survive a **misconfigured role**, and therefore cannot itself be expressed as a role/permission check. That is precisely why D-7 chose RLS. Permission-holding, by contrast, *is* the role configuration, and belongs where the rest of it lives.

**One residual, recorded honestly:** under RP-1 a `required_permission` naming a code that no role grants (a typo, or an unseeded code) yields a request no one can ever approve. It fails **closed** (safe direction), is detectable, and is a caller defect — and RP-2 would trade it for the live seeding-order coupling described in the prior gate (`cash.variance.approve` is deliberately unseeded today). The trade favours RP-1, and the failure mode is disclosed rather than hidden.

### 4.2 Item 5 — compatibility with D-4's terminal lifecycle

D-4 ratifies `pending → approved` and `pending → rejected`, with **no transition out of either terminal state** and cl. 3 forbidding invented states. Exactly-one-final-decision is therefore not merely *compatible* but **entailed**: a second decision would require `status` to transition out of a terminal state, which D-4 does not permit, and would require a second `GRANT UPDATE(status)` write that D-6's ratified single-mutable-column model does not contemplate.

A rejected request is not retried in place — a **new request** is created, which is precisely what D-4's one-way lifecycle prescribes.

**Item 5 does not amend D-15.** D-15 ratified *no additional approval-specific concurrency **mechanism***, having considered and declined locking and versioning options. A `UNIQUE` constraint is a **declarative schema constraint**, not a concurrency mechanism — and under D-15 it is the *only* remaining means by which the two concurrent-manager races can be resolved at all, since §24.6.4 confines pessimistic locking to two named cases with approval not among them.

---

## 5. CORRECTED RATIFICATION BLOCK — REPLACES §23 OF THE PRIOR REPORT

> **This is a PROPOSAL. It is NOT written into the Governance Decision Register.** It creates **no D-21+**, uses the register's existing **carried-item / amendment** mechanism, **does not modify P-1**, keeps **D-12 BLOCKED**, keeps the **asynchronous half of `FR-SEC-032` deferred**, and introduces **no Governance HTTP surface**. Binding statements are numbered; rationale is italicised and is not part of the ratification.

---

**PROPOSED — APPROVAL RUNTIME MINIMUM RESOLUTION (carried-item resolution and amendments; no new numbered decision; the 20-decision tally is unaltered).**

**1. D-16 — `request_type` constraint form → option (d).** *(unchanged)*
`governance.approval_requests.request_type` is **`VARCHAR(32) NOT NULL` with no CHECK constraint** in this phase, documented by comment. **D-16's enumeration question remains OPEN and is NOT closed by this**; no closed value set is created and no value is added to any enum.
*Rationale: D-16 finding 5 already settles the type; the `stock_movements.reference_type` precedent is directly on point; options (a)/(c) would exclude `FR-FIN-006`, which D-16's own evidence table lists as outside `FR-SEC-030`'s seven.*

**2. SB-1 — FK posture → RP-1 (store the code, no foreign key).** *(amended — clause 2b added)*
**2a.** `required_permission` stores an existing SRS §15.2 permission **code** as immutable data, with **no** foreign key to `identity.permissions`.
**2b.** The approver's authority is validated **at decision time** against the approver's effective permission set, as resolved by the existing membership → role → permission path. **RP-1 does not impede this**, the check being a membership test over resolved code strings rather than a key lookup. This validation is **service-layer**, consistent with the rest of the permission system; it is **distinct from** D-7's database-enforced self-approval prohibition, which must survive misconfigured roles and therefore cannot be a permission check.
*Rationale: preserves historical meaning if the catalogue later changes; avoids coupling Governance writes to Treasury's permission-seeding order, live today since `cash.variance.approve` is deliberately unseeded. SB-1's representation half is already settled and is not reopened.*

**3. SB-3 — DELETE posture → DP-1 (no DELETE capability).** *(unchanged)*
`ros_app` receives **no DELETE grant and no DELETE policy** on `governance.approval_requests`. The `approval_decisions → approval_requests` FK carries **`ON DELETE RESTRICT`**. **`ON DELETE CASCADE` remains rejected.**
*Rationale: dissolves the D-8 clause 6 cascade question rather than deferring it; the only option requiring no V2 empirical verification (SB-3's own neutral fact); matches the repository's append-only posture for financially-consequential tables.*

**4. D-4 clause 5 — `rejected` storage → BOTH, with distinct roles.** *(unchanged)*
`approval_decisions.decision` is the **immutable historical fact** (required by `FR-SEC-033`). `approval_requests.status` is the **current-state projection** and remains the sole column carrying `GRANT UPDATE` under D-6. These are **not** duplicate sources of truth.

**5. DECISION CARDINALITY — exactly one final decision per request.** *(unchanged)*
`governance.approval_decisions` carries **`UNIQUE (tenant_id, approval_request_id)`**.
*Rationale: entailed by D-4's terminal lifecycle and D-6's single mutable column. **D-15 is not amended** — a UNIQUE constraint is a declarative schema constraint, not an additional concurrency mechanism, and under D-15 it is the only available resolution for the concurrent-manager races.*

**6. D-2 — AMENDMENT IN PART: lift the defer for the SYNCHRONOUS half of `FR-SEC-032` only.** *(unchanged)*
Recorded in the register's established manner, **the 2026-08-17 ratified text unchanged, not reinterpreted, not deleted**, exactly as the 2026-08-19 amendment was.
**Defer LIFTED for exactly this:** obtaining an approval decision **synchronously via manager PIN on a registered terminal**, reusing the **existing** `FR-SEC-021`/`FR-SEC-022` PIN substrate.
**Defer REMAINS IN FORCE for everything else, explicitly:** the **asynchronous** half of `FR-SEC-032` and all push notification (**D-11 N-B untouched**); broader branch-scoped RBAC `FR-SEC-002`/`003`/`004`; **D-12**; and any Governance HTTP surface (**D-14 A-1 untouched** — the PIN is carried on the *consuming* route, never on a new Governance endpoint).
*Rationale: without this, D-14 A-1 + D-2 (a) + D-11 N-B + D-20 jointly leave no path by which any human can approve anything. The dependency chain D-2 originally cited is now satisfied at the `FR-SEC-021`/`022` level: when D-2 was ratified the register recorded "no PIN implementation anywhere in `src/modules`"; the PIN substrate has since shipped.*

---

**7. SB-2 — `value` representation → VT-3 (`JSONB`), `NOT NULL`.** ⟵ **NEW**

**7a.** `governance.approval_requests.value` is **`JSONB NOT NULL`**.
**7b.** It is an **opaque carrier**. Governance **SHALL NOT** parse, validate, interpret, index on the internals of, or constrain the contents of `value`. **No Governance RLS policy, CHECK constraint, index or predicate may read into it.**
**7c.** Monetary amounts within `value` **SHALL** be carried as **exact decimal strings of minor units**, never as JSON numbers. *This preserves the repository's integer-minor-unit discipline; JSON numbers are IEEE-754 doubles.*
**7d.** The consuming domain owns the document's shape and meaning entirely, consistent with **D-13** (*"Governance is a generic carrier"*).
**7e.** **SB-2's ratified exclusion is preserved**: a money-only `BIGINT` representation (VT-4) remains excluded, and 7c is not a reintroduction of it — no monetary type is imposed on the column.
**7f.** The nullability sub-question SB-2 left open (*"`FR-POS-047`'s boolean dimension means some approvals have no numeric value at all"*) is **resolved by 7a**: a boolean condition is representable as a document, so the column is `NOT NULL` and `FR-SEC-031`'s *"SHALL specify the value"* is met for every consumer.
*Rationale: `value` is mandatory (`FR-SEC-031` [M]; D-1 RATIFIED) and no authority types it, so the migration is unwritable without this. VT-3 is the only live option carrying all four dimensions the register enumerates — percentage, absolute amount, count and **boolean**; the only one that is genuinely opaque, as D-13's ratified "generic carrier" language supports; and the only one that invents no vocabulary, avoiding the D-16-proxy hazard SB-2 explicitly warns of under VT-2. VT-1 and VT-2 cannot carry a boolean at all; VT-5 leaves a mandatory field "only partly served" by the register's own words; VT-4 is already excluded.*

**8. F-1 — approver ≠ subject owner → R-b (excluded-party column + fourth RLS conjunct).** ⟵ **NEW**

**8a.** `governance.approval_requests` gains **one nullable column** identifying an **additional party who may not approve this request**, supplied by the consuming domain. Governance attaches **no domain meaning** to it. *Recorded as a further documented deviation from the approved SQL, of the same species D-1 itself performed.*
**8b.** The `approval_decisions` **INSERT `WITH CHECK` predicate gains a fourth conjunct** excluding that party from approving. **D-7's existing self-approval conjunct is unchanged**, so `SRS §7.3 #36`'s *requester ≠ approver* invariant and `FR-FIN-006`'s *approver ≠ session owner* hold **simultaneously and independently**.
**8c.** Recorded explicitly as a **D-9 policy amendment/consequence**, in the manner the register established at line 1112 and applied in **D-7 cl. 6** and **D-10 cl. 9**. **D-7, D-8 and D-10 are otherwise unamended.**
**8d.** Enforcement is at the **database layer**. Service-only enforcement is **NOT** acceptable (D-7 cl. 5; `FR-SEC-016`'s *"regardless of role configuration"*).
**8e.** The excluded party **SHALL NOT** be read from `value` — clause 7b forbids it, and a security predicate must not depend on a domain-supplied payload shape.
**8f.** **R-a is rejected** (it would record a false requester and drop the genuine requester ≠ approver protection). **R-c is rejected** (service-only). **R-d** — restricting beyond-tolerance close to the session owner, avoiding all amendment at the cost of `cash.session.close_other` for that path — is **recorded as the alternative the user may select instead of 8a–8e**, with its conditionality on a service-layer restriction disclosed.
*Rationale: without this, `FR-SEC-016` [M] — which requires the system to **block, not merely warn**, on "approving one's own cash variance" — is violated whenever `cash.session.close_other` is used, because D-7's traversal then constrains only the closing supervisor. D-7 cl. 10 confirms the case was never in scope: "No claim is made that the Phase 1 implementation satisfies the … **Finance** … `FR-SEC-016` combinations."*

---

**9. Preserved exactly.** **P-1 is not amended.** **D-12 remains BLOCKED.** **D-16's enumeration remains OPEN.** **SB-2's VT-4 exclusion is preserved.** D-1 (save the additive column in 8a), D-3, D-4 (save cl. 5), D-5, D-6, D-7 (save the additive conjunct in 8b), D-8, D-9 (save 8b/8c), D-10, D-11, D-13, D-14, D-15, D-17, D-18, D-19, D-20 are **preserved exactly**. The **D-3 residual**, **D-8 cascade verification**, **GAP-11**, **granted-approval staleness**, **`FR-AUD-008`** and **`FR-SEC-035`** remain carried and unresolved.

**10. No implementation is authorized.** A separate **runtime design gate** is still required before any migration, and must resolve at minimum: the Identity `contract/` publication for PIN verification (prior gate §10.3), the exact excluded-party column name and predicate SQL, and the full concurrency test matrix.

---

### 5.1 Corrected §21 schema deltas

Only the rows this correction changes; all other columns stand as in the prior report.

| Column | Corrected | Basis |
|---|---|---|
| `approval_requests.value` | **`JSONB NOT NULL`** — was *"SB-2 UNRESOLVED"* | Item 7 |
| `approval_requests.<excluded party>` | **`UUID NULL`** — new | Item 8a |
| `approval_decisions` INSERT `WITH CHECK` | **four** conjuncts: tenant **AND** self-approval traversal **AND** request-unexpired **AND** excluded-party — was three | Item 8b |

**The migration becomes writable at this point and not before.** Items 7 and 8 are mutually reinforcing: item 8's typed column is precisely what allows item 7's payload to remain opaque to every security predicate (7b/8e). Choosing VT-3 *without* item 8's column would have forced the predicate to parse the JSONB and collapsed the boundary — an interaction neither the prior gate nor the challenge anticipated, and the strongest single argument that these two items must be ratified **together**.

---

## 6. WHAT THIS CORRECTION DOES NOT CHANGE

All other findings of the prior gate stand unamended: the verdict class (**B**), P-1's verification and the register's internal consistency (§3.3 there), the D-16 analysis, the D-14/D-2/D-11/D-20 "no human can approve anything" finding, finding **F-2** (Identity has no `contract/`), the API and tenancy analyses, and §24's conclusion that the **variance-tolerance / settings source**, not the approval mechanism, is P1G-1's nearest blocker.

**Withdrawn:** the §22 claim that six ratifications suffice, and the §14.3 sentence *"This is what keeps SB-2 off the critical path."* **Corrected total: eight.**

---

## 7. FINAL VERDICT

## **B. CORRECTED RATIFICATION PROPOSAL REQUIRED — PROVIDED**

**SB-2 is schema-blocking** — `value` is mandatory by `FR-SEC-031` [M] and D-1 RATIFIED, no authority types it, and the prior §21 printed "UNRESOLVED" in a mandatory column's type field while §22 claimed the migration could proceed. **F-1 requires ratification** — its only fully DB-enforced resolution amends D-1's column set and D-9's INSERT predicate, and the register twice established that adding a conjunct to that predicate *"must be ratified explicitly, not applied silently."*

Verdict **C** and **D** are not selected: neither item requires a *separate* governance gate, because both are resolvable inside the same narrow carried-item block as the original six, and both are presented with a single recommended option and reasoned rejections. Verdict **A** is refuted by the report's own §21.

**Eight ratifications. No D-21. P-1 unchanged. D-12 BLOCKED. Async `FR-SEC-032` deferred. No Governance HTTP surface. No commit, no push, no implementation authorized.**

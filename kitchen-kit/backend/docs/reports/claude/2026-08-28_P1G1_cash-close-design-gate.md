# P1G-1 — CashSession / Shift Close Design Gate

**Report type:** Design/readiness gate (analysis only — no product code, no migration, no governance change, no D-21+, no commit, no push)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → current repository evidence → accepted design reports**. **No governance is created or amended here; no D-21+ exists.** Where authority does not decide a question, this report says **NOT SOURCE-DECIDABLE** rather than filling the gap.
**Date:** 2026-08-28
**HEAD:** `bfe7e69` — `feat: complete P1F-2 atomic order completion` (verified unchanged)
**Branch:** `feat/production-spec`
**Working tree:** unchanged apart from this report and its `INDEX.md` row, plus the two pre-existing intentionally-uncommitted unrelated reports. No product code touched.
**Task identifier:** P1G-1 cash-close design gate

> ## VERDICT (§19)
> ## **C. BLOCKED — APPROVAL/GOVERNANCE RESOLUTION REQUIRED**
> P1G-1 is **not** implementation-ready. The blocker is proven, not asserted:
> FR-FIN-006 [M] requires variance approval by a holder of `cash.variance.approve`
> who is not the session owner, and FR-SEC-016 [M] requires the system to **block**
> self-approval of one's own cash variance *regardless of role configuration*.
> FR-SEC-030 [M] requires this to run through a **general approval mechanism**.
> That mechanism **does not exist in any form** — no `approval_requests`, no
> `approval_decisions`, no table, no migration, no service (verified exhaustively).
> Standing it up is not a design choice available to this gate: the register
> records that creating an approval request is **Class C + E on D-16** — *"the
> `request_type` contract is deliberately open"* and *"must not be resolved here"* —
> and that the decision→request linkage has **"NO SOURCE-SUPPORTED RECOMMENDATION
> between P-1 and P-2"**, requiring an **architectural ratification**.
> **The task brief's premise that "P-1 remains: approval_decisions references
> approval_requests directly" is not supported by the register** — P-1 is one of two
> unresolved candidates, not a ratified position (§3.1). Correcting that is the
> single most consequential finding of this gate.
> Two further hard problems are recorded: **FR-POS-091 [M] pay-in/pay-out/safe-drop
> do not exist**, yet three of the eight terms of FR-FIN-004 [M]'s expected-cash
> formula are exactly those operations (§2); and **FR-PLT-025/026 [M] hierarchical
> settings do not exist**, so variance tolerance and blind-count mode have no
> conformant home (§6). Minimum decisions required are listed in §19.

---

## 0. SUBSTRATE AUDIT — WHAT EXISTS AT `bfe7e69`

Verified directly, not inferred.

| Substrate | Finding |
|---|---|
| **Approval mechanism** | **ABSENT ENTIRELY.** No `Approval*` model in `schema.prisma`; no `approval_requests`/`approval_decisions` in any migration; no approval source files. The only traces are **columns without FKs**: `audit_entries.approval_id` and `inventory.waste_records.approval_request_id` (documented as "a recorded UUID and remains NULL in this phase"), plus `counts.requires_approval` — a *caller-supplied boolean gate* that blocks posting, **not** an approval workflow. |
| **Hierarchical settings** | **ABSENT.** No settings model, no settings module (12 modules enumerated; none is settings). Only opaque JSONB blobs: `org.settings` and `defaultSettings`. No resolver, no lockability. |
| **CashSession** | `openingFloat`, `currency` (branch snapshot), `status`, `closedAt`, plus `branchId`/`drawerId`/`shiftId`/`employeeId` with tenant-safe composite FKs. **No counted/expected/variance columns.** |
| **CashSession cardinality** | `@@index([tenantId, shiftId])` — **NOT unique**. `uq_one_open_session_per_drawer` is a partial unique index **on `drawer_id` WHERE status='open'** — per **drawer**, not per shift. |
| **Cash movements** | **ABSENT.** No `CashMovement`/pay-in/pay-out/safe-drop model or service. |
| **Payment attribution** | **COMPLETE** — `tender`, `amount`, `roundingAdjustment`, `cashSessionId`, `employeeId`, `terminalId`, `tenderedAmount`, `changeGiven`, all trusted, tenant/branch-safe FKs. |
| **Idempotency** | **PRESENT and reusable** — `common/idempotency/` (interceptor, `@Idempotent` decorator, service, `IdempotencyKey` model). |
| **Audit** | **PRESENT** — append-only (`GRANT SELECT, INSERT` / `REVOKE UPDATE, DELETE, TRUNCATE`), hash-chained, RLS-scoped. |
| **Domain events / UoW** | **PRESENT** — `UnitOfWork.execute` + `ctx.publishEvent`, same-transaction, no outbox (P1E-1C). |

---

## 1. SHIFT / CASHSESSION CLOSE COUPLING

**P1D-A is preserved and not re-litigated.** Operational Shift (Workforce) ≠ CashSession (Treasury); the session references the shift.

### Fact separation, as required

| Layer | Fact |
|---|---|
| **SRS fact** | §16.2 models a cash session as *"one employee, one shift, one drawer"*. FR-FIN-001 [M]: one open session **per drawer**. FR-FIN-002 [M]: a session is bound to exactly one employee; two employees SHALL NOT share an open session on the same drawer. §5.5.4 makes **Workforce** the publisher of `shift.opened` / `shift.closed`. |
| **Ratified P1D fact** | P1D-A: the two are distinct and not collapsed; the session **references** the shift. D-2's Workforce defer is reopened **narrowly** — *"Authorised now: Operational Shift identity and open/closed lifecycle state; the CashSession → Shift relationship"*. Schedules, attendance, clock-in/out, breaks, payroll remain **not authorised**. |
| **Repository fact** | `cash_sessions.shift_id` is indexed **non-uniquely** → **one Shift CAN own many CashSessions**. `uq_one_open_session_per_drawer` constrains **drawers, not shifts** → **multiple sessions under one Shift CAN be open simultaneously on different drawers**. `ShiftsService` exposes only `openShift`; no close, and no controller references it. |
| **Design choice (proposed, not decided)** | Closing one CashSession **must not** close the Shift — it cannot, since sibling sessions may still be open. Shift close, if implemented, must require **all** referencing sessions closed. |

### Answers

- **Can one Shift own more than one CashSession?** **Yes** — repository fact (non-unique index). Not contradicted by SRS.
- **Can multiple sessions under one Shift be open simultaneously?** **Yes** — the only open-session invariant is per drawer.
- **Does closing one CashSession close the Shift?** **No.** Structurally impossible to justify given the above.
- **When exactly may/shall the Shift close?** **NOT SOURCE-DECIDABLE.** No SRS text names the trigger, actor, or timing of Operational Shift close. FR-POS-094/096 say *"Shift close"* while FR-FIN-005/006/007 attach count, variance and immutability to the **session** — the two vocabularies are not reconciled by any source reviewed.
- **Must all referencing CashSessions be closed first?** A necessary condition if Shift close is implemented, but **the requirement itself is not source-stated**; it is inference from FR-FIN-007's session immutability, not authority.
- **Is Shift close a synchronous Treasury→Workforce command?** It would have to be (no outbox; P1E-1C same-transaction discipline; Workforce owns the aggregate) — but **the need is not established**, so this is not proposed.
- **Is `shift.closed` required for this slice?** **No.** §5.5.4 makes it a Workforce event; nothing in the cash-close path consumes it. **Recommendation: P1G-1 does NOT implement Shift close and does NOT create a standalone Shift-close HTTP route** — authority does not require one, and inventing the trigger would be exactly the gap-filling this gate forbids.

---

## 2. EXPECTED CASH — FULL FR-FIN-004 [M] TERM AUDIT

FR-FIN-004 [M], verbatim from the SRS:

```
Expected Cash = Opening Float + Cash Sales + Cash Tips (if placed in drawer)
              + Pay-ins − Cash Refunds − Pay-outs − Safe Drops
              ± Cash Rounding Adjustments
```

| # | Term | Classification | Evidence |
|---|---|---|---|
| 1 | **Opening Float** | **IMPLEMENTED FACT** | `cash_sessions.opening_float` (BigInt minor units), set at open |
| 2 | **Cash Sales** | **IMPLEMENTABLE FROM CURRENT FACTS** | Σ `OrderPayment.amount` WHERE `tender='cash'` AND `cash_session_id=?`. **Newly possible only because of P1F-2** |
| 3 | **Cash Tips (if placed in drawer)** | **OUTSIDE CURRENT SUPPORTED OPERATION** | No tip entity, column, or route anywhere. Source basis is **FR-POS-056/057 [S]** — *SHOULD*, not mandatory, and scoped to "tip entry at payment, on the payment terminal". No integrated terminal exists (FR-POS-064 absent). |
| 4 | **Pay-ins** | **NOT IMPLEMENTED** — required by **FR-POS-091 [M]** | No cash-movement substrate |
| 5 | **Cash Refunds** | **OUTSIDE CURRENT SUPPORTED OPERATION** | Refunds are an explicit P1F-2 NON-GOAL and absent repo-wide. `pos.refund.issue` is SRS-named but unimplemented. |
| 6 | **Pay-outs** | **NOT IMPLEMENTED** — required by **FR-POS-091 [M]** | As #4 |
| 7 | **Safe Drops** | **NOT IMPLEMENTED** — required by **FR-POS-091 [M]** and **FR-POS-092 [M]** | As #4; FR-POS-092 additionally requires a configurable drawer limit |
| 8 | **Cash Rounding Adjustments** | **IMPLEMENTABLE FROM CURRENT FACTS** | `OrderPayment.rounding_adjustment` — already correctly modelled as a drawer-reconciliation figure never added to `paid_total` (BR-FIN-004) |

**Only 3 of 8 terms are available.** Three of the five missing terms (#4, #6, #7) are **mandatory operations in their own right** under FR-POS-091 [M].

### Decision on options A / B / C

The brief correctly forbids "scoping out" mandatory requirements to shrink the slice.

- **Option C is rejected.** There is **no authoritative reason** pay-in/pay-out/safe-drop may sit outside while P1G-1 is merely "PARTIAL". They are [M], their permissions (`cash.payin`, `cash.payout`, `cash.safedrop`) are **SRS-named**, and they are **arithmetic inputs to another [M] formula**. A close computing expected cash from an incomplete formula would produce a **wrong variance** — and variance is the control the whole slice exists to provide. Shipping a knowingly-wrong control figure is worse than not shipping it.
- **Option A (fold into P1G-1) vs Option B (separate prerequisite P1G-0):** **B is preferred.** Cash movements are a self-contained Treasury capability with their own routes, permissions, audit and drawer-limit rule (FR-POS-092 [M]); folding them in roughly doubles the slice and mixes two independently-testable concerns. Critically, **P1G-0 is not blocked by anything** — unlike P1G-1 (§3).

**Conclusion:** a **P1G-0 Treasury CashMovement foundation (pay-in / pay-out / safe-drop + drawer limit)** is a genuine prerequisite. Terms #3 and #5 remain structurally unavailable and must be stated as such — with them absent, **FR-FIN-004 can at best be PARTIAL even after P1G-0**, and the report must say so rather than claim a complete formula.

---

## 3. APPROVAL — THE HARD BLOCKER (PROVEN, NOT ASSERTED)

### 3.1 Correction to the brief's premise

The brief states *"P-1 remains: approval_decisions references approval_requests directly."* **Repository evidence does not support that.** The register's own analysis concludes:

> **NO SOURCE-SUPPORTED RECOMMENDATION** between P-1 and P-2.
> **This must therefore be settled as an ARCHITECTURAL RATIFICATION**, in exactly the manner already used for **D-4**'s lifecycle and **D-8**'s no-DELETE portion.

and records for P-1: *"Approved-design basis: **NONE** — a deviation, additional to D-1's."* **P-1 is a candidate, not a ratified position.** This gate therefore cannot build against it.

### 3.2 The requirement stack

| Requirement | Text | Consequence |
|---|---|---|
| **FR-SEC-030 [M]** | *"SHALL provide a **general approval mechanism** used by discounts, refunds, purchase orders, waste, count adjustments, expenses, and price changes."* | Approval is a **shared platform mechanism**, not a Treasury-local field |
| **FR-SEC-031 [M]** | Requests specify requesting user, action, affected entity, value, **required approver permission**, and **an expiry** | A real request entity is mandated |
| **FR-SEC-032 [M]** | Obtainable **synchronously (manager PIN on the terminal)** or asynchronously, terminal usable while awaiting | Sync manager-PIN is source-sanctioned — but still *through* the mechanism |
| **FR-SEC-033 [M]** | Decisions record approver, timestamp, decision, comment; **immutable** | A real decision entity is mandated |
| **FR-SEC-016 [M]** | SHALL **block, not merely warn**, on *"approving one's own cash variance"* — **regardless of role configuration** | Self-approval must be structurally impossible |
| **FR-FIN-006 [M]** | Variance beyond tolerance requires reason **and approval by a user with `cash.variance.approve`, who SHALL NOT be the session owner** | Approver identity must be recorded and constrained |
| **SRS §15 SoD matrix** | Names the toxic pair `cash.session.close` + `cash.variance.approve` = **"Self-approved shortage"** | Direct source support for the SoD rule |

### 3.3 Answers to the six required questions

1. **Is a conformant synchronous manager-PIN variance approval implementable with the currently ratified Approval design?**
   **NO.** There *is* no ratified approval design to implement against — the decision→request linkage is unresolved (§3.1), and `approval_steps`' existence was *"twice declined"*.

2. **Does the required persistence already exist?**
   **NO.** Verified exhaustively: no approval model, no migration, no service. Only FK-less recorded-UUID columns that are NULL in this phase.

3. **If ApprovalRequest/ApprovalDecision runtime is absent, is that a HARD prerequisite to P1G-1?**
   **YES — for the above-tolerance close path.** Without it, a session whose variance exceeds tolerance **can never be closed**, which defeats the slice's own purpose: real shortages are routine, and the cycle would remain unclosable exactly when control matters most.

4. **Can P1G-1 introduce only the consuming integration while another approved Governance slice supplies the mechanism?**
   **Architecturally yes — and this is the recommended shape** — but it does not unblock P1G-1 *now*. P1G-1 could own only the *reference* (a nullable `variance_approval_request_id`) and the SoD enforcement, with the mechanism delivered by a Governance slice. That still requires the Governance slice to land **first or concurrently**, and that slice is itself gated on §3.4.

5. **Do unresolved D-12 / D-16 / SB residuals materially block the exact persistence needed here?**
   **YES, materially and specifically:**
   - **D-16 is OPEN** on the `request_type` contract. A cash-variance request needs a `request_type` value; the register states `request_type` is *"deliberately open"* and *"must not be resolved here"*. Minting one **is** resolving D-16.
   - **Parent linkage unresolved** (P-1 vs P-2) — a decision cannot be persisted without choosing.
   - Endpoint classification: **"Create approval request" = C + E**; **"Approve / reject (create decision)" = C + E** — *"No SRS route… E on parent-linkage — a decision's parent is unresolved."*
   - **D-12 BLOCKED** affects escalation (FR-SEC-034 [S]) only — **not** a blocker for this slice, recorded for completeness.

6. **Is an explicit user/governance decision required before implementation?**
   **YES.** Listed in §19.

### 3.4 What this gate must NOT do

Per the brief and per governance: it must not treat *possession* of `cash.variance.approve` as an approval record, and must not invent an inline `approvedBy` field bypassing the mechanism. **This gate does neither.** An inline approver field would also directly contradict FR-SEC-030's "general approval mechanism" and would set a precedent that pre-empts the very ratification the register defers.

---

## 4. CLOSE STATE MACHINE

Designed only as far as authority permits; the above-tolerance branch is **not** designed, because its terminal step is blocked.

**Path A — within tolerance (designable now):**
```
OPEN → [close command: denominations submitted]
     → server computes counted (from denominations)
     → server computes expected (FR-FIN-004, inside the txn, under lock)
     → variance = counted − expected            (FR-FIN-005)
     → |variance| ≤ tolerance
     → posted facts written + CLOSED, atomically, one transaction
```

**Path B — above tolerance: NOT DESIGNABLE.** Terminates in an approval step that cannot exist (§3).

**Intermediate states — deliberately NOT proposed.** `closing` / `awaiting_variance_approval` would be needed **only** if Path B existed, and FR-SEC-032's "terminal remains usable while awaiting an asynchronous decision" hints an async variant would require one. Adding a state now would be inventing semantics for a path that cannot be built. **NOT SOURCE-DECIDABLE** until the approval mechanism is ratified.

**The count-invalidation race — defined explicitly (required by the brief).** If a Payment or CashMovement commits to the session after the physical count is taken, the count is stale and the variance is false. Two candidate disciplines:

- **(i) Single-command close (recommended while Path B is blocked).** Count submission *is* the close. Expected cash is computed **inside the same transaction** that flips `status`, holding a row lock on the session (`SELECT … FOR UPDATE`) and rejecting if `status <> 'open'`. No window exists. Concurrent Payment capture must take the **same** session lock and observe `status='open'`, so a Payment either commits before the close (and is counted) or fails after it (session closed) — never silently lands in a closed session.
- **(ii) Two-command (submit-count, then close).** Opens a real window between declaration and close, which then **requires** an intermediate state that freezes financial effects. Only justified if Path B exists.

**Recommendation: (i)**, revisited when approval lands.

---

## 5. BLIND COUNT — SERVER-ENFORCED PROTOCOL

FR-POS-094 [M] (blind and open, configurable per branch), FR-POS-095 [M] (**blind is default**, with an explicit internal-control rationale). This cannot be "the frontend hides the number".

**Leak audit of current API:** `CashSessionsService` exposes `open`, `findOne`, `findOpenForDrawer`. **No expected-cash figure is computed or returned anywhere today**, so there is no existing leak — but that is because the computation does not exist, not because it is protected. Any new read surface must preserve this.

**Proposed protocol (blind mode):**
- The close request carries the **denomination declaration only**. It must **not** be preceded by any endpoint that returns expected cash for an open session.
- Expected cash is computed **server-side, after** the declaration is durably accepted, in the same transaction.
- The **response** carries `expectedCash`, `countedCash`, `variance` — i.e. disclosure occurs strictly after declaration, which is exactly FR-POS-095's control.
- **Count submission is immutable**: a second differing declaration for the same session must not overwrite the first.
- **Retry/idempotency**: `Idempotency-Key` required; identical replay returns the identical stored response (the existing interceptor's semantics); a differing body under the same key is a fingerprint mismatch → 409.
- **Open mode** may expose expected cash before declaration; the mode must be resolved **server-side** from configuration, never from a client flag.
- **Manager visibility:** the approver needs expected/counted/variance — which is *post-declaration* data, so it leaks nothing to the cashier. However, **how the approver obtains it is part of the blocked approval design** and is not specified here.

---

## 6. CONFIGURATION SOURCE

Settings required: **blind vs open count** (per branch), **variance tolerance**, and — if P1G-0 lands — **drawer limit** (FR-POS-092 [M]).

**FR-PLT-025 [M]** requires a hierarchical settings resolver; **FR-PLT-026 [M]** requires lockability with the locking level named. **Neither exists**: there is no settings model, no settings module, no resolver — only opaque `org.settings` / `defaultSettings` JSONB with no read path, no precedence, no locking.

| Setting | Source of truth | Level | Default | Lockability | Effective-value resolution |
|---|---|---|---|---|---|
| Blind vs open count | **NOT SOURCE-DECIDABLE where it lives** — FR-POS-094 says "per branch"; FR-PLT-025 says settings hierarchy; the hierarchy does not exist | branch (per FR-POS-094) | **blind** (FR-POS-095 [M], explicit) | Required by FR-PLT-026; **unimplementable today** | **No resolver exists** |
| Variance tolerance | Same | branch or tenant — **not stated by any source** | **NOT SOURCE-DECIDABLE** — no numeric default anywhere in the SRS | As above | As above |
| Drawer limit (FR-POS-092) | Same | branch | **NOT SOURCE-DECIDABLE** | As above | As above |

**Conclusion.** Implementing FR-PLT-025/026 is a platform slice far larger than P1G-1 and clearly outside its fence. The brief forbids claiming FR-POS-094 complete via a hard-coded branch setting — correctly. So:

- **Blind-count default is safe**: FR-POS-095 [M] *states* blind is the default, so defaulting to blind with no configurability is **truthful and control-correct**, and yields **FR-POS-095 COMPLETE / FR-POS-094 PARTIAL** (the "configurable" half unmet).
- **Variance tolerance has no source-stated default at all.** Choosing one would be inventing a financial control threshold. **NOT SOURCE-DECIDABLE — a user/governance decision.** This compounds the §3 blocker: tolerance is the trigger for the approval path.

---

## 7. DENOMINATION COUNTING

FR-POS-097 [M]: denomination-level counting, **System computes the total** from the counts.

**Smallest truthful model: Option A — an immutable `CashCount` parent + denomination child rows.** Rejected alternatives: **B (structured JSON)** cannot express per-row CHECK constraints (positive quantity, positive denomination) or be indexed/aggregated in SQL, and would store money semantics in an opaque blob — inconsistent with this repository's exact-integer discipline; **C** — no existing model fits (audited: nothing in Treasury or elsewhere represents a physical count).

Fields to preserve (all integer minor units; **no floating point** anywhere): tenant, branch, session, currency (snapshot, matching the session's), denomination value, quantity, computed subtotal, computed total, declaring **employee** (P1D-E identity), declaring user/session identity where relevant, timestamp. Append-only posture; total recomputed server-side and never client-supplied.

**Valid denomination values: NOT SOURCE-DECIDABLE.** Verified the country pack model carries only `currency: Currency` (code, exponent) and `cashRounding` — **no denomination catalogue**. Nothing in the SRS, governance, or repository defines the legal denominations for a currency. Per the brief, **no Egyptian denomination catalogue may be invented in core code.** The only truthful posture available now is: accept caller-supplied `(denominationValue, quantity)` pairs, validate them as **positive integers** and that the computed total is internally consistent, and **do not** validate against a catalogue — recording explicitly that catalogue validation is unimplemented.

---

## 8. CASH VARIANCE FACTS — WHY THEY ARE POSTED FACTS, NOT PROJECTIONS

On successful close the following must become **immutable posted facts**: `expected_cash`, `counted_cash`, `variance`, `variance_reason` (when required), `closed_at`, `closed_by` (Employee, per P1D-E and FR-POS-007 [M]), and — once approval exists — an approval reference.

**Justification for storing derived values (required by the brief).** These are **not** redundant caches of a recomputable projection, for the same reason P1F-2's `posted_cogs_total` is a distinct fact from `unit_cost_snapshot`:

- **FR-FIN-007 [M]** makes a closed session immutable; a *recomputed* expected cash is by definition mutable.
- Expected cash depends on **configuration** (tolerance is separate, but the formula's scope — e.g. whether tips/refunds/pay-ins are in play — evolves as P1G-0 and later slices land). A later change must **never** retroactively alter a historical close. Recomputation would do exactly that.
- **CR-04 / BR-POS-001** immutability discipline: historical financial records are not rewritten; corrections are new entries.
- Payments are immutable, but the *set* considered could change if an adjusting entry is later attached (§9). The posted figure must record what was true **at close**.

Therefore `expected_cash` at close is a **historical posted fact**, exactly like posted COGS — and must be written once, never updated.

---

## 9. FR-FIN-007 ADJUSTING ENTRIES

FR-FIN-007 [M]: *"Cash sessions SHALL be immutable once closed. Corrections SHALL be recorded as adjusting entries referencing the session."*

**Can P1G-1 claim FR-FIN-007 COMPLETE without an adjusting-entry substrate? NO.** The requirement has two clauses; a close that writes immutable facts satisfies only the first.

Evaluating the options: **(A)** folding adjusting entries into P1G-1 expands scope and — critically — **an adjusting entry is a privileged financial correction whose authorization code the SRS does not name** (no `cash.adjust`, `cash.session.adjust`, or equivalent appears in the catalogue). Minting one violates the zero-invented-codes discipline. **NOT SOURCE-DECIDABLE.** **(B)** as an immediate sub-slice inherits the same unnamed-permission problem.

**Recommendation: (C) — P1G-1 ships close; FR-FIN-007 remains PARTIAL** (immutability clause met, corrections clause unmet), with the missing authorization code recorded as NOT SOURCE-DECIDABLE. This is honest and blocks nothing.

---

## 10. TENDER TOTALS

FR-FIN-010 [M]: totals **per session and per day**, by tender type: *cash, each card scheme, each wallet, gift card, voucher, on-account, aggregator-settled*.

**Source of truth: `OrderPayment`, per P1D-G.** Supported tenders in the MVP are exactly **`cash`** and **`manual_external_card`**. The SRS's enumerated classes (wallets, gift card, voucher, on-account, aggregator) **do not exist**, so **global FR-FIN-010 cannot be claimed COMPLETE** — only "complete for the tenders that exist".

**Aggregation rules:**
- **Cash** — increases drawer cash; feeds Expected Cash term #2.
- **`manual_external_card`** — associated to the session **for reconciliation only**; **never** increases drawer cash and must **never** enter the expected-cash formula. (Its `changeGiven` is NULL by construction and `tenderedAmount` is NULL — already enforced.)
- `roundingAdjustment` is summed separately (term #8), never folded into a tender total.

**Persist a snapshot at close, or derive?** **Derive** for the per-session figure at read time, **and** persist only what the close itself posts (§8). Justification: `OrderPayment` rows are **immutable and append-only**, and once the session is closed no further payment can attach to it (§4 lock discipline) — so the derivation is **historically stable by construction**, and a persisted duplicate would add a second thing to keep in step for no gain. This is the same reasoning that makes `posted_cogs_total` a fact (it summarises *mutable-in-principle* inventory state) while tender totals are not.

**Per-day totals: PARTIAL/blocked.** A "day" requires FR-FIN-024 [M]'s configurable business-day boundary, which **is not implemented**. Per-session totals are achievable; per-day are not, and belong with Day close.

---

## 11. X REPORT — AUTHORIZATION

FR-POS-093 [M]: an X report (non-resetting mid-shift summary) "on demand for **authorised users**".

**The SRS names no X-report permission.** Verified: §15.2's catalogue contains `cash.session.open`, `cash.session.close`, `cash.session.close_other`, `cash.variance.approve`, `cash.day.close`, `cash.payin`, `cash.payout`, `cash.safedrop`, `cash.drawer.open_no_sale` — **and no X-report code**. The only reporting entries are the **templates** `report.view.<category>` and `report.export`, and **the `<category>` vocabulary is not enumerated anywhere in the SRS**.

**Conclusion: NOT SOURCE-DECIDABLE.** Authorising the X report requires either minting `cash.x_report` (forbidden — invention) or minting a `report.view.<category>` value (equally an invention, and structurally the same open-type-contract problem as D-16's `request_type`).

**Per the brief, this must not block the underlying close calculation** — and it does not: expected cash, counted cash and variance are computed by the close command under `cash.session.close`. **Recommendation: P1G-1 ships no X-report endpoint**; FR-POS-093 stays NOT IMPLEMENTED pending a permission decision. The *computation* it would need is built either way.

---

## 12. IDEMPOTENCY / CONCURRENCY

Applying FR-API-020…023, NFR-REL-011, CR-04. The existing `common/idempotency/` interceptor and `IdempotencyKey` model are reused — **no new idempotency framework**.

- **Idempotency-Key: REQUIRED on every financial POST** (close; and every P1G-0 cash movement).
- **Permanent business identity:** the CashSession id is the natural close identity — close is a **CAS transition on an existing aggregate**, not a creation, so no new client-minted permanent id is needed (unlike Payment/FR-OFF-015).
- **Response replay:** identical key + identical fingerprint → stored response replayed. Differing fingerprint → **409**.
- **Double-submit close:** the second attempt finds `status <> 'open'` under lock → deterministic **409**, never a second close.
- **Two managers approving one variance:** unresolvable here — belongs to the blocked approval design (D-15 is explicitly recorded as having *"no unique constraint, no locking"*).
- **Close vs concurrent Payment:** both paths must take the **same** session row lock. Payment capture must assert `status='open'` **inside** its transaction. Ordering: **session row → order row → inventory batch layers**, matching the existing P1F-2 order so no deadlock inversion is introduced (P1F-2 already locks sessions/orders before inventory layers; close never touches inventory).
- **Close vs PAY_IN/PAY_OUT/SAFE_DROP:** same session lock; a movement committing after close must be rejected.
- **close-other vs owner close:** both are the same CAS; whichever commits first wins, the other 409s.
- **Count submission retry:** idempotent by key; the declaration is immutable (§5).

**Critical invariant, satisfied:** expected cash is computed **inside** the closing transaction while holding the session lock, so a session can never close from a stale expected cash.

**Required real-Postgres concurrency tests (≥3 clean runs each, real barriers, no sleeps as proof):**
1. Two concurrent closes, same session → exactly one closes; the other 409s; exactly one set of posted facts.
2. Close vs concurrent cash Payment on the same session → serialized; the payment is either fully counted in expected cash or cleanly rejected; ledger and posted expected cash agree exactly.
3. Close vs concurrent PAY_IN / SAFE_DROP (once P1G-0 exists) → same guarantee.
4. Owner close vs `close_other` raced → one winner, correct `closed_by`.
5. Idempotent close replay → identical stored response, exactly one state transition, exactly one audit entry.
6. Two sessions on different drawers under one Shift closing concurrently → both succeed, no cross-interference (guards the §1 cardinality finding).

---

## 13. AUTHORIZATION / SoD

**SRS-named permissions only** — no invention:

| Permission | Meaning |
|---|---|
| `cash.session.close` | Close **one's own** session (actor's Employee = `cash_sessions.employee_id`) |
| `cash.session.close_other` | Close a session owned by **another** employee (supervisor override) |
| `cash.variance.approve` | Approve an out-of-tolerance variance — **consumer only; the mechanism is blocked (§3)** |

Enforcement required:
- **Own vs other:** actor Employee ≠ session owner → require `cash.session.close_other`.
- **Owner identity is the Employee** (P1D-E), from the trusted PIN session — never the request body, never the identity User.
- **Approver ≠ session owner** (FR-FIN-006) and **FR-SEC-016 block, not warn, regardless of role configuration** — so the check is **unconditional in code**, not a role-composition matter. §15's SoD matrix independently names `cash.session.close` + `cash.variance.approve` as *"Self-approved shortage"*, confirming the pair is toxic **even for one user holding both**.
- **Branch safety — explicitly required.** D-2's branch-scoped RBAC remains **deferred**, so permissions are tenant-wide. This gate must **not** treat tenant-wide RBAC as branch-safe. The operation itself must therefore assert, in code: the session's `branch_id` matches the actor's PIN-session branch/terminal context, and the drawer/terminal belong to that branch. These are **narrow operation-level checks**, not a branch RBAC redesign.

---

## 14. AUDIT + EVENTS

**Audit entries required** (append-only, hash-chained, existing `AuditService`): count submitted (denominations + computed total), variance detected (expected/counted/variance/tolerance), variance reason, approval requested/decided *(blocked)*, session closed (before-state + posted facts + `closed_by`), shift closed *(not in this slice)*, adjusting entry *(not in this slice)*.

**Events.** The SRS event catalogue names **`cash.variance.detected`** — publisher **Treasury**, subscribers **Governance, Analytics**. This is source-required and should be published **in the same transaction** via the existing `UnitOfWork` / `ctx.publishEvent` mechanism (P1E-1C discipline). **`shift.closed`** is a **Workforce**-published event (§5.5.4) and is **out of scope** here (§1).

**No outbox.** Nothing in current authority requires one; P1E-1C's same-transaction in-process dispatcher stands.

---

## 15. DATA / MIGRATION DESIGN — CONTINGENT, NOT PROPOSED FOR EXECUTION

**No migration is written, and migration 31 must not be created while the verdict is C.** Shape recorded only so the eventual gate can move quickly.

Treasury-owned (**never** in Sales):

- **`treasury.cash_sessions` — added columns:** `counted_cash BIGINT NULL`, `expected_cash BIGINT NULL`, `variance BIGINT NULL`, `variance_reason TEXT NULL`, `closed_by UUID NULL` (Employee, tenant-safe composite FK), `variance_approval_request_id UUID NULL` (**recorded id, no FK** — matching the existing `waste_records.approval_request_id` precedent, pending §3). CHECKs: all-or-nothing on close (`status='closed'` ⇒ counted/expected/variance/closed_at/closed_by NOT NULL), `variance = counted_cash − expected_cash`, reason required when |variance| > tolerance **only if** tolerance is persisted with the close (else unenforceable — a consequence of §6). Mutable-once (open→closed) by nature, so the table stays UPDATE-capable; the **posted facts** are protected by CHECK, not by grant.
- **`treasury.cash_counts`** — immutable parent: `id`, `tenant_id`, `branch_id`, `cash_session_id`, `currency CHAR(3)`, `counted_total BIGINT` (server-computed), `declared_by_employee_id`, `declared_at`, `created_at`. UNIQUE `(tenant_id, cash_session_id)` — one declaration per session (§5 immutability). Composite tenant-safe FKs. **Append-only**: `GRANT SELECT, INSERT`, `REVOKE UPDATE, DELETE, TRUNCATE`; RLS `ENABLE`+`FORCE`, SELECT+INSERT policies only.
- **`treasury.cash_count_denominations`** — child: `id`, `tenant_id`, `cash_count_id`, `denomination_value BIGINT` (minor units, CHECK > 0), `quantity INT` (CHECK > 0), `subtotal BIGINT` (CHECK `subtotal = denomination_value * quantity`), `created_at`. UNIQUE `(tenant_id, cash_count_id, denomination_value)`. Same append-only + RLS posture. Index `(tenant_id, cash_count_id)`.
- **Money semantics:** all BIGINT **minor units**; currency snapshotted from the session; no floating point; no DECIMAL for money.
- **No generic Approval table is proposed** — governance defines that shape and has not settled it (§3).

---

## 16. API DESIGN — CONTINGENT

A **single-call close is sufficient while Path B is blocked** (§4), and is the honest shape today:

```
POST /cash-sessions/{id}/close
  Headers: Authorization (PIN session), Idempotency-Key (REQUIRED)
  Body:    { denominations: [{ denominationValue, quantity }, ...],
             varianceReason?: string }
  Perms:   cash.session.close  (or cash.session.close_other)
  200/201: { countedCash, expectedCash, variance, closedAt, closedBy }
  409:     session not open / concurrent close / idempotency fingerprint mismatch
  422:     variance exceeds tolerance and approval is unavailable (see §3)
```

Separate `submit-count` and `approve-variance` commands become necessary **only when approval lands** (they are what Path B requires) — so they are **deliberately not specified now**, per the brief's instruction not to invent routes prematurely. No `/v1` retrofit. Errors use the existing Nest envelope; **no RFC 7807 claim**.

---

## 17. SCOPE FENCE — CONFIRMED

Excluded and untouched: Day close, Z report, Receipt, fiscal documents, KDS, refunds, integrated card, branch-wide RBAC redesign, offline sync, NFR-PERF-006 optimization, general reporting platform. The one prerequisite proven unavoidable is **P1G-0 cash movements** (§2) — not a scope expansion but a separate, earlier slice.

---

## 18. REQUIREMENT CLASSIFICATION

"After" = after a hypothetical P1G-1 shipping Path A only, assuming P1G-0 has landed.

| Req | Now | P1G-1 would implement | Remains | After |
|---|---|---|---|---|
| **FR-POS-091** [M] | NOT IMPLEMENTED | — (P1G-0) | pay-in/out/safe-drop | **BLOCKED for P1G-1; COMPLETE after P1G-0** |
| **FR-POS-092** [M] | NOT IMPLEMENTED | — (P1G-0) | drawer limit + config home (§6) | **PARTIAL after P1G-0** |
| **FR-POS-093** [M] | NOT IMPLEMENTED | nothing (auth NOT SOURCE-DECIDABLE, §11) | endpoint + permission | **NOT IMPLEMENTED** |
| **FR-POS-094** [M] | NOT IMPLEMENTED | blind count server-enforced | per-branch configurability (§6) | **PARTIAL** |
| **FR-POS-095** [M] | NOT IMPLEMENTED | blind as default | — | **COMPLETE** |
| **FR-POS-096** [M] | NOT IMPLEMENTED | variance computed + recorded; reason captured | **manager acknowledgement (§3)** | **PARTIAL** |
| **FR-POS-097** [M] | NOT IMPLEMENTED | denomination counting, server-computed total | denomination catalogue (NOT SOURCE-DECIDABLE, §7) | **PARTIAL** |
| **FR-FIN-004** [M] | NOT IMPLEMENTED | terms 1, 2, 8; terms 4/6/7 via P1G-0 | **tips (#3), refunds (#5)** — no operations exist | **PARTIAL** |
| **FR-FIN-005** [M] | NOT IMPLEMENTED | variance = counted − expected, recorded on session | accuracy depends on FR-FIN-004 | **PARTIAL** (complete arithmetic, incomplete inputs) |
| **FR-FIN-006** [M] | NOT IMPLEMENTED | SoD checks + reason capture only | **approval mechanism + tolerance config** | **BLOCKED** |
| **FR-FIN-007** [M] | NOT IMPLEMENTED | immutability of closed session | **adjusting entries** (§9) | **PARTIAL** |
| **FR-FIN-010** [M] | NOT IMPLEMENTED | per-session totals for `cash` + `manual_external_card` | per-day (needs FR-FIN-024); absent tender classes | **PARTIAL** |
| **FR-SEC-016** [M] | NOT IMPLEMENTED | unconditional self-approval block for cash variance | other named combinations (requisition, discount, count) | **PARTIAL** |
| **FR-SEC-030** [M] | NOT IMPLEMENTED | nothing | the entire general mechanism | **BLOCKED** |
| **FR-SEC-031** [M] | NOT IMPLEMENTED | nothing | request entity + expiry | **BLOCKED** |
| **FR-SEC-032** [M] | NOT IMPLEMENTED | nothing | sync/async approval | **BLOCKED** |
| **FR-SEC-033** [M] | NOT IMPLEMENTED | nothing | decision entity + immutability | **BLOCKED** |
| **FR-PLT-025** [M] | NOT IMPLEMENTED | nothing | hierarchical resolver | **NOT IMPLEMENTED** |
| **FR-PLT-026** [M] | NOT IMPLEMENTED | nothing | lockability | **NOT IMPLEMENTED** |

**No requirement would reach COMPLETE except FR-POS-095.** That alone disqualifies the "no governance blocker" reading offered in the prior next-slice report, which this gate hereby corrects.

---

## 19. FINAL READINESS VERDICT

# **C. BLOCKED — APPROVAL/GOVERNANCE RESOLUTION REQUIRED**

### Minimum unresolved decisions required from the user / governance

1. **Ratify the approval decision→request linkage (P-1 vs P-2).** The register states there is **no source-supported recommendation** and that this must be settled as an **architectural ratification**. Without it, no approval decision can be persisted.
2. **Resolve D-16's `request_type` contract** far enough to admit a cash-variance request type. The register says `request_type` is *"deliberately open"* and *"must not be resolved here"* — so it must be resolved **there**, by governance, not by an implementation slice.
3. **Authorise the Governance approval slice** that stands up `approval_requests` + `approval_decisions` (FR-SEC-030…033 [M]), including the Class-C endpoint deviation the register already flags (GAP-1 precedent). P1G-1 then consumes it.
4. **Set the variance tolerance's source of truth and default** — no SRS value exists (§6). Either accept a stated, governance-recorded default with FR-POS-094 PARTIAL, or commission FR-PLT-025/026 settings first.
5. **Confirm the P1G-0 prerequisite** (pay-in / pay-out / safe-drop, FR-POS-091 [M]) as a separate preceding slice — recommended (§2), and **not blocked by anything**.

### Also NOT SOURCE-DECIDABLE (record, do not invent)

- Denomination catalogue per currency (§7).
- X-report authorization — no `cash.x_report`; `report.view.<category>` vocabulary unenumerated (§11).
- Adjusting-entry authorization code (§9).
- Operational Shift close trigger/actor/timing (§1).

### Recommended path forward

**P1G-0 (Treasury cash movements) can proceed now** — every permission it needs is SRS-named, it has no governance blocker, and it is a hard arithmetic prerequisite for FR-FIN-004. Run the **Governance approval ratification (items 1–3) in parallel**. P1G-1 then becomes designable in full, including Path B.

**No Sonnet implementation prompt is provided**, because the verdict is not A.

---

## Update to INDEX.md

Appended (see `docs/reports/claude/INDEX.md`).

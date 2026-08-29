# Approval Runtime Minimum Resolution — Ratification Recorded

**Report type:** Governance recording. **No product code, no migration, no test changes, no implementation, no commit, no push, no D-21+.**
**Authority statement:** This report is **non-authoritative evidence**. The **binding record is the Governance Decision Register entry** appended by this task (`## Approval Runtime Minimum Resolution — 2026-08-29`, plus its ratification-log entry). Where this report and the register differ, **the register governs**. The two occasioning reports remain non-authoritative evidence and are **corrected on two points** by the register entry (§4).
**Date:** 2026-08-29
**HEAD:** `55e4ae8` (unchanged; no commit performed)
**Branch:** `feat/production-spec`
**Working tree:** register + `INDEX.md` modified; this report added. Unrelated uncommitted reports untouched.
**Task identifier:** APPROVAL ratification recorded

> ## STATUS
> ## **RECORDED — EIGHT RESOLUTIONS BINDING**
>
> The user's ratification of items 1–8 (item 8 = **R-b**) plus the two binding
> clarifications is recorded in the register as an **unnumbered carried-item /
> amendment entry**, in the established forward-supersession style.
>
> **The register diff is `263 insertions, 0 deletions`** — mechanical proof
> that **no historical text was rewritten**, no decision renumbered, and no
> `D-21+` created.
>
> **One substantive correction was required during recording.** The
> correction report asserted that item 5 *"does not amend D-15."* That is
> **false**: **D-15 clause 4 prohibits the one-decision-per-request UNIQUE
> constraint by name.** The ratified **substance is recorded unchanged**; its
> **governance characterisation is corrected** to a narrow amendment of D-15
> clause 4 via the route **D-15 clause 14 itself provides**. Recording the
> claim as written would have placed a false statement into the register.

---

## 1. WHAT WAS RECORDED, AND WHERE

Two additive edits to `docs/governance/GOVERNANCE_DECISION_REGISTER.md`:

| # | Location | Content |
|---|---|---|
| 1 | New `##` section **`Approval Runtime Minimum Resolution — 2026-08-29`**, appended chronologically after *FIFO Exhaustion Carry-Forward Ratification — 2026-08-25* and immediately before `## Final Decision Matrix` | Full ratification: header block, *The question*, the eight binding resolutions, *Corrections*, *Not decided*, *Preservation*, `Status: RATIFIED — CLOSED` |
| 2 | New bullet appended to the **Ratification log** (inside the Final Decision Matrix section) | Condensed authoritative summary of all eight resolutions and every preservation clause |

**Placement rationale.** The register appends dated, unnumbered ratification sections in chronological order before the Final Decision Matrix — the pattern of *P1A / P1C / P1D*, *Fire Authorization — 2026-08-24*, *P1F-2 Completion Economics — 2026-08-25* and *FIFO Exhaustion Carry-Forward — 2026-08-25*. The new entry follows that convention exactly, including the header block form (`RECORDED … by explicit user governance action` / `NOT a new numbered decision — no D-21 is created and the 20-decision tally is unchanged`).

**Tally.** Unchanged: **17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN**. No numbered decision was added, and **D-16 remains the OPEN one** because only its Phase-1 constraint form is resolved — its enumeration stays open.

---

## 2. THE EIGHT RESOLUTIONS AS RECORDED

| # | Resolution | Governance effect |
|---|---|---|
| **1** | `request_type` = `VARCHAR(32) NOT NULL`, **no CHECK** this phase | **D-16 Phase-1 constraint form resolved. Enumeration remains OPEN; D-16 NOT closed.** Literal cash-variance code **not** decided |
| **2** | `required_permission` stores the immutable §15.2 **code**, **no FK**; authority checked at decision time against the approver's resolved permission-code set | **SB-1 RESOLVED.** No new permission code created |
| **3** | **No DELETE capability** for `ros_app`; no DELETE policy; decisions FK **`ON DELETE RESTRICT`**; CASCADE still rejected | **SB-3 RESOLVED.** **D-8 clause 6 cascade verification dissolved** — no delete path exists for a cascade to fire through — and **V2 is not required** |
| **4** | `decision` = immutable historical fact; `status` = current-state projection, still the sole D-6-updatable request column | **D-4 clause 5 RESOLVED.** D-4's lifecycle unchanged; no new state introduced |
| **5** | Exactly **one** final decision per request; future schema enforces **`UNIQUE (tenant_id, approval_request_id)`** | **Narrowly AMENDS D-15 clause 4**, superseding clauses 10 and 11 — see §4.1 |
| **6** | **D-2 amended in part** — defer lifted **only** for synchronous manager-PIN approval on a registered terminal, reusing the existing `FR-SEC-021`/`022` substrate | Async `FR-SEC-032`, D-11, D-12, broader branch RBAC, **D-14 A-1** and **D-20** all expressly preserved |
| **7** | `value` = **`JSONB NOT NULL`**, an **opaque carrier**; money as **base-10 integer strings of minor units** | **SB-2 RESOLVED.** Money-only `BIGINT` exclusion preserved; the open nullability sub-question resolved by `NOT NULL` |
| **8** | **F-1 = R-b** — one nullable **excluded-approver** column (an **Identity USER ID**, not an Employee ID) + a **DB-enforced fourth conjunct** on the decisions INSERT policy | **Amends D-1's column set and D-9's INSERT policy**, recorded as a D-9 policy amendment/consequence in the manner of D-7 cl. 6 and D-10 cl. 9 |

### 2.1 The two binding user clarifications — both recorded verbatim in substance

**Clarification A (item 7).** Monetary values within the JSONB **SHALL** be represented as **base-10 integer strings of minor units, so that application-layer numeric precision is preserved**. The register entry states this as binding text and, per the user's instruction, **makes no claim about PostgreSQL `jsonb` internal storage** (§4.2).

**Clarification B (item 8).** The excluded-approver identity is an **Identity USER ID, in the same identity domain as `approval_decisions.approver_id` — NOT an Employee ID**. For cash variance, **Treasury supplies the User identity corresponding to the CashSession owner** per the accepted Employee/User model. Recorded verbatim in substance, and load-bearing: `approval_decisions.approver_id` resolves to `identity.users`, while `cash_sessions.employee_id` resolves to `identity.employees`, so without this clarification the comparison would have been type-mismatched and the conjunct would never have fired.

---

## 3. WHAT WAS DELIBERATELY NOT RECORDED

The register entry carries an explicit **"Not decided by this entry"** block naming every item the brief listed, so none can later be read as settled by implication: the **literal `request_type` code for cash variance**; the **exact excluded-User column name**; its **exact FK shape**; the **exact RLS SQL / predicate form**; **approval service interfaces**; the **Identity contract shape**; the **migration number** beyond the existing planning assumption; the **CashSession-close API shape**; **variance tolerance / settings**; the **denomination catalogue**; the **X-report permission**; **Shift close**; **Day Close**; **D-12 escalation**; **asynchronous approval**; **notifications**.

**One Design-Gate consequence was recorded as a note and explicitly NOT ratified.** `identity.employees.user_id` is **nullable** (verified at `prisma/schema.prisma`: `userId String? @unique`), consistent with SRS §7.3 #25 *"May link to at most one User"*. The Employee → User mapping clause 8 requires can therefore yield NULL for an Employee with no linked User, which would leave the excluded-approver field NULL and the conjunct inert. The note records that the Design Gate must address this, and that **PIN authentication already requires a linked User**, so a PIN-opened session's owner necessarily has one. Flagging it prevents a silent gap in exactly the invariant item 8 exists to enforce.

---

## 4. CORRECTIONS MADE DURING RECORDING

Both occasioning reports are non-authoritative evidence. Two of their characterisations were wrong and are corrected **in the binding register text**, not silently.

### 4.1 Item 5 **does** amend D-15 — the correction report was wrong

The correction report (§4.2) claimed: *"**Item 5 does not amend D-15.** D-15 ratified no additional approval-specific concurrency **mechanism** … A `UNIQUE` constraint is a **declarative schema constraint**, not a concurrency mechanism."*

**D-15's ratified clause 4 refutes this directly**, naming the exact constraint:

> 4. **Do NOT** introduce a **UNIQUE constraint** establishing *"one decision per approval request."* **The sources do not establish that semantic.**

and the ratification log repeats it: *"No approval-specific idempotency key, duplicate-request mechanism, HTTP retry contract, **one-decision-per-request UNIQUE constraint**, or pessimistic row locking."*

**What was recorded instead.** The ratified **substance is unchanged** — exactly one final decision, enforced by `UNIQUE (tenant_id, approval_request_id)`. Its characterisation is corrected to a **narrow amendment of D-15 clause 4**, made by the route D-15 itself provides in clause 14:

> 14. Any future requirement or architectural decision establishing **duplicate-decision prevention**, **one-decision-per-request semantics**, or **stronger approval concurrency guarantees** must be handled by an **explicit future decision/amendment**. **It must not be inferred from D-15.**

The register entry therefore states that this **is** that explicit amendment; that D-15 clause 4's *"the sources do not establish that semantic"* **remains true as a source finding**, this being an **architectural ratification and not a claim the SRS mandates it**; that **D-15 clauses 10 and 11** (duplicate/contradictory decision rows as unresolved architectural behaviour) are **superseded forward to exactly this extent**; and that **D-15 clauses 3, 5 and 9's C-3 prohibition are preserved** — no approval-specific idempotency key, no pessimistic locking, and no pending-status predicate is added.

**Why this mattered.** Recording the claim as written would have put a demonstrably false statement into the register and would have left item 5 resting on an inference D-15 clause 14 expressly forbids (*"It must not be inferred from D-15"*). The corrected form is both accurate and better-founded: D-15 anticipated this decision and specified how it must be made.

### 4.2 The IEEE-754 attribution is withdrawn

Both prior reports justified the minor-unit string convention by asserting that JSON numbers are IEEE-754 doubles. Per the user's binding instruction, **no such claim is made in the register**, and it is withdrawn here: **PostgreSQL `jsonb` stores numbers as `numeric`** (arbitrary precision), so the assertion was wrong as applied to `jsonb` storage. The binding rationale recorded is **application-layer numeric precision** — the accurate ground, since the hazard arises when large minor-unit integers round-trip through application JSON handling, not in the database.

### 4.3 A third item surfaced and was handled without amending governance

Item 8 adds a fourth conjunct to the decisions INSERT policy, while **D-15 clause 9** says *"Preserve D-9 exactly as currently amended by D-7 and D-10. **Do NOT** add the proposed **D-15 C-3 pending-status predicate**."* These are compatible and the entry says so precisely: D-15 clause 9's **general** preservation of D-9 is superseded forward **only** to the extent of item 8's conjunct, while its **specific** C-3 prohibition remains in force — **no pending-status predicate is added**. Conflating the two would have either blocked item 8 wrongly or silently voided a live prohibition.

---

## 5. VERIFICATION (§6 of the brief)

### 5.1 Mechanical

```
git diff --check                      → clean (exit 0)
git diff --numstat -- <register>      → 263    0    (263 insertions, 0 deletions)
git diff -U0 | grep '^-' | grep -v '^---' | wc -l   → 0   (real deleted lines)
git diff -U0 | grep -E '^\+## D-[0-9]' | wc -l      → 0   (new numbered-decision headings)
```

**Zero deletions is the proof that no historical text was rewritten.** Every prior finding — the SB status table of 2026-08-19, D-15's clauses 4/10/11, D-2's 2026-08-17 text, and all retained analysis — is byte-identical and superseded forward only.

### 5.2 Substantive — every check the brief required

| Check | Result | Evidence |
|---|---|---|
| **P-1 not changed** | ✅ | Binding text *"RATIFIED — P-1: `approval_decisions` SHALL REFERENCE `approval_requests` DIRECTLY"* present, unmodified (0 deletions); new entry states **"P-1 remains RATIFIED and UNCHANGED"** |
| **No `D-21+` created** | ✅ | 0 new `## D-nn` headings; entry declares *"no D-21 is created and the 20-decision tally is unchanged"* |
| **D-12 still BLOCKED** | ✅ | Stated in both the section and the log entry |
| **D-16 enumeration still OPEN** | ✅ | *"D-16's ENUMERATION remains OPEN"* and *"D-16 is NOT closed — only its Phase-1 constraint-form question is resolved"* |
| **Async `FR-SEC-032` still deferred** | ✅ | *"The asynchronous half of `FR-SEC-032` remains deferred and knowingly unmet"* |
| **No Governance HTTP surface authorised** | ✅ | *"D-14 A-1 remains unchanged — NO Governance HTTP/API surface"*; the PIN is carried on the consuming route |
| **No Governance read surface** | ✅ | *"D-20 remains unchanged — NO Governance read surface"* |
| **All eight items appear exactly once** | ✅ | Items 1–8 each matched exactly once in the new section |
| **Both binding clarifications present** | ✅ | *"base-10 integer strings of minor units"* ×1; *"It is NOT an Employee ID"* ×1 |
| **Historical text not rewritten** | ✅ | 0 real deletions; D-15 clause 4's original text confirmed still present |
| **Money-only `BIGINT` exclusion preserved** | ✅ | Stated in the Preservation block |
| **No implementation authorised** | ✅ | *"NO IMPLEMENTATION IS AUTHORISED BY THIS RATIFICATION"* |

### 5.3 Repository invariants

`git status --short`: only `docs/governance/GOVERNANCE_DECISION_REGISTER.md` and `docs/reports/claude/INDEX.md` modified, plus this report added. **No product code. No migration** (31, unchanged). **No test changes.** **HEAD `55e4ae8` unchanged. No commit. No push.** No destructive git command was used at any point.

---

## 6. WHAT THIS UNBLOCKS, AND WHAT REMAINS

The approval schema is now **fully typed and posture-complete**: `request_type` (item 1), `required_permission` (item 2), DELETE posture and FK action (item 3), `status`/`decision` allocation (item 4), decision cardinality (item 5), `value` (item 7) and the excluded-approver column (item 8). **A migration is writable for the first time** — but **is not authorised**: a runtime Design Gate must first settle the exact column name, FK shape, RLS predicate SQL, the Identity `contract/` shape for PIN verification, and the concurrency test matrix.

**P1G-1 remains blocked on a separate axis.** As the first gate found (§24 there), the **variance-tolerance / settings source** — not the approval mechanism — is P1G-1's nearest blocker: `FR-FIN-006` requires a *"configurable tolerance"* and `FR-PLT-025`/`026` hierarchical settings do not exist. That decision is independent of this one and can proceed in parallel.

---

## 7. RECOMMENDED NEXT STEP

**Approval runtime Design Gate** (analysis/design only), resolving the items §3 lists as undecided. The **variance-tolerance / settings governance decision** can run in parallel, as both are prerequisites for P1G-1 and neither depends on the other.

**No implementation is authorised by the ratification recorded here.**

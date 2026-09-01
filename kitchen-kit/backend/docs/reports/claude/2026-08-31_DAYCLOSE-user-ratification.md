# DAY CLOSE — Final User Ratification Record

| Field | Value |
|---|---|
| **Task / slice name** | DAY CLOSE — final user ratification record (DC-R1 / DC-R2 / DC-R3) |
| **Report type** | **Governance recording only.** Not a design task, not a review, not an implementation. No product code, no migration, no schema change, no route, no permission in source, no test, no OpenAPI change, no commit, no push, no deploy. |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. **The register entry written by this task — “Day Close Ratification — 2026-08-31” — is the binding record; this report is evidence of the recording action only.** Where this report and the register differ, **the register governs**. |
| **Date** | 2026-08-31 |
| **HEAD (verified before and after)** | `7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c` — *feat: add minimum operational reporting* |
| **Branch** | `feat/production-spec` |
| **Working tree** | Documentation-only drift throughout. **Zero** source / schema / migration / test / OpenAPI drift, before and after. 34 migrations, unchanged. |
| **Task identifier** | DAYCLOSE-user-ratification |
| **Status** | COMPLETE |
| **Governance IDs** | **`DC-R1`, `DC-R2`, `DC-R3`** — a **new `DC-R<n>` series**, verified unused before this entry |

---

## §0. VERDICT

> # **A. DAYCLOSE RATIFICATIONS RECORDED — IMPLEMENTATION GOVERNANCE-UNBLOCKED**

---

## §1. BASELINE — VERIFIED BEFORE AND AFTER

```
git rev-parse HEAD        -> 7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c   MATCH
git branch --show-current -> feat/production-spec                        MATCH
git log -3 --oneline      -> 7bc5d2c feat: add minimum operational reporting
                             38e007b feat: complete KDS operator lifecycle
                             121b889 feat: add cash session close
migrations                -> 34
```

`git status --short --untracked-files=all` returned **documentation-only** paths:
the modified `INDEX.md`, the four long-standing unrelated reports, the
POST-REPORTING rebase, and the four DayClose design reports.
**No product baseline difference. No STOP condition.**

---

## §2. THE USER'S RATIFICATION STATEMENT

> **Verbatim:** *"موافق، اعتمد DC-R1 وDC-R2 وDC-R3."*
> **Translation:** *"Agreed, ratify DC-R1, DC-R2 and DC-R3."*

All three decisions are therefore **USER-RATIFIED**. They are **not reopened**
by this task, and this report does not re-argue them.

---

## §3. ID SELECTION AND COLLISION CHECK

| Check | Result |
|---|---|
| `DC-R` anywhere in the register | **0 occurrences** — free |
| bare `DC-` prefix anywhere | **0 occurrences** — free |
| A new numbered `D-<n>` decision | **NOT created.** No `D-21`; the 20-decision tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN) |
| Series deliberately not continued | the cash **`R-1(a) … R-6`** (bare `R-<n>` collides with **D-20**'s own option labels `R-1 … R-7`), **`KDS-R1 … KDS-R12`** and **`RPT-R1 … RPT-R3`** (different domains) |

**Style followed:** an unnumbered `## <Title> — <date>` section carrying
independently identifiable limbs, placed immediately before
`## Final Decision Matrix`, plus one matching Final Decision Matrix bullet —
the exact convention of the **Fire Authorization**, **P1F-2**, **FIFO
Carry-Forward**, **Approval Runtime**, **P1G-1**, **R-6**, **KDS** and
**Minimum Operational Reporting** entries.

---

## §4. WHAT WAS RECORDED

### DC-R1 — Internal-MVP Day Close sequencing

The Internal-MVP operational Day Close **may be implemented now** — the
state-changing **Treasury** DayClose aggregate and its minimum persisted
Z/DayClose historical surface. Implemented: **`FR-FIN-020`**; **`FR-FIN-021`
in full**, both limbs, over every branch cash session with
`status <> 'closed'`, unqualified by business day; **`FR-FIN-023`**;
**`FR-FIN-024`** reused as already COMPLETE.

**Simultaneously and without qualification:**

| Requirement | Status recorded |
|---|---|
| **`FR-FIN-022`** | **PARTIAL** — **tax by rate** NOT IMPLEMENTED (only the `FR-FIN-032` component *sum* is persisted); **sales by category** NOT IMPLEMENTED (no `order_lines` snapshot; mutable, many-to-many master data); **comp** half structurally zero (the **void** half **is** implemented); **sales by tender** PARTIAL per RPT-R2 cl. 8 |
| **`FR-FIN-026`** | **PARTIAL — all four limbs unmet.** **Fiscal finalisation NOT IMPLEMENTED**; **inventory day-end snapshot** NOT IMPLEMENTED; **report pre-aggregation** NOT IMPLEMENTED and **excluded by RPT-R2**; **accounting export** NOT IMPLEMENTED (`FR-RPT-043` unchanged; **no `FR-PLT-041` outbox exists**) |
| **`FR-FIN-025` [S]** | **NOT IMPLEMENTED** |

**It is sequencing only** — **NOT a waiver**, **NOT a reinterpretation**,
**NOT a claim that `FR-FIN-020 … 026` are complete**, and **NOT a claim that
the Z report is fully compliant**. The register binds every artefact against
saying otherwise, and requires the Day Close **aggregate** to be distinguished
from Z-content **compliance** wherever either is described.

**On fiscal finalisation specifically:** the register records that an empty
document set is **never** to be described as *"satisfied"*, *"vacuously
satisfied"* or *"complete by absence"*. **CARRIED ITEM P1C-1 is untouched.**

### DC-R2 — Close-business-day variance ownership

Whole-session CashSession close facts, **above all the variance**, are owned
**exactly once** by the business day in which that session becomes `CLOSED`.
An immutable **`closedBusinessDay`** is derived at final close using the **same
authoritative resolver Sales already uses**, and is **never historically
re-derived** from the mutable timezone or cutover.

**Spanning-session consequence, recorded:** day-scoped tender **may contribute
to BOTH** `D` and `D+1`; the **whole-session variance is owned only by the
closing day**. The same CashSession **MAY** therefore be linked to **multiple**
DayClose snapshots, and an **unconditional `UNIQUE (tenant_id,
cash_session_id)` on the linkage is PROHIBITED**. Whole-session figures are
labelled `WHOLE_SESSION` and **never** emitted as day totals, so variance
**cannot double-count** across Z reports.

**Legacy attribution consequence, recorded:** sessions carrying
`closed_business_day IS NULL` **remain unknown honestly** — never backfilled,
never inferred historically, never silently assigned, never included in any
variance summary. **No speculative backfill is authorised.** Zero-payment and
movement-only sessions are reached by this rule for the first time; **RPT-R2
clause 9 is unchanged**.

### DC-R3 — Historical Z read authority

**`report.view.financial` is extended narrowly** to authorise
**`GET /branches/{branchId}/day-closes/{businessDay}`**.

- **NO new permission token is created** — `cash.day.read`, `cash.z.read`,
  `report.view.z`, `report.view.day_close` and any other new code are **NOT
  authorized**.
- **`POST` Day Close remains authorised by the source-decided
  `cash.day.close`** (SRS §15.2, *"Close the business day"*), which **MUST NOT**
  be used as historical-read authority — a write permission is not a
  read-history permission.
- **`report.view.sales` is not required and not extended.**
- The code **carries no branch scope**; the extension **must not be broadened**
  to any other financial route.

---

## §5. CONSISTENCY CHECK — NO CONTRADICTION FOUND

Searched the full register for `DC-R`, `DayClose`, `Day Close`, `day close`,
`cash.day.close`, `report.view.financial`, `RPT-R1`, `RPT-R2`, `FR-FIN-022`,
`FR-FIN-026`, `variance`, `CashSession`, `D-2`, `P1C-1`.

| Prior text | Relationship to DC-R1/R2/R3 |
|---|---|
| **`cash.day.close`** | **Zero occurrences** in the register. No conflict; it is source-decided by SRS §15.2 and is not created by this entry |
| **RPT-R2 clause 10** — *"`FR-FIN-020 … 026` remain NOT IMPLEMENTED … DayClose remains a separate slice with its own design gate"* | **No contradiction.** That was a status statement at the Reporting slice's HEAD and **explicitly anticipated** a separate DayClose slice with its own gate. DC-R1 **is** that gate's ratification, and it **preserves** `FR-FIN-022`/`FR-FIN-026` as PARTIAL rather than claiming completion |
| **RPT-R2 clause 9** — Cash Reconciliation PARTIAL; *"no business-day anchor exists … and none is invented"* | **No contradiction.** DC-R2 does not retro-fit an anchor onto the Reporting surface; it introduces `closedBusinessDay` **prospectively at close time** for the DayClose aggregate, and RPT-R2 clause 9's statement about the *Reporting* slice remains true of that slice |
| **RPT-R1 clause 3** — *"The route authorised by this limb is exactly `GET /reports/branches/{branchId}/daily-trading/{businessDay}` … **No other route is authorised by these codes**"* | **THE ONE PLACE REQUIRING EXPLICIT TREATMENT.** DC-R3 is the **explicit, user-ratified scope extension** of exactly this clause, by **exactly one additional route and nothing else**. It is recorded **as an extension in the register text itself**, never as a silent supersession. Every other RPT-R1 clause — including clause 6's NOT-authorized list and clause 8 as applied to **every other** code — **stands unchanged** |
| **D-2** | **Unchanged, IN FORCE.** `FR-SEC-002`/`003`/`004` remain NOT IMPLEMENTED; the DC-R3 code carries no branch scope |
| **CARRIED ITEM P1C-1** | **Untouched.** DC-R1 records fiscal finalisation as NOT IMPLEMENTED rather than reopening the exclusion |
| **D-20** | **Unchanged.** Its record of Appendix C's absence is the same absence DC-R3 relies on, and no Governance read surface is created |

> ### **No prior ratified entry contradicts DC-R1, DC-R2 or DC-R3.**
> The single scope interaction — **RPT-R1 clause 3** — is handled by **explicit
> user-ratified extension recorded in the register**, not by silent
> supersession. **No STOP condition arose.**

---

## §6. ACTIVATION MECHANIC — RECORDED AS CONSEQUENCE ONLY

Recorded in the register's **consequence notes**, explicitly **NOT `DC-R4`**:

- the first Day Close command for a branch **may create the immutable
  activation epoch and return `outcome = ACTIVATED`**;
- **that transaction COMMITS successfully** and **does not throw and rely on
  rollback persistence**;
- **`activationBusinessDay` itself is NEVER closeable**;
- **`firstEligibleBusinessDay = activationBusinessDay + 1`**;
- a target day is closeable only when
  **`activationBusinessDay < targetBusinessDay < branchCurrentBusinessDay`**;
- **historical Z is NEVER retroactively manufactured** for pre-activation
  dates — retrieval returns **persisted records only**, and a day with no
  persisted Day Close is a **404**;
- **legacy closed sessions with unknown close-business-day attribution are
  never silently assigned.**

---

## §7. CONCURRENCY — RECORDED AS IMPLEMENTATION CONSEQUENCE ONLY

Order creation and Day Close share the **existing**
`ros_order_number(branchId, businessDay)` serialization fence. Order creation
checks Treasury's public Day Close state **after** acquiring that fence and
**before** its `INSERT`; Day Close acquires the **same** fence before its final
close checks. This prevents a pre-cutover in-flight Order from committing into a
business day after that day has been closed.

**SERIALIZABLE is NOT claimed to solve this race**, and **advisory-lock
mechanics are NOT ratified as business policy** — the register records them only
so the constraint is not lost.

---

## §8. WHAT WAS AND WAS NOT AUTHORISED

| | |
|---|---|
| **Migration authorised by this recording task** | **NONE.** Migration count unchanged at **34**; the conceptual migration 35 remains conceptual |
| **Schema authorised** | **NONE.** `prisma/schema.prisma` untouched |
| **Product code / routes / permissions in source** | **NONE.** No `*.permissions.ts` change; `cash.day.close` is **not** seeded and `report.view.financial` gains **no** new `PermissionDef` — the row already exists, keyed by `code`; DC-R3 changes only which routes require it |
| **Tests / OpenAPI** | **NONE** |
| **New numbered decision** | **NONE.** No `D-21`; tally unchanged |
| **`FR-SEC-010` role seeding** | **NOT authorized** — no role row, `role_permission` row, or role semantic created or modified |

**Register diff, verified:** **401 insertions, 0 deletions**, two contiguous
additive hunks (the new unnumbered section placed before `## Final Decision
Matrix`, plus one matching matrix bullet). **Zero `## D-` headings added.**
**Nothing was modified, superseded silently, or deleted; all historical text is
preserved verbatim.**

---

## §9. FILES TOUCHED

| File | Change |
|---|---|
| `docs/governance/GOVERNANCE_DECISION_REGISTER.md` | **+401 / −0**, purely additive |
| `docs/reports/claude/2026-08-31_DAYCLOSE-user-ratification.md` | created (this report) |
| `docs/reports/claude/INDEX.md` | **exactly one** appended row |

**All four prior DayClose design reports are preserved byte-unmodified.** No
product code, schema, migration, test or OpenAPI file was touched. **Nothing was
staged or committed.**

---

## §10. IMPLEMENTATION AUTHORIZATION STATUS

> # **DAY CLOSE IS GOVERNANCE-UNBLOCKED FOR IMPLEMENTATION.**

Downstream implementation may consume, in supersession order:

1. `2026-08-31_DAYCLOSE-final-design-gate.md`
2. `2026-08-31_DAYCLOSE-design-gate-acceptance-correction.md`
3. `2026-08-31_DAYCLOSE-pre-ratification-final-correction.md`
4. `2026-08-31_DAYCLOSE-activation-mechanic-final-correction.md`
5. the **“Day Close Ratification — 2026-08-31”** register entry (**DC-R1 /
   DC-R2 / DC-R3**) — **binding**

— each later correction governing the earlier where they differ, and the
register governing all of them.

**No further user ratification is required unless current source disproves a
ratified assumption** — in which case the implementation task must **STOP and
report**, not proceed. **A separate, explicitly authorised implementation task
is still required**; this recording authorises none.

---

## §11. VERDICT

> # **A. DAYCLOSE RATIFICATIONS RECORDED — IMPLEMENTATION GOVERNANCE-UNBLOCKED**
>
> **Not B** — the full consistency scan found no contradicting ratified entry;
> the single scope interaction (RPT-R1 clause 3) is an explicit recorded
> extension.
> **Not C** — HEAD, branch and migration count were identical before and after.
> **Not D** — the `DC-R<n>` series was verified unused, and the entry follows
> the register's established unnumbered-limb format exactly.

---

*This report is non-authoritative evidence. The SRS and the ratified governance
decisions remain authoritative; **the register entry is the binding record and
this report is evidence of the recording action only.** All prior DayClose
design and correction reports are preserved unmodified; this task performs
governance recording only and supersedes none of them.*

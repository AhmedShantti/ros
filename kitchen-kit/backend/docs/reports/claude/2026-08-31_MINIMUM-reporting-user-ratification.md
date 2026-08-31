# MINIMUM OPERATIONAL REPORTING — Final User Ratification Record

| Field | Value |
|---|---|
| **Task / slice name** | MINIMUM OPERATIONAL REPORTING — branch daily-trading read surface (final user ratification record) |
| **Report type** | **Governance recording only.** No implementation, no migration, no schema, no route, no permission code in source, no test, no OpenAPI regeneration, no commit. |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the **ratified** entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the only authorities. **The binding record of these three ratifications is the register entry** *"Minimum Operational Reporting Ratification — 2026-08-31"*, **not this report**. This report describes what was recorded and where; where it and the register differ, **the register governs**. |
| **Ratification input** | The user's explicit governance statement, verbatim: **«موافق، اعتمد القرارات 1 و2 و3.»** — *"Agreed, ratify decisions 1, 2 and 3."* |
| **Decisions ratified** | The three tabled in `2026-08-31_MINIMUM-reporting-design-gate-acceptance-correction.md` §18 |
| **Evidence base** | `docs/reports/claude/2026-08-31_MINIMUM-reporting-final-design-gate.md` and `docs/reports/claude/2026-08-31_MINIMUM-reporting-design-gate-acceptance-correction.md` — **the acceptance correction supersedes the original gate wherever they differ.** Both preserved unmodified. |
| **Date** | 2026-08-31 |
| **HEAD** | `38e007b0cd285679fc7fd334aec54d3bf2a8006c` — *feat: complete KDS operator lifecycle* (**verified unchanged**) |
| **Branch** | `feat/production-spec` |
| **Working tree** | Documentation + governance only. **Zero source / schema / test / migration / OpenAPI drift**, verified before and after recording. |
| **Task identifier** | MINIMUM-reporting-user-ratification |
| **Status** | COMPLETE |
| **Migrations** | 34 — unchanged. **No migration created, modified or authorised.** |
| **Tests** | **No test suite executed in this session** and **no test file modified.** This task performs governance recording only. |

---

## §0. VERDICT

> # **A. REPORTING RATIFICATIONS RECORDED — IMPLEMENTATION GOVERNANCE-UNBLOCKED**
>
> Three limbs recorded — **RPT-R1**, **RPT-R2**, **RPT-R3** — as one unnumbered
> ratified register entry in the established forward-supersession style.
> **No D-21 is created; the 20-decision tally is unchanged.**
>
> **Conflict scan: CLEAN.** No prior ratified entry contradicts any of the
> three. **No prior text was modified, superseded silently, or deleted** —
> the register diff is **451 insertions, 0 deletions**.
>
> **Minimum Operational Reporting is GOVERNANCE-UNBLOCKED for implementation.**

---

## §1. VERIFIED BASELINE

Commands executed **first**, in this session:

```
git status --short
git rev-parse HEAD
git branch --show-current
git log -8 --oneline
```

| Expectation | Observed | Verdict |
|---|---|---|
| HEAD `38e007b0cd285679fc7fd334aec54d3bf2a8006c` | identical | PASS |
| Subject *feat: complete KDS operator lifecycle* | identical | PASS |
| Branch `feat/production-spec` | identical | PASS |
| Dirty state documentation-only | `M INDEX.md` + untracked reports under `docs/reports/claude/` only | PASS |
| **No source / schema / test / migration / OpenAPI drift** | `git status --short` returns nothing outside `docs/reports/claude/` | PASS |
| Migration count 34 | `ls -d prisma/migrations/*/ \| wc -l` → **34** | PASS |

**Governance was NOT recorded against an unknown baseline.** Verdict C is not
returned.

---

## §2. GOVERNANCE IDS ASSIGNED

> ### **`RPT-R1` · `RPT-R2` · `RPT-R3`**

| Property | Value |
|---|---|
| **Register entry** | `## Minimum Operational Reporting Ratification — 2026-08-31` |
| **Location** | Appended **immediately before** `## Final Decision Matrix`, exactly where the Fire Authorization, P1F-2, FIFO, Approval Runtime, P1G-1, R-6 and KDS entries sit |
| **Form** | **Unnumbered ratified entry with three independently identifiable limbs** — the P1A / P1C / P1D / Fire / P1F-2 / FIFO / Approval-Runtime / P1G-1 / R-6 / KDS convention |
| **Numbered decisions created** | **NONE.** No `D-21`. The tally stays **17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN**. |
| **Series** | A **new `RPT-R<n>` series**, verified **unused** anywhere in the 7,126-line register before this entry (`grep` for `RPT` returned nothing) |

### Why a new series, and why not the existing ones

| Series | Not continued because |
|---|---|
| **`R-<n>`** (cash: `R-1(a) … R-6`) | A different domain — **and** the bare `R-<n>` labels collide with **D-20's own option labels `R-1 … R-7`**. `R-7` is *"Defer to Appendix C"*, sitting in **precisely this subject area** — permission-catalogue source silence — where the record must be least ambiguous. **KDS-R11 refused to reuse `R-7` for the same reason**; this entry follows that precedent exactly. |
| **`KDS-R<n>`** (`KDS-R1 … KDS-R12`) | A different domain (Kitchen). Continuing it would misattribute Reporting decisions to the KDS track. |
| **`D-<n>`** | The KDS entry established that new ratifications create **no numbered decision**; this entry preserves that. |

**No new numbering scheme was invented** — `RPT-R<n>` is the same
`<SLICE-PREFIX>-R<n>` shape the register already uses for `KDS-R<n>`.

---

## §3. RATIFIED DECISION 1 — REPORT PERMISSIONS (`RPT-R1`)

### The exact permission codes

| Code | Description |
|---|---|
| **`report.view.sales`** | **"View sales reports"** |
| **`report.view.financial`** | **"View financial reports"** |

### Semantics

> **BOTH are required together — `mode: 'all'` (AND), never OR.**

A principal holding only one is refused. The mechanism is the **existing**
`@RequirePermission(...)` default (`mode: 'all'`) evaluated by
`PermissionGuard` as `codes.every(...)`. **No new authorization capability is
invented.**

### The route authorised

```
GET /reports/branches/{branchId}/daily-trading/{businessDay}
```

One branch, one business day, dashboard-only, read-only. **No other route is
authorised by these codes.**

### Rationale, recorded

- SRS **§15.2** supplies the **template** `report.view.<category>`.
- SRS **§19.3** supplies the **categories** — *Sales* and *Financial* among
  them.
- **Appendix C**, which §15.2 designates as the authoritative full catalogue,
  is **absent from the delivered SRS**.
- The composite response **spans both categories**: *Sales Summary* and
  *Sales by Tender* are §19.3 **Sales** reports; *Cash Reconciliation* and
  *Tax Summary* are §19.3 **Financial** reports.
- The repository already recorded the gap **in code**:
  `treasury.controller.ts` lists the X report as *"authorization NOT
  SOURCE-DECIDABLE (no `cash.x_report`, **`report.view.<category>`
  unenumerated**)"*.

### Position in the zero-invented-codes discipline

These are the **FOURTH and FIFTH explicit user-authorized exceptions**, after
`pos.order.fire` (2026-08-24), `pos.payment.capture` (CARRIED ITEM P1D-F) and
`kds.operate` (KDS-R11). **The discipline itself is unchanged and remains in
force for every other code.**

**Recorded honestly, in both directions:** unlike those three, §15.2 supplies
the **pattern** and §19.3 the **category vocabulary**, so only the concrete
instantiation is user-ratified. That is a **materially weaker** form of
invention — and it is still an exception, and is recorded as one.

### Branch scope

> **The permissions carry NO branch scope** and must never be relied on for
> it — directly parallel to **KDS-R11 §6**. See §7.

### NOT authorized

`report.export` · `report.view.daily_trading` (**`daily_trading` is not a
§19.3 category**) · `report.view.inventory` · `report.view.kitchen` ·
`report.view.workforce` · `report.view.governance` · **any other
`report.view.*` code**.

**No existing permission is broadened.** `pos.order.create`,
`inventory.view`, `inventory.cost.view`, `settings.branch.read` and every
`cash.*` code keep their exact pre-ratification scope, and none is repurposed
as a report-read authority.

### ADR 0008 D-01 remapping consequence — recorded

**Should Appendix C ever be supplied and name these category tokens
differently, the concrete codes may be remapped per ADR 0008 D-01** — the same
documented remap procedure the Organisation (`settings.tenant.read`,
`settings.branch.read`) and Catalogue (`menu.item.read`, `menu.price.read`,
`menu.availability.read`) codes already carry.

**Recording that route does NOT make this ratification provisional.**

---

## §4. FUTURE ROLE INTENT — RECORDED ONLY

> **`FR-SEC-010` standard-role seeding is NOT authorized. No role row, no
> `role_permission` row, and no role semantic is created or modified by this
> task or by the ratification it records.**

| Role (§15.3) | Both codes? | Basis |
|---|---|---|
| **Owner** | intended | *"All permissions"* |
| **Operations Director** | intended | *"All operational, no user or billing management"* |
| **Branch Manager** | intended | *"Full branch operations, approvals within band"* |
| **Accountant** | intended | *"Financial read and export, no operational write"* |
| **Auditor** | intended | *"Read-only everything including audit log"* |
| **Brand Manager** | **OPEN — NOT resolved** | *"Menu, pricing, reports; no financial approval"* — an approval restriction is not self-evidently a read restriction |
| **Shift Supervisor** | **OPEN — NOT resolved** | §15.3 is silent on reports |
| **Cashier · Waiter · Kitchen Staff · Head Chef · Storekeeper** | **NOT granted** | none is a reporting role — **unless a future ratified role-seeding decision explicitly says otherwise** |

The two OPEN rows are **deliberately not resolved by this task**. They remain
future role-seeding questions, and no role-seeding mechanism is being built.

---

## §5. RATIFIED DECISION 2 — INTERNAL-MVP REPORTING SEQUENCING (`RPT-R2`)

### What is authorised

> The Internal-MVP operational **daily-trading read surface** is authorised to
> be implemented **NOW**, using **query-time aggregation over the
> transactional primary**.

### The four requirements that remain unmet — recorded explicitly

| Requirement | Pri | Status |
|---|---|---|
| **`FR-RPT-001`** — analytical queries against a **read replica**, never the transactional primary | `[M]` | **NOT IMPLEMENTED** |
| **`FR-RPT-002`** — pre-aggregated hourly / daily / weekly / monthly rollups | `[M]` | **NOT IMPLEMENTED** |
| **`FR-RPT-003`** — incrementally updated, fully rebuildable rollups | `[M]` | **NOT IMPLEMENTED** |
| **`FR-RPT-005`** — Type-2 slowly-changing dimensions | `[M]` | **NOT IMPLEMENTED** |

> **This is NOT a waiver. NOT a reinterpretation. NOT a claim of completion.**
> All four remain **open, unmet `[M]` requirements**, exactly as `FR-SEC-032`
> is already recorded as knowingly unmet under **D-2**.
>
> **No artefact may claim otherwise** — no report, register entry, INDEX row,
> code comment, OpenAPI description or commit message produced by this slice
> may state or imply *"waived"* or *"complete"* for any of the four.

### NOT authorised by this limb

**Read replica** · **star schema** · any **`fact_*`** table · any **`dim_*`**
table · **Type-2 dimensions** · **rollup persistence** · **report cache** ·
**export pipeline** · **analytics warehouse**.

The reporting module owns **zero tables and zero migrations**.

### Other requirement statuses recorded by this limb

| Item | Status |
|---|---|
| **`FR-RPT-004`** | **MAY be implemented in full** by this slice |
| **`FR-RPT-042`** (drill-down) | **NOT IMPLEMENTED** |
| **`FR-RPT-043` / `FR-RPT-044`** (export + export audit) | **NOT IMPLEMENTED**; no export route, no `report.export` code |
| **`FR-RPT-030 … 034` · `040`/`041` · `045`/`046` · `047`** | **NOT IMPLEMENTED** |
| **`FR-FIN-010`** | **PARTIAL.** Per-day totals for the **two implemented tenders** may be added. ***"Each card scheme"* UNSATISFIED** — `card_scheme` is optional, unvalidated, cashier-typed free text and no integrated terminal exists (`FR-POS-064` NOT IMPLEMENTED). **The nine unimplemented tender families remain UNSATISFIED.** |
| **§19.3 *Cash Reconciliation*** | **PARTIAL** — payment-contributing sessions only · **WHOLE_SESSION** close facts · **zero-payment / movement-only session attribution NOT IMPLEMENTED** (no business-day anchor exists on `cash_sessions`, `shifts`, `cash_movements` or `cash_session_close_attempts`, and **none is invented**) · **NO day-level variance total** |
| **`FR-FIN-020 … 026`** (DayClose · X report · Z report) | **NOT IMPLEMENTED.** This slice **does NOT provide `FR-FIN-021`'s blocking-session list.** |
| **`FR-AUD-008`** | **Knowingly unsatisfied gap, unchanged** — **D-20 clause 9** stands |
| **Audit on ordinary report `GET`** | **NONE.** `FR-AUD-001` binds state-changing operations; `FR-AUD-006` names *"data exports"*, and this slice performs none; `FR-AUD-007` binds **audit-log** access (**D-20 clause 8** CONDITIONAL, stands) |

### Not reopened

**D-2** · **D-20** · **KDS-R11** · **KDS-R12** · **CARRIED ITEM P1C-1**
(Receipt / fiscal exclusion).

---

## §6. RATIFIED DECISION 3 — AVERAGE ORDER VALUE (`RPT-R3`)

### The formula

```
averageOrderValue = netSales ÷ completedOrderCount
                    HALF_UP to minor units   (BR-FIN-001, exact integer arithmetic)
                    null  when completedOrderCount = 0
```

`netSales` is the already-source-decided figure
`Gross − Discounts − Refunds − Tax` (**`FR-CST-003` `[M]`**, verbatim).

> **`FR-CST-003` is an SRS finding, not a ratification.** It is cited only to
> fix the numerator's meaning; this entry does not ratify, restate or alter it.

`null` — not `"0"` — at a zero count: an average of nothing is undefined, and
`"0"` would read as *"the average order was worth nothing"*.

### Rationale, recorded

The SRS names Average Order Value in **five** places — `FR-FIN-022`'s Z report,
§19.3 *Sales by Employee*, §19.3 *Average Order Value Trend*, the §12.1
employee-metric list and the §18.x customer-profile list — and **defines a
formula in none of them**. Repository source is likewise silent.

> **The NET basis is a USER-RATIFIED choice resolving source silence, not an
> SRS finding.** It is *compatible with, but not mandated by*, §13's consistent
> use of Net Sales as the canonical revenue denominator
> (`Food Cost % = COGS ÷ Net Sales`; `Prime Cost % ÷ Net Sales`;
> `Sales per Labour Hour = Net Sales ÷ Hours Worked`) and `FR-CST-035`'s ledger
> line *"= Net Sales (excl. tax)"*.

### NOT authorized

**Food Cost %** · **Prime Cost %** · **gross-margin %** ·
**contribution margin** · **items per order** · **upsell rate** ·
**basket-size decomposition** · **any other derived KPI**.

**`FR-CST-003` is NOT claimed** by this slice, and **no COGS figure is
exposed** — doing so would silently widen **`inventory.cost.view`**.

---

## §7. BRANCH FAIL-CLOSED MECHANICS — IMPLEMENTATION CONSEQUENCE, NOT A RATIFICATION

> **No fourth ratification was created.**

Recorded in the register as a **consequence note** — a binding constraint on
implementation, not a business decision — exactly as **KDS-R11**'s
station-authorization consequence note was recorded (*"engineering
mechanics"*). It **grants nothing, lifts nothing and relaxes nothing**, and is
strictly **more** restrictive than every existing read route in the
repository:

- the route requires an **explicit `branchId`** path parameter — no
  optional-filter form exists;
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
  deactivated concurrently cannot yield a report assembled under a shape the
  posture refuses.

### D-2 — UNCHANGED

> **`D-2`'s branch-scoped RBAC deferral is UNCHANGED and is NOT reopened.**

The assertion reads a **tenant-shape** fact (`org.branches.status`), **never a
principal's scope**. It does not consult `identity.membership_roles.branch_id`,
does not populate `TenantContext.branchId`, and does not make `PermissionGuard`
branch-aware.

> **`FR-SEC-002` / `FR-SEC-003` / `FR-SEC-004` remain NOT IMPLEMENTED.**
> **No principal branch-aware RBAC is introduced.**

**Disclosed product consequence, recorded:** a tenant with **more than one
active branch receives 403 on this route entirely**. That is the correct
posture for an Internal MVP whose permitted carve-out is explicitly *"one
branch operationally"*, and the refusal disappears when D-2 is lifted.

---

## §8. ACCEPTED ENGINEERING CONSEQUENCES — DELIBERATELY NOT RATIFIED

Recorded in the register as accepted design consequences, **not** as
governance decisions, because none is a discretionary choice for project
governance:

thin **reporting module owning zero tables** · **`RepeatableRead`** composite
snapshot · **`transaction_timestamp()`** as `dataAsOf` · **future
`businessDay` ⇒ 400** · **historical transaction-currency selection**
(immutable order/payment currency snapshots preferred over the mutable
`org.branches.base_currency`) · **orders-first indexed joins** · **zero
migration** · **no day-level variance total** · **WHOLE_SESSION**
cash-reconciliation scope · **tax by class only, no tax-by-rate** · **zero
`KNOWN_DEVIATIONS` growth** · **no business audit on an ordinary `GET`**.

Exact table/column names, route URLs, DTO field names, SQL shapes, index
decisions and error-code choices remain **implementation details, NOT ratified
here**.

---

## §9. CONSISTENCY CHECK — CLEAN

Every term the brief required was searched across the full register.

| Term | Occurrences | Finding |
|---|---|---|
| **`report.view`** | **1** (D-20 §1a) | A **verbatim quotation of §15.2's catalogue table** as evidence. **Not** a ratified position on any concrete token. **No contradiction.** |
| **`report.export`** | 9 | All are **quoted §15.2 / `FR-AUD-008` evidence** inside D-20 and D-19. **`RPT-R1` explicitly does NOT create `report.export`**, and `FR-AUD-008` remains unsatisfied (**D-20 clause 9**). **Consistent.** |
| **`Reporting`** | 5 | §5.2.4-style domain mentions and FR-CST reporting-surface deferrals. **None is a ratified Reporting decision.** **No contradiction.** |
| **`FR-RPT-001` / `002` / `003` / `005`** | **0** | **No prior ratified entry mentions any FR-RPT requirement.** `RPT-R2` is the first, and it records them as **NOT IMPLEMENTED**. **No contradiction.** |
| **`AOV` / `average order`** | **0** | **No prior entry addresses Average Order Value.** **No contradiction.** |
| **`D-2`** | many | Defer of `FR-SEC-002/003/004` in force, reconfirmed by the KDS entry at this HEAD. `RPT-R1` states the codes carry **no branch scope**; §7 introduces **no** principal branch-aware RBAC. **Consistent.** |
| **`D-20`** | many | Ratified **MINIMAL / no new Governance read surface**, permission-code decision **deferred, not invented**. Its own stated Question scopes it to *"reading/listing **approval requests and decisions**"* — a surface **D-14 A-1 removed**, so deferral cost nothing. **Reporting has the opposite posture** (an executable, permission-guarded surface is required), which is **precisely the distinction KDS-R11 already adjudicated and recorded**. **D-20 is not reopened, contradicted or amended; `R-1 … R-7` remain options that were NOT introduced, and `R-7` is not reused.** |
| **`KDS-R11`** | 4 | Established the precedent applied here: a user-authorized code where source silence meets an `[M]`-required executable surface, plus the fail-closed *"exactly one … zero ⇒ denied · more than one ⇒ denied"* consequence-note pattern. **`kds.operate` is not broadened; KDS-R11 is not amended.** |
| **`Appendix C`** | 13 | Uniformly recorded as **absent**, with **ADR 0008 D-01** as the remap route. `RPT-R1` clause 10 records the same route. **Consistent.** |
| **`RPT` / `RPT-R`** | **0 before this entry** | **No id collision.** |

> ### **CONFLICT SCAN RESULT: CLEAN — no prior ratified entry contradicts
> RPT-R1, RPT-R2 or RPT-R3.** Verdict B is not returned.
>
> **Nothing was silently superseded.** The register diff is **451 insertions,
> 0 deletions**, in **two contiguous additive hunks**. All historical text is
> preserved verbatim.

---

## §10. FILES CHANGED

| File | Change |
|---|---|
| `docs/governance/GOVERNANCE_DECISION_REGISTER.md` | **+451 / −0.** New section `## Minimum Operational Reporting Ratification — 2026-08-31` inserted before `## Final Decision Matrix`, plus one summary bullet appended to the Final Decision Matrix notes after the KDS bullet. **No existing line modified or deleted.** |
| `docs/reports/claude/2026-08-31_MINIMUM-reporting-user-ratification.md` | **Created** — this report. |
| `docs/reports/claude/INDEX.md` | **Exactly ONE row appended.** |

### Not touched — verified

- **No source file.** No `src/**` change of any kind.
- **No `prisma/schema.prisma`.** No migration created or modified — **34,
  unchanged**.
- **No permission code added to code.** `report.view.sales` and
  `report.view.financial` exist **only as ratified governance text**; no
  `<module>.permissions.ts` was created or edited.
- **No route, no controller, no module.**
- **No test file.**
- **No OpenAPI regeneration.**
- **Previous design reports NOT modified** — the final design gate (2,350
  lines) and the acceptance correction (1,402 lines) are byte-unchanged.
- **Nothing staged. Nothing committed. Nothing pushed. No destructive git
  operation.**

---

## §11. IMPLEMENTATION AUTHORIZATION STATUS

> # **MINIMUM OPERATIONAL REPORTING IS GOVERNANCE-UNBLOCKED FOR IMPLEMENTATION.**

The design track has **no outstanding `USER RATIFICATION REQUIRED` item**.

**Downstream implementation may consume:**

1. the **acceptance-corrected design gate** —
   `2026-08-31_MINIMUM-reporting-design-gate-acceptance-correction.md`,
   which **supersedes** `2026-08-31_MINIMUM-reporting-final-design-gate.md`
   wherever they differ; and
2. the **three ratified limbs** `RPT-R1`, `RPT-R2`, `RPT-R3`, whose binding
   text is the register entry.

**No additional user ratification is required** — unless current source
disproves a ratified assumption, in which case the implementation task **must
STOP and report**, not proceed around it.

### What is still NOT authorised

> **This entry authorises NO implementation.** A separate, explicitly
> authorised implementation task is required before any product code,
> migration, schema change, permission seeding, route, test, or OpenAPI
> change.

The implementation, when authorised, is bound by the acceptance correction's
**§16 corrected Definition of Done** (4 amended + 6 added criteria) and its
**§17 corrected test design**, including: clean scratch database with the full
suite green before acceptance; migration count **34**; **zero
`KNOWN_DEVIATIONS` growth**; and `EXPLAIN` evidence showing **no sequential
scan on `sales.order_payments`**.

---

## §12. VERDICT

> # **A. REPORTING RATIFICATIONS RECORDED — IMPLEMENTATION GOVERNANCE-UNBLOCKED**

**Not B** — the conflict scan across `report.view`, `report.export`,
`Reporting`, `FR-RPT-001/002/003/005`, `AOV`/`average order`, `D-2`, `D-20`,
`KDS-R11` and `Appendix C` found **no contradiction**, and nothing was
silently superseded.

**Not C** — HEAD, branch, working tree and migration count were verified
unchanged before and after recording.

**Not D** — the register's existing format was followed exactly: an unnumbered
ratified entry with named limbs, placed where every comparable entry sits, with
a matching Final Decision Matrix bullet; a new `RPT-R<n>` series was opened on
the `KDS-R<n>` model after confirming no collision and after refusing `R-7` for
the same documented reason KDS-R11 refused it. **No new numbering scheme was
invented and no numbered decision was created.**

**Next step:** an explicitly authorised implementation task, bound by the
acceptance-corrected gate and these three ratified limbs.

---

*End of ratification record. The binding governance text is
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` §"Minimum Operational
Reporting Ratification — 2026-08-31". Both prior design reports are preserved
unmodified.*

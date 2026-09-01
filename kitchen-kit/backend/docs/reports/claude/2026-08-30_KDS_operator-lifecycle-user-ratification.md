# KDS MVP Operator Lifecycle — User Ratification Recording

| Field | Value |
|---|---|
| **Task / slice** | KDS MVP Operator Lifecycle — final user ratification record |
| **Report type** | Governance recording — RECORDING ONLY |
| **Authority statement** | **This report is NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the only authorities. **The binding record of the two decisions is the register entry itself**, not this report; where they differ, the register governs. |
| **Date** | 2026-08-30 |
| **HEAD (verified)** | `121b889b23a20167ea47574d601ec115350addaa` — `feat: add cash session close` |
| **Branch** | `feat/production-spec` |
| **Baseline check** | HEAD matches the expected `121b889`. `git status --short -- src prisma test package.json` returned **empty** — **no source, schema, migration or test drift**. Working tree is documentation-only. |
| **Migrations at HEAD** | 34 (unchanged) |
| **Tests** | None executed — governance recording task. |
| **Governance IDs assigned** | **KDS-R11** (permission) · **KDS-R12** (domain event) |
| **Register section** | `## KDS MVP Operator Lifecycle Ratification — 2026-08-30` |
| **Task identifier** | KDS-RATIFICATION-2026-08-30 |

---

## §1. BASELINE VERIFICATION

```
$ git rev-parse HEAD        121b889b23a20167ea47574d601ec115350addaa
$ git branch --show-current feat/production-spec
$ git log -8 --oneline
121b889 feat: add cash session close          ← HEAD, as expected
0f10afe feat: add cash close policy substrate
1f9ea1f feat: add governance approval runtime
55e4ae8 feat: add mid-shift treasury cash movements
bfe7e69 feat: complete P1F-2 atomic order completion
9aa7a88 feat: provision signed demo country pack
18a155f docs: finalize P1F-2 completion design gates
cf04e00 docs: record Payment checkpoint verification
```

Working tree before this task: `M docs/reports/claude/INDEX.md` plus six untracked
report files — **all documentation**. A targeted `git status --short` over `src`,
`prisma`, `test` and `package.json` returned nothing.

> **Baseline accepted. Governance is recorded against a known, unchanged baseline.**

---

## §2. CONVENTION RESEARCH AND IDENTIFIER SELECTION

### 2.1 Precedents read

| Precedent | Register location | What it established |
|---|---|---|
| **Fire Authorization Ratification — 2026-08-24** | `## Fire Authorization Ratification — 2026-08-24` | The template for an unnumbered permission ratification: `> RECORDED … by explicit user governance action` blockquote · `### The question` · `### Ratified` · `### Binding constraints on implementation` · `### Preservation`. Introduced **`pos.order.fire`**. |
| **CARRIED ITEM P1D-F** | inside the P1D carried-items section | Introduced **`pos.payment.capture`** as *"a new code created by explicit user authorisation"* — and the rule that a permission is **seeded only where an executable consumer exists**. |
| **D-20** | `## D-20 — Permission for Reading Approval Requests` | The Appendix-C-absent posture, resolved by **DEFERRING, not inventing** — and its internal option labels **R-1 … R-7**, explicitly *"NOT introduced"*. |
| **P1G-1 Cash-Close Policy Ratification** | `## P1G-1 Cash-Close Policy Ratification — 2026-08-30` | Independently identifiable limbs **R-1(a) … R-5** under one named parent section. |
| **R-6** | `## R-6 — Cash Variance Approval Rejection Recovery — RATIFIED 2026-08-30` | The most recent entry; confirms limbs may carry their own section and continue a series. |
| **Approval Runtime Minimum Resolution** | `## Approval Runtime Minimum Resolution — 2026-08-29` | The running summary-bullet convention in the tail index list. |

The register's structure is **two-level**, and both levels were used:
1. a **body section** placed chronologically, ending just before `## Final Decision Matrix`;
2. a **summary bullet** appended to the running ratification list that ends immediately before *"**6 decisions remain fully unratified**"*.

### 2.2 Why the identifiers are `KDS-R11` / `KDS-R12`

The prompt permitted either two identifiers or one decision with two limbs, requiring only that
the substance stay independently identifiable. The register's own convention — a **named parent
section carrying independently identified limbs** — was followed. Identifier selection was
constrained by two verified collisions:

- **`KDS-R1 … KDS-R10` are already taken** by the P1E-2 KDS routing design closure. This is not
  merely a report-local label: **`KDS-R9` is cited in `prisma/schema.prisma`**'s
  `StationRoutingRule` docblock (*"`priority` is retained physically with NO assigned semantics
  (P1E-2 §D, KDS-R9)"*). Reusing any of them would corrupt a live code reference.
- **`R-7` is already taken** as a **D-20 option label** — *"Defer to Appendix C"* — and D-20's
  subject is **permission-catalogue source silence**, which is *precisely* KDS-R11's subject.
  Reusing `R-7` would produce an ambiguous record exactly where clarity matters most.

> **Therefore the established `KDS-R<n>` series is continued at `KDS-R11` and `KDS-R12`.** The
> cash series `R-1(a) … R-6` is not continued, since these decisions are not cash decisions.

**No new register format was invented.** No existing decision was renumbered.

---

## §3. CONSISTENCY / CONFLICT CHECK — PERFORMED BEFORE SAVING

Searched the register for every term the task required:

| Term | Occurrences before this entry | Conflict? |
|---|---|---|
| `ticket.bumped` | **0** | **None** |
| `ticket.recalled` | **0** | **None** — nothing to contradict |
| `recall` | **0** | **None** |
| `kds` / `KDS` | **1** — line 6114, citing `FR-KDS-025` (*"default 30 minutes"*) as an example of a requirement that **does** supply its default | **None — supportive.** It corroborates the design track's treatment of `recall_window_seconds` |
| `Appendix C` | 9, all within D-20 and its option table | **None — D-20 is not reopened.** See below |
| `pos.order.fire` | 6, in the Fire Authorization Ratification | **None — precedent, followed** |
| `pos.payment.capture` | 4, in CARRIED ITEM P1D-F | **None — precedent, followed** |
| `permission` | many | Checked: no existing ratification forbids a new code; the discipline's own text admits explicitly ratified exceptions |

### 3.1 The one apparent tension, resolved explicitly

**D-20** ratified *"permission-code decision **DEFERRED, not invented**"*. KDS-R11 invents a code.
**This is not a contradiction**, and the register entry says so in its own words:

- D-20's deferral concerned **`governance.approval.read`** — a read code for a Governance HTTP
  surface that **D-14 A-1 had already removed**. With no route to guard, deferral cost nothing and
  was the minimal answer.
- **KDS has the opposite posture.** `FR-KDS-024` `[M]` and `FR-KDS-025` `[M]` require an
  executable operator surface, `ACT-09` assigns it to Kitchen Staff, and repository convention
  guards every route. **Deferral is not available**, so the register's *other* established remedy
  for exactly this posture applies — an explicitly user-authorized code, as for `pos.order.fire`
  and `pos.payment.capture`.
- **D-20 is not reopened, amended, or reinterpreted**, and its `R-1 … R-7` option labels remain
  what they always were: options that were **NOT introduced**.

Also verified as unaffected: **D-2**'s branch-scoped RBAC deferral (station scope is a
terminal-binding fact under `FR-SEC-021`/`FR-SEC-028`, not a new RBAC tier), the **P1E-2**
`KDS-R1 … KDS-R10` routing decisions, the **P1E-4/P1E-5** Ticket-lifecycle and Kitchen-ownership
decisions, **§5.5.4**'s `ticket.bumped` publisher/subscriber row, **§5.2.3** module boundaries,
and **R-1(a) … R-6**.

> **No conflict exists. Nothing was silently overwritten or superseded.**

---

## §4. EXACTLY WHAT WAS RECORDED

### 4.1 KDS-R11 — the `kds.operate` permission

- **New code `kds.operate`**, description **"Operate a kitchen display station"**.
- **Authorized surface:** station queue read · first-viewed acknowledgement · item start ·
  bump item · bump all · ticket recall.
- **Third explicit user-authorized exception** to the zero-invented-codes discipline, after
  `pos.order.fire` and `pos.payment.capture`. The discipline itself remains in force for
  every other code.
- **Coarse grain deliberate.** **NOT authorized and MUST NOT be created:** `kds.view`,
  `kds.ticket.view`, `kds.ticket.start`, `kds.ticket.bump`, `kds.ticket.recall`,
  `kds.ticket.serve`, `kds.expedite`.
- **Reads sit behind `kds.operate`** — the existing `pos.order.create` operational-read precedent.
- **`kds.operate` does NOT represent station authorization.** Recorded as a *binding constraint
  on implementation* (engineering mechanics, not a separate business decision): active registered
  **KDS-type** terminal required · **exactly one** operative station binding · zero ⇒ denied ·
  more than one ⇒ denied as unsupported/misconfigured · supplied `stationId` must equal the
  terminal-derived station · a POS or dashboard surface cannot operate KDS merely by holding the
  code.
- **Code-driven, not migration-driven** — `<MODULE>_PERMISSION_DEFS` + `PermissionsService
  .upsertMany`, seeded only by the slice that creates the routes.
- **ADR 0008 D-01 remap route** recorded should Appendix C ever surface and name the capability
  differently. This does not make the ratification provisional.

### 4.2 KDS-R12 — the `ticket.recalled` domain event

- **New internal domain event `ticket.recalled`. Publisher: Kitchen Ops. Principal subscriber:
  Sales.**
- Recorded as an **EXTENSION of SRS §5.5.4 "Event Catalogue (Core Subset)"**. **The register
  states plainly that the SRS does NOT define it**, and makes no claim otherwise.
- **Semantics:** Sales consumes it **inside the same UnitOfWork transaction**; reverts exactly the
  affected order lines **`ready → fired`**; **clears `ready_at`**; **MUST NOT regress lines already
  `served`, `voided` or `comped`**.
- **Module ownership preserved** — no direct cross-module table query authorized in either
  direction; communication stays on published contracts and domain events per §5.2.3.
- **No schema change authorized** — `sales.order_lines.state` and `.ready_at` already exist.
- **`ticket.bumped` is unchanged** in publisher and subscribers.

### 4.3 Future standard-role intent — RECORDED, NOT IMPLEMENTED

`kds.operate` is intended for **Kitchen Staff · Head Chef · Branch Manager · Shift Supervisor ·
Owner**, and **no other** standard role. **Auditor explicitly excluded** — the code carries write
authority and Auditor is read-only.

> **This does NOT authorize FR-SEC-010 standard-role seeding. No existing role row and no existing
> role semantic is modified by this task.** Consistent with the Fire Authorization Ratification's
> finding that **ROS has no system-defined "standard role" persistence mechanism**, the mapping is
> a **policy for whoever administers a tenant's equivalent roles** — not a migration, not a
> hardcoded seed. It is recorded now solely so a future role-seeding slice need not rediscover it.

---

## §5. WHAT WAS DELIBERATELY NOT RATIFIED

Per §§7–8 of the task, neither of the following was turned into a governance decision, and the
register entry says so explicitly:

- **SERIALIZABLE isolation + bounded whole-UoW retry (max 3, serialization/deadlock failures only,
  exhaustion surfaces conflict, readiness recomputed after retry).** This is an **engineering
  correctness mechanism**, not a business or governance choice. It introduces **no
  `SELECT FOR UPDATE`, no new advisory lock, no reliance on `AuditService`'s tenant-wide advisory
  lock, no `sales.orders.version` coupling, and no migration** — so **§24.6.4's confinement of
  pessimistic locking is untouched**.
- **The first-viewed `TICKET_VIEWED` audit entry.** **FR-AUD-001 `[M]` already decides it**: a
  persisted acknowledgement is a state-changing operation and is therefore audited — one entry per
  newly-first-viewed Ticket, affected lines as metadata, and a zero-row replay writing no entry.
  This is **requirement compliance, not a discretionary governance choice**.

Also expressly not authorized: any schema, migration, table, column, index, route URL, DTO, audit
action literal or event payload field — all remain implementation details. And still **DEFERRED**:
`served`/Expediter (FR-KDS-013 `[S]`), sorting beyond FIFO, colour thresholds, FR-KDS-041/042
analytics, the post-fire `order.line.voided` path, offline KDS (NFR-REL-002), peer discovery
(NFR-REL-003), the FR-SEC-026 8-hour KDS session TTL, and standard-role seeding implementation.

---

## §6. FILES CHANGED BY THIS TASK

| File | Change |
|---|---|
| `docs/governance/GOVERNANCE_DECISION_REGISTER.md` | **+299 lines, −0.** One new body section (`## KDS MVP Operator Lifecycle Ratification — 2026-08-30`, placed chronologically after R-6 and before `## Final Decision Matrix`) and one summary bullet appended to the running ratification list. **`git diff` shows zero removed lines** — no existing content was rewritten, reformatted, or renumbered. |
| `docs/reports/claude/2026-08-30_KDS_operator-lifecycle-user-ratification.md` | This report (new). |
| `docs/reports/claude/INDEX.md` | Exactly **one** appended row. |

**No prior KDS report was modified.** The design gate and its acceptance correction are untouched.

### Explicit negative statements

> **No product code was changed.** No file under `src/` was created, modified, or deleted.
> **No migration or schema change is authorized by this ratification**, and none was made —
> `prisma/` is untouched and the migration count remains 34.
> No route, no permission code in code, no test, no OpenAPI regeneration, no commit, no push,
> no deploy, and no destructive git operation.

---

## §7. IMPLEMENTATION AUTHORIZATION STATUS

> # KDS MVP Operator Lifecycle is **GOVERNANCE-UNBLOCKED** for implementation.

This governance task **authorizes the downstream implementation to consume KDS-R11 and KDS-R12**;
it does **not** implement them. A separate, explicitly authorised implementation task is required
before any product code, migration, permission seeding, test, or OpenAPI change.

**Expected downstream scope** — the accepted DoD from the corrected gate:
`kds.operate` · KDS controller/routes · active KDS-terminal enforcement · exactly-one-station
enforcement · station queue · first-viewed + `TICKET_VIEWED` audit · optional start · bump item ·
bump all · SERIALIZABLE + bounded retry · `ticket.bumped` runtime event · Sales multi-station
readiness · recall · `ticket.recalled` · Sales recall reversion · audit · idempotency · OpenAPI ·
concurrency and authorization tests.

**Still deferred:** served / Expediter · sorting beyond FIFO · colour thresholds · FR-KDS-041/042
analytics · post-fire cancellation path · offline KDS · peer discovery · KDS 8-hour session TTL ·
standard-role seeding implementation.

---

## §8. VERDICT

> # **A — KDS RATIFICATIONS RECORDED — IMPLEMENTATION GOVERNANCE-UNBLOCKED**

- **Not B** — the conflict check across `kds`, `kitchen`, `ticket.bumped`, `ticket.recalled`,
  `permission`, `Appendix C`, `pos.order.fire`, `pos.payment.capture` and `recall` found **no
  contradiction**; the one apparent tension (D-20) is resolved explicitly in the register text
  without reopening or amending D-20.
- **Not C** — HEAD re-verified as `121b889` with no source, schema, migration or test drift.
- **Not D** — the register's existing structure and identifier conventions accommodated both
  decisions; `KDS-R11`/`KDS-R12` continue an established series and avoid two verified collisions.

# DAY CLOSE — Final Design & Governance Gate

| Field | Value |
|---|---|
| **Task / slice name** | DAY CLOSE (`FR-FIN-020 … 026`) — final implementation-writable design + governance gate |
| **Report type** | Analysis / design / governance gate. **No implementation.** No migration, no schema change, no route, no permission, no governance edit, no OpenAPI regeneration, no commit, no push, no deploy. |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report records what was verified **in this session** against the repository at the HEAD below. It ratifies nothing and creates no scope. Where it disagrees with an earlier report — including my own `2026-08-31_POST-REPORTING` rebase — **current source is the reason**, and every such disagreement is stated explicitly in §2.4. |
| **Date** | 2026-08-31 |
| **HEAD** | `7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c` — *feat: add minimum operational reporting* |
| **Parent** | `38e007b0cd285679fc7fd334aec54d3bf2a8006c` — *feat: complete KDS operator lifecycle* |
| **Branch** | `feat/production-spec` |
| **Working tree** | Dirty **only** in `docs/reports/claude/`: modified `INDEX.md` + five untracked pre-existing reports. **Zero** source / schema / migration / test / OpenAPI drift. |
| **Task identifier** | DAYCLOSE-final-design-gate |
| **Status** | COMPLETE |
| **Migrations** | 34 — unchanged. None created. Migrations are **specified conceptually only** (§27). |
| **Tests** | **No test suite executed in this session.** Test files cited as structural evidence only; no prior run's results restated as newly executed. |

---

## §0. VERDICT

> # **B. DAYCLOSE READY AFTER NARROW USER RATIFICATION**
>
> **Three genuine decisions (§29). Nothing else is put to the user.**
>
> **DC-R1** — Internal-MVP sequencing: build the operational DayClose now while
> **`FR-FIN-022` and `FR-FIN-026` remain explicitly PARTIAL**. *(Not a waiver.)*
> **DC-R2** — Which DayClose owns a **spanning** CashSession's whole-session
> variance — genuinely source-silent business semantics.
> **DC-R3** — The **historical Z read authority**. `cash.day.close` is a WRITE
> code and the repository has already **refused** that exact reinterpretation
> once; `report.view.financial` is a deliberately narrow RPT-R1 code that
> **must not be broadened**. Source cannot decide this.
>
> **Not A** — three real decisions remain.
> **Not C** — no Z-data persistence prerequisite blocks an *operational* DayClose;
> the unavailable limbs are honestly classifiable as PARTIAL (§8, §9).
> **Not D** — Receipt/fiscal independence is **proven**, not asserted (§11).
> **Not E** — the Internal-MVP branch posture is sufficient and leaves D-2 untouched (§16).
> **Not F** — every remaining semantic gap is isolated into DC-R2, not left unresolved.
> **Not G** — baseline matched exactly.

---

## §1. BASELINE VERIFICATION

```
git rev-parse HEAD    -> 7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c   MATCH
git rev-parse HEAD^   -> 38e007b0cd285679fc7fd334aec54d3bf2a8006c   MATCH
git log -2 --oneline  -> 7bc5d2c feat: add minimum operational reporting
                         38e007b feat: complete KDS operator lifecycle   MATCH
git branch --show-current -> feat/production-spec                   MATCH
```

`git status --short --untracked-files=all` returned exactly:

```
 M docs/reports/claude/INDEX.md
?? docs/reports/claude/2026-08-26_MVP_current-state-and-next-slice.md
?? docs/reports/claude/2026-08-27_RENDER_empty-db-demo-provisioning-check.md
?? docs/reports/claude/2026-08-28_P1G1_cash-close-design-gate.md
?? docs/reports/claude/2026-08-28_POST-P1F2_MVP_next-slice-rebase.md
?? docs/reports/claude/2026-08-31_POST-REPORTING_MVP-rebase-and-next-slice.md
```

**Nothing outside `docs/reports/claude/`.** Migrations: **34**. OpenAPI: **110
paths**. **BASELINE READY.**

---

## §2. AUTHORITY, AND FOUR CORRECTIONS TO THE POST-REPORTING REBASE

### 2.1 Read this session

- **SRS** — glossary (*Business Day*, *Z Report*), §5.2/§5.4, **§5.5.1/§5.5.2/§5.5.3
  (Transactional Outbox)**/§5.5.4, §7.3 (#28, #29), §15.2 (Cash family), **§16.5
  `FR-FIN-020…026`**, §19.3, §24.6.4, §25.1, §26.5.
- **Governance register** — RPT-R1 (all 10 clauses + binding constraints), RPT-R2
  (all 13 clauses), RPT-R3, the branch fail-closed consequence note, the two
  *"Not decided by this entry"* lists, CARRIED ITEM P1C-1, D-2, D-20.
- **Repository at `7bc5d2c`** — Prisma schema, 34 migrations, approved
  `ROS_DrawDB_Compatible_v3.sql`, generated OpenAPI, and every source path cited.
- `2026-08-31_POST-REPORTING_MVP-rebase-and-next-slice.md` — **NON-AUTHORITATIVE**.

### 2.2 The register's own instruction

**RPT-R2 clause 10**, verbatim: *"`FR-FIN-020 … 026` remain NOT IMPLEMENTED.
DayClose, the Z report and the X report are untouched, and this slice does NOT
provide `FR-FIN-021`'s blocking-session list — that requires every open session
of the branch, which a payment-derived session set cannot see. **DayClose remains
a separate slice with its own design gate.**"*

This gate is that gate. **DayClose is not excluded by any ratified decision.**

### 2.3 Correction 1 — **SERIALIZABLE has precedent. My prior claim was false.**

The POST-REPORTING rebase §15 stated *"zero repository precedent (verified)"* for
SERIALIZABLE and recommended an advisory lock. **That is wrong**, and the
consequence is not cosmetic — it changes the recommended concurrency model (§14).

Verified this session:

| Evidence | Location |
|---|---|
| `const KDS_SERIALIZABLE_RETRY = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxAttempts: 3 }` | `kitchen/tickets/kds-operations.service.ts:40-43` |
| Used on **three** KDS mutation paths | `:257`, `:343`, `:416` |
| A **generic, deliberately non-Kitchen-specific** bounded whole-UoW retry primitive | `common/domain-events/serialization-retry.ts` — *"This module is deliberately generic (not Kitchen-specific)"* |
| First-class `UnitOfWork` support | `common/domain-events/unit-of-work.ts:43-46` (`UnitOfWorkRetryOptions`), `:158` (`maxAttempts` default 3), `:191-193`, `:196-208` (retry loop, fresh event collector per attempt, stable `correlationId` across attempts) |
| Three empirically-discovered serialization-failure shapes (`P2034`, raw SQLSTATE `40001`/`40P01`, unwrapped `DriverAdapterError`) | `serialization-retry.ts:51-82` |
| A deliberate **write-skew guard test** proving READ COMMITTED is insufficient | `test/kds-concurrency.e2e-spec.ts:347` (`D0 [GUARD]`), `:421` |

**The mechanism is generic, accepted, tested, and available to DayClose with no
new infrastructure and no `KNOWN_DEVIATIONS` growth.**

### 2.4 Corrections 2–4

| Prior claim (POST-REPORTING) | **Correction, source-backed** |
|---|---|
| §7 recommended `session_summaries` **+ `UNIQUE (tenant_id, cash_session_id)`** | **REJECTED — §5.** That constraint silently forbids a legitimate relationship: a CashSession provably spans business days (the accepted Reporting slice emits `businessDayCount`/`spansMultipleBusinessDays` *because* it occurs). The uniqueness is only safe under a rule that assigns each session to exactly one DayClose — and **which** DayClose is genuinely source-silent (**DC-R2**) |
| §6.L classified *sales by category* as "no aggregate exists" (implying derivable) | **UPGRADED to NOT HONESTLY DERIVABLE — §8.6.** `sales.order_lines` carries **no category snapshot**; `MenuItem` deliberately has **no `category_id`**; placement is the **many-to-many** `catalogue.menu_item_placements` (`@@unique([tenantId, menuItemId, categoryId])`). Aggregating by category would (a) join a **sealed immutable Z** to **mutable current master data**, violating BR-POS-004's snapshot discipline and the exact restatement hazard `FR-RPT-005` exists to prevent, and (b) be **ambiguous** for an item placed in two categories |
| §15 proposed `pg_advisory_xact_lock` as the primary serializer | **DEMOTED — §14/§15.** An advisory lock on `(branch, businessDay)` does **not** protect the *blocking-session read* (a concurrent `INSERT` into `treasury.cash_sessions` is a different key space). PostgreSQL **SSI predicate locks do** |

---

## §3. SOURCE REQUIREMENTS — EXACT TEXT AND PER-REQUIREMENT CLASSIFICATION

Extracted verbatim from `ROS_SRS_v1.0.pdf` §16.5 this session. **Not merged.**

### `FR-FIN-020` [M]
> *"The System SHALL support a business-day close operation per branch."*

**SOURCE-DECIDED · CURRENTLY IMPLEMENTABLE · REQUIRES NEW PERSISTENCE.**
Scope unit = **branch**. Nothing else is stated; everything about *how* is gate
mechanics.

### `FR-FIN-021` [M]
> *"Day close SHALL be blocked while any cash session remains open, and SHALL list the blocking sessions."*

**SOURCE-DECIDED · CURRENTLY IMPLEMENTABLE · NO NEW PERSISTENCE.** See §4 — this
is fully satisfiable at this HEAD from `treasury.cash_sessions` alone.

### `FR-FIN-022` [M]
> *"Day close SHALL produce a Z report containing: gross sales, discounts, refunds, net sales, tax by rate, sales by category, sales by tender, sales by order type, transaction count, average order value, void and comp summary, cash reconciliation, and variance summary."*

**PARTIALLY SOURCE-DECIDED · CAN REMAIN INTERNAL-MVP PARTIAL · REQUIRES USER
RATIFICATION (DC-R1).** Field-by-field in §8. **Three limbs are not honestly
producible at this HEAD** (tax by rate, sales by category, comp half of
void-and-comp); one is source-silent (variance summary → **DC-R2**).

### `FR-FIN-023` [M]
> *"Z reports SHALL be sequentially numbered per branch, immutable, and retrievable for any historical date."*

**PARTIALLY SOURCE-DECIDED · REQUIRES NEW PERSISTENCE.** *Sequential per branch*
and *immutable* are SOURCE-DECIDED and implementable (§12, §13). *Retrievable*
is SOURCE-DECIDED as an obligation, but its **read authority is SOURCE-SILENT →
DC-R3** (§25).

### `FR-FIN-024` [M]
> *"The System SHALL support a configurable business-day boundary per branch (e.g. 04:00), so that late-night trading is attributed to the correct operating day."*

**SOURCE-DECIDED · ALREADY IMPLEMENTED — COMPLETE.**
`org.operating_hours.business_day_cutover TIME DEFAULT '00:00:00'`
(`schema.prisma:768`), consumed by `sales/orders/business-day.ts`
(`cutoverLookup` / `resolveBusinessDay`), used by **both** `OrdersService`
(`orders.service.ts:224`) and Sales' `currentBusinessDay` contract. DayClose
**reuses this single implementation** and introduces no second algorithm.

### `FR-FIN-025` [S]
> *"Day close SHALL be performable automatically at the configured boundary where the branch enables it, with any open sessions force-closed and flagged."*

**SOURCE-SILENT on mechanism · CAN REMAIN INTERNAL-MVP PARTIAL — DEFER (§24).**
`[S]`, not `[M]`. Requires a scheduler (recorded as a separately deferred
capability — D-12 is *"BLOCKED on … a scheduler"*), a per-branch enablement flag
(no such column), and force-close-and-flag semantics no ratified rule defines.

### `FR-FIN-026` [M]
> *"Day close SHALL trigger: fiscal document finalisation, inventory day-end snapshot, report pre-aggregation, and accounting export generation where configured."*

**PARTIALLY SOURCE-DECIDED · CAN REMAIN INTERNAL-MVP PARTIAL · REQUIRES USER
RATIFICATION (DC-R1).** Full limb-by-limb audit in §11.

### `cash.day.close`
> SRS §15.2, **Cash** family: *"`cash.day.close` — Close the business day"*.

**SOURCE-DECIDED.** Already named in `treasury.permissions.ts` among codes
*"deliberately NOT seeded … Each is seeded by the slice that implements it."*
**No user ratification. It is a WRITE authority and is NOT repurposed as a read
authority (§25).**

### `day.closed`
> SRS §5.5.4: **`day.closed` · Publisher: Treasury · Principal Subscribers: Analytics, Fiscal, Reporting.**

**SOURCE-DECIDED** as to name, publisher and intended subscribers.
**SOURCE-SILENT** as to payload — gate mechanics (§19).

---

## §4. FIRST CRITICAL CORRECTION — `FR-FIN-021` NEEDS **NO** SESSION→DAY ATTRIBUTION

### The text, read without addition

> *"Day close SHALL be blocked while **any** cash session remains open, and SHALL list the blocking sessions."*

There is **no business-day qualifier**, and none is added here. Corroborated
independently by **SRS §7.3 #29**, whose DayClose *Key Invariant* column reads
**"All sessions closed before day close"** — equally unqualified. The scope unit
is the **branch**, from `FR-FIN-020`.

### The exact blocker set — CONFIRMED

```
treasury.cash_sessions
WHERE tenant_id = :tenant
  AND branch_id = :branch
  AND status <> 'closed'          -- i.e. status IN ('open', 'closing')
```

**`closing` MUST block.** It is the P1G-1 frozen state between an above-tolerance
immutable count declaration and its manager decision
(`schema.prisma:2230-2241`). It is **not** closed and its variance is declared
but **unapproved**. Treating it as non-blocking would let a day seal over an
unresolved cash variance — the precise accountability failure `FR-FIN-006` exists
to prevent, and it would contradict §7.3 #29's *"All sessions closed"*.

### Coverage proof

| Case | Covered? | Why |
|---|---|---|
| **Zero-payment session** | ✅ | It is a row in `cash_sessions` with `status='open'`. No payment is consulted |
| **Movement-only session** (pay-in/pay-out/safe-drop, no sale) | ✅ | Same — `cash_movements` is never consulted |
| **Session spanning multiple business days** | ✅ | Irrelevant to the predicate: only `status` matters |
| **Session opened long before the target day** | ✅ | No temporal predicate exists |
| **Session opened *after* the target day** | ✅ | Also blocks — and correctly so, per the unqualified text |

### Index support

`CashSession` already carries **`@@index([tenantId, branchId, status])`**
(`schema.prisma:2360`) — the exact predicate. **No new index is required for the
blocker check.**

### Reporting's set must NOT be reused

`DAILY_CASH_RECONCILIATION_QUERY` receives its session ids from Sales'
`contributingCashSessionIds` — *payment-derived*. Its own contract docblock and
**RPT-R2 clause 10** both say so. It **structurally cannot see** a zero-payment
or movement-only session. **It is not used for `FR-FIN-021`.** Treasury owns
`cash_sessions` (§25.1) and queries its own table directly — no cross-module
contract is needed at all.

> ## **CONFIRMED: session→businessDay attribution is NOT REQUIRED for the `FR-FIN-021` blocker check.**
> `FR-FIN-021` is **fully satisfiable at this HEAD with no new persistence and no
> new index.** Both limbs — the block *and* the list — are met.

---

## §5. SECOND CRITICAL CORRECTION — SESSION→BUSINESS-DAY ATTRIBUTION RE-AUDITED

**The POST-REPORTING recommendation (`session_summaries` + `UNIQUE (tenant_id,
cash_session_id)`) is NOT accepted.** Re-audit below.

### 5.1 What the attribution is actually for

| Purpose | Needs attribution? | Evidence |
|---|---|---|
| **A. `FR-FIN-021` blocking** | **NO** | §4 — settled globally at branch level |
| **B. Z cash reconciliation / variance history** | **YES** | `FR-FIN-022` names both as Z content |
| **C. Historical retrieval** | **YES** | `FR-FIN-023` — a sealed Z must still explain *which* sessions it covered, years later, with no join to mutable state |
| **D. Session summary snapshot** | **YES** | SRS §7.3 #29 makes `SessionSummaries` a **contained entity** of the DayClose aggregate |

So attribution is a **Z-content and historical-record** concern, **not** a
blocking concern. That narrows it decisively.

### 5.2 The falsifying fact

**A CashSession may legitimately contain payments from MORE THAN ONE business
day.** This is not hypothetical — the accepted Reporting slice emits
`businessDayCount` and `spansMultipleBusinessDays` *precisely because it occurs*,
and its acceptance correction **removed** a day-level variance total to stop such
a session double-counting into two days.

**Therefore the global rule "one CashSession → one business day" is FALSE**, and
any model that hard-codes it at the database level is wrong.

### 5.3 Option evaluation

For each: *what does "belongs to this Z" mean · spanning behaviour · duplication
of whole-session variance / opening float / movement totals · can a session appear
in two Z reports · day-scoped allocation vs historical linkage · what is immutable
· what is unique.*

#### OPTION A — `cash_sessions.business_day` stamped at **session open**

- *Belongs* = "was opened on this day". **Spanning:** misattributes — a session
  opened 22:00 on D that trades past the 04:00 boundary contributes money to D+1
  while being stamped D. **Duplication:** none, but **loss** instead (D+1's Z
  never sees it). **Two Z reports:** impossible. **Immutable:** yes.
  **Unique:** one day per session.
- **Migration hazard:** a `NOT NULL` column needs a value for pre-existing rows;
  the P1G-1 migration-compatibility closure recorded **real pre-existing `open`
  and `closed` sessions in the dev database**, and there is **no honest value**
  for them. It also amends the **accepted** P1D-1 open path, which R-3(a)
  deliberately declined to touch.
- ❌ **REJECTED on correctness.**

#### OPTION B — `cash_sessions.business_day` stamped at **close**

- *Belongs* = "was closed on this day". **Spanning:** the whole session's money
  lands on the closing day; the earlier day's Z under-reports. **Two Z reports:**
  impossible. Same backfill hazard as A. **Simpler than A, still lossy.**
- ❌ **REJECTED on correctness** (it answers *"which day sealed it"*, then
  pretends that is *"which day earned it"*).

#### OPTION C — `session_summaries (day_close_id, cash_session_id)`, a session **MAY** appear in multiple DayCloses

- *Belongs* = "this Z's snapshot **listed** this session". **Spanning:** the
  session appears in **both** days' summaries — which is *truthful as linkage*.
  **Duplication:** whole-session variance / opening float / movement totals
  **WOULD be duplicated** if any consumer sums them across days.
  **Two Z reports:** **YES, by design.** **Unique:** `(day_close_id,
  cash_session_id)` only. **Immutable:** yes.
- ⚠️ **Viable — but only if the Z never SUMS whole-session facts**, and only once
  DC-R2 answers whose variance total owns a spanning session.

#### OPTION D — immutable child `(tenant, cash_session_id, business_day)`

- *Belongs* = "this session touched this day". Many-to-many, so spanning is
  represented **exactly**. **But:** nothing in source defines how to *populate*
  it for a zero-payment session (it touched no day observably), and it duplicates
  what `order_payments.business_day` already proves for payment-bearing sessions.
  It invents a table the approved SQL does not define.
- ❌ **REJECTED as unnecessary invention.**

#### OPTION E — attribute a session **only to the business day on which it closes**

- *Belongs* = "closed on this day". **Spanning:** exactly one owner —
  **eliminates duplication of whole-session facts by construction**. **Two Z
  reports:** **NO.** **Unique:** one DayClose per session. **Immutable:** yes.
- ⚠️ **Strong candidate** — but "the day on which it closes" is *itself* derived
  from `closedAt`, which needs the mutable-timezone derivation the POST-REPORTING
  rebase already disproved. **Unless** it is re-expressed as *"the DayClose that
  first sealed it"*, which needs no timestamp at all.

#### **OPTION F (RECOMMENDED) — a two-layer split: LINKAGE (Option C) + OWNERSHIP (Option E, expressed without timestamps)**

The two questions have been conflated. They are separate:

| Layer | Question | Model | Uniqueness |
|---|---|---|---|
| **Linkage** — historical record | *"Which sessions did this Z's snapshot list?"* | `session_summaries (tenant_id, day_close_id, cash_session_id)` **+ per-session day-scoped figures snapshotted at close** | **`UNIQUE (tenant_id, day_close_id, cash_session_id)`** — one row per session **per DayClose**. A spanning session legitimately appears in two |
| **Ownership** — variance attribution | *"Which single Z owns this session's WHOLE-SESSION variance?"* | one nullable/boolean discriminator on the linkage row (e.g. *"this DayClose is this session's variance owner"*) | **partial `UNIQUE (tenant_id, cash_session_id) WHERE <owner flag>`** — at most **one** owning DayClose per session |

**Why this is correct:**

- It **never forbids** the legitimate spanning relationship (the fatal flaw of
  the POST-REPORTING proposal).
- It **never duplicates** whole-session variance into two variance totals,
  because ownership is exclusive.
- Day-scoped tender figures (which *are* day-attributable, from
  `order_payments.business_day`) are snapshotted per row — **no derivation from a
  mutable timezone anywhere**.
- Both constraints are ordinary PostgreSQL; the partial-unique form is already
  precedented in this repository (`cash_sessions`' one-open-session-per-drawer
  partial unique index).
- It uses the approved SQL's own table.

> ### **The rule that decides ownership is NOT in the SRS.** §16.5 never says
> which day owns a spanning session's variance. **That is DC-R2 — a genuine
> business-semantics decision, and this gate does not invent it (§22).**

### 5.4 The forbidden constraint, stated explicitly

> ## **`UNIQUE (tenant_id, cash_session_id)` — UNCONDITIONAL — IS FORBIDDEN.**
> It silently forbids a legitimate spanning-session relationship. Only the
> **partial** form, gated on the ownership discriminator, is permitted, and only
> once **DC-R2** defines who the owner is.

---

## §6. APPROVED SQL AUDIT

Exact definitions (`ROS_DrawDB_Compatible_v3.sql:1118-1137`):

```sql
CREATE TABLE treasury.day_closes (
    id           UUID PRIMARY KEY,
    branch_id    UUID NOT NULL REFERENCES org.branches(id),
    business_day DATE NOT NULL,
    closed_by    UUID NOT NULL REFERENCES identity.users(id),
    closed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_day_close UNIQUE (branch_id, business_day)
);
CREATE TABLE treasury.session_summaries (
    id              UUID PRIMARY KEY,
    day_close_id    UUID NOT NULL REFERENCES treasury.day_closes(id) ON DELETE CASCADE,
    cash_session_id UUID NOT NULL REFERENCES treasury.cash_sessions(id)
);
CREATE TABLE treasury.variance_reports (
    id             UUID PRIMARY KEY,
    day_close_id   UUID NOT NULL REFERENCES treasury.day_closes(id) ON DELETE CASCADE,
    total_variance BIGINT NOT NULL
);
```

**The approved SQL is NOT assumed correct. Audit:**

| Aspect | Finding | Verdict |
|---|---|---|
| **`tenant_id`** | **ABSENT on all three tables** | ❌ **CONFLICT.** `FR-PLT-010` mandates RLS on `tenant_id`; every Treasury table in this repository carries it (`cash_sessions`, `cash_movements`, `cash_close_policies`, `cash_session_close_attempts`). **Must be added** — the identical correction the repo already applied to every Treasury table |
| **`branch_id`** | present | ✅ but must become an **ADR 0008 D-09 composite FK** `(tenant_id, branch_id) → org.branches(tenant_id, id)`, as every Treasury table does |
| **`business_day`** | `DATE NOT NULL` | ✅ correct, and matches `sales.orders.business_day`'s type exactly |
| **Primary keys** | bare `id UUID` | ✅ acceptable; repo convention adds `@@unique([tenantId, id])` as the tenant-safe FK target |
| **Uniqueness** | `UNIQUE (branch_id, business_day)` | ⚠️ **must become `UNIQUE (tenant_id, branch_id, business_day)`**. Without `tenant_id` the constraint is *stricter than intended* only because `branch_id` happens to be globally unique — relying on that is exactly the weakness ADR 0008 D-09 forbids |
| **Immutability** | **NOT EXPRESSED** — no grant model, no CHECK | ❌ **CONFLICT with `FR-FIN-023`.** Must add the repo's append-only pattern (§12) |
| **Session relation** | `session_summaries` has **no uniqueness at all** | ❌ **CONFLICT.** Permits unbounded duplicate `(day_close_id, cash_session_id)` rows. Needs §5.3 Option F's two constraints |
| **Z number** | **ABSENT — no column** | ❌ **CONFLICT with `FR-FIN-023` [M]** *"sequentially numbered per branch"*. Must be added (§13) |
| **Summary columns** | `session_summaries` carries **no summary data whatsoever** — only two FKs | ❌ **CONFLICT.** It is named *summaries* but summarises nothing. A sealed Z must explain itself with no join to live tables (the `cash_session_close_attempts` precedent, whose eight FR-FIN-004 terms are CHECK-bound onto the row itself) |
| **Z content** | **ABSENT entirely** | ❌ **CONFLICT with `FR-FIN-022`.** No gross sales, tender, tax, count or AOV column exists anywhere |
| **RLS suitability** | impossible without `tenant_id` | ❌ see above |
| **FKs** | `closed_by → identity.users(id)` | ✅ **correct as-is** — untenanted global FK, the exact precedent of `cash_movements.performed_by` / `cash_close_policies.created_by` / `stock_movements.performed_by` |
| **Cross-module references** | `org.branches`, `identity.users` only | ✅ both already precedented from `treasury` |
| **Can it represent spanning sessions?** | **YES** — nothing forbids one `cash_session_id` appearing under two `day_close_id`s | ✅ **and this is the reason the POST-REPORTING `UNIQUE (tenant, cash_session_id)` proposal was wrong**: the approved SQL never asserted it |
| **Does it duplicate whole-session facts across days?** | It would, if a consumer summed `variance_reports.total_variance` naively | ⚠️ resolved by §5.3 Option F's exclusive ownership |
| **`variance_reports` shape** | one FK + one `BIGINT`, 1:1 with `day_closes` | ⚠️ **A one-column child table 1:1 with its parent does not earn a table.** Recommend folding `total_variance` onto the DayClose row (mechanics, §27) — but see DC-R2 first, since the *definition* precedes the *placement* |
| **SRS §25.1 compliance** | all three in `treasury` | ✅ |

> ### **CONCLUSION: the approved SQL is DIRECTIONALLY CORRECT and TABLE-NAME
> AUTHORITATIVE, but PHYSICALLY INCOMPLETE.** It conflicts with `FR-PLT-010`
> (no tenant), `FR-FIN-022` (no Z content), `FR-FIN-023` (no Z number, no
> immutability) and ADR 0008 D-09 (no composite FKs). **Only the conflicting
> physical shape is redesigned (§27); the table names, the schema placement, the
> parent/child structure and the `closed_by` FK shape are kept verbatim.**

---

## §7. AGGREGATE OWNERSHIP

> ## **A — TREASURY. Four independent authoritative statements.**

1. **SRS §7.3 #29** — `DayClose` · **Context: Treasury** · Contained entities
   `SessionSummaries`, `VarianceReport` · Invariant *"All sessions closed before
   day close"*.
2. **SRS §25.1** — `treasury` schema contains *"drawers, cash_sessions,
   cash_movements, expenses, **day_closes**"*.
3. **SRS §5.5.4** — `day.closed` · **Publisher: Treasury**.
4. **SRS §15.2** — the permission is in the **Cash** family: `cash.day.close`.

**B — Reporting: REJECTED.** **RPT-R2 clause 5** is binding: *"The reporting
module owns **zero tables and zero migrations**."* `DailyTradingReportService`'s
own docblock: *"This service owns ZERO Prisma models."* Making Reporting a
state-changing financial aggregate would reopen a ratification for no
source-supported reason.

**C — new Finance module: REJECTED.** No SRS context named "Finance" exists;
§7.3 places the aggregate in Treasury and §25.1 places the table there.

**D — other: none source-backed.**

**Internal shape:** a `day-close/` directory inside the existing Treasury module,
mirroring `cash-session-close/`, `cash-movements/`, `cash-close-policy/`. **No new
NestJS module.**

---

## §8. Z REPORT — FIELD-BY-FIELD SOURCE AUDIT

Classification key: **A** exactly available · **B** structurally zero and truthful ·
**C** derivable via a new public contract, no new business semantics ·
**D** data exists but business definition source-silent ·
**E** not derivable from persisted facts · **F** blocked by an excluded capability.

| # | `FR-FIN-022` field | Class | Evidence and reasoning |
|---|---|---|---|
| 1 | **gross sales** | **A** | `DailyTradingSalesFacts.grossSales` — Σ completed `orders.grand_total`, tax-inclusive. `orders.subtotal` is banned from every formula (its meaning differs by pricing mode) |
| 2 | **discounts** | **B** | `.discounts` = Σ `orders.discount_total`, **structurally `0`** — no discount mechanism exists. Truthful, and must be **rendered as zero with a stated reason**, never omitted |
| 3 | **refunds** | **B** | `.refunds` is a **literal `0n`**. **Structurally impossible, not merely absent**: `order-state.ts` `TRANSITIONS` gives `partially_refunded: []` and `refunded: []` **no inbound transition** — verified at `:88-90`. The domain *"KNOWS these states so historical rows read correctly; it refuses to invent a way of reaching them"* |
| 4 | **net sales** | **A** | `gross − discounts − refunds − tax` (`FR-CST-003` [M] verbatim), already computed and ratified in RPT-R3 clause 4 |
| 5 | **tax by rate** | **E** | **§9.** Only the component **sum** is persisted (`order_lines.tax_amount`); `FR-FIN-032` permits multiple components; per-component rate/base is persisted nowhere. `orders.country_pack_version` pins a version **string** with no pack code and no FK |
| 6 | **sales by category** | **E** | **CORRECTED UPWARD (§2.4).** `sales.order_lines` snapshots `menu_item_id`, `variant_id`, `item_name_snapshot` — **no category**. `MenuItem` deliberately carries **no `category_id`** (*"an item that appears on both the Main and Delivery menus must remain ONE identity"*); placement is the **many-to-many** `catalogue.menu_item_placements` (`@@unique([tenantId, menuItemId, categoryId])`). Deriving it would join a **permanently sealed Z** to **mutable master data** — the exact restatement hazard `FR-RPT-005` names (*"reclassifying an item today does not silently restate last year"*), which **RPT-R2 records as NOT IMPLEMENTED** — and would be **ambiguous** for a multi-placed item. **Not honestly derivable without a category snapshot on `order_lines`, i.e. a Sales-side migration and a BR-POS-004 extension** |
| 7 | **sales by tender** | **A (PARTIAL)** | `.cash` / `.manualExternalCard` with `paymentCount` and `roundingAdjustmentTotal`. `FR-FIN-010` stays **PARTIAL** by RPT-R2 clause 8 — *each card scheme* unsatisfied (`card_scheme` is optional, unvalidated, cashier-typed free text; `FR-POS-064` NOT IMPLEMENTED) and nine tender families unimplemented |
| 8 | **sales by order type** | **C** | `sales.orders.order_type` is a **NOT NULL enum on the order itself** — an immutable transaction fact needing **no** master-data join and **no** new semantics. A `GROUP BY order_type` over the same completed population. **Minimal contract in §8.9** |
| 9 | **transaction count** | **A** | `.completedOrderCount` |
| 10 | **average order value** | **A** | RPT-R3: `netSales ÷ completedOrderCount`, HALF_UP via `divideRounded`, **`null`** at zero count |
| 11 | **void and comp summary** | **C (void) + B (comp)** | **Voids exist**: `order-lines.service.ts:571-576` writes `state:'voided'` with `voidedBy`, and `order_lines` carries `void_reason_id` / `voided_by`, DB-guarded by `ck_order_line_void_reason`. **Pre-fire only** — post-fire void is deliberately unimplemented (*"no ratified rule defines its approval semantics"*). **Comps are structurally zero**: `isComp` defaults `false` and **no code path ever writes `state:'comped'`**. ⚠️ **One residual source-silence:** the void *population* (voided lines on **completed** orders only, vs. all orders of the day incl. cancelled/abandoned) is undefined — **resolve as completed-population-only for consistency with every other Z field, and state it** (mechanics, not governance) |
| 12 | **cash reconciliation** | **A (PARTIAL) → improvable** | Today PARTIAL via Reporting's payment-derived, WHOLE_SESSION contract. **DayClose can do better**: Treasury owns `cash_sessions` and queries **all** branch sessions directly (§4), so the Z's reconciliation can list **every** session it sealed — including zero-payment and movement-only ones. **This is a genuine improvement over `FR-FIN-021`-blind Reporting, achieved with no new anchor** |
| 13 | **variance summary** | **D** | Data exists (`cash_sessions.variance`, populated exactly once at `closed`). **The business definition is source-silent** for spanning sessions — **§22 / DC-R2** |

### Tally, honestly stated

- **A — exactly available: 5** (gross, net, tender*, count, AOV)
- **B — structurally zero and truthful: 2** (discounts, refunds) **+ the comp half of #11**
- **C — new public contract, no new semantics: 2** (sales by order type; the void half of #11)
- **D — source-silent business definition: 1** (variance summary → **DC-R2**)
- **E — not derivable from persisted facts: 2** (**tax by rate**, **sales by category**)
- **F — blocked by an excluded capability: 0** *(no Z field is P1C-1-blocked — §11)*

> **The POST-REPORTING "8 of 13 available / 5 missing" framing is superseded by
> this six-class breakdown.** The material change: **sales by category moves from
> "buildable" to NOT HONESTLY DERIVABLE**, joining tax by rate.

### §8.9 — Minimal new public contracts for the two **C** items

Both are **Sales-owned facts**. **No direct cross-module private-table query.**
Both are `tx`-first, matching every accepted contract in this repository.

**Recommendation: a NEW, additive, DayClose-specific Sales contract — do NOT
extend `DAILY_TRADING_SALES_QUERY`.** Extending it would (a) change the accepted
Reporting HTTP response shape or force dead fields into it, and (b) couple a
sealed financial document to a read-report contract whose acceptance criteria
differ. §21 elaborates.

```
DAY_CLOSE_SALES_FACTS_QUERY  (Sales, tx-first)
  facts(tx, { tenantId, branchId, businessDay }) -> {
    // the same ratified formulas, reused not reimplemented:
    grossSales, discounts, refunds, taxTotal, completedOrderCount,
    openOrderCount, cash{...}, manualExternalCard{...},
    unsettledCapturedTotal, completedExcessCapturedTotal,
    orderCurrencies, paymentCurrencies,
    contributingCashSessionIds, sessionTenderTotals[],
    taxByClass[],                       // by CLASS, never by rate (§9)
    // NEW for FR-FIN-022:
    salesByOrderType: [{ orderType, netSales, grossSales, orderCount }],
    voidSummary:      { voidedLineCount, voidedLineValue }   // pre-fire only
  }
```

**Binding constraint:** the implementation MUST reuse the existing
`resolveBusinessDay`/`cutoverLookup` and the existing gross/net/AOV formulas —
**no second algorithm for any figure that already has a ratified one.**

---

## §9. TAX BY RATE — NO FALSE COMPLETION

### Re-confirmed against current source

| Fact | Evidence |
|---|---|
| `order_lines.tax_amount BIGINT` persists **one summed amount** | `schema.prisma:1896` |
| `FR-FIN-032` [M] permits **multiple simultaneous components**, *"each with its own rate, base, and rounding"* | SRS §16.6 |
| Per-component rate/base is persisted **nowhere** | No component table exists among 88 models; no migration creates one |
| `order_lines.tax_class_id` carries **identity only, never a rate** | `TaxClass` docblock: *"It holds NO rate, NO component definition, NO rounding rule and NO order-type override"* |
| `orders.country_pack_version` pins a **version string**, no pack code, no FK | `schema.prisma:1854` |
| The accepted Reporting design gate proved this, not asserted it | *"tax by rate is not derivable at all — FR-FIN-032 multi-component tax means only the component SUM is persisted"* |

**Deriving a legal rate by dividing rounded money is forbidden** — it is
reverse-engineering a statutory figure from a lossy aggregate, and would produce
a *different* rate for the same class on different orders.

### The three options

| | Description | Assessment |
|---|---|---|
| **A** | **Block DayClose** until a Fiscal/Tax persistence slice stores per-component snapshots | **Honest but disproportionate.** It blocks the *entire* operational close — including `FR-FIN-020/021/023`, all 5 class-A fields, and the whole cash-accountability ceremony — on one presentation limb. It also enlarges into Fiscal, which **P1C-1** excludes |
| **B** | **Internal-MVP sequencing** — build the operational DayClose now; `FR-FIN-022` remains **PARTIAL** | **RECOMMENDED.** Exactly the shape RPT-R2 already established for `FR-RPT-001/002/003/005`: *"not a waiver, not a reinterpretation, not a claim of completion"* |
| **C** | Persist components inside this slice | ❌ It is a **Sales/Fiscal** persistence change (a new component table + a BR-POS-004 snapshot extension + tax-calculator changes), not a Treasury close. It would silently widen an already-large slice and touch accepted P1F code |

> ### **The user decision is SEQUENCING / SCOPE ACCEPTANCE — never a "tax-by-rate semantics" vote.**
> The data does not exist; no user choice can conjure it. **DC-R1** asks whether
> the operational DayClose may ship while this `[M]` limb stays **explicitly
> unmet**. It must never be recorded as *waived*, *satisfied by subset*, or
> *redefined*.

---

## §10. Z CONTENT COMPLETENESS — WHAT MAY AND MAY NOT BE SAID

**`FR-FIN-022` is `[M]`. No user vote changes the SRS.** The gate therefore fixes
the permitted vocabulary in advance.

### Unmet limbs, named exactly

| Limb | Status after this slice | Reopened by |
|---|---|---|
| **tax by rate** | **NOT IMPLEMENTED** — components not persisted (§9) | a future Tax/Fiscal component-persistence slice |
| **sales by category** | **NOT IMPLEMENTED** — no category snapshot on `order_lines`; master data is mutable and many-to-many (§8 #6) | a future Sales BR-POS-004 category-snapshot slice |
| **comp half of void-and-comp** | **STRUCTURALLY ZERO** — no comp mechanism exists | a future Comp slice |
| **sales by tender** | **PARTIAL** — two tenders; *each card scheme* unsatisfied (RPT-R2 cl. 8) | `FR-POS-064` / tender-family slices |
| **variance summary** | Implemented **only** once **DC-R2** defines spanning ownership | DC-R2 |

### Mandated wording

> ✅ **PERMITTED:** *"Internal-MVP Operational DayClose / Z snapshot is authorised
> now, while **`FR-FIN-022` remains PARTIAL** because tax-by-rate and
> sales-by-category are not derivable from persisted facts, the comp summary is
> structurally zero, and sales-by-tender is PARTIAL under RPT-R2 clause 8."*
>
> ❌ **FORBIDDEN in every artefact** — report, register entry, INDEX row, code
> comment, OpenAPI description, commit message: *"`FR-FIN-022` waived"* ·
> *"satisfied with a subset"* · *"Z fully compliant"* · *"`FR-FIN-020…026`
> COMPLETE"*.

### Naming the artefact

**Recommendation: name it a `DayClose` with an embedded Z snapshot, and label the
snapshot honestly** — e.g. an OpenAPI description and a response field stating
*Internal-MVP Z snapshot; `FR-FIN-022` PARTIAL — tax-by-rate and sales-by-category
NOT IMPLEMENTED*.

Rationale: calling the route or payload a bare **"Z report"** implies statutory
completeness a client may act on; calling it only a *"DayClose snapshot"* hides
that `FR-FIN-022` is the requirement being served. The accepted Reporting slice's
own `scope.notes` array is the exact precedent — **carry a machine-readable
scope/limitations block on the response**, listing each unmet limb verbatim.
*(Mechanics, not governance.)*

---

## §11. `FR-FIN-026` — FULL RE-AUDIT (RECEIPT INDEPENDENCE **PROVEN**)

> *"Day close SHALL trigger: fiscal document finalisation, inventory day-end snapshot, report pre-aggregation, and accounting export generation where configured."*

### Grammar

**Answer: C — AMBIGUOUS, resolved to A on the balance of evidence.**

*"where configured"* sits immediately after *"accounting export generation"* in a
four-item list with no comma before it, which in ordinary reading attaches to the
**final item only (A)**. A distributive reading (B) is grammatically possible but
would make the entire requirement conditional, which is inconsistent with its
`[M]` marking.

**The distinction is immaterial to this gate**, and that is worth stating: under
**either** reading, **every one of the four effects is unavailable at this HEAD**
for reasons that are *not* about configuration. The gate does not rest on winning
the grammar argument.

### Limb-by-limb, against current source

| # | Effect | Classification | Proof |
|---|---|---|---|
| 1 | **Fiscal document finalisation** | **NO-OP BECAUSE NO ENTITY EXISTS** + **BLOCKED BY P1C-1** | **Not asserted — proven.** 88 Prisma models contain **no** `TaxDocument`, `InvoiceTemplate`, `FiscalConfig`, `FiscalSubmissionAttempt`. The approved SQL defines `fiscal.tax_documents` / `tax_document_lines` / `invoice_templates` / `fiscal_configs` / `fiscal_submission_attempts`; **none is migrated** across all 34 migrations (only `20260820140000_fiscal_tax_class_identity` touches `fiscal.*`, and it creates the rate-free `TaxClass` identity). `country-pack.model.ts:34` — the pack models **`currency` + `tax` only**; §22.2's `invoice:` block is **not modelled, not parsed, not signed**. **There is no row of any type for a finalisation to act upon.** Separately and independently, **CARRIED ITEM P1C-1** forbids creating one, reaffirmed by P1F-2 (2026-08-25) and left unchanged by **RPT-R2 clause 13** |
| 2 | **Inventory day-end snapshot** | **NOT IMPLEMENTED** | `inventory.stock_levels` is a **live projection** (`@@id([stockItemId, locationId])` — current state, no date dimension). No dated snapshot table exists among 88 models; no `business_day` or `as_of_date` column exists on any inventory table. `CountSession` is a **physical count workflow**, not an automatic day-end snapshot |
| 3 | **Report pre-aggregation** | **NOT IMPLEMENTED — and deliberately so** | **`FR-RPT-002`/`FR-RPT-003` are recorded NOT IMPLEMENTED by RPT-R2 clause 2**, and clause 5 forbids *"rollup persistence"*, *"`fact_*`/`dim_*` tables"* and *"an analytics warehouse"*. **DayClose must NOT implement this limb — doing so would directly contradict RPT-R2** |
| 4 | **Accounting export generation** | **NOT IMPLEMENTED · REQUIRES OUTBOX/EXTERNAL EFFECT** | `FR-RPT-043` (export) is **NOT IMPLEMENTED** by RPT-R2 clause 7 and `report.export` is a **NOT-authorized** code under RPT-R1 clause 6. Additionally: **no outbox exists** — `grep -c -i outbox prisma/schema.prisma` → **0**, and five separate accepted modules state it verbatim (`production/costing/recipe-cost.port.ts:12` *"this repository has no outbox, no event bus and no…"*; `workforce/workforce.module.ts:28` *"…faking a fire-and-forget event would be worse than…"*; `inventory/inventory.module.ts:20`; `production/production.module.ts:20`; `inventory/reconciliation/reconciliation.service.ts:8`). **SRS §5.5.3 makes the outbox MANDATORY (`FR-PLT-041`) for exactly this class of effect.** No configuration mechanism exists either (`FR-PLT-025` settings hierarchy NOT IMPLEMENTED) |

### Receipt dependency — the proof, not the assertion

Three independent legs, each sufficient alone:

1. **`FR-FIN-022` enumerates no fiscal field.** All thirteen items are
   operational aggregates. No TRN, no invoice sequence, no QR, no document
   reference.
2. **`FR-FIN-023`'s numbering is a per-branch Z number**, structurally unrelated
   to §22.2's invoice `sequenceStrategy: pre_allocated_block` / `blockSize` /
   `voidUnusedOnExpiry`. Different scope, different lifecycle, different table.
3. **`FR-FIN-026`'s limb 1 is a trigger over an empty set.** A trigger that
   iterates zero rows completes vacuously. It cannot fail, and it cannot block —
   **which is not the same as it being satisfied**, and it is classified
   **NOT IMPLEMENTED**, not *complete*.

> ## **RECEIPT DEPENDENCY: NONE. PROVEN.**
> DayClose is buildable while `FR-FIN-026` remains **PARTIAL**. **P1C-1 is not
> reopened, not narrowed, and not consulted for a decision.** The required user
> action is the **DC-R1 sequencing** decision — nothing about fiscal semantics.

---

## §12. Z PERSISTENCE — MINIMUM IMMUTABLE MODEL

### Draft→finalise, or insert-once?

> ## **INSERT-ONCE. No draft state, no status column, no aggregate `version`.**

- `FR-FIN-023` requires **immutable**. A draft→finalised mutation needs an
  `UPDATE` grant on the table, which is precisely what makes immutability
  service-enforced instead of DB-enforced. The accepted P1G-1 design-acceptance
  closure reached the identical conclusion for close facts — *"the corrected
  design writes core facts only at the CLOSED transition"* — after proving RLS
  cannot compare `OLD` to `NEW`.
- Nothing in `FR-FIN-020…026` describes a partially-closed day.
- §24.6.4's expected-version OCC has **nothing to assert against** on the INSERT
  of a brand-new aggregate. **A `version` column would be dead weight** —
  recommend omitting it and saying so.

### Conceptual fields (names are implementation detail — §27)

| Field | Required | Reason |
|---|---|---|
| `id` | ✅ | aggregate identity |
| `tenant_id` | ✅ | `FR-PLT-010` RLS — **the approved SQL's omission, corrected** (§6) |
| `branch_id` | ✅ | `FR-FIN-020` per-branch; ADR 0008 D-09 composite FK |
| `business_day` | ✅ | `DATE`, matching `sales.orders.business_day` |
| `z_number` | ✅ | `FR-FIN-023` sequential per branch (§13) |
| `closed_at` | ✅ | DB-generated (`statement_timestamp()`), un-forgeable — the `cash_close_policies` / `cash_session_close_attempts` precedent |
| `closed_by` (user) | ✅ | approved SQL's own FK, kept verbatim |
| `closed_by_employee` | ✅ | **P1D-E**: *"the business financial actor is the EMPLOYEE, not the login user"* — carried by every Treasury financial row |
| `data_as_of` | ✅ | `FR-RPT-004` [M] is **COMPLETE** and must not regress; `transaction_timestamp()`, the accepted Reporting precedent |
| `currency` | ✅ | ADR-008 / BR-CORE-001 — a historical Z must not depend on today's mutable `org.branches.base_currency`. Use the accepted **historical transaction-currency** resolution |
| **Z snapshot** | ✅ | **Normalised columns, NOT a JSON blob** — see below |
| `status` / finality | ❌ | insert-once |
| `version` | ❌ | nothing to assert against |
| idempotency identity | ❌ **on the row** | HTTP-layer concern (§18); the DB's business key is `(tenant, branch, business_day)` |
| audit linkage | ❌ **as an FK** | `governance.audit_entries` is append-only and hash-chained; Treasury references Governance through `AuditService`, never by FK (the `approval_request_id` precedent: *"Deliberately NO FK — another module's table"*) |

### Normalised columns vs. a JSON payload

**Recommend NORMALISED `BIGINT` columns** for every monetary Z figure, with child
tables for the repeating groups (per-tax-class, per-tender, per-order-type,
per-session). Reasons, all precedented:

- ADR-008 forbids floating money; a JSON blob invites JSON numbers.
- `cash_session_close_attempts` **DB-CHECKs its own arithmetic**
  (`ck_csca_formula`, `ck_csca_variance`) so *"a historical close explains itself
  with no join to current settings"*. The same identity checks (e.g.
  `net = gross − discounts − refunds − tax`) are only expressible over real
  columns.
- A JSONB blob cannot be constrained, indexed for retrieval, or safely evolved.

### Immutability enforcement — DB-level, not service-level

The exact accepted pattern from `20260830010000_treasury_cash_close_policies/migration.sql:127-147`:

```
GRANT SELECT ON <table> TO ros_app;
GRANT INSERT (<every column EXCEPT the DB-generated timestamps>) ON <table> TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON <table> FROM ros_app;
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
CREATE POLICY <t>_select ON <table> FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY <t>_insert ON <table> FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- No UPDATE policy. No DELETE policy.
```

**This makes `FR-FIN-023` immutability DB-enforced**, exactly as the P1G-1 gate
required for close facts.

---

## §13. Z NUMBER ALLOCATION

`FR-FIN-023` [M]: *"Z reports SHALL be **sequentially numbered per branch**"*.

| Question | Answer | Basis |
|---|---|---|
| **Starts at 1?** | **YES** | Source silent; 1 is the only non-arbitrary start for an ordinal, and any other choice would be invention |
| **Scope** | **`(tenant_id, branch_id)`** | `FR-FIN-020` is per-branch; `tenant_id` is mandatory for RLS. A tenant-wide or global sequence would leak branch activity volume across branches |
| **Reset?** | **NEVER** | Source says nothing about resetting. A reset would break *"retrievable for any historical date"* by making the number ambiguous. **No yearly reset is invented** |
| **Sequence object vs allocator row vs `MAX+1`** | **`MAX(z_number)+1` scoped to `(tenant, branch)`, inside the close transaction, protected by the §14 mechanism, with `UNIQUE (tenant_id, branch_id, z_number)` as the structural backstop** | This repository contains **zero PostgreSQL sequence objects** and **zero triggers** (the P1G-1 design-acceptance closure verified *"the repo contains zero triggers/functions/rules across all 33 migrations"*). A `SEQUENCE` is also **non-transactional** — it would consume numbers on rollback, guaranteeing gaps. An allocator row would need an `UPDATE` grant on a Treasury table, reintroducing the mutability §12 removes |
| **Transaction-safe?** | **YES** under §14's SERIALIZABLE + retry: the `MAX` read takes an SSI predicate lock over `(tenant, branch)`, so a concurrent close conflicts and retries |
| **Retry-safe?** | **YES** — `UnitOfWork`'s retry re-executes the **entire** UoW on a fresh transaction with fresh reads (`unit-of-work.ts:205-207`), so the retry recomputes `MAX+1` and sees the winner's committed number |
| **Does a failed transaction consume a number?** | **NO** — `MAX+1` is derived, not allocated; a rollback leaves no trace |
| **Is "sequential" ≡ "gapless"?** | > **Under this design, YES in practice — but GAPLESSNESS IS NOT CLAIMED AS A REQUIREMENT.** The SRS says *sequential*, not *gapless*. `MAX+1` inside the committing transaction happens to produce no gaps, which is a **property of the chosen mechanism**, not a promise the slice makes. **State it that way** and do not add gap-detection machinery |
| **Offline implications** | **NONE — and this is load-bearing.** Z numbering is **server-side and online-only**. It must **NOT** adopt `FR-OFF-016`/`OrderNumberBlock`'s pre-allocated-block strategy: that exists because *order* numbers must be issuable without connectivity, which day close never is |
| **Fiscal invoice sequencing** | **NOT IMPORTED.** §22.2's `pre_allocated_block` / `blockSize` / `voidUnusedOnExpiry` govern **invoice** sequences. **Source draws no link** between them and `FR-FIN-023`, and none is invented (§11) |

---

## §14. CONCURRENCY — RE-EVALUATED AFTER THE SERIALIZABLE CORRECTION

### §24.6.4, verbatim

> *"Aggregates carry a version. Updates assert the expected version and fail on mismatch, forcing the caller to reload. **Pessimistic locking is used only for order-number allocation and count-session exclusivity.**"*

**Two consequences, both decisive:**

1. **The OCC sentence is about `UPDATE`s.** DayClose is an **INSERT of a new
   aggregate**; there is no prior version to assert. **Option B is inapplicable.**
2. **§24.6.4 restricts *pessimistic* locking to two named cases.** DayClose is
   neither. An advisory lock **is** pessimistic. **SERIALIZABLE is not** — SSI is
   *optimistic* (snapshot isolation with conflict detection, resolved by
   retry). **SERIALIZABLE is therefore MORE §24.6.4-consistent than the advisory
   lock my prior report recommended.**

### Option comparison

| | Mechanism | Verdict |
|---|---|---|
| **A** | `UNIQUE (tenant, branch, business_day)` + conflict-safe INSERT | ✅ **REQUIRED — but insufficient alone.** It protects the DayClose **row**; it does nothing about the blocking-session read or the totals read |
| **B** | Optimistic expected-version `UPDATE` | ❌ **INAPPLICABLE** — no prior row |
| **C** | **SERIALIZABLE with bounded retry** | ✅ **RECOMMENDED — PRIMARY.** The **only** option that covers all seven questions below, because SSI predicate locks cover **phantom inserts** into a read range. Precedent, mechanism, retry loop, error classification and guard test all already exist and are **generic by design** |
| **D** | Branch/day advisory lock | ❌ **REJECTED as primary.** It is **pessimistic** (against §24.6.4 for a third use case) **and it does not solve the problem**: a lock on `hash(branch‖businessDay)` does not prevent a concurrent `INSERT INTO treasury.cash_sessions` — a different key space entirely. It would give false confidence |
| **E** | Row lock on a sequence/allocator row | ❌ **REJECTED.** Requires an `UPDATE` grant on a Treasury table, reintroducing mutability §12 removes; also pessimistic. Note the accepted `CashMovementsService` finding that `ros_app` **lacks the `UPDATE` privilege** needed for `SELECT … FOR UPDATE` on `cash_sessions` |
| **F** | Other | none source-consistent |

### The seven questions, answered by **one** model (A + C)

| Question | Answer under SERIALIZABLE + `UNIQUE` |
|---|---|
| Can two DayClose commands both pass *"no open sessions"*? | Both may **read** it, but they write the same `(tenant, branch, business_day)` → the **unique constraint** rejects the second (`P2002`, **not** retryable — it is a genuine business conflict → **409**) |
| Can a CashSession open concurrently after the blocker read but before commit? | **NO.** The blocker read is a **range predicate** on `(tenant, branch, status<>'closed')`; a concurrent `INSERT` of a session into that range is an SSI **write-skew/phantom** conflict → `40001` at commit → **bounded retry** re-reads and correctly finds the new blocker → **409 with the blocking list**. *(This is exactly the anomaly class the KDS `D0 [GUARD]` test documents.)* |
| Can a session transition `open`→`closing`/`closed` concurrently? | Same mechanism — the transition writes a row inside the read predicate → serialization conflict → retry |
| Can a new Order/Payment for the target day commit while DayClose snapshots totals? | **During the transaction: NO** (same predicate-lock reasoning over `sales.orders` / `sales.order_payments` for that `business_day`). **After commit: see §15** — this needs an additional *precondition*, not an isolation level |
| How does the configured business-day boundary affect late writes? | `orders.business_day` is **server-derived at order creation** (`resolveBusinessDay(serverNow, …)`), so a **new** order can never be created into a **past** business day. Only an **already-open** order of that day can still receive writes — §15 |
| What protects Z numbering? | The `MAX+1` read's predicate lock **plus** `UNIQUE (tenant_id, branch_id, z_number)` as the structural backstop |
| What protects one-close-per-day? | `UNIQUE (tenant_id, branch_id, business_day)` — structural, independent of isolation |

### Selected model

```
UnitOfWork.execute(
  scope, fn, causal,
  { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxAttempts: 3 }
)
```

- **No new infrastructure**; `serialization-retry.ts` is *"deliberately generic
  (not Kitchen-specific)"*.
- `SerializationRetryExhaustedError` maps to the repository's existing
  *"lost a race, reload and retry"* **409** convention (the
  `OrderVersionConflictError` precedent) — **never 422**.
- **No advisory lock is pre-authorised.** If implementation discovers a
  contention hot-spot, that is a *measured* follow-up, not a design assumption.

---

## §15. THE CRITICAL RACES — LATE SESSION AND LATE SALE

### Race 1 — new CashSession during close

```
T1: DayClose reads: no branch session with status <> 'closed'   ✓
T2: POST /cash-sessions  → INSERT a new open session, COMMIT
T1: INSERT DayClose, COMMIT
```

**Under READ COMMITTED: POSSIBLE — `FR-FIN-021` violated.**
**Under SERIALIZABLE: IMPOSSIBLE.** T2's `INSERT` falls inside T1's read
predicate; one transaction is aborted with `40001`. If T1 loses, its bounded
retry re-reads, finds the new session, and returns **409 + the blocking list** —
the correct outcome. **Deterministically testable** with the existing two-party
barrier harness (`test/kds-concurrency.e2e-spec.ts` pattern). **No sleeps.**

### Race 2 — late sale into an already-sealed day

```
T1: DayClose reads final Sales totals for business_day D
T2: a payment on an order whose business_day = D commits
T1: INSERT immutable Z, COMMIT
```

**Inside the transaction window: prevented by SERIALIZABLE** (same predicate
reasoning). **After the commit, however, the general problem is real and
SERIALIZABLE does not solve it:**

- `order_payments.business_day` is **copied from the order**, not derived from
  the clock (`schema.prisma:2053` — *"Copied from the order"*).
- So a payment captured **today** on an order opened **yesterday** lands with
  `business_day = D` — **after D's Z is sealed**.

**Analysis of reachability.** A `sales.order_payments` row for day `D` can only
be created by `SalesPaymentService.capture`, which requires **both**:

1. an order of day `D` that is **not finalised** — `assertTransition` refuses
   `completed`/`cancelled`/`partially_refunded`/`refunded` (`order-state.ts`
   `FINALISED`); and
2. a CashSession with **`status === 'open'`** (`sales-payment.service.ts:207`).

Condition 2 is already false at the instant of close (`FR-FIN-021`), but a new
session can be opened afterwards. **Condition 1 is the durable lever.**

### The precondition that makes the sealed Z provably final

> **Add: ZERO OPEN ORDERS for the target business day**, where *open* is the
> accepted Sales definition already in source —
> `draft · open · held · parked · partially_paid`
> (`daily-trading-sales.query.service.ts:14-19`, already exposed as
> `openOrderCount`).

**Proof of finality.** With zero open orders for day `D`:
every order of `D` is terminal (`completed`/`cancelled`), so no further payment,
line addition, line void or completion can target `D`; and a **new** order can
never be created into `D`, because `business_day` is server-derived to *today*.
**⇒ Day `D`'s sales, tender, tax, void and count facts are frozen.** The Z is
then immutable *and true*, not merely immutable.

### Complete close precondition set

```
(1) businessDay < branch current business day     -- FR-FIN-024 derivation, reused
(2) no DayClose exists for (tenant, branch, businessDay)
(3) no branch cash session with status <> 'closed' -- FR-FIN-021, unqualified
(4) no open orders for (tenant, branch, businessDay) -- finality (this section)
```

> **Disclosed operational consequence, recorded so it is not lost:** a single
> forgotten `parked` order blocks the day close until it is completed or
> cancelled. That is a **real** operational cost. The alternative — omitting (4)
> — means a sealed Z can later become false, which `FR-FIN-023`'s immutability
> makes **unrecoverable**.
>
> **Classified as an engineering consequence, NOT a fourth ratification** —
> exactly as RPT-R2 classified the branch fail-closed posture. It is *more*
> restrictive, grants nothing, and is derived from an `[M]` requirement rather
> than from business preference. **It is disclosed here rather than buried.**

---

## §16. BRANCH SECURITY FOR AN IRREVERSIBLE WRITE

**D-2 remains in force**, reconfirmed at this HEAD by **RPT-R2 clause 13** and
the 2026-08-31 consequence note (*"reads a **tenant-shape** fact
(`org.branches.status`), **never a principal's scope**"*). `TenantContext.branchId`
is still *"RESERVED — not populated this phase"*; `membership_roles.branch_id`
still exists and is still never read.

### Is the Internal-MVP rule sufficient for an irreversible write?

**The rule:** explicit `branchId` path parameter · target branch tenant-visible
(else tenant-safe 404) · tenant has **exactly ONE** active branch (0 ⇒ denied,
>1 ⇒ denied as unsupported) · supplied id **equals** it · actor holds
`cash.day.close`.

> ## **YES — SUFFICIENT. And the argument is arithmetic, not convention.**

Under the assertion, the set of branches the principal can affect has
**cardinality 1** and is **identical** to the set they are entitled to affect.
There is no second branch to cross into. **Read/write asymmetry changes the
*cost* of a scope error; it does not change a difference that is provably zero.**
This is precisely the Internal MVP's ratified carve-out — *"one branch
operationally"*.

**Additional strengthening available to DayClose that Reporting did not have:**
if the command is POS/manager-terminal-originated, the branch is derivable from
the **terminal binding** — Treasury's existing, *stronger* posture, where *"the
terminal is taken from the session, never the body"*. See §17.

### Binding conditions if accepted

- This is **tenant-shape safety, not branch-aware RBAC**.
- **D-2 is UNTOUCHED. `FR-SEC-002` / `FR-SEC-003` / `FR-SEC-004` remain NOT
  IMPLEMENTED.**
- **The branch check MUST execute inside the SAME write transaction** — the
  TOCTOU lesson the Reporting acceptance correction learned when it deleted its
  `ReportingBranchGuard`. Under SERIALIZABLE this is additionally enforced.
- **Multi-branch tenants receive no DayClose capability** (403). **Disclosed
  consequence:** for a write this means *operations are blocked*, not merely a
  report unavailable — strictly worse than Reporting's case, and it must be
  stated in the OpenAPI description, not discovered in production.
- **No fourth scope mechanism is created.** The existing
  `BRANCH_REPORTING_SCOPE_QUERY` contract is reused as-is.

**Therefore: NOT verdict E.**

---

## §17. ACTOR / SESSION TYPE

**Permission is settled (`cash.day.close`). Session type is not, and is not
inferred from the permission name.**

| Evidence | Direction |
|---|---|
| §15.2 places the code in the **Cash** family, alongside `cash.session.open` / `cash.payin` — all POS-originated | → POS |
| §15.3 role catalogue assigns day close to **Branch Manager**-tier roles | → either |
| `FR-FIN-025` [S] contemplates a **server-side automatic** close | → server (deferred, §24) |
| Treasury's existing precedent: **every** cash route carries `@AllowPosSession()` (`treasury.controller.ts:314`) | → POS |
| Reporting's precedent: **dashboard-only**, no `@AllowPosSession` (`reporting.controller.ts:43`) | → dashboard |
| A manager closing the branch day physically stands at a terminal after the drawers are counted | → POS |

> ### **RECOMMENDATION: POS session ALLOWED (`@AllowPosSession()`), matching every
> other Treasury write route — and dashboard sessions also accepted, since the
> decorator is an *opt-in widening*, not a restriction.**

Rationale: DayClose is a **cash-accountability ceremony** performed where the
drawers are, immediately after the last `POST /cash-sessions/{id}/close`.
Restricting it to dashboard-only would force a manager to switch devices
mid-ceremony for no source-supported reason. **Mechanics, not governance.**

**No role-name string is hardcoded** — authorization is permission-based (**D-3**,
and RPT-R1's binding constraint *"Do NOT hardcode role-name strings"*).

**Note:** the **historical retrieval** route's session type is a separate
question, and is bound to **DC-R3** (§25).

---

## §18. IDEMPOTENCY / REPLAY

`FR-API-020` [M]: *"Every POST and PATCH SHALL accept an `Idempotency-Key`
header, and it SHALL be **mandatory on all financially significant endpoints**."*
Sealing a business day is financially significant. **Repository precedent is
unanimous** — every Treasury POST carries `@Idempotent()`
(`treasury.controller.ts:341, 402, 440, 478, 567, 631`).

**HTTP idempotency and DB uniqueness are NOT conflated.** They answer different
questions and both are required:

| Scenario | Layer | Behaviour |
|---|---|---|
| **First execution** | both | Reserve key → run → persist DayClose → store response |
| **Exact replay** (same key, same fingerprint) | HTTP | Stored response + **`Idempotent-Replay: true`** (`FR-API-022`). The transaction does not re-run |
| **Fingerprint conflict** (same key, different body) | HTTP | **409** (`FR-API-023`) — a client defect, not a retry |
| **Same key still in flight** | HTTP | **409**, no duplicate work |
| **Already-closed day under a DIFFERENT key** | **DB** | `UNIQUE (tenant, branch, business_day)` → **409 "business day already closed"**, carrying the existing `zNumber`/`closedAt`. **HTTP idempotency cannot catch this** — different key, different fingerprint. This is exactly why both layers exist |
| **Concurrent duplicate commands** (two keys, same day) | **DB + §14** | One commits; the other hits the unique violation (`P2002` — **not** a serialization failure, therefore **not retried**) → 409 |
| **Handler throws** | HTTP | Reservation **released**, so a legitimate retry can proceed (`idempotency.interceptor.ts` docblock) |
| **Response replay after commit** | HTTP | Served from the idempotency store, byte-identical |

### Client-generated permanent id?

> **NO. The DayClose id is SERVER-GENERATED.**

`FR-OFF-015` mandates client permanent ids for **device-originated** facts —
which is why `CashSessionCloseAttempt`'s id is a client ULID (*"the cashier's
terminal assigns it at physical count declaration time"*). **DayClose is not
device-originated**: it allocates a **server-side sequential Z number**, requires
server-side blocking-session and finality reads, and `FR-FIN-025` contemplates a
server-side automatic variant. It is the **administrative-write** class, matching
`CashClosePolicy` (*"correctly server-generated as an administrative write"*).

### R-6(a) lesson, carried forward

**Never throw after the durable decision has been written.** A 4xx thrown after a
successful INSERT would release the idempotency reservation and let a replay
attempt a second close. Business refusals (blocking sessions, open orders,
already-closed) must be raised **before** any write.

---

## §19. EVENT — `day.closed`

**SOURCE-DECIDED:** SRS §5.5.4 — `day.closed` · Publisher **Treasury** ·
Principal Subscribers **Analytics, Fiscal, Reporting**. Exactly one event. **No
second event is invented.**

### Mechanism and timing

**SRS §5.5.2** (*"Asynchronous In-Transaction — Domain Events … dispatched by the
unit of work within the same database transaction"*) governs. Precedent:
Treasury already publishes `cash.variance.detected` via `UnitOfWork` /
`ctx.publishEvent`, and the dispatcher tolerates **zero** registered handlers
(as it does today for `order.line.fired` and `order.opened`).

- Published **after** the DayClose row and its children are persisted, **inside**
  the same UoW, **before** commit — so `drain` runs with the same `tx`.
- **Retry-safe:** `UnitOfWork` allocates a **fresh event collector per attempt**
  (`unit-of-work.ts:166-168`) and holds `correlationId` **stable across
  attempts** (`:150-155`), so a serialization retry cannot leak or duplicate
  events.
- The mandatory §5.5.4 envelope (`eventId`, `eventType`, `eventVersion`,
  `occurredAt`, `recordedAt`, `tenantId`, `branchId`, `actorId`, `actorType`,
  `correlationId`, `causationId`, `idempotencyKey`) is supplied by
  `createDomainEvent` and **never repeated in the payload**.

### Payload — sufficient without leaking private models

Money as **base-10 minor-unit strings** (ADR-008 — never JSON numbers), mirroring
`CashVarianceDetectedPayload`:

```
dayCloseId · businessDay (ISO date) · zNumber · currency · dataAsOf (ISO)
grossSalesMinorUnits · discountsMinorUnits · refundsMinorUnits
taxTotalMinorUnits · netSalesMinorUnits
completedOrderCount · averageOrderValueMinorUnits (nullable)
tenderTotals[{ tender, amountMinorUnits, paymentCount }]
sessionCount · varianceTotalMinorUnits (subject to DC-R2)
closedByUserId · closedByEmployeeId
```

**No `cash_session_id` list, no per-session internals, no row shapes** — the
event announces the sealed *fact*, not Treasury's table structure.

### External effects — explicitly NOT faked

**No synchronous call to Fiscal, Accounting or any external system inside the
request.** SRS §5.5.3 makes the **transactional outbox mandatory
(`FR-PLT-041`)** for that class of effect, and **no outbox exists** (§11, limb 4
— proven by schema grep and five accepted module docblocks that refuse to fake
it).

> **Therefore every external-effect limb of `FR-FIN-026` is recorded
> NOT IMPLEMENTED / deferred. Nothing is faked, and no fire-and-forget call is
> made.** This follows `workforce.module.ts:28` verbatim: *"faking a
> fire-and-forget event would be worse than…"*.

---

## §20. AUDIT

`FR-AUD-001` binds state-changing operations; `FR-AUD-006`'s always-audit list
covers financial finalisation. DayClose is unambiguously both.

| Element | Value |
|---|---|
| **Action literal** | one new `AUDIT_ACTION` entry, e.g. `DAY_CLOSED` — **engineering mechanics.** The P1G-1 register entry records verbatim that *"the audit action literal"* is a *"Design-Gate / implementation detail"* |
| **Entity type / id** | the DayClose aggregate and its id |
| **Context** | `branchId`, `businessDay`, `zNumber`, `dataAsOf` |
| **Actor** | both the identity **user** and the **employee** (P1D-E) |
| **before / after** | **`before` is null and MUST be** — insert-once, nothing pre-existed. `after` carries the Z summary metadata, not the full payload |
| **Metadata** | headline totals + session count. **No secrets, no full payload dump, no per-session internals** |
| **Transaction** | **SAME atomic transaction** — `AuditService` already advisory-locks its hash chain per tenant and participates in the caller's `tx` |
| **Retrieval route** | **NOT audited** — `FR-AUD-001` binds state-changing operations; **RPT-R2 clause 12** settled the identical question for ordinary `GET`s, and `FR-AUD-007` binds *audit-log* access, which this route does not touch |

---

## §21. REPORTING CONTRACT REUSE

| Contract | Decision |
|---|---|
| **Sales `DAILY_TRADING_SALES_QUERY`** | **DO NOT EXTEND.** Add an additive, DayClose-specific Sales contract instead (§8.9). Extending it would either change the **accepted** Reporting HTTP response (breaking RPT-R1/R2 acceptance) or push dead fields into a ratified read surface. The two consumers have genuinely different acceptance criteria: Reporting is a *live, recomputable* read; DayClose is a *sealed, permanent* snapshot |
| **Reused *implementations*, not duplicated** | **BINDING:** the new contract MUST reuse `resolveBusinessDay`/`cutoverLookup` and the ratified gross/net/AOV formulas. The repository's own rule — *"the report and Order creation must never be able to disagree about what today's business day is; no second business-day algorithm exists"* — applies identically to gross sales |
| **Treasury `DAILY_CASH_RECONCILIATION_QUERY`** | **MUST NOT be the `FR-FIN-021` blocker source** (§4). Treasury owns `cash_sessions` and queries its own tables directly — **no contract needed** |
| **Organisation `BRANCH_REPORTING_SCOPE_QUERY` / `BRANCH_CURRENCY_QUERY`** | **REUSED AS-IS**, both `tx`-first, for §16's posture and the currency fallback |
| **Sales `currentBusinessDay`** | **REUSED** for precondition (1). *(Long-term, business-day resolution arguably belongs to Organisation, since the cutover column is `org.operating_hours` — recorded as a future concern, **not** changed here: relocating it would touch accepted Sales and Reporting code for no functional gain.)* |
| **Localisation `TAX_CLASS_LABELS_QUERY`** | **REUSED AS-IS** if the Z snapshots tax-class labels |
| **Catalogue** | **NO new contract** — sales-by-category is class **E** (§8 #6). **Adding a Catalogue contract here would be the wrong fix**, because the defect is a missing *snapshot*, not a missing *query* |
| **Treasury → Sales direction** | **Already precedented with zero deviations**: `cash-session-close.service.ts:65-66` consumes Sales' `CASH_SESSION_TENDER_TOTALS_QUERY` |

**Zero `KNOWN_DEVIATIONS` growth is required and achievable** — every edge is a
public `contract/` token.

---

## §22. VARIANCE SUMMARY — THE GENUINE SOURCE SILENCE

`FR-FIN-022` requires a *variance summary*. It is **NOT** automatically
`SUM(whole-session variance touching the day)`, because a spanning session would
contribute its single whole-session variance to two days — the exact
double-count the Reporting acceptance correction removed.

| | Candidate semantics | Spanning-session behaviour |
|---|---|---|
| **A** | Sessions **closed during** this DayClose's business day | Needs `closedAt` → mutable-timezone derivation (disproven). A session closed at 02:00 could belong to either day |
| **B** | Sessions whose **payments touched** the business day | **Double-counts**: a spanning session's whole-session variance lands in **both** days' totals. This is the removed defect |
| **C** | Sessions **first opened in** the business day | Under-counts the later day and misattributes a session that earned most of its money after the boundary |
| **D** | Sessions **assigned to this DayClose at close time** | **No duplication** — exclusive by construction. But *which* DayClose gets a session already listed by an earlier one is **undefined by source** |
| **E** | Whole-branch delta **since the previous DayClose** | Clean and gapless across the branch's timeline; makes the *first* DayClose's window unbounded, and needs a rule for sessions predating any DayClose |
| **F** | Other | — |

> ## **THE SRS IS SILENT.** §16.5 never states which day owns a spanning session's
> variance. **This is a genuine business-semantics decision — DC-R2. It is not
> invented here.**

**Engineering note offered to inform the decision, not to pre-empt it:** options
**D** and **E** are the only two that never duplicate a variance figure, and §5.3
Option F's partial-unique ownership constraint implements **either** without
schema change. **A/B/C are structurally unsound** for an immutable document, and
this gate does not recommend them.

---

## §23. CASH SESSION SUMMARY RELATION — EXACT ANSWER

> ### **Q: Can the same CashSession legally appear in TWO DayClose records?**
> ## **A: YES — for LINKAGE. NO — for VARIANCE OWNERSHIP.**

| | **Linkage rows** | **Variance ownership** |
|---|---|---|
| **Nature** | immutable per-DayClose snapshot child | an exclusive discriminator on the linkage row |
| **Cardinality** | one row per session **per DayClose** | at most one owning DayClose **per session** |
| **Uniqueness** | **`UNIQUE (tenant_id, day_close_id, cash_session_id)`** | **partial `UNIQUE (tenant_id, cash_session_id) WHERE <owner flag>`** |
| **Contents** | session id, employee, drawer, status at seal, opening float, **day-scoped** tender figures (from `order_payments.business_day` — genuinely day-attributable), whole-session close facts **explicitly labelled WHOLE_SESSION**, `businessDayCount` | the whole-session variance, counted exactly once system-wide |
| **Immutable** | yes — append-only grants (§12) | yes |

**The authoritative rule that assigns ownership is exactly what DC-R2 decides.**
Until DC-R2 is answered, the partial-unique constraint has no predicate and the
variance summary cannot be implemented.

> ### **`UNIQUE (tenant_id, cash_session_id)` UNCONDITIONAL IS FORBIDDEN** (§5.4).

---

## §24. AUTOMATIC CLOSE — `FR-FIN-025`

> ## **DEFER. Recorded as NOT IMPLEMENTED.**

`[S]`, not `[M]`. It requires **all** of: a scheduler (the register records D-12
as *"BLOCKED on … a scheduler"*, and four accepted modules state *"no
scheduler"*), a per-branch enablement flag (no such column; `FR-PLT-025`
settings hierarchy NOT IMPLEMENTED), and **force-close-and-flag** semantics that
no ratified rule defines.

**No scheduler, no job runner, no cron is built. No forced session closure is
implemented** — and none is implied by manual close, since `FR-FIN-021` makes
all-sessions-closed a **precondition**, not an action.

---

## §25. HISTORICAL RETRIEVAL — AND THE PERMISSION PROBLEM

`FR-FIN-023` [M] requires Z reports *"retrievable for any historical date"*.
**This mandates a read route.** It does **not** mandate export or PDF
(`FR-RPT-043`/`044` remain NOT IMPLEMENTED by RPT-R2 clause 7).

### Route shape (mechanics)

`GET /branches/{branchId}/day-closes/{businessDay}` — repository-native,
mirroring the existing `POST /branches/{branchId}/cash-close-policy` and
`GET /reports/branches/{branchId}/daily-trading/{businessDay}`.

### The authority problem — this is NOT hidden

| Candidate | Assessment |
|---|---|
| **`cash.day.close`** | ❌ **REFUSED.** §15.2 quotes it as *"Close the business day"* — a **WRITE** authority. **The repository has already refused this exact reinterpretation**, in this exact module: *"§15.2 quotes `cash.session.open` as 'Open a shift' — a WRITE authority. It is not a generic CashSession read permission, and reinterpreting it as one would hand every session-opening cashier a read capability no source grants."* Letting a write code become historical read authority would contradict Treasury's own accepted reasoning |
| **`report.view.financial`** | ❌ **REFUSED without new ratification.** RPT-R1 gates it on *"the single composite daily-trading route"*; `reporting.permissions.ts` states it **"MUST NOT be broadened, split, or accompanied by…"**; RPT-R1 clause 8 — *"No existing permission is broadened. Every existing code keeps its exact pre-ratification scope."* Applying it to a second, Treasury-owned route is a broadening |
| **A new `cash.day.close.view` / `report.view.*`** | ❌ **Cannot be invented.** §15.2's Cash family contains **no read code**, and §15.2 designates **Appendix C** as authoritative — **Appendix C is ABSENT from `ROS_SRS_v1.0.pdf`** (the document ends at §29.5). **D-20** records the same absence and answers it by **deferring** rather than inventing |
| **Defer the route entirely** | ⚠️ Follows Treasury's *"read routes are withdrawn rather than misauthorised"* precedent — **but leaves `FR-FIN-023` [M]'s retrievability limb unmet**, which is a worse outcome than for the optional reads that precedent covered |

> ## **HISTORICAL Z READ AUTHORITY: SOURCE-SILENT → DC-R3.**
> **This question is surfaced, not hidden.** It is precisely the KDS-R11 /
> RPT-R1 situation: a code the SRS's *absent* appendix would have supplied. The
> options are laid out in §29 with a recommendation; **the choice is the user's.**

---

## §26. API SURFACE

**Design only. No route is created.**

### 1 — Close the business day

| | |
|---|---|
| **Method / path** | `POST /branches/{branchId}/day-closes/{businessDay}` |
| **Session type** | `@AllowPosSession()` + dashboard (§17) |
| **Permission** | `cash.day.close` (**source-decided**) |
| **`Idempotency-Key`** | **REQUIRED** (`@Idempotent()`, `FR-API-020`) |
| **Body** | **empty**, enforced by an empty DTO + the global `forbidNonWhitelisted` pipe (the accepted Reporting precedent). Every input is server-derived; **nothing financially significant is client-supplied** |
| **200/201** | the sealed DayClose + Z snapshot + the honest scope/limitations block (§10) |
| **400** | missing/oversized `Idempotency-Key`; malformed `businessDay`; **`businessDay` not in the past** (precondition 1) |
| **401** | no/invalid token |
| **403** | missing `cash.day.close`; zero active branches; **more than one** active branch (unsupported this release); `branchId` ≠ the single active branch |
| **404** | branch unknown **or** in another tenant — **byte-identical** (RLS tenant-safe 404) |
| **409** | **(a)** blocking cash sessions — **body carries the `FR-FIN-021` blocking list**; **(b)** open orders for the day (§15); **(c)** day already closed (unique violation), body carries the existing `zNumber`/`closedAt`; **(d)** idempotency fingerprint conflict / in-flight; **(e)** `SerializationRetryExhaustedError` after 3 attempts |
| **Error ordering** | **404 → 403 → 400 → 409**, matching the accepted Reporting error semantics |

### 2 — Retrieve a historical Z

| | |
|---|---|
| **Method / path** | `GET /branches/{branchId}/day-closes/{businessDay}` |
| **Session type** | dashboard-only (recommended; a historical financial read is not a POS action) |
| **Permission** | **DC-R3 — UNRESOLVED** (§25) |
| **Idempotency** | none (GET) |
| **200** | the sealed snapshot, byte-stable forever |
| **404** | branch unknown/foreign, **or** no DayClose for that day |
| **Audit** | **none** — ordinary GET (RPT-R2 clause 12) |
| **Headers** | `Cache-Control: no-store`, matching the Reporting precedent |

**Deliberately absent:** any list/search route (no source-supported read
authority beyond DC-R3), any export/PDF route (`FR-RPT-043` NOT IMPLEMENTED),
any reopen/delete route (`FR-FIN-023` immutability), any X-report route
(`FR-POS-093` authorization NOT SOURCE-DECIDABLE).

---

## §27. MIGRATION DESIGN — CONCEPTUAL ONLY

> **ONE additive Treasury migration (number 35). NO migration is created by this
> task.** Exact table/column/index/constraint **names** remain implementation
> detail, consistent with how the P1G-1 and Reporting gates treated the same
> class of item.

| Object | Needed? | Notes |
|---|---|---|
| `treasury.day_closes` | ✅ | Approved-SQL name + shape, **corrected** per §6: add `tenant_id`, composite FK `(tenant_id, branch_id) → org.branches(tenant_id, id)`, `@@unique([tenantId, id])` |
| Z snapshot columns on `day_closes` | ✅ | Normalised `BIGINT` money (§12); DB CHECKs for the arithmetic identities, mirroring `ck_csca_formula` |
| Z snapshot child tables | ✅ | per-tax-class, per-tender, per-order-type repeating groups |
| `treasury.session_summaries` | ✅ | Approved-SQL name, **plus** the day-scoped/whole-session figures it currently lacks (§6, §23) |
| `treasury.variance_reports` | ⚠️ **probably fold onto the parent** | A one-column child 1:1 with its parent does not earn a table. **Decide after DC-R2**, since the definition precedes the placement |
| **`UNIQUE (tenant_id, branch_id, business_day)`** | ✅ | one close per branch-day (§14, §18) |
| **`UNIQUE (tenant_id, branch_id, z_number)`** | ✅ | `FR-FIN-023` structural backstop (§13) |
| **`UNIQUE (tenant_id, day_close_id, cash_session_id)`** | ✅ | linkage cardinality (§23) |
| **partial `UNIQUE (tenant_id, cash_session_id) WHERE <owner>`** | ⚠️ | variance ownership — **blocked on DC-R2** (§22). Precedent: `cash_sessions`' one-open-session-per-drawer partial unique index |
| **UNCONDITIONAL `UNIQUE (tenant_id, cash_session_id)`** | ❌ **FORBIDDEN** | §5.4 |
| Branch Z sequence / allocator table | ❌ | `MAX+1` + unique constraint (§13); no sequence object, no allocator row, no trigger |
| `RLS ENABLE + FORCE` + select/insert policies | ✅ | every new table |
| `GRANT SELECT` + **column-level** `GRANT INSERT` excluding DB-generated timestamps; `REVOKE UPDATE, DELETE, TRUNCATE` | ✅ | `FR-FIN-023` immutability, DB-enforced (§12) |
| FKs | ✅ | `closed_by → identity.users(id)` **verbatim from approved SQL**; employee via the tenant-safe composite; `cash_session_id` via `(tenant_id, branch_id, id)` on `cash_sessions` (that target **already exists**: `uq_cs_branch_scoped_id`) |
| Indexes | ✅ | retrieval by `(tenant_id, branch_id, business_day)`. **Blocker check needs none** — `@@index([tenantId, branchId, status])` already exists |
| **`cash_sessions.business_day` column** | ❌ **NOT ADDED** | §5 proves it unnecessary and incorrect |
| Any change to accepted Sales/Payment/CashSession code paths | ❌ | none required |
| Legacy-data compatibility | ✅ **mandatory check** | New tables only ⇒ no backfill. **But the P1G-1 migration-compatibility method still applies**: execute against real pre-existing data before claiming clean |

---

## §28. `FR-FIN-026` / INTERNAL-MVP SEQUENCING PACKET

**Implemented now:** `FR-FIN-020` (per-branch close operation) · `FR-FIN-021`
(block + blocking list, **both limbs, fully**) · `FR-FIN-023` (sequential
per-branch Z number, DB-enforced immutability, historical retrieval — retrieval
**subject to DC-R3**) · `FR-FIN-024` (**already COMPLETE**, reused) · the
class-A/B/C limbs of `FR-FIN-022` (§8).

**Remains NOT IMPLEMENTED, named exactly:**

| Item | Reason | Reopened by |
|---|---|---|
| `FR-FIN-022` — **tax by rate** | components not persisted (§9) | a Tax/Fiscal component-persistence slice |
| `FR-FIN-022` — **sales by category** | no category snapshot on `order_lines`; master data mutable + many-to-many (§8 #6) | a Sales BR-POS-004 category-snapshot slice |
| `FR-FIN-022` — **comp** half of void-and-comp | no comp mechanism | a Comp slice |
| `FR-FIN-022` — **sales by tender** PARTIAL | RPT-R2 cl. 8 | `FR-POS-064` / tender-family slices |
| `FR-FIN-025` | `[S]`; no scheduler (§24) | a scheduler slice |
| `FR-FIN-026` limb 1 — fiscal finalisation | no fiscal entity exists; **P1C-1** (§11) | the Receipt/Fiscal decision |
| `FR-FIN-026` limb 2 — inventory day-end snapshot | no dated snapshot table exists | an Inventory day-end slice |
| `FR-FIN-026` limb 3 — report pre-aggregation | **RPT-R2 forbids it** | a future Reporting-warehouse ratification |
| `FR-FIN-026` limb 4 — accounting export | `FR-RPT-043` NOT IMPLEMENTED; **no outbox** (`FR-PLT-041`) | an outbox + export slice |

**Why this is not a waiver:** every item stays an **open, unmet `[M]`
requirement** counted against its domain, exactly as RPT-R2 cl. 3 recorded
`FR-RPT-001/002/003/005` and as `FR-SEC-032` is recorded under D-2. **No
artefact may state or imply that any of them is waived, reinterpreted, or
complete.**

---

## §29. USER RATIFICATIONS — EXACTLY THREE

### **DC-R1 — Internal-MVP DayClose sequencing** *(scope acceptance, not a waiver)*

> Authorise building the **Internal-MVP operational DayClose** now — `FR-FIN-020`,
> `FR-FIN-021` in full, `FR-FIN-023`, and the derivable limbs of `FR-FIN-022` —
> **while `FR-FIN-022` and `FR-FIN-026` remain explicitly PARTIAL / NOT
> IMPLEMENTED** as itemised in §28, with the §10 wording rules binding on every
> artefact.

**Recommended: YES.** It is the exact shape RPT-R2 already established. The
alternative blocks the whole cash-accountability ceremony on presentation limbs
whose data does not exist.

### **DC-R2 — Spanning-session variance ownership** *(genuine business semantics)*

> When one CashSession's payments span two business days, **which DayClose owns
> its whole-session variance** for `FR-FIN-022`'s variance summary?

Options in §22. **This gate does not recommend a business answer.** It records
only that **A/B/C are structurally unsound** for an immutable document (they
duplicate or misattribute), leaving **D** *(the DayClose that first seals it)* and
**E** *(whole-branch delta since the previous DayClose)* as the sound candidates.
**Until DC-R2 is answered, the variance summary cannot be implemented and its
partial-unique constraint has no predicate.**

### **DC-R3 — Historical Z read authority** *(source-silent permission)*

> Which permission authorises `GET .../day-closes/{businessDay}`?
>
> **(a)** ratify a **new** read code — the KDS-R11 / RPT-R1 precedent for an
> absent Appendix C *(recommended: it keeps write and read authority separate,
> which is the discipline `treasury.controller.ts` already enforces)*;
> **(b)** extend `report.view.financial` — **requires explicitly reopening
> RPT-R1's non-broadening clause 8**;
> **(c)** defer the retrieval route — follows Treasury's *"withdrawn rather than
> misauthorised"* precedent but **leaves `FR-FIN-023` [M] partly unmet**;
> **(d)** reuse `cash.day.close` — **this gate refuses to recommend it**: it
> converts a write authority into a read authority, the exact reinterpretation
> the repository already rejected.

### **NOT put to the user** (settled by source or classified as mechanics)

`cash.day.close` permission · Treasury ownership · `day.closed` event and payload ·
the `FR-FIN-021` no-open-session check and its blocker set · schema/table/column/
index/constraint naming · RLS mechanics · audit action literal · idempotency
design · transaction/concurrency model · session type · the open-orders finality
precondition (**disclosed engineering consequence**, §15) · the branch
fail-closed posture (**implementation consequence**, §16) · tax-by-rate
*semantics* (§9 — the data does not exist; only sequencing is decidable).

---

## §30. IMPLEMENTATION DEFINITION OF DONE

**Structural**
1. Migration 35 applies **cleanly from zero** on a fresh scratch DB (persistent
   `ros` untouched and re-verified); `prisma validate` clean; migration count 34 → 35.
2. Every new table: `RLS ENABLE` **and** `FORCE`, select+insert policies,
   `GRANT SELECT` + column-level `GRANT INSERT`, `REVOKE UPDATE, DELETE, TRUNCATE`.
3. **Immutability proven as an unprivileged `NOBYPASSRLS` role**: `UPDATE` and
   `DELETE` on a sealed DayClose both fail.
4. All uniqueness constraints present; **no unconditional
   `UNIQUE (tenant_id, cash_session_id)`**; no `cash_sessions.business_day` column.
5. Composite tenant-safe FKs (ADR 0008 D-09) on every new edge.

**Behaviour**
6. Branch safety: explicit `branchId`; tenant-safe 404; 0 / >1 active branches ⇒
   403; mismatch ⇒ 403 — **all inside the write transaction**.
7. `@Idempotent()`: 400 without key; exact replay ⇒ stored response +
   `Idempotent-Replay: true`; fingerprint conflict ⇒ 409; in-flight ⇒ 409.
8. **Blocker tests:** an `open` session blocks; a **`closing`** session blocks;
   a **zero-payment** session blocks; a **movement-only** session blocks; a
   **spanning** session blocks while unclosed; the 409 body **lists** them
   (`FR-FIN-021` limb 2).
9. **Finality tests:** an open order of the target day blocks (§15); a future or
   current business day ⇒ 400.
10. **Concurrency, deterministic barriers only — no sleeps:**
    (a) two concurrent closes for the same branch-day ⇒ exactly one succeeds,
    the other 409 (never two rows, never two Z numbers);
    (b) **a session opened concurrently after the blocker read** ⇒ the close
    either retries and 409s, or fails — **never seals over an open session**
    (the §15 Race 1 proof);
    (c) a concurrent late payment into the target day ⇒ serialization conflict,
    not a silently stale Z;
    (d) a `SerializationRetryExhaustedError` surfaces as **409**, never 422.
11. **Z number:** starts at 1 per `(tenant, branch)`; strictly increasing under
    concurrency; never reused; a rolled-back attempt consumes none.
12. **Historical retrieval** returns a byte-stable snapshot; a DayClose sealed
    before a subsequent `org.branches.timezone` / `base_currency` / cutover
    change is **unchanged** by it (the regression test that proves no derivation
    from mutable config).
13. **Z field identities** asserted as exact bigint arithmetic:
    `net = gross − discounts − refunds − tax`; per-tender sum = tender grand
    total; the corrected three-term tender identity preserved; AOV = RPT-R3.
14. **Honest status surfaced on the response** — the scope/limitations block
    names tax-by-rate and sales-by-category as NOT IMPLEMENTED, the comp summary
    as structurally zero, sales-by-tender as PARTIAL. **No artefact claims
    `FR-FIN-022` complete.**
15. Variance summary implements **exactly** the DC-R2 semantics, with a
    spanning-session test proving **no double count**.
16. `day.closed` published once per successful close, inside the UoW, with the
    §5.5.4 envelope; **not** republished on an idempotent replay; **not** leaked
    on a rolled-back retry attempt.
17. Audit: one `DAY_CLOSED` entry in the same transaction, hash-chain intact,
    `before` null; **no audit on the GET**.

**Hygiene**
18. Module boundaries: **zero `KNOWN_DEVIATIONS` growth**; every cross-module
    read via a public `contract/` token; Reporting still owns zero tables.
19. Full e2e green on a **clean from-zero scratch database**; OpenAPI regenerated
    as a **pure addition** (110 → 112 paths), drift-detection passing.
20. `tsc --noEmit` (no **new** errors vs. the known pre-existing
    `access-token.service.spec.ts` one), scoped ESLint 0/0, `nest build`,
    `prisma validate`, `git diff --check` all clean.
21. No `console.*`, no `.skip(`/`.only(` in any new file.

---

## §31. WHAT THIS TASK DID AND DID NOT DO

**Did:** verified the baseline; read the SRS, register and repository at
`7bc5d2c`; produced this gate; appended **exactly one** `INDEX.md` row.

**Did NOT:** implement product code · create or modify a migration · modify the
Prisma schema · add a route or permission · edit governance · regenerate
OpenAPI · run any test suite · stage · commit · push · deploy · perform any
destructive git operation · touch the five unrelated dirty reports or their
`INDEX.md` rows.

---

## §32. VERDICT

> # **B. DAYCLOSE READY AFTER NARROW USER RATIFICATION**
>
> **DC-R1** (Internal-MVP sequencing — `FR-FIN-022`/`026` stay PARTIAL) ·
> **DC-R2** (spanning-session variance ownership) ·
> **DC-R3** (historical Z read authority).
>
> **DC-R2 and DC-R3 are hard-blocking** for the variance summary and the
> retrieval route respectively. **DC-R1 is scope acceptance.** Everything else in
> this gate is source-decided or engineering mechanics.

---

*End of report. **Non-authoritative evidence.** The SRS and the ratified
governance decisions remain authoritative. No prior report is modified; the four
corrections in §2.3/§2.4 — including one to my own prior report's false claim
that SERIALIZABLE had no repository precedent — are recorded against current
source and leave every prior report byte-unchanged.*

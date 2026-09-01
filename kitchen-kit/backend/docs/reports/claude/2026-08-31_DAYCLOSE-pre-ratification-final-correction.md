# DAY CLOSE — Pre-Ratification Final Correction

| Field | Value |
|---|---|
| **Task / slice name** | DAY CLOSE — final pre-ratification correction (legacy attribution · resolver ownership · cutover race) |
| **Report type** | Design correction. **No implementation.** No migration, no schema change, no source change, no route, no permission, no governance edit, no commit, no push, no deploy. No agents/forks launched. |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report corrects two implementation-safety points left unresolved by `2026-08-31_DAYCLOSE-final-design-gate.md` and `2026-08-31_DAYCLOSE-design-gate-acceptance-correction.md`. **Both are preserved byte-unmodified**; where they differ from this report, **this report governs**. DC-R1/DC-R2/DC-R3 are **not reopened**. |
| **Date** | 2026-08-31 |
| **HEAD** | `7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c` |
| **Branch** | `feat/production-spec` |
| **Working tree** | Dirty **only** in `docs/reports/claude/`. **Zero** source / schema / migration / test / OpenAPI drift. 34 migrations. |
| **Task identifier** | DAYCLOSE-pre-ratification-final-correction |
| **Status** | COMPLETE |
| **Tests** | **No test suite executed in this session.** Every claim below is traced to a source path and line. |

---

## §0. VERDICT

> # **A. DAYCLOSE PRE-RATIFICATION CORRECTION CLEAN — RATIFICATIONS READY**
>
> **§1 — No safe backfill exists. Proven.** Resolved by a fail-closed
> **DayClose activation epoch** (smallest durable mechanism, one immutable
> Treasury row per branch). No speculative backfill, no silent variance loss,
> no retroactive Z.
>
> **§3 — THE CUTOVER RACE IS REAL.** Traced through the actual
> `OrdersService.create` transaction. **Both transactions can commit today.**
>
> **§4 — Resolved by TWO existing primitives, no invention:** DayClose
> **participates in the already-existing `ros_order_number` (branch,
> business-day) advisory lock**, and Order creation gains a **closed-day check**
> through an additive **public Treasury contract** on a **module edge that
> already exists in both directions** with zero deviations.
>
> **Two further corrections fall out and are recorded:** SERIALIZABLE is
> **withdrawn** as DayClose's isolation level (it would not abort this race, and
> `withAuthContext`'s first statement takes the snapshot *before* any lock wait);
> and the Z-number collision is handled by a **local bounded retry**, not a new
> lock.
>
> **Still exactly THREE user decisions. No fourth is created — no business
> semantic was discovered.** *(Not verdict E.)*

---

## §1. BASELINE

```
git rev-parse HEAD        -> 7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c   MATCH
git branch --show-current -> feat/production-spec                        MATCH
migrations                -> 34
```

`git status --short --untracked-files=all` returned **only** `docs/reports/claude/`
paths. **Nothing outside it.** Both prior DayClose reports were **read, not
modified**. **BASELINE UNCHANGED — not verdict F.**

---

## §2. LEGACY CLOSED-SESSION ATTRIBUTION

### 2.1 The problem, stated precisely

A legacy CashSession may hold `status = 'closed'`, `closed_at != NULL`,
`closed_business_day = NULL`. Under **DC-R2 (close-business-day ownership)** its
whole-session variance has no owner. **Production databases are not assumed
empty** — the P1G-1 migration-compatibility closure recorded **real pre-existing
`open` and `closed` `cash_sessions` rows** in the development database, and that
report's whole method exists because such rows aborted a previously-planned
CHECK.

### 2.2 Q1 — Can `closed_business_day` be safely backfilled? **NO.**

Every candidate source was enumerated and each fails:

| Candidate anchor | Why it fails |
|---|---|
| `cash_sessions.closed_at` + timezone/cutover | **Forbidden and unsound.** `org.branches.timezone` is updatable (`branches.service.ts:149-150`); `org.operating_hours` rows are creatable with **no** unique constraint on `(branch_id, day_of_week)` and `cutoverLookup` applies **no `ORDER BY`** (`business-day.ts:141-146`), so the effective cutover is mutable and can even be non-deterministic. This is *manufacturing historical timezone correctness* |
| `MAX(order_payments.business_day)` over the session's payments | **Wrong quantity.** It yields the last day the session **traded**, not the day it **closed**. A session that traded on `D` and closed on `D+2` would be misattributed. **And it is unavailable at all for a zero-payment or movement-only session** — precisely the sessions DC-R2 exists to reach |
| `cash_movements` | Carries `occurred_at` only — **no `business_day` column** |
| `cash_session_close_attempts` | Carries `declared_at` / `created_at` — **no `business_day` column**; and an attempt may exist for a session that was never approved |
| `workforce.shifts` | **No `business_day` column**, and no close command exists at all (`ros_app` holds no `UPDATE` privilege on it) |

> ### **Q2 — There is NO immutable source to prove from. Q1 = NO.**
> For a zero-payment or movement-only legacy session there is **no immutable
> business-day anchor anywhere in the schema**. Any backfill would be
> speculation.

### 2.3 Q3 — The fail-closed upgrade rule

**Shape A is selected** — *a Treasury-owned DayClose activation row per
`(tenant, branch)` recording the first business day eligible for authoritative
DayClose/Z creation.*

**Shape B (a timestamptz attribution epoch) is rejected**: turning an instant
into "the business day that contained it" requires the mutable
timezone/cutover derivation §2.2 forbids, and an error there could *un-block* a
day containing NULL-closed sessions — unsafe in the wrong direction.
**Organisation is untouched** — no mutable historical semantics are placed there.

#### The mechanism

```
treasury.day_close_activations
  tenant_id, branch_id, activation_business_day DATE, activated_at, activated_by
  UNIQUE (tenant_id, branch_id)          -- exactly one per branch, immutable
```

- Created **lazily and idempotently on the FIRST DayClose request for a branch**,
  inside that same transaction, recording
  `activation_business_day = branchCurrentBusinessDay` **at that live instant**,
  computed by the authoritative resolver (§3) from `new Date()`.
  **This is a live-clock derivation, not a historical one** — the §2.2 hazard
  does not apply.
- **Written by the application, never by the migration.** A migration-time
  backfill would have to re-implement `resolveBusinessDay` in SQL — a **second
  business-day algorithm**, which is forbidden.
- Immutable: `SELECT` + column-level `INSERT`, **no `UPDATE`, no `DELETE`**
  (the accepted `cash_close_policies` grant pattern).

#### Eligibility rule

```
activation_business_day  <  targetBusinessDay  <  branchCurrentBusinessDay
```

**Why the activation day itself is excluded:** the branch's business day that is
*current* at activation may contain sessions closed **before** migration 35
(`NULL`) and others closed **after** it (populated). It is therefore
provably ambiguous. Every day **strictly after** it is entirely post-migration
and fully covered.

### 2.4 The exact answers

| Question | Answer |
|---|---|
| **First closable business day after activation** | `activation_business_day + 1`, and it becomes closable once `branchCurrentBusinessDay ≥ activation_business_day + 2` (the strictly-past rule) |
| **A requested OLDER day** | **Refused — 409**, naming the branch's first closable business day. It is a resource-state conflict, not a malformed request |
| **The very first request for a branch** | **Always refused (409)** — it *activates* the branch and reports the first closable day. This is deliberate, self-documenting, and fail-closed: `target < current` and `target > activation = current` cannot both hold |
| **Legacy `NULL` rows** | **Retained honestly. Never backfilled, never inferred, never deleted.** `closed_business_day IS NULL` on a closed row is itself the relational discriminator — the exact pattern P1G-1 already uses for `close_attempt_id` on legacy closed rows |
| **Can a legacy `NULL` row appear in a new variance summary?** | **NO — structurally.** The summary selects `WHERE closed_business_day = :targetDay`; `NULL` never equals a value in SQL. There is no code path by which it could be included |
| **Is that silent variance loss?** | **NO.** No Z is ever produced for any day a legacy session could belong to — every such day is `≤ activation_business_day` and therefore permanently ineligible. The variance is **not omitted from a Z that claims completeness; no Z for those days exists at all.** The distinction is the whole point of the activation rule, and the response's scope block states it |
| **`FR-FIN-023` historical retrieval** | **Retrieval of PERSISTED DayClose/Z records ONLY.** A `GET` for a day with no DayClose row returns **404**. **The system never retroactively manufactures a Z** for a date before DayClose existed. *"Retrievable for any historical date"* obliges the system to be able to return any Z it has sealed; it does not oblige it to invent Zs for dates that predate the capability — and inventing one would be an unauditable fabrication of a statutory record |

### 2.5 Classification

> **This is an engineering migration/upgrade mechanic.** Source is silent on
> upgrade paths, and every option that touches business meaning was rejected in
> favour of the option that refuses to claim anything it cannot prove.
> **No fourth ratification is created.**

---

## §3. THE AUTHORITATIVE `closedBusinessDay` RESOLVER

### 3.1 Where the one implementation lives

`src/modules/sales/orders/business-day.ts` — `resolveBusinessDay()` +
`cutoverLookup()`. Its docblock records that it is deliberately the single copy:
*"This is the ONE place this lookup is built; `OrdersService` … and Sales'
`DAILY_TRADING_SALES_QUERY` … both import it from here rather than each keeping
their own copy — a second copy would risk silently diverging."*

**`resolveBusinessDay` is NOT duplicated. No new algorithm is created.**

### 3.2 The exact dependency path

Treasury needs *"the branch's business day right now"* at CashSession final
close. That is **exactly** the existing public contract method:

```
DAILY_TRADING_SALES_QUERY.currentBusinessDay(tx, { tenantId, branchId })
  → resolveBusinessDay(new Date(), branch.timezone, cutoverLookup(branch.operatingHours))
    (daily-trading-sales.query.service.ts:48-74 — verified this session)
```

`tx`-first, live clock, one implementation.

### 3.3 Module direction — the edge already exists, in both directions

| Fact | Evidence |
|---|---|
| Treasury already imports `SalesModule` | `treasury.module.ts:7` |
| Sales already imports `TreasuryModule` | `sales.module.ts:10` |
| The **module-level circular import is already resolved with `forwardRef()` on BOTH sides** — *"a genuine module-level circular import … there is no circular PROVIDER"* | `sales.module.ts:68-70`, `:97-98` |
| Treasury already consumes a **public Sales contract** | `cash-session-close.service.ts:65-66` (`CASH_SESSION_TENDER_TOTALS_QUERY`) |
| Sales already consumes a **public Treasury contract** | `sales-payment.service.ts:20-21` (`CASH_SESSION_FACTS_QUERY`) |
| `KNOWN_DEVIATIONS` for either direction | **none exist, and none is needed** — every edge is a public `contract/` token |

> ### **No new cycle. No new module edge. No private import. `KNOWN_DEVIATIONS` growth = ZERO.**

### 3.4 Recommendation

**Add a small additive PUBLIC Sales contract** — e.g.
`BUSINESS_DAY_QUERY.currentBusinessDay(tx, { tenantId, branchId })` — whose
implementation **delegates to the same `business-day.ts` functions**, and have
both Treasury (for `closedBusinessDay`) and the existing
`DAILY_TRADING_SALES_QUERY` use it.

**Why not simply reuse `DAILY_TRADING_SALES_QUERY`?** It would work mechanically
and adds nothing, but that token is semantically *"daily trading facts for the
reporting read surface"*; a CashSession close reaching into it to learn today's
date couples an accepted reporting contract to an unrelated consumer. The
additive token costs one file, duplicates **no logic**, and keeps each contract's
meaning honest. *(Reusing the existing token is an acceptable fallback and is
recorded as such — it is a naming judgement, not a correctness one.)*

**Long-term ownership, recorded but NOT acted on:** the cutover column is
`org.operating_hours.business_day_cutover` and `FR-FIN-024` is a Finance
requirement, so Organisation is arguably the correct owner. Moving it would
touch accepted Sales **and** Reporting code for **no functional gain**, so it is
**not done here**. **Not a blocker — not verdict D.**

---

## §4. THE CUTOVER RACE — TRACED FROM CURRENT SOURCE

### 4.1 The real `OrdersService.create` transaction

Every fact below was read this session from `src/modules/sales/orders/orders.service.ts`.

| # | Fact | Line |
|---|---|---|
| 1 | **`at` is computed BEFORE the transaction opens** — `const at = input.at ?? new Date()` | `:175` |
| 2 | `at` is **not client-suppliable** — the controller never passes it (`orders.controller.ts:341-356` passes `originDeviceTime`, never `at`) | verified |
| 3 | The transaction is `this.prisma.withAuthContext(...)` with **NO `isolationLevel`** ⇒ **READ COMMITTED** | `:177-180`; `prisma.service.ts:56-72` |
| 4 | `businessDay = resolveBusinessDay(at, …)` is derived **inside** the transaction, from the **pre-transaction** `at` | `:224-228` |
| 5 | **`pg_advisory_xact_lock(hashtext('ros_order_number'), hashtext(`branchId:businessDay`))`** is taken inside `allocateOrderNumber`, **before** the Order INSERT, and is **transaction-scoped** (held to commit) | `:112-116` |
| 6 | `tx.order.create(...)` — **same transaction** | `:239` |
| 7 | **No CashSession is required or read** by order creation | absent throughout |
| 8 | Predicates read: `terminals`, `branches` (+`operating_hours`), `employees`, `order_number_blocks`. Written: `order_number_blocks`, `orders`, `audit_entries` | `:180-280` |

### 4.2 The race — **CAN BOTH COMMIT? YES.**

```
T2  BEGIN (READ COMMITTED)                     ← at = new Date() captured BEFORE this
    resolveBusinessDay(at) → D                   (at is pre-cutover)
    pg_advisory_xact_lock('ros_order_number', "branch:D")
    … block allocation …
                                    ── cutover occurs; branchCurrentBusinessDay → D+1 ──
T1                                  BEGIN DayClose(D):  D is now strictly past
                                    reads: no open sessions ✓ ; openOrderCount(D) = 0 ✓
T2  INSERT orders(business_day = D, state='draft')
    COMMIT                                                       ← succeeds
T1                                  INSERT day_closes(D) ; COMMIT ← succeeds
```

> ## **BOTH COMMIT. The sealed Z for D is missing a committed order. THE RACE IS REAL.**

**It is narrow but genuine:** `at` is server-clock and cannot be back-dated by a
client (fact 2), so the window is bounded by one request straddling the cutover
instant — a nightly occurrence at exactly the hour `FR-FIN-025` designates for
automatic close.

### 4.3 Why the existing mechanisms do NOT close it

**The `ros_cash_session` advisory lock does not apply.** Order creation
**never touches a CashSession** (fact 7) and never takes that lock. The two
transactions share **no** serialization mechanism through it. *(The prior
correction's §3 case C used that lock only for **payments**, where both sides do
take it — that reasoning stands and is unaffected.)*

**SERIALIZABLE would NOT abort this, and would additionally be unsafe here:**

```
T1 (DayClose) reads  orders WHERE (tenant, branch, business_day = D)
T2 (OrderCreate) writes an order into that predicate     ⇒  T1 --rw--> T2

T2 reads terminals / branches / employees / order_number_blocks
T1 writes day_closes / day_close_sessions / audit_entries
⇒ T2 reads NOTHING T1 writes  ⇒  no inbound antidependency  ⇒  NO PIVOT, NO CYCLE
```

A single unidirectional rw-antidependency serializes validly as **T1 before T2**
and **both commit** — the identical structure the previous correction already
withdrew for the late-session case.

> ### **FURTHER CORRECTION — SERIALIZABLE IS WITHDRAWN AS DAYCLOSE'S ISOLATION LEVEL.**
> Beyond not aborting this race, it would be **actively unsafe combined with a
> blocking lock**: `withAuthContext`'s **first statement** is
> `SELECT set_config('app.user_id', …, 'app.tenant_id', …)`
> (`prisma.service.ts:62-66`) — a snapshot-acquiring statement. Under
> REPEATABLE READ / SERIALIZABLE the transaction snapshot is therefore fixed
> **before** any advisory-lock wait, so a DayClose that blocks on a lock would
> resume with a snapshot that **predates the lock holder's commit** and could
> seal a day while blind to the very order it waited for. *(This is the same
> class of defect the P1G-1 final acceptance closure found and corrected when
> `transaction_timestamp()` aged across a lock wait.)*
>
> **DayClose runs at READ COMMITTED — the `withAuthContext` default, matching
> every other Treasury and Sales write path.** Coherence for the target day is
> supplied by the **fence** (§4.4), not by the isolation level.

### 4.4 The solution — **Option C + Option B together. Both are required.**

> **Neither alone is sufficient. This is the load-bearing point of §4.**

#### C — DayClose participates in the **existing** `(branch, business-day)` advisory lock

```
pg_advisory_xact_lock( hashtext('ros_order_number'), hashtext(`${branchId}:${businessDay}`) )
```

**No lock is invented.** This exact primitive already exists (fact 5), on exactly
the `(branch, business-day)` key space DayClose needs, and **§24.6.4 explicitly
sanctions pessimistic locking for order-number allocation** — the one use this
key serves. DayClose becomes a **second consumer of an existing lock**, adding
no new key space and no new lock-ordering (it takes only this one lock, so no
deadlock cycle is possible). *(Stated plainly rather than dressed up: a second
consumer **is** a new use, and the lock's `ros_order_number` name becomes
narrower than its actual role — a documentation-only note belongs in
`business-day`/`allocateOrderNumber`.)*

**Why C alone fails:** after DayClose commits and releases the lock, the waiting
order-create transaction simply proceeds and inserts `Order(business_day = D)`
into the now-sealed day. **The lock orders the two transactions; it does not
tell the loser to stop.**

#### B — Order creation checks the persisted DayClose, **inside its own transaction, after the lock**

An **additive public Treasury contract**:

```
DAY_CLOSE_STATE_QUERY  (Treasury, tx-first)
  isClosed(tx, { tenantId, branchId, businessDay }) : Promise<boolean>
```

consumed by `OrdersService.create` **immediately after the existing advisory-lock
acquisition and before the Order INSERT**. If the day is closed ⇒ refuse
(**409**, *"that business day is closed"*).

- **Sales → Treasury public-contract consumption already exists** with zero
  deviations (`sales-payment.service.ts:20-21`), on a module edge already
  `forwardRef`-resolved in both directions (§3.3). **No new cycle, no private
  query, zero `KNOWN_DEVIATIONS` growth.**
- **Why C alone is still needed:** without the lock the check is a TOCTOU — the
  DayClose could commit between the check and the INSERT.

#### The proof, both directions

| Interleaving | Outcome |
|---|---|
| **T2 acquires the lock first** | T1 blocks. T2 commits `Order(D)`. T1 acquires the lock and — **under READ COMMITTED, with fresh per-statement snapshots** — reads `openOrderCount(D) = 1` ⇒ **409, close refused.** ✓ |
| **T1 acquires the lock first** | T2 blocks. T1 commits `DayClose(D)`. T2 acquires the lock, calls `isClosed(D)` ⇒ **true** ⇒ **409, order refused.** ✓ |

> **No post-close Order can commit into a closed business day. Deterministic,
> testable with a two-party barrier, no sleeps.**

#### Z-number collision — a **local** bounded retry, no new lock

Two DayCloses for **different** past days at one branch take **different** lock
keys and do not exclude each other; both may compute `MAX(z_number)+1`.
`UNIQUE (tenant_id, branch_id, z_number)` makes duplication **impossible**; the
loser raises a unique violation. Per the previous correction's distinction, the
**two constraints mean different things**:

| Violated | Meaning | Handling |
|---|---|---|
| `(tenant, branch, business_day)` | the day is genuinely already closed | **terminal → 409** |
| `(tenant, branch, z_number)` | transient allocation collision | **retried by a small bounded loop local to the DayClose service**, keyed on the constraint name |

**No advisory lock is added for numbering, `UnitOfWork` is not modified, and no
new isolation level is introduced.**

### 4.5 Requirements check

| Requirement | Met |
|---|---|
| No private cross-module query | ✅ both directions are public `contract/` tokens |
| No hidden advisory-lock invention | ✅ the lock already exists; its reuse is stated explicitly |
| No branch-aware RBAC change | ✅ D-2 untouched |
| No second business-day algorithm | ✅ §3 |
| No post-close Order into the closed day | ✅ §4.4 |
| Deterministic tests, no sleeps | ✅ §9 |
| Idempotency unaffected | ✅ the check precedes every write; a refusal releases the reservation normally, and the R-6(a) *"never throw after the durable write"* rule is preserved |
| Zero `KNOWN_DEVIATIONS` growth | ✅ §3.3 |

---

## §5. RE-DERIVED LATE PAYMENT / COMPLETION

With §4 in place, and claiming nothing beyond current source:

1. **No new Order can appear in a closed `D`** — §4.4, proven in both
   interleavings.
2. **No target-day open Order exists at DayClose commit** — the precondition is
   read **under the fence** (lock held, READ COMMITTED fresh reads), so it cannot
   be stale.
3. **`completed` and `cancelled` are terminal under current source** —
   `TRANSITIONS` gives `completed: []` and `cancelled: []`
   (`order-state.ts:87-88`); `assertMayCapturePayment` admits **only** `open` and
   `partially_paid` (`:226-234`); `assertOrderMutable` refuses every finalised
   state. `partially_refunded` / `refunded` have **no inbound transition** and are
   structurally unreachable.
4. **A later current-day CashSession cannot create new captured tender for `D`.**
   Payment capture requires a **non-finalised order** (3) **and** an `open`
   session (`sales-payment.service.ts:207`). After the close, every `D` order is
   terminal (2) and no new `D` order can be created (1) ⇒ **no payable `D` order
   can ever exist again**, regardless of how many sessions open later. Line
   addition and pre-fire void are excluded by the same `assertOrderMutable` gate.

> **Explicit revisit triggers — recorded, not overclaimed.** Any future
> **Refund**, **Comp**, **post-fire Void**, **adjusting entry**, or **offline
> sync** capability could write into a past business day and **would invalidate
> step 4**. Each must re-open this analysis. *(This mirrors the five-item revisit
> trigger the accepted Reporting design correction already recorded.)*

---

## §6. DC-R2 LEGACY CONSEQUENCE

**DC-R2's recommendation is unchanged: CLOSE-BUSINESS-DAY OWNERSHIP.** Preserved
exactly: a spanning session **may** link to multiple DayCloses for its day-scoped
tender contribution; whole-session variance is owned **once**; unconditional
`UNIQUE (tenant_id, cash_session_id)` remains **FORBIDDEN**.

| Session | How it gets ownership |
|---|---|
| **NEW closed session** (post-migration-35) | `closed_business_day` is written in the **same single UPDATE** that already writes `expectedCash`/`countedCash`/`variance` **exactly once at the `CLOSED` transition**, derived from the §3 resolver at that live instant, and joins the existing `ck_cs_core_facts_only_when_closed` CHECK. Owned by `DayClose(branch, closed_business_day)` — deterministic, no flag required (previous correction §4.4) |
| **LEGACY `NULL` session** | Owned by **no** DayClose, permanently and honestly. Excluded from every variance summary by `closed_business_day = :targetDay` (NULL never matches), and **no Z exists for any day it could belong to**, because every such day is `≤ activation_business_day` (§2.3) |

> ### **NO SILENT VARIANCE LOSS.**
> A legacy session's variance is **not dropped from a Z that claims to be
> complete** — it belongs to a day for which **no Z is ever produced**. The
> activation rule exists precisely to make that guarantee structural rather than
> a hope, and the response's scope block states it in words.

---

## §7. RATIFICATION PACKET — UNCHANGED, EXACTLY THREE

**No business semantic was discovered by this analysis.** Everything in §2–§6 is
migration/upgrade mechanics and concurrency engineering.

| | Decision | Recommendation |
|---|---|---|
| **DC-R1** | Internal-MVP DayClose sequencing while the named `FR-FIN-022` / `FR-FIN-026` limbs remain PARTIAL / NOT IMPLEMENTED | **YES** — binding nine-clause text unchanged (acceptance correction §6, with the §7 `FR-FIN-026` wording rule) |
| **DC-R2** | Spanning-session variance ownership | **CLOSE-BUSINESS-DAY OWNERSHIP** — unchanged; legacy consequence clarified in §6 |
| **DC-R3** | Historical Z read authority | **Extend the existing `report.view.financial`** to `GET /branches/{branchId}/day-closes/{businessDay}` — unchanged |

> **NO FOURTH DECISION.** The activation epoch (§2), the resolver contract (§3),
> the advisory-lock participation and the order-create closed-day check (§4), the
> READ COMMITTED correction, and the local Z-number retry are **all engineering
> mechanics**, consistent with how P1G-1 and RPT-R1/R2 classified the same class
> of item.

---

## §8. MIGRATION EXPECTATION — STILL **ONE** ADDITIVE TREASURY MIGRATION #35

**No migration is created by this task.** Conceptual objects, updated:

| Object | Status |
|---|---|
| `treasury.day_closes` (+ `tenant_id`, composite FKs, Z snapshot columns, DB CHECK identities) | unchanged from the gate |
| `UNIQUE (tenant_id, branch_id, business_day)` — **terminal** conflict | unchanged |
| `UNIQUE (tenant_id, branch_id, z_number)` — **retryable** conflict (§4.4) | unchanged |
| Z snapshot child tables (per tax class / tender / order type) | unchanged |
| `treasury.day_close_sessions` — `UNIQUE (tenant_id, day_close_id, cash_session_id)`; **no unconditional `UNIQUE (tenant_id, cash_session_id)`**; partial owner unique as defence-in-depth only | unchanged |
| **`treasury.cash_sessions.closed_business_day DATE NULL`** | unchanged — **NULLABLE**, no backfill (§2) |
| **`treasury.day_close_activations`** — **NEW in this correction** (§2.3): `(tenant_id, branch_id, activation_business_day, activated_at, activated_by)`, `UNIQUE (tenant_id, branch_id)`, immutable | **added to migration 35, not to a separate migration** |
| RLS `ENABLE` + `FORCE`, select/insert policies, `GRANT SELECT` + column-level `GRANT INSERT`, `REVOKE UPDATE, DELETE, TRUNCATE` on every new table | unchanged |
| Index for retrieval `(tenant_id, branch_id, business_day)` | unchanged |
| **No new index for the `FR-FIN-021` blocker** | unchanged — `@@index([tenantId, branchId, status])` already exists |
| **No `sales.*` schema change** | ✅ §4's Order-create change is **application code only** (one contract call), no column, no constraint |

---

## §9. CORRECTED DEFINITION OF DONE — ADDITIONS

All prior DayClose concurrency, idempotency, immutability, spanning-session and
variance tests are **preserved**. Added, all with **deterministic barriers, no
sleeps**:

### Legacy / activation
1. A pre-migration-style closed session (`status='closed'`,
   `closed_at != NULL`, `closed_business_day IS NULL`) **survives migration 35
   unchanged** — applied against real pre-existing rows, per the P1G-1
   migration-compatibility method.
2. **No silent inclusion:** such a session **never** appears in any Z variance
   summary.
3. **No silent exclusion:** the response's scope block **states** that
   pre-activation days are not closable and why.
4. **Pre-activation DayClose refused** — the **first** request for a branch
   activates it and returns **409** naming the first closable business day.
5. **Post-activation DayClose succeeds** for a day satisfying
   `activation < target < current`.
6. Activation is **idempotent and immutable** — a second request creates no
   second row and cannot change the first.
7. **Historical `GET` never manufactures a pre-activation Z** — returns **404**
   for a day with no persisted DayClose.

### Cutover race
8. **The exact §4.2 interleaving**, with a deterministic barrier: order creation
   begins and resolves `businessDay = D`; the cutover passes; `DayClose(D)`
   begins. **Assert that the end state is NEVER `committed DayClose(D)` +
   subsequently `committed Order(D)`** — one of the two must be refused with 409.
9. Both interleavings asserted separately: **lock-holder = order-create** ⇒ close
   refused (open order); **lock-holder = DayClose** ⇒ order refused (day closed).
10. An order for a **different** business day at the same branch is **not**
    blocked by an in-progress `DayClose(D)`.
11. **Order creation after a committed `DayClose(D)`** ⇒ **409**, deterministic,
    no barrier needed.

### Resolver / mechanics
12. `closedBusinessDay` is written **in the same transaction and same UPDATE** as
    the close facts, from the shared resolver — and **no second
    `resolveBusinessDay` implementation exists anywhere** (asserted structurally).
13. **DayClose runs at READ COMMITTED** — a guard test asserting the production
    path does not silently acquire `Serializable` (mirroring the KDS `D0 [GUARD]`
    discipline in reverse).
14. **Z-number collision across two different past days** at one branch ⇒ two
    distinct numbers, the collision **retried locally**, never a spurious
    terminal 409, and **never a duplicate**.
15. **Zero `KNOWN_DEVIATIONS` growth**; `module-boundaries.spec.ts` asserts the
    new Treasury and Sales contract tokens are consumed **only** via
    `contract/`.

---

## §10. WHAT THIS TASK DID AND DID NOT DO

**Did:** verified the baseline; read both prior DayClose reports **without
modifying them**; traced `OrdersService.create`, `withAuthContext`,
`allocateOrderNumber`, `currentBusinessDay` and both module wirings line by line;
produced this correction; appended **exactly one** `INDEX.md` row.

**Did NOT:** implement product code · create or modify a migration · modify the
Prisma schema or any source file · add a route or permission · edit governance ·
reopen DC-R1/DC-R2/DC-R3 · run any test suite · launch any agent or fork ·
stage · commit · push · deploy.

---

## §11. VERDICT

> # **A. DAYCLOSE PRE-RATIFICATION CORRECTION CLEAN — RATIFICATIONS READY**
>
> **Not B** — legacy attribution is resolved fail-closed by the activation epoch,
> with no speculative backfill and no silent variance loss.
> **Not C** — the cutover race is real, is proved from source, and is closed by
> two existing primitives plus one additive public contract.
> **Not D** — the resolver stays a single implementation on a module edge that
> already exists in both directions, with zero deviation growth.
> **Not E** — no new business semantic was discovered; every fix is engineering
> mechanics.
> **Not F** — baseline unchanged.

---

*End of report. **Non-authoritative evidence.** The SRS and the ratified
governance decisions remain authoritative. `2026-08-31_DAYCLOSE-final-design-gate.md`
and `2026-08-31_DAYCLOSE-design-gate-acceptance-correction.md` are preserved
**byte-unmodified**; this report governs where they differ, and everything they
settled that is not named here stands unchanged. It withdraws one further claim
made by this model — SERIALIZABLE as DayClose's isolation level — on evidence
gathered this session.*

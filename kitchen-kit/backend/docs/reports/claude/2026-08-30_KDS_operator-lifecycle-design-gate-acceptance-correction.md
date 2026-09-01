# KDS Operator Lifecycle — Design-Gate Acceptance Correction

| Field | Value |
|---|---|
| **Task / slice** | KDS MVP Operator Lifecycle — external review acceptance correction (3 blockers + secondary auth check) |
| **Report type** | Acceptance correction — ANALYSIS / DESIGN ONLY |
| **Authority statement** | **This report is NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the only authorities. Where this report and those sources differ, **those sources govern**. Nothing here is ratified; nothing here authorizes implementation. |
| **Date** | 2026-08-30 |
| **HEAD** | `121b889b23a20167ea47574d601ec115350addaa` — **re-verified unchanged** at the start of this task |
| **Branch** | `feat/production-spec` |
| **Working tree** | `M docs/reports/claude/INDEX.md` + 5 untracked reports (4 pre-existing + the design gate this corrects). **No source, schema, migration, governance file or test created or modified.** |
| **Migrations at HEAD** | 34 (unchanged) |
| **Tests** | None executed. No verification result is claimed as newly executed. |
| **Corrects** | `2026-08-30_KDS_operator-lifecycle-final-design-gate.md` — **NOT modified**, per instruction. This report supersedes its §13, §9, §6 and §23 where they differ. |
| **Task identifier** | KDS-GATE-CORRECTION-2026-08-30 |

---

## §0. SUMMARY OF THE CORRECTION

| Finding | Prior gate | Corrected position |
|---|---|---|
| **1. Multi-station readiness concurrency** | Claimed `readyOrderLineIds` computed from Kitchen's own tables was sufficient; cited `tickets.version` CAS | **The reviewer is correct. The prior claim was FALSE.** It is a textbook write-skew anomaly under READ COMMITTED, and `tickets.version` CAS provably cannot serialize two different Ticket aggregates. Corrected mechanism: **SERIALIZABLE isolation for the KDS bump/recall UoW with bounded deterministic retry.** |
| **2. `first_viewed` audit** | Proposed no audit entry | **The reviewer is correct.** A POST that writes persisted columns is a state-changing operation and FR-AUD-001 `[M]` admits no exception. Corrected: **one `TICKET_VIEWED` entry per newly-first-viewed Ticket; zero rows changed ⇒ zero entries.** |
| **3. ACT-09 one-station scope** | Allowed N stations per terminal ("naturally supports one screen, two stations") | **The reviewer is correct.** That does not mechanically enforce ACT-09. Corrected: **exactly one operative station per KDS terminal; 0 ⇒ 403; >1 ⇒ 403 fail-closed as unsupported for this slice.** |
| **4. Secondary auth** | Terminal-bound + station rule | **Strengthened**: terminal must exist, be `active`, and be of type **`kds`**; employee identity required for attributed actions. A POS or dashboard session holding `kds.operate` is now refused. |

**Migration remains NO — but for a re-argued reason, not a preserved one.** §1.6 sets out the migration-bearing alternative in full and rejects it on merit.

---

# §1. BLOCKER 1 — MULTI-STATION READINESS CONCURRENCY

## 1.1 The prior claim, withdrawn

The design gate §13 asserted that Kitchen computing `readyOrderLineIds` from its own `ticket_lines` was sufficient, and §25 test 7 asserted *"exactly one of the two transactions computes the line into `readyOrderLineIds`."*

> **That assertion was never proven and is false.** It is withdrawn.

## 1.2 The race, worked through explicitly

`OrderLine X` is routed to Grill (Ticket A) and Packaging (Ticket B) — FR-KDS-011 `[M]`. Both Kitchen rows exist, keyed by the P1E-5 unique `uq_ticket_lines_ticket_order_line (tenant_id, ticket_id, order_line_id)`, so **X has two distinct `ticket_lines` rows under two distinct Tickets.**

PostgreSQL default isolation is **READ COMMITTED** — `withAuthContext` passes no `isolationLevel` to `$transaction` (`prisma.service.ts:59`), so every transaction in this repository runs at the connection default.

```
 time │ T1 (Grill)                              │ T2 (Packaging)
──────┼─────────────────────────────────────────┼──────────────────────────────────────────
  t0  │ BEGIN (READ COMMITTED)                  │ BEGIN (READ COMMITTED)
  t1  │ UPDATE ticket_lines                     │
      │   SET status='bumped', ready_at, …      │
      │  WHERE id = <grill line for X>          │
      │  → 1 row (uncommitted)                  │
  t2  │                                         │ UPDATE ticket_lines
      │                                         │   SET status='bumped', ready_at, …
      │                                         │  WHERE id = <packaging line for X>
      │                                         │  → 1 row (uncommitted)
      │                                         │  ── NO BLOCK: different row ──
  t3  │ SELECT … FROM ticket_lines              │
      │  WHERE order_line_id = X                │
      │  sees: grill=bumped   (own write)       │
      │        packaging=queued (T2 UNCOMMITTED,│
      │                 invisible under RC)     │
      │  bool_and(…) = FALSE                    │
      │  → readyOrderLineIds = []               │
  t4  │                                         │ SELECT … FROM ticket_lines
      │                                         │  WHERE order_line_id = X
      │                                         │  sees: packaging=bumped (own write)
      │                                         │        grill=queued (T1 UNCOMMITTED)
      │                                         │  bool_and(…) = FALSE
      │                                         │  → readyOrderLineIds = []
  t5  │ ticket.bumped{ readyOrderLineIds: [] }  │
      │ COMMIT                                  │
  t6  │                                         │ ticket.bumped{ readyOrderLineIds: [] }
      │                                         │ COMMIT
```

**Final state:**
- `kitchen.ticket_lines` — both rows `bumped`. Correct.
- `sales.order_lines` for X — still `fired`. **WRONG.**
- **No further event will ever be published**, because no further bump will occur. UC-POS-01 step 7 is permanently unsatisfied for X.

This is **write skew**: two transactions each read a predicate the other is concurrently writing into, each sees a consistent-but-stale snapshot, and the conjunction of their decisions violates an invariant neither violated alone. Neither transaction did anything wrong in isolation.

### Why the anomaly is real and not merely theoretical

Two Tickets of the same order are bumped seconds apart by two different cooks at two different stations — this is **the normal case** FR-KDS-011 exists to describe, not an edge case. The window is the duration of a bump transaction.

## 1.3 Why `tickets.version` CAS does not serialize this — proven

The design gate cited `tickets.version` optimistic CAS. **It cannot help, and the reason is structural:**

- The Ticket projection CAS is `UPDATE kitchen.tickets SET version=version+1 WHERE id=$ticket AND version=$read`.
- T1's CAS targets **Ticket A** (`tickets.id = A`). T2's CAS targets **Ticket B**.
- Per the P1E-4 cardinality invariant, backed by `uq_tickets_order_station (tenant_id, order_id, business_day, station_id)` (`schema.prisma:1031`), **A ≠ B** — one Ticket per order *per station*, so a two-station order line necessarily produces two Ticket rows.
- **Two `UPDATE`s against two different rows take two different row locks and never conflict.** Neither CAS fails. Both `version` columns increment. No serialization occurs.

`tickets.version` correctly guards the *intra-ticket* race (design gate §11 case 2: two lines of the **same** ticket). It has **no reach whatsoever** across ticket aggregates. The prior report conflated the two races.

> **There is no existing Kitchen row that both transactions must write.** Ticket A and Ticket B share `order_id` as a *value*, but Kitchen holds no per-order row — the P1E-4 design deliberately has no `ticket_stations` join table and no per-order Kitchen aggregate. That absence is precisely why nothing serializes them.

## 1.4 A verified repository fact that currently MASKS this race — and why it must not be relied on

`AuditService.record` takes a **per-tenant transaction-scoped advisory lock** as its first statement (`audit.service.ts:62-66`):

```ts
await tx.$executeRawUnsafe(
  'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
  'ros_audit', event.tenantId,
);
```

Held until COMMIT/ROLLBACK. **Consequence: any two audited writes in the same tenant serialize from that point onward.** If a KDS bump wrote its audit entry *before* computing readiness, T2 would block at t2, T1 would commit, and T2's readiness SELECT would then see grill=bumped and correctly mark X ready.

**This is reported because it is true and because it explains why naive testing may not reproduce the bug — not because it is the fix.** It is rejected as the mechanism for four reasons:

1. **It is incidental.** The lock exists to order the audit hash chain, nothing else. Sales readiness correctness would silently depend on an unrelated module's implementation detail.
2. **It is statement-order-dependent.** Correctness would hold only while `audit.record` precedes the readiness SELECT. Any future refactor reordering them — entirely reasonable, since audit is conceptually last — reintroduces a silent data-correctness bug with no failing test.
3. **It serializes the entire tenant.** Every bump at every station of every branch of a tenant would queue behind every other audited write. That is a direct threat to **NFR-PERF-004 `[M]`** (1 s p95) and an unacceptable architectural coupling for a kitchen at peak.
4. **It is pessimistic locking**, which §24.6.4 confines to order-number allocation and count-session exclusivity. Deliberately *extending its purpose* to a third use would need the very justification §24.6.4 withholds.

**Design consequence:** the corrected design places the audit write **last**, so the correctness argument provably does not depend on the advisory lock, and the lock's serialization window is minimized.

## 1.5 Options evaluated

### Option A — SERIALIZABLE for the KDS bump/recall UoW, with bounded deterministic retry ★ **RECOMMENDED**

PostgreSQL's Serializable Snapshot Isolation (SSI) exists for exactly this anomaly.

**Proof that SSI detects it.** SSI aborts a transaction when it completes a *dangerous structure* — a cycle of read-write antidependencies. In §1.2:
- T1's readiness `SELECT … WHERE order_line_id = X` acquires a **SIREAD predicate lock** over that range of `ticket_lines`.
- T2 **writes into T1's read set** (the packaging row for X) ⇒ rw-antidependency T1 → T2.
- T2's own readiness SELECT acquires a SIREAD predicate lock over the same range.
- T1 **writes into T2's read set** (the grill row for X) ⇒ rw-antidependency T2 → T1.
- The two antidependencies form a cycle ⇒ **PostgreSQL aborts one transaction with SQLSTATE `40001` (`could not serialize access due to read/write dependencies among transactions`).**

The surviving transaction commits. The aborted one is **retried from the beginning**, and — because the winner has now committed — its readiness SELECT sees `grill=bumped` **and** `packaging=bumped`, computes `readyOrderLineIds = [X]`, and publishes `ticket.bumped` carrying it. Sales marks X ready. **Exactly once.**

This satisfies the reviewer's required disjunction precisely: *either one transaction observes the other's committed completion, or one is forced to abort and then recompute.* Under SSI it is always the second, resolving into the first on retry.

**It is not pessimistic locking.** SSI never blocks on SIREAD locks; they are bookkeeping that causes an *abort*, not a wait. §24.6.4's restriction is untouched. No `SELECT FOR UPDATE`, no advisory lock, is introduced.

**Repository feasibility — verified:**
- `@prisma/client@^7.9.1` and `@prisma/adapter-pg@^7.9.1` (`package.json:40-41`).
- `TransactionIsolationLevel.Serializable` is present in the generated client (`src/generated/prisma/internal/prismaNamespace.ts:6977`).
- `PrismaService.withAuthContext` calls `this.$transaction(async (tx) => …)` with **no options object** (`prisma.service.ts:59`) — Prisma's second parameter `{ isolationLevel, maxWait, timeout }` is simply unused today, so threading an **optional** level through is additive and changes no existing caller.
- `UnitOfWork.execute` is a single `withAuthContext` call (`unit-of-work.ts:134-157`), so a retry loop wraps it cleanly.

**Retry safety — proven against the existing machinery:**
- `correlationId`, `commandId` and `defaultCausationId` are computed **outside** the transaction (`unit-of-work.ts:129-132`), so they remain **stable across attempts** — the causal chain identifies one logical command, not one attempt.
- `DomainEventCollector` is constructed **inside** (`:135`), so each attempt starts with an empty, uncontaminated event queue.
- A rolled-back attempt leaves no audit row, no Kitchen write, no Sales write — the audit hash chain is recomputed cleanly on the next attempt because `sequence_no`/`previous_hash` are read inside the transaction.
- The `IdempotencyInterceptor` operates **outside** the transaction and stores only the final response, so a retry is invisible to FR-API-022 replay semantics.
- Handlers dispatched by `dispatcher.drain` are pure database work; re-executing them after a rollback is safe.

**Bounding:** `MAX_SERIALIZATION_ATTEMPTS = 3`. On exhaustion, surface **409 Conflict** with a reload invitation — matching the repository's existing convention for a lost optimistic race (`OrderVersionConflictError`, `order-state.ts:100-113`, *"the operation is permitted, it just lost a race… not 422, which reads as 'this can never work'"*).

**Detection predicate:** Prisma surfaces a serialization failure as `PrismaClientKnownRequestError` **`P2034`**. Because parts of the Kitchen path use `$queryRaw`, the predicate must **also** match a raw SQLSTATE `40001` (and `40P01` deadlock) surfaced as `PrismaClientUnknownRequestError`. Both are checked; **no other error is ever retried** — a genuine FK violation, a `TicketHeaderMismatchError` or a business rejection propagates on the first attempt, exactly as today.

**Scope:** opt-in. Only the KDS bump / bump-all / recall UoW requests `Serializable`. Fire, Payment, Completion, Cash Close and every other existing caller keep READ COMMITTED and are untouched.

**Costs, stated honestly:** two shared files change additively (`PrismaService`, `UnitOfWork`); SSI adds predicate-lock bookkeeping on the KDS path; a genuine conflict costs one extra round trip. Against NFR-PERF-004 this is acceptable — conflicts require two stations bumping the *same order line* within one transaction's duration, and the retry is a single re-execution of a short transaction.

### Option B — an existing shared optimistic serialization point

**Investigated; none exists.**
- `tickets.version` — §1.3, provably out of reach across aggregates.
- The audit advisory lock — §1.4: exists and would work, but is pessimistic, incidental, order-dependent, and tenant-wide. Rejected.
- **`sales.orders.version`** — the reviewer explicitly required this be analysed and not dismissed. Both Tickets *do* descend from one `sales.orders` row, so CASing it **would** serialize them. It is rejected on three independent grounds:
  1. **It breaks the module boundary outright.** Kitchen would have to `UPDATE sales.orders` — precisely what §5.2.3 forbids (*"A module MUST NOT query another module's tables"*), what `module-boundaries.spec.ts:1019-1026` mechanically blocks by scanning Kitchen for Prisma calls against Sales delegates, and what would add the first-ever `kitchen->sales` entry to `KNOWN_DEVIATIONS` — a list the suite asserts `toEqual` so that it can shrink but never grow.
  2. **POS ETag/If-Match consequences are severe, not incidental.** `orders.version` is the cashier's optimistic-concurrency token, surfaced as the `ETag` and demanded back as `If-Match` on line add and pre-fire void (`orders.controller.ts:715-722`). Every kitchen bump would silently invalidate every POS client's held ETag for that order. A waiter adding a drink to a table would receive **409 Conflict** because a cook bumped an unrelated burger seconds earlier — a spurious failure caused by a different actor in a different module, at exactly the busiest moment. `assertVersion` (`order-state.ts:242-250`) would fire on a race the cashier neither caused nor can reason about.
  3. It would make Kitchen throughput a function of POS contention on the same order, and vice versa.
- **`kitchen.branch_kds_config`** — a per-branch config row. Writing it to serialize would serialize every bump in the branch and abuse a configuration table as a mutex. Rejected.

### Option C — a Kitchen-owned readiness aggregate (MIGRATION REQUIRED: YES)

Genuinely evaluated, and specified here in full so the rejection is on merit.

```sql
CREATE TABLE kitchen.order_line_readiness (
  tenant_id      uuid  NOT NULL,
  order_line_id  uuid  NOT NULL,
  business_day   date  NOT NULL,
  stations_total     int NOT NULL,
  stations_completed int NOT NULL DEFAULT 0,
  ready_at       timestamptz NULL,
  PRIMARY KEY (tenant_id, order_line_id, business_day)
);
-- + ENABLE/FORCE RLS, tenant policy, composite FK to sales.order_lines
```

**How it would work.** The fire handler upserts the row with `stations_total = |resolution.stationIds|`. Each bump issues a **self-referencing increment** against the *shared* row:

```sql
UPDATE kitchen.order_line_readiness
   SET stations_completed = stations_completed + 1
 WHERE tenant_id=$t AND order_line_id=$x AND business_day=$d
RETURNING stations_completed, stations_total;
```

Because both transactions now update **one row**, the second blocks on the row lock; on release, READ COMMITTED re-evaluates the increment against the winner's committed value. Exactly one transaction observes `completed == total` and includes X in `readyOrderLineIds`. Deterministic, no aborts, no retries, no isolation change.

**Why it is rejected despite being correct:**
1. **It introduces derived state that must be kept consistent across five separate paths** — fire, amendment re-fire (an order line may acquire a new station if routing config changed between fires), bump, recall (must decrement), and cancellation (a cancelled line must reduce the effective total, or an all-cancelled line would never "complete"). Each is a drift opportunity, and the design gate §15 shows the cancellation path is not even reachable yet — so one of the five invariants could not be tested at all.
2. **It re-solves a problem the database already solves.** SSI is a general guarantee over *every* multi-row invariant in the bump path, including ones not enumerated here. The counter guards exactly one hand-identified invariant, and only for as long as its five paths stay correct.
3. **The increment-to-serialize is a lock in disguise.** Its serializing effect, not its stored value, is what supplies correctness — which is the substance of §24.6.4's concern even though no `FOR UPDATE` appears.
4. It adds a per-order-line hot row and a migration, for a strictly narrower guarantee than Option A.

**MIGRATION REQUIRED remains NO — and this is not cosmetic preservation.** Option C was designed to the schema level and rejected on the four grounds above. Had no isolation-level route existed, C would have been recommended and the answer would have been YES.

### Option D — repository-native alternatives

- **Push the decision to Sales** (payload carries `stationsTotal`; Sales counts stations it has seen). Requires Sales to persist per-station progress — a Sales migration, and it duplicates Kitchen's state inside Sales. Strictly worse on boundary and cost.
- **Emit per-line `ticket.bumped` and let Sales infer completion.** Same counting problem, plus it contradicts §5.5.4's ticket-scoped event name.
- **Defer readiness to a later reconciliation pass.** Violates §5.5.2's atomicity and UC-POS-01 step 7's immediacy; leaves a window in which the POS is knowingly wrong.

## 1.6 CORRECTED MECHANISM

> **The KDS bump / bump-all / recall Unit of Work executes at `Serializable` isolation with a bounded, deterministic whole-transaction retry (max 3) on `P2034` / SQLSTATE `40001` / `40P01`. Exhaustion surfaces 409 Conflict.**

Order of operations inside the transaction — **audit last, deliberately** (§1.4):

```
1. resolve + authorize station (§3)
2. conditional UPDATE of the eligible ticket_lines        (state CAS, design gate §11)
3. Ticket projection CAS on tickets.version               (intra-ticket race, unchanged)
4. readiness SELECT over kitchen.ticket_lines             ← the SSI-protected predicate read
   WHERE order_line_id = ANY(...) AND business_day = ...
5. ctx.publishEvent(ticket.bumped { …, readyOrderLineIds })
6. AuditService.record(ctx.tx, …)                         ← LAST: correctness must not
                                                             depend on its advisory lock
7. dispatcher.drain → Sales readiness subscriber
   ── COMMIT (or 40001 → rollback → retry from 1) ──
```

### Every required property, discharged

| Required | How |
|---|---|
| Two station tickets completing concurrently cannot lose Sales readiness | SSI detects the rw-antidependency cycle (§1.5 A) and aborts one; the retry observes the committed peer and emits `readyOrderLineIds=[X]` |
| One transaction observes the other's committed completion, **or** one retries and recomputes | Under SSI it is always the latter, resolving into the former on retry |
| Kitchen never queries Sales private tables | The readiness SELECT reads **only** `kitchen.ticket_lines`; `module-boundaries.spec.ts:1019-1026` continues to prove it mechanically |
| Sales never queries Kitchen private tables | Sales reads only the event payload; `KNOWN_DEVIATIONS['sales->kitchen']` stays `undefined` |
| §5.2.3 intact | No new cross-module table access; the only cross-module surfaces remain public `contract/` imports |
| `ticket.bumped` → Sales readiness atomic per §5.5.2 | `dispatcher.drain` still runs **inside** the same `$transaction`; isolation level does not change the transaction boundary |
| Rollback holds if the Sales subscriber fails | Unchanged: `drain` catches nothing, the rejection propagates out of the `withAuthContext` callback, `$transaction` rolls back Kitchen writes, projection, event and audit together (`unit-of-work.ts:51-53`). A rollback caused by a subscriber error is **not** a serialization failure and is **never retried** |

**Payload:** unchanged from design gate §12 — `readyOrderLineIds` remains the load-bearing field. What changes is not *what* is computed but *under what isolation*, so the field is now actually trustworthy.

## 1.7 Deterministic real-PostgreSQL race test

Harness follows `test/kitchen-ticket-concurrency.e2e-spec.ts`, which already establishes the correct pattern — **two independent connections released by an explicit barrier**, described there as *"synchronized with an explicit barrier so both are guaranteed to attempt … a database-level race, not two `Promise.all`'d calls sharing one"*. **No sleeps anywhere.**

**Test 1 — prove the anomaly is real (guard test, READ COMMITTED).**
Fire one order line X to two stations. Open two independent transactions at READ COMMITTED. Barrier. T1 bumps the grill line; T2 bumps the packaging line; barrier; each runs the readiness SELECT; barrier; both commit.
**Assert:** both computed `readyOrderLineIds = []`, and X is therefore *not* ready. This test **documents the defect** and must be written so that it fails loudly if someone later removes `Serializable`.

**Test 2 — prove SERIALIZABLE + retry fixes it.**
Identical schedule at `Serializable` through the real `UnitOfWork`.
**Assert:** exactly one transaction raises `40001`/`P2034`; the retry succeeds; **exactly one** `ticket.bumped` carries `X` in `readyOrderLineIds`; `sales.order_lines` for X ends `state='ready'` with `ready_at` set exactly once; both Kitchen lines are `bumped`.

**Test 3 — retry does not double-write.** Assert exactly one audit entry for the retried command, one `ready_at` value, and a **stable `correlationId` across attempts** (proving the causal chain identifies the command, not the attempt).

**Test 4 — the advisory lock is not load-bearing.** Run Test 2 with the audit write ordered last (the corrected order). It must still pass — proving correctness comes from SSI, not from `pg_advisory_xact_lock`.

**Test 5 — non-serialization errors are never retried.** Force a `TicketHeaderMismatchError` and a subscriber failure; assert exactly one attempt and a full rollback.

**Test 6 — three-station fan-out.** X routed to three stations, all three bumping concurrently: exactly one transaction ends up emitting `readyOrderLineIds=[X]`.

---

# §2. BLOCKER 2 — `first_viewed` MUST SATISFY FR-AUD-001

## 2.1 Concession

The design gate §9 argued first-viewed was *"a display-progress observation, not an operational state change"* and proposed no audit entry.

> **That reasoning is withdrawn.** FR-AUD-001 `[M]` reads: *"The System SHALL record an immutable audit entry for **every state-changing operation**."* Once first-viewed is implemented as a `POST` that writes `tickets.first_viewed_at` and `ticket_lines.first_viewed_at`, it **is** a state-changing operation. The requirement admits no "display-progress" exemption, and the prior report invented one.

## 2.2 Options

**A. One entry per newly-first-viewed Ticket ★ RECOMMENDED**
`entity_type='ticket'`, `entity_id=<ticketId>` — exactly the FR-AUD-002 targeting the schema expects, with no ambiguity about what the entry describes.

Cardinality is **bounded and small**: `first_viewed_at` is write-once, so a Ticket generates **exactly one** `TICKET_VIEWED` entry in its entire lifetime — the same order of magnitude as `ORDER_FIRED` (one per order fire). A station handling 200 tickets a day produces 200 entries a day. This is not audit noise; it is one entry per business object per lifetime.

The Ticket's lines are stamped in the same operation and are recorded in that single entry's metadata as `ticketLineIds` — **one entry covering the ticket and its lines**, mirroring the rule already applied to bump-all in design gate §23 (one `TICKET_BUMPED` entry, not one per line) and the reasoning `audit.constants.ts:37-40` records for `CASH_MOVEMENT_RECORDED`.

**B. One entry per batch acknowledgement**
Fewer rows, but `entity_type`/`entity_id` cannot truthfully name a single entity when the batch spans N tickets. Targeting the *station* would make the entity a thing that did not change state, which is worse than verbose — it makes FR-AUD-002's targeting fields untrue. **Rejected on truthfulness.**

**C. Redesign granularity to `POST /kds/tickets/{id}/view`**
Perfectly truthful (one request = one entity = one entry) but forces N HTTP requests per screen refresh, working against NFR-PERF-004. **Rejected** — Option A achieves identical audit truthfulness while keeping the batch request.

## 2.3 Corrected design

- New constant `AUDIT_ACTION.TICKET_VIEWED = 'TICKET_VIEWED'`, following the existing `<ENTITY>_<PAST_TENSE>` convention (`audit.constants.ts:13-14`).
- `entity_type = AUDIT_ENTITY.TICKET`, `entity_id = ticketId`.
- Metadata: `stationId`, `ticketLineIds` stamped, `firstViewedAt`.
- Actor: the acknowledging employee from the session; `actor_type='user'`.
- **Written in the same transaction as the stamp**, via `AuditService.record(tx, …)` — an audit failure rolls the stamp back.

**Replay / no-op rule (explicitly required by the reviewer):**

> The acknowledgement writes `SET first_viewed_at = :now WHERE first_viewed_at IS NULL`. **An audit entry is written only for Tickets whose stamp actually changed a row.** An acknowledgement changing zero rows — a client retry, a display refresh, a second screen showing the same ticket — writes **zero** audit entries and returns `{ acknowledged: 0 }`.

This is enforced by deriving the audit set from the `RETURNING` clause of the stamping UPDATE, never from the request body — so it is structural, not a convention a later edit can quietly violate.

**Idempotency-Key:** remains accepted-but-not-required. The operation is idempotent at the database level, and with the no-op rule the audit trail is idempotent too.

## 2.4 Updated classification

| | Design gate | Corrected |
|---|---|---|
| **FR-AUD-001 `[M]`** | COMPLETE for KDS operations *(claimed while first-viewed was unaudited — the claim was internally inconsistent)* | **COMPLETE for KDS operations** — now genuinely so: view, start, bump, bump-all and recall each write an immutable in-transaction entry, with no state-changing KDS operation unaudited |

Audit actions for the slice become **five**: `TICKET_VIEWED`, `TICKET_LINE_STARTED`, `TICKET_LINE_BUMPED`, `TICKET_BUMPED`, `TICKET_RECALLED`.

---

# §3. BLOCKER 3 — ACT-09 ONE-STATION SCOPE

## 3.1 Concession

The design gate §6 defined the permitted set as *all* stations whose `display_terminal_id` equals the session's terminal, and presented one-terminal-to-many-stations as a feature (*"naturally supports the common 'one screen, two stations' kitchen"*).

> **Withdrawn.** SRS ACT-09 (p.19) states Kitchen Staff scope as **"One station"**, singular. A rule permitting N stations does not enforce it. `Station.displayTerminalId` carries **no unique constraint** (`schema.prisma`, plain nullable column), so nothing at any layer prevents N stations sharing one terminal — the prior design's permissiveness was unbounded, not merely theoretical.

## 3.2 Source check — is one-terminal-to-N-stations required now?

| Source | Says |
|---|---|
| **ACT-09** (p.19) | `Kitchen Staff \| One station \| KDS` — singular |
| **ACT-10** (p.19) | Head Chef — `All stations, recipes \| KDS + Dashboard` |
| **§7.3 Terminal aggregate** (p.41) | Key invariant *"Bound to exactly one branch"* — **no station binding invariant at all** |
| **FR-KDS-013 `[S]`** | The Expediter (Pass) display — the one *multi-station* view the SRS describes — is **Should-have and deferred** |
| **FR-KDS-001 `[M]`** | Stations defined per branch; says nothing about terminal fan-out |

> **No source authority requires one terminal to serve multiple stations in this slice.** The only SRS construct needing multi-station breadth is FR-KDS-013 `[S]` (Expediter) and ACT-10 (Head Chef, whose interface is *"KDS + Dashboard"*), both already deferred by design gate §5(B). Meanwhile ACT-09 positively requires singular scope for the actor this slice serves.

## 3.3 CORRECTED RULE — fail-closed, exactly one station

> Let `S = { s ∈ org.stations : s.display_terminal_id = principal.terminalId }`, resolved through the Organisation public contract.
>
> - `|S| = 0` ⇒ **403** — terminal is not configured as a station display (configuration error).
> - `|S| > 1` ⇒ **403** — a KDS terminal bound to multiple stations is **unsupported in this slice** and is refused as a misconfiguration, not silently interpreted.
> - `|S| = 1` ⇒ the operative station is `s₀`. The path `stationId` **MUST equal `s₀.id`**, else **403**.

Every branch fails closed. ACT-09 is now mechanically enforced: an ordinary Kitchen Staff session can read and operate **exactly one** station, and that station is derived from the registered terminal — never from a client parameter. The path parameter is retained purely as an assertion the server validates, keeping the route self-describing and preventing a display that has been reconfigured from silently operating a different station.

**Why `|S| > 1` is refused rather than accepted with a chosen default:** picking one of several would be arbitrary and could route a bump to the wrong station; accepting all violates ACT-09. Refusal is the only choice that is both safe and honest, and it surfaces the misconfiguration to the administrator immediately.

**Why this is enforced in the application layer, not by a unique index:** a partial unique index on `display_terminal_id` would enforce 1:1 structurally, but would also permanently foreclose the FR-KDS-013 Expediter display and any future multi-station screen — a schema decision made by a slice that has no authority over that requirement, and a migration. The application rule is reversible by the slice that actually implements FR-KDS-013.

**Head Chef / ACT-10 / Expediter breadth: explicitly DEFERRED** with FR-KDS-013 `[S]`. This slice is **not** enlarged to make ACT-10 "all stations" complete. Design gate §30's classification is unchanged: FR-KDS-013 remains NOT IMPLEMENTED.

**No user ratification is required.** ACT-09 is explicit SRS text and settles the MVP-safe rule; the reviewer's instruction not to escalate what the source can decide is satisfied.

---

# §4. SECONDARY AUTH CHECK — CORRECTED FAIL-CLOSED GATE

Every KDS route (including the `GET` queue) refuses unless **all** hold. Each is an independent check, evaluated before any business logic:

| # | Condition | Evidence it is enforceable today | Failure |
|---|---|---|---|
| 1 | Session is **terminal-bound** — `principal.terminalId` present | `AuthenticatedPrincipal.terminalId` (`auth.types.ts:34`); precedent `OrdersController.requireTerminal` — *"Every Sales WRITE happens at a registered terminal (FR-SEC-028)"* | 403 |
| 2 | Terminal **exists** and `status = 'active'` | `TerminalStatus { active, disabled, revoked }`; FR-SEC-028 `[M]` requires revocation to *"immediately invalidate its credentials"* — so `disabled`/`revoked` must be refused at request time, not merely at login | 403 |
| 3 | **`terminal.terminalType === 'kds'`** | `TerminalType { pos, kds, kiosk, handheld }` — the value already exists and is stored per terminal | 403 |
| 4 | **Employee identity present** (`principal.employeeId`) for start / bump / bump-all / recall | Required for `started_by` / `bumped_by`; FR-KDS-041 `[M]` "by employee" is unsatisfiable without it | 403 |
| 5 | Station rule of §3.3 | Organisation public contract query | 403 |

**Check 3 is the substantive addition and the reviewer's core point.** Without it, `kds.operate` on an ordinary POS terminal — or a dashboard session with no terminal at all — would operate the kitchen display. Possession of the permission must never by itself confer KDS operation; the **surface** must match. This also gives FR-SEC-020's surface separation real teeth on the KDS side, complementing the existing PIN rule that a `typ:'pos'` token is denied on dashboard routes.

**Where the terminal facts come from.** `terminalType` and `status` are Identity-owned and are **not** on the token today (`AuthenticatedPrincipal` carries only `terminalId`). Kitchen must not read `identity.terminals`. Two boundary-clean routes exist, and **Identity already publishes a public contract** (`src/modules/identity/contract/`, currently `pin-verification.contract.ts`), so this is precedented rather than novel:

- **Preferred:** an Identity-provided guard/decorator (e.g. `@RequireKdsTerminal()`) owned by Identity and merely *applied* by Kitchen — exactly the ownership model `@RequirePermission` already uses. Authorization infrastructure stays in the module that owns identity.
- **Alternative:** an Identity contract query `TerminalFactsQuery.byId(tx, terminalId) → { id, branchId, terminalType, status }`, consumed by a Kitchen guard.

Either adds **zero** `KNOWN_DEVIATIONS` entries. Combined with the Organisation station-binding query from §3.3, Kitchen reaches both facts through published contracts only.

## 4.1 Are the existing PIN/session mechanics sufficient after this check?

**Yes — with one honest caveat, unchanged from the design gate.**

Sufficient: a Kitchen Staff employee authenticating by PIN at a registered `kds`-type terminal yields a session carrying `terminalId` **and** `employeeId`, satisfying checks 1–4. FR-SEC-021 requires only that PIN be valid on registered terminals within permitted branches; a `kds` terminal is a registered terminal, and nothing in the SRS restricts PIN to POS hardware. Terminal registration and revocation (FR-SEC-028) already exist as routes.

Caveat: PIN-issued tokens are typed `sessionType: 'pos'` (`auth.types.ts:29`). **This is a token-label artifact and must not be used as the KDS surface check** — check 3 tests the **terminal's** type from the terminal record, which is the authoritative fact. A future `'kds'` session type would be cosmetic; it would not change any decision above.

Unchanged pre-existing gap: **FR-SEC-026 `[M]`** (8-hour KDS idle expiry) remains **PARTIAL** — one flat `JWT_ACCESS_TTL=15m` for every surface. Not created by this slice, not closed by it, non-blocking (it fails toward re-authentication, never toward exposure), and it remains identity work rather than KDS work.

---

# §5. RATIFICATION PACKET — REVALIDATED

**Nothing is ratified by this report.**

### Decision 1 — single `kds.operate` permission — **PRESERVED, unchanged**

Nothing in the three corrections disturbs it. Re-checked against the corrections:
- The §3.3 one-station rule is enforced by **terminal binding**, not by permission vocabulary — so no station-scoped permission variant is introduced, and the Option A analysis stands.
- The §4 terminal-type check is likewise an **authentication-surface** control, not a permission. It in fact *strengthens* Option A: because the surface is separately enforced, a coarse capability code cannot be exercised from the wrong device, which was the main residual concern about coarseness.
- `TICKET_VIEWED` (§2) is authorised by the same capability; the repository's refusal to invent read codes (`sales.permissions.ts:20-27`) is untouched.

Recommended ratification sentence: **unchanged** from design gate §20 Decision 1.

### Decision 2 — `ticket.recalled` (Kitchen Ops → Sales) — **PRESERVED, and reinforced**

Unchanged in substance. One correction-driven note: recall now also runs at `Serializable` with retry (§1.6), and the Sales revert must clear the same `ready_at` the readiness subscriber set. The concurrency correction makes Decision 2 **more** load-bearing, not less: because readiness is now reliably set, a recall that failed to revert it would leave a reliably-wrong POS rather than an intermittently-wrong one.

Recommended ratification sentence: **unchanged** from design gate §20 Decision 2.

### Third ratification — **NOT REQUIRED**

Assessed against the reviewer's bar (*add one only if resolving concurrency or station scope genuinely requires a business/governance choice*):

- **Concurrency (§1)** — isolation level, retry bounds and statement ordering are engineering mechanics. No permission, no schema, no cross-module contract, no user-visible business rule changes. `ticket.bumped`'s payload and trigger are unchanged from the already-tabled design. **Not a user decision.**
- **First-viewed audit (§2)** — FR-AUD-001 `[M]` *mandates* the entry; there is no choice to make about whether. Entry cardinality is an engineering judgement bounded by FR-AUD-002's truthfulness requirement. **Not a user decision.**
- **Station scope (§3)** — ACT-09's "One station" is explicit SRS text and settles the MVP-safe rule; refusing `|S| > 1` is the only reading that neither violates ACT-09 nor invents a tie-break. **Not a user decision.**
- **Terminal-type check (§4)** — a fail-closed security control derived from FR-SEC-020/028 and ACT-09. **Not a user decision.**

**The ratification count stays at exactly two.**

---

# §6. WHAT CHANGES IN THE PROPOSED DoD

Deltas against design gate §29 only:

| Item | Change |
|---|---|
| UoW | **NEW:** optional `isolationLevel` on `PrismaService.withAuthContext`; bounded serialization-retry in `UnitOfWork.execute`; KDS bump/bump-all/recall opt in to `Serializable` |
| Audit | **5** actions, not 4 — adds `TICKET_VIEWED`; audit written **last** in the bump transaction |
| First-viewed | Audited per newly-viewed Ticket; zero-row acknowledgement writes nothing |
| Station authorization | Exactly-one-station rule; `0` and `>1` both 403 |
| Auth guard | Adds terminal existence, `status='active'`, `terminalType='kds'`, employee-present checks — via an Identity-owned guard or Identity contract query |
| Tests | Adds the six §1.7 concurrency/serialization tests and the §4 fail-closed authorization matrix (POS terminal ⇒ 403; revoked terminal ⇒ 403; unbound terminal ⇒ 403; two-station terminal ⇒ 403; wrong station ⇒ 403) |
| Migration | **Still none** — §1.6 |
| `KNOWN_DEVIATIONS` | **Still no growth** — Identity and Organisation are reached through published contracts |

Classification changes vs design gate §30: **FR-AUD-001 → COMPLETE for KDS operations (now genuinely).** All other rows unchanged — in particular FR-KDS-013 stays NOT IMPLEMENTED, and ACT-10 breadth is not claimed.

---

# §7. VERDICT

> # **A — ACCEPTANCE CORRECTION CLEAN — READY FOR USER RATIFICATION**

- **Blocker 1 CLOSED.** The write-skew was real, the prior claim is withdrawn, `tickets.version` is proven structurally incapable of serializing two Ticket aggregates, and the corrected mechanism (SERIALIZABLE + bounded retry, audit ordered last) discharges every required property with a deterministic six-test race suite. `sales.orders.version` was analysed, not dismissed, and rejected on module-boundary and POS ETag grounds.
- **Blocker 2 CLOSED.** The "not a state change" argument is withdrawn; first-viewed is audited one entry per newly-viewed Ticket, with a structural zero-row/zero-entry rule.
- **Blocker 3 CLOSED.** Exactly one operative station per KDS terminal, fail-closed at 0 and at >1; ACT-09 mechanically enforced; ACT-10/FR-KDS-013 breadth explicitly deferred without enlarging the slice.
- **Secondary auth STRENGTHENED.** Terminal must exist, be active, and be of type `kds`; employee identity required for attributed actions.
- **Not B / not C** — both blockers are closed with proof rather than assertion.
- **Not D** — no new business or governance choice arose; the count stays at two.
- **Not E** — HEAD re-verified as `121b889`, working tree documentation-only.

**MIGRATION REQUIRED: NO** — re-argued from first principles in §1.5–§1.6, with the migration-bearing Option C specified to schema level and rejected on merit, not on cosmetic preservation of the prior conclusion.

---

## §8. WHAT THIS REPORT DID NOT DO

No product code · no migration · no schema change · no route · no permission · no governance-register edit · no test written or executed · no OpenAPI regeneration · no commit · no push · no deploy · no destructive git operation. The prior design-gate report was **not modified**. The only file created is this report; the only file modified is `INDEX.md`, by exactly one appended row.

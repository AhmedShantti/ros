# D4-1A — SYNC PROTOCOL KERNEL

| Field | Value |
|---|---|
| **Task / slice name** | P15-OFF2 / D4-1A — Sync protocol kernel |
| **Lane** | D — KDS + Offline/Sync |
| **Report type** | IMPLEMENTATION + SCHEMA/MIGRATION + TESTS + BENCHMARK |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` — in particular *"D1-1 — Offline / Sync Protocol Foundation Ratification — 2026-09-02"* — remain authoritative. This report records what was built, run and measured in this session; where it disagrees with the SRS or the register, they win. |
| **Date** | 2026-09-02 |
| **Starting HEAD** | `76b42893c44bd1ce73cde0e88e307f85d6577fca` (`76b4289`) — *docs(sync): ratify offline protocol foundation* |
| **Branch** | `full-srs/lane-d-kds-offline` |
| **Working tree at start** | Clean. |
| **Task identifier** | D4-1A |
| **Status** | **COMPLETE** — kernel implemented, migrated, tested and benchmarked. Three residual hard gates remain open by design (§40). |

---

## 1. Status

The protocol kernel behind `POST /v1/sync/batch` exists, runs against real PostgreSQL, and is covered by
**79 unit tests** and **65 sync e2e tests**, inside a fully green **894 unit / 1,218 e2e** suite.

Everything the ratification put in D4-1A CORE's scope (§39 of the brief) is implemented:

- global operation dedup **separated** from time-partitionable history — the Correction 1 architecture,
  with `PRIMARY KEY (tenant_id, op_id)` and no partition-key column diluting it (§7);
- dedup written in the **same transaction** as the business effect, so neither forbidden atomicity
  state is reachable (§8);
- **crash-recoverable** batch reservation with a lease and optimistic reclaim (§11);
- HLC exactly per `FR-OFF-041`, corpus-graded, `GD-D1-03` deliberately not implemented (§12);
- strict envelopes, causal ordering, the ratified fifth status `deferred` (§13, §15);
- **per-operation failure isolation without per-operation commit** — Correction 3 (§16);
- conflict, revalidation-exception and device-state substrates (§19, §20, §21);
- RLS on all six new tables (§22);
- the canonical **`/v1`** route, with no repository-wide retrofit — Correction 5 (§23);
- both mandatory measured gates run (§29, §30, §31).

**Three things this slice found rather than assumed**, each fixed here:

1. Express's inherited **100 KB** body limit made a 500-operation batch — `NFR-PERF-032`'s own size —
   impossible to submit at all (§23.3).
2. The first architecture **missed the performance budget** (kernel-floor p95 3,896 ms against 3,000 ms).
   The gate caught it before the protocol surface grew, and the fast/safe chunk design brought the
   kernel floor to **340 ms p95** (§29).
3. A `module-boundaries` guard asserted a **global migration count** as a proxy for "Reporting added no
   migration", so any lane adding a migration failed a Reporting test. Replaced with an assertion of
   the actual intent (§35).

**No implementation credit is claimed beyond what was executed.** `NFR-PERF-032` is **NOT YET FULLY
VERIFIED**, `CT-01` **NOT PASSED**, `CT-06` **NOT PASSED globally**, and `FR-OFF-040`/`043`/`044`/
`045`/`046`/`047`/`050`/`051` remain **PARTIAL** (§38).

---

## 2. Starting HEAD

```
$ pwd                        /Users/mac/projects/ros-worktrees/lane-d/kitchen-kit/backend
$ git rev-parse --show-toplevel   /Users/mac/projects/ros-worktrees/lane-d
$ git rev-parse HEAD         76b42893c44bd1ce73cde0e88e307f85d6577fca
$ git branch --show-current  full-srs/lane-d-kds-offline
$ git status --short --untracked-files=all   (empty)
```

`docs/governance/GOVERNANCE_DECISION_REGISTER.md` contains the D1-1 ratification section, and both D1-1
reports are present. Proceeded.

---

## 3. Governance consumed

Every decision below is applied as ratified, not reinterpreted.

| Ratified item | How D4-1A honours it |
|---|---|
| **GD-D1-01** — identifiers are ULIDs rendered as canonical UUID hex; the server never remaps | `sync.dto.ts` validates against the repository `UUID_PATTERN`; base32 is rejected; `opId`/`entityId` are echoed and stored verbatim, proven by test (§13, §27) |
| **GD-D1-02** — HLC `<13>.<5>.<32>`, algorithm exactly `FR-OFF-041` | `hlc.ts` implements the algorithm verbatim; the corpus grades all four receive branches (§12) |
| **GD-D1-03** — bounded server adoption **DEFERRED** | **NOT implemented.** Nothing bounds, clamps or refuses a received physical component. The corpus records the resulting three-hour drag as the EXPECTED value so it cannot be "corrected" by accident (§12.4) |
| **GD-D1-04** — fifth status `deferred`; four proposed conflict rules | `deferred` implemented and non-definitive; conflict rules are substrate-only because their domains do not exist (§15, §19) |
| **GD-D1-05** — `sync.revalidation_exceptions` is sync-owned | Table created in the `sync` schema; no dependency on `governance.anomaly_flags` (§20) |
| **GD-D1-06** — versioning, limits, retention, strict envelopes | `protocolVersion` + per-operation `schemaVersion`, strict rejection both ways, configurable limits, 30-day retention floor (§13, §22, §24) |
| **GD-D1-07** — **REJECTED** | A revoked terminal is refused ordinary sync, and the refusal message states that committed transactions are **not** discarded. Lossless recovery remains a hard gate (§17) |
| **Correction 1** — dedup separated from partitioned history | §7, §9 |
| **Correction 2** — batch idempotency crash-recoverable, not "reused unchanged" | §11; `sync.idempotency_keys` and `IdempotencyService` are **untouched** |
| **Correction 3** — failure isolation, not per-operation commit | §16 |
| **Correction 4** — committed backlog loss not accepted | §17 |
| **Correction 5** — canonical `/v1`, no unilateral retrofit | §23 |
| **P-D4-01 / P-D4-02** — measured release gates | §29, §30, §31 |

---

## 4. Current cross-lane state caveats

Both advanced facts from the brief are respected, and **neither was cherry-picked**.

**A. Branch RBAC.** Lane B has ratified reopening `D-2` and `B1-2` is authorised, but that
implementation is **not in this lane's tree**. D4-1A therefore:

- does **not** recreate branch RBAC, and defines no permission code of its own;
- authorises on authenticated tenant + registered **active** terminal + that terminal's server-derived
  branch (§17);
- publishes `SYNC_AUTHORIZATION_PORT` (`sync/contract`) as the narrow question Lane B will answer —
  *"is this actor allowed to execute permission P at the terminal branch / target scope?"* — and
  **binds nothing to it**, so nothing fakes an answer (§18);
- does **not** claim `FR-SEC-002/003/004`.

This is a pending integration, not a permanent block.

**B. Inventory `CG-01`.** Lane A's atomic stock projection exists but its exact-caller-delta acceptance
correction is not integrated here. **No stock-movement domain replay is part of D4-1A's acceptance.**
The kernel ships zero domain handlers, so inventory attaches later through
`@SyncOperationHandlerFor` without touching the protocol.

---

## 5. Migration

**One** migration: `prisma/migrations/20260902010000_sync_protocol_kernel/migration.sql`.

- **Sync-owned only.** It creates six tables in the existing `sync` schema and touches **no** identity
  table (Lane B), **no** inventory table (Lane A), and no domain aggregate.
- `sync.idempotency_keys` is **unchanged**.
- **No domain aggregate gains `hlc`/`sync_state`.** The design gate proposed spraying those across every
  synced table; D4-1A declines (§37 of the brief): the oplog is the protocol truth, and a query-time
  materialisation must be justified by a concrete D4-1B conflict handler. This also removes a large
  cross-lane schema-conflict surface.

Verified from zero and as an upgrade (§36, §37).

---

## 6. Sync schema

| Model | Table | Purpose |
|---|---|---|
| `SyncOperationDedup` | `sync.operation_dedup` | **Authoritative global operation identity.** Never partitioned |
| `SyncOperation` | `sync.sync_operations` | Operation history; designed for later `RANGE` partitioning |
| `SyncBatch` | `sync.sync_batches` | Reservation, crash-recovery lease, durable response, telemetry |
| `SyncDeviceState` | `sync.device_state` | Last seen, cursor, protocol version, clock skew, mismatch counter |
| `SyncConflictRecord` | `sync.conflict_records` | `FR-OFF-043` register, both versions, audit linkage |
| `SyncRevalidationException` | `sync.revalidation_exceptions` | `FR-OFF-046`, sync-owned per `GD-D1-05` |

Six new models (92 → 98), six back-relations on `Tenant`. **Zero schema content was lost**: normalising
whitespace and diffing HEAD against the working tree yields **0 removed content lines** — the 83
deletions in the raw diff are `prisma format` re-alignment only.

---

## 7. Operation dedup

```sql
CONSTRAINT operation_dedup_pkey PRIMARY KEY (tenant_id, op_id)
```

Verified in-database, and asserted by a test that reads `pg_constraint` directly rather than trusting
the migration text:

```
$ SELECT pg_get_constraintdef(oid) FROM pg_constraint
   WHERE conrelid='sync.operation_dedup'::regclass AND contype='p';
  PRIMARY KEY (tenant_id, op_id)
```

**Why this is a separate table at all.** PostgreSQL requires every unique constraint on a partitioned
table to contain all partition-key columns — the constraint `prisma/schema.prisma:1767` already
documents for `sales.orders`. Had the uniqueness lived on a table partitioned by `received_at`, it would
necessarily have become `(tenant_id, op_id, received_at)`, under which the same `opId` re-submitted
across a partition boundary inserts cleanly and the financial effect applies twice. That failure would
have appeared **only for devices offline across a month boundary** — precisely the `CR-01` 72-hour case
the whole protocol exists for.

Behaviour, all covered by e2e tests (§27):

| Situation | Outcome |
|---|---|
| First sighting | Processed; row written with the settled status |
| Same `opId`, same fingerprint | `duplicate`, returning the **original** result — never reprocessed |
| Same `opId`, **different** fingerprint | `rejected/duplicate_op_id_different_fingerprint`. The original effect is never re-applied and nothing is overwritten |
| Same `opId`, different tenant | A first sighting there. Cross-tenant replay is structurally impossible |

`received_at` is deliberately **not** part of the identity. Stored status is constrained to
`accepted | conflict | rejected`: `deferred` settles nothing, and `duplicate` is what a later submission
is *told*, not what the row records.

---

## 8. Dedup / business-effect atomicity

The dedup row is written **inside the same transaction, and in the fast path the same statement batch,
as the handler's business effect.** There is no window between them, so neither forbidden state is
reachable:

| Forbidden state | Why it cannot occur |
|---|---|
| effect committed + dedup missing → retry applies it twice | Both are in one transaction; a commit carries both or neither |
| dedup present + effect missing → client told `accepted` falsely | Same |

The handler contract makes the safe path the only path: `SyncOperationContext` hands the handler the
kernel's own `Prisma.TransactionClient` and nothing else, and the contract states that a handler which
opens its own transaction or writes through another client breaks the guarantee.

**Proven, not asserted** (`sync-protocol.e2e-spec.ts`): a batch containing one succeeding and one
throwing operation leaves exactly one audit row for the successful entity and **zero** for the failed
one — the failed operation's business effect is gone, and its `rejected` settlement is still durable.

---

## 9. Operation history

`sync.sync_operations`, primary key `(tenant_id, op_id, received_at)`.

**Not partitioned in this slice, and the schema is shaped so that it can be later.** `received_at` is
already in the primary key, so `PARTITION BY RANGE (received_at)` becomes a purely physical change. The
four conditions the brief attaches to that choice all hold:

- the schema is explicitly designed for later partitioning — `received_at` in the PK;
- global dedup already lives separately (§7);
- **no correctness guarantee depends on history partitioning** — nothing reads it for idempotency;
- the deferred work is recorded here.

**Why deferred rather than done now:** partitioning needs a partition-lifecycle job to pre-create the
next period's partition, and this repository has no scheduler at all (`@nestjs/schedule` is not a
dependency). Creating monthly partitions with nothing to create the next one would fail every write on
the first day of the following month — strictly worse than an unpartitioned table.

History is written only for operations the server actually **processed**: a `duplicate` adds no new
fact, and a `deferred` settles nothing. Verified by test.

---

## 10. Batch persistence

`sync.sync_batches` holds `batch_id`, tenant, terminal, fingerprint, protocol version, operation count,
byte size, lifecycle state, timing, per-status counts, max observed skew, and the **durable response**.

The response lives here rather than in `sync.idempotency_keys` because the lease and reclaim columns
have to live somewhere anyway, and splitting one batch's record across two tables would create exactly
the kind of two-writes-that-can-disagree the atomicity rule forbids.

---

## 11. Crash-recovery mechanism

**The failure this removes.** `IdempotencyService.reserve()` commits an `in_flight` row in its own
transaction; `release()` deletes it on a *handled* failure. **A process death handles nothing**, so the
row survives and every later attempt is told *"being processed concurrently. Retry shortly."* — forever.
For an ordinary POST that is survivable; for a batch carrying a terminal's only copy of six hours of
sales it is not.

**Mechanism.** A processing attempt takes a time-bounded lease (`lease_owner`, `lease_expires_at`,
`attempt`, default 60 s, renewed after each chunk):

| Condition | Behaviour |
|---|---|
| No row | Insert `ON CONFLICT DO NOTHING`; the inserter owns it |
| Completed, same fingerprint | Replay the stored response verbatim; **nothing re-applied** |
| Different fingerprint | `409` — client defect (`FR-API-023`) |
| Different terminal | `409` |
| `in_flight`, **live** lease | `409` "being processed concurrently" |
| `in_flight`, **expired** lease | **Reclaim**, optimistic on the observed `(lease_owner, attempt)`; a racing reclaimer sees 0 rows updated and backs off |

On a handled failure the lease is **released immediately** (expiry set to the epoch) so the client's
retry reclaims at once, and the batch row and every committed operation are preserved.

**Why resume is safe.** The reclaimer does not reconstruct what the dead owner applied. It re-runs the
batch, and the global dedup registry answers `duplicate` per operation. Correction 1 is what makes
Correction 2 cheap — had uniqueness stayed on a partitioned table, resume would have been unsound.

`sync.idempotency_keys` and `IdempotencyService` are **UNCHANGED**: no shared semantics were altered
for any other endpoint, so there is no compatibility surface to prove.

---

## 12. HLC implementation

`src/modules/sync/hlc/hlc.ts` — pure, dependency-free, so both runtimes can hold the identical logic.

- **Algorithm**: `FR-OFF-041` verbatim, quoted in the file above the code.
- **Representation**: `<13 digits>.<5 digits>.<32 lowercase hex>`, always 52 characters.
- **API**: `hlc`, `encodeHlc`, `parseHlc`, `isValidHlc`, `compareHlc`, `hlcLocalEvent`,
  `hlcReceiveEvent`, `hlcNodeFromTerminalId`.
- **Fail-closed**: parsing is a single strict regex — no trimming, no case folding, no alternate
  separators. Out-of-range components and a logical counter that would overflow the 5-digit field
  **throw** rather than truncate, because truncation silently corrupts causal order.
- **Verbatim preservation**: a received HLC is stored exactly as sent and never rewritten.
- **`GD-D1-03` is NOT implemented**: nothing bounds adoption of a skewed physical component.

**Fixed width earns its keep**: lexicographic string order **is** the total HLC order, so PostgreSQL can
`ORDER BY hlc` with no parsing, and the causal scheduler compares raw strings. Both properties are
asserted, not assumed.

---

## 13. Envelope

Operation: `opId · hlc · type · entityId · causedBy · actorEmployeeId · occurredAt · schemaVersion ·
payload`. Batch: `protocolVersion · deviceId · batchId · lastServerCursor · operations`.

**What is absent is part of the contract.** There is no `tenantId`, no `branchId`, no client-supplied
`fingerprint` and no `clientSeq` field anywhere. Because the global `ValidationPipe` runs
`whitelist + forbidNonWhitelisted`, a body carrying any of them is **rejected with 400**, not silently
stripped — strict rejection, not lenient ignoring, for financial envelopes. Each case has its own test.

Also rejected at the edge: a malformed or uppercase HLC, a base32 ULID where a UUID rendering is
required, an unsupported `protocolVersion`, an empty batch, and an unknown field inside a nested
operation.

---

## 14. Processor registry

`SyncOperationRegistry` scans the container once at bootstrap for `@SyncOperationHandlerFor` providers,
mirroring `DomainEventHandlerRegistry`'s discovery and lifetime rules. Two handlers for one type is a
**bootstrap failure**, not a container-ordering coin flip.

**D4-1A ships ZERO production handlers, deliberately.** The ratification's boundary is explicit —
"conflict handling for domains that actually exist", "Do NOT implement all domain handlers". A kernel
with an invented `order.create` handler would be a domain slice wearing a protocol slice's name and
would pre-empt D4-1B's revalidation and conflict design.

**The honest consequence, stated rather than hidden:** on a production deployment of D4-1A every
operation type is answered `rejected/unknown_operation_type`. The startup log says so explicitly. The
protocol, its idempotency, its crash recovery and its ordering are all real and exercised; the domains
attach in D4-1B.

---

## 15. Causal / deferred handling

`operation-scheduler.ts` is pure and unit-tested (13 cases). Kahn's algorithm over `causedBy`, ties
broken by HLC and then `opId`, so the client can predict the server's order exactly.

| Situation | Outcome |
|---|---|
| Parent absent and not previously applied | **`deferred`** — non-definitive; nothing is written |
| Parent applied in an earlier batch | Child proceeds |
| Parent later in the same batch | Topologically reordered; parent first |
| Parent blocked | Child inherits the block, transitively |
| Parent settled **without being applied** | **`rejected/causal_parent_rejected`** |
| `causedBy` cycle, including self-reference | **`rejected/causal_cycle`** |
| Parent fails at apply time | Child `rejected/causal_parent_rejected` |

**One kernel-level decision, recorded rather than applied silently.** `FR-OFF-022` says a child whose
parent "has not been applied" is deferred. That is right while the parent might still arrive. It is
wrong once the parent has been settled definitively as `rejected` or `conflict`: that parent will never
be applied, so deferring strands the child in the outbox forever and `FR-OFF-024` never lets the client
clear it. The child is therefore **rejected** — definitive, so it can be dead-lettered. Derived from
`FR-OFF-022` and `FR-OFF-024` read together; flagged here for **D4-1B review**.

**No server-side pending queue.** The client retains and resends deferred operations, so the server
holds no incomplete-chain state — which is what keeps `CT-14` bounded.

---

## 16. Failure-isolation transaction strategy

**Ratified invariant: per-operation failure ISOLATION, not per-operation physical COMMIT.**

Chunks of 50 operations, one transaction each, in **two modes**:

- **Fast path** — no savepoints; handlers called directly; all settlement rows flushed with two
  set-oriented `createMany` statements at the end of the chunk. Roughly `N + 2` round trips.
- **Safe path** — a `SAVEPOINT` around each operation and one insert at a time. Roughly `4N` round trips.

A chunk is attempted fast. **Any** failure discards the chunk transaction — nothing committed, so
nothing can be half-applied — and the identical chunk is re-run isolated. The common case is cheap; the
pathological case is exactly as isolated as before.

This is what made the budget reachable: the naive shape measured **3,896 ms p95** at the kernel floor
against a 3,000 ms budget, before any domain handler existed (§29).

**Acknowledgement rule preserved**: results are merged only after the chunk commits, so no `accepted`
is externally final until its chunk is durable, and a rollback means those operations were never
accepted. `FR-OFF-023` is proven directly — a throwing operation between two healthy ones leaves both
neighbours `accepted` and only itself `rejected`.

---

## 17. Authentication / terminal binding

`SyncTerminalGuard`, after `JwtAuthGuard` → `TenantContextGuard`. Each check independently fail-closed:

1. the session is terminal-bound;
2. a tenant context exists;
3. the terminal exists and is `active`, read **live** through Identity's published
   `TERMINAL_FACTS_QUERY` — never from the token — so a terminal revoked mid-session is refused on its
   very next batch (`FR-OFF-032`: revocations "re-verified on every reconnection");
4. `body.deviceId` equals the authenticated terminal, else `403`.

Tenant comes from the principal; branch from the terminal's live state. Neither is ever read from the
body, and the stored history rows carry the server-derived values — asserted by test.

**Revoked terminals.** Ordinary sync is refused, which is the correct security outcome. It is **not** a
statement that the backlog may be discarded. `GD-D1-07` was **REJECTED**; committed-sale loss is
explicitly not accepted behaviour; **lossless revoked-terminal recovery is a hard gate D4-1 cannot be
closed without**. The 403 message itself says the committed transactions are not discarded, and a test
asserts that wording — so an operator reading only the error cannot conclude otherwise.

**`actorEmployeeId` is asserted by the terminal, not authenticated by the server**, and the contract
says so. It is trustworthy exactly to the extent the offline PIN authentication that produced it was.

---

## 18. Branch-RBAC integration boundary

`sync/contract/sync-authorization.port.ts` declares `SyncAuthorizationRequest`
(`tenantId · terminalId · branchId · actorEmployeeId · permission · targetBranchId?`) and
`SyncAuthorizationPort.isAllowed(tx, request)`.

**`SYNC_AUTHORIZATION_PORT` is intentionally unbound.** An unbound token fails loudly if consumed early —
the correct failure. A default `true` would be the faked answer the ratification forbids; a default
`false` would silently disable a protocol that works today.

**No permission code was invented.** This repository treats a new code as requiring explicit user
authorization — `kitchen.permissions.ts` records `kds.operate` as *"the THIRD explicit user-authorized
exception to the zero-invented-codes discipline"* — and D4-1A has none. There is therefore no
`sync.permissions.ts`, and **`FR-SEC-002/003/004` are not claimed**.

---

## 19. Conflict substrate

`ConflictRecordService.record(tx, input)` writes a `sync.conflict_records` row **and** a hash-chained
`governance.audit_entries` row carrying both input states and the applied rule (`FR-OFF-044`), inside
the caller's transaction — a conflict register that can disagree with the ledger is worse than none.

**No domain conflict rules are implemented.** The ratified matrix covers orders, payments, cash
sessions, stock movements and KDS tickets, and each needs its domain handler first. `FR-OFF-040` stays
**PARTIAL**; `FR-OFF-043`/`044` are **PARTIAL** rather than NOT IMPLEMENTED precisely because this
writer and its schema exist.

---

## 20. Revalidation-exception substrate

`sync.revalidation_exceptions`, owned by Sync per `GD-D1-05`.
`RevalidationExceptionService.raise(tx, input)` records client values, server values, attribution and
review state, writes the audit entry, and increments the `FR-OFF-047` per-device mismatch counter.

**There is deliberately no code path here that rejects, reverses or corrects an operation.** Raising an
exception is the only thing a mismatch does — `FR-OFF-046`, whose rationale is blunt: *"Rejecting a
synced sale because the server disagrees about a price is not an option: the customer already paid and
left."* This is the rule most likely to be implemented wrongly, because every instinct in a validation
layer says reject the bad data.

The computations that produce a mismatch are D4-1B, so `FR-OFF-045/046/047` are **PARTIAL**.

---

## 21. Device / skew state

Per batch, the largest **signed** deviation between any operation's HLC physical component and the
server's receipt instant is computed and stored on `sync.device_state`, with
`skew_detected_at`/`skew_alerted_at` stamped past the configurable threshold (default **5 minutes**).

`FR-OFF-042`, clause by clause: **detect** ✓ · **record** ✓ · **preserve both timestamps** ✓
(`sync_operations.hlc` and `.origin_device_time` verbatim alongside `received_at`) · **alert the branch
manager** — raised as a hash-chained audit entry, because this repository has **no notification
substrate** and the brief is explicit ("Do not invent a notification system"). **`FR-OFF-042` is
therefore PARTIAL**, and the code says so where it happens rather than only here.

`CT-10` is proven server-side end to end: a device three hours ahead has its skew detected and alerted,
its operations accepted, its HLC stored byte-identically, and `origin_device_time` recorded **later**
than `received_at` — the observable signature of a device clock running ahead.

---

## 22. RLS

All six tables: `ENABLE` + **`FORCE`** row level security, and four policies each
(SELECT/INSERT/UPDATE/DELETE) predicated on the transaction-local `app.tenant_id`.

Proven through `PrismaService` as `ros_app` (NOBYPASSRLS) — seven tests:

- ENABLE and FORCE verified from `pg_class` for every table;
- four policies per table verified from `pg_policies`;
- own-tenant read works; another tenant's row is invisible **even by primary key**;
- cross-tenant `updateMany`/`deleteMany` affect **0 rows**, and the row is observed still intact;
- cross-tenant INSERT is refused;
- **no auth context at all** → zero rows readable and writes refused.

**No branch predicate anywhere.** Branch-scoped RLS is not introduced by this lane; `branch_id` is
server-derived attribution, never an authorization boundary.

---

## 23. API / versioning

### 23.1 The canonical route

`POST /v1/sync/batch` is live. `GET /v1/sync/changes` and `GET /v1/sync/status` are named in the
canonical catalogue and belong to **D4-2**; they are absent rather than stubbed, because a stub that
returns nothing is indistinguishable to a client from a server with no data.

### 23.2 The narrowest mechanism that produces it

Nest URI versioning with **`defaultVersion: VERSION_NEUTRAL`** (`common/http/api-versioning.ts`), so a
controller moves under `/v1` **only if it explicitly asks**. Today exactly one does.

**Proven, not claimed:** regenerating the committed OpenAPI document adds `/v1/sync/batch` and
**deletes nothing** — 0 removed path lines. No unrelated route moved.

The helper is called from `main.ts`, the OpenAPI generator **and** the e2e suites, because configuring
it in `main.ts` alone would mean the generated document and every test exercised different routes from
production — the exact drift class `openapi:check` exists to catch. The OpenAPI drift suite caught this
immediately when it was first configured differently, which is the suite working as intended.

**No repository-wide retrofit, and no silent fallback.** There is still no `setGlobalPrefix`; every
pre-existing route keeps its path; and a test asserts `POST /sync/batch` returns **404**. When Platform
makes the repository-wide decision, flipping `defaultVersion` to `'1'` versions everything at once and
Sync needs no change. `swagger.config.ts`'s server description was updated, because it previously
asserted that `/v1` was not implemented — true before this slice, false after.

### 23.3 A real defect this uncovered

Express's default JSON body limit is **100 KB** and this application never configured one. A
500-operation batch is ~150 KB, so **`NFR-PERF-032`'s own batch size and the ratified 4 MiB cap were
both unreachable** — the framework returned 413 before the kernel saw a byte. The D1-1 report flagged
the missing configuration; the e2e suite turned it into a reproducible failure.

Fixed **scoped to the sync path only**, so no unrelated endpoint's memory-pressure surface widens.

One trap worth recording: `express.json()` returns a function literally named `jsonParser`, and Nest
decides whether to install its **global** parser by scanning for a handler with that name. Registering
the raw `json()` convinced Nest a global parser already existed, so it installed none — silently
leaving every other route with an unparsed body. Wrapping it in a differently-named function fixes it,
and the code carries the explanation.

---

## 24. OpenAPI

Generated from source (`npm run openapi:generate`); artifacts never hand-edited. The `200` response
carries a **concrete schema** (`sync.schemas.ts`) — the drift suite rightly rejects an untyped 2xx body,
because that is a contract the client team cannot build against. The schema documents the status
vocabulary, the `definitive` flag and its meaning, and the skew fields.

`test/openapi.e2e-spec.ts`: **49 passed**, including live-route/document drift in both directions and
the schema-completeness sweep. `npm run openapi:check` passes once the regenerated artifacts are
committed (it is a regenerate-then-`git diff --exit-code`).

---

## 25. Conformance corpus

Extends `kitchen-kit/conformance/`, following its existing conventions — decimal strings, structural
integers only, hand-derived expectations, strict runner. **Three new corpus files:**

| Path | Contents |
|---|---|
| `conformance/hlc/hlc-algorithm.corpus.json` | Local-event advance/increment/equal-time, the logical bound and its overflow, **all four `FR-OFF-041` receive branches**, node tie-break, comparison, lexicographic-equals-causal sort, padding, 13 malformed encodings |
| `conformance/hlc/hlc-ct10-clock-skew.corpus.json` | The `CT-10` three-hour sequence and its ordering consequences |
| `conformance/ids/ids-rendering.corpus.json` | ULID↔UUID rendering, accepted/rejected wire forms, the no-remapping guarantee |

Run by `hlc-conformance.spec.ts` and `ids-conformance.spec.ts` — **79 unit tests total** for the sync
module.

**One corpus vector was wrong when first written and was corrected by derivation, not by pasting output:**
a Crockford alphabet slip (`Q`=23, not 22) had produced the wrong UUID. Re-deriving the timestamp from
the alphabet gives `1727641790304` → `01923f79-a760-…`, which an independent implementation then
confirmed. The corpus rule that expectations are hand-derived is what surfaced it.

**`FR-OFF-050`/`051` remain PARTIAL**: the Dart runner does not exist, and neither does the CI job that
would run both suites. The server matching the corpus proves the server is self-consistent, not that
client and server agree — and `CT-06` grades agreement.

---

## 26. Crash-recovery tests

`test/sync-crash-recovery.e2e-spec.ts`, real PostgreSQL, deterministic failpoint (never a killed runner).
**5 passed.**

| Case | Result |
|---|---|
| **A.** Owner died before applying anything (stale lease) | Reclaimed and processed; `attempt` incremented to 2; lease cleared. A mismatched fingerprint on the stale row correctly 409s first |
| **B.** Died after chunk 1 committed, 55 operations | First 50 effects durable, remaining 5 untouched, lease released. **The client retries the identical batch with the same `batchId` and the same `opIds`** — first 50 answer `duplicate`, remainder `accepted`, all definitive, and **every entity has exactly one effect** |
| **C.** Same `batchId`, different body | `409` |
| **D.** Two concurrent identical submissions | Exactly one 200, one 409, one effect. The live owner is not stolen from |
| Never trapped at 409 | After a simulated death the very next retry succeeds — no manual intervention, no new `batchId` |

Case B is the `FR-OFF-025` invariant in full: no duplication, no stranding, no lost acknowledged sale,
no changed `opId`, no unrecoverable outbox.

---

## 27. Idempotency tests

`test/sync-idempotency.e2e-spec.ts` — **10 passed.**

Global `(tenant_id, op_id)` uniqueness asserted from `pg_constraint` · applied exactly once across
repeated batches, verified on the **business effect** not merely the row · the **original** result
returned for a repeat, not a recomputed one · same `opId` + different body fails closed with the
original effect untouched · a repeated `opId` inside one batch answered from the first occurrence · a
completed batch replayed verbatim with nothing re-applied · `409` on the same `batchId` with a different
body · **no cross-tenant replay** · the ≥30-day retention window asserted on stored timestamps rather
than by waiting · history written for processed operations but not duplicates, with server-derived
terminal and branch.

---

## 28. Causal tests

`test/sync-causal.e2e-spec.ts` — **9 passed.**

Parent applied before a child submitted first and carrying an earlier HLC — verified against the **audit
chain's own ordering**, a durable witness of application order rather than of the reported results ·
absent parent deferred with **nothing written** · the deferred child accepted after its parent arrives ·
a three-deep cascade all deferred · a child of a definitively-unapplied parent rejected · a child of a
parent that fails at apply time rejected · cycles rejected · independent operations applied in HLC order
(submitted 3,1,2 → applied 1,2,3) · a deferred operation never becomes definitive across repeated
attempts and never leaves a dedup row.

---

## 29. `NFR-PERF-032` kernel benchmark (P-D4-01)

20 iterations per layer, 500 operations per batch, chunk size 50, single local PostgreSQL 16 container,
`ros_app` with RLS forced, measured end-to-end over HTTP.

### 29.1 Measured, isolated run (quiet database)

| Layer | p50 | **p95** | min | max |
|---|---:|---:|---:|---:|
| **A. Kernel floor** — validation, HLC, causal scheduling, dedup, history, result persistence, commit | 317 ms | **340 ms** | 280 ms | 350 ms |
| **B. Representative** — the same **plus** a per-operation hash-chained audit append and a conflict-lookup read | 883 ms | **937 ms** | 807 ms | 957 ms |

Budget: **3,000 ms p95**. Headroom: ~8.8× at the floor, ~3.2× representative.

### 29.2 The measurement that changed the architecture

The first implementation — a savepoint round trip either side of every operation and two single-row
inserts, i.e. ~4 round trips × 500 — measured:

| Layer | p50 | p95 |
|---|---:|---:|
| Kernel floor | 2,133 ms | **3,896 ms** |
| Representative | 5,813 ms | **8,149 ms** |

**Over budget at the kernel floor, before a single domain handler existed.** That is exactly what the
gate is for, and it forced the fast/safe redesign (§16) rather than being discovered in D4-1B.

### 29.3 The variance is itself a finding

Re-measured on a database carrying ~60,000 accumulated rows from repeated benchmark runs, the same code
gave kernel-floor p95 **1,094 ms** and representative p95 **2,954 ms** — the representative layer
approaching the budget under accumulated load, **before any price or tax revalidation exists**. Both
numbers are reported because the honest reading is the pair, not the better one.

### 29.4 What this does and does not establish

It establishes that the kernel's own cost is not the obstacle, and that the audit chain is the dominant
per-operation term. It does **not** establish `NFR-PERF-032`: neither layer includes price resolution,
tax computation, discount distribution or loyalty accrual, because D4-1A has no domain handlers. The
environment is also a single local container, not the reference environment the requirement is graded
on — which is why the suite **records** the p95 rather than failing the build on it, a threshold tuned
here would be measuring the laptop.

> **`NFR-PERF-032` — NOT YET FULLY VERIFIED.**

---

## 30. Representative benchmark

Layer B above. The probe is not a toy: per operation it appends a **real hash-chained audit entry**
behind the per-tenant advisory lock, and the kernel additionally performs the dedup write, the history
write and the conflict-lookup read path. It is an existing, fully-ratified, inexpensive domain operation
(option B of the brief's §23) rather than a fabricated financial operation, and it is registered **only
by test modules** — `SyncModule` provides no handler.

The gap between layers (317 → 883 ms p50) is almost entirely the audit chain, which is what makes
§31 the more important of the two gates.

---

## 31. Audit contention probe (P-D4-02)

`test/sync-audit-contention.e2e-spec.ts` — **5 passed.** Three terminals of **one tenant**, 100
audit-writing operations each, draining concurrently.

| Measure | Value |
|---|---|
| Single terminal, alone | 335 ms |
| Three terminals concurrently, per terminal | 649 / 640 / 547 ms |
| Three terminals concurrently, wall clock | 656 ms |
| **Serialisation ratio** (wall ÷ single-terminal) | **1.96** |
| Audit entries written | 405 |
| Duplicate sequence numbers | **0** |
| Sequence contiguity from 1 | **verified** |
| Hash chain | **verified intact** by the repository's own `verifyAuditChain` |
| Deadlocks / exhausted retries | **none** |

**Reading it honestly.** Perfect serialisation would be 3.0, perfect parallelism 1.0. At **1.96** the
per-tenant chain is a genuine bottleneck — roughly two-thirds of the theoretical worst case — but it is
not catastrophic and it does not deadlock. Concurrent terminals of one tenant will contend, and that
contention scales with the number of draining terminals, which is exactly the `UC-OFF-01` recovery
shape (1,204 audit events from one branch's six-hour outage).

**The chain was not weakened to produce these numbers**, and must not be: it is a `FR-SEC` repudiation
control and an ADR-010 append-only guarantee. Batched audit persistence remains available to D4-1B only
where it is compatible with the immutable chain contract.

---

## 32. Typecheck

`npx tsc --noEmit -p tsconfig.json` — **one error, pre-existing and untouched**:

```
src/modules/identity/auth/access-token.service.spec.ts(28,7): error TS2322:
  Type 'string' is not assignable to type 'number | StringValue | undefined'.
```

Confirmed present at the starting HEAD before any change. It is an **Identity** surface that Lane B is
independently modifying, so it was deliberately **not** touched. No other type error exists.

---

## 33. Unit

`npx jest` — **64 suites, 894 tests, all passing.** Includes the 79 sync tests (HLC 53, ids 13,
scheduler 13) and `module-boundaries.spec.ts`.

---

## 34. E2E

`npx jest --config ./test/jest-e2e.json --runInBand` — **71 suites, 1,218 tests, all passing**, on a
disposable database migrated from zero.

Sync-specific: **7 suites, 65 tests** (protocol 26, idempotency 10, causal 9, RLS 7, crash-recovery 5,
performance 3, audit contention 5).

> **Note on parallel execution.** Run without `--runInBand`, 20 suites fail — teardown foreign-key
> violations from suites interfering over one shared database. This reproduces on suites this slice
> never touched and is a pre-existing property of the e2e design, not a regression. Serial execution is
> the meaningful configuration and is what is reported.

---

## 35. Module boundaries

`module-boundaries.spec.ts` passes, which means **the new `sync` module adds no `KNOWN_DEVIATIONS`
entry**. It imports only `identity/contract`, `governance/contract`, `identity.module` (the permitted
composition-root exemption) and `common/**`. `AuditModule` and `IdempotencyModule` are deliberately not
imported — both are `@Global()`, and importing them is precisely what manufactured the older modules'
private-path deviations.

**One guard was corrected.** The test *"Reporting owns no Prisma model and no migration"* asserted a
**global migration count** (`toBe(35)`) as a proxy. Any lane adding a migration then fails a Reporting
test for a reason unrelated to Reporting — and with several lanes adding migrations this wave, each
would conflict with the others' number. It now asserts the actual intent: no migration creates a
`reporting` schema or a table in one, whatever the count is. Stronger and stable. Flagged in §41.

---

## 36. Migration-from-zero

A disposable database was created and **all 36 migrations applied from empty**, then verified directly:

- 7 tables in `sync` (6 new + the pre-existing `idempotency_keys`);
- `operation_dedup` primary key is exactly `PRIMARY KEY (tenant_id, op_id)`;
- RLS enabled **and forced** on all 7;
- 4 policies per table.

`prisma format`, `prisma validate` and `prisma generate` all clean.

---

## 37. Legacy upgrade

Also proven, on a second disposable database:

1. the migration directory was temporarily removed and the **35 pre-existing** migrations applied
   (`_prisma_migrations` → 35 finished);
2. it was restored and `prisma migrate deploy` re-run → **36 finished**, `sync` containing 7 tables.

So the migration applies as an in-place upgrade from the pre-D4-1A baseline, not only from zero.

---

## 38. Requirement disposition

| Requirement | Status | Basis |
|---|---|---|
| `FR-OFF-015` | **COMPLETE (server protocol behaviour)** | Client ids are permanent primary keys; the server never remaps; `opId`/`entityId` echoed and stored verbatim; collision and cross-tenant cases tested; corpus-graded |
| `FR-OFF-020` | **PARTIAL** | Batching, the 500 cap and byte caps implemented and tested. **Plan-derived limits are absent** — no plan/entitlement substrate exists |
| `FR-OFF-021` | **COMPLETE** | Every operation carries `opId`; ≥30-day retention stamped and asserted; a repeat returns the **original** result rather than reprocessing |
| `FR-OFF-022` | **COMPLETE** | Causal order applied; a parentless operation is deferred, not rejected; cascade and cycle handling tested |
| `FR-OFF-023` | **COMPLETE** | Per-operation `accepted`/`duplicate`/`conflict`/`rejected` with reasons, plus the ratified `deferred`; a failing operation never fails the batch, proven directly |
| `FR-OFF-024` | **COMPLETE (server half)** | Every result carries an explicit `definitive` flag; the vocabulary is documented in OpenAPI. Outbox behaviour itself is FRONTEND-EXTERNAL |
| `FR-OFF-025` | **COMPLETE** | Batch replay, lease reclaim and mid-batch resume all proven with no duplication and no stranding |
| `FR-OFF-040` | **PARTIAL** | Conflict substrate and the `conflict` result exist; **no domain conflict strategy is implemented** |
| `FR-OFF-041` | **COMPLETE (server / shared-server half)** | Algorithm verbatim; corpus covers all branches, the tie-break, encoding and malformed input. Global completion depends on Dart client parity |
| `FR-OFF-042` | **PARTIAL** | Detected, recorded, both timestamps preserved, `CT-10` proven. **Alert delivery is an audit entry** — no notification substrate exists |
| `FR-OFF-043` | **PARTIAL** | Register and both-versions storage exist; no domain conflict handler populates them yet |
| `FR-OFF-044` | **PARTIAL** | Audit writer with both input states and applied rule exists and is used for skew; domain conflict audits are D4-1B |
| `FR-OFF-045` / `046` / `047` | **PARTIAL** | Sync-owned exception substrate, the accept-and-flag rule and the mismatch counter exist. The computations are D4-1B |
| `FR-OFF-050` / `051` | **PARTIAL** | HLC and ids corpora added and running server-side. **No Dart runner, no dual-suite CI, no release-blocking gate** |
| `FR-API-020` … `023` | **REUSED, UNCHANGED** | Sync owns its own reservation record; shared idempotency semantics are untouched |
| `NFR-REL-010` | **SUPPORTED, not proven** | Ack ordering, durability-before-acknowledgement and crash resume implemented and tested. Full proof needs `CT-01` |
| `NFR-REL-011` | **COMPLETE (protocol level)** | At-most-once **financial effect** asserted on the effect itself, not merely on rows |
| `NFR-PERF-032` | **NOT YET FULLY VERIFIED** | Measured at two layers; realistic revalidation absent (§29.4) |
| `CT-06` | **NOT PASSED globally** | Server half only |
| `CT-10` | **Server-side executable proof passes** | Global CT still depends on client conformance |
| `CT-01` | **NOT PASSED** | Requires the full offline stack and 72 elapsed hours |
| `CT-14` | **Partially exercised** | 500-operation batches with bounded memory; the 20,000-operation drain is not run here |
| `FR-SEC-002` / `003` / `004` | **NOT CLAIMED** | Lane B |

**No production claim is made.**

---

## 39. D4-1B remaining work

1. Domain operation handlers (`order.*`, `payment.*`, `cash_session.*`, `kitchen.ticket.*`,
   `inventory.movement.*`) via `@SyncOperationHandlerFor`.
2. The ratified conflict matrix wired to real handlers, including the four `GD-D1-04` rows.
3. `FR-OFF-045`/`046` revalidation over the computations that exist — price resolution, tax, discounts,
   service charge, cash rounding — with accept-and-flag.
4. `FR-OFF-047` threshold escalation to a platform alert.
5. Re-measure `P-D4-01` **with** revalidation in the loop; the representative layer already sits at
   ~3.2× headroom on a quiet database and ~1.0× under accumulated load.
6. Review the `causal_parent_rejected` decision recorded in §15.
7. Consider domain-level `hlc`/`sync_state` columns **only** where a concrete conflict handler proves it
   needs query-time materialisation.
8. Physical partitioning of `sync_operations`, once a partition-lifecycle job exists.
9. Retention reapers for `sync.operation_dedup` and the still-unpruned `sync.idempotency_keys`.

---

## 40. External / cross-lane blockers

| Blocker | Owner | Blocks |
|---|---|---|
| **Lossless revoked-terminal recovery** | Lane D + governance | **D4-1 FULL completion** (hard gate) |
| **`P-D4-01` with realistic revalidation** | D4-1B | **D4-1 FULL completion** (hard gate) |
| **`P-D4-02` at production scale** | D4-1B | **D4-1 FULL completion** (hard gate) |
| Branch-scoped RBAC (`B1-2`) | **Lane B** | Operation authorisation beyond terminal-branch; permission bootstrap |
| Canonical `TaxDocument` / fiscal sequence | `C3-1` / `P7-FISCAL` | `D4-3`; `CT-01`'s fiscal criterion |
| Repository-wide `/v1` versioning | **Platform** | Versioning every other route; Sync already exposes its canonical route |
| Dart runner + dual-suite CI | **Lane G / frontend** | `FR-OFF-050`/`051`, `CT-06` |
| Scheduled-job infrastructure | **Platform** | Automated retention; `sync_operations` partitioning |
| Per-tenant/per-terminal rate limiting | Lane B / platform | Sync endpoint protection sized for a `CT-14` drain |
| `crm` schema (loyalty, customers) | Unassigned | `CT-13` |
| Plan / entitlement limits | Unassigned | `FR-OFF-020` plan-derived caps |
| `CG-01` exact-caller-delta correction | **Lane A** | Trustworthy stock-movement replay (explicitly out of D4-1A acceptance) |

---

## 41. Integration conflict risks

Ranked by likelihood of a merge conflict.

| # | File | Risk | Mitigation already taken |
|:--:|---|---|---|
| 1 | `prisma/schema.prisma` | **HIGH** — a shared text surface all lanes edit. Additions are in one block at EOF, plus 6 lines in `Tenant`'s relation list. `prisma format` also re-aligned 83 unrelated lines | New models appended at the very end, away from identity/inventory. **Zero content lines lost** (proved by normalised diff). The `Tenant` block is the only interior edit |
| 2 | `prisma/migrations/` ordering | **HIGH** — timestamp `20260902010000`. Lanes A and B are adding their own; final order is resolved on the integration branch | Migration is additive, creates only `sync` objects, and depends only on `identity.tenants` existing |
| 3 | `src/modules/module-boundaries.spec.ts` | **HIGH** — the global migration-count assertion. **Every** lane adding a migration touches this line | Replaced the count with an intent assertion, so no future lane needs to touch it. Whoever merges second should keep the intent version, not restore a number |
| 4 | `src/modules/governance/audit/audit.constants.ts` | MEDIUM — additive entries at the end of two objects | Three actions and three entities appended at the block ends |
| 5 | `src/app.module.ts` | LOW — one import and one entry at the end of `imports` | |
| 6 | `src/main.ts` | LOW — two helper calls | Both delegate to helpers, so a conflict is one line each |
| 7 | `docs/api/openapi.*` | MEDIUM — regenerated artifacts conflict textually | Resolve by regenerating (`npm run openapi:generate`), never by hand-merging |
| 8 | `src/swagger.config.ts` | LOW — server description rewritten | Prose only |
| 9 | `test/openapi.e2e-spec.ts` | LOW — one call added | Required, or every versioned route reads as drift |

**Nothing in `src/modules/{identity,inventory}` was modified.**

---

## 42. Files changed

**Modified (10):** `prisma/schema.prisma` · `src/app.module.ts` · `src/main.ts` ·
`src/scripts/generate-openapi.ts` · `src/swagger.config.ts` ·
`src/modules/governance/audit/audit.constants.ts` · `src/modules/module-boundaries.spec.ts` ·
`test/openapi.e2e-spec.ts` · `docs/api/openapi.json` · `docs/api/openapi.yaml`

**New — migration (1):** `prisma/migrations/20260902010000_sync_protocol_kernel/migration.sql`

**New — source (18):** `src/common/http/api-versioning.ts` · `src/modules/sync/` —
`sync.module.ts`, `sync.controller.ts`, `sync.dto.ts`, `sync.schemas.ts`, `sync.bootstrap.ts`,
`sync.failpoint.ts`, `contract/{index,sync-operation-handler,sync-authorization.port}.ts`,
`auth/sync-terminal.guard.ts`, `batch/{sync-batch.service,batch-reservation.service,savepoint}.ts`,
`operations/{operation-scheduler,sync-operation.registry,sync-operation-handler.decorator}.ts`,
`device/device-state.service.ts`, `conflict/conflict-record.service.ts`,
`revalidation/revalidation-exception.service.ts`, `hlc/{hlc,hlc-conformance.runner}.ts`

**New — tests (12):** `src/modules/sync/hlc/{hlc.spec,hlc-conformance.spec}.ts` ·
`src/modules/sync/ids/ids-conformance.spec.ts` ·
`src/modules/sync/operations/operation-scheduler.spec.ts` · `test/sync-fixtures.ts` ·
`test/sync-{protocol,idempotency,causal,crash-recovery,rls,performance,audit-contention}.e2e-spec.ts`

**New — conformance corpus (3):** `kitchen-kit/conformance/hlc/hlc-algorithm.corpus.json` ·
`kitchen-kit/conformance/hlc/hlc-ct10-clock-skew.corpus.json` ·
`kitchen-kit/conformance/ids/ids-rendering.corpus.json`

**Untouched:** `package.json` / `package-lock.json` · `src/modules/identity/**` ·
`src/modules/inventory/**` · `src/common/idempotency/**` · every pre-existing conformance file.

---

## 43. Database safety

**The persistent `ros` database was never touched, and could not have been.**

Work ran against a **dedicated, disposable container** — `ros-postgres-lane-d` on host port **5566**,
created for this slice — whose cluster contains **no database named `ros` at all**. The persistent
`ros` database lives in a different container (`ros-postgres`, port 5544) that this session never
connected to; Lane A's container (port 5555) was likewise untouched.

Databases used, all named `ros_lane_d_d41a_<timestamp>` (plus one `ros_lane_d_upgrade_<timestamp>` for
§37) and all disposable. `.env` is gitignored and is not part of the commit.

---

## 44. Commit

Single commit on `full-srs/lane-d-kds-offline`, staged by explicit path — no `git add .`, no
`git add -A`.

**Subject:** `feat(sync): establish offline protocol kernel`

**Not pushed. Not deployed. Not merged. Not rebased.** No destructive git operation was performed.

# D1-1 — OFFLINE / SYNC PROTOCOL FOUNDATION — RATIFICATION + ACCEPTANCE CORRECTION

| Field | Value |
|---|---|
| **Task / slice name** | P5-OFF1 / D1-1 — Acceptance correction + governance ratification |
| **Lane** | D — KDS + Offline/Sync |
| **Report type** | GOVERNANCE RATIFICATION / ACCEPTANCE CORRECTION (no implementation) |
| **Authority statement** | **This report is NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. **The authoritative outcome of this task is the register entry** *"D1-1 — Offline / Sync Protocol Foundation Ratification — 2026-09-02"*; this report records the reasoning and the evidence behind it. Where this report disagrees with the SRS or the register, the SRS and the register win. |
| **Date** | 2026-09-02 |
| **Starting HEAD** | `50b37067b8a2f9566fc285500fce6b02200b8cc1` (`50b3706`) — *docs(sync): define offline protocol design gate* |
| **Branch** | `full-srs/lane-d-kds-offline` |
| **Working tree at start** | Clean (`git status --short --untracked-files=all` empty) |
| **Working tree at report time** | Four documentation/governance files changed (§31). **No product code, no Prisma schema, no migration, no route, no controller, no service, no test, no package file, no conformance code.** |
| **Task identifier** | D1-1-RATIFICATION |
| **Status** | **COMPLETE** |

---

## 1. Status

**The D1-1 design gate is ACCEPTED WITH CORRECTIONS.**

Five architectural issues were identified during acceptance review. All five are corrected here.
Seven governance decisions proposed by the design gate are now resolved: **four ratified, one
ratified with a corrected representation, one deferred, one rejected.**

| Outcome | Count | Which |
|---|:--:|---|
| RATIFIED | 3 | `GD-D1-01`, `GD-D1-04`, `GD-D1-05` |
| RATIFIED WITH CORRECTION(S) | 2 | `GD-D1-02`, `GD-D1-06` |
| DEFERRED | 1 | `GD-D1-03` |
| **REJECTED** | 1 | **`GD-D1-07`** |

**`D4-1` CORE is authorised to begin.** It **cannot be declared fully complete** until three
residual hard gates close (§30).

**No implementation credit is created by this task** (§30.4). Nothing was implemented, measured
or tested. The original D1-1 report is retained unaltered as historical engineering evidence,
with one appended post-review note.

---

## 2. User authority

> **Explicitly approved during Full-SRS 4-Day execution after post-design acceptance review.**

The user reviewed the D1-1 design gate, identified five architectural defects, and issued the
ratification decisions recorded here. This is a governance action by the user, not an inference
drawn by this session. The register entry records the same authority statement verbatim.

Two of these decisions **overturn** what the design gate proposed:

- `GD-D1-07` (revoked-terminal backlog loss) is **REJECTED**. The user's stated position:
  *knowingly designing committed-sale loss into the system is not acceptable.*
- The design gate's root-only endpoint is **not** accepted as the permanent contract; the
  canonical Sync API is versioned under `/v1`.

Both are recorded as corrections to this lane's own proposal, not as ambiguities resolved.

---

## 3. Starting HEAD

Verified before any file was written:

```
$ pwd
/Users/mac/projects/ros-worktrees/lane-d

$ git rev-parse --show-toplevel
/Users/mac/projects/ros-worktrees/lane-d

$ git rev-parse HEAD
50b37067b8a2f9566fc285500fce6b02200b8cc1

$ git branch --show-current
full-srs/lane-d-kds-offline

$ git status --short --untracked-files=all
(empty)

$ git log -1 --oneline
50b3706 docs(sync): define offline protocol design gate
```

All required files present:
`docs/reports/claude/full-srs-4day/2026-09-02_D1-1_offline-sync-design-gate.md` ·
`docs/reports/claude/full-srs-4day/INDEX.md` ·
`docs/governance/GOVERNANCE_DECISION_REGISTER.md`.

---

## 4. Original D1-1 acceptance

| Item | Outcome |
|---|---|
| **D1-1 design gate** | **ACCEPTED WITH CORRECTIONS** |
| **D1-1 original report** | **RETAINED** as historical design evidence — body unaltered; one post-review note appended (§31) |
| **D4-1 CORE implementation** | **AUTHORISED** after this ratification |
| **D4-1 final full-scope acceptance** | **NOT authorised** — subject to the residual hard gates in §30 |
| **Implementation credit** | **NONE created** (§30.4) |

What the design gate got right and is carried forward unchanged: the ULID identity discipline,
the verbatim `FR-OFF-041` algorithm, the envelope field set and its security boundary, the
`FR-OFF-046` accept-and-flag invariant, the acknowledgement/definitiveness model, the fiscal
deferral discipline, the conformance-corpus principle, and the identification of the two
performance risks — which are now promoted from *risks* to *release gates* (§26, §27).

---

## 5. Corrections made during review

Five, in the order they appear in the corrected architecture.

| # | Correction | What the design gate said | What is now authoritative |
|:--:|---|---|---|
| **C-1** | **Operation idempotency vs partitioning** | `sync.sync_operations` RANGE-partitioned on `received_at` **and** carrying `UNIQUE (tenant_id, op_id)` as the global idempotency guarantee | **Those two cannot coexist in PostgreSQL.** Global operation identity moves to a small non-partitioned dedup registry; partitioned history is separate and is never the sole uniqueness mechanism (§12, §13) |
| **C-2** | **Batch idempotency is not "unchanged"** | `sync.idempotency_keys` / `IdempotencyService` *"reused **unchanged**"* | May be reused as the **foundation**, but batch processing must be **crash-recoverable**. A crash between `reserve()` and `complete()` must not strand a valid batch at `409` forever (§14) |
| **C-3** | **Failure isolation, not 500 commits** | *"`FR-OFF-023` **forces** per-operation transactions"* | `FR-OFF-023` requires **per-operation failure isolation**, not per-operation physical commit. `D4-1` chooses a transaction strategy capable of meeting `NFR-PERF-032` (§15, §16) |
| **C-4** | **Committed backlog loss rejected** | `GD-D1-07`: revoked terminal → reject batch → *"backlog is lost by design"* | **REJECTED.** Committed offline sales must have a controlled, auditable, lossless recovery path. Lossless revoked-terminal recovery is a **hard follow-up gate** (§20, §21) |
| **C-5** | **Canonical API is versioned** | *"`D4-1` registers `@Controller('sync')` at the application root"* as the contract | The canonical Full-SRS external contract is **`/v1`**-versioned. Lane D must **not** unilaterally retrofit repository-wide routing; it must coordinate (§22) |

### 5.1 C-1 is confirmed by existing repository precedent, not merely asserted

PostgreSQL requires every unique constraint on a partitioned table to include **all** partition
key columns. This repository already documents that exact constraint, in
`prisma/schema.prisma:1767`:

> *"`orders` and `order_lines` are monthly RANGE-partitioned on `business_day` (FR-DR-001).
> **PostgreSQL requires the partition key inside every unique constraint**, hence the composite
> ids below — `id` is still the permanent client-generated ULID (FR-OFF-015); the composite is a
> storage requirement, not a second identity."*

Applied to the design gate's proposal: partitioning `sync_operations` on `received_at` would
force the unique key to become `(tenant_id, op_id, received_at)`. That is **not** a global
uniqueness guarantee — the same `op_id` re-submitted in a later month would land in a different
partition and insert cleanly. **The idempotency guarantee would silently be no guarantee at all**,
and `NFR-REL-011` ("at-most-once financial effect") would fail in exactly the case it exists for:
a device that was offline across a partition boundary.

The design gate called `UNIQUE (tenant_id, op_id)` *"the single most important constraint in this
design"* while simultaneously specifying a partitioning scheme that makes it unenforceable. The
correction is necessary, and the same schema comment that proves it is the precedent for the fix.

---

## 6. GD-D1 decision table

| ID | Decision | Outcome | Blocking `D4-1` before? | Residual |
|---|---|---|:--:|---|
| **`GD-D1-01`** | Identifier wire form = canonical UUID hex | **RATIFIED** | Yes → resolved | None |
| **`GD-D1-02`** | HLC canonical representation | **RATIFIED WITH CORRECTION** (example corrected; column width demoted to an implementation detail) | Yes → resolved | Column width derived at `D4-1` |
| **`GD-D1-03`** | Bounded server HLC adoption / per-terminal server clock | **DEFERRED** | No | Separate design + conformance proof required before adoption |
| **`GD-D1-04`** | Fifth per-operation status `deferred` + four proposed conflict rules | **RATIFIED** | Yes → resolved | Domain-specific tests; stricter domain rules win later (§6.2) |
| **`GD-D1-05`** | Home of `FR-OFF-046` reconciliation exceptions | **RATIFIED → `sync.revalidation_exceptions`** | No | Names/columns are `D4-1` detail |
| **`GD-D1-06`** | Shaping bundle (versioning, limits, retention, watermark, tombstones, partitioning) | **RATIFIED WITH ARCHITECTURE CORRECTIONS** | Partly | Byte caps are testable defaults; tombstones block `D4-2` |
| **`GD-D1-07`** | Revoked terminal rejects batch; unsynced backlog lost | **REJECTED** | Yes → resolved by rejection | **Lossless recovery = HARD FOLLOW-UP GATE** |

All four decisions the design gate flagged as blocking `D4-1` are now resolved — three ratified,
one rejected and replaced by a hard gate that permits `D4-1` CORE to proceed (§21.3).

### 6.1 What `GD-D1-04` ratifies beyond the fifth status

The four conflict rows the design gate marked **[PROPOSED]** are ratified for the domains that
exist today, subject to later domain-specific tests:

| Conflict matrix row | Ratified rule |
|---|---|
| 3 — **order void vs payment** | Payment wins; money physically moved cannot be un-taken by ordering. Reconciliation exception; manager decides refund |
| 5 — **partitioned overpayment** | Accept both; both sums were physically taken. Reconciliation exception → refund workflow |
| 12 — **overlapping / offline cash sessions** | Neither auto-wins; counts are physical facts. Conflict record with both counts; manager reconciles |
| 15 — **KDS ticket state** | LWW by HLC per field over a monotonic state machine; legal-transition guard prevents a stale operation un-bumping a served ticket; a higher-HLC recall is honoured |

### 6.2 The precedence rule attached to `GD-D1-04`

This ratification does **not** claim that absent domains (CRM/loyalty, attendance, fiscal) are
implemented, and it does not pre-empt them.

> **Where a domain later defines stricter legal or fiscal semantics, the domain's ratified rule
> WINS, and the sync conflict registry must be extended explicitly.**

Sync's conflict rules are a protocol-level default for domains that have not spoken. They are
never a licence to override a domain's own ratified rule, and the fiscal case (§24) is the one
where a sync default could be **legally unavailable**.

---

## 7. Identifier ratification — `GD-D1-01` RATIFIED

**RATIFIED.**

1. Client-generated identifiers **remain ULIDs**, as `FR-OFF-015` [M] requires.
2. The permanent 128-bit identifier is rendered on the ROS wire/API as the **repository-standard
   canonical UUID hexadecimal string**.
3. **The server SHALL NOT remap or reassign the identifier** — `FR-OFF-015`, unchanged and
   unqualified.
4. Crockford base32 remains a valid alternate textual representation *of the same ULID*. It is
   **not** the canonical ROS API representation.

**Basis.** ADR-009 (Accepted) permits ULID storage as `BYTEA(16)` **or native UUID**; this
repository chose native UUID and implements the rendering in `src/common/ids.ts`
(`ulidToUUID(ulid())`, plus the deliberately lenient `UUID_PATTERN` because ULID-derived values
are valid `uuid` but not RFC-4122). Every id column is `@db.Uuid`; every id-shaped DTO field
validates against that pattern; `src/common/openapi/oas31.util.ts` detects id fields by the same
convention.

The decisive consideration is that this avoids **two incompatible ID encodings in one API**. The
SRS §21.5.1 snippet showing `"opId": "01J8..."` is illustrative JSON; `FR-OFF-015` constrains the
identifier, not its text encoding, and the two forms carry the same 128 bits.

**No product code changes in this task.**

---

## 8. HLC ratification — `GD-D1-02` RATIFIED WITH CORRECTION

### 8.1 Semantic algorithm — unchanged, and not open for variation

**EXACTLY the normative `FR-OFF-041` algorithm**, on both client and server:

```
On local event:
  l' = max(l, physical_time)
  c' = (l' == l) ? c + 1 : 0

On receiving message with (l_msg, c_msg):
  l' = max(l, l_msg, physical_time)
  c' = if l' == l == l_msg then max(c, c_msg) + 1
       else if l' == l      then c + 1
       else if l' == l_msg then c_msg + 1
       else 0
```

**No alternative HLC algorithm is invented, and none may be.** This is a `CT-06`-graded shared
algorithm; an "improvement" on either side is a divergence.

### 8.2 Canonical representation — RATIFIED

```
<physical_ms> "." <logical> "." <node>
```

| Segment | Rule |
|---|---|
| `physical_ms` | **exactly 13** zero-padded decimal digits — Unix epoch **milliseconds**, for the supported operational date range |
| `logical` | **exactly 5** zero-padded decimal digits |
| `node` | **exactly 32** lowercase hexadecimal characters — the originating terminal UUID with dashes removed |

Fixed width is the point: **lexical comparison is deterministic and matches component ordering**,
so the stored string sorts causally with no parsing.

### 8.3 The corrected example

The original D1-1 report §7.2 printed:

```
0001722765753000.00042.7f3a9c1e4b8d42f0a1c5e6b70d29f841
```

whose physical segment is **16 digits, not 13** — a formatting error in the illustration, not in
the specification (the accompanying annotation already said 13). Corrected:

```
1722765753000.00042.7f3a9c1e4b8d42f0a1c5e6b70d29f841
└─── 13 ────┘ └─5─┘ └────────────── 32 ─────────────┘
```

`1722765753000` is already exactly 13 digits and needs no padding. Total length: 13 + 1 + 5 + 1 +
32 = **52 characters**. A 13-digit millisecond field spans 2001-09-09 to 2286-11-20, which covers
the supported operational date range with no encoding change.

**The semantic algorithm is unchanged by this correction.** Only the illustration was wrong.

### 8.4 What is demoted to an implementation detail

**Column width and final database type are `D4-1` implementation details**, derived from the
ratified canonical representation. They are not ratified here.

### 8.5 SRS source defect — recorded, not resolved

The SRS specifies the `hlc` column twice and contradicts itself: **§7.4.1 `VARCHAR(40)`** vs
**§25.2 `VARCHAR(48)`**. Neither can be normative while they disagree. This remains recorded as a
**source defect**, alongside the source-integrity findings in P0 §3. It is not resolved by this
ratification and must not be quietly "picked".

---

## 9. Deferred HLC hardening — `GD-D1-03` DEFERRED

**Status: DEFERRED ENGINEERING HARDENING. Not ratified.**

**Reason.** The normative `FR-OFF-041` algorithm and `CT-10` can be implemented and verified
**without** changing clock-adoption semantics. `CT-10`'s pass criterion — *"HLC ordering
preserved; skew alerted; original timestamps retained"* — is met by the algorithm as written,
plus `FR-OFF-042` skew detection. The design gate said so itself.

Per-terminal HLC state and bounded adoption may be valuable defence-in-depth against a single
badly-skewed device displacing a tenant's clock, **but they must not alter the normative shared
algorithm without a separate design and a conformance proof.** A unilateral change to a
`CT-06`-graded algorithm on the server side alone would guarantee client/server divergence.

**Consequence for `D4-1`:**

- `D4-1` **MAY** design extension points for bounded adoption.
- `D4-1` **MUST NOT** claim bounded adoption as ratified behaviour.
- `D4-1` **MUST NOT** deviate from `FR-OFF-041` in the shipped algorithm.

---

## 10. Operation envelope — carried forward

Carried forward from the design gate **unchanged**, with the current security boundary intact.

**Operation:**

```
opId · hlc · type · entityId · causedBy · actorEmployeeId · occurredAt · schemaVersion · payload
```

**Batch:**

```
protocolVersion · deviceId · batchId · lastServerCursor · operations
```

**Security boundary — unchanged and binding:**

- **No `tenantId` in the body.** Tenant identity is derived from authenticated server context.
- **Branch identity for a registered terminal is derived server-side**, never trusted from
  arbitrary client body input.

This matches the existing repository rule stated in `IdempotencyInterceptor`: *"The tenant comes
from the authenticated principal, never from the body, so a key can never be replayed across a
tenant boundary."*

**`clientSeq` — no change.** No mandatory `clientSeq` is introduced in `D4-1` unless
implementation evidence shows causal or idempotency correctness requires it. Causality is carried
by `causedBy` + HLC; idempotency by `opId` + `batchId`. **Sequence-gap semantics must not be added
without a separately demonstrated need** — they would impose a gap-detection obligation the SRS
never asks for.

**Nothing in this section is implemented by this task.**

---

## 11. Deferred result semantics — `GD-D1-04` RATIFIED

**RATIFIED: the fifth per-operation result `deferred`.**

### 11.1 Why the fifth state is required, not preferred

Two mandatory clauses are not jointly implementable with four statuses:

- **`FR-OFF-022` [M]** — an operation whose causal parent has not been applied *"SHALL be
  **deferred, not rejected**"*.
- **`FR-OFF-024` [M]** — the client removes an operation from the outbox *"only upon receiving a
  **definitive** server response"*.

`FR-OFF-023`'s four statuses are all definitive. Mapping "deferred" onto any of them breaks
something: `rejected` makes the client discard an operation the server explicitly promised to
accept later (sale lost — `NFR-REL-010`); `conflict` is semantically false and would raise a
spurious conflict record for a manager; omitting it from the results array is indistinguishable
from a server bug that dropped an operation.

**The fifth state is a protocol clarification needed to make the mandatory SRS clauses jointly
implementable.** It is not an extension of scope.

### 11.2 The ratified definitiveness table

| Status | Definitive? | Client action |
|---|:--:|---|
| `accepted` | **YES** | Remove from outbox |
| `duplicate` | **YES** | Remove from outbox |
| `conflict` | **YES** | Remove from outbox; surface; do not retry |
| `rejected` | **YES** | Remove from outbox; dead-letter locally; do not retry |
| **`deferred`** | **NO** | **Retain**; retry after the causal dependency is satisfied |
| transport failure / timeout / 5xx | **NO** | Retain the whole batch; retry with backoff |

The client retains a deferred operation and retries **after its causal dependency has been
satisfied**.

---

## 12. Corrected operation dedup architecture — CORRECTION 1 (A)

### 12.1 The design conflict, recorded explicitly

**The original design is NOT ratified**, because it simultaneously relied on:

- RANGE partitioning of `sync_operations` by `received_at`, **and**
- global `UNIQUE (tenant_id, op_id)` on that same partitioned table.

PostgreSQL cannot provide both (§5.1). Under partitioning the constraint necessarily becomes
`(tenant_id, op_id, received_at)`, which does not prevent the same `op_id` being applied twice in
different partitions — the exact failure `NFR-REL-011` exists to prevent.

### 12.2 The ratified separation

The authoritative architecture **SHALL separate**:

**A. GLOBAL OPERATION IDEMPOTENCY IDENTITY** from **B. HIGH-VOLUME OPERATION HISTORY /
OBSERVABILITY.**

### 12.3 A — sync operation dedup registry

A **small, non-time-partitioned, authoritative relation** — conceptually `sync.operation_dedup` —
owns the globally enforceable key:

```
PRIMARY KEY / UNIQUE (tenant_id, op_id)
```

It contains enough immutable data to:

1. detect duplicate operation IDs;
2. detect same-`opId`/different-fingerprint client defects;
3. return or locate the original per-operation result (`FR-OFF-021`);
4. preserve the minimum idempotency retention guarantee;
5. **prevent the same financial effect being applied twice** (`NFR-REL-011`).

**Exact table name and columns are `D4-1` implementation details.** What is ratified is the
*separation* and the *global enforceability of the key*, not a schema.

### 12.4 B — `sync_operations` history

A high-volume operation/history relation **may** be time-partitioned for inspection, conflict
analysis, audit linkage, operational history and retention management.

> **It MUST NOT be treated as the sole global uniqueness mechanism** where PostgreSQL partitioning
> prevents enforcing global `(tenant_id, op_id)` uniqueness.

`FR-OFF-040`/`-043`/`-044`/`-046` all require the operation to remain inspectable, so the history
relation is genuinely needed — it simply is not the identity authority.

### 12.5 Dedup atomicity invariant — RATIFIED

The dedup registry **MUST NOT become a second non-atomic write that can diverge from the business
effect.**

For every accepted operation, the authoritative operation result / dedup reservation and the
business effect **must participate in a crash-safe protocol.**

`D4-1` must prove that a crash can never produce either failure direction:

| Forbidden state | Why it is fatal |
|---|---|
| **business effect committed + no durable record that the `opId` was applied**, in a way that allows re-application on retry | Double financial effect — violates `NFR-REL-011`, fails `CT-01` "zero duplication" |
| **dedup says accepted + business effect never committed**, externally acknowledged as `accepted` | The client discards on a false acknowledgement — sale lost, violates `NFR-REL-010`, fails `CT-01` "zero loss" |

**Exact transactional implementation is `D4-1`'s design responsibility.**

*Non-binding engineering observation:* both relations live in the same PostgreSQL database, so
the natural discharge of this invariant is for the dedup write and the business effect to commit
**in the same transaction**, which makes atomicity structural rather than protocol-enforced. If
`D4-1` chooses any other pattern — a reserve-then-apply flow, for instance — it must supply an
equivalent crash-safe protocol and demonstrate that **both** rows of the table above are
unreachable. This observation is guidance, not a ratified constraint.

---

## 13. Partitioning boundary

| Concern | Relation | Partitioned? | Rationale |
|---|---|:--:|---|
| Global operation identity / idempotency | dedup registry | **NO** | Global `UNIQUE (tenant_id, op_id)` must be enforceable |
| Operation history, conflict analysis, audit linkage, retention | `sync_operations` history | **MAY BE** | Genuinely high-volume; retention by partition drop rather than `DELETE` storm |
| Batch telemetry | `sync_batches` | May be | Volume-driven |
| Device state | `sync.device_state` | **NO** | One row per `(tenant, terminal)` |
| Conflict records | `sync.conflict_records` | **NO** | Low volume, long-lived, manager-facing |
| Revalidation exceptions | `sync.revalidation_exceptions` | **NO** | Low volume, review-driven, must remain reachable |

**Ratified boundary rule:** *partitioning must not break idempotency correctness.* Where the two
conflict, idempotency wins and the data moves to an unpartitioned relation.

**Retention consequence.** The dedup registry is unpartitioned, so its retention **must** be
enforced by an automated reaper rather than by dropping partitions, and its floor is set by §19.

---

## 14. Crash-recoverable batch idempotency — CORRECTION 2

### 14.1 What is corrected

`sync.idempotency_keys` / `IdempotencyService` **MAY be reused as the foundation** for
batch-level idempotency.

**The phrase *"reused unchanged"* from the original D1-1 report §16.2 is NOT ratified**, because
`D4-1` requires crash-recoverable batch processing.

### 14.2 The failure case, concretely

1. Batch reservation enters `in_flight`.
2. Some operations commit.
3. The process **dies** before `complete()` / batch-response persistence.
4. The client retries the exact same batch.

Under the current service this is a real trap: `reserve()` commits the `in_flight` row in its own
transaction, and `release()` — which deletes it — is only called on a *handled* failure. **A
process death never calls `release()`.** The retry therefore finds a `completed`-less `in_flight`
row and receives *"This Idempotency-Key is being processed concurrently. Retry shortly."*
Forever.

> **The system MUST NOT leave that batch permanently trapped as `409 being processed` with no safe
> recovery path.**

### 14.3 Ratified required behaviour

A batch in progress **must have a reclaim/recovery mechanism.**

Conceptual states may include `in_flight` and `completed`, plus crash-ownership metadata such as
**lease / owner / attempt / expires_at**. **Exact schema is NOT ratified here.**

| Condition | Required behaviour |
|---|---|
| same `batchId` + same fingerprint + **live owner** | May report *currently processing*, per implementation semantics |
| same `batchId` + same fingerprint + **stale/dead owner or expired lease** | **Safely reclaim / resume** |
| same `batchId` + **different fingerprint** | `409` — client defect (`FR-API-023`) |

**On resume:**

- already-applied `opId`s → `duplicate` / original result;
- not-yet-applied `opId`s → continue normally.

> **The client must never need to invent a new operation ID merely because the server process
> crashed.**

### 14.4 Why the two corrections are complementary

Resume is safe **precisely because** operation-level dedup (§12) is global and authoritative. The
batch reclaim does not need to reconstruct what was applied — it simply re-runs the batch, and
the dedup registry answers per operation. Correction 1 is what makes Correction 2 cheap; had the
uniqueness guarantee remained on a partitioned table, resume would have been unsound.

### 14.5 `FR-OFF-025` invariant — RATIFIED

A server crash or connection loss during a batch **SHALL NOT**:

1. duplicate an already-applied operation;
2. permanently strand a valid batch;
3. require loss of acknowledged sales;
4. require changing `opId`s;
5. make the outbox unrecoverable.

**This is part of `D4-1` acceptance**, not a best-effort goal.

---

## 15. Failure isolation vs transaction strategy — CORRECTION 3

### 15.1 What is corrected

**NOT ratified:** *"one PostgreSQL transaction per operation"* as an SRS requirement.

`FR-OFF-023` [M] requires: *"A single failing operation SHALL NOT fail the batch."* That is a
statement about **failure isolation**, not about physical commit granularity. The original report
inferred a mandatory implementation from a semantic requirement.

### 15.2 The ratified invariant

> **PER-OPERATION FAILURE ISOLATION** — not **PER-OPERATION PHYSICAL COMMIT.**

`D4-1` is **authorised to choose an implementation capable of meeting `NFR-PERF-032`.**

This matters because the design gate's own arithmetic showed the inferred requirement was likely
unachievable: 500 operations in 3 s p95 is 6 ms per operation, and that budget must cover
revalidation, the write, the audit append and the commit. Removing a self-imposed constraint that
the SRS never stated is the difference between a meetable and an unmeetable gate.

---

## 16. Allowed `D4-1` performance architecture

`D4-1` **MAY** use:

- one **pinned database connection** for a batch;
- **transaction chunks**;
- **`SAVEPOINT` per operation**;
- **preloaded reference data**;
- **set-oriented reads**;
- **set-oriented writes** where business invariants permit;
- **batched audit persistence** where compatible with the immutable hash-chain contract.

It **must preserve**, for each operation:

1. independent semantic status;
2. independent rollback / failure isolation;
3. correct dedup result;
4. correct business effect;
5. required audit / domain-event semantics.

> **One failed operation MUST NOT convert independent successful operations into failures.**

*Non-binding engineering observation:* `SAVEPOINT` per operation inside a chunk transaction
satisfies the invariant naturally — a failing operation rolls back to its savepoint, its siblings
survive, and the dedup row for the failed operation can then be written with its `rejected` status
inside the same outer transaction, so a retry replays the rejection rather than reprocessing
(`FR-OFF-021`). Recorded as guidance; the choice remains `D4-1`'s.

---

## 17. Ack / durability semantics

Carried forward from the design gate and **re-ratified**, with one clarification forced by §16.

### 17.1 Definitiveness — unchanged

`accepted` / `duplicate` / `conflict` / `rejected` → **definitive**.
`deferred` → **not definitive**.
Transport failure / timeout / 5xx → **not definitive**.

The client removes an operation from its outbox **only** on a definitive result.

### 17.2 `accepted` means durably committed

> **No operation may be returned as `accepted` until its business effect and authoritative
> dedup/result state are durably committed.**

### 17.3 The chunk clarification

If several operations share a chunk transaction:

- their `accepted` statuses **cannot be externally final until that chunk commits**;
- **a rollback means those operations are not accepted** — and must not be reported as such.

This is the precise obligation that §16's performance freedom carries with it. Chunking is
permitted; acknowledging before the chunk commits is not.

### 17.4 Batch HTTP semantics — carried forward

A well-formed, authorised batch **may return HTTP 200 with independent per-operation results**.
One operation's rejection or conflict **does not** transform the whole batch into an HTTP error.
Envelope-level faults may still return the appropriate 4xx/5xx. The exact status/error catalogue
remains an implementation detail consistent with the repository's API error contract.

---

## 18. Revalidation exception ownership — `GD-D1-05` RATIFIED

**RATIFIED: `sync.revalidation_exceptions` is the canonical persistence ownership for `FR-OFF-046`
reconciliation exceptions.**

**Reason.** A revalidation exception **originates in the sync protocol** and should not create a
cross-lane persistence dependency on `governance.anomaly_flags` — a table that, as of this HEAD,
**does not exist** and belongs to another lane's roadmap. The design gate's recommendation (a) is
overturned in favour of its option (b).

**Sync owns:** persistence · the relationship to `opId` · client-computed values · server-computed
values · `detected_at` · terminal / branch attribution · the resolution state sync itself requires.

**Governance / Reporting may consume:** domain events · read contracts · alerts — **without owning
the underlying sync table.**

Exact table and column names remain implementation details.

This also removes `GD-D1-05` from the cross-lane dependency list: `D4-1` no longer needs to build
behind an interface and bind late.

---

## 19. `FR-OFF-046` invariant — carried forward unchanged

> **A financially significant revalidation mismatch MUST NOT reject a sale that already physically
> occurred.**

The server:

1. **accepts** the transaction;
2. records **client-computed** values;
3. records **server-computed** values;
4. persists a **reconciliation exception**;
5. **escalates systematic mismatches** per `FR-OFF-047`.

**This remains a mandatory `D4-1` invariant.** The SRS's own rationale is the reason: *"Rejecting a
synced sale because the server disagrees about a price is not an option: the customer already paid
and left."* `UC-OFF-01` step 11 is the worked example — four orders, a two-piastre tax difference
from a price change the terminals never received, all four accepted, four exceptions raised.

This is the rule most likely to be implemented wrongly, because every instinct in a validation
layer says *reject the bad data*.

---

## 20. Retention / tombstone / versioning decisions — `GD-D1-06` RATIFIED WITH ARCHITECTURE CORRECTIONS

### 20.1 Approved direction

- explicit `protocolVersion`;
- per-operation `schemaVersion`;
- strict envelope compatibility;
- explicit payload / batch byte limits;
- **no silent unknown-field discard for financial operation envelopes**;
- reference-data change watermark;
- deletion / tombstone mechanism;
- bounded retention;
- partitioning for genuinely high-volume history;
- retention jobs / reapers.

### 20.2 Corrections attached

1. **Operation global uniqueness MUST use the corrected dedup architecture** (§12).
2. **Final byte-cap values are implementation-testable defaults, not immutable business
   semantics.** The design gate's 500 ops / 4 MiB / 64 KiB stand as starting defaults; `D4-1` may
   revise them on measurement without a further governance action, provided `NFR-PERF-020` and
   `NFR-PERF-032` are still met.
3. **Retention floor must satisfy every applicable SRS requirement.**
4. **Partitioning must not break idempotency correctness** (§13).

### 20.3 Retention — RATIFIED

> Operation idempotency retention **SHALL be at least the SRS-required minimum** and **must not be
> shorter than any client retry / outbox horizon that could legitimately replay an operation.**

- `FR-OFF-021` / `FR-API-021` set the floor at **30 days**.
- `FR-OFF-013` gives the client a default 30-day local horizon. **Server dedup retention ≥ client
  outbox horizon**, or a retry after a server prune re-applies an operation as new.
- A **90-day hot operation-history target may be used as an initial engineering default**, but it
  is **NOT** a reason to weaken statutory / financial / audit retention on the underlying business
  records.
- **Sync operation history is not a substitute for statutory business ledgers.** Orders, payments,
  stock movements and audit entries retain their own retention obligations independently
  (ADR-010, `CR-04`).
- **The retention mechanism must be automated.**

**The currently unpruned `sync.idempotency_keys` condition remains an implementation gap** — the
`expires_at` index exists for a reaper that does not, and no scheduled-job infrastructure exists in
the repository at this HEAD. Adding sync traffic makes a latent problem real.

### 20.4 Tombstones / delta watermark — MANDATORY for `D4-2`

Reference-data delta sync **cannot be correct** if deletes cannot be represented or there is no
monotonic change watermark. An offline device would keep selling a deleted menu item indefinitely.

`D4-2` therefore **requires**:

1. a **change-cursor / watermark** mechanism;
2. **deletion tombstones or equivalent deletion events**;
3. **full checksum reconciliation** (`FR-OFF-012`).

**Not implemented in this task.** These block `D4-2`, not `D4-1`.

---

## 21. Revoked-terminal decision — `GD-D1-07` REJECTED

### 21.1 The rejection

**`GD-D1-07` is REJECTED.**

The proposal was: *revoked terminal → reject forever → unsynced committed sales may be lost.*

> That outcome is **NOT an acceptable Full-SRS / production architecture.** The user **explicitly
> rejects knowingly designing committed-sale loss into the system.**

The design gate stated the tension correctly — `FR-OFF-010` requires the local store to become
unusable on revocation, `NFR-REL-010` forbids losing any committed sale — but resolved it by
sacrificing durability and declaring the loss "by design". **Naming a conflict does not authorise
resolving it by discarding a mandatory requirement.**

### 21.2 The ratified security rule

Security and durability must be **reconciled explicitly**, not traded off:

1. A normally revoked terminal **must lose ordinary interactive operating authority.**
2. Revocation **MUST NOT** silently restore the terminal to ordinary trusted status **merely
   because it claims to hold unsynced transactions.** A lost or stolen device would claim exactly
   that.
3. **Committed offline financial data must have a controlled, auditable, lossless-recovery path.**

### 21.3 Lossless revoked-terminal recovery — HARD FOLLOW-UP GATE

A required follow-up design: **LOSSLESS REVOKED-TERMINAL RECOVERY.**

Candidate implementations — **none ratified**: quarantine upload-only recovery · pre-revocation
salvage · recovery credential / one-shot drain · replicated recovery spool · another architecture
preserving both properties.

**Hard invariants — all nine binding on whatever mechanism is chosen:**

1. a revoked terminal **does not regain normal POS authority**;
2. recovery is **explicitly authorised**;
3. recovery is **auditable**;
4. recovery **cannot create new sales**;
5. recovery **cannot modify arbitrary server state**;
6. **operation idempotency remains enforced**;
7. recovered financial operations receive **enhanced provenance / review**;
8. a lost/stolen terminal **cannot use the recovery path to escalate authority**;
9. **legitimate committed transactions are not silently discarded.**

### 21.4 Relation to `D4-1`

- **`D4-1` CORE is authorised to start** before the final recovery mechanism exists.
- **`D4-1` may initially support active valid terminals only.**
- **`D4-1` MUST NOT be declared FULLY COMPLETE for the revoked-terminal durability case** until
  the lossless recovery design is ratified **and** implemented.
- **Committed backlog loss must not be described as accepted behaviour** — in reports, in code
  comments, in the frontend handoff, or anywhere else.

The residual is recorded as an explicit hard gate (§30.1).

---

## 22. Canonical API versioning — CORRECTION 5

### 22.1 What is corrected

**NOT ratified:** the root-only endpoint as the permanent Full-SRS contract.

The Full-SRS API catalogue uses versioned routes. The canonical external contract for Sync is
therefore versioned under **`/v1`**:

```
POST /v1/sync/batch
GET  /v1/sync/changes
GET  /v1/sync/status
```

### 22.2 The constraint that made the design gate reach for the root

Verified at this HEAD and unchanged: **no global `/v1` prefix exists.** There is no
`setGlobalPrefix`, and `src/swagger.config.ts` documents the absence explicitly, publishing
`addServer('/')` rather than guessing at a prefix.

The design gate's *observation* was correct. Its *conclusion* — that the root path is therefore
the contract — was not.

> **Lane D MUST NOT independently retrofit the entire application routing structure.**

### 22.3 The ratified split of responsibility

| Owner | Owns |
|---|---|
| **`D4-1`** | The Sync controller and the business protocol |
| **Platform / API architecture** | The repository-wide versioning mechanism |

Implementation options include **Nest URI versioning**, a coordinated **`/v1` prefix**, or another
repository-wide mechanism. **The mechanism is not ratified here.** What is ratified is the
outcome: *the resulting external contract for Sync must expose the canonical v1 route.*

> **Do not permanently publish only `/sync/batch` and later claim Full-SRS route compliance.**

If a temporary unversioned compatibility route is needed during migration, it **must be explicitly
temporary/deprecated** and **must not replace** the canonical versioned endpoint.

### 22.4 Route inventory note

`GET /v1/sync/status` is named canonically here and did not appear in the original D1-1 report.
It is the read surface over `sync.device_state` (cursor, last sync, skew, protocol version). Its
slice assignment — `D4-1` alongside device state, or `D4-2` alongside the pull surface — is a
boundary detail for those slices, not a governance question. Its **canonical path is ratified**.

---

## 23. Branch RBAC dependency

**Lane B governance is NOT altered from this lane.** Governance decision `D-2` and its 2026-08-19
amendment are untouched; no defer is lifted, narrowed or reinterpreted here.

**Recorded:** branch-scoped authorization remains a **dependency to be consumed from Lane B's
accepted implementation**.

The Sync protocol MUST **ultimately** authorise operations against:

- authenticated tenant;
- registered terminal;
- terminal branch;
- actor / session;
- required permission / scope **once branch RBAC lands**.

> **Do not recreate a parallel permission model inside Sync.**

Until Lane B lands, `D4-1` authorises against tenant + registered terminal + terminal branch only,
and must not claim branch-scoped permission enforcement.

---

## 24. Fiscal dependency

The original D1-1 fiscal discipline is **carried forward unchanged**.

- **Do NOT invent the canonical `TaxDocument` / fiscal sequence behaviour here.** Nothing in this
  ratification does.
- **`D4-3` remains dependent on `C3-1` / `P7-FISCAL`.**
- The **generic fiscal operation extension point** is kept: `sync_operations.type` is an open
  string and `payload` is versioned `JSONB`, so a `fiscal.*` operation family can be added later
  with no envelope change, no protocol bump and no migration to the protocol itself.
- The one fiscal question the design gate *did* settle stands, because it follows from
  `FR-OFF-015` rather than from any fiscal model: **a fiscal number is not an entity identifier**,
  so the "server-assigned on sync" strategy does not violate "the server SHALL NOT reassign
  identifiers".
- **`CT-01`'s fiscal-sequence criterion remains ungradeable** until the fiscal model is ratified
  and implemented.

Row 17 of the D1-1 conflict matrix (fiscal document sequence) remains reserved, not guessed. Where
the fiscal domain later defines stricter legal semantics, §6.2's precedence rule applies and the
fiscal rule wins.

---

## 25. Conformance corpus

**Ratified architectural principle:** shared client/server algorithms are governed by a
**language-neutral conformance corpus**.

`kitchen-kit/conformance/` **is the precedent and must be extended, not replaced.** Its established
encoding contract — decimal strings for all money/quantity/rate values, minor units, structural
integers only as JSON numbers, jurisdiction codes as data never as branches, hand-derived
expectations, strict runner — is carried forward.

**`D4-1` will own server vectors for:** ids · HLC · envelope canonicalization · conflict rules ·
money where applicable.

**Other domain owners contribute their own shared logic** (pricing, tax, recipe, search, routing,
loyalty, promotions) as those domains exist.

**Full `FR-OFF-050` / `FR-OFF-051` completion still requires:**

1. a **Dart / client runner**;
2. **dual-suite CI**;
3. a **release-blocking divergence gate**.

> **None of those are claimed complete by this governance task.** `FR-OFF-050` and `FR-OFF-051`
> remain **PARTIAL**, exactly as `kitchen-kit/conformance/README.md` already records.

**No conformance code was modified by this task.**

---

## 26. `NFR-PERF-032` early gate — `P-D4-01`

**RATIFIED as a measured release gate, not a future optimization.**

> `NFR-PERF-032` — **500 operations within 3 seconds p95** — **must be measured during the earliest
> `D4-1` implementation iteration.**
>
> **Do not implement the entire protocol first and benchmark last.**

Required early benchmark dimensions:

- 500 operations;
- **realistic revalidation**;
- audit writes;
- dedup writes;
- conflict checks;
- commit cost.

**If naive operation-by-operation execution misses the budget, `D4-1` must optimize the
architecture before expanding protocol surface.** §15 and §16 exist precisely to make that
optimization available without a further governance action.

This is a **protocol architecture acceptance criterion**. Precedent for taking it seriously: P0
§11 records a case (`NFR-PERF-006`) where the assumed cost and the measured cost differed
materially.

---

## 27. Audit contention early gate — `P-D4-02`

**RATIFIED as a measured release gate.**

The existing per-tenant audit hash-chain sequence — `governance.audit_entries` with
`UNIQUE (tenant_id, sequence_no)` — **can become a serialization point** when several terminals of
one tenant drain a backlog concurrently. `UC-OFF-01` produces 1,204 audit events from a single
branch's six-hour outage.

**`D4-1` acceptance must measure:**

- one-terminal backlog;
- **multiple terminals concurrently draining**;
- audit-chain sequence contention;
- deadlock / retry behaviour;
- `NFR-PERF-032` impact.

> **Do not weaken audit immutability to make the benchmark pass.**

The hash chain is a `FR-SEC` repudiation control and an ADR-010 append-only guarantee. Batched
audit persistence is permitted (§16) only where it is **compatible with the immutable hash-chain
contract**; relaxing the chain is not an available optimization.

---

## 28. Corrected `D4-1` boundary

### 28.1 `D4-1` CORE is authorised to implement

1. global operation **dedup registry**;
2. time-partitionable **operation history** if justified;
3. `sync_batches` / `device_state` / `conflict_records`;
4. `sync.revalidation_exceptions`;
5. **canonical v1 batch API coordinated with platform versioning**;
6. strict operation/batch **envelope validation**;
7. **HLC algorithm + canonical representation**;
8. **crash-recoverable batch reservation/resume**;
9. operation-level **idempotency**;
10. **causal ordering**;
11. **`deferred` handling**;
12. **per-operation failure isolation**;
13. conflict handling **for domains that actually exist**;
14. `FR-OFF-045` / `FR-OFF-046` revalidation **for available computation substrates**;
15. **skew detection**;
16. `FR-OFF-044` **audit writes**;
17. required **conformance vectors**;
18. **early `NFR-PERF-032` benchmark**;
19. **concurrent audit-contention benchmark**.

### 28.2 `D4-1` explicit non-goals

`D4-1` must **NOT** implement:

- fiscal sequence semantics;
- bootstrap / delta / checksum endpoints;
- WebSocket push;
- mDNS / LAN coordinator;
- CRM / loyalty domain;
- Dart client;
- branch RBAC itself;
- full revoked-terminal recovery unless separately designed and ratified;
- **global repository API versioning unilaterally**.

### 28.3 The boundary rule, restated

`D4-1` implements **the protocol**, not **the domains**. Where a conflict rule needs a domain that
does not exist, `D4-1` ships the rule's registration point and no rule — which keeps `CT-13`
honestly unmet rather than half-built.

---

## 29. `D4-2` / `D4-3` boundary

**`D4-2` remains responsible for:** full bootstrap snapshot · delta changes · cursors ·
watermarks · **tombstones / deletions** · entity-type checksums · reference reconciliation.

**`D4-3` remains responsible for** fiscal / offline sequence integration **after the canonical
fiscal model is available** (`C3-1` / `P7-FISCAL`).

Neither is implemented, started or unblocked by this task.

---

## 30. Remaining blockers

### 30.1 Hard gates on `D4-1` full completion

| Gate | Blocks | Closed by |
|---|---|---|
| **Lossless revoked-terminal recovery** | `D4-1` FULL completion for the revoked-terminal durability case | A ratified recovery design satisfying all nine invariants of §21.3, then implementation |
| **`P-D4-01` — `NFR-PERF-032`** | `D4-1` FULL completion | Measured proof: 500 ops ≤ 3 s p95 with realistic revalidation, audit, dedup, conflict checks and commit |
| **`P-D4-02` — audit contention** | `D4-1` FULL completion | Measured proof under concurrent multi-terminal drain, without weakening audit immutability |

**`D4-1` CORE may start now. `D4-1` may not be closed until all three are satisfied.**

### 30.2 Cross-lane dependencies — unchanged by this task

| Dependency | Owner | Blocks |
|---|---|---|
| Branch-scoped RBAC (`FR-SEC-002/003/004`), governance `D-2` | **Lane B** | Full operation authorisation; permission bootstrap |
| Canonical `TaxDocument` / fiscal sequence model | **`C3-1` / `P7-FISCAL`** | `D4-3`; conflict row 17; `CT-01` fiscal criterion |
| Repository-wide API versioning mechanism | **Platform / API architecture** | Canonical `/v1` Sync routes (§22) |
| Dart runner + dual-suite CI + release-blocking divergence gate | **Lane G / frontend** | `FR-OFF-050`, `FR-OFF-051`, `CT-06` |
| Scheduled-job infrastructure (retention reapers) | **Platform** | §20.3 automated retention |
| Per-tenant / per-terminal rate limiting beyond auth | **Lane B / platform** | Sync endpoint protection sized for a `CT-14` drain |
| `crm` schema (customers, loyalty ledger) | **Unassigned** | `CT-13`; conflict row 8; bootstrap rows |
| Plan / entitlement limits (`FR-OFF-020`) | **Unassigned** | Plan-derived batch caps |
| `CG-01` lost update in `MovementsService.post` (P0 §12.1) | **Lane A** | Trustworthy backlog replay of stock movements |

`GD-D1-05` is **removed** from this list — §18 resolves it inside Lane D.

### 30.3 Resolved by this task

`GD-D1-01` · `GD-D1-02` · `GD-D1-04` · `GD-D1-05` · `GD-D1-06` (with corrections) · `GD-D1-07`
(by rejection + replacement gate) · the four `D4-1`-blocking approvals · the partition/uniqueness
design conflict · the batch-crash trap · the per-operation-commit over-constraint · the API
versioning question.

### 30.4 No implementation credit

**Nothing was implemented, measured or tested by this task.** Explicitly:

| Item | Status after this task |
|---|---|
| `FR-OFF` requirements | **DESIGN / RATIFICATION ONLY**, as applicable. **Not** implementation-complete |
| `NFR-PERF-032` | **NOT YET VERIFIED** |
| `FR-OFF-050` / `FR-OFF-051` | **PARTIAL** |
| `CT-01` | **NOT PASSED** |
| `CT-06` | **NOT PASSED** globally |
| `CT-10` | **NOT PASSED** — no executable conformance vectors or tests exist yet |
| Fiscal | **UNRESOLVED** until `P7-FISCAL` / `D4-3` |
| Revoked-terminal lossless recovery | **UNRESOLVED HARD GATE** |

---

## 31. Files changed

| Path | Change |
|---|---|
| `docs/governance/GOVERNANCE_DECISION_REGISTER.md` | **MODIFIED** — one new unnumbered ratified section, *"D1-1 — Offline / Sync Protocol Foundation Ratification — 2026-09-02"*, inserted before `## Final Decision Matrix` per the established convention. **No historical text deleted or rewritten.** No new numbered decision created; the 20-decision tally is unchanged |
| `docs/reports/claude/full-srs-4day/2026-09-02_D1-1_offline-sync-ratification.md` | **NEW** — this report |
| `docs/reports/claude/full-srs-4day/2026-09-02_D1-1_offline-sync-design-gate.md` | **MODIFIED** — a short **POST-REVIEW ACCEPTANCE NOTE appended at the end only.** No historical analysis section altered |
| `docs/reports/claude/full-srs-4day/INDEX.md` | **MODIFIED** — exactly one appended row |

**Not touched:** `src/` · `prisma/` · any migration · any test · any package file · any conformance
code or corpus · any other governance decision.

---

## 32. Commit

Single documentation/governance commit on `full-srs/lane-d-kds-offline`.

**Subject:** `docs(sync): ratify offline protocol foundation`

Files staged explicitly by path — no `git add .`, no `git add -A`. No merge, no rebase, no
destructive git operation.

---

## 33. Push / deploy status

**PUSHED: NO. DEPLOYED: NO.**

No merge. No rebase. No history rewritten — the original D1-1 commit `50b3706` and its report body
are intact.

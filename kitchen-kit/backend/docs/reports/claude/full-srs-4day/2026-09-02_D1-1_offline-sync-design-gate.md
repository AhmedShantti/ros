# D1-1 — OFFLINE + SYNC SERVER PROTOCOL DESIGN GATE

| Field | Value |
|---|---|
| **Task / slice name** | P5-OFF1 / D1-1 — Offline + Sync server protocol design gate |
| **Lane** | D — KDS + Offline/Sync |
| **Report type** | DESIGN / CONTRACT / GOVERNANCE-DEPENDENCY ANALYSIS (no implementation) |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. This report records what was read, observed and designed in this session; where it disagrees with the SRS or a ratified governance decision, the SRS and the register win. **This report ratifies nothing.** Every engineering proposal in §22 requires explicit approval before `D4-1` may implement it. |
| **Date** | 2026-09-02 |
| **HEAD (baseline)** | `63d3b7c2ea5f999bb9ba7277d51a5da3c6950a71` (`63d3b7c`) |
| **Branch** | `full-srs/lane-d-kds-offline` |
| **Working tree at start** | Clean (`git status --porcelain` empty). |
| **Working tree at report time** | Two files added: this report and one appended row in `docs/reports/claude/full-srs-4day/INDEX.md`. **No product code, no Prisma schema, no migration, no route, no controller, no permission, no test, no governance-register file touched.** |
| **Task identifier** | D1-1 |
| **Status** | **COMPLETE** — design gate produced; fiscal extension point deferred to `D4-3` by design, not by omission. |

---

## 1. Status

`D1-1` is a **design gate**, and it is complete for everything the SRS makes decidable today.

- The protocol contract for identifiers, HLC, the operation envelope, batch upload,
  acknowledgement, conflict classification, revalidation, bootstrap, versioning, idempotency
  reuse and the conformance corpus is **specified in full** below.
- **Fiscal sequence semantics are deliberately NOT specified.** §18 defines the extension point,
  states precisely what is unresolved, and assigns it to `D4-3` behind `C3-1` / `P7-FISCAL`.
- **Seven decisions require governance approval before `D4-1` starts** (§22). Four of them
  (`GD-D1-01`, `GD-D1-02`, `GD-D1-04`, `GD-D1-07`) block implementation; three are shaping
  decisions that can be ratified in parallel with early `D4-1` work.
- The external frontend team can begin against §21 **PARTIAL** — the blocking approvals in §22
  are precisely the four that change what the client writes to its outbox.

**Nothing was implemented.** No schema, no migration, no route, no test.

---

## 2. Baseline

Verified at the start of this session, before any file was written:

```
$ git rev-parse HEAD
63d3b7c2ea5f999bb9ba7277d51a5da3c6950a71

$ git rev-parse --abbrev-ref HEAD
full-srs/lane-d-kds-offline

$ git status --porcelain
(empty)
```

All three baseline requirements are satisfied exactly. Proceeded.

**Sources read directly in this session** (not via P0 summaries):

| Source | What was read |
|---|---|
| `ROS_SRS_v1.0.pdf` | Extracted with `pdftotext -layout` (6,510 lines). §1.9 `CR-01`, §21.1–21.11 in full (all 36 `FR-OFF`), §26.5 `FR-API-020…023`, §26.6 `NFR-PERF-032`, §27 `NFR-REL-010/011`, `NFR-PERF-020/021`, `NFR-CAP-001`, §28.3 `CT-01…CT-15`, §7.4.1 Order aggregate, §7.3 entity 40 `SyncBatch`, §8.2 `FR-POS-002`/`FR-POS-012`, §8.3.1 `FR-POS-041`, §18.3 `FR-CRM-020/021`, §17 `FR-SEC-035`, §22.2 `FR-LOC-020…025`, §22.3 `IR-LOC-*`, §24 threat table, §25.1 schema list, §25.2 representative DDL, ADR-004/-005/-009/-010. |
| `docs/reports/claude/2026-09-02_FULL-SRS-current-head-traceability-rebase.md` | §16 (offline/sync gap analysis) and §27 (external blockers) in full. |
| `prisma/schema.prisma` | Complete model inventory (91 models across 12 schemas), `IdempotencyKey`, `Order`, `Terminal`, `DeviceFingerprint`, `AuditEntry`, `Ticket`, `CashSession`, `CountSession`, `StockMovement`, `Shift`, `OrderNumberBlock`. |
| `src/common/idempotency/*` | `IdempotencyService`, `IdempotencyInterceptor` — reuse analysis (§16). |
| `src/common/ids.ts`, `src/common/money/*` | ID strategy precedent, `Money.allocate`. |
| `kitchen-kit/conformance/` | `README.md`, `tax/*.corpus.json`, `src/modules/localisation/tax/conformance.runner.ts` — corpus precedent (§20). |
| `docs/governance/GOVERNANCE_DECISION_REGISTER.md` | `D-2` (branch-scoped RBAC scope + 2026-08-19 amendment) — the Lane B dependency (§17.2). |
| `src/swagger.config.ts`, `src/main.ts` | Endpoint path and body-limit reality (§9.1, §17.7). |

---

## 3. Exact SRS scope

### 3.1 The constraint

`CR-01` (§1.9, Technical): *"The POS application MUST operate for a minimum of 72 hours without
server connectivity."* This is a **constraint on the product**, not a feature request. `CT-01`
grades it: *72-hour full offline operation, 500 orders, then sync → zero loss, zero duplication,
fiscal sequence intact.*

### 3.2 All 36 `FR-OFF` requirements, verbatim scope

| Req | Pri | Substance | Owner | D1-1 disposition |
|---|:--:|---|---|---|
| `FR-OFF-001` | M | Continuous mode detection, unobtrusive indicator | FRONTEND | Out of backend scope |
| `FR-OFF-002` | M | Mode transitions never interrupt an in-progress order | FRONTEND | Out of backend scope |
| `FR-OFF-003` | M | Isolated mode ≥ 72 h without degrading sales capture | SHARED | Bounded by §14 bootstrap completeness |
| `FR-OFF-010` | M | Local DB encrypted; key from device credentials + server-issued key; unusable if registration revoked | SHARED | Backend owes the server-issued key at registration — §17.5, `GD-D1-07` |
| `FR-OFF-011` | M | Downward reference data versioned; client requests deltas since last version | BACKEND | §14.3 cursor contract |
| `FR-OFF-012` | M | Periodic full reconciliation by per-entity-type checksum | BACKEND | §14.4 |
| `FR-OFF-013` | M | Local storage bounded; synced orders older than N days (default 30) pruned locally | FRONTEND | Backend owes online retrieval — already true |
| `FR-OFF-015` | M | Client-generated ULID as **permanent** PK; **server SHALL NOT reassign** | SHARED | §6 |
| `FR-OFF-016` | M | Order numbers from server-issued blocks per terminal per business day (`FR-POS-002`) | BACKEND | Substrate `sales.order_number_blocks` **EXISTS** — §12.6 |
| `FR-OFF-017` | M | Gapless fiscal sequence: pack selects one of three strategies | BACKEND | **DEFERRED — §18** |
| `FR-OFF-018` | M | Unused numbers in an expired block reported void; never silently discarded | BACKEND | **DEFERRED — §18** |
| `FR-OFF-020` | M | Sync batched; size bounded by plan limits and payload size | BACKEND | §9.2 |
| `FR-OFF-021` | M | Every operation carries an idempotency key; keys persisted ≥ 30 days; repeated key returns the original result | BACKEND | §16 — partly satisfied by existing substrate |
| `FR-OFF-022` | M | Operations applied in causal order; operation whose causal parent is unapplied is **deferred, not rejected** | BACKEND | §9.3 — creates `GD-D1-04` |
| `FR-OFF-023` | M | Per-operation response `accepted` / `duplicate` / `conflict` / `rejected` with reason; one failure never fails the batch | BACKEND | §9.6 |
| `FR-OFF-024` | M | Client removes from outbox **only** on a definitive server response | SHARED | §10 |
| `FR-OFF-025` | M | Sync resumable; connection lost mid-batch resumes without duplication | BACKEND | §10.3 |
| `FR-OFF-026` | M | Exponential backoff with jitter; financially significant operations prioritised | FRONTEND | §21.2 |
| `FR-OFF-030` | M | Client pulls reference changes since cursor, on interval and on reconnect | BACKEND | §14.3 |
| `FR-OFF-031` | S | WebSocket push for price / 86 / permission-revocation changes | BACKEND | **NOT IN D4-1** — no realtime substrate exists (§4.4); `[S]` priority |
| `FR-OFF-032` | M | Permission and terminal revocations applied immediately and re-verified on every reconnection | SHARED | §17.5 |
| `FR-OFF-035` | M | POS/KDS mDNS discovery; direct order and bump exchange | FRONTEND | §19 |
| `FR-OFF-036` | M | One electable LAN coordinator per branch; deterministic tie-break on device id | FRONTEND | §19 |
| `FR-OFF-037` | M | LAN peer comms authenticated by branch-scoped key distributed at registration; encrypted | SHARED | Backend issues the key — §19.3 |
| `FR-OFF-038` | S | Re-election within 30 s; divergent state reconciled on election | FRONTEND | §19 |
| `FR-OFF-040` | M | Every entity type classified by conflict strategy | BACKEND | §12 — the SRS's own table is the spine |
| `FR-OFF-041` | M | HLC ordering, algorithm given normatively | SHARED | §7 — algorithm quoted verbatim, not reinterpreted |
| `FR-OFF-042` | M | Skew > configurable threshold (default 5 min) detected every sync, recorded, manager alerted, original timestamp preserved | BACKEND | §7.5 |
| `FR-OFF-043` | M | Unresolvable conflicts → conflict register + alert + manager UI with both versions | BACKEND | §11.4 |
| `FR-OFF-044` | M | Every automatic resolution recorded in the audit log with **both input states and the applied rule** | BACKEND | §12.2, §17.8 |
| `FR-OFF-045` | M | Server revalidates all financially significant computations | BACKEND | §13 |
| `FR-OFF-046` | M | On mismatch: **accept**, record both values, raise a reconciliation exception | BACKEND | §13.3 |
| `FR-OFF-047` | M | Systematic mismatches from one terminal escalate to a platform alert after a configurable count | BACKEND | §13.4 |
| `FR-OFF-050` | M | Shared language-neutral conformance corpus run by both Dart and TypeScript suites in CI | SHARED | §20 — **substrate partially EXISTS** |
| `FR-OFF-051` | M | Any corpus divergence blocks release | SHARED | §20.4 — Lane G dependency |
| `FR-OFF-052` | M | Every production `FR-OFF-046` discrepancy triaged; new corpus case before the fix merges | SHARED | §20.4 |

### 3.3 Applicable NFRs

| Req | Statement | Bearing on this design |
|---|---|---|
| `NFR-PERF-020` | 5,000 queued operations sync within **5 minutes on 2 Mbps** | 10 batches of 500. Budget is dominated by *bandwidth*, not server time: 5,000 ops × ~2 KiB ≈ 10 MiB ≈ 40 s at 2 Mbps. Drives the per-operation payload cap (§17.6) — at 8 KiB/op the same backlog needs 160 s of pure transfer and the budget is at risk. |
| `NFR-PERF-032` | Sync batch endpoint processes **500 operations within 3 s p95** | 6 ms per operation including revalidation and commit. Drives §9.4 (transaction boundaries) and is the single hardest number in this design. |
| `NFR-PERF-021` | Local order persistence ≤ 50 ms p95 | FRONTEND-EXTERNAL. Stated so it is not claimed from the backend. |
| `NFR-REL-010` | No committed sale lost under **any** single-device failure | Drives §10 (ack ordering) and `GD-D1-07` (revoked-terminal backlog). |
| `NFR-REL-011` | **At-most-once financial effect**, enforced by idempotency keys | Drives §16's two-level idempotency split. |
| `NFR-CAP-001` | Local store holds ≥ 20,000 orders and lines without degradation | FRONTEND-EXTERNAL, but bounds the server: a device may arrive with 20,000 orders' worth of operations (`CT-14`). Drives §9.7 (streaming, never load a full backlog). |

### 3.4 Critical test scenarios in scope

| CT | Scenario | Pass criterion | Where this design answers it |
|---|---|---|---|
| `CT-01` | 72-h full offline, 500 orders, then sync | Zero loss, zero duplication, fiscal sequence intact | §10 (loss), §16 (duplication), **§18 (fiscal — UNRESOLVED)** |
| `CT-03` | Concurrent order edits on one table from two terminals | Converges per CRDT rules; no line lost | §12 row 2 |
| `CT-04` | Power loss during payment write | Order recoverable; no partial state | §10.2 — client durability is FRONTEND; server-side atomicity is §9.4 |
| `CT-06` | Client/server conformance corpus | **Byte-identical** results on every case | §20 |
| `CT-10` | Device clock set 3 hours ahead | HLC ordering preserved; skew alerted; original timestamps retained | §7.6 — creates `GD-D1-03` |
| `CT-13` | Loyalty double-redemption from two offline terminals | Detected on sync; policy applied; ledger consistent | §12 row 8 — **contract only, no substrate** |
| `CT-14` | Sync backlog of 20,000 operations after extended outage | Completes; no timeout; no memory exhaustion | §9.7 |

---

## 4. Current substrate

Verified by direct inspection of `prisma/schema.prisma` and `src/` at `63d3b7c`.

### 4.1 The `sync` schema contains exactly one table

`sync.idempotency_keys`, modelled as `IdempotencyKey`. That is the entire sync substrate.

**Absent, and named by SRS §25.1 as belonging to `sync`:** `sync_batches`, `sync_operations`,
`conflict_records`, `device_state`. All four are proposed in §11.

### 4.2 Confirmed absent

- No `hlc` column anywhere in the schema — including on `sales.orders`, where SRS §7.4.1 and
  §25.2 both require one.
- No `sync_state` column anywhere — likewise required on `sales.orders` by both SRS sections.
- No oplog, no operation log, no batch endpoint, no conflict protocol.
- No WebSocket, SSE, or any realtime substrate (`grep` for `websocket|socket.io|EventSource`
  returns only unrelated matches in comments).
- No `crm` schema at all — **no customers, no loyalty accounts, no loyalty ledger.** `CT-13` and
  `FR-CRM-020/021` therefore have zero substrate; §12 row 8 is a contract, not a plan.
- No `fiscal` tables beyond `TaxClass` — no `tax_documents`, no `country_packs` table, no
  `fiscal_submissions`. Confirms §18.
- No attendance-event substrate (`workforce` holds only `Shift`).
- No `platform.outbox` table.
- No scheduled-job infrastructure (`@nestjs/schedule` is not a dependency), so **nothing prunes
  `sync.idempotency_keys`** despite the `expires_at` index existing for exactly that purpose.

### 4.3 Present and directly reusable

| Substrate | Location | Reuse |
|---|---|---|
| `sync.idempotency_keys` + `IdempotencyService` | `src/common/idempotency/` | **Batch-level idempotency, as-is** — §16 |
| ULID-as-UUID id generation | `src/common/ids.ts` (`newId()`, `UUID_PATTERN`, `ulidx`) | §6 |
| `sales.order_number_blocks` | `prisma/schema.prisma` | `FR-OFF-016` / `FR-POS-002` block allocation — §12.6 |
| `sales.orders.origin_device_time` | `prisma/schema.prisma` | `FR-OFF-042` "preserve the device's original timestamp" |
| `sales.orders.idempotency_key` + `uq_orders_idempotency` | `prisma/schema.prisma` | Order-level duplicate suppression |
| `governance.audit_entries` (hash-chained, `before_state`/`after_state`) | `prisma/schema.prisma` | `FR-OFF-044` — carries both input states natively |
| Shared conformance corpus + runner | `kitchen-kit/conformance/`, `src/modules/localisation/tax/conformance.runner.ts` | `FR-OFF-050` — §20 |
| `Money`, `Money.allocate`, rounding, rational arithmetic | `src/common/money/` | `CT-12`, corpus |
| Country-pack loader, parser, **signature verification**, registry | `src/modules/localisation/country-pack/` | `FR-LOC-022/024` bootstrap — §14.2 |
| Price resolution | `src/modules/catalogue/pricing/price-resolution.ts` | `FR-POS-041` revalidation + corpus |
| Tax calculator + engine registry | `src/modules/localisation/tax/` | `FR-OFF-045` revalidation |
| KDS routing resolver, `kitchen.station_routing_rules`, `BranchKdsConfig` | `src/modules/kitchen/`, schema | §19 local routing |
| Terminal identity + `TerminalStatus.revoked` + session guard | `src/modules/identity/terminals/` | §17.4, §17.5 |
| Domain events / Unit of Work | `src/common/domain-events/` | §9.4 transaction boundaries |

### 4.4 One correction to the P0 baseline statement

P0 §16 states *"no substrate"* for `FR-OFF-050`. That is true of the **client half and the CI
job**, but the **server half exists and runs**: `kitchen-kit/conformance/tax/` holds two corpus
files with an established encoding contract, and `conformance.spec.ts` executes them. This is a
material improvement to `D1-1`'s starting position: §20 extends an existing, documented corpus
convention rather than inventing one. `FR-OFF-050`/`051` remain **PARTIAL**, exactly as
`kitchen-kit/conformance/README.md` already states.

---

## 5. Ownership split

Restated from P0 §16.2, refined by what this gate decided.

### 5.1 FRONTEND-EXTERNAL — no backend effort, and the backend must not claim these

Flutter/SQLite local store and its encryption at rest, the local write path, local UI state and
mode indication, outbox durability, backoff and prioritisation, mDNS discovery, LAN coordinator
election and the LAN transport itself, local pruning.

Requirements: `FR-OFF-001`, `-002`, `-013`, `-026`, `-035`, `-036`, `-038`, `NFR-PERF-021`,
`NFR-REL-002` (client buffering half), `NFR-CAP-001`.

### 5.2 BACKEND — this campaign owns

Operation envelope schema, batch upload endpoint, acknowledgement semantics, oplog persistence,
server-side revalidation, conflict detection and resolution rules, conflict register, skew
detection and alerting, bootstrap/snapshot and delta endpoints, checksum reconciliation,
protocol versioning, fiscal-sequence reconciliation (deferred), the branch-scoped LAN key issued
at registration, retention and pruning.

Requirements: `FR-OFF-011`, `-012`, `-016`, `-017`, `-018`, `-020`…`-025`, `-030`, `-031`,
`-040`, `-042`…`-047`.

### 5.3 SHARED — must be **identical** on both sides; this is where `CT-06` lives

| Algorithm | Server home | Corpus directory |
|---|---|---|
| ULID generation + UUID rendering + ordering | `src/common/ids.ts` | `conformance/ids/` (new) |
| HLC local-event, receive-event, comparison | new, `D4-1` | `conformance/hlc/` (new) |
| Operation canonical serialization + fingerprint | `IdempotencyService.fingerprint` + `stableStringify` | `conformance/envelope/` (new) |
| `Money.allocate`, rounding, cash rounding | `src/common/money/` | `conformance/money/` (new) |
| Price resolution (`FR-POS-041`) | `src/modules/catalogue/pricing/` | `conformance/pricing/` (new) |
| Tax computation and rounding | `src/modules/localisation/tax/` | `conformance/tax/` **EXISTS** |
| Arabic search normalisation (`FR-POS-012`) | not implemented | `conformance/search/` (new) |
| Conflict resolution rules | new, `D4-1` | `conformance/conflict/` (new) |
| KDS routing resolution | `src/modules/kitchen/` | `conformance/routing/` (new) |
| Recipe expansion (`CT-07`) | `src/modules/production/` | `conformance/recipe/` (new) |
| Loyalty accrual | **no substrate** | deferred |
| Promotion evaluation (`FR-CRM-027`) | **no substrate** | deferred |

---

## 6. ID strategy

### 6.1 Format

**Every entity created on a device receives a ULID as its permanent primary key** (`FR-OFF-015`
[M], ADR-009 Accepted).

A ULID is 128 bits: a 48-bit big-endian millisecond Unix timestamp followed by 80 bits of
randomness. ADR-009 explicitly permits storage as `BYTEA(16)` **or native UUID**; this repository
chose native UUID, and `src/common/ids.ts` renders the ULID's 128 bits in canonical 8-4-4-4-12
hexadecimal form via `ulidToUUID(ulid())`.

**Canonical wire form: the 36-character UUID hexadecimal rendering.** The 26-character Crockford
base32 form appears nowhere in the API. See `GD-D1-01` — this contradicts the SRS §21.5.1
example, which shows `"opId": "01J8..."`.

*Why:* every DTO in the repository validates ids against `UUID_PATTERN`; every id column is
`@db.Uuid`; the OpenAPI generator (`src/common/openapi/oas31.util.ts`) detects id-shaped fields
by that same convention. Introducing base32 on one endpoint would (a) make `opId` unstorable in
the `@db.Uuid` column the oplog needs, (b) break the shared validator, and (c) create two
encodings of the same 128 bits in one API. The two forms are the *same ULID*; only the rendering
differs, and `FR-OFF-015` constrains the identifier, not its text encoding. The SRS §21.5.1
snippet is illustrative JSON, not a normative format clause.

### 6.2 Collision properties

Within one device within one millisecond, uniqueness is **structural** only if the client uses a
**monotonic ULID factory** (increment the random component rather than redrawing it). This is a
client obligation and a corpus case (§20.2), because without it two entities created in the same
millisecond on one device have a 2⁻⁸⁰ collision chance *and*, more importantly, lose their
creation order — which matters because ULIDs are the tie-break of last resort.

> **Repository note (not a defect in this design):** `src/common/ids.ts` calls `ulidx`'s
> non-monotonic `ulid()`. For server-generated ids this is harmless. If any server path ever
> needs same-millisecond ordering it should move to `monotonicFactory()`. Recorded here, not
> changed — `D1-1` changes no code.

Across devices, uniqueness is **probabilistic**: 80 random bits per millisecond. It is not
namespaced by tenant, branch or device, and this design does not pretend otherwise.

### 6.3 Tenant / device namespace assumptions

**None.** IDs carry no tenant or device component and MUST NOT be parsed for one.

Isolation is provided structurally instead: every table's identity is `(tenant_id, id)` or a
partition-composite containing `tenant_id`. A ULID minted by tenant A can therefore never be
confused with, or replay against, the same ULID in tenant B — the uniqueness scope is per tenant
by construction, which is also why `sync.idempotency_keys` was deliberately keyed
`(tenant_id, key)` rather than globally (see its schema comment).

### 6.4 Server acceptance

On receiving an operation that creates entity `E` with client id `X`:

1. Insert under `(tenant_id, X)`.
2. **No conflict** → `accepted`.
3. **Unique violation, and the existing row's originating `opId` equals this operation's `opId`**
   → `duplicate`; return the original stored result (`FR-OFF-021`).
4. **Unique violation, different `opId`, identical canonical fingerprint** → `duplicate`. (Same
   logical write re-minted under a new `opId` by a client defect; treating it as a new entity
   would duplicate a sale.)
5. **Unique violation, different `opId`, different fingerprint** → `rejected`, reason
   `id_collision`. The server does **not** remap.

Case 5 is expected to be vanishingly rare and is a client-side signal to regenerate. It is the
only correct outcome: silently remapping would violate `FR-OFF-015`, and silently merging would
corrupt two distinct sales into one.

### 6.5 Remapping policy

**There is none.** `FR-OFF-015`: *"The server SHALL NOT reassign identifiers."* The server never
rewrites an entity id, an `opId`, or a `batchId`, under any circumstance, including collision,
conflict resolution or revalidation mismatch.

**The one thing that IS reallocated is the human-readable order number**, which is not an
identifier — `FR-POS-002` explicitly provides for offline terminals exhausting their block,
falling back to `<terminal_code>-<local_seq>`, and being *"reconciled on sync"*. Reconciliation
changes `orders.order_number`; it never touches `orders.id`. See §12.6.

### 6.6 Permanence

**Yes, permanently.** The client id is the row's primary key for the life of the record. Client
and server refer to the same entity by the same identifier forever, which is what makes an
`accepted` acknowledgement meaningful (§10) and what makes `causedBy` references stable across
the partition.

---

## 7. HLC

### 7.1 The algorithm is normative and is not reinterpreted

`FR-OFF-041` [M] states the algorithm in full. Quoted verbatim from §21.7:

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

**Both client and server implement exactly this, with no variation** (`FR-OFF-041` +
`FR-OFF-050`). It is a corpus-covered shared algorithm (§20.2). Any implementation that
"improves" it diverges and fails `CT-06`.

### 7.2 Representation

```
HLC := <physical> "." <logical> "." <node>
```

| Segment | Encoding | Width | Source |
|---|---|:--:|---|
| `physical` | Zero-padded decimal **milliseconds** since Unix epoch, UTC | 13 | `l` in the algorithm |
| `logical` | Zero-padded decimal counter | 5 | `c` in the algorithm |
| `node` | The originating terminal's UUID with dashes removed, lowercase hex | 32 | Tie-break |

Total: **52 characters**, fixed width. Example:

```
0001722765753000.00042.7f3a9c1e4b8d42f0a1c5e6b70d29f841
                 ^ 13 digits shown padded in the real encoding
```

Two properties this buys, and they are the reason for fixed width:

1. **Lexicographic string order === the correct total HLC order.** Postgres can index and range
   over `hlc` directly with no parsing, and a `ORDER BY hlc` is the causal order.
2. **The string is self-contained.** A stored HLC totally orders against any other stored HLC
   without needing its row's `terminal_id` column.

`physical` at millisecond resolution is a deliberate departure from the SRS §21.5.1 example
(`"1722765753.0042.dev07"`, which is second resolution with an opaque node label). Second
resolution would push an entire second of a busy terminal's events through the 5-digit logical
counter and lose ordering fidelity for no benefit. `logical` is capped at 99,999; on overflow
within one millisecond the client **stalls** until the physical clock advances — the standard HLC
bound, and unreachable in practice at POS event rates.

### 7.3 Column width — an SRS internal inconsistency

The SRS specifies the `hlc` column twice and disagrees with itself:

- §7.4.1 Order aggregate: `hlc VARCHAR(40)`
- §25.2 representative DDL: `hlc VARCHAR(48)`

Neither can be treated as normative when they contradict. This design uses `VARCHAR(52)`, chosen
by the encoding rather than by picking one of two conflicting numbers. Recorded as a source
observation, and as part of `GD-D1-02`.

### 7.4 Comparison

```
compare(a, b) = compare(a.physical, b.physical)
             ?: compare(a.logical,  b.logical)
             ?: compare(a.node,     b.node)      // lexicographic, deterministic
```

Total, deterministic, and identical on both sides. The `node` tie-break is what makes
"last-writer-wins with HLC" (`FR-OFF-040`, table state) a *function* rather than a coin flip: two
devices that produce byte-identical `physical.logical` still resolve deterministically, and both
sides compute the same winner without coordinating.

### 7.5 Merge / update, and skew handling

Every node — each terminal **and the server** — maintains one HLC state `(l, c)`.

- The client advances on every local mutation (local-event rule) and on every batch response
  (receive rule, against the response's `serverHlc`).
- The server advances on every received operation (receive rule) and on every server-originated
  operation (local-event rule).

**`FR-OFF-042` skew detection**, on every batch:

```
skew_ms = max(op.hlc.physical for op in batch) - server_receipt_physical_ms
```

- Recorded on `sync.device_state` (`clock_skew_ms`, `skew_detected_at`).
- If `|skew_ms| > threshold` (tenant-configurable, **default 5 minutes** per `FR-OFF-042`):
  alert the branch manager, and stamp `skew_alerted_at`.
- The device's original timestamp is preserved alongside the server-corrected one: the envelope's
  `occurredAt` and `hlc` are stored **verbatim and never rewritten**; `received_at` is the
  server's own clock. `sales.orders.origin_device_time` already exists for exactly this and is
  reused.

### 7.6 `CT-10` — device set 3 hours ahead

Pass criterion: *"HLC ordering preserved; skew alerted; original timestamps retained."*

What the algorithm as written does: `l' = max(l, l_msg, physical_time)` means the server adopts
the +3 h device physical component into its own clock. Causality and ordering are preserved
(criterion 1 ✓), skew is detected and alerted (criterion 2 ✓), and the received HLC is stored
verbatim (criterion 3 ✓). **`CT-10` passes on the algorithm as specified — no invention is
required to pass it.**

But there is a real consequence the SRS's own rationale demands be addressed: *"HLC **bounds**
clock skew's effect."* Merging a +3 h device into a single global server clock drags every
subsequent server-originated HLC 3 hours ahead **permanently**, and every other device then
inherits that on its next response. One bad device would poison the whole tenant. That is
unbounded, and it is the opposite of what the rationale promises. The SRS states the merge rule
but never states the bound.

**Proposal (`GD-D1-03`, requires approval):**

1. The server keeps **one HLC per (tenant, terminal)** in `sync.device_state`, advanced by the
   receive rule against that terminal's operations only. Ordering comparisons between operations
   are made on **stored HLC values**, which are never rewritten — so cross-device ordering is
   unaffected by this proposal.
2. The **server's own** HLC — used only when the server originates an operation — merges an
   inbound `physical` **only within `max_drift_ms`**, defaulting to the same configurable value
   as the `FR-OFF-042` skew threshold (5 minutes). Beyond that bound the inbound value is
   recorded, alerted and *not adopted into the server clock*.

This changes nothing about how a received operation is stored, ordered or acknowledged. It only
prevents one wrong device from permanently displacing the server's clock. It is a bound the SRS
promises but does not specify, so it is an **engineering proposal, not a reading of the SRS**.

### 7.7 What the server never does

The server never rewrites, normalises, corrects or truncates a received `hlc`. It is part of the
operation's identity, part of the audit record, and part of what makes a replayed batch
byte-identical.

---

## 8. Operation envelope

### 8.1 Batch envelope

```jsonc
{
  "protocolVersion": 1,
  "deviceId":        "<uuid>",       // terminal id; cross-checked against the authenticated principal
  "batchId":         "<uuid>",       // ULID-as-UUID; the batch idempotency key (SRS §21.5.1)
  "lastServerCursor": "<opaque>|null",
  "operations":      [ /* 1..500 operation envelopes */ ]
}
```

### 8.2 Operation envelope

```jsonc
{
  "opId":            "<uuid>",       // ULID-as-UUID; THE operation idempotency key (SRS §21.5.1)
  "hlc":             "<13>.<5>.<32>",
  "type":            "order.create", // "<aggregate>.<operation>"
  "entityId":        "<uuid>",       // the aggregate id this operation concerns
  "causedBy":        "<uuid>|null",  // opId of the causal parent (SRS §21.5.1)
  "actorEmployeeId": "<uuid>|null",
  "occurredAt":      "2026-09-02T14:31:07.412+03:00",   // device wall clock, RFC 3339 with offset
  "schemaVersion":   1,
  "payload":         { /* type-specific */ }
}
```

### 8.3 Every field justified — and what was deliberately left out

| Field | Required by | Why it is here |
|---|---|---|
| `opId` | `FR-OFF-021`, SRS §21.5.1 | *"idempotency key for the operation"* — the SRS says so literally. No separate `idempotencyKey` field: that would be two names for one thing. |
| `hlc` | `FR-OFF-041`, §7.4.1 `hlc` column | Causal ordering and LWW resolution. |
| `type` | SRS §21.5.1 (`"order.create"`) | Dotted `<aggregate>.<operation>`. **The aggregate type is derivable from `type`; no separate `aggregateType` field is added** — it would be a second, desynchronisable source of the same fact. |
| `entityId` | SRS §21.5.1 | The aggregate id. |
| `causedBy` | `FR-OFF-022`, SRS §21.5.1 | Causal parent, so a parent-less operation can be **deferred, not rejected**. |
| `actorEmployeeId` | `FR-OFF-044`, `governance.audit_entries.actor_id`, §24 repudiation control | A 72-hour batch spans shift changes (`UC-OFF-01` step 8). Batch-level actor would attribute a whole outage to one employee. Nullable for system-originated operations. |
| `occurredAt` | `FR-OFF-042` ("preserve the device's original timestamp"), `orders.origin_device_time` | The device's *wall clock*, distinct from the HLC's logical time. Both are needed: one is causal, one is what the receipt says. |
| `schemaVersion` | §15 | A device offline 72 h may be running an older payload schema than the server. Without this the server must guess. |
| `payload` | SRS §21.5.1 | Type-specific body. |

**Deliberately NOT in the envelope, and this is a security property, not an omission:**

| Absent field | Why |
|---|---|
| `tenantId` | Taken from the authenticated principal, **never from the body**. This is the existing repository rule — `IdempotencyInterceptor`: *"The tenant comes from the authenticated principal, never from the body, so a key can never be replayed across a tenant boundary."* Accepting a body tenant would reopen `CT-05`. |
| `branchId` | Derived server-side from the authenticated terminal's `branch_id`, which is FK-enforced since the `D-2` amendment (item 3). A POS terminal writes only for its own branch; letting the body assert otherwise would be a privilege escalation with no legitimate use. |
| `idempotencyKey` | `opId` **is** it. |
| `fingerprint` | Computed server-side over the canonical operation (§16.3). A client-supplied fingerprint is unverifiable and worthless. |
| `clientSeq` | **Not required.** Causal order is carried by `causedBy` + `hlc`; resumption is guaranteed by `batchId`/`opId` idempotency (`FR-OFF-025`); prioritisation is a client-side queue concern (`FR-OFF-026`). A per-device sequence would add a gap-detection obligation the SRS never asks for and that a partitioned outbox cannot reliably satisfy. Omitted on the "do not overstuff" rule. |
| `signature` | Not required by any `FR-OFF`. Transport is TLS; device identity is the authenticated terminal. Per-operation signing is a `FR-SEC` question, not a sync one. |

### 8.4 Envelope validation is strict

Unknown fields at the envelope level are **rejected**, not ignored (§15.3). An unknown envelope
field means the client is speaking a protocol version the server does not know, and silently
dropping part of a financial operation is exactly the failure `NFR-REL-010` forbids.

---

## 9. Batch upload

### 9.1 Endpoint shape

```
POST /sync/batch
Idempotency-Key: <batchId>          # same value as body.batchId — see §16.2
Content-Type: application/json
Authorization: Bearer <terminal-scoped token>
```

> **Path note, verified this session.** SRS §26.1 and §21.5.1 write `/v1/sync/batch`, but **no
> `/v1` prefix exists anywhere in this application** — there is no `setGlobalPrefix`, and
> `src/swagger.config.ts` documents this explicitly, publishing `addServer('/')` rather than
> guessing at a prefix. `D4-1` therefore registers `@Controller('sync')` at the application root,
> exactly like every other controller. Introducing `/v1` is a repository-wide API decision, not a
> Lane D one; it is out of scope here and must not be made unilaterally by this slice.

### 9.2 Maximum operations and size

| Limit | Value | Basis |
|---|---|---|
| Operations per batch | **500** | `NFR-PERF-032` grades exactly 500; `UC-OFF-01` step 10 says *"batches of 500"*. Above 500 → `400 batch_too_large`. |
| Bytes per batch | **4 MiB** | Engineering proposal (`GD-D1-06`). Above → `413`. |
| Bytes per operation | **64 KiB** | Engineering proposal (`GD-D1-06`). Above → per-operation `rejected/payload_too_large`, **not** a batch failure. |
| Plan-based limits | **Dependency** | `FR-OFF-020` says *"bounded by plan limits"*. **No plan/entitlement substrate exists** (no `platform.feature_flags`, no plan model). `D4-1` implements the fixed caps; plan-derived caps are a Lane-crossing dependency recorded in §26. |

The per-operation cap is load-bearing for `NFR-PERF-020`, not just for safety: at 2 Mbps, 5,000
operations must fit in 5 minutes, and payload size is the dominant term (§3.3).

### 9.3 Ordering

`FR-OFF-022`: *"Operations within a batch SHALL be applied in causal order. An operation whose
causal parent has not been applied SHALL be deferred, not rejected."*

Application order within a batch:

1. Build the dependency graph from `causedBy`.
2. Topologically sort; break ties by HLC comparison (§7.4).
3. Apply in that order.
4. An operation whose `causedBy` names an `opId` that is **neither already applied (in the oplog)
   nor present earlier in this batch** is **deferred** — not applied, not rejected, and the
   client keeps it.
5. A `causedBy` cycle within a batch → every operation in the cycle is `rejected` with
   `causal_cycle`. A cycle is a client defect, and deferring it forever would silently strand the
   outbox.

The server does **not** reorder across batches or hold deferred operations in a server-side
pending queue: the operation stays in the client's outbox and is re-sent (§10.4). This keeps the
server stateless with respect to incomplete causal chains, which matters for `CT-14`.

### 9.4 Transaction boundaries

`FR-OFF-023`: *"A single failing operation SHALL NOT fail the batch."* This forces
**per-operation transactions**. There is no outer batch transaction.

Each operation is applied inside the existing Unit-of-Work transaction (`src/common/domain-events/
unit-of-work.ts`), so domain events, the audit chain and the write commit atomically per
operation — exactly as an online command does today. An operation that throws rolls back only
itself and is recorded as `rejected` or `conflict`.

**The `NFR-PERF-032` problem, stated honestly.** 500 operations in 3 s p95 is **6 ms per
operation**, and that budget must cover revalidation (price resolution, tax computation), the
write, the audit hash-chain append, and the commit. 500 sequential round-trip transactions on a
pooled connection will not hit 6 ms each without work.

Mitigations available to `D4-1`, in the order they should be tried:

1. Pin the whole batch to **one pooled connection** for its duration — removes 500 checkout
   round trips.
2. **Group causally independent operations** into chunks that commit together, with a rule that a
   failure inside a chunk retries that chunk operation-by-operation so `FR-OFF-023` still holds.
   This is the highest-leverage option and the one most likely to be needed.
3. Batch-load the reference data revalidation needs (prices, tax classes, country pack) **once
   per batch** rather than per operation.
4. Append audit entries in one statement per chunk — see the contention warning in §17.8.

`D4-1` must **measure** this, not assume it. P0 §11 records a comparable case
(`NFR-PERF-006`) where the assumed cost and the measured cost differed materially.

### 9.5 Partial success semantics

**Always `200 OK` with a per-operation result array**, provided the batch envelope itself is
well-formed and authorised. A per-operation failure never produces a 4xx.

4xx/5xx are reserved for envelope-level faults only:

| Status | Condition |
|---|---|
| `400` | Malformed batch, `> 500` operations, unknown envelope field, unsupported `protocolVersion` |
| `401` | No/invalid terminal token |
| `403` | `deviceId` ≠ authenticated terminal; terminal revoked or disabled (§17.5) |
| `409` | `Idempotency-Key` reused with a different batch fingerprint (`FR-API-023`) |
| `413` | Batch exceeds the byte cap |
| `429` | Rate limit (§17.7) |
| `5xx` | Server fault — **never definitive**; the client retries the whole batch |

### 9.6 Per-operation result

```jsonc
{
  "opId":   "<uuid>",
  "status": "accepted" | "duplicate" | "conflict" | "rejected" | "deferred",
  "reasonCode":   "<machine-readable>",   // required for conflict, rejected, deferred
  "reasonDetail": "<human-readable>",     // optional
  "conflictId":   "<uuid>|null",          // set when status = conflict (§11.4)
  "revalidation": {                       // present only when server values differ (FR-OFF-046)
    "clientValues": { "grandTotal": "22950", "taxTotal": "2661" },
    "serverValues": { "grandTotal": "22952", "taxTotal": "2663" },
    "exceptionId": "<uuid>"
  }
}
```

`FR-OFF-023` enumerates four statuses. **`deferred` is a fifth**, and it exists because
`FR-OFF-022` and `FR-OFF-024` read together require it (§9.3, §10.4) — see `GD-D1-04`.

### 9.7 Batch result and `CT-14`

```jsonc
{
  "batchId":     "<uuid>",
  "receivedAt":  "2026-09-02T11:31:09.004Z",
  "serverHlc":   "<13>.<5>.<32>",
  "nextCursor":  "<opaque>",
  "counts":      { "accepted": 496, "duplicate": 2, "conflict": 1, "rejected": 0, "deferred": 1 },
  "results":     [ /* one per submitted operation, in submission order */ ]
}
```

`CT-14` (20,000-operation backlog) resolves to 40 batches of 500. At the `NFR-PERF-032` budget
that is ~120 s of server time, comfortably inside `NFR-PERF-020`'s envelope. The binding
constraints are memory and connection lifetime, so:

- The server **never** holds more than one batch in memory. There is no server-side accumulation
  across batches.
- The client drives pacing; the server holds no backlog state beyond `sync.device_state`.
- Rate limiting must be expressed in **batches per minute**, not requests, so a legitimate
  40-batch drain is not throttled into failure (§17.7).

### 9.8 Retry and duplicate semantics

| Situation | Server behaviour |
|---|---|
| Whole batch re-sent, same `batchId`, identical fingerprint | Stored batch response replayed verbatim with `Idempotent-Replay: true` (`FR-API-022`). **No operation is re-applied.** |
| Same `batchId`, **different** fingerprint | `409` (`FR-API-023`) — a client defect, not a retry. |
| Same `batchId` still in flight | `409` "being processed concurrently". Existing `IdempotencyService` behaviour, unchanged. |
| Same `opId` in a **new** batch, already applied | `duplicate`, returning the original per-operation result from the oplog row. |
| Connection lost mid-batch, client re-sends | Either the batch committed (→ replay) or it did not (→ fresh processing; each already-applied operation independently returns `duplicate`). Either way **no duplication** — `FR-OFF-025` satisfied at both levels. |

---

## 10. Ack semantics

This section answers exactly one question: **when may the client delete an operation from its
outbox?**

### 10.1 The rule

`FR-OFF-024`: *"The client SHALL remove an operation from the outbox only upon receiving a
definitive server response for it."*

| Per-operation status | Definitive? | Client action |
|---|:--:|---|
| `accepted` | **YES** | Delete from outbox |
| `duplicate` | **YES** | Delete from outbox |
| `conflict` | **YES** | Delete from outbox; surface the conflict; **do not retry** |
| `rejected` | **YES** | Delete from outbox; move to a local dead-letter store for operator visibility; **do not retry** |
| `deferred` | **NO** | **Keep**; re-send after its causal parent is accepted |
| operation absent from `results` | **NO** | Keep and re-send |
| HTTP `5xx`, `429`, timeout, transport failure | **NO** | Keep the whole batch and retry with backoff |
| HTTP `409` on the batch | **NO** | Keep; this is a client defect requiring a new `batchId` or a fixed payload |

`rejected` is definitive on purpose. An operation the server will never accept must not be
retried forever — it would block the outbox head and, under `FR-OFF-026` prioritisation, could
starve every financially significant operation behind it. Local dead-lettering preserves the
record for the operator without stalling the queue.

### 10.2 What "durable" means, precisely

**`accepted` means the operation's own transaction has COMMITTED to PostgreSQL.** Not enqueued,
not buffered, not accepted for later processing. When the client sees `accepted`, the write is on
disk under the same durability guarantee as an online order.

### 10.3 The ordering that makes the guarantee true

This ordering is the whole of `NFR-REL-010` for the sync path, and it must not be rearranged:

```
1. Reserve the batch idempotency key (batchId), in its own transaction   [existing substrate]
2. For each operation, in causal order:
     a. apply inside its own Unit-of-Work transaction
     b. COMMIT
     c. record the per-operation result on the oplog row
3. Persist the assembled batch response under batchId (IdempotencyService.complete)   ← COMMITS
4. ONLY THEN write the HTTP response
```

Step 3 must precede step 4. If the server crashes between them the client sees a transport
failure, keeps everything, and re-sends; the replay then returns `duplicate` per operation. If
step 4 preceded step 3, a crash in that window would leave the client holding a `200` for work
whose record of acceptance was lost — and on the client's next sync the server would have no
memory of the batch. That is the exact shape of `CT-01`'s "zero loss, zero duplication" failure.

### 10.4 `deferred`, and why it must exist

`FR-OFF-022` requires a parent-less operation to be **deferred, not rejected**. `FR-OFF-024`
permits the client to discard **only** on a definitive response. `FR-OFF-023` lists four
statuses, all four of which are definitive.

Mapping "deferred" onto any of the four breaks something:

- `rejected` → the client discards an operation the server explicitly said it would accept later.
  Sale lost. Violates `FR-OFF-022` and `NFR-REL-010`.
- `conflict` → semantically false and would raise a spurious conflict record for a manager.
- omitting it from `results` → works, but is indistinguishable from a server bug that dropped an
  operation, and gives the client no reason and no retry guidance.

Hence the fifth status. It extends the `FR-OFF-023` enumeration and therefore **requires
ratification** — `GD-D1-04`.

---

## 11. Persistence design

**PROPOSED ONLY. Nothing below is implemented, and `D1-1` writes no schema.** Column lists are
design intent, not final DDL.

### 11.1 `sync.sync_operations` — the oplog

The core table. Named by SRS §25.1.

| Column | Type | Notes |
|---|---|---|
| `op_id` | `UUID` | Client ULID-as-UUID |
| `tenant_id` | `UUID` | RLS key |
| `branch_id` | `UUID` | Server-derived from the terminal |
| `terminal_id` | `UUID` | Server-derived from the principal |
| `actor_employee_id` | `UUID NULL` | From the envelope |
| `batch_id` | `UUID` | The batch that delivered it |
| `type` | `VARCHAR(64)` | `<aggregate>.<operation>` |
| `entity_type` | `VARCHAR(48)` | Derived from `type`; denormalised for indexing |
| `entity_id` | `UUID` | |
| `caused_by` | `UUID NULL` | |
| `hlc` | `VARCHAR(52)` | Verbatim; never rewritten |
| `origin_device_time` | `TIMESTAMPTZ` | Envelope `occurredAt` |
| `received_at` | `TIMESTAMPTZ` | Server clock |
| `schema_version` | `INTEGER` | |
| `payload` | `JSONB` | Verbatim |
| `fingerprint` | `CHAR(64)` | Server-computed SHA-256 |
| `status` | `VARCHAR(16)` | `accepted`/`duplicate`/`conflict`/`rejected` |
| `reason_code` | `VARCHAR(48) NULL` | |
| `result` | `JSONB NULL` | The per-operation result, replayed on duplicate |
| `applied_at` | `TIMESTAMPTZ NULL` | |

**Unique constraints**

- `UNIQUE (tenant_id, op_id)` — **this is the operation-level idempotency guarantee**
  (`FR-OFF-021`, `NFR-REL-011`). It is the single most important constraint in this design.
- Partition-composite equivalent if the table is partitioned (below).

**Indexes**

- `(tenant_id, entity_id, hlc)` — conflict detection and per-entity causal replay
- `(tenant_id, terminal_id, received_at DESC)` — `FR-OFF-047` per-terminal mismatch analysis
- `(tenant_id, caused_by)` partial `WHERE caused_by IS NOT NULL` — dependency resolution
- `(tenant_id, batch_id)` — batch replay

**Partitioning.** RANGE on `received_at`, monthly — the same technique already used for
`sales.orders` and `inventory.stock_movements` on `business_day`/`occurred_at`. At 500-order
days across a fleet this table becomes the largest in the database; retention pruning without
partitioning would be a `DELETE` storm.

**Retention.** The SRS sets no oplog retention. `FR-OFF-021`'s 30-day floor applies to
idempotency keys, and `FR-OFF-021` is satisfied by this table for operation-level keys — so
**30 days is the hard floor**. Proposed: **90 days hot, then drop the partition**
(`GD-D1-06`). Rationale: 30 days is the legal minimum for replay-safety, but `FR-OFF-046`
reconciliation exceptions and `FR-OFF-052` corpus triage both need the originating operation to
still exist when a discrepancy is investigated, and that investigation is not same-week work.

### 11.2 `sync.sync_batches` — justified, and small

Named by SRS §25.1 and by §7.3 entity 40 (*"SyncBatch — Operations, ConflictRecords — Idempotent
by batch key"*).

It does **not** store the batch response (that lives in `sync.idempotency_keys`, §16.2). It
stores **telemetry**: `batch_id` (PK with tenant), `tenant_id`, `terminal_id`,
`protocol_version`, `operation_count`, per-status counts, `received_at`, `completed_at`,
`duration_ms`, `byte_size`, `max_clock_skew_ms`.

Justified by two requirements that cannot be satisfied without per-batch aggregation:
`FR-OFF-047` (systematic mismatch **from one terminal**, counted) and `NFR-PERF-032` (a p95 the
system must be able to *show*, not assert). Without it, both become unmeasurable.

### 11.3 `sync.device_state` — justified

Named by SRS §25.1. One row per `(tenant_id, terminal_id)`.

`last_batch_id`, `last_cursor`, `last_seen_at`, `last_server_hlc`, `device_hlc` (§7.6),
`clock_skew_ms`, `skew_detected_at`, `skew_alerted_at`, `protocol_version`, `app_version`,
`revalidation_mismatch_count`, `mismatch_window_start`.

Directly required by `FR-OFF-042` (record skew), `FR-OFF-030` (cursor), `FR-OFF-047` (mismatch
count against a configurable threshold) and `GD-D1-03` (per-terminal HLC).

### 11.4 `sync.conflict_records` — justified

Named by SRS §25.1; required by `FR-OFF-043`.

`id`, `tenant_id`, `branch_id`, `entity_type`, `entity_id`, `conflict_class`, `detected_at`,
`op_id`, `competing_op_id`, `applied_rule`, `resolution` (`auto` / `manual_pending` /
`manual_resolved`), `local_state JSONB`, `server_state JSONB`, `resolved_by`, `resolved_at`,
`audit_entry_id`.

`FR-OFF-043` requires *"both versions displayed"* to a manager — hence both state columns.
`FR-OFF-044` requires the audit link.

### 11.5 Reconciliation exceptions — home not yet decided

`FR-OFF-046` requires a **reconciliation exception** distinct from a conflict: the operation was
*accepted*, and a human must review a value difference. SRS §25.1 lists
`governance.anomaly_flags` (not implemented) and does not list an exceptions table under `sync`.

Two candidate homes, and this is a Lane-crossing decision → `GD-D1-05`:

- **(a) `governance.anomaly_flags`** — the SRS names it, `FR-OFF-047` escalates to a *platform*
  alert which is governance-shaped, and it would serve non-sync anomalies too. **Recommended.**
- **(b) `sync.revalidation_exceptions`** — keeps Lane D self-contained and unblocks `D4-1`
  without a Lane-crossing dependency.

### 11.6 Columns missing from existing tables

Both are required by the SRS today and are simply absent:

| Table | Column | Required by | Status |
|---|---|---|---|
| `sales.orders` | `hlc VARCHAR(52)` | §7.4.1, §25.2 | **ABSENT** |
| `sales.orders` | `sync_state` enum (`local`/`pending`/`synced`/`conflicted`) | §7.4.1, §25.2 | **ABSENT** |

`origin_device_time` and `idempotency_key` are already present. `D4-1` adds the two missing
columns; both are additive and safe on the partitioned table. Every other synced aggregate
(`order_lines`, `order_payments`, `cash_sessions`, `stock_movements`, `tickets`) needs the same
treatment — `D4-1` must decide whether `hlc` lives on each row or only in the oplog, and the
recommendation is **both**: the oplog for protocol truth, the row for query-time LWW resolution
without a join.

---

## 12. Conflict matrix

`FR-OFF-040` requires every entity type classified. The SRS's own §21.7 table is the spine; rows
marked **[SRS]** are its classifications verbatim, rows marked **[PROPOSED]** are engineering
proposals filling gaps the SRS leaves open.

### 12.1 The matrix

| # | Operation / domain | Conflict class | Detection rule | Winner / resolution | Compensating action | Audit event | Client notification | Manual? |
|:--:|---|---|---|---|---|---|---|:--:|
| 1 | **Order create** | None possible **[SRS]** | — (single-writer by construction) | Accept | — | `sync.operation.applied` | none | No |
| 2 | **Order lines, shared table** (`CT-03`) | CRDT: add-wins set; per-line LWW on mutable fields **[SRS]** | Two ops on one `order_id` from different `terminal_id`, concurrent by HLC | Union of added lines (**a line is never removed by a losing writer**); each mutable field takes the higher-HLC value | — | `order.line.conflict_resolved` with both input states + applied rule (`FR-OFF-044`) | Silent; reflected on next pull | No |
| 3 | **Order void vs payment** | Semantic **[PROPOSED]** | Void op and payment op on one order, concurrent by HLC | **Payment wins** — money physically moved and cannot be un-taken by ordering | Reconciliation exception → manager decides refund | `order.void_payment_conflict` | Yes, manager | **YES** |
| 4 | **Payment duplicate** | Server-authoritative, idempotent by key **[SRS]** | Same `opId`, or same `(order_id, terminal_id, amount, external_ref)` | Second is `duplicate`; **no second charge** (`NFR-REL-011`, `FR-POS-065`) | — | `sync.operation.duplicate` | none | No |
| 5 | **Payment overpayment across partition** | Semantic **[PROPOSED]** | `sum(payments) > grand_total` after merge | **Accept both** — both sums were physically taken (`FR-OFF-046` principle) | Reconciliation exception → refund workflow | `order.overpaid` | Yes, manager | **YES** |
| 6 | **Stock movement** | Append-only, commutative **[SRS]** | — (order of independent movements is irrelevant) | Apply all in HLC order; **stock level is derived, never synced as a value** | — | `inventory.movement.applied` | none | No |
| 7 | **Negative stock after replay** | Not a conflict — an alert **[SRS rationale]** (`UC-OFF-01` step 12) | Derived balance < 0 after backlog replay | Apply anyway; flag | Negative-stock alert; suggests an unrecorded goods receipt | `inventory.negative_stock` | Yes, manager | No |
| 8 | **Loyalty double redemption** (`CT-13`) | Ledger append; server recomputes; overdraw flagged **[SRS]** | Ledger sum for a customer goes negative after merge | **Append both entries**; server recomputes balance; overdraw flagged. `FR-CRM-021`: *"risk of overdraw accepted and reported on sync"* — **tenant policy decides honour vs reverse** | Compensating ledger entry when policy = reverse (never a mutation — `FR-CRM-020`) | `loyalty.overdraw_detected` + conflict record | Yes, manager | **YES** (policy-dependent) |
| 9 | **Employee clock event** | Append-only; duplicates by `(employee, type, time window)` **[SRS]** | Same employee, same event type, inside the configured window | Second is `duplicate` | — | `workforce.clock_duplicate` | none | No |
| 10 | **Configuration / menu / price / recipe** | Server-authoritative; client changes **rejected** **[SRS]** | Any inbound op whose `type` is a reference-data mutation | **`rejected`**, reason `reference_data_is_server_authoritative` | — | `sync.reference_mutation_rejected` — **also a `FR-OFF-047` tamper signal** | Yes | No |
| 11 | **Cash session, one drawer** | Single-writer **[SRS]** | Two sessions open for one `drawer_id` | Second `rejected/drawer_occupied` | — | `treasury.drawer_conflict` | Yes | No |
| 12 | **Cash session, both closed offline** | Semantic **[PROPOSED]** | Two closed sessions for one drawer overlapping in time | Neither auto-wins — counts are physical facts | Conflict record with both counts; manager reconciles | `treasury.session_overlap` | Yes, manager | **YES** |
| 13 | **Stock count session** | Exclusive lock by scope; second submission rejected **[SRS]** | Two sessions for one `(location_id, scope_type, scope_id)` overlapping | First-committed by HLC wins; second `rejected/count_scope_locked` | — | `inventory.count_scope_conflict` | Yes | No |
| 14 | **Table state** | LWW with HLC **[SRS]** | Concurrent ops on one `table_id` | Higher HLC wins (tie-break on node, §7.4) | — | `org.table_state_resolved` | none | No |
| 15 | **KDS ticket state** | LWW with HLC over a monotonic state machine **[PROPOSED]** | Two devices act on one `ticket_id` concurrently | Higher HLC wins **per field**; a legal-transition guard prevents a stale op un-bumping a served ticket; `recall` at a higher HLC **is** honoured (`FR-KDS-025`) | — | `kitchen.ticket_state_resolved` | Silent | No |
| 16 | **Order number collision** | Allocation **[SRS `FR-POS-002`]** | Unique violation on `(branch_id, business_day, order_number)` after block-exhaustion fallback | **The order is NEVER rejected** (`NFR-REL-010`). Server reallocates the **order number only** — never the id (§6.5) — from a reconciliation range | Reallocated number recorded on the order; receipt already printed shows the old number | `sales.order_number_reconciled` with both numbers | Yes, informational | No |
| 17 | **Fiscal document sequence** | **UNRESOLVED** | — | **Cannot be specified — see §18** | — | — | — | **DEFERRED to `D4-3`** |
| 18 | **Offline approval under `FR-SEC-035`** | Policy **[SRS]** | Op carries an offline PIN approval | Accept per tenant policy (block vs permit-with-retrospective-approval) | Flagged for retrospective review in an exception report | `governance.retrospective_approval_required` | Yes, manager | **YES** (review) |

### 12.2 Audit obligations for every row

`FR-OFF-044` [M]: *"All automatic conflict resolutions SHALL be recorded in the audit log with
both input states and the applied rule."*

`governance.audit_entries` already carries `before_state` and `after_state` (JSONB) and is
hash-chained. For a conflict resolution the mapping is: `before_state` = the losing/competing
state, `after_state` = the applied state, `reason_code` = the rule identifier (e.g.
`conflict.lww.hlc`, `conflict.add_wins`), `entity_type`/`entity_id` = the contested aggregate.
No new audit substrate is required — but see the contention warning in §17.8.

### 12.3 What this matrix does not cover

`crm` (loyalty, customers) and attendance events have **no substrate whatsoever** (§4.2). Rows 8
and 9 are contracts for whichever lane builds those domains; `D4-1` cannot implement them and
must not claim `CT-13`.

---

## 13. Revalidation

### 13.1 Accepted blindly — physical facts

These record something that physically happened. The server has no better information than the
device, and second-guessing them would be inventing data. **Validated for shape, authorisation
and tenancy — but their values are taken as given:**

cash counted and denomination breakdowns · drawer open/close events · employee clock events ·
waste quantities and reasons · KDS bump/start/ready/serve timings · table state · order notes and
guest counts · the fact and time of a payment · the operator who acted · offline PIN approvals
(`FR-SEC-035`).

### 13.2 Must be revalidated — `FR-OFF-045`

*"prices, discounts, taxes, totals, loyalty accrual"* — the SRS names these explicitly. In full:

| Computation | Server authority | Exists today? |
|---|---|---|
| Unit price resolution (`FR-POS-041`, 7-level precedence) | `src/modules/catalogue/pricing/price-resolution.ts` | **YES** |
| Modifier price computation | `src/modules/catalogue/` | YES |
| Line and order discount application + distribution | `src/modules/sales/` | Partial |
| Promotion evaluation (`FR-CRM-027`) | — | **NO substrate** |
| Tax computation and rounding | `src/modules/localisation/tax/` | **YES** |
| Service charge | — | Partial |
| Cash rounding | `src/common/money/rounding.ts` + country pack | **YES** |
| Order totals (subtotal, discount, tax, grand, rounding adjustment) | derived | YES |
| Loyalty accrual | — | **NO substrate** |
| Recipe expansion / COGS | `src/modules/production/` | YES |

### 13.3 Never accepted from the client at all — stronger than revalidation

Some values are not "revalidated"; they are **computed server-side and the client's value is
recorded only as evidence**:

`stock_movements.balance_after` · `orders.cogs_total` · any ledger balance · `tenant_id` ·
`branch_id` · audit `sequence_no` and hash chain · `received_at`.

`business_day` is taken from the payload (the device knows its own day-close state offline) but
validated against the branch's operating configuration; a mismatch raises an exception, it does
**not** reject (`FR-OFF-046`).

### 13.4 The mismatch rule — `FR-OFF-046`, and it is absolute

*"Where server revalidation produces a different result, the server SHALL **accept** the
transaction (the sale physically occurred), record both values, and raise a reconciliation
exception for review."*

The SRS's rationale is unusually direct: *"Rejecting a synced sale because the server disagrees
about a price is not an option: the customer already paid and left."*

Therefore: **a revalidation mismatch NEVER produces `rejected` and NEVER produces `conflict`.**
It produces `accepted` plus a populated `revalidation` block in the per-operation result (§9.6)
plus a reconciliation exception record (§11.5). This is the single rule most likely to be
implemented wrongly, because every instinct in a validation layer says "reject the bad data".

`UC-OFF-01` step 11 is the worked example: four orders show a two-piastre tax difference from a
price change published at 13:00 that the terminals never received; all four are accepted, four
exceptions are raised.

### 13.5 `FR-OFF-047` — systematic mismatch escalation

*"Systematic revalidation mismatches from one terminal SHALL be treated as a signal of stale
reference data or client tampering, and SHALL escalate to a platform alert after a configurable
count."*

Implementation shape: `sync.device_state.revalidation_mismatch_count` incremented per mismatch
within a rolling window (`mismatch_window_start`); crossing the tenant-configured threshold emits
a **platform** alert — distinct from the branch-manager alert of `FR-OFF-042`.

Note the diagnostic split the requirement itself implies: mismatches concentrated on one terminal
across many entity types suggest tampering; mismatches across many terminals on one entity type
suggest a reference-data distribution failure. `D4-1` should record enough dimensionality to tell
those apart, because the operational responses are opposite.

---

## 14. Bootstrap snapshot

### 14.1 What the POS must hold to operate offline

From SRS §21.3, cross-checked against the current schema. **"Present" means the server has the
data; it does not mean an endpoint exists to ship it.**

| Data | Direction | Refresh (SRS) | Server substrate | Bootstrap status |
|---|---|---|---|---|
| Menus, categories, items, variants, modifiers, groups, links, placements, availability rules | Down | On change + periodic full reconcile | `catalogue.*` — **present** | Ready |
| Price lists and entries, **including future-dated** | Down | On change | `catalogue.price_lists`, `price_entries` — **present** | Ready. Future-dated prices **must ship ahead and activate locally by date** (SRS §12: *"will not take effect on a branch that is offline"*) |
| Recipes for offline availability and cost | Down | On change | `production.recipes`, `recipe_versions`, `recipe_lines`, substitutes, modifier effects — **present** | Ready |
| Tax configuration and country pack, **version-pinned** | Down | On change | `localisation/country-pack` loader + **signature verification** — present | Ready. Client **MUST verify the pack signature** (`FR-LOC-022`) and activate by effective date (`FR-LOC-024`) |
| Employees, hashed PINs, permissions | Down | On change | `identity.employees`, `employee_branches`, `credentials`, `roles`, `permissions` — present | **BLOCKED — see §17.2.** Permission resolution is not branch-aware (`D-2` defer still in force) |
| Customers (recent + frequent subset) | Down | Nightly + on demand | **ABSENT** — no `crm` schema | Not deliverable |
| Loyalty balances (last known) | Down | On sync | **ABSENT** | Not deliverable |
| Stock levels (last known, availability only) | Down | Periodic | `inventory.stock_levels` — present | Ready, **as a hint only**: `FR-OFF-040` classifies stock level as *"not synced as a value — derived from movements"*. It is never uploaded and never authoritative offline |
| Branch, tables, operating hours | Down | On change | `org.*` — present | Ready |
| Terminal config, stations, routing rules, KDS config, print routing | Down | On change | `identity.terminals`, `org.stations`, `kitchen.station_routing_rules`, `kitchen.branch_kds_config`, `org.print_routing` — present | Ready — **and required for §19** |
| Drawers, cash close policy, day-close activation | Down | On change | `treasury.*` — present | Ready |
| Order number block | Down | On sync / at 80% consumption | `sales.order_number_blocks` — **present** | Ready (`FR-OFF-016`, `FR-POS-002`) |
| Fiscal number block / sequence state | Down | Per pack strategy | **ABSENT** | **UNRESOLVED — §18** |
| Reason codes, tax classes, UoMs, packaging units | Down | On change | present | Ready |

### 14.2 Contract shape

```
GET  /sync/snapshot                     → full bootstrap, stamped with a cursor
GET  /sync/changes?since=<cursor>       → deltas since that cursor  (FR-OFF-011, FR-OFF-030)
GET  /sync/checksums                    → per-entity-type digest    (FR-OFF-012)
```

These belong to **`D4-2`**, not `D4-1`. `D1-1` fixes the contract so the client can be built
against it.

### 14.3 Cursor and delta semantics — `FR-OFF-011`, `FR-OFF-030`

The cursor is **opaque to the client**. It is monotonic per tenant and is the client's only
resume token. A cursor the server no longer recognises (too old, or a retention boundary crossed)
→ the server responds `cursor_expired` and the client performs a full snapshot. Never a silent
partial result.

**Two gaps that must be closed before deltas can work** (`GD-D1-06`):

1. **No uniform change watermark.** Reference tables carry `updated_at` inconsistently, and
   nothing carries a tenant-monotonic change sequence. A delta endpoint needs one.
2. **No tombstones.** A deleted menu item cannot be expressed in a delta today, so an offline
   device would keep selling it forever. Soft-delete or a tombstone stream is **mandatory**, not
   optional, for `FR-OFF-011` to mean anything.

### 14.4 Checksum reconciliation — `FR-OFF-012`

*"Periodically perform a full reference-data reconciliation (checksum comparison per entity type)
to detect and repair silent drift."*

Per entity type, a digest over the canonical serialization of that type's tenant/branch-visible
rows, computed identically on both sides — which makes the **canonicalisation itself a shared
algorithm** and therefore a corpus obligation (§20.2). `stableStringify` (already used by the
audit hash chain and the idempotency fingerprint) is the natural basis. A mismatch triggers a
scoped re-pull of that entity type only, not a full snapshot.

### 14.5 Revocation on reconnect — `FR-OFF-032`

*"Permission and terminal revocations SHALL be applied by the client immediately on receipt and
SHALL be re-verified on every reconnection."*

Every snapshot, delta and batch response carries the terminal's current status and the actor
permission set version. The client applies revocations before processing anything else in the
response. This is the online enforcement of `FR-OFF-010`'s offline promise, and it is why §17.5's
revoked-terminal decision matters.

---

## 15. Versioning

### 15.1 Two independent version axes

| Axis | Field | Scope | Meaning |
|---|---|---|---|
| Protocol | `protocolVersion` (batch) | Envelope shape, status vocabulary, batch semantics | Changes when the *protocol* changes |
| Payload schema | `schemaVersion` (per operation) | The `payload` body for one `type` | Changes when one operation's payload changes |

Splitting them matters because they change at different rates: adding a field to `order.create`'s
payload must not force every device to speak a new protocol.

### 15.2 Backward compatibility — the server accepting older clients

- The server accepts `protocolVersion` in a **supported range** it advertises. `NFR-API-002`
  requires 180 days' notice before removing anything, so a version stays accepted for **at least
  180 days** after deprecation.
- Older `schemaVersion` payloads are **upcast** on receipt through a per-`type` upcaster chain,
  never rejected while in the support window.
- This is not theoretical: `CR-01` guarantees 72 hours offline, and a device can be offline
  across an app-release boundary. A device that cannot upload is a device that has lost sales.

### 15.3 Forward compatibility — the server receiving newer clients

**Strict rejection, not lenient ignoring.**

- Unknown envelope field → `400 unknown_field`.
- `protocolVersion` above what the server supports → `400 protocol_version_unsupported`, with the
  supported range in the body.
- `schemaVersion` above what the server knows for that `type` → per-operation
  `rejected/schema_version_unsupported`.

Leniently ignoring an unknown field inside a financial payload would silently discard part of a
sale — a discount, a tax override, a tip. `NFR-REL-010` and `CR-04` both forbid that outcome.
**Versioned upcasting is the only compatibility mechanism; tolerance is not one.**

### 15.4 Response compatibility

Response envelopes are **additive only**. A field is never removed or repurposed within a
protocol version; new fields may appear and older clients ignore them. The per-operation `status`
vocabulary is closed within a version — adding `deferred` (§10.4) is precisely why `GD-D1-04`
must be ratified before `D4-1`, not after.

---

## 16. Idempotency reuse

### 16.1 What exists, verified

`sync.idempotency_keys` + `IdempotencyService`:

- `(tenant_id, key)` primary key — **deliberately tenant-scoped**, per its own schema comment,
  because a global key space *"would collide — and could replay — across tenants"*.
- `endpoint` — so one key reused on a different route is a conflict, not a cross-operation replay.
- `fingerprint` — SHA-256 over `stableStringify({method, path, body})`, the same canonicaliser the
  audit hash chain uses. Deterministic under key reordering; nothing volatile enters it.
- `state` `in_flight` → `completed`, with the reservation committed in **its own transaction**
  before the handler runs, so concurrency is resolved by the primary key.
- `release()` on handler failure, so a transient error does not poison the key forever.
- 30-day `expires_at` (`FR-API-021`), stamped from a single clock reading.
- `409` on fingerprint mismatch (`FR-API-023`); stored response replay with `Idempotent-Replay:
  true` (`FR-API-022`).

The service's own docblock states it is *"deliberately transport-agnostic… so the same component
can later serve the Sync batch path"*. That intent is honoured here.

### 16.2 Reused as-is — batch level

**`sync.idempotency_keys` becomes the batch-level idempotency store, with no schema change and no
service change.**

| Field | Value for sync |
|---|---|
| `key` | `batchId` |
| `endpoint` | the sync batch route |
| `fingerprint` | SHA-256 over `stableStringify` of the canonical batch body |
| `response_body` | the full batch result (§9.7) |

The client sends `Idempotency-Key: <batchId>` **and** `body.batchId`, and the server asserts they
are equal. This satisfies `FR-API-020` (header mandatory on financially significant endpoints)
and `FR-OFF-025` (resumable without duplication) with **zero new code on the idempotency path** —
the existing `IdempotencyInterceptor` handles it by marking the route `@Idempotent`.

### 16.3 Must be separate — operation level

**Operation-level idempotency does NOT use `sync.idempotency_keys`.** It is enforced by
`UNIQUE (tenant_id, op_id)` on `sync.sync_operations`, with the per-operation result stored on
that same row.

Three reasons, and the first is decisive:

1. **Volume.** 500 operations per batch × 40 batches per device-drain × a fleet would put tens of
   millions of rows into a table that stores a JSONB response per row. `idempotency_keys` is
   sized for *requests*, not for operations inside requests.
2. **The oplog is needed anyway.** `FR-OFF-040`/`-043`/`-044`/`-046` all require the operation to
   remain inspectable. Storing operation idempotency in the oplog gets it for free; storing it in
   `idempotency_keys` would mean writing every operation twice.
3. **Different retention curves.** §11.1 argues 90 days for the oplog against 30 for request
   keys.

So: **two levels, two mechanisms, one requirement satisfied at each.** `FR-OFF-021`'s *"Every
operation SHALL carry an idempotency key… persist processed keys for at least 30 days… return
the original result for a repeated key"* is satisfied by the oplog row, whose retention floor is
therefore 30 days (§11.1).

### 16.4 Retention consequences for a 72-hour offline device

- **72 h ≪ 30 days**, so `FR-API-021`'s window covers `CR-01` with a wide margin. Retention is
  measured from **server receipt**, not device creation, so an `opId` minted 72 hours before
  upload still gets a full 30-day replay window from the moment the server first sees it.
- The binding retention constraint is therefore **not** the offline duration. It is
  `FR-OFF-013`'s client-side 30-day pruning and the oplog's own retention (§11.1) — which must
  not be shorter than the client's, or a client retry after a server prune would re-apply an
  operation as new. **Rule: server oplog retention ≥ client outbox retention.** At 90 vs 30 days
  this holds with margin.
- **A gap that must be closed:** nothing prunes `sync.idempotency_keys` today. There is no
  scheduled-job infrastructure in the repository at all (§4.2). `expires_at` is indexed for a
  reaper that does not exist. `D4-1` inherits this: adding sync traffic to an unpruned table
  makes an existing latent problem a real one. Recorded as a risk (§26) and as work in §25.

---

## 17. Security

### 17.1 Tenant isolation

- `tenant_id` comes **only** from the authenticated principal; the envelope carries none (§8.3).
- Every proposed table is keyed `(tenant_id, …)`; RLS applies as the second layer (ADR 0003,
  `prisma.withAuthContext`).
- Cross-tenant `opId` replay is **structurally impossible**: uniqueness is scoped per tenant, and
  the key space is not shared.
- `CT-05` (cross-tenant access returns zero rows) extends to every new sync table without new
  reasoning, provided they follow the established `(tenant_id, id)` + RLS pattern.

### 17.2 Branch identity and scoping — **the Lane B dependency**

`branch_id` is derived from the authenticated terminal, whose `branch_id` is now FK-enforced (the
`D-2` amendment, item 3: *"`FR-SEC-021` cannot be trusted while that binding is unenforced"*).

**But broader branch-scoped RBAC remains deferred.** Quoting the register verbatim:

> *"Broader branch-scoped RBAC — `FR-SEC-002` / `FR-SEC-003` / `FR-SEC-004` general scope
> resolution stays deferred. Only the branch check `FR-SEC-021` itself requires is lifted;
> permission resolution is **not** made branch-aware by this amendment."*

Consequences `D4-1` must live with, and must not paper over:

- An operation can be authorised against *the terminal's branch*, but **not** against *"the
  actor's permitted branches"* in general.
- §14's employee/permission bootstrap cannot ship branch-scoped permissions, because they do not
  exist server-side.
- **This design does not resolve it and must not.** It is Lane B's, and it is listed in §22 as a
  cross-lane dependency rather than a `D1-1` decision.

### 17.3 Device identity

`deviceId` in the batch must equal the authenticated terminal id. Mismatch → `403`, no partial
processing. A terminal cannot upload on behalf of another terminal, and `sync_operations.
terminal_id` is written from the principal, never from the body — so the oplog's device
attribution is trustworthy for `FR-OFF-047` and for the `FR-OFF-042` skew record.

### 17.4 Actor identity

`actorEmployeeId` is per-operation (§8.3) and is what `governance.audit_entries.actor_id`
receives. It is **claimed by the client**, so it is trustworthy only to the extent the offline PIN
authentication that produced it was trustworthy — which is exactly what `FR-SEC-021`/`-022` and
the encrypted local store (`FR-OFF-010`) exist to underwrite. `D4-1` must record it as *asserted
by terminal X*, not as *authenticated by the server*, because it was not.

### 17.5 Revoked terminal — an unresolved tension, stated plainly

`FR-OFF-010`: the local database is *"unusable if the device registration is revoked."* §24's
threat table: *"remote wipe on registration revocation."* `TerminalStatus.revoked` exists and the
terminal session guard already returns 403 for any non-`active` terminal.

**The tension:** a revoked terminal may hold an unsynced backlog of real sales. `NFR-REL-010`
says no committed sale may be lost. `FR-OFF-010` says the store must become unusable. Both cannot
hold for the same device.

**Proposal (`GD-D1-07`, requires approval, and it BLOCKS `D4-1`):**

1. A revoked terminal's batch is **rejected at the envelope level** with `403 terminal_revoked`.
   No operation is applied. Security wins by default.
2. Revocation is therefore an **explicitly destructive act** with respect to unsynced sales, and
   the product must say so at the point of revocation rather than discovering it afterwards.
3. A **quarantine drain** path is specified as required follow-on work: a tenant-admin-authorised,
   audited, one-shot upload from a revoked terminal, applied with every operation flagged
   `origin=quarantine` for mandatory review. Without it, "revoke a lost terminal" and "keep the
   day's sales" are mutually exclusive, and an operator will eventually be forced to choose
   between them under pressure.

`D4-1` implements (1) and (2). (3) is scoped but not built, and this report does not pretend
otherwise.

### 17.6 Replay resistance

The §24 threat table names the controls for *"replayed sync payload"* exactly: **idempotency keys,
HLC ordering, server-side duplicate detection.** All three are in this design:

- batch replay → stored response (§16.2)
- operation replay → `UNIQUE (tenant_id, op_id)` (§16.3)
- reordering/injection → HLC ordering plus causal-parent checks (§9.3)
- payload substitution under a reused key → fingerprint mismatch → `409` (`FR-API-023`)

### 17.7 Malformed operations, size limits, rate limiting

- **Malformed** → per-operation `rejected` with a machine-readable reason; a malformed operation
  never fails the batch, and is never silently dropped (`FR-OFF-023`).
- **Size** → §9.2. Note: **no explicit Express body limit is configured** in `src/main.ts`, so the
  framework default applies. A 4 MiB batch cap must be set deliberately rather than inherited.
- **Rate limiting** → `@nestjs/throttler` is present but wired **only** for auth
  (`src/common/throttler/auth-throttler.guard.ts`, ADR 0006). There is no per-tenant or
  per-terminal limiter for anything else. `D4-1` needs one, and it must be expressed in
  **batches per minute per terminal**, generous enough that a legitimate 40-batch `CT-14` drain
  completes — a limiter that throttles a backlog drain into failure converts an outage into data
  loss. Cross-lane dependency (§22).

### 17.8 Auditability — and a real contention risk

`FR-OFF-044` requires an audit entry per automatic resolution, with both input states and the
applied rule. `governance.audit_entries` supports this natively (§12.2).

**The risk:** the audit chain is hash-chained with `UNIQUE (tenant_id, sequence_no)`. Sequence
allocation is a **per-tenant serialization point**. When three terminals drain a six-hour outage
simultaneously — `UC-OFF-01` produces 1,204 audit events from one branch alone — every audit
append for that tenant contends on one sequence. This is the most likely place `NFR-PERF-032`
fails under realistic recovery load, and it is a pre-existing property of the audit design, not
something this protocol introduces. `D4-1` must measure it explicitly (§25).

---

## 18. Fiscal dependency

### 18.1 The dependency is real and is not negotiable

P0 §16.3 obligation 7: the offline protocol *"cannot be specified until `P7-FISCAL` decides the
`TaxDocument` model."* Verified independently this session: **the `fiscal` schema contains only
`TaxClass`.** There are no `tax_documents`, no `country_packs` table, no `fiscal_submissions` —
all three are named by SRS §25.1 and none exist.

`FR-OFF-017` requires the country pack to select one of three mutually incompatible strategies:

| Strategy | Mechanism | Used where |
|---|---|---|
| Server-assigned on sync | Local document held provisional; fiscal number assigned at sync | Jurisdictions permitting delayed issuance |
| Pre-allocated block | Server issues a **signed** block of fiscal numbers to the terminal in advance | Jurisdictions requiring immediate issuance |
| Device-scoped series | Each terminal holds its own registered series | Jurisdictions permitting per-device series |

These are not variations on one design — they place the sequence authority in three different
places. The offline protocol's fiscal behaviour differs completely between them.

### 18.2 The extension point, designed now

The extension point is deliberately **minimal**, because a larger one would be an invention:

1. **`sync_operations.type` is an open string.** Adding a `fiscal.*` operation family later needs
   **no envelope change, no protocol version bump, no migration.**
2. **`payload` is `JSONB` with a per-`type` `schemaVersion`.** Whatever shape `P7-FISCAL` chooses
   is expressible without touching the protocol.
3. **`FR-OFF-015` already resolves the one question that could have blocked everything:** a
   fiscal number is **not** an entity identifier. A provisional document keeps its client ULID
   permanently and later gains a server-assigned fiscal number as an *attribute*. The
   "server-assigned on sync" strategy therefore does **not** violate "the server SHALL NOT
   reassign identifiers". This is settled here and `D4-3` need not revisit it.
4. **Row 17 of the conflict matrix is reserved**, not guessed.

### 18.3 Exactly what remains unresolved

1. The canonical `TaxDocument` model — fields, states, immutability rules under `CR-04`.
2. How a country pack **expresses** its `FR-OFF-017` strategy choice, and whether a tenant may
   hold packs with different strategies across branches.
3. The block issuance/renewal contract for the pre-allocated strategy: endpoint, block size,
   **signing**, expiry, and the 80%-consumption reorder trigger (by analogy with `FR-POS-002`,
   but **not** by assumption).
4. `FR-OFF-018` void reporting: how unused numbers in an expired block are enumerated, reported
   and proven reported. `UC-OFF-01` postcondition: *"88 unused numbers reported void."*
5. `IR-LOC-SA-003` PIH hash chain **across offline periods** — the hardest case, because the
   chain is order-dependent and offline devices produce documents concurrently.
6. `IR-LOC-SA-004`'s clearance model, which *"conflicts directly with offline operation"* by the
   SRS's own admission and restricts B2B standard invoices to online.
7. The conflict rule for a duplicated fiscal number across two partitioned terminals — the one
   conflict class where "accept both and flag" (`FR-OFF-046`'s principle) may be **legally
   unavailable**.

### 18.4 What `D4-3` must revisit

Row 17 of §12 · the fiscal rows of §14's bootstrap table · the block-allocation contract · the
`fiscal.*` operation family and its payload schemas · `CT-01`'s *"fiscal sequence intact"*
criterion, which **cannot be graded** until the above is decided.

### 18.5 Scheduling consequence

`CT-01` requires 72 hours of elapsed time (P0 §27.1: *"75% of the entire 4-day programme"*), and
its fiscal criterion depends on `D4-3`, which depends on `C3-1`. **`CT-01` cannot be fully graded
inside this programme unless `C3-1` lands early enough for `D4-3` to precede the 72-hour window.**
Stated here so it is a planning input, not a Wave 4 discovery.

---

## 19. KDS dependency

### 19.1 The minimum contracts for local operation

`NFR-REL-002` (KDS keeps displaying and accepting bumps during an outage) and `NFR-REL-003`
(routing works over the LAN with no internet) are satisfied by the **client and the LAN**, not by
backend code. The backend's obligation is to make local behaviour *identical* to what the server
would have done — otherwise the kitchen diverges and the reconciliation on reconnect is a mess.

Three contracts, and only three:

1. **Routing configuration must be in the bootstrap** (§14): `kitchen.station_routing_rules`,
   `kitchen.branch_kds_config`, `org.stations`, `org.print_routing`, and station↔terminal display
   bindings. All exist server-side.
2. **The routing resolver must be a shared, corpus-covered algorithm.** A ticket routed to the
   grill by the LAN coordinator and to the fryer by the server on replay is a divergence, and
   `CT-06`'s "byte-identical" standard applies to routing decisions as much as to money. The
   server resolver exists (`P1E-3`); it needs a `conformance/routing/` corpus (§20.2).
3. **KDS state changes are ordinary oplog operations**: `kitchen.ticket.start`, `.ready`,
   `.bump`, `.recall`, `.serve` — resolved by §12 row 15.

### 19.2 Ownership

| Concern | Owner |
|---|---|
| mDNS discovery (`FR-OFF-035`) | FRONTEND |
| Coordinator election + deterministic tie-break on device id (`FR-OFF-036`, `-038`) | FRONTEND |
| LAN transport, authentication, encryption (`FR-OFF-037`) | FRONTEND, using the backend-issued key |
| **Branch-scoped LAN key issuance at registration** (`FR-OFF-037`) | **BACKEND** — §19.3 |
| Bootstrap of routing config | **BACKEND** — `D4-2` |
| Routing resolver determinism + corpus | **SHARED** — `D2` owns the resolver, `D4` owns the corpus |
| Ticket-state oplog types + conflict rules | **BACKEND** — `D4-1` |
| KDS operator lifecycle semantics | **`D2`** (already has a ratified design gate) |

### 19.3 The one backend gap

`FR-OFF-037` requires *"a branch-scoped key distributed during registration."* No such key exists
in `identity.terminals` or `identity.device_fingerprints`. It is small, but it is a real
prerequisite for `FR-OFF-035`…`-038` and it is nobody's work today. Recorded in §25 and §26.

**`D4` must not claim `NFR-REL-002`/`-003`.** They are satisfied by client behaviour over the LAN;
the backend enables them and cannot demonstrate them.

---

## 20. Conformance corpus

### 20.1 The precedent exists and is followed

`kitchen-kit/conformance/` already holds a language-neutral corpus with an explicit encoding
contract, executed by the TypeScript server suite. This design **extends** that convention; it
does not invent one. Its established rules are adopted unchanged:

- every monetary amount, quantity and rate is a **decimal string** (never a JSON number);
- money in **minor units**, exponent from the pack;
- the only permitted JSON numbers are structural integers;
- jurisdiction codes are **data**, never a branch in code (`CR-03`, ADR-005);
- expectations are **hand-derived from the requirement**, never pasted from implementation output
  — *"a corpus that records what the code does cannot detect what the code gets wrong"*;
- the runner is **strict**: a malformed case throws rather than being skipped;
- a directory is added only when the logic it describes exists.

### 20.2 Directories `D4-1`/`D4-3` must add

| Directory | Vectors | Grades |
|---|---|---|
| `ids/` | ULID → UUID rendering; monotonic-within-millisecond ordering; lexicographic sort equals creation order; the collision-resolution decision table of §6.4 | `FR-OFF-015` |
| `hlc/` | local-event rule; all four receive-rule branches; `l_msg <`, `==`, `>` local; logical increment and reset; overflow/stall; **the `CT-10` +3 h device sequence**; string encoding round-trip; total-order comparison including the node tie-break | `FR-OFF-041`, **`CT-10`** |
| `envelope/` | canonical serialization of an operation → exact byte string → its SHA-256 fingerprint | `CT-06` for the protocol itself |
| `money/` | `Money.allocate` across split bills (**`CT-12`: sum of parts exactly equals the whole**); rounding modes; cash rounding | `CT-12`, `BR-FIN-005` |
| `tax/` | **EXISTS** — two corpus files, running | `FR-OFF-050` |
| `pricing/` | the 7-level `FR-POS-041` precedence; modifier price computation; discount application and distribution; service charge | `FR-POS-041` |
| `search/` | Arabic normalisation: أ إ آ ا → one form; ة → ه; ى → ي; tashkeel ignored — including the SRS's own شاورما ↔ َشاِوْرَما case | `FR-POS-012` |
| `conflict/` | two operations + their HLCs + entity type → expected winner, conflict class, and applied rule, for every row of §12 | `FR-OFF-040`, **`CT-03`**, `CT-13` |
| `routing/` | order line + station rules + KDS config → expected station | `NFR-REL-003` divergence |
| `recipe/` | 5-level sub-recipes with modifiers → base-ingredient depletion | **`CT-07`** |
| `checksum/` | canonical entity-type digest vectors | `FR-OFF-012` |
| `loyalty/` | accrual and redemption vectors | **deferred — no substrate** |
| `promotion/` | deterministic evaluation (`FR-CRM-027`) | **deferred — no substrate** |

### 20.3 The corpus is the contract

`FR-OFF-050`'s scope list is what *must* agree. Anything on it that is not in the corpus is an
ungraded divergence risk, and `FR-OFF-052` requires a new case whenever a production discrepancy
reveals a divergence — **before the fix merges.**

### 20.4 What blocks `FR-OFF-050`/`-051` from being met

Both remain **PARTIAL**, exactly as `conformance/README.md` already states, for two reasons
neither of which Lane D can fix:

1. **The Dart client half does not exist** — no Flutter client in this repository. FRONTEND-EXTERNAL.
2. **No CI job runs both suites** — `FR-OFF-051` (divergence blocks release) is unenforceable
   without it. **Lane G dependency.**

The server matching the corpus proves the server is self-consistent. It does not prove
client/server agreement, and `CT-06` grades agreement.

---

## 21. Frontend handoff

*This section is written for the external frontend team and is intended to be sufficient to build
local persistence and oplog generation without guessing backend semantics. Everything marked
**PENDING APPROVAL** may still change — those items are listed in §21.4.*

### 21.1 BACKEND GUARANTEES

1. **Your identifiers are permanent.** Generate a ULID; it is the entity's primary key forever.
   The server never reassigns, remaps or rewrites it (`FR-OFF-015`).
2. **Send ids as 36-character UUID hex**, not Crockford base32. Same 128 bits, different
   rendering. *(PENDING `GD-D1-01`.)*
3. **`opId` is the operation's idempotency key; `batchId` is the batch's.** You do not need any
   other key. Send `Idempotency-Key: <batchId>` as a header too, with the same value as
   `body.batchId`.
4. **Replaying a batch is always safe.** Same `batchId` + identical body → the identical stored
   response, nothing re-applied. Same `opId` in a new batch → `duplicate` with the original
   result. You cannot double-charge by retrying.
5. **One bad operation never fails your batch.** You always get `200` with a per-operation result
   array, unless the batch envelope itself is malformed, unauthorised or oversized.
6. **`accepted` means committed to disk**, not queued. The batch response is made durable before
   it is sent to you.
7. **A revalidation mismatch is never a rejection.** If the server computes a different total, it
   **accepts your operation anyway**, records both values, and flags it for a human
   (`FR-OFF-046`). The sale happened; the server does not argue with it.
8. **Reference data changes are never rejected into you.** You will never be told your menu is
   wrong — you will be given a delta.
9. **The server never rewrites your `hlc` or `occurredAt`.** Both are stored verbatim as evidence.
10. **The server tells you when your clock is wrong** rather than silently correcting it
    (`FR-OFF-042`).

### 21.2 CLIENT RESPONSIBILITIES

1. **Use a monotonic ULID factory** — increment the random component within a millisecond rather
   than redrawing it. Two entities created in the same millisecond must not collide and must
   retain their order (§6.2).
2. **Implement the HLC exactly as `FR-OFF-041` specifies** — no variations, no improvements. It is
   corpus-graded (§20.2).
3. **Maintain a durable outbox.** Delete an operation **only** on `accepted`, `duplicate`,
   `conflict` or `rejected`. Keep it on `deferred`, on a missing result, and on any 5xx/429/timeout
   (§10.1).
4. **Set `causedBy`** to the `opId` of the operation that must be applied first. A `deferred`
   response means the parent has not arrived — send the parent, then re-send.
5. **Never send `tenantId` or `branchId`.** They are derived from your authentication and would be
   rejected.
6. **Set `actorEmployeeId` per operation**, not per batch. A batch spans shift changes.
7. **`occurredAt` is your wall clock with UTC offset**; `hlc` is your logical clock. Both are
   required and they are not the same thing.
8. **Cap batches at 500 operations**, 64 KiB per operation, 4 MiB per batch. *(PENDING `GD-D1-06`.)*
9. **Exponential backoff with jitter**, and prioritise orders, payments and cash sessions ahead of
   everything else (`FR-OFF-026`).
10. **Verify the country pack's signature** before using it, and activate packs and future-dated
    prices **by local date** (`FR-LOC-022`, `-024`).
11. **Apply permission and terminal revocations immediately** on receipt, and re-verify on every
    reconnection (`FR-OFF-032`).
12. **Treat stock levels as a hint.** They are last-known availability, never authoritative, and
    you never upload them — you upload movements (`FR-OFF-040`).
13. **Enforce the offline loyalty redemption limit locally** (`FR-CRM-021`); the server accepts
    overdraw and reports it, so the guard has to be yours.

### 21.3 SHARED ALGORITHMS — must be byte-identical (`CT-06`)

ULID generation and UUID rendering · HLC (all rules, comparison, encoding) · operation canonical
serialization and fingerprint · `Money.allocate`, rounding, cash rounding · price resolution
(7-level precedence) · modifier pricing · discount application and distribution · tax computation
and rounding · service charge · Arabic search normalisation · conflict resolution rules · KDS
routing resolution · recipe expansion · reference-data checksum canonicalisation.

**Test vectors are the contract.** Where a vector exists, it wins over prose — including this
document.

### 21.4 UNRESOLVED DEPENDENCIES — do not build against these yet

| Area | Status | Blocked by |
|---|---|---|
| **Fiscal document issuance offline**, number blocks, void reporting, PIH chain | **UNRESOLVED** | `C3-1` / `P7-FISCAL` → `D4-3` (§18) |
| **Branch-scoped permissions** in the bootstrap | **DEFERRED** | Lane B; governance `D-2` defer still in force (§17.2) |
| **Loyalty** — balances, ledger, redemption | **NO SUBSTRATE** | No `crm` schema exists |
| **Customers** in the bootstrap | **NO SUBSTRATE** | No `crm` schema exists |
| **Attendance events** | **NO SUBSTRATE** | Only `Shift` exists |
| **WebSocket push** (`FR-OFF-031`, `[S]`) | **NOT PLANNED for `D4-1`** | No realtime substrate; poll on interval instead |
| **Branch-scoped LAN key** (`FR-OFF-037`) | **NOT IMPLEMENTED** | §19.3 |
| **Revoked-terminal backlog** | **PENDING** | `GD-D1-07` — assume your backlog is **lost** on revocation until told otherwise |
| **`/v1` path prefix** | **DOES NOT EXIST** | Endpoints are at the application root today (§9.1) |
| **`deferred` status** | **PENDING** | `GD-D1-04` — but design your outbox for it now |

### 21.5 TEST VECTORS REQUIRED

Both sides must pass, in CI, before release (`FR-OFF-051`). Directories and contents: §20.2.

The Dart runner and the dual-suite CI job **do not exist yet**; they are prerequisites for
`FR-OFF-050`/`-051` and for `CT-06`, and they are not Lane D's to build.

---

## 22. Governance decisions required

### 22.1 Classification of every material decision

| # | Decision | Classification |
|---|---|---|
| 1 | ULID as permanent client-generated PK; server never reassigns | **Directly required by SRS** — `FR-OFF-015` |
| 2 | ULID stored/rendered as UUID | **Already ratified** — ADR-009 ("or native UUID") + repository precedent (`src/common/ids.ts`) |
| 3 | ULID-as-UUID hex is the **wire** form; base32 appears nowhere | **Engineering proposal** — `GD-D1-01` (SRS §21.5.1 shows base32) |
| 4 | HLC algorithm exactly as `FR-OFF-041` | **Directly required by SRS** |
| 5 | HLC encoding `13.5.32` fixed-width, `VARCHAR(52)` | **Engineering proposal** — `GD-D1-02` (SRS shows a different shape; §7.4.1 and §25.2 contradict on width) |
| 6 | Bounded HLC adoption + per-terminal server HLC | **Engineering proposal** — `GD-D1-03` |
| 7 | Envelope field list (§8.2) | **Directly required by SRS** for `opId`/`hlc`/`type`/`entityId`/`causedBy`/`payload`; the rest justified per field in §8.3 |
| 8 | `actorEmployeeId` per operation | **Directly required by SRS** — `FR-OFF-044` + `governance.audit_entries` |
| 9 | `schemaVersion` + `protocolVersion` | **Engineering proposal** — `GD-D1-06` (SRS names neither) |
| 10 | No `clientSeq` | **Engineering proposal** (an omission, justified in §8.3) |
| 11 | `tenantId`/`branchId` never in the body | **Repository precedent** — `IdempotencyInterceptor`, ADR 0002/0003 |
| 12 | 500 operations per batch | **Directly required by SRS** — `NFR-PERF-032` + `UC-OFF-01` |
| 13 | Byte caps (4 MiB / 64 KiB) | **Engineering proposal** — `GD-D1-06` |
| 14 | Per-operation transactions, no outer batch transaction | **Directly required by SRS** — `FR-OFF-023` |
| 15 | Always `200` with per-operation results | **Directly required by SRS** — `FR-OFF-023` |
| 16 | Fifth status `deferred` | **Engineering proposal** — `GD-D1-04` (extends the `FR-OFF-023` enumeration) |
| 17 | Ack ordering: commit → persist batch response → respond | **Repository precedent** (existing `IdempotencyService` flow) + `NFR-REL-010` |
| 18 | Batch idempotency reuses `sync.idempotency_keys` unchanged | **Repository precedent** — the service's own stated intent |
| 19 | Operation idempotency lives in the oplog, not `idempotency_keys` | **Engineering proposal** — §16.3 |
| 20 | Four new `sync` tables | **Directly required by SRS** — §25.1 names all four |
| 21 | Oplog retention 90 days, monthly partitioning | **Engineering proposal** — `GD-D1-06` (SRS sets only a 30-day floor) |
| 22 | Reconciliation exceptions in `governance.anomaly_flags` | **Engineering proposal** — `GD-D1-05` (Lane-crossing) |
| 23 | Conflict matrix rows marked **[SRS]** | **Directly required by SRS** — `FR-OFF-040` table |
| 24 | Conflict matrix rows marked **[PROPOSED]** (3, 5, 12, 15) | **Engineering proposal** — `GD-D1-04` |
| 25 | Revalidation mismatch → accept + record + flag | **Directly required by SRS** — `FR-OFF-046` |
| 26 | Strict forward-compat (reject unknown fields) | **Engineering proposal** — `GD-D1-06` |
| 27 | Revoked terminal → reject batch; backlog lost pending a quarantine drain | **Engineering proposal** — `GD-D1-07` |
| 28 | Corpus encoding conventions | **Repository precedent** — `conformance/README.md` |
| 29 | Endpoint at application root, not `/v1` | **Repository precedent** — verified: no `setGlobalPrefix`; `swagger.config.ts` documents it |

### 22.2 Decisions requiring ratification before `D4-1`

| ID | Decision | Blocks `D4-1`? | Why it needs a decision, not a default |
|---|---|:--:|---|
| **`GD-D1-01`** | Wire form of identifiers: UUID hex (recommended) vs Crockford base32 as SRS §21.5.1 shows | **YES** | Changes every DTO, the OpenAPI contract, the oplog column type, and what the client serialises. Cheap now, expensive later. |
| **`GD-D1-02`** | HLC encoding `13.5.32` in `VARCHAR(52)`; SRS §7.4.1 (40) and §25.2 (48) contradict each other and the example shows a different shape | **YES** | It is a stored column width and a shared algorithm. Both sides must agree before either is written. |
| **`GD-D1-03`** | Bounded HLC adoption (`max_drift_ms`) + per-terminal server HLC | No | `CT-10` passes without it; it prevents one bad clock permanently displacing the tenant's. Can land after the first implementation. |
| **`GD-D1-04`** | Fifth per-operation status `deferred`, plus conflict-matrix rows 3, 5, 12, 15 | **YES** | Extends an `[M]` requirement's closed enumeration and determines when the client may delete from its outbox. |
| **`GD-D1-05`** | Home of `FR-OFF-046` reconciliation exceptions: `governance.anomaly_flags` (recommended) vs `sync.revalidation_exceptions` | No | Lane-crossing; `D4-1` can build behind an interface and bind late. |
| **`GD-D1-06`** | Bundle: byte caps · `protocolVersion`/`schemaVersion` · strict forward-compat · oplog retention 90 d + partitioning · change watermark + **tombstones** | No (except tombstones, which block `D4-2`) | Individually routine, collectively shaping. |
| **`GD-D1-07`** | Revoked terminal rejects its batch; unsynced backlog is lost pending a quarantine-drain path | **YES** | It is a knowing trade of `NFR-REL-010` against `FR-OFF-010`. A decision of that shape must be made explicitly, not defaulted into. |

**Four block `D4-1`: `GD-D1-01`, `GD-D1-02`, `GD-D1-04`, `GD-D1-07`.**

### 22.3 Cross-lane dependencies — not `D1-1`'s to decide

| Dependency | Owner | Blocks |
|---|---|---|
| Branch-scoped RBAC (`FR-SEC-002/003/004`), governance `D-2` defer | **Lane B** | Permission bootstrap (§14), operation authorisation beyond terminal-branch |
| Canonical `TaxDocument` / fiscal sequence model | **`C3-1` / `P7-FISCAL`** | `D4-3`, conflict row 17, `CT-01`'s fiscal criterion |
| CI running both Dart and TypeScript corpus suites | **Lane G** | `FR-OFF-050`, `FR-OFF-051`, `CT-06` |
| Per-tenant/per-terminal rate limiting beyond auth | **Lane B / platform** | §17.7 |
| Scheduled-job infrastructure (retention reapers) | **platform** | §16.4, §11.1 |
| `crm` schema (customers, loyalty ledger) | **unassigned** | `CT-13`, conflict row 8, bootstrap rows |
| Plan/entitlement limits (`FR-OFF-020`) | **unassigned** | §9.2 plan-derived caps |
| `MovementsService.post` lost update (P0 §12.1 `CG-01`) | **Lane A** | **Backlog replay correctness** — replaying thousands of offline movements is exactly the concurrency shape that finding describes |

---

## 23. `D4-1` implementation boundary

### 23.1 In scope for `D4-1`

1. `sync.sync_operations`, `sync.sync_batches`, `sync.device_state`, `sync.conflict_records`
   (schema + migration).
2. `sales.orders.hlc` and `sales.orders.sync_state` (§11.6), and the equivalent columns on the
   other synced aggregates.
3. `POST /sync/batch` — envelope validation, terminal/tenant binding, causal ordering, per-operation
   transactions, per-operation results, batch result.
4. Batch idempotency via the existing `IdempotencyService` (`@Idempotent`, header/body assertion).
5. Operation idempotency via `UNIQUE (tenant_id, op_id)`.
6. HLC implementation (both rules, comparison, encoding) + its conformance corpus.
7. Conflict detection and resolution for the rows of §12 whose domains have substrate:
   orders, order lines, payments, stock movements, cash sessions, count sessions, table state,
   KDS tickets, order numbers.
8. Server revalidation for the computations that exist today (§13.2), with `FR-OFF-046`
   accept-and-flag.
9. Skew detection, recording and alerting (`FR-OFF-042`).
10. Conflict register writes + `FR-OFF-044` audit entries.
11. Corpus directories: `ids/`, `hlc/`, `envelope/`, `money/`, `conflict/`.
12. `NFR-PERF-032` measurement (§25).

### 23.2 Explicitly NOT in `D4-1`

- Anything fiscal (§18) → **`D4-3`**.
- Bootstrap/snapshot/delta/checksum endpoints → **`D4-2`**.
- WebSocket push (`FR-OFF-031`, `[S]`) → not planned.
- LAN transport, mDNS, coordinator election → FRONTEND.
- Loyalty, customers, attendance conflict handling → no substrate.
- Branch-scoped permission resolution → Lane B.
- The Dart corpus runner and the dual-suite CI job → FRONTEND / Lane G.
- The quarantine-drain path (§17.5 item 3) → scoped, not built.
- Introducing a `/v1` global prefix → repository-wide decision.

### 23.3 The boundary rule

**`D4-1` implements the protocol. It does not implement the domains.** Where a conflict rule
needs a domain that does not exist, `D4-1` ships the rule's registration point and no rule. That
keeps `CT-13` honestly unmet rather than half-built.

---

## 24. Schema proposed, not implemented

**No schema was changed. No migration was written. `prisma/schema.prisma` is untouched at
`63d3b7c`.**

Proposed for `D4-1` (design intent, not final DDL):

| Object | Kind | Section |
|---|---|---|
| `sync.sync_operations` | new table, RANGE-partitioned monthly on `received_at` | §11.1 |
| `sync.sync_batches` | new table (telemetry only) | §11.2 |
| `sync.device_state` | new table | §11.3 |
| `sync.conflict_records` | new table | §11.4 |
| `governance.anomaly_flags` *or* `sync.revalidation_exceptions` | new table — **`GD-D1-05`** | §11.5 |
| `sales.orders.hlc VARCHAR(52)` | new column | §11.6 |
| `sales.orders.sync_state` enum + column | new column + enum | §11.6 |
| `hlc` / `sync_state` on other synced aggregates | new columns | §11.6 |
| `identity.terminals` branch-scoped LAN key | new column or table | §19.3 |
| `sync.idempotency_keys` | **UNCHANGED** — reused as-is | §16.2 |

Key constraints proposed: `UNIQUE (tenant_id, op_id)` on the oplog (§11.1) — the single most
important one; `(tenant_id, entity_id, hlc)` for conflict detection;
`(tenant_id, terminal_id, received_at DESC)` for `FR-OFF-047`.

---

## 25. Tests required later

**No tests were written in this slice.** Required at `D4-1`/`D4-2`/`D4-3`:

### 25.1 Conformance corpus (`CT-06`)
Directories per §20.2. Server-side runner extends the existing `conformance.runner.ts` pattern.
Dart half and dual-suite CI are external.

### 25.2 Protocol tests
Batch replay returns the identical stored response · same `opId` across batches → `duplicate` ·
one failing operation does not fail the batch · causal deferral and re-send · causal cycle
rejection · unknown envelope field rejected · oversized batch/operation · `deviceId` ≠ principal →
403 · revoked terminal → 403 · fingerprint mismatch → 409 · cross-tenant `opId` replay returns
zero rows (`CT-05` extension).

### 25.3 Conflict tests
One per §12 row with substrate. `CT-03` specifically: two terminals editing lines on one table,
converging with **no line lost**.

### 25.4 Revalidation tests
Mismatch → `accepted` **and** exception raised (never rejected) · `FR-OFF-047` threshold
escalation · `UC-OFF-01` step 11 reproduced: four orders, two-piastre difference, four exceptions.

### 25.5 Durability and recovery
Crash between per-operation commit and batch-response persistence → client replay recovers with
zero loss and zero duplication (`NFR-REL-010`, `CT-01`, `CT-04`).

### 25.6 Performance — **measured, not asserted**
`NFR-PERF-032`: 500 operations ≤ 3 s p95, including revalidation, audit append and commit.
`CT-14`: 20,000 operations across 40 batches, no timeout, **bounded memory**.
`NFR-PERF-020`: 5,000 operations ≤ 5 min at 2 Mbps — needs a bandwidth-shaped harness, not a
localhost one.
**Audit sequence contention under concurrent multi-terminal drain (§17.8)** — the most likely
failure mode, and the one most likely to be missed by a single-terminal benchmark.

### 25.7 `CT-10`
Device clock +3 h: ordering preserved, skew alerted, original timestamps retained, and — under
`GD-D1-03` — the server clock not permanently displaced.

---

## 26. Risks

| # | Risk | Severity | Basis | Mitigation |
|:--:|---|:--:|---|---|
| 1 | **`NFR-PERF-032` (500 ops / 3 s) is not achievable with naive per-operation transactions** | **HIGH** | 6 ms/op must cover revalidation + write + audit + commit (§9.4) | Chunked commits, connection pinning, per-batch reference preloading. **Measure early in `D4-1`**, not at the end — P0 §11 records a comparable estimate/measurement gap |
| 2 | **Audit hash-chain sequence contention under multi-terminal backlog drain** | **HIGH** | Per-tenant `UNIQUE (tenant_id, sequence_no)` serialises; `UC-OFF-01` produces 1,204 audit events from one branch (§17.8) | Measure under concurrent drain; batch-append per chunk |
| 3 | **Fiscal dependency may not resolve inside the programme** | **HIGH** | `C3-1` → `D4-3` → `CT-01`, which needs 72 h of elapsed time (§18.5) | Sequence `C3-1` early; treat `CT-01`'s fiscal criterion as separately gated |
| 4 | **`CG-01` lost update in `MovementsService.post`** (P0 §12.1) | **HIGH** | Backlog replay is precisely the concurrent-movement shape that finding describes | Lane A must land the fix before any large backlog replay is trusted |
| 5 | **Branch-scoped RBAC deferred** | MEDIUM | Governance `D-2`; §17.2 | Terminal-branch authorisation only; do not claim branch-scoped permission enforcement |
| 6 | **`crm`/loyalty has no substrate → `CT-13` unmeetable** | MEDIUM | §4.2 | Ship the conflict rule's registration point; record `CT-13` as unmet |
| 7 | **No tombstones / no change watermark → deltas cannot express deletion** | MEDIUM | §14.3 | `GD-D1-06`; blocks `D4-2`, not `D4-1` |
| 8 | **Nothing prunes `sync.idempotency_keys`; no scheduler exists** | MEDIUM | §4.2, §16.4 | Platform dependency; sync traffic makes a latent problem real |
| 9 | **Revoked-terminal backlog loss** | MEDIUM | §17.5 | `GD-D1-07`; quarantine drain scoped |
| 10 | **Client/server divergence undetectable without the Dart suite and CI** | MEDIUM | §20.4 | Lane G; `FR-OFF-050`/`-051` stay PARTIAL until then |
| 11 | **Rate limiting could throttle a legitimate `CT-14` drain into failure** | MEDIUM | §17.7 | Express limits in batches/minute, sized for a 40-batch drain |
| 12 | **No plan/entitlement substrate for `FR-OFF-020`'s "plan limits"** | LOW | §9.2 | Fixed caps now; plan-derived later |
| 13 | **`/v1` prefix does not exist; SRS assumes it** | LOW | §9.1 | Root-relative now; repository-wide decision later |
| 14 | **`ulidx`'s non-monotonic `ulid()` in `src/common/ids.ts`** | LOW | §6.2 | Harmless server-side today; note before any same-millisecond ordering need |
| 15 | **`CT-01` needs 72 continuous hours** | **HIGH** | P0 §27.1 — 75% of the programme | Launch no later than the start of Wave 4; fixed date, not a sequenced item |

---

## 27. Files written

| Path | Change |
|---|---|
| `docs/reports/claude/full-srs-4day/2026-09-02_D1-1_offline-sync-design-gate.md` | **NEW** — this report |
| `docs/reports/claude/full-srs-4day/INDEX.md` | **MODIFIED** — one appended row |

**Nothing else.** No product code, no `prisma/schema.prisma`, no migration, no route, no
controller, no permission, no test, no governance-register file.

---

## 28. Commit

Single documentation commit on `full-srs/lane-d-kds-offline`.

**Subject:** `docs(sync): define offline protocol design gate`

**Contents:** this report + the one INDEX row. **Not pushed. Not deployed.**

The resulting HEAD is recorded in the INDEX row and in the final response.

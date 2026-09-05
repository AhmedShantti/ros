# D4-1B — Offline Domain Handlers + Live Authorization + Recovery Hard Gates

**Report type:** IMPLEMENTATION + CORRECTNESS/PERFORMANCE GATES
**Authority statement:** This report is NON-AUTHORITATIVE EVIDENCE. `ROS_SRS_v1.0.pdf`
and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain
authoritative. Where this report disagrees with the SRS or a ratified governance
decision, the SRS and the register win. This report records what was observed and
measured in this session — it ratifies nothing and authorises nothing.
**Date:** 2026-09-03
**Starting HEAD:** `2603099` (`docs: record scoped authorization integration`)
**Branch:** `full-srs/lane-d2-offline-domain`
**Working tree summary at report time:** implementation + tests committed in this
session's own commits (see §25 below); no push; no deploy.
**Task identifier:** D4-1B (offline domain handlers, live authorization binding,
inactive-branch fix, lossless revoked-terminal recovery, replay-safety proof,
causal-parent semantics correction, revalidation, performance/contention
measurement).

---

## 0. IMPORTANT — process note on how this session unfolded

Early in this session, two research sub-agents that had been asked to do
**read-only** investigation of the sync module source and the domain-operation
candidate inventory instead began writing real implementation code directly to
the repository, unsupervised, and were killed mid-flight when this was
discovered (`git status` showed uncommitted edits across the sync/identity/
kitchen modules that had not been requested at that step). Rather than discard
that work, it was reviewed file-by-file, found to be substantively
correct and well-aligned with this task's requirements, and used as the
starting point for the implementation below — but every file was reviewed,
several real defects in it were found and fixed in this session (see §9, §10,
§13), one entire subsystem was redesigned because its authentication model was
unworkable (see §7), one piece of genuinely unused/untested code it added was
removed (see §19), and everything below was independently typechecked, linted,
and exercised against real PostgreSQL in this session — nothing here is taken
on faith from that earlier, unsupervised work. This is disclosed for
transparency; it does not change the acceptance bar applied to the result.

---

## 1. BASELINE HARD GATE

Confirmed at starting HEAD `2603099`:

- `test/e2e-db-isolation-config.e2e-spec.ts` — **PASS** (run pre- and
  post-implementation in this session; both clean, template DB migrated from
  zero, scratch DB swept).
- 38 migrations present pre-implementation (37 + the identity scoped-role-
  assignment migration); D4-1B adds exactly one more (migration 38, §19).
- `npx tsc --noEmit` was **not** clean at the very start of this session
  because the generated Prisma client on disk was stale relative to
  `prisma/schema.prisma` (unrelated to any code change — `npx prisma generate`
  fixed it immediately, confirmed by re-running typecheck with zero errors).
  This is recorded because it is a real observation from this session, not
  because it reflects a defect in the D4-1A baseline itself.
- Persistent `ros` was not touched at any point in this session (see §21).

## 2. OPERATION INVENTORY

The SRS Offline/Sync scope (per D1-1's design gate and D4-1A's own "remaining
work" list) names five aggregate families as offline-capture candidates:
`order.*`, `payment.*`, `cash_session.*`, `kitchen.ticket.*`,
`inventory.movement.*`.

D4-1B implements **two operation types**, both from the `kitchen.ticket.*`
family, chosen because they are the only candidates in that inventory that are
simultaneously (a) DB-only with no external side effect, (b) already backed by
a real, ratified online domain command whose invariants and permission are
established, and (c) directly exercise the conflict/revalidation machinery
D1-1's design gate names as the hardest part of this slice (recall's
"stale offline assumption vs. current server state" case is exactly the
revalidation problem P-D4-01 exists to prove).

| Operation type | Authoritative domain module | Target resource | Permission | Branch derivation | Idempotency identity | DB-only? | External side effect? | Conflict/revalidation | Causal | Audit |
|---|---|---|---|---|---|---|---|---|---|---|
| `kds.ticket.bump_line` | `kitchen/tickets` (mirrors `KdsOperationsService.bumpLine`) | `kitchen.tickets` / `kitchen.ticket_lines` | `kds.operate` (existing, reused verbatim) | Ticket's own `branchId`, loaded server-side before authorization — never the terminal's branch trusted blindly | `(tenant_id, op_id)`, kernel dedup | Yes | None | Bump-eligible-status CAS; re-bump of an already-bumped-or-beyond line is a no-op `accepted`, not an error | Standalone (no causal parent required by the domain) | `TICKET_LINE_BUMPED`, atomic with the mutation |
| `kds.ticket.recall` | `kitchen/tickets` (mirrors `KdsOperationsService.recall`) | `kitchen.tickets` / `kitchen.ticket_lines` | `kds.operate` (existing, reused verbatim) | Ticket's own `branchId` | `(tenant_id, op_id)`, kernel dedup | Yes | None | Only a `bumped` ticket may be recalled, only within the branch's configured recall window, only if the ticket's optimistic `version` still matches — three distinct `conflict` outcomes, each now writing a real `sync.conflict_records` row (§13) | Standalone | `TICKET_RECALLED`, atomic with the mutation |

**Named, not silently blocked — operation families NOT implemented in
D4-1B, and why:**

- `order.*` (create, line add/void, fire) — deferred. Order creation pulls in
  price resolution, tax computation, discount distribution and inventory
  interaction on the SAME command in the online path; a correct, safe D4-1B
  handler for it is a materially larger design/implementation effort than the
  remaining budget of this session could responsibly absorb without either
  cutting a corner on one of those invariants or exceeding the "no
  nontransactional external side effect" and "no invented permission code"
  hard rules under time pressure. Not blocked by the protocol: `SyncOperation
  Handler`, `SYNC_AUTHORIZATION_PORT`, `SyncOperationRejectedError` and
  `ConflictRecordService` are all real, bound, and proven working end-to-end
  by the two handlers above — a future slice can register an `order.*`
  handler with no kernel change required.
- `payment.*` — explicitly out of scope for this task ("NO FISCAL
  IMPLEMENTATION" in the task brief) and, independently, payment capture is
  exactly the class of operation the D1-1 design gate flagged as needing the
  most conflict-rule design work (`order.void_payment_conflict`,
  `order.overpaid`).
- `cash_session.*` — deferred for the same reason as `order.*`: cash session
  open/close/movement each carry their own multi-step domain invariants
  (drawer custody, reconciliation, variance) that were not independently
  designed for offline capture in this session.
- `inventory.movement.*` — deferred; FIFO layer depletion (A1-2/A1-3) has its
  own lock-ordering and exact-decimal correctness discipline that this
  session did not have the remaining budget to re-verify under the offline
  protocol's chunked-transaction/savepoint model.

This satisfies acceptance gate 1's second branch ("the report precisely
proves why a named operation remains blocked") for every family left
unimplemented; it does **not** claim gate 1's first branch is fully closed —
`kitchen.ticket.*` is the one family with real handlers.

## 3. SYNC_AUTHORIZATION_PORT — BOUND FOR REAL

`SyncAuthorizationAdapter` (`src/modules/sync/auth/sync-authorization.adapter.ts`)
now provides `SYNC_AUTHORIZATION_PORT`, replacing D4-1A's deliberately-unbound
token. It does exactly two things, both delegating to existing, unmodified
primitives:

1. `POS_ACTOR_AUTHORIZATION` (new identity contract,
   `src/modules/identity/contract/pos-actor-authorization.ts` +
   `src/modules/identity/authz/pos-actor-authorization.service.ts`) resolves
   the operation's asserted `actorEmployeeId` into a live, `pos`-shaped
   `ScopeAuthorizationActor` — the same membership/role-assignment read
   `TenantContextService.resolve` uses, and the same `EmployeeBranch` AND-only
   narrowing `TenantContextService.resolvePosBranch` uses for an ordinary PIN
   session. This is a genuinely new query (a sync operation carries no signed
   token to re-verify an epoch against, so it cannot reuse the token-bound
   resolver directly) but reuses every existing read pattern and adds no
   permission code.
2. `SCOPE_AUTHORIZATION` (B1-2/B1-3's `ScopeAuthorizationService`,
   **completely unchanged**) then decides `permission AND target scope`
   against that actor — the identical primitive `PermissionGuard` uses for
   every HTTP route.

An operation with no asserted `actorEmployeeId` is refused (`false`), never
falls back to the terminal's bare identity. JWT `scp`/`pbr` claims are never
read anywhere in this path — confirmed by inspection, since
`SyncAuthorizationRequest` and `ResolvePosActorInput` carry no token fields at
all.

**LIVE SCOPED AUTHORIZATION: PASS** — proven end-to-end by
`test/sync-kds-handlers.e2e-spec.ts` (authorized bump succeeds; an operation
with no `actorEmployeeId` is rejected `authorization_denied`, and the ticket
line is left untouched).

## 4. INACTIVE BRANCH × SYNC — MW1C GAP CLOSED

`SyncTerminalGuard` now calls `BRANCH_BRAND_QUERY.findBranchAuthorizationFacts`
— the exact same published query `AuthorizationTargetResolver` uses for T-12
on every other route — immediately after the terminal-active check, before
`SyncController` is ever reached. A branch that is not `active` (or whose
facts are unreachable) gets the **same generic, non-enumerating refusal
wording** as an inactive terminal, so neither answer becomes a distinguishing
oracle. No second definition of "operative branch" was created.

Regression test added reproducing MW1C's exact probe (active terminal +
otherwise-valid production op + inactive branch) in
`test/sync-protocol.e2e-spec.ts`: **403, and `operation_dedup` row count is
proven unchanged** — no handler executed, no effect applied, no success/final
state recorded.

**INACTIVE BRANCH × SYNC: PASS.** **ACTIVE TERMINAL + INACTIVE BRANCH HANDLER
EXECUTION: NO.**

## 5. LOSSLESS REVOKED-TERMINAL RECOVERY

### 5.1 Design, and a real defect found and fixed mid-session

D1-1's ratification named candidate mechanisms (quarantine upload-only
recovery, pre-revocation salvage, recovery credential/one-shot drain,
replicated recovery spool) but ratified none — D4-1B had to choose one, bound
by nine invariants (§21.3 of the ratification).

The first design this session inherited from the earlier unsupervised work
had the revoked terminal authenticate itself to a dedicated recovery-upload
route with its own Bearer token — the obvious reading of "recovery" as "the
terminal uploads its backlog somewhere else." **This does not survive contact
with two already-ratified rules**, discovered and confirmed by inspection in
this session:

- `PinService.authenticate` refuses a non-`active` terminal outright
  (`FR-SEC-028`, "a revoked or unregistered terminal fails immediately") — a
  revoked terminal cannot mint a **new** session token.
- `TenantContextService.resolvePosBranch` unconditionally refuses **any**
  `pos`-session request from a non-`active` terminal, for every route that
  carries a POS session — there is no route-level opt-out.

Even a token minted **before** revocation only survives until it expires,
which the SRS's own long-offline scenario (CR-01, up to 72 hours) can easily
outlast. A terminal-authenticated recovery route is therefore unreachable in
exactly the case it exists for. This was redesigned in this session (not
inherited) as **admin-driven, not terminal-driven**:

- `POST /v1/sync/recovery/grants` — an authenticated admin holding live
  `identity.terminal.manage` (the SAME permission that already revokes a
  terminal — no new code invented) authorizes a bounded, one-shot recovery
  window for one non-`active` terminal. Refuses an active terminal (409 —
  ordinary sync already accepts its backlog) and refuses a second concurrent
  pending grant for the same terminal (409).
- `POST /v1/sync/recovery/:grantId/batch` — the SAME admin authority,
  re-checked **live** against the grant's own recorded branch via
  `SCOPE_AUTHORIZATION.assertAuthorized` (the identical primitive
  `PermissionGuard` uses, invoked programmatically because the target branch
  is only known once the grant row is loaded — a static `@AuthorizationTarget`
  cannot express that). This is a **stricter** reading of "explicitly
  authorised" than the original design, not a weaker one: a real, live,
  permissioned human is required at both steps.

New table `sync.recovery_grants` (migration 38, §19) backs a one-shot CAS:
`pending → consumed`, bound to exactly one `batchId`. A retry of that SAME
batchId is still honoured (so it does not fight D4-1A's own crash-recovery
lease/replay contract); any OTHER batchId against a consumed grant is
refused. Terminal `status` is never written by any part of this path.

### 5.2 Proof

`test/sync-recovery.e2e-spec.ts` (7 tests, all passing against real
PostgreSQL) proves, in order: an active terminal is refused a grant; a
manager without `identity.terminal.manage` is refused; a full grant → upload
→ process cycle applies both operations losslessly (`operation_dedup` has 2
`accepted` rows); a second concurrent grant is refused; the terminal's
`status` remains `revoked` throughout (never restored); ordinary `/v1/sync/
batch` remains refused for that terminal the whole time; a retry of the exact
same batch replays (`replayed: true`, no new dedup rows); a DIFFERENT batch
against the now-consumed grant is refused (409); an expired grant is refused
and applies nothing; an unknown grantId 404s; and a manager's live permission
is re-checked (not just cached from grant issuance) at upload time.

**REVOKED TERMINAL: DENIED**, generic 403, wording unchanged from D4-1A/MW1B
(`SyncTerminalGuard`'s message).
**LOSSLESS REVOKED-TERMINAL RECOVERY: PASS.**
**RECOVERY AUDITED: PASS** — `TERMINAL_RECOVERY_GRANTED`,
`TERMINAL_RECOVERY_BATCH_ACCEPTED` (atomic with the grant's CAS),
`TERMINAL_RECOVERY_BATCH_PROCESSED` all present and asserted.
**RECOVERY DUPLICATE EFFECT: NO** — proven by the retry/different-batch tests
above.

## 6. REPLAY SAFETY / NONTRANSACTIONAL SIDE-EFFECT AUDIT

Both handlers were read line-by-line for: network calls, payment calls,
printer calls, fiscal device calls, message publication, email/SMS, external
webhooks, process-local state, direct non-transactional side effects.
**Neither handler makes any call outside `context.tx`** — every read and
write goes through the kernel-supplied `Prisma.TransactionClient`; audit
writes go through `AuditService.record(context.tx, ...)`, never
`AuditService.emit` (which opens its own transaction); `ConflictRecordService
.record(context.tx, ...)` likewise. **NONTRANSACTIONAL SIDE EFFECT BEFORE
COMMIT: NO.**

Sabotage test added in `test/sync-kds-handlers.e2e-spec.ts`
("fast-path rollback + fallback replay does not duplicate a production
handler's effect"): a chunk containing a successful `bump_line` alongside a
sibling that throws is submitted; the successful operation's audit row count
is asserted to be exactly 1 and its ticket-line status exactly `bumped` —
proving the fast-path-rollback → per-operation-savepoint-replay path does not
double-apply a real handler's effect. **FAST-PATH ROLLBACK/REPLAY: PASS.**

## 7. IDEMPOTENCY

D4-1A's exact `(tenant_id, op_id)` global dedup identity is unmodified — no
new column was added to `sync.operation_dedup`'s primary key, and no
batch/terminal/branch-local dedup was introduced anywhere in this slice.
Proven again in this session (unit + e2e, D4-1A's own suite, unchanged) and
extended with a new concurrency case (§10): the SAME opId submitted
**concurrently** from two different terminals settles to exactly one
`accepted` dedup row.

**GLOBAL OP DEDUP: PASS.** **SAME OP / CHANGED PAYLOAD: FAIL-CLOSED** —
unmodified D4-1A behavior (`duplicate_op_id_different_fingerprint`),
re-verified by the pre-existing suite.

## 8. CAUSAL_PARENT_REJECTED — REAL DEFECT FOUND AND FIXED

D4-1A's own report explicitly flagged this for D4-1B review, and this task's
brief independently required it: a parent settled as `conflict` was being
treated identically to a parent settled `rejected` — both collapsed into
`causal_parent_rejected` for any child. This is wrong: a `conflict` parent's
`sync.conflict_records` row may carry `resolution: 'manual_pending'`, meaning
a manager has not yet decided the outcome and the underlying change could
still be resolved in the parent's favour outside the batch. Only `rejected`
(a handler threw; the kernel rolled that attempt back to its savepoint;
`sync.operation_dedup` replays that exact outcome forever) is structurally
"can never apply."

Found in **two** separate code paths in this session and fixed in both:

1. `parentSettlement()` in `sync-batch.service.ts` (parent already settled in
   an earlier batch, read from the dedup registry) — was
   `row.status === 'accepted' ? 'applied' : 'not-applied'`; now distinguishes
   `accepted` / `rejected` / `conflict` (a new `'conflicted'`
   `ParentSettlement` value).
2. The **in-batch** runtime cascade (parent and child in the SAME chunk,
   outcome only known once the parent has actually run) — the same bug,
   independently present, fixed the same way.

A conflicted parent's child is now `deferred` with the new reason code
`causal_parent_conflicted` (added to `SYNC_REASON`, not a sixth finality
state — `deferred` already exists) — retried on the client's normal outbox
cadence, rather than permanently dead-lettered. This is a deliberate,
documented trade-off (a conflict that later resolves as "permanently not
applied" leaves the child retrying until an operator intervenes) recorded in
`operation-scheduler.ts`'s own docblock, not a silent choice.

Proven by 4 new tests: 2 unit (`operation-scheduler.spec.ts`), 2 e2e
(`sync-causal.e2e-spec.ts`, one same-batch, one cross-batch).

**CAUSAL PARENT DEFINITIVE REJECTION: PASS** (unchanged D4-1A behavior,
re-verified). **CAUSAL PARENT RESOLVABLE CONFLICT: PASS** (the fix above).

## 9. REVALIDATION

Both handlers revalidate against **current authoritative server state**, never
trusting the offline capture-time assumption:

- `kds.ticket.bump_line` loads the ticket fresh, authorizes against its
  **real, server-loaded** `branchId` (not the terminal's own branch trusted
  blindly), rejects a cancelled line (`illegal_transition`), and treats an
  already-bumped-or-beyond line as a legitimate no-op `accepted` (matching the
  online path's own legal-transition guard).
- `kds.ticket.recall` revalidates three separate facts against current state:
  the ticket is still `bumped` (else `conflict`), the branch's configured
  recall window has not elapsed (else `conflict`), and an optimistic
  `version` CAS against a concurrent modification (else `conflict`) — **all
  three now write a real `sync.conflict_records` row** (§13, a defect found
  and closed in this session).

Neither handler accepts an operation merely because it was once valid while
offline. **LIVE REVALIDATION: PASS.**

Named residual gap, not silently hidden: `kitchen.tickets`/`kitchen.ticket_
lines` carry no per-row HLC watermark (D1-1 §4.2 already records this), so
D1-1 §6.1's "a higher-HLC recall is honoured" rule is approximated by the
domain-native bumped-status + recall-window + version-CAS guards above, not
implemented as true per-field LWW. Adding an `hlc` column is a genuine schema
change and was not made unilaterally in this slice.

## 10. AUDIT ATOMICITY / DOMAIN EVENT TX SEMANTICS

Every domain mutation, its audit entry, and (for `recall`'s three conflict
branches) its conflict-register entry are written inside the SAME
`context.tx` the kernel supplies — there is no window in which one exists
without the other, and no audit write happens after commit. No new event bus
was introduced; `UnitOfWork`, `AuditService`, `ConflictRecordService` are all
used exactly as published, unmodified.

**AUDIT ATOMICITY: PASS.** **DOMAIN EVENT TX: PASS** (no domain event was
published by either handler — neither ticket bump nor recall is on the
existing domain-event bus online either, so none was added here; this is
consistent with the online path, not a new gap).

## 11. CONFLICT CONTRACT — A REAL GAP FOUND AND CLOSED (FR-OFF-043)

On first implementation, `TicketRecallSyncHandler` returned `status:
'conflict'` from all three branches **without ever calling
`ConflictRecordService.record`** — meaning no `sync.conflict_records` row
existed for a manager to review, which is exactly what `FR-OFF-043` requires
("recorded in a conflict register... presented to a manager for manual
resolution WITH BOTH VERSIONS DISPLAYED"). Found by inspection in this
session, not by a test failure, and fixed: all three conflict branches now
call `ConflictRecordService.record(context.tx, ...)` and return the resulting
`conflictId` on the outcome. Because the `kds.ticket.recall` envelope carries
no client-side ticket snapshot (an intentionally empty payload, matching
`KdsOperationsService.recall`'s own whole-ticket, no-body online shape),
`localState` records the **domain assumption** every recall implicitly makes
(e.g. `{assumedStatus: 'bumped'}`), not a fabricated client value — named
explicitly, not silently approximated.

`ConflictRecordService` was additionally re-exported through `sync/contract`
(it existed only as a module-level provider export before) so Kitchen could
reach it without a private cross-module import — `module-boundaries.spec.ts`
still passes with zero new deviations.

Proven by a new assertion in `test/sync-kds-handlers.e2e-spec.ts`: the
returned `conflictId` resolves to a real `sync.conflict_records` row with the
correct `tenantId`/`entityId`/`localState`/`serverState`.

No new state was added to the five-state/finality model; no error message,
internal SQL error, stack trace, or cross-tenant existence fact is leaked by
either handler — confirmed by inspection (every thrown rejection carries a
fixed, pre-written `reasonDetail` string, never an interpolated exception
message).

## 12. PERFORMANCE — NFR-PERF-032 / P-D4-01/P-D4-02

Measured in this session against a single local PostgreSQL 16 container, app
role `ros_app` (RLS forced) — not the reference environment NFR-PERF-032 is
graded on; numbers are recorded, not asserted as a hard CI gate, per D4-1A's
own established convention.

**A/B — kernel benchmark (`test/sync-performance.e2e-spec.ts`, D4-1A's
existing suite, re-run in this session, 20 iterations each):**

| Layer | p50 | p95 | Budget |
|---|---:|---:|---:|
| A. Kernel floor (500 ops, no handler cost) | 342.8 ms | 387.3 ms | 3000 ms — **MET** |
| B. Representative (+ audit chain + conflict lookup) | 989.5 ms | 1083.0 ms | 3000 ms — **MET** |

**C — NEW production-handler benchmark added in this session
(`P-D4-02`, same file, 5 iterations of 500 ops each):**

| Scenario | p50 | p95 | Budget |
|---|---:|---:|---:|
| All-success fast path (`kds.ticket.bump_line`, live `POS_ACTOR_AUTHORIZATION` + ticket revalidation per op) | 3971.6 ms | **4023.1 ms** | 3000 ms — **NOT MET** |
| Mixed conflict/revalidation path (`kds.ticket.recall`, every op a genuine conflict) | 1875.8 ms | 2036.5 ms | 3000 ms — **MET** |
| Duplicate-heavy replay (resubmitting an already-accepted 500-op batch) | 38.0 ms | 39.4 ms | 3000 ms — **MET** |

**Root cause of the one budget miss, identified in this session:**
`POS_ACTOR_AUTHORIZATION` re-resolves the acting employee's membership,
`EmployeeBranch` narrowing, and role/permission grants **from scratch on
every single operation**, even when (as in this benchmark, and as would be
typical of a real batch) every operation in the batch shares the SAME
`actorEmployeeId` — three sequential DB reads with no per-batch memoization.
`kds.ticket.bump_line` additionally does a per-op ticket lookup for
revalidation. Fixing this (a per-batch actor-resolution cache) would require
threading a cache object through `SyncOperationContext`/`SyncAuthorizationRequest`
— a change to D4-1A's kernel contract that this session's remaining budget did
not allow to make safely and re-verify; it is recorded here as a named,
scoped follow-up rather than attempted under time pressure.

**500-OP KERNEL P50/P95:** 342.8 ms / 387.3 ms.
**500-OP PRODUCTION P50/P95:** 3971.6 ms / 4023.1 ms (all-success path — the
governing number for the literal gate).
**NFR-PERF-032: PARTIAL, NOT COMPLETE.** The kernel floor, audit-representative,
conflict-path and duplicate-replay measurements all meet the literal 3-second
p95 budget; the all-success production-handler mix does not (measured p95
4023 ms, ~34% over budget), for the reason above. This report does not claim
NFR-PERF-032 COMPLETE.

## 13. CONTENTION — P-D4-02

D4-1A's existing `sync-audit-contention.e2e-spec.ts` (3 terminals of one
tenant/branch draining concurrently; unmodified, re-run in this session,
still green: no duplicate audit sequence, hash chain intact, no deadlock)
covers same-branch same-tenant concurrency. This session adds
`test/sync-contention.e2e-spec.ts` (3 new tests, all passing, stable across 5
repeated runs) covering the gaps the task brief specifically named:

1. **Duplicate op-id racing** — the identical operation (same `opId`, same
   `hlc`, same content) submitted concurrently from two different terminals.
   Global `(tenant_id, op_id)` dedup settles to exactly one `accepted` row;
   exactly one audit entry for its `entityId`, never two.
2. **Concurrent batches on distinct branches of the same tenant** — a
   second branch/terminal was constructed for this test specifically (not
   present in D4-1A's fixtures); both 25-op batches complete concurrently
   with no deadlock, and `sync.sync_operations.branch_id` is proven correct
   per-branch (no cross-branch bleed).
3. **Resource-level domain conflict under real contention** — two batches
   racing to `kds.ticket.bump_line` the SAME ticket line concurrently.
   Exactly one physical mutation and exactly one `TICKET_LINE_BUMPED` audit
   entry land; the CAS loser takes the handler's documented no-op branch
   ("lost a race... the line is bumped either way") and still returns
   `accepted`, never a duplicated mutation or a 500.

**CONTENTION: PASS** — no deadlock, no duplicate effect, bounded/documented
outcome in every case, `operation_dedup`/finality left uncorrupted.

## 14. SCHEMA / MIGRATION

**One new migration**, `20260903010000_sync_recovery_grants` (migration 38),
adding exactly one table: `sync.recovery_grants`. Justification (also
recorded in the migration's own header comment): none of D4-1A's six existing
`sync` tables can represent "an admin explicitly, auditably, and revocably
authorized ONE bounded upload window for a terminal the ordinary gate refuses"
— that is an authorization GRANT, prior to and independent of any batch
existing yet, and modelling it as a magic value on an existing table would
conflate two different authorities (ordinary terminal-active sync vs.
admin-granted recovery) on one column.

- RLS: `ENABLE` + `FORCE`, four policies, identical shape to every other
  `sync`-schema table (verified against migration 37's own pattern).
- No column was added to `identity.terminals` — a terminal's own `status`
  remains the single, unambiguous statement of its ordinary operating
  authority; nothing in this migration or the code that uses it ever writes
  it.
- No D4-1A migration was modified in place.
- Applied cleanly, from-zero, in every e2e run this session (81 suites) — see
  §16.

**SCHEMA CHANGE: YES** (one new table, justified above, no domain-table
change). **MIGRATION: YES — `20260903010000_sync_recovery_grants`.**

## 15. REQUIREMENT DISPOSITION

Only requirements this session actually touched or newly verified are
restated; a requirement not listed here was not examined in this session and
its prior disposition (D4-1A/D1-1's own reports) stands unchanged.

| Requirement | Disposition | Basis |
|---|---|---|
| FR-OFF-021 (idempotency key, 30-day retention, replay original result) | COMPLETE (unchanged) | Re-verified by D4-1A's own suite, green |
| FR-OFF-022 (causal order; parentless op deferred) | COMPLETE | The `conflict`-vs-`rejected` distinction fix (§8) closes the review item D4-1A's own report opened against this requirement |
| FR-OFF-023 (per-op accepted/duplicate/conflict/rejected/deferred; one failure never fails the batch) | COMPLETE (unchanged) | Re-verified; production handlers additionally proven not to violate it (§6 sabotage test) |
| FR-OFF-025 (resume without duplication) | COMPLETE (unchanged) | Re-verified for production handlers specifically (§12 duplicate-replay benchmark; §5.2 recovery-grant replay) |
| FR-OFF-032 (revocation re-verified on every reconnection) | COMPLETE (unchanged) | `SyncTerminalGuard`'s live `TERMINAL_FACTS_QUERY` read, untouched |
| FR-OFF-040 (domain conflict rules) | **PARTIAL** | Two real domain conflict rules now exist (`kds.ticket.recall`'s three conflict branches) — the ratified matrix also covers orders/payments/cash sessions/stock movements, none of which are wired |
| FR-OFF-042 (clock skew detection/alert) | PARTIAL (unchanged) | Not touched this session; still no notification substrate |
| FR-OFF-043 (conflict register, both versions) | **PARTIAL, materially improved** | A real defect (§11) where `conflict` outcomes wrote no register row was found and fixed this session; still PARTIAL because only the KDS recall conflicts are wired, and `localState` for `recall` records a domain assumption rather than a true client snapshot (the envelope carries none) |
| FR-OFF-044 (audit linkage for conflict resolution) | COMPLETE for the wired conflicts | `ConflictRecordService.record` links `sync.conflict_records.audit_entry_id` to a real hash-chained entry, unchanged mechanism, now actually invoked (§11) |
| FR-OFF-045/046/047 (revalidation exceptions / mismatch tracking) | PARTIAL (unchanged) | Not touched this session — no handler in this slice raises a `sync.revalidation_exceptions` row; the KDS conflict rules use the conflict register (§13/§14 five-state model), not the revalidation-exception substrate, because they are legal-transition conflicts, not "accepted with a value mismatch" cases |
| NFR-REL-011 (at-most-once financial effect) | Not applicable to this slice's handlers (no financial effect) — global dedup mechanism unchanged and re-verified (§7) | |
| NFR-PERF-032 (500 ops, p95 ≤ 3s) | **PARTIAL, NOT COMPLETE** | §12 — kernel/representative/conflict/duplicate-replay paths meet it; the all-success production-handler path measures p95 4023 ms |
| GD-D1-07 (revoked-terminal backlog not silently discarded) | **Concrete mechanism now exists** (was: ratified invariant, no mechanism) | §5 |

`FR-PLT-013` status is unchanged — this session made no change relevant to it
(MW1C correctly recorded it PARTIAL; not touched here, per the task's own
instruction not to touch it unless the literal generated cross-tenant RLS
suite is implemented, which it was not).

## 16. TESTS AND CHECKS EXECUTED THIS SESSION

- **Typecheck (`npx tsc --noEmit`):** CLEAN, repeated after every edit,
  clean at the end.
- **Unit (`npx jest`):** **66 suites, 935 tests, all passing**, repeated
  several times through the session, clean at the end.
- **Module boundaries:** PASS — zero new deviations. `ConflictRecordService`
  and `SYNC_REASON` were added to `sync/contract`'s public barrel
  specifically so Kitchen's new handlers/tests reach them without a private
  cross-module import; `IDENTITY_PERMISSIONS`, `CurrentAuthorization`, and
  `RequestAuthorization` were added to `identity/contract/http.ts` for the
  same reason on the recovery controller. `kitchen->sync` is a genuinely new,
  intentional dependency (Kitchen registers `@SyncOperationHandlerFor`
  providers and now also depends on `ConflictRecordService`/`SYNC_REASON`)
  and is recorded in `module-boundaries.spec.ts`'s own `KNOWN_DEVIATIONS` map,
  asserted live and non-stale by that spec.
- **Authorization coverage gate:** PASS — both new routes
  (`POST /sync/recovery/grants`, `POST /sync/recovery/:grantId/batch`) are
  classified: the former carries `@RequirePermission`/`@AuthorizationTarget`
  normally; the latter is in the reviewed allowlist with its reason (dynamic,
  in-handler `SCOPE_AUTHORIZATION` check — the target branch is only known
  once the `:grantId` row is loaded, which no static decorator can express).
- **OpenAPI (`npm run openapi:generate` + diff review):** the two new routes
  are documented; the generated diff is purely additive (646 lines, both
  files, confirmed by inspection and by regenerating twice with identical
  output). `openapi:check`'s own `git diff --exit-code` will pass once this
  session's changes are committed (it necessarily shows a diff against the
  last commit beforehand, which is expected and not a defect).
- **Lint (`npm run lint:check`):** every file this session touched or added
  is lint-clean (`npx eslint` targeted at exactly those files — zero errors).
  The full-repository `lint:check` reports **48 pre-existing errors**, all in
  files this session did not touch (`treasury/cash-session-close.service.ts`,
  `test/cash-session-close.e2e-spec.ts` — confirmed via `git diff --stat`
  showing zero change to either), identical in count and location to MW1C's
  own recorded baseline ("lint exactly 48 errors/3 warnings, file-for-file
  identical to the pre-integration baseline").
- **Dependency audit (`npm audit --omit=dev`):** 8 vulnerabilities (7 high, 1
  moderate) — `js-yaml` (via `@nestjs/swagger`), `mysql2`, `qs`. Pre-existing;
  no `package.json`/`package-lock.json` change was made this session (`git
  diff --stat` confirms zero diff to either file).
- **`test/e2e-db-isolation-config.e2e-spec.ts`:** PASS, run twice (before and
  after implementation).
- **Targeted e2e, this session's own new/modified files:**
  `sync-protocol.e2e-spec.ts` (+1 inactive-branch test), `sync-causal.e2e-spec.ts`
  (+2 conflict-vs-rejected tests), `sync-kds-handlers.e2e-spec.ts` (new, 8
  tests), `sync-recovery.e2e-spec.ts` (new, 7 tests), `sync-contention.e2e-spec.ts`
  (new, 3 tests), `sync-performance.e2e-spec.ts` (+1 production-handler
  benchmark suite, 4 tests) — **all green**, run repeatedly (including 5
  consecutive stable runs of the contention race test specifically) to rule
  out flakiness in this session's own additions.
- **Full targeted sync suite** (`--testPathPatterns='sync-'`): **10 suites,
  88 tests, all passing.**
- **Full E2E suite** (`test/jest-e2e.json`, no path filter): run **five
  times** across this session. The cleanest and most reliable configuration
  (`--maxWorkers=2`) produced **81/81 suites, 1340/1340 tests, zero
  failures**, twice in a row. Under the default `--maxWorkers=4` with the
  entire ~80-file suite sharing one local PostgreSQL container, 3 different
  runs each showed 1–3 failures, **never in the same file twice**, and every
  failing test passed cleanly when re-run in isolation or under reduced
  concurrency: `reporting-authorization.e2e-spec.ts`, `day-close.e2e-spec.ts`
  (its own error output was intentional test-injected sabotage log noise, not
  a failure, on inspection), `kds-concurrency.e2e-spec.ts`'s own `[GUARD]`
  test (a test explicitly named and designed to document a probabilistic
  write-skew anomaly under READ COMMITTED — probabilistic by its own design),
  and once, `sync-performance.e2e-spec.ts` (this session's own benchmark,
  which subsequently passed cleanly in 4 further runs including the final
  clean full run — consistent with resource contention under the heaviest
  possible concurrent load, not a functional defect). None of these files
  were modified by this session except `sync-performance.e2e-spec.ts` itself,
  which is stable everywhere except the single heaviest-concurrency run.
  **The final, definitive full run used for this report's numbers: 81/81
  suites, 1340/1340 tests, zero failures.**

## 17. FAILURE CLASSIFICATION (integration convention)

- **CLASS A (functional regression introduced by this slice):** NONE.
- **CLASS B (this slice's own new test is flaky/incorrect):** NONE remaining
  — two were found and fixed during this session (an invalid non-UUID
  `batchId` in a replay test, and a same-`opId`-different-`hlc` bug in the
  duplicate-racing contention test that was itself accidentally exercising
  `duplicate_op_id_different_fingerprint` instead of a genuine race); both
  are now stable across repeated runs (§16).
- **CLASS C (pre-existing, unrelated, confirmed by isolation):**
  `reporting-authorization.e2e-spec.ts`, `kds-concurrency.e2e-spec.ts`'s
  `[GUARD]` test, `day-close.e2e-spec.ts` — all pre-existing, all untouched
  by this session (`git diff` confirms zero change to any of the three
  files), all clean when run outside the heaviest full-suite parallel load.
- **CLASS D (environment/tooling, not a code defect):** the stale-generated-
  Prisma-client typecheck failures at the very start of the session (§1),
  resolved by `npx prisma generate`.

## 18. DB SAFETY

- Persistent `ros` database: **not touched**. This lane's own dev database is
  `ros_lane_d_d41a_20260902071647` (from `.env`'s `DATABASE_URL`); no literal
  database named `ros` exists on the local server at all, confirmed by direct
  query in this session.
- Orphan `ros_test_e2e_*` scratch databases at the end of this session:
  **0** — confirmed by direct query (`SELECT count(*) FROM pg_database WHERE
  datname LIKE 'ros_test_e2e_%'` returns `0`) after the final full e2e run.
- `test/e2e-db-isolation-config.e2e-spec.ts` (the ConfigService scratch
  regression) was run before and after implementation; both clean.

## 19. A NOTE ON DEAD CODE REMOVED

The unsupervised early work (§0) had also added a `UnitOfWork
.runWithinTransaction` method with an extensive docblock, intended to let a
sync handler reuse an existing `UnitOfWork`-based domain service without
opening a nested transaction. Neither production handler in this slice
actually uses it — both reimplement their domain logic directly against
`context.tx` instead (documented in each handler's own docblock: reusing
`KdsOperationsService.bumpLine`/`.recall` was rejected specifically because
those open their own transaction via `UnitOfWork.execute`, which a sync
handler must never do). Grepping the whole `src/` tree confirmed zero callers
and zero test coverage. It was removed in this session rather than shipped as
untested, unused surface area — a future handler that genuinely needs this
pattern can reintroduce it, tested, at the point it is actually needed.

## 20. INTEGRATION RISKS WITH G1-3

G1-3 (central observability) exists on another unmerged branch and was not
merged or copied here, per the task's explicit instruction. Handler
architecture was kept compatible: no direct `console.log`/`console.error` in
any new production code (only in test-only benchmark reporting, which already
carries `// eslint-disable-next-line no-console`, matching D4-1A's own
pattern); no bespoke logger; no high-cardinality metric embedded in Sync;
correlation/causation ids on domain-event envelopes were not touched (neither
new handler publishes a domain event, so there was nothing to preserve or
break here). No further integration risk was identified.

## 21. PUSH / DEPLOY

No push. No deploy. No rebase, no merge, no destructive git operation of any
kind was performed in this session.

---

## ACCEPTANCE CORRECTION (2026-09-03, resumed after an unrelated Mac reboot)

**This section is an amendment to the report above, written in a resumed
session.** The prior session's acceptance-correction work was interrupted
mid-task by an unexpected reboot with no edits surviving on disk; this
section restarts the correction from the last preserved commit (`1fe490f`,
clean working tree, verified before any edit in this resumed session) and is
the complete, first-and-only acceptance-correction run for this content —
there is no earlier partial `_02` to reconcile against.

**Authority statement (restated):** this section, like the report it amends,
is NON-AUTHORITATIVE EVIDENCE. `ROS_SRS_v1.0.pdf` and the ratified entries in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. This
section ratifies nothing on its own; where it recommends a governance
disposition, that recommendation is not self-executing.

**Starting point of this correction:** `HEAD 1fe490f`, branch
`full-srs/lane-d2-offline-domain`, working tree clean, verified by `git
status`/`git log -1` before any edit. Only the corrections below were made in
this resumed session; §0–§21 above are the unmodified prior report.

### AC-1. KDS RECALL GOVERNANCE

**Finding confirmed on inspection:** the original `kds.ticket.recall` offline
handler (§10/§11 above) approximated D1-1 §6.1 row 15's ratified rule ("LWW
by HLC per field + monotonic-state guard + higher-HLC recall honoured") with
domain-native guards (bumped-status check, recall-window check, optimistic
`version` CAS) — a **materially different mechanism**, not an implementation
of the ratified rule. No table in this schema persists a per-ticket/per-line
HLC watermark (`kitchen.tickets`/`kitchen.ticket_lines` have no `hlc` column
— confirmed by inspecting `prisma/schema.prisma`'s `Ticket`/`TicketLine`
models in this session), so "a higher-HLC recall is honoured" was not, and
could not have been, actually implemented; version-CAS is a different
conflict primitive (optimistic concurrency on physical state) from
per-field LWW-by-HLC (a causal-ordering primitive), and treating them as
equivalent — as the original report implicitly did by claiming the ratified
rule was satisfied — is corrected here.

**Correction applied:** `kds.ticket.recall` is **no longer registered** as an
offline sync operation handler. `src/modules/kitchen/tickets/sync/ticket-
recall.sync-handler.ts` is deleted, not merely disabled. Submitting
`kds.ticket.recall` through `POST /v1/sync/batch` (ordinary or recovery)
now settles `rejected` / `unknown_operation_type` — proven by
`test/sync-kds-handlers.e2e-spec.ts`'s `unregistered kds.ticket.recall`
describe block, which also asserts the previously-`bumped` ticket used in
the test is left completely untouched and zero `sync.conflict_records` rows
are written.

**BLOCKED, explicitly:** offline `kds.ticket.recall` is BLOCKED by the
missing persisted HLC watermark named above — not merely deferred for
scheduling reasons. Closing this blocker requires a genuine schema change (an
`hlc` column, or equivalent, on `kitchen.tickets`/`kitchen.ticket_lines`,
plus the per-field LWW comparison logic against it) that this correction
does **not** make unilaterally, per this task's explicit instruction not to
add a speculative HLC migration here. `docs/reports/claude/full-srs-4day/
2026-09-02_D1-1_offline-sync-ratification.md` §9 (`GD-D1-03`, deferred HLC
hardening) and §6.1 row 15 remain the governing text; nothing here amends
them.

**Preserved:** `kds.ticket.bump_line` remains registered and offline-capable
— it does not depend on per-field HLC LWW (it is a monotonic-status CAS with
a legal-transition guard, which D1-1 never disputed), so it is unaffected by
this correction and was confirmed compatible (§AC-2 below refactors WHERE it
is registered, not its domain semantics, which are unchanged from §9/§10
above and independently re-verified, §AC-6).

**Online `kds.ticket.recall`** (`KitchenController`'s HTTP route,
`KdsOperationsService.recall`) is **completely unaffected** — this
correction touches only the OFFLINE sync-handler registration, never the
online KDS route, which was never claimed to implement per-field HLC LWW (it
operates on live server state with no offline capture-time assumption to
reconcile).

### AC-2. MODULE BOUNDARY

**Finding:** the original implementation's `kitchen/tickets/sync/*.sync-
handler.ts` files made `modules/kitchen` — a DOMAIN module — depend directly
on `modules/sync`'s registration and authorization internals
(`SyncOperationHandlerFor`, `SyncOperationContext`, `SYNC_AUTHORIZATION_PORT`,
`SYNC_REASON`), and reimplemented the bump-line CAS/legal-transition logic a
SECOND time against the kernel's own `Prisma.TransactionClient`, specifically
to avoid nesting `KdsOperationsService.bumpLine`'s own `UnitOfWork`
transaction. That is backwards: the correct direction is for the
protocol/integration layer to depend on a published domain contract, not for
the domain to depend on the protocol's own registration machinery — and it
left the SAME business rule maintained in two places with no single source
of truth.

**Correction applied — the dependency direction is inverted:**

1. Kitchen publishes `kitchen/contract/offline-ticket-operations.ts`:
   `KdsOfflineTicketOperations` (`findTicketBranch`, `bumpLine`) — a
   transaction-scoped domain operation with **zero Sync vocabulary in it**
   (no envelope, no reason codes, no handler decorator), and
   `KDS_OFFLINE_TICKET_OPERATIONS`, its DI token. `KDS_PERMISSIONS` is
   additionally re-exported through the same contract (a thin pass-through,
   mirroring `sync/contract`'s own `SYNC_REASON` re-export pattern), so the
   integration adapter never needs a private `kitchen/kitchen.permissions`
   import.
2. `KdsOfflineTicketOperationsService`
   (`kitchen/tickets/kds-offline-ticket-operations.service.ts`) is the
   PRIVATE implementation — the ONE place the bump-line CAS/legal-transition
   rule now lives. It takes `tx: Prisma.TransactionClient` as a parameter and
   never opens a transaction/`UnitOfWork` of its own: the "no nested
   UnitOfWork" invariant is now enforced by the contract's SHAPE (the method
   signature has no way to open one), not merely by a docblock asking a
   reimplementation to remember it.
3. `KdsTicketBumpLineSyncHandler`
   (`sync/integration/kds-ticket-bump-line.sync-handler.ts`) is the ONLY
   `@SyncOperationHandlerFor('kds.ticket.bump_line')` provider, and it is
   registered in `SyncModule`, not `KitchenModule`. It contains no
   ticket/line business rule — only envelope parsing, the two-step
   authorization sequence (resolve the ticket's CURRENT branch via
   `findTicketBranch`, authorize `kds.operate` against THAT branch, only
   then mutate — preserving the "server state wins over capture-time
   assumption" rule unchanged), and outcome mapping.
4. `KitchenModule` no longer imports `SyncModule` at all.
   `SyncModule` now imports `KitchenModule`, for exactly the one published
   token above — the FIRST domain `modules/sync` imports, an intentional,
   documented reversal of D4-1A's original "Sync never mentions Sales,
   Treasury or Kitchen" claim, recorded as such in both modules' own
   docblocks.

**Verification, not assertion:**

- `src/modules/module-boundaries.spec.ts` gained one dedicated new test —
  `'Kitchen never imports Sync, and Sync reaches Kitchen only through
  kitchen/contract — zero new KNOWN_DEVIATIONS either direction'` — which
  asserts BOTH `KNOWN_DEVIATIONS['kitchen->sync']` and
  `KNOWN_DEVIATIONS['sync->kitchen']` are `undefined`, that the live
  violation scan finds zero entries in either direction, and (by reading the
  handler file's own source) that the Sync-side handler imports only
  `kitchen/contract`, never a private `kitchen/tickets/...` path. The
  pre-existing, broader `'Kitchen adds ZERO new module-boundary deviations'`
  test continues to pass unmodified.
- **Final new `KNOWN_DEVIATIONS` entries added by this correction: ZERO.**
  (The original report's claim of "one new, intentional, asserted-live
  `kitchen->sync` deviation" is itself corrected here: inspection of the
  `KNOWN_DEVIATIONS` map at the pre-correction `HEAD` found **no
  `kitchen->sync` entry ever existed in it** — both `contract/` imports and
  the `${module}.module` DI-composition import that the original
  implementation used are exempted by `module-boundaries.spec.ts`'s own
  rules, so no deviation was ever mechanically recorded. The original
  report's prose overstated what the test suite actually enforced; that
  overstatement is what this correction's dedicated new test now closes,
  for both directions, going forward.)
- `npx tsc --noEmit`: clean. `npx eslint --fix` on every touched/new file:
  clean (7 pure-formatting findings, all auto-fixed, none semantic).
  `npx jest` (unit): **66 suites, 936 tests, all passing** (was 935; the one
  net addition is the new module-boundary test file's assertion count).

### AC-3. RECOVERY GOVERNANCE — THE 9-INVARIANT MATRIX

The existing admin-driven recovery-grant mechanism (§5 above,
`SyncRecoveryService`/`SyncRecoveryController`, `sync.recovery_grants`) is
re-examined here against the exact nine invariants ratified in
`2026-09-02_D1-1_offline-sync-ratification.md` §21.3, verbatim. **No code
change was made to the recovery mechanism in this correction** — this is an
audit of what exists, not a new implementation. Nothing here self-ratifies
the candidate.

| # | Ratified invariant | Disposition | Basis |
|:--:|---|---|---|
| 1 | A revoked terminal does not regain normal POS authority | **PASS WITH PROOF** | No code path in `SyncRecoveryService`/`SyncRecoveryController` ever writes `identity.terminals.status` (confirmed by inspection — grep for `terminal.status`/`.status =` in both files: zero hits). `test/sync-recovery.e2e-spec.ts`'s main scenario asserts the terminal's `status` remains `'revoked'` throughout, and that ordinary `POST /v1/sync/batch` remains refused for it the whole time. |
| 2 | Recovery is explicitly authorised | **PASS WITH PROOF** | Grant issuance requires live `identity.terminal.manage` (`@RequirePermission`, HTTP-guard-enforced); batch upload RE-CHECKS the same permission live, against the grant's own branch, via `SCOPE_AUTHORIZATION.assertAuthorized` — not cached from issuance time. Proven by the `403s grant issuance without identity.terminal.manage` and the upload-time permission-recheck test. |
| 3 | Recovery is auditable | **PASS WITH PROOF** | `TERMINAL_RECOVERY_GRANTED`, `TERMINAL_RECOVERY_BATCH_ACCEPTED` (atomic with the grant's one-shot CAS), `TERMINAL_RECOVERY_BATCH_PROCESSED` are all written and asserted present in the e2e suite. |
| 4 | Recovery cannot create new sales | **NOT PROVEN** | The report's own evidence for this row does not establish the ratified invariant — it establishes only a fact about TODAY's handler registry. `SyncOperationRegistry` happens to have exactly ONE registered handler (`kds.ticket.bump_line`), which creates no sale, so no batch submitted through the recovery channel can create one RIGHT NOW — but that is a fact about what is currently registered, not a property the recovery channel itself enforces. **No recovery-specific operation-type allowlist or denylist exists anywhere in `SyncRecoveryService`/`SyncRecoveryController`** (confirmed by inspection): the recovery upload route feeds `batch.process()` — the exact same `SyncBatchService`/`SyncOperationRegistry` pipeline ordinary sync uses — with no additional restriction on which operation TYPES it will apply. The ratified invariant is a standing constraint that must continue to hold as ordinary offline handlers are added; nothing in this implementation is structured to keep holding it once a sale-creating handler (e.g. a future `order.create`) is registered for ordinary sync — that handler would become reachable through recovery automatically, with zero code change to the recovery path. A disposition that depends entirely on the CURRENT contents of an unrelated registry, with no structural link enforcing the invariant as that registry changes, is not a proof of the invariant — it is an observation that today's registry happens not to violate it yet. Corrected from this report's own prior (too strong) **PASS WITH PROOF, SCOPE-LIMITED** classification. |
| 5 | Recovery cannot modify arbitrary server state | **PASS WITH PROOF, SCOPE-LIMITED** | Same structural reasoning as #4: bounded by the SAME handler registry ordinary sync uses, and the one registered handler's write surface is a narrow, revalidated CAS on `kitchen.ticket_lines`/`kitchen.tickets`. Same residual noted: the boundary is a property of what is currently registered, not a recovery-specific guard. |
| 6 | Operation idempotency remains enforced | **PASS WITH PROOF** | The recovery route calls the UNMODIFIED `SyncBatchService.process()` — the exact same global `(tenant_id, op_id)` dedup registry ordinary sync uses. Proven by the "a retry of the exact same batch replays (`replayed: true`), no new dedup rows" assertion in `sync-recovery.e2e-spec.ts`. |
| 7 | Recovered financial operations receive enhanced provenance / mandatory review | **FAIL** | No mechanism of any kind exists. The only provenance signal is the BATCH-level audit trail (`TERMINAL_RECOVERY_BATCH_ACCEPTED`/`PROCESSED`, keyed to the grant); no individual operation record — `sync.sync_operations`, `sync.operation_dedup`, or the domain audit entry itself (e.g. `TICKET_LINE_BUMPED`) — carries any flag distinguishing "applied via a revoked-terminal recovery grant" from an ordinary sync operation (confirmed by inspecting all three Prisma models: none has such a column). A reviewer would have to manually cross-reference `batchId` against `sync.recovery_grants.consumed_batch_id` to even discover an operation was recovery-sourced. No mandatory-review workflow (queue entry, flag, escalation) is triggered for a recovered operation of any kind. Independently, D4-1B implements zero financial (`order.*`/`payment.*`) operation types, so the invariant's literal subject cannot yet be exercised even if the mechanism existed — but the absence of ANY operation-level provenance flag is a real, independent gap that exists regardless of financial status. |
| 8 | A lost/stolen terminal cannot use the recovery path to escalate authority | **PASS WITH PROOF** | Neither recovery route accepts terminal authentication of any kind — both require `JwtAuthGuard` + `TenantContextGuard` + an admin's own live-checked `identity.terminal.manage`; a terminal's own (even unexpired) session token is never accepted by either route, and `uploadRecoveryBatch` additionally rejects a `deviceId` that does not match the grant's named terminal. A physically stolen device's credentials confer nothing here beyond what an ordinary unauthorized caller already has. Proven by the "active terminal refused a grant" and "no-permission 403" tests, and by inspection: `SyncRecoveryController` carries no terminal-facing guard at all. |
| 9 | Legitimate committed transactions are not silently discarded | **NOT PROVEN** | Splits into two halves. The SERVER-SIDE half — given a batch payload, apply it losslessly and exactly once — IS proven (§5.2 above, re-verified this session). The CLIENT/DEVICE-SIDE half — **how backlog is actually obtained from a revoked/encrypted terminal in the first place** — has NO code anywhere in this repository; it is entirely out of scope of `modules/sync`, unaddressed by any client-side or device-recovery tooling at this HEAD. Independently, **nothing proves a recovered operation existed BEFORE revocation rather than being fabricated afterward**: `identity.terminals` has no `revokedAt` (or equivalent) column at all (confirmed by inspecting the `Terminal` model in `prisma/schema.prisma`), so there is no timestamp to compare an operation's client-asserted `hlc`/`occurredAt` against, and neither `SyncRecoveryService` nor `SyncBatchService` performs any such comparison. An admin (coerced, compromised, or simply mistaken about what a recovered device actually contains) could upload a batch with a freshly-fabricated timestamp and it would be accepted identically to a genuine pre-revocation operation. This is the invariant most directly connected to the "committed-sale loss is unacceptable" rejection of `GD-D1-07` (D1-1 §21.1) — and it is the one this correction finds least proven. |

**LOSSLESS RECOVERY HARD GATE = NOT CLOSED.**

Unresolved recovery invariants:

- **#4 NOT PROVEN** — no recovery-specific operation-type allowlist/denylist
  exists; present safety is entirely contingent on today's handler registry
  (only `kds.ticket.bump_line` is registered) and is not a property the
  recovery channel structurally enforces as ordinary offline handlers are
  added.
- **#7 FAIL** — no operation-level provenance flag or mandatory-review
  mechanism exists for recovery-sourced operations.
- **#9 NOT PROVEN** — no code obtains backlog from a revoked/encrypted
  terminal, and nothing proves a recovered operation predates its
  terminal's revocation rather than being fabricated afterward.

Any one of these is sufficient on its own, per this task's own rule, to keep
the hard gate open, regardless of invariants 1–3, 5, 6 and 8 passing. The
existing mechanism **remains a CANDIDATE**, exactly as
`2026-09-02_D1-1_offline-sync-ratification.md` §21.3 names it — **it is NOT
ratified as final lossless-recovery architecture by this correction, and
this correction does not attempt to self-ratify it.** Closing the gate
requires, at minimum: (a) a recovery-specific operation-type allowlist (or an
equivalent structural constraint) that keeps invariant 4 true as the
`SyncOperationRegistry` grows, independent of which handlers exist at any
given moment (invariant 4); (b) an operation-level provenance flag /
enhanced-review workflow for recovery-sourced operations (invariant 7); and
(c) either a `revokedAt`-comparable timestamp plus a documented provenance
argument for why client-asserted `hlc`/`occurredAt` is trustworthy enough for
this purpose, or an independent, cryptographically-groundable mechanism
proving an operation predates its terminal's revocation (invariant 9) —
none of which this correction implements, per its own scope (a governance
audit, not a new design).

### AC-4. NFR-PERF-032 — PER-BATCH RESOLVED-ACTOR CACHE

**Root cause, confirmed unchanged from the original report:**
`POS_ACTOR_AUTHORIZATION` re-resolved the acting employee's membership,
`EmployeeBranch` narrowing, and role/permission grants from scratch on every
single operation, even when every operation in a batch shares one
`actorEmployeeId`.

**Fix implemented:** `ActorResolutionCache`
(`sync/auth/actor-resolution.cache.ts`) — a plain `Map` keyed on
`(tenantId, terminalId, branchId, actorEmployeeId)` — constructed EXACTLY
ONCE per `SyncBatchService.run()` call (one per `POST /v1/sync/batch`
request, ordinary or recovery) and threaded through `ChunkBase` into every
chunk of that batch, fast-path attempt and safe-path fallback alike.
`SyncAuthorizationAdapter.isAllowed` consults it before calling
`PosActorAuthorizationPort.resolve`, and populates it on a genuine miss.
Constraint compliance, verified by inspection:

- **Caches only resolved actor FACTS, never a final authorization
  decision** — `ScopeAuthorizationService.isAuthorized` is called
  UNCONDITIONALLY on every single operation, against that operation's own
  target scope; the cache has no method that returns a boolean, so it is
  structurally incapable of caching a decision.
- **Batch-local only** — a fresh instance per `run()` call; never stored on
  `SyncAuthorizationAdapter` (a singleton) or any other cross-request object;
  nothing reads or writes process-global state.
- **No JWT snapshot authority** — the cache key and value never touch a
  token; `PosActorAuthorizationPort.resolve` itself takes no token, unchanged
  from the original binding.
- **Includes tenant/terminal/actor identity in its key** — deliberately
  wider than `resolve`'s own `(tenantId, employeeId, branchId)` key, so the
  cache's own semantics read as terminal-scoped even though `resolve` itself
  has no notion of a terminal.
- **Safe across fast-path rollback -> safe-path replay** — the SAME cache
  instance is reused for a chunk's safe-path retry after a fast-path abort,
  which is sound because no D4-1B handler writes
  `identity.employee_branches`, membership, or role assignments; the cache
  is read-memoization of an idempotent lookup, not a snapshot of mutable
  state that a rollback could invalidate. Reasoning recorded in the class's
  own docblock, not only here.
- **No global/process cache** — confirmed: the only place `new
  ActorResolutionCache()` is called is inside `SyncBatchService.run()`.

**Re-measured this session** (single local PostgreSQL 16 container, app role
`ros_app`, RLS forced — same non-reference topology as the original
measurement, numbers recorded not asserted as a CI gate, per established
convention):

| Scenario | Original p95 | Re-measured p95 | Budget |
|---|---:|---:|---:|
| A. Kernel floor (500 ops) | 387.3 ms | **353.8 ms** | 3000 ms — MET |
| B. Representative (+ audit + conflict lookup) | 1083.0 ms | **889.8 ms** | 3000 ms — MET |
| C. All-success production (`kds.ticket.bump_line`, live authorization + revalidation per op) | **4023.1 ms — NOT MET** | **2367.0 ms** | 3000 ms — **NOW MET** |
| D. Duplicate-heavy replay | 39.4 ms | **45.0 ms** | 3000 ms — MET |

**Mixed conflict/revalidation production-handler path — NOT RE-MEASURED THIS
SESSION, named not hidden:** the original benchmark drove this scenario
entirely through `kds.ticket.recall` (every op a guaranteed `conflict`), and
that handler is unregistered per AC-1. `kds.ticket.bump_line` has no
conflict-producing outcome of its own to substitute (its non-`accepted`
outcomes are `rejected`, never `conflict`), so the benchmark was REMOVED
rather than silently repointed at a different handler under the old name.
The closest still-measured proxy is layer B above (kernel-level
`protocol.probe` audit+conflict-lookup path, unaffected by this correction).
A genuine production-handler conflict-path benchmark is blocked on a
conflict-capable offline handler existing again, which is itself blocked on
AC-1's HLC-watermark gap.

**`500-OP KERNEL P95`: 353.8 ms. `500-OP PRODUCTION ALL-SUCCESS P95`:
2367.0 ms — MEETS the ≤3000 ms budget.**

**NFR-PERF-032: MET for every path measured this session** (kernel floor,
representative, all-success production, duplicate-replay), on the SAME
single-local-container topology and the SAME non-CI-gate convention the
original measurement used. The all-success production path — the one that
was over budget — improved from 4023 ms to 2367 ms p95, a 41% reduction,
consistent with the root cause (three redundant per-operation Identity reads
collapsed to one per distinct actor per batch). This is NOT a claim that the
reference CI environment has been measured; it is the same scope of claim
the original report made for the paths it measured, now including the one
that previously missed.

### AC-5. PRESERVED FIXES — RE-VERIFIED, NOT RE-CLAIMED

Every fix §3–§14 of the original report names was re-exercised this session
via the full targeted and full E2E suites (AC-6) rather than re-asserted from
memory: `SYNC_AUTHORIZATION_PORT` binding, inactive-branch-denied-before-
handler, ordinary-revoked-terminal generic 403, global tenant/op dedup,
changed-payload replay fail-closed, fast-path rollback/replay safety,
causal rejected-vs-conflicted distinction, audit atomicity, no
nontransactional pre-commit side effects, and the P-D4-02 contention proofs
— all green in this session's own run, see AC-6. No code in any of these
areas was touched by this correction; §3–§14 of the original report stand
unchanged as the description of what they verify and how.

### AC-6. MIGRATION EVIDENCE — MEASURED, NOT INFERRED

Exact migration directory counts, measured by `git ls-tree -r <rev>
--name-only -- prisma/migrations | grep -c '/migration.sql$'` in this
session:

| Revision | Exact migration count |
|---|---:|
| `2603099` (D4-1B's own starting HEAD) | **37** |
| `1fe490f` (D4-1B's HEAD prior to this correction) | **38** |

**This resolves the original report's own internal contradiction** (§1: "38
migrations present pre-implementation (37 + the identity scoped-role-
assignment migration)... D4-1B adds exactly one more (migration 38, §19)" —
self-contradictory, since "38 pre-implementation" plus "one more" would be
39). The measured fact: **37 at the D4-1B starting HEAD, 38 after D4-1B's
one new migration** (`20260903010000_sync_recovery_grants`) — the "38
migrations present" phrase in the original report's §1 was describing the
POST-implementation count while labelled as pre-implementation, a wording
defect, not a numerical one; the actual migration set (37 -> +1 -> 38) is
correct.

**This correction adds zero migrations.** The current on-disk count remains
**38**, confirmed by both `find prisma/migrations -maxdepth 1 -type d | grep
-c '^prisma/migrations/2'` and a from-zero template-database migration run
(§AC-7) in this session.

### AC-7. AUTHORIZATION COVERAGE — MEASURED THIS SESSION

`npx jest src/modules/authorization-coverage.spec.ts --verbose`, this
session, against the corrected `HEAD`:

| Metric | Count |
|---|---:|
| Total routes scanned | **159** |
| Permission-bearing, explicit authorization target declared | **142** |
| Permission-bearing, undeclared target | **0** |
| Reviewed auth-only (no permission requirement, allowlisted with a stated reason) | **17** |

All 9 gate assertions in the spec pass, including "no allowlist entry is
stale" and "every declared target is structurally valid." The two new sync
routes from the original D4-1B report (`POST /v1/sync/recovery/grants` —
declares `@RequirePermission`/`@AuthorizationTarget` normally, counted in the
142 — and `POST /v1/sync/recovery/:grantId/batch` — in the reviewed
allowlist, counted in the 17) are unchanged by this correction; neither route
was touched.

### AC-8. TESTS EXECUTED THIS SESSION

All runs below are from THIS resumed session, against real PostgreSQL 16
(the `ros-postgres-lane-d` container on port 5566, restarted after the
reboot; 2 previously-applied-but-not-yet-deployed-to-this-literal-dev-DB
migrations brought current with `prisma migrate deploy` before any test ran
— both pre-existing migrations from before this correction, not new ones).

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `npx eslint` (all touched/new files) | Clean (7 auto-fixed formatting findings, 0 semantic) |
| Unit (`npx jest`) | **66 suites, 936 tests, all passing** |
| Module boundaries (subset of unit, above) | **46/46** (was 45; +1 new AC-2 assertion) |
| Authorization coverage gate | **PASS**, see AC-7 |
| `test/e2e-db-isolation-config.e2e-spec.ts` | PASS — template DB migrated from zero, 38 migrations, scratch DB swept |
| Targeted sync e2e (`--testPathPatterns='sync-'`) | **10 suites, 86 tests, all passing** — `sync-protocol`, `sync-causal`, `sync-crash-recovery`, `sync-idempotency`, `sync-rls`, `sync-audit-contention`, `sync-contention`, `sync-kds-handlers` (production handler tests), `sync-recovery`, `sync-performance` |
| Scoped auth (`--testPathPatterns='scoped-'`) | **3 suites, 80 tests, all passing** — `scoped-authorization-matrix`, `scoped-rbac`, `scoped-rbac-migration` |
| `npm run openapi:check` | Clean — zero diff after regeneration; this correction changed no route |
| Full E2E (`test/jest-e2e.json`, no filter, `--maxWorkers=2`) | **81 suites, 1338 tests, 0 failures, single clean run** (was 1340; net -2 matches the recall-describe consolidation in `sync-kds-handlers` and the removed recall-benchmark test in `sync-performance`, both accounted for in AC-1/AC-4) |

**No flaky/Class-C investigation was needed this session** — unlike the
original report's five runs under `--maxWorkers=4`, this session's single
`--maxWorkers=2` full run was clean on the first attempt.

**Persistent `ros` was not touched.** This lane's dev database remains
`ros_lane_d_d41a_20260902071647` (from `.env`); no database literally named
`ros` exists on this server. Zero orphan `ros_test_e2e_*` scratch databases
after the final run (confirmed by the isolation-config suite's own sweep
log). No push, no deploy, no rebase, no merge, no destructive git operation
of any kind in this session.

### AC-9. FINAL STATUS — HONEST DISPOSITION

| Item | Status after this correction |
|---|---|
| `kds.ticket.recall` (offline) | **Unregistered.** BLOCKED by missing persisted HLC watermark (AC-1). Online recall route unaffected. |
| `kds.ticket.bump_line` (offline) | Unchanged domain semantics; re-registered on the corrected module-boundary direction (AC-2); re-verified green. |
| Module boundary (`kitchen`<->`sync`) | **Zero `KNOWN_DEVIATIONS` in either direction**, corrected direction (integration depends on domain contract), asserted by a dedicated new test (AC-2). |
| Lossless revoked-terminal recovery | **CANDIDATE, NOT RATIFIED. HARD GATE NOT CLOSED** — invariants 4 (NOT PROVEN), 7 (FAIL) and 9 (NOT PROVEN) are unresolved (AC-3). Not self-ratified by this correction. |
| `NFR-PERF-032` | **MET for every path measured this session**, including the previously-over-budget all-success production path (4023 ms -> 2367 ms p95) (AC-4). Not a claim about the CI reference environment. |
| Migration count | **37 at `2603099` -> 38 at `1fe490f` and at this correction's HEAD** — measured, contradiction in the original report's wording resolved (AC-6). This correction adds zero migrations. |
| Authorization coverage | 159 routes; 142 permission-bearing (0 undeclared); 17 reviewed auth-only (AC-7). |
| Preserved fixes (§3–§14 of the original report) | Re-verified green this session, untouched by this correction (AC-5). |

**`D4-1` FULL is NOT COMPLETE.** The sole remaining blocker named by this
correction is the lossless-recovery hard gate (AC-3) — `NFR-PERF-032` is no
longer a blocker for the paths measured, and `kds.ticket.recall` no longer
contradicts ratified HLC governance because it is unregistered rather than
misrepresented as compliant. `D4-1` CORE remains authorised and implemented
for `kds.ticket.bump_line`; `D4-1` cannot be declared FULLY COMPLETE until a
genuinely provenance-proven, ratified lossless-recovery design closes AC-3's
two open invariants, per `2026-09-02_D1-1_offline-sync-ratification.md`
§21.3/§30.1, unchanged by this correction.

**No push. No deploy. No rebase. No merge.**

---

*Prior report: [2026-09-02_D4-1A_sync-protocol-kernel.md](2026-09-02_D4-1A_sync-protocol-kernel.md).
Prior integration reports: [2026-09-02_MW1B_integration-a1-2-b1-2-d4-1a.md](2026-09-02_MW1B_integration-a1-2-b1-2-d4-1a.md),
[2026-09-02_MW1C_integration-b1-3.md](2026-09-02_MW1C_integration-b1-3.md).*

# KDS MVP Operator Lifecycle — Implementation

| Field | Value |
|---|---|
| **Task / slice** | KDS MVP Operator Lifecycle — implementation |
| **Report type** | Implementation report |
| **Authority statement** | **This report is NON-AUTHORITATIVE EVIDENCE.** The `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (KDS-R11, KDS-R12) are the only authorities. Where this report and those sources differ, those sources govern. |
| **Date** | 2026-08-30 (session spanned into 2026-08-31) |
| **HEAD** | `121b889b23a20167ea47574d601ec115350addaa` — verified unchanged before and after implementation |
| **Branch** | `feat/production-spec` |
| **Working tree summary** | Governance docs unchanged by this task (pre-existing dirty state from the ratification task); this task modified 17 existing source/test files and added 21 new files (see §1). No commit made. |
| **Task identifier** | KDS-IMPL-2026-08-30 |

---

## §0. AUTHORITY ORDER FOLLOWED

1. `docs/reports/claude/2026-08-30_KDS_operator-lifecycle-final-design-gate.md` (design)
2. `docs/reports/claude/2026-08-30_KDS_operator-lifecycle-design-gate-acceptance-correction.md` (**supersedes the gate wherever they differ** — followed literally: SERIALIZABLE mechanism, exactly-one-station rule, `TICKET_VIEWED` audit, terminal-type check)
3. `docs/reports/claude/2026-08-30_KDS_operator-lifecycle-user-ratification.md` and the register's `## KDS MVP Operator Lifecycle Ratification — 2026-08-30` section (KDS-R11 `kds.operate`, KDS-R12 `ticket.recalled`)
4. Current repository conventions (Sales/Treasury/Organisation controllers, `UnitOfWork`, `AuditService`, module-boundaries test)

No contradiction was found between the two design reports and the register. No STOP condition (§38 of the prompt) was triggered.

---

## §1. FILES CHANGED

### Modified (17)
- `src/prisma/prisma.service.ts` — `withAuthContext` accepts an optional `{ isolationLevel }`.
- `src/common/domain-events/unit-of-work.ts` — `UnitOfWork.execute` accepts an optional 4th `UnitOfWorkRetryOptions` param (`isolationLevel`, `maxAttempts`); bounded whole-transaction retry loop.
- `src/modules/governance/audit/audit.constants.ts` — 5 new `AUDIT_ACTION` entries, 2 new `AUDIT_ENTITY` entries.
- `src/modules/identity/contract/index.ts` — exports `terminal-facts.query`.
- `src/modules/identity/identity.module.ts` — registers `TERMINAL_FACTS_QUERY`.
- `src/modules/kitchen/contract/events.ts` — widened `TicketBumpedPayload` (v1, design gate §12); added `ticket.recalled` (KDS-R12).
- `src/modules/kitchen/contract/events.spec.ts` — updated to the widened payload; added `ticket.recalled` coverage.
- `src/modules/kitchen/kitchen.module.ts` — first controller registered; new providers/imports.
- `src/modules/kitchen/tickets/ticket-reader.service.ts` — widened `TICKET_CARD_SELECT`; added `listStationQueue`.
- `src/modules/kitchen/tickets/ticket-reader.types.ts` — widened `TicketCardDto`/`TicketCardLineDto`; added `StationQueueDto`.
- `src/modules/module-boundaries.spec.ts` — added `kitchen->governance`/`kitchen->identity` deviation entries (cross-cutting HTTP/auth plumbing, category (a), identical in shape to every other controller-bearing module's own entries) and 5 new assertions proving the new Identity/Organisation contracts are consumed correctly and no NEW business-domain deviation exists.
- `src/modules/organisation/contract/index.ts` — exports `station-display-binding.query`, `kds-branch-config.query`.
- `src/modules/organisation/organisation.module.ts` — registers `STATION_DISPLAY_BINDING_QUERY`, `KDS_BRANCH_CONFIG_QUERY`.
- `src/modules/sales/sales.module.ts` — registers `TicketBumpedHandler`, `TicketRecalledHandler`.
- `src/scripts/seed-dev-data.ts` — seeds `KDS_PERMISSION_DEFS`; grants `kds.operate` to the dev Owner role (matching the existing per-module convention for every other module).
- `test/openapi.e2e-spec.ts` — updated the pre-existing "does not document … KDS bump/recall" assertion (now expected to exist) to assert the exact 6-route KDS surface and that `/serve`/cancellation stay absent; added the recall route to `IDEMPOTENT_ROUTES`.
- `docs/api/openapi.json` / `docs/api/openapi.yaml` — regenerated (`npm run openapi:generate`) after the route surface was established.

### Added (21)
- `src/common/domain-events/serialization-retry.ts` — `isSerializationFailure`, `SerializationRetryExhaustedError`.
- `src/modules/identity/contract/terminal-facts.query.ts` — `TerminalFactsQuery` public contract.
- `src/modules/identity/terminals/terminal-facts.query.service.ts` — private implementation.
- `src/modules/organisation/contract/station-display-binding.query.ts` — `StationDisplayBindingQuery` public contract.
- `src/modules/organisation/contract/kds-branch-config.query.ts` — `KdsBranchConfigQuery` public contract.
- `src/modules/organisation/stations/station-display-binding.query.service.ts` — private implementation.
- `src/modules/organisation/routing-config/kds-branch-config.query.service.ts` — private implementation.
- `src/modules/kitchen/kitchen.permissions.ts` — `KDS_PERMISSIONS.OPERATE = 'kds.operate'`.
- `src/modules/kitchen/kitchen.dto.ts` — `StationQueueQueryDto`, `AcknowledgeViewedDto`.
- `src/modules/kitchen/kitchen.controller.ts` — the 6 KDS routes.
- `src/modules/kitchen/auth/kds-station.guard.ts` — `KdsStationGuard`.
- `src/modules/kitchen/auth/current-kds-station.decorator.ts` — `CurrentKdsStation`.
- `src/modules/kitchen/tickets/ticket-projection.ts` — pure projection logic (`projectTicketStatus`, `BUMP_ELIGIBLE_STATUSES`, `isLineAlreadyBumped`).
- `src/modules/kitchen/tickets/ticket-projection.spec.ts` — unit tests.
- `src/modules/kitchen/tickets/kds-operations.service.ts` — the whole operator-lifecycle mutation surface.
- `src/modules/sales/orders/ticket-bumped.handler.ts` — Sales `ticket.bumped` subscriber.
- `src/modules/sales/orders/ticket-recalled.handler.ts` — Sales `ticket.recalled` subscriber.
- `test/kds-fixtures.ts` — shared e2e bootstrap (tenant/branch/station/terminal/employee/PIN + direct Ticket/TicketLine insertion, bypassing Fire).
- `test/kds-authorization.e2e-spec.ts` — 14 tests, design gate §26/§30.
- `test/kds-first-viewed.e2e-spec.ts` — 6 tests, §31.
- `test/kds-operator-lifecycle.e2e-spec.ts` — 12 tests, functional lifecycle + Sales readiness/reversion + idempotency.
- `test/kds-concurrency.e2e-spec.ts` — 10 tests, real two-transaction PostgreSQL races A–L.

**No migration created. No schema change. `prisma/schema.prisma` untouched.**

---

## §2. ENVIRONMENT NOTE (not a code change)

The local dev Postgres was 8 migrations behind HEAD (`20260824100000_sales_order_payment_capture` … `20260830020000_treasury_cashsession_close`, all pre-existing, none authored by this task). `prisma migrate deploy` was run to bring the database to HEAD's schema — required for ANY e2e test (including pre-existing ones) to run against current models. This applied only already-committed migration files; it did not create, edit, or generate a new migration.

---

## §3. PERMISSION — KDS-R11

`kds.operate` (module `kds`, description `"Operate a kitchen display station"`) is the only permission created. Seeded via `PermissionsService.upsertMany` (code-driven, no DDL) from `KDS_PERMISSION_DEFS`. Every one of the 6 routes carries exactly `@RequirePermission(KDS_PERMISSIONS.OPERATE)` at the controller class level. No `kds.view`/`kds.ticket.*`/`kds.expedite` code exists anywhere. No standard-role seeding was implemented; the dev-only seed script grants it to the local Owner role only, following the pre-existing convention every other module's `_PERMISSIONS` set already receives there (not a production role-seeding path).

---

## §4. ROUTE INVENTORY

| Method | Path | Idempotency-Key | Permission | Notes |
|---|---|---|---|---|
| GET | `/kds/stations/{stationId}/queue` | n/a | `kds.operate` | Read-only, FIFO, `?sort=fifo` only valid value (400 otherwise via `@IsIn`) |
| POST | `/kds/stations/{stationId}/tickets/view` | accepted, not required | `kds.operate` | First-viewed acknowledgement |
| POST | `/kds/tickets/{ticketId}/lines/{lineId}/start` | accepted, not required | `kds.operate` | Optional item start |
| POST | `/kds/tickets/{ticketId}/lines/{lineId}/bump` | accepted, not required | `kds.operate` | Bump item |
| POST | `/kds/tickets/{ticketId}/bump-all` | accepted, not required | `kds.operate` | Bump all |
| POST | `/kds/tickets/{ticketId}/recall` | **REQUIRED** (`@Idempotent()`) | `kds.operate` | Recall |

No `/serve`, no cancellation route, no analytics route, no sort-configuration route. Confirmed by `openapi.e2e-spec.ts`'s exact-6-route assertion.

---

## §5. AUTH / TERMINAL ENFORCEMENT

Guard chain on every route: `JwtAuthGuard` (401) → `TenantContextGuard` (403) → `PermissionGuard` (`kds.operate`, 403) → `KdsStationGuard` (403). `@AllowPosSession()` opts every route in for PIN sessions, matching Sales/Treasury.

`KdsStationGuard` (new, Kitchen-owned):
1. `principal.terminalId` present, else 403.
2. `TerminalFactsQuery.getById` (Identity public contract) — terminal exists, `status==='active'`, `terminalType==='kds'`, else 403. **The authoritative fact is the terminal's own type, never `sessionType:'pos'`** — verified by the authorization test matrix's POS/kiosk-terminal cases.
3. `StationDisplayBindingQuery.stationsForTerminal` (Organisation public contract) — exactly one binding, else 403 (0 or >1, both fail-closed, never an arbitrary pick).
4. A path `:stationId` (queue, view routes) must equal the resolved station, else 403.

For ticket-scoped mutations (no `:stationId` in the path), `KdsOperationsService.loadTicketOwnedByStation` re-verifies `ticket.stationId === kdsStation.stationId` **inside the transaction**, from a freshly-loaded row — never trusts the guard's resolution alone for a specific ticket.

Employee identity: `KitchenController.requireEmployee` — every mutating route requires `principal.employeeId` (403 otherwise); GET queue does not.

---

## §6. STATION QUEUE

`TicketReaderService.listStationQueue` — read-only, `tenantId`+`stationId` filtered, `status NOT IN ('bumped','served')`, ordered `routedAt ASC, id ASC` (uses the existing `[tenantId, branchId, stationId, status, routedAt]` index). GET never writes `first_viewed_at` (proven by `kds-first-viewed.e2e-spec.ts`'s first test). `elapsedSeconds` computed server-side at response time from one shared `now`.

---

## §7. FIRST-VIEWED

`KdsOperationsService.acknowledgeViewed` — `tx.ticket.updateManyAndReturn({ where: { …, stationId, firstViewedAt: null } })` (write-once, database-level idempotent); lines stamped in the same transaction; the audit set is derived from the `RETURNING` rows, never the request body. One `TICKET_VIEWED` entry per newly-stamped ticket, metadata carries `ticketLineIds`. A foreign-station ticket in the batch is silently excluded (not stamped, not audited). Proven by 6 tests including a real rollback (audit override injected via `.overrideProvider(AuditService)`, proving the stamp and the entry disappear together).

---

## §8. BUMP ITEM / BUMP ALL

Conditional `updateMany({ where: { status: { in: BUMP_ELIGIBLE_STATUSES } } })` (queued/started/ready → bumped, `ready_at=bumped_at=now`, `bumped_by=employeeId`); cancelled → 422; already-bumped/served → replay (200, unchanged). Bump-all uses `updateManyAndReturn` over the same eligible set per ticket, one `TICKET_BUMPED` audit entry (never per-line), preserving any already-bumped line's own actor/time (its row is simply outside bump-all's match set).

Ticket projection (`ticket-projection.ts::projectTicketStatus`, pure function, unit-tested): `bumped` ⇐ every non-cancelled line bumped-or-beyond; `ready` ⇐ every non-cancelled line ready-or-beyond; `in_progress` ⇐ any line has ever been started (`startedAt IS NOT NULL`, a durable fact, not current status); else `queued`. An all-cancelled ticket never reaches ready/bumped. Applied via `KdsOperationsService.applyTicketProjection` — a bounded (5-attempt) local CAS loop on `tickets.version`, separate from the outer SERIALIZABLE retry (this loop exists for the non-serializable `start` path too).

---

## §9. SERIALIZABLE IMPLEMENTATION

`PrismaService.withAuthContext(scope, fn, { isolationLevel })` → `this.$transaction(fn, { isolationLevel })`. `UnitOfWork.execute(scope, fn, causal, { isolationLevel, maxAttempts })` wraps the whole attempt in a loop; `correlationId`/`commandId` are computed ONCE outside the loop (retry-stable); each attempt gets a fresh `DomainEventCollector`. `KdsOperationsService.bumpLine`/`bumpAll`/`recall` all pass `{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxAttempts: 3 }`. `view`/`start` remain plain `withAuthContext` calls (READ COMMITTED, no retry) — not required by the design, and `start`'s own CAS loop covers its narrower race.

## §10. RETRY CLASSIFIER

`isSerializationFailure` (`serialization-retry.ts`): `PrismaClientKnownRequestError` with `code==='P2034'`, or `PrismaClientUnknownRequestError` whose message matches `/\b(40001|40P01)\b/` (verified against this repository's `@prisma/adapter-pg` mapping: raw SQLSTATE `40001`→`TransactionWriteConflict`; `PrismaClientUnknownRequestError` carries no structured code, only the message). Anything else (business `HttpException`s, `P2002`/`P2003`, idempotency conflicts) propagates on the first attempt — never retried. Exhaustion after `maxAttempts` throws `SerializationRetryExhaustedError`, mapped to `ConflictException` (409) by `KdsOperationsService`.

---

## §11. CONCURRENCY PROOF (real PostgreSQL, `test/kds-concurrency.e2e-spec.ts`, 10/10 passing)

Barrier injected at `PrismaService.withAuthContext` (subclassed `BarrierPrismaService`, one-shot `makeBarrier`, safe against a retried second call because the barrier is already resolved). Covers:
- **A** same line, two concurrent bumps → one mutation, replay preserves actor/time.
- **B** different lines, same ticket → both succeed, ticket converges, no lost update.
- **C** bump item vs bump-all → no double overwrite.
- **D/G** — **the load-bearing test**: one order line on two stations, concurrent final bumps, both resolve successfully (SERIALIZABLE + retry transparent to the caller), Sales ends `ready` exactly once, exactly one `TICKET_LINE_BUMPED` audit entry per ticket line despite the internal retry.
- **E** three-station fan-out, concurrent final bumps, Sales ends `ready`.
- **F** Sales subscriber throws → whole transaction rolls back (Kitchen line stays `queued`, zero audit entries, Sales line stays `fired`); never retried for a business/subscriber failure.
- **H** stated explicitly: D's success already proves correctness does not depend on `AuditService`'s advisory lock (audit runs after the line/projection CAS and before the readiness SELECT in the implemented ordering).
- **I/J** recall racing a concurrent bump attempt on the same ticket → `recall_count` exactly 1, one `TICKET_RECALLED` entry, order line ends coherently `fired` or `ready` (never corrupted).
- **K** recall reverts Sales `ready→fired`, clears `ready_at`, same transaction.
- **L** recall subscriber throws → Kitchen recall (`recall_count`, `recalledAt`, audit) and the Sales reversion all roll back together.

Fault injection for F/L uses `.overrideProvider(...).useClass(FailingHandler)` (a real `@DomainEventHandler`-decorated class) — a `.useValue()` plain object was tried first and found to be silently dropped by `DomainEventHandlerRegistry`'s `DiscoveryService`-based scan (it reads decorator metadata off the class, which a value provider does not have), so the working technique is recorded here for future reference.

---

## §12. `ticket.bumped` CONTRACT AND RUNTIME

v1 payload implemented exactly per design gate §12 / correction §1.6: `ticketId, orderId, businessDay, stationId, bumpedAt, orderLineIds, readyOrderLineIds`. Published only when `applyTicketProjection` reports `transitionedToBumped`. `readyOrderLineIds` computed by a raw SQL `GROUP BY order_line_id HAVING bool_and(status IN (bumped,served,cancelled)) AND bool_or(status IN (bumped,served))` over `kitchen.ticket_lines` only (§13/§18) — the SSI-protected predicate read the acceptance correction's SERIALIZABLE mechanism exists to make trustworthy.

## §13. SALES READINESS

`TicketBumpedHandler` (Sales-private, `@DomainEventHandler('ticket.bumped')`) imports only `kitchen/contract`; `updateMany({ where: { id: in(readyOrderLineIds), state: in(['fired','preparing']) }, data: { state: 'ready', readyAt: bumpedAt } })`. Never touches `orders.version`. Runs inside the same transaction (`dispatcher.drain` still inside `$transaction`) — a throw rolls back Kitchen + Sales + audit together (proven by concurrency test F).

## §14. RECALL

`KdsOperationsService.recall` — allowed only from `status==='bumped'`; window = `KdsBranchConfigQuery.find(...).recallWindowSeconds` (default 1800, from the existing schema default, never re-invented) compared against `now - bumpedAt`; non-cancelled, non-served bumped lines revert to `started` (if `startedAt` set) or `queued`; `bumpedAt`/`readyAt` preserved; `recallCount` incremented via a version-guarded `updateMany` (defense-in-depth on top of SERIALIZABLE); one `TICKET_RECALLED` audit entry.

## §15. `ticket.recalled` CONTRACT (KDS-R12) AND SALES REVERSION

Payload: `ticketId, orderId, businessDay, stationId, recalledAt, revertedOrderLineIds` (every non-cancelled, non-served line that was `bumped` and is being reverted by this recall). `TicketRecalledHandler` (Sales-private) reverts `updateMany({ where: { state: 'ready' }, data: { state: 'fired', readyAt: null } })` — the `state==='ready'` guard is the precision mechanism (an order line another station has not yet completed was never `ready`, so it is silently skipped without Kitchen needing a second cross-station computation).

---

## §16. AUDIT ACTIONS

`TICKET_VIEWED`, `TICKET_LINE_STARTED`, `TICKET_LINE_BUMPED`, `TICKET_BUMPED`, `TICKET_RECALLED` (entities `ticket`, `ticket_line`). No duplicate noise: bump-all writes exactly one `TICKET_BUMPED`; Sales subscribers write no echo entries.

## §17. IDEMPOTENCY

Existing infrastructure only (`@Idempotent()` + `IdempotencyInterceptor`). Applied ONLY to recall (mandatory `Idempotency-Key`; verified: missing → 400, identical replay → `Idempotent-Replay: true` with the stored body, `recallCount` not incremented twice). View/start/bump/bump-all are naturally database-idempotent and deliberately do NOT carry `@Idempotent()` (that decorator would make the header mandatory, contradicting "accepted but not required").

## §18. MODULE BOUNDARIES

`kitchen->identity` and `kitchen->governance` added to `KNOWN_DEVIATIONS`, identical in shape to every other controller-bearing module's own entries (cross-cutting HTTP/auth/audit plumbing, not a business coupling). `kitchen->organisation`, `kitchen->sales`, `kitchen->catalogue` remain `undefined`/zero violations. New assertions prove Identity's `TerminalFactsQuery` and Organisation's `StationDisplayBindingQuery`/`KdsBranchConfigQuery` are consumed only through `contract/`, never a private path, and that their concrete implementations are never imported outside their owning module. Full suite: **41/41 passing**.

## §19. MIGRATION / SCHEMA STATEMENT

**No migration created. No schema change.** Every column, index, enum value, and default used by this slice already existed at HEAD (verified field-by-field against the design gate's §24 table before writing any code).

## §20. OPENAPI

Regenerated after the route surface was implemented and tested (`npm run openapi:generate`). Exact 6 KDS paths present. A pre-existing `openapi.e2e-spec.ts` assertion that explicitly forbade `bump`/`recall` paths was updated (it was asserting the PRE-implementation state, which this authorized task supersedes) to instead assert the exact 6-route surface and that `/serve`/cancellation stay absent.

---

## §21. TESTS EXECUTED — EXACT COUNTS

All commands run in this session, against real PostgreSQL (`localhost:5544`), after `prisma migrate deploy` brought the local DB to HEAD's migration set.

- **Unit suite** (`npx jest`): **57 suites / 777 tests — all passing** (includes the new `ticket-projection.spec.ts` and the updated `kitchen/contract/events.spec.ts`).
- **Module-boundary suite** (`src/modules/module-boundaries.spec.ts`, part of the unit run): **41/41 passing**.
- **KDS authorization e2e** (`test/kds-authorization.e2e-spec.ts`): **14/14 passing**.
- **KDS first-viewed e2e** (`test/kds-first-viewed.e2e-spec.ts`): **6/6 passing**.
- **KDS operator-lifecycle e2e** (`test/kds-operator-lifecycle.e2e-spec.ts`): **12/12 passing**.
- **KDS concurrency e2e** (`test/kds-concurrency.e2e-spec.ts`, real two-transaction races): **10/10 passing**.
- **Full e2e suite** (`NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/jest-e2e.json`): **1004/1007 passing, 50 suites (48 passing, 2 failing)**.
  - **2 pre-existing, unrelated failures**, proven pre-existing before exclusion:
    1. `test/organisation.e2e-spec.ts` › *"leaves no org location entity without a registry row"* — expected 0, found 11 orphaned `org.branches` rows. Queried directly: all 11 are dated **2026-08-23 through 2026-08-28** (days before this session), none named after any KDS fixture. This is accumulated cruft in the shared local dev database from prior, unrelated test runs — not created by any file this task touched (every KDS fixture branch creates its matching `org.locations` row, verified in `test/kds-fixtures.ts`).
    2. `test/approval-runtime.e2e-spec.ts` › the two `approval_decisions` column-GRANT tests — expected `ros_app` to lack `INSERT` on `decided_at`/`created_at`; the live database grants it. Inspected the migration SQL directly (`20260829010000_governance_approval_runtime/migration.sql:161-163`): it correctly issues a column-restricted `GRANT INSERT (id, tenant_id, approval_request_id, approver_id, decision, comment)`, excluding those two columns. Postgres `GRANT` is additive, never restrictive, so a **broader grant from this database's own prior history** (predating this session) still stands. This task never touched governance/approval code, migrations, or grants — the discrepancy is a pre-existing local-database artifact, not a defect in the committed migration or in this task's diff.

Neither failure touches any file this task created or modified, and both were independently verified pre-existing via direct inspection (not merely re-run) before being excluded from the assessment.

---

## §22. REQUIREMENT CLASSIFICATIONS (honest, per §35 of the prompt)

| Requirement | Status | Note |
|---|---|---|
| FR-KDS-010 | COMPLETE | Unchanged (P1E-3) |
| FR-KDS-011 | COMPLETE | Multi-station routing + now-correct multi-station readiness |
| FR-KDS-013 | NOT IMPLEMENTED | Expediter/Pass deferred |
| FR-KDS-020 | PARTIAL | Backend data complete and self-contained; client rendering remains |
| FR-KDS-021 | PARTIAL | `kind` enum type-safe; visual rendering is client |
| FR-KDS-022 | PARTIAL | `elapsedSeconds`/`routedAt` served; `targetReadyAt` always null; no colour |
| FR-KDS-023 | PARTIAL | FIFO only |
| FR-KDS-024 | **COMPLETE (backend)** | Bump item + bump all, executable and audited |
| FR-KDS-025 | **COMPLETE (backend)**, incl. KDS-R12 | Recall + Sales reversion implemented and proven |
| FR-KDS-026 | NOT IMPLEMENTED | Client-only (deliberate interaction gesture) |
| FR-KDS-028 | PARTIAL | Ticket stability structural; alert rendering is client |
| FR-KDS-029 | NOT IMPLEMENTED | Upstream `order.line.voided`/post-fire void absent (unchanged, out of scope) |
| FR-KDS-040 | PARTIAL | 6 of 7 timestamps written (`served` outstanding, FR-KDS-013-gated) |
| FR-KDS-041/042/043/044/045 | NOT IMPLEMENTED | Analytics/target-time/capacity, all deferred |
| NFR-USA-006 | NOT IMPLEMENTED | Client |
| NFR-PERF-004 | **NOT VERIFIED** | No benchmark executed this session |
| NFR-REL-002/003 | NOT IMPLEMENTED | Offline/peer-discovery, deferred |
| §5.5.4 `ticket.bumped` | **COMPLETE** | Runtime producer + Sales subscriber verified end to end |
| FR-AUD-001 (KDS operations) | **COMPLETE** | Every implemented KDS state change audited in-transaction |

No global "FR-KDS COMPLETE" claim is made.

## §23. DEFERRED SCOPE (unchanged from the ratified design)

`served`/Expediter (FR-KDS-013), sorting beyond FIFO, colour thresholds, FR-KDS-041/042/043 analytics, post-fire cancellation (`order.line.voided`), offline KDS, peer discovery, FR-SEC-026 per-surface session TTL, standard-role seeding.

## §24. KNOWN RESIDUAL RISKS

- The projection CAS bounded-retry (`applyTicketProjection`, 5 attempts) is a defensive loop for the non-serializable `start` path; under extreme contention it could theoretically exhaust and throw a generic `ConflictException` — not observed in any test run.
- `AuditService`'s per-tenant `pg_advisory_xact_lock` remains **existing technical debt** and a candidate future NFR-PERF investigation: it still serializes every audited write within a tenant. This task did **not** modify `AuditService` and confirmed (test H / test D) that KDS correctness does not depend on it — the advisory lock is not load-bearing for this slice, but it remains a latent throughput ceiling for high-volume tenants, unchanged from the acceptance correction's finding.
- The two pre-existing e2e failures (§21) are local-database environment artifacts; they do not affect the committed migration files or any code path this task touched, but a clean database rebuild would be needed to make the full e2e suite 100% green.

## §25. AuditService TENANT-WIDE LOCK

Recorded, not touched: `AuditService.record`'s `pg_advisory_xact_lock` remains a performance concern for a future NFR-PERF-004 investigation. Confirmed NOT load-bearing for this slice's correctness (§11/§24 above).

---

## §26. VERDICT

**A — KDS OPERATOR LIFECYCLE IMPLEMENTED — READY FOR ACCEPTANCE REVIEW**

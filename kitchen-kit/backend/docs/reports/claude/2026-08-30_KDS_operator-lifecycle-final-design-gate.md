# KDS Operator Lifecycle — Final Rebase, Design & Governance Gate

| Field | Value |
|---|---|
| **Task / slice** | KDS MVP Operator Lifecycle — final rebase + design + governance packet |
| **Report type** | Design gate / governance packet — ANALYSIS ONLY |
| **Authority statement** | **This report is NON-AUTHORITATIVE EVIDENCE.** The `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the only authorities. Where this report and those sources differ, **those sources govern**. Nothing here is ratified, and nothing here authorizes implementation. |
| **Date** | 2026-08-30 |
| **HEAD** | `121b889b23a20167ea47574d601ec115350addaa` (`121b889` — "feat: add cash session close") |
| **Branch** | `feat/production-spec` |
| **Working tree** | `M docs/reports/claude/INDEX.md` + 4 untracked pre-existing reports (`2026-08-26_MVP_…`, `2026-08-27_RENDER_…`, `2026-08-28_P1G1_cash-close-design-gate`, `2026-08-28_POST-P1F2_MVP_…`). All pre-date this task. **No source file, migration, schema, governance file or test was created or modified by this task.** |
| **Migrations at HEAD** | 34 (unchanged) |
| **Tests** | None executed — analysis-only task. No verification result in this report is claimed as newly executed. |
| **Task identifier** | KDS-GATE-2026-08-30 |

---

## §1. REPOSITORY BASELINE — VERIFIED

```
$ git rev-parse HEAD      121b889b23a20167ea47574d601ec115350addaa
$ git branch --show-current  feat/production-spec
$ git remote -v           origin   https://github.com/OffBrand-org/kitchen-kit-backend.git
                          upstream https://github.com/AhmedShantti/ros.git
```

Last five commits:

```
121b889 feat: add cash session close
0f10afe feat: add cash close policy substrate
1f9ea1f feat: add governance approval runtime
55e4ae8 feat: add mid-shift treasury cash movements
bfe7e69 feat: complete P1F-2 atomic order completion
```

**The prompt's warning is confirmed correct: HEAD is NOT `0f10afe`.** `0f10afe` is the cash-close *policy substrate*; the externally FINAL-ACCEPTED **P1G-1 CashSession Close** is `121b889`, one commit later, and it **is present in HEAD**. `git show --stat HEAD` confirms it ships `cash-session-close.service.ts` (883 lines), `cash-session-close.dto.ts`, `treasury.permissions.ts` (+34), migration `…_cash_session_close`, `treasury/contract/events.ts`, and the Sales `cash-session-tender-totals` contract query.

Every expected predecessor is present: P1F-2 atomic completion (`bfe7e69`), P1G-0 cash movements (`55e4ae8`), Approval Runtime (`1f9ea1f`), P1G-1 policy substrate (`0f10afe`), P1G-1 Close (`121b889`).

The working tree contains only documentation (one modified `INDEX.md`, four untracked reports). **No source, schema or migration is dirty.** The baseline is trustworthy for a KDS rebase.

> **VERDICT §1 — BASELINE READY.** Verdict E is NOT returned.

### 1.1 Shared-infrastructure drift check (P1G-1)

P1G-1 changed no shared substrate the KDS slice depends on. It *added* (never altered) `Sales → contract/cash-session-tender-totals.query.ts`, two `AUDIT_ACTION` verbs, three `TREASURY_PERMISSIONS` codes, and one migration. `UnitOfWork`, `DomainEventHandlerRegistry`, `IdempotencyInterceptor`, `AuditService.record`, `PrismaService.withAuthContext` and `module-boundaries.spec.ts`'s enforcement rules are all unchanged in shape. **No KDS assumption is invalidated.**

---

## §2. AUTHORITY ORDER APPLIED

Read in the mandated order: (1) `ROS_SRS_v1.0.pdf` (161pp, extracted `pdftotext -layout`, page-cited below); (2) `GOVERNANCE_DECISION_REGISTER.md` (6,827 lines, D-1…D-20 + R-series + unnumbered ratifications); (3) the current repository at `121b889`; (4) accepted P1E/Fire/Kitchen reports; (5) later accepted implementation reports; (6) engineering inference, explicitly labelled.

**Conflicts found between prior reports and current repo — current repo wins in each case:**

| Prior report claim | Current repo | Resolution |
|---|---|---|
| P1E-4 §Q: `cancelled_line_visibility_seconds INT NOT NULL DEFAULT 900` | Column is `Int?`, **nullable, no default** (`schema.prisma:867`) | **Repo wins.** P1E-5 correction removed the invented default. FR-KDS-029 names no default; none may be invented. |
| `kitchen/contract/events.ts` docblock: "No `KitchenModule`, no `Ticket`, and no `TicketLine` exist in this repository" | All three exist since P1E-5 | **Repo wins.** The docblock is stale prose, not a behavioural claim. |
| P1E-4 §U: bump concurrency guarded by `UNIQUE (tenant_id, ticket_id, sequence_no)` | `sequence_no` **was removed** by the P1E-5 acceptance correction; identity is `fire_batch_id` | **Repo wins.** That uniqueness argument no longer applies. |

---

## §3. CURRENT IMPLEMENTATION MATRIX (evidence-backed)

Legend: **C**=COMPLETE · **P**=PARTIAL · **D**=DESIGNED ONLY · **B**=BLOCKED · **N**=NOT IMPLEMENTED.

> A column existing does **not** upgrade a requirement. Every "C" below is a *code path that executes*, not a schema fact.

| # | Element | Class | Evidence |
|---|---|---|---|
| 1 | Routing resolver | **C** | `kitchen/routing/routing-resolver.service.ts` (172 ln), 5-tier FR-KDS-010, `routing-resolver.service.spec.ts` (312 ln) |
| 2 | Multi-station routing | **C** | `order-line-fired.handler.ts:79` `for (const stationId of resolution.stationIds)` — N stations ⇒ N Tickets |
| 3 | Ticket persistence | **C** | `ticket-persistence.service.ts:108-181`, `INSERT … ON CONFLICT DO NOTHING RETURNING` |
| 4 | TicketLine persistence | **C** | `ticket-persistence.service.ts:243-327` |
| 5 | `ticket_fire_batches` | **C** | `ticket-persistence.service.ts:200-241`; `uq_ticket_fire_batches_ticket_fire_batch` |
| 6 | Modifier snapshots | **C** | `ticket-persistence.service.ts:329-354`; keyed on `sourceOrderLineModifierId` |
| 7 | `TicketReaderService` | **P** | `ticket-reader.service.ts` — **single-ticket `getCard(tx, ticketId)` only.** No station query, no queue, no pagination, no HTTP caller. Never invoked in production code. |
| 8 | Kitchen controller | **N** | Zero `*.controller.ts` under `src/modules/kitchen`. `kitchen.module.ts:11` states "No controller". No `/kds*` path in `docs/api/openapi.json`. |
| 9 | `TicketStatus` enum | **P** | `schema.prisma:899-908` full vocabulary exists; **no code writes any value but the `queued` default.** |
| 10 | `TicketLineStatus` enum | **P** | `schema.prisma:914-923`; same — default only. |
| 11 | `created_at` | **C** | Written `order-line-fired.handler.ts:65` |
| 12 | `routed_at` | **C** | Written from `payload.firedAt`, `order-line-fired.handler.ts:63` |
| 13 | `first_viewed_at` | **N** | Columns exist (`schema.prisma:994`, `1106`); **no writer anywhere** |
| 14 | `started_at` | **N** | Columns exist (`995`, `1107`); no writer |
| 15 | `ready_at` | **N** | Columns exist (`996`, `1108`); no writer |
| 16 | `bumped_at` | **N** | Columns exist (`997`, `1109`); no writer |
| 17 | `served_at` | **N** | Columns exist (`998`, `1110`); no writer |
| 18 | `started_by` | **N** | Columns exist (`1011`, `1117`); no writer |
| 19 | `bumped_by` | **N** | Columns exist (`1012`, `1118`); no writer |
| 20 | `recalled_at` | **N** | Columns exist (`1007`, `1115`); no writer |
| 21 | `recall_count` | **N** | Column exists (`1008`); no writer |
| 22 | `cancelled_at` | **N** | Column exists (`1113`); no writer |
| 23 | `recall_window_seconds` | **P** | `branch_kds_config.recallWindowSeconds Int @default(1800)` (`861`). Persisted + SRS-backed default; **never read by any code.** |
| 24 | Cancelled-line visibility config | **P** | `cancelledLineVisibilitySeconds Int?` (`867`) — nullable, **deliberately no default**; never read |
| 25 | `target_ready_at` | **P** | Columns exist (`1002`); **always NULL** — population is FR-KDS-044 `[S]`, deferred |
| 26 | `ticket.bumped` contract | **P** | `kitchen/contract/events.ts:27-41`. Typed only. Payload is `{ticketId, orderId, businessDay}` — **insufficient for UC-POS-01 step 7** |
| 27 | `ticket.bumped` **producer** | **N** | Grep across `src/`: zero `publishEvent({eventType: TICKET_BUMPED_EVENT_TYPE …})`. Only hits are the contract file, its spec, and a string assertion in `module-boundaries.spec.ts:598` |
| 28 | Sales subscriber (`ticket.bumped`) | **N** | Only one production `@DomainEventHandler` exists in the whole repo: `OrderLineFiredHandler` |
| 29 | `order.line.voided` producer | **N** | **The event type does not exist.** Zero hits repo-wide. `AUDIT_ACTION.ORDER_LINE_VOIDED` is an *audit verb*, not a domain event. `voidLinePreFire` does not even run inside `UnitOfWork.execute` (`order-lines.service.ts:532` uses `prisma.withAuthContext` directly) — it has no `publishEvent` available. |
| 30 | Kitchen cancellation subscriber | **B** | Blocked on #29 — no upstream trigger exists |
| 31 | KDS auth / session path | **P** | `TerminalType` includes `kds` (`schema.prisma`); `Session.terminalId` exists; PIN sessions carry `sessionType:'pos'`. **No KDS-specific session type; no per-surface idle TTL** (one flat `JWT_ACCESS_TTL=15m`) |
| 32 | Station binding | **P** | `org.stations.displayTerminalId` exists with a D-16 composite FK to `Terminal(branchId,id)`. **Pure CRUD config** — `grep` finds it only in `stations.service.ts`, `station.view.ts`, the two DTOs and `organisation.controller.ts`. **No guard, no session, no authorization path consults it.** |
| 33 | KDS permissions | **N** | Zero codes match `/kds\|kitchen/i` across all 6 `*.permissions.ts` files. Confirmed absent from SRS §15.2 too (§7 below). |
| 34 | Audit (KDS actions) | **N** | No KDS verb in `AUDIT_ACTION` (`audit.constants.ts:12-166`); no `AUDIT_ENTITY.TICKET` |
| 35 | Idempotency infrastructure | **C** (generic) | `src/common/idempotency/`, global `APP_INTERCEPTOR`, `@Idempotent()` (`idempotent.decorator.ts:13`), `sync.idempotency_keys`, replay ⇒ stored response + `Idempotent-Replay: true`, fingerprint mismatch ⇒ 409. **Not applied to any KDS route (none exist).** |
| 36 | OpenAPI routes (KDS) | **N** | No `/kds` path in the 100-path generated contract |
| 37 | RLS on kitchen tables | **C** | All four ticket tables + both KDS-config tables: `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, tenant-only predicate, fail-closed via `NULLIF(current_setting('app.tenant_id', true),'')` (migration `20260823030000`, ll. 133-368) |

**Summary:** the *substrate* is COMPLETE and unusually well-prepared. The *operator lifecycle* is NOT IMPLEMENTED in its entirety — every one of the seven FR-KDS-040 timestamps beyond `created`/`routed` has a column and no writer.

---

## §4. SOURCE REQUIREMENTS — AS READ FROM THE SRS

Verbatim extraction, page-cited. Numbering is **not contiguous**: only FR-KDS-001, 010–013, 020–031, 040–045 exist. FR-KDS-002…009, 014…019, 032…039 were never allocated.

| ID | M/S/C | Text (verbatim, abbreviated only where marked …) | p. |
|---|---|---|---|
| FR-KDS-001 | M | Define preparation stations per branch: name, display colour, capacity | 62 |
| FR-KDS-010 | M | Route each order line to one **or more** stations by 5-tier precedence | 62 |
| FR-KDS-011 | M | "A single order line SHALL be routable to multiple stations…" | 62 |
| FR-KDS-012 | S | Prep-Time-Aware staggered release | 62 |
| FR-KDS-013 | **S** | Expediter (Pass) display showing complete orders, per-station completion state | 62 |
| FR-KDS-020 | M | Cards: order number, order type, elapsed time, table/customer reference, item lines with quantity and modifiers, preparation notes | 62 |
| FR-KDS-021 | M | Modifiers visually distinguished; removals rendered differently from additions | 62 |
| FR-KDS-022 | M | Colour-coded by elapsed time **against a configurable target**: neutral / amber / red / red-flashing | 62 |
| FR-KDS-023 | M | Sort orders **configurable per station**: FIFO, by target completion time, by order type priority, by course sequence | 63 |
| FR-KDS-024 | M | "Staff SHALL be able to mark an individual item ready ("bump item") or an entire ticket ready ("bump all")." | 63 |
| FR-KDS-025 | M | Recall function restoring the **most recently bumped tickets**, retained for a configurable period (**default 30 minutes**) | 63 |
| FR-KDS-026 | M | Bump actions SHALL require a deliberate interaction (long-press, double-tap, dedicated confirm zone) | 63 |
| FR-KDS-027 | S | Priority flags (rush, VIP, remake) | 63 |
| FR-KDS-028 | S | Amendments appear as a visually distinct update on the existing ticket, audible+visual alert, **never as a new ticket** | 63 |
| FR-KDS-029 | **M** | Cancelled lines struck through and highlighted, with an alert, **remaining visible for a configurable period** | 63 |
| FR-KDS-030 | S | "All-day" counts | 63 |
| FR-KDS-031 | S | Icon-and-image mode | 63 |
| FR-KDS-040 | **M** | "…record the following timestamps **per ticket and per line**: created, routed, first viewed, started, ready, bumped, and served." | 63 |
| FR-KDS-041 | M | Average prep time by item, station, hour, **employee**, order type | 63 |
| FR-KDS-042 | M | "ticket time" = bump − fire; "order time" = last-line-ready − order-open | 63 |
| FR-KDS-043 | S | Bottleneck station per hour | 63 |
| FR-KDS-044 | S | Configurable per-item target prep times, defaulting to recipe `prep_time_seconds` | 63 |
| FR-KDS-045 | C | Capacity warning | 64 |

**NFR (p.64):** NFR-USA-006 `[M]` legible at 2 m / min 24 pt · NFR-PERF-004 `[M]` fired order on station display **within 1 s p95 on the local network** · NFR-REL-002 `[M]` continue to display and accept bumps during a network outage, **buffering bump events locally** · NFR-REL-003 `[M]` local peer discovery when internet is down.

**Security (pp.90-95):** FR-SEC-001 RBAC · FR-SEC-010 predefined roles · FR-SEC-011 custom roles from the catalogue · FR-SEC-012 **plain-language description + sensitive-permission warning marker per permission** · FR-SEC-020 auth methods (PIN = POS terminal) · FR-SEC-021 **PIN valid only on registered terminals within the employee's permitted branches** · FR-SEC-022 PIN hashing/lockout · **FR-SEC-026 idle expiry: 15 min POS, 60 min dashboard, 8 h KDS** · FR-SEC-028 terminals individually registered and revocable.

**Platform (pp.36-37):** FR-PLT-003 immutable `tenant_id` · FR-PLT-010 RLS at the DB layer · FR-PLT-011 app role **NOT** `BYPASSRLS` · FR-PLT-012 **fail closed** without tenant context · FR-PLT-013/014 CI cross-tenant suite + CI failure if any `tenant_id` table lacks enabled+forced RLS.

**API (p.152):** FR-API-020 `Idempotency-Key` on every POST/PATCH, mandatory on financially significant endpoints · 021 store key+fingerprint+response ≥30 days · 022 identical fingerprint ⇒ stored response + `Idempotent-Replay: true` · 023 different fingerprint ⇒ **409**.

**Audit (pp.108-109):** FR-AUD-001 immutable entry for **every state-changing operation** · FR-AUD-002 required entry fields.

**Architecture:** §5.2.3 (mechanically enforced modularity: no cross-module internal import, no cross-module table query, communication via published interface or domain event, `modules/<name>/contract/`) · §5.4 (layer rules) · §5.5.1 (synchronous direct call when the caller needs the result **in the same transaction**) · §5.5.2 (domain events dispatched **by the unit of work within the same DB transaction**) · §5.5.4 event catalogue.

**§5.5.4 — Event Catalogue (Core Subset), the two rows that bind this slice:**

| Event | Publisher | Principal Subscribers |
|---|---|---|
| `order.line.voided` | Sales | **Kitchen Ops**, Inventory, Governance |
| `ticket.bumped` | **Kitchen Ops** | **Sales**, Analytics |

**`ticket.recalled` appears NOWHERE in the SRS** — not in §5.5.4, not anywhere in the 161 pages. Note however the section is titled **"Event Catalogue (Core Subset)"** — the SRS declares the list non-exhaustive. See §14.

**UC-KDS-01 (pp.64-65)** — Preconditions: *"Stations configured; KDS terminals authenticated."* Steps 3–8 and alt-flows 4a/5a/6a are reproduced and analysed in §§9–16 below.

**UC-POS-01 step 7 (p.60):** *"Kitchen prepares and bumps. **System receives ticket.bumped, updates line states to ready.**"* — this is the SOURCE mandate for the Sales readiness subscriber.

**ACT-09 (p.19), verbatim row:** `ACT-09 | Kitchen Staff | One station | KDS`. (Contrast **ACT-10 Head Chef**: `All stations, recipes | KDS + Dashboard`.)

---

## §5. INTERNAL MVP KDS SCOPE — THE THREE-WAY SPLIT

### A. BACKEND OPERATOR LIFECYCLE REQUIRED FOR INTERNAL MVP
Station queue read · full ticket-card DTO · first-viewed · optional start · bump item · bump all · recall · `ticket.bumped` runtime event · Sales multi-station readiness subscriber · audit · idempotency · station authorization · OpenAPI · concurrency tests.

### B. FULL SRS KDS WORK THAT CAN FOLLOW LATER
FR-KDS-012 staggered release `[S]` · FR-KDS-013 Expediter display `[S]` and with it the **serve** action (§16) · FR-KDS-027 priority flags `[S]` · FR-KDS-030 all-day counts `[S]` · FR-KDS-031 image mode `[S]` · FR-KDS-041/042/043 timing & analytics surfaces (§18) · FR-KDS-044 `target_ready_at` population `[S]` · FR-KDS-045 capacity warning `[C]` · FR-KDS-029 cancellation projection **(blocked upstream, §15)** · per-station sort configuration persistence (§17).

### C. CLIENT / OFFLINE WORK THIS BACKEND SLICE CANNOT HONESTLY COMPLETE
FR-KDS-021 visual distinction · FR-KDS-022 colour rendering · FR-KDS-026 long-press/double-tap · FR-KDS-028 audible/visual amendment alert · FR-KDS-029 strike-through/alert rendering · NFR-USA-006 font size · NFR-REL-002 local buffering · NFR-REL-003 peer discovery.

**The readiness target is `fire → display → operate → bump`.** This report does **not** claim global FR-KDS completeness, and §31 predicts the honest post-slice classification.

---

## §6. STATION QUEUE / DISPLAY READ DESIGN

**1. Is station identity a client parameter, terminal-derived, or both with equality validation?**
→ **Both, with equality validation.** `stationId` is an explicit path parameter (a single KDS screen may legitimately display several stations, and the parameter keeps the route addressable and cacheable), **and** it is validated against the terminal-derived bound-station set. The client parameter alone is never trusted.

**2. How does `org.stations.display_terminal_id` interact with authentication today?**
→ **It does not.** It is write-only configuration: created/updated via `POST|PATCH /org/branches/{branchId}/stations` and `/org/stations/{stationId}`, surfaced in `station.view.ts`, and read by **no guard, no session resolver and no authorization path**. Its only structural strength today is the D-16 composite FK `(branchId, displayTerminalId) → Terminal(branchId, id)`, which makes a cross-branch (and therefore cross-tenant) binding **unrepresentable**.

**3. SRS ACT-09 says Kitchen Staff scope is ONE STATION. How is that mechanically enforced today?**
→ **It is not enforced at all.** There is no station concept anywhere in the authorization path.

**4. Does current RBAC only enforce branch scope?**
→ **It does not even enforce branch scope.** `TenantContext.branchId` is declared (`tenant-context.ts:23`) but **reserved and never populated** — D-2 ratified the branch-scoped RBAC deferral, and both `sales.permissions.ts` and `treasury.permissions.ts` state in their docblocks that "no handler consults `TenantContext.branchId`". Authorization today is **tenant-scoped only**; RLS filters tenant only. Branch safety comes from terminal binding and the FR-SEC-021 permitted-branch set, which are identity facts rather than RBAC scoping.

**5. Could a Kitchen user currently request another station's tickets?**
→ **There is no route to request any station's tickets.** If a naive controller were added with a trusted `stationId` parameter, then **yes** — any authenticated same-tenant principal holding the permission could read and operate **any station in any branch of the tenant**, because neither RBAC nor RLS constrains below tenant.

**6. Can station-level enforcement be implemented without inventing a new RBAC system?**
→ **Yes.** Every fact required already exists:

```
Session.terminalId  (identity.sessions, already on AuthenticatedPrincipal/TenantContext)
        ↓
org.stations.display_terminal_id   (D-16 composite FK, same-branch-guaranteed)
        ↓
the set of stations this physical screen is the display for
```

**RECOMMENDED RULE (engineering, no new RBAC):**

> The stations a KDS request may read or operate =
> `{ s ∈ org.stations : s.display_terminal_id = principal.terminalId }`.
> A request whose `stationId` is not in that set ⇒ **403**. An empty set ⇒ **403** (fail closed).
> Every KDS route additionally requires a terminal-bound session, exactly as `OrdersController.requireTerminal` already enforces for every Sales write ("Every Sales WRITE happens at a registered terminal (FR-SEC-028)", `orders.controller.ts:766-773`).

This satisfies ACT-09 exactly when one station points at the terminal, and *naturally* supports the common "one screen, two stations" kitchen without any special case — because `display_terminal_id` lives on the **station**, so N stations may point at one terminal. Tenant safety is structural: `org.stations` is `ENABLE`+`FORCE` RLS with a branch-traversal predicate (`20260816110000_organisation_foundation`, ll. 329-343), so a foreign-tenant station is invisible to the query regardless of the parameter supplied.

**Module boundary:** Kitchen must not query `org.stations` directly. The lookup belongs in a **new Organisation public contract query** — e.g. `StationDisplayBindingQuery.stationsForTerminal(tx, terminalId)` under `modules/organisation/contract/` — precisely mirroring the three queries already published there (`routing-config.query.ts`, `table-display.query.ts`, `branch-currency.query.ts`). This adds **zero** `KNOWN_DEVIATIONS` entries (`kitchen->organisation` is currently `undefined`, `module-boundaries.spec.ts:588-651`).

**Operational precondition (report it; do not ratify it):** a station whose `display_terminal_id` is unset cannot be operated from any KDS screen. This is configuration that FR-KDS-001 and D-16 already contemplate, and the failure mode is a clear 403 rather than silent over-permission.

> **CLASSIFICATION §6 — DESIGN-DECIDABLE.** ACT-09 (SRS) fixes the *requirement*; D-16 + `Session.terminalId` (repo) supply the *mechanism*; the mapping between them is ordinary engineering. **No user ratification required.**

### 6.1 Query shape

```
GET /kds/stations/{stationId}/queue?status=active&sort=fifo&limit=&cursor=
```

Backed by the **already-existing** index `@@index([tenantId, branchId, stationId, status, routedAt])` (`schema.prisma:1034`) — an exact match for the default FIFO ordering, which is what NFR-PERF-004's 1 s p95 needs. `@@index([tenantId, branchId, stationId, targetReadyAt])` (`1036`) already backs the target-time sort for the day FR-KDS-044 populates it.

`TicketReaderService` must gain a `listStationQueue()` alongside `getCard()`, preserving that file's structural self-containment guarantee: an explicit `select` naming **only** `kitchen.*` columns and `kitchen.*` child relations, never `order`/`station`/`orderLine`/`sourceModifier`, each of which is a real Prisma relation that would silently cross into `sales.*`/`catalogue.*` if selected.

The DTO must be widened beyond today's `TicketCardDto` to carry the lifecycle facts the operator UI needs: per-ticket and per-line `firstViewedAt`, `startedAt`, `readyAt`, `bumpedAt`, `recalledAt`, `recallCount`, `cancelledAt`, plus `targetReadyAt` and a server-computed `elapsedSeconds` (§17).

---

## §7. PERMISSION GOVERNANCE — THE PRINCIPAL GAP

### 7.1 Exhaustive source verification

SRS §15.2 (pp.90-93) permission catalogue, fully enumerated: `pos.*` (15 codes), `cash.*` (9), `inventory.*` (10), `menu.*`/`recipe.*` (6), `purchase.*`/`supplier.*` (8), `hr.*` (7), and `report.view.<category>`, `report.export`, `audit.view`, `governance.view_anomalies`, `security.user.manage`, `security.role.manage`, `settings.branch.manage`, `settings.tenant.manage`, `integration.manage`, `api.key.manage`.

> **DEFINITIVE: no code beginning `kds.`, and no code containing "kds" or "kitchen", exists anywhere in the SRS** — verified by exhaustive grep over the full extracted text.

Two aggravating source facts:

1. §15.2 states outright: *"The catalogue below is **representative rather than exhaustive**; the full catalogue is maintained in **Appendix C**."*
2. **Appendix C does not exist in the delivered 161-page document.** The single reference to it is the sentence above.

This is the **exact** situation D-20 confronted and recorded: *"§15.2 supplies no approval-read code — and Appendix C, which §15.2 designates authoritative, is ABSENT from the SRS."* D-20 resolved it by **deferring, not inventing** — because D-14 A-1 had removed the HTTP surface, so no code was actually needed.

**That escape does not exist here.** §15.3 requires Kitchen Staff to be *"KDS only"*, ACT-09 requires them to work a station, and FR-KDS-024/025 `[M]` require bump and recall. A KDS route must exist, and in this repository **every route carries `@RequirePermission`**. A code must therefore be created.

### 7.2 Repository convention — and the two precedents that govern this

The zero-invented-codes discipline is stated in *every* module's permission file. `sales.permissions.ts:3-11`:

> *"Sales permission codes — taken **VERBATIM** from the SRS §15.2 catalogue, except `ORDER_FIRE`… No code is invented from thin air: the same zero-invented-codes discipline D-17-06 imposed on Production Spec applies here, and every route below names an SRS code **or an explicitly governance-ratified one**."*

There are exactly **two** ratified exceptions in the entire repository, and both are the template for this decision:

| Code | Authority | File |
|---|---|---|
| `pos.order.fire` | *"Fire Authorization Ratification — 2026-08-24"* in the governance register | `sales.permissions.ts:41-49` |
| `pos.payment.capture` | *"CARRIED ITEM P1D-F … a NEW code created by explicit user authorisation, **the one recorded exception** to the zero-invented-codes discipline"* | `sales.permissions.ts:51-61` |

So the KDS gap is **narrow and precedented**, not novel. What it is *not* is something this report may decide.

A third convention is decisive for the option analysis. `sales.permissions.ts:20-27`, verbatim:

> *"**WHY READS ALSO USE `pos.order.create`** — §15.2 defines no `pos.order.read`. **Inventing one would break the discipline**; leaving reads unguarded would be worse… Reads therefore sit behind the same capability, and no route grants visibility that `pos.order.create` does not already imply."*

**The established repository answer to "should reads get their own code?" is NO.**

### 7.3 Cost of adding a code

**No migration.** `PermissionDef`s are applied by application code — `PermissionsService.upsertMany` (`permissions.service.ts:36`) and the seed list in `seed-dev-data.ts:97-103`. The `…_PERMISSION_DEFS` arrays are plain TypeScript. Adding a KDS code touches: a new `src/modules/kitchen/kitchen.permissions.ts`, the `seed-dev-data.ts` spread list, and the route decorators. **Zero DDL.**

FR-SEC-012 `[M]` requires a plain-language `description` per permission — the `PermissionDef.description` field already carries this, and any new code must supply one.

### 7.4 THE OPTIONS

#### OPTION A — one coarse permission: `kds.operate`
Covers view, first-viewed acknowledgement, start, bump item, bump all, recall.

| Criterion | Assessment |
|---|---|
| Least privilege | Adequate. The blast radius is one station's queue, structurally bounded by §6's terminal binding — **not** by the permission. A Kitchen Staff member who can bump can already recall (see below), so splitting buys no real containment. |
| Usability | **Best.** One switch labelled "Kitchen display". Matches §15.3's own one-line role character *"KDS only"* literally. |
| Role seeding | Trivial and unambiguous. |
| Future extensibility | **Good.** A later Expediter slice adds `kds.expedite`; a later analytics slice adds `report.view.kitchen` (already an SRS shape). Neither breaks an existing role, because adding a code never removes authority from one. |
| Station-scoped actor model | Correct fit — station scope is enforced by terminal binding (§6), which is where it belongs; duplicating it in the permission vocabulary would be misleading. |
| Audit attribution | Unaffected — attribution comes from `bumped_by`/`started_by` and the audit entry's `actor_id`, never from the permission. |
| Admin complexity | Minimal — 1 checkbox. |
| Custom-role usability (FR-SEC-011) | Good: a tenant building "Grill Lead" ticks one box. |
| Migration/seeding cost | 1 `PermissionDef`. |

#### OPTION B — two-level: `kds.view` + `kds.operate`
| Criterion | Assessment |
|---|---|
| Least privilege | Marginal gain. A read-only KDS role is a *plausible* future need (a manager's wall display), but **no SRS requirement asks for one** — FR-KDS-013's Expediter display is `[S]` and deferred, and ACT-10 Head Chef is characterised as *"KDS, recipes…"*, not "KDS read-only". |
| **Repository precedent** | **Directly contradicted.** `sales.permissions.ts:20-27` explicitly refuses to invent a read code and puts reads behind the write capability. Option B invents exactly the code that precedent refuses. |
| Usability | Slightly worse — admins must understand why two boxes exist when every operator needs both. |
| Verdict | Rejected on repository precedent, not on principle. If a read-only wall display is later required, `kds.view` can be added **then**, with a real consumer — matching the repo's own rule that "this repository seeds a permission only where an executable consumer exists" (`treasury.permissions.ts:17-22`). |

#### OPTION C — granular: `kds.ticket.view` / `.start` / `.bump` / `.recall` / `.serve`
| Criterion | Assessment |
|---|---|
| Least privilege | Highest on paper. |
| Usability | **Worst.** Five switches for a role the SRS describes in two words. Directly against the stated product preference. |
| Does start deserve separation? | **No.** UC-KDS-01 step 4 makes marking-started *"optional configuration"*; a permission for an optional convenience action is micromanagement. |
| **Does recall deserve separation?** | **No — and this is source-decided.** UC-KDS-01 **alternate flow 4a**, verbatim: *"Wrong bump: **staff** uses recall to restore the ticket within the retention window."* The SRS assigns recall to **staff**, not to a supervisor. Recall is the *correction half of bumping*, performed by the same person seconds later. Separating it would mean the cook who mis-bumps must fetch a manager — the precise operational failure FR-KDS-026's accidental-bump rationale is worried about. |
| Does served deserve separation? | Moot for this slice — serve is deferred with FR-KDS-013 `[S]` (§16). When it lands it is a **different actor at a different station** (Expediter/Pass), which is a genuine separation and argues for a *later* `kds.expedite`. |
| Does Head Chef need broader authority than Kitchen Staff? | Per §15.3 the difference is **breadth of scope** ("All stations" vs "One station") and **other modules** (recipes, waste, inventory view) — **not** a stronger KDS verb. Under §6 that breadth is expressed by terminal binding and by the recipe/inventory codes that already exist, not by a KDS permission tier. |
| Verdict | Rejected — five codes to express what the source expresses in one capability, with no source-backed separation surviving scrutiny. |

### 7.5 RECOMMENDATION

> **OPTION A — a single new permission code `kds.operate`**, description *"Operate a kitchen display station"*.

It is the only option consistent with **all four** governing constraints simultaneously: the SRS's own two-word role character (§15.3 "KDS only"), the repository's refusal to invent read codes (`sales.permissions.ts:20-27`), the SRS's assignment of recall to *staff* (UC-KDS-01 4a), and the stated product preference for admin simplicity without permission micromanagement. It is future-expandable in the direction the SRS actually points — `kds.expedite` when FR-KDS-013 lands — rather than in speculative directions.

**NOT RATIFIED. See §20 Decision 1.**

---

## §8. STANDARD ROLE CONSEQUENCE

**Material finding first:** *no migration and no production code path seeds the SRS §15.3 standard roles at all.* The only role seeding in the repository is `src/scripts/seed-dev-data.ts`, a manual development script creating an ad-hoc "Owner"/"Cashier" pair. FR-SEC-010 `[M]` ("SHALL ship predefined roles") is therefore **NOT IMPLEMENTED** today — a pre-existing gap this slice neither creates nor closes.

**Consequence:** the KDS slice should seed the **`PermissionDef` only**, exactly as every prior slice did. It must **not** silently edit role semantics — there are no role rows to edit. The mapping below is therefore a **recorded intent for the future FR-SEC-010 role-seeding slice**, submitted as part of the decision packet, not as work in this slice.

| §15.3 Role | Scope (§15.3) | Character (§15.3, verbatim) | Proposed `kds.operate` |
|---|---|---|---|
| **Kitchen Staff** | Branch | *"KDS only"* | **YES** — and, per §15.3, essentially its *only* grant |
| **Head Chef** | Branch(es) | *"KDS, recipes, waste, inventory view"* | **YES** — breadth ("All stations", ACT-10) comes from terminal binding, not a second code |
| **Branch Manager** | Branch | *"Full branch operations, approvals within band"* | **YES** |
| **Shift Supervisor** | Branch | *"Approvals within a lower band, no configuration"* | **YES** — an operational, non-configuration capability |
| **Owner** | Tenant | *"All permissions"* | **YES** (by definition) |

Not proposed for: Cashier, Waiter, Storekeeper, Purchasing Officer, Accountant, HR Officer. **Auditor** (*"Read-only everything"*) is deliberately excluded — under Option A the code confers write authority, and the Auditor's read need is an `audit.view`/reporting concern, not a KDS operator capability.

---

## §9. FIRST-VIEWED SEMANTICS

FR-KDS-040 `[M]` requires a *first viewed* timestamp **per ticket AND per line**. Both columns exist (`schema.prisma:994`, `1106`); neither has a writer. P1E-4 proposed only *"first KDS read of the ticket by a station display — write-once"* and designed no mechanism.

### Option analysis

**A. `GET` queue marks unseen rows viewed.** Rejected.
- Violates HTTP semantics: a safe method acquires a side effect. Every proxy, retry, prefetch and browser refresh becomes a write.
- Unusable with the idempotency infrastructure, which is `@Idempotent()`-scoped to POST/PATCH; FR-API-020 attaches to POST/PATCH only, so a mutating GET is **outside** the repo's replay protection entirely.
- A KDS display polls this route continuously to satisfy NFR-PERF-004. Turning the hot read path into a write path costs a row lock on every ticket on every poll — the worst possible interaction with the 1 s p95 budget.
- Audit-hostile: FR-AUD-001 requires an entry for every state-changing operation. A polling display would generate an unbounded audit stream.

**B. Separate `POST …/view` acknowledgement.** **RECOMMENDED.**
- Keeps `GET` safe and cacheable; keeps the hot path read-only.
- Honest semantics: the *display* asserts "these tickets became visible to a human", which is exactly what FR-KDS-040 records and what FR-KDS-041's prep-time analysis will consume.
- Write-once by construction: `SET first_viewed_at = :now WHERE first_viewed_at IS NULL` is idempotent **at the database level**, so concurrent displays and client retries converge with no lock, no CAS and no error. A replay is a 0-row update, not a conflict.
- Batched: one call carries the ticket ids newly rendered, so a busy station produces a handful of writes per minute rather than one per poll.
- Because the write is naturally idempotent and carries no financial weight, `Idempotency-Key` is **accepted but not required** here (FR-API-020's "mandatory" clause attaches to *financially significant* endpoints).

**C. Station-display session acknowledgement.** Rejected for MVP — it presumes a display-session entity that does not exist, and would need schema. It is the natural home for this *if* an offline KDS session model is later built; Option B is forward-compatible with it because the acknowledgement is already an explicit, batched, client-driven command.

### Recommended semantics
Ticket and line are set **together in one transaction**: acknowledging a ticket sets `tickets.first_viewed_at` and every one of its `ticket_lines.first_viewed_at` where currently NULL. FR-KDS-040 requires both, and no requirement describes viewing an individual line independently of its card. **Write-once, never overwritten, never cleared — a recall does not reset it** (the ticket genuinely was seen).

**No `first_viewed_by`.** P1E-4 §R deliberately omitted it: no requirement attributes *viewing* to an employee, and FR-KDS-041's "by employee" attaches to prep time (`started_by`/`bumped_by`), not to viewing. Adding it would be speculation.

**Audit:** first-viewed is **not** individually audited. It is a display-progress observation, not an operational state change; FR-AUD-001's "state-changing operation" is doing real work here, and auditing every acknowledgement would be exactly the duplicate-noise §24 warns against. *(Engineering judgement, recorded explicitly so a reviewer can disagree.)*

> **CLASSIFICATION §9 — DESIGN-DECIDABLE.** The SRS fixes the *fact to record*; it is silent on API mechanics. Option B is recommended on engineering grounds and labelled as such.

---

## §10. START SEMANTICS

UC-KDS-01 step 4: *"Grill staff long-press to mark started (**optional configuration**), then long-press to bump when done."* FR-KDS-040 `[M]` nonetheless requires a *started* timestamp per ticket and per line.

Revalidated against current schema — P1E-4's accepted semantics survive unchanged:

| Question | Answer | Basis |
|---|---|---|
| Explicit item start? | **Yes** — line-level `POST …/lines/{lineId}/start` | FR-KDS-024's unit of work is the item; `started_by` is per-line (`schema.prisma:1117`) |
| Ticket start? | **Not a separate action.** `Ticket.status = in_progress` and `tickets.started_at`/`started_by` are set by the **first** line start, in the same transaction | P1E-4 §N: *"`in_progress` — at least one line `started`, not all lines terminal"* |
| Both? | Both **columns** are written; only one **action** exists | FR-KDS-040 requires the timestamp on both; it does not require two commands |
| Optional route? | The route always exists; **using it is optional**, per the branch's configuration and the operator's habit | UC-KDS-01 step 4 |
| Bump directly from `queued`? | **Legal.** `queued → bumped` is an accepted transition | P1E-4 §N transition table |
| Does `started_at` stay NULL when skipped? | **Yes, permanently.** Bump never back-fills it | P1E-4 §O. FR-KDS-041 then measures prep as `routed_at → ready_at` — a wider but honest window |
| `started_by` preservation | Write-once. A second start on an already-started line is a no-op that overwrites nothing | Mirrors the bump replay rule (§11) |
| Ticket projection when one line starts | `queued → in_progress`, `tickets.started_at`/`started_by` set if NULL — same transaction | P1E-4 §N |

**No new configuration column is proposed** for "is start enabled". `branch_kds_config` could carry one, but FR-KDS-040 names no such flag and UC-KDS-01's "optional configuration" is satisfied by the client simply not offering the gesture. Adding a column would be inventing configuration the source does not require — and would force a migration (§25).

---

## §11. BUMP ITEM / BUMP ALL

Revalidated against the current schema. P1E-4 §O survives, with one correction (its `sequence_no` uniqueness argument was voided by the P1E-5 correction, §2).

### BUMP ITEM — `POST /kds/tickets/{ticketId}/lines/{lineId}/bump`

- Target must be one eligible `TicketLine` on a ticket at a station bound to the caller's terminal (§6).
- Sets **`ready_at` and `bumped_at` to the same authoritative action time** — one `now` captured once by the service, not `DEFAULT now()`, not a client value (§23). FR-KDS-024 names one gesture ("mark an individual item **ready**") that FR-KDS-042 measures as a **bump**; the two facts are simultaneous by construction, and separating them would invent an intermediate state the source does not describe.
- `bumped_by` = the trusted employee from the session (`principal.employeeId`), **never** from the body — the identical rule `OrdersController.requireTerminal` and `TreasuryController.requirePosIdentity` already enforce.
- `status → bumped`.
- A `cancelled` line **cannot** be bumped ⇒ 422.
- A line already `bumped` or `served` is a **replay**: left untouched, **no timestamp overwritten, no error** (200 with current state).
- Ticket projection recomputed **in the same transaction** (below).

### BUMP ALL — `POST /kds/tickets/{ticketId}/bump-all`

- For every line **not** already `bumped`/`served`/`cancelled`: set `ready_at`, `bumped_at`, `bumped_by`, `status = bumped` — all sharing the one action instant.
- **Already-bumped lines are left exactly as they are.** Their original `bumped_at` and `bumped_by` are preserved. P1E-4's reasoning is correct and load-bearing: *"a cook who bumped their own item at 12:03 must not be retroactively replaced by the expediter who bumped-all at 12:07"* — FR-KDS-041 `[M]` requires per-employee attribution, and overwriting would silently corrupt a mandatory metric.
- Cancelled lines skipped.
- Ticket projection recomputed once, same transaction.

### Ticket projection rule (maintained column, not derived-on-read)

```
in_progress ⇐ ≥1 line started, not all terminal
ready       ⇐ every NON-CANCELLED line is ready or beyond   → set tickets.ready_at if NULL
bumped      ⇐ every NON-CANCELLED line is bumped or beyond  → set tickets.bumped_at, bumped_by
```
A ticket **all** of whose lines are cancelled is **not** "bumped" — it holds its status and the display strikes it through. Maintained rather than derived because FR-KDS-023 sorts and filters the queue by status and NFR-PERF-004's 1 s p95 argues against an aggregate-per-read; it must remain **reconcilable** from the line rows, which is a test obligation (§26).

### Concurrency mechanism — and the proof

**No locks.** SRS §24.6.4 confines pessimistic locking to two named cases — order-number allocation and count-session exclusivity — and neither is bumping. No advisory lock is introduced.

The mechanism is a **conditional UPDATE whose WHERE clause is the preconditions** (compare-and-swap on state, not on a version counter), which is precisely the `updateMany({where:{…, version:expected}})` + `count===0` pattern P1E-6 already established for `orders.version`:

```sql
UPDATE kitchen.ticket_lines
   SET status='bumped', ready_at=$now, bumped_at=$now, bumped_by=$actor
 WHERE tenant_id=$t AND id=$line
   AND status IN ('queued','started','ready')     -- excludes bumped/served/cancelled
RETURNING …
```

- **Two cooks bump the SAME line.** Both statements target one row; PostgreSQL serialises them on the row lock. The first commits with `status='bumped'`. The second re-evaluates its `WHERE` against the updated row, matches **zero** rows, and returns nothing — the service reports the replay outcome. **The original `bumped_at`/`bumped_by` are preserved; no lost update, no error, no retry loop.**
- **Two cooks bump DIFFERENT lines on the same ticket.** The two line UPDATEs touch disjoint rows and do not block each other. Both then recompute the ticket projection. **This is the only genuine lost-update risk in the slice**, because both may read "not all lines bumped" before either commits. It is closed by making the ticket projection itself a conditional UPDATE with `tickets.version` as the CAS token — `WHERE id=$ticket AND version=$read` , `SET version=version+1` — and, on a 0-row result, **re-reading the lines and retrying the projection** (bounded, e.g. 3 attempts). The line facts are already durably committed; only the derived projection retries, so no operator action is ever lost or duplicated. This is exactly the role `tickets.version` was reserved for (`schema.prisma:983-985`, "§24.6.4 optimistic concurrency … updated by concurrent bump/recall operations") and it has **no writer today**.
- **Bump item vs bump-all.** Bump-all issues one conditional UPDATE over the ticket's lines with the same `status IN (…)` guard, so a concurrently bumped line is simply outside its match set and retains its own actor. Then the same projection CAS.

> All of this operates on the existing schema. **No lock, no new column, no advisory lock, no migration.**

---

## §12. `ticket.bumped` — FINAL v1 CONTRACT

### Trigger rule — revalidated, and **changed** from P1E-4's recommendation on one point

P1E-4 recommended *"only on aggregate ticket bump"*, classified NOT SOURCE-DECIDABLE. Its two reasons remain sound: §5.5.4 names the event `ticket.bumped`, not `ticket.line.bumped`, and its subscribers are consumers of a ticket-completion fact. UC-KDS-01 step 5 ("records `ready_at` for that line and publishes `ticket.bumped`") describes a **single-line** Grill ticket, so the line bump *is* the ticket bump there — the step discriminates neither reading.

**Confirmed: publish only when the Ticket transitions to `bumped`** — whether reached by bump-all or by the last outstanding line being bumped individually. An item bump that leaves other lines outstanding publishes nothing.

> **Revalidation caveat.** P1E-4's supporting argument was that per-line publication *"makes Sales receive N events per ticket with no way to tell which was the last"*. Under the payload below that argument is now **weaker**, because the payload carries `readyOrderLineIds` and is self-describing. The recommendation is retained on the **stronger** ground: §5.5.4 names the event's *subject* as the ticket, and publishing a ticket-scoped event on a non-ticket-scoped transition would misrepresent the contract. **Classification remains NOT SOURCE-DECIDABLE — engineering choice, recorded knowingly.**

### v1 payload

```ts
export interface TicketBumpedPayload {
  readonly ticketId: string;
  readonly orderId: string;
  readonly businessDay: string;        // 'YYYY-MM-DD' — network-ready, P1E-1A
  readonly stationId: string;          // ADDED — which station completed
  readonly bumpedAt: string;           // ADDED — ISO-8601; NFR-REL-002 original-timestamp preservation
  readonly orderLineIds: readonly string[];      // ADDED — every line on this ticket
  readonly readyOrderLineIds: readonly string[]; // ADDED — see §13; the load-bearing field
}
```

`ticketId`/`orderId`/`businessDay` are unchanged from the shipped stub. `stationId`, `bumpedAt`, `orderLineIds` are the P1E-4 recommendation. **`readyOrderLineIds` is new in this gate** and is what makes §13 solvable without a cross-module query.

Envelope fields (`eventId`, `eventType`, `eventVersion`, `occurredAt`, `recordedAt`, `tenantId`, `branchId`, `actorId`, `actorType`, `correlationId`, `causationId`, `idempotencyKey`) are supplied by `UnitOfWork.publishEvent` and are **not** re-declared in the payload — `tenantId` in particular is forced from the trusted `AuthScope` and cannot be overridden by the publisher.

`TICKET_BUMPED_EVENT_VERSION` stays **1**: nothing has consumed the stub, so widening the payload breaks no consumer.

**No broker. No outbox.** §5.5.2 makes this an in-transaction effect; the outbox is for *external* delivery (UC-POS-01 alt 6a), which this is not.

---

## §13. SALES READINESS SUBSCRIBER — THE MULTI-STATION PROBLEM

### The requirement and the trap

UC-POS-01 step 7 `[SOURCE]`: *"System receives `ticket.bumped`, updates line states to ready."*
FR-KDS-011 `[M]`: one order line may be routed to several stations.

⇒ **A single station's bump MUST NOT mark the Sales line ready while another station still has that same order line outstanding.** A burger routed to Grill and Packaging is ready only when both have bumped.

P1E-4 §X item 26 recorded this as SOURCE-DECIDED but left the mechanism *"out of scope"*, and no prior report ever proposed one. **This gate closes it.**

### Why the obvious answers are wrong

- **Sales queries Kitchen** ⇒ violates §5.2.3 ("A module MUST NOT query another module's tables") and would add a `sales->kitchen` deviation. Rejected.
- **Kitchen queries Sales** ⇒ same violation in reverse, and `module-boundaries.spec.ts:1019-1026` mechanically forbids it: a regex scan asserts Kitchen contains **zero** direct Prisma calls against `order`/`orderLine`/`orderLineModifier`/`modifier`/`menuItem`/`category`. Rejected.
- **Sales keeps its own "stations pending" counter** ⇒ requires Sales to know the *resolved* station set, which is Kitchen's FR-KDS-010 output, not Sales' input (tier-1 overrides are Sales-owned, tiers 2-5 are Organisation config resolved by Kitchen). Sales would have to duplicate the resolver. Requires a migration. Rejected.

### The solution: Kitchen already holds the answer

**Kitchen owns every `TicketLine` for the order, across every station.** For any `order_line_id`, Kitchen can see all of its station rows in one query — and the index for exactly this shape **already exists**:

```
@@index([tenantId, orderLineId, businessDay])     -- schema.prisma:1140
```

So, inside the same bump transaction, Kitchen computes for each `orderLineId` on the bumped ticket:

```sql
SELECT order_line_id
  FROM kitchen.ticket_lines
 WHERE tenant_id = $t AND business_day = $d AND order_line_id = ANY($lines)
 GROUP BY order_line_id
HAVING bool_and(status IN ('bumped','served') OR status = 'cancelled')
   AND bool_or(status IN ('bumped','served'))     -- not an all-cancelled line
```

The result is `readyOrderLineIds` — the order lines that are **fully** complete across **every** station. Kitchen answers a Kitchen question using only Kitchen tables; Sales answers a Sales question using only Sales tables.

### The Sales subscriber

```ts
@Injectable()
@DomainEventHandler(TICKET_BUMPED_EVENT_TYPE)   // imports kitchen/contract — a PUBLIC surface
export class TicketBumpedHandler { … }
```

It sets `state='ready'` and `ready_at = payload.bumpedAt` on exactly `payload.readyOrderLineIds`, guarded so it never regresses a line already `served` and never touches `voided`/`comped`. **`sales.order_lines.state` already has `ready`, and `sales.order_lines.ready_at` already exists** (`schema.prisma:1913`) with **no writer today** — so this needs **no migration**.

This mirrors `OrderLineFiredHandler` exactly, in the opposite direction: a private handler in the consuming module, discovered by `DiscoveryService` via the `@DomainEventHandler` metadata key, importing only the producer's public `contract/`. `KNOWN_DEVIATIONS['sales->kitchen']` stays **undefined**. §5.2.3 is satisfied.

**No public Kitchen contract query is required.** The event payload is sufficient — which is the outcome §13 of the prompt asked to be established before designing one.

### Transaction boundary — and the rollback proof

```
POST /kds/tickets/{id}/bump-all
  └─ UnitOfWork.execute(scope, fn)                     ← ONE PrismaService.withAuthContext $transaction
       ├─ fn(ctx):  line CAS updates
       │            ticket projection CAS
       │            compute readyOrderLineIds
       │            AuditService.record(ctx.tx, …)
       │            ctx.publishEvent(ticket.bumped)     ← queued, not yet dispatched
       └─ dispatcher.drain(ctx)                         ← still INSIDE the same transaction
            └─ TicketBumpedHandler → UPDATE sales.order_lines
                                                        ← COMMIT here, once, for all of it
```

**Rollback proof:** `TransactionalDomainEventDispatcher.drain` awaits each handler sequentially and catches nothing. A throw from the Sales handler propagates out of `drain`, out of the `withAuthContext` callback, and Prisma's `$transaction` **rolls back the Kitchen bump, the ticket projection, the audit entry and the Sales update together** (`unit-of-work.ts:51-53`, verbatim: *"A handler's rejection propagates out of `drain`, out of this callback, causing `$transaction` to roll back the whole thing"*). There is no state in which Kitchen believes a ticket is bumped and Sales does not. This is §5.5.2's guarantee, already proven in production by the Fire path.

**Order version:** the Sales handler should **not** bump `orders.version`. `version` is the cashier's optimistic-concurrency token for *content* edits, and a fired line cannot be edited by a cashier anyway (`assertCashierMayMutateLine`). Bumping it would inject spurious 409s into the POS from a different actor entirely, with no correctness gain. *(Engineering judgement — DESIGN-DECIDABLE.)*

---

## §14. RECALL

Revalidated against current schema (`recalled_at`, `recall_count`, `recall_window_seconds` all present, none written).

| Question | Resolution | Class |
|---|---|---|
| Ticket recall or line recall? | **Ticket only.** FR-KDS-025 says "restoring the most recently bumped **tickets**". No line-level recall. | **SOURCE-DECIDED** |
| Allowed source state | `status = 'bumped'` **only**. Recalling anything else ⇒ 422 invalid transition (not a silent no-op) | SOURCE-DECIDED (state) / engineering (error shape) |
| Window clock source | `now() - bumped_at <= recall_window_seconds`, evaluated **server-side at the recall attempt** | Engineering |
| Window configuration | `branch_kds_config.recall_window_seconds`, `DEFAULT 1800` | **SOURCE-DECIDED** — FR-KDS-025 states "default 30 minutes" explicitly. The governance register itself cites FR-KDS-025 as an example of a requirement that *does* supply its default (register l. 6114). |
| Status after recall | `in_progress` if any line has `started_at`, else `queued`. `tickets.status` also has a `recalled` value — used as the **display flag**, with `recall_count > 0` as the durable fact | Engineering (P1E-4 §P) |
| Line states after recall | `bumped → started` (if `started_at` set) else `queued`. No `cancelled` line is touched | Engineering |
| Is `ready_at` preserved? | **Yes.** *"The work was genuinely done; only the ticket's presence in the active queue is restored."* | Engineering |
| Is `bumped_at` preserved? | **Yes — never cleared.** FR-KDS-042 `[M]` defines ticket time as bump − fire; clearing it would destroy the only input to a mandatory metric | **SOURCE-CONSTRAINED** |
| `recalled_at` | Set to the recall instant, ticket and lines | Engineering |
| `recall_count` | `+1` per recall. Flags a ticket whose FR-KDS-042 ticket time is **not a clean measurement** | Engineering |
| Re-bump after recall | Legal — ordinary bump path; overwrites `bumped_at`/`bumped_by` with the new bump | Engineering |
| Second recall after re-bump | Legal; `recall_count` → 2 | Engineering |
| Idempotency / conflict | Recall is **not** naturally idempotent (it increments a counter), so `Idempotency-Key` is **REQUIRED** on this route — a network retry must not double-count | Engineering, FR-API-020 |
| Known lossiness | With single `recalled_at`/`bumped_at` columns, bump→recall→re-bump retains only the latest of each. Full history needs a `ticket_state_events` table. **No requirement asks for it — DEFERRED**, and `recall_count` is the honest flag | P1E-4 §P, unchanged |

### The cross-module consequence — the real problem

**This is the one place where recall stops being a Kitchen-internal concern.**

Under §13, when a ticket bumps, Sales sets the affected order lines to `ready`. If that ticket is then recalled, **Sales still says `ready` while the kitchen has pulled the food back**. Operationally that is a waiter collecting food that is not ready — a real defect, not a cosmetic drift.

Constraints:
- **`ticket.recalled` is NOT in the SRS.** Zero occurrences in 161 pages, and it is absent from §5.5.4.
- **But §5.5.4 is titled "Event Catalogue (Core Subset)"** — the SRS declares the list non-exhaustive on its face.
- The consequence materially changes POS behaviour, which is exactly what the prompt says must be flagged rather than decided quietly.

Three options, analysed in §20 Decision 2. **This report does not invent the event.** It is escalated.

---

## §15. CANCELLATION / `order.line.voided`

FR-KDS-029 is `[M]`. §5.5.4 names `order.line.voided` with **Kitchen Ops as a principal subscriber**. So the requirement and the event are both source-backed.

### Upstream audit — the blocker

> **`order.line.voided` does not exist in this repository in any form.** Not as a type in `sales/contract/events.ts`, not as a publisher, not as a route effect. Zero hits repo-wide.

Worse, the only void path is structurally **pre-fire only**:

- `DELETE /orders/{businessDay}/{id}/lines/{lineId}` → `OrderLinesService.voidLinePreFire` (`order-lines.service.ts:524-611`).
- It is gated by `assertCashierMayMutateLine`, which throws for any line in `SENT_TO_PRODUCTION` = `{fired, preparing, ready, served}` (`order-state.ts:57-59, 167-173`).
- The controller docblock states the position outright (`orders.controller.ts:700-708`): *"Once a line is fired this returns 422: the post-fire path is privileged and **no ratified permission authorises it**, so it is not implemented rather than approximated."*
- `pos.order.void_line_postfire` **exists in SRS §15.2** and is deliberately **not** seeded (`sales.permissions.ts:32-39`).
- The method does not even run inside `UnitOfWork.execute` — it calls `prisma.withAuthContext` directly (`order-lines.service.ts:532`), so it has **no `publishEvent` available at all**.

**A line can only be cancelled in Kitchen if it was fired. A fired line cannot currently be voided. Therefore FR-KDS-029 has no reachable trigger.**

> **Per the prompt's explicit instruction: no post-fire void path is fabricated to make KDS green.** Building one would require a new privileged Sales route, the `pos.order.void_line_postfire` permission, waste-disposition semantics (UC-KDS-01 6a: *"the POS prompts for waste disposition"*), an Inventory effect, and a Governance subscriber — an entire slice of its own, and one the register has repeatedly declined to open.

### Designed-but-not-built Kitchen subscriber (design is source-ready even though the trigger is not)

When a post-fire void slice lands, the Kitchen subscriber semantics are already fixed:

- **Never delete the `TicketLine`.** Backed at the database level by `onDelete: Restrict` on the `sales.order_lines` FK (`schema.prisma:1127`).
- `status = 'cancelled'`, `cancelled_at` set.
- **Preserve prior `ready_at`/`bumped_at`.** UC-KDS-01 6a prompts for waste disposition — the food was made and the record must say so.
- A `served` line may still be cancelled (late void); `cancelled` is terminal.
- Cancelled lines **remain visible** and are **excluded from the ready/bumped aggregate** (§11) — one cancelled line must not block a ticket from becoming ready.

### Visibility duration in the read DTO

`branch_kds_config.cancelled_line_visibility_seconds` is `Int?` — **nullable with no default, deliberately**. FR-KDS-029 `[M]` requires configurability but, unlike FR-KDS-025, **names no default value**, and P1E-5's acceptance correction explicitly removed P1E-4's invented 900 s.

> **No default is invented here either.** The queue DTO should expose the configured value verbatim — `cancelledLineVisibilitySeconds: number | null` — alongside each line's `cancelledAt`, and let the client compute visibility. `null` means "not configured", and the honest client behaviour for `null` is to keep the line visible until the ticket leaves the queue rather than to guess a duration.

> **CLASSIFICATION §15 — BLOCKED upstream.** FR-KDS-029 cannot be completed by this slice. Persistence and DTO support are ready; the trigger is not. **Not a KDS design blocker** — it is a Sales scope boundary, and it does not block the rest of the operator lifecycle.

---

## §16. SERVED SEMANTICS

The tension, stated precisely:

- **FR-KDS-040 `[M]`** names a *served* timestamp per ticket and per line.
- **UC-KDS-01 step 8:** *"Expediter bumps the order. System sets all order lines to served, computes order time, and notifies the POS."*
- **FR-KDS-013 — the Expediter (Pass) display — is `[S]`.**

So the *timestamp* is mandatory but its **only** described producer is a Should-have display.

### Analysis

The prompt is right that a stored `served_at` column does not satisfy FR-KDS-040. But the inverse trap is equally real: shipping a `POST /serve` route with no Expediter display, no per-station completion view (FR-KDS-013's actual content), and no defined actor would be **appearance without capability** — precisely the failure `treasury.permissions.ts:17-22` articulates as the reason it refuses to seed permissions without an executable consumer.

Three further facts push the same way:
1. P1E-4 §R deliberately added **no `served_by`** — *"no requirement attributes viewing or serving to an employee"* — so a serve action has no actor attribution to record, unlike bump.
2. UC-KDS-01 step 8 says serve sets **all order lines** to served and *"notifies the POS"* — i.e. it is an **order-level, cross-module** action, not a station-level one. It is much closer in shape to the Sales readiness subscriber than to a bump, and its Sales-side effect (`state='served'`) has the same "column exists, no writer" status.
3. §15.3 gives no role a "expediter" character, and ACT-09/ACT-10 name no Expediter actor — the SRS's Expediter appears only inside the `[S]` use-case narrative.

### Recommendation

> **Leave `served` UNIMPLEMENTED in this slice and classify FR-KDS-040 honestly as PARTIAL.**

Concretely: implement `created`, `routed`, `first viewed`, `started`, `ready`, `bumped` — six of the seven, on **both** ticket and line — and record `served` as the one outstanding timestamp, tied to FR-KDS-013 `[S]`.

**Could serve be added cheaply without the full Expediter UI?** Mechanically, yes — one route, one conditional UPDATE, no migration. **But it should not be**, for three reasons: the actor is undefined (no `served_by`, no role, no permission), its mandated effect is order-wide and crosses into Sales (widening this slice's blast radius materially), and there is no display from which anyone could invoke it. Shipping it would let FR-KDS-040 be *claimed* complete while the operation remains unreachable — the exact dishonesty §31 is meant to prevent.

**Forward compatibility is preserved:** `served_at` columns exist on both tables, `TicketStatus.served`/`TicketLineStatus.served` exist, `sales.order_lines.state` has `served`, and the bump projection already treats `served` as "beyond bumped". The later Expediter slice adds a route, a `kds.expedite` permission and a Sales effect — **no migration, no contract break.**

---

## §17. SORTING / TARGET / COLOUR SUPPORT

### Substrate audit

| Field | State | Usable for sorting today? |
|---|---|---|
| `routed_at` | **Populated** (`payload.firedAt`) | **YES** — real values |
| `target_ready_at` | Column exists, **always NULL** — population is FR-KDS-044 `[S]`, unimplemented | **NO** |
| `order_type_snapshot` | **Populated** `VARCHAR(32)` | Partially — see below |
| `course` | Populated per line, **nullable** (optional at POS, UC-POS-01 step 5) | Partially |
| Indexes | `[tenantId, branchId, stationId, status, routedAt]` and `[tenantId, branchId, stationId, targetReadyAt]` | FIFO fully covered; target covered for the day it has values |
| `branch_kds_config` | Exists — but carries only `fallback_station_id`, `recall_window_seconds`, `cancelled_line_visibility_seconds` | **No sort configuration column exists** |

### FR-KDS-023's four modes, honestly assessed

| Mode | Can it work TODAY with real values? |
|---|---|
| **Oldest first (FIFO)** | **YES** — `routed_at`, indexed |
| **By target completion time** | **NO.** `target_ready_at` is universally NULL. Claiming this mode complete would be claiming a sort over an empty column. |
| **By order type priority** | **PARTIAL.** `order_type_snapshot` holds real values, but *"priority"* implies an ordering **over** order types that no requirement, table or configuration defines. Inventing one (delivery > takeaway > dine-in?) is unsupported. |
| **By course sequence** | **PARTIAL.** `course` is real but nullable, and it is a **line** attribute while FR-KDS-023 sorts **tickets** — a ticket with lines in courses 1 and 3 has no single course. The ticket-level projection rule is undefined by source. |

### A second, independent gap

FR-KDS-023 requires sort order **"configurable per station"**. There is **no per-station configuration store**: `branch_kds_config` is keyed by `branch_id`, and `org.stations` carries only `capacity_config` (FR-KDS-045 `[C]`). Persisting a per-station sort preference would require **a migration** — either a new column on `org.stations` or a new `station_kds_config` table.

### Recommendation

> **Implement FIFO only, as a request-level `?sort=` parameter defaulting to `fifo`. Classify FR-KDS-023 PARTIAL. Add no migration.**

A query parameter lets the client choose and lets a later slice add persistence without an API break; it does not satisfy "configurable per station", and this report does not pretend otherwise. Accepting `sort=target_ready_at` while the column is universally NULL would be worse than refusing it — the recommendation is to accept **only** `fifo` in v1 and return 400 for the others, so the OpenAPI contract cannot imply a capability that does not exist.

### What the backend should expose for FR-KDS-022

FR-KDS-022 `[M]` is colour-coding *"by elapsed time against a configurable target"*. The backend owns the **facts**; the client owns the **colour**.

Expose per ticket: `routedAt` (the anchor), **`elapsedSeconds`** (server-computed at response time — the KDS clock must not be trusted for a displayed SLA), and `targetReadyAt` (currently always `null`).

**Do NOT expose a `targetState`/colour band.** The band thresholds are the "configurable target" FR-KDS-022 names, and **no configuration for it exists** (FR-KDS-044 `[S]` is unimplemented and there is no threshold store). A backend-computed band would be a fabricated classification. With `targetReadyAt` null, a client can still render the neutral state and an elapsed timer, which is FR-KDS-020's "elapsed time" — mandatory and satisfiable — while FR-KDS-022's amber/red thresholds remain honestly unmet.

**No UI colour is implemented in the backend.**

---

## §18. FR-KDS-041 / FR-KDS-042

**Do these become COMPLETE because timestamps exist? No.** Both are *"compute and report"* requirements; a stored column is an input, not a report.

**Data sufficiency audit for the future analytics slice:**

| FR-KDS-041 dimension | Sufficient after this slice? |
|---|---|
| by item | **Yes** — `ticket_lines.item_name_snapshot`. *(Note: the snapshot is a display name; grouping by a stable `menu_item_id` would need one, and `ticket_lines` deliberately has none. Analytics may need to join via `order_line_id` — a Sales fact — which is a boundary question for that slice, not this one.)* |
| by station | **Yes** — `tickets.station_id` |
| by hour | **Yes** — `routed_at` / `ready_at` |
| **by employee** | **Yes** — `started_by`/`bumped_by`, **only because this slice populates them.** Today they are NULL and the dimension is impossible. |
| by order type | **Yes** — `tickets.order_type_snapshot` |

| FR-KDS-042 metric | Sufficient? |
|---|---|
| ticket time = bump − fire | **Yes** — `tickets.bumped_at − ticket_fire_batches.fired_at` (earliest batch). `recall_count > 0` correctly flags an unclean measurement. |
| order time = last-line-ready − order-open | **Partially, and not by Kitchen alone.** Kitchen has last-line-ready (`MAX(ticket_lines.ready_at)` across the order's tickets); **`order-open` is `sales.orders.opened_at`** — a Sales fact. This metric is inherently **cross-module** and will need either a Sales contract query or an Analytics module that legitimately reads both. Flagging it now so the later slice does not discover it late. |

> **RECOMMENDATION: Option B — preserve the data now, schedule KDS timing/reporting as a separate later sub-slice.**

Reasons: the operator lifecycle is the *producer* of the very columns these reports consume, so building reports first is impossible and building both at once doubles the slice; FR-KDS-042's order-time metric raises a cross-module question (above) that deserves its own design; and neither requirement has any read surface, permission (`report.view.<category>` is the SRS shape) or DTO designed. Analytics is deliberately **not** absorbed into the operator lifecycle.

**FR-KDS-041 and FR-KDS-042 remain NOT IMPLEMENTED after this slice** — their inputs become available, which is a real advance and is stated as exactly that.

---

## §19. AUTHENTICATION / KDS SESSION

### Audit against the four SRS facts

| SRS | Repository at `121b889` | Verdict |
|---|---|---|
| ACT-09 Kitchen Staff — One station — KDS | No station concept in auth at all | **GAP** — closable by §6 with existing schema |
| UC-KDS-01 precondition — KDS terminals authenticated | `TerminalType` includes **`kds`**; `Terminal` has `status` (`active`/`disabled`/`revoked`); `Session.terminalId` exists and reaches `AuthenticatedPrincipal.terminalId` | **SATISFIABLE TODAY** |
| FR-SEC-026 — KDS idle default **8 hours** | One flat `JWT_ACCESS_TTL=15m` for every session type. No idle tracking, no per-surface TTL | **PARTIAL — pre-existing** |
| FR-SEC-028 — terminals individually registered/revocable | `POST /auth/terminals`, `POST /auth/terminals/{id}/status`, `DeviceFingerprint`, `AUDIT_ACTION.TERMINAL_REGISTERED` | **COMPLETE** |

Specific answers:

- **Is there a KDS authentication/session type?** No dedicated one. `AuthenticatedPrincipal.sessionType` is `'pos' | undefined` — PIN sessions are `'pos'`, dashboard sessions undefined. There is no `'kds'` value.
- **Can an existing PIN principal legally authenticate KDS?** **Yes.** FR-SEC-020 assigns PIN to the "POS terminal, fast switching" surface, and FR-SEC-021 requires only that PIN be *"valid only on registered terminals within the employee's permitted branches"* — a `kds`-type terminal **is** a registered terminal. Nothing in the SRS forbids PIN on KDS, and fast operator switching is exactly the kitchen's need. A PIN session carries `employeeId`, which `bumped_by`/`started_by` require.
- **Does the session carry `terminalId`?** **Yes** — `Session.terminalId`, surfaced on both `AuthenticatedPrincipal` and `TenantContext`.
- **Does terminal type distinguish POS from KDS?** **Yes in the data** (`TerminalType.pos` vs `.kds`), **no in the auth logic** — no guard reads it.
- **Is `display_terminal_id` enforceable?** **Yes** — the D-16 composite FK already guarantees same-branch, and §6's rule needs no schema change.
- **Does session TTL distinguish KDS?** **No.**

### Is this a blocker?

**The FR-SEC-026 gap is real but is not a security defect.** A 15-minute TTL is *stricter* than the 8 hours the SRS permits — it fails toward re-authentication, not toward exposure. It is a **usability** defect (a cook re-entering a PIN every 15 minutes is an unacceptable kitchen experience) and it is **pre-existing**, already recorded as PARTIAL in the repository's own `PHASE_1_SRS_REQUIREMENT_MAP.md:128`, created by neither this slice nor P1G-1.

Two honest consequences: this slice must **not** claim FR-SEC-026 progress, and the internal MVP pilot should expect PIN re-entry until a per-surface-TTL slice lands. That slice is small (session type on the token + TTL lookup) but is **identity work, not KDS work**, and folding it in would widen this slice across a module boundary for no KDS-specific gain.

> **VERDICT §19 — KDS operator lifecycle is IMPLEMENTATION READY on authentication.** It is **not** blocked on KDS authentication design: registered `kds` terminals, terminal-bound sessions, employee attribution and revocation all exist today, and §6's station authorization is buildable from existing schema. **Verdict C is NOT returned.** FR-SEC-026 is carried as a separate, pre-existing, non-blocking gap.

---

## §20. USER RATIFICATION PACKET

Only genuinely business/governance choices appear here. Engineering mechanics (§6 station rule, §9 acknowledgement route, §11 CAS, §13 payload-carried readiness, §17 FIFO-only, §22 route shapes) are **not** submitted for approval.

---

### DECISION 1 — KDS PERMISSION VOCABULARY AND ROLE MAPPING

**Why source and governance cannot decide this.** SRS §15.2 contains no `kds.*` code (exhaustively verified). §15.2 designates **Appendix C** as the authoritative full catalogue, and **Appendix C is absent from the delivered SRS**. §15.3 nonetheless requires Kitchen Staff to be *"KDS only"*, ACT-09 scopes them to a station, and FR-KDS-024/025 `[M]` require bump and recall — so a route must exist, and in this repository every route carries `@RequirePermission`. D-20 met this identical situation and resolved it by **deferring rather than inventing** — but D-20 could defer only because D-14 A-1 had removed the HTTP surface entirely. **That escape is unavailable here.** A code must be created, and creating one is expressly reserved to explicit user authorisation: `sales.permissions.ts:51-61` records `pos.payment.capture` as *"a NEW code created by explicit user authorisation, **the one recorded exception** to the zero-invented-codes discipline"*, alongside `pos.order.fire`'s *"Fire Authorization Ratification — 2026-08-24"*.

| | Option |
|---|---|
| **A ★** | **One code — `kds.operate`.** Covers view, first-viewed acknowledgement, start, bump item, bump all, recall. |
| **B** | **Two codes — `kds.view` + `kds.operate`.** |
| **C** | **Five codes — `kds.ticket.view` / `.start` / `.bump` / `.recall` / `.serve`.** |

**RECOMMENDATION: OPTION A.**

Four independent grounds converge: §15.3 characterises the role in two words (*"KDS only"*); the repository explicitly refuses to invent read codes and puts reads behind the write capability (`sales.permissions.ts:20-27`), which rules out B on precedent; **UC-KDS-01 alternate flow 4a assigns recall to "staff"**, not to a supervisor, which removes C's strongest separation argument; and marking-started is *"optional configuration"* per UC-KDS-01 step 4, which removes another. Option A is future-expandable in the direction the SRS actually points — `kds.expedite` when FR-KDS-013 `[S]` lands — and adding a code never revokes authority from an existing role.

**Consequence if ratified.** One `PermissionDef` (`code: 'kds.operate'`, `module: 'kds'`, `description: 'Operate a kitchen display station'` — the description satisfying FR-SEC-012 `[M]`). **No migration** (permissions are seeded by `PermissionsService.upsertMany` / `seed-dev-data.ts`, not by DDL). Proposed standard-role mapping — **Kitchen Staff, Head Chef, Branch Manager, Shift Supervisor, Owner: YES; all others including Auditor: NO** — is recorded as intent for the future FR-SEC-010 role-seeding slice, since **no production path seeds standard roles today** (§8). No existing role semantics are edited.

**Consequence if declined.** The KDS operator lifecycle cannot ship: no route can be guarded, and leaving routes unguarded is not an option this repository permits.

> **RECOMMENDED RATIFICATION SENTENCE**
> *"I ratify the creation of a single new permission code `kds.operate`, described as 'Operate a kitchen display station', authorising the KDS station-queue read, first-viewed acknowledgement, item start, bump item, bump all, and ticket recall. It is the third recorded exception to the zero-invented-codes discipline, alongside `pos.order.fire` and `pos.payment.capture`. I further record — as intent for the future FR-SEC-010 role-seeding slice, not as work authorised now — that `kds.operate` shall be granted to Kitchen Staff, Head Chef, Branch Manager, Shift Supervisor and Owner, and to no other standard role. No existing role semantics are amended. Station-level authorisation is not carried by this code: it is enforced by the terminal-to-station binding, and a later Expediter slice may introduce `kds.expedite` without reopening this ratification."*

---

### DECISION 2 — CROSS-MODULE CONSEQUENCE OF RECALL (`ticket.recalled`)

**Why source and governance cannot decide this.** UC-POS-01 step 7 requires Sales to mark lines `ready` on `ticket.bumped`. FR-KDS-025 `[M]` requires recall of a bumped ticket. The SRS **never states what happens to the Sales line when the ticket that made it ready is recalled**, and **`ticket.recalled` appears nowhere in the SRS** — verified across all 161 pages and absent from §5.5.4. However §5.5.4 is explicitly titled **"Event Catalogue (Core Subset)"**, so the omission is a *silence*, not a *prohibition*. Because the answer changes what a waiter sees on the POS, it is a business consequence, not an engineering mechanic.

| | Option |
|---|---|
| **A ★** | **Add a `ticket.recalled` domain event** (Kitchen Ops → Sales), payload symmetric to `ticket.bumped` (`ticketId`, `orderId`, `businessDay`, `stationId`, `recalledAt`, `revertedOrderLineIds`). The Sales subscriber reverts exactly those lines from `ready` back to `fired`, clearing `ready_at`, never touching `served`/`voided`/`comped` lines. Same transaction, same rollback guarantee as §13. |
| **B** | **No event.** Kitchen recalls internally; Sales keeps saying `ready`. Document the divergence and classify FR-KDS-025 PARTIAL. |
| **C** | **Restrict recall** to tickets whose bump has not yet been propagated to Sales — i.e. forbid recall once `ticket.bumped` published. |

**RECOMMENDATION: OPTION A.**

B leaves the POS asserting food is ready when the kitchen has taken it back — a safety-relevant operational error, and it makes the system's two halves knowingly inconsistent for up to the full 30-minute recall window. C is worse than it looks: under §12 the event fires precisely *when the ticket becomes bumped*, so "not yet propagated" is empty in the single-station case and arbitrary in the multi-station case — it would effectively delete FR-KDS-025 `[M]`. A costs one event type in a catalogue the SRS itself labels a subset, is exactly symmetric to the event it reverses, needs **no migration** (`sales.order_lines.state`/`ready_at` already exist and are already written by the §13 subscriber), and reuses the proven `@DomainEventHandler` + same-transaction-rollback path.

**Consequence if ratified.** One new type in `kitchen/contract/events.ts`, one new `@DomainEventHandler` in Sales. The event is recorded as an **extension of §5.5.4's declared Core Subset**, not as a contradiction of it. Analytics gains a truthful recall signal for FR-KDS-042's "unclean measurement" flag.

**Consequence if declined (Option B).** Recall ships Kitchen-side only; FR-KDS-025 is classified **PARTIAL** rather than COMPLETE; the Kitchen/Sales divergence is recorded as a known defect with an operational workaround (the expediter tells the waiter). This is survivable for an internal MVP but should not reach a pilot with real customers.

> **RECOMMENDED RATIFICATION SENTENCE**
> *"I ratify the addition of a `ticket.recalled` domain event, published by Kitchen Ops and subscribed by Sales, as an extension of the SRS §5.5.4 'Event Catalogue (Core Subset)' — recorded explicitly as resolving source silence, not as a finding that the SRS defined it. On recall, Sales shall revert exactly the order lines the corresponding `ticket.bumped` marked ready, from `ready` to `fired`, clearing `ready_at`, within the same transaction as the Kitchen recall, and shall never alter a line that is `served`, `voided` or `comped`. No schema change is authorised by this ratification."*

---

**No further ratifications are required.** In particular, and deliberately **not** escalated: the station-authorization rule (§6 — derivable from ACT-09 + ratified D-16 + existing `Session.terminalId`), the first-viewed acknowledgement route (§9 — API mechanics, source-silent, engineering-labelled), the `ticket.bumped` trigger and payload (§12 — engineering choice recorded knowingly), the multi-station readiness computation (§13 — Kitchen answering a Kitchen question within its own tables), FIFO-only sorting (§17 — an honest PARTIAL, not a new rule), and deferring `served` (§16 — a scope decision governed by FR-KDS-013's `[S]` classification).

---

## §21. API DESIGN

Conventions confirmed from the generated contract (`docs/api/openapi.json`, 100 paths) and `treasury.controller.ts`: **flat resource-first paths, NO global `/v1` prefix** (the SRS §26.1 `/v1` gap is pre-existing and self-documented in `swagger.config.ts`; **it is not retrofitted here**). Decorator stack, verbatim shape from `treasury.controller.ts:339-343`: `@Post(...)` · `@HttpCode(...)` · `@Idempotent()` · `@RequirePermission(...)` · `@ApiHeader/@ApiOperation/@Api*Response`.

Common to **every** route below: authenticated **terminal-bound** session (PIN `sessionType:'pos'` on a `kds`-type terminal); permission **`kds.operate`** (pending Decision 1); station ownership per §6 (`stationId ∈ stationsForTerminal(principal.terminalId)`, else 403); tenant isolation by RLS; all writes inside one `UnitOfWork.execute`.

| # | Route | Idem-Key | Request | Response | Preconditions | Replay / conflict | Audit | Tx |
|---|---|---|---|---|---|---|---|---|
| 1 | `GET /kds/stations/{stationId}/queue` | n/a (GET) | `?status=active` `&sort=fifo` `&limit&cursor` | `{ tickets: TicketCardDto[], cancelledLineVisibilitySeconds, recallWindowSeconds }` | station bound to terminal | n/a — **safe, no side effect** | **none** (reads not audited) | read-only |
| 2 | `POST /kds/stations/{stationId}/tickets/view` | optional | `{ ticketIds: string[] }` | `{ acknowledged: n }` | tickets belong to station | naturally idempotent (`WHERE first_viewed_at IS NULL`); replay ⇒ `acknowledged: 0` | **none** (§9) | 1 tx |
| 3 | `POST /kds/tickets/{ticketId}/lines/{lineId}/start` | optional | `{}` | `{ line, ticket }` | line `queued`; not cancelled | replay ⇒ 200, unchanged | `TICKET_LINE_STARTED` | 1 tx |
| 4 | `POST /kds/tickets/{ticketId}/lines/{lineId}/bump` | optional | `{}` | `{ line, ticket }` | line ∈ `{queued,started,ready}`; **not cancelled ⇒ 422** | replay ⇒ 200, **original `bumped_at`/`bumped_by` preserved** | `TICKET_LINE_BUMPED` | 1 tx (+ `ticket.bumped` if ticket transitions) |
| 5 | `POST /kds/tickets/{ticketId}/bump-all` | optional | `{}` | `{ ticket, bumpedLineIds }` | ≥1 eligible line | replay ⇒ 200, `bumpedLineIds: []` | `TICKET_BUMPED` (one entry, **not one per line**) | 1 tx + `ticket.bumped` |
| 6 | `POST /kds/tickets/{ticketId}/recall` | **REQUIRED** | `{}` | `{ ticket }` | `status='bumped'` **and** `now − bumped_at ≤ recall_window_seconds`; else **422** | **not naturally idempotent** (`recall_count++`) — key mandatory; identical replay ⇒ stored response + `Idempotent-Replay: true`; different fingerprint ⇒ **409** | `TICKET_RECALLED` | 1 tx + `ticket.recalled` (pending Decision 2) |

**Deliberately NOT proposed:** `POST …/serve` (§16, deferred with FR-KDS-013 `[S]`), any cancellation route (§15 — cancellation arrives by event, never by a KDS command), any analytics route (§18), any per-station sort-configuration route (§17 — would need a migration).

Six routes, one of them a GET. No route exists that is not required by §5(A).

**Idempotency-Key policy rationale.** FR-API-020 makes the header *acceptable* on every POST and *mandatory* on financially significant endpoints. None of these is financially significant, so the header is **accepted** everywhere and **required** only on recall — the one operation with a non-idempotent side effect (`recall_count`). Routes 2–5 are idempotent at the database level by construction (§9, §11), which is a stronger guarantee than replay caching.

---

## §22. IDEMPOTENCY / OFFLINE-FORWARD COMPATIBILITY

**Existing infrastructure is sufficient.** `src/common/idempotency/` registers a global `APP_INTERCEPTOR`; `@Idempotent()` opts a route in; records are keyed `(tenantId, key)` with `endpoint` + SHA-256 request `fingerprint`, stored in `sync.idempotency_keys` with 30-day retention (FR-API-021); an identical replay returns the stored `{status, body}` with `Idempotent-Replay: true` (FR-API-022); a fingerprint mismatch is **409** (FR-API-023). All four requirements are met by machinery already in production on 11 endpoints. **No new idempotency mechanism is needed.**

### Should each device action carry `actionId` / `occurredAt`?

**Recommendation: `actionId` — NO (the `Idempotency-Key` header already is it). `occurredAt` — NO, not yet, and this is the security-sensitive half.**

NFR-REL-002 `[M]` requires an offline KDS to buffer bumps and — per UC-KDS-01 alt-flow 5a — replay them *"with its original timestamp preserved"*. That is a real future obligation. But accepting a client `occurredAt` **today** would let any terminal write arbitrary history into `bumped_at`, which is the direct input to FR-KDS-042's mandatory ticket-time metric and FR-KDS-041's per-employee prep times. **A client-supplied timestamp that rewrites a mandatory metric with no trust rule is a defect, not a feature.**

The distinction that must be preserved when offline support lands:

| | Meaning | Trust |
|---|---|---|
| **device occurrence time** | when the cook pressed bump | Client-asserted. Requires a trust rule: bounded skew, never after server receipt, never before `routed_at`, and stored **separately** so it can be audited and disbelieved. |
| **server persistence time** | when the server durably recorded it | Server clock. Trustworthy. |

Today, online-only, these coincide, and this slice writes **one** server-authoritative instant. When the offline slice arrives it adds a *second, distinct* column (e.g. `bumped_occurred_at`) plus its trust rule — **an additive migration that breaks no API and no existing row**, because the meaning of `bumped_at` never changes.

**Forward compatibility is therefore preserved by design:** the routes are POSTs carrying `Idempotency-Key` (so a reconnecting device replays safely without duplicating), the operations are database-level idempotent (so out-of-order replay converges), and no field's meaning must be redefined later.

> **CLASSIFICATION §22 — NOT SOURCE-DECIDABLE; engineering choice, recorded.** NFR-REL-002 is **NOT IMPLEMENTED** after this slice and this report does not claim otherwise.

---

## §23. AUDIT

FR-AUD-001 `[M]`: an immutable entry for **every state-changing operation**. `AuditService.record(tx, event)` writes inside the **caller's** transaction, serialising the per-tenant hash chain with `pg_advisory_xact_lock` — so an audit entry can never survive a rolled-back bump, nor vice versa.

**Proposed new constants** (following the existing `<ENTITY>_<PAST_TENSE>` convention exactly):

```
AUDIT_ACTION.TICKET_LINE_STARTED   = 'TICKET_LINE_STARTED'
AUDIT_ACTION.TICKET_LINE_BUMPED    = 'TICKET_LINE_BUMPED'
AUDIT_ACTION.TICKET_BUMPED         = 'TICKET_BUMPED'
AUDIT_ACTION.TICKET_RECALLED       = 'TICKET_RECALLED'
AUDIT_ENTITY.TICKET                = 'ticket'
AUDIT_ENTITY.TICKET_LINE           = 'ticket_line'
```

**Avoiding duplicate noise — the explicit rule.** `bump-all` changes many lines but is **one operator action**: it writes **exactly one** `TICKET_BUMPED` entry whose metadata carries the affected line ids, **not** one entry per line. This mirrors the reasoning already recorded for `CASH_MOVEMENT_RECORDED` (*"One verb covers all three movement types; the type is metadata, not a different action"*) and the warning `audit.constants.ts:56-58` gives against a second echo of an event another module already records.

Correspondingly:
- **first-viewed: NOT audited** (§9) — display progress, not an operational state change.
- **cancellation subscriber: NOT audited Kitchen-side.** Sales already writes `ORDER_LINE_VOIDED` for the originating action; a Kitchen echo of the same fact is exactly the duplication the register warns against. *(Moot today — §15 shows the trigger does not exist.)*
- **the Sales readiness subscriber: NOT separately audited.** The Kitchen bump entry is the operator action; the Sales projection is its in-transaction consequence, and `correlationId` already ties them.

**Minimum immutable metadata per entry:** `tenantId`, `branchId`, `occurredAt`/`recordedAt`, `actorId` (= the employee) + `actorType`, `action`, `entityType`/`entityId` (the ticket), and in the payload `stationId`, the affected `ticketLineIds`, and the resulting statuses. Per FR-AUD-002 the entry is chained and immutable.

> **Domain events are NOT treated as audit substitutes.** `ticket.bumped` is a contract for subscribers; the audit entry is the accountability record. Both are written, in the same transaction.

---

## §24. DATABASE / MIGRATION

> # MIGRATION REQUIRED: **NO**

Verified field by field against `schema.prisma` at HEAD.

| Need | Exists? |
|---|---|
| All 7 FR-KDS-040 timestamps, **ticket and line** | **YES** — `created_at`, `routed_at`, `first_viewed_at`, `started_at`, `ready_at`, `bumped_at`, `served_at` on both |
| Actor columns | **YES** — `started_by`, `bumped_by` on both |
| Recall facts | **YES** — `recalled_at` (both), `recall_count` (ticket), `recall_window_seconds` (`branch_kds_config`, default 1800) |
| Cancellation facts | **YES** — `cancelled_at` (line), `cancelled_line_visibility_seconds` (nullable, no invented default) |
| Status vocabulary | **YES** — `TicketStatus` (6 values incl. `recalled`), `TicketLineStatus` (6 values incl. `cancelled`) |
| Optimistic-concurrency token | **YES** — `tickets.version` (currently unwritten; §11 gives it its first writer) |
| Station-queue index | **YES** — `[tenantId, branchId, stationId, status, routedAt]` |
| Target-sort index | **YES** — `[tenantId, branchId, stationId, targetReadyAt]` |
| Multi-station readiness lookup (§13) | **YES** — `[tenantId, orderLineId, businessDay]` — an exact match for the `readyOrderLineIds` query |
| Station→terminal binding (§6) | **YES** — `org.stations.display_terminal_id` + D-16 composite FK; `org.stations` is RLS-protected via branch traversal |
| Sales readiness target (§13) | **YES** — `sales.order_lines.state` has `ready`; `sales.order_lines.ready_at` exists, **no writer today** |
| Event payload persistence | **NONE NEEDED** — payload is computed from existing rows |
| Permission seeding (Decision 1) | **NO DDL** — `PermissionsService.upsertMany` / `seed-dev-data.ts`; permissions are application-seeded |
| Audit constants (§23) | **NO DDL** — TypeScript constants; `governance.audit_entries` is generic |

**Indexes are sufficient.** No new index is proposed. The three that matter — FIFO queue, target sort, and cross-station readiness — all already exist, each created for exactly this purpose by P1E-5.

**What WOULD force a migration, and is therefore excluded from this slice:** per-station sort configuration (FR-KDS-023's "configurable per station", §17); `target_ready_at` population config and colour thresholds (FR-KDS-022/044, §17); a `ticket_state_events` history table (§14, deferred); a separate device-occurrence timestamp for offline bumps (§22); a `served_by` column (§16 — deliberately absent, P1E-4 §R).

**No schema is added for aesthetic reasons.** The P1E-4/P1E-5 intent — front-load the substrate so the lifecycle slice is behaviour-only — is confirmed correct and is realised here.

---

## §25. CONCURRENCY — TEST DESIGN

Following `test/kitchen-ticket-concurrency.e2e-spec.ts`, which already establishes the correct harness: **real PostgreSQL, two genuinely concurrent transactions released by an explicit barrier** (*"synchronized with an explicit barrier so both are guaranteed to attempt … a database-level race, not two `Promise.all`'d calls sharing one"*). **No arbitrary sleeps.** No advisory locks introduced (§11).

| # | Race | Expected outcome |
|---|---|---|
| 1 | Two cooks bump the **same line** | Exactly one write. Second matches 0 rows ⇒ replay result. **Original `bumped_at`/`bumped_by` preserved.** No error. |
| 2 | Two cooks bump **different lines, same ticket** | Both line writes succeed and keep their own actors. Ticket projection converges to the correct final status via `tickets.version` CAS + bounded retry. **No lost update** — reconcile projection against line rows afterwards. |
| 3 | **Bump item vs bump-all** concurrently | No duplicate bump; the individually-bumped line keeps its own `bumped_by`; bump-all covers the remainder; ticket status correct. |
| 4 | **Bump vs recall** | Serialised by state guards. Either recall lands then the bump re-bumps a now-`queued`/`started` line, or the bump lands and recall then sees `bumped` and succeeds. **Never both applied to the same state**; `recall_count` increments exactly once per successful recall. |
| 5 | **Final bump vs cancellation** | Cancelled line is excluded from the bump match set; the ticket still reaches `bumped` on its remaining non-cancelled lines; `cancelled_at` preserved. *(Constructed directly against the tables — §15 shows no HTTP trigger exists.)* |
| 6 | **Recall vs re-bump** | `recall_count` exact; `bumped_at` reflects the latest bump; `ready_at` never cleared. |
| 7 | **Sales readiness under two station tickets completing concurrently** | **The load-bearing test.** One order line routed to Grill and Packaging; both stations bump simultaneously. Exactly one of the two transactions computes the line into `readyOrderLineIds`; `sales.order_lines.state` becomes `ready` exactly once; it is **never** set ready by the first station alone. |
| 8 | **Rollback** | Force the Sales subscriber to throw; assert the Kitchen bump, ticket projection **and** audit entry are all absent after rollback. |
| 9 | **Projection reconciliation** (invariant, not a race) | For arbitrary line-state combinations, `tickets.status`/`ready_at`/`bumped_at` always equal what the §11 rule derives from the line rows. |

---

## §26. RLS / TENANCY / STATION ISOLATION — THREE DISTINCT THINGS

The prompt's warning is exactly right, and the distinction is not academic here.

**1. TENANT ISOLATION — COMPLETE.**
All four Kitchen ticket tables and both Kitchen-schema KDS-config tables carry `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY` with a tenant predicate that fails closed when no context is set:
```sql
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
```
An unset context yields `NULL`, which matches nothing (FR-PLT-012). The app role `ros_app` is created `NOBYPASSRLS` (FR-PLT-011), and context is established per transaction by `PrismaService.withAuthContext`'s `SET LOCAL app.tenant_id`. `org.stations` is likewise protected, via a branch traversal (it carries no `tenant_id` of its own).

**2. BRANCH AUTHORIZATION — NOT IMPLEMENTED.**
No RLS policy filters by branch anywhere in the repository. `TenantContext.branchId` is declared and **never populated** (D-2 deferral). Branch safety on Kitchen data is **structural, not authorization-based**: `Ticket`'s composite FK chain proves `branch_id` is the order's own branch and that the station lies in that branch, making a cross-branch ticket unrepresentable. That is an *integrity* guarantee about how rows are written — **it does not stop an authenticated principal reading another branch's rows.**

**3. STATION AUTHORIZATION — NOT IMPLEMENTED; introduced by this slice.**
Nothing in RLS or RBAC constrains below tenant. §6's terminal-binding rule is the **only** thing that would enforce ACT-09, and it is **application-layer**, not RLS.

> **Explicitly: tenant isolation does NOT prove branch authorization, and neither proves station authorization.** Because station scope is enforced in the application layer, its tests must be **route-level authorization tests** (a principal bound to station A receiving 403 for station B, and 403 when bound to no station), **not** RLS tests. Conflating the two would be the exact false-assurance §27 of the prompt warns against.

---

## §27. MODULE OWNERSHIP

Enforced mechanically by `module-boundaries.spec.ts` (1,058 lines): a static scan resolves every cross-module import and permits only `modules/<other>/contract` , `contract/…` or the other module's `.module` file; `KNOWN_DEVIATIONS` is asserted **`toEqual`** the actual violation set, so the list can shrink but **can never silently grow**. A second scan (`containsForeignPrismaQuery`) asserts Kitchen contains **zero** direct Prisma calls against Sales/Catalogue delegates.

| Direction | Mechanism | Deviation? |
|---|---|---|
| Kitchen → Organisation (station↔terminal binding, §6) | **new** public `organisation/contract/station-display-binding.query.ts`, alongside the three queries already published there | **None.** `KNOWN_DEVIATIONS['kitchen->organisation']` stays `undefined` |
| Kitchen → Sales (readiness) | **none** — Kitchen publishes `ticket.bumped`; it never touches `sales.*` | **None** |
| Sales → Kitchen (readiness subscriber) | imports `kitchen/contract` only — a public surface | **None.** `KNOWN_DEVIATIONS['sales->kitchen']` stays `undefined` |
| Kitchen writes | `kitchen.tickets`, `ticket_lines`, `ticket_fire_batches`, `ticket_line_modifiers` — its own tables only | — |
| Sales writes | `sales.order_lines.state`/`ready_at` — its own tables only | — |

**`KNOWN_DEVIATIONS` does not grow.** §5.2.3 is satisfied: cross-module communication is by published interface (the Organisation query, §5.5.1 — synchronous because the authorization decision must precede the read in the same request) and by domain event (`ticket.bumped`, §5.5.2 — in the same transaction).

**A public Kitchen contract query is NOT needed.** §13's payload-carried `readyOrderLineIds` removes the only reason Sales would have had to ask Kitchen anything synchronously.

---

## §28. UI / BACKEND BOUNDARY

No visual or client requirement is marked COMPLETE from a JSON field.

| Requirement | Backend portion | Client portion | This slice proves | Remains |
|---|---|---|---|---|
| **FR-KDS-020** card contents `[M]` | order number, order type, service reference, lines, quantities, modifiers, prep notes, `routedAt` + `elapsedSeconds` — **all served** | card layout/rendering | **the data contract is complete and self-contained** | rendering |
| **FR-KDS-021** modifier distinction `[M]` | `kind ∈ {addition, removal, substitution}` as a DB enum — invalid values unrepresentable | rendering `+ extra cheese` vs `- no onion` differently | the distinction is **available and type-safe** | **all rendering — NOT IMPLEMENTED** |
| **FR-KDS-022** colours `[M]` | `routedAt`, `elapsedSeconds`, `targetReadyAt` (**always null**) | amber/red/flashing bands | elapsed-time facts only | **thresholds have no config store; colour NOT IMPLEMENTED** |
| **FR-KDS-026** deliberate interaction `[M]` | **none** — a long-press cannot be enforced server-side | long-press / double-tap / confirm zone | **nothing** | **entirely client — NOT IMPLEMENTED** |
| **FR-KDS-028** amendment alert `[S]` | `ticket_fire_batches` makes amendments distinguishable on a **stable** ticket ("never as a new ticket") and the queue DTO can expose batch grouping | visual distinction + audible alert | **the "never a new ticket" half** | visual/audible — NOT IMPLEMENTED |
| **FR-KDS-029** strike-through/alert `[M]` | `cancelled_at` + `cancelledLineVisibilitySeconds` in the DTO | strike-through, highlight, alert | **nothing executable — no upstream trigger (§15)** | trigger **and** rendering |
| **NFR-USA-006** 24 pt at 2 m `[M]` | **none** | font sizing | **nothing** | **entirely client — NOT IMPLEMENTED** |
| **NFR-REL-002** offline bumps `[M]` | forward-compatible API shape (§22) | local buffering + replay | **nothing** | **NOT IMPLEMENTED** |
| **NFR-REL-003** peer discovery `[M]` | **none** — a network topology requirement (SRS §21.6) | local peer routing | **nothing** | **NOT IMPLEMENTED** |
| **NFR-PERF-004** 1 s p95 `[M]` | indexed queue query; no aggregate-per-read | display refresh/push | **a query shape consistent with the budget** | **unmeasured — no benchmark run; cannot be claimed** |

---

## §29. PROPOSED INTERNAL MVP DEFINITION OF DONE

Sized for **one implementation slice**.

1. `KitchenController` — the module's first — with the **six** routes of §21.
2. `TicketReaderService.listStationQueue()` + widened lifecycle DTO (self-containment `select` guarantee preserved).
3. First-viewed acknowledgement (ticket + all its lines, write-once).
4. Optional line start (+ ticket `in_progress` projection).
5. Bump item.
6. Bump all (preserving already-bumped actors/timestamps).
7. Ticket projection maintained in-transaction via `tickets.version` CAS.
8. Recall (window from `branch_kds_config`, `recall_count`, timestamps preserved).
9. `ticket.bumped` **runtime** event with the §12 v1 payload.
10. Sales multi-station readiness subscriber (§13).
11. `ticket.recalled` + Sales revert — **only if Decision 2 is ratified as Option A**.
12. New Organisation contract query for station↔terminal binding; station authorization guard (§6).
13. `kds.operate` permission + `PermissionDef` — **pending Decision 1**.
14. Four audit actions + two audit entities (§23).
15. `Idempotency-Key` required on recall, accepted elsewhere.
16. OpenAPI regenerated (`openapi:generate`) — the six routes documented.
17. Concurrency + authorization test suite (§25, §26).

**Explicitly OUT (with reasons):**
- **`served`** — §16, deferred with FR-KDS-013 `[S]`. *Evaluated as instructed: cheap mechanically, but the actor, role, permission and display are all undefined, and its effect is order-wide and cross-module.*
- **Sorting beyond FIFO / target / colour bands** — §17. *Evaluated as instructed: `target_ready_at` is universally NULL, "order type priority" has no defined ordering, and "configurable per station" has no store and would force a migration.*
- **FR-KDS-041/042 analytics** — §18, a separate sub-slice; kept out deliberately.
- **Cancellation handler** — §15, blocked on a non-existent upstream event.
- **Offline buffering** — §22, forward-compatible but not built.
- **Per-surface session TTL (FR-SEC-026)** — §19, identity work, pre-existing gap.

**No migration. No new `KNOWN_DEVIATIONS`. No governance-register edit performed by this report.**

---

## §30. PREDICTED REQUIREMENT CLASSIFICATION AFTER THE PROPOSED MVP

| Requirement | After | Why |
|---|---|---|
| FR-KDS-010 `[M]` | **COMPLETE** | Already complete; unchanged |
| FR-KDS-011 `[M]` | **COMPLETE** | Multi-station routing already works; the slice adds correct multi-station **readiness**, which was the missing half |
| FR-KDS-013 `[S]` | **NOT IMPLEMENTED** | Expediter display deferred |
| FR-KDS-020 `[M]` | **PARTIAL** | Every card datum served incl. elapsed-time anchor; **rendering is client** |
| FR-KDS-021 `[M]` | **PARTIAL** | Type-safe distinction available; visual rendering NOT IMPLEMENTED |
| FR-KDS-022 `[M]` | **PARTIAL** | Elapsed facts served; `target_ready_at` always NULL, no threshold config, no colour |
| FR-KDS-023 `[M]` | **PARTIAL** | FIFO only; three modes unsupported; "configurable per station" has no store |
| FR-KDS-024 `[M]` | **COMPLETE** *(backend)* | Bump item **and** bump all, both executable and audited. FR-KDS-026's gesture is a separate requirement |
| FR-KDS-025 `[M]` | **COMPLETE** if Decision 2 = A; **PARTIAL** if Decision 2 = B | Kitchen-side recall is complete either way; the Sales consequence decides it |
| FR-KDS-026 `[M]` | **NOT IMPLEMENTED** | Entirely client-side |
| FR-KDS-028 `[S]` | **PARTIAL** | "Never as a new ticket" holds structurally; visual/audible alert NOT IMPLEMENTED |
| FR-KDS-029 `[M]` | **NOT IMPLEMENTED** | No upstream `order.line.voided` exists (§15). Persistence and DTO are ready; the requirement is not met |
| FR-KDS-040 `[M]` | **PARTIAL** | Six of seven timestamps written on **both** ticket and line; `served` outstanding (§16) |
| FR-KDS-041 `[M]` | **NOT IMPLEMENTED** | Inputs become available (incl. the by-employee dimension, newly possible); **no report surface exists** |
| FR-KDS-042 `[M]` | **NOT IMPLEMENTED** | Ticket-time inputs complete; order-time needs a cross-module join; no report surface |
| FR-KDS-043 `[S]` | **NOT IMPLEMENTED** | No analytics |
| FR-KDS-044 `[S]` | **NOT IMPLEMENTED** | `target_ready_at` never populated |
| FR-KDS-045 `[C]` | **NOT IMPLEMENTED** | No capacity logic |
| NFR-USA-006 `[M]` | **NOT IMPLEMENTED** | Client |
| NFR-PERF-004 `[M]` | **NOT VERIFIED** | Query shape is consistent with the budget; **no benchmark executed — not claimable** |
| NFR-REL-002 `[M]` | **NOT IMPLEMENTED** | Online-only; API is forward-compatible |
| NFR-REL-003 `[M]` | **NOT IMPLEMENTED** | Network topology, out of scope |
| **§5.5.4 `ticket.bumped`** | **COMPLETE** | Published by Kitchen Ops, consumed by Sales, in-transaction, with a payload sufficient for UC-POS-01 step 7 |
| §5.5.4 `order.line.voided` | **NOT IMPLEMENTED** | Sales-side gap (§15) |
| FR-AUD-001 `[M]` | **COMPLETE for KDS operations** | Every KDS state change audited in-transaction, no duplicate noise. (Repo-wide status unchanged by this slice.) |
| FR-SEC-026 `[M]` | **PARTIAL — pre-existing, unchanged** | No per-surface idle TTL; not created by this slice |

**No UI or offline requirement is promised COMPLETE from backend work.**

---

## §31. VERDICT

> # **B — KDS MVP IMPLEMENTATION READY AFTER NARROW USER RATIFICATION**

- **Not E:** the baseline is verified, HEAD is `121b889`, and P1G-1 CashSession Close is present (§1).
- **Not C:** KDS authentication is not a blocker. `kds` terminal type, terminal-bound sessions, employee attribution and terminal revocation all exist; station authorization is buildable from `Session.terminalId` + ratified D-16 with no new RBAC and no migration (§6, §19). FR-SEC-026's missing per-surface TTL is a pre-existing, non-blocking usability gap.
- **Not D:** no lifecycle design question remains open. Bump, bump-all, projection, start, first-viewed, recall and concurrency are all resolved (§9–§11, §14, §25), and the multi-station Sales readiness problem that P1E-4 left explicitly "out of scope" is **closed** in §13 without any module-boundary violation, contract query, or migration.
- **B, because exactly two genuine governance choices remain** (§20): the `kds.operate` permission vocabulary and role mapping — unavoidable, since SRS §15.2 supplies no KDS code and its designated Appendix C is absent from the document — and the cross-module consequence of recall, where the SRS is silent and the answer visibly changes POS behaviour.

**MIGRATION REQUIRED: NO.**

Neither ratification is a design question this report may settle: the first is expressly reserved to explicit user authorisation by the repository's own zero-invented-codes discipline (precedents `pos.order.fire`, `pos.payment.capture`); the second resolves a source silence with an operational consequence for front-of-house.

---

## §32. WHAT THIS REPORT DID NOT DO

No product code · no migration · no schema change · no route · no permission · no governance-register edit · no test written or executed · no OpenAPI regeneration · no commit · no push · no deploy · no destructive git operation. The only file created is this report; the only file modified is `INDEX.md`, by exactly one appended row.

*Two subagents used during evidence-gathering wrote report files and INDEX rows contrary to their read-only instruction; both files were deleted and both INDEX rows reverted, restoring the working tree to its pre-task state (verified by `git status`). Their findings are incorporated above and were independently re-verified against source before use.*

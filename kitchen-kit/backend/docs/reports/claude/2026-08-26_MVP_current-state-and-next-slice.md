# ROS — MVP Current-State Audit, Remaining Work, and Next-Slice Gate

**Report type:** Analysis/audit only. No product code, migration, or governance was changed by this task.
**Authority statement:** This report is non-authoritative evidence. `ROS_SRS_v1.0.pdf` and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority for requirements and architecture decisions. Where the SRS and a prior Claude report disagree, the SRS wins; where ratified governance and an older design assumption disagree, governance wins; where current code and an old implementation report disagree, current code wins. A design report is never treated as implementation evidence. A passing test is only evidence if it actually exercises the claimed behavior.
**Date:** 2026-08-26
**HEAD:** `9aa7a880229938bffd2d5dc0dfcb3d263da060e8`
**Branch:** `feat/production-spec` (confirmed via `git branch --show-current`, not assumed)
**Working tree summary:** exactly one pre-existing local modification, not made by this task: `kitchen-kit/backend/prisma.config.ts` (see §M). No file was altered, no migration created, no commit, no push, no branch operation, no destructive git command.
**Task identifier:** MVP current-state audit + remaining-work + next-slice gate. Analysis only — implementation of the chosen next slice is explicitly out of scope and deferred to a future task.

---

## A. Executive verdict

The protected MVP path (PIN → Shift/CashSession open → Order → Fire → Kitchen routing/ticket → Payment → **COMPLETED** → depletion → COGS → Receipt → session/day close → reports) is **real and working from PIN through partial Payment**, and **structurally blocked immediately after Payment**: there is no code path anywhere in the repository that can legally transition an Order to `COMPLETED`. Everything downstream of that transition — recipe expansion, inventory depletion, COGS posting, receipt generation, KDS operator lifecycle, cash-session/shift close, day close, and reporting — is **either DESIGNED ONLY (Completion/depletion/COGS) or NOT IMPLEMENTED (Receipt, KDS operator lifecycle, Treasury close, day close, reporting)**. This is not a soft gap: `SalesPaymentService` contains an explicit, deliberate throw (`FullPaymentRequiresCompletionError`) refusing any payment that would fully or over-settle an order, specifically because the Completion orchestration "does not exist yet." A demo order today can be fired, tickets can be created in the kitchen schema, and it can be partially paid — but it can never be closed out as a completed sale.

P1F-2 (the Completion/COGS/depletion slice) has five accepted design-gate reports (P1F2 → P1F2E-A) culminating in "IMPLEMENTATION READY," but **zero corresponding production code or migration exists**. This was independently confirmed by direct code/migration inspection (two independent audit passes, Sales/Treasury and Production/Inventory, both returned the same verdict with no code found). P1F-2 = **DESIGNED ONLY**, full stop.

The 2026-08-26 Country Pack unblock work is real and verified in the current repository: `config/country-packs/EG-2026.1.pack.json` and `trust-manifest.json` exist, are committed (`git log` shows commit `9aa7a88 feat: provision signed demo country pack`), and are covered by dedicated tests. This report treats the Render deployment's own log output as deployment evidence only (this session did not access Render), but the repository-side artifacts backing it are confirmed present and correct.

## B. Repository snapshot

| Fact | Value |
|---|---|
| Branch | `feat/production-spec` |
| HEAD | `9aa7a880229938bffd2d5dc0dfcb3d263da060e8` (`feat: provision signed demo country pack`) |
| Remote | `origin` → `github.com/OffBrand-org/kitchen-kit-backend.git`; `upstream` → `github.com/AhmedShantti/ros.git` |
| Dirty files | `kitchen-kit/backend/prisma.config.ts` only (pre-existing, not made by this task — see §M) |
| Migrations | 27, newest `20260824100000_sales_order_payment_capture`. **Nothing exists after Payment** — no migration for Country Pack provisioning (it ships as committed JSON config, not a migration), no P1F-2 migration (28/29/30 as designed) |
| OpenAPI | `openapi: 3.1.0`, **95 paths, 133 operations** (confirmed by direct read of `docs/api/openapi.json` and by re-running `npm run openapi:check`, which regenerates and diffs — zero drift). This is the **same 133** P1F-1A shipped; the 134/135 the P1F-2B/C/D/E design reports project never materialized in the contract, confirming no P1F-2 route was ever added. |
| Unit test files | 53 (`src/**/*.spec.ts`) |
| E2E test files | 34 (`test/**/*.e2e-spec.ts`) — none named for completion, receipt, or day-close |

## C. Source / evidence review

Reviewed directly in this task: `ROS_SRS_v1.0.pdf` (converted to text and grepped/read section-by-section — Ch. 8 POS, Ch. 9 KDS, Ch. 10 Menu/Recipe, Ch. 11 Inventory, Ch. 13 Costing, Ch. 15 Security, Ch. 16 Finance/Tax, Ch. 17 Multi-Branch, Ch. 21 Offline, Ch. 26 API); `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (P1C and P1F-2 carried items, both Completion-Economics and FIFO-Exhaustion-Carry-Forward ratifications); `docs/reports/claude/INDEX.md` in full; the P1F-1/P1F-1A/P1E-6/P1E-6A/P1F2/P1F2A-E-A/2026-08-26 Country-Pack reports (read for claims, then independently checked against code — not trusted verbatim); current module code for all 13 named modules; `prisma/schema.prisma` and all 27 migrations; `docs/api/openapi.json`; `src/main.ts`. Five parallel focused code audits were run (Sales/Treasury; Production/Inventory; Kitchen/Catalogue/Receipt; Identity/Organisation/Governance/Sync/Workforce + RLS survey; API/OpenAPI + build verification) — each independently grepped and read actual files rather than summarizing prior reports.

## D. Protected MVP path status (one table, every node)

| # | Node | Status | SRS IDs | Evidence |
|---|---|---|---|---|
| 1 | PIN/operator auth | **COMPLETE** | FR-API-010, FR-SEC-* | `identity/employees/pin.service.ts`, `POST /auth/pin`, JWT HS256 pinned iss/aud, e2e `pin.e2e-spec.ts` |
| 2 | Shift open | **PARTIAL** | FR-POS-090 | `workforce/shifts/shifts.service.ts` — open only; no scheduling |
| 3 | CashSession open | **PARTIAL** | FR-POS-090, §16.2 | `treasury.controller.ts:166` `POST /cash-sessions` → `CashSessionsService.open()`. **Only route in the entire Treasury module** (confirmed by full-file grep) |
| 4 | Create Order | **COMPLETE** | UC-POS-01 steps 1-2 | `sales/orders` DRAFT creation, order number, `opened_by` |
| 5 | Add items / price / tax | **COMPLETE** | FR-POS-040, FR-FIN-030..035 | Line capture with modifiers, `CountryPackService`-resolved tax, `vat_standard` engine |
| 6 | Sale-time cost snapshot | **COMPLETE** (as a snapshot only) | FR-CST-002 (partial), schema | `order_lines.unitCostSnapshot`, `orders.cogsTotal` (nullable estimate) — **this is NOT posted COGS**, see §I row 3 |
| 7 | Fire | **COMPLETE** | UC-POS-01 step 6, BR-POS-* | `SalesFireService`, `POST /:businessDay/:id/fire`, `first_fired_at`, `order.line.fired`, one transaction, concurrency-tested |
| 8 | Kitchen routing / ticket persistence | **COMPLETE** | FR-KDS-010/011 | `RoutingResolverService`, `OrderLineFiredHandler`, `kitchen.tickets`/`ticket_lines`/`ticket_fire_batches`/`ticket_line_modifiers`, RLS ENABLE+FORCE on all 6 kitchen tables, idempotent `getOrCreate*`, `kitchen-ticket-concurrency.e2e-spec.ts` |
| 9 | KDS operator lifecycle (display/start/ready/bump/recall) | **NOT IMPLEMENTED** | FR-KDS-020..029 | `KitchenModule` docstring states outright: "No controller." Zero `.controller.ts` under `src/modules/kitchen`. `TicketPersistenceService` has exactly 4 create-only methods; no `start`/`bump`/`recall`/`cancel` method exists anywhere. Schema carries the full status vocabulary (`queued/in_progress/ready/bumped/served/recalled`) but no code path ever writes those transitions |
| 10 | CASH / manual external-card Payment | **COMPLETE** (for its explicit MVP scope) | FR-POS-060 (partial) | `SalesPaymentService`, `POST /:businessDay/:id/payments`, append-only `sales.order_payments` (RLS ENABLE+FORCE, GRANT SELECT/INSERT only, REVOKE UPDATE/DELETE/TRUNCATE), idempotent, atomic CAS |
| 11 | Final settlement / Order → COMPLETED | **NOT IMPLEMENTED** | UC-POS-01 step 12, BR-POS-002 | `order-state.ts` `TRANSITIONS` map has **no entry** for `open`/`partially_paid` → `completed`. `sales-payment.service.ts` explicitly throws `FullPaymentRequiresCompletionError` rather than complete an order. `orders.completedAt`/`closedBy` exist as columns but are **read-only, never written**, anywhere |
| 12 | Recipe expansion (completion-time) | **DESIGNED ONLY** | FR-CST-001 | `resolveConsumptionBasis`/`planConsumption`: zero occurrences in `src/`. No `modifier_recipe_effects` table |
| 13 | Inventory depletion | **DESIGNED ONLY** | FR-CST-001, §1.2 | No `sale_depletion_effects`/`sale_depletion_allocations` table; `MovementType.sale_depletion` exists only as an **unused enum value** with its own comment noting it has no writer yet |
| 14 | StockMovement ledger (general) | **COMPLETE** (pre-existing, unrelated to completion) | FR-INV-012/013 | `movements.service.ts`, FIFO/weighted-average/standard costing already implemented for transfers/waste/counts — just never invoked by a sale |
| 15 | Posted COGS | **NOT IMPLEMENTED** | FR-CST-001/002 | No `posted_cogs_total` column anywhere in schema or migrations |
| 16 | Cash/tender totals | **PARTIAL** | FR-POS-093/097 | Payments recorded per-order; no X report, no denomination counting found |
| 17 | Receipt | **NOT IMPLEMENTED** | FR-POS-100..106 | Repo-wide grep for "receipt" finds only an unrelated Inventory concept (`goods_receipt`) and a `MenuItem` schema comment that itself states: "The RECEIPT surface has no column in the approved SQL — documented gap." Zero template, zero route, zero generator |
| 18 | CashSession/Shift close | **NOT IMPLEMENTED** | FR-POS-094..097 | No close route in Treasury; `closedAt` column is read-only everywhere it's referenced |
| 19 | Operational day close | **NOT IMPLEMENTED** | FR-FIN-020..026 | No day-close operation, no Z report, found anywhere in `src/` |
| 20 | Minimum reports | **NOT IMPLEMENTED** | FR-FIN-022, FR-CST-003/004 | No reporting module/routes found in this audit's module survey |

## E. Module status

| Module | Status | Notes |
|---|---|---|
| **Identity** | **COMPLETE** for its scope (auth, RBAC engine, tenants/memberships, PIN, terminals, sessions) | Tenant-wide RBAC only — see branch-scoped gap below |
| **Organisation** | **COMPLETE** for brands/branches/warehouses/central-kitchens/stations/tables/operating-hours/print-routing/locations, all RLS ENABLE+FORCE | |
| **Localisation** | **COMPLETE** for the shipped Country Pack/tax mechanism (parser, Ed25519/JCS signature verification, registry, `vat_standard` engine, TaxClass provisioning); one real signed demo pack (EG/EGP) now committed and tested. **NOT** production-certified fiscal compliance — do not overclaim (§ below) | See §F item 8 |
| **Catalogue** | **COMPLETE** for menu/category/variant/modifier/price-list/availability(incl. 86)/tax-class-assignment chain needed by the MVP order flow | `POST /catalogue/availability-rules/:ruleId/86` verified legitimate — see §L |
| **Production** | **PARTIAL** — pre-P1F-2 baseline only (recipes, recipe versions, substitute groups, recipe costing at line-capture) | P1F-2's `resolveConsumptionBasis`/`planConsumption`/modifier-recipe-effects: **NOT IMPLEMENTED** |
| **Sales** | **PARTIAL** — Order create/price/tax/Fire/partial-Payment COMPLETE; **COMPLETED transition NOT IMPLEMENTED** | See §D rows 11-15 |
| **Kitchen** | **PARTIAL** — backend Fire/routing/persistence COMPLETE; operator-facing KDS **NOT IMPLEMENTED** (no controller at all) | See §D row 9 |
| **Treasury** | **PARTIAL** — CashSession/Drawer/Shift **open only**; no close, no variance, no X report | Only one route in the whole module |
| **Inventory** | **PARTIAL** — general ledger/costing (transfers/waste/counts/FIFO/weighted-average/standard) COMPLETE and pre-existing; sale-triggered depletion **DESIGNED ONLY** | |
| **Audit/Governance** | **COMPLETE** as an append-only, hash-chained, DB-enforced ledger (`governance.audit_entries`, REVOKE UPDATE/DELETE/TRUNCATE) | Per-mutation coverage across every service is NOT SOURCE-DECIDABLE from this pass (spot-check only, not exhaustive) |
| **Sync/Offline** | **NOT IMPLEMENTED** | No `src/modules/sync` application module exists; `sync.idempotency_keys` is the HTTP-idempotency substrate, not offline sync. No 72-hour Isolated-mode capability (FR-OFF-001..003) exists in this backend |
| **Workforce** | **NOT IMPLEMENTED** beyond the Shift-open primitive | No scheduling, no payroll, no timesheets |
| **Reporting/Fiscal** | **NOT IMPLEMENTED** | No report routes found; `fiscal.tax_classes` exists (Localisation-owned identity table) but no fiscal document/Z-report/food-cost-report generation exists |

## F. Completed / accepted work (real, implemented facts only)

1. Identity: full auth/RBAC/tenant/PIN/terminal substrate, tenant-wide, RLS-enforced.
2. Organisation: full org-structure CRUD, RLS-enforced.
3. Catalogue: full menu/pricing/availability chain, including the legitimate `/86` toggle.
4. Localisation: Country Pack parser, Ed25519/RFC-8785 signature verification (CARRIED ITEM P1C-3), `vat_standard` tax engine, TaxClass auto-provisioning at tenant creation, and — as of 2026-08-26 — one real signed EG/EGP demo pack + public trust manifest committed at `config/country-packs/`, covered by `country-pack.deployment-artifacts.spec.ts` (6 tests) and `country-pack.service.spec.ts` (3 tests, including branch currency-mismatch refusal).
5. Sales: Order DRAFT→OPEN (Fire) with full routing/ticket integration; partial CASH + manual-external-card Payment, append-only, idempotent, RLS-enforced, atomically CAS'd.
6. Kitchen: Fire-time ticket persistence and routing resolution, RLS-enforced, idempotent, concurrency-proven.
7. Inventory (general ledger): transfers/waste/counts, FIFO/weighted-average/standard costing — real and working, but never invoked by a sale (that invocation is exactly what P1F-2 was designed to add and has not been built).
8. Audit: append-only, hash-chained, DB-enforced audit ledger.
9. Cross-cutting: every tenant-scoped table across every schema surveyed (identity, governance, org, kitchen, catalogue, inventory, production, sync, sales, fiscal, workforce, treasury) is both `ENABLE`d and `FORCE`d for RLS; `ros_app` confirmed `NOBYPASSRLS` everywhere (no `BYPASSRLS` grant found repo-wide).

## G. Designed-only work (architecture/governance settled, no executable behavior)

1. **P1F-2 Completion** — the entire slice: `orders` → `completed` transition, `posted_cogs_total`, `order.completed` event, `ORDER_COMPLETED` audit action, Production's `resolveConsumptionBasis`/`planConsumption`, `modifier_recipe_effects`, Inventory's `fifo_cost_quantity_consumed`, `sale_depletion_effects`/`sale_depletion_allocations`, the dual physical/accounting FIFO axis, the shared FIFO-cost-ledger kernel, the reservation-first ordering, multi-batch allocations. Fully designed across 6 accepted reports (P1F2, P1F2A, P1F2B, P1F2C, P1F2D, P1F2E, P1F2E-A) and two ratified governance entries. **Zero migration, zero production code.**
2. KDS operator lifecycle — the schema vocabulary exists (`TicketStatus`, `TicketLineStatus`, timestamp columns) but is pure design; no service/route consumes it.
3. Receipt — SRS-mandated (FR-POS-100..106) but not even schema-designed; the codebase's own comment records it as an acknowledged gap.

## H. Internal MVP remaining work (ordered by dependency)

1. **Order → COMPLETED transition** (Sales) — the single hardest blocker; nothing below this list item can start without it existing at least in a minimal form.
2. **Recipe expansion + Inventory depletion + COGS posting** (Production + Inventory + Sales) — per the already-ratified P1F-2E-A design; this is a large slice, not a quick add.
3. **Minimal Receipt** (at least an internal, non-fiscal itemized receipt — FR-POS-100 in full requires country-pack-mandated fiscal elements, QR, bilingual templates; an Internal MVP can defer that layer per §J).
4. **CashSession/Shift close + cash declaration/variance** (Treasury) — required to make a sale reconcilable at all; currently a session can open but never close.
5. **Minimal day close** (Z-report-equivalent) — depends on #4 (FR-FIN-021 blocks day close while any session is open) and on #1/#2 for the report to reflect real completed-sale numbers.
6. **Minimum reports** (at least gross/net sales, tax by rate, sales by tender) — depends on #1/#2/#5 existing to have real data to report on.
7. **KDS minimal operator lifecycle** (start/ready/bump at minimum) — not on the critical path to a completed sale record (Kitchen already receives fired lines), but needed for a *usable* pilot/demo since without it the kitchen has no way to signal readiness back to front-of-house. Can proceed in parallel with #1-3.
8. **Branch-scoped RBAC** — not required to demonstrate a single-branch pilot, but is a named, tracked gap (FR-SEC-010, prior reports) that should not be silently forgotten; low urgency for a single-branch Internal MVP, real gap for any multi-branch demo.

## I. Production-Ready MVP remaining work (additional, beyond Internal MVP)

1. Full FR-POS-100..106 receipt: country-pack-templated layout, bilingual, digital delivery (SMS/WhatsApp/email/QR), reprint marking.
2. Full fiscal submission/outbox (§5.5.3, no outbox exists repo-wide per earlier P1F-2 gates).
3. Full KDS per FR-KDS-020..044 (colour-coding by elapsed time, recall window, amendment visual distinction, bottleneck analytics, target prep times).
4. Branch-scoped RBAC enforcement (FR-SEC-010's full "standard roles" grant is itself PARTIAL — see §K).
5. Production Country Pack governance/certification pipeline (today's demo pack is explicitly non-certified — see §L Country Pack caveat).
6. §26.2 RFC 7807 error envelope (SRS-mandated; current envelope is Nest's plain default, documented as a deliberate truthful choice, not RFC 7807).
7. §26.1 `/v1` URL versioning (not implemented; no global prefix, no proxy config found).
8. Partition scheduler/automation for the range-partitioned `sales.orders`/`order_lines`/`stock_movements` tables (partitions currently hand-created per migration, ending at a fixed horizon per prior reports).
9. CI/CD pipeline, dependency/security scanning, observability/SLO instrumentation, backup/restore + restore-drill procedure, MFA/privileged-auth controls, formal secret management (today: `.env` + Render env vars) — none of these were found in this audit's scope and none are addressed by any reviewed report.
10. Operational runbooks.

## J. Deferrable post-MVP scope

| Area | SRS refs | Why deferrable |
|---|---|---|
| 72-hour offline (Isolated mode) | FR-OFF-001..003, §21 | No local client exists in this backend-only repository; a controlled pilot can run online-only |
| Integrated card terminal lifecycle | FR-POS-060 (full) | Current Payment MVP explicitly ships CASH + **manual/external-card recording** only, not an integrated terminal — do not claim integrated card support anywhere |
| Additional tenders (loyalty points, gift card, etc.) | FR-POS-060 (full) | Not needed for a controlled cash/manual-card pilot |
| Procurement (Ch. 12) | FR-PRC-* | No purchasing/supplier code found in this audit; irrelevant to a sales-side pilot with manually-set opening stock |
| CRM/Loyalty | referenced in UC-POS-01 step 13 as a subscriber | No `Customer` model exists (confirmed in earlier P1F-2 gates); vacuously out of scope |
| Workforce scheduling/payroll | Ch. not audited in depth here, module confirmed near-empty | Only the Shift-open primitive exists; scheduling is a distinct, larger feature |
| Central kitchen workflows | referenced in Organisation schema (`central_kitchens` table exists) | Table exists, no workflow logic found; not on the single-branch critical path |
| Aggregator integrations | not directly audited | No evidence of any aggregator adapter in the module survey |
| Advanced floor/table management | FR-POS-080..083 [S] | Explicitly [S] (should), not [M]; basic table assignment already works via Organisation's `tables` |
| Advanced KDS (priority flags, all-day counts, icon mode) | FR-KDS-027/030/031 [S] | [S]-classified, and the [M] baseline (FR-KDS-020..029) isn't built yet either — advanced KDS is doubly deferred |
| Full analytics catalogue | Ch. 13/16 reporting breadth | No reporting module exists yet at all; full catalogue is far beyond even the minimum reports needed for Internal MVP |
| Broader country packs (beyond the one demo EG/EGP pack) | FR-BRN-003 | Mechanism supports it (`CountryPackRegistry` is code-keyed, not branch-hardcoded); only one pack is provisioned today, more is pure configuration/content work, not engineering |
| Advanced costing/reporting (contribution margin, food-cost-% by dimension) | FR-CST-003..005 | Depends entirely on posted COGS existing first (§D row 15) — cannot even begin |

None of the above is classified COMPLETE; each is either NOT IMPLEMENTED or, where a substrate exists (country packs, tables), explicitly noted as partial/available-but-unused.

## K. Security / tenancy / RLS status

- Every tenant-scoped table surveyed across all 12 schemas (identity, governance, org, kitchen, catalogue, inventory, production, sync, sales, fiscal, workforce, treasury) has both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` — the two exceptions (`identity.roles`, `identity.role_permissions`, ENABLE-only) are a **documented, deliberate** design so `ros_migrator` can seed system roles, not an oversight.
- `ros_app` is confirmed `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` in the role-init script, and no `BYPASSRLS` grant exists anywhere in any migration.
- Fail-closed missing-context behavior: confirmed pattern throughout (`NULLIF(current_setting(...,true),'')::uuid` → NULL → predicate false → fail closed), consistent with every migration reviewed in this and prior sessions.
- **Branch-scoped RBAC is NOT IMPLEMENTED.** `MembershipRole.branchId` exists as a nullable schema column with a comment stating verbatim it is "not yet consumed by permission resolution." `TenantContextService` builds a flat, tenant-wide permission set with zero branch filtering; `PermissionGuard` checks only that flat set. **Every permission grant in the system today is 100% tenant-wide.** This directly confirms the gap named in FR-SEC-010 and flagged (but not fixed) across the P1E-6A/P1F-1A reports — it is real, current, and unresolved, not merely historical.
- Audit ledger is append-only at the DB level (`REVOKE UPDATE, DELETE, TRUNCATE` on `governance.audit_entries`), hash-chained. Per-mutation audit coverage across every service was spot-checked, not exhaustively swept — **NOT SOURCE-DECIDABLE** whether every mutating action currently records an audit entry without a dedicated full sweep.

## L. API / frontend readiness

- OpenAPI 3.1.0, 95 paths, **133 operations** (confirmed live, matches P1F-1A's baseline exactly — the 134/135 the later P1F-2 design gates project never shipped, which is itself independent confirmation that no P1F-2 route exists).
- Swagger UI at `/docs`; no `app.setGlobalPrefix` — **§26.1's `/v1` URL versioning is NOT IMPLEMENTED**, and no proxy/infra config exists in-repo to say otherwise (matches the prior API-1A report's own finding, unchanged).
- Auth: HS256, pinned issuer `ros-identity` / audience `ros-identity-api`, unchanged.
- ETag/If-Match: implemented, but **Sales-only** (`orders.controller.ts`, `order-lines.service.ts`) — not a cross-module convention yet.
- Idempotency-Key: implemented in `src/common/idempotency/*`, consumed by exactly two controllers today (Sales orders/payments, Treasury cash-sessions) — **FR-API-020's "every POST/PATCH" is PARTIAL**, not global.
- Error envelope: **§26.2's RFC 7807 is NOT IMPLEMENTED.** No global exception filter exists; the one exception filter in the repo is Sales-scoped. `src/common/openapi/oas31.util.ts` documents this as a deliberate truthful choice over fabricating an unimplemented shape — a defensible engineering call, but the SRS requirement is unmet.
- `POST /catalogue/availability-rules/:ruleId/86` — **verified real and legitimate.** "86" is genuine industry terminology for removing an item from sale (not a bug or leftover route); the code cites `FR-MNU-030/032` directly, is permission-guarded (`AVAILABILITY_TOGGLE`), tenant-scoped, audited, and documented in OpenAPI. **Does not block MVP.** Only stylistic note: the path segment is non-resource-shaped, a style choice rather than a defect.
- CORS: falls back to allow-all if `CORS_ORIGIN` is unset — acceptable for a controlled internal pilot, a Production-Ready gap (§I item 9 territory).
- Current frontend-usable API is genuinely broad (Identity, Organisation, Catalogue, Localisation, partial Sales/Kitchen/Treasury) but stops exactly where the protected MVP path stops (§D) — a frontend can authenticate, browse/manage catalogue and org structure, create/fire/partially-pay orders, and nothing past that.

## M. Technical debt that must not be confused with MVP completion

1. **`prisma.config.ts` is currently, locally modified (uncommitted)** to use `env("APP_DATABASE_URL")` (the `ros_app` runtime role, no DDL rights) instead of `DATABASE_URL` (`ros_migrator`, the owner role) for Prisma CLI operations. This predates this task, was flagged (not fixed) in the 2026-08-26 Country Pack report, and remains unresolved and uncommitted as of this audit. If ever committed/pushed it will break `prisma migrate deploy` identically to how it broke this session's own scratch-DB verification. **Not part of MVP scope; a standing local hazard.**
2. `orders.cogsTotal`/`order_lines.unitCostSnapshot` are a **sale-time estimate**, never posted completion COGS — do not let a future report casually call FR-CST-001/002 "complete" because these columns exist and are populated. FR-CST-002's literal wording (COGS recorded on the order line, never recomputed retroactively) is **not satisfied** by the sale-time snapshot alone; posted COGS per FR-CST-001 does not exist.
3. `MovementType.sale_depletion` exists as a schema enum value with **no writer** — do not mistake its presence in `schema.prisma` for depletion capability.
4. The Country Pack demo pack (`EG-2026.1`) is real, signed, and verified — but it is **explicitly a development/demo artifact**, not a production-certified Egyptian fiscal pack. FR-LOC-023 (full conformance suite) and FR-LOC-031 remain NOT satisfied; do not let deployment success be read as fiscal certification.
5. RFC 7807 error envelope and `/v1` prefix are SRS-mandated but absent — a frontend team should be told explicitly not to code against either assumption yet.
6. Branch-scoped RBAC schema column (`branchId`) existing must not be read as the feature existing — it is inert.

## N. Dependency graph (Internal MVP remaining work)

```
Order → COMPLETED transition (Sales)
 ├─ BLOCKS → Recipe expansion + Inventory depletion + COGS posting (Production/Inventory/Sales)
 │            └─ BLOCKS → Posted COGS-based reporting (food cost %, contribution margin)
 ├─ BLOCKS → Receipt (minimal internal receipt needs a completed, immutable order to print from)
 ├─ BLOCKS → trustworthy day close (Z report needs completed-order truth, not partial-payment state)
 └─ BLOCKS → CashSession close reconciliation (FR-FIN-021: day close blocked while any session open,
              and a session's expected-cash total is only meaningful against completed sales)

CashSession/Shift close + variance (Treasury)
 └─ BLOCKS → Day close (FR-FIN-021, explicit blocking rule)
      └─ BLOCKS → Minimum reports (Z-report-equivalent needs day close to have run)

KDS minimal operator lifecycle (start/ready/bump)
 └─ INDEPENDENT of the above chain — Kitchen already receives fired lines; this only affects
    front-of-house/kitchen coordination visibility, not the sale's financial correctness.
    Can be built in PARALLEL with Completion.

Branch-scoped RBAC
 └─ INDEPENDENT — a single-branch pilot does not need it; do not let it block the Completion slice.
```

Serial blockers on the money/financial-truth path: **Completion → Depletion/COGS → Receipt/Day-close/Reports**, in that order, with CashSession close joining the day-close dependency from a separate branch. KDS lifecycle and branch-scoped RBAC are parallel, non-blocking tracks.

## O. Single next slice

**P1F-2 — Completion, Recipe Expansion, Inventory Depletion & COGS Posting** (the already-designed slice, per P1F2E-A's final Sonnet prompt), **verified against the current repository rather than assumed**.

- **WHY NOW:** It is the single hard blocker on the entire rest of the protected MVP path (§N). Nothing past Payment can proceed — not Receipt, not day close, not reporting — until an Order can legally reach `COMPLETED`. It is also the most thoroughly de-risked slice available: five design/correction gates plus two ratified governance entries have already resolved every disputed FIFO/valuation/provenance/locking question. No other candidate slice unlocks as much downstream work per unit of engineering effort.
- **SRS REQUIREMENTS:** FR-CST-001, FR-CST-002 (literal wording), UC-POS-01 steps 12-13, BR-POS-001/002, §1.2's nine mandated atomic completion effects, §5.5.2/§5.5.3, §24.2.4 (Order.complete() reference pseudocode), FR-INV-012/013 (FIFO), BR-INV-003.
- **DEPENDENCIES:** All satisfied per the ratified design — Payment MVP (done), Fire/routing/ticket persistence (done), recipe/recipe-version substrate (done, pre-P1F-2), stock batch/movement/level substrate (done, pre-P1F-2), Country Pack tax resolution (done). No unresolved upstream blocker was found in this audit.
- **READINESS:** P1F2E-A's own final Sonnet prompt (§L of that report) is the most current, most-corrected specification (superseding P1F2A/C/D's own prompts). It should be re-verified against the *current* repository state before use (this audit did not re-derive it — that re-verification is the first step of the next slice, not of this one) since two commits have landed since P1F2E-A was written (the Payment checkpoint doc commit and the Country Pack commit) — neither touched Sales/Production/Inventory schema, so the design's premises are very likely still valid, but this must be explicitly re-confirmed, not assumed, before implementation begins.
- **WHAT IT UNLOCKS:** Order completion (the actual sale record becoming final/immutable/reportable), inventory truth (real depletion instead of a ledger that only reflects transfers/waste/counts), real COGS (unlocking FR-CST-003/004/005 reporting), the precondition for Receipt (an internal receipt needs a completed order to print), and the precondition for CashSession/day close to mean anything financially.
- **RISKS:** This is the largest single slice audited here — 3 new migrations (Sales/Production/Inventory), a new private Inventory locking kernel, and a genuinely intricate FIFO/FEFO dual-axis valuation model. The design gates found and fixed 20+ real defects across their own iterations (C-1 through C-20), which is a signal of real complexity, not instability — but it means this slice is not a quick add and should be scoped, tested, and reviewed with the same rigor the design gates already applied.
- **GOVERNANCE STATUS:** Fully ratified, no open governance question remains per P1F2E-A/P1F2C (Completion Economics & Depletion Resolution — 2026-08-25; FIFO Exhaustion Carry-Forward Ratification — 2026-08-25). No new governance action is required to begin.
- **EXPECTED MODULES:** Sales (completion orchestration, CAS-last transaction), Production (`resolveConsumptionBasis`/`planConsumption`, new `modifier_recipe_effects` table, one new route pair for recipe-effects read/write), Inventory (new depletion effect/allocation tables, FIFO cost-ledger kernel, `MovementsService.post` counter-maintenance extension).
- **EXPECTED MIGRATIONS:** 3 new (Sales, Production, Inventory), per the ratified design — current count 27 → 30.
- **EXPECTED API IMPACT:** OpenAPI 133 → 135 per the ratified design (one new Production route pair); no existing route's contract changes.
- **VERIFICATION GATES:** All P1F-2B/C/D/E-A negative/positive test requirements (conflict-safe reservation-first insert, deterministic FIFO/no-SKIP-LOCKED locking, migration-upgrade test proving receipt-order backfill correctness, concurrency race test vs. `MovementsService.post`, fail-closed conversion-gap handling, append-only Sales snapshot immutability) plus the existing full regression suite (53 unit spec files, 34 e2e spec files) must all still pass. A scratch database (never the persistent local `ros`) should be used for any DB-touching verification, exactly as done in this and the prior Country Pack session.

## P. Next-slice readiness gate

| Gate | Status |
|---|---|
| Design settled | YES — P1F2E-A, superseding all prior P1F-2 prompts |
| Governance ratified | YES — two ratified 2026-08-25 entries, no open question |
| Upstream dependencies implemented | YES — Payment, Fire, recipe/stock substrate all confirmed present in code |
| Current repo state re-verified against the design's premises | **NOT DONE IN THIS AUDIT** — required as literally the first step of the implementation task, since 2 commits have landed since the design was written |
| Blocking unresolved source input | NONE FOUND |
| Blocking repository contradiction | NONE FOUND |

## Q. Risks / blockers / NOT SOURCE-DECIDABLE items

- **NOT SOURCE-DECIDABLE:** whether every mutating action across the whole app currently writes an audit entry — this audit spot-checked, did not exhaustively sweep every service.
- **NOT SOURCE-DECIDABLE from this session:** the live Render runtime's actual current tenant/database state (this audit is repository-only; the Render Country Pack unblock's log evidence was reported by the user, not independently observed here).
- **Risk, not a blocker:** `prisma.config.ts`'s local uncommitted modification (§M) — could silently break a future `migrate deploy` if committed without review.
- **No hard blocker was found** preventing the P1F-2 slice from starting engineering work, given the re-verification step in §P is performed first.

## R. Updated MVP assessment

**NON-AUTHORITATIVE ENGINEERING ESTIMATE — basis stated, not a governance figure:**

Treating "Internal MVP" as the protected path in §D plus minimum viable Receipt/close/reporting (§H): roughly **55-60%** of the Internal MVP path has real, verified, working behavior (PIN through partial Payment, plus the full Identity/Organisation/Catalogue/Localisation substrate those steps depend on). The remaining **40-45%** is concentrated in exactly one large, already-designed slice (Completion/depletion/COGS) plus three smaller, currently-unstarted slices (minimal Receipt, Treasury close, minimum reports) and one parallel-track item (KDS operator lifecycle). This estimate is a rough weighting by "protected-path nodes with real code" vs. "nodes with none," not a requirements-count percentage, and should not be quoted as a formal completion metric.

## S. Final verdict

MVP AUDIT VERDICT:
READY TO CONTINUE

NEXT IMPLEMENTATION SLICE:
P1F-2 — Completion, Recipe Expansion, Inventory Depletion & COGS Posting

WHY:
It is the sole hard blocker on every downstream MVP node (Receipt, CashSession/day close, reporting). It is the most de-risked available slice — five design gates and two ratified governance entries already resolved every disputed valuation/locking/provenance question, and every one of its upstream dependencies (Payment, Fire, recipe/stock substrate) is confirmed implemented in current code, not just designed.

HARD BLOCKERS:
None found. The design must be re-verified against the current repository state (two commits have landed since P1F2E-A was written) as the first step of implementation, but this is a verification step, not an unresolved blocker.

DO NOT START YET:
Receipt generation (depends on Completion existing); CashSession/Shift close and day close (depend on Completion for financially-meaningful numbers, and day close additionally depends on session close); minimum reports (depend on posted COGS and day close); KDS operator lifecycle (independent, may run in parallel, but is not this slice); branch-scoped RBAC (independent, lower urgency for a single-branch pilot); any Production-Ready-only item in §I.

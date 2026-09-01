# POST-KDS — Internal MVP Final Rebase & Next-Slice Selection Gate

| Field | Value |
|---|---|
| **Task / slice name** | POST-KDS Internal MVP — final rebase + next-slice selection gate |
| **Report type** | Analysis / rebase / next-slice selection. **No implementation.** |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** The `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the only authorities. This report records what was verified in *this* session against the repository at the HEAD below. It ratifies nothing, decides nothing, and creates no scope. Where it disagrees with an older report, the *current source* is the reason, and the disagreement is stated explicitly in §4. |
| **Date** | 2026-08-31 |
| **HEAD** | `38e007b0cd285679fc7fd334aec54d3bf2a8006c` — *feat: complete KDS operator lifecycle* |
| **Parent** | `121b889` — *feat: add cash session close* |
| **Branch** | `feat/production-spec` |
| **Working tree** | Clean of all source, schema, test, migration and OpenAPI drift. Dirty **only** in `docs/reports/claude/`: one modified `INDEX.md` (4 unstaged rows) and four untracked pre-existing reports — exactly the state the KDS closure documented. Untouched by this task except for the single INDEX row this task appends. |
| **Task identifier** | POST-KDS_MVP-final-rebase-and-next-slice |
| **Status** | COMPLETE |
| **Migrations** | 34 — unchanged. No migration created, modified or planned by this task. |
| **Tests** | **No test run was executed in this session.** Test *files* are cited below as structural evidence only. No prior run's results are restated as newly executed. |

---

## §0. VERDICT

> ## **A. INTERNAL MVP REBASE CLEAN — NEXT SLICE SELECTED**
>
> **NEXT SLICE: MINIMUM OPERATIONAL REPORTING (branch daily trading read surface).**
>
> It is the **only** remaining Internal-MVP protected-path gap that is
> simultaneously (i) real, (ii) upstream-complete at this HEAD, and
> (iii) **not standing behind a ratified governance exclusion**.
>
> **Receipt is NOT selectable.** It is not merely unimplemented — it is
> **BLOCKED by the standing, twice-reaffirmed P1C-1 fiscal exclusion.**
> **Branch-scoped authorization is NOT selectable.** It is **BLOCKED by D-2**,
> whose defer was explicitly reconfirmed in force by the KDS ratification at
> this very HEAD.
>
> Two narrowly-isolated **user decisions** are surfaced in §14 for parallel
> consideration. Neither blocks the selected slice.

---

## §1. VERIFIED REPOSITORY BASELINE

Commands run first, in this session:

```
git status --short
git rev-parse HEAD
git branch --show-current
git log -15 --oneline
git show --stat --oneline HEAD
```

**Result — every expectation matched exactly.**

| Expectation | Observed | Verdict |
|---|---|---|
| HEAD `38e007b0cd285679fc7fd334aec54d3bf2a8006c` | identical | ✅ |
| Subject `feat: complete KDS operator lifecycle` | identical | ✅ |
| Parent `121b889` *feat: add cash session close* | identical | ✅ |
| Branch `feat/production-spec` | identical | ✅ |
| Dirty tree = 4 unrelated reports + unstaged `INDEX.md` rows only | identical (`M INDEX.md`, 4 `??` reports) | ✅ |
| No source / schema / test / migration drift | `git status --short` returns **nothing** outside `docs/reports/claude/` | ✅ |

`git show --stat HEAD` confirms the KDS commit's 57 files: `KitchenController`
(Kitchen's first controller), `KdsStationGuard`, `KdsOperationsService`,
`ticket-projection`, the two Sales subscribers (`ticket-bumped.handler.ts`,
`ticket-recalled.handler.ts`), 6 new KDS e2e specs, the regenerated OpenAPI
(`+416` JSON / `+251` YAML), and `+299` register lines — **and no migration**.

**The four untracked reports and the unstaged `INDEX.md` rows were not
modified, staged, deleted or "cleaned up" by this task.**

**BASELINE: TRUSTWORTHY. No repository-baseline blocker.**

---

## §2. AUTHORITY ORDER APPLIED

1. `ROS_SRS_v1.0.pdf` — extracted and read directly this session (§16.5 Day
   Close, §8.8 FR-POS-100…106, §15.2 permission catalogue, §19 Reporting,
   §22.2 Country Pack, §16.3 FR-FIN-010, UC-POS-01).
2. `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (7,126 lines) — D-2,
   CARRIED ITEM P1C-1, the P1F-2 Completion Economics entry, the P1G-1
   Cash-Close Policy Ratification, R-6, and the KDS MVP Operator Lifecycle
   Ratification, all read in full at their preservation clauses.
3. **The repository at `38e007b`** — Prisma schema (88 models), 34 migrations,
   the generated OpenAPI (109 paths), and the module sources cited throughout.
4. FINAL-ACCEPTED closure reports (KDS ×3, P1G-1 ×7, P1G-0, Approval Runtime,
   P1F-2, Payment, Fire).
5. `ROS_MVP_READINESS_AND_REMAINING_WORK.pdf` + the two prior MVP rebase
   reports — **historical evidence only**.
6. Engineering inference — used only where §4/§6/§7/§8 say so explicitly.

**Executable code at `38e007b` was treated as winning over every
implementation-status prose claim, in both directions.** Several historical
"ABSENT" classifications are corrected to COMPLETE in §4; one historical
"folded in" claim is corrected *downward*.

---

## §3. THE INTERNAL MVP DEFINITION, RECONSTRUCTED

Taken from `ROS_MVP_READINESS_AND_REMAINING_WORK.pdf` Part 4 ("The first ROS
MVP, defined") — *"the smallest coherent product that lets one branch of one
tenant take an order, get paid, feed the kitchen, deplete stock, and close the
day — with tenant isolation and audit intact"* — re-derived against the SRS and
re-scored against **current** source.

### A. INTERNAL / ENGINEERING MVP (a controlled pilot on non-production data)

Permitted carve-outs: **online-only**, **one country pack**, **one branch
operationally**, **no offline store**, **no fiscal submission**, **no analytics
warehouse**.

Non-negotiable and NOT weakened anywhere below: **tenant isolation, PIN
authentication, payment idempotency, financial integrity, audit**.

### B. PRODUCTION-READY MVP (real money, real customers)

Adds: fiscal receipt + submission, branch-scoped RBAC actually enforced, MFA
for privileged roles, encryption/KMS/secrets, SLOs, restore drills, scan gates,
day-close automation, printer/queue resilience (FR-POS-106).

### C. POST-MVP / DEFERRED

Offline & sync (FR-OFF-*), theoretical-vs-actual costing, procurement, CRM /
loyalty, workforce scheduling, aggregator channels, central-kitchen
distribution, multi-branch consolidation, integrations, the FR-RPT star schema
and dashboards.

### The 15-capability MVP definition, rescored at `38e007b`

| # | Capability | Readiness PDF said | **AT `38e007b`** |
|---|---|---|---|
| 1 | Establish a tenant | COMPLETE | **COMPLETE** |
| 2 | Establish organisation / branch | COMPLETE | **COMPLETE** |
| 3 | Configure catalogue & pricing | PARTIAL (no price resolution) | **COMPLETE** |
| 4 | Configure recipes | COMPLETE | **COMPLETE** |
| 5 | Operator authentication at the terminal | ABSENT | **COMPLETE** |
| 6 | Order entry & lifecycle | ABSENT | **COMPLETE** |
| 7 | Pricing, tax & totals | ABSENT | **COMPLETE** |
| 8 | Payment & tender | ABSENT | **COMPLETE** |
| 9 | **Receipt** | ABSENT — HARD BLOCKER | **NOT IMPLEMENTED — GOVERNANCE-BLOCKED** |
| 10 | Kitchen ticket | ABSENT | **COMPLETE** (dine-in scope) |
| 11 | Inventory depletion on sale | HALF | **COMPLETE** |
| 12 | Cash session & day close | ABSENT | **PARTIAL** — session ✅, **day close ✗** |
| 13 | Multi-tenant safety | COMPLETE | **COMPLETE** |
| 14 | Audit of new operations | PARTIAL | **COMPLETE** for the protected path |
| 15 | **Minimum operational visibility** | ABSENT — HARD BLOCKER | **PARTIAL** — stock-on-hand ✅, session close-context ~, **daily sales ✗** |

**12 of 15 COMPLETE · 2 PARTIAL · 1 NOT IMPLEMENTED (governance-blocked).**

---

## §4. CORRECTIONS TO OLDER REPORTS

Recorded explicitly, because several older statements are no longer true and
one is *over*-stated.

| Older claim | Source | **Correction at `38e007b`** |
|---|---|---|
| "No order, payment, ticket, or receipt exists in any form" | Readiness PDF | Order, payment and ticket all exist and are exercised end-to-end. **Only receipt is still true.** |
| "Price resolution absent — an order could not be priced" | Readiness PDF | `PriceResolutionService` is injected into `order-lines.service.ts:157` and resolves every captured line (FR-POS-040 / FR-MNU-021-023). |
| "PIN authentication entirely [missing]" | Readiness PDF | `POST /auth/pin`, `pin.service.ts`, `test/pin.e2e-spec.ts`. |
| "Cash session & day close — ABSENT" | Readiness PDF | The **cash-session** half is complete through declaration, variance, tolerance policy and approval-gated finalize. The **day-close** half remains absent — the row must now be read as split. |
| P1G-1 next-slice report: "**including the X report** and per-session tender totals, folded in" | `2026-08-28_POST-P1F2` §9 | **Not delivered as an X report.** What shipped is `GET /cash-sessions/{id}/close-context` (`treasury.controller.ts:529`) — a close *pre-flight* (count mode, tolerance, expected cash in open mode only). The register's own P1G-1 entry lists **"the X-report permission"** among items *"not decided by this entry"*. **This report classifies the X report as NOT IMPLEMENTED**, not folded in. |
| "Receipt is therefore not the next slice … the correct first step is a governance decision" | `2026-08-28_POST-P1F2` §5 | **Reconfirmed, unchanged, and independently re-verified against the register at this HEAD.** Nothing since 2026-08-28 has lifted P1C-1. |
| Readiness PDF: Internal MVP ≈ **55–60 %** | Readiness PDF | Superseded — see §12. |

---

## §5. CURRENT MVP CAPABILITY MATRIX

Legend — **Impl**: C = COMPLETE · P = PARTIAL · N = NOT IMPLEMENTED.
Schema existence alone is **never** counted as implementation; a report is
**never** counted as executable evidence. Every row's evidence is a source
path, a route in the generated OpenAPI, or a migration.

| # | Capability | SRS IDs | Impl | Executable evidence at `38e007b` | Acceptance | Deps | Governance | Remaining work | **MVP blocker?** |
|---|---|---|---|---|---|---|---|---|---|
| 1 | PIN authentication | FR-SEC-021/022/028 | **C** | `POST /auth/pin`; `identity/employees/pin.service.ts`; `typ:'pos'` audience refused by dashboard routes (`auth.types.ts`); `test/pin.e2e-spec.ts` | accepted | — | D-2 amendment (defer lifted for exactly this) | — | No |
| 2 | Tenant isolation / RLS | FR-PLT-003/010-012, FR-SEC-045/047 | **C** | RLS migrations from `20260812145207`; `prisma.service.withAuthContext`; `test/rls.e2e-spec.ts` + 5 per-module `*-rls` specs | accepted | — | D-9 ratified | Extend to every new table | No |
| 3 | Terminal registration / revocation | FR-SEC-028 | **C** | `POST /auth/terminals`, `/{id}/status`, `/{id}/fingerprints`; `terminals.service.ts`; `test/terminal.e2e-spec.ts` | accepted | 2 | D-2 amendment item 3 | — | No |
| 4 | **Branch authorization** | FR-SEC-002/003/004 | **N** | **Negative proof:** `context/tenant-context.ts:11-16` — *"branchId → RESERVED, not populated this phase"*; `tenant-context.service.ts` builds the context with **no** `branchId` and loads `membershipRoles` with **no branch predicate** | n/a | 2 | **D-2 defer IN FORCE** (reconfirmed verbatim by the KDS ratification at this HEAD) | Whole slice | **See §9** |
| 5 | Catalogue price resolution | FR-MNU-021/022/023, FR-POS-040/042 | **C** | `catalogue/pricing/price-resolution.service.ts` injected at `order-lines.service.ts:157`; provenance persisted (`price_list_id`, `price_entry_id`, `price_rule`) | accepted (P0 closures) | — | P0 carried items | — | No |
| 6 | Money / rounding | BR-CORE-001/002, BR-FIN-005 | **C** | `common/money/{money,rational,rounding,currency}.ts`; bigint minor units, money-as-string on every view | accepted | — | ADR-008 | — | No |
| 7 | Tax / country pack | FR-FIN-030…034, FR-LOC-020/021/022 | **P** | `localisation/tax/tax.calculator.ts` + `vat-standard.strategy.ts`; per-line tax at `order-lines.service.ts:285`; signed pack (`country-pack.signature.ts`), version pinned on `orders.country_pack_version` | accepted for tax | 5, 6 | C-04 amendment (TaxClass identity) | **Pack models `currency` + `tax` ONLY.** `country-pack.model.ts:34` — *"invoice, fiscal, labour, calendar, legal … deliberately absent"*. FR-LOC-023 not claimed | No (tax half); **yes for Receipt** |
| 8 | Order creation | FR-POS-001/002/005/010 | **C** | `POST /orders`; `orders.service.ts`; `order-number.ts` (`OrderNumberBlock`); `business-day.ts`; partitioned `sales.orders` | accepted | 1,3,5,7 | P1A carried items | — | No |
| 9 | Order lines / modifiers | FR-POS-020…040, BR-POS-004 | **C** | `POST /orders/{bd}/{id}/lines`; BR-POS-004 snapshots on `order_lines`; `OrderLineModifier` with `kind` | accepted | 5,7,8 | P1A / C-02 / C-09 | — | No |
| 10 | Fire | FR-POS-035, UC-POS-01 §6 | **C** | `POST /orders/{bd}/{id}/fire`; `sales-fire.service.ts`; `order.line.fired`; `test/sales-fire{,-concurrency}.e2e-spec.ts` | FINAL ACCEPTED | 9 | Fire Authorization Ratification 2026-08-24 (`pos.order.fire`) | — | No |
| 11 | Payment — cash | FR-POS-060/063 | **C** | `POST /orders/{bd}/{id}/payments`; `sales-payment.service.ts`; `tendered_amount`/`change_given`/`rounding_adjustment` | FINAL ACCEPTED | 8 | P1D-B…G | — | No |
| 12 | Payment — manual external card | FR-POS-065/066 | **C** | same route, `tender='manual_external_card'`; ref/scheme/last4/auth columns, CHECK-constrained | FINAL ACCEPTED | 8 | P1D-F (`pos.payment.capture`) | FR-POS-064 integrated terminal NOT implemented | No |
| 13 | Payment idempotency | FR-API-020…023, FR-POS-065 | **C** | `@Idempotent()` at `orders.controller.ts:612`; `common/idempotency/idempotency.interceptor.ts` (400 / replay / 409-fingerprint / 409-in-flight); `uq_orders_idempotency` | FINAL ACCEPTED | — | D-15 ratified | — | No |
| 14 | Order completion | UC-POS-01 §11-13, BR-POS-001/002 | **C** | `sales-payment.service.ts` — a **settling** payment completes the order **in the same `UnitOfWork` transaction** and publishes `order.completed` (:658); `order-state.ts` transitions `open`/`partially_paid` → `completed` | FINAL ACCEPTED | 11,12 | P1F-2 Completion Economics ratified 2026-08-25 | — | No |
| 15 | Recipe expansion | FR-MNU-040…045 | **C** | `production/costing/consumption-resolution.service.ts` via `PRODUCTION_CONSUMPTION_QUERY`; version/effect/conversion pins on the line | FINAL ACCEPTED | 9 | P1C-2 | — | No |
| 16 | Inventory sale depletion | FR-INV-030, BR-INV-001 | **C** | `inventory/sale-depletion/sale-depletion.service.ts` called at `sales-payment.service.ts:507`; dual-axis FIFO (`costing/fifo-cost-ledger.ts`); `SaleDepletionEffect`/`Allocation` | FINAL ACCEPTED | 14,15 | P1F-2 §7 + FIFO Carry-Forward | — | No |
| 17 | COGS / cost snapshots | FR-CST-001/002, FR-MNU-046 | **C** | `order_lines.posted_cogs_total` + `orders.cogs_total` written at `sales-payment.service.ts:531-563`; `recipeCost.recomputeForStockItems` :525 | FINAL ACCEPTED | 16 | P1C-2 narrow lift | Wider FR-CST deferred | No |
| 18 | Kitchen ticket persistence | FR-KDS-001…010 | **C** | migration `20260823030000_kitchen_ticket_persistence`; `ticket-persistence.service.ts`; `order-line-fired.handler.ts`; `routing-resolver.service.ts` | FINAL ACCEPTED | 10 | KDS-R1…R10 | — | No |
| 19 | KDS operator lifecycle | FR-KDS-020/021/024/025/028 | **C** | `kitchen.controller.ts` — `GET stations/:id/queue` :92, `view` :135, `start` :169, `bump` :197, `bump-all` :228, `recall` :260; `KdsStationGuard`; 5 KDS e2e specs | **FINAL ACCEPTED, SOURCE-CONTROL CLOSED** | 18 | KDS-R11 (`kds.operate`) ratified | — | No |
| 20 | Sales readiness from KDS | UC-POS-01 §7, §5.5.4 | **C** | `sales/orders/ticket-bumped.handler.ts` — same-transaction `updateMany` to `state:'ready'`, guarded `state IN ('fired','preparing')` | FINAL ACCEPTED | 19 | §5.5.4 | — | No |
| 21 | KDS recall consistency | FR-KDS-025 | **C** | `sales/orders/ticket-recalled.handler.ts`; `ticket.recalled` (KDS-R12); `recall_count` cumulative; window from `branch_kds_config` | FINAL ACCEPTED | 19,20 | KDS-R12 ratified | — | No |
| 22 | CashSession open | FR-POS-090, FR-FIN-001/002 | **C** | `POST /cash-sessions`; `cash-sessions.service.ts`; one-open-session invariant; `test/cash-session.e2e-spec.ts` | accepted | 1,3 | P1D | — | No |
| 23 | Cash movements | FR-POS-091 | **C** | `POST /cash-sessions/{id}/{pay-in,pay-out,safe-drop}`; `cash-movements.service.ts`; migration 31 | FINAL ACCEPTED | 22 | P1G-0 | FR-POS-092 drawer limit not decided | No |
| 24 | CashSession close / declaration / variance | FR-POS-093…097, FR-FIN-004/005/006/007 | **C** | `POST /cash-sessions/{id}/close` + `/close/finalize`; `cash-session-close.service.ts`; `CashSessionCloseAttempt`, `CashCountDenomination`; blind mode; tolerance policy; approval-gated finalize with manager PIN; migrations 33-34 | **FINAL ACCEPTED** | 14,22,23 | P1G-1 R-1(a)…R-5 + R-6(a) ratified | FR-FIN-007 adjusting entries PARTIAL; FR-FIN-010 PARTIAL (2 tenders only) | No |
| 25 | **Receipt** | FR-POS-100…106, FR-LOC-022 | **N** | **Exhaustive negative proof — §6** | n/a | 7,14 | **BLOCKED — P1C-1 fiscal exclusion** | Entire capability | **§6** |
| 26 | **Day / business-day close** | FR-FIN-020…026 | **N** | **Exhaustive negative proof — §8** | n/a | 24, 27 | Explicitly *"not decided"* twice | Entire capability | **§8** |
| 27 | **Daily / minimum sales reporting** | FR-RPT-001…005 subset, FR-FIN-010 (per-day half), §19.3 | **N** | **Exhaustive negative proof — §7** | n/a | 14,16,24 | **No exclusion exists** | Entire capability | **YES — SELECTED** |
| 28 | Stock-on-hand read surface | FR-INV-010/015 | **C** | `GET /inventory/levels` (`inventory.controller.ts:732`), `@RequirePermission(inventory.view)`, optional `locationId`; plus `/low-stock`, `/expiring`, `/negative-stock`, `/reconciliation` | accepted | — | D-INV-08 | Branch scoping (row 4) | No |
| 29 | Shift / session report | FR-POS-094/095, FR-FIN-010 | **P** | `GET /cash-sessions/{id}/close-context` (:529) — count mode, tolerance, expected cash (open mode only), and post-close expected/counted/variance | accepted as a *close pre-flight* | 24 | X-report permission *not decided* | **No X report; no shift report; no per-day tender totals** | Partly — folds into row 27 |
| 30 | **Branch-scoped manager read isolation** | FR-SEC-002/003/004 | **N** | **Negative proof:** `GET /orders?branchId=` is an **optional client-supplied filter** (`orders.controller.ts:400`); the route is guarded by tenant-scoped `pos.order.create`; `sales.permissions.ts` states verbatim *"Authorization is TENANT-scoped. D-2's branch-scoped RBAC deferral stands: no handler consults `TenantContext.branchId`"* | n/a | 4 | **BLOCKED — D-2** | Whole slice | **See §9** |
| 31 | Audit across the protected path | FR-AUD-001/002/003/006 | **C** | `AUDIT_ACTION` covers `ORDER_CREATED`, `ORDER_LINE_ADDED/VOIDED`, `ORDER_FIRED`, `PAYMENT_CAPTURED`, `ORDER_COMPLETED`, `SHIFT_OPENED`, `CASH_SESSION_OPENED`, `CASH_MOVEMENT_RECORDED`, `CASH_VARIANCE_DECLARED`, `CASH_SESSION_CLOSED`, `APPROVAL_*`, `TICKET_VIEWED/LINE_STARTED/LINE_BUMPED/BUMPED/RECALLED`; hash-chained (`audit-hash.ts`, `audit-verify.ts`) | accepted | — | D-19 ratified | `report.export` audit (FR-RPT-044) arrives with row 27 | No |
| 32 | Cross-tenant not-found behaviour | FR-PLT-011/012 | **C** | RLS renders foreign rows invisible → 404 not 403; `organisation/branch-scope.ts` documents and relies on exactly this | accepted | 2 | D-9 | — | No |
| 33 | OpenAPI surface | FR-API-* | **C** | `docs/api/openapi.{json,yaml}` — **109 paths**, regenerated in the KDS commit; `test/openapi.e2e-spec.ts` asserts the contract | accepted | — | — | — | No |

**Tally — 33 rows: 26 COMPLETE · 2 PARTIAL · 5 NOT IMPLEMENTED.**

---

## §6. SPECIAL AUDIT — RECEIPT

### Method

Exhaustive grep across `src/` (excluding `src/generated/`) for
`receipt`, `receipts`, `invoice`, `fiscal`, `reprint`, `print`, `document`,
`QR`, and `FR-POS-100`…`FR-POS-106`; plus the full Prisma model list, the full
migration list, the generated OpenAPI path list, and the approved SQL.

### Findings

| Question | Answer | Evidence |
|---|---|---|
| Receipt persistence model? | **NO** | 88 Prisma models; **no** `Receipt`, `TaxDocument`, `InvoiceTemplate`, `FiscalConfig`, `FiscalSubmissionAttempt`. The approved SQL *does* define `fiscal.tax_documents` / `tax_document_lines` / `invoice_templates` / `fiscal_configs` / `fiscal_submission_attempts` (`ROS_DrawDB_Compatible_v3.sql:1264-1302`) — **none migrated.** No migration among the 34 touches `fiscal.*` beyond `20260820140000_fiscal_tax_class_identity`. |
| Receipt generator? | **NO** | Every one of the 40 non-generated hits is an unrelated sense of the word: inventory *goods-receipt* order (`costing.ts`, `fifo-cost-ledger.ts`), `purchase_receipt` movement type, `receipt` as a `print_routing` **document-type string** (`create-print-routing.dto.ts:6`), server *receipt time* (`treasury.dto.ts:103`), or a comment naming Fiscal as out of scope. |
| HTTP / read / print surface? | **NO** | 109 OpenAPI paths — **zero** receipt, document, print-job or reprint route. |
| Created atomically with completion or payment? | **N/A — nothing is created** | `sales-payment.service.ts` steps 13-16 write depletion, COGS, the completed CAS, two audits and `order.completed`. No document. `orders.controller.ts:92` records the *intent*: *"completion must also drive fiscal documents"* — a forward note, not code. |
| Uses Country Pack receipt requirements? | **CANNOT** | `country-pack.model.ts:34` — *"Sections of §22.2 outside this slice (invoice, fiscal, labour, calendar, legal) are deliberately absent … A pack document MAY carry them; they are ignored, not rejected."* The signed EG fixture carries **`currency` + `tax` only**. SRS §22.2's `invoice:` block (`template`, `requiredFields: [seller_trn, buyer_trn_if_b2b, uuid, submission_datetime, qr]`, `sequenceStrategy: pre_allocated_block`, `blockSize`, `voidUnusedOnExpiry`, `qr.standard`) and `legal.receiptFooter` are **not modelled, not parsed, not signed**. |
| Required tax / tender totals available? | **YES — the data exists** | `order_lines`: `tax_class_id`, `tax_amount`, `line_subtotal`, `line_total`, BR-POS-004 name snapshots. `orders`: `subtotal`, `tax_total`, `grand_total`, `rounding_adjustment`, `country_pack_version`. `order_payments`: `tender`, `amount`, `tendered_amount`, `change_given`, `rounding_adjustment`. **A receipt would *render* existing immutable facts; it needs no new snapshot substrate.** |
| Bilingual / localized? | **NO** | FR-POS-102 [M] mandates Arabic-only / English-only / both with defined ordering. `itemNameSnapshot` is `JsonB` (capable), but no template, no language selection, no `legal.receiptFooter`. |
| Receipt number allocated? | **NO** | `OrderNumberBlock` allocates **order** numbers (FR-POS-002), not invoice sequences. FR-POS-100 [M] requires an **invoice sequence**; §22.2 specifies `pre_allocated_block` with `blockSize: 500` and `voidUnusedOnExpiry` — none of it exists. The approved `fiscal.tax_documents` table has **no number column at all**, so even the approved SQL does not settle it. |
| Reprint represented? | **NO** | `pos.reprint.receipt` is SRS-named in §15.2 but **not** in any `*.permissions.ts`. FR-POS-104 is **[S]**, not [M]. |
| Fiscal submission required for Internal MVP? | **NO** | UC-POS-01 §14 says *"where required"*; `fiscal.submission` is production-scope. The Internal MVP carve-out (online-only, non-production data, one pack) legitimately excludes it. |
| Can Internal MVP use a **non-fiscal itemised** receipt? | **NOT WITHOUT A GOVERNANCE DECISION** | See below. |
| Is there already a ratified decision defining this boundary? | **YES — and it forbids the work, not merely defers it** | See below. |

### The governing ratified decision

> **CARRIED ITEM P1C-1** (register): *"Fiscal remains otherwise out of scope:
> **no tax documents, invoice templates, fiscal submissions** or
> `fiscal.tax_rules` table."*
>
> **Reaffirmed verbatim** in the *P1F-2 Completion Economics & Depletion
> Resolution* ratification of 2026-08-25, §"What is NOT reopened":
> *"**P1C-1's Fiscal exclusion (no tax documents, invoice templates, fiscal
> submissions or `fiscal.tax_rules`) stands**."*
>
> **Untouched** by the Approval Runtime, P1G-1, R-6 and KDS ratifications —
> each of whose Preservation clauses re-lists the carried items as unchanged.

A receipt in this repository's approved design **is** `fiscal.tax_documents`
+ `fiscal.invoice_templates`. There is no second, non-fiscal home for it.
And FR-POS-100 [M] / FR-POS-101 [M] as *literally written* demand exactly the
excluded artefacts: *"tax registration number, invoice sequence, tax
breakdown, and any required QR code"* and *"template-driven per country pack
and per brand"*.

Therefore: **either** implement a receipt that fails its own [M] requirements,
**or** invent fiscal semantics against a standing ratified exclusion. **Both
are refused by this report.**

### Status

> ## **RECEIPT: BLOCKED**
> *(Not "NOT IMPLEMENTED" — the stronger classification is correct: the work
> is not merely absent, it is affirmatively excluded by ratified governance.)*
>
> **Hard next-slice candidate? NO — not selectable at this HEAD.**
> The correct first step is the narrow user decision isolated in **§14.1**,
> not an implementation slice and not a design gate.

---

## §7. SPECIAL AUDIT — MINIMUM REPORTING

### Method

Searched Sales, Treasury, Inventory, Governance, Kitchen and Catalogue for
executable read models, aggregation queries, routes and DTOs; enumerated all
109 OpenAPI paths; inspected every `*.permissions.ts`; read SRS §19.1-19.3 and
FR-RPT-001…005 directly.

### What exists

| Read surface | Route | Aggregating? |
|---|---|---|
| Order list | `GET /orders` (cursor-paginated rows) | **No** — row listing |
| One order + line snapshots | `GET /orders/{bd}/{id}` | **No** |
| Stock levels | `GET /inventory/levels` | **Yes** — the projection *is* stock-on-hand |
| Low stock / expiring / negative / reconciliation | `GET /inventory/*` | Yes (item-level computations) |
| Item movement ledger | `GET /inventory/items/{id}/movements` | No — gated by `inventory.cost.view` |
| Cash-session close context | `GET /cash-sessions/{id}/close-context` | Per-**session** only |

**There is no `report`, `reports`, `analytics`, `summary`, `dashboard` or `z`
route anywhere in the 109-path surface, and no `report.*` permission in any
`*.permissions.ts`.**

### Can a manager answer these TODAY?

| Question | Today | Why |
|---|---|---|
| Gross sales for yesterday | **NO** | No aggregation route. Would require paging `GET /orders` and summing client-side — not a report surface. |
| Net sales | **NO** | Same. (`discount_total`, `service_charge_total` are structurally 0 — no discount/comp/service-charge mechanism exists.) |
| Tax by rate | **NO — and not directly derivable** | `order_lines.tax_amount` + `tax_class_id` give tax **by class**. The **rate** lives in the pinned pack version; `orders.country_pack_version` pins a **version string only** — there is **no pack `code` column on the order** and no FK. **"Tax by rate" needs an explicit resolution rule.** *(New finding — design-gate item.)* |
| Sales by tender | **NO (route)** / **YES (data)** | `order_payments.tender/amount/branch_id/business_day` are all present and exact. |
| Completed-order count | **NO (route)** / **YES (data)** | `orders.state='completed'`, `completed_at`. |
| Cash-session totals / variance | **PARTIAL** | Per-session via close-context / `CashSessionCloseAttempt`. **No per-day, cross-session roll-up.** |
| Stock on hand | **YES** | `GET /inventory/levels`. |

### Does a new persistence model have to exist?

**No, for the Internal MVP.** Every fact is already durably and immutably
recorded by accepted slices: `orders`, `order_lines` (BR-POS-004 snapshots),
`order_payments`, `cash_sessions`, `cash_movements`,
`cash_session_close_attempts`, `stock_levels`, `stock_movements`.
**Reporting is a read concern over facts that already exist.**

Two indexing observations, verified in `prisma/schema.prisma`:

- `orders` **already** carries `@@index([tenantId, branchId, businessDay])` —
  the exact predicate a branch-day report needs. ✅
- `order_payments` carries only `@@index([tenantId, orderId, businessDay])`
  and `@@index([tenantId, cashSessionId])` — **no `(tenant, branch,
  business_day)` index.** A per-day sales-by-tender aggregate would want one.
  **This is the single plausible reason the slice touches a migration**, and it
  is an *index-only, additive* migration — no column, no table, no enum.

### Live aggregation vs persisted rollups vs projection

SRS §19.1-19.2 describe a **read replica + star schema + materialised
rollups**, and:

- **FR-RPT-001 [M]** — analytical queries against a **read replica**.
- **FR-RPT-002 [M]** — pre-aggregated rollups at hourly/daily/weekly/monthly.
- **FR-RPT-003 [M]** — incrementally updated, fully rebuildable.
- **FR-RPT-004 [M]** — **every report displays the data-as-of timestamp and
  indicates when the period is incomplete.**
- **FR-RPT-005 [M]** — Type-2 slowly-changing dimensions.

**Engineering conclusion (inference, flagged as such):** FR-RPT-001/002/003/005
are **scale and warehouse** requirements — they change *where* and *how fast* a
figure is produced, never *whether it is correct*. FR-RPT-004 is a
**correctness-of-presentation** requirement and is cheap. The readiness PDF
already frames the target as an **"FR-RPT-001…010 subset"**, and P4's exit
criterion is behavioural: *"A manager can read yesterday's trading."*

**Therefore: query-time aggregation over the transactional primary, satisfying
FR-RPT-004 in full, with FR-RPT-001/002/003/005 recorded as knowingly-unmet
Internal-MVP carve-outs.** **Do NOT build an Analytics warehouse for an
Internal MVP** — the source does not require it *for this scope*, and §19.2's
star schema is explicitly the Reporting *domain's* architecture, which the
readiness PDF places at 0 % and post-MVP.

### Must DayClose precede the report?

**No.** See §8. The report reads **completed transactions**; nothing in
FR-RPT-001…005 or §19.3's *Sales Summary* / *Sales by Tender* / *Cash
Reconciliation* / *Tax Summary* entries conditions them on a day-close record.
The dependency runs the **other way** (§8).

### Does FR-RPT require a specific persisted snapshot?

**FR-RPT-002/003 do** — and they are the carve-out. **FR-FIN-022 does** for
the **Z report** specifically (*"Z reports SHALL be sequentially numbered per
branch, immutable, and retrievable for any historical date"* — FR-RPT/FIN-023).
That is a **DayClose** obligation, not a minimum-reporting one, and is one more
reason the two are separate slices in this order.

### Status

> ## **MINIMUM REPORTING: NOT IMPLEMENTED**
>
> **Hard next-slice candidate: YES — and it is the one selected (§11).**

---

## §8. SPECIAL AUDIT — DAY CLOSE

**CashSession Close is emphatically NOT DayClose**, and this report does not
treat it as such.

| Element | Status | Evidence |
|---|---|---|
| Business-day **attribution** | **EXISTS** | `orders.business_day` (DATE, partition key); `sales/orders/business-day.ts`; `uq_order_number (branch_id, business_day, order_number)`. |
| Business-day **lifecycle / branch-day state** | **ABSENT** | No `BusinessDay`, `BranchDay` or `DayClose` model among the 88. The approved SQL defines `treasury.day_closes`, `treasury.session_summaries`, `treasury.variance_reports` (`ROS_DrawDB_Compatible_v3.sql:1118-1137`) — **none migrated.** |
| DayClose command / runtime | **ABSENT** | No route in 109; no service; `cash.day.close` (SRS §15.2, line "Close the business day") is **not** in `treasury.permissions.ts`. |
| Z report | **ABSENT** | Nothing. |
| FR-FIN-024 configurable day boundary | **ABSENT** | `branches.timezone` exists; no boundary setting. ADR 0008 D-11 (`org.settings` deferred) is unchanged. |
| FR-FIN-021 "blocked while any cash session remains open" | **MECHANICALLY TRIVIAL, SEMANTICALLY UNBUILT** | `cash_sessions.status` + the one-open-session invariant make the check easy; there is nothing to block. |

### Governance status — explicitly undecided, twice, at this HEAD

> *Approval Runtime Minimum Resolution (2026-08-29), "Not decided by this
> entry"*: **"… `X-report permission`; `Shift close`; **`Day Close`**; D-12
> escalation; asynchronous approval; and notifications."**
>
> *P1G-1 Cash-Close Policy Ratification (2026-08-30), "Not decided by this
> entry"*: **"… the full CashSession Close implementation; **`Day Close`**;
> **`X / Z reports`**; and `NFR-PERF-006`."**

### Dependency analysis

- **On CashSession Close** — satisfied (FR-FIN-021's blocking predicate).
- **On Receipt** — FR-FIN-026 [M] requires day close to trigger *"fiscal
  document finalisation"*. **That limb is unreachable while P1C-1 stands.**
- **On Reporting** — **hard.** FR-FIN-022 [M] enumerates the Z report's
  contents: *gross sales, discounts, refunds, net sales, **tax by rate**,
  sales by category, sales by tender, sales by order type, transaction count,
  average order value, void and comp summary, cash reconciliation, variance
  summary.* Of these, at `38e007b`: `discounts`, `refunds`, `voids`, `comps`
  are **structurally absent** (no discount/comp/refund/post-fire-void
  mechanism); `sales by category` needs the `MenuItemPlacement` join;
  **`tax by rate` is not directly derivable** (§7). **A Z report cannot be
  filled at this HEAD.**
- **On completion / depletion** — satisfied.

### Verdict

> **DAY CLOSE: NOT IMPLEMENTED — and correctly sequenced AFTER minimum
> reporting, not before it.**
>
> It is **production-operational** rather than first-Internal-MVP-critical:
> the Internal MVP's actual need is *"a manager can read yesterday's
> trading"*, which a daily report over completed transactions serves
> **directly**. DayClose adds a *statutory sealing ceremony* (immutable,
> per-branch-sequential, retrievable) whose mandated content (FR-FIN-022) is
> **not yet computable** and one of whose mandated triggers (FR-FIN-026 fiscal
> finalisation) is **governance-blocked**.
>
> Selecting DayClose now would produce a Z report with six structurally-zero
> or underivable columns, permanently sealed and per-branch-sequentially
> numbered. That is worse than not having it.

---

## §9. SPECIAL AUDIT — BRANCH AUTHORIZATION

**Tenant isolation ≠ branch authorization. No branch safety is claimed from
tenant RLS anywhere below.**

| Question | Answer | Evidence |
|---|---|---|
| Is `TenantContext.branchId` populated? | **NO** | `identity/context/tenant-context.ts:11-16` declares it *"RESERVED — not populated this phase"*; `tenant-context.service.ts`'s `resolve()` constructs the context with `userId, sessionId, tenantId, membershipId` and **conditionally `terminalId`** — `branchId` is **never** assigned on any path. |
| Do permissions/guards constrain branch scope? | **NO** | `TenantContextService` loads `membershipRoles` with a **role/tenant** predicate only — no `branch_id` filter. `PermissionGuard` matches a flat `ReadonlySet<string>` of codes. `identity.membership_roles.branch_id` exists in schema and **is still never read**. |
| Could a manager read another branch **in the same tenant**? | **YES, on the Dashboard read surfaces** | `GET /orders` accepts `branchId` as an **optional client-supplied filter** (`orders.controller.ts:400`), guarded by tenant-scoped `pos.order.create`, with **no terminal binding required** on that handler. Omitting `branchId` returns **every branch's** orders. `GET /inventory/levels` behaves the same way with `locationId`. |
| Is terminal binding enough? | **For POS/KDS, yes; for Dashboard/reporting, NO** | `orders.controller.ts:805-826` — the terminal is taken from the **session**, never the body, *"letting a request name a different one would let any terminal book sales onto another branch"*. `KdsStationGuard` requires an **active `kds`-type terminal** and **exactly one** station binding (0 or >1 ⇒ 403). **Both are FR-SEC-021 device facts, not RBAC scope** — and neither guards a Dashboard session. |
| SRS IDs | **FR-SEC-002 / 003 / 004** | §15.2: *"A permission answers 'may this action be performed?' A scope answers 'on which data?' **Both must be satisfied.**"* FR-SEC-004: *"Permissions SHALL NOT leak across scopes."* |
| D-2 status | **RATIFIED (a) CORE ONLY; amended 2026-08-19; defer STILL IN FORCE** | The amendment lifted the defer for **exactly four items** (Employee↔User linkage, permitted/home-branch substrate, tenant-safe Terminal→Branch FK, FR-SEC-021/022 PIN behaviour) and states verbatim: *"**Broader branch-scoped RBAC — FR-SEC-002 / FR-SEC-003 / FR-SEC-004 general scope resolution stays deferred.** Only the branch check FR-SEC-021 itself requires is lifted; permission resolution is **not** made branch-aware by this amendment."* Reconfirmed at this HEAD by the KDS ratification's Preservation clause: **"D-2's branch-scoped RBAC defer remains in force."** |

### Classification

> **BRANCH AUTHORIZATION: (D) BLOCKED BY GOVERNANCE** — with (B) as the
> *current operating posture*.
>
> Not (A): it cannot be *required before Internal MVP exit* while D-2 forbids
> building it. Not (C): it is demonstrably not implemented. It is (B) —
> *"acceptable as a single-branch demo limitation"* — **only as a factual
> description of the pilot**, and **only because the readiness PDF's P4 exit
> criterion (*"a manager … cannot read another branch's"*) is an
> **exit-gate** criterion, not a first-slice one.**

The isolated user decision is in **§14.2**. It is deliberately narrow: it does
**not** ask for a global RBAC redesign, and this report does **not** design one.

---

## §10. SPECIAL AUDIT — POST-FIRE VOID / KDS CANCELLATION, AND SERVED / EXPEDITER

### 10.1 Post-fire void / `order.line.voided` / FR-KDS-029

**Verified absent at HEAD:** `TicketLineStatus.cancelled` and `cancelledAt`
exist in schema; **nothing writes them**. No `order.line.voided` event in
`sales/contract/events.ts`. `pos.order.void_line_postfire` is SRS-named in
§15.2 and **deliberately excluded** from `sales.permissions.ts` — which states
verbatim: *"no route performs a post-fire void, because Clarification C makes
it a privileged operation and **no ratified rule defines its approval
semantics**."* `order-state.ts:23-26` repeats it: *"The privileged post-fire
path is deliberately NOT implemented: no existing SRS or ratified permission
authorises a general post-fire edit."*

Analysed against the smallest coherent MVP workflow:

- **Can a restaurant demo/operate safely without it?** **Yes.** The pre-fire
  correction path (`DELETE /orders/{bd}/{id}/lines/{lineId}`) is the *ordinary*
  cashier correction and is implemented. Post-fire is, by ratified
  Clarification C, a **privileged manager** path — an exception path.
- **Does the SRS require fired-item cancellation in the protected happy
  path?** **No.** UC-POS-01's main flow (steps 1-15) contains no cancellation.
  It appears only in alternate flows.
- **Is waste disposition required for coherence?** **No.** Inventory depletion
  fires at **completion**, not at fire — so an uncancelled fired line that is
  never paid for never depletes. There is no orphaned stock effect. (Waste
  recording itself is separately implemented: `POST /inventory/waste`.)
- **Does its absence prevent Receipt / Close / Reporting?** **No.** None of the
  three reads `ticket_lines.cancelled`.
- **Better scheduled immediately after the first coherent MVP?** **Yes** — it
  needs an approval-semantics ratification (Governance), and the Approval
  Runtime that would carry it now exists, so the slice is *cheaper* later, not
  more expensive.

> ### **POST-FIRE VOID: DEFERRED MVP GAP** — not a hard blocker.
> FR-KDS-029 [M] is **[M] for the KDS domain's completeness, not for the
> Internal MVP's protected path**, and is not promoted merely on its `[M]`
> marking. It remains **knowingly unmet**.

### 10.2 `served` / Expediter — FR-KDS-040 PARTIAL

**Verified:** `'served'` appears in `order-state.ts:41` (enum),
`order-state.ts:58` (`SENT_TO_PRODUCTION` set), `ticket-projection.ts:34,38`,
`ticket-reader.service.ts:88` (`INACTIVE_STATUSES`) and
`kds-operations.service.ts:616-617` (an SQL `bool_and`/`bool_or` predicate that
*tolerates* `served`). **No code path ever writes it.** No Expediter/Pass route.

`TicketBumpedHandler` moves the Sales line to **`ready`**, which is exactly
UC-POS-01 step 7 (*"updates line states to `ready`"*). The MVP protected path
runs **fire → ready → payment → completion**; `served` sits **beside** it, not
inside it.

> ### **SERVED / EXPEDITER: SAFELY DEFERRED.** Does not prevent Internal MVP
> exit. **The accepted KDS slice is NOT reopened.** FR-KDS-040 stays PARTIAL,
> exactly as the KDS closure classified it.

---

## §11. PROTECTED PATH — END-TO-END WALKTHROUGH AT `38e007b`

| # | Edge | Executable? | Route / mechanism |
|---|---|---|---|
| 1 | PIN | ✅ | `POST /auth/pin` → `typ:'pos'` token carrying `emp` + `trm` |
| 2 | Terminal | ✅ | `POST /auth/terminal` bind; terminal taken from session, never body |
| 3 | Open CashSession | ✅ | `POST /cash-sessions` (opens Shift + session; one-open invariant) |
| 4 | Open Order | ✅ | `POST /orders` (`@Idempotent`, order number from a terminal block) |
| 5 | Add priced + taxed lines | ✅ | `POST /orders/{bd}/{id}/lines` → `PriceResolutionService` + `computeLineTax`, BR-POS-004 snapshots |
| 6 | Fire | ✅ | `POST /orders/{bd}/{id}/fire` → `order.line.fired` |
| 7 | KDS queue | ✅ | `GET /kds/stations/{id}/queue` behind `KdsStationGuard` |
| 8 | Kitchen bump | ✅ | `POST /kds/tickets/{id}/lines/{lid}/bump`, `/bump-all` |
| 9 | Sales readiness | ✅ | `ticket.bumped` → `TicketBumpedHandler` → lines `ready`, **same transaction** |
| 9b | Recall → reversion | ✅ | `POST /kds/tickets/{id}/recall` → `ticket.recalled` → `TicketRecalledHandler` |
| 10 | Payment | ✅ | `POST /orders/{bd}/{id}/payments` — cash or manual external card, idempotent |
| 11 | Complete | ✅ | settling payment ⇒ `completed` + `order.completed`, **same `UnitOfWork`** |
| 12 | Inventory depletion + COGS | ✅ | `SaleDepletionCommand` + `posted_cogs_total`/`cogs_total`, same transaction |
| 13 | **Receipt** | ❌ | **nothing — §6, governance-blocked** |
| 14 | CashSession close | ✅ | `GET .../close-context` → `POST .../close` → (if above tolerance) `POST .../close/finalize` with manager PIN |
| 15 | **Daily report** | ❌ | **nothing — §7** |
| 16 | *(Day close)* | ❌ | **nothing — §8** |

> ### **EXACTLY TWO missing executable edges in the sale-to-close cycle: 13 and 15.**
> Edge 13 is **blocked**. **Edge 15 is the only open one.**
>
> This is the decisive fact of the whole rebase: there is no third candidate
> hiding in the path, and no risk of selecting a feature that closes nothing.

---

## §12. REMAINING DEPENDENCY GRAPH — CURRENT, NOT HISTORICAL

```
                     ┌───────────────────────────────────────────┐
   COMPLETE ────────▶│  order → fire → KDS → pay → complete →    │
   AT HEAD           │  deplete → COGS → cash-session close      │
                     └───────────────┬───────────────────────────┘
                                     │  facts are durable + immutable
                                     ▼
                   ┌─────────────────────────────────┐
                   │ [1] MINIMUM REPORTING           │◀── SELECTED
                   │  daily sales · tender · tax     │
                   │  session roll-up · stock-on-hand│
                   └───────┬─────────────────┬───────┘
                           │                 │
                           ▼                 ▼
              ┌────────────────────┐   ┌──────────────────────┐
              │ [3] DAY CLOSE      │   │ Prep-time / KDS      │
              │  Z report content  │   │ reporting (post-MVP) │
              └─────────┬──────────┘   └──────────────────────┘
                        │ FR-FIN-026 fiscal-finalisation limb
                        ▼
              ┌────────────────────────────────────────┐
   BLOCKED ──▶│ [2] RECEIPT  (P1C-1 fiscal exclusion)  │
              └────────────────────────────────────────┘

   BLOCKED ──▶ [4] BRANCH-SCOPED AUTHORIZATION  (D-2)
                 ── independent of [1]…[3]; gates MVP *exit*, not [1]

   DEFERRED ─▶ [5] POST-FIRE VOID / FR-KDS-029   (no ratified approval semantics)
   DEFERRED ─▶ [6] served / Expediter            (FR-KDS-040 PARTIAL)
```

### [1] MINIMUM REPORTING

| | |
|---|---|
| **UPSTREAM** | Completion (`bfe7e69`), depletion, `OrderPayment` attribution, CashSession close (`121b889`), stock levels — **all COMPLETE** |
| **DOWNSTREAM** | DayClose Z-report content; FR-FIN-010's per-day half; management visibility; MVP capability #15 |
| **CAN START NOW** | **YES** |
| **BLOCKS** | DayClose; Internal-MVP exit |
| **PARALLELIZABLE** | Yes — read-only; touches no write path |
| **GOVERNANCE REQUIRED** | **Narrow.** `report.view.<category>` and `report.export` are **SRS-named in §15.2**, but `<category>` is a template — the concrete token needs the same explicit authorisation `kds.operate` received (KDS-R11). Plus an explicit FR-RPT-001/002/003/005 Internal-MVP carve-out. |
| **MIGRATION LIKELY** | **Possibly one additive index only** — `order_payments (tenant_id, branch_id, business_day)`. **No table, no column, no enum.** |
| **APPROXIMATE SIZE** | **M** — smaller than P1G-1 or KDS |

### [2] RECEIPT

UPSTREAM: complete (completion, tax, pack, snapshots) · DOWNSTREAM: FR-FIN-026
limb of DayClose; FR-POS-104 reprint · **CAN START NOW: NO** · BLOCKS: Production
MVP · PARALLELIZABLE: yes, once unblocked · **GOVERNANCE REQUIRED: YES —
P1C-1 must be narrowly reopened** · MIGRATION LIKELY: **YES** (`fiscal.*` tables
+ a country-pack `invoice` section, which **re-signs the pack**) · SIZE: **L**.

### [3] DAY CLOSE

UPSTREAM: **[1]** (Z content) and **[2]** (FR-FIN-026 fiscal limb) · DOWNSTREAM:
statutory sealing; FR-FIN-025 automation · **CAN START NOW: NO** · BLOCKS:
Production MVP · PARALLELIZABLE: no · GOVERNANCE REQUIRED: **YES** — explicitly
*"not decided"* in two 2026-08-30 ratifications · MIGRATION LIKELY: **YES**
(`treasury.day_closes` + summaries + variance reports + a Z sequence) · SIZE: **M-L**.

### [4] BRANCH-SCOPED AUTHORIZATION

UPSTREAM: none — substrate exists (`membership_roles.branch_id`,
`employee_branches`, `terminals.branch_id` FK) · DOWNSTREAM: **every** read
surface, including [1] · **CAN START NOW: NO — D-2** · BLOCKS: **MVP exit
criterion**, not MVP function · PARALLELIZABLE: yes · GOVERNANCE REQUIRED:
**YES — D-2 defer must be lifted** · MIGRATION LIKELY: **probably not** (columns
exist; the work is resolution + guard + RLS predicate) · SIZE: **M**.

### CRITICAL PATH

> **[1] MINIMUM REPORTING → [3] DAY CLOSE**, with **[2] RECEIPT** and
> **[4] BRANCH SCOPE** as **governance-gated parallel tracks** that
> **do not block [1]**.

---

## §13. THE SELECTED NEXT SLICE

> # **MINIMUM OPERATIONAL REPORTING**
> ### *A branch daily-trading read surface over already-accepted facts.*

### Scope sketch (indicative — the design gate settles it, §15)

A small, read-only, permission-gated set of branch-and-business-day-addressed
reads:

1. **Daily sales summary** — gross, net, tax total, transaction count, AOV,
   for a `(branchId, businessDay)`.
2. **Sales by tender** — FR-FIN-010's **per-day** half (cash /
   manual_external_card), including `rounding_adjustment`.
3. **Tax summary** — by **tax class** at minimum (§19.3 *"Tax Summary — by
   rate, class, jurisdiction, period"*); "by rate" pending the §7 resolution
   question.
4. **Session roll-up** — the day's cash sessions with expected / counted /
   variance, from `CashSessionCloseAttempt`.
5. **Stock-on-hand** — **already exists** (`GET /inventory/levels`); the slice
   *records* it as satisfying capability #15's third limb rather than
   rebuilding it.
6. **FR-RPT-004 [M] in full** — every response carries a data-as-of timestamp
   and an explicit *"this period is not yet complete"* indicator.

**SRS IDs claimed:** FR-RPT-004 [M]; FR-FIN-010 [M] (per-day half — advancing
it from PARTIAL); §19.3 *Sales Summary*, *Sales by Tender*, *Tax Summary*,
*Cash Reconciliation*; FR-INV-010/015 (already met).
**Explicitly NOT claimed:** FR-RPT-001/002/003/005 (Internal-MVP carve-out),
FR-RPT-030…034 (dashboards), FR-RPT-040…047, FR-FIN-022/023 (Z report).

### Why it beats every alternative

| Criterion (in the prescribed order) | Reporting | Receipt | DayClose | Branch scope | Post-fire void |
|---|---|---|---|---|---|
| **1. Closes a real protected-path gap** | ✅ edge 15 | ✅ edge 13 | ~ edge 16 | ✗ (exit gate) | ✗ (exception path) |
| **2. All upstream runtime deps present NOW** | ✅ | ✅ | ✗ (needs [1] + [2]) | ✅ | ✅ |
| **3. Unlocks most downstream MVP completion** | ✅ **unlocks DayClose** | ~ unlocks reprint | ✗ terminal | ~ | ✗ |
| **4. Source-decided / governance-settled** | ✅ **no exclusion; §15.2 names the permission family** | ❌ **P1C-1 BLOCKS** | ❌ *"not decided"* ×2 | ❌ **D-2 BLOCKS** | ❌ no ratified approval semantics |
| **5. Coherent, single-purpose** | ✅ one read surface | ✅ | ✅ | ✅ | ✅ |
| **6. Not production-hardening** | ✅ functional | ✅ | ~ operational | ~ security-hardening | ✅ |
| | **SELECTED** | blocked | premature | blocked | deferred |

**Criterion 4 is decisive.** Reporting is the **only** candidate that does not
require lifting a standing ratified decision before a single line can be
designed.

Three further reasons, all evidence-backed:

1. **It completes an already-PARTIAL `[M]` requirement on the protected path**
   rather than opening a new domain. `FR-FIN-010` [M] — *"per session **and per
   day**, totals by tender type"* — is classified PARTIAL by the P1G-1 closure.
   The session half shipped; **the per-day half is exactly this slice.**
2. **It is the cheapest slice with the largest read-value**, because every fact
   is already durably recorded and *immutable by ratified design* (BR-POS-004
   snapshots, append-only `OrderPayment`, `posted_cogs_total`, immutable close
   attempts). **No new write path, no new financial-integrity surface, no new
   concurrency hazard.**
3. **It converts DayClose from unbuildable to buildable.** §8 shows the Z
   report cannot be filled today. After this slice, the aggregation layer
   FR-FIN-022 needs exists, and DayClose reduces to *sealing + sequencing +
   the FR-FIN-026 fiscal limb*.

### Readiness

| | |
|---|---|
| **UPSTREAM READY** | **YES — all of it.** |
| **DOWNSTREAM UNLOCKED** | DayClose (Z content); FR-FIN-010 → COMPLETE; MVP capability #15; the readiness PDF's P4 exit criterion's *first* half. |
| **GOVERNANCE** | **NOT BLOCKED.** One narrow authorisation needed (permission token + FR-RPT carve-out), on the exact KDS-R11 precedent. |
| **DESIGN GATE REQUIRED** | **YES** — before any implementation prompt. §15 lists its questions. |
| **MIGRATION EXPECTATION** | **AT MOST ONE additive index** on `order_payments (tenant_id, branch_id, business_day)`. **Zero tables, zero columns, zero enums.** Very likely the first slice since `9aa7a88` with no schema change at all. |
| **IMPLEMENTATION READY** | **NO — design gate first**, matching the KDS / P1G-1 / P1F-2 precedent without exception. |

---

## §14. THE TWO ISOLATED USER DECISIONS (parallel; neither blocks §13)

Stated narrowly, as required. **This report does not answer them and does not
implement around them.**

### §14.1 — Receipt / fiscal boundary

> **Does the user wish to narrowly reopen CARRIED ITEM P1C-1's fiscal
> exclusion for a single purpose: a non-fiscal, itemised, bilingual-capable
> customer receipt for the Internal MVP — explicitly WITHOUT fiscal
> submission (FR-POS-103 digital delivery, `fiscal_submission_attempts`,
> `fiscal_configs`) and WITHOUT claiming FR-POS-100/101 complete?**

If **NO** → Receipt stays BLOCKED; the Internal MVP ships without a printed
document; FR-POS-100/101/102 are recorded as **knowingly unmet**, exactly as
FR-SEC-032 already is.
If **YES** → a Receipt design gate follows, and §15 becomes its input.
**Either way, [1] proceeds unaffected.**

### §14.2 — Branch-scope for read surfaces

> **Given that D-2 keeps FR-SEC-002/003/004 deferred, should the new reporting
> reads (a) require an explicit `branchId` on every route so the retrofit
> surface stays single and narrow, or (b) match the existing
> optional-filter behaviour of `GET /orders` and `GET /inventory/levels`?**

This asks **nothing** about global RBAC and reopens **nothing**. It is a route
**shape** question whose answer determines how expensive the eventual D-2
lift will be. **Recommended: (a)** — it costs nothing now and makes the future
guard a one-line predicate on a parameter that is already mandatory.
**If the user instead wants real branch enforcement, that requires lifting
D-2, which this report reports honestly rather than implementing around.**

---

## §15. DESIGN-GATE QUESTIONS FOR THE SELECTED SLICE (§16 of the task brief)

**No implementation. These are the questions the gate must settle.**

**Aggregation model**
1. Live query-time aggregation over the primary (recommended, §7) vs persisted
   daily summary vs event-built projection — and the **explicit written
   carve-out** for FR-RPT-001 (read replica), FR-RPT-002/003 (rollups),
   FR-RPT-005 (SCD2).
2. Does any figure need to be *frozen*, or is every figure recomputable from
   immutable facts? (Evidence says: fully recomputable — no snapshot needed
   until DayClose demands an immutable Z.)

**Minimum report fields**
3. Exact field list per report, and which are **structurally zero** at this
   HEAD (`discount_total`, `service_charge_total`, refunds, voids, comps) —
   these must be **rendered as zero with a stated reason**, never silently
   omitted.
4. **"Tax by rate" resolution (§7's new finding).** `orders.country_pack_version`
   pins a version **string** with **no pack code and no FK**. Options: (a) report
   **by tax class** only for the Internal MVP; (b) resolve the rate through
   `branch.country_code` + the pinned version; (c) add a pack-code column
   (**a migration — raises the slice's cost**). Recommend (a), state it.
5. Net-sales definition — SRS §19.3 *"Gross, discounts, refunds, net"*. With
   discounts/refunds structurally zero, **is net ≡ gross for the Internal
   MVP?** Must be decided and *displayed*, not assumed.
6. FR-RPT-004 mechanics: what exactly is the "data as of" timestamp, and what
   makes a business day "incomplete" (an open cash session? the branch's
   FR-FIN-024 boundary, which does not exist?).

**Module ownership**
7. Who owns these reads? The evidence favours **each domain publishing its own
   aggregate through its existing `contract/` boundary** (Sales owns
   order/payment aggregates — SRS §5.2.3 puts `sales.order_payments` in Sales;
   Treasury owns session roll-ups; Inventory already owns levels), with **no
   new Reporting module**. Creating a Reporting module now would be the
   Analytics warehouse §7 rejects. **The gate must settle this explicitly** —
   `module-boundaries.spec.ts` will enforce whatever is chosen.
8. Where does the HTTP surface live — a route on each domain controller, or one
   read controller? (Note: **D-14 A-1 / D-20 forbid a *Governance* read
   surface**; that constrains Governance only, and must not be over-read.)

**Authorization**
9. The concrete `report.view.<category>` token(s) — §15.2 gives the **shape**
   but not the category vocabulary. Needs the KDS-R11 treatment: an
   explicitly user-authorised code, recorded, not invented silently.
10. `report.export` (FR-RPT-043) and its FR-RPT-044 [M] audit obligation — in
    or out of this slice? (Recommend **out**; record as unmet.)
11. §14.2's branch-scope route shape.

**Mechanics**
12. Money serialisation — bigint-as-string, without exception (ADR-008).
13. Pagination / period bounds — single business day only, or a range?
14. The `order_payments (tenant_id, branch_id, business_day)` index — needed,
    or does the existing `orders` index plus a join suffice? **This single
    question decides whether the slice has a migration at all.**
15. Audit: reads are **not** audited by existing convention (`ADR 0008 §15`,
    Organisation/Catalogue precedent). Confirm the same holds here, and that
    FR-RPT-044 applies only to **export**.

**Not for the gate — user ratification items, kept separate:**
**(i)** the `report.view.<category>` token itself; **(ii)** the FR-RPT-001/002/
003/005 Internal-MVP carve-out; **(iii)** §14.2's route shape.

---

## §16. INTERNAL MVP COMPLETION ESTIMATE

> ### **NON-AUTHORITATIVE ENGINEERING ESTIMATE**
> Raw SRS requirement-count percentage is deliberately **not** used as the
> headline number. The old **~55-60 %** is superseded.

### A. Protected-path capabilities (§5 matrix, 33 rows)

- **COMPLETE: 26 / 33 = 79 %**
- Counting the 2 PARTIALs at half: **27 / 33 ≈ 82 %**

### A′. The readiness PDF's own 15-capability definition (§3)

- **12 COMPLETE · 2 PARTIAL · 1 BLOCKED ⇒ 13 / 15 ≈ 87 %**

### B. Remaining blocking slices

| Slice | Size | Startable now? |
|---|---|---|
| **[1] Minimum Reporting** | **M** | **YES** |
| [3] DayClose | M-L | No — needs [1] |
| [2] Receipt | L | No — governance |
| [4] Branch-scope authorization | M | No — governance |

**Count: 4 remaining blocking slices; exactly ONE is startable today.**

### Honest framing

The **functional sale-to-close cycle is 15/16 executable edges complete**
(§11). What remains is **one read surface, one sealing ceremony, one
document, and one authorization scope** — three of which stand behind
decisions that are the user's to make, not engineering's.

---

## §17. EXACT NEXT STEP

1. **Write the Minimum Reporting design gate** answering §15's 15 questions,
   and separating its three user-ratification items from its engineering
   mechanics — exactly as the KDS and P1G-1 gates did.
2. **Obtain the narrow ratification** for the `report.view.<category>` token
   and the FR-RPT-001/002/003/005 Internal-MVP carve-out.
3. **Then, and only then**, an explicitly authorised implementation task.
4. **In parallel, at the user's discretion:** answer §14.1 (Receipt / P1C-1)
   and §14.2 (branch-scope route shape). Neither gates step 1.

**No product code, no migration, no schema change, no route, no permission, no
governance edit, no commit, no push and no deploy was performed by this task.**

---

## §18. REQUIREMENT CLASSIFICATIONS — PRESERVED EXACTLY

**COMPLETE at `38e007b`:** FR-SEC-021/022/028 · FR-PLT-003/010/011/012 ·
FR-SEC-045/047 · FR-MNU-021/022/023 · FR-POS-001/002/005/010/020…040/042 ·
FR-FIN-030/031/032/033/034 · FR-POS-035 · FR-POS-060/063/065/066 ·
FR-API-020…023 · FR-INV-030 · FR-INV-010/015 · FR-KDS-001…010/020/021/024/025/028 ·
FR-POS-090/091/093/094/095/096/097 · FR-FIN-001/002/005/006 ·
FR-SEC-016 (cash-variance limb) / 030 / 033 · FR-AUD-001/002/003/006.

**PARTIAL:** FR-LOC-020/021/022 (tax + currency only; invoice/fiscal/legal
sections unmodelled) · FR-LOC-023 (structural half only) · FR-FIN-004 ·
FR-FIN-007 (no adjusting entries) · FR-FIN-010 (2 tenders; **per-session only —
the per-day half is the selected slice**) · FR-KDS-040 (`served` never written) ·
FR-SEC-032 (synchronous half only).

**NOT IMPLEMENTED / knowingly unmet:** FR-SEC-002/003/004 (D-2) ·
FR-POS-100/101/102/103/105/106 · FR-POS-104 [S] · FR-FIN-020…026 ·
FR-RPT-001…005 · FR-RPT-030…047 · FR-KDS-029 · FR-POS-064 · FR-PLT-025…028 ·
all FR-OFF-*.

**BLOCKED (governance, not absence):** Receipt (P1C-1) ·
branch-scoped RBAC (D-2) · DayClose / X / Z reports (explicitly
*"not decided"*, 2026-08-29 and 2026-08-30).

---

*End of report. Non-authoritative evidence. The SRS and the ratified
governance decisions remain authoritative.*

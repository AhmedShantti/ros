# INTERNAL MVP RECEIPT — Implementation + Final Acceptance Candidate

| Field | Value |
|---|---|
| **Task / slice name** | INTERNAL-MVP RECEIPT (RCPT-R1) — implementation of the already-accepted narrow design |
| **Report type** | Implementation + verification report. A normal implementation commit is authorized after all acceptance checks pass (this report records that they did). |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report records what was implemented and verified **in this session** against the repository at the HEAD below. It does not itself ratify anything beyond recording the RCPT-R1 entry the design gate specified. |
| **Date** | 2026-09-01 |
| **Design reference** | `docs/reports/claude/2026-09-01_INTERNAL-MVP-receipt-narrow-design-gate.md` — verdict **A. RECEIPT DESIGN ACCEPTED-READY**. Implemented exactly, subject only to the explicitly authorized adjacent OpenAPI correction (§2 of the task). No new design was invented in this session. |
| **Baseline HEAD (pre-implementation)** | `1cc9ace9fe4d8ddda69d65475899a2f4a9fb7930` — *fix: tighten OpenAPI response contracts* |
| **Branch** | `feat/production-spec` |
| **Working tree at start** | Verified identical to the design gate's own baseline: dirty only in `docs/reports/claude/` (four historical untracked reports + modified `INDEX.md`, plus the uncommitted Receipt design-gate report). Zero source/schema/migration/test/OpenAPI/governance drift. |
| **Task identifier** | INTERNAL-MVP-receipt-implementation-and-acceptance |
| **Status** | COMPLETE — acceptance-clean, not yet committed at the time this report was written (commit performed immediately after, per the task's own commit step) |
| **Migrations** | 35 — **unchanged. None created.** Verified twice: `prisma migrate status` against the persistent dev DB, and a from-zero `prisma migrate deploy` of all 35 against a disposable scratch database. |

---

## §0. VERDICT

> # **A. RECEIPT ACCEPTANCE CLEAN — INTERNAL MVP READY FOR EXIT GATE**

Every condition in the design gate's acceptance bar (§W) and the task's own
§34 acceptance bar is met. No STOP condition fired. No scope was added beyond
§§B–W of the accepted design plus the three explicitly authorized adjacent
OpenAPI corrections (§2 of the task).

---

## §1. WHAT WAS IMPLEMENTED

### 1.1 New files

| File | Purpose |
|---|---|
| `src/modules/sales/orders/receipt.errors.ts` | `ReceiptNotAvailableError extends OrderStateError` — maps to 422 via the existing `SalesDomainExceptionFilter`, zero filter changes. |
| `src/modules/sales/receipt.views.ts` | Pure functions: `deriveTaxPresentation`, `toReceiptView` (+ line/modifier/payment sub-mappers). No Prisma client, no Nest, no HTTP. |
| `src/modules/sales/receipt.views.spec.ts` | 18 unit tests (pure, no DB) — `deriveTaxPresentation`'s four branches, money-string serialization, BigInt-precision preservation, non-fiscal constants, field-absence proofs. |
| `src/modules/sales/orders/receipt.service.ts` | `ReceiptService.findCompletedOrderReceipt` — three reads inside `prisma.withAuthContext`, eligibility check, delegates to the view. `AuditService` is **not** injected. |
| `src/modules/sales/orders/receipt.openapi.ts` | `receiptSchema` — fully typed OpenAPI response schema, built from the repository's existing `schema-helpers.ts` primitives. |
| `test/receipt.e2e-spec.ts` | 16 e2e scenarios (A–P) through the real HTTP route, real PostgreSQL, real authorization. |

### 1.2 Modified files

| File | Change |
|---|---|
| `src/modules/sales/orders/orders.controller.ts` | Added `GET :businessDay/:id/receipt` handler (inserted directly after the existing `findOne` handler); added the receipt line to the route-map header comment; applied the three adjacent OpenAPI corrections (§2). |
| `src/modules/sales/sales.module.ts` | Added `ReceiptService` to `providers` (not exported — nothing outside Sales consumes it); one doc-comment paragraph recording the RCPT-R1 public-surface addition. |
| `test/openapi.e2e-spec.ts` | Extended the existing route-surface `it` with a `receiptMatches` assertion (exactly one exact route) and two new forbidden patterns (`receipts?/(email|print|reprint)`, `fiscal[-_]?receipts?`); added three new dedicated `it` blocks for the adjacent Order-contract corrections (§2). |
| `test/sales.e2e-spec.ts` | Its own `/orders` route-surface assertion (a **different, independent** test from the one above, in a different file) needed the new route added to its expected list — this is the one genuine regression the new route caused, and it is now fixed, not worked around. |
| `docs/api/openapi.json` / `docs/api/openapi.yaml` | Regenerated via `npm run openapi:generate`. |
| `docs/governance/GOVERNANCE_DECISION_REGISTER.md` | Appended the RCPT-R1 ratification entry (§3 below). **+87 lines, −0 lines** — verified by `git diff --numstat`. |

### 1.3 Files NOT touched — verified by `git status`

```
prisma/schema.prisma                              NOT MODIFIED
prisma/migrations/**                              NOT MODIFIED (35, unchanged)
src/modules/sales/sales.permissions.ts            NOT MODIFIED (no new permission)
src/modules/sales/orders/order-state.ts           NOT MODIFIED
src/modules/sales/orders/order-lines.service.ts   NOT MODIFIED
src/modules/sales/orders/sales-payment.service.ts NOT MODIFIED
src/modules/sales/sales-domain-exception.filter.ts NOT MODIFIED
src/modules/sales/sales.views.ts                  NOT MODIFIED
src/modules/sales/contract/**                     NOT MODIFIED
src/modules/module-boundaries.spec.ts             NOT MODIFIED (45/45)
src/modules/localisation/**, organisation/**,
  treasury/**, reporting/**                       NOT MODIFIED
src/common/openapi/schema-helpers.ts              NOT MODIFIED
src/common/openapi/oas31.util.ts                  NOT MODIFIED
```

---

## §2. THE EXPLICITLY AUTHORIZED ADJACENT ORDER OPENAPI CORRECTION

Source re-verified before correcting (not assumed from the design report):

| Field | Actual runtime (Prisma column) | OpenAPI before | OpenAPI after |
|---|---|---|---|
| `orderSchema.countryPackVersion` | `orders.country_pack_version VARCHAR(24)` — a string, returned verbatim by `toOrderView` | `type: 'integer'` | `type: 'string'` |
| `orderLineSchema.priceRule` | `order_lines.price_rule VARCHAR(160)` — nullable string, returned verbatim by `toOrderLineView` | `type: 'object'` | `nullable({ type: 'string' })` → serializes as `type: ['string', 'null']` |
| `orderLineSchema.taxClassId` | `order_lines.tax_class_id UUID NOT NULL` (D-09 — a MenuItem with no TaxClass is not sellable) | `nullable(uuidSchema())` | `uuidSchema()` (non-nullable) |

**Zero runtime wire change** — every one of these is a documentation-only
correction to schema constants in `orders.controller.ts`; no serializer
(`toOrderView`/`toOrderLineView` in `sales.views.ts`) was touched.

Verified in the regenerated `docs/api/openapi.json`:

```json
"countryPackVersion": {"description": "...", "type": "string"}
"priceRule": {"description": "...", "type": ["string", "null"]}
"taxClassId": {"example": "3fa85f64-...", "format": "uuid", "type": "string"}
```

Three dedicated assertions were added to `test/openapi.e2e-spec.ts` proving
each correction (§4.3 below) — not merely inspected once and left
unenforced.

**Scope discipline:** no other pre-existing OpenAPI defect was touched. The
broader full-API audit is out of this task's authorized blast radius.

---

## §3. RCPT-R1 GOVERNANCE RECORDING

Appended verbatim to `docs/governance/GOVERNANCE_DECISION_REGISTER.md`,
immediately before the pre-existing `## Final Decision Matrix` section (the
established insertion point every prior named ratification — Fire
Authorization, P1F-2, FIFO, Approval Runtime Minimum Resolution, P1G-1,
R-6, KDS MVP, Minimum Operational Reporting, Day Close — has used, keeping
the original Phase-1 Governance closing appendix as the file's fixed tail).

**Diff verified append-only:** `git diff --numstat` reports **87 insertions,
0 deletions** for this file.

The recorded entry states, at minimum, exactly what the task required:

- the controlled Internal MVP exposes an itemized completed-order receipt
  view, explicitly non-fiscal, no claim of fiscal/legal compliance;
- a sequencing/scope decision only;
- no waiver of full SRS fiscal requirements;
- **FR-POS-100 becomes PARTIAL** after implementation, with its still-missing
  limbs named explicitly (TRN, invoice sequence, tax breakdown, QR, the
  country-pack element set, printing);
- **FR-POS-101…106 remain NOT IMPLEMENTED**;
- **P1C-1 remains globally unchanged** and still blocks the full fiscal
  receipt;
- **D-2 is unchanged** (no branch-scoped RBAC introduced);
- no schema/migration authorized.

No new numbered `D-*` decision was created; the 20-decision tally is
unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN). No ceremonial
extra entries (ownership, no-persistence) were added — per the design
gate's own §U.3, those are ordinary engineering conclusions, not user
governance decisions.

---

## §4. API

### 4.1 Route

```
GET /orders/{businessDay}/{id}/receipt
```

Implemented exactly as designed: pure read-only, no `Idempotency-Key`, no
`If-Match` requirement, no `ETag` response header. Uses the existing
`OrderPathParamsDto` and `parseBusinessDay` helper unchanged.

### 4.2 Owner

**Sales** — `ReceiptService` reads only `sales.orders`, `sales.order_lines`,
`sales.order_line_modifiers`, `sales.order_payments`, inside the existing
`OrdersController`. No new module, no new module import, no new published
`contract/` file.

### 4.3 OpenAPI verification

`npm run openapi:generate` run, regenerated **twice**, byte-identical both
times (`diff` confirmed no output on either `docs/api/openapi.json` or
`docs/api/openapi.yaml`) — deterministic.

Route/operation counts, verified against the regenerated document:

| Metric | Before | After |
|---|---|---|
| Paths | 111 | **112** |
| Operations | 151 | **152** |
| Source routes vs OpenAPI operations mismatch | 0 | **0** |

`test/openapi.e2e-spec.ts` result: **49/49** (baseline 46 + 3 new dedicated
`it` blocks for the adjacent Order-contract corrections, placed as separate
assertions for clearer test output rather than folded into an existing
`it` — the task's own §32 explicitly permits either). The existing
route-surface `it` was **extended**, not duplicated, so it stays one test
carrying one additional assertion (`receiptMatches`) plus two new forbidden
patterns.

---

## §5. AUTHORIZATION

`SALES_PERMISSIONS.ORDER_CREATE` (`pos.order.create`) reused — no new
permission created, none seeded, none added to `sales.permissions.ts` (file
unmodified — verified). The route inherits the class-level guard chain
(`JwtAuthGuard` → `TenantContextGuard` → `PermissionGuard`) and
`@AllowPosSession()` unchanged.

**Cross-tenant access verified 404, never 403** — e2e test **L** (§8).
**D-2 not reopened** — no handler consults `TenantContext.branchId`; branch
safety continues to come from terminal binding, exactly as every other
Sales route.

---

## §6. ELIGIBILITY

`order.state !== 'completed'` → `ReceiptNotAvailableError` → 422, via
`SalesDomainExceptionFilter`'s existing `@Catch(OrderStateError, ...)` —
**zero filter file changes**, confirmed by `git status` showing
`sales-domain-exception.filter.ts` untouched.

Verified for `open` (test **I**), `partially_paid` (test **J**), and
`cancelled` (test **K**), each returning exactly 422.

---

## §7. HISTORICAL STABILITY — PROVEN BY A LIVE TEST, NOT JUST ANALYSIS

Test **G** (`test/receipt.e2e-spec.ts`):

1. Completes an order with one line carrying one modifier.
2. Reads the receipt (`before`).
3. Renames the `MenuItem`, the `MenuItemVariant`, **and** the `Modifier` via
   direct admin writes.
4. Independently confirms the rename actually took effect in Catalogue
   (`renamedItem.names` equals the new value) — proving the test is not
   vacuously passing against a fixture that never changed.
5. Re-reads the receipt (`after`).
6. Asserts `after.lines[0].itemNameSnapshot` and
   `after.lines[0].modifiers[0].nameSnapshot` are **unchanged**, by deep
   equality against `before`.

**Result: PASS.** The snapshot survived the rename untouched, confirming
BR-POS-004's sale-time-snapshot guarantee end to end through the real HTTP
route and real PostgreSQL — not merely inferred from reading
`order-lines.service.ts`.

---

## §8. DEDICATED E2E TEST MATRIX — RESULTS

`test/receipt.e2e-spec.ts`, run against a **fresh, disposable scratch
database** (`ros_scratch_test`, migrated from zero, dropped after use —
never the persistent `ros` dev database for the authoritative run):

| # | Scenario | Result |
|---|---|---|
| A | Completed CASH order → receipt | **PASS** |
| B | Completed MANUAL_EXTERNAL_CARD order → receipt (`tenderedAmount`/`changeGiven` null, no merchant refs leaked) | **PASS** |
| C | Split tender (partial cash → settling card) → both payments listed, `Σ amounts == paidTotal == grandTotal` | **PASS** |
| D | Modifiers represented correctly (`nameSnapshot`, `priceDelta`, `quantity`) | **PASS** |
| E | Exact totals/tax invariant: `Σ lineSubtotal ≡ subtotal`, `Σ taxAmount ≡ taxTotal`, `Σ lineTotal ≡ grandTotal` as exact BigInt; `taxPresentation === 'EXCLUSIVE'` for the tax-exclusive test pack | **PASS** |
| F | Truthful zero discount/service-charge/tip, per-line `lineDiscount === "0"` | **PASS** |
| G | Catalogue rename after completion does not alter the historical receipt | **PASS** |
| H | Repeated GET → strict deep-equal body (no `generatedAt` field exists to differ) | **PASS** |
| I | `open` order → 422 | **PASS** |
| J | `partially_paid` order → 422 | **PASS** |
| K | `cancelled` order → 422 | **PASS** |
| L | Cross-tenant → 404 (never 403) | **PASS** |
| M | No token → 401; authenticated without `pos.order.create` → 403 | **PASS** |
| N | Wrong `businessDay` → 404; unknown `id` → 404; malformed date (`2026-02-31`) → 400 | **PASS** |
| O | `application/json`, documented top-level fields present (full contract-level check delegated to the global OpenAPI suite, which automatically covers this route — §4.3) | **PASS** |
| P | No DB mutation across 3 GETs: `orders.version`, `orders.updated_at`, and `governance.audit_entries` tenant row count all unchanged | **PASS** |

**16/16 — 100%.** No scenario was written for an unsupported product
capability (refund, post-fire void, comp, non-zero discount, service
charge, tip, printing) — each excluded explicitly per the design gate's
§20, not silently skipped.

Unit spec `src/modules/sales/receipt.views.spec.ts`: **18/18 — 100%**
(`deriveTaxPresentation`'s four branches; BigInt round-trip past
`Number.MAX_SAFE_INTEGER`; all money fields are strings; constants exact;
no `generatedAt`; COGS fields absent by key; merchant/internal payment
fields absent by key; internal order actor/operational fields absent by
key; truthful zero discount; distinct cash-rounding naming; null
tenderedAmount/changeGiven for card; modifier/name-snapshot pass-through).

---

## §9. REGRESSION VERIFICATION

### 9.1 Static gates

| Gate | Result |
|---|---|
| `npx prisma validate` | **valid** — schema file untouched |
| `npx nest build` | **clean**, run repeatedly through the session, always clean |
| `npx tsc --noEmit` | **1 PRE-EXISTING ERROR, ZERO NEW ERRORS** (`access-token.service.spec.ts:28` — unrelated Identity file, not touched this session; confirmed present both before and after every change) |
| `git diff --check` | **clean** — no whitespace errors |
| ESLint on every file this task touched or created (10 files) | **0 errors, 0 warnings** |
| ESLint on the full `{src,test}` tree | 48 pre-existing issues, **all** in files `git status` confirms this session never touched (`treasury.controller.ts`, `cash-sessions.service.ts`, `cash-session-close.e2e-spec.ts`, `cash-movements-close-and-payment-concurrency.e2e-spec.ts`, `cash-session-tender-totals.query.service.ts`) — pre-existing debt, zero new |

### 9.2 Module boundaries

```
npx jest src/modules/module-boundaries.spec.ts
45/45 — unchanged. KNOWN_DEVIATIONS: zero growth (verified — no entry
touched, no `sales->*` line edited).
```

### 9.3 Focused suites (dev DB)

```
receipt.e2e-spec.ts:  16/16
openapi.e2e-spec.ts:  49/49
sales.e2e-spec.ts:    63/63  (2 suites — fixed the one real regression, §9.5)
                      128/128 combined
```

### 9.4 Full unit suite

```
Before: 797/797, 59 suites (user-declared baseline)
After:  815/815, 60 suites  (+18 new receipt.views.spec.ts cases, +1 suite)
100%.
```

### 9.5 The one real regression found and fixed

`test/sales.e2e-spec.ts` carries its **own, independent** `/orders`
route-surface assertion (`'exposes order capture + explicit Fire (P1E-6) +
Payment capture (P1F-1)... and NOTHING with an unmet prerequisite'`) — a
different file and a different exact-list assertion from the one extended
in `openapi.e2e-spec.ts`. Adding the new route legitimately changed the
live route surface, so this test's expected list needed the receipt route
added — exactly the kind of consequence the test exists to catch. Fixed by
adding `'/orders/{businessDay}/{id}/receipt'` to its expected array and
extending its adjoining doc comment to name RCPT-R1, mirroring how the
Fire/Payment comments already read. Not worked around, not weakened —
the assertion still requires an *exact* list.

### 9.6 Full E2E — fresh scratch database, from-zero migrations

A disposable `ros_scratch_test` database was created on the same local
PostgreSQL instance (**never** the persistent `ros` dev database), and all
35 migrations were applied from zero via `prisma migrate deploy`:

```
35 migrations applied. No migration 36. Confirms zero schema change.
```

**Run 1** (fresh DB, default parallel workers):

```
Test Suites: 64 passed, 64 total
Tests:       1153 passed, 1153 total
100%.
```

**Run 2** (same DB, now carrying Run 1's accumulated fixture data, default
parallel workers) — investigated per the task's own instruction rather than
dismissed:

```
Test Suites: 63 passed, 1 failed, 64 total
Tests:       1152 passed, 1 failed, 1153 total
```

The single failure was `organisation.e2e-spec.ts`'s
*"leaves no org location entity without a registry row"* — a **global,
whole-database invariant check** that several unrelated e2e suites'
raw-admin fixture inserts across a shared, accumulated database can
violate once enough suites have run against it. This exact failure mode
(with the same test name) was independently observed against the
**persistent dev DB** at the very start of this session, *before any
Receipt code existed*, and is documented in a prior accepted report
(`2026-08-30_KDS_operator-lifecycle-implementation.md`) as a known
dirty-DB artifact unrelated to the feature under test. `git status`
confirms `test/organisation.e2e-spec.ts` and every file it depends on were
never touched by this task.

To fully isolate the question, per the task's §31 ("re-run against a
newly-created scratch DB with `--runInBand`"), the scratch database was
**dropped and recreated from zero** and the full suite run once more,
sequentially:

**Run 3** (freshly recreated DB, `--runInBand`, fully sequential):

```
Test Suites: 64 passed, 64 total
Tests:       1153 passed, 1153 total
100%.
```

**Conclusion:** Runs 1 and 3, each against a genuinely fresh database, both
pass 100%. Run 2's single failure is a pre-existing cross-suite
test-isolation gap in `organisation.e2e-spec.ts`'s global invariant check —
triggered by data accumulation across many unrelated suites sharing one
database within a single test process, not by anything this task changed.
**This is reported, not hidden or silently re-run away.** It is out of
this task's authorized scope to fix (it is not a Receipt file, not touched
by RCPT-R1, and fixing it would require auditing every suite's raw-admin
Organisation fixtures for a missing Location-registry insert — a
repository-wide fixture-hygiene fix, not a narrow Receipt correction).

The scratch database was dropped after verification. The original `.env`
was restored and re-verified pointing at the persistent dev database
(`prisma migrate status` → *"Database schema is up to date!"* at 35
migrations, unchanged).

### 9.7 Baseline comparison

| Gate | Baseline (user-declared) | This session (authoritative: fresh scratch DB, Run 1 and Run 3) |
|---|---|---|
| Unit | 797/797, 59 suites | **815/815, 60 suites** |
| Module boundaries | 45/45 | **45/45 — unchanged** |
| OpenAPI | 46/46 | **49/49** (3 new dedicated assertions, existing route-surface `it` extended) |
| Full e2e | 1134/1134, 63 suites | **1153/1153, 64 suites** |
| Migrations from zero | 35/35 | **35/35 — unchanged, no migration 36** |
| Lint | — | **0 new errors/warnings** (48 pre-existing, in files this task never touched) |
| TSC | 1 pre-existing error | **1 PRE-EXISTING ERROR, ZERO NEW ERRORS** |

---

## §10. REQUIREMENT STATUS AFTER IMPLEMENTATION

```
FR-POS-100 [M]  NOT IMPLEMENTED -> PARTIAL
   Still NOT IMPLEMENTED within it: country-pack mandated element set,
   tax registration number, invoice sequence, tax breakdown, required QR,
   physical print.
FR-POS-101 [M]  NOT IMPLEMENTED   (unchanged)
FR-POS-102 [M]  NOT IMPLEMENTED   (unchanged)
FR-POS-103 [M]  NOT IMPLEMENTED   (unchanged)
FR-POS-104 [S]  NOT IMPLEMENTED   (unchanged — re-GET satisfies the
                Internal-MVP reprint need; duplicate marking and logging,
                FR-POS-104's actual substance, are not implemented)
FR-POS-105 [M]  NOT IMPLEMENTED   (unchanged — kitchen printing)
FR-POS-106 [M]  NOT IMPLEMENTED   (unchanged — no printing subsystem)
```

**No receipt requirement reaches COMPLETE.**

**P1C-1:** unchanged globally. Still blocks the full fiscal receipt. Does
NOT block the ratified Internal-MVP non-fiscal projection (§6 of the
design gate; §3 above).

---

## §11. HARD BLOCKERS

**None.** Every §22/§27 forbidden-change category was checked against the
actual diff and confirmed absent:

```
prisma/schema.prisma / prisma/migrations/**  — untouched
receipt table / snapshot table / sequence    — none created
fiscal table                                 — none created
invoice sequence                             — none created
domain event                                 — none created
audit action                                 — none created
permission                                   — none created
cross-module public contract                 — none created
module-boundary deviation                    — zero growth (45/45,
                                                KNOWN_DEVIATIONS unchanged)
printer queue / delivery channel             — none created
```

---

## §12. INTERNAL MVP STATUS

**RECEIPT FINAL ACCEPTED CANDIDATE.**
**INTERNAL MVP READY FOR FINAL EXIT GATE.**

This report does **not** declare Internal MVP complete. The next task is
the independent Internal-MVP Exit Gate audit.

---

## §13. COMMIT

A single commit follows this report, staging exactly:

- the six new Receipt implementation/test files
- the four modified source/test files (`orders.controller.ts`,
  `sales.module.ts`, `openapi.e2e-spec.ts`, `sales.e2e-spec.ts`)
- the regenerated `docs/api/openapi.json` / `docs/api/openapi.yaml`
- the append-only governance register update
- this report and the accepted design-gate report
- their two corresponding `INDEX.md` rows

**Not staged:** the four pre-existing, unrelated historical reports and
`INDEX.md`'s already-modified state for rows unrelated to Receipt — those
remain exactly as they were found at the start of this session, per the
task's explicit instruction not to stage them.

No push. No deploy. No amend.

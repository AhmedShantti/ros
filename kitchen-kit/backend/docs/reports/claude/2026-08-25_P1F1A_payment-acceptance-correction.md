# P1F-1A — Payment Acceptance Correction

**Report type:** Implementation + verification report (correction of the accepted P1F-1 Payment MVP slice)
**Authority statement:** This report is non-authoritative evidence. The SRS and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority for requirements and architecture decisions. Nothing in this document creates, amends, or ratifies governance.
**Date:** 2026-08-25
**HEAD at start of task:** `a095bb103a2f961ce7c0161d1c572fccd9cebd60` (unchanged throughout — no commit made in this task)
**Branch:** `feat/production-spec`
**Working tree at start:** the uncommitted P1F-1 Payment slice (migration `20260824100000_sales_order_payment_capture`, `sales-payment.service.ts`, `sales-payment.e2e-spec.ts`, `sales-payment-concurrency.e2e-spec.ts`, `payment.errors.ts`, `treasury/contract/`, `treasury/cash-sessions/cash-session-facts.query.service.ts`, plus the P1F-1 report itself and three pre-existing untouched user files: `.gitignore`, `src/main.ts`, `src/scripts/seed-dev-data.ts`) — no commit was made across P1F-1 or this task.
**Task identifier:** P1F-1A

---

## A. Starting state confirmation

Before any edit, confirmed:
- HEAD unchanged at `a095bb1`, branch `feat/production-spec`.
- The P1F-1 migration `20260824100000_sales_order_payment_capture` is **absent from both local HEAD and `origin/feat/production-spec`** (`git log --all --oneline -- prisma/migrations/20260824100000_sales_order_payment_capture` returns nothing) — genuinely uncommitted, confirming it is safe to correct in place rather than create migration 28.
- `git status --short` matched the expected P1F-1 uncommitted working tree exactly, with the three pre-existing user files (`.gitignore`, `src/main.ts`, `src/scripts/seed-dev-data.ts`) present and untouched.

## B. Defect A confirmation

`SalesPaymentService` (P1F-1) imported `CountryPackService` directly from `../../localisation/country-pack/country-pack.service` — a private Localisation implementation path, not `contract/`. The P1F-1 report justified this as "zero new deviation" because `sales->localisation` was already an acknowledged `KNOWN_DEVIATIONS` entry (for `OrderLinesService`'s own pre-existing tax-engine consumption). That reasoning is rejected: an existing private-import deviation is unrepaired debt, not a public API: a second, unrelated consumer relying on the same private path *expands* the real violation even though the `KNOWN_DEVIATIONS` allow-list's shape does not change to reflect it.

## C. Localisation public-contract correction

Built Localisation's first-ever `contract/` directory, exposing exactly the four payment-relevant facts Payment needs — not the full `CountryPack` (which also carries tax engine internals Payment has no business seeing):

- `src/modules/localisation/contract/pinned-payment-policy.query.ts` (new) — `PINNED_PAYMENT_POLICY_QUERY` DI token, `PinnedPaymentPolicyQueryInput { countryCode, packVersion }`, `PinnedPaymentPolicy { currencyCode, cashRoundingEnabled, cashRoundingStepMinorUnits, roundingMode }`, `PinnedPaymentPolicyQuery.requirePinnedPaymentPolicy(input)`.
- `src/modules/localisation/contract/index.ts` (new) — barrel export.
- `src/modules/localisation/payment-policy/pinned-payment-policy.query.service.ts` (new, private) — `PinnedPaymentPolicyQueryService implements PinnedPaymentPolicyQuery`, delegating to the existing `CountryPackService.requirePinned()`.
- `src/modules/localisation/localisation.module.ts` (modified) — registers the new service, publishes it under the `PINNED_PAYMENT_POLICY_QUERY` token via `useExisting`, exports the token.
- `src/modules/sales/orders/sales-payment.service.ts` (modified) — the `CountryPackService` import and constructor dependency are gone; replaced with `@Inject(PINNED_PAYMENT_POLICY_QUERY) private readonly paymentPolicy: PinnedPaymentPolicyQuery` imported only from `localisation/contract`. Confirmed via grep: zero remaining `CountryPackService`/`countryPacks`/`pack.` references in the file.

The interface is deliberately **synchronous** (no `Prisma.TransactionClient` parameter): `CountryPackService.requirePinned()` is a genuine in-memory registry lookup, not a database call — confirmed by reading the real implementation before designing the contract, per the task's own caution against inventing a transactional shape that does not match reality. It still resolves the order's **pinned** `(countryCode, packVersion)`, never "current."

`OrderLinesService`'s own pre-existing direct `CountryPackService` import (the original `sales->localisation` deviation) is deliberately **not** touched — out of scope for this narrow correction.

## D. Architecture-boundary proof

`src/modules/module-boundaries.spec.ts` grew from 27 to **31 tests** (+4), added immediately after the existing "Payment adds zero new module-boundary deviations" test:

1. Localisation publishes a public pinned-payment-policy contract, and `SalesPaymentService` consumes only that contract (asserts the contract barrel exists, `sales-payment.service.ts` imports from `../../localisation/contract`, and does **not** import `localisation/country-pack`, `localisation/payment-policy`, or `localisation/tax`, and contains no `CountryPackService` string).
2. Localisation `contract/` contains interface/types only — `containsPersistenceImplementation(...)` is `false` for the contract file (mirrors the existing Catalogue/Organisation/Treasury contract precedent).
3. The concrete `PinnedPaymentPolicyQueryService` implementation is private (outside `contract/`), and Sales never imports it — `containsPersistenceImplementation(...)` is `true` for the private implementation file (the detector's `@Injectable`/`class` checks are a broad "this is a concrete implementation" proxy, not literally about Prisma queries — matches the established precedent for every other private query implementation in the suite).
4. Payment does not expand the historical `sales->localisation` deviation: `KNOWN_DEVIATIONS['sales->localisation']` still equals the exact original 6-entry array, and zero violations exist where `importer==='sales' && imported==='localisation' && file.includes('sales-payment.service.ts')`.

`npx jest --silent src/modules/module-boundaries.spec.ts` → **31/31 passing**.

## E. Original Payment FK audit (Defect B)

The P1F-1 migration defined two FKs weaker than existing available targets:

- `order_payments (tenant_id, order_id, business_day) -> sales.orders (tenant_id, id, business_day)` — tenant-safe but **not branch-safe**: a Payment could reference a real Order in a *different* branch than the one the Payment itself claims, despite `orders` already exposing a branch-inclusive composite unique target (`uq_orders_tenant_id_business_day_branch`, added in P1E-3 for an unrelated purpose).
- `order_payments.terminal_id -> identity.terminals(id)` — tenant/branch-**unsafe**: any real terminal ID from *any* tenant/branch satisfied it, despite `identity.terminals(branch_id, id)` already existing as an additive unique index (ADR 0008 D-16), already consumed by `treasury.drawers.terminal` for exactly this purpose.

Per ADR 0008 D-09: PostgreSQL evaluates FK checks with RLS disabled, so RLS alone cannot prevent a cross-branch/cross-tenant reference from being *written* — only a composite FK on the relevant columns makes the illegal combination structurally unrepresentable.

## F. Corrected Order/branch composite FK

`prisma/schema.prisma` — `OrderPayment.order` relation changed to `@relation(fields: [tenantId, orderId, businessDay, branchId], references: [tenantId, id, businessDay, branchId], onDelete: Restrict)`.

`prisma/migrations/20260824100000_sales_order_payment_capture/migration.sql` (corrected in place — confirmed uncommitted, see §A) — FK constraint renamed and widened to `order_payments_tenant_id_order_id_business_day_branch_id_fkey`, referencing `sales.orders(tenant_id, id, business_day, branch_id)` (the existing P1E-3 `uq_orders_tenant_id_business_day_branch` target). **No new Sales index created.**

Verified via direct `pg_constraint`/`pg_get_constraintdef` inspection against a freshly-migrated scratch database that the FK exists exactly as specified, including its automatic propagation to all 6 `orders_YYYY_MM` partition tables (`..._fkey1` through `..._fkey6`) — normal PostgreSQL partitioned-table FK behaviour, not a defect.

## G. Corrected branch/Terminal composite FK

`prisma/schema.prisma` — `OrderPayment.terminal` relation changed to `@relation(fields: [branchId, terminalId], references: [branchId, id], onDelete: Restrict)`.

Migration SQL — FK renamed to `order_payments_branch_id_terminal_id_fkey`, referencing `identity.terminals(branch_id, id)` — the same ADR 0008 D-16 target `treasury.drawers.terminal` already uses. **No new Identity index, no `tenant_id` column added to `identity.terminals`, no new Identity migration.**

Verified via the same `pg_constraint` inspection.

## H. CashSession FK disposition (unchanged, by instruction)

Inspected `treasury.cash_sessions` first, as instructed: it exposes only `(tenant_id, id)` as a composite unique target — no `(tenant_id, branch_id, id)` or equivalent exists. A branch-safe FK would require a **new** additive index on a Treasury-owned table, which is a separate Treasury migration this narrow Sales-owned correction does not make.

**Disposition: retained unchanged.** The existing tenant-safe FK (`order_payments (tenant_id, cash_session_id) -> treasury.cash_sessions (tenant_id, id)`) and the existing service-layer validation (branch/employee/terminal/currency/open-status matching via Treasury's `CASH_SESSION_FACTS_QUERY` contract) stand as-is. This is documented explicitly here rather than silently glossed over, per the task's own instruction not to alter a Treasury table from this correction.

## I. RLS proof (appPrisma / `ros_app`, unmodified, re-verified)

The full P1F-1 RLS proof block in `test/sales-payment.e2e-spec.ts`, using the real non-bypass `ros_app` connection (`app.get(PrismaService)`), is unchanged and re-verified passing: missing-tenant-context fail-closed, same-tenant positive control, cross-tenant SELECT returns empty + positive control, INSERT without tenant context rejected, `ros_app` cannot UPDATE/DELETE Payment rows (with a same-row survival proof afterward), and the grant set is exactly SELECT+INSERT (UPDATE/DELETE/TRUNCATE revoked). None of these tests were weakened, mocked, or skipped; none were converted to use the admin/migrator connection.

## J. Structural FK proof (new, migrator/admin client — permitted only for this)

Added a `describe('structural FK integrity (P1F-1A §9)', ...)` block to `test/sales-payment.e2e-spec.ts` using the raw migrator/admin client (explicitly permitted for this narrow purpose, per the task's own instruction, to isolate FK behaviour from RLS — the existing RLS tests were **not** converted to this connection):

- **A** — valid Payment/Order/branch/Terminal combination inserts (positive control).
- **B** — a real Order, but the Payment's own `branch_id` set to a *different* branch (matching terminal/cash-session for that other branch) — isolates the Order/branch FK as the sole rejection cause; rejected with a foreign-key violation.
- **C** — branch A Payment referencing a Terminal registered to branch U — isolates the Terminal/branch FK; rejected.
- **D** — branch A Payment referencing a Terminal that belongs to a *different tenant* entirely — cross-tenant case; rejected.
- **E** — a fabricated, non-existent `order_id` — rejected (baseline FK sanity).

All five pass. A `validPayment(...)` helper was retyped from a loosely-typed `Record<string, unknown>` parameter to `Partial<Prisma.OrderPaymentUncheckedCreateInput> & Pick<..., 'orderId' | 'businessDay' | 'terminalId' | 'cashSessionId'>` with an explicit return type, after `tsc --noEmit` (not eslint, not the passing test run, since JS test execution does not enforce the TS type) caught that the original shape could not prove the merged object actually satisfied the required-fields contract.

## K. A genuine regression the correction surfaced (honest finding)

The pre-existing P1F-1 test "the rounding-DISABLED country pack applies zero rounding" used a PIN token bound to `terminalA` (branch A) to capture a payment for an order actually booked at `terminalU`/branch U. Under the **old**, weak `terminal_id -> identity.terminals(id)` FK this silently succeeded — any valid terminal ID satisfied it regardless of branch, masking a real cross-branch-terminal capture that should never have been permitted. After the Defect B fix (§G), this correctly fails with a foreign-key violation. **Fixed** by logging in with a token bound to `terminalU` (matching the order's actual branch) for that one test only — not by weakening the new FK or adding new service-level validation, which would have been out of scope for this correction. This is reported as a genuine defect the FK hardening exposed and fixed, not a test-authoring artifact of this task.

## L. Migration-from-zero proof

Migration count confirmed **27** before and after (no migration 28 created; the P1F-1 migration was corrected in place per §A/F/G).

Verification performed twice against a freshly created, disposable scratch database (`ros_p1f1a_scratch`, `createdb`/`dropdb`-provisioned, never the persistent dev DB):
1. First pass (mid-phase): `prisma migrate deploy` applied all 27 migrations cleanly from zero; full Payment e2e suite 51/51; concurrency proof 3/3 clean; full unit suite 722/722; broader regression sweep 303/303 across 12 suites; OpenAPI regenerated (133 operations, 3.1.0, zero drift); `tsc --noEmit` clean (only the known pre-existing baseline error, see §M); `git diff --check` clean; `prisma validate` clean.
2. Final pass (this report): the scratch database was **dropped and recreated fresh**, all 27 migrations reapplied from zero (`20260824100000_sales_order_payment_capture` confirmed as the last-applied migration), full unit suite re-run — **722/722** — then the full e2e suite run against this same fresh instance — **731/731, 34/34 suites**, exit code 0.

Both `DATABASE_URL` and `APP_DATABASE_URL` were set to the scratch database for every one of these runs (the app's own `PrismaService` reads `APP_DATABASE_URL`, a distinct variable from the one `prisma migrate deploy` and the raw migrator client use — a pitfall discovered in P1E-6A and re-applied correctly throughout).

## M. Persistent dev DB proof

After dropping the final scratch database, `npx prisma migrate status` was run against the **unmodified** `.env` configuration (pointing at the persistent `ros` database on port 5544). Output: *"Following migration have not yet been applied: `20260824100000_sales_order_payment_capture`"* — identical to its state before any P1F-1A (and indeed any P1F-1) scratch-DB work began. The persistent dev database was never migrated or otherwise touched by this task. The scratch database `ros_p1f1a_scratch` was dropped only after this confirmation.

## N. Payment regression proof

- Full unit suite: **722/722 passing** (51 suites) — includes the +4 module-boundary tests from §D.
- Broader regression sweep (Fire, Fire concurrency, Orders, Order lines, CashSession, Kitchen persistence/concurrency, domain events, Payment, Payment concurrency, OpenAPI — 12 suites): **303/303 passing**.
- Full e2e suite against the final clean from-zero scratch DB: **731/731 passing, 34/34 suites**, exit code 0 (§L). This equals the expected total: 726 (P1F-1 baseline) − 46 (old `sales-payment.e2e-spec.ts` count) + 51 (new count, §O) = 731.
- `test/sales-payment.e2e-spec.ts` grew from 46 to **51 tests** (+5 structural FK tests, §J), plus one pre-existing test corrected for the real regression in §K.
- `test/sales-payment-concurrency.e2e-spec.ts` — unmodified (no schema/FK change affects its fixtures, which already use matching branch/terminal combinations); re-verified passing 3/3 clean runs.

All previously-accepted P1F-1 Payment semantics are preserved unchanged: CASH/manual-external-card capture, no PaymentAttempt for either tender, per-payment CashSession attribution, Employee-as-financial-actor/User-as-audit-actor, per-payment rounding recorded distinctly (`rounding_adjustment`, never absorbed into `paid_total`), the `FullPaymentRequiresCompletionError` full/over-settlement safety gate (still present, not removed), OPEN→PARTIALLY_PAID transition and further-partial-stays-PARTIALLY_PAID, permanent-Payment-identity replay/conflict semantics, HTTP Idempotency-Key semantics, If-Match/ETag optimistic concurrency, append-only grants/RLS, PCI card-field restrictions, transactional audit (`PAYMENT_CAPTURED`), and `pos.payment.capture` authorization.

## O. OpenAPI proof

Regenerated via `npm run openapi:generate`: **133 operations** (unchanged from P1F-1 — no route shape changed by this correction, confirmed by inspection, not assumption), `openapi: 3.1.0`, `npm run openapi:check` reports **zero drift**.

## P. Files changed (this task, on top of the already-uncommitted P1F-1 tree)

New:
- `src/modules/localisation/contract/pinned-payment-policy.query.ts`
- `src/modules/localisation/contract/index.ts`
- `src/modules/localisation/payment-policy/pinned-payment-policy.query.service.ts`

Modified:
- `src/modules/localisation/localisation.module.ts`
- `src/modules/sales/orders/sales-payment.service.ts`
- `src/modules/module-boundaries.spec.ts` (27→31 tests)
- `prisma/schema.prisma` (`OrderPayment.order`, `OrderPayment.terminal` relations)
- `prisma/migrations/20260824100000_sales_order_payment_capture/migration.sql` (corrected in place, confirmed uncommitted — see §A)
- `test/sales-payment.e2e-spec.ts` (46→51 tests, +1 test fixed for the §K regression)
- `docs/api/openapi.json`, `docs/api/openapi.yaml` (regenerated, no shape change)

Untouched by this task (already uncommitted from P1F-1, left exactly as-is): `payment.errors.ts`, `treasury/contract/`, `treasury/cash-sessions/cash-session-facts.query.service.ts`, `test/sales-payment-concurrency.e2e-spec.ts`, the three pre-existing user files (`.gitignore`, `src/main.ts`, `src/scripts/seed-dev-data.ts`), and the P1F-1 report.

## Q. Exact test results (final, this session)

| Suite | Result |
|---|---|
| `module-boundaries.spec.ts` (isolated) | 31/31 |
| Full unit suite (final clean-DB pass) | 722/722 (51 suites) |
| Regression sweep (12 named suites) | 303/303 |
| Full e2e suite (final from-zero clean scratch DB) | 731/731 (34 suites), exit 0 |
| `sales-payment-concurrency.e2e-spec.ts` | 3/3 clean runs |
| `eslint` on all P1F-1A changed/new files | 0 errors, 0 warnings |
| `tsc --noEmit` | only the known pre-existing baseline error (`access-token.service.spec.ts`); zero new errors |
| `git diff --check` | clean |
| `npx prisma validate` | clean |
| `npm run openapi:check` | zero drift, 133 operations, 3.1.0 |

## R. Requirement classifications

No requirement classification changes as a result of this correction. Defect A and Defect B were architecture/schema-integrity corrections to the already-accepted P1F-1 scope, not new requirement coverage. BR-FIN-004, BR-POS-002, P1D-B through P1D-G remain classified exactly as in the P1F-1 report.

## S. Acceptance exit

All 17 acceptance conditions of the governing P1F-1A instruction are met:
- Defect A corrected via a new narrow Localisation `contract/` (§C), mechanically proven (§D), zero `KNOWN_DEVIATIONS` growth.
- Defect B corrected using only existing composite targets, no new indexes, `ON DELETE RESTRICT` preserved (§F, §G).
- CashSession FK deliberately unchanged with explicit reasoning recorded (§H).
- RLS proof preserved unweakened/unmocked/unskipped (§I); structural FK proof added using the admin client only where permitted (§J).
- Migration corrected in place, count remains 27 (§L).
- Persistent dev DB proven untouched (§M).
- Full regression, unit, e2e, concurrency, OpenAPI, tsc, eslint, `prisma validate`, `git diff --check` all pass (§N, §O, §Q).
- Governance untouched: no D-21+, no permission invented, P1D-B..G preserved exactly.
- No commit, no push, no amend, no destructive git command, no edit to the three preserved user files.

## T. Remaining scope / next

Explicitly not attempted (per the task's own non-goals): P1F-2, final Payment, Order Completion, `order.completed`, inventory depletion, completion-time COGS, Treasury completion posting, fiscal/receipt generation, loyalty, refunds, integrated-card lifecycle, PaymentAttempt, session/day close, tender reconciliation, branch-scoped RBAC cleanup, global Localisation/module-boundary refactors, RFC7807, `/v1` runtime prefix, or `OrderLinesService`'s own pre-existing `sales->localisation` debt.

**Commit readiness:** the corrected P1F-1+P1F-1A working tree is verification-complete and internally consistent (schema, migration, code, and tests all agree; full suite green from zero on a disposable DB; persistent DB untouched). No commit or push was made in this task, per standing instruction — commit/push remains a decision for the user.

**Next (not started):** P1F-2 / Order Completion, per the P1F-1 report's own stated trajectory.

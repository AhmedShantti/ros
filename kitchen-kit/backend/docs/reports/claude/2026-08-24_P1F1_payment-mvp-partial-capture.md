# P1F-1 — Payment MVP: Partial CASH + Manual/External Card Capture

**Date:** 2026-08-24 (session continued into 2026-08-25 across two network interruptions)
**Branch:** `feat/production-spec`
**HEAD at start and end (unchanged — no commit made):** `a095bb103a2f961ce7c0161d1c572fccd9cebd60`
**Slice:** P1F-1 — IMPLEMENTATION. The first callable Payment slice after the accepted Fire path: persistent append-only Sales Payment, CASH and manual/external-card tender, partial-payment Order lifecycle, payment-level CashSession attribution, idempotent financial capture, optimistic concurrency, cash change/rounding, audit, RLS, OpenAPI. Full/over-settlement is explicitly refused — Completion does not exist yet.
**Report author:** Claude (Sonnet 5), per the repository's `CLAUDE.md` reporting policy

This report is non-authoritative evidence of implementation work performed in
this session. The ROS SRS and ratified governance decisions remain the sole
authority on what the system is *supposed* to be. §T's classification table
is a truthful statement of what is verified to work today, not a claim that
broader requirements (Completion, inventory depletion, COGS, fiscal
documents, receipts) are satisfied.

---

## A. STARTING STATE

Verified before any edit: `git status -sb`, `git branch --show-current`,
`git rev-parse HEAD`, `git branch -vv`.

- Branch: `feat/production-spec`. HEAD: `a095bb103a2f961ce7c0161d1c572fccd9cebd60`.
  The task's own stated expectation was `1ed3521...` (the Fire feature
  commit); the actual HEAD is one commit ahead of that
  (`a095bb1`, `docs: record Fire checkpoint verification`) — the
  documentation-only follow-up commit the *prior* checkpoint task itself
  required. Confirmed this is not drift: `git log --oneline -3` shows a
  strictly linear history (`01c0b0f` → `1ed3521` → `a095bb1`), `git diff
  HEAD origin/feat/production-spec` is empty, and `origin/main` remains at
  `01c0b0f`, untouched. Proceeded on this basis rather than stopping, since
  branch matches exactly, the extra commit is docs-only and already
  reported, and no external divergence exists.
- `docs/reports/claude/2026-08-24_P1E6_CHECKPOINT_fire.md` and its INDEX row
  are present in HEAD — CHECKPOINT REPORT REPO PRESENCE: YES.
- Preserved pre-existing local changes, confirmed present and left
  untouched throughout: `M .gitignore`, `M src/main.ts`,
  `?? src/scripts/seed-dev-data.ts`.
- No `git stash`/`reset`/`checkout`/`restore`/`clean`/`rebase` used anywhere
  in this session. No commit, no push.

This session was interrupted twice by transport-level failures (API/DNS
`ENOTFOUND`), not by any repository or test failure. Both times, work was
resumed in place from the exact uncommitted working-tree state — nothing
was redone, restarted, or reverted.

---

## B. SOURCE / GOVERNANCE CONFIRMATION

Read `ROS_SRS_v1.0.pdf` directly (via `pdftotext`, not summarised from
memory) for every cited section, and
`docs/governance/GOVERNANCE_DECISION_REGISTER.md`'s full P1D-B..G text.

**Key findings, source-grounded, not assumed:**

- **§1.2** — atomicity (the "nine effects") belongs to a *completed* order,
  not to a payment. This is why the §L safety gate exists: nothing in this
  slice may produce a state that implies those nine effects happened.
- **§7.4.1 BR-POS-002** (exact SRS text): *"An Order SHALL NOT transition
  to COMPLETED while `paid_total + discount_total_of_comps < grand_total`."*
  §24.2.4's own reference pseudocode for `Order.complete()` confirms the
  same shape operationally: `paid` (`Money.sum` of payment amounts) compared
  directly against `grandTotal - compTotal`, with **no rounding term
  anywhere in that comparison**.
- **No comp/discount mechanism exists anywhere in this codebase.**
  `discountTotal` never leaves `0` in any implemented flow (confirmed:
  `OrderLine.isComp` exists as a schema placeholder but no code path sets
  it `true`). `discount_total_of_comps`/`compTotal` is therefore not a
  guess-and-omit — it is a term whose real value is verifiably always `0`
  today, so `paid_total >= grand_total` **is** the SRS's own formula in
  this codebase's current state, not an invented substitute.
- **BR-FIN-004** (exact SRS text): *"Cash rounding... SHALL be applied only
  to the cash portion of a payment and SHALL be recorded as a distinct
  rounding_adjustment, never absorbed into revenue or tax."* Combined with
  the settlement-formula finding above, this resolves §14's flagged
  ambiguity concretely: **`rounding_adjustment` does not participate in the
  settlement threshold at all** — it is a cash-drawer reconciliation figure
  only (FR-FIN-004's expected-cash formula), orthogonal to `paid_total`.
  This is not a dodge of the ambiguity; it is the answer the source gives.
- P1D-B/C/D/E/F/G (`GOVERNANCE_DECISION_REGISTER.md`) read in full and
  followed verbatim — not reopened. See §K/§M/§N for exactly where each is
  implemented.

---

## C. PAYMENT OWNERSHIP

SRS §5.3/§25.1 places `order_payments` under Sales; Treasury owns
Drawer/CashSession. Confirmed via direct code inspection that Sales had
**zero** existing edge into Treasury (`module-boundaries.spec.ts`'s
`KNOWN_DEVIATIONS` has no `sales->treasury` entry at all — this is the
first). Payment persistence, application logic, and the HTTP route are all
implemented inside Sales; Treasury gained one new published contract query
and nothing else (§F).

Separately, Sales already had a pre-existing, unchanged, ratified deviation
(`KNOWN_DEVIATIONS['sales->localisation']`, includes
`country-pack/country-pack.service`) that `OrderLinesService` already uses
for tax purposes. Payment reuses this **exact same** `CountryPackService`
and its `requirePinned()` method, for cash-rounding data — introducing
**zero new Localisation surface and zero new deviation** (§G).

---

## D. SCHEMA / MIGRATION

New migration: `20260824100000_sales_order_payment_capture` (27th
migration, forward-only, no edit to any prior migration file).

`sales.order_payments` — **not partitioned** (mirrors `order_line_modifiers`
/ `order_line_station_overrides`: a leaf reached only through its order,
carrying `business_day` solely for the tenant-safe composite FK — not in
FR-DR-001's partition list). New enum `sales.OrderPaymentTender` (`cash`,
`manual_external_card` — MVP scope only; the SRS names eleven tenders, and
adding the other nine would be appearance without capability).

Columns, truthfully as specified: `id, tenant_id, branch_id, order_id,
business_day, tender, currency, amount, rounding_adjustment,
cash_session_id, employee_id, terminal_id, tendered_amount, change_given,
payment_terminal_txn_ref, card_scheme, card_last4, authorization_code,
processed_at, created_at`. No mutable `status`. No `PaymentAttempt` table.
No PAN/CVV/track/magstripe/encrypted-PAN/raw-response field — not merely
unvalidated, structurally absent from the schema (FR-POS-066).

**CHECK constraints** (all row-local, source-decided):
`ck_order_payments_amount_positive` (`amount > 0`),
`ck_order_payments_last4` (`card_last4 IS NULL OR ~ '^[0-9]{4}$'`),
`ck_order_payments_cash_fields` (CASH requires
tendered/change, forbids all card fields),
`ck_order_payments_card_fields` (MANUAL_EXTERNAL_CARD requires a terminal
reference, forbids cash fields, and **CHECK-enforces `rounding_adjustment =
0`** — BR-FIN-004 at the database, not only in application code).

**PAYMENT TABLE COMPLETE.**

---

## E. TENANT-SAFE FKS / RLS

- `(tenant_id, order_id, business_day) -> sales.orders(tenant_id, id,
  business_day)`, `ON DELETE RESTRICT` — the established partition-safe
  composite target `order_lines` already uses.
- `(tenant_id, employee_id) -> identity.employees(tenant_id, id)` — mirrors
  `orders.opened_by`'s own composite FK.
- `terminal_id -> identity.terminals(id)` — simple FK; `identity.terminals`
  has no `(tenant_id, id)` composite unique, the same documented limitation
  `orders.terminal_id` already carries.
- **`(tenant_id, cash_session_id) -> treasury.cash_sessions(tenant_id,
  id)`** — uses CashSession's *existing* tenant-safe unique target. This is
  deliberately **not** branch-safe at the FK level: `CashSession` has no
  `(tenant_id, branch_id, id)` composite index, and adding one would be a
  **Treasury-owned migration this slice does not make** (the task's own
  explicit instruction: "do not modify a Treasury table from a Sales-owned
  migration merely for convenience"). Branch/employee/terminal/currency/
  open-status matching is validated at the service layer instead, through
  Treasury's public contract (§F) — the same two-part pattern (FK proves
  tenant safety; service proves the rest) Fire already established for the
  dine-in table check.

**RLS:** `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`.
`ros_app` granted `SELECT, INSERT` only; `UPDATE, DELETE, TRUNCATE`
explicitly `REVOKE`d (mirroring `governance.audit_entries`'s established
append-only pattern exactly). Only `SELECT`/`INSERT` policies exist — no
`UPDATE`/`DELETE` policy at all, so even a future privilege grant would
still have no policy to act under.

**Proven, not merely configured** — `test/sales-payment.e2e-spec.ts`,
`Payment schema / DB` block, using the real application connection
(`app.get(PrismaService)`, `ros_app`/NOBYPASSRLS — never the migrator/admin
client, which would prove nothing about RLS):

- missing tenant context → fail closed: `SELECT` returns 0 rows *even
  though the row exists*; `INSERT` with no tenant context rejected.
- same tenant → allowed (positive control): sees its own row.
- cross-tenant: `SELECT` as tenant B returns 0 rows for tenant A's payment;
  **the same query as tenant A does see it** (positive control proving the
  empty result is RLS, not a bad `WHERE` clause); a tenant B HTTP token
  cannot reach the order at all (404).
- append-only: `ros_app` cannot `UPDATE` (row provably unchanged
  afterward) or `DELETE` (row provably still present afterward) a Payment
  row; a **positive control** proves `ros_app` can still `SELECT` its own
  row (so the UPDATE/DELETE refusal is a real privilege gap, not a broken
  connection); `information_schema.role_table_grants` confirms exactly
  `['INSERT','SELECT']`, nothing else.

**APPEND-ONLY ENFORCED. RLS COMPLETE.**

---

## F. TREASURY PUBLIC CONTRACT

No public Treasury query existed at all (Treasury's only route was a
write — `cash.session.open`). Added the narrowest possible new contract:

`src/modules/treasury/contract/cash-session-facts.query.ts` —
`CASH_SESSION_FACTS_QUERY` token, `CashSessionFactsQuery` interface,
`find(tx, {tenantId, cashSessionId}): Promise<CashSessionFacts | null>`,
transaction-aware (the CALLER's own `Prisma.TransactionClient`, same
pattern as P1E-6's Catalogue/Organisation contracts). Returned facts:
`cashSessionId, tenantId, branchId, employeeId, shiftId, drawerId,
terminalId (nullable, from Drawer), currency, status` — exactly what
Payment capture needs to validate P1D-G attribution, nothing invented
beyond the real schema.

Private implementation: `treasury/cash-sessions/
cash-session-facts.query.service.ts`, bound via `useExisting` only inside
`TreasuryModule`, mirroring `CatalogueFireFactsQueryService`/
`TableDisplayQueryService`'s exact P1E-6 precedent. `sales-payment.service.ts`
imports only `treasury/contract`; `module-boundaries.spec.ts` proves this
mechanically (new tests: contract purity, concrete-implementation privacy,
zero new deviation — `KNOWN_DEVIATIONS['sales->treasury']` stays
`undefined`).

---

## G. LOCALISATION / CASH-ROUNDING CONTRACT

No new contract was built. Sales already has an established, unchanged
`sales->localisation` deviation (`country-pack/country-pack.service`),
used identically by `OrderLinesService` for tax. `SalesPaymentService`
calls the exact same `CountryPackService.requirePinned(branch.countryCode,
order.countryPackVersion)` — the order's **pinned** pack, never "current" —
and reads `pack.currency.cashRounding.{enabled, stepMinorUnits}`. There is
no cash-specific rounding-mode field on `CountryPack`; `pack.tax.roundingMode`
(BR-FIN-002's system-wide, pack-overridable default) is used, since it is
the only rounding-mode value the pinned pack structurally provides.

---

## H. CASH CAPTURE

`amount` (what accumulates into `paid_total`) is the EXACT figure being
settled. Cash rounding is computed **separately**:

```
roundedCashDue = divideRounded(amount, stepMinorUnits, pack.tax.roundingMode) * stepMinorUnits
roundingAdjustment = roundedCashDue - amount
changeGiven = tenderedAmountMinor - roundedCashDue
```

`divideRounded` (`common/money/rounding.ts`) — exact `bigint` integer
division with an explicit tie rule; **no `Number`, no `Math.round`, no
float anywhere in this path.** Insufficient tendered cash
(`tenderedAmountMinor < roundedCashDue`) is refused
(`InsufficientCashTenderedError`, 422) before any write.

Proven end to end (`test/sales-payment.e2e-spec.ts`, CASH capture block):
open/valid-session requirement; wrong employee/branch/terminal/currency/
closed-session all rejected (422); insufficient tender rejected; **change
due computed correctly with rounding enabled** (step 25, HALF_UP: 2137 →
2125, `roundingAdjustment: -12`, `changeGiven` computed from the rounded
figure); rounding persisted **per Payment** and the Order's
`rounding_adjustment` projection reflects it while `paid_total` moves by
the exact, unrounded `amount` (2137, not 2125); the rounding-**disabled**
country pack (a second branch, pinned to a `cashRounding.enabled: false`
pack) applies zero adjustment.

**CASH ROUNDING COMPLETE FOR IMPLEMENTED SEMANTICS.**

---

## I. MANUAL EXTERNAL CARD CAPTURE

No PaymentAttempt, no terminal initiation, no timeout/decline/partial-
approval modelling — per P1D-C and the task's explicit non-goals, ROS
records an already-completed external-machine transaction, nothing more.
`terminalReference` required (`BadRequestException`, 400, if absent);
`rounding_adjustment` is always `0` (CHECK-enforced at the database, not
only in application code); no tendered/change semantics at all
(`tenderedAmount`/`changeGiven` are `NULL`). Retained metadata is exactly
FR-POS-066's permitted list (`cardScheme`, `last4`, `authorizationCode`,
`terminalReference` itself) — optional, and the DTO has no field capable of
representing PAN/CVV/track data at all; a PCI-looking extra field (`pan`)
sent in a request is rejected outright (400, `forbidNonWhitelisted`) before
any handler code runs.

**MANUAL EXTERNAL CARD PARTIAL CAPTURE COMPLETE. PAYMENT ATTEMPT ABSENT FOR
MVP TENDERS.**

---

## J. PAYMENT IDEMPOTENCY

Two independent guarantees, both proven:

1. **HTTP Idempotency-Key** (the shared, P1E-6A-corrected, resolved-path
   mechanism — unmodified here): same key + same body replays (one
   Payment, one `paid_total` change, one audit entry); same key + different
   order 409s, never replays order X onto order Y; same key + different
   body 409s.
2. **Permanent Payment identity** (FR-OFF-015, a *separate* concern the
   task named explicitly): the same client-chosen Payment `id`, resubmitted
   under a genuinely *different* Idempotency-Key, is checked **first**,
   before any other work, mirroring `CashSessionsService.open()`'s own
   established pattern — identical content replays (no second financial
   effect); different content under the same id gets a 409
   (`ConflictException`, matching the exact message convention
   `CashSessionsService` already uses for this scenario, not a new error
   shape).

The actual database write uses the P1E-5A-proven conflict-safe pattern:
`INSERT ... ON CONFLICT ("id") DO NOTHING RETURNING <explicit camelCase
column aliases>` (tagged-template `$queryRaw`, never string interpolation),
falling back to a plain `SELECT` on conflict — never a caught-`P2002`-then-
query pattern, which P1E-5A already proved poisons the transaction.

**A real bug was found and fixed during testing**: the first draft used
`RETURNING *`, which returns raw `snake_case` SQL column names, not the
Prisma-mapped `camelCase` shape the rest of the code expects — every
successful capture 500'd on `payment.businessDay.toISOString()` being
`undefined`. Fixed by explicitly aliasing every column in the `RETURNING`
clause (`"business_day" AS "businessDay"`, etc.), matching
`TicketPersistenceService`'s own established convention exactly — this was
already the right pattern; the bug was not reusing it consistently.

**IDEMPOTENCY COMPLETE FOR SUPPORTED PATH.**

---

## K. ORDER STATE / PARTIAL PAYMENT

`order-state.ts` gained one new legal transition, `open -> partially_paid`
(source-required by BR-POS-002/§13), and one new guard function,
`assertMayCapturePayment(orderState)`, mirroring `assertMayAddLine`'s
exact style: `assertOrderMutable` first (so a finalised order still gets
its existing BR-POS-001 message unchanged), then an explicit reject for
anything other than `open`/`partially_paid`. **`PARTIALLY_PAID ->
PARTIALLY_PAID` was deliberately NOT added as a transition** — per the
task's own instruction, a further partial payment on an already-
partially-paid order changes only `paid_total`/`rounding_adjustment`/
`version`, never calling `assertTransition` at all, since the state does
not change.

`orders.paid_total` is incremented by the exact `amount` (never the
rounded cash figure); `orders.rounding_adjustment` is incremented by the
per-payment `roundingAdjustment` — both via the same atomic
`order.updateMany({..., version: expectedVersion})` CAS the Payment insert
shares a transaction with. **No new "remaining balance" column** —
`orderRemainingBalance(order) = grandTotal - paidTotal`, computed fresh at
response time in `sales.views.ts`, the only place the subtraction happens.

Proven: OPEN + partial → PARTIALLY_PAID; PARTIALLY_PAID + further partial
stays PARTIALLY_PAID; DRAFT/HELD/PARKED/CANCELLED all rejected (422, the
terminal-state case carrying the existing BR-POS-001 message unchanged).

---

## L. FULL-PAYMENT SAFETY GATE

Implemented exactly per §14/§B's resolved formula:
`newPaidTotal = order.paidTotal + input.amountMinor; if (newPaidTotal >=
order.grandTotal) throw FullPaymentRequiresCompletionError` — checked
**before any write of any kind**, with the typed error code
`FULL_PAYMENT_REQUIRES_COMPLETION`, mapped to 422 via the existing
`SalesDomainExceptionFilter` (the error extends `OrderStateError`, zero new
filter wiring).

Proven atomically: a payment requesting the exact `grandTotal` is refused
422, and afterward the order's state/version/`paid_total` are all
byte-identical to before, zero `OrderPayment` rows exist for that order,
and the `PAYMENT_CAPTURED` audit count is unchanged.

**FULL-PAYMENT SAFETY GATE COMPLETE.**

---

## M. OPTIMISTIC CONCURRENCY

Payment insert and the Order `paid_total`/`rounding_adjustment`/`state`/
`version` update are one atomic unit — the same `PrismaService.
withAuthContext()` transaction, the same `updateMany({where: {id,
businessDay, version: expectedVersion}, ...})` CAS shape Fire already
established. A stale `If-Match` produces `OrderVersionConflictError` (409),
proven via the real HTTP route (missing/malformed/stale/correct If-Match,
including the correct-case ETag/version round-trip).

---

## N. REAL CONCURRENCY PROOF

New file: `test/sales-payment-concurrency.e2e-spec.ts`, the exact P1E-5A/
P1E-6A pattern — two genuinely independent transactions, direct service
calls (`app.get(SalesPaymentService)`, no HTTP), synchronized by a real
barrier (`makeBarrier(2)`; no sleeps).

**The seam**: `CASH_SESSION_FACTS_QUERY` — the Treasury contract token this
service already injects (§F) — overridden with a barrier-aware stub that
delegates to the real one-line lookup after awaiting the barrier. The
service calls this dependency strictly after loading the order and
computing `nextVersion`, and strictly before the §14 gate and the CAS —
zero production code changes.

**Design proves the settlement-race case specifically, not only
lost-update**: both participants request an amount that is individually
partial against the pre-race `paid_total` (0) but would together exceed
`grand_total` (60% each). Because neither writes before the barrier
releases both, both independently pass their own §14 gate check — the race
is decided entirely by the CAS.

Required post-conditions, all proven: exactly one `Promise.allSettled`
result fulfils, the other rejects with `OrderVersionConflictError`;
`Order.version` bumped exactly once; `Order.paidTotal` incremented exactly
once (never both amounts); `Order.paidTotal < Order.grandTotal` holds
afterward (no silent over-settlement); exactly one `OrderPayment` row;
exactly one `PAYMENT_CAPTURED` audit entry.

Run 9 times across this session (1 + 5 + 3 consecutive), on both the
iterative-development scratch database and the final from-zero clean
database — zero flakiness.

**REAL CONCURRENCY PROOF: YES.**

---

## O. AUDIT

One new taxonomy verb, `PAYMENT_CAPTURED` (`AUDIT_ACTION`), one new entity,
`order_payment` (`AUDIT_ENTITY.ORDER_PAYMENT`) — the same
`<ENTITY>_<PAST_TENSE>` convention every prior slice uses. Written in the
**same transaction** as the Payment insert and the Order CAS. Identifies:
order, payment tender, amount, rounding adjustment, CashSession, terminal,
the Employee financial actor (P1D-E), and (per the existing audit
architecture) the User as the audit/security actor — `actorType: 'user'`,
`actorId: actorUserId`. Never records PAN/CVV/track/raw-card-payload —
proven by asserting the serialized audit row (BigInt-safe) does not match
`/pan|cvv|track/i`.

Proven: exactly one audit entry on success; **no** audit entry on a
rolled-back attempt (a closed-session capture); replay never duplicates it
(the HTTP-idempotency test asserts audit count stays 1 across a replay).

**AUDIT COMPLETE.**

---

## P. AUTHORIZATION

`pos.payment.capture` (P1D-F, the one explicitly authorised
zero-invented-codes exception) added to `SALES_PERMISSIONS`/
`SALES_PERMISSION_DEFS`, required server-side
(`@RequirePermission(SALES_PERMISSIONS.PAYMENT_CAPTURE)`). Both the
terminal AND the employee come from the trusted PIN session
(`requirePosIdentity`, mirroring `TreasuryController`'s own established
helper) — never the body, matching P1D-E's financial-actor requirement.
`pos.order.create` alone is proven insufficient (403). `src/scripts/
seed-dev-data.ts` was **not** touched, per explicit instruction — FR-SEC-010
predefined production Waiter/Cashier role distribution remains the
separate, pre-existing, unclosed gap it already was.

---

## Q. OPENAPI

Regenerated. **132 → 133 operations** (exactly the one new route), `openapi:
3.1.0` — confirmed deterministic (two consecutive generations produce a
byte-identical diff, zero drift on the second). Documents: Idempotency-Key,
If-Match, the `tender` discriminator, CASH fields, manual-external-card
fields, the response shape (`payment`, `order`, `remainingBalance`), ETag,
real error statuses (400/401/403/404/409/422). No PCI field anywhere in the
schema. No fictional completion/integrated-terminal/refund/PaymentAttempt
route — `test/openapi.e2e-spec.ts`'s route-absence test was updated (not
weakened) to assert the real, single, exact Payment path now exists
alongside Fire, while re-scoping its forbidden-pattern list to precise
integrated-terminal/PaymentAttempt patterns (a bare `/payments?/` pattern
would now, correctly, no longer make sense as a "must never exist"
assertion).

**OPENAPI UPDATED.**

---

## R. MIGRATION-FROM-ZERO

`ros_p1f1_scratch`, a dedicated database distinct from the persistent
`ros` dev database, created via `createdb`. All 27 migrations (26 prior +
this slice's one) applied via `prisma migrate deploy` — clean, twice
(iterative development, then a fresh drop-and-recreate for final
acceptance). **Both `DATABASE_URL` and `APP_DATABASE_URL`** were set to the
scratch database throughout, per the P1E-6A-discovered requirement (the
application's own `PrismaService` reads `APP_DATABASE_URL`, a different
variable from the raw-migrator test client's `DATABASE_URL` — setting only
one silently splits the app and its test fixtures across two different
databases). The persistent `ros` database was never migrated: `prisma
migrate status` against it (default env, unset scratch overrides) confirms
the new migration is listed as **not yet applied** there, and a direct
query for `sales.order_payments` against `ros` returns `relation does not
exist` — proof, not assertion, that it was never touched. The scratch
database was dropped after the final successful verification run.

**MIGRATIONS FROM ZERO: YES (27). PERSISTENT DEV DB UNTOUCHED: YES.**

---

## S. FULL TEST RESULTS

| Check | Result |
|---|---|
| `nest build` | Clean |
| `eslint` on every changed file (excluding the 3 preserved user files) | Clean, zero warnings |
| `npx tsc --noEmit` | One pre-existing, unrelated baseline error (`access-token.service.spec.ts`, untouched by this session — confirmed via `git status` on that path); zero new errors after fixing one real arity bug this session introduced and found via `tsc` itself (§V) |
| `npx prisma format` / `validate` | Formatted cleanly (cosmetic realignment only, confirmed via `nest build`+`generate` afterward); schema valid |
| `git diff --check` | Clean, 0 whitespace conflicts |
| Unit suite | **718/718 passing** (708 pre-P1F-1 baseline + 10 new: 6 in `order-state.spec.ts`, 4 in `module-boundaries.spec.ts`) |
| Focused Payment e2e (`sales-payment.e2e-spec.ts`) | **46/46 passing** |
| Payment concurrency (`sales-payment-concurrency.e2e-spec.ts`) | **1/1 passing, run 9× total across the session, zero flakiness** |
| Regression sweep (Fire, Fire-concurrency, orders, order-lines, cash-session, Kitchen persistence/concurrency, domain-events, OpenAPI, + both Payment suites) | **298/298 passing, 12/12 suites** |
| **Full e2e suite, clean from-zero scratch DB, run #1** | 718/726 passing — 8 failures, all in the unrelated pre-existing `pin.e2e-spec.ts`, all "exceeded 5000ms hook timeout" (never an assertion failure) |
| `pin.e2e-spec.ts` re-run in isolation, same DB | **34/34 passing in 3.6s** — confirms the 8 failures above were transient resource-pressure flakiness from a 68-second `--runInBand` run of 34 bootstrapped app instances in one process, not a regression (Payment code has zero relation to PIN auth) |
| **Full e2e suite, clean from-zero scratch DB, run #2 (confirmation)** | **726/726 passing, 34/34 suites, 100% — zero failures** |

No skipped tests. No todo tests. Both full-suite clean-DB numbers are
reported exactly as observed, including the one transient run, rather than
only the clean one.

---

## T. REQUIREMENT CLASSIFICATION

| Requirement | Classification | Note |
|---|---|---|
| P1F-1 Payment persistence | **COMPLETE** | Append-only, RLS, tenant-safe FKs, all proven. |
| P1F-1 partial CASH capture | **COMPLETE for this slice** | |
| P1F-1 partial MANUAL_EXTERNAL_CARD capture | **COMPLETE for this slice** | |
| FR-POS-060 | **PARTIAL** | Only cash + manual external card exist; the SRS names eleven tenders. |
| FR-POS-061 | **PARTIAL** | The persistent multi-tender substrate and a derived running balance exist; the full split-bill/split-tender UX requirement (§8.4's broader scope) is not claimed complete, and final settlement is gated. |
| FR-POS-062 | **NOT IMPLEMENTED** | Bill-splitting (equal/seat/item/amount) was never in scope for this slice and nothing pre-existing implements it. |
| FR-POS-063 | **PARTIAL, evidence-based** | Change-due computation and cash-rounding application are proven for both rounding-enabled and rounding-disabled packs; the ledger recording is per-payment as required. Not claimed COMPLETE because FR-POS-063 also concerns split-payment display context (FR-POS-061), which is itself PARTIAL. |
| BR-FIN-004 | **PARTIAL, same discipline** | Cash-only rounding, distinct `rounding_adjustment`, never absorbed into revenue/tax — all proven for the implemented capture path; not a system-wide reconciliation claim (Day Close, X/Z reports do not exist). |
| BR-FIN-005 | **PARTIAL** | No Dart/client conformance runtime exists; the TypeScript side's rounding arithmetic is exact-integer and deterministic, but cross-language byte-identity cannot be verified without a Dart executor. |
| FR-POS-064 | **NOT IMPLEMENTED** | Integrated card lifecycle (terminal initiation, timeout, decline, partial approval, communication failure) — explicit non-goal. |
| FR-POS-065 | **COMPLETE for the supported ROS capture paths** | At-most-once financial effect proven via both the HTTP idempotency layer and the independent permanent-Payment-identity check, plus the deterministic concurrency proof. Does not extend to any claim about integrated-terminal ambiguity recovery, which does not exist. |
| FR-POS-066 | **COMPLETE for the supported manual-external-card path** | No PAN/CVV/track field exists on the schema or DTO at all; retained metadata is exactly the permitted list; a PCI-shaped extra field is rejected at the edge — proven. |
| FR-FIN-010 | **PARTIAL** | Truthful per-payment/per-session/per-tender attribution is persisted (the substrate FR-FIN-010 needs); the actual reporting/reconciliation surface (totals by tender, by session, by day) does not exist. |
| FR-POS-090 | **PARTIAL, globally; this route is fully gated** | The Payment route itself requires a resolved, OPEN, correctly-attributed CashSession before any capture proceeds — proven with 6 distinct negative cases (nonexistent, wrong employee/branch/terminal/currency, closed). Whether *every* "before processing sales" path in the wider system is gated is a broader claim this slice does not extend. |
| BR-POS-002 | **PRESERVED / gate implemented** | Full settlement is deliberately, atomically blocked (§L) until Completion exists — proven, not merely asserted. |
| §1.2 completed-sale atomicity | **NOT IMPLEMENTED** | Unchanged from before this slice; explicitly out of scope. |
| Order completion | **NOT IMPLEMENTED** | Non-goal (§28). |
| Inventory depletion on completed sale | **NOT IMPLEMENTED** | Non-goal. |
| Completion-time COGS | **NOT IMPLEMENTED** | Non-goal. |
| Receipt | **NOT IMPLEMENTED** | Non-goal. |

Slice completeness is never converted into a global requirement-completeness
claim anywhere above.

---

## U. FILES CHANGED

**New:**
`prisma/migrations/20260824100000_sales_order_payment_capture/migration.sql`,
`src/modules/sales/orders/payment.errors.ts`,
`src/modules/sales/orders/sales-payment.service.ts`,
`src/modules/treasury/contract/cash-session-facts.query.ts`,
`src/modules/treasury/contract/index.ts`,
`src/modules/treasury/cash-sessions/cash-session-facts.query.service.ts`,
`test/sales-payment.e2e-spec.ts`, `test/sales-payment-concurrency.e2e-spec.ts`.

**Modified:**
`prisma/schema.prisma` (OrderPaymentTender enum, OrderPayment model, 4
back-relations), `src/modules/sales/orders/order-state.ts` (new
`open -> partially_paid` transition, new `assertMayCapturePayment`),
`src/modules/sales/orders/order-state.spec.ts` (+6 tests),
`src/modules/sales/orders/orders.controller.ts` (new Payment route +
`requirePosIdentity`), `src/modules/sales/sales.dto.ts`
(`CapturePaymentDto`), `src/modules/sales/sales.module.ts` (TreasuryModule
import, `SalesPaymentService` provider), `src/modules/sales/sales.permissions.ts`
(`PAYMENT_CAPTURE`), `src/modules/sales/sales.views.ts` (`toPaymentView`,
`orderRemainingBalance`), `src/modules/treasury/treasury.module.ts`
(`CASH_SESSION_FACTS_QUERY` wiring), `src/modules/governance/audit/
audit.constants.ts` (`PAYMENT_CAPTURED`, `ORDER_PAYMENT`),
`src/modules/module-boundaries.spec.ts` (+4 tests), `test/sales.e2e-spec.ts`,
`test/cash-session.e2e-spec.ts`, `test/openapi.e2e-spec.ts` (all three:
route-whitelist/table-existence assertions updated from "Payment does not
exist" to "Payment exists, exactly here, and nowhere else" — the same
update pattern P1E-6 itself established for Fire), `docs/api/openapi.json`,
`docs/api/openapi.yaml` (regenerated, staged but not committed).

No file outside this list was modified. `order-lines.service.ts`,
`orders.service.ts`, `sales-fire.service.ts`, `idempotency.interceptor.ts`,
`idempotency.service.ts`, every P1E-6/P1E-6A-accepted file, and Treasury's
own `cash-sessions.service.ts`/`drawers.service.ts`/`treasury.controller.ts`
are confirmed untouched (verified by direct `git status`/`git diff`
inspection).

---

## V. A REAL BUG FOUND VIA `tsc --noEmit`, NOT `eslint`

Worth recording precisely: a test-authoring mistake (an extra positional
argument on `httpPay(...)`, from an earlier bulk find-and-replace during
test drafting) compiled and *ran* successfully under `ts-jest` — JavaScript
silently ignores an extra function argument at runtime — but was caught
immediately by a full-project `npx tsc --noEmit` (`error TS2554: Expected
5-6 arguments, but got 7`), which `eslint`'s own TypeScript rules did not
flag. Fixed by restoring the correct `.expect(201)` chain. This is the
concrete justification for running `tsc --noEmit` as its own explicit
verification step rather than treating a clean `eslint` + passing tests as
sufficient — exactly as this slice's own instructions required.

---

## W. P1F-1 EXIT

```
PAYMENT TABLE COMPLETE: YES
APPEND-ONLY ENFORCED: YES
CASH PARTIAL CAPTURE COMPLETE: YES
MANUAL EXTERNAL CARD PARTIAL CAPTURE COMPLETE: YES
PAYMENT ATTEMPT ABSENT FOR MVP TENDERS: YES
PAYMENT SESSION ATTRIBUTION COMPLETE: YES
CASH ROUNDING COMPLETE FOR IMPLEMENTED SEMANTICS: YES
IDEMPOTENCY COMPLETE FOR SUPPORTED PATH: YES
REAL CONCURRENCY PROOF: YES (9/9 runs, zero flakiness)
RLS COMPLETE: YES
AUDIT COMPLETE: YES
FULL-PAYMENT SAFETY GATE COMPLETE: YES
OPENAPI UPDATED: YES (133 operations, 3.1.0)
MIGRATIONS FROM ZERO: YES (27)
PERSISTENT DEV DB UNTOUCHED: YES
P1F-1 OVERALL: COMPLETE (for the explicit MVP scope defined in §1/§4; see §T for the full non-overclaiming breakdown)
COMMIT READY: NO — not evaluated; commit/push were explicitly out of scope for this task
COMMITTED: NO
PUSHED: NO
```

---

## X. NEXT

```
NEXT: P1F-2 — FINAL PAYMENT + ORDER COMPLETION ATOMIC ORCHESTRATION DESIGN/IMPLEMENTATION GATE
```

Not begun in this session. P1F-2 must deal explicitly with: `order.completed`,
inventory depletion, completion-time COGS, Treasury consequence, fiscal
consequence, audit, and the exact completion transaction boundary — and,
separately from P1F-2 itself, the still-open branch/checkpoint question
this and the prior P1E-6A report both already recorded (`feat/production-spec`
vs. the externally-renamed `main`) remains unresolved and out of scope here.

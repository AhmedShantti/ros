# P1G-0 — Mid-Shift Treasury Cash Movements Design Gate

**Report type:** Design/readiness gate (analysis only — no product code, no migration, no governance change, no D-21+, no commit, no push)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → repository evidence → accepted design reports**. **No governance is created or amended here; no D-21+ exists.** Where authority is silent this report says **NOT SOURCE-DECIDABLE** rather than filling the gap.
**Date:** 2026-08-28
**HEAD:** `bfe7e69` — `feat: complete P1F-2 atomic order completion` (verified unchanged)
**Branch:** `feat/production-spec`
**Working tree:** unchanged apart from this report and its `INDEX.md` row, plus the pre-existing intentionally-uncommitted unrelated reports. No product code touched.
**Task identifier:** P1G-0 cash-movements design gate

> ## VERDICT (§18)
> ## **B. P1G-0 DESIGN READY FOR FR-POS-091; FR-POS-092 REMAINS PARTIAL**
> FR-POS-091 [M] is **fully source-decidable and implementable now**: all three
> operations, their permissions (`cash.payin`, `cash.payout`, `cash.safedrop`),
> their mandatory `reason` and `amount`, and every attribution fact are either
> literal SRS text or already-trusted repository facts. FR-POS-092 [M] is **not**:
> **all four of its parameters are undecided** — drawer-limit source of truth,
> hierarchy level, default value, and prompt-vs-block policy — with **no monetary
> threshold anywhere in the SRS**, `Drawer` carrying no limit column, the country
> pack carrying no drawer limit, and `tenant.settings` being an **inert JSONB
> column never read by any service**. P1G-0 supplies its substrate (drawer cash
> becomes computable) but implements none of its clauses. **A material correction
> is also recorded (§17): my 2026-08-28 P1G-1 gate was WRONG on P-1.** The register
> **RATIFIED P-1 on 2026-08-18**; I mistook a retained analysis section for its
> conclusion. P1G-1's blocker is narrower than reported — it stands on D-16 and the
> absent mechanism, not on parent linkage.

---

## 0. SUBSTRATE VERIFIED AT `bfe7e69`

| Substrate | Finding |
|---|---|
| `treasury.cash_sessions` | `status` (`open`/`closed`), `opening_float`, `currency`, `branch_id`, `drawer_id`, `shift_id`, `employee_id`, tenant-safe composite FKs, `uq_one_open_session_per_drawer` |
| `CASH_SESSION_FACTS_QUERY` contract | **Already exists and returns exactly the facts this slice needs**: `cashSessionId, tenantId, branchId, employeeId, shiftId, drawerId, terminalId, currency, status` |
| `treasury.drawers` | `name`, `terminalId?`, `isActive`; branch-safe composites. **NO limit column.** |
| Cash movements | **ABSENT** — no model, table, or service |
| `tenant.settings` / `defaultSettings` | JSONB columns that **no service ever reads** (grep: zero hits) — inert |
| Idempotency | `common/idempotency/` interceptor + `@Idempotent` + `IdempotencyKey` model — reusable |
| UnitOfWork / events | `UnitOfWork.execute` + `ctx.publishEvent`, same-transaction, no outbox |
| Audit | `AuditService`, append-only, hash-chained, RLS-scoped |

---

## 1. REQUIREMENT SCOPE — LITERAL SRS FACT vs DESIGN IMPLICATION

**FR-POS-091 [M], verbatim:** *"The System SHALL support mid-shift cash operations: pay-in (adding cash to drawer), pay-out (removing cash for an expense), and safe drop (removing excess cash to the safe), **each with reason and amount**."*

| Element | Classification | Basis |
|---|---|---|
| Three operations: PAY_IN, PAY_OUT, SAFE_DROP | **LITERAL SRS FACT** | Enumerated verbatim; **no fourth type may be added** |
| **amount** | **LITERAL SRS FACT** | *"each with reason and amount"* |
| **reason** | **LITERAL SRS FACT** | Same clause — `reason` is **mandatory, NOT NULL**, for all three |
| PAY_IN adds to drawer; PAY_OUT removes for an expense; SAFE_DROP removes excess to the safe | **LITERAL SRS FACT** | Parenthetical definitions give each operation its direction |
| Active/open CashSession binding | **DESIGN IMPLICATION** (well-founded) | "mid-shift" + FR-FIN-001/002 (one open session per drawer, one employee) + FR-FIN-004 placing these terms inside the session's expected cash. Not a literal sentence. |
| Branch/drawer/session attribution | **DESIGN IMPLICATION**, inherited from ratified P1D-B/D/E/G | Payment-level attribution is already ratified as authoritative; movements follow the same discipline |
| Employee actor | **RATIFIED GOVERNANCE (P1D-E)** + FR-POS-007 [M] | The accountable actor is the **Employee**, not the identity User |
| Immutable financial record | **DESIGN IMPLICATION** from CR-04 / BR-POS-001 / ADR-010 posture | The SRS does not say "immutable" of these rows specifically; the repository's posted-financial discipline does |

**No additional movement types are introduced.** `cash.drawer.open_no_sale` exists as a *permission* in §15.2 but is a **different operation** (opening the drawer without a sale) and is **out of scope**.

---

## 2. MONEY EFFECT SEMANTICS

**Signed effect on Expected Cash (FR-FIN-004 [M] terms owned by this slice):**

```
PAY_IN     → + amount      (formula term "+ Pay-ins")
PAY_OUT    → − amount      (formula term "− Pay-outs")
SAFE_DROP  → − amount      (formula term "− Safe Drops")
```

**Client contract:** amount is a **positive integer in minor units**. The **type determines the sign**. A client-supplied negative value is rejected (`400`). **No floating point anywhere** — `BIGINT` minor units only, matching every money column in the repository.

### Storage choice: **A — positive amount + type**

Rejecting B (signed amount) and C (both):

- **Repository money convention is positive-magnitude + a type discriminator.** `OrderPayment.amount` is positive with `tender` as the discriminator. P1F-2's `sale_depletion_allocations.total_cost` is explicitly *"POSITIVE magnitude (repo convention, test-locked by `costing.spec.ts:184-186` — a deliberate §7.4.3 deviation)"*. `stock_movements.quantity` is signed, but that is a **quantity** convention, not a money one, and its own `total_cost` is positive.
- **CR-04 / immutability favours storing the declared fact.** The cashier declares "a pay-out of 500", not "−500". Storing the declaration verbatim and deriving the sign keeps the record isomorphic to what was actually asserted.
- **C (both) is redundant denormalisation** — two representations of one fact that can drift, with a CHECK needed to keep them in step. Rejected.
- A `CHECK (amount > 0)` is expressible under A and meaningless under B.

Sign is applied **once**, in the totals contract (§6), via a `CASE` on `movement_type`.

---

## 3. RECORD IDENTITY / IMMUTABILITY

### Client-generated ULID is **MANDATORY**, not optional — settled by authority

Two pieces of source evidence combine decisively:

1. **SRS §21.3's local data model** lists, among what the POS holds and syncs **Up / Continuous**: **"Shifts, cash sessions, drawer events"**. Cash movements are drawer events created on the device.
2. **FR-OFF-015 [M]**, verbatim: *"All entities created on a device SHALL receive a client-generated ULID as their **permanent primary key**. The server SHALL NOT reassign identifiers."*

Therefore **Idempotency-Key alone is NOT sufficient**. The permanent business identity is the **client-supplied ULID rendered as a UUID**, exactly as `OrderPayment` already does (P1F-1's `input.id ?? newId()` with a permanent-id replay check performed **first**).

### Defined behaviours

| Case | Behaviour |
|---|---|
| **Duplicate business id, identical immutable facts** | **Replay** — return the existing movement, no second financial effect (NFR-REL-011 [M] at-most-once) |
| **Duplicate business id, differing immutable facts** | **409 Conflict** — a client defect, never a silent overwrite |
| **Idempotency-Key replay, identical fingerprint** | Stored response returned with `Idempotent-Replay: true` (FR-API-022 [M]) — existing interceptor already does this |
| **Idempotency-Key, differing fingerprint** | **409** (FR-API-023 [M]) |
| **After create** | **Immutable.** `GRANT SELECT, INSERT` only; `UPDATE`/`DELETE`/`TRUNCATE` revoked; RLS SELECT+INSERT policies only |
| **Correction posture** | §12 — **NOT SOURCE-DECIDABLE**; no UPDATE/DELETE invented |

The permanent-id check must run **before** any other read or write, mirroring P1F-2's step 1 ordering, so a replay never performs partial work.

---

## 4. CASHSESSION / DRAWER VALIDATION

Every movement binds to an **OPEN** CashSession. The existing `CASH_SESSION_FACTS_QUERY` contract already returns every fact needed — **no new cross-module query is required**, and Treasury owns the session anyway.

**Enforced, all server-side, none client-supplied:** tenant (RLS + explicit), branch (must match the actor's PIN-session branch), drawer (via session), shift (via session), employee (session owner vs actor — below), currency (movement currency = session currency, snapshotted at open), **status = `open`** (asserted under lock, §10).

### Actor rules — narrowest safe interpretation, honestly classified

The SRS §15.2 Cash catalogue is:

```
cash.session.open          Open a shift
cash.session.close         Close own shift
cash.session.close_other   Close another user's shift
cash.drawer.open_no_sale   Open the drawer without a sale
cash.payin / cash.payout   Record cash in / out
cash.safedrop              Perform a safe drop
cash.variance.approve      Approve a variance beyond tolerance
cash.day.close             Close the business day
```

**The decisive observation:** the catalogue provides an explicit `_other` variant for **close** (`cash.session.close_other`, described as *"Close another user's shift"*) and provides **no `_other` variant for any cash movement**. Where the SRS wanted cross-actor authority it granted it by name.

- **Can a cashier post only to their own session?** **Yes — narrowest safe interpretation.** The actor's Employee must equal `cash_sessions.employee_id`.
- **Is posting to another employee's session permitted by any SRS permission?** **No such permission exists.** Not `cash.payin_other`, nothing equivalent.
- **Do the named permissions imply own-session only?** They do not *literally state* it. **Cross-session authorization is NOT SOURCE-DEFINED and is therefore NOT invented here.** Own-session-only is adopted as the narrowest safe reading, and is **classified as a design interpretation, not an SRS fact** — the asymmetry above is strong supporting evidence but not a literal statement.

If an operator later needs supervisor pay-outs on another cashier's drawer, that requires a **new SRS-absent permission** and is a governance question, not an implementation choice.

---

## 5. SAFE DROP / FR-POS-092 — THE UNRESOLVED PART

**FR-POS-092 [M], verbatim:** *"Safe drops SHALL be enforceable by a **configurable drawer limit** that triggers **a prompt or a block** when exceeded."*

| Sub-question | Finding |
|---|---|
| **A. Drawer-limit source of truth** | **NOT SOURCE-DECIDABLE.** `treasury.drawers` has **no limit column** (verified field-by-field). The country pack carries only `currency` (code, exponent) and `cashRounding` — **no drawer limit**. FR-PLT-025 [M]'s hierarchical settings resolver **does not exist**. `tenant.settings` / `defaultSettings` are JSONB columns **never read by any service** (grep: zero hits) — inert, with no precedence, no lockability, no resolver. |
| **B. Hierarchy level** | **NOT SOURCE-DECIDABLE.** "drawer limit" suggests drawer or branch; FR-PLT-025's precedence would decide, and it does not exist. |
| **C. Default value** | **NOT SOURCE-DECIDABLE — and must not be invented.** There is **no monetary threshold anywhere in the SRS**. Unlike FR-POS-095 [M], which explicitly states blind count is the default, FR-POS-092 states no default at all. |
| **D. Prompt vs block policy** | **NOT SOURCE-DECIDABLE.** The SRS says *"a prompt **or** a block"* and never says which, nor who chooses, nor whether the choice is itself configurable. A prompt is a **client** affordance; a block is a **server** refusal — they are not interchangeable and the requirement does not pick. |
| **E. What "triggers" means** | **NOT SOURCE-DECIDABLE.** Nothing states whether exceeding the limit merely surfaces a required action, blocks further cash sales, or auto-creates a SafeDrop. **Auto-creating a SafeDrop is explicitly not supported by any source** and would fabricate a financial record no human declared — the worst of the three readings. |

### Can FR-POS-091 be COMPLETE while FR-POS-092 is not?

**Yes, and the two are cleanly separable.** FR-POS-091 requires the three operations to exist "each with reason and amount" — none of which depends on a drawer limit. FR-POS-092 is an **enforcement layer** on top of an existing safe-drop capability. Building the operations without the enforcement satisfies FR-POS-091 in full and leaves FR-POS-092 untouched.

**Honest classification, stated precisely:** P1G-0 would leave FR-POS-092 **NOT IMPLEMENTED (substrate enabled)** — not PARTIAL. **Zero of its clauses would be met**: there is no configurable limit, no trigger, no prompt, no block. What P1G-0 *does* provide is the arithmetic substrate (current drawer cash becomes computable from `opening_float` + movements + cash payments), moving FR-POS-092 from "no substrate and no decision" to "substrate present, all four parameters still undecided". Verdict label **B** uses the word "PARTIAL" for the slice's coverage of the requirement pair; **this report does not claim any clause of FR-POS-092 is satisfied.**

**FR-POS-092 is therefore NOT a hard prerequisite of P1G-0** — but it **is** a hard prerequisite of *claiming FR-POS-092*, and it requires a user/governance decision on all four parameters (§18).

---

## 6. RELATION TO EXPECTED CASH

**P1G-0 does not compute Expected Cash and must not store `expected_cash` anywhere.** It creates immutable source facts for P1G-1 to consume.

**Source of truth: query the immutable `cash_movements` ledger directly. No maintained projection.**

Justification (one source of truth, per the brief's preference):
- The rows are **append-only and immutable**, so a derived total is **historically stable by construction** — the same reasoning that made tender totals derivable rather than snapshotted in the P1G-1 gate, and the mirror of why `posted_cogs_total` *is* stored (it summarises mutable-in-principle inventory state; this does not).
- A projection would introduce a second thing to keep in step, and BR-INV-003-style ledger/projection reconciliation debt, for a per-session row count in the low tens.
- Volume is trivially small; no performance argument exists.

**Proposed Treasury-internal contract** (module contract, **not** an HTTP route — no read permission exists, §8):

```ts
export const CASH_MOVEMENT_TOTALS_QUERY = Symbol('CASH_MOVEMENT_TOTALS_QUERY');

export interface CashMovementTotals {
  readonly cashSessionId: string;
  /** Positive minor-unit magnitudes, by declared type. */
  readonly payInTotal: bigint;
  readonly payOutTotal: bigint;
  readonly safeDropTotal: bigint;
  /** payIn − payOut − safeDrop. The signed contribution to FR-FIN-004. */
  readonly netCashMovementEffect: bigint;
}

export interface CashMovementTotalsQuery {
  totalsForSession(
    tx: Prisma.TransactionClient,   // tx-first, so P1G-1 reads under its own close lock
    tenantId: string,
    cashSessionId: string,
  ): Promise<CashMovementTotals>;
}
```

`tx`-first is essential: P1G-1's close must compute this **inside** its transaction while holding the session lock, so no movement can commit between the read and the close.

---

## 7. DOMAIN MODEL / MIGRATION (SHAPE ONLY — NOT CREATED)

A new Treasury-owned model **is** required; nothing existing fits. **Migration 31 is NOT created by this gate.**

### `treasury.cash_movement_type` enum
`pay_in`, `pay_out`, `safe_drop` — exactly three; no fourth value.

### `treasury.cash_movements`

| Field | Type / rule | Justification |
|---|---|---|
| `id` | `UUID` PK | **Client-generated ULID rendered as UUID** (FR-OFF-015 [M]); server never reassigns |
| `tenant_id` | `UUID NOT NULL` | RLS anchor |
| `branch_id` | `UUID NOT NULL` | **Denormalised deliberately** — needed for branch-safe attribution (§13 auth), the RLS/index path, and audit; reachable via session but required at the FK/index level |
| `cash_session_id` | `UUID NOT NULL` | The binding |
| `employee_id` | `UUID NOT NULL` | **P1D-E** accountable actor; own-session rule means this equals the session owner today, but recorded explicitly so the fact survives any future change |
| `movement_type` | enum `NOT NULL` | The sign discriminator (§2) |
| `amount` | `BIGINT NOT NULL`, `CHECK (amount > 0)` | Positive magnitude, minor units, no floating point |
| `currency` | `CHAR(3) NOT NULL` | Snapshot; CHECK-free but service-asserted equal to the session's |
| `reason` | `TEXT NOT NULL`, `CHECK (length(btrim(reason)) > 0)` | **FR-POS-091 [M] literal** — mandatory for all three types |
| `occurred_at` | `TIMESTAMPTZ NOT NULL` | Device-declared instant (offline-capable) |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | Server receipt instant |
| `performed_by` | `UUID NOT NULL` | Identity **User** who transmitted, distinct from `employee_id` — mirrors `stock_movements.performed_by` |

**Deliberately NOT denormalised:** `drawer_id`, `shift_id`. Both are reachable through `cash_session_id` and are **immutable on the session** (a session's drawer/shift binding never changes), so copying them would add drift surface for no integrity gain. This follows the brief's instruction to avoid denormalising safely-reachable immutable fields.

**Constraints / FKs (all tenant-safe composites):**
- `FK (tenant_id, cash_session_id) → treasury.cash_sessions(tenant_id, id)` RESTRICT
- `FK (tenant_id, branch_id) → org.branches(tenant_id, id)` RESTRICT
- `FK (tenant_id, employee_id) → workforce.employees(tenant_id, id)` RESTRICT
- `UNIQUE (tenant_id, id)` — composite target, repo convention
- Indexes: `(tenant_id, cash_session_id)` (the totals query's access path), `(tenant_id, branch_id, occurred_at)`

**Posture:** **append-only.** `GRANT SELECT, INSERT ON treasury.cash_movements TO ros_app; REVOKE UPDATE, DELETE, TRUNCATE ... FROM ros_app;` RLS `ENABLE` + `FORCE`, **SELECT and INSERT policies only**, `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` — byte-identical to the pattern P1F-2's `sale_depletion_effects` uses.

**No `expected_cash`, no drawer-limit column, no settings column** (§5, §6).

---

## 8. PERMISSION SEMANTICS

**SRS-named only. No new permission codes.**

| Route | Permission | SRS description |
|---|---|---|
| `POST /cash-sessions/{id}/pay-in` | `cash.payin` | *"Record cash in / out"* |
| `POST /cash-sessions/{id}/pay-out` | `cash.payout` | *"Record cash in / out"* |
| `POST /cash-sessions/{id}/safe-drop` | `cash.safedrop` | *"Perform a safe drop"* |

**No read route is proposed.** §15.2's Cash catalogue contains **no** movement-read permission, and `report.view.<category>`'s vocabulary is unenumerated (the same open-type-contract problem recorded for the X report). Inventing `cash.movement.read` / `cash.movement.manage` is forbidden and unnecessary — the totals contract (§6) is an **in-process module contract**, not an HTTP surface, so P1G-1 consumes it without any read permission existing.

---

## 9. API DESIGN

### Chosen: **three separate routes**, not one `/movements` with type in body

The decisive argument is **repository evidence, not taste**: this codebase authorises routes with a **static, route-level** `@RequirePermission(...)` decorator evaluated by a guard **before** the handler runs. A single `POST /movements` endpoint carrying `type` in the body **cannot** map to three distinct permissions without the guard inspecting the request body — which the existing `PermissionGuard` does not and should not do. Collapsing to one route would force either a single coarse permission (inventing one — forbidden) or body-dependent authorization (a new guard capability, and a security anti-pattern).

Three routes additionally give: 1:1 permission mapping, stable machine-readable semantics per operation, unambiguous audit/OpenAPI surface, and no room for a future fourth type to sneak in via an enum widening.

```
POST /cash-sessions/{sessionId}/pay-in     @RequirePermission(cash.payin)
POST /cash-sessions/{sessionId}/pay-out    @RequirePermission(cash.payout)
POST /cash-sessions/{sessionId}/safe-drop  @RequirePermission(cash.safedrop)

Headers: Authorization (PIN session), Idempotency-Key  ← REQUIRED on all three
Body:    { id?: string,            // client ULID-as-UUID; FR-OFF-015
           amountMinor: string,    // positive integer, minor units
           reason: string,         // non-empty, mandatory
           occurredAt?: string }   // ISO instant; device time
201:     { id, cashSessionId, movementType, amountMinor, currency, reason,
           occurredAt, employeeId }
400: non-positive amount / blank reason / malformed id
403: missing permission / not own session
404: session not visible under RLS
409: session not open · duplicate business id with differing facts · idempotency fingerprint mismatch
```

No `/v1` retrofit. Existing Nest error envelope — **no RFC 7807 claim**.

---

## 10. CONCURRENCY

**All three writers lock the `cash_sessions` row** (`SELECT … FOR UPDATE` on `(tenant_id, id)`) and assert `status = 'open'` **inside the same transaction** as the insert. This is what makes "no movement after close" enforceable rather than aspirational.

**Lock order:** `CashSession` → (nothing else). P1G-0 touches **only** Treasury. Since the P1F-2 chain is `CashSession → Order → Inventory`, a path that acquires only the **first** lock in that chain **cannot** invert it. No deadlock is introducible.

**Honest note for P1G-1:** the current Payment path reads session facts via `findUnique` and takes **no** session lock. That is safe today (nothing races it) but P1G-1's close **must** lock, and Payment must then assert `status='open'` under that lock. P1G-0 establishes the locking convention; **closing that gap belongs to P1G-1**, not here, and is recorded so it is not forgotten.

| Race | Outcome |
|---|---|
| Two simultaneous PAY_INs | Serialized by the session lock; both commit; totals sum exactly; no lost update |
| PAY_IN vs PAY_OUT | Serialized; both commit; net effect exact |
| SAFE_DROP vs Payment | Both commit (Payment takes no session lock today); totals remain exact because each is an independent append. No shared mutable counter exists — this is precisely why an append-only ledger beats a maintained projection (§6) |
| Movement vs future session close | The close (P1G-1) will hold the session lock; a movement arriving after close finds `status='closed'` under lock → deterministic **409** |
| Duplicate business id | Permanent-id check first → replay or 409; **never** a second financial effect |
| Idempotent HTTP replay | Existing interceptor returns the stored response with `Idempotent-Replay: true` |

**Required real-PostgreSQL concurrency tests** (real barriers, no sleeps as proof, ≥3 clean runs each) are listed in §14.

---

## 11. AUDIT / EVENTS

**Audit — one action, following the established repository precedent.** `MovementsService` records a single `STOCK_MOVEMENT_RECORDED` action with `movementType` in the metadata rather than three separate actions. P1G-0 mirrors that exactly:

**`CASH_MOVEMENT_RECORDED`**, entity type `CASH_MOVEMENT`, entity id = the movement id, metadata:
`movementType`, `cashSessionId`, `drawerId`, `branchId`, `employeeId` (accountable actor), `amountMinor`, `currency`, `reason`, `occurredAt`.

`reason` is operator-entered free text — it is business content, not a secret, and `sanitizeMetadata`'s `FORBIDDEN_KEY` pattern does not match any of these key names. **No secrets are logged.**

**Events: NONE.** The SRS event catalogue (§5.5.4) contains `shift.opened` / `shift.closed` (Workforce), `cash.variance.detected` (Treasury → Governance, Analytics), and `day.closed` (Treasury) — **and no cash-movement event**. Per the brief, **no event is invented**. `cash.variance.detected` belongs to P1G-1, not here.

---

## 12. REVERSAL / CORRECTION

**NOT SOURCE-DECIDABLE.**

- The SRS defines **no** correction permission or movement type for cash movements. §15.2's Cash catalogue has no `cash.movement.reverse`, `cash.adjust`, or equivalent.
- **No `UPDATE` or `DELETE` is invented**; the table is append-only by grant and by RLS policy.
- **A compensating movement of the same vocabulary is NOT silently adopted.** Recording a PAY_IN to cancel an erroneous PAY_OUT would **falsify both the type and the reason**: it asserts that cash was physically added to the drawer, which did not happen. That is exactly the falsification the brief forbids, and it would corrupt the FR-FIN-004 terms P1G-0 exists to supply.
- Note the tension with **FR-FIN-007 [M]** (*"Corrections SHALL be recorded as adjusting entries referencing the session"*), which speaks of **sessions**, not movements, and whose own authorization code is likewise unnamed (recorded in the P1G-1 gate).

**Recorded as an open item.** P1G-0 ships with no correction path; an erroneous movement stands as an immutable fact until authority defines a correction vocabulary.

---

## 13. OFFLINE

**Cash movements ARE within POS offline scope** — settled by source, not inferred:

- **§21.3 local data model** lists **"Shifts, cash sessions, drawer events — Up — Continuous"** among what the POS holds and syncs.
- **FR-OFF-015 [M]:** device-created entities take a **client-generated ULID as their permanent primary key**; the server **SHALL NOT** reassign it.
- **FR-OFF-021 [M]:** every operation carries an idempotency key.
- **FR-OFF-003 [M]:** 72-hour isolated operation (scoped in its own text to *"sales capture"*, so it does not by itself extend to cash ops — §21.3 is the operative evidence).

**Server-side substrate P1G-0 must provide NOW:** accept a client-supplied permanent id, enforce at-most-once on it (replay vs 409), and require `Idempotency-Key`. That is the whole of the server obligation.

**Explicitly NOT in this slice:** the sync engine, batching, causal ordering, per-operation accept/duplicate/reject responses, and the outbox (FR-OFF-020…024). Those remain **client/sync work**, unimplemented repository-wide, and P1G-0 neither builds nor claims them.

---

## 14. TEST MATRIX (pre-acceptance)

**DOMAIN** — positive amount enforced (0 and negative rejected at DTO and DB CHECK); blank/whitespace reason rejected; exact sign semantics per type in the totals contract; currency equals session currency; record immutable after create.

**AUTH** — each of the three permissions authorises exactly its own route and no other; missing permission → 403; **own-session rule**: actor Employee ≠ session owner → 403; wrong branch (session in another branch than the PIN-session context) → 403; cross-tenant session → 404 (invisible under RLS, never 403); closed session → 409.

**IDEMPOTENCY** — same key + same body → stored response, `Idempotent-Replay: true`, exactly one row; same key + different body → 409; duplicate business id + identical facts → replay, exactly one row, exactly one audit entry; duplicate business id + differing facts → 409.

**RLS** (via the real `ros_app` connection, never the migrator) — own-tenant SELECT succeeds; cross-tenant SELECT returns zero rows with tenant B holding its own real row (a genuine filtering proof); `UPDATE` rejected and row survives unmodified; `DELETE` rejected and row survives; `information_schema.role_table_grants` shows SELECT+INSERT and **not** UPDATE/DELETE/TRUNCATE.

**CONCURRENCY** (real Postgres, barriers, no sleeps as proof, ≥3 clean runs) — two simultaneous PAY_INs on one session; PAY_IN vs PAY_OUT; SAFE_DROP vs a settling Payment on the same session; movement attempted against a session closed concurrently → deterministic 409; duplicate business id raced → exactly one row.

**EXPECTED-CASH SUBSTRATE** — grouped totals by session and type match the immutable ledger exactly (`payIn − payOut − safeDrop == netCashMovementEffect`), across a mixed sequence, computed under a transaction.

**SAFE DROP** — only the *operation* is tested (it is an ordinary movement). **No drawer-limit tests exist**, because FR-POS-092 is not implemented (§5).

---

## 15. REQUIREMENT CLASSIFICATION

| Req | Now | P1G-0 implements | Remains | After |
|---|---|---|---|---|
| **FR-POS-091** [M] | NOT IMPLEMENTED | all three operations, each with mandatory reason + amount, immutable, attributed | — | **COMPLETE** |
| **FR-POS-092** [M] | NOT IMPLEMENTED | nothing (substrate only) | limit source/level/default/policy — all four undecided | **NOT IMPLEMENTED (substrate enabled)** |
| **FR-FIN-004** [M] | PARTIAL (3/8 terms) | terms **Pay-ins, Pay-outs, Safe Drops** → 6/8 | **Cash Tips** (FR-POS-056/057 are [S], no operation), **Cash Refunds** (non-goal) | **PARTIAL — explicitly NOT complete** |
| **FR-API-020** [M] | PARTIAL (few routes) | +3 financially-significant routes with mandatory key | the remaining mutating routes | **PARTIAL** |
| **FR-API-021** [M] | IMPLEMENTED for covered routes | reuses existing store (key, fingerprint, response) | 30-day retention policy unverified | **IMPLEMENTED for covered routes** |
| **FR-API-022** [M] | IMPLEMENTED for covered routes | replay with `Idempotent-Replay: true` | — | **IMPLEMENTED for covered routes** |
| **FR-API-023** [M] | IMPLEMENTED for covered routes | 409 on fingerprint mismatch | — | **IMPLEMENTED for covered routes** |
| **NFR-REL-011** [M] | Held for Order/Payment | at-most-once via permanent id **and** idempotency key | system-wide claim still not general | **HELD for this slice's operations** |

**FR-FIN-004 is explicitly NOT claimed COMPLETE.** P1G-0 supplies three of its five missing terms; two remain structurally unavailable.

---

## 16. P1G-1 DEPENDENCY CONTRACT

P1G-0 guarantees to P1G-1:

1. **An immutable, append-only cash-movement ledger** — DB-enforced (grants + RLS policies), not convention.
2. **Movement totals by session and type**, via a `tx`-first in-process contract (`CASH_MOVEMENT_TOTALS_QUERY`), computable **inside** the close transaction under the close's own session lock.
3. **Atomic serialization against `CashSession`** — every writer holds the session row lock and asserts `status='open'`, so P1G-1's close observes a stable set.
4. **No mutation after session close** — a movement against a closed session is a deterministic 409, enforced under lock.
5. **Exact minor-unit integer arithmetic** — `BIGINT` throughout, positive magnitudes + type discriminator, no floating point, sign applied once in the contract.
6. **Trusted actor/session attribution** — Employee (P1D-E), branch, drawer, shift, currency, all server-derived from the PIN session and the session row, never client-supplied.
7. **Permanent business identity** (client ULID) with at-most-once semantics, so offline replay cannot double-count expected cash.

**P1G-1 itself is not designed here.**

---

## 17. GOVERNANCE CONSISTENCY CHECK — P-1

### Classification: **P-1 RATIFIED / RETAINED**

**The register is NOT internally contradictory.** It uses a standard *analysis-then-ratification* structure, and my earlier reading was wrong.

**Exact current register text (quoted verbatim):**

- Heading, line 4376: **`## PL — approval_decisions → Parent Linkage (carried item — RATIFIED)`**
- Line 4378–4381:
  > **STATUS: RATIFIED 2026-08-18 — P-1: `approval_decisions` REFERENCES `approval_requests` DIRECTLY.** See the **Ratification** block at the end of this item for the binding text. The analysis below is retained as the record of what was considered; **P-2 was considered and NOT adopted**, and **P-3 / P-4 were not adopted**.
- Line 4604–4606:
  > `### RATIFICATION — PARENT LINKAGE (2026-08-18)`
  > **RATIFIED — P-1: `approval_decisions` SHALL REFERENCE `approval_requests` DIRECTLY.**
- Line 4635: *"**P-1 is an ARCHITECTURAL CHOICE**, **not** a claim that the SRS mandates direct linkage."*
- Line 4663 (a later entry): *"**D-16 remains OPEN and untouched** … **D-12 remains BLOCKED. Parent linkage P-1 is RATIFIED and not reopened.**"*
- Line 5893: *"**PARENT LINKAGE — RATIFIED 2026-08-18 — P-1: `approval_decisions` references …**"*

### The error being corrected

My `2026-08-28_P1G1_cash-close-design-gate.md` quoted line 4562 — *"NO SOURCE-SUPPORTED RECOMMENDATION between P-1 and P-2"* — **as if it were the register's conclusion**. It is not. It sits inside the **analysis** section, which the register itself labels *"retained as the record of what was considered"*, and its very next sentences call for the question to *"be settled as an ARCHITECTURAL RATIFICATION"* — **which then happens 44 lines later at line 4606.** I read the problem statement as the answer. **The P1G-1 gate's §3.1 "correction to the brief's premise" was itself the error; the brief was right and I was wrong.**

### Consequence (informational only — not fixed here)

P1G-1's verdict **C (BLOCKED)** does **not** collapse, but its grounds are **narrower** than reported. Surviving, re-verified blockers:

- **D-16 remains OPEN** on the `request_type` contract — explicitly reaffirmed *after* the P-1 ratification (line 4663), and a cash-variance request needs a `request_type` value.
- **The approval mechanism does not exist at all** — no `approval_requests`/`approval_decisions` table, migration, or service (re-verified at `bfe7e69`).
- **Endpoint classification stands** — "Create approval request" = **C + E on D-16**.
- **SB-1 / SB-3 remain UNRESOLVED** (`required_permission` representation; DELETE posture), and line 4894 records that **P-1's ratification COUPLED** further sub-questions with **"NO OPTION SELECTED"** among DP-1…DP-4.

**Falsified ground:** parent linkage. It is settled.

**Recommendation (not performed):** a narrow correction pass on the P1G-1 report to strike its §3.1 and restate the blocker on D-16 + absent-mechanism + SB residuals. **Per this brief, the register is not touched and the P1G-1 report is not edited in this task.**

---

## 18. FINAL VERDICT

# **B. P1G-0 DESIGN READY FOR FR-POS-091; FR-POS-092 REMAINS PARTIAL**

*(With the §5 precision: FR-POS-092 would be **NOT IMPLEMENTED (substrate enabled)**; no clause of it is claimed.)*

**Minimum decisions required before FR-POS-092 can be implemented** (none block P1G-0 itself):
1. Drawer-limit **source of truth and hierarchy level** — a Treasury column, or FR-PLT-025 settings (which do not exist).
2. Drawer-limit **default value** — no SRS threshold exists; must not be invented.
3. **Prompt vs block** policy, and whether that choice is itself configurable.
4. What "**triggers**" means operationally — surface a required action, block further cash sales, or something else. Auto-creating a SafeDrop is **not** source-supported.

**Also NOT SOURCE-DECIDABLE (recorded, not invented):** cash-movement correction/reversal vocabulary (§12); cross-session movement authorization (§4).

---

## 19. SONNET IMPLEMENTATION PROMPT

```
# ROS — P1G-0
# MID-SHIFT TREASURY CASH MOVEMENTS (PAY_IN / PAY_OUT / SAFE_DROP)
# MODEL: CLAUDE SONNET 5
#
# IMPLEMENTATION TASK. The design is SETTLED by
# docs/reports/claude/2026-08-28_P1G0_cash-movements-design-gate.md (CONTROLLING).
# Do not redesign. Do not re-litigate. If the design and the code disagree, STOP and report.
#
# AUTHORITY (in order):
#   ROS_SRS_v1.0.pdf  >  docs/governance/GOVERNANCE_DECISION_REGISTER.md
#   >  docs/reports/claude/2026-08-28_P1G0_cash-movements-design-gate.md  >  repository code

====================== A. REPOSITORY SAFETY ======================
Expected branch: feat/production-spec.  Expected HEAD: bfe7e69 (verify, do not assume).
Baseline: 30 migrations · OpenAPI 3.1.0 / 135 operations.
NEVER USE: git stash/reset/checkout/restore/clean/rebase/commit --amend/push --force.
NO branch operation. DO NOT COMMIT. DO NOT PUSH.
DO NOT TOUCH: .gitignore · src/main.ts · src/scripts/seed-dev-data.ts
NEVER migrate the persistent local `ros` DB. Use a disposable scratch DB and set BOTH
DATABASE_URL and APP_DATABASE_URL (the app reads APP_DATABASE_URL).

====================== B. MIGRATION 31 (TREASURY, THE ONLY ONE) ======================
CREATE TYPE treasury."CashMovementType" AS ENUM ('pay_in','pay_out','safe_drop');  -- exactly 3

CREATE TABLE treasury.cash_movements (
  id UUID PK,                       -- CLIENT-GENERATED ULID-as-UUID (FR-OFF-015). Never reassigned.
  tenant_id UUID NOT NULL,
  branch_id UUID NOT NULL,          -- deliberate denormalisation: branch-safe auth + index + audit
  cash_session_id UUID NOT NULL,
  employee_id UUID NOT NULL,        -- P1D-E accountable actor
  movement_type treasury."CashMovementType" NOT NULL,
  amount BIGINT NOT NULL,           -- POSITIVE magnitude, minor units
  currency CHAR(3) NOT NULL,
  reason TEXT NOT NULL,             -- FR-POS-091 [M]: mandatory for ALL THREE types
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  performed_by UUID NOT NULL        -- identity User (mirrors stock_movements.performed_by)
);
CHECKs: ck_cash_movement_amount_positive (amount > 0);
        ck_cash_movement_reason_present  (length(btrim(reason)) > 0)
UNIQUE (tenant_id, id)
FKs (ALL tenant-safe composites, RESTRICT):
  (tenant_id, cash_session_id) -> treasury.cash_sessions(tenant_id, id)
  (tenant_id, branch_id)       -> org.branches(tenant_id, id)
  (tenant_id, employee_id)     -> workforce.employees(tenant_id, id)
INDEX (tenant_id, cash_session_id); INDEX (tenant_id, branch_id, occurred_at)
GRANT SELECT, INSERT TO ros_app;  REVOKE UPDATE, DELETE, TRUNCATE FROM ros_app;
RLS ENABLE + FORCE; SELECT and INSERT policies ONLY, tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid
DO NOT add: drawer_id, shift_id (reachable + immutable via the session), expected_cash,
            any drawer-limit column, any settings column.
Update prisma/schema.prisma to match exactly (new enum, new model, back-relations).

====================== C. SERVICE ======================
New treasury/cash-movements/cash-movements.service.ts. For each movement, IN ONE TRANSACTION:
 1. PERMANENT-ID REPLAY CHECK FIRST (before any other read/write), on (tenant_id, id):
      identical immutable facts -> REPLAY the existing row, zero new effect
      differing facts           -> 409 (typed domain error)
    Use INSERT ... ON CONFLICT DO NOTHING RETURNING, never insert-catch-P2002 (P1E-5A).
 2. SELECT ... FOR UPDATE the cash_sessions row on (tenant_id, id).
 3. Assert: status='open' (else 409); session.branch_id == actor's PIN-session branch (else 403);
    session.employee_id == actor Employee (else 403 — OWN-SESSION ONLY; no _other permission exists);
    movement currency == session.currency.
 4. INSERT the movement (amount POSITIVE; type carries the sign).
 5. Audit: ONE action CASH_MOVEMENT_RECORDED, entity CASH_MOVEMENT, entity id = movement id,
    metadata {movementType, cashSessionId, drawerId, branchId, employeeId, amountMinor,
              currency, reason, occurredAt}.
    (Follows the STOCK_MOVEMENT_RECORDED precedent: one action, type in metadata.)
 6. PUBLISH NO DOMAIN EVENT. The SRS event catalogue defines no cash-movement event. Do not invent one.

====================== D. CONTRACT FOR P1G-1 ======================
New treasury/contract/cash-movement-totals.query.ts — interface + Symbol ONLY (contract/ is
interface-only; implementation lives outside it, bound by useExisting):
  CASH_MOVEMENT_TOTALS_QUERY
  totalsForSession(tx, tenantId, cashSessionId)
    -> { cashSessionId, payInTotal, payOutTotal, safeDropTotal, netCashMovementEffect }
  netCashMovementEffect = payInTotal - payOutTotal - safeDropTotal   (exact BigInt)
tx-FIRST so P1G-1 can read under its own close lock. NO HTTP route for it.
Query the immutable ledger directly — DO NOT build or maintain a projection.

====================== E. API ======================
THREE routes on the existing TreasuryController (1:1 permission mapping; a single
/movements route is REJECTED because @RequirePermission is route-level static and must
not inspect the body):
  POST /cash-sessions/{sessionId}/pay-in     @RequirePermission(cash.payin)
  POST /cash-sessions/{sessionId}/pay-out    @RequirePermission(cash.payout)
  POST /cash-sessions/{sessionId}/safe-drop  @RequirePermission(cash.safedrop)
Add these THREE SRS-named permission codes to treasury.permissions.ts. INVENT NO PERMISSION.
NO GET/read route (no source-backed read permission exists).
Idempotency-Key REQUIRED on all three (existing @Idempotent interceptor).
Body { id?, amountMinor, reason, occurredAt? }. amountMinor positive integer minor units;
reason non-empty. Client CANNOT send a negative amount; the TYPE decides the sign.
Status codes exactly as the design gate §9 lists. No /v1. No RFC7807 claim.
OpenAPI must go 135 -> 138 operations, still 3.1.0, zero other drift.

====================== F. SCOPE FENCE — DO NOT BUILD ======================
NO CashSession close, count, denominations, variance, approval, X report, Day close.
NO drawer limit / FR-POS-092 (all four of its parameters are undecided — gate §5).
NO expected_cash storage or computation. NO settings resolver. NO sync/outbox.
NO correction/reversal/UPDATE/DELETE path (NOT SOURCE-DECIDABLE — gate §12).
NO fourth movement type. NO cash.drawer.open_no_sale.

====================== G. TESTS (all required, real PostgreSQL) ======================
DOMAIN: amount 0 and negative rejected (DTO + DB CHECK); blank/whitespace reason rejected;
  sign semantics exact in the totals contract; currency must equal the session's.
AUTH: each permission authorises only its own route; missing permission 403; actor Employee
  != session owner 403; wrong branch 403; cross-tenant 404 (RLS-invisible, NOT 403); closed session 409.
IDEMPOTENCY: same key+body -> stored response + Idempotent-Replay: true, exactly one row;
  same key+different body -> 409; duplicate business id identical facts -> replay, exactly one
  row AND exactly one audit entry; duplicate id differing facts -> 409.
RLS (via the REAL ros_app connection, app.get(PrismaService), never the migrator):
  own-tenant SELECT ok; cross-tenant SELECT zero rows WITH tenant B holding its own real row;
  UPDATE rejected + row survives unmodified; DELETE rejected + row survives;
  information_schema.role_table_grants shows SELECT+INSERT and NOT UPDATE/DELETE/TRUNCATE.
CONCURRENCY (real barriers, NO sleeps as the proof, >=3 clean runs each):
  two simultaneous PAY_INs; PAY_IN vs PAY_OUT; SAFE_DROP vs a settling Payment on the same
  session; movement vs a session closed concurrently -> deterministic 409; duplicate business
  id raced -> exactly one row.
SUBSTRATE: grouped totals match the ledger exactly over a mixed sequence, read inside a tx.
MODULE BOUNDARIES: contract/ is interface-only; impl outside it; KNOWN_DEVIATIONS MUST NOT GROW.

====================== H. BUILD / VERIFY ======================
npx tsc --noEmit (only the known access-token.service.spec.ts baseline error may remain — ZERO new)
eslint changed files · npx prisma validate · npm run build · git diff --check
npm run openapi:check -> 3.1.0 and EXACTLY 138 operations
Clean FROM-ZERO scratch DB: 31 migrations apply; drop it after; PROVE the persistent `ros`
  dev DB was never migrated (it must stay at its current _prisma_migrations row count).
Full unit suite + full E2E suite green; report EXACT counts.
DO NOT COMMIT. DO NOT PUSH.

====================== I. REPORT ======================
Write docs/reports/claude/<YYYY-MM-DD>_P1G0_cash-movements.md with the required ROS header.
Classify honestly: FR-POS-091 COMPLETE · FR-POS-092 NOT IMPLEMENTED (substrate enabled) ·
FR-FIN-004 PARTIAL (6/8 terms; tips and refunds have no operations — DO NOT claim COMPLETE) ·
FR-API-020 PARTIAL · FR-API-021/022/023 IMPLEMENTED for covered routes · NFR-REL-011 HELD for
this slice. Record corrections/reversals as NOT SOURCE-DECIDABLE. Update INDEX.md.
```

---

## Update to INDEX.md

Appended (see `docs/reports/claude/INDEX.md`).

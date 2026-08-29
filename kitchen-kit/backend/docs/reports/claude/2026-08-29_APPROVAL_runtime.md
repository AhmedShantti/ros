# Governance Approval Runtime — Implementation

**Report type:** Implementation report (migration, production code, tests, verification evidence).
**Authority statement:** This report is **non-authoritative evidence**. Authority order: **(1) `ROS_SRS_v1.0.pdf` → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md`, specifically the "Approval Runtime Minimum Resolution — 2026-08-29" ratification → (3) the repository at HEAD `55e4ae8` → (4) `docs/reports/claude/2026-08-29_APPROVAL_runtime-final-design-gate.md`, corrected by `docs/reports/claude/2026-08-29_APPROVAL_runtime-design-acceptance-closure.md` (CONTROLLING over the earlier gate where they differ) → (5) engineering inference only where authority is silent.**
**Date:** 2026-08-29
**Starting HEAD:** `55e4ae8` — *feat: add mid-shift treasury cash movements* (unchanged throughout — no commit performed)
**Branch:** `feat/production-spec`
**Working tree at start:** the working tree carried the uncommitted "Approval Runtime Minimum Resolution — 2026-08-29" governance ratification (263 insertions, 0 deletions to the register) plus five prior-phase analysis reports, all preserved untouched by this task.
**Working tree at report time:** the above, plus one new migration, one new Governance sub-module, one new Governance contract, one new Identity contract, five modified files, one new test file, one modified test file, and this report. **Nothing committed, nothing pushed.**
**Task identifier:** Governance Approval runtime implementation (migration 32)

> ## VERDICT
> ## **A. APPROVAL RUNTIME IMPLEMENTATION COMPLETE**
>
> The shared Governance Approval runtime (FR-SEC-030..033) is implemented
> exactly to the corrected design (final design gate + acceptance closure),
> with **one genuine implementation defect found and fixed** by the
> mandatory real-Postgres concurrency tests themselves — precisely the
> discipline those tests exist to enforce. Migration **32** applied cleanly
> from a fresh scratch DB; the persistent local `ros` DB was **never**
> touched (still 26 `_prisma_migrations` rows, newest
> `20260823030000_kitchen_ticket_persistence`). OpenAPI regeneration is
> **byte-identical** — `3.1.0 / 138`, unchanged — confirming no accidental
> Governance HTTP route was introduced. Full regression: **746/746 unit,
> 877/877 e2e**, zero regressions, including a dedicated PIN/auth
> regression check. Final verdict is reported as **COMPLETE**, not
> **FINAL ACCEPTED** — that determination is made outside this session
> after report review, per the executing prompt's own instruction.

---

## A. WHAT WAS BUILT

### A.1 Migration 32 — `governance.approval_requests` / `governance.approval_decisions`

`prisma/migrations/20260829010000_governance_approval_runtime/migration.sql` — Governance-owned only; no Inventory/Sales/Treasury object touched.

**`approval_requests`**: `id UUID PK` (client-generated permanent id), `tenant_id`, `request_type VARCHAR(32)` (no CHECK — D-16's enumeration stays OPEN), `entity_type VARCHAR(48)`, `entity_id UUID` (no FK — polymorphic), `requested_by UUID` (no FK — see §C), `required_permission VARCHAR(64)` (no FK — SB-1 RESOLVED), `value JSONB NOT NULL` (opaque carrier — SB-2 RESOLVED), `expires_at TIMESTAMPTZ` (mandatory, immutable), `excluded_approver_user_id UUID NULL` (item 8, generic name, no FK), `status VARCHAR(16) DEFAULT 'pending'` (the **only** mutable column), `created_at`. `CHECK status IN ('pending','approved','rejected')`; `CHECK` non-blank on `request_type`/`required_permission`; `UNIQUE (tenant_id, id)`.

**`approval_decisions`**: `id UUID PK`, `tenant_id`, `approval_request_id` (P-1 direct composite FK to `approval_requests(tenant_id, id)`, `ON DELETE RESTRICT`), `approver_id UUID` (no FK), `decision VARCHAR(16)` (`CHECK IN ('approved','rejected')`), `comment TEXT NULL`, `decided_at TIMESTAMPTZ DEFAULT statement_timestamp()`, `created_at`. **`UNIQUE (tenant_id, approval_request_id)`** — the one-final-decision invariant (item 5, the narrow ratified amendment of D-15 clause 4 via clause 14).

**Grants** (D-6 Model B + Mechanism 1, the Production GAP-2 three-line form for requests):
```sql
GRANT SELECT, INSERT ON governance.approval_requests TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON governance.approval_requests FROM ros_app;
GRANT UPDATE ("status") ON governance.approval_requests TO ros_app;
```
For decisions, a **column-level `GRANT INSERT`** that deliberately omits `decided_at`/`created_at`:
```sql
GRANT SELECT ON governance.approval_decisions TO ros_app;
GRANT INSERT ("id","tenant_id","approval_request_id","approver_id","decision","comment")
  ON governance.approval_decisions TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON governance.approval_decisions FROM ros_app;
```
**Empirically verified** (against a real scratch DB, before any application code was written): `ros_app` genuinely cannot supply `decided_at` — an explicit attempt fails with `permission denied for table approval_decisions`.

**RLS** — both tables `ENABLE`+`FORCE`; tenant-scoped SELECT; requests' INSERT requires `status='pending'`; requests' UPDATE is **D-9 U4 reproduced exactly** (`USING (T AND status='pending')` / `WITH CHECK (T AND status IN ('approved','rejected'))`); decisions' INSERT carries the **four-conjunct** `WITH CHECK`:
```sql
WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  AND NOT EXISTS (
    SELECT 1 FROM governance.approval_requests r
    WHERE r.tenant_id = approval_decisions.tenant_id
      AND r.id        = approval_decisions.approval_request_id
      AND (    r.requested_by              = approval_decisions.approver_id
            OR r.expires_at                <  statement_timestamp()
            OR r.excluded_approver_user_id = approval_decisions.approver_id )
  )
)
```
No UPDATE/DELETE policy on decisions (fully append-only, D-8). **`status = 'pending'` deliberately absent as a fifth conjunct** — D-15 clause 9 forbids it there; the compare-and-set lives on the requests UPDATE policy instead, exactly as ratified.

### A.2 Identity's first public contract

`src/modules/identity/contract/{pin-verification.contract.ts,index.ts}` — `TERMINAL_PIN_VERIFIER` token, `TerminalPinVerifier.verifyTerminalPin(input): Promise<VerifiedTerminalPrincipal>`. Deliberately **not** `tx`-first (PIN verification manages its own transaction(s), and must run **before** any consuming module's business transaction — nested `withAuthContext` is unsupported, and lockout must survive a caller rollback). `VerifiedTerminalPrincipal` carries `{userId, employeeId, membershipId, branchId, terminalId, permissions: ReadonlySet<string>}` and is **branded** via a non-exported, ambient `unique symbol` — no plain object literal can satisfy it; even Identity's own implementation must cast (`as unknown as VerifiedTerminalPrincipal`).

`src/modules/identity/employees/pin.service.ts` gained `verifyTerminalPin()`, implementing the contract by calling the **existing, unmodified** `authenticate()` for the entire verification path (terminal/employee/branch/hash/lockout/membership — zero duplication), then resolving the SAME membership's effective permission codes via the identical `membershipRoles → role → rolePermissions → permission.code` shape `TenantContextService.resolve` uses. `authenticate()` itself is **byte-unchanged**; a dedicated PIN/auth regression pass (§F.2) confirms this.

### A.3 Governance's public contract and private implementation

`src/modules/governance/contract/{approval.contract.ts,approval.errors.ts,index.ts}` — `APPROVAL_COMMANDS` token; `ApprovalCommands.createRequest(tx, tenantId, requestedByUserId, command)` and `.decide(tx, tenantId, command)`, both `tx`-first. `tenantId`/actor id are **trusted positional arguments**, never fields inside the command payload — mirroring `CashMovementsService.record(tenantId, actorUserId, input)` exactly. `value: Prisma.InputJsonValue` (write) / `Prisma.JsonValue` (read) — the generic Prisma JSON type, never a Governance-owned shape. Six typed errors (`ApprovalRequestConflictError`, `ApprovalDecisionConflictError`, `ApprovalNotPendingError`, `ApproverNotPermittedError`, `ApprovalDecisionRejectedError`), following `inventory/contract/sale-depletion.errors.ts`'s `class X extends Error { readonly code = '...' }` form.

`src/modules/governance/approvals/approvals.service.ts` — **private**, bound to `APPROVAL_COMMANDS` only inside `GovernanceModule` via `useExisting`. Implements the full permanent-id / zero-row / RLS-rejection protocol (§B). `src/modules/governance/governance.module.ts` — no controller, no HTTP route of any kind; exports only the token. Wired into `AppModule`.

### A.4 Audit integration

`AUDIT_ACTION.APPROVAL_REQUEST_CREATED` / `.APPROVAL_DECISION_RECORDED`; `AUDIT_ENTITY.APPROVAL_REQUEST` / `.APPROVAL_DECISION` — one decision verb with the outcome (`approved`/`rejected`) in metadata, mirroring `CASH_MOVEMENT_RECORDED`'s own convention. `AuditEvent` gained optional `approverId`/`approvalId`, mapped to the **pre-existing** `audit_entries.approver_id`/`.approval_id` columns (present since the original migration, never previously populated) — **explicitly excluded from `computeEntryHash`'s input**, so D-19's ratified "no additional approval-specific hash coverage" and GAP-11 are both preserved exactly; the docblock states this is **not** a hash-coverage fix. `value` is deliberately **never** copied into audit metadata (preserves the opaque-carrier boundary).

---

## B. THE PERMANENT-ID / ZERO-ROW / RLS-REJECTION PROTOCOL

Exactly as the corrected design specified, and now proven against real PostgreSQL:

1. **Permanent-id replay/conflict check, logically first**, before any other mutation (both `createRequest` and `decide`).
2. **Exactly one actual INSERT.** `createRequest` targets `ON CONFLICT ("id") DO NOTHING` (the table's only relevant unique constraint). `decide` uses a **bare** `ON CONFLICT DO NOTHING` — see §D.1 for why this distinction is load-bearing and was the one real defect found.
3. **Zero rows → recover in the still-healthy transaction**: for `decide`, a zero-row result is disambiguated in two steps — same decision id (replay/conflict) checked first, then a **different** decision id already final for the same request (**always** a conflict, never a replay, even when the outcome matches — a distinct permanent id is a distinct business act).
4. **RLS rejection is a separate, real exception** (`PrismaClientKnownRequestError` code `P2010`, underlying SQLSTATE `42501`), caught and re-thrown as `ApprovalDecisionRejectedError` — not a race outcome to resolve, a definitively illegal decision. The whole transaction rolls back, which is correct.
5. **CAS status update** on the request, asserting exactly one row affected — the D-9 U4 policy's compare-and-set, backstopped by the application assertion (§9.2 of the design gate's atomicity proof).
6. **Audit written exactly once**, only on the branch that actually created the decision — never on replay, never on conflict.

---

## C. `performed_by`-style FK decision — no FK on any user column

Following the **governance precedent, not the treasury one**: `governance.audit_entries.approver_id`/`.approval_id` are FK-less; `identity.users` has no `tenant_id` column at all (global identity, membership is many-to-many), so an FK would guarantee row existence only, never tenant membership — zero tenant safety. No `ON DELETE` action is safe either (`SET NULL` would silently void the item-8 exclusion; `CASCADE` would delete a never-deletable request; `RESTRICT` would permanently couple user deletion to approval retention, since requests are never deleted). **`User` and `Tenant` Prisma models are not modified** — the entire schema change is confined to a new Governance section.

---

## D. IMPLEMENTATION-TIME FINDINGS

### D.1 A genuine defect, found and fixed by the mandatory concurrency tests — exactly as intended

**The defect.** `approval_decisions` carries **two** unique constraints: the `id` primary key, and `uq_approval_decision_per_request` (`tenant_id, approval_request_id`). The first implementation of `decide()`'s INSERT used `ON CONFLICT ("id") DO NOTHING` — a **targeted** conflict clause, which in PostgreSQL suppresses **only** a violation of the named constraint. Two managers racing the same request with two **different**, freshly-generated decision ids conflict on the **per-request** constraint, never on `id` — and a targeted `ON CONFLICT` does not catch a violation of a different constraint. The result: a real, unhandled `23505` (surfaced by Prisma as `PrismaClientKnownRequestError`), not the silent zero-row outcome step 3 of the protocol depends on.

**How it was found.** Scenario 1 of the mandatory concurrency matrix — two valid managers, genuine barrier-synchronized contention, `pg_stat_activity` polling — failed on its very first run with exactly this shape: `Expected constructor: ApprovalDecisionConflictError. Received constructor: PrismaClientKnownRequestError`. This is the concurrency-test discipline working precisely as designed: a real Postgres constraint interaction that no amount of code review would reliably catch, surfaced immediately and deterministically by a real two-connection race.

**The fix.** `ON CONFLICT ("id") DO NOTHING` → a **bare** `ON CONFLICT DO NOTHING` (no target list) in `decide()`'s INSERT only — this suppresses a violation of **either** unique constraint on the table, restoring the silent-zero-row behaviour the recovery algorithm requires. `createRequest`'s targeted `ON CONFLICT ("id")` is unaffected and correct as-is (`approval_requests` has only one relevant conflict target). Documented extensively in the service's own docblock, including the exact race shape that exposed it, so a future reader does not reintroduce the same defect on a table with multiple unique constraints.

**Re-verified**: all 3 runs of scenario 1, all 3 runs of scenario 2, and all 3 runs of the duplicate-permanent-id race passed cleanly after the fix (§E).

### D.2 A test-only gap, found by an unrelated repository-wide invariant

The first full-suite run failed one assertion in `test/organisation.e2e-spec.ts` — a global invariant that every `org.branches` row has a matching `org.locations` registry row. The new test file's fixture created a branch directly without creating the paired `Location` row, unlike every other e2e fixture that creates a branch (`inventory.e2e-spec.ts`'s `mkLocation`, etc.). Fixed by adding the missing `admin.location.create(...)` call to `approval-runtime.e2e-spec.ts`'s `beforeAll`, matching the established pattern exactly. **Not a production defect** — Governance never reads `Location`; this was purely a test-fixture completeness gap, caught by an existing repository-wide test doing exactly its job.

### D.3 A test-metadata correction (grants check)

The first RLS/grants assertion checked `information_schema.role_table_grants` for an `UPDATE` privilege on `approval_requests`, expecting it to appear because of the column-level `GRANT UPDATE ("status")`. Empirically, `role_table_grants` does **not** surface a column-level-only grant in this Postgres version — the correct view is `information_schema.role_column_grants`. Fixed the test to check the right view; the underlying grant itself was correct throughout (already proven functionally by a direct UPDATE-attempt test that passed from the start).

---

## E. VERIFICATION

### E.1 Static / build

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean — only the known pre-existing `access-token.service.spec.ts` baseline error |
| `npx eslint` on every changed/added file | Clean, zero errors, zero warnings |
| `npx prisma validate` | `The schema at prisma/schema.prisma is valid` |
| `npx prisma format` | Clean, no diff |
| `nest build` | Clean |
| `git diff --check` | Clean |

### E.2 Targeted, in order (per the executing prompt's own §35)

| Step | Result |
|---|---|
| 1. Approval unit tests (`approvals.service.spec.ts`) | **7/7 passing** — id/entityId/excludedApproverUserId shape guards, blank-field guards, invalid-`expiresAt` guard, each proven to fail **before** the (stubbed, throwing) transaction is ever touched |
| 2. Identity/PIN-affected tests | `auth.service.spec.ts` + `auth.service.refresh.spec.ts`: **7/7**. `test/pin.e2e-spec.ts` + `test/auth.e2e-spec.ts`: **41/41**. Zero regressions — `PinService.authenticate` is byte-unchanged |
| 3. `module-boundaries.spec.ts` | **38/38** (31 baseline + 7 new) — `KNOWN_DEVIATIONS` **unchanged**, zero growth |
| 4. `approval-runtime.e2e-spec.ts` | **40/40**, run in isolation |
| 5–7. Concurrency blocks isolated, ≥3 clean runs, scenario 15 ≥3 clean runs | The full 40-test file (which internally loops every concurrency scenario, including scenario 15, 3× each) was run **4 times** total against 4 independent fresh scratch DBs across this session — **all 4 runs clean, 40/40 each time**, so every concurrency scenario has been proven clean well beyond the minimum 3 runs |
| 8. RLS/grant matrix | Included in the 40; all passing |
| 9. Fresh 32-migration scratch run | Performed **6 times** across this session (once per fresh scratch DB used for isolated/targeted runs, plus the two final full-suite runs) — **all 6 clean** |

### E.3 Full regression

| Suite | Result |
|---|---|
| Full unit suite (`npx jest`) | **746/746 passing**, 54/54 suites (baseline 732 + 7 module-boundary + 7 approvals-service = +14) |
| Full e2e suite (`npm run test:e2e --runInBand`) | **877/877 passing**, 44/44 suites (baseline 837 + 40 new) — run twice against two independent fresh scratch DBs, both clean, zero regressions anywhere in the pre-existing suite |
| OpenAPI regeneration | **Byte-identical** to the pre-task files (verified via a true before/after snapshot diff) — `3.1.0`, exactly **138** operations, confirming zero accidental Governance route |
| Persistent local `ros` DB | Confirmed untouched **after every phase of this task** — still **26** `_prisma_migrations` rows, newest `20260823030000_kitchen_ticket_persistence`; `governance.approval_requests` confirmed **absent** there |

All scratch databases created during this task were dropped after use; only pre-existing, unrelated scratch databases from earlier phases remain.

---

## F. SCOPE FENCE — CONFIRMED HELD

**Not implemented, as instructed**: P1G-1 CashSession close; a cash-variance consumer; the literal `cash.variance` (or any) `request_type` value; the literal `entity_type` for CashSession; variance tolerance/settings; Day Close; X/Z reports; drawer limits; denomination catalogue; asynchronous approval (D-11 N-B, D-2 remain exactly as ratified — knowingly unmet); notifications of any kind; D-12 escalation; `approval_steps`; any Governance HTTP route, read or write; a generic workflow engine; offline approval; NFR-PERF-006 work.

**Confirmed governance-safe**: no register edit performed by this task (the register's uncommitted ratification from the prior task was read as authority and left byte-identical); P-1 not reopened; D-12 remains BLOCKED; D-16's `request_type` enumeration remains OPEN; SB-2's money-only `BIGINT` exclusion remains valid; D-15's pessimistic-locking and generic-idempotency prohibitions remain honoured (the one-final-decision `UNIQUE` constraint is the sole, already-ratified exception).

---

## G. REQUIREMENT CLASSIFICATION

| Requirement | Classification | Basis |
|---|---|---|
| **FR-SEC-030** [M] | **PARTIAL** | The general mechanism exists and is fully consumable, but **zero of the seven named consumers is wired** by this slice — no business module calls `APPROVAL_COMMANDS` yet |
| **FR-SEC-031** [M] | **COMPLETE** (for the runtime substrate) | All six enumerated elements present, `NOT NULL`, immutable after INSERT (D-6) |
| **FR-SEC-032** [M] | **PARTIAL** | Synchronous manager PIN fully implemented and proven (scenarios 13/14); the **asynchronous half remains deferred and knowingly unmet** (D-2, D-11 N-B) — including *"the terminal remaining usable while awaiting an asynchronous decision."* COMPLETE cannot be claimed while that clause is unmet |
| **FR-SEC-033** [M] | **COMPLETE** (for the runtime substrate) | Approver, timestamp, decision, comment all recorded; immutability DB-enforced (append-only grants, no UPDATE/DELETE policy); `decided_at` now provably unforgeable by `ros_app` |
| **FR-SEC-016** [M] | **NOT IMPLEMENTED — enforcement substrate enabled** | The DB-enforced generic primitives (requester ≠ approver, excluded approver ≠ approver) exist and are proven, but **zero of the four named business combinations is operationally wired** — cash variance awaits P1G-1, discounts/requisitions have no consuming domain, strict SoD does not exist |
| **FR-FIN-006** [M] | **NOT IMPLEMENTED — substrate enabled** | Wholly P1G-1's; this slice makes it reachable, implements none of it |

Runtime-substrate classification is kept explicitly separate from cash-variance-consumer classification throughout, per the executing prompt's own instruction — none of the above predicts or claims what a future P1G-1 would achieve.

---

## H. REMAINING GAPS

Everything in §F's "not implemented" list, plus: the literal `request_type`/`entity_type` values for any future consumer (deliberately left to that consumer's own design gate); whether a future Treasury `approval_request_id` column belongs on `cash_sessions` (recorded as **NOT SOURCE-DECIDABLE** in the final design gate, not resolved here); GAP-11 (approval audit linkage remains outside the tamper-evident hash chain); the variance-tolerance/settings source, which — as the earlier design gate found — remains **P1G-1's nearest actual blocker**, independent of and unaffected by this runtime's completion.

---

## I. FINAL VERDICT

## **A. APPROVAL RUNTIME IMPLEMENTATION COMPLETE**

Reported as **COMPLETE**, not **FINAL ACCEPTED** — per the executing prompt's explicit instruction, final acceptance is a determination made outside this session after report review, and is not self-declared here.

**No commit. No push.** The Governance Decision Register's 2026-08-29 ratification remains intentionally uncommitted, exactly as it was found; it was used as authority throughout and was not modified, reset, or restored.

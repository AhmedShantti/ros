# Approval Runtime — Final Design Gate

**Report type:** Design gate. **No product implementation, no migration, no commit, no push, no D-21+.**
**Authority statement:** This report is **non-authoritative evidence**. Authority order: **(1) `ROS_SRS_v1.0.pdf` → (2) `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (current working-tree version, including the uncommitted `Approval Runtime Minimum Resolution — 2026-08-29` ratification) → (3) the repository at HEAD `55e4ae8` → (4) accepted reports → (5) engineering inference only where authority is silent.** **The register governs over the two earlier analysis reports wherever they differ.** Where authority is silent this report says **NOT SOURCE-DECIDABLE** and does not convert a recommendation into a fact.
**Date:** 2026-08-29
**HEAD:** `55e4ae8` (unchanged; no commit), branch `feat/production-spec`, migrations **31**
**Working tree:** the register carries the uncommitted ratification (used as authority, not reset or restored); unrelated uncommitted reports untouched. This report + its INDEX row are the only additions.
**Task identifier:** APPROVAL runtime final design gate

> ## VERDICT
> ## **A. APPROVAL RUNTIME IMPLEMENTATION READY**
>
> Every migration-critical question is now **RATIFIED** or **DESIGN-DECIDABLE
> NOW**. Nothing migration-critical remains **USER RATIFICATION REQUIRED**.
>
> Three findings materially shaped the design, each from current code rather
> than report prose:
>
> **(1) The expiry inequality is already decided.** D-10's ratified option E2
> reads *"a decision may not be inserted **once `now() > expires_at`**"* — so a
> decision **at exactly** `expires_at` is permitted. No ratification needed.
>
> **(2) The pending-status guard is already a DB predicate — in the right
> place.** D-9 **U4** ratifies the *request UPDATE* policy as
> `USING (T AND status='pending')`, while D-15 clause 9 **forbids** a
> pending predicate on the *decisions INSERT* policy. So the decisions policy
> keeps exactly **four** conjuncts and the compare-and-set lives on the UPDATE
> policy, where it was ratified. No new predicate is invented.
>
> **(3) `PinService.authenticate` opens its own transaction, and nested
> `withAuthContext` is unsupported.** PIN verification therefore **cannot** sit
> inside the approval transaction — a constraint that dictates the whole
> command ordering, and which a naive design would hit only at runtime.
>
> The `Employee.user_id` nullability the brief flagged resolves **without**
> ratification: `PinService.authenticate` refuses any employee with
> `userId = NULL`, so a session owner reachable through the POS path always has
> a linked User; where the link is genuinely absent the design **fails closed**,
> refusing the beyond-tolerance close exactly as Inventory already refuses an
> approval-requiring post. The fourth conjunct is never weakened.

---

## 1. FIXED RATIFIED FACTS — TREATED AS BINDING

All twenty facts listed in the brief were verified present in the working-tree register and are treated as binding and unopened: Governance ownership of both tables; **P-1** direct linkage; `request_type` `VARCHAR(32)` with no CHECK and its **enumeration still OPEN**; `required_permission` as an immutable code with no FK; **no DELETE** on requests; **append-only** decisions; lifecycle `pending → approved | rejected`; `decision` and `status` stored with distinct roles; **exactly one final decision**; `value` as opaque `JSONB NOT NULL` with money as base-10 integer strings and never parsed by Governance policies; synchronous manager PIN **in scope**; asynchronous approval **deferred**; **no Governance HTTP surface**; **no Governance read surface**; **D-12 BLOCKED**; excluded approver as an **Identity USER ID**, DB-enforced independently of requester ≠ approver.

**Post-ratification corrections observed.** This report states throughout that the `UNIQUE (tenant_id, approval_request_id)` constraint **is** a narrow amendment of **D-15 clause 4** made through **D-15 clause 14**'s own future-amendment route, superseding D-15 clauses 10–11 to that extent only. It **does not** repeat the earlier incorrect claim that the constraint does not amend D-15. No approval-specific pessimistic locking, no approval-specific generic idempotency mechanism, and **no D-15 C-3 pending-status predicate** are introduced.

---

## 2. REPOSITORY STATE — VERIFIED AT HEAD, NOT ASSUMED

| Area | Verified fact | Consequence for this design |
|---|---|---|
| Approval artifacts | **None exist** — no model, table, migration, or `src/` file. `governance/` holds only `audit/` (8 files) | Greenfield; nothing to reconcile |
| `governance.audit_entries` | Ships **zero foreign keys**, including `actor_id`, `approver_id`, `approval_id` — plain UUID columns | Sets the governance precedent for user references (§5.4) |
| Governance migration note | *"Future governance tables must grant `ros_app` explicitly"* — `ALTER DEFAULT PRIVILEGES` was removed for Render compatibility | Migration 32 **must** carry explicit GRANTs |
| `PinService.authenticate` | Requires non-null `employee.userId`; returns `PinAuthResult {employeeId, userId, branchId, terminalId, membershipId}` — **no token**; opens **its own** `withAuthContext({tenantId})`; `recordFailure` runs **outside** any transaction | §3, §8, §15 |
| `withAuthContext` | *"Nested calls to `withAuthContext` are **NOT supported**"* | PIN verification cannot nest inside the approval transaction (§8/§9) |
| Permission resolution | `TenantContextService.resolve()` needs a full principal (`userId + tenantId + membershipId`) and returns the whole code `Set`. **No service answers "does user X hold code Y" for a non-principal user** | Identity must publish it (§3, §11) |
| Module boundaries | `identity/` and `governance/` have **no `contract/`**; **no `governance->identity`** deviation exists; `KNOWN_DEVIATIONS` is asserted **exactly** | A contract is mandatory, not optional (§14) |
| `CashSession.employeeId` | Taken from `principal.employeeId` (JWT claim), never the body; the DTO has no such field. `CashSessionsService.open` **does not select or check `userId`** | §15 |
| `Employee.userId` | `String? @unique`, relation `onDelete: SetNull`; `ros_app` holds schema-wide DELETE on `identity`; **no application user-delete path** (`UsersService` exposes only `createUser`) | §15 |
| `AuditService` | `record(tx, event)`; `AuditEvent` has **no** `approverId`/`approvalId`; takes `pg_advisory_xact_lock('ros_audit', tenantId)`; metadata must be JSON-serializable (**a `bigint` leaf throws** in `stableStringify`) | §13 |
| Slice-boundary test | `test/inventory.e2e-spec.ts:644-649` asserts `governance.approval_requests` was **NOT** created — the **only** such assertion in the suite | §18 |

---

## 3. IDENTITY PIN CONTRACT — F-2 RESOLVED

### 3.1 Classification — a **verification contract**

Not a pure query (it has persistent side effects: failure counters and lockout). Not a classic command (it creates no domain state). The repository already has a form for exactly this case: `<subject>.contract.ts`, used by P1F-2 *"when the contract is the module's single cross-boundary port for a business flow — regardless of read/write direction"* (`consumption.contract.ts` is a query; `sale-depletion.contract.ts` is a command).

**File:** `src/modules/identity/contract/pin-verification.contract.ts` — Identity's **first** public contract.
**Barrel:** `src/modules/identity/contract/index.ts`.
**Token:** `export const TERMINAL_PIN_VERIFIER = Symbol('TERMINAL_PIN_VERIFIER');` — role-named, following the `SHIFT_OPENER` precedent rather than the `*_QUERY` form, because this is neither a query nor a command.
**Binding:** `{ provide: TERMINAL_PIN_VERIFIER, useExisting: PinService }` in `IdentityModule`, plus the token in `exports` — the `useExisting` pattern used by all seven existing contract bindings.

### 3.2 Shape

```ts
import { Prisma } from '../../../generated/prisma/client';

export const TERMINAL_PIN_VERIFIER = Symbol('TERMINAL_PIN_VERIFIER');

export interface VerifyTerminalPinInput {
  readonly tenantId: string;
  readonly terminalId: string;
  readonly employeeCode: string;
  readonly pin: string;
}

export interface VerifiedTerminalPrincipal {
  readonly userId: string;
  readonly employeeId: string;
  readonly membershipId: string;
  readonly branchId: string;
  readonly terminalId: string;
  /** The verified actor's effective permission CODES in this tenant. */
  readonly permissions: ReadonlySet<string>;
}

export interface TerminalPinVerifier {
  verifyTerminalPin(
    input: VerifyTerminalPinInput,
  ): Promise<VerifiedTerminalPrincipal>;
}
```

Every field is `readonly`; the contract is an `interface`, never a class; there is no `any`. The five fields the brief specifies are all present.

### 3.3 Two deliberate, documented departures from convention

**(a) NOT `tx`-first — and this is security-motivated, not stylistic.** Every existing contract takes `tx: Prisma.TransactionClient` first. This one takes none, because `PinService.authenticate` opens its own `withAuthContext({tenantId})` and **nested `withAuthContext` is explicitly unsupported**. More importantly, `recordFailure` deliberately runs **outside** any transaction so that lockout counters survive a caller rollback — if PIN verification joined the caller's transaction, an attacker could obtain unlimited PIN attempts simply by forcing the outer transaction to roll back. **The contract must therefore manage its own transaction, and the docblock must say why.** (`localisation/contract/pinned-payment-policy.query.ts` is the existing precedent for a contract that documents why it takes no `tx`.)

**(b) It returns the effective permission set.** The brief lists five output fields; `permissions` is added because §11 requires Governance to validate `required_permission` against the approver, and **no service exists that answers that for a non-principal user**. The alternatives are worse: a general "query any user's permissions" API is a strictly *larger* Identity surface and edges toward the read surface D-20 declines; a private import of `TenantContextService` is a boundary violation. Returning the set from the call that already resolved the membership is the **minimum** capability — `PinService.authenticate` already queries the membership at `pin.service.ts:372-380`, so the role→permission join is the natural extension of one consistent read.

**Reused, never duplicated:** hashing, lockout, terminal-active check, permitted-branch check, membership-active check and the generic-401 discipline all remain `PinService`'s. The contract adds only the permission projection.

---

## 4. REQUEST TYPE VALUE FOR CASH VARIANCE — **ANSWER A**

**The runtime can be fully generic. No cash-variance value is defined here.**

`request_type` is `VARCHAR(32)` with no CHECK; Governance never reads or branches on it (D-13: *"Governance is a generic carrier"*). The create command accepts it as caller-supplied data. **Nothing in the runtime, the schema, or the RLS policies requires knowing any particular value.**

Do tests force one? No. Because the column is unconstrained, e2e tests may insert an explicitly **test-only** literal (e.g. `'test_request'`) that is *not* proposed as a production value and carries no authority. This is materially different from P1G-0, where the closed `CashMovementType` enum forced tests to use real production values.

**The literal machine-readable code for cash variance therefore belongs to the P1G-1 design gate**, and remains **NOT SOURCE-DECIDABLE** here: the SRS names the requirement (`FR-FIN-006`) and the permission (`cash.variance.approve`) but never a `request_type` value; the approved SQL's comment lists six values, none of them cash-variance; and D-16's evidence table places `FR-FIN-006` among the **nine** requirements outside `FR-SEC-030`'s seven. **`cash.variance` is not invented, and no ratification is requested.**

---

## 5. EXACT DATABASE SCHEMA

### 5.1 `governance.approval_requests`

| SQL name | Prisma | SQL type | Null | Default | Notes |
|---|---|---|---|---|---|
| `id` | `id` | `UUID` | NO | — | PK. Client-supplied permanent id (§16) |
| `tenant_id` | `tenantId` | `UUID` | NO | — | RLS anchor. **No FK** (§5.4) |
| `request_type` | `requestType` | `VARCHAR(32)` | NO | — | **No CHECK** (item 1) |
| `entity_type` | `entityType` | `VARCHAR(48)` | NO | — | Matches `audit_entries.entity_type` |
| `entity_id` | `entityId` | `UUID` | NO | — | Polymorphic. **No FK** — see §13 |
| `requested_by` | `requestedBy` | `UUID` | NO | — | Identity User. **No FK** (§5.4) |
| `required_permission` | `requiredPermission` | `VARCHAR(64)` | NO | — | Immutable §15.2 code, **no FK** (item 2) |
| `value` | `value` | `JSONB` | NO | — | Opaque carrier (item 7, §6) |
| `expires_at` | `expiresAt` | `TIMESTAMPTZ(6)` | NO | — | Immutable (D-10 cl. 7) |
| `excluded_approver_user_id` | `excludedApproverUserId` | `UUID` | **YES** | — | Item 8. Generic name (§5.3) |
| `status` | `status` | `VARCHAR(16)` | NO | `'pending'` | **The only updatable column** (D-6) |
| `created_at` | `createdAt` | `TIMESTAMPTZ(6)` | NO | `CURRENT_TIMESTAMP` | — |

**Constraints**
- `CONSTRAINT approval_requests_pkey PRIMARY KEY (id)`
- `CONSTRAINT uq_approval_requests_tenant_id UNIQUE (tenant_id, id)` — the composite-FK target (mirrors `cash_movements_tenant_id_id_key`)
- `CONSTRAINT ck_approval_request_status CHECK (status IN ('pending','approved','rejected'))` — D-4's ratified set, and the only enumeration Governance owns outright
- `CONSTRAINT ck_approval_request_permission_present CHECK (length(btrim(required_permission)) > 0)`
- `CONSTRAINT ck_approval_request_type_present CHECK (length(btrim(request_type)) > 0)`
- **No FK on any user column, and none on `entity_id`** (§5.4, §13)

**Indexes**
- `(tenant_id, status)` — the pending working set
- `(tenant_id, entity_type, entity_id)` — the consuming domain's lookup

**Mutability — D-6 Model B + Mechanism 1**, exactly the Production GAP-2 three-line form:
```sql
GRANT SELECT, INSERT ON "governance"."approval_requests" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "governance"."approval_requests" FROM ros_app;
GRANT UPDATE ("status") ON "governance"."approval_requests" TO ros_app;
```
The `REVOKE` includes `DELETE, TRUNCATE` per item 3 (**no DELETE capability**), and the column grant makes every other column structurally unwritable after INSERT.

**RLS**
```sql
ALTER TABLE "governance"."approval_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "governance"."approval_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY approval_requests_select ON "governance"."approval_requests" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY approval_requests_insert ON "governance"."approval_requests" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status = 'pending');

-- D-9 U4, ratified verbatim: the compare-and-set for the status transition.
CREATE POLICY approval_requests_update ON "governance"."approval_requests" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         AND status = 'pending')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('approved','rejected'));

-- No DELETE policy exists (item 3), and DELETE is revoked above.
```
The INSERT policy's `status = 'pending'` is not a new invention — it is the entry half of D-4's ratified one-way lifecycle, and prevents a request being born already decided. The UPDATE policy is **D-9 U4 reproduced exactly** as the register records it: `USING (T AND status='pending')` + `WITH CHECK (T AND status IN ('approved','rejected'))`.

### 5.2 `governance.approval_decisions`

| SQL name | Prisma | SQL type | Null | Default | Notes |
|---|---|---|---|---|---|
| `id` | `id` | `UUID` | NO | — | PK. Client-supplied permanent id |
| `tenant_id` | `tenantId` | `UUID` | NO | — | RLS anchor |
| `approval_request_id` | `approvalRequestId` | `UUID` | NO | — | **P-1 direct parent** |
| `approver_id` | `approverId` | `UUID` | NO | — | Identity User. **No FK** (§5.4) |
| `decision` | `decision` | `VARCHAR(16)` | NO | — | `approved` \| `rejected` |
| `comment` | `comment` | `TEXT` | **YES** | — | `FR-SEC-033` *"any comment"* — *any* implies optional |
| `decided_at` | `decidedAt` | `TIMESTAMPTZ(6)` | NO | — | `FR-SEC-033` *"timestamp"* |
| `created_at` | `createdAt` | `TIMESTAMPTZ(6)` | NO | `CURRENT_TIMESTAMP` | — |

**Constraints**
- `CONSTRAINT approval_decisions_pkey PRIMARY KEY (id)`
- **`CONSTRAINT uq_approval_decision_per_request UNIQUE (tenant_id, approval_request_id)`** — item 5; the narrow amendment of D-15 clause 4 via clause 14. **This is the entire concurrency mechanism** (§9)
- `CONSTRAINT ck_approval_decision_value CHECK (decision IN ('approved','rejected'))`
- **P-1 tenant-safe composite FK:**
  ```sql
  ALTER TABLE "governance"."approval_decisions"
    ADD CONSTRAINT "approval_decisions_tenant_id_approval_request_id_fkey"
    FOREIGN KEY ("tenant_id", "approval_request_id")
    REFERENCES "governance"."approval_requests"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
  ```
  `ON DELETE RESTRICT` is item 3 verbatim; `CASCADE` remains rejected. **No `requested_by` column** — D-7 clause 3 forbids denormalising it.

**Indexes:** the UNIQUE above already serves parent lookup; add `(tenant_id, approver_id)` for approver history.

**Mutability — D-8 full append-only:**
```sql
GRANT SELECT, INSERT ON "governance"."approval_decisions" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "governance"."approval_decisions" FROM ros_app;
```

**RLS:** `ENABLE` + `FORCE`; a tenant-scoped SELECT policy; the four-conjunct INSERT policy of §10; **no UPDATE and no DELETE policy**.

### 5.3 The excluded-approver field — name and rationale

**`excluded_approver_user_id` / `excludedApproverUserId`.** Generic and self-describing: *an additional User prohibited from approving this request*. It contains no cash, session, or Treasury vocabulary, so Governance attaches no domain meaning — exactly as item 8 requires. Nullable, because most approvals name no additional excluded party.

### 5.4 Do the user columns get a plain FK to `identity.users(id)`? — **NO**

Two precedents exist and they diverge, so this is decided on reasoning, not by copying the nearest file:

- `treasury.cash_movements.performed_by` **has** a plain FK to `identity.users(id) ON DELETE RESTRICT`.
- `governance.audit_entries` has **no FK at all** — including `actor_id`, `approver_id` and `approval_id`, which are precisely the same kind of reference, on the only existing Governance table.

**The governance precedent governs**, for three reasons:

1. **The FK would provide no tenant safety whatsoever.** `identity.users` is **global** — it has no `tenant_id` column. An FK guarantees only that the row exists, not that the user belongs to this tenant. Tenant safety comes from elsewhere and already does: the row's own `tenant_id` under FORCE RLS, plus the **membership-validated provenance** of every user id written — `requested_by` from `TenantContext` (which DB-validates an active membership), `approver_id` from `VerifiedTerminalPrincipal` (same), and `excluded_approver_user_id` from a tenant-scoped Employee row. A plain FK adds nothing to the guarantee that actually matters.
2. **`ON DELETE` has no safe non-trivial option.** `SET NULL` would silently void the exclusion and **weaken the ratified fourth conjunct** — expressly forbidden. `CASCADE` would delete a request that item 3 says may never be deleted. Only `RESTRICT` is safe, and since requests are **never deleted**, a RESTRICT FK would permanently block deleting any user ever named on any request — a lasting coupling of user lifecycle to approval retention. Storing a bare UUID keeps the invariant robust: the stored value survives, and a deleted user cannot be an approver in any case.
3. **Consistency within the schema.** `audit_entries.approver_id` and `.approval_id` are FK-less today and the register discusses them (D-19 / GAP-11) without ever proposing FKs. Introducing FKs for the same concept one table over would be incoherent.

**Consequence for Prisma:** to avoid schema/migration drift the rule *DB FK ⟺ Prisma relation* is preserved. The models therefore declare **only** the intra-Governance relation (decisions ⇄ requests) and carry the user columns as plain `String @db.Uuid`, exactly as `AuditEntry.actorId` / `.approverId` do. **No back-relations are added to `User` or `Tenant`, and neither model is modified** — the entire `schema.prisma` change stays inside a new Governance section.

---

## 6. REQUEST VALUE — THE GENERIC APPLICATION TYPE

**Write side: `Prisma.InputJsonValue`. Read side: `Prisma.JsonValue`.**

Rejected alternatives: `unknown` forces an unchecked cast at every call site and loses the JSON-safety guarantee; `any` is prohibited and mechanically detected in contracts; a repository-owned JSON type does not exist and inventing one duplicates Prisma's for no gain.

`Prisma.*` type-only imports are already the contract convention — every contract file imports `Prisma` for `Prisma.TransactionClient`, and `module-boundaries.spec.ts` flags only `@Injectable(`, class declarations and Prisma **query-method calls**, none of which a type reference is. `AuditService` already casts to `Prisma.InputJsonValue` for `before_state`/`after_state`, so this matches shipped Governance code.

**Governance-level domain discriminators are NOT introduced** — no `valueKind`, no dimension enum, no shape validation. Treasury owns the concrete cash-variance document later, and **money inside it is a base-10 integer string of minor units** (item 7). A `bigint` must never be placed in the document: `JSON.stringify` throws on `bigint`, which is exactly why the string convention exists and how `audit_entries` metadata already handles minor units.

---

## 7. REQUEST CREATE COMMAND

```ts
export interface CreateApprovalRequestCommand {
  readonly id: string;                       // client-supplied permanent id
  readonly requestType: string;              // opaque to Governance
  readonly entityType: string;
  readonly entityId: string;
  readonly value: Prisma.InputJsonValue;     // opaque carrier
  readonly requiredPermission: string;       // an existing §15.2 code
  readonly expiresAt: Date;                  // MANDATORY — no default (§12)
  readonly excludedApproverUserId?: string;  // optional Identity USER id
}

export interface ApprovalCommands {
  createRequest(
    tx: Prisma.TransactionClient,
    tenantId: string,
    requestedByUserId: string,
    command: CreateApprovalRequestCommand,
  ): Promise<ApprovalRequestRecord>;
}
```

**Trusted vs supplied.** `tenantId` and `requestedByUserId` are **positional parameters supplied by the calling module from its own `TenantContext`**, never fields inside `command` — the exact shape every comparable service uses (`record(tenantId, actorUserId, input)`, `openShift(tx, command)` with a server-derived `openedAt`). Placing them outside the caller-shaped payload is what makes tenant spoofing structurally awkward rather than merely discouraged; and the RLS INSERT policy independently rejects any `tenant_id` that differs from the transaction's `app.tenant_id`, so a spoofed value fails at the database even if it reached the service.

`requestType`, `entityType`, `entityId`, `value`, `requiredPermission`, `expiresAt` and `excludedApproverUserId` are **domain facts the consuming module owns** (D-13) and are supplied explicitly. `status` is not accepted at all — it is always `'pending'` at creation, enforced by both the service and the INSERT policy.

**`tx`-first**, so the request is created inside the consuming module's single transaction — the load-bearing convention `cash-movement-totals.query.ts` documents. **No HTTP route** (D-14 A-1).

**Permanent id.** Client-supplied and validated with the shared `UUID_PATTERN` before any DB work, following `CashMovementsService.record`'s exact shape and error string (*"id must be a ULID rendered as a UUID."*). Whether **`FR-OFF-015` mandates** this for approvals is **NOT SOURCE-DECIDABLE** — §21.3's device-created list names *"Shifts, cash sessions, drawer events"* and not approvals — so the id is adopted on **repository precedent**, not claimed as an SRS requirement. Replay/conflict semantics are in §16.

---

## 8. DECIDE COMMAND — SYNCHRONOUS MANAGER PIN

```ts
export interface DecideApprovalCommand {
  readonly id: string;                      // client-supplied decision id
  readonly approvalRequestId: string;
  readonly decision: 'approved' | 'rejected';
  readonly comment?: string;
  readonly approver: VerifiedTerminalPrincipal;   // from the Identity contract
}

decide(
  tx: Prisma.TransactionClient,
  tenantId: string,
  command: DecideApprovalCommand,
): Promise<ApprovalDecisionRecord>;
```

**The approver arrives already verified.** Governance does not accept a raw PIN, and never sees one. The consuming module calls the Identity contract first — **outside** the approval transaction, because `PinService.authenticate` opens its own and nesting is unsupported — then passes the resulting `VerifiedTerminalPrincipal` in. This keeps PIN handling entirely inside Identity, satisfies "Governance must not import `pin.service`", and preserves the security property that lockout counters persist even if the outer transaction rolls back.

**Ordered flow**

1. Consuming module (Treasury) receives close + manager PIN on **its own** route.
2. **Outside the transaction:** `TERMINAL_PIN_VERIFIER.verifyTerminalPin(...)` → `VerifiedTerminalPrincipal` (or a 401 that ends the request; lockout persists).
3. Consuming module opens **one** `withAuthContext({ userId, tenantId })` transaction.
4. `createRequest(tx, …)` — the request row, `status='pending'`.
5. `decide(tx, tenantId, command)`:
   a. Validate `id` shape; **permanent-id replay check first** (§16).
   b. Load the request in-transaction; assert it exists and `status='pending'`.
   c. **Permission check:** `approver.permissions.has(request.requiredPermission)` → else `ForbiddenException`, no decision (§11).
   d. **One INSERT** — `INSERT … ON CONFLICT DO NOTHING RETURNING …` (§9).
   e. If zero rows → resolve replay vs conflict in the still-healthy transaction (§9/§16).
   f. **CAS UPDATE** the request status; assert exactly one row affected.
   g. `AuditService.record(tx, …)` — one entry (§13).
   h. Return the immutable decision record.
6. Consuming module performs its own business write in the same transaction; commit.

**No auth session or token is minted to approve** — `verifyTerminalPin` returns facts only, never tokens, mirroring `PinService.authenticate`'s own no-token design. **No Governance endpoint is exposed**; the only HTTP surface is Treasury's pre-existing route.

**Recorded TOCTOU note.** The permission set is read in step 2 and used in step 5c, so a permission revoked in between would not be seen. This window is inherent to the shipped architecture — `PermissionGuard` resolves in its own transaction and every handler then runs in another — so the approval path is no weaker than any other permission-gated operation. Recorded, not silently ignored.

---

## 9. TRANSACTION / ATOMICITY

### 9.1 One transaction, three writes, fixed order

Steps 5d (decision INSERT) → 5f (request CAS UPDATE) → 5g (audit) execute in **one** `withAuthContext` transaction, opened by the consuming module. **PIN verification is deliberately outside it** (§8).

### 9.2 Proof that decision and status can never diverge

**Claim.** After commit there is no state where a decision exists with `status='pending'`, nor `status` decided with no decision.

**Proof.** Both writes are statements of a single PostgreSQL transaction, so they commit together or not at all; no isolation level exposes one without the other, because no intermediate state is ever made visible. The only way to produce divergence is to place them in separate transactions, which this design forbids. Within the transaction, step 5f asserts **exactly one** row affected: if the CAS matches zero rows — because `status` was no longer `'pending'`, or the D-9 U4 `USING` clause filtered the row — the service throws and the **whole** transaction rolls back, discarding the INSERT of step 5d. Symmetrically, `status` cannot become decided without a decision, because step 5f is reached only after step 5d has produced a row. ∎

A silent no-op is impossible precisely because the affected-row count is asserted; without that assertion, RLS filtering would appear as a successful zero-row UPDATE. This is the one place where the DB predicate alone is insufficient and the application must cooperate.

### 9.3 The race: two managers decide concurrently

**Mechanism: the `UNIQUE (tenant_id, approval_request_id)` constraint — and nothing else.** D-15 forbids approval-specific pessimistic locking and §24.6.4 confines pessimistic locking to two named cases; no advisory lock, no `SELECT … FOR UPDATE`, no version column is introduced.

Sequence: both transactions insert; PostgreSQL's unique index makes the second **wait** on the first's in-progress insert; on the winner's commit the loser's `ON CONFLICT DO NOTHING` yields **zero rows** — no exception, so the loser's transaction is **not aborted**. The loser then reads the winner in the still-healthy transaction and either replays (identical permanent id and facts) or raises a typed conflict, rolling back with **no partial state**.

**Why `ON CONFLICT DO NOTHING` rather than catching `23505`.** A raised unique violation would put the transaction into the aborted state, so every subsequent statement — including the recovery read — would fail with `25P02`. This is the P1E-5A lesson, already load-bearing in `ticket-persistence.service.ts`, `sales-payment.service.ts` and `cash-movements.service.ts`, and it is why the conflict must be resolved **inside** the statement.

The bare `ON CONFLICT DO NOTHING` (no conflict target) covers **both** unique constraints — the PK on `id` and the per-request UNIQUE — which is exactly what §16 needs to distinguish replay from conflict.

**Deferred vs immediate constraints:** the UNIQUE constraint stays **IMMEDIATE** (the default). Deferring it would move the violation to COMMIT, past the point where the service can distinguish replay from conflict, and would defeat `ON CONFLICT` entirely.

**Approve-vs-reject concurrently** resolves identically: the constraint is on the request, not the decision value, so the first to insert wins regardless of outcome and the second sees a differing-facts conflict.

**This is precisely the residual D-15 recorded** — *"a decision can be inserted against an already-decided request"*, and *"duplicate or contradictory decision rows"* — which item 5 now closes. The design does not merely coexist with the amendment; it is the amendment's purpose.

**No deadlock.** The only lock taken beyond ordinary row locks is `AuditService`'s pre-existing per-tenant `pg_advisory_xact_lock('ros_audit', tenantId)`, acquired **last** and identically by every audited write in the system, so no cycle is possible. It is not approval-specific and introduces no new locking scheme, so D-15 clause 5 is untouched.

---

## 10. RLS — THE EXACT FOUR-CONJUNCT INSERT POLICY

### 10.1 Should `status='pending'` be a fifth conjunct? — **NO, and authority decides it**

**D-15 clause 9** is explicit: *"**Do NOT** add the proposed **D-15 C-3 pending-status predicate** to the decision INSERT policy,"* and the 2026-08-29 ratification **expressly preserved that prohibition**. So the decisions INSERT policy carries exactly **four** conjuncts.

The guard is not lost — it already exists, on the correct object. **D-9 U4**, ratified, is the *request UPDATE* policy: `USING (T AND status='pending')` + `WITH CHECK (T AND status IN ('approved','rejected'))`. The pending check is therefore **a DB predicate on the UPDATE policy**, supplemented by the application's affected-row assertion (§9.2) which converts a filtered no-op into an error. **Answer: DB-enforced on the UPDATE policy, plus an application assertion — and NOT a fifth INSERT conjunct.** No new predicate is invented, and no ratified wording is stretched.

### 10.2 Exact SQL

```sql
CREATE POLICY approval_decisions_insert ON "governance"."approval_decisions" FOR INSERT
  WITH CHECK (
    -- 1. tenant isolation
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    -- 2/3/4. D-7 self-approval, D-10 expiry, item-8 excluded approver
    AND NOT EXISTS (
      SELECT 1
      FROM "governance"."approval_requests" r
      WHERE r.tenant_id = approval_decisions.tenant_id
        AND r.id        = approval_decisions.approval_request_id
        AND (    r.requested_by              = approval_decisions.approver_id
              OR r.expires_at                <  now()
              OR r.excluded_approver_user_id = approval_decisions.approver_id )
    )
  );
```

**Form.** A single `NOT EXISTS` traversal, matching **D-7's ratified wording** (*"the required cross-table `NOT EXISTS` traversal"*) and the register's own rendering `WITH CHECK (T AND <D-7 self-approval NOT EXISTS traversal> AND <D-10 request unexpired>)`. Note the repository contains **no** existing `NOT EXISTS` policy — every current cross-table policy uses `EXISTS` — so this is the first; the ratified wording is followed over the local idiom, and the divergence is recorded rather than silently resolved.

**Why one subquery rather than three.** The three request-derived conjuncts all traverse to the same row, so expressing them as one *violating-conditions* disjunction is logically identical to three separate conjuncts **given that exactly one request row matches** — which the composite FK guarantees. One subquery is also one index probe.

**NULL-safety of conjunct 4.** When `excluded_approver_user_id IS NULL`, `NULL = approver_id` evaluates to `NULL`, not `TRUE`, so the disjunct cannot fire and the row is admitted. This delivers item 8's *"when non-null"* semantics with no `IS NOT NULL` guard and no three-valued-logic trap.

**Expiry inequality.** `r.expires_at < now()` is the *violating* condition, so insertion is permitted while `now() <= expires_at` — see §12.

### 10.3 Fail-closed proof

With no tenant context, `current_setting('app.tenant_id', true)` returns `''`; `NULLIF('', '')` is `NULL`; the cast yields `NULL`; `tenant_id = NULL` evaluates to `NULL`, which is **not TRUE**, so the `WITH CHECK` fails and the INSERT is rejected. This is the byte-identical expression used by every policy in the repository, whose stated rationale is *"read via `NULLIF(current_setting(...,true),'')::uuid` → fail-closed."*

A subtlety worth stating: with no tenant context the `NOT EXISTS` subquery would see zero rows under the requests SELECT policy and therefore evaluate to `TRUE`. It does not matter — conjunct 1 has already failed, and `NULL AND TRUE` is `NULL`. The tenant conjunct must remain a **top-level** conjunct for this reason, and it does.

**Cross-tenant pairing is structurally impossible**, independent of RLS: the FK is `(tenant_id, approval_request_id) → approval_requests(tenant_id, id)`, so a decision carrying `tenant_id = A` can only reference a request whose `tenant_id` is also `A`. Combined with conjunct 1 pinning `tenant_id` to the session context, a cross-tenant decision/request pair cannot be represented.

---

## 11. PERMISSION VALIDATION

`required_permission` carries **no FK** (item 2), so validation is by **membership test at decision time** against `VerifiedTerminalPrincipal.permissions` — the approver's effective code set, resolved by Identity from membership → roles → permissions. This is item 2b's ratified wording implemented literally.

**The layer asymmetry is deliberate.** Permission-holding is checked at the **service layer**, exactly like every other permission in the system (`PermissionGuard`), while self-approval and exclusion are enforced at the **database layer** (D-7 M2, item 8). The reason is in the requirement: `FR-SEC-016` demands the block hold *"regardless of role configuration"* — a guarantee that must survive a **misconfigured role** and therefore cannot itself be expressed as a role/permission check.

**Failure modes — all fail closed, none produces a decision:**

| Case | Behaviour |
|---|---|
| `required_permission` names an **unknown** code | No role grants it → not in the approver's set → `ForbiddenException`; transaction rolls back |
| Code is **known but ungranted** to this approver | Identical — the check is set membership, not existence |
| Code **removed from every role** after request creation | Identical. The request becomes permanently un-approvable and expires unresolved — the disclosed, safe-direction consequence of RP-1, and the reason it was disclosed |

**No generic approval permission is invented.** The approver's authority is exactly the code the request names — for cash variance, the source-named `cash.variance.approve`. Creating a request needs **no** permission of its own: under D-14 A-1 there is no route, and creation is an internal consequence of an already-authorised business action (§16.2 of the first gate).

---

## 12. EXPIRY

**`expiresAt` is mandatory in the create command** — a required, non-optional field with **no service default**. This is the ratified position implemented literally: D-10 retains `expires_at`, D-1 mandates the column, and **no default duration is ratified**, so the consuming domain must state it. `NOT NULL` at the DB layer makes omission impossible.

**The boundary inequality is DECIDED by ratified text — not NOT SOURCE-DECIDABLE.** D-10's ratified option E2 reads:

> **E2** — *Validity predicate, lazily evaluated at decision INSERT — a decision may not be inserted **once `now() > expires_at`***

and D-10 clause 3 prohibits insertion for a request whose `expires_at` *"**has passed**."* Both fix the prohibition at **`now() > expires_at`**, so a decision at exactly `expires_at` is **permitted**:

> **`decided_at <= expires_at` is permitted; `decided_at > expires_at` is refused.**

The policy therefore uses `r.expires_at < now()` as the violating condition. **No user ratification is required**, and no inequality is invented.

Enforced **at the database INSERT boundary** (D-10 clause 8), inside the same statement as the other conjuncts, so expiry cannot be raced past. **No scheduler, no sweep, no `expired` status** (D-10 clauses 4–6); `expires_at` is immutable, structurally guaranteed by the column-level UPDATE grant admitting only `status`. An expired request simply stays `pending` and becomes undecidable — which is why §13 records no expiry audit event.

---

## 13. AUDIT

**Two actions, using `AuditService` unchanged:**

| Constant | Entity | When | Metadata |
|---|---|---|---|
| `APPROVAL_REQUEST_CREATED` | `APPROVAL_REQUEST` | request row created | `requestType`, `entityType`, `entityId`, `requiredPermission`, `expiresAt` (ISO string), `excludedApproverUserId` |
| `APPROVAL_DECISION_RECORDED` | `APPROVAL_DECISION` | decision created (created path only, never replay) | **`decision`** (`approved`/`rejected`), `approvalRequestId`, `approverId`, `decidedAt`, `comment` presence |

**One decision action with the outcome in metadata**, not separate approve/reject verbs — the `STOCK_MOVEMENT_RECORDED` / `CASH_MOVEMENT_RECORDED` precedent, and no authority requires separate actions. New constants follow the ratified `<ENTITY>_<PAST_TENSE>` convention; `AUDIT_ENTITY` values are `snake_case`.

**No expiry audit event** — correct and required: D-10 clauses 5–6 mean expiry mutates nothing and runs no process, so there is no event to record.

**`value` is NOT copied into audit metadata.** It is an opaque domain document Governance must not interpret, and `sanitizeMetadata` would walk it; keeping it out preserves the §6 boundary. The `entity_id` and request id give full traceability.

**Metadata typing.** `stableStringify` throws on a `bigint` leaf, so any minor-unit figure must be a string before it enters metadata — the convention already used for `amountMinor` in P1G-0's audit calls.

### 13.1 `audit_entries.approval_id` / `approver_id`

Both columns exist and are FK-less, but **`AuditEvent` exposes neither**. Two options: extend `AuditEvent` with optional `approvalId`/`approverId` and map them to the columns, or carry them only in metadata.

**Recommended: extend `AuditEvent`.** The columns were designed for exactly this (SRS §24: *"approver_id, approval_id — Where an approval was involved"*), `AuditService` is Governance-owned so the change crosses no boundary, and it is additive and optional, so no existing caller changes.

**Explicitly not claimed:** this does **not** fix **GAP-11**. D-19 ratified **no additional approval-specific hash coverage**, so these two columns remain **outside** the hash chain and the digest is unchanged. Approval linkage recorded in audit is therefore **not tamper-evident to the same standard as the chained fields** — which is a further reason the authoritative approval record is `governance.approval_decisions` (append-only under D-8), never the audit row. GAP-11 stays open.

---

## 14. MODULE BOUNDARIES

**New files**

| Path | Contents |
|---|---|
| `src/modules/identity/contract/pin-verification.contract.ts` | `TERMINAL_PIN_VERIFIER` token, `VerifyTerminalPinInput`, `VerifiedTerminalPrincipal`, `TerminalPinVerifier` |
| `src/modules/identity/contract/index.ts` | Barrel with the standard *"PUBLIC contract barrel — SRS §5.4"* docblock |
| `src/modules/governance/contract/approval.contract.ts` | `APPROVAL_COMMANDS` token, `CreateApprovalRequestCommand`, `DecideApprovalCommand`, record DTOs, `ApprovalCommands` |
| `src/modules/governance/contract/approval.errors.ts` | Typed errors (see below) |
| `src/modules/governance/contract/index.ts` | Barrel |

`approval.contract.ts` follows the `<subject>.contract.ts` form — the precedented choice when one port carries a business flow in both directions (create is a command, the decision returns a record).

**Errors** follow `inventory/contract/sale-depletion.errors.ts`: plain `Error` subclasses with a `readonly code` literal, published so the consuming module can map them — e.g. `ApprovalRequestConflictError` (`APPROVAL_REQUEST_CONFLICT`), `ApprovalDecisionConflictError` (`APPROVAL_DECISION_CONFLICT`), `ApprovalNotPendingError`, `ApprovalExpiredError`, `ApproverNotPermittedError`, `SelfApprovalProhibitedError`. Typed errors are how the consumer distinguishes outcomes without Governance owning HTTP semantics — **D-18 E-1 is untouched**: Governance defines no HTTP error contract and no RFC 7807 mapping.

**Boundary compliance.** `governance -> identity/contract` and `treasury -> governance/contract` are **public-surface imports**, which `module-boundaries.spec.ts` admits via `isPublicSurface` without any `KNOWN_DEVIATIONS` entry. **No new deviation is created, and the deviation list must not grow** — it is asserted exactly, so growth would fail the test.

**Governance never queries another module's tables.** It cannot inspect `CashSession`, and needs no such access: the consuming domain supplies `entity_type`/`entity_id`, `value`, `excludedApproverUserId`, `requiredPermission` and `expiresAt`. The contract is the only channel, and `value` being opaque (§6) is what keeps that true under future change.

---

## 15. CASH-VARIANCE F-1 INTEGRATION CONTRACT

**P1G-1's CashSession close is NOT designed here.** This section defines only Treasury's future obligations.

| Field | Treasury must supply |
|---|---|
| `requestedByUserId` | The **actual closer's** Identity User (`context.userId`) — never the owner's |
| `excludedApproverUserId` | The CashSession **owner's linked Identity User** (`Employee.userId` for `CashSession.employeeId`) |
| `requiredPermission` | `cash.variance.approve` (source-named, §15.2) |
| `value` | A Treasury-owned opaque document; monetary figures as base-10 integer strings of minor units |
| `entityId` | The CashSession id |
| `entityType` | **NOT SOURCE-DECIDABLE** — no source names a value. Belongs to the P1G-1 gate, like `requestType` (§4). Not invented here |
| `expiresAt` | Explicit; no default exists (§12) |

Both invariants then hold independently and at the database: **requester ≠ approver** (D-7, blocking the closing supervisor) and **approver ≠ session owner** (item 8, blocking the owner) — which is precisely the gap F-1 identified, since under `cash.session.close_other` these are different people.

### 15.1 Can a CashSession owner exist without a linked User?

**(A) Is it structurally guaranteed that a session reaching synchronous manager-PIN close has a user-linked owner? — In practice yes; structurally no.**

`CashSession.employeeId` is taken from `principal.employeeId`, never the request body. That claim can only originate from a PIN login, and `PinService.authenticate` **refuses** any employee with `userId = NULL` (`pin.service.ts:310-312`) — the same generic 401 as a wrong PIN, with `setPin` documenting the rationale: *"SRS §14 permits an Employee with no User; such an employee simply cannot authenticate."* So every session opened through the POS path has a user-linked owner **at open time**.

It is nonetheless **not structurally guaranteed**, for three reasons found in current code: `CashSessionsService.open` does not select or check `userId` at all; `Employee.userId` is nullable with `onDelete: SetNull`, and `ros_app` holds schema-wide DELETE on `identity`, so a future user deletion would silently NULL an existing link (no application delete path exists today — `UsersService` exposes only `createUser`); and nothing re-verifies the link at close time.

**(B) What happens when `employee.user_id IS NULL`?** Treasury cannot resolve an excluded User, so it cannot construct a conformant request.

**(C) Must the beyond-tolerance close fail closed? — YES.** The four prohibited escapes are all rejected: substituting `employee_id` would compare an Employee id against a User id and **never match**, silently voiding the conjunct; leaving the column NULL would admit the owner as approver, violating `FR-FIN-006` and `FR-SEC-016`; inventing a User fabricates identity; weakening the conjunct is forbidden outright. The only conformant behaviour is to **refuse the close** with a typed error.

Failing closed is **design-decidable now, not a new requirement**, because it is the repository's existing answer to exactly this situation: `counts.service.ts:237` and `waste.service.ts:46` already refuse to post when approval is required but the mechanism is unavailable. The invariant is satisfied by refusal, never circumvented — so no ratification is required.

**(D) Is there another ratified identity mapping? — No.** `Employee.userId` is the only Employee→User relation, it is `@unique`, and SRS §7.3 #25 (*"May link to at most one User"*) together with §14 explicitly permits its absence. **Nothing is invented.**

**Recorded for the P1G-1 gate, not decided here:** whether to add a structural guarantee that a CashSession owner is user-linked (a Treasury/Identity schema question), and whether to resolve the excluded User at request-creation time — **recommended**, since freezing it in the immutable request makes the conjunct immune to a later link change.

---

## 16. API / IDEMPOTENCY

**No Governance HTTP endpoint** (D-14 A-1), so **`FR-API-020` does not attach to Governance**, exactly as D-14 clause 12 records. The consuming route (Treasury's close) is `@Idempotent()`, and its `Idempotency-Key` covers the entire operation — approval creation, decision and business write — because all three are inside its single transaction. That is the correct and only place for the at-most-once guarantee, and it needs nothing approval-specific.

**No second idempotency store is built inside Governance.** D-15 clause 3 forbids an approval-specific idempotency key or duplicate-request mechanism, and the ratification preserved it. Permanent business ids are **primary keys**, not an idempotency-key mechanism, and are adopted on repository precedent (§7).

| Case | Behaviour |
|---|---|
| Duplicate `ApprovalRequest` id, **same** facts | **Replay** — return the existing row, `created: false`, no new effect (the `OpenedShift.created` / `CashMovement` precedent) |
| Duplicate `ApprovalRequest` id, **differing** facts | **409** `ApprovalRequestConflictError` — a permanent identity is never silently repointed |
| Duplicate `ApprovalDecision` id, same facts | **Replay**, and **no duplicate audit entry** |
| Duplicate decision id, differing facts | **409** |
| Second decision on the same request (different id) | **409** — the per-request UNIQUE, resolved via `ON CONFLICT DO NOTHING` (§9.3) |
| Consuming-route retry | Handled upstream by the interceptor; Governance is not re-entered |

**Identical-content comparison excludes server-stamped timing** (`created_at`, `decided_at`), mirroring `OrderPayment.processedAt` and `CashMovement.occurredAt` — a precedent established because two genuine retries otherwise disagree on a value neither caller asserted.

---

## 17. CONCURRENCY TEST MATRIX

Real PostgreSQL, deterministic barriers, **no sleeps as correctness proof** (sleeps only as poll cadence), and **≥3 clean runs** for every genuine concurrency scenario (1–4, 9). The barrier technique is the established one: override a provider (e.g. `AuditService`) to pause at the last statement inside the transaction, holding it open while the racing party is dispatched, and confirm genuine contention by polling `pg_stat_activity` rather than assuming it.

| # | Scenario | Mechanism under test | Expected |
|---|---|---|---|
| 1 | Two managers approve the same request | per-request UNIQUE | one decision; loser 409; exactly 1 row; `status='approved'` |
| 2 | Approve vs reject concurrently | same | first wins; second 409; outcome matches the winner |
| 3 | Requester self-approves while a valid manager races | D-7 conjunct + UNIQUE | self-approval rejected by RLS; manager's decision commits |
| 4 | Excluded User approves while a valid manager races | item-8 conjunct + UNIQUE | excluded rejected by RLS; manager's commits |
| 5 | Decision exactly at the expiry boundary | `expires_at < now()` | **permitted** (§12) |
| 6 | Decision after expiry | same | rejected by RLS; zero rows; `status` still `pending` |
| 7 | Duplicate decision permanent id | PK + `ON CONFLICT` | replay; exactly one row; **exactly one** audit entry |
| 8 | Second decision on an already-decided request | per-request UNIQUE | 409; still exactly one decision |
| 9 | Injected failure between the INSERT and the CAS UPDATE | transaction atomicity | **both** rolled back; no decision, `status='pending'` (§9.2) |
| 10 | Cross-tenant decision/request pairing | composite FK + conjunct 1 | rejected; unrepresentable |
| 11 | Missing tenant context | `NULLIF(...)` → NULL | INSERT rejected, fail-closed (§10.3) |
| 12 | Approver lacks `required_permission` | service check | `ForbiddenException`; **no** decision row |
| 13 | Wrong / locked PIN | Identity contract | 401; **no** request-independent side effect except the persisted lockout counter |
| 14 | Valid manager PIN | full happy path | decision committed, `status` transitioned, one audit entry, immutable result returned |

Plus non-concurrency coverage: RLS SELECT isolation; UPDATE rejected on every column except `status`; DELETE rejected on both tables; `information_schema.role_table_grants` asserting `SELECT, INSERT` (+ column-level `UPDATE(status)` on requests) and **not** DELETE/TRUNCATE; and a `status` CHECK violation.

---

## 18. MIGRATION PLAN

**Planned migration 32** — `prisma/migrations/<ts>_governance_approval_runtime/migration.sql`. **Governance-owned only.** Not created by this gate. **No migration 33.**

**Files the migration slice may touch**

| File | Change |
|---|---|
| `prisma/migrations/<ts>_governance_approval_runtime/migration.sql` | **New** — both tables, constraints, indexes, explicit GRANTs, RLS |
| `prisma/schema.prisma` | **New Governance section only**: `ApprovalRequest`, `ApprovalDecision` + their mutual relation. **`User` and `Tenant` are NOT modified** (§5.4) |
| `src/modules/identity/contract/{pin-verification.contract.ts,index.ts}` | New |
| `src/modules/identity/identity.module.ts` | Bind + export `TERMINAL_PIN_VERIFIER` |
| `src/modules/identity/employees/pin.service.ts` | Add the permission projection; implement the contract |
| `src/modules/governance/contract/{approval.contract.ts,approval.errors.ts,index.ts}` | New |
| `src/modules/governance/approvals/approvals.service.ts` | New — create + decide |
| `src/modules/governance/governance.module.ts` | New or extended module wiring |
| `src/modules/governance/audit/audit.constants.ts` | 2 actions + 2 entities |
| `src/modules/governance/audit/audit.service.ts` | Optional `approvalId`/`approverId` (§13.1) |
| `test/approval-runtime.e2e-spec.ts` | New — §17 |
| `src/modules/module-boundaries.spec.ts` | Assertions for the two new contracts; **`KNOWN_DEVIATIONS` must not grow** |

**The slice-boundary test that must be deliberately updated**

`test/inventory.e2e-spec.ts:644-649` — *"governance.approval_requests was NOT created"*, asserting a `pg_tables` count of 0. It is the **only** such assertion in the suite (verified by grep). It is a deliberate tripwire and **must be updated, not deleted**: inverted to assert the table now exists, with a comment citing the 2026-08-29 ratification as the authorising change — exactly how P1G-0 handled its four boundary assertions.

**No OpenAPI change is expected** — Governance exposes no route, so the operation count stays **138**. Any drift would indicate an accidental endpoint and must fail the slice.

---

## 19. REQUIREMENT CLASSIFICATION AFTER IMPLEMENTATION

**Runtime substrate** (what migration 32 delivers):

| Requirement | Classification | Basis |
|---|---|---|
| **FR-SEC-030** [M] | **PARTIAL** | The general mechanism exists and is consumable, but **no consumer is wired** in this slice — Inventory's gates still refuse, Treasury comes later, and five of the seven named domains do not exist. Cannot be COMPLETE with zero consumers |
| **FR-SEC-031** [M] | **COMPLETE (substrate)** | All six enumerated elements are present, `NOT NULL`, and immutable after INSERT |
| **FR-SEC-032** [M] | **PARTIAL** | Synchronous manager PIN implemented; the **asynchronous half remains deferred and knowingly unmet** (D-2, D-11 N-B). The requirement's trailing clause — *"the terminal remaining usable while awaiting an asynchronous decision"* — is unmet, so **COMPLETE cannot be claimed** |
| **FR-SEC-033** [M] | **COMPLETE (substrate)** | Approver, timestamp, decision and comment recorded; immutability DB-enforced by append-only grants and the absence of UPDATE/DELETE policies |
| **FR-SEC-016** [M] | **PARTIAL** | The blocking mechanism is real and DB-enforced, but of the four named combinations only cash variance gains a consumer (later); requisitions and discounts have no domain, and strict-SoD does not exist |
| **FR-FIN-006** [M] | **NOT IMPLEMENTED — substrate enabled** | Wholly P1G-1's. This slice makes it reachable; it implements none of it |

**Cash-variance consumer** (after a future P1G-1, and stated as prediction, not claim): FR-FIN-006 would reach **COMPLETE** only if the variance-tolerance source also exists (§20), since the requirement is *"beyond a **configurable** tolerance"*. FR-SEC-016 would advance for the cash-variance combination only, remaining PARTIAL system-wide.

**Not claimed anywhere:** that `FR-SEC-034` (escalation), `FR-SEC-035` (offline approval policy), `FR-AUD-008`, or GAP-11 are addressed. They are untouched.

---

## 20. IMPLEMENTATION READINESS

| Item | Classification |
|---|---|
| Both tables owned by Governance; table names | **SOURCE-DECIDED** (SRS §7.3 #36, §25.1) |
| P-1 direct linkage; `request_type` type/constraint; `required_permission` code + no FK; no DELETE; append-only decisions; lifecycle; `decision`/`status` roles; one final decision; `value` `JSONB NOT NULL` + minor-unit strings; sync PIN in scope; excluded approver = USER id, DB-enforced | **RATIFIED** (2026-08-29) |
| Expiry boundary `decided_at <= expires_at` permitted | **RATIFIED** (D-10 E2 / clause 3) |
| `status='pending'` not a fifth INSERT conjunct; CAS on the D-9 U4 UPDATE policy | **RATIFIED** (D-15 cl. 9; D-9 U4) |
| Exact RLS SQL; excluded-approver column name; no FK on user columns; index set; CHECK constraints | **DESIGN-DECIDABLE NOW** — §5, §10 |
| Identity contract name, token, signature, own-transaction exception, permission projection | **DESIGN-DECIDABLE NOW** — §3 |
| Governance contract files, typed errors, module wiring | **DESIGN-DECIDABLE NOW** — §14 |
| `value` TypeScript type (`Prisma.InputJsonValue` / `JsonValue`) | **DESIGN-DECIDABLE NOW** — §6 |
| Transaction order, `ON CONFLICT DO NOTHING`, affected-row assertion | **DESIGN-DECIDABLE NOW** — §9 |
| Audit actions/entities; extending `AuditEvent` | **DESIGN-DECIDABLE NOW** — §13 |
| Permanent-id replay/conflict semantics | **DESIGN-DECIDABLE NOW** (precedent) — §16 |
| Fail-closed when the owner Employee has no linked User | **DESIGN-DECIDABLE NOW** (Inventory precedent) — §15 |
| Whether `FR-OFF-015` *mandates* client ids for approvals | **NOT SOURCE-DECIDABLE** — §21.3 does not list approvals. Adopted on precedent, not claimed as mandate |
| Literal `request_type` value for cash variance | **NOT SOURCE-DECIDABLE** — P1G-1's gate. **Not migration-critical** (§4) |
| `entity_type` value for CashSession | **NOT SOURCE-DECIDABLE** — P1G-1's gate. Not migration-critical |
| Expiry **default duration** / who chooses it | **NOT SOURCE-DECIDABLE** — dissolved by making `expiresAt` mandatory (§12) |
| Variance tolerance / settings source | **BLOCKED OUTSIDE THIS SLICE** — P1G-1's nearest blocker |
| D-12 escalation; async `FR-SEC-032`; notifications; Governance read surface; GAP-11 | **BLOCKED OUTSIDE THIS SLICE** |
| **USER RATIFICATION REQUIRED** | **NONE** |

**No migration-critical item remains `USER RATIFICATION REQUIRED`**, so a Sonnet implementation prompt is permissible. It is **not issued in this report**, which is a design gate; it should be issued as the next step (§22).

---

## 21. NON-GOALS — CONFIRMED NOT DESIGNED

P1G-1 / CashSession close · variance tolerance & settings · denomination catalogue · X report · Shift close · Day Close · D-12 escalation · `approval_steps` · asynchronous approval · notifications · any Governance HTTP or read surface · Receipt · Fiscal · KDS · refunds · procurement · expenses · branch-RBAC redesign · offline sync · NFR-PERF-006.

**Also confirmed:** no product implementation, **no migration (32 not created)**, no register edit in this task, no commit, no push, no D-21+, no destructive git command; the working-tree register (carrying the uncommitted ratification) was used as authority and left untouched.

---

## 22. FINAL VERDICT

## **A. APPROVAL RUNTIME IMPLEMENTATION READY**

Every migration-critical question is **RATIFIED** or **DESIGN-DECIDABLE NOW**; the residual **NOT SOURCE-DECIDABLE** items (the literal `request_type` and `entity_type` values for cash variance) are **P1G-1's**, not this slice's, and the runtime is fully generic without them. The two items the brief flagged as potential blockers both resolve without ratification: the expiry inequality is settled by D-10's own ratified text, and the `Employee.user_id` nullability is answered by PIN authentication's existing refusal plus a fail-closed guard that never weakens the fourth conjunct.

**Recommended next step:** a **Sonnet implementation prompt** for migration 32 and the runtime, scoped to §§3–18, with the §17 matrix as the acceptance bar and the `test/inventory.e2e-spec.ts:644-649` tripwire explicitly listed for deliberate update. The **variance-tolerance / settings** decision remains independent and can proceed in parallel; it, not the approval mechanism, is P1G-1's nearest blocker.

**No commit. No push. No implementation authorized by this gate.**

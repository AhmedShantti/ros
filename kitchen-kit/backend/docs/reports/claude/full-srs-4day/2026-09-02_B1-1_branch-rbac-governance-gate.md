# B1-1 — Governance Gate: Reopen D-2 for Branch-Scoped RBAC

| Field | Value |
|---|---|
| **Task / Slice** | `B1-1` — GOVERNANCE GATE: reopen D-2 for branch-scoped RBAC |
| **Lane** | B — Security + Platform + Audit |
| **Programme** | ROS Full-SRS 4-Day Execution (P2-SEC, priority 1, merge wave 1) |
| **Report type** | GOVERNANCE ANALYSIS / DECISION BRIEF |
| **Authority** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. Where this report disagrees with the SRS or a ratified governance decision, the SRS and the register win. **This report ratifies nothing and authorises nothing.** The decision brief in §14 is a *proposal*; it has **not** been inserted into the register. |
| **Date** | 2026-09-02 |
| **Baseline HEAD** | `63d3b7c2ea5f999bb9ba7277d51a5da3c6950a71` |
| **Resulting HEAD** | recorded in §17 (this report + one INDEX row only) |
| **Branch** | `full-srs/lane-b-security-platform` |
| **Working tree at start** | Clean (`git status --porcelain` empty) |
| **Working tree at end** | This report + one appended INDEX row. **No product code, no schema, no migration, no route, no permission, no governance-register change.** |
| **Task identifier** | `P2-SEC / B1-1` |
| **Mode** | Analysis only. No implementation performed. No push. No deploy. |

---

## 0. Executive Summary

**A governance change IS required.** `FR-SEC-002`, `FR-SEC-003`, `FR-SEC-004` [all M] and
`FR-SEC-005` [S] are **NOT IMPLEMENTED** and are **blocked by D-2**, which was ratified
2026-08-17 as **CORE ONLY** and whose broader branch-scoped-RBAC deferral has been
**explicitly re-affirmed as still in force** at every subsequent governance checkpoint,
most recently in the **DAY CLOSE** ratification of 2026-08-31.

The current defect is precisely stated: **within a tenant, any principal holding a
permission can exercise it on every branch of that tenant.** There is no branch dimension
anywhere in the authorization path. `identity.membership_roles.branch_id` exists, is
**never written by any code path** and **never read by any authorization path**.
`organisation/branch-scope.ts::assertBranchInScope` — the only thing named "branch scope"
in the codebase — resolves a branch **inside the caller's RLS context** and answers
*"is this branch visible to my tenant?"*. It never asks *"may this actor act on this
branch?"*. It is a tenant-safety helper, correctly built for that purpose, and it is
**not** an authorization control.

Three corrections to the P0 execution board's predicted shape are argued below and are
the substantive findings of this slice:

1. **The `scope_type` / `scope_id` polymorphic column pair predicted by P0 is NOT the best
   model for this repository.** A polymorphic `scope_id` cannot carry a foreign key, which
   would reintroduce exactly the "recorded UUID with no FK" defect that the 2026-08-19
   D-2 amendment fixed for `Terminal.branch_id`, and would violate the ADR 0008 D-09
   tenant-safe composite-FK convention. **Typed, individually FK'd nullable scope columns
   under a CHECK constraint** are recommended instead. (§11)
2. **A permitted-branch list SHOULD NOT be placed in the JWT access token.** The
   repository's access token deliberately carries **no** authorization data
   (`auth.types.ts`: *"No permissions, no tenant data — authorization is resolved
   server-side per request, not carried in the token"*). A branch-list claim would be
   unbounded for multi-branch managers, would be stale for the whole access-token TTL
   after a revocation, and would directly conflict with `FR-SEC-028`'s *immediate*
   invalidation requirement. This creates a **genuine, explicit conflict with the literal
   text of `FR-API-012`**, which is a `[M]` requirement and is therefore escalated as a
   **decision the user must make**, not a decision this report may take. (§6)
3. **The B1-2/B1-3 boundary in the execution board is materially incomplete.** It omits
   (a) the `@@id([membershipId, roleId])` primary-key change, which is a table-identity
   migration and not an additive column; (b) the **missing `UPDATE` RLS policy** on
   `identity.membership_roles`, which makes `FR-SEC-005` expiry-by-update **impossible at
   runtime** as the table stands; and (c) the retirement or explicit retention of the
   **Internal-MVP single-active-branch fail-closed posture** now embedded in Reporting and
   Day Close. (§12)

**B1-2 must not start before the user ratifies a D-2 reopening.**

---

## 1. Objective and Method

**Objective.** Determine exactly what D-2 must change in order to unblock `B1-2` and
`B1-3` for true branch-scoped RBAC, and prepare the minimum governance decision text
required — without ratifying it, without touching the register, and without writing
product code.

**Method.** Read the exact SRS requirement text as recorded in the P0 traceability CSV
(the SRS PDF's own wording, quoted verbatim below); read `D-2` and every amendment and
cross-reference to it in the 8,065-line governance register; read the identity and
organisation source, schema, migrations and RLS policies at HEAD `63d3b7c`; then evaluate
the three candidate authorisation models against that evidence.

**What was NOT done, by instruction:** no product code, schema, migration, route or
permission change; no modification of `GOVERNANCE_DECISION_REGISTER.md`; no ratification;
no push; no deploy; no test execution (this is an analysis slice — **no test results are
reported in this document, and none were produced in this session**).

---

## 2. SRS Requirements — verbatim

Quoted from the P0 traceability extract of `ROS_SRS_v1.0.pdf` at HEAD. Priority markers
`[M]` mandatory / `[S]` should are the SRS's own.

| ID | Pri | §  | Verbatim requirement text |
|---|---|---|---|
| **`FR-SEC-002`** | **[M]** | 15.1 (p.90) | *"Role assignments SHALL carry a scope, restricting the assignment to a tenant, a brand, a set of branches, or a single branch."* |
| **`FR-SEC-003`** | **[M]** | 15.1 (p.90) | *"A user MAY hold multiple role assignments with different scopes — for example, Branch Manager at Branch 1 and Cashier at Branch 2."* |
| **`FR-SEC-004`** | **[M]** | 15.1 (p.90) | *"Where multiple assignments apply, effective permissions SHALL be the union of granted permissions within each assignment's own scope. Permissions SHALL NOT leak across scopes."* |
| **`FR-SEC-005`** | **[S]** | 15.1 (p.90) | *"Role assignments SHALL support validity dates, enabling temporary elevation (covering a manager's leave) that expires automatically."* |
| **`FR-API-012`** | **[M]** | 26.4 (p.151) | *"Tokens SHALL carry: subject, tenant, scope set, and permitted branch set. Every request SHALL be authorised against both the permission and the scope."* |

### Directly relevant, already-satisfied or already-partial requirements

| ID | Pri | Status at HEAD | Verbatim / substance |
|---|---|---|---|
| `FR-SEC-001` | [M] | **COMPLETE** | *"…role-based access control where permissions are granted to roles and roles are assigned to users."* |
| `FR-SEC-045` | [M] | **COMPLETE** | *"Every API endpoint SHALL enforce authorisation server-side. Client-side permission checks are presentation only and SHALL NOT be relied upon."* |
| `FR-SEC-021` | [M] | **COMPLETE** | *"PIN authentication SHALL be valid only on registered terminals within the employee's permitted branches, and SHALL NOT grant access to the web dashboard."* |
| `FR-SEC-022` | [M] | **COMPLETE** | *"PINs SHALL be stored as salted hashes, SHALL be unique within a branch, and SHALL be subject to lockout after a configurable number of failures."* |
| `FR-SEC-028` | [M] | **COMPLETE** | *"Terminals SHALL be individually registered, and the System SHALL support revoking a terminal's registration, **immediately invalidating its credentials**…"* |
| `FR-HRM-001` | [M] | **PARTIAL** | Employee record incl. *"home branch, permitted branches"*. |
| `FR-HRM-005` | [M] | **PARTIAL** | *"Employees SHALL be assignable to multiple branches with a designated home branch…"* |
| `FR-PLT-012` | [M] | **COMPLETE** | Request reaching the data layer without resolved tenant context **fails closed**. |
| `FR-PLT-013` | [M] | **PARTIAL** | Cross-tenant isolation suite, *"generated, not hand-written"*; no CI pipeline exists. |
| `FR-BRN-005` | [M] | **PARTIAL** | *"branch groups (regions, clusters, franchise territories) as a reporting and **permission-scoping** dimension."* |
| `FR-SEC-010` | [M] | **NOT IMPLEMENTED** | Predefined roles shipped for immediate use. §15.3 states the *"full catalogue is maintained in Appendix C"*. |

### Appendix C

**SRS Appendix C is referenced by §15.3 and is ABSENT from the delivered SRS** (P0
signal **SIG-03**, recorded UNRESOLVED). The repository's 40 permission codes in
`identity/authz/permissions.constants.ts` were therefore **authored from SRS prose, not
derived from the catalogue** — the file records this itself, and one code
(`settings.branch.read`) is marked *"invented (provisional)"* in
`docs/organisation/authorization.md`.

**Consequence for this slice, stated as a hard constraint:** the permission *catalogue*
must not be invented, extended, re-derived or re-classified by B1-1, B1-2 or B1-3. In
particular, **no permission code may be classified as "tenant-only" or "branch-only" on
the strength of a missing appendix.** The scope model recommended below deliberately
avoids requiring any such classification (see §5, model **C-1**, and §11, migration
option **M-3** which is rejected precisely because it would require one). §15.3's "Scope
column on every standard role" is cited by ADR 0008 D-02 but cannot be reconstructed
without Appendix C, so `FR-SEC-010` remains out of scope here.

---

## 3. Governance — what D-2 actually says

Source: `docs/governance/GOVERNANCE_DECISION_REGISTER.md` at HEAD `63d3b7c` (8,065 lines).

### 3.1 The ratified text (register lines 105–113) — verbatim

> **RATIFIED 2026-08-17 — Option (a): CORE ONLY.**
> The synchronous half of `FR-SEC-032` (manager PIN on the terminal) and the
> asynchronous half (push notification) are both **OUT OF SCOPE** for the first
> Governance phase. PIN authentication (`FR-SEC-021`, `FR-SEC-022`) and
> branch-scoped RBAC (`FR-SEC-002`, ADR 0008 D-02) are **NOT** pulled into scope.
> **`FR-SEC-032` is consequently NOT satisfied and must be recorded as knowingly
> unmet.** The Governance phase MUST NOT be reported complete on the strength of
> the approval model alone.

D-2's own **SRS Evidence** block cites `FR-SEC-002` [M] as *"role assignments carry a
scope — tenant, brand, branch-set, or single branch"*, and its **Existing Repository
Evidence** block records: *"`identity.membership_roles.branch_id` exists but is never
read; `src/modules/identity/context/tenant-context.ts:11` records it as 'RESERVED — not
populated this phase'. ADR 0008 D-02 deferred branch-scoped RBAC."*

D-2's **Scope Impact** block states what a reopening costs: *"If (b) or (c):
authentication (new PIN credential type, lockout), **authorization (branch-scoped
assignment resolution, reopening ADR 0008 D-02)**, database (`identity` schema changes),
and a materially larger test surface."*

### 3.2 Amendment — D-2 REOPENED IN PART (2026-08-19)

Recorded by explicit user governance action. The ratified text above is *"unchanged, not
reinterpreted, and not deleted."* The defer was lifted for **exactly four items**:
(1) Employee ↔ User linkage; (2) permitted / home branch substrate; (3) tenant-safe
`Terminal → Branch` binding (a composite FK replacing an unenforced UUID); (4)
`FR-SEC-021` / `FR-SEC-022` PIN behaviour in full, plus `FR-SEC-028` to the extent
`FR-SEC-021` relies on *"registered"*.

The amendment then states, verbatim, what stays deferred — **this is the exact text B1-1
must reopen**:

> **Defer REMAINS IN FORCE for everything else**, explicitly:
>
> - **Broader branch-scoped RBAC** — `FR-SEC-002` / `FR-SEC-003` / `FR-SEC-004`
>   general scope resolution stays deferred. Only the branch check `FR-SEC-021`
>   itself requires is lifted; **permission resolution is not made branch-aware by
>   this amendment.**

### 3.3 Every other reference to D-2 in the register

| Register locus | What it says about branch-scoped RBAC |
|---|---|
| L4109 (D-19 / audit analysis) | *"**D-2** — branch-scoped RBAC deferred, so `FR-SEC-004` scope mechanics are **not reopened here**"* |
| L4157 / L4198 (`FR-AUD-008`) | *"Branch-scoped users — **NOT RESOLVED.** `FR-AUD-008` names branch as a **filter** dimension, **not** as a restriction. **D-2 deferred branch-scoped RBAC**"* |
| L4595, L4938 (carried-open lists) | *"**D-2 deferred branch-scoped RBAC**"* — carried forward as an open item |
| L5064 (P0 preservation) | *"**D-2 is amended separately and only in part** — see the amendment recorded under D-2"* |
| L5311 (P1C preservation) | *"**D-2's broader branch-scoped RBAC defer stands.**"* |
| L5328–5356 (**CARRIED ITEM P1D-A**) | Narrow reopening of D-2's **Workforce domain** deferral for Operational Shift only, closing with: *"**D-2's branch-scoped RBAC deferral is untouched.** This item reopens the Workforce *domain* defer only, and only as far as stated."* |
| L2467 (`FR-API-012` row) | *"`FR-API-012` token carries subject, tenant, scope set, **permitted branch set** — [M] — Branch scope deferred (ADR 0008 D-02; D-2 kept it out)"* |
| **Register tail — MINIMUM REPORTING ratification** | The **branch fail-closed posture** (explicit `branchId`; tenant-visible branch or tenant-safe 404; **exactly ONE active branch**, zero ⇒ denied, >1 ⇒ denied as unsupported) is *"an **implementation consequence, NOT a fourth ratification** — it grants nothing, and **D-2's branch-scoped RBAC defer is UNCHANGED**, `FR-SEC-002`/`003`/`004` remaining **NOT IMPLEMENTED**"* |
| **Register tail — DAY CLOSE ratification (2026-08-31)** | *"**D-2's branch-scoped RBAC defer remains IN FORCE and `FR-SEC-002`/`003`/`004` remain NOT IMPLEMENTED**"*; and of `DC-R3`'s `report.view.financial` extension: *"the code **carries no branch scope**"* |

### 3.4 Related decisions inspected

| Decision | Bearing on this gate |
|---|---|
| **D-3** — approval authority is **permission-based** (RATIFIED IN PART) | Binding: authority must be expressed as a permission, never a role-name string (re-stated in **P1A CLARIFICATION C**: *"Do NOT hardcode role-name strings… Do NOT invent a generic 'manager correction' permission."*). A scoped model must therefore scope the **assignment**, not introduce role-name logic. |
| **D-9 (S1 + N1 + U4)** — Governance RLS / tenant isolation | Confirms tenant RLS is the tenant boundary; contains no branch predicate. |
| **D-11** — notifications: strict none | Untouched. |
| **D-2 amendment items 2–4** — PIN, permitted branches, terminal FK | **Already shipped.** `EmployeeBranch`, `Employee.homeBranchId`, and the composite `Terminal → Branch` FK exist. This is the substrate B1-2 builds on and must not duplicate. |
| **P1D-A** — narrow Workforce reopen (Shift) | Precedent for the *form* of a narrow D-2 reopening; explicitly does **not** touch branch RBAC. |
| **ADR 0008 D-02** — RATIFIED as DEFERRED (2026-08-15) | The technical twin of D-2's defer. **It must be superseded by its own ADR**, by its own terms (below). |
| **ADR 0002 / ADR 0004** | Both deferred branch scope *"until the org/branch context and SRS branch rules are available"*. ADR 0008 records that Phase 15 **satisfied that precondition**, making the continued deferral *"a conscious re-decision rather than an inherited default."* |
| **RPT-R1 / RPT-R2 / RPT-R3, DC-R1 / DC-R2 / DC-R3** | Carry the Internal-MVP **single-active-branch** posture that B1-3 must retire or explicitly retain (§12). |

### 3.5 ADR 0008 D-02 — the technical deferral, verbatim on the points that matter

> **Status: RATIFIED as DEFERRED** (2026-08-15). … **Branch-scoped RBAC is NOT implemented
> in Phase 15.** … `TenantContext.branchId` remains declared and **unpopulated**;
> `membership_roles.branch_id` remains present and **unconsumed**; `PermissionGuard` and
> `TenantContextService` are not modified. … Scope-aware RBAC receives **its own phase, its
> own ADR superseding the relevant parts of ADR 0002 and ADR 0004, and its own security
> review.**

> **This must not be implemented accidentally in Phase 15.** Concretely … no code may:
> populate `TenantContext.branchId`; read `membership_roles.branch_id` in any authorization
> path; add a branch parameter to `PermissionGuard`, `@RequirePermission`, or
> `TenantContextService.require`; or introduce a per-branch permission check in an
> Organisation service.

> **Security implications.** This is a knowingly accepted **intra-tenant** authorization
> gap: within one tenant, a principal holding `settings.branch.manage` can mutate **every**
> branch, not only the branches they operate. It is **not** a cross-tenant gap…

> Additionally the shipped primary key blocks the full model outright:
> `@@id([membershipId, roleId])` permits one row per membership+role, so **FR-SEC-003's own
> worked example ("Branch Manager at Branch 1 and Cashier at Branch 2") is only
> half-representable and "Cashier at Branch 1 and Cashier at Branch 2" is not representable
> at all. Fixing that is a change to the RBAC table's identity, not an additive column.**

> **Tenant/RLS implications.** None. All Organisation RLS anchors on `app.tenant_id` only.
> No branch predicate enters any policy this phase, so the later introduction of branch
> scoping is **additive at the policy layer** rather [than a rewrite].

### 3.6 Determination

| Question | Determination |
|---|---|
| **What did D-2 ratify?** | Option (a) **CORE ONLY** for the first Governance phase: the approval request/decision model only. It **excluded** both halves of `FR-SEC-032`, and it **declined to pull in** PIN authentication and branch-scoped RBAC. |
| **What was explicitly deferred?** | Branch-scoped RBAC as a whole (`FR-SEC-002` via ADR 0008 D-02), PIN authentication, and both halves of `FR-SEC-032`. |
| **What did the later amendment change?** | The **2026-08-19 amendment** lifted the defer for exactly four items — Employee↔User linkage, permitted/home-branch substrate, the tenant-safe Terminal→Branch FK, and `FR-SEC-021`/`022` PIN behaviour (with `FR-SEC-028` as far as "registered" requires). **All four are shipped.** **P1D-A (2026-08-20)** additionally reopened D-2's *Workforce domain* defer narrowly, for Operational Shift only, and stated in terms that the branch-RBAC deferral was untouched. |
| **What remains blocked?** | **`FR-SEC-002`, `FR-SEC-003`, `FR-SEC-004` [M] and `FR-SEC-005` [S]** — general scope resolution. Consequentially **`FR-API-012` [M]** (its scope-set / permitted-branch-set clause and its "authorised against … the scope" clause). The amendment's own words: *"permission resolution is not made branch-aware by this amendment."* Re-affirmed as recently as the **DAY CLOSE ratification of 2026-08-31**. |
| **Is a governance change required to start B1-2?** | **YES.** Both D-2's amendment text and ADR 0008 D-02's prohibition list forbid, by name, every change B1-2 must make. |

---

## 4. Current Source — what exists at HEAD `63d3b7c`

*Read-only inspection. Nothing in this section was modified.*

### 4.1 Identity persistence

| Model | File | Shape relevant to branch scope |
|---|---|---|
| `Membership` | `prisma/schema.prisma:268` | `id` PK, `userId`, `tenantId`, `status`. `@@unique([userId, tenantId])`, `@@index([tenantId])`. **No `@@unique([tenantId, id])`** — so no composite tenant-safe FK can currently target it. |
| `Role` | `:294` | `tenantId` **nullable** (NULL = platform/system role). `@@unique([tenantId, name])`. Roles carry **no scope column**. |
| `Permission` | `:314` | Global, keyed by dot-notation `code`. **40 codes**, authored (Appendix C absent). |
| `RolePermission` | `:328` | `@@id([roleId, permissionId])`. |
| **`MembershipRole`** | **`:341`** | **`@@id([membershipId, roleId])`** — the blocking key. `branchId String? @map("branch_id")`, commented *"Optional branch scoping carried from the approved user_roles design; **not yet consumed by permission resolution**"*. **No `tenantId`. No `valid_from` / `valid_to`.** |
| `Terminal` | `:383` | `branchId` with a **composite tenant-safe FK** `(tenantId, branchId) → Branch(tenantId, id)`, `onDelete: Restrict` — added by the D-2 amendment. `status: active \| disabled \| revoked`. |
| `Employee` | `:1667` | `userId String? @unique` (at most one User; NULL = cannot sign in), `homeBranchId` with composite FK, `status: active \| suspended \| terminated`. `@@unique([tenantId, id])` **present**. |
| `EmployeeBranch` | `:1717` | `(tenantId, employeeId, branchId)`, `@@id([employeeId, branchId])`, composite FKs to both. Doc comment: *"It is **authentication integrity only** — it does NOT grant permissions and does NOT implement FR-SEC-002/003/004 branch-scoped RBAC, which D-2 still defers."* |
| `Branch` | `:608` | `(id, tenantId, brandId, code, timezone, status: active \| …)`, composite FK to `Brand`. |
| `Brand` | `:582`, `Warehouse` `:674` (`branchId` **nullable**), `CentralKitchen` `:699` (tenant-level), `Location` `:2856` (`branchId` nullable) | Bear on §8 scope-type selection. |

### 4.2 Authorization path

`JwtAuthGuard` (401) → `TenantContextGuard` (403) → `PermissionGuard` (403) → controller →
service → Prisma → RLS. (ADR 0008, *"Preserved architecture (non-negotiable)"*.)

- **`AccessTokenPayload`** (`identity/auth/auth.types.ts`) — `sub`, `sid`, `tid?`, `mid?`,
  `trm?` (bound terminal), `emp?` (employee behind a POS session), `typ?: 'pos'`, `iat`,
  `exp`. Its own header comment: ***"Minimal access-token payload. No permissions, no
  tenant data — authorization is resolved server-side per request, not carried in the
  token."*** **There is no scope claim and no branch claim.**
- **`TenantContext`** (`identity/context/tenant-context.ts`) — declares
  `branchId?: string` with the comment ***"branch scope (RESERVED — not populated this
  phase; …) … Branch-level authorization is deferred"***. Verified: **never populated**.
- **`TenantContextService.resolve`** — *"The single authoritative resolver."* One
  `withAuthContext` query walks `Membership → MembershipRole → Role → RolePermission →
  Permission` and flattens **every** permission code into a single flat
  `ReadonlySet<string>`, memoized at `request.authorization`. **`membershipRole.branchId`
  is not selected. There is no scope dimension in the result type at all.**
- **`PermissionGuard`** — reads `@RequirePermission` metadata (`codes`, `mode: 'all' | 'any'`)
  and tests membership of that flat set. **It has no branch parameter and no branch
  awareness**, exactly as ADR 0008 D-02 mandates.
- **`MembershipRolesService.assign`** — `tx.membershipRole.upsert({ … create: { membershipId, roleId } })`.
  **`branchId` is never written.** Verified by grep across `src`: no code path anywhere
  assigns or reads `membershipRole.branchId`.

### 4.3 Tenant / RLS context

`PrismaService.withAuthContext(scope, fn)` is *"the ONE mechanism"* establishing DB
context, via a single transaction-local
`SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)`.
Policies read `NULLIF(current_setting('app.tenant_id', true), '')::uuid` so missing
context yields `NULL` → false → **fail closed** (`FR-PLT-012`, COMPLETE/VERIFIED).
**There is no `app.branch_id` and no branch predicate in any policy.**

**Finding — `identity.membership_roles` RLS has no `UPDATE` policy.**
`prisma/migrations/20260812145207_identity_rls/migration.sql:105–130` creates
`membership_roles_select`, `membership_roles_insert` and `membership_roles_delete` only,
under `ENABLE` + `FORCE`. Under FORCE with no `UPDATE` policy, **every `UPDATE` on this
table is denied to the runtime role.** Consequence: **`FR-SEC-005` revocation-by-setting-
`valid_to` is impossible at runtime as the table stands.** B1-2 must add an `UPDATE`
policy (with both `USING` and `WITH CHECK`), or revocation must remain `DELETE`-shaped.
The board does not mention this. It is a **hard, verified blocker inside B1-2's scope.**

Also note the policies derive tenancy through an `EXISTS` join to `identity.memberships`
because `membership_roles` carries **no `tenant_id` of its own** — relevant to §11.

### 4.4 Everything currently called "branch scope"

| Helper | File | What it actually does |
|---|---|---|
| **`assertBranchInScope(tx, branchId)`** | `src/modules/organisation/branch-scope.ts` | `tx.branch.findUnique({ where: { id } })` inside the caller's RLS context; throws `404` if not found. Its own doc: *"A branch belonging to another tenant is invisible under RLS, so this yields 404 rather than 403 and a foreign branch id cannot be probed for existence."* **It is a tenant-visibility + non-enumeration control. It contains no actor, no permission and no authorization.** Called from **4 services** (tables, print-routing, station-routing, operating-hours). |
| **`BranchReportingScopeQuery.operativeBranches`** | `organisation/contract/branch-reporting-scope.query.ts`, impl `…/branches/branch-reporting-scope.query.service.ts` | Returns ids of `status = 'active'` branches in the tenant, capped at `limit`. Its own doc: *"This is **NOT branch-aware RBAC** and does **NOT reopen D-2**. `operativeBranches` reads a **TENANT-SHAPE fact** (`org.branches.status`), never a principal's scope."* Used by `daily-trading-report.service.ts` and `day-close.service.ts` to enforce **0 ⇒ 403, 1 ⇒ continue, >1 ⇒ 403 unsupported**, with the supplied `branchId` required to equal the sole active branch. |
| **`PinService`** (`identity/employees/pin.service.ts:298–324`) | | The **only** true branch check in the codebase: terminal must be `status === 'active'`; the employee's `EmployeeBranch` set must contain `terminal.branchId`; otherwise a uniform `UnauthorizedException`. This satisfies `FR-SEC-021` at **authentication** time. It does **not** constrain what the resulting session may then do — `pin.service.ts:440–470` resolves *"the same **TENANT-scoped** set a dashboard session gets"*, which its own comment states explicitly *"leaves the D-2 deferral untouched."* |

### 4.5 Blast radius — routes that take a branch

- **20 controller routes carry an explicit `:branchId` path parameter**, across
  `organisation`, `catalogue`, `treasury` (incl. `day-close`, `cash-close-policy`),
  `reporting` and `identity/terminals`.
- **10 further DTO files accept a `branchId` in the request body** (`sales`,
  `production`, `inventory` via its controller, `treasury`, `catalogue`, `reporting`,
  `organisation/warehouses`, `identity/terminals`).
- **`assertBranchInScope` is called from only 4 of these paths.**

**The gap between "20 + 10 branch-taking surfaces" and "4 tenant-visibility checks" is the
measured size of B1-3.**

### 4.6 Current security defect — stated precisely

> **Tenant isolation is intact. Branch isolation does not exist.**
>
> A principal authenticated into tenant *T* with a role granting permission *P* may
> exercise *P* against **every branch of *T***, because:
> 1. no role assignment carries a scope (`membership_roles.branch_id` is never written);
> 2. permission resolution flattens all assignments into one unscoped set;
> 3. `PermissionGuard` has no branch parameter;
> 4. the only branch helper on the request path (`assertBranchInScope`) tests **tenant
>    visibility**, and every branch of *T* is tenant-visible to every member of *T*;
> 5. RLS anchors on `app.tenant_id` alone.
>
> This is an **intra-tenant** authorization gap, already documented as knowingly accepted
> in `docs/organisation/authorization.md` (*"KNOWN GAP — authorization is tenant-scoped
> only … any principal holding `settings.branch.manage` can mutate **every** branch"*) and
> in ADR 0008 D-02. It is **not** a cross-tenant gap.
>
> It is currently **masked, not fixed**, by the Internal-MVP posture: Reporting and Day
> Close refuse outright unless the tenant has **exactly one active branch**. **That mask
> disappears the moment a pilot tenant activates a second branch** — which is precisely
> the multi-branch pilot/production posture this programme targets.

---

## 5. Design Question — branch-authorisation model

### 5.1 The three candidate models

| | Model | Shape |
|---|---|---|
| **A** | **Scoped role assignment** | The assignment itself carries a scope (`TENANT` / `BRAND` / `BRANCH`). Effective permissions are computed **per scope**. |
| **B** | **Tenant-level roles + permitted-branch filter** | Assignments stay unscoped; a separate user↔branch relation intersects the resulting permission set. |
| **C** | **Hybrid** | Role-assignment scope **plus** employee/user permitted-branch assignments. |

### 5.2 Evaluation

| Criterion | **A** | **B** | **C** |
|---|---|---|---|
| **`FR-SEC-002`** *"Role assignments SHALL carry a scope"* | **Satisfied — literally.** The requirement is about the *assignment*. | **Fails.** The assignment carries no scope; the requirement's subject is not modelled. | **Satisfied** (via its A component). |
| **`FR-SEC-003`** *"Branch Manager at Branch 1 and Cashier at Branch 2"* | **Satisfied** once the PK admits multiple scoped rows. | **Structurally impossible.** One tenant-level role set ∩ one branch set cannot express *different roles at different branches*. | **Satisfied.** |
| **`FR-SEC-004`** *"union **within each assignment's own scope**. Permissions SHALL NOT leak across scopes."* | **Satisfied.** Non-leakage is definable only when a scope is attached to an assignment. | **Fails by construction.** Under B, the Cashier permissions granted "for Branch 2" apply at Branch 1 too — that **is** the leak the clause prohibits. | **Satisfied.** |
| **`FR-SEC-005`** effective dating | Natural — `valid_from`/`valid_to` on the assignment row. | Ambiguous — dates on the role, the branch link, or both? | Natural. |
| **Employee multi-branch assignment (`FR-HRM-005`)** | Orthogonal; `EmployeeBranch` retained unchanged. | Conflates authorization with HR assignment. | **Correctly separated** — this is C's whole point. |
| **PIN login (`FR-SEC-021`/`022`)** | Unaffected; already shipped. | Would tempt reuse of `EmployeeBranch` as an authorization source — **a privilege-escalation surface**: an HR clerk adding a branch to an employee would silently grant authority there. | **Explicitly forbids** that reuse. |
| **Dashboard users with no Employee row** | Works — authorization hangs off `Membership`. | **Breaks.** A user with no `Employee` has no permitted-branch set, so under B they get *nothing* (or, worse, *everything* via a fail-open default). | **Works** — the same as A. |
| **API keys / machine clients later (`B2-5`, `FR-API-011/014`)** | Clean: a key is another principal carrying scoped grants. | Poor: machine clients are not employees and have no branch set. | Clean. |
| **Least privilege** | Strong. | Weak — coarse intersection only. | Strong. |
| **Auditability** (`FR-AUD-006`: *role changes*) | One row = one grant = one audit fact, with its scope. | Two independent tables must be correlated to explain any grant. | Same as A. |
| **Query complexity** | One extra grouping over the **same single query** `TenantContextService` already runs. | Two queries or a join; then an intersection. | Same as A. |
| **Token size / staleness** | Neutral — nothing needs to enter the token (§6). | Encourages a branch-list claim, hence staleness. | Neutral. |
| **Revocation** | Delete or expire one row; effective on the **next request** under server-side resolution. | Ambiguous: revoke the role, or the branch link? | Same as A. |
| **RLS boundary** | Untouched; ADR 0008 D-02: *"additive at the policy layer"*. | Untouched. | Untouched. |
| **Frontend contract** | Permissions become **scope-qualified** — a real, breaking contract change requiring a `/me`-style effective-scope surface. | Two flat lists — simpler, but wrong. | Same as A. |
| **Migrations** | **Table-identity change** on `membership_roles` (PK), plus a `tenant_id` column, typed scope columns, and an `UPDATE` RLS policy. | Additive only — cheapest, and the reason it is tempting. | Same as A. |
| **Future central-kitchen / warehouse / branch-group scope** | Extensible: add a scope type + a typed FK column. | Not extensible — the branch set is branch-shaped by definition. | Extensible. |

### 5.3 Recommendation — **Option C, in the constrained form C-1**

> **C-1 — Scoped role assignment is the SOLE source of authorization. `EmployeeBranch`
> remains authentication-integrity substrate ONLY, and NEVER grants, widens or implies a
> permission.**

Concretely:

1. **Authorization** is resolved **exclusively** from `Membership → MembershipRole
   (scoped) → Role → RolePermission → Permission`. This is Option A, and it is the only
   one of the three that satisfies `FR-SEC-002`, `003` and `004` as written.
2. **`EmployeeBranch` / `Employee.homeBranchId`** keep their present, already-shipped
   meaning — `FR-HRM-001`/`005` substrate and the `FR-SEC-021` PIN check — and are
   **never read by permission resolution**. The schema comment already asserts this; C-1
   makes it a **ratified invariant** instead of a comment.
3. For **`pos` sessions only**, the employee's permitted-branch set acts as an additional
   **AND** condition (defence in depth), re-verified per request. **It is never an `OR`
   and never a grant.** Formally:

   ```
   authorised(actor, permission P, branch B) ⟺
       ∃ assignment a ∈ assignments(actor) :
             valid_now(a)
         ∧  P ∈ permissions(role(a))
         ∧  B ∈ covered_branches(scope(a))
       ∧  ( session.typ ≠ 'pos'  ∨  ( B = branch_of(session.trm)
                                      ∧ B ∈ permitted_branches(session.emp) ) )
   ```
   Every conjunct must hold. Absence of any input ⇒ **deny** (§10).

**Why C-1 and not bare A:** because the repository *already ships* an employee
permitted-branch relation built for a different purpose. Left un-adjudicated, the two
relations will drift into a second, informal authorization source — the single most likely
way this design fails in practice. C-1 names the boundary and makes crossing it a
governance violation rather than a refactor.

**Why not B, plainly:** B cannot represent `FR-SEC-003`'s own worked example, and it
violates `FR-SEC-004`'s non-leakage clause **by construction**. It is cheaper only because
it does less than the requirement.

---

## 6. Token Claim Question — verdict on P0's proposal

**P0's execution board proposes:** *"Role assignment scope + permitted-branch claim in the
access token"* (`B1-2`, board row 7).

**Verdict: the role-assignment-scope half is correct. The permitted-branch-JWT-claim half
is NOT recommended, and the conflict it exposes must be decided by the user.**

### 6.1 Evidence against placing branch lists in the JWT

1. **It reverses the repository's stated architecture.** `auth.types.ts` — *"Minimal
   access-token payload. **No permissions, no tenant data — authorization is resolved
   server-side per request, not carried in the token.**"* `TenantContextService` is
   documented as *"The single authoritative resolver … Nothing else reconstructs user →
   membership → tenant."* A branch claim creates a **second** authorization source that
   must then be reconciled with the first on every request.
2. **Staleness directly violates the requirements it is meant to serve.** A revoked scope
   would remain effective for the whole access-token TTL. `FR-SEC-004`'s *"Permissions
   SHALL NOT leak across scopes"* would then hold only *eventually*. `FR-SEC-005`
   auto-expiry would be honoured only *eventually*. **`FR-SEC-028` requires terminal
   revocation to be effective *immediately*** — a cached branch claim cannot deliver that.
3. **Unboundedness.** `FR-BRN-001` [M]: *"an **unlimited** number of branches per brand and
   an **unlimited** number of brands per tenant."* A regional or tenant-wide manager's
   permitted-branch set is therefore unbounded by requirement. Cookie/header limits and JWT
   size are real operational constraints for exactly the users who need the most scope.
4. **The claim is unnecessary for POS terminals — the hard case is already solved.** The
   token carries `trm`; `Terminal.branchId` now has a **composite tenant-safe FK** to
   `org.branches` (D-2 amendment item 3). A POS session's branch is therefore **derivable
   server-side, authoritatively, from data that cannot point at another tenant.** Adding a
   branch claim would duplicate a fact that is already both available and stronger.
5. **The marginal cost of server-side resolution is ~zero.** `TenantContextService` already
   performs exactly one query per request, already memoizes it at `request.authorization`,
   and already walks `membershipRoles`. Adding the scope columns to that same `select` adds
   **no additional round trip**.

### 6.2 The `FR-API-012` conflict — escalated, not decided here

`FR-API-012` [M] has two clauses:

- **Clause 1 (mechanism):** *"Tokens SHALL carry: subject, tenant, **scope set**, and
  **permitted branch set**."*
- **Clause 2 (security):** *"Every request SHALL be authorised against **both the
  permission and the scope**."*

**Clause 2 is the security-bearing half, and C-1 satisfies it IN FULL.** Clause 1
prescribes a *mechanism* that conflicts with `FR-SEC-028`'s immediate-invalidation
requirement and with `FR-BRN-001`'s unbounded branch count. This report will not resolve
an `[M]`-vs-`[M]` tension by reinterpretation. Options, for the user:

| Opt | Strategy | Consequence |
|---|---|---|
| **T-1** | **Literal compliance.** Serialise the full scope set + permitted-branch set into the JWT; authorise from the claim. | `FR-API-012` COMPLETE as written. **Accepts** revocation latency of one access-token TTL (`FR-SEC-028` weakened), unbounded token size, and a second authorization source. **Not recommended.** |
| **T-2** *(recommended)* | **Server-side resolution only.** Token shape **unchanged**. `TenantContextService` resolves scoped assignments per request in its existing single query. | Clause 2 **COMPLETE**. Clause 1 **knowingly deviated**, satisfied by a mechanism that is *strictly stronger* on revocation. `FR-API-012` recorded **PARTIAL — knowingly deviating**, never as complete. |
| **T-3** | **T-2 + advisory, non-authoritative claim.** Carry a bounded hint (e.g. `scv` scope-version integer, or a truncated branch list flagged as advisory) for client UX only; the server never authorises from it. | Clause 2 COMPLETE. Clause 1 arguably addressed in form. **Adds a second field that looks authoritative and is not** — a standing misuse risk. |
| **T-4** | **T-1 + epoch fencing.** Full claim, plus a `scope_epoch` on the membership; any request whose token epoch ≠ current epoch is rejected and forced to re-resolve; hard cap on claim size with overflow ⇒ server-side lookup. | Clause 1 COMPLETE and revocation near-immediate. Costs a DB read of the epoch per request — i.e. **the T-2 query, plus a token that can still overflow.** Strictly more machinery for no security gain. |

**Recommended: T-2.** If the user requires literal `FR-API-012` clause-1 compliance,
**T-4**, never bare T-1. **The user must choose. This is `DECISION REQUIRED — 3` in §14.**

### 6.3 Recommended claim strategy, stated exactly (under T-2)

- **`AccessTokenPayload` is UNCHANGED.** No `scp`, no `brs`, no branch array. `sub`,
  `sid`, `tid`, `mid`, `trm`, `emp`, `typ` remain exactly as they are.
- **`TenantContext` gains a `branchId?` only for `pos` sessions**, derived server-side from
  `trm → Terminal.branchId` — never from a claim, never from the request body. This finally
  populates the field that `tenant-context.ts:11` has reserved since Phase 6.
- **`RequestAuthorization.permissions` changes from `ReadonlySet<string>` to a scope-aware
  structure** — the flat set is exactly what makes non-leakage untestable today. The
  concrete shape is an **implementation detail for B1-2**, not ratified here.
- **No caching layer is introduced.** Per-request resolution, memoized per request. Any
  cross-request cache would reintroduce the staleness that T-2 exists to avoid; if one is
  ever proposed, it needs its own governance decision.
- **Refresh tokens and sessions are untouched.**

---

## 7. RLS vs Authorization

**Stated explicitly, as required:**

> **Tenant RLS answers: *"does this row belong to the tenant?"***
> **Branch authorization answers: *"may this actor act on this branch?"***

These are different questions with different subjects. RLS's subject is a **row**;
authorization's subject is an **actor**. **This report does not propose replacing
application branch authorization with tenant RLS, and C-1 does not weaken tenant RLS in
any respect.**

### 7.1 Should branch restriction additionally be pushed into RLS later?

**Recommendation: NO for B1-2/B1-3. Keep branch authorization in the application layer.
A narrow branch-aware RLS layer MAY be revisited later, under its own ADR and its own
governance decision.** Reasons, all verified at HEAD:

1. **A branch predicate is not universally definable.** `roles`, `permissions`,
   `role_permissions`, `brands`, `central_kitchens`, tenant-level `warehouses`
   (`branch_id` nullable) and most Catalogue master data have **no branch column at all**.
   A "branch RLS" that covers 60% of tables is a false guarantee.
2. **Branch-owned Organisation rows have no `tenant_id`.** `branch-scope.ts` records the
   approved design: stations, tables, operating hours and both routing tables *"carry no
   `tenant_id` — their tenant boundary is the parent branch."* A branch predicate on those
   tables means a **join inside a policy**, evaluated per row.
3. **RLS cannot express `FR-SEC-004`.** *"Union of granted permissions within each
   assignment's own scope"* is a statement about **permission codes per scope**. Encoding
   it in SQL policies means putting the entire RBAC model into the database — a second
   implementation of authorization, guaranteed to diverge from the first.
4. **Tenant-wide roles must still read across branches.** A tenant administrator listing
   all branches is legitimate. A blanket branch predicate would break it, and the
   exceptions would have to be re-encoded in SQL.
5. **`withAuthContext` is the single most security-critical path in the repository.** ADR
   0008 D-02 declined to modify the resolver precisely to avoid cross-tenant risk. Adding
   `app.branch_ids` to the one `set_config` statement that every tenant guarantee depends
   on is a **cross-tenant** risk taken for an **intra-tenant** benefit. That trade is
   backwards.
6. **ADR 0008 D-02 already recorded the correct sequencing:** *"No branch predicate enters
   any policy this phase, so the later introduction of branch scoping is **additive at the
   policy layer** rather than a rewrite."* Deferring it costs nothing later.

### 7.2 If branch-aware RLS is nonetheless pursued later

It would belong **after B1-3**, never inside it, and would require:

- **Migration implications:** a new `app.branch_ids` GUC (a text array, parsed per policy);
  new per-operation policies on an **explicitly enumerated** list of branch-owned
  transactional tables (`orders`, `order_lines`, `cash_sessions`, `cash_movements`,
  `day_closes`, `stock_movements`, `tickets`); backfill of `branch_id` onto any target
  table lacking one; and **the partitioned tables (`orders`, `order_lines`) need policy
  changes replicated across every partition**.
- **Runtime implications:** every `withAuthContext` call site must supply the branch set,
  including background and migration-adjacent paths; a tenant-wide actor implies a
  potentially unbounded array in a GUC; policy-side array containment on every row read
  changes plan shapes on the hottest tables in the system.
- **Verdict:** **LATER, and only as defence in depth behind a working application layer.**
  It must never be offered as a substitute for §5's C-1.

---

## 8. Scope Types

Assessed strictly against what the SRS requires **now** and what the schema already
supports. No type is added because it sounds useful.

| Scope type | Classification | Basis |
|---|---|---|
| **`TENANT`** | **REQUIRED NOW** | Named first in `FR-SEC-002`. It is also the **behaviour every existing assignment has today**, so the migration has nowhere to land without it (§11). Tenant-wide administration (roles, users, brands, tenant settings) is genuinely not branch-shaped. |
| **`BRANCH`** | **REQUIRED NOW** | Named in `FR-SEC-002` (*"a single branch"*). It is the defect. `org.branches` exists with a `(tenant_id, id)` composite key ready for a tenant-safe FK. |
| **`BRAND`** | **REQUIRED NOW** | Named explicitly in `FR-SEC-002` [M]. Omitting it leaves an `[M]` requirement PARTIAL by choice. Cost is near zero: `org.brands` exists, `Branch.brandId` has a composite FK to it, so brand→branch expansion is **one join on an indexed column**. |
| **"a set of branches"** | **REQUIRED NOW — but NOT a scope type** | `FR-SEC-002`'s fourth shape is satisfied by **multiple `BRANCH`-scoped assignment rows** for the same membership+role. This is the correct modelling: it needs no array column, no junction table, and it makes `FR-SEC-003`'s example fall out for free. **It is the direct reason the `@@id([membershipId, roleId])` PK must change.** |
| **`BRANCH_GROUP`** | **FUTURE-COMPATIBLE — NOT NOW** | `FR-BRN-005` [M] names branch groups as *"a reporting and **permission-scoping** dimension"*, but **branch groups do not exist** (PARTIAL; board slice `G3-1`, lane G, wave 3, depends on B1-2). Adding the type before the entity would create an unresolvable scope. The enum and typed-column design (§11) admit it later **additively**. |
| **`WAREHOUSE`** | **UNNECESSARY** | **No SRS requirement scopes a role assignment to a warehouse.** `FR-SEC-002` does not list it. A warehouse's `branch_id` is nullable, so a warehouse scope would be undefined for tenant-level warehouses. Branch scope already covers branch-attached warehouses. |
| **`CENTRAL_KITCHEN`** | **UNNECESSARY** | Same reasoning. `org.central_kitchens` is **tenant-level** (no `branch_id`), so `TENANT` scope already covers it. Re-examine only when the P13-CK cross-branch operating model lands. |
| **`LOCATION`** | **UNNECESSARY** | Sub-branch storage detail; no requirement scopes authority to it. |

**Ratify exactly three now: `TENANT`, `BRAND`, `BRANCH`.** The enum must be
**open for additive extension** and **closed to reinterpretation** — an unknown scope type
read at runtime **denies** (§10, rule R-11).

---

## 9. Employee / User Relationship

### 9.1 The distinction, from the sources

SRS §14 distinguishes an **Employee** (a person in a job) from a **User** (a login).
§7.3 #25 defines the Employee aggregate as *"May link to at most one User."* The 2026-08-19
D-2 amendment shipped exactly this: `Employee.userId String? @unique` — nullable
(an employee who cannot sign in), unique (at most one User).

**The design must not make every User an Employee, and must not make every Employee a
User.** Both directions occur in the delivered schema today.

### 9.2 How the four things interact under C-1

| Concept | Where it lives | Role under C-1 |
|---|---|---|
| **User permissions** | `Membership → MembershipRole (scoped) → Role → …` | **The sole authorization source.** Hangs off `Membership`, which requires a `User` and a `Tenant` — **not** an `Employee`. A back-office user with no `Employee` row therefore authorises normally. |
| **Employee permitted branches** | `identity.employee_branches` | **Authentication integrity only** (`FR-SEC-021`, `FR-SEC-022` per-branch PIN uniqueness). **Never a grant.** For `pos` sessions it is an additional **AND** condition, re-verified per request. |
| **Home branch** | `Employee.homeBranchId` | **HR designation only** (`FR-HRM-005`). **It confers no authority.** Stated explicitly so a later HR slice cannot quietly turn it into a default grant. |
| **PIN branch rules** | `PinService` + `Terminal.branchId` (composite FK) | Unchanged. A `pos` session's actionable branch is `branch_of(terminal)`, **derived server-side**. A `TENANT`-scoped role on a `pos` session still acts on **only** the terminal's branch, because the terminal binds the session to one branch (§10, R-6). |

### 9.3 Two structural facts B1-2 must preserve

1. **An Employee with no User cannot hold a PIN.** Credentials key on `userId`
   (`identity.credentials`, `credential_type = 'pin'`). This is correct and should be
   stated, not "fixed".
2. **A `pos` session currently receives the full tenant-scoped permission set.**
   `pin.service.ts:440–470` resolves *"the same TENANT-scoped set a dashboard session
   gets"* — correct under the current defer, and **exactly what C-1 must narrow**. Under
   C-1, a `pos` session's authority becomes the scoped resolution intersected with the
   terminal's branch. **This is a behavioural narrowing of an already-shipped, COMPLETE
   requirement path (`FR-SEC-021`), and must be called out in the decision text and
   covered by regression tests** (§13, T-5, T-6).

### 9.4 Dependency on F2-1, without forcing HR first

Board slice **`F2-1`** (P11-HR — employee record completion, `FR-HRM-001..006`) lists
`B1-2` as *its* dependency and notes it *"shares the identity migration surface with B1-2
and B2-5."*

- **B1-2 requires nothing from F2-1.** `Employee`, `EmployeeBranch` and `homeBranchId`
  already exist at the level `FR-SEC-021` needs.
- **Sequencing: `B1-2` → then `F2-1` and `B2-5`.** All three touch the `identity` schema;
  the board already flags `B2-5` as *"MUST NOT run concurrently with B1-2 — same identity
  migration surface."* The same warning applies to `F2-1`.
- **The forward constraint F2-1 must honour:** completing the employee aggregate **must
  not** turn `permitted_branches` or `home_branch` into an authorization grant. C-1 makes
  that a ratified invariant rather than a review comment.

---

## 10. Fail-Closed Rules

Deterministic, exhaustive, and **all deny**. Every rule states the required outcome; HTTP
status choices marked *(shape)* follow the repository's existing tenant-safe convention —
**404 where a positive answer would confirm the existence of something the caller may not
see, 403 where existence is already known to the caller** — and remain implementation
detail for B1-2/B1-3, not ratified here.

| # | Condition | Required outcome |
|---|---|---|
| **R-1** | **No branch scope determinable** — the route needs a branch and none can be resolved from path, body or session. | **DENY.** Never default to "any branch", never fall back to the sole active branch, never infer from home branch. *(shape: 400 if the request genuinely omits a required parameter; 403 otherwise.)* |
| **R-2** | **Branch is deleted / disabled / not `status = 'active'`.** | **DENY**, regardless of scope held. Branch status is checked in the **same transaction** as the action (the TOCTOU discipline `branch-reporting-scope.query.ts` already documents). |
| **R-3** | **Branch exists and is tenant-visible, but no valid assignment covers it.** | **DENY.** *(shape: 403 — the caller can already see the branch.)* |
| **R-4** | **Tenant mismatch** — the branch belongs to another tenant. | **DENY as NOT FOUND.** Unchanged from today: RLS makes it invisible, `assertBranchInScope` yields 404, and a foreign branch id must remain unprobeable. **Branch authorization must never turn a 404 into a 403 and thereby leak existence.** |
| **R-5** | **Token / session bound to a different terminal or branch** — a `pos` session acting on a branch ≠ `branch_of(session.trm)`. | **DENY.** The terminal binding is absolute for `pos` sessions and is **never** widened by a `TENANT`- or `BRAND`-scoped role. |
| **R-6** | **Tenant-wide administrator** (a valid `TENANT`-scoped assignment). | **ALLOW** for the permissions that assignment grants, on any **active** branch of that tenant — this is `FR-SEC-002`'s tenant scope working as specified, **not** a leak. **Except** on a `pos` session, where R-5 still binds it to the terminal's branch. |
| **R-7** | **"Central" roles** (no branch dimension: brand management, role/user administration, tenant settings). | Modelled as `TENANT` (or `BRAND`) scope. **No implicit branch-wildcard is introduced, and no permission is exempted from the check.** A route that takes a branch is always checked against the branch. |
| **R-8** | **Branch list / covered-branch set resolves EMPTY.** | **DENY.** An empty set is zero authority, never "unrestricted". This is the classic fail-open inversion and is prohibited by name. |
| **R-9** | **Assignment expired** (`valid_to` in the past) or **not yet valid** (`valid_from` in the future). | **DENY.** Validity is evaluated at **request time**, against the **DB clock in the same transaction** — never against a token `iat`/`exp` and never against a client clock. |
| **R-10** | **Role scope changed or was revoked while an access token is still live.** | **DENY on the next request.** Under T-2 this is automatic: nothing authoritative is cached in the token, so the next request re-resolves. **No revocation list, no token blacklist and no session invalidation sweep is required** — which is precisely the argument in §6. |
| **R-11** | **Unknown / unrecognised `scope_type`, or scope columns inconsistent with `scope_type`.** | **DENY**, and treat as a data-integrity fault worth an audit entry. Forward compatibility must never mean "ignore what you don't understand". |
| **R-12** | **Membership inactive, tenant inactive, or role not visible to the tenant.** | **DENY** — unchanged from `TenantContextService.resolve` today (`ForbiddenException('Invalid tenant context.')`). Branch scope is evaluated **after**, never instead of, these checks. |
| **R-13** | **Any exception during scope resolution.** | **DENY.** No `catch` may downgrade a scope-resolution failure to "unscoped". Mirrors `FR-PLT-012`'s ratified posture: absent context ⇒ `NULL` ⇒ false ⇒ closed. |

---

## 11. Migration Strategy — described, NOT implemented

### 11.1 Verification of P0's predicted model

P0 predicted changes around `membership_roles` · `scope_type` · `scope_id` · `valid_from` ·
`valid_to`. **Assessment: directionally right, but `scope_id` as a single polymorphic
column is NOT the best model for this repository.**

| P0 prediction | Assessment |
|---|---|
| Table is `identity.membership_roles` | **Correct.** |
| `valid_from` / `valid_to` | **Correct** (`FR-SEC-005`), **but incomplete** — see the missing `UPDATE` RLS policy below. |
| `scope_type` enum | **Correct**, with exactly three members now (§8). |
| **Single polymorphic `scope_id uuid`** | **REJECTED.** A polymorphic column **cannot carry a foreign key**. ADR 0008 **D-09** exists because *"PostgreSQL evaluates referential-integrity checks with row security disabled"* — RLS hides another tenant's row from `SELECT` but does not stop an FK pointing at it, so **single-column FKs are insufficient** and the repository's convention is a **composite `(tenant_id, id)` FK**. A bare `scope_id` would be a **recorded UUID with no FK** — *exactly* the defect the 2026-08-19 D-2 amendment (item 3) was raised to fix on `Terminal.branch_id`. Re-introducing it in the RBAC table, of all places, would be a regression. |
| **Omitted entirely: the PK change** | **The single largest migration fact.** ADR 0008 D-02: *"the shipped primary key blocks the full model outright … Fixing that is a **change to the RBAC table's identity, not an additive column**."* |
| **Omitted entirely: no `tenant_id` on `membership_roles`** | Composite tenant-safe FKs to `org.branches(tenant_id, id)` and `org.brands(tenant_id, id)` **require a local `tenant_id`**. It must be added and kept consistent with the parent membership. |
| **Omitted entirely: no `UPDATE` RLS policy** | Verified at `20260812145207_identity_rls/migration.sql:105–130`. Under `FORCE` with `SELECT`/`INSERT`/`DELETE` policies only, **`UPDATE` is denied**. `FR-SEC-005` expiry-by-update cannot work until this is added. |

### 11.2 Recommended target shape (design intent only — column names NOT ratified)

```
identity.membership_roles
  id             uuid        PK                    -- NEW surrogate identity
  tenant_id      uuid        NOT NULL              -- NEW, enables tenant-safe composite FKs
  membership_id  uuid        NOT NULL
  role_id        uuid        NOT NULL
  scope_type     enum        NOT NULL              -- TENANT | BRAND | BRANCH
  scope_brand_id uuid        NULL  -> FK (tenant_id, scope_brand_id)  REFERENCES org.brands(tenant_id, id)
  scope_branch_id uuid       NULL  -> FK (tenant_id, scope_branch_id) REFERENCES org.branches(tenant_id, id)
  valid_from     timestamptz NOT NULL DEFAULT now()
  valid_to       timestamptz NULL
  created_at     timestamptz NOT NULL DEFAULT now()

  FK (tenant_id, membership_id) REFERENCES identity.memberships(tenant_id, id)
       -- requires adding @@unique([tenantId, id]) to Membership (additive)

  CHECK ( (scope_type = 'TENANT' AND scope_brand_id IS NULL AND scope_branch_id IS NULL)
       OR (scope_type = 'BRAND'  AND scope_brand_id IS NOT NULL AND scope_branch_id IS NULL)
       OR (scope_type = 'BRANCH' AND scope_branch_id IS NOT NULL AND scope_brand_id IS NULL) )

  CHECK ( valid_to IS NULL OR valid_to > valid_from )

  UNIQUE (membership_id, role_id, scope_type,
          COALESCE(scope_branch_id, scope_brand_id, tenant_id))  WHERE valid_to IS NULL
       -- at most ONE open-ended assignment per (membership, role, scope);
       -- historical/expired rows may repeat, so re-granting after expiry works.
```

**Why typed columns beat a polymorphic `scope_id`:** every scope reference keeps a
**tenant-safe composite FK**, so a scope can never point at another tenant's brand or
branch — the D-09 guarantee — and `onDelete: Restrict` makes a scoped branch
undeletable while assignments reference it (matching `Terminal`'s existing posture, and
giving rule **R-2** a clean deleted-branch story). The cost is one extra nullable column
per scope type, which is the correct price for referential integrity in the RBAC table.

**Also required in the same migration:**

- **`membership_roles_update` RLS policy** (`USING` **and** `WITH CHECK`, tenant-predicated
  in the same style as the existing three) — otherwise `FR-SEC-005` cannot function.
- **Existing SELECT/INSERT/DELETE policies revisited** so they predicate on the new local
  `tenant_id` rather than the `EXISTS` join to `memberships`, **without weakening** the
  existing *"tenant OR own-user"* read rule.
- **`@@unique([tenantId, id])` on `Membership`** (additive; no data change).
- **`branch_id`** — the never-written, never-read legacy column: **drop it** in the same
  migration, or repurpose it as `scope_branch_id`. Leaving both would guarantee future
  confusion about which one authorises.

### 11.3 Backfill posture — the explicitly-authorised decision

**The constraint, restated:** *existing Internal-MVP assignments MUST NOT silently receive
access to all branches in a newly multi-branch tenant unless the governance decision
explicitly authorises that migration behaviour.*

| Opt | Backfill | Assessment |
|---|---|---|
| **M-1** | Every existing row → `scope_type = TENANT`. | **Behaviour-preserving and honest** — tenant-wide *is* what every assignment means today. **But taken alone it is exactly the prohibited outcome**: those rows become tenant-wide by ratification, and the day a tenant activates a second branch they silently cover it. |
| **M-2** | Every existing row → `BRANCH`, scoped to the tenant's sole active branch. | **Maximum least privilege**, and the Internal-MVP shape makes "the sole active branch" well-defined today. **But it breaks genuinely tenant-level administration** — role management, user management, brand management and tenant settings are not branch-shaped, so a branch-scoped owner would lose the ability to administer their own tenant. **Rejected.** |
| **M-3** | Hybrid: `TENANT` where the role holds any tenant-level permission, `BRANCH` otherwise. | **Requires classifying all 40 permission codes by scope applicability. Appendix C is ABSENT**, so that classification would be *authored*, not derived — inventing permission-catalogue semantics, which §2 prohibits. **Rejected on governance grounds, not technical ones.** |
| **M-4** | **M-1 + provenance marking + a fail-closed multi-branch activation gate.** | **RECOMMENDED.** |

**M-4 in detail:**

1. **Backfill `TENANT`** for every existing assignment (M-1) — zero behavioural change for
   every tenant as it stands today, and no existing test or route breaks on migration day.
2. **Mark provenance.** Every backfilled row is recorded as migration-originated (a column,
   or an audit entry per row — mechanism is B1-2's choice). Without this, a
   deliberately-granted tenant scope and an inherited-by-default one become
   indistinguishable **forever**, and no later remediation can be targeted.
3. **Gate the second branch — fail closed.** A tenant **MUST NOT** be permitted to activate
   a **second** branch while it still holds **un-reviewed migration-originated `TENANT`
   assignments**. Activation is refused with an actionable error naming the assignments to
   re-scope. This converts "silent tenant-wide access on multi-branch activation" from a
   latent defect into an explicit, blocking administrative step — **at exactly the moment
   the risk becomes real, and never before.**
4. **Provide the re-scoping surface** — an administrator can convert a marked `TENANT`
   assignment into one or more `BRANCH`/`BRAND` assignments, clearing the mark. Every such
   change is audited (`FR-AUD-006` role changes).
5. **No production data is silently widened, and no existing tenant is broken.**

**M-4 clause 3 is a genuine product-behaviour change and is `DECISION REQUIRED — 5`
in §14.** If the user declines the gate, **M-1 alone reproduces the exact defect this
slice exists to close** — and that must then be recorded as a knowingly accepted risk, not
left implicit.

### 11.4 Backward compatibility

| Surface | Effect |
|---|---|
| Existing tokens / sessions | **Unaffected** under T-2 — the token shape does not change. |
| Existing single-branch tenants | **No behavioural change** under M-1/M-4. |
| `RequestAuthorization.permissions` | **Breaking internal type change** (`ReadonlySet<string>` → scope-aware). Contained within `identity`; every consumer is in-repo. |
| Frontend | **Breaking contract change** — permissions become scope-qualified. An effective-scope read surface (`/me`-shaped) is required so a client can render per-branch capability. Its design is B1-2's, and its route/DTO shape is **not** ratified here. |
| Internal-MVP single-active-branch posture (RPT-R1/R2/R3, DC-R1/R2/R3) | **Must be retired or explicitly retained by B1-3** — see §12. |
| Audit | `FR-AUD-006` role-change events gain a scope dimension; the existing audit chain is otherwise untouched. |

---

## 12. B1-2 / B1-3 Boundaries

The board's split is broadly right. **Three corrections and one addition** follow from the
repository evidence.

### 12.1 B1-2 — persistence, resolution, and one reusable primitive

**Owns:**

1. The `membership_roles` **identity migration**: surrogate PK, `tenant_id`, `scope_type`,
   typed FK'd scope columns, CHECKs, `valid_from`/`valid_to`, indexes, the legacy
   `branch_id` disposition, and `@@unique([tenantId, id])` on `Membership`.
2. **The `membership_roles_update` RLS policy** *(correction — absent from the board; a
   hard blocker for `FR-SEC-005`)*, plus the review of the existing three policies against
   the new local `tenant_id`.
3. **Scope-aware permission resolution** in `TenantContextService` — the same single
   memoized query, now selecting the scope columns and producing a scope-aware
   authorization structure that makes `FR-SEC-004`'s non-leakage clause **expressible and
   testable**.
4. **Role-assignment API extension** — `MembershipRolesService.assign` / `remove` and
   `rbac.controller.ts` gain a scope, with tenant-safe validation of the referenced brand
   or branch and audit on every change.
5. **The reusable branch-authorization primitive** — one function, one place, e.g.
   `assertBranchAuthorized(authorization, branchId)`, enforcing §10's R-1 … R-13 and
   composing with (not replacing) `assertBranchInScope`'s tenant-safe 404 behaviour.
6. **`pos`-session branch derivation** — populate `TenantContext.branchId` from
   `trm → Terminal.branchId`, finally consuming the field reserved since Phase 6.
7. **Token strategy per the ratified §6 option** (T-2 recommended ⇒ **no token change**).
8. **The effective-scope read surface** the frontend needs.
9. **The migration backfill per the ratified §11.3 option.**

**Does NOT own:** applying the primitive across business routes; the exhaustive
enumeration suite; cross-branch E2E for other modules.

### 12.2 B1-3 — enforcement everywhere, and closure

**Owns:**

1. **Applying the B1-2 primitive to every branch-taking surface** — the **20 `:branchId`
   path routes** and the **10 DTO families accepting a body `branchId`** identified in
   §4.5, across `organisation`, `catalogue`, `inventory`, `kitchen`, `production`,
   `reporting`, `sales`, `treasury` (incl. `day-close`, `cash-close-policy`) and
   `identity/terminals`.
2. **The enumerated / generated branch-authorization coverage suite** — an automated
   enumeration of branch-taking routes asserting each is branch-authorized, so a route
   added later **fails the suite instead of shipping unguarded**. *(Correction: this is
   the branch analogue of `FR-PLT-013`'s "generated, not hand-written" cross-tenant suite.
   `FR-PLT-013` itself is PARTIAL and **has no CI pipeline to run it** — lane G. **B1-3
   must not claim `FR-PLT-013` complete**; it can only supply the suite.)*
3. **Cross-branch E2E**, extending the existing hand-written per-module isolation suites
   from cross-**tenant** to cross-**branch**.
4. **Missing-route closure** — routes that take a branch implicitly (via an entity that
   belongs to a branch) and today take none explicitly.
5. ***Addition — retire or explicitly retain the Internal-MVP single-active-branch
   posture.*** The register records it as an *"implementation consequence, NOT a fourth
   ratification"* that *"grants nothing"*: Reporting's daily-trading route and Day Close
   currently 403 whenever a tenant has **0** or **>1** active branches. Once real branch
   authorization exists, that mask is either **redundant** (remove it, and the routes
   become genuinely multi-branch) or **deliberately kept** as an independent product
   limit. **B1-3 must decide this explicitly and record it**; silently leaving it in place
   would make branch RBAC untestable on the very routes most likely to expose it, and
   silently removing it would change a ratified Reporting/Day-Close behaviour without a
   governance record.

### 12.3 Correction to the board's stated ownership

The board assigns the *"permitted-branch claim in the access token"* to B1-2's title.
**Under the recommended T-2 that work does not exist**, and B1-2's token-facing work is
limited to deriving the `pos` branch server-side. If the user instead ratifies T-1 or T-4,
the claim work is B1-2's and B1-3 additionally inherits token-staleness tests.

### 12.4 A required companion artefact

ADR 0008 D-02 states that scope-aware RBAC *"receives its own phase, **its own ADR
superseding the relevant parts of ADR 0002 and ADR 0004**, and its own security review."*
**B1-2 must therefore also produce that superseding ADR**, and B1-3 (or a following slice)
the security review. Neither appears on the board. Both are conditions ADR 0008 already
imposed.

---

## 13. Required Test Matrix

Acceptance tests B1-2/B1-3 must implement. **None were executed in this session** — this is
a design-gate slice, and no test result is reported anywhere in this document.

| # | Test | Owner | Asserts |
|---|---|---|---|
| **T-1** | **Branch A user cannot act on branch B.** A membership holding permission `P` scoped `BRANCH = A` is refused on every branch-taking route for branch `B` — across sales, inventory, treasury, kitchen, reporting and organisation. | B1-3 | `FR-SEC-002`, `FR-SEC-004` |
| **T-2** | **Tenant-wide role behaves as authorised.** A `TENANT`-scoped assignment succeeds on **every active** branch, and **only** for the permissions that assignment grants. | B1-2 + B1-3 | `FR-SEC-002` (R-6) |
| **T-3** | **Multi-branch manager acts on assigned branches only.** Two `BRANCH` assignments (A, C) of the same role: allowed on A and C, refused on B. **Directly exercises the PK change.** | B1-2 | `FR-SEC-002` ("a set of branches") |
| **T-4** | **`FR-SEC-003`'s own worked example.** "Branch Manager at Branch 1 **and** Cashier at Branch 2": manager-only permissions succeed at B1 and fail at B2; cashier-only succeed at B2 and fail at B1. **The direct non-leakage test.** | B1-2 | `FR-SEC-003`, `FR-SEC-004` |
| **T-5** | **PIN terminal cannot cross its permitted branch.** A `pos` session on a terminal in branch A is refused on branch B **even when the underlying role is `TENANT`-scoped** (R-5 beats R-6). | B1-2 | `FR-SEC-021`, R-5 |
| **T-6** | **PIN regression.** Existing `FR-SEC-021`/`022` behaviour is unchanged: unregistered/revoked terminal denied; employee outside permitted branches denied; per-branch PIN uniqueness and lockout intact; **no dashboard access from a `pos` token**. | B1-2 | `FR-SEC-021`, `FR-SEC-022`, `FR-SEC-028` |
| **T-7** | **Scope revocation takes effect.** Delete or expire an assignment while an access token is still live ⇒ the **very next request** using that token is refused, **with no re-login and no token refresh**. | B1-2 | R-10; the §6 T-2 argument |
| **T-8** | **Effective dating.** `valid_from` in the future ⇒ denied; `valid_to` in the past ⇒ denied; a temporary elevation expires **automatically** with no sweep job. Validity evaluated against the **DB clock in the request transaction**. | B1-2 | `FR-SEC-005`, R-9 |
| **T-9** | **Tenant isolation remains intact.** The full existing cross-tenant matrix re-run unchanged; a foreign `branchId` still yields **404, not 403** (no existence leak). | B1-3 | `FR-PLT-012`, R-4 |
| **T-10** | **User without Employee supports valid dashboard use.** A `Membership` whose `User` has **no** `Employee` row authorises normally on scoped routes. | B1-2 | §9 |
| **T-11** | **Employee without User remains possible.** `Employee.userId = NULL` persists and is usable as an HR/business actor; it holds no PIN and no session. | B1-2 | §9, SRS §7.3 #25 |
| **T-12** | **Disabled / revoked branch fails closed.** A branch moved off `status = 'active'` ⇒ denied **for every scope**, including `TENANT`; checked inside the acting transaction. | B1-3 | R-2 |
| **T-13** | **Empty and absent scope fail closed.** Membership with zero valid assignments ⇒ denied. Branch-taking route with no resolvable branch ⇒ denied. Unknown `scope_type` ⇒ denied. | B1-2 | R-1, R-8, R-11, R-13 |
| **T-14** | **Every branch-taking route is covered.** The enumerated suite walks the route table, and **fails the build on any branch-taking route lacking branch authorization**. Add an unguarded route ⇒ suite goes red. | B1-3 | `FR-SEC-045`; the branch analogue of `FR-PLT-013` |
| **T-15** | **Migration safety.** On a copy of Internal-MVP data: post-migration behaviour is **identical** for a single-active-branch tenant; every backfilled row is marked; and (if M-4 cl. 3 is ratified) activating a second branch is **refused** while marked assignments remain un-reviewed. | B1-2 | §11.3 |
| **T-16** | **Cross-branch scope cannot be assigned across tenants.** Assigning a scope referencing another tenant's branch or brand is rejected by **both** the composite FK and the application check. | B1-2 | ADR 0008 D-09 |

---

## 14. GOVERNANCE DECISION BRIEF — PROPOSED

> **STATUS: PROPOSED. NOT RATIFIED. NOT INSERTED INTO THE REGISTER.**
> `docs/governance/GOVERNANCE_DECISION_REGISTER.md` was **not modified** by this slice.
> The text below is drafted in the register's established forward-amendment style so that,
> if the user ratifies it, it can be recorded under **D-2** without restructuring. It
> **creates no new numbered decision** — consistent with the register's convention that
> the 20-decision tally is unchanged.

---

### PROPOSED — AMENDMENT: D-2 REOPENED IN PART (2) — BRANCH-SCOPED RBAC

#### CONTEXT

D-2 was **RATIFIED 2026-08-17 as option (a) CORE ONLY**, keeping branch-scoped RBAC
(`FR-SEC-002`, ADR 0008 D-02) out of the first Governance phase. The **2026-08-19
amendment** lifted the defer for four PIN-related items only, stating explicitly that
*"permission resolution is **not** made branch-aware by this amendment."* **P1D-A
(2026-08-20)** reopened the Workforce *domain* defer narrowly for Operational Shift and
recorded that *"D-2's branch-scoped RBAC deferral is untouched."* The defer has been
re-affirmed at every subsequent checkpoint, most recently in the **DAY CLOSE**
ratification of **2026-08-31**.

#### PROBLEM

**Branch isolation does not exist.** Within a tenant, any principal holding a permission
may exercise it against **every** branch of that tenant. Verified at HEAD `63d3b7c`:
`identity.membership_roles.branch_id` is **never written and never read**;
`TenantContextService` flattens all assignments into one unscoped permission set;
`PermissionGuard` has no branch parameter; `TenantContext.branchId` is never populated;
and `organisation/branch-scope.ts::assertBranchInScope` verifies **tenant visibility**,
not caller authorisation. Tenant isolation and RLS are **strong and unaffected**.

The gap is currently **masked** by the Internal-MVP posture — Reporting and Day Close
refuse unless the tenant has **exactly one active branch**. **That mask disappears the
moment a pilot tenant activates a second branch.** The single-active-branch posture is
**not acceptable for a multi-branch pilot or production.**

#### SRS REQUIREMENTS

`FR-SEC-002` [M] · `FR-SEC-003` [M] · `FR-SEC-004` [M] · `FR-SEC-005` [S] ·
`FR-API-012` [M]. Verbatim text at §2 of the B1-1 report. Related and already satisfied:
`FR-SEC-001`, `FR-SEC-021`, `FR-SEC-022`, `FR-SEC-028`, `FR-SEC-045`, `FR-PLT-012`.
Related and partial: `FR-HRM-001`, `FR-HRM-005`, `FR-PLT-013`, `FR-BRN-005`.

#### CURRENT RATIFIED LIMIT

D-2's *"Defer REMAINS IN FORCE"* clause: *"**Broader branch-scoped RBAC** — `FR-SEC-002` /
`FR-SEC-003` / `FR-SEC-004` general scope resolution stays deferred."* And ADR 0008 D-02's
prohibition list, which forbids **by name** every change B1-2 must make: populating
`TenantContext.branchId`; reading `membership_roles.branch_id` in any authorization path;
adding a branch parameter to `PermissionGuard`, `@RequirePermission` or
`TenantContextService.require`; and per-branch checks in services.

#### OPTIONS CONSIDERED

- **A** — scoped role assignment.
- **B** — tenant-level roles + separate permitted-branch relation. **Rejected:** cannot
  represent `FR-SEC-003`'s own worked example, and violates `FR-SEC-004`'s non-leakage
  clause by construction.
- **C** — hybrid. **Recommended in the constrained form C-1.**

#### RECOMMENDED OPTION — **C-1**

**Scoped role assignment is the SOLE source of authorization. `EmployeeBranch` remains
authentication-integrity substrate ONLY and NEVER grants, widens or implies a permission**;
for `pos` sessions it is an additional **AND** condition, never an `OR`. `Employee.homeBranchId`
confers **no** authority.

#### DATA MODEL IMPLICATION

`identity.membership_roles` receives a **new identity** (surrogate PK replacing
`@@id([membershipId, roleId])` — *"a change to the RBAC table's identity, not an additive
column"*, ADR 0008 D-02), a local `tenant_id`, a `scope_type` enum of **exactly three
members — `TENANT`, `BRAND`, `BRANCH`** — **typed, individually composite-FK'd nullable
scope columns** (**not** a polymorphic `scope_id`, which cannot carry an FK and would
reintroduce the unenforced-UUID defect the 2026-08-19 amendment fixed on
`Terminal.branch_id`), a CHECK binding the columns to `scope_type`, and
`valid_from` / `valid_to`. *"A set of branches"* is represented as **multiple `BRANCH`
rows**, not an array and not a group entity. **`BRANCH_GROUP`, `WAREHOUSE`,
`CENTRAL_KITCHEN` and `LOCATION` scope types are NOT authorised.** `Membership` gains
`@@unique([tenantId, id])` (additive). The legacy `branch_id` column is dropped or
repurposed — **never left alongside the new columns.**

**A `membership_roles_update` RLS policy MUST be created.** The table today carries
`SELECT`/`INSERT`/`DELETE` policies only under `FORCE`, so every `UPDATE` is denied and
`FR-SEC-005` expiry-by-update is impossible as it stands.

#### AUTHORIZATION SEMANTICS

Authority requires **all** of: a valid, in-date assignment; the permission in that
assignment's role; the target branch covered by that assignment's scope; and, for `pos`
sessions, equality with the terminal's branch **and** membership of the employee's
permitted-branch set. Fail-closed rules **R-1 … R-13** (B1-1 report §10) are binding.
Tenant RLS is **unchanged and is not weakened**. `FR-SEC-004`'s union is computed **within
each assignment's own scope**; permissions **do not leak across scopes**.

#### TOKEN / SESSION SEMANTICS

**`AccessTokenPayload` is UNCHANGED. No permitted-branch claim and no scope-set claim is
added.** Authorization continues to be resolved **server-side per request**, in the single
memoized `TenantContextService` query, preserving the repository's stated architecture and
delivering **immediate** revocation — which a cached claim cannot, and which `FR-SEC-028`
requires. A `pos` session's branch is **derived server-side** from `trm → Terminal.branchId`
(composite FK, D-2 amendment item 3), and `TenantContext.branchId` is populated **only**
for `pos` sessions.

**`FR-API-012` clause 2** (*"Every request SHALL be authorised against both the permission
and the scope"*) is thereby **satisfied IN FULL**. **`FR-API-012` clause 1** (*"Tokens
SHALL carry … scope set, and permitted branch set"*) is **knowingly deviated from**, and
`FR-API-012` **MUST be recorded as PARTIAL — knowingly deviating — and MUST NOT be
reported complete.** *(See DECISION REQUIRED — 3.)*

#### MIGRATION SEMANTICS

**M-4.** Every existing assignment is backfilled `scope_type = TENANT` — behaviour-
preserving, because tenant-wide is what every assignment means today — **and every
backfilled row is marked as migration-originated**, so an inherited scope is permanently
distinguishable from a deliberately granted one. **A tenant MUST NOT be permitted to
activate a second branch while un-reviewed migration-originated `TENANT` assignments
remain**; activation is refused, fail-closed, naming the assignments to re-scope. An
administrative re-scoping surface clears the mark, audited under `FR-AUD-006`.

**Explicitly: this decision does NOT authorise existing Internal-MVP assignments to gain
access to additional branches in a newly multi-branch tenant.** *(See DECISION
REQUIRED — 5.)*

#### BACKWARD COMPATIBILITY

No token, session or refresh-token change. No behavioural change for any existing
single-active-branch tenant. `RequestAuthorization.permissions` becomes scope-aware — an
internal breaking type change, fully contained in-repo. The **frontend contract changes**:
permissions become scope-qualified and an effective-scope read surface is required. The
**Internal-MVP single-active-branch posture** (RPT-R1/R2/R3, DC-R1/R2/R3) **must be
explicitly retired or explicitly retained by B1-3, and the choice recorded.**

#### SECURITY INVARIANTS

1. **Tenant RLS is not weakened, replaced or bypassed.** No branch predicate enters any RLS
   policy under this decision.
2. **A foreign-tenant branch id remains a tenant-safe 404**, never a 403. Branch
   authorization must not leak existence.
3. **Every scope reference carries a tenant-safe composite FK** (ADR 0008 D-09). A scope
   can never point at another tenant's brand or branch.
4. **`EmployeeBranch` and `homeBranchId` never grant a permission.**
5. **Empty scope means zero authority, never unrestricted.**
6. **An unknown `scope_type` denies.**
7. **Revocation is effective on the next request**, with no token blacklist.
8. **Authority is permission-based** — D-3 and P1A CLARIFICATION C: no role-name string is
   hardcoded, and **no new permission code is created by this decision.**
9. **The permission catalogue is NOT extended, reclassified or re-derived.** SRS Appendix C
   remains absent (SIG-03); no permission may be labelled tenant-only or branch-only on the
   strength of a missing appendix.

#### TEST REQUIREMENTS

**T-1 … T-16** (B1-1 report §13) are binding acceptance criteria for B1-2/B1-3. In
particular **T-4** (`FR-SEC-003`'s own worked example), **T-5** (`pos` session cannot cross
its terminal's branch even under a `TENANT`-scoped role), **T-7** (revocation effective on
the next request, no re-login), **T-14** (enumerated coverage of every branch-taking route,
build-failing) and **T-15** (migration safety on Internal-MVP data).

**`FR-PLT-013` is NOT satisfied by T-14** — no CI pipeline exists to execute it (lane G).
B1-3 supplies the suite; it must not claim the requirement.

#### NON-GOALS

**This decision does NOT authorise, and the defer REMAINS IN FORCE for:**

- **`FR-SEC-032`** — manager PIN for **approvals**, and push notification. **Remains
  knowingly unmet. D-11 (notifications: strict none) is untouched.**
- **`FR-SEC-010` / `FR-SEC-012`** — predefined/standard role seeding and the role editor.
  Appendix C is absent; **no role catalogue is seeded and no permission code is created.**
- **`FR-SEC-023` / `FR-SEC-024`** — MFA (board `G4-2`).
- **`FR-API-011` / `FR-API-014`** — API keys and machine clients (board `B2-5`). The scope
  model is designed to extend to them; **they are not implemented here**, and `B2-5` **MUST
  NOT** run concurrently with `B1-2` (shared identity migration surface).
- **`FR-BRN-005`** — branch groups as a permission-scoping dimension (board `G3-1`). **No
  `BRANCH_GROUP` scope type is created.**
- **`WAREHOUSE`, `CENTRAL_KITCHEN`, `LOCATION` scope types** — no SRS requirement scopes a
  role assignment to any of them.
- **Branch-aware RLS** — branch authorization remains an **application** layer. Any future
  branch predicate in RLS requires **its own ADR and its own governance decision**.
- **The wider Workforce domain / full `FR-HRM-001` employee aggregate** (board `F2-1`) —
  deferred as before; **B1-2 requires nothing from it.**
- **Any cross-request permission cache.**
- **Modification of `P-1`, `D-3`, `D-5`, `D-9`, `D-10`, `D-11`, `D-12` (BLOCKED), `D-13`,
  `D-16` (OPEN), `D-17`, `D-19`, `D-20`, the `SB` residuals, `P1A`–`P1G` carried items, or
  the `R-1(a) … R-6` / `KDS-R1 … KDS-R12` / `RPT-R1 … RPT-R3` / `DC-R1 … DC-R3` series.**

**No numbered decision is created, amended or renumbered. No migration is created and no
implementation is performed by this entry.** Exact table and column names, enum member
spellings, route URLs, DTO fields, index choices and error codes remain **implementation
details, NOT ratified here.**

**ADR requirement carried forward:** ADR 0008 D-02 requires that scope-aware RBAC receive
*"its own ADR superseding the relevant parts of ADR 0002 and ADR 0004, and its own security
review."* **B1-2 must produce that ADR; a security review must follow B1-3.**

#### DECISION REQUIRED FROM USER

1. **Reopen D-2 for branch-scoped RBAC** — lifting the defer for `FR-SEC-002`,
   `FR-SEC-003`, `FR-SEC-004` and `FR-SEC-005`, and for those parts of `FR-API-012`
   consequential on them. **YES / NO.**
2. **Ratify the authorisation model.** **C-1** (recommended) / A / B.
3. **Ratify the token strategy.** **T-2 — server-side resolution, token unchanged,
   `FR-API-012` clause 1 knowingly deviated and the requirement recorded PARTIAL**
   (recommended) / T-1 / T-3 / **T-4** (literal claim + epoch fencing, if literal `[M]`
   compliance is required). *This is an `[M]`-vs-`[M]` tension between `FR-API-012`
   clause 1 and `FR-SEC-028`; it is escalated rather than resolved by reinterpretation.*
4. **Ratify the scope types: exactly `TENANT`, `BRAND`, `BRANCH`** — with `BRANCH_GROUP`,
   `WAREHOUSE`, `CENTRAL_KITCHEN` and `LOCATION` **excluded**. **YES / NO.**
5. **Ratify the migration posture M-4** — backfill `TENANT` **+ provenance marking +
   fail-closed second-branch activation gate.** **If the gate (clause 3) is declined, the
   silent-widening risk it exists to prevent must be recorded as knowingly accepted.**
6. **Confirm that branch authorization remains an APPLICATION layer**, and that branch-aware
   RLS is **not** authorised by this decision. **YES / NO.**
7. **Confirm the B1-2 / B1-3 boundaries** as corrected in B1-1 report §12, including
   (a) the `membership_roles` `UPDATE` RLS policy in B1-2, (b) the superseding ADR in B1-2,
   and (c) B1-3's explicit disposition of the Internal-MVP single-active-branch posture.

---

## 15. Facts Verified In This Session

All at HEAD `63d3b7c2ea5f999bb9ba7277d51a5da3c6950a71`, by direct file inspection.
**No tests were executed and no test results are reported.**

| # | Verified fact | Evidence |
|---|---|---|
| 1 | `MembershipRole` PK is `@@id([membershipId, roleId])`; `branchId` nullable and outside the key. | `prisma/schema.prisma:341–366` |
| 2 | `membership_roles.branch_id` is **never written and never read** by any code path. | grep across `src`; `MembershipRolesService.assign` creates `{ membershipId, roleId }` only |
| 3 | `TenantContext.branchId` is declared *"RESERVED — not populated this phase"* and is never populated. | `identity/context/tenant-context.ts:11`; `TenantContextService.resolve` |
| 4 | The access token carries **no** permissions, scope set or branch set. | `identity/auth/auth.types.ts` |
| 5 | `PermissionGuard` tests a flat `ReadonlySet<string>` with no branch dimension. | `identity/authz/guards/permission.guard.ts` |
| 6 | `assertBranchInScope` performs a tenant-visibility lookup yielding 404; **no authorization**. Called from **4** services. | `organisation/branch-scope.ts` + grep |
| 7 | `identity.membership_roles` has **`SELECT`/`INSERT`/`DELETE` policies only** under `ENABLE` + `FORCE` — **no `UPDATE` policy**. | `prisma/migrations/20260812145207_identity_rls/migration.sql:105–130` |
| 8 | `membership_roles` has **no `tenant_id`**; RLS derives tenancy via an `EXISTS` join to `memberships`. | same migration |
| 9 | `Membership` has `@@unique([userId, tenantId])` but **no `@@unique([tenantId, id])`**. | `prisma/schema.prisma:268–286` |
| 10 | `Terminal.branchId` has a **composite tenant-safe FK** `(tenantId, branchId) → Branch(tenantId, id)`, `onDelete: Restrict`. | `prisma/schema.prisma:383–430` |
| 11 | `EmployeeBranch` is documented as *"authentication integrity only … does NOT grant permissions."* | `prisma/schema.prisma:1717+` |
| 12 | A `pos` session receives *"the same TENANT-scoped set a dashboard session gets."* | `identity/employees/pin.service.ts:440–470` |
| 13 | `PinService` performs the only real branch check in the codebase, at **authentication** time. | `identity/employees/pin.service.ts:298–324` |
| 14 | **20** controller routes take a `:branchId` path parameter; **10** further DTO files accept a body `branchId`. | grep over `src/**/*.controller.ts`, `src/**/*.dto.ts` |
| 15 | `withAuthContext` sets `app.user_id` and `app.tenant_id` only; **no branch GUC** anywhere. | `src/prisma/prisma.service.ts:42–73` |
| 16 | `operativeBranches` enforces **0 ⇒ 403 / 1 ⇒ continue / >1 ⇒ 403**, and is documented as *"NOT branch-aware RBAC"*. | `organisation/contract/branch-reporting-scope.query.ts`; `daily-trading-report.service.ts:107–121`; `day-close.service.ts:288–302` |
| 17 | `docs/organisation/authorization.md` records the gap: *"any principal holding `settings.branch.manage` can mutate **every** branch."* | that file, §"KNOWN GAP" |
| 18 | `Warehouse.branchId` is **nullable**; `CentralKitchen` is **tenant-level** (no branch column). | `prisma/schema.prisma:674`, `:699` |
| 19 | The permission catalogue holds **40 codes**, authored because Appendix C is absent; `settings.branch.read` is marked *"invented (provisional)."* | `identity/authz/permissions.constants.ts`; `docs/organisation/authorization.md` |
| 20 | D-2's branch-RBAC defer is re-affirmed in the register as recently as the **DAY CLOSE** ratification of 2026-08-31. | `GOVERNANCE_DECISION_REGISTER.md`, tail |

---

## 16. Blockers Still Open

| Blocker | Why still open |
|---|---|
| **D-2 branch-scoped RBAC defer** | Only the user can reopen it. §14 is a **proposal**; nothing is ratified. **B1-2 and B1-3 cannot start.** |
| **`FR-API-012` clause 1 vs `FR-SEC-028`** | An `[M]`-vs-`[M]` mechanism conflict. Escalated as `DECISION REQUIRED — 3`; **not resolved by this report.** |
| **M-4 clause 3 (second-branch activation gate)** | A genuine product-behaviour change. `DECISION REQUIRED — 5`. Without it, M-1 alone reproduces the defect. |
| **SRS Appendix C absent (SIG-03)** | Unresolved spec defect. Keeps `FR-SEC-010`/`FR-SEC-012` unsatisfiable and forbids any scope-based reclassification of the permission catalogue. |
| **`FR-PLT-013` — no CI pipeline** | Lane G. B1-3 can supply the enumerated suite but cannot execute it in CI or claim the requirement. |
| **ADR superseding ADR 0002 / ADR 0004** | Required by ADR 0008 D-02's own terms; absent from the execution board; assigned to B1-2 in §12.4. |
| **Internal-MVP single-active-branch posture** | Must be explicitly retired or retained by B1-3; absent from the board. |

---

## 17. Slice Record

| Field | Value |
|---|---|
| **Baseline HEAD** | `63d3b7c2ea5f999bb9ba7277d51a5da3c6950a71` |
| **Commits created** | One, subject **`docs(security): prepare branch RBAC governance gate`** |
| **Files changed** | This report + one row appended to `docs/reports/claude/full-srs-4day/INDEX.md`. **Nothing else.** |
| **Product code changed** | **NO** |
| **Schema / migration changed** | **NO** |
| **Route / permission changed** | **NO** |
| **`GOVERNANCE_DECISION_REGISTER.md` changed** | **NO** |
| **Anything ratified** | **NO** |
| **Tests executed this session** | **NONE.** No test result appears in this report. |
| **Pushed** | **NO** |
| **Deployed** | **NO** |
| **Status** | **COMPLETE** — awaiting user governance decision on §14's seven items. |

---

## POST-REVIEW ACCEPTANCE NOTE (appended 2026-09-02)

**The analysis body above is preserved unchanged as historical evidence. It is NOT the
authoritative governance outcome.**

The authoritative outcome is the register amendment
**`AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC`** (RATIFIED **2026-09-02**,
`docs/governance/GOVERNANCE_DECISION_REGISTER.md`, under **D-2**), with the acceptance
correction recorded in
`docs/reports/claude/full-srs-4day/2026-09-02_B1-1_branch-rbac-ratification.md`.

**Where §14 of this report differs from that amendment, THE AMENDMENT GOVERNS.** Five
differences:

1. **The §14 / §6 `T-2` token recommendation was NOT ratified. `T-4-LIVE` was ratified
   instead** — the token carries the SRS-required snapshot (subject, tenant, scope set,
   permitted branch set) **plus a scope epoch/version**, while **live server-side
   resolution remains the authoritative authorization source** and no decision may rely
   solely on a claim. `FR-API-012` is recorded **RATIFIED DESIGN — NOT YET IMPLEMENTED**,
   and the `DECISION REQUIRED — 3` escalation is thereby closed.
2. **A generic target-scope lattice was ratified**, replacing this report's
   `permission + branchId` framing: every protected operation carries a required
   permission **and** a target scope `S` ∈ {`TENANT`, `BRAND(id)`, `BRANCH(id)`}, with
   strictly **downward** coverage. Scope is derived from the **resource / operation
   target**, never from any classification of permission codes.
3. **`M-4` was strengthened to `M-4+`**, adding the **already-multi-branch tenant case**:
   do not fail the migration, do not declare such a tenant branch-RBAC-ready, mark it as
   requiring scope review, and do not retire the single-active-branch mask for it until
   inherited assignments are reviewed or re-scoped.
4. **`BRANCH_GROUP` is deferred from B1-2 but explicitly NOT rejected** — it is a
   **mandatory Full-SRS follow-up** under `FR-BRN-005` once the canonical `BranchGroup`
   entity exists, and the B1-2 data model must remain additively extensible to it. §8 and
   the §14 NON-GOALS of this report should be read subject to that clarification.
5. **`FR-SEC-028` is corrected from COMPLETE to `PARTIAL` globally.** Server-side
   registration, revocation and immediate credential invalidation are implemented; the
   *"wiping its local data on next contact"* limb is **not**. Every reference to
   `FR-SEC-028` as COMPLETE in the body above (§2 tables and §15 item 20 context) is
   superseded by that correction.

**Unchanged and carried forward:** the C-1 authorization model; scope types
`TENANT`/`BRAND`/`BRANCH` only; the rejection of a polymorphic `scope_id`; the
`membership_roles` table-identity migration; the missing `UPDATE` RLS policy finding; the
application-layer (not RLS) branch-authorization boundary; and the `R-1 … R-13` fail-closed
rules, corrected to the generic target-scope model.

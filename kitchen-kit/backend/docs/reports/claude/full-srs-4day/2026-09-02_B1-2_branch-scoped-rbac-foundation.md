# B1-2 — Scoped RBAC Foundation

| Field | Value |
|---|---|
| **Task / Slice** | `B1-2` — SCOPED RBAC FOUNDATION (P2-SEC, lane B, merge wave 1) |
| **Report type** | IMPLEMENTATION + SCHEMA/MIGRATION + TESTS + ADR |
| **Authority** | **This report is NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative — specifically `AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC` (RATIFIED 2026-09-02). Where this report and the register differ, the register wins. This report ratifies nothing. |
| **Date** | 2026-09-02 |
| **Starting HEAD** | `2967043e46eb4208c8723d65a64b724f5a89d824` (`docs(security): ratify branch-scoped RBAC`) |
| **Branch** | `full-srs/lane-b-security-platform` |
| **Working tree at start** | Clean |
| **Task identifier** | `P2-SEC / B1-2` |
| **Push / deploy / merge** | **NONE.** No push, no merge, no rebase, no deploy, no destructive git operation. |

---

## 1. Status

**COMPLETE.** B1-2 delivers the scoped-RBAC persistence model, the live scope-aware
authorization resolver, the `T-4-LIVE` token contract, the generic
`permission + target scope` primitive, the scoped assignment APIs, the `M-4+` migration
with its safety gate, the superseding ADR, and the tests.

**Nothing about B1-3 is delivered, and no requirement is over-claimed.** `FR-SEC-004` and
`FR-API-012` remain **PARTIAL**; `FR-SEC-028` remains **PARTIAL** globally. See §29.

---

## 2. Starting HEAD

Verified before any edit: worktree `/Users/mac/projects/ros-worktrees/lane-b`, branch
`full-srs/lane-b-security-platform`, HEAD `2967043e46eb4208c8723d65a64b724f5a89d824`,
working tree clean, and the ratification present —
`docs/reports/claude/full-srs-4day/2026-09-02_B1-1_branch-rbac-ratification.md` exists and
the register contains `AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC`.

**Environment note.** This worktree had **no `node_modules`** and no generated Prisma
client; `npm ci` was run to make typecheck, tests and migrations executable. `.env` was
created pointing at a **disposable Lane-B database** and is gitignored (it does not appear
in the diff).

---

## 3. Ratified Governance Consumed

| Clause | Consumed as |
|---|---|
| 1 — **C-1** | Scoped `MembershipRole` assignments are the sole grant source; `EmployeeBranch`/`homeBranchId` never grant (§7, §15). |
| 2 — **target-scope lattice** | `identity/authz/scope.ts`, unit-tested in isolation (§12). |
| 3 — **permission AND target** | `ScopeAuthorizationService`; no permission code is classified (§14). |
| 4 — **scope types** | `TENANT`/`BRAND`/`BRANCH` only; a branch SET is multiple rows (§6). |
| 5 — **`BRANCH_GROUP` deferred, not rejected** | Not implemented; the enum and typed columns extend additively; recorded in ADR 0009 D-02. |
| 6 — **POS narrowing** | `TenantContextService` + `ScopeAuthorizationService` (§15). |
| 7 — **`T-4-LIVE`** | Snapshot + epoch on the token; live resolution authoritative (§16, §18). |
| 8 — **bounded representation** | Symbolic permitted-branch set; overflow fails closed (§17). |
| 10 — **no polymorphic `scope_id`** | Typed, composite-FK'd scope columns (§6, §7). |
| 11 — **table identity** | Surrogate PK migration (§6). |
| 12 — **`UPDATE` RLS policy** | Added, tenant-safe, `USING` + `WITH CHECK` (§8). |
| 13 — **`M-4+`** | Backfill, provenance, second-branch gate, already-multi-branch case (§9–§11). |
| 14 — **RLS boundary** | Application layer only; no branch predicate, no `app.branch_id` (§8). |
| 15 — **fail-closed invariants** | §14, §17, §28. |
| 16 / 17 — **B1-2 / B1-3 boundaries** | Respected; §30 lists what was deliberately left. |
| 19 — **frontend contract** | Effective-scope read contract (§20). |
| 20 — **Appendix C** | **No permission code created, extended or reclassified.** |

---

## 4. Files Changed

**New (12)**

| Path | Purpose |
|---|---|
| `prisma/migrations/20260902010000_identity_scoped_role_assignments/migration.sql` | Migration 36. |
| `src/modules/identity/authz/scope.ts` | Pure lattice + symbolic permitted-branch set. |
| `src/modules/identity/authz/scope.spec.ts` | Lattice unit tests. |
| `src/modules/identity/authz/scope-authorization.service.ts` | The generic primitive. |
| `src/modules/identity/authz/authorization-snapshot.service.ts` | `T-4-LIVE` snapshot + budget. |
| `src/modules/identity/authz/scope-review.query.service.ts` | `SCOPE_REVIEW_QUERY` impl. |
| `src/modules/identity/contract/scope-review.query.ts` | Identity published contract. |
| `src/modules/organisation/contract/branch-brand.query.ts` | Organisation published contract. |
| `src/modules/organisation/branches/branch-brand.query.service.ts` | `BRANCH_BRAND_QUERY` impl. |
| `docs/adr/0009-scoped-rbac.md` | The ADR ADR 0008 D-02 required. |
| `test/scoped-rbac.e2e-spec.ts` | Lattice / FR-SEC-003 / transition / dating / `T-4-LIVE` / POS / user-employee / cross-tenant / legacy API. |
| `test/scoped-rbac-migration.e2e-spec.ts` | `M-4+` posture and `membership_roles` RLS. |

**Modified — production code (14)**
`prisma/schema.prisma` · `identity/context/tenant-context.ts` ·
`identity/context/tenant-context.service.ts` · `identity/authz/membership-roles.service.ts` ·
`identity/authz/rbac.controller.ts` · `identity/authz/dto/assign-role.dto.ts` ·
`identity/authz/guards/permission.guard.ts` (docblock only — behaviour follows from the
resolver) · `identity/auth/auth.types.ts` · `identity/auth/auth.service.ts` ·
`identity/auth/guards/jwt-auth.guard.ts` · `identity/tenants/tenant-selection.service.ts` ·
`identity/terminals/terminal-session.service.ts` · `identity/identity.module.ts` ·
`organisation/organisation.module.ts` · `organisation/branches/branches.service.ts` ·
`governance/audit/audit.constants.ts` · `scripts/seed-dev-data.ts` · both `contract/index.ts`
barrels.

**Modified — generated**: `docs/api/openapi.json`, `docs/api/openapi.yaml` (regenerated,
never hand-edited).

**Modified — tests (28)**: mechanical migration of `membershipRoles.assign(t, m, r)` to the
scoped `create(t, actor, { membershipId, roleId, scope })` across 23 suites and fixtures,
plus four specs updated for the new constructor/claims, `module-boundaries.spec.ts`
migration count 35 → 36, `openapi.e2e-spec.ts` bodyless allowlist, and `rbac.e2e-spec.ts` /
`audit.e2e-spec.ts` for the new 201 + mandatory scope + epoch semantics (§28).

**NOT changed**: no permission catalogue, no API keys, no Workforce feature, no branch
groups, no branch-aware RLS, no unrelated business route.

---

## 5. Migration Name

`prisma/migrations/20260902010000_identity_scoped_role_assignments` — **migration 36**.
One migration, additive-then-restructuring within a single file, in this order: enums →
`memberships` epoch + composite-FK target → new columns → backfill → guards → NOT NULL →
table identity → FKs → invariants → indexes → RLS.

---

## 6. Final `MembershipRole` Model

```
identity.membership_roles
  id               uuid  PRIMARY KEY          -- stable per-assignment identity (ULID-as-UUID)
  tenant_id        uuid  NOT NULL             -- local tenant; enables composite FKs + direct RLS
  membership_id    uuid  NOT NULL
  role_id          uuid  NOT NULL
  scope_type       identity."RoleScopeType" NOT NULL   -- tenant | brand | branch
  scope_brand_id   uuid  NULL                 -- set iff scope_type = brand
  scope_branch_id  uuid  NULL                 -- set iff scope_type = branch
  valid_from       timestamptz NOT NULL DEFAULT now()
  valid_to         timestamptz NULL
  origin           identity."MembershipRoleOrigin" NOT NULL DEFAULT 'explicit'
  reviewed_at      timestamptz NULL
  reviewed_by      uuid  NULL
  created_at       timestamptz NOT NULL DEFAULT now()
  updated_at       timestamptz NOT NULL
```

- **`@@id([membershipId, roleId])` is GONE**, replaced by `PRIMARY KEY (id)`. This is what
  makes `FR-SEC-003`'s worked example representable.
- **Legacy `branch_id` is DROPPED**, not left alongside `scope_branch_id`. The migration
  first *proves* it held no data (§25) rather than assuming it.
- `memberships` gains `authz_epoch INTEGER NOT NULL DEFAULT 0` and
  `UNIQUE (tenant_id, id)`.

**Verified foreign keys** (`pg_constraint`, from-zero database):

```
membership_roles_tenant_id_membership_id_fkey   (tenant_id, membership_id) -> identity.memberships(tenant_id, id)  ON DELETE CASCADE
membership_roles_tenant_id_scope_brand_id_fkey  (tenant_id, scope_brand_id)  -> org.brands(tenant_id, id)          ON DELETE RESTRICT
membership_roles_tenant_id_scope_branch_id_fkey (tenant_id, scope_branch_id) -> org.branches(tenant_id, id)        ON DELETE RESTRICT
membership_roles_role_id_fkey                    role_id -> identity.roles(id)  ON DELETE CASCADE
```

`role_id` stays a single-column FK deliberately: roles may be SYSTEM roles with
`tenant_id IS NULL`, so there is no composite target to point at.

---

## 7. Database Constraints

All verified present on the from-zero database:

| Constraint | Enforces |
|---|---|
| `ck_membership_role_scope_consistent` | `tenant` ⇒ both refs NULL; `brand` ⇒ brand ref only; `branch` ⇒ branch ref only. **An inconsistent row cannot exist.** |
| `ck_membership_role_validity_window` | `valid_to IS NULL OR valid_to > valid_from`. |
| `ck_membership_role_review_state` | `reviewed_at` and `reviewed_by` are both set or both NULL. |
| `ex_membership_role_no_overlap` | `EXCLUDE USING gist (membership_id =, role_id =, scope_type =, COALESCE(scope_branch_id, scope_brand_id, tenant_id) =, tstzrange(valid_from, valid_to) &&)` — at most ONE effective assignment per (membership, role, exact scope) at any instant. |
| composite FKs (§6) | Cross-tenant scope references are **structurally impossible**, independently of RLS. |

**Why an EXCLUDE rather than a partial unique index.** A partial unique index on
`valid_to IS NULL` would catch only the open-ended case. The range EXCLUDE is the exact
invariant: it forbids genuine temporal duplication (which `FR-SEC-004`'s per-scope union
would silently double-count) while leaving **historical and future** assignments fully
representable — proven by the "re-grant after expiry" test (§23 J-2). `btree_gist` is
already an established dependency (migration `20260819120000_price_list_no_overlap`
creates it for the same reason), so no new extension requirement is introduced.

Prisma cannot express the CHECKs or the EXCLUDE, so they are explicit migration SQL. **The
invariant was not weakened to fit Prisma syntax.**

---

## 8. RLS Changes

`identity.membership_roles` keeps `ENABLE` + `FORCE` (verified in-test). Policies were
re-expressed against the new LOCAL `tenant_id` — previously every policy joined
`identity.memberships` because the table had no tenant column of its own.

| Policy | Before | After |
|---|---|---|
| `..._select` | `EXISTS(memberships m … m.tenant_id = app.tenant_id OR m.user_id = app.user_id)` | `tenant_id = app.tenant_id OR EXISTS(memberships m … m.user_id = app.user_id)` — **the own-user limb is preserved exactly.** |
| `..._insert` | EXISTS join | `WITH CHECK (tenant_id = app.tenant_id)` |
| **`..._update`** | **DID NOT EXIST** | **NEW** — `USING` **and** `WITH CHECK`, both `tenant_id = app.tenant_id`. |
| `..._delete` | EXISTS join | `USING (tenant_id = app.tenant_id)` |

**The missing `UPDATE` policy was a genuine runtime blocker**: under `FORCE` with no
`UPDATE` policy PostgreSQL denies every update, so `FR-SEC-005` expiry-by-update and
`M-4+` review were impossible as the table stood.

Both limbs are required: `USING` alone would permit *re-tenanting* a row. That is tested
directly (§23 J-4).

Every predicate reads `NULLIF(current_setting('app.tenant_id', true), '')::uuid`, so an
absent context yields NULL → false → **fail closed** (`FR-PLT-012`).

**NOT done, by governance:** no branch predicate in any policy, no `app.branch_id` GUC, no
weakening of any tenant policy, `FORCE` never disabled. A test asserts the policy text
contains neither `app.branch_id` nor `scope_branch_id`.

---

## 9. `M-4+` Backfill

Every pre-B1-2 assignment becomes: `scope_type = 'tenant'` (what an unscoped assignment
actually meant), `origin = 'migration'`, `reviewed_at = NULL`, `valid_from = created_at`,
`valid_to = NULL`, `id = gen_random_uuid()`, `tenant_id` from the parent membership.

Two **guards run before any destructive step**, and both `RAISE EXCEPTION` rather than
proceed:

1. **an assignment with no parent membership** — it cannot be scoped, and must not be left
   unscoped or silently dropped;
2. **a populated legacy `branch_id`** — the migration will neither discard a recorded
   intent silently nor promote it to a `BRANCH` scope, because promoting it would GRANT
   authority this migration is not authorised to grant.

Assignments created through the API afterwards are `origin = 'explicit'` — proven in test.

---

## 10. Already-Multi-Branch Handling

**Migration does not fail**, does not touch the tenant's branches, and does not declare it
ready. Proven on a real pre-B1-2 database seeded with a tenant holding **two active
branches** plus an unscoped assignment (§26): the upgrade succeeded, the two branches were
untouched, and the tenant's assignment came through marked `origin = 'migration'`,
`reviewed_at IS NULL` — i.e. **review-required**.

The review state is exposed two ways, both reusable:
`SCOPE_REVIEW_QUERY.hasUnreviewedInheritedAssignments(tx)` (Identity's published
contract), and `scopeReviewRequired` on the effective-scope read contract.

**The Internal-MVP single-active-branch masks in Reporting and Day Close were NOT retired
here.** That is B1-3's, after enforcement and review are complete.

---

## 11. Second-Branch Activation Gate

Implemented at Organisation's real branch lifecycle, inside the caller's transaction:

- `BranchesService.create` — `branches.status` defaults to `active`, so **creating a branch
  IS activating one**; the gate belongs here;
- `BranchesService.setStatus` — only on a transition **into** `active` from a non-active
  status.

Rule: `activeCount === 1` **and** unreviewed inherited grants exist ⇒ **403, fail closed**,
with an actionable message naming `GET /auth/permissions` (`scopeReviewRequired`).

- `activeCount === 0` (first branch) → never gated.
- `activeCount >= 2` (already multi-branch) → **not gated** — the gate is the 1 → 2
  transition only; blocking a running multi-branch business retroactively is precisely
  what clause 13.D forbids.

**No parallel branch lifecycle was invented.** Both outcomes of review clear the block:
explicit review (retain tenant scope) and re-scoping (replace the grant). Both are tested.

---

## 12. Scope Lattice

`src/modules/identity/authz/scope.ts` — pure, no Nest, no Prisma, no I/O, so the security
invariant is testable in isolation.

| Assignment | COVERS | DOES NOT COVER |
|---|---|---|
| `TENANT` | `TENANT`; every `BRAND`; every `BRANCH` in the tenant | anything outside the tenant |
| `BRAND X` | `BRAND X`; a `BRANCH` whose parent brand is X | `TENANT`; another brand; a branch of another brand |
| `BRANCH X` | `BRANCH X` only | `TENANT`; any `BRAND` (including its own parent); any other branch |

A branch target whose parent brand is **unknown** is **not covered by any brand scope** —
unknown fails closed rather than assuming membership.

---

## 13. Transitional `PermissionGuard` Safety

**A route carrying `@RequirePermission(P)` and no explicit target scope is a TENANT-target
operation.** `RequestAuthorization.permissions` therefore contains **only** the permissions
of `tenant`-scoped assignments; `BRAND`- and `BRANCH`-scoped grants are **never** flattened
into it.

- `TENANT` assignment with P → passes (legacy behaviour preserved exactly);
- `BRAND` assignment with P → **denied**;
- `BRANCH` assignment with P → **denied**.

Without this, B1-2 would have created a wider gap than it closed: a branch-scoped grant
would have satisfied every not-yet-converted route in the tenant. All three cases are
tested over real HTTP against `GET /auth/roles` (§23 C).

---

## 14. Generic Scope Primitive

`ScopeAuthorizationService.assertAuthorized(auth, { codes, mode }, target, tx?)` /
`isAuthorized(...)`, published from `IdentityModule` for B1-3.

Authorised only when **ONE SINGLE assignment** satisfies both halves — its role grants the
code **and** its scope covers the target. That quantifier is `FR-SEC-004`'s non-leakage
clause; a permission at Branch 1 plus a different permission at Branch 2 never combine.

Handles: `TENANT`/`BRAND`/`BRANCH` targets · the lattice · effective dates (via the
resolver) · **empty assignments ⇒ zero authority** · unknown/inconsistent scope ⇒ deny ·
tenant mismatch ⇒ deny without an existence oracle · POS narrowing. An empty `codes` array
is a programming error and denies rather than opening a door.

**The target is resolved against Organisation, and anything not visible in the acting
tenant is DENIED.** This is deliberate and is stronger than the brief required. A
`TENANT`-scoped assignment covers *"every branch in MY tenant"*; if the primitive took the
caller's word for the target's identity, another tenant's branch id would satisfy that
grant, and the only thing preventing a cross-tenant action would be whether the B1-3 caller
remembered to resolve the resource tenant-safely first. That is exactly the
"every-caller-must-remember" rule this slice exists to remove, so the check lives in the
primitive. Invisible ⇒ denied, with **no distinction between "another tenant's" and "does
not exist"** (R-4 — a target must never become an existence oracle). The caller still owns
the tenant-safe 404 on its own resource lookup; this is defence in depth, not a
replacement. A caller that already loaded the branch and can supply its parent brand skips
the round trip entirely — the common B1-3 path.

**Module boundaries respected.** The brand-of-branch and brand-visibility facts come from
Organisation's published `BRANCH_BRAND_QUERY`; the inherited-grant fact from Identity's
published `SCOPE_REVIEW_QUERY`. The edge is genuinely bidirectional, so both modules use
`forwardRef()` — the `sales` ↔ `treasury` pattern. **No private path is imported in either
direction and `KNOWN_DEVIATIONS` did not grow** (§27).

---

## 15. POS Narrowing

A POS request targeting branch `B` requires **all three**:

1. the scoped assignment model authorises `P` at `B`;
2. `B == branch_of(session terminal)` — derived server-side from live
   `identity.terminals`, **never** from a request body and **never** from a JWT claim;
3. the employee is **still** permitted at `B` under `EmployeeBranch`.

`TenantContext.branchId` is populated **only** for `pos` sessions, from live terminal
state, and `TenantContextService` re-verifies terminal status *and* employee permission on
**every request** — so terminal revocation (`FR-SEC-028`) and HR removal both take effect
on the next request. All failures return one uniform 403: a terminal must not be able to
probe which condition it failed.

**A `TENANT`-scoped role does not let a POS session cross its terminal's branch** — tested
explicitly with a tenant-wide role and an employee permitted at *both* branches (§23 F-1).
`EmployeeBranch` is **AND-only** and appears nowhere in grant computation.

---

## 16. `T-4-LIVE` Token Shape

A **tenant-bound** access token now carries, in addition to `sub`/`sid`/`tid`/`mid`
(and `trm`/`emp`/`typ` where applicable):

| Claim | Meaning |
|---|---|
| `scp` | `FR-API-012` **scope set** — `['tenant']`, `['brand:<id>', …]`, `['branch:<id>', …]`, deduplicated and sorted. |
| `pbr` | `FR-API-012` **permitted branch set** — `{ v: 1, all, brands[], branches[] }`, **symbolic**. |
| `epo` | `memberships.authz_epoch` at mint time. |

Minted at **all four** sites: PIN login, tenant selection, refresh, terminal bind. A
pre-tenant-selection token carries no snapshot (there is no tenant, so no scope set).

**`scp` and `pbr` are never read to authorize.** They are deliberately **not copied onto
the request principal** at all — the surest way to guarantee the authorization path cannot
read them is for it never to receive them. Only `epo` reaches the principal, and only to
*refuse*.

---

## 17. Token Size / Overflow Strategy

The representation is **symbolic**, so the tenant's branch **count never drives token
size**: `TENANT` scope is ONE unit however many branches exist (asserted in a test against
a three-branch tenant); `BRAND X` is one unit per brand; only explicit `BRANCH` grants
enumerate.

`MAX_SNAPSHOT_UNITS = 128`. At roughly 45 bytes per rendered entry this caps the two claims
near 6 KB — inside the ~8 KB header budget of common reverse proxies, with room for the
rest of the token. It is a guard against pathological *assignment* data, not a product
limit on branches: an actor exceeding it is expressing per-branch authority that one
`BRAND` or `TENANT` scope would express in a single unit.

**Overflow fails closed**: `AuthorizationSnapshotService.build` throws a `Forbidden` with
an actionable message. **No token is issued and no assignment is dropped.**
`all: false` with empty lists means **zero** permitted branches; **omission never means
unrestricted**; an unknown `v` fails closed. Proven end-to-end with 130 branch-scoped
assignments: the snapshot builder throws AND `POST /auth/tenant` returns 403 (§23 E-6).

---

## 18. Authorization Epoch Behaviour

`memberships.authz_epoch` is bumped **transactionally, in the same transaction as the
mutation and its audit entry**, on: assignment create, remove, re-scope, validity change,
and inherited-grant review. Reviewing an already-reviewed assignment is idempotent and does
**not** bump (it would invalidate every live token for nothing).

On every request `TenantContextService` compares the token's `epo` to the live value:
mismatch, **or absent on a tenant-bound token**, ⇒ 403 with a uniform "obtain a new access
token". Automatic *expiry* needs no epoch bump and no sweep — live validity evaluation
simply stops returning the assignment.

**A consequence worth stating plainly:** granting authority also invalidates that
membership's live tokens, not only revoking it. That is the ratified fail-closed rule
(clause 12), and two pre-existing RBAC e2e tests were updated to re-authenticate after a
grant rather than assume an old snapshot is honoured (§28).

---

## 19. Assignment API

| Route | Behaviour |
|---|---|
| `POST /auth/memberships/{membershipId}/roles` | **201** with the created assignment. **`scope` is MANDATORY** — never defaulted. Optional `validFrom` / `validTo`. 400 on a bad/missing scope shape, 404 on a foreign membership/role/brand/branch, 403 on a system role, **409** on an overlapping duplicate. |
| `GET /auth/memberships/{membershipId}/roles` | All assignments, including expired ones. |
| `PATCH /auth/role-assignments/{assignmentId}` | Re-scope and/or re-date. |
| `POST /auth/role-assignments/{assignmentId}/review` | **M-4+ outcome A** — record that an inherited tenant-wide grant is intentionally correct, **without forcing a scope change**. Idempotent. |
| `DELETE /auth/role-assignments/{assignmentId}` | **204** — removes exactly one. |
| `DELETE /auth/memberships/{membershipId}/roles/{roleId}` | **DEPRECATED**, retained. Idempotent when absent; removes the single match; **409 fail-closed when the role is held at several scopes**, removing nothing. |

All reuse the existing `identity.role.assign` / `identity.role.read` codes. **No permission
code was created.**

---

## 20. Effective-Scope Read Contract

`GET /auth/permissions` **extended additively** — no duplicate identity endpoint was
created, per the brief:

```jsonc
{
  "permissions": ["…"],            // TENANT-scoped only: what a target-less endpoint accepts today
  "scopes": [ { "assignmentId", "scopeType", "brandId", "branchId", "permissions": ["…"] } ],
  "permittedBranches": { "v": 1, "all": false, "brands": [], "branches": ["…"] },
  "authorizationEpoch": 3,
  "scopeReviewRequired": false
}
```

The pre-B1-2 `{ permissions: [...] }` shape is preserved. `permittedBranches` is symbolic,
so the response never grows with the tenant's branch count. It is **presentation only**
(`FR-SEC-045`); the OpenAPI description states that a client must not infer branch
authority from a role name, `EmployeeBranch`, a home branch, or a flat permission list.

---

## 21. Audit Behaviour

Every assignment mutation writes its audit entry through the **existing** `AuditService`,
via `record(tx, …)` — the mandatory in-transaction path — **inside the same transaction as
the write and the epoch bump**. There is no window in which authority changed but the trail
did not; a rollback loses all three together.

Four verbs added, following the existing `<ENTITY>_<PAST_TENSE>` convention, plus one
entity type `role_assignment`:

`ROLE_ASSIGNED` (reused) · `ROLE_ASSIGNMENT_REMOVED` · `ROLE_ASSIGNMENT_RESCOPED` ·
`ROLE_ASSIGNMENT_VALIDITY_CHANGED` · `ROLE_ASSIGNMENT_REVIEWED`.

Re-scope and validity change are separate verbs because they are materially different
security events — conflating them would leave the trail unable to answer *who widened this
authority, and when*. Entries carry membership, role, **old scope** (`before`), new scope,
validity and origin/review status, which is what makes a grant reconstructible.
**No permission code was created for any of it.**

---

## 22. ADR Created

**`docs/adr/0009-scoped-rbac.md`** — Accepted, 2026-09-02. Twelve decisions D-01…D-12
covering C-1, the scope types (including `BRANCH_GROUP` deferred-not-rejected), the
lattice, table identity, typed scope references, effective dating, `T-4-LIVE`, the bounded
symbolic snapshot, the RLS boundary, the fail-closed B1-2→B1-3 transition, `M-4+`, and the
cross-module contracts.

It **supersedes the branch-scope deferral limbs of ADR 0002 and ADR 0004** and **closes
ADR 0008 D-02**, which required exactly this. Historical ADRs were not rewritten. The ADR
records that the **security review remains required and is B1-3's**.

---

## 23. Tests

### Unit — `src/modules/identity/authz/scope.spec.ts` (new)

The lattice in isolation: `TENANT` covers all three target kinds; `BRAND X` covers X and its
child branches but **not** tenant, **not** brand Y, **not** a branch of Y, **not** a branch
of unknown parentage; `BRANCH X` covers X only — **not** tenant, **not** its own parent
brand, **not** a sibling. Plus lazy brand-resolution logic and the symbolic
permitted-branch set (tenant-wide = 1 unit; dedup + sort; **zero assignments = empty set,
never unrestricted**).

### Unit — `tenant-context.service.spec.ts` (rewritten)

Scoped resolution; **BRAND/BRANCH kept OUT of the flat tenant-target set** while retained
scope-qualified in `grants`; `M-4+` review-state reporting; an inconsistent scope row
contributes nothing rather than a wildcard; and the `T-4-LIVE` fence (behind epoch ⇒ 403;
**no epoch at all ⇒ 403**).

### E2E — `test/scoped-rbac.e2e-spec.ts` (new)

Real PostgreSQL through the RLS-constrained `ros_app` role.

| Group | Coverage |
|---|---|
| **A** | The full lattice end-to-end, incl. brand→branch resolved live through Organisation's contract. |
| **B** | `FR-SEC-003` same role at two branches simultaneously; and "Branch Manager at Branch 1 / Cashier at Branch 2" proving **no cross-scope leakage**. |
| **C** | Transition safety over HTTP: TENANT passes the legacy guard, BRAND and BRANCH are refused; narrow grants absent from the flat set yet present in `scopes`. |
| **D** | Future `validFrom` denies; current grants; **expired via the DATABASE clock** stops granting with no sweep; `validTo <= validFrom` refused. |
| **E** | Token carries subject/tenant/`scp`/`pbr`/`epo`; **tenant-wide is one symbol against a three-branch tenant**; revoked grant ⇒ next request 403 though the token still *claims* the branch; a **server-signed token with a tenant-wide snapshot the holder lacks** is ignored by live resolution; an epoch-less tenant-bound token is refused; **130-assignment overflow fails closed with no truncation**. |
| **F** | POS: a **TENANT-scoped role still cannot cross the terminal's branch**; `EmployeeBranch` removal denies the next request on a live token; **revoked terminal** denies the next request; POS token still cannot reach a dashboard route. |
| **G** | A User with **no Employee** authorises normally; an Employee with **no User** is representable and gains nothing. |
| **H** | Foreign-tenant brand/branch **assignment** scope rejected by the **application**, and **independently by the composite FK even as the migrator role** (RLS is not the FK mechanism). Foreign-tenant **targets**: a TENANT-wide actor is denied a foreign branch and a foreign brand, and **cannot tell either apart from one that does not exist**, while its own tenant's branch/brand still passes; a brand-scoped actor likewise. |
| **K** | The deprecated remove-by-role route: works for one, **409 for several with nothing removed**, and the assignment-id route removes exactly one. |

### E2E — `test/scoped-rbac-migration.e2e-spec.ts` (new)

`M-4+` provenance; the first branch never gated; **second branch denied**; **activating an
existing inactive branch also gated**; **review clears the block without a scope change**;
**re-scoping clears it**; a reviewed grant stops counting while an unreviewed sibling still
blocks; an already-multi-branch tenant keeps operating, is not gated, and is reported
review-required. RLS: `ENABLE`+`FORCE` intact; the `UPDATE` policy exists with **both**
`USING` and `WITH CHECK`; **no branch predicate and no `app.branch_id`**; UPDATE succeeds
only in the owning tenant (cross-tenant touches **0 rows**, target unchanged); re-tenanting
refused by `WITH CHECK`. Temporal: duplicate refused, **succession after expiry allowed**.

### Results actually executed in this session

| Suite | Result |
|---|---|
| **Unit (`npx jest`)** | **838 passed / 838, 61 suites, 0 failed** |
| **Module boundaries** (`module-boundaries.spec.ts`) | **45 passed / 45** |
| `scoped-rbac` + `scoped-rbac-migration` e2e | **44 passed / 44, 2 suites** |
| `rbac` + `audit` + `openapi` + `tenant-context` + `scoped-rbac` e2e | **111 passed / 111, 5 suites** |
| `scoped-rbac*` + `sales` together (interference check) | **109 passed / 109, 4 suites** |
| **FULL e2e (`npm run test:e2e -- --runInBand`)** | **1199 passed / 1199, 66 suites, 0 failed, exit 0** — on a dropped, recreated and freshly migrated `ros_lane_b_b12_zero` |

*(The unit count is 838, not the 842 seen mid-slice: four tests were removed with the
`needsBrandResolution` helper they covered, which the hardened primitive no longer uses.)*

---

## 24. Migration-From-Zero Proof

Database **`ros_lane_b_b12_zero`** (disposable, created for this task). `prisma migrate
deploy` applied **all 37 migrations from an empty database** — *"All migrations have been
successfully applied."*

Verified afterwards by direct catalogue queries: the fourteen columns, the four CHECK/
EXCLUDE constraints, all four foreign keys, the four RLS policies (`SELECT`/`INSERT`/
`UPDATE`/`DELETE`), `relrowsecurity = true` and `relforcerowsecurity = true`, and
`memberships_tenant_id_id_key`.

---

## 25. Legacy-Upgrade Proof

Database **`ros_lane_b_b12_legacy`** (disposable).

1. **All 36 pre-B1-2 migrations only** were applied (the B1-2 migration was held aside).
   Confirmed the genuine PRE-B1-2 shape: columns `membership_id, role_id, branch_id,
   created_at` and `PRIMARY KEY (membership_id, role_id)`.
2. Seeded a realistic legacy fixture: two tenants — one single-branch, one **already
   holding two active branches** — each with an unscoped `membership_roles` row
   (`branch_id NULL`, as production has it).
3. Applied the B1-2 migration.

**Assertions, all true:**

| Check | Result |
|---|---|
| rows preserved | `2` (none lost) |
| every row `scope_type = 'tenant'` | true |
| every row `origin = 'migration'` | true |
| every row unreviewed | true |
| every row has an `id` | true |
| `tenant_id` matches the parent membership | true |
| `valid_from` preserved from `created_at` | true |
| no validity end introduced | true |
| legacy `branch_id` column gone | true |
| `authz_epoch` starts at 0 | true |
| already-multi-branch tenant flagged review-required | true |
| already-multi-branch tenant's branches untouched | `2` |

---

## 26. Typecheck Status

`npx tsc --noEmit -p tsconfig.json` → **exactly one error, pre-existing and untouched**:

```
src/modules/identity/auth/access-token.service.spec.ts(28,7): error TS2322:
Type 'string' is not assignable to type 'number | StringValue | undefined'.
```

`git diff HEAD -- src/modules/identity/auth/access-token.service.spec.ts` is **empty** — the
file is byte-identical to the starting HEAD, so this is the known baseline error the brief
named.

**It is NOT made obsolete by B1-2** and was therefore **not** touched. It is a
`JwtService` `signOptions.expiresIn` typing issue in a local test helper; B1-2 changed the
token *payload* interface (adding optional claims), not `AccessTokenService`'s constructor
or the `JwtService` options type. Fixing it would be an unrelated edit.

**Integration overlap risk with Lane G:** if Lane G independently fixes this same line, the
two changes will touch the same file. B1-2 leaves it untouched, so a Lane G fix should
merge cleanly; if both lanes fix it, expect a trivial conflict on that one line.

**Typecheck was not weakened**: no `any`, no `@ts-ignore`, no `skipLibCheck` change, no
config change. Zero NEW errors.

**One process note, recorded rather than glossed over.** An intermediate full `tsc` run
showed **four additional errors** in `tenant-context.service.spec.ts`, introduced when that
spec was rewritten for scoped resolution: its row-builder helper inferred literal types
(`origin: 'explicit'`, `reviewedAt: null`), which made the deliberate migration-originated
and reviewed variants unrepresentable. `ts-jest` compiled them anyway, so the unit suite was
green while `tsc` was not — a green jest run is NOT evidence of a clean typecheck in this
repository. The helper now declares an explicit `AssignmentRow` interface with the wide
field types the tests genuinely need, and the final `tsc` is back to the single
pre-existing error above. No error was suppressed and no assertion was dropped to achieve
that.

---

## 27. Module-Boundary Result

`src/modules/module-boundaries.spec.ts` — **45 passed / 45.**

The Identity ↔ Organisation edge is now bidirectional and is served **entirely by published
contracts**: `organisation/contract`'s `BRANCH_BRAND_QUERY` and `identity/contract`'s
`SCOPE_REVIEW_QUERY`. Both modules use `forwardRef()`, matching the existing
`sales` ↔ `treasury` precedent. **`KNOWN_DEVIATIONS` was not extended** — the suite fails on
any NEW private path, and it passes.

One assertion was updated: the migration count 35 → 36, with a comment recording why
(Reporting still owns no migration, which is what that assertion guards).

---

## 28. OpenAPI Result

Regenerated with `npm run openapi:generate` (`nest build` + the generator). **Never
hand-edited.** `docs/api/openapi.json` and `.yaml` updated; **156 operations** documented.

New/changed operations: `POST /auth/memberships/{membershipId}/roles` (now **201 with a
body**), `GET /auth/memberships/{membershipId}/roles`,
`PATCH /auth/role-assignments/{assignmentId}`,
`POST /auth/role-assignments/{assignmentId}/review`,
`DELETE /auth/role-assignments/{assignmentId}`, and the extended `GET /auth/permissions`.

`test/openapi.e2e-spec.ts`'s bodyless allowlist was updated accordingly: the assign route
is removed (it now returns a body) and `DELETE /auth/role-assignments/{assignmentId} 204`
added. The OpenAPI contract suite passes.

### Pre-existing suites updated, and exactly why

| Suite | Change | Cause |
|---|---|---|
| 23 e2e suites + fixtures | `membershipRoles.assign(t, m, r)` → `create(t, null, { membershipId, roleId, scope: { type: 'tenant' } })` | Scope is mandatory; a `null` actor is the bootstrap/system actor (audited as `system`), which the API path never uses. |
| `rbac.e2e-spec.ts` | raw `membershipRole.create/delete` given `id`/`tenantId`/`scopeType` and addressed by `id` | Table identity changed. |
| `rbac.e2e-spec.ts` tests 4/6 and 5 | re-authenticate after a grant; assignment cleaned up | **T-4-LIVE**: granting bumps the epoch, so a token minted before the grant is stale (§18). Re-assigning the same role at the same scope is now a 409 duplicate. |
| `rbac.e2e-spec.ts`, `audit.e2e-spec.ts` | send `scope`, expect **201** | Mandatory scope; route returns the created assignment. |
| 3 service specs | new `AuthorizationSnapshotService` constructor arg; expected token shape includes `scp`/`pbr`/`epo` | T-4-LIVE. |
| `module-boundaries.spec.ts` | 35 → 36 migrations | This migration. |
| `openapi.e2e-spec.ts` | bodyless allowlist | The 204 → 201 change. |

One **real defect** was found and fixed while doing this: an omitted `scope` produced a
**500** (the mapper dereferenced `undefined`). `@IsDefined()` + `@IsObject()` now make it a
**400** at the edge. An omitted scope must never be a server error — and must certainly
never default.

---

## 29. Requirement Disposition — no overclaims

| Requirement | Status after B1-2 | Why |
|---|---|---|
| **`FR-SEC-002`** [M] | **COMPLETE** | *"Role assignments SHALL carry a scope, restricting the assignment to a tenant, a brand, a set of branches, or a single branch."* All four shapes are representable and enforced at the database layer (a set of branches = multiple `branch` rows), verified end-to-end. The requirement is about the assignment carrying a scope, and it does. |
| **`FR-SEC-003`** [M] | **COMPLETE** | *"A user MAY hold multiple role assignments with different scopes."* The blocking primary key is gone; the SRS's own worked example is directly tested, including "same role at two different branches". |
| **`FR-SEC-004`** [M] | **PARTIAL** | The union is computed **within each assignment's own scope** and non-leakage is proven for the primitive and the transitional guard. But the clause is a property of *every applicable business operation*, and B1-3 has not yet attached a target scope to them. **MUST remain PARTIAL until B1-3 proves enforcement across all applicable business surfaces.** |
| **`FR-SEC-005`** [S] | **COMPLETE** | *"Role assignments SHALL support validity dates, enabling temporary elevation … that expires automatically."* Columns, DB constraints, live DB-clock evaluation, admin APIs, and automatic expiry with no sweep job — all directly verified. |
| **`FR-API-012`** [M] | **PARTIAL** | Clause 1 (token carries subject, tenant, scope set, permitted branch set) is implemented. **Clause 2** — *"Every request SHALL be authorised against both the permission and the scope"* — is only true for operations that declare a target scope, which is B1-3. **MUST remain PARTIAL.** |
| **`FR-SEC-028`** [M] | **PARTIAL (unchanged)** | Server-side registration, revocation and immediate credential invalidation are implemented (and B1-2 additionally re-checks terminal status on every POS request). The *"wiping its local data on next contact"* limb is still not implemented. B1-2 did not address it and does not claim it. |
| `FR-SEC-001` / `FR-SEC-045` | COMPLETE (unchanged) | Not re-claimed by this slice. |
| `FR-PLT-012` | COMPLETE (unchanged) | Fail-closed tenant context preserved; RLS not weakened. |
| `FR-PLT-013` | PARTIAL (unchanged) | No generated isolation suite and no CI pipeline. B1-2 claims nothing here. |
| `FR-BRN-005` | PARTIAL (unchanged) | `BRANCH_GROUP` scoping is the mandatory follow-up; not implemented. |
| `FR-SEC-010` / `012` | NOT IMPLEMENTED (unchanged) | Appendix C absent; no role seeded, no code created. |

**Governance approval is not implementation credit, and B1-2 alone is not a
production-ready claim.** The security review ADR 0008 D-02 requires has not been done.

---

## 30. Remaining B1-3 Work

1. Attach an explicit target scope to **every applicable business operation** — not merely
   routes containing `:branchId`, but also body branch ids, resources whose branch is
   implicit through a referenced entity, **BRAND-target** operations, and **TENANT-target**
   operations where a narrower assignment must not leak upward.
2. Build the **generated/enumerated authorization-coverage gate** so a future scoped surface
   cannot ship unprotected. (It cannot claim `FR-PLT-013` — no CI pipeline exists.)
3. The **cross-branch E2E matrix**, and preservation of cross-tenant isolation.
4. Confirm the lattice and POS narrowing across the real business surface.
5. The **security review** ADR 0008 D-02 requires.
6. **Retire the Internal-MVP single-active-branch mask** in Reporting and Day Close, once
   B1-2 is complete, B1-3 enforcement is complete, and the tenant's `M-4+` review is
   satisfied — failing closed for tenants still under review.
7. Move `FR-SEC-004` and `FR-API-012` from PARTIAL only when the above is proven.

### §30-A — Full e2e run, and the runs that preceded it

The final gate is the **1199 / 1199, 66 / 66 suites, exit 0** recorded in §23, produced in
this session against a dropped-and-recreated `ros_lane_b_b12_zero`.

Three earlier full runs are recorded here rather than quietly discarded, because two of
them failed and the reasons matter:

| Run | Result | Cause |
|---|---|---|
| 1 | 1196 / 1197, 1 failed | `organisation.e2e-spec`'s repository-wide *"no org location entity without a registry row"* invariant, broken by MY overflow test creating 130 branches through the migrator client. **A real defect in my test arrange**, fixed by writing the `org.locations` rows `BranchesService.create` would have written. |
| 2 | 944 / 1199, 255 failed | **`beforeAll` hook timeouts at 5000 ms**, not logic failures: the suites boot the whole `AppModule` in `beforeAll`, and the machine was simultaneously running two `tsc` passes, a unit suite of mine, and **another lane's e2e suite in a different worktree**. Invalid as evidence, and my own concurrency was part of the cause. |
| 3 | 1147 / 1199, 52 failed | Same hook-timeout signature in three suites, plus one `sales.e2e-spec` 403→401. `sales` was then run in isolation (**63 / 63**) and alongside both new suites (**109 / 109**), so it was not caused by this slice. |
| **4 (final)** | **1199 / 1199, exit 0** | Run alone, uncontended, on a fresh database. |

**No prior run's numbers are re-reported as the final result**, and the only failure
attributable to this slice's own code or tests (run 1) was fixed, not explained away.

---

## 31. Integration Conflict Risks

| Risk | Detail |
|---|---|
| **Identity migration surface** | `B2-5` (API keys) and `F2-1` (Workforce) both touch the `identity` schema and **MUST NOT** run concurrently with B1-2. B1-2 goes first; it changes `membership_roles`' identity and adds a column to `memberships`. |
| **`access-token.service.spec.ts` TS2322** | Untouched by B1-2 (byte-identical to HEAD). If **Lane G** fixes the same line, expect a one-line conflict at most (§26). |
| **Token contract** | Any lane minting an access token must go through `AuthorizationSnapshotService`; a tenant-bound token without `epo` is now refused. Four mint sites were updated; a new one added elsewhere would fail closed, which is the safe direction. |
| **`RequestAuthorization.permissions` narrowed** | Now tenant-scoped only. In-repo consumers (`treasury.controller`, `day-close.controller`, `governance/approvals`) are unaffected because their callers hold tenant-scoped roles today — but any lane adding a consumer must use the primitive, not the flat set. |
| **`POST .../roles` 204 → 201 + mandatory scope** | A breaking API change. Any lane or client calling it must send `scope`. |
| **Bidirectional Identity ↔ Organisation module edge** | New `forwardRef()` on both sides. A lane restructuring either module's imports should preserve it. |
| **`docs/api/openapi.*`** | Regenerated; any concurrent lane touching routes will conflict in the generated document. Resolve by regenerating, never by hand-editing. |

---

## 32. Commit

- **Subject:** `feat(security): implement scoped role assignments`
- Files staged **explicitly** (no `git add .`, no `git add -A`).
- One independently reviewable B1-2 slice commit.

---

## 33. Push / Deploy Status

| | |
|---|---|
| **Pushed** | **NO** |
| **Merged / rebased / cherry-picked** | **NO** |
| **Deployed** | **NO** |
| **Destructive git operations** | **NONE** |
| **Persistent `ros` database touched** | **NO** — see below |

### Database safety

All database work used **disposable Lane-B databases only**: `ros_lane_b_b12_zero` and
`ros_lane_b_b12_legacy`. A guard script mediated every create/drop and was **proven to
refuse** `ros`, `postgres` and any unrecognised name **before** being used for real
(exit 90 / 91 on each attempt). No `DROP`/`ALTER` was ever issued against `ros`,
`postgres`, `template0` or `template1`. Only databases created by this task were dropped.

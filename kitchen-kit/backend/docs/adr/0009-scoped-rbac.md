# ADR 0009 — Scope-aware RBAC (tenant / brand / branch)

- Status: **Accepted.** Ratified by the project owner on **2026-09-02** as
  `AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC` in
  `docs/governance/GOVERNANCE_DECISION_REGISTER.md`. This ADR records the
  architecture that ratification authorises; the register remains authoritative.
- Date: 2026-09-02
- Phase: Full-SRS 4-Day execution, P2-SEC / B1-2
- Deciders: Project owner (explicit governance action). The options, the
  evidence, and the rejected alternatives are recorded in
  `docs/reports/claude/full-srs-4day/2026-09-02_B1-1_branch-rbac-governance-gate.md`
  and the acceptance correction
  `docs/reports/claude/full-srs-4day/2026-09-02_B1-1_branch-rbac-ratification.md`.
- **Supersedes:** the *branch-scope deferral* limbs of **ADR 0002** ("Branch
  scope") and **ADR 0004** ("Branch authorization — DEFERRED"), and closes
  **ADR 0008 D-02**, which required exactly this: *"Scope-aware RBAC receives its
  own phase, its own ADR superseding the relevant parts of ADR 0002 and ADR 0004,
  and its own security review."*
- **Does NOT supersede** anything else in ADR 0002 or ADR 0004. Tenant context
  resolution, the `withAuthContext` mechanism, terminal identity, and the guard
  chain are preserved exactly.
- **Security review:** still REQUIRED, and is B1-3's, not this slice's. ADR 0008
  D-02 asks for a review of scope-aware RBAC as a whole; that is only meaningful
  once enforcement exists across the business surface.

> **Reading note.** This ADR is architecture, not authority. Where it and the
> ratified register entry differ, the register wins. It records no requirement as
> satisfied: B1-2 delivers persistence, resolution, the token contract and the
> primitive. `FR-SEC-004` and `FR-API-012` remain **PARTIAL** until B1-3 proves
> enforcement across every applicable business operation.

## Context

Tenant isolation in ROS is strong: RLS is `ENABLE`d and `FORCE`d, every runtime
query runs through one `withAuthContext` transaction, and `FR-PLT-012` fails
closed. **Branch isolation did not exist.** Within a tenant, any principal
holding a permission could exercise it against every branch:
`identity.membership_roles.branch_id` was never written and never read;
`TenantContext.branchId` was declared "RESERVED" and never populated;
`PermissionGuard` had no branch dimension; and
`organisation/branch-scope.ts::assertBranchInScope` verified **tenant
visibility**, not caller authorisation.

That gap was knowingly accepted (ADR 0008 D-02, `docs/organisation/authorization.md`)
and masked by the Internal-MVP posture, which refuses reporting and day-close
operations unless a tenant has exactly one active branch. **The mask disappears
the moment a pilot tenant activates a second branch**, which is the multi-branch
posture the Full-SRS programme targets.

## Decision

### D-01 — C-1: scoped role assignment is the SOLE authorization grant source

Authority derives only from
`Membership → scoped MembershipRole assignment → Role → RolePermission → Permission`.

**`EmployeeBranch` and `Employee.homeBranchId` MUST NOT grant, widen, infer or
imply authorization.** They remain HR (`FR-HRM-001`/`005`) and
authentication-integrity (`FR-SEC-021`/`022`) substrate. For POS sessions they
may **narrow** authority as an additional AND condition; they are never an OR.

**Invariant: authorization cannot exist merely because an employee belongs to a
branch.** This is stated as an invariant, not a convention, because the repository
already ships a permitted-branch relation built for a different purpose, and the
most likely way this design decays is for that relation to drift into becoming a
second, informal authorization source.

*Rejected:* keeping assignments tenant-level and intersecting them with a
permitted-branch relation. It cannot represent `FR-SEC-003`'s own worked example
("Branch Manager at Branch 1 and Cashier at Branch 2") and violates
`FR-SEC-004`'s non-leakage clause by construction.

### D-02 — Scope types: `TENANT`, `BRAND`, `BRANCH` — and no others

`FR-SEC-002` names tenant, brand, a set of branches, and a single branch. **A
"set of branches" is MULTIPLE `branch`-scoped assignment rows** — not an array
column, not a polymorphic branch-set object, not an invented group surrogate.
That modelling is also the direct reason the table's identity had to change
(D-04).

`WAREHOUSE`, `CENTRAL_KITCHEN` and `LOCATION` are **not authorised**: no SRS
requirement scopes a role assignment to any of them, `org.warehouses.branch_id`
is nullable (so a warehouse scope would be undefined for tenant-level
warehouses), and `org.central_kitchens` is tenant-level, so `TENANT` already
covers it.

**`BRANCH_GROUP` is DEFERRED, NOT REJECTED.** `FR-BRN-005` [M] names branch
groups as *"a reporting and **permission-scoping** dimension"*, but the canonical
`BranchGroup` entity does not exist yet. Adding the scope type before the entity
would create an unresolvable scope. **It is a MANDATORY follow-up once that
entity lands**, and the enum plus typed-column design admits it **additively**,
without reinterpreting what `TENANT`, `BRAND` or `BRANCH` already mean.

### D-03 — The generic target-scope lattice

A protected operation carries a **required permission `P`** and a **target
resource scope `S` ∈ {`TENANT`, `BRAND(id)`, `BRANCH(id)`}**. Coverage is
**directional downward only**:

| Assignment | COVERS | DOES NOT COVER |
|---|---|---|
| `TENANT` | `TENANT`; all `BRAND`; all `BRANCH` in the tenant | anything outside the tenant |
| `BRAND X` | `BRAND X`; `BRANCH` whose parent brand is X | `TENANT`; another brand; branches of another brand |
| `BRANCH X` | `BRANCH X` only | `TENANT`; any `BRAND`; any other branch |

Authorization requires that **ONE SINGLE assignment** satisfies both halves: its
role grants `P` **and** its scope covers `S`. That "same assignment" quantifier
IS `FR-SEC-004`'s non-leakage clause — a permission held at Branch 1 and a
different permission held at Branch 2 never combine into authority at either.

**Target scope is derived from the protected RESOURCE, never from a
classification of permission codes.** SRS **Appendix C is absent**, so any
tenant-only/branch-only classification of the catalogue would be authored rather
than derived. This design deliberately does not need one.

The lattice lives in one pure, dependency-free module
(`identity/authz/scope.ts`) and is unit-tested directly, because it is the
security invariant.

### D-04 — Assignment identity: a stable surrogate id

`@@id([membershipId, roleId])` is REPLACED by a surrogate `id`. ADR 0008 D-02
already recorded why: that key admits one row per membership+role, so
`FR-SEC-003`'s worked example was half-representable and "Cashier at Branch 1
AND Cashier at Branch 2" was not representable at all. *"Fixing that is a change
to the RBAC table's identity, not an additive column."*

### D-05 — Typed scope references, never a polymorphic `scope_id`

`scope_brand_id` and `scope_branch_id` are separate nullable columns, each with a
tenant-safe **composite FK** (`(tenant_id, <col>)`), and a CHECK binds them to
`scope_type` so an inconsistent row cannot exist.

A single polymorphic `scope_id` cannot carry a foreign key. **PostgreSQL
evaluates referential-integrity checks with row security DISABLED** (ADR 0008
D-09), so RLS can never prevent a cross-tenant scope reference — only an FK can.
A bare `scope_id` would reproduce exactly the unenforced-UUID defect that the
2026-08-19 D-2 amendment was raised to fix on `Terminal.branch_id`.

`membership_roles` gains its own `tenant_id` (making those composite FKs
possible, and letting RLS predicate directly instead of joining `memberships`),
and `memberships` gains `UNIQUE (tenant_id, id)` as the composite-FK target.

The legacy `branch_id` column is **dropped**, not kept alongside
`scope_branch_id`: two branch-shaped columns with different authority is a
permanent ambiguity, and the migration proves the old column held no data.

### D-06 — `FR-SEC-005` effective dating, on the DATABASE clock

`valid_from` / `valid_to` on the assignment, with a CHECK that `valid_to` is
NULL or strictly after `valid_from`, and a `btree_gist` EXCLUDE constraint
forbidding two assignments of the same role at the same exact scope with
overlapping validity windows. Historical and future assignments stay
representable; only genuine duplication — which `FR-SEC-004`'s union would
double-count — is forbidden.

Validity is evaluated **live, per request, against `now()` read inside the
request's own transaction**. Expiry therefore needs no sweep job, and cannot
drift with a mis-set application host clock.

`identity.membership_roles` had `SELECT`/`INSERT`/`DELETE` RLS policies only,
under `FORCE`; PostgreSQL consequently denied every `UPDATE`, which made
effective-dating and review impossible at runtime. A tenant-safe `UPDATE` policy
with **both** `USING` and `WITH CHECK` is added — `USING` alone would permit
re-tenanting a row.

### D-07 — T-4-LIVE: the token carries a snapshot; the database decides

A tenant-bound access token carries the `FR-API-012` clause-1 payload — subject,
tenant, **scope set** (`scp`) and **permitted branch set** (`pbr`) — plus an
**authorization epoch** (`epo`).

**THE TOKEN IS NOT THE AUTHORIZATION SOURCE.** Every protected request
re-resolves the current scoped assignments server-side and decides from live
state. `scp` and `pbr` are never read to grant; they are deliberately not even
copied onto the request principal. `epo` is used only to REFUSE a token whose
snapshot no longer matches the live membership.

The epoch is bumped transactionally on every authority change (create, remove,
re-scope, validity change, inherited-grant review), in the same transaction as
the mutation and its audit entry. A removed or re-scoped assignment therefore
stops authorising on the **next request**, with no token blacklist and no
revocation sweep — which is what keeps `FR-SEC-028`'s *immediate* invalidation
requirement intact while still satisfying `FR-API-012` clause 1.

### D-08 — The permitted-branch set is SYMBOLIC and bounded

`FR-BRN-001` [M] permits unlimited branches per brand and brands per tenant, so
an expanded branch list in a header would be unbounded *by requirement*. The
snapshot therefore carries the SYMBOL that produced the authority:

- `TENANT` scope → `all: true` — **one unit, whatever the tenant's branch count**;
- `BRAND X` → one unit per brand;
- `BRANCH B` → one unit per explicit branch.

`all: false` with empty lists means **zero** permitted branches. **Omission never
means unrestricted.** A budget (128 units) guards against pathological assignment
data — not against branch count, which the representation has removed from the
equation. **Overflow FAILS CLOSED: the token is refused, never truncated**, with
an actionable message. Silent truncation would issue a token understating
authority and would train readers to treat an incomplete set as complete.

### D-09 — Branch authorization is an APPLICATION layer; RLS stays tenant-only

> Tenant RLS answers: *does this row belong to the tenant?*
> Application authorization answers: *may this actor perform `P` against `S`?*

No branch predicate enters any RLS policy; no `app.branch_id` GUC is introduced;
tenant RLS keeps `ENABLE` + `FORCE` and is not weakened. A branch predicate is
not even universally definable — `roles`, `permissions`, `brands`, tenant-level
`warehouses` and most Catalogue master data have no branch column, and
branch-owned Organisation rows carry no `tenant_id` at all (their tenant boundary
is the parent branch). Encoding `FR-SEC-004`'s per-scope union in SQL policies
would be a second implementation of authorization, guaranteed to diverge.

A future branch-aware RLS defence-in-depth layer requires **its own ADR and its
own governance review**. ADR 0008 D-02 already recorded that introducing it later
is *"additive at the policy layer"*, so deferring costs nothing.

### D-10 — The B1-2 → B1-3 transition is fail-closed by construction

B1-2 introduces scoped assignments before B1-3 attaches an explicit target scope
to every business operation. If the resolved permission set stayed a flat union
of all assignments, a BRANCH-scoped grant would satisfy every not-yet-converted
route in the tenant — the slice meant to close an authorization gap would have
opened a wider one.

Therefore: **an operation carrying `@RequirePermission(P)` and no explicit target
scope is a TENANT-target operation**, and `RequestAuthorization.permissions`
contains **only** the permissions of `tenant`-scoped assignments. BRAND- and
BRANCH-scoped grants are never flattened into it; they reach a route only through
`ScopeAuthorizationService` with an explicit target.

Consequences, all intended: migrated legacy TENANT assignments keep working
unchanged; new narrow assignments fail closed on unconverted routes; and B1-3's
job is to add the correct target scope operation by operation.

### D-11 — M-4+ migration posture

Every pre-existing assignment is backfilled `scope_type = 'tenant'`, because
tenant-wide is what an unscoped assignment actually meant — behaviour is
preserved exactly on migration day. Each backfilled row is stamped
`origin = 'migration'` with `reviewed_at IS NULL`, so **inherited authority stays
permanently distinguishable from deliberately granted authority**; without that,
no targeted remediation is ever possible.

- **A tenant may not activate a SECOND active branch while unreviewed inherited
  grants remain.** The gate lives at Organisation's branch-creation and
  branch-activation paths (`branches.status` defaults to `active`, so creation is
  activation), runs inside the caller's transaction, and fails closed with an
  actionable message. This is the only Organisation business behaviour B1-2
  changes, and it is specifically authorised because the migration requires it.
- **An already-multi-branch tenant is NOT failed by the migration** and is NOT
  declared branch-RBAC-ready. Its review-required state is derived and reported;
  its existing operations are untouched; and the Internal-MVP
  single-active-branch mask must not be retired for it until its inherited grants
  are reviewed or re-scoped.
- Review has two outcomes, both clearing the condition, both audited, both
  bumping the epoch: **retain** the tenant scope as intentionally correct, or
  **re-scope** it to brand/branch grants. An administrator is never forced to
  change a scope that was already right merely to mark it reviewed.

### D-12 — Cross-module contracts, not shortcuts

The lattice's "BRAND X covers a branch whose parent brand is X" limb needs
`org.branches.brand_id`, and the M-4+ gate needs Identity's inherited-grant
state. Both cross a module boundary, and neither takes a shortcut:
Organisation publishes `BRANCH_BRAND_QUERY` and Identity publishes
`SCOPE_REVIEW_QUERY`, each in its module's `contract/` directory per SRS §5.4.
The edge is genuinely bidirectional, so both modules use `forwardRef()` — the
pattern `sales.module.ts` ↔ `treasury.module.ts` already established.
`module-boundaries.spec.ts` enforces that no private path is imported in either
direction, and no new `KNOWN_DEVIATIONS` entry is added.

## Consequences

**Gained.** `FR-SEC-002`, `FR-SEC-003` and `FR-SEC-005` become implementable and
implemented at the persistence and resolution layers; `FR-SEC-004`'s non-leakage
clause becomes *expressible and testable* for the first time; a stale token can
no longer outlive a revoked grant; and inherited tenant-wide authority can no
longer silently widen when a tenant goes multi-branch.

**Costs, accepted.** `RequestAuthorization.permissions` narrows to tenant scope —
an internal breaking change, contained in-repo, and the point of D-10. The
frontend contract changes: permissions become scope-qualified, and
`GET /auth/permissions` is extended (additively — the pre-B1-2 shape is
preserved) with the effective-scope read contract. A tenant-bound access token
minted before this change has no `epo` and is refused as stale; a refresh mints a
current one.

**Explicitly NOT delivered here.** Route-wide enforcement (B1-3), the security
review (B1-3), `BRANCH_GROUP` (blocked on the entity), branch-aware RLS (D-09),
API keys, MFA, Workforce completion, and any permission-catalogue work
(Appendix C remains absent). Retirement of the Internal-MVP
single-active-branch mask is B1-3's, after enforcement and review are complete.

## Relationship to ADR 0001–0008

- **ADR 0001** (identity/tenancy) — unchanged, except that `membership_roles`,
  which ADR 0001 introduced, changes identity per D-04.
- **ADR 0002** (tenant context) — the branch-scope deferral limb is
  **superseded**; `TenantContext.branchId` is no longer "RESERVED" and is
  populated for POS sessions from live terminal state. Everything else — the
  server-derived context, the single resolver, per-request memoization — is
  preserved exactly.
- **ADR 0003** (RLS) — preserved exactly, plus one added `UPDATE` policy on
  `identity.membership_roles`. No branch predicate, no new GUC, no weakening.
- **ADR 0004** (terminal identity) — the "branch authorization deferred" limb is
  **superseded**. The terminal's branch, already made structurally tenant-safe by
  the 2026-08-19 D-2 amendment, is now the POS session's operating branch.
- **ADR 0005 / 0006** — untouched.
- **ADR 0007** (audit) — reused unchanged. Assignment changes are audited through
  the existing writer, inside the mutation's own transaction. Four audit verbs
  are added following the existing `<ENTITY>_<PAST_TENSE>` convention; **no
  permission code is created**.
- **ADR 0008** — **D-02 is closed by this ADR.** D-09's composite-FK posture is
  applied to every scope reference. Nothing else in ADR 0008 changes.

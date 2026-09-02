# B1-1 — Branch-Scoped RBAC: Acceptance Correction + D-2 Ratification

| Field | Value |
|---|---|
| **Task / Slice** | `B1-1` — ACCEPTANCE CORRECTION + D-2 RATIFICATION (P2-SEC, lane B, merge wave 1) |
| **Report type** | GOVERNANCE RATIFICATION + ACCEPTANCE CORRECTION |
| **Authority** | **This report is NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. **The authoritative record of this ratification is the register amendment `AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC`**, written under `D-2` in this same commit. Where this report and the register differ, **the register wins.** |
| **Date** | 2026-09-02 |
| **Starting HEAD** | `1e53a2132fa8367e3470d489bb5132cec7df1a4c` (`docs(security): prepare branch RBAC governance gate`) |
| **Ultimate baseline** | `63d3b7c2ea5f999bb9ba7277d51a5da3c6950a71` |
| **Branch** | `full-srs/lane-b-security-platform` |
| **Working tree at start** | Clean (`git status --short --untracked-files=all` empty) |
| **Mode** | Governance ratification + acceptance correction **only**. No product code, no schema, no migration, no route, no permission, no token change. No merge, rebase, push or deploy. |
| **Task identifier** | `P2-SEC / B1-1` (acceptance correction) |

---

## 1. Status

**COMPLETE.** The user's explicit governance approval has been recorded as a **forward
amendment to D-2** in `docs/governance/GOVERNANCE_DECISION_REGISTER.md`, titled
**`AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC`**, **RATIFIED 2026-09-02**.

**B1-2 is GOVERNANCE-UNBLOCKED and authorised to start. B1-3 follows B1-2.**

**Nothing was implemented.** `FR-SEC-002`, `FR-SEC-003`, `FR-SEC-004` and `FR-SEC-005` are
**RATIFIED FOR IMPLEMENTATION — NOT IMPLEMENTED**. `FR-API-012` is **RATIFIED DESIGN — NOT
YET COMPLETE**. `FR-SEC-028` is corrected to **PARTIAL globally**. Governance approval is
**not** implementation credit.

---

## 2. User Authority

The user gave **explicit approval** to proceed with a durable, scalable,
Full-SRS-oriented branch authorization architecture, and issued the acceptance
correction that constrains it. That authority is recorded in the register amendment as
*"RATIFIED 2026-09-02, by explicit user governance action in the Full-SRS 4-Day
execution."*

**This acceptance correction — not the B1-1 report's §14 proposal — is the authoritative
post-review governance outcome.** Where the two differ, the register amendment governs,
and the differences are enumerated in §5 below. The original B1-1 report remains
important evidence and its analysis was **not** rewritten.

---

## 3. Starting HEAD and Verified Start State

| Check | Required | Observed |
|---|---|---|
| Worktree | `/Users/mac/projects/ros-worktrees/lane-b` | `/Users/mac/projects/ros-worktrees/lane-b` (`git rev-parse --show-toplevel`) |
| Branch | `full-srs/lane-b-security-platform` | `full-srs/lane-b-security-platform` |
| HEAD | `1e53a21` (B1-1 report commit) | `1e53a2132fa8367e3470d489bb5132cec7df1a4c` |
| Working tree | clean | clean — `git status --short --untracked-files=all` returned nothing |
| Parent history | `1e53a21` → `63d3b7c` | `1e53a21` · `63d3b7c` · `358feb4` · `0887193` · `ec616a0` |
| `docs/governance/GOVERNANCE_DECISION_REGISTER.md` | exists | present (8,065 lines pre-edit) |
| `…/full-srs-4day/2026-09-02_B1-1_branch-rbac-governance-gate.md` | exists | present |
| `…/full-srs-4day/INDEX.md` | exists | present |

**No mismatch. No stop condition triggered.**

---

## 4. B1-1 Reviewed Findings — ACCEPTED

The following B1-1 findings were reviewed and are **accepted and carried into the
ratification**:

| # | Accepted finding | Where it lands |
|---|---|---|
| 1 | **Branch isolation does not exist.** Within a tenant, any principal holding a permission may exercise it on every branch. `membership_roles.branch_id` is never written and never read; `TenantContext.branchId` is never populated; `PermissionGuard` has no branch dimension; `assertBranchInScope` verifies **tenant visibility**, not caller authorisation. | Amendment PROBLEM statement |
| 2 | **Tenant isolation and RLS are strong and unaffected.** The gap is **intra-tenant**, never cross-tenant. | Amendment clause 14 |
| 3 | **D-2 CORE ONLY and its 2026-08-19 amendment still deferred `FR-SEC-002`/`003`/`004`/`005`**, re-affirmed as recently as the DAY CLOSE ratification of 2026-08-31. | Amendment CONTEXT |
| 4 | **A single polymorphic `scope_id` is unacceptable** — it cannot carry a foreign key, and would reintroduce the unenforced-UUID defect the 2026-08-19 amendment fixed on `Terminal.branch_id`, breaking the ADR 0008 D-09 tenant-safe composite-FK posture. | Amendment clause 10 |
| 5 | **`@@id([membershipId, roleId])` cannot remain the assignment identity** — it makes `FR-SEC-003`'s own worked example class unrepresentable. A table-identity migration is required. | Amendment clause 11 |
| 6 | **`identity.membership_roles` has no `UPDATE` RLS policy** under `ENABLE` + `FORCE` (only `SELECT`/`INSERT`/`DELETE`), so `FR-SEC-005` expiry-by-update is impossible at runtime as the table stands. | Amendment clause 12 |
| 7 | **`EmployeeBranch` must never be an authorization grant** — reusing it would let an HR-side branch assignment silently confer authority. | Amendment clause 1 |
| 8 | **Option B is unusable** — it cannot represent `FR-SEC-003`'s worked example and violates `FR-SEC-004`'s non-leakage clause by construction. | Amendment clause 1 (C-1 ratified) |
| 9 | **Scope types must not be invented** — `WAREHOUSE`, `CENTRAL_KITCHEN`, `LOCATION` have no SRS basis for role-assignment scoping. | Amendment clause 4 |
| 10 | **The permission catalogue must not be classified**, because SRS Appendix C is absent (SIG-03). | Amendment clauses 3 and 20 |
| 11 | **The enforcement surface is far larger than the 4 existing `assertBranchInScope` call sites** — 20 `:branchId` path routes plus 10 body-`branchId` DTO families, and more via implicit entity ownership. | Amendment clause 17 |
| 12 | **ADR 0008 D-02 requires a superseding ADR** for the relevant parts of ADR 0002 and ADR 0004, plus a security review. | Amendment clauses 16(15) and 17(7) |
| 13 | **The Internal-MVP single-active-branch posture is a mask, not a fix**, and must be dispositioned explicitly. | Amendment clause 18 |
| 14 | **`M-4` migration direction** — backfill `TENANT`, mark provenance, gate second-branch activation. | Amendment clause 13, **strengthened to `M-4+`** |

---

## 5. Corrections to the Original B1-1

Five corrections. **Each is a deliberate departure from the B1-1 report's §14 proposal, and
in each case the correction governs.**

| # | Original B1-1 §14 proposal | **RATIFIED CORRECTION** | Why |
|---|---|---|---|
| **C-I** | **`T-2`** — server-side resolution only; token unchanged; `FR-API-012` clause 1 knowingly deviated and recorded PARTIAL. | **`T-4-LIVE` RATIFIED. `T-2` NOT RATIFIED.** The token carries the SRS-required snapshot (subject, tenant, scope set, permitted branch set) **plus a scope epoch/version**; **server-side live resolution remains authoritative** and no decision may rely solely on a claim. | The objective is **Full-SRS compliance without making JWT claims the authorization source of truth.** `T-2` bought immediate revocation by declining an `[M]` clause; `T-4-LIVE` obtains both, because the epoch makes a stale snapshot detectable and the live re-resolution keeps revocation immediate. |
| **C-II** | Authorization framed largely as **`permission + branchId`**. | **GENERIC TARGET-SCOPE LATTICE RATIFIED.** A protected operation carries a **required permission `P`** and a **target resource scope `S` ∈ {`TENANT`, `BRAND(id)`, `BRANCH(id)`}**, with strictly **downward** coverage. | `permission + branchId` cannot express `BRAND`-target operations, cannot stop a narrow assignment leaking **upward** into a `TENANT` target, and would have forced a permission-catalogue classification that **Appendix C's absence forbids**. Deriving scope from the **resource/operation target** avoids that dependency entirely. |
| **C-III** | **`M-4`** — backfill `TENANT`, mark provenance, gate second-branch activation. | **`M-4+`** — `M-4` **plus an explicit already-multi-branch tenant case (clause 13.D)**: do not fail the migration; do not declare the tenant branch-RBAC-ready; preserve existing behaviour; mark the tenant as requiring scope review; and **do not retire the single-active-branch mask for that tenant** until inherited assignments are reviewed or re-scoped. Re-scoping is audited. | `M-4` only covered a tenant *moving into* multi-branch operation. It was silent on a tenant that is **already** multi-branch at migration time — the case where inherited `TENANT` authority is **already** effective across branches. |
| **C-IV** | `BRANCH_GROUP` listed under **NON-GOALS**, alongside genuinely unnecessary scope types. | **`BRANCH_GROUP` is DEFERRED FROM B1-2, EXPLICITLY *NOT* REJECTED**, and is recorded as a **MANDATORY Full-SRS FOLLOW-UP** once the canonical `BranchGroup` entity exists — because **`FR-BRN-005`** [M] requires branch groups as a permission-scoping dimension. **The B1-2 data model MUST remain additively extensible to it.** | Listing an `[M]`-backed dimension among non-goals risked it reading as rejected. It is deferred on an **entity-availability** ground only. |
| **C-V** | `FR-SEC-028` cited as **COMPLETE** (carried from the P0 traceability row). | **`FR-SEC-028` IS `PARTIAL` GLOBALLY.** See §13. | The requirement's third limb — *"wiping its local data on next contact"* — is not implemented. §13 records the evidence. |

**Not a correction, but recorded for precision:** the B1-1 report's `R-1 … R-13`
fail-closed rules are **carried forward and corrected to the generic target-scope model**,
with additional invariants ratified (§17).

---

## 6. D-2 Reopening

**Recorded as a forward amendment beneath the existing D-2 entry**, in the register's
established convention — the same convention the 2026-08-19 amendment used.

- **Title:** `AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC`
- **Ratified:** 2026-09-02
- **Authority:** explicit user governance action in the Full-SRS 4-Day execution
- **Historical D-2 text preserved:** the originally ratified CORE ONLY text and the
  2026-08-19 amendment are **unchanged, not reinterpreted, not deleted**
- **No new numbered decision created; no decision renumbered.** The 20-decision tally is
  unchanged
- **Superseding clause:** the 2026-08-19 sentence *"permission resolution is **not** made
  branch-aware by this amendment"* is superseded **for the reopened requirements only**

**Defer LIFTED for:** `FR-SEC-002` [M] · `FR-SEC-003` [M] · `FR-SEC-004` [M] ·
`FR-SEC-005` [S] · **the branch/scope authorization portions of `FR-API-012`** [M].

**Remaining outside this amendment unless separately ratified:** the deferred
`FR-SEC-032` portions (approval PIN and push) · MFA (`FR-SEC-023`/`024`) · API keys
(`FR-API-011`/`014`) · the full missing Appendix C catalogue (and `FR-SEC-010`/`012`) ·
branch-aware RLS · `BRANCH_GROUP` scope in B1-2 · `WAREHOUSE`/`CENTRAL_KITCHEN`/`LOCATION`
scope types · unrelated Workforce completion · notification-system expansion · any other
unrelated security-platform requirement.

---

## 7. Ratified C-1 Model

**Scoped role assignment is the SOLE source of authorization grant.**

```
Membership → scoped MembershipRole assignment → Role → RolePermission → Permission
```

- **`EmployeeBranch` and `Employee.homeBranchId` MUST NOT grant, widen, infer or imply
  authorization.** They remain HR (`FR-HRM-001`/`005`) and authentication-integrity
  (`FR-SEC-021`/`022`) substrate.
- For **POS sessions** they MAY **narrow** authority as an additional **AND** condition.
- **They are NEVER an `OR` grant.**
- **Formal invariant: authorization cannot exist merely because an employee belongs to a
  branch.**

### POS session narrowing (ratified)

Authorization for a POS session targeting Branch `B` requires **all three**:

| | Condition |
|---|---|
| **A** | the scoped role-assignment model authorizes permission `P` at Branch `B` |
| **AND B** | `B` equals `branch_of(session terminal)` |
| **AND C** | the employee associated with the POS session is permitted for `B` under the already-ratified `EmployeeBranch` authentication-integrity model |

**A `TENANT`-scoped role MUST NOT let a POS session act on another terminal's branch.**

---

## 8. Ratified Generic Scope Lattice

A protected operation has a **required permission `P`** and a **target resource scope
`S`**, where `S` ∈ {`TENANT`, `BRAND(id)`, `BRANCH(id)`}. **Coverage is directional
downward only.**

| Assignment scope | **COVERS** | **DOES NOT COVER** |
|---|---|---|
| **`TENANT`** | `TENANT`; **all** `BRAND` targets in that tenant; **all** `BRANCH` targets in that tenant | anything outside the tenant |
| **`BRAND X`** | `BRAND X`; `BRANCH` targets whose **parent brand = X** | `TENANT`; another brand; branches of another brand |
| **`BRANCH X`** | `BRANCH X` **only** | `TENANT`; `BRAND`; any other branch |

**This lattice is a critical security invariant.** Coverage never flows upward or sideways;
a narrower assignment never satisfies a broader target.

### Permission AND target scope

Authorization SHALL be evaluated against **both**. **A permission code by itself is never
sufficient where the target scope is narrower than, or outside, the actor's authorized
scope** — this is what stops a branch-scoped assignment holding a powerful permission from
becoming tenant-wide authority.

**The permission catalogue SHALL NOT be classified into tenant-only / branch-only classes.
Scope MUST be derived from the protected RESOURCE / operation target.** This is the
architectural correction (**C-II**) that keeps branch authorization independent of the
missing Appendix C.

---

## 9. Scope Types

| Scope type | Status |
|---|---|
| **`TENANT`** | **RATIFIED for B1-2** |
| **`BRAND`** | **RATIFIED for B1-2** |
| **`BRANCH`** | **RATIFIED for B1-2** |
| `WAREHOUSE` | **NOT authorised now** |
| `CENTRAL_KITCHEN` | **NOT authorised now** |
| `LOCATION` | **NOT authorised now** |
| `BRANCH_GROUP` | **Deferred from B1-2 — mandatory follow-up** (§10) |

**A "set of branches" (`FR-SEC-002`) is represented as multiple `BRANCH`-scoped
role-assignment rows** — **not** an array inside one assignment, **not** a polymorphic
branch-set object, and **not** an invented branch-group surrogate.

---

## 10. `BRANCH_GROUP` — Deferred, Mandatory Follow-Up

**`BRANCH_GROUP` is NOT authorised for B1-2 solely because the canonical `BranchGroup`
domain entity does not yet exist. It is NOT rejected from the Full SRS.**

`FR-BRN-005` [M] requires branch groups *"(regions, clusters, franchise territories) as a
reporting and **permission-scoping** dimension"*. Therefore:

> **`BRANCH_GROUP` permission scoping is a MANDATORY FOLLOW-UP once the canonical
> `BranchGroup` domain model is implemented.**

**Binding constraint on B1-2:** the data model **MUST remain additively extensible to a
future `BRANCH_GROUP` scope type without reinterpretation of existing scope semantics** —
adding it must not change what `TENANT`, `BRAND` or `BRANCH` already mean.

The `BranchGroup` domain entity itself sits in board slice **`G3-1`** (P13-CK, lane G,
wave 3), which already depends on B1-2.

---

## 11. Ratified `T-4-LIVE` Token Strategy

**`T-4-LIVE` is ratified. The B1-1 report's `T-2` recommendation is NOT ratified.**

| Layer | Ratified role |
|---|---|
| **TOKEN** | Carries the SRS-required authorization snapshot — **subject, tenant, scope set, permitted branch set** — **plus an authorization/scope version or epoch** sufficient to detect a stale snapshot. **Exact claim names are NOT ratified here.** |
| **SERVER** | **Re-resolves the current scoped assignments on every request** and validates authorization freshness. **The server-side database resolution is authoritative.** |

**Security rule — ratified:** **TOKEN CLAIMS ARE NOT THE AUTHORITATIVE AUTHORIZATION
SOURCE. No authorization decision may rely solely on the claim.**

**Staleness:** if a role assignment **changes, expires, is revoked, or is re-scoped**, the
stale token **MUST NOT retain authority**. The next protected request **MUST fail closed or
require token renewal**, per the B1-2 implementation design.

### Token size / unbounded branch sets — ratified invariant

The SRS permits large multi-branch tenants (`FR-BRN-001` [M]), so the token contract **MUST
support the SRS-required permitted-branch set without creating an unbounded unsafe
header.** B1-2 MUST choose a **bounded, deterministic representation** — a versioned
compact or bounded encoding, or another mechanism preserving the literal SRS-visible token
contract while **failing closed on overflow**.

- **No concrete encoding is ratified here.**
- **SILENT TRUNCATION IS PROHIBITED.**
- If the required representation cannot be carried safely: **fail closed; do not silently
  omit authority; never interpret omission as unrestricted.**

---

## 12. `FR-API-012` Treatment

Under `T-4-LIVE` the **design intent is to satisfy both clauses**:

| Clause | Intent |
|---|---|
| **1** | The token carries subject, tenant, **scope set** and **permitted branch set**. |
| **2** | Every request is authorised against **both** the permission **and** the scope. |

**`FR-API-012` MUST NOT be marked COMPLETE merely because governance chose this model.**
Completion requires B1-2/B1-3 **implementation and verification**.

**Status recorded as of this entry: `RATIFIED DESIGN — NOT YET IMPLEMENTED`.**

*(Note on the B1-1 report: its §6 escalated an `FR-API-012` clause-1 vs `FR-SEC-028`
tension. `T-4-LIVE` resolves that tension rather than trading one requirement against the
other — the epoch/version makes a stale snapshot **detectable**, and the mandatory live
server-side re-resolution keeps revocation effective on the next request. The B1-1
`DECISION REQUIRED — 3` is thereby closed.)*

---

## 13. `FR-SEC-028` Correction

**`FR-SEC-028` is corrected from COMPLETE to `PARTIAL` globally. It MUST NOT be described
as COMPLETE and MUST NOT be closed.**

**Requirement text (verbatim, §15.5 p.95):** *"Terminals SHALL be individually registered,
and the System SHALL support revoking a terminal's registration, **immediately invalidating
its credentials and wiping its local data on next contact**."*

| Limb | Status | Evidence verified this session |
|---|---|---|
| Individual terminal registration | **Implemented** | `identity/terminals/terminals.service.ts`; `terminal.controller.ts` (6 routes: register, list, status, fingerprints, terminal session bind, terminal read); `DeviceFingerprint` stores hashes only |
| Revocation of registration | **Implemented** | `TerminalsService.setStatus` transitions to `disabled` / `revoked` under the tenant RLS context; cross-tenant terminal invisible ⇒ 404, no probing |
| **Immediate credential invalidation** | **Implemented (server-side)** | `identity/employees/pin.service.ts` refuses immediately when the terminal is not `status === 'active'`, returning a uniform `UnauthorizedException` |
| **Wiping local data on next contact** | **NOT IMPLEMENTED** | No wipe/purge directive, no next-contact wipe command and no client-data-clearing signal exists anywhere in `src` (verified by search across the whole source tree) |

**Recorded distinction, as ratified:**

- **Server-side credential revocation** — implemented and supported by existing evidence.
- **Global `FR-SEC-028`** — **`PARTIAL`** until the remaining device / local-data behaviour
  is implemented **and verified**.

**No product code was changed to address that residual under this task**, and the residual
is **not** assigned to B1-2 or B1-3 by this entry. The prior P0 traceability row recording
`FR-SEC-028` as `COMPLETE / VERIFIED / READY` is **superseded by this correction**; the
traceability CSV itself was **not** edited (it is a dated P0 artefact, and the register is
the authoritative record).

---

## 14. Data Model Governance

**Ratified direction — persistence MUST preserve referential integrity:**

- **A single untyped/polymorphic scope UUID that cannot carry a real foreign key is NOT
  authorised.**
- The model SHALL include: a **stable role-assignment identity capable of multiple
  assignments for the same membership/role at different scopes**; **local tenant identity**
  sufficient for tenant-safe references; **scope type**; **typed scope references** where
  necessary; **effective validity**; **constraints making inconsistent scope rows
  impossible**; and a **tenant-safe composite FK posture consistent with existing
  governance** (ADR 0008 D-09).

**Exact table names, column names, enum spellings and indexes remain B1-2 implementation
details and are NOT ratified here.**

### `membership_roles` identity

**`@@id([membershipId, roleId])` cannot remain the effective identity of scoped role
assignments**, because it prevents the same role at multiple branches, prevents multiple
scope assignments, and makes `FR-SEC-003`'s worked-example class unrepresentable — as ADR
0008 D-02 already recorded (*"a change to the RBAC table's identity, not an additive
column"*).

**B1-2 is authorised to perform the required table-identity migration.** It is a
coordinated identity-schema change and **MUST remain isolated from the concurrent `B2-5`
and `F2-1` migrations.**

### `FR-SEC-005` / `UPDATE` RLS policy

**B1-2 MUST correct the verified runtime inability to `UPDATE identity.membership_roles`
under `FORCE` RLS** — the table carries `SELECT`/`INSERT`/`DELETE` policies only
(`prisma/migrations/20260812145207_identity_rls/migration.sql`), so every `UPDATE` is
denied and effective-dating cannot function.

B1-2 SHALL add the necessary **tenant-safe `UPDATE` policy with fail-closed `USING` and
`WITH CHECK` semantics**. **This authorization is limited to making scoped and
effective-dated assignments work. Tenant RLS MUST NOT be weakened.**

---

## 15. `M-4+` Migration Posture

| | Ratified clause |
|---|---|
| **A** | Existing role assignments are backfilled as **`TENANT` scope**, because that is the actual legacy behaviour. |
| **B** | Every migrated assignment **MUST retain provenance** distinguishing **migration-originated inherited `TENANT` authority** from **a deliberately granted `TENANT` scope**. Mechanism is an implementation detail. |
| **C** | **A tenant MUST NOT activate a second active branch while it still holds unreviewed migration-originated `TENANT` assignments.** Fail closed, with an actionable re-scope requirement. |
| **D** | **Already-multi-branch tenants** *(the `M-4` → `M-4+` strengthening)*: **do NOT fail the entire migration**; **do NOT silently declare the tenant branch-RBAC-ready**; **preserve existing behaviour during migration**; **mark/derive the tenant as requiring scope review**; **the tenant MUST NOT be considered multi-branch authorization-ready**; and **the Internal-MVP single-active-branch safety posture MUST NOT be retired for that tenant** until inherited assignments have been explicitly reviewed / re-scoped. Exact persistence of the review-required state is an implementation detail. |
| **E** | **Re-scoping is audited**, using the existing audit architecture and permission semantics. |

**Inherited access MUST NOT be silently widened when a tenant moves into multi-branch
operation.**

---

## 16. RLS Boundary

**Ratified and unchanged:**

> **Tenant RLS answers: *"does this database row belong to the tenant?"***
> **Application authorization answers: *"may this actor perform permission `P` against
> target scope `S`?"***

- **Branch- and brand-scoped authorization stays in the APPLICATION layer for B1-2 and
  B1-3.**
- **Branch-aware RLS is NOT introduced by this decision.** A future branch-aware RLS
  defence-in-depth layer **requires its own explicit ADR and governance review**.
- **Tenant RLS MUST remain `ENABLE`d and `FORCE`d and MUST NOT be weakened.**

---

## 17. Fail-Closed Invariants

The B1-1 report's rules **`R-1 … R-13`** are **carried forward, corrected to the generic
target-scope model** (§8). **Additionally ratified:**

| Condition | Outcome |
|---|---|
| Unknown target scope | **DENY** |
| Unsupported scope type | **DENY** |
| Missing required target scope | **DENY** |
| Empty effective assignments | **ZERO AUTHORITY** — never unrestricted |
| Expired or not-yet-valid assignment | **DENY** |
| Tenant mismatch | **Preserve tenant-safe non-enumeration** — a foreign id remains a tenant-safe 404, never a 403 |
| Stale token scope snapshot | **DENY or refresh — never retain authority** |
| Permission present but outside the target scope | **DENY** |
| `BRAND` scope | **Expands only to branches belonging to that brand** |
| Home branch | **NO default to it** |
| Sole active branch | **NO default to it** |
| Resolver error | **NO fail-open** |

---

## 18. B1-2 Implementation Authority

**B1-2 is authorised to own:**

1. `MembershipRole` persistence / table-identity migration.
2. `TENANT` / `BRAND` / `BRANCH` scope persistence.
3. Tenant-safe scope FKs and integrity constraints.
4. `valid_from` / `valid_to` semantics.
5. The `membership_roles` `UPDATE` RLS policy.
6. Migration / backfill `M-4+`.
7. Scope-aware authorization resolution.
8. **A generic scope-authorization primitive keyed on `permission + target scope`.**
9. A branch-specific specialisation of that primitive where useful.
10. POS terminal branch derivation and **AND-only** `EmployeeBranch` narrowing.
11. The **`T-4-LIVE` token contract** — scope snapshot, permitted branch set, scope
    epoch/version — with **live server-side authorization remaining authoritative**.
12. Assignment create / change / remove APIs required to manage scoped assignments.
13. An **effective-scope read contract** for authenticated clients / frontend.
14. Audit events for role-assignment scope changes, using the existing audit architecture
    and permission semantics.
15. The **superseding ADR required by ADR 0008 D-02** for the relevant parts of **ADR 0002**
    and **ADR 0004**.
16. B1-2-specific tests.

**B1-2 MUST NOT start implementing branch enforcement across every unrelated business
controller and service. That is B1-3.**

---

## 19. B1-3 Implementation Authority

**B1-3 SHALL own:**

1. **Apply scope enforcement across every applicable business operation — not merely
   routes containing `:branchId`.** Coverage must include: explicit branch path
   parameters; branch ids in request bodies; **resources whose branch is implicit through
   the referenced entity**; **`BRAND`-target operations**; and **`TENANT`-target
   operations where narrower assignments must not leak upward**.
2. A **generated / enumerated authorization-coverage gate**, so future scoped surfaces
   cannot ship unprotected.
3. The **cross-branch E2E matrix**.
4. **Preservation of cross-tenant isolation.**
5. Confirmation of the **scope lattice** across `TENANT`, `BRAND` and `BRANCH`.
6. Confirmation of **POS branch narrowing**.
7. The **security review required by ADR 0008 D-02**.
8. **Explicit retirement of the Internal-MVP single-active-branch mask** (§20).

---

## 20. Single-Active-Branch Retirement Rule

> **The intended Full-SRS product is multi-branch. The single-active-branch posture is a
> TEMPORARY SAFETY MASK, NOT a permanent product constraint.**

**It must not be retained globally once real branch authorization is proven.** It is
retired only when **all three** hold:

1. **B1-2 is complete**;
2. **B1-3 enforcement is complete**;
3. **the `M-4+` migration scope-review conditions are satisfied for the tenant.**

**For tenants still blocked by `M-4+` review requirements — including the already-
multi-branch case of clause 13.D — fail closed until the review is complete.**

This disposition concerns the **posture** recorded as an implementation consequence under
the **MINIMUM REPORTING** and **DAY CLOSE** entries. **`RPT-R1 … RPT-R3` and
`DC-R1 … DC-R3` are otherwise unchanged, and no permission code is created, extended or
re-scoped by this clause.**

---

## 21. Frontend Impact

- The frontend must eventually be able to determine **effective scope-qualified authority**.
- **B1-2 owns that backend / shared contract.** **No final route or DTO is invented here.**
- The external frontend team **MUST NOT infer branch authority from**: `EmployeeBranch`
  alone; the home branch; a role name; or a client-side permission list alone.
- **Client-side permission checks remain presentation only** (`FR-SEC-045`, COMPLETE).
- Permissions becoming **scope-qualified** is a real contract change for consumers, and the
  effective-scope read contract is how it is communicated.

---

## 22. Appendix C Residual

**SRS Appendix C remains absent** (P0 signal **SIG-03**, UNRESOLVED). §15.3 states the
*"full catalogue is maintained in Appendix C"*, and the repository's 40 permission codes
were authored from SRS prose rather than derived — with `settings.branch.read` recorded as
*"invented (provisional)"*.

Therefore, ratified:

- **Do NOT invent new permission codes.**
- **Do NOT classify current permission codes as branch-only or tenant-only.**
- **Do NOT claim `FR-SEC-010` / `FR-SEC-012` or any other Appendix-C-dependent completion.**

**The generic target-scope model (§8) was chosen specifically so that branch authorization
does not depend on reconstructing the missing catalogue.**

---

## 23. Remaining External / Governance Blockers

| Blocker | State after this entry |
|---|---|
| **SRS Appendix C absent (SIG-03)** | **UNRESOLVED.** Keeps `FR-SEC-010`/`FR-SEC-012` unsatisfiable. Deliberately **not** on B1-2's critical path (§22). |
| **`FR-SEC-028` device local-data wipe** | **OPEN.** `FR-SEC-028` is `PARTIAL` globally. Not assigned to B1-2 or B1-3 by this entry; needs its own slice. |
| **`FR-PLT-013` — no CI pipeline** | **OPEN** (lane G). B1-3 supplies the enumerated coverage gate but **cannot execute it in CI or claim `FR-PLT-013`.** |
| **`BranchGroup` entity absent** | **OPEN** (board `G3-1`, wave 3). Blocks the mandatory `BRANCH_GROUP` follow-up (§10). |
| **Superseding ADR (ADR 0002 / ADR 0004)** | **OPEN** — required by ADR 0008 D-02's own terms; assigned to **B1-2** (§18.15). |
| **ADR 0008 D-02 security review** | **OPEN** — assigned to **B1-3** (§19.7). |
| **Migration surface contention** | **OPEN** — `B1-2`, `B2-5` and `F2-1` share the `identity` migration surface and **MUST NOT run concurrently.** B1-2 goes first. |
| **`FR-SEC-032`, MFA, API keys, notification expansion, wider Workforce** | **STILL DEFERRED** — outside this amendment. |

**No blocker prevents B1-2 from starting.**

---

## 24. Files Changed

| File | Change |
|---|---|
| `docs/governance/GOVERNANCE_DECISION_REGISTER.md` | **Forward amendment inserted beneath D-2**: `AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC`, RATIFIED 2026-09-02. Historical D-2 text and the 2026-08-19 amendment preserved byte-for-byte. **No decision renumbered; no unrelated entry modified.** |
| `docs/reports/claude/full-srs-4day/2026-09-02_B1-1_branch-rbac-ratification.md` | **NEW** — this report. |
| `docs/reports/claude/full-srs-4day/INDEX.md` | **One row appended.** |
| `docs/reports/claude/full-srs-4day/2026-09-02_B1-1_branch-rbac-governance-gate.md` | **Body untouched.** A single clearly-labelled `POST-REVIEW ACCEPTANCE NOTE` appended at the end, pointing to this report and the register, and listing the five corrections. |

**No product code. No Prisma schema. No migrations. No routes, controllers or services.
No permissions. No tokens. No package files. No generated files. No unrelated docs.**

---

## 25. Commit

- **Subject:** `docs(security): ratify branch-scoped RBAC`
- **Content:** documentation / governance only — the four files in §24, staged
  **explicitly** (no `git add .`, no `git add -A`).
- **Starting HEAD:** `1e53a2132fa8367e3470d489bb5132cec7df1a4c`
- **Verification run before committing:** `git diff --check` (clean), `git diff --stat`,
  `git status --short`, and a review of the register and report diffs.

---

## 26. Push / Deploy Status

| | |
|---|---|
| **Pushed** | **NO** |
| **Deployed** | **NO** |
| **Merged / rebased** | **NO** |
| **Destructive git operations** | **NONE** |
| **Tests executed this session** | **NONE.** This is a governance task; **no test result is reported in this document.** |
| **Implementation performed** | **NONE.** `FR-SEC-002`/`003`/`004`/`005` are **RATIFIED FOR IMPLEMENTATION — NOT IMPLEMENTED**; `FR-API-012` is **RATIFIED DESIGN — NOT YET COMPLETE**; `FR-SEC-028` is **PARTIAL**. |
| **Ready for B1-2** | **YES** |

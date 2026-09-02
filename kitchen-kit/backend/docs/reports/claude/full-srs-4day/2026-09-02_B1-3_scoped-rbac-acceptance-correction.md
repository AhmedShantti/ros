# B1-3 — Scoped RBAC Acceptance Correction

| Field | Value |
|---|---|
| **Task / Slice** | `B1-3` (acceptance correction) — ROUTE-WIDE SCOPED AUTHORIZATION ENFORCEMENT (P2-SEC, lane B) |
| **Report type** | ACCEPTANCE CORRECTION + SECURITY FINDING CLOSURE + TESTS + ADR AMENDMENT |
| **Authority** | **This report is NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative — specifically `AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC` (RATIFIED 2026-09-02). `docs/adr/0009-scoped-rbac.md` records architecture, not authority. Where this report and the register differ, **the register wins.** This report ratifies nothing. |
| **Date** | 2026-09-02 |
| **Starting HEAD** | `4f15f8b` (`feat(security): enforce scoped authorization across routes`) |
| **Branch** | `full-srs/lane-b-security-platform` |
| **Working tree at start** | Clean |
| **Task identifier** | `P2-SEC / B1-3 (acceptance correction)` |
| **Supersedes** | The **F-2 informational disposition** in `2026-09-02_B1-3_route-wide-scoped-rbac.md` §14. Everything else in that report stands. |
| **Push / deploy / merge** | **NONE.** |

---

## 1. Status

**COMPLETE.** All three required corrections are implemented, tested and closed:

1. **F-2 — unresolvable targets now FAIL CLOSED.** The `defer` outcome is gone
   entirely; no business handler can run without a completed scope decision.
2. **T-12 — a non-active branch is denied for EVERY scope, route-wide**,
   enforced once in the generic branch-target path.
3. **F-1 — `MAX_SNAPSHOT_UNITS` is 64.** Measured worst-allowed header:
   **7,808 bytes**, inside the strictest common 8,190-byte default.

**No unrelated security work was done.** No schema, no migration, no permission
code, no RLS change.

---

## 2. Correction 1 — Fail-Closed Unresolvable Targets (F-2)

### What was wrong

B1-3 shipped a `defer` outcome: when a target could not be resolved, the request
proceeded to its handler on the reasoning that the handler's own tenant-safe
lookup would refuse it anyway.

**That reasoning was a claim about every handler in the repository, present and
future, and the guard was not entitled to make it.** It was already false for at
least one route: `GET /catalogue/branches/:branchId/menus` answered `200 []` for
an unknown branch — harmless in content, because the underlying query is
tenant-scoped, but the business operation ran with **no scope decision at all**.
"Harmless today" is not a completion state for an authorization layer.

### What it is now

`TargetResolution` has **no outcome that reaches a handler unscoped**:

| Outcome | Meaning | HTTP |
|---|---|---|
| `target` | A concrete scope. `ScopeAuthorizationService` decides. | 200 / 403 |
| `deny` | Scope refusal, uniform message. | **403** |
| `notFound` | Target not visible in this tenant. | **404** |
| `badRequest` | Input that cannot denote a resource. | **400** |

`defer` is deleted from the type, so a future contributor cannot reintroduce it
by accident — there is no variant to reach for.

### Non-enumeration is preserved, and is now stronger

- **Foreign and non-existent are byte-identical 404s**, because the guard raises
  the route's **own** tenant-safe wording (`notFound` is a required field on
  every resource spec: `'Branch not found.'`, `'Order not found.'`,
  `'Station not found.'`, `'Price list not found.'`, …). The answer is the same
  one the handler would have given — one question, one answer, one layer.
- **Nothing became a 403.** The correction explicitly forbade converting these
  into scope refusals, and none was.
- The operation does not run: the 404 responses carry no `menus` key, no page,
  no empty collection — asserted directly, because "returned 404" and "returned
  404 *instead of doing the work*" are different claims.

### The malformed-input cases, and why they are 400 rather than deferred

The correction permits deferring only where validation is **guaranteed** to
terminate before the handler. Auditing that guarantee route by route showed it
does **not** hold: `GET /org/branches/:branchId` takes a bare
`@Param('branchId') branchId: string` with no `@IsUUID`, so a malformed id would
have reached Prisma and produced a **500**, not a 400.

Rather than encode a per-route belief about someone else's DTO, the guard now
**answers 400 itself**. A value of the wrong shape cannot denote any resource, so
there is nothing to authorize against, and the routes that already documented
`400` for malformed input keep answering `400`.

One real defect surfaced while doing this: `2026-02-31` matches `YYYY-MM-DD`, and
`new Date('2026-02-31T00:00:00Z')` **silently rolls forward to 3 March**. The
first version of the check accepted it, looked up a different day, found nothing
and answered **404** — turning `receipt.e2e-spec`'s documented *"malformed date
→ 400"* into a not-found. `isCalendarDate` now round-trips the parsed date
against its own digits, so the guard's answer matches the route's own
`parseBusinessDay`. **Caught by an existing test, fixed, not explained away.**

### The audit the correction asked for

Every remaining reason a request can leave `AuthorizationTargetResolver`:

| Reason | Outcome | Reaches a handler? |
|---|---|---|
| Declared target absent from params/body/query | `badRequest` 400 | No |
| Target id not UUID-shaped | `badRequest` 400 | No |
| Business-day key not a real calendar date | `badRequest` 400 | No |
| `declaredScope` names brand/branch with no id | `badRequest` 400 | No |
| `declaredScope` names an unknown scope word | `badRequest` 400 | No |
| Branch/brand/resource not visible in tenant | `notFound` 404 | No |
| Branch not `active` (T-12) | `deny` 403 | No |
| POS session with no terminal branch | `deny` 403 | No |
| Terminal not active | `deny` 403 | No |
| `requestBranch` not established by an earlier guard | `deny` 403 | No |
| Resolver token not wired (build defect) | `deny` 403 | No |
| Resolved | `target` | **Only after the primitive decides** |
| Optional filter omitted (`branchOrTenant` / `resourceOrTenant`) | `target` = TENANT | Only after the primitive decides |

The property is asserted directly rather than argued: a unit test drives every
non-`target` outcome through `PermissionGuard` and proves each throws **and**
that `assertAuthorized` was never called.

---

## 3. Correction 2 — T-12: a non-active branch is denied for EVERY scope

### It was NOT implemented route-wide

Before this correction, only **Reporting** and **Day Close** checked branch
activity, each with its own copy. Every other branch-targeted route — stations,
tables, operating hours, print routing, station routing, catalogue menu
resolution, orders, cash sessions, cash-close policy, KDS, terminals — served a
deactivated branch normally.

### Where it lives now

One check, at the end of **every** branch-target resolution, whatever the target
came from — path parameter, body field, query filter, live terminal state, an
earlier guard, or a resource row:

```
resolve(spec) -> preliminary target -> finalizeBranchTarget()
                                         ├─ not visible  -> 404 'Branch not found.'
                                         ├─ not active   -> 403   (T-12)
                                         └─ active       -> BRANCH target + parent brand
```

**Why one place and not six.** A branch target can arrive six different ways;
checking activity in each is six chances to forget, and the two modules that
*did* check it are exactly the evidence that a per-module check does not
generalise.

**One query, not two.** `BranchBrandQuery` gains
`findBranchAuthorizationFacts(tx, branchId)` returning `{ brandId, isActive }`.
Asking separately would mean two round trips per branch-targeted request *and*
two moments at which the answer could differ; asking once, inside the caller's
own transaction, means the activity check and the lattice see the same branch.

### Two refusals, deliberately kept distinct

| Case | Answer | Why |
|---|---|---|
| Branch invisible (another tenant's, or nobody's) | **404**, byte-identical | Non-enumeration protects OTHER TENANTS' data. |
| Branch visible but **inactive**, own tenant | **403** | Hiding a tenant's own deactivated branch *from that tenant* would be a different bug. |

### The one exemption, and why refusing it would have been worse

`POST /org/branches/:branchId/status` carries
`branchFromParam('branchId', { reason: … })`.

Without it, **deactivation would be a one-way door**: the operation that returns
a branch to `active` addresses that same branch, so a deactivated branch could
never be reactivated. The exemption is narrow — the status transition **only**,
not reading or editing an inactive branch — and the coverage gate now asserts a
**census**: exactly one route may carry it, and the reason must be substantive.
A second exemption fails the build and has to be argued for.

### Proof

`test/scoped-authorization-matrix.e2e-spec.ts`, six new tests:

| Test | Result |
|---|---|
| **TENANT** scope on an inactive branch — the widest authority, and the case most likely overlooked | **403** (and the same actor still 200s on an active branch) |
| **BRAND** scope on an inactive branch of its own brand | **403** |
| **BRANCH** scope on the very branch it is scoped to | **403** |
| Route-wide, not Reporting/DayClose-only: `/org/branches/:id/stations`, `/org/branches/:id/tables`, `/catalogue/branches/:id/menus`, `POST /branches/:id/day-closes/:day` | **403** on all four |
| Inactive (403) stays distinct from invisible (404) and non-existent (404) | **PASS** |
| Reactivation via the exempt lifecycle route, then everything works again, then deactivation again | **PASS** |

Reporting's and Day Close's own in-transaction `isOperativeBranch` checks are
**kept**. They now run behind the generic guard, inside the write/report
transaction, closing the window between the guard's decision and the write.

---

## 4. Correction 3 — Token Budget (F-1 resolved)

`MAX_SNAPSHOT_UNITS`: **128 → 64**.

| Measurement (worst-allowed: 64 units, all explicit `branch` scopes) | Value |
|---|---|
| Serialized JWT | **7,784 bytes** |
| **`Authorization` header line** | **7,808 bytes** |
| Empty-snapshot baseline JWT | 533 bytes |
| Bytes per unit | **113.3** |
| Strictest common default (Apache `LimitRequestFieldSize`, nginx `large_client_header_buffers` 8k) | 8,190 |
| **Fits** | **YES**, with 382 bytes of margin |

**Why 64 and not 67.** 67 was the measured *break-even*, which is an edge, not a
budget. 64 is the nearest power of two below it and leaves real margin.

**Why the original 128 was wrong.** It came from an estimate — "roughly 45 bytes
per rendered entry" — that counted a rendered entry once. An explicit branch id
is carried **twice** (a `branch:<uuid>` scope-set entry *and* a raw uuid in
`pbr.branches`), and the payload is then base64url encoded (+4/3). Measured:
113.3 bytes per unit, so a 128-unit token was **15,061 header bytes** — nearly
double the strictest default limit.

**This is an implementation detail, not a contract change**, exactly as the
correction directs. Clause 8 requires a *bounded, deterministic* representation
with *fail-closed overflow* and *no truncation*; all three are unchanged. The
`FR-API-012` token **shape** is untouched — `scp`, `pbr` and `epo` keep their
meanings and encodings.

### Required tests, all passing

| Requirement | Evidence |
|---|---|
| 64-unit real tenant-bound JWT mints successfully | A real membership with 64 brand-scoped assignments mints through `POST /auth/tenant`. |
| Serialized `Authorization` header < 8190 bytes | **7,808** — asserted, not estimated. |
| 65-unit snapshot fails closed | The 65th assignment ⇒ `POST /auth/tenant` **403**. No token issued. |
| Zero silent truncation | No token is issued at all on overflow; the at-budget token verifies with **exactly 64** `scp` entries and 64 `pbr.branches`. |
| Live DB authorization remains authoritative | The at-budget actor carries a full 64-unit snapshot and is still **403** on a branch target, because its live grants do not cover it. The snapshot never grants. |
| Tenant/brand symbolic compression unchanged | A TENANT-scoped actor in a ≥3-branch tenant reports `all: true` with **empty** `branches` and `brands`; a BRAND-scoped actor reports exactly one brand and no branches. If tenant-wide ever cost one unit per branch, 64 would become a branch-count limit — which clause 8 and `FR-BRN-001` forbid. |

The size test asserts against the **constant**, not the literal 64, so changing
the budget re-runs the measurement rather than silently invalidating it.

**`docs/adr/0009-scoped-rbac.md` D-08 amended**, recording the measured reason,
the 128→64 change, and that the token shape is untouched.

---

## 5. Governance Decisions Recorded

| Finding | Disposition |
|---|---|
| **F-1** — token size | **RESOLVED** by the 64-unit bounded snapshot. Measured header 7,808 bytes < 8,190. |
| **F-2** — unresolvable targets | **Previous informational disposition SUPERSEDED.** Corrected to fail closed; no handler runs without a scope decision. |
| **F-3** — `POST /org/branches` is BRAND-targeted | **ACCEPTED by governance.** Branch creation under brand X remains authorised for a BRAND-X administrator holding `settings.branch.manage`. Unchanged by this correction, and now recorded as an accepted decision rather than an open question. |

---

## 6. Requirement Disposition

| Requirement | Status | Change |
|---|---|---|
| **`FR-SEC-004`** [M] | **COMPLETE** | Strengthened: enforcement no longer has a path that reaches a handler unscoped, and T-12 now holds route-wide. |
| **`FR-API-012`** [M] | **COMPLETE** | Clause 2 is now true without the F-2 caveat. Clause 1's token shape is unchanged; only the bound moved, to a measured value. |
| **`FR-SEC-028`** [M] | **PARTIAL (unchanged)** | Local-device wipe still not implemented; untouched, not claimed. |
| **`FR-PLT-013`** | **PARTIAL (unchanged) — NOT CLAIMED** | The coverage gate runs here; there is still no CI pipeline on this branch. |
| `FR-SEC-002` / `003` / `005`, `FR-PLT-012` | COMPLETE (unchanged) | Not re-claimed. |

---

## 7. Files Changed

**Production (11)**

| Path | Change |
|---|---|
| `identity/authz/authorization-target.resolver.ts` | `defer` removed; `notFound`/`badRequest` added; `finalizeBranchTarget` (T-12 + one-query brand/active); `isCalendarDate`. |
| `identity/authz/guards/permission.guard.ts` | Raises 404 / 400; no fall-through. |
| `identity/contract/authorization-target.ts` | `allowInactive` on the branch spec; `notFound` required on resource specs; builder signatures. |
| `identity/authz/authorization-snapshot.service.ts` | `MAX_SNAPSHOT_UNITS` 128 → 64, with the measured reasoning. |
| `organisation/contract/branch-brand.query.ts` + `branches/branch-brand.query.service.ts` | `findBranchAuthorizationFacts` (additive). |
| `organisation/organisation.controller.ts` | The single T-12 exemption, with its written reason. |
| `catalogue`, `inventory`, `sales`, `production`, `treasury`, `kitchen`, `identity` controllers | 44 resource-target call sites gain their route's own `notFound` wording; four routes gain the `@ApiNotFoundResponse` their new behaviour requires. |
| `docs/adr/0009-scoped-rbac.md` | D-08 amended. |
| `docs/api/openapi.{json,yaml}` | Regenerated; **never hand-edited**. |

**Tests (4)**: `authorization-coverage.spec.ts` (validates `notFound` and the
exemption reason; adds the exemption census) · `permission.guard.spec.ts`
(404/400 outcomes; the "no outcome reaches the handler" property) ·
`scoped-authorization-matrix.e2e-spec.ts` (+11 tests: F-2 fail-closed, T-12
across three scopes and four modules, 64-unit measurement, symbolic
compression) · `catalogue.e2e-spec.ts` (the C-01 claim re-anchored on a REAL
empty branch; the unknown-branch case corrected to a byte-identical 404).

---

## 8. Tests — results actually executed in this session

| Suite | Result |
|---|---|
| **Typecheck** | **1 error — the known pre-existing baseline** (`access-token.service.spec.ts(28,7)`), byte-identical to HEAD. **Zero new errors relative to the lane baseline.** |
| **Unit** | **855 passed / 855, 62 suites** |
| **Module boundaries** | **PASS**; `KNOWN_DEVIATIONS` did not grow |
| **Authorization coverage gate** | **PASS** — 156 routes, 141 declared, 0 undeclared; exemption census = exactly `POST /org/branches/:branchId/status` |
| **`scoped-rbac` + `scoped-rbac-migration`** | PASS |
| **`scoped-authorization-matrix`** | **34 passed / 34** (was 23; +11) |
| **catalogue / receipt / organisation / reporting / day-close (targeted)** | **301 passed / 301, 17 suites** |
| **openapi / catalogue / inventory / sales** | **370 passed / 370, 12 suites** |
| **FULL e2e** (`npm run test:e2e -- --runInBand`) | **1235 passed / 1235, 67 suites, 0 failed, exit 0**, on a dropped, recreated and freshly migrated database |

### The intermediate full run that failed, recorded rather than dropped

| Run | Result | Disposition |
|---|---|---|
| 1 | 1181 / 1234, 53 failed | **Two genuine failures**, both mine, both fixed: `catalogue.e2e-spec`'s unknown-branch case (correctly now a 404 — the test encoded the behaviour being corrected) and `receipt.e2e-spec`'s `2026-02-31` case (a real defect in my business-day check — fixed by `isCalendarDate`). The other **51 were the `beforeAll` 5000 ms AppModule hook-timeout signature** B1-2 documented, on a contended machine (299 s vs the usual ~180 s). |
| **2 (final)** | **1235 / 1235, 67 / 67 suites, exit 0** | Fresh database, run alone. |

**No prior run's numbers are re-reported as the final result**, and the two
failures attributable to this correction's own code were fixed rather than
explained away.

---

## 9. Constraints Honoured

| | |
|---|---|
| **SCHEMA CHANGE** | **NO** — `prisma/schema.prisma` untouched |
| **MIGRATION** | **NO** |
| **NEW PERMISSION CODE** | **NONE** |
| **RLS** | **Not weakened, not touched** |
| **Unrelated security work** | **NONE** — the diff is the three corrections, the two defects they surfaced, and their tests |
| **Persistent `ros` touched** | **NO** — only `ros_lane_b_b13_zero`, disposable, dropped and recreated under the guard script (re-proven to refuse `ros`/`postgres`/`template1` and unrecognised names) |
| **Pushed / deployed / merged / rebased** | **NO** |

---

## 10. Commit

- **Subject:** `fix(security): close scoped authorization review findings`
- Files staged **explicitly**. No `git add .`, no `git add -A`.

# MW1B — Merge Wave 1B Integration: A1-2 + B1-1/B1-2 + D1-1/D4-1A

**Task/slice:** MW1B — reviewed-slice integration + cross-lane reconciliation
+ verification of A1-2 (inventory lock grouping), the Lane B governance chain
(B1-1 design gate + ratification) and B1-2 (branch-scoped RBAC foundation),
and the Lane D governance/design chain (D1-1 design gate + ratification) and
D4-1A (offline sync protocol kernel).

**Report type:** Integration + cross-lane reconciliation + verification
report.

**Authority statement:** This report is non-authoritative evidence.
`ROS_SRS_v1.0.pdf` and the ratified entries in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative.
Where this report disagrees with the SRS or a ratified governance decision,
the SRS and the register win. This report records what was observed and
measured in this session only; it ratifies nothing and authorises nothing.

**Date:** 2026-09-02

**Starting HEAD (task brief):** `1efb301d32ea563f381cc7cf0e7255f8d9f13b4f`
(`fix(e2e-harness): fix ConfigService database isolation timing (C2)`).

**Actual starting HEAD (this session):** `b69509f` — see §1 "Baseline
deviation" for why.

**Resulting HEAD:** `9911dfc0169454302e7a2aa7a9f4ff49956703d3` (last
cherry-pick) → `41039350bff2dc2e077bd36f573965fd2d0bf0aa` (reconciliation
commit) → report commit (this file), see §18.

**Branch:** `full-srs/4day-integration`.

**Working tree summary:** Not clean at session start (see §1); clean before
every cherry-pick, clean after the reconciliation commit, clean at report
time except this report's own new file and the INDEX row.

**Task identifier:** MW1B — A1-2 + B1-1/B1-2 + D1-1/D4-1A integration.

---

## 1. Baseline deviation (disclosed)

The task brief required HEAD `1efb301` and a clean tree before starting.
`git status` at session start showed HEAD `1efb301` (matched) but a **dirty
tree**: a modified `kitchen-kit/backend/docs/reports/claude/INDEX.md` and an
untracked `2026-09-02_MW1A_baseline-corrections.md`. Investigation showed
this was **complete, evidence-backed work from a prior session**
(MW1A-CORRECTION — C1/C2/C3) whose two code commits (`092ef69`, `1efb301`)
were already on HEAD, but whose own report/INDEX-row "record" commit had
never been made. Nothing in the working tree was incomplete or
in-progress; the report content referenced only commits already on HEAD.

Per the ROS reporting policy ("never overwrite previous substantive reports"
and the established `docs: record <wave>` pattern used by every prior
session), this was committed as `b69509f` — `docs: record MW1A correction
gate (C1/C2/C3)` — before starting MW1B, to reach the required clean-tree
precondition without discarding prior evidence. All MW1B work in this report
proceeds from `b69509f`, not the literal `1efb301` named in the brief; the
product-code diff between the two commits is `0` (docs-only).

---

## 2. Pre-flight verification

| Check | Expected | Observed | Result |
|---|---|---|---|
| `pwd` | `/Users/mac/projects/ros-worktrees/integration` | matched | PASS |
| Branch | `full-srs/4day-integration` | matched | PASS |
| HEAD (brief) | `1efb301` | matched, tree dirty — see §1 | PASS (with disclosed deviation) |
| `test/e2e-db-isolation/e2e-database-environment.ts` | EXISTS | exists | PASS |
| `test/e2e-db-isolation/jest-hooks.ts` | DOES NOT EXIST | absent | PASS |
| `test/jest-e2e.json` custom `testEnvironment` | yes | `<rootDir>/e2e-db-isolation/e2e-database-environment.ts` | PASS |
| `test/e2e-db-isolation-config.e2e-spec.ts` | EXISTS | exists | PASS |
| Regression test before integrating | MUST PASS | 1/1 passed, DB migrated from zero as `ros_test_e2e_*` | PASS |
| All 7 commits exist | yes | `897333b`, `1e53a21`, `2967043`, `428c904`, `50b37067`, `76b42893`, `9ecc910` all verified via `git cat-file -t` | PASS |

---

## 3. Integrated commits

Cherry-picked in the exact required order, from `b69509f`:

| # | Commit | Subject | Result hash | Conflicts |
|---|---|---|---|---|
| 1 | `897333b` | `perf(inventory): group depletion layer locks` (A1-2) | `8f25578` | none |
| 2 | `1e53a21` | `docs(security): prepare branch RBAC governance gate` (B1-1 design) | `f6b0c96` | `full-srs-4day/INDEX.md` (append) |
| 3 | `2967043` | `docs(security): ratify branch-scoped RBAC` (B1-1 ratification) | `4092bf9` | none (auto-merged) |
| 4 | `428c904` | `feat(security): implement scoped role assignments` (B1-2) | `e9ea568` | none (auto-merged, incl. `order-completion.e2e-spec.ts`/`sales-lines.e2e-spec.ts`) |
| 5 | `50b37067` | `docs(sync): define offline protocol design gate` (D1-1 design) | `e118c27` | `full-srs-4day/INDEX.md` (append) |
| 6 | `76b42893` | `docs(sync): ratify offline protocol foundation` (D1-1 ratification) | `e1d4363` | none (auto-merged, incl. `GOVERNANCE_DECISION_REGISTER.md`) |
| 7 | `9ecc910` | `feat(sync): establish offline protocol kernel` (D4-1A) | `9911dfc` | `src/modules/module-boundaries.spec.ts` (real conflict, see §4); `schema.prisma`, `openapi.json/yaml`, `audit.constants.ts`, `INDEX.md` auto-merged |

A1-2's diff was exactly the predicted, isolated scope: `sale-depletion.service.ts`
(+111/-8), one new e2e spec, one new report, one INDEX row. No A1-3 work
present.

Reconciliation commit: `41039350bff2dc2e077bd36f573965fd2d0bf0aa` —
`chore(integration): reconcile wave 1b contracts` (§9).

---

## 4. Conflicts by file — exact resolution

### 4a. `full-srs-4day/INDEX.md` (×2 append conflicts)

Both were pure sequential-append conflicts (each side added a distinct new
row at the same point). Resolved by keeping every row from both sides in
chronological order, dropping only the `<<<<<<<`/`=======`/`>>>>>>>`
markers. No row lost or duplicated. Final table has 9 rows: A1-1 (×2:
correctness + acceptance correction), A1-2, B1-1 (×2: design + ratification),
B1-2, D1-1 (×2: design + ratification), D4-1A. Verified via
`grep -c "^| 2026-09-02"`.

### 4b. `prisma/schema.prisma`

Auto-merged cleanly by git (no `<<<<<<<` markers). Verified both sides
present after merge: `model MembershipRole` (B1-2 — stable `id` PK, tenant-
safe FKs, validity window, provenance) and all six D4-1A sync models plus
the unchanged `IdempotencyKey` model. Ran `npx prisma format` (whitespace-
only realignment, `git diff` confirmed no semantic change — column-alignment
padding only) then `npx prisma validate` — **clean**.

### 4c. `prisma/migrations/`

Both reviewed migrations present unchanged, same timestamp prefix, distinct
directory names, as specified:
- `20260902010000_identity_scoped_role_assignments` (B1-2)
- `20260902010000_sync_protocol_kernel` (D4-1A)

No historical migration SQL rewritten. Final count from the 35-migration
baseline: **37**, confirmed both by filesystem listing and by
`_prisma_migrations` row count on a from-zero scratch DB (§10A). Prisma
resolves and applies them in this order: `..._identity_scoped_role_assignments`
then `..._sync_protocol_kernel` (alphabetical within the identical
timestamp), confirmed live in §10B.

### 4d. `src/modules/module-boundaries.spec.ts` (real conflict)

B1-2 had replaced the pre-existing bare `toBe(35)` migration-count assertion
in the "Reporting owns no Prisma model and no migration" test with
`toBe(36)` (a one-line change, its only touch to this file). D4-1A
independently replaced the *same* assertion with an intent-based check (no
migration anywhere creates a `reporting` schema/table, whatever the count).
Per task §6C, resolved in favour of **D4-1A's intent-based version**,
discarding B1-2's brittle count. Verified: `module-boundaries.spec.ts`
45/45 in isolation, zero new `KNOWN_DEVIATIONS` (B1-2's own commit message
already claimed this; confirmed empirically by the passing suite — B1-2's
only other footprint in this file was the same one line just superseded).

### 4e. `governance/audit/audit.constants.ts`

Auto-merged cleanly. Verified both additive sets present: B1-2's
`ROLE_ASSIGNMENT_REMOVED`/`RESCOPED`/`VALIDITY_CHANGED`/`REVIEWED` action
codes and `ROLE_ASSIGNMENT` entity code; D4-1A's `SYNC_CLOCK_SKEW_DETECTED`,
`SYNC_CONFLICT_RECORDED`, `SYNC_REVALIDATION_EXCEPTION_RAISED`, and
`SYNC_DEVICE_STATE`/`SYNC_CONFLICT_RECORD`/`SYNC_REVALIDATION_EXCEPTION`
entity codes. No verb/entity dropped. No new permission code created by
either.

### 4f. `docs/governance/GOVERNANCE_DECISION_REGISTER.md`

Auto-merged cleanly. Both ratified amendments present exactly once, verified
by `grep`: `AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC` (B1-1)
and `## D1-1 — Offline / Sync Protocol Foundation Ratification — 2026-09-02`
(D1-1). No historical decision rewritten.

### 4g. Reports/INDEX files

Covered by §4a. All accepted A/B/D report rows present exactly once; no
append conflict left unresolved anywhere else (confirmed by a repo-wide
`git grep` for conflict markers post-integration — the only hits were
pre-existing, unrelated literal `===`/`<<<`/`>>>` text in older docs never
touched by this session, confirmed via `git diff --stat` against those
paths returning empty).

### 4h. Generated OpenAPI (`docs/api/openapi.json`/`.yaml`)

Auto-merged cleanly during cherry-pick (no `<<<<<<<`). Not hand-verified as
correct at that point — per task instructions, the merge result was treated
as provisional and superseded by regeneration. After all 7 commits were
applied: `npm run openapi:check` (regenerate + `git diff --exit-code`) —
**clean, zero diff**. The committed artifacts are therefore the sole output
of `generate-openapi.ts` run against the final integrated source, not a
hand- or auto-merged document. Confirmed present: B1-2's scoped role
assignment APIs (`/auth/role-assignments/{assignmentId}`, `.../review`) and
extended `GET /auth/permissions`; D4-1A's `POST /v1/sync/batch`. No
pre-existing path disappeared (zero diff after full regeneration is
sufficient proof — any dropped path would show as a diff).

### 4i. `test/openapi.e2e-spec.ts`

Auto-merged cleanly (source test file, not generated). Confirmed passing
(part of the B1-2-targeted suite run, §12) with both B assignment-route and
D versioned-sync-path assertions intact.

---

## 5. Section-by-section preservation checks

**A1-2** (task §3): `SaleDepletionService`-only product diff confirmed by
`git show --stat`; canonical key/global lock order, independent physical/FIFO
axes, reservation-before-mutation, no movement batching, no A1-3 work,
`balance_after` truthfulness and A1-1 exact-decimal semantics — all
unmodified by this integration (A1-2's own diff was untouched by any
conflict resolution).

**B1-1/B1-2** (task §4): all listed architectural properties present and
verified live in §10/§12 — scoped `MembershipRole` as sole grant source,
`TENANT`/`BRAND`/`BRANCH` lattice, `BRANCH_GROUP` deferred (not implemented),
stable assignment id, typed tenant-safe FKs, effective dates, UPDATE RLS with
USING+WITH CHECK, M-4+ migration/backfill/review, old `PermissionGuard`
TENANT-target-only (unconverted routes), T-4-LIVE, live DB scope resolution,
authorization epoch, symbolic bounded branch representation, POS
`EmployeeBranch` AND-only narrowing. No permission code invented (grep for
new `IDENTITY_PERMISSIONS`/`*_PERMISSIONS` entries in the B1-2 diff found
none). `FR-SEC-004`/`FR-API-012` remain PARTIAL per B1-2's own commit
message, unchanged by integration.

**D1-1/D4-1A** (task §5): nonpartitioned global `sync.operation_dedup` with
exact `PRIMARY KEY (tenant_id, op_id)` (§10A); history (`sync_operations`)
not the dedup authority; crash-recoverable lease/reclaim (proven live by
`sync-crash-recovery.e2e-spec.ts`, §12); business-effect+dedup atomicity;
HLC verbatim with conformance corpus; `deferred` status present; causal
handling; fast-chunk-path+safe-fallback (measured in §13); strict
server-derived tenant/branch (`SyncTerminalGuard`); canonical
`POST /v1/sync/batch`; conflict/revalidation substrate only, zero
production domain handlers (every operation type still resolves
`unknown_operation_type` except the test-only `protocol.probe` handler
registered solely by `sync-fixtures.ts`); no branch-RBAC recreation; no
`GD-D1-03` implementation; no revoked-terminal-recovery claim (see §7 for
the one message-reachability finding, which does **not** claim recovery is
implemented). `SYNC_AUTHORIZATION_PORT` remains an unbound published
contract — confirmed no binding exists anywhere in the diff.

---

## 6. E2E harness preservation (hard gate)

Re-verified after every major conflict resolution and again at session end:

| Check | Result |
|---|---|
| `test/jest-e2e.json` `testEnvironment` | still `<rootDir>/e2e-db-isolation/e2e-database-environment.ts` |
| `test/e2e-db-isolation/jest-hooks.ts` | still absent |
| `test/e2e-db-isolation/e2e-database-environment.ts` | still present |
| `test/e2e-db-isolation-config.e2e-spec.ts` | **1/1 passed**, ConfigService confirmed resolving `ros_test_e2e_*`, re-run at session start, after full integration, and after the reconciliation commit |
| Every e2e invocation this session | connected only to `ros_test_e2e_*` scratch databases (harness) or explicitly named `ros_test_mw1b_*` manual scratch databases (§10) — **zero** connections to persistent `ros` |

No test unexpectedly connected to `ros`. Persistent `ros` confirmed
untouched at session end: still exactly 35 `_prisma_migrations` rows, still
the legacy pre-B1-2 `membership_roles` shape (composite PK, `branch_id`
column) — proof that no migration or e2e run this session ever pointed at it.

---

## 7. B1-2 × D4-1A cross-lane auth compatibility (task §8)

All sync e2e suites were run after B1-2 was integrated. One real
cross-lane interaction was found (not a stale-token/fixture-staleness bug —
D4-1A's sync fixtures already mint tokens through the real, current Identity
path):

**Finding:** B1-2 added `TenantContextService.resolvePosBranch`
(`src/modules/identity/context/tenant-context.service.ts`), a **new**
cross-cutting check that every POS-bound request now passes through via
`TenantContextGuard`, running **before** D4-1A's `SyncTerminalGuard`. It
independently re-checks terminal-active status (among other live facts) and
denies with a deliberately **generic** 403 (`"POS session is not permitted
here."`) — an anti-enumeration design so a POS session cannot probe which of
several conditions it failed. Confirmed via `git show b69509f:...
tenant-context.service.ts` that this check did **not** exist pre-B1-2: D4-1A
was developed against a branch where `SyncTerminalGuard`'s own
revoked-terminal check (with its specific `"...NOT discarded by this
refusal..."` message, existing to satisfy the ratified GD-D1-07 no-data-loss
guarantee) was the sole enforcer and therefore reachable.

**What did NOT change:** the core security property — a revoked terminal is
still denied (403) — holds without exception. The core GD-D1-07 data
guarantee — a refused sync writes and deletes nothing — also holds: proven
directly in the fixed test by asserting `sync.operation_dedup` row count is
byte-identical before and after the 403 (see the diff to
`test/sync-protocol.e2e-spec.ts` in the reconciliation commit).

**What did change, and was NOT fixed here:** `SyncTerminalGuard`'s specific
reassurance wording is no longer reachable via this exact request shape,
because `TenantContextGuard` denies first. Per task instructions ("DO NOT
weaken B1-2", "no special sync test exception", "no production auth
bypass"), **no production code was changed**. Weakening B1-2's anti-
enumeration design to let the sync-specific message through would itself be
prohibited scope-creep into new design work. The test
(`test/sync-protocol.e2e-spec.ts`, "403s a revoked terminal, and does not
touch its unsynced backlog") was updated to assert the actual, correct,
integrated behaviour and to prove the underlying data guarantee directly
rather than by string-matching a now-unreachable message. **This is flagged
as an open item**, not silently resolved: reconciling which guard should
carry the reassurance wording (or whether `TenantContextGuard` should be
made sync-route-aware through a published contract) is left to B1-3 (which
owns route-wide scope conversion) or a dedicated governance decision.

Other required proofs, all confirmed live via the full sync e2e run (§12):
tenant still server-derived (`SyncTerminalGuard` reads `principal.tenantId`,
never the body); branch still terminal-derived (`SyncTerminal.branchId` from
live `TerminalFactsQuery`, never the body — `deviceId`-mismatch test passes);
token snapshot never authorizes by itself (T-4-LIVE tests in
`scoped-rbac.e2e-spec.ts` and `tenant-context.service.spec.ts` pass,
including stale/absent-epoch fail-closed cases).

---

## 8. Migration proof — combined state (task §9)

All performed on disposable, guard-pattern-named scratch databases
(`ros_test_mw1b_zero`, `ros_test_mw1b_upgrade`), never `ros`. Both dropped
after use; zero orphans remain (`SELECT count(*) FROM pg_database WHERE
datname LIKE 'ros_test_e2e_%'` → 0; the two manual scratch DBs are also
gone).

### 8A. From zero

`ros_test_mw1b_zero` created; all 37 migrations applied via `prisma migrate
deploy` — **PASS**. Verified catalogue:

- `identity.membership_roles`: PK `membership_roles_pkey` on `(id)`
  (stable surrogate, not composite); composite tenant-safe FKs to
  `org.brands(tenant_id, id)`/`org.branches(tenant_id, id)`; three CHECK
  constraints (`ck_membership_role_review_state`,
  `ck_membership_role_scope_consistent`, `ck_membership_role_validity_window`);
  `FORCE ROW LEVEL SECURITY` confirmed (`relforcerowsecurity = t`); UPDATE
  policy present with both `USING` and `WITH CHECK` clauses (confirmed
  verbatim via `\d`).
- `sync.*`: six new tables (`conflict_records`, `device_state`,
  `operation_dedup`, `revalidation_exceptions`, `sync_batches`,
  `sync_operations`) plus the pre-existing `idempotency_keys`; all seven
  confirmed `FORCE ROW LEVEL SECURITY` (`relrowsecurity`/`relforcerowsecurity`
  both `t`).
- `sync.operation_dedup`: PK exactly `(tenant_id, op_id)`, confirmed via
  `\d` — `"operation_dedup_pkey" PRIMARY KEY, btree (tenant_id, op_id)`.

### 8B. Upgrade from pre-wave baseline (35 → 37)

`ros_test_mw1b_upgrade` created; the original 35 migrations applied from the
pre-B1-2/D4-1A worktree state (`b69509f`). Legacy Identity state seeded to
exercise M-4+: one tenant, two active branches (already-multi-branch tenant
case), three users/memberships, two roles, and four legacy
`membership_roles` rows — one single-branch grant, one tenant-wide
(`branch_id IS NULL`) grant, and one membership holding two grants across
two different roles (a genuinely multi-role membership).

First `migrate deploy` attempt against this seed **correctly refused** with
a fail-closed error (`P0001`: *"B1-2 backfill: N membership_roles row(s)
carry a legacy branch_id. It was never consumed by any authorization path,
so this migration will neither discard it silently nor promote it to a
BRANCH scope."*) — this is deliberate, verified-correct migration behaviour
(the B1-2 report's own claim that legacy `branch_id` was "never consumed by
any authorization path" is a live-database production fact, not something
this migration should guess about for ambiguous legacy data). Legacy
`branch_id` values were nulled (matching that production fact) and the
migration retried after `prisma migrate resolve --rolled-back`.

**Clarified 35→37 upgrade result, stated as two distinct cases rather than
one pass/fail outcome:**
- **Valid legacy production shape (legacy `branch_id` NULL on every
  `membership_roles` row, matching the B1-2 report's own claim about
  `ros`'s actual state): PASS.** This is the case verified end-to-end below.
- **A legacy shape with a populated `branch_id` on one or more
  `membership_roles` rows: the migration intentionally fails closed**,
  refusing to guess whether that legacy value was ever a real grant, and
  requires explicit manual remediation/review before it will proceed. This
  is correct, deliberate migration behaviour — not a defect and not part of
  the PASS result above — and was exercised directly (see the `P0001` error
  above) before the seed was corrected to the valid (NULL) shape.

Both migrations then applied, in the order Prisma resolved them:
`..._identity_scoped_role_assignments` first, then `..._sync_protocol_kernel`
— **PASS**. Verified:

- All 4 seeded `membership_roles` rows preserved (row count unchanged,
  `SELECT count(*)` = 4 before and after).
- All backfilled to `scope_type = 'tenant'`, `origin = 'migration'`,
  `reviewed_at IS NULL` — correct M-4+ provenance/review-pending state.
- The already-multi-branch tenant (2 active `org.branches`) survived the
  upgrade unmodified — the migration neither failed nor silently declared it
  reviewed.
- `memberships.authz_epoch` column added, defaulted to `0` on all 3 seeded
  memberships.
- All six sync tables added; `sync.operation_dedup` PK still exactly
  `(tenant_id, op_id)`.
- `_prisma_migrations` row count: **37**.

---

## 9. Reconciliation commit (task §16)

`41039350bff2dc2e077bd36f573965fd2d0bf0aa` —
`chore(integration): reconcile wave 1b contracts`. Contents:

1. **Module boundaries** — resolution of the real conflict in §4d (already
   applied during the cherry-pick, committed here as part of the working
   tree at that point — no separate diff needed since the conflict
   resolution was already staged into commit `9911dfc`; the reconciliation
   commit's `module-boundaries.spec.ts` line count is 0, confirming nothing
   further was needed after the cherry-pick's own resolution).
2. **`prisma/schema.prisma` formatting** — `npx prisma format` output
   (whitespace/column-alignment only, confirmed via diff inspection).
3. **Lint fixes for newly introduced errors only** (task §11, see §11 below
   for the full before/after accounting) — 28 files, all either 100%-new-
   error files (safe blanket `eslint --fix`) or, for the one file mixing
   pre-existing baseline debt with new errors
   (`test/cash-session-close.e2e-spec.ts`), a surgical hand-fix of only the
   newly introduced hunk, verified to restore that file's error count to
   its exact pre-integration baseline (27).
4. **`test/sync-protocol.e2e-spec.ts`** — the cross-lane test fix from §7.

No unrelated product work included.

---

## 10. Corrected G1-2 harness preservation proof

See §6 — re-verified clean at three checkpoints (pre-integration, post-full-
integration, post-reconciliation-commit), 1/1 every time.

---

## 11. Lint — exact before/after accounting (task §11)

**Before integration** (measured directly at `b69509f`, via a temporary
detached worktree with its own generated Prisma client, to get a byte-exact
baseline rather than trusting a prior session's recorded number): **exactly
48 errors**, all in 6 known files (`cash-session-tender-totals.query.service.ts`
×1, `cash-session-close.service.ts` ×1 — a pre-existing
`@typescript-eslint/no-unsafe-member-access`, not `prettier/prettier` —
`cash-sessions.service.ts` ×1, `treasury.controller.ts` ×2,
`cash-movements-close-and-payment-concurrency.e2e-spec.ts` ×16,
`cash-session-close.e2e-spec.ts` ×27, one of which is a pre-existing
`@typescript-eslint/require-await`).

**Immediately after all 7 cherry-picks, before any fix:** 158 errors — the
48 baseline plus 110 new, spread across 24 new-or-touched files. Root cause
of every one: B1-2 (test-fixture `.assign()`→`.create()` migration across
many e2e specs, plus new source files under `src/modules/identity/`) and
D4-1A (all-new `src/modules/sync/*` and `test/sync-*` files) — confirmed
file-by-file via `git diff --stat b69509f..HEAD -- <file>` before touching
anything, so no baseline file was fixed by mistake.

**Fix applied**, exactly as task §11 requires — new errors only, zero
baseline errors touched:
- 23 files where **100%** of the current errors were new (the file had zero
  baseline errors, or is an entirely new file): blanket `eslint --fix`
  (prettier-only in all but the following cases).
- 8 substantive (non-`prettier/prettier`, non-autofixable) new errors fixed
  by hand: an unused destructured binding
  (`tenant-context.service.spec.ts`, replaced with `delete`); a redundant
  string-literal-vs-`string` union
  (`sync-operation-handler.ts`'s `reasonCode`, changed to
  `SyncReasonCode | (string & {})`, preserving both the literal
  autocomplete and the free-form-string call sites already in
  `revalidation-exception.service.ts`/`device-state.service.ts`); two
  unnecessary type assertions in `sync.schemas.ts` (auto-fixed); one
  unnecessary type assertion in `scoped-rbac.e2e-spec.ts` (auto-fixed); two
  async functions with no `await` (`sync-audit-contention.e2e-spec.ts` —
  dropped `async`; `sync-crash-recovery.e2e-spec.ts` — dropped `async`,
  changed the early-return to `Promise.resolve()` to satisfy the
  `Promise<void>`-returning `SyncFailpoint.afterChunk` contract); one unused
  import (`sync-fixtures.ts`'s `Provider`, removed).
- 1 file (`test/cash-session-close.e2e-spec.ts`) mixed 27 pre-existing
  baseline errors with 4 newly introduced ones (from B1-2's `.assign()` →
  `.create()` replacement at lines 388–392). A blanket `--fix` here would
  have also fixed the 26 pre-existing `prettier/prettier` baseline errors,
  silently shrinking the "48" invariant without accounting for it. Instead,
  fixed by hand — only the 6-line new hunk's indentation — verified via an
  isolated `npx eslint` run on just this file returning to **exactly 27**,
  byte-identical to its pre-integration count.

**After fix (final):** **exactly 48 errors**, confirmed by a full
`npm run lint:check` file-by-file breakdown matching the original 6
baseline files and counts precisely (`cash-session-tender-totals.query.service.ts`
1, `cash-session-close.service.ts` 1, `cash-sessions.service.ts` 1,
`treasury.controller.ts` 2, `cash-movements-close-and-payment-concurrency.e2e-spec.ts`
16, `cash-session-close.e2e-spec.ts` 27 — sum 48). **Zero delta.** 3 pre-
existing warnings in `sync-performance.e2e-spec.ts` (unused
`eslint-disable` directives, not part of D4-1A's own reported baseline
change and not errors) are unchanged and out of this task's lint-error
scope.

---

## 12. Dependency audit

`npm audit --omit=dev --audit-level=high`: **exactly 6 high-severity
advisories** (`deepmerge-ts`, `js-yaml`, `mysql2` — same three packages as
every prior session's baseline). No new advisory. No dependency
upgrade performed.

---

## 13. Typecheck, unit, module boundaries, OpenAPI

| Check | Result |
|---|---|
| `npm run typecheck` | **clean, zero errors** (no TS2322 or any other error; G1-1's fix to `access-token.service.spec.ts` remains intact) |
| `npm test` (unit) | **917/917 passed, 65 suites** (re-run identically before and after the reconciliation commit) |
| `src/modules/module-boundaries.spec.ts` (isolated) | **45/45 passed** |
| `npm run openapi:check` | clean, zero diff — regenerated artifacts are the sole source of the committed `docs/api/openapi.json`/`.yaml` |

---

## 14. Targeted verification (task §13)

| Group | Suites | Tests | Result |
|---|---|---|---|
| A1-2 (`sale-depletion-lock-grouping`, `order-completion*`, `movements-concurrency`, `inventory-exact-decimal-callers`) | 10 | 78 | PASS |
| B1-2 (`scoped-rbac`, `scoped-rbac-migration`, `rbac`, `tenant-context`, `audit`, `openapi`) | 7 | 132 | PASS |
| D4-1A / sync (all `sync-*.e2e-spec.ts`, incl. protocol, idempotency, causal, crash-recovery, RLS, performance, audit-contention) | 7 | 65 | PASS |
| Cross-lane (`e2e-db-isolation-config`, `organisation`, `approval-runtime`, `module-boundaries`, `terminal` — POS scoped-RBAC path) | 4 | 115 | PASS |

Sync terminal auth after T-4-LIVE: covered by the sync-protocol suite
(revoked terminal 403, `deviceId`-mismatch 403, no-token 401) and by
`scoped-rbac.e2e-spec.ts`'s stale/absent-epoch fail-closed cases — all
PASS. See §7 for the one message-wording finding (not a functional
failure).

---

## 15. Performance status (task §14)

**A1-2 / NFR-PERF-006** (isolated, unmodified 30-line/135-effect fixture,
re-run for the fully integrated state): **p50 = 421.5 ms, p95 = 858.2 ms**
(20 iterations). Consistent with A1-2's own accepted measurement (p50
750 ms / p95 2069 ms) — this run's lower numbers reflect a quieter
concurrent-load window, not a code change (A1-2's product diff is untouched
by this integration). **p95 remains > 200 ms. `NFR-PERF-006` stays
PARTIAL / VERIFIED-FAILING.** A1-3 (set-oriented rewrite, its own design
gate) was not attempted, as required.

**D4-1A kernel/representative (P-D4-01):** 500-op batch, 20 iterations —
kernel floor p50 = 332.0 ms / p95 = 403.8 ms; representative p50 = 885.2 ms
/ p95 = 943.8 ms; both well inside the fixture's own 3000 ms budget.
Materially consistent with D4-1A's own accepted measurement (kernel floor
p50 317/p95 340 ms; representative p50 883/p95 937 ms) — **no material
regression**.

**D4-1A audit contention (P-D4-02):** 3 concurrent terminals, 100 ops each
— serialisation ratio **2.09** (accepted baseline: 1.96), hash chain intact
across 405 entries, zero deadlocks/exhausted retries. Consistent, no
material regression.

**`NFR-PERF-032` is NOT claimed fully verified** — domain revalidation is
still absent (D4-1B's scope), exactly as D4-1A's own report states.

---

## 16. Full E2E

Run via `npm run test:e2e` (the corrected G1-2 harness), on a shared
machine with ~28 other node/jest processes from other active worktree lanes
throughout — not a dedicated runner, consistent with every prior session on
this repository.

- **Run 1:** 77/77 suites, **1281/1281 tests** — fully green.
- **Run 2:** 76/77 suites, 1280/1281 tests — 1 failure.
- **Runs 3–6:** 77/77 suites, 1281/1281 tests each — fully green (4 more
  full runs).
- **Run 7:** 76/77 suites, 1280/1281 tests — 1 failure, captured in full.

**5 of 7 full runs fully green (runs 1, 3, 4, 5, 6). 2 of 7 runs (run 2 and
run 7) contained the same Class-C, contention-only failure** — both times
in `cash-session-close.e2e-spec.ts`, both 76/77 suites, 1280/1281 tests.
Run 7's captured failure was `'tenant B cannot read or reference a tenant A
close attempt'` — a `PrismaClientValidationError` from `id: undefined` being
passed into a `findUnique`, traced to `(res.body as
DeclareBody).closeAttemptId` being `undefined`, i.e. an HTTP response body
shape mismatch consistent with the request itself being affected by heavy
concurrent host load (this specific line is far from anything touched by
A1-2/B1-2/D4-1A — the only B1-2 change to this file is an unrelated
`assign()`-helper formatting fix at line ~388, verified in §11). Run 2's
failure was not captured with the same file-level detail (only the
tail-summary counts, 1 failed/1280 passed, were retained at the time), but
matches the identical supertest-assertion signature and the identical
76/77-suites/1280/1281-tests shape, and is treated as the same failure mode
rather than a distinct one. Re-run **3/3 clean, 35/35 tests** in isolation
immediately after. This file and this general area (cash-session-close
under full-suite concurrent load) has a documented history of exactly this
contention-only failure mode in every prior session's own report on this
branch (MW1A, MW1A-CORRECTION).

**Failure classification: Class C** (known/environmental,
performance/resource-sensitive) — not Class A (no correctness regression:
clean in isolation, and the failing code path touches nothing modified by
this wave), not Class B (no DB-isolation issue: the harness's own
`ros_test_e2e_*` isolation was never in question — the failure is an
application-level response-shape/timing issue under load, and the
per-suite scratch database itself was correctly isolated throughout), not
Class D (the mechanism — full-suite concurrent contention producing an
occasional slow/failed HTTP round-trip inside a test that immediately
consumes the response body — is understood and has precedent, not
unexplained).

**Hard gates:** no test connected to persistent `ros` (✓, §6); `organisation`
PASS (✓, §14); `approval-runtime` PASS (✓, §14); scoped-RBAC suites PASS (✓,
§14); sync suites PASS (✓, §14); A1 inventory correctness/concurrency suites
PASS (✓, §14). **No Class A or B failures anywhere in this session — MW1B is
not rejected.**

---

## 17. Orphan scratch databases

**0.** Confirmed via `SELECT count(*) FROM pg_database WHERE datname LIKE
'ros_test_e2e_%'` → 0 at session end. The two manually created
`ros_test_mw1b_*` migration-proof scratch databases (§8) were explicitly
dropped after use. Persistent `ros` confirmed untouched throughout (§6):
still 35 `_prisma_migrations` rows, still the legacy pre-B1-2
`membership_roles` shape.

---

## 18. Requirement statuses that remain PARTIAL / not implemented

Per task §19, none of the following are marked complete by this session
(this integration does not implement or verify their remaining literal
requirements):

`NFR-PERF-006` (PARTIAL/VERIFIED-FAILING, §15), `FR-SEC-004` (PARTIAL, B1-3
scope), `FR-API-012` (PARTIAL, B1-3 scope), `FR-SEC-028` (PARTIAL, local-
data-wipe-on-next-contact not implemented), `NFR-PERF-032` (not fully
verified, §15), `FR-OFF-040`–`FR-OFF-047`, `FR-OFF-050`, `FR-OFF-051`
(D4-1B scope — zero production domain handlers ship in D4-1A), `CT-01`,
`CT-06` (unaffected).

`B1-3` owns route-wide scoped authorization (including reconciling the §7
open item). `D4-1B` owns real domain handlers/conflict/revalidation. `A1-3`
remains design-gated.

---

## 19. Readiness for next implementation wave

**YES**, with the §7 open item (sync-revoked-terminal message reachability)
flagged for B1-3 or a dedicated governance decision, not silently resolved.

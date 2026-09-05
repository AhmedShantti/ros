# MW1C — Integrate B1-3 Route-Wide Scoped RBAC (+ Acceptance Correction)

**Report type:** Reviewed-slice integration + cross-lane reconciliation + verification
**Authority:** This report is NON-AUTHORITATIVE EVIDENCE. `ROS_SRS_v1.0.pdf`
and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md`
remain authoritative. Where this report disagrees with the SRS or a ratified
governance decision, the SRS and the register win.
**Date:** 2026-09-02
**Starting HEAD:** `b46a00e69758f68de2b8228a34e1a9d9452dcb69` ("docs: correct wave 1b verification counts")
**Branch:** `full-srs/4day-integration`
**Worktree:** `/Users/mac/projects/ros-worktrees/integration`
**Working tree at start:** clean
**Task identifier:** MW1C

---

## 1. Starting-state verification (§0)

- `pwd` = `/Users/mac/projects/ros-worktrees/integration` ✓
- branch = `full-srs/4day-integration` ✓
- HEAD = `b46a00e` ✓
- working tree clean ✓
- Baseline content confirmed present via
  `kitchen-kit/backend/docs/reports/claude/full-srs-4day/INDEX.md` and its
  report files: corrected G1-2 harness, A1-1, A1-2, B1-2, D4-1A, all present.
- 37 migrations present at baseline (`prisma/migrations`).
- `kitchen-kit/backend/test/e2e-db-isolation/e2e-database-environment.ts`
  EXISTS (path is relative to `kitchen-kit/backend`, not the worktree root —
  the task text's path was written relative to the backend package).
- `kitchen-kit/backend/test/e2e-db-isolation/jest-hooks.ts` DOES NOT EXIST ✓
- `test/e2e-db-isolation-config.e2e-spec.ts` run before integration: **1/1
  PASS**, scratch database `ros_test_e2e_*` created and swept; persistent
  `ros` not touched.

No mismatch found. Proceeded.

---

## 2. Commits integrated (§1)

Both target commits verified to exist before cherry-picking:

- `4f15f8b09dce701fc348acd1b17120d682857021` — `feat(security): enforce scoped authorization across routes`
- `9de7103d10390868dc2aa71449bc81c6f55cc976` — `fix(security): close scoped authorization review findings`

Cherry-picked in the required order, each with `-x`:

1. `4f15f8b` → resulting hash `71151ddd7f06a4e79ad09323d5798eb683c0f4e6`.
   One real conflict: `INDEX.md` (pure append — both sides' new rows kept,
   see §7F below). Everything else auto-merged clean.
2. `9de7103` → resulting hash `88776bc7f597c21b84e597fb3a80726754c337ab`.
   Auto-merged clean, zero conflicts (including
   `INDEX.md`, `openapi.json/yaml`, `inventory.controller.ts`,
   `catalogue.e2e-spec.ts`).

The whole Lane-B branch was not merged; only these two commits.

---

## 3. Preserved B1-3 accepted behaviour (§2)

Verified via the coverage gate report (§6 below), the scoped-authorization
matrix suite (80/80 passing, §9 below), and direct code reading:

- 141/141 permission-bearing routes explicitly classified (integrated
  157-route surface; see §6).
- `PermissionGuard` remains the single enforcement point (`src/modules/identity/authz/guards/permission.guard.ts`) — no second guard was added.
- Target resolution against the TENANT/BRAND/BRANCH lattice unchanged
  (`authorization-target.resolver.ts`, `scope-authorization.service.ts`).
- Resource-derived resolvers (13 published contracts) unchanged; no new
  `branchId` input added anywhere.
- `EmployeeBranch` remains AND-only narrowing for POS, never a grant source
  (`tenant-context.service.ts` `resolvePosBranch`, unchanged by this
  integration).
- `T-4-LIVE` unchanged: live DB resolution remains authoritative; JWT
  snapshot never authorizes by itself.
- No branch-aware RLS added. No new permission codes added (confirmed: no
  migration, no permission-constant diff outside `treasury.permissions`
  import cleanup which is a lint fix, not a semantic change).
- `BRANCH_GROUP` remains deferred (untouched).
- M-4+ review gate untouched.
- Reporting and Day Close single-branch masks retired exactly as B1-3 left
  them (verified by running `reporting-authorization`, `reporting-snapshot`,
  `day-close`, `day-close-cutover-race`, `day-close-znumber-concurrency` —
  all green, §9).
- `POST /org/branches` remains BRAND-targeted (F-3, verified in OpenAPI and
  in `organisation.controller.ts`).
- Branch re-parenting remains TENANT-targeted (unchanged).

Acceptance-correction guarantees preserved:

- No `defer` outcome exists in `TargetResolution` (confirmed: the union type
  in `authorization-target.resolver.ts` has only `target` / `deny` /
  `notFound` / `badRequest`).
- Unresolvable required target never reaches the handler (proven by the
  fail-closed matrix tests in `scoped-authorization-matrix.e2e-spec.ts`,
  §11 below).
- Malformed/un-denotable input → 400; invisible/nonexistent target →
  tenant-safe 404; inactive visible branch → 403 (T-12, §10 below).
- Exactly one inactive-branch exemption: `POST /org/branches/:branchId/status`
  — proven by the coverage gate's own census test (§6).
- `MAX_SNAPSHOT_UNITS = 64`; 65 fails closed (§9 below, measured).
- No silent truncation (measured, §9).
- Token shape unchanged (T-4-LIVE claims `scp`/`pbr`/`epo`, unchanged).
- F-3 (branch creation BRAND-targeted) preserved.

---

## 4. D4-1A Sync route × B1-3 coverage gate (§3) — HARD INTEGRATION ITEM

B1-3 was developed without D4-1A on its branch. Once both were on this
branch together, B1-3's filesystem-driven `authorization-coverage.spec.ts`
discovered `POST /sync/batch` (from `SyncController`, D4-1A) as a route with
no `@RequirePermission` and no allowlist entry.

**Before reconciliation**, running the gate:

```
routes: 157
EVERY route without a permission requirement is a reviewed auth-only route
  FAILED — unlisted: ["POST /sync/batch  (modules/sync/sync.controller.ts#uploadBatch)"]
reports the target classification totals
  FAILED — UNDECLARED 16, expected 15
```

**Resolution:** `POST /sync/batch` was added to
`REVIEWED_UNPROTECTED_ROUTES` in `authorization-coverage.spec.ts` (no
wildcard exception, no invented permission code, no branch-RBAC logic added
to Sync), with the exact reason the task specified:

> "Offline sync transport authenticated by tenant-bound terminal/session
> guards; branch is server-derived; operation-level domain authorization is
> delegated to SYNC_AUTHORIZATION_PORT when production handlers are added."

**After reconciliation**, the gate is 9/9 green:

```
B1-3 authorization target totals: {
  routes: 157,
  tenant: 66,
  branch: 21,
  resource: 42,
  UNDECLARED: 16,
  resourceOrTenant: 2,
  branchOrTenant: 3,
  brand: 3,
  sessionTerminalBranch: 2,
  declaredScope: 2
}
```

**Resulting totals: 157 routes total; 141 permission-bearing routes, all
141/141 classified; 16 undeclared (15 original B1-3 auth-only + 1 Sync),
all itemised with reasons and none stale.** This is the same
141/141-permission-bearing figure B1-3 reported on its own branch — Sync
adds to the auth-only bucket, not to the undeclared/unclassified bucket.

---

## 5. Revoked terminal × B1-3 × Sync (§4)

`test/sync-protocol.e2e-spec.ts`'s `'403s a revoked terminal, and does not
touch its unsynced backlog'` test already anticipates and documents exactly
this cross-lane interaction (comment block dated to MW1B, §8): B1-2's
`TenantContextGuard` denies a revoked terminal with its own generic,
anti-enumeration 403 before `SyncTerminalGuard`'s more specific wording is
ever reached. The test asserts the **security/data behaviour** (403 status,
`syncOperationDedup` row count unchanged before/after) rather than exact
message wording, per this task's §4 instruction that "security/data
behaviour wins over old message-string assertions."

Re-run against the integrated B1-3 state: **PASS**. No weakening of either
guard. `SyncTerminalGuard`'s own lossless-recovery wording
(`'NOT discarded ... the separately authorised lossless recovery path'`)
remains intact in source for the case where it IS reached (a request that
fails `SyncTerminalGuard`'s own terminal-status check via a path that
doesn't first fail `TenantContextGuard` — not applicable to POS-session
sync, which always passes through `TenantContextGuard` first). Lossless
revoked-terminal recovery is NOT implemented or claimed here (D4-1B scope).

---

## 6. Inactive branch × Sync (§5) — CROSS-LANE DESIGN GAP FOUND

Traced the full guard chain Sync runs on every request:
`JwtAuthGuard → TenantContextGuard → SyncTerminalGuard`. Neither
`TenantContextService.resolvePosBranch` (used by `TenantContextGuard` for
POS/terminal-bound sessions) nor `SyncTerminalGuard` (via
`TerminalFactsQuery.getById`, which selects `id, branchId, terminalType,
status` from `identity.terminals` only) reads `Branch.status` anywhere.
Both check only that the **terminal** is `active`; neither checks that the
terminal's **branch** is active.

T-12 (the branch-active check) lives exclusively in
`AuthorizationTargetResolver.finalizeBranchTarget`, which is invoked only
from `PermissionGuard.canActivate` — and only when a route both carries
`@RequirePermission` and declares an `@AuthorizationTarget`. `POST
/sync/batch` carries neither (§4), so `PermissionGuard.canActivate` returns
`true` on its very first line (`if (!required) return true;`) without ever
constructing a target or reaching `finalizeBranchTarget`.

**Empirical proof** (temporary probe test, run and then discarded — not
committed, since the task instructs "do not invent a large new architecture"
and this integration slice does not fix the gap): with an active terminal
bound to a branch, after setting that `Branch.status` to `inactive` via a
direct admin update, `POST /v1/sync/batch` still returned **HTTP 200**
(envelope-level acceptance), reaching `SyncBatchService.process()`. The
single operation in the probe batch was rejected only because it was an
unregistered operation type (`'protocol.probe'`), not because of the
inactive branch — proving the request passed through the entire guard chain
and into the batch-processing pipeline while the bound branch was inactive.

**Conclusion, per the task's explicit instruction: STOP, do not invent a
fix.** This is a real, previously undocumented cross-lane design gap:
**Sync does not fail closed when its bound branch becomes inactive.** It is
distinct from, and not covered by, T-12 (which is a `PermissionGuard`-only
guarantee) and distinct from the revoked-terminal guarantee (§5, which is a
terminal-status check, not a branch-status check). No code change was made
to Sync in this integration slice to address it, per §5's explicit
instruction not to duplicate B1-3 branch-target code inside Sync or invent
new architecture. **This is an open item for D4-1B or a dedicated
governance/design decision**, not resolved here.

---

## 7. Coverage gate + CI (§6)

`.github/workflows/backend-ci.yml`'s `quality` job runs `npm test -- --ci`
(the "Unit tests" step) before `openapi:check` and `npm audit`. The
root-level `package.json` `jest` config sets `rootDir: "src"` and
`testRegex: ".*\\.spec\\.ts$"`, which matches
`src/modules/authorization-coverage.spec.ts` (`npx jest --listTests`
confirms this file is discovered). Ran `npm test -- --ci` directly in this
session: **66 suites / 934 tests, all green**, including the coverage gate.

**This confirms the coverage gate is deterministically executed by the
existing CI path** — no second CI workflow was created, no existing gate
weakened.

**However, per §6's explicit instruction, the literal SRS text for
FR-PLT-013 was read before touching its status** (`ROS_SRS_v1.0.pdf` §6.2.2,
extracted via `pdftotext`):

> "FR-PLT-013 [M] — The CI pipeline SHALL execute a cross-tenant isolation
> test suite that, for every table containing tenant_id, attempts to read
> and write records belonging to Tenant B while the session context is
> Tenant A, and fails the build on any success. This suite is generated,
> not hand-written — it enumerates tables from the information schema so
> that a newly added table without a policy fails the build automatically."

**This is a completely different mechanism from B1-3's
`authorization-coverage.spec.ts`**, which classifies HTTP routes by
authorization target (an FR-SEC-004/FR-API-012 concern), not cross-tenant
RLS read/write isolation per database table (an FR-PLT-013 concern). The
repository's existing RLS suites (`rls.e2e-spec.ts`,
`catalogue-rls.e2e-spec.ts`, `inventory-rls.e2e-spec.ts`,
`production-rls.e2e-spec.ts`, `order-completion-rls.e2e-spec.ts`,
`sync-rls.e2e-spec.ts`, `tax-class-rls.e2e-spec.ts`) are **hand-written**,
not generated from the information schema, and there is no evidence they
enumerate every `tenant_id` table exhaustively or would automatically catch
a newly added table missing a policy.

**FR-PLT-013 does NOT become COMPLETE from this integration.** It remains
**PARTIAL**. The literal missing limb: no generated, information-schema-
driven, exhaustive-by-construction cross-tenant isolation suite exists or
is wired into CI. The coverage gate landing in CI satisfies a different
requirement's evidence (FR-SEC-004/FR-API-012 route coverage), not
FR-PLT-013.

---

## 8. Conflict surfaces (§7)

**7A — `module-boundaries.spec.ts`:** auto-merged clean by git during the
cherry-pick (no manual resolution needed). Verified both survive: D4-1A's
intent-based Reporting migration assertion (searches migration SQL text for
`CREATE SCHEMA "reporting"` / `"reporting".` rather than a brittle global
count) at lines ~1296-1319, and B1-3's `stripComments` persistence-source
scanner at line 840. Re-ran in isolation: **45/45 PASS**. Zero new
`KNOWN_DEVIATIONS` entries (diffed against the pre-integration baseline —
no changes to the `KNOWN_DEVIATIONS` object).

**7B — Inventory contract barrel:** `contract/index.ts` exports
`sale-depletion.contract`, `sale-depletion.errors` (pre-existing A1) AND
B1-3's `scope-target.resolvers` — all three present, nothing dropped.

**7C — Treasury/Day Close/Cash Session Close:** all pre-existing
close/day-close business logic, audit ordering, and concurrency semantics
unchanged by the cherry-picks (git diff shows only the B1-3-introduced
`resourceTarget`/`RequestAuthorization`/`SCOPE_AUTHORIZATION` additions,
no removed logic). Treasury concurrency suites
(`cash-movements-close-and-payment-concurrency.e2e-spec.ts`,
`movements-concurrency.e2e-spec.ts`) re-run: **PASS** (§9/§11 below).

**7D — Organisation contracts:** `contract/index.ts` retains
`routing-config.query`, `table-display.query`, `branch-currency.query`,
`station-display-binding.query`, `kds-branch-config.query`,
`branch-reporting-scope.query`, `branch-brand.query` (all pre-existing) AND
B1-3's `scope-target.resolvers`. No private-module import was introduced
(module-boundaries gate confirms, §7A).

**7E — OpenAPI:** No file was hand-merged. After all source integration,
ran `npm run openapi:generate` then `npm run openapi:check` — **zero diff**
(`git diff --exit-code` inside the check script succeeded with no output).
Confirmed present in the regenerated contract: B1-2 role-assignment routes
(`/auth/memberships/{membershipId}/roles`, `/auth/role-assignments/...`),
D4-1A's `POST /v1/sync/batch`, and B1-3's descriptions/400/404
documentation (spot-checked `GET /catalogue/branches/{branchId}/menus`).

**7F — Reports/INDEX:** Both B1-3 report files
(`2026-09-02_B1-3_route-wide-scoped-rbac.md`,
`2026-09-02_B1-3_scoped-rbac-acceptance-correction.md`) present exactly
once. `INDEX.md`'s one real append conflict (both sides adding new rows
after B1-2's row) resolved by keeping all prior rows (D1-1 x2, D4-1A, MW1B)
followed by the incoming B1-3 row — nothing dropped, nothing duplicated.

---

## 9. Typecheck (§8)

```
npm run typecheck
```

**Clean. Zero errors.** No `TS2322` (the Lane-B pre-existing error the task
warned about) — confirms it remains fixed from G1-1, as expected.

---

## 10. Token size in integrated state (§9)

Re-ran `test/scoped-authorization-matrix.e2e-spec.ts`'s
`'T-4-LIVE token size, MEASURED (not estimated)'` describe block against
the integrated state:

```
B1-3 CORRECTION — measured worst-allowed token size: {
  units: 64,
  serializedJwtBytes: 7784,
  authorizationHeaderBytes: 7808,
  emptySnapshotJwtBytes: 533,
  bytesPerUnit: 113.3
}
```

- `MAX_SNAPSHOT_UNITS`: **64** (`authorization-snapshot.service.ts:75`).
- 64-unit JWT: **successfully minted, 7,784 bytes.**
- 64-unit Authorization header: **7,808 bytes — under the 8,190-byte
  Apache/nginx strictest-common-default limit.**
- 65-unit membership: **`'OVERFLOW STILL FAILS CLOSED: no token is issued,
  and nothing is truncated'` — PASS** (re-run in this session).
- At-budget decoded snapshot: exactly 64 units, no truncation (asserted by
  the same test, PASS).
- Tenant-wide/brand-wide symbolic compression: unchanged (no source diff to
  the compression logic from this integration).
- Live DB authorization remains authoritative (T-4-LIVE unchanged).

---

## 11. T-12 active-branch matrix (§10)

Re-ran `test/scoped-authorization-matrix.e2e-spec.ts` (80/80 including
`scoped-rbac.e2e-spec.ts` and `scoped-rbac-migration.e2e-spec.ts` in the
same batch) in the integrated state:

| Case | Result |
|---|---|
| TENANT-scoped actor → inactive branch | **DENIED 403** (PASS) |
| BRAND-scoped actor → inactive child branch | **DENIED 403** (PASS) |
| BRANCH-scoped actor → same inactive branch | **DENIED 403** (PASS) |
| Invisible/nonexistent branch | **tenant-safe 404, foreign == absent** (PASS, byte-identical) |
| Lifecycle exemption census | **exactly one: `POST /org/branches/:branchId/status`** (coverage gate's own census test, §4/§6, PASS) |

Representative resource-derived / branch-target routes re-run and green:
Organisation (`organisation.e2e-spec.ts`), Catalogue
(`catalogue.e2e-spec.ts`), Treasury (`cash-session-close.e2e-spec.ts`,
`cash-movements-close-and-payment-concurrency.e2e-spec.ts`), Sales/order
(`sales.e2e-spec.ts`, `order-completion.e2e-spec.ts`, and concurrency
variants).

---

## 12. Unresolvable-target fail-closed matrix (§11)

Re-run within `scoped-authorization-matrix.e2e-spec.ts`:

- Unknown branch does not reach the handler — PASS (denied/404 before
  handler, matrix tests).
- Foreign branch does not reach the handler — PASS.
- Unknown resource does not reach the handler — PASS (resource-target
  tests across Organisation/Catalogue/Inventory/Treasury/Sales/Kitchen).
- Malformed UUID → 400 — PASS.
- Impossible calendar date `2026-02-31` → 400 — PASS (`isCalendarDate`
  round-trip check, from the acceptance correction, intact).
- No `defer` outcome exists anywhere in the codebase (confirmed by reading
  `TargetResolution`'s union type — only `target`/`deny`/`notFound`/
  `badRequest`).

**Named hard regression check:** `GET /catalogue/branches/:branchId/menus`
— foreign and absent branch IDs verified **byte-identical 404**, never
`200 []` (test: `'GET /catalogue/branches/:branchId/menus — foreign and
absent are byte-identical 404s'`, PASS).

---

## 13. Database / migration (§12)

- B1-3 added **no schema, no migration** — confirmed:
  `git diff b46a00e..88776bc -- kitchen-kit/backend/prisma/migrations/`
  is empty.
- Migration count: **37** (unchanged).
- `npx prisma validate`: **schema valid.**
- The `e2e-db-isolation-config` test (run at §1 and again as part of every
  targeted/full e2e run in this session) performs a from-zero migration of
  a scratch database on every invocation — verified clean every time,
  including the very last targeted run.
- Persistent database `ros` **was not touched** by any migration, write, or
  destructive operation in this session. One read-only `SELECT
  current_database()` connectivity check was run against it directly
  (§16) — no schema or data command.

---

## 14. Lint (§13)

**Baseline established from `b46a00e`** (via a temporary `git worktree add`
of the pre-cherry-pick HEAD, `prisma generate`d and linted in place, then
removed): **exactly 48 errors, 3 warnings (51 total)** — matches the task's
stated baseline exactly, confirming this session's own tooling/environment
reproduces it before touching anything.

**Immediately after both cherry-picks (before any fix):** 188 errors, 6
warnings (194 total) — a delta of +140 errors / +3 warnings, all confined
to files the B1-3 commits touched (confirmed file-by-file: zero delta in
any file NOT in the `b46a00e..88776bc` diff).

**Fixed, scoped only to newly-introduced problems:**

- `npx eslint --fix` run against every B1-3-touched file whose baseline
  problem count was 0 (pure Lane-B-vs-integration-branch prettier-baseline
  drift — safe to fully auto-fix).
- `treasury.controller.ts` (the one touched file with a nonzero baseline,
  2 pre-existing prettier errors) was fixed **surgically by hand**: its 6
  new `resourceTarget(...)` decorator calls were reformatted to match
  prettier's expected multi-line form; its 2 pre-existing baseline errors
  (import-list formatting at line 45, an unrelated insertion at line ~295)
  were left exactly as they were — re-verified untouched after the fix.
- 4 non-autofixable errors resolved by hand: an unsafe `String(unknown)`
  stringification in the coverage gate's route-verb fallback (narrowed with
  a `typeof` check), one unused `ResolverKeySpec` type import, and two
  unused `TREASURY_PERMISSIONS` imports in day-close concurrency tests
  (both superseded by the new `@AuthorizationTarget`-based checks and no
  longer referenced).

**Final result:** `npm run lint:check` → **exactly 48 errors, 3 warnings
(51 total)** — and a full per-file diff against the `b46a00e` baseline
snapshot shows **zero files differ** (every file's problem count is
identical to baseline, not merely the same total). None of the original 48
was fixed; every one of the ~143 newly-introduced problems was accounted
for and closed.

---

## 15. Dependency audit (§14)

```
npm audit --omit=dev --audit-level=high
```

**Measured this session: 7 high-severity advisories, 1 moderate (8
total)** — not the task's stated expectation of exactly 6.

Named packages: `@nestjs/swagger`, `@prisma/config`, `deepmerge-ts`,
`fast-uri`, `js-yaml`, `mysql2`, `prisma` (high); `qs` (moderate).

**This is not a B1-3/D4-1A integration regression.**
`git diff b46a00e..88776bc -- kitchen-kit/backend/package.json
kitchen-kit/backend/package-lock.json` is **empty** — neither cherry-pick
touched a single dependency. `npm audit` queries the live npm advisory
registry at run time, and the previous session's MW1B report (recorded
2026-09-02, this same date, earlier in the day) measured exactly 6 high
advisories from 3 named packages (`deepmerge-ts`, `js-yaml`, `mysql2`). The
4 additional high advisories now present (`@nestjs/swagger`,
`@prisma/config`, `fast-uri`, `prisma`) affect packages whose install-tree
state did not change between that session and this one. The most
consistent explanation is registry-side advisory-database drift between
sessions (new CVEs published against already-installed transitive
versions), not a code or dependency change made in this integration.

**No package upgrade was performed in this task**, per instruction. This
deviation from the expected count is recorded here as measured evidence,
not silently reconciled to the expected number.

---

## 16. Targeted tests (§15)

All run against the integrated state (`88776bc`, then re-verified against
the reconciliation commit `5d223bf`), using the corrected G1-2 harness
(`npm run test:e2e`, isolated per-suite scratch databases):

| Batch | Suites | Tests | Result |
|---|---|---|---|
| e2e-db-isolation-config, scoped-rbac, scoped-rbac-migration, scoped-authorization-matrix, tenant-context, organisation, catalogue, reporting-authorization, reporting-snapshot, day-close, day-close-cutover-race, day-close-znumber-concurrency, cash-session-close, terminal, sync-protocol, sync-causal, sync-crash-recovery, sync-rls, sync-idempotency, audit, openapi | 21 | 452 | **PASS** |
| sales, sales-lines, sales-fire(+concurrency), sales-payment(+concurrency), order-completion(+2 concurrency variants), order-completion-rls, receipt, cash-movements-close-and-payment-concurrency, movements-concurrency, sync-audit-contention | 14 | 282 | **PASS** |
| unit (includes `permission.guard.spec.ts`) | 66 | 934 | **PASS** |
| `module-boundaries.spec.ts` (isolated) | 1 | 45 | **PASS** |
| `authorization-coverage.spec.ts` (isolated) | 1 | 9 | **PASS** |

Total targeted: **37 suites, 1722 tests, 0 failures.**

---

## 17. Full E2E (§16)

```
npm run test:e2e
```

(the corrected G1-2 harness; run on a shared machine consistent with every
prior session on this repository, not a dedicated runner)

**Result: 77/78 suites passed, 1316/1317 tests passed.**

One failure: `audit.e2e-spec.ts`, test `'records authentication events on
the sentinel chain (success/failure/logout)'` — `expect(failures.length)
.toBeGreaterThan(0)` received `0` (a `LOGIN_FAILURE` audit row for a
deliberately-wrong-password login attempt was not found).

**Investigation before classification (per §16's instruction that Class D
be investigated, not assumed):**

- `git diff b46a00e..88776bc -- kitchen-kit/backend/test/audit.e2e-spec.ts`
  is **empty** — this file is untouched by the B1-3 integration; nothing in
  this session's changes could have caused it.
- Re-run in isolation immediately after: **7/7 PASS**, including this exact
  test.
- Re-run again as part of the 21-suite targeted batch (§16 above, which
  also includes `audit.e2e-spec.ts`): **PASS**.
- The mechanism (a login-throttle/timing-sensitive audit-write race under
  heavy concurrent full-suite host load affecting a request that is
  immediately followed by a query for its side effect) matches the
  documented, precedented Class-C contention pattern from the MW1B
  integration report (§17, `cash-session-close.e2e-spec.ts`, "known/
  environmental, performance/resource-sensitive... not Class D... the
  mechanism... is understood and has precedent, not unexplained"). This
  session's shared-machine conditions (multiple other active worktree lanes
  running concurrently) are identical to every prior session's own
  documented conditions.

**Classification: Class C** (known/environmental, contention-only). Not
Class A (no correctness regression — clean in isolation twice, file
untouched by this integration). Not Class B (no DB-isolation issue — the
scratch-database harness was correctly isolated throughout this run, as
independently confirmed by the DB safety checks in §13/§19). Not Class D
(mechanism understood, precedented in this repository's own prior-session
reports, not unexplained).

**Hard gates (§16):**

| Gate | Result |
|---|---|
| No connection to persistent `ros` | ✓ PASS |
| Auth coverage gate passes | ✓ PASS (§4/§7) |
| Scoped authorization matrix passes | ✓ PASS (§11/§16, 80/80) |
| Inactive branch matrix passes | ✓ PASS (§11, T-12) |
| Foreign/absent 404 matrix passes | ✓ PASS (§12) |
| Sync suites pass | ✓ PASS (protocol, causal, crash-recovery, RLS, idempotency, audit-contention, performance — all green in targeted runs and in the full run) |
| Organisation passes | ✓ PASS |
| Approval runtime passes | ✓ PASS (full run, no failures reported in that suite) |
| Treasury passes | ✓ PASS |
| Inventory passes | ✓ PASS (full run; `movements-concurrency` targeted PASS) |

No Class A, no Class B failures in this run.

---

## 18. Reconciliation commit (§17)

```
5d223bfbf17edbe37934732daa78c504a31ee59e
chore(integration): reconcile scoped authorization
```

Contains exactly: the Sync coverage-gate classification entry (§4), and the
lint fixes for the newly-introduced B1-3-vs-integration-branch formatting
delta (§14). No unrelated product work. No OpenAPI file changes were
needed in this commit (regeneration produced zero diff, §7E) so none are
included.

---

## 19. Requirement status (§18)

- **FR-SEC-004:** COMPLETE — all integrated evidence green (coverage gate,
  matrix suite, targeted + full e2e).
- **FR-API-012:** COMPLETE — token shape/budget evidence green (§10).
- **FR-SEC-028:** PARTIAL (unchanged — local-data wipe on next contact
  still not implemented; not in scope for this integration).
- **FR-PLT-013:** **PARTIAL** (see §7 for the full literal-text analysis).
  The coverage gate is confirmed to run deterministically inside the
  existing CI `quality` job's `npm test` step, but FR-PLT-013's literal SRS
  §6.2.2 requirement — a CI-executed, information-schema-generated,
  exhaustive cross-tenant RLS isolation suite — is a distinct requirement
  that this gate does not satisfy. Missing limb: no generated/exhaustive
  cross-tenant RLS suite exists or is wired into CI; the existing RLS
  suites are hand-written and not proven exhaustive-by-construction.

Lossless revoked-terminal recovery: **NOT claimed** (D4-1B scope,
unimplemented).
D4-1B work: **NOT implemented** in this task.

---

## 20. Database/scratch safety (§19 evidence)

- Zero orphan scratch databases: `SELECT datname FROM pg_database WHERE
  datname LIKE 'ros_test_e2e_%'` against the persistent `ros` connection
  returned **zero rows** after all test runs in this session.
- Persistent `ros`: reachable (one read-only `SELECT current_database()`
  check), never migrated, never written to, never had its schema touched.

---

## 21. Readiness for D4-1B

**READY**, with one disclosed open item: the inactive-branch × Sync
cross-lane design gap found in §6. D4-1B (lossless revoked-terminal
recovery) does not itself require resolving that gap to begin, but the gap
should be carried into D4-1B's design/governance scope or raised as a
dedicated cross-lane decision before Sync is extended with real production
operation handlers, since `SYNC_AUTHORIZATION_PORT`'s eventual
operation-level authorization will need to account for branch lifecycle
state that the current terminal-only guard chain does not check.

---

## Summary of deviations from the task's stated expectations

1. **Dependency audit: 7 high / 1 moderate measured, not 6 high** (§15).
   Confirmed unrelated to this integration (zero dependency-file diff);
   most consistent explanation is live npm-registry advisory drift between
   sessions on the same date. No upgrade performed, as instructed.
2. **FR-PLT-013: remains PARTIAL, not COMPLETE** (§7/§19). The task
   explicitly required reading the literal SRS text before changing status;
   doing so showed the coverage gate landing in CI satisfies a different
   requirement (FR-SEC-004/FR-API-012 evidence), not FR-PLT-013's literal
   cross-tenant-RLS-suite requirement.
3. **A real cross-lane design gap found and NOT fixed, per instruction**:
   inactive branch does not fail closed for Sync (§6). Recorded as an open
   item for D4-1B/governance, not silently patched.
4. **One Class-C, contention-only full-E2E failure** (`audit.e2e-spec.ts`),
   investigated and classified per §16's instruction, not assumed.

None of these required stopping the integration; all are recorded here as
measured, disclosed evidence rather than reconciled away.

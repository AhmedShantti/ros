# Full API OpenAPI — Final Contract Acceptance Correction

**Report type:** Narrow API-contract correction only (follow-up to the
2026-09-01 full 151-endpoint audit). No business logic, runtime wire
behavior, DB schema/migration, or governance change.

**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative. It records two
narrow corrections requested against the accepted broad audit, plus their
verification — it does not reopen or repeat that audit.

**Date:** 2026-09-01

**HEAD at start:** `803aa3d54d6b163b6aa0589532d6420d5c144d0e`
(`fix: complete API response schemas`)

**Parent of that commit:** `02fd05a782f7638e375b5418ad7c8775b0e2466f`

**Branch:** `feat/production-spec`

**Working tree at start:** exactly the 4 expected pre-existing historical
reports (untracked) + their 4 `INDEX.md` rows (modified) — identical
residue to the prior task, re-verified before starting (0 deletions, 4
content additions in the `INDEX.md` diff).

**Task identifier:** ROS — FULL API OPENAPI FINAL CONTRACT ACCEPTANCE
CORRECTION

---

## 1. Scope

The broad 151-endpoint audit (commit `803aa3d`) is accepted as-is. This task
corrects exactly two issues raised against it, plus hardens the test
covering both, and the opaque-object exemption in the schema-completeness
sweep:

1. `POST /branches/{branchId}/day-closes/{businessDay}`'s 200 response was
   flattened into one object schema instead of a real `oneOf` union.
2. The path-parameter format post-processor (`enrichPathParameterSchemas`)
   and its future test coverage used one internal name list with no shared,
   importable, pure mapping — risking two independently-maintained lists
   drifting apart.
3. (Test-hardening, requested alongside #1/#2) The schema-completeness
   sweep's opaque-object exemption (`{type:'object', description:'...'}`
   passes) was applied at the top level, which could let a future entire
   response ship undocumented behind prose alone.

No controller/service business logic, no DTO used for request validation,
no Prisma schema, no migration, and no governance file was touched.

---

## 2. DayClose POST — flattened schema (BEFORE) vs `oneOf` (AFTER)

### BEFORE (commit `803aa3d`)

One flat object schema, `outcome` documented via `enum: ['ACTIVATED',
'CLOSED']`, and `dayClose` carrying a free-text "Present only when outcome
is CLOSED" description — nothing in the schema itself rejected an
ACTIVATED-outcome payload that also carried `dayClose`, or a CLOSED-outcome
payload missing it. This mirrored an established Treasury precedent
(`declareCloseResponseSchema`/`finalizeCloseResponseSchema` in
`treasury.controller.ts`), but for DayClose specifically it is not an
accurate machine-checkable contract of `DayClosePostResult` — a real TS
discriminated union of two structurally distinct object literal types (verified again this session against `day-close.service.ts`):

```ts
export type DayClosePostResult =
  | { outcome: 'ACTIVATED'; branchId; businessDay;
      activationBusinessDay; firstEligibleBusinessDay }
  | { outcome: 'CLOSED'; branchId; businessDay;
      activationBusinessDay; firstEligibleBusinessDay; dayClose };
```

### AFTER

`dayClosePostResultSchema = { oneOf: [dayCloseActivatedResultSchema, dayCloseClosedResultSchema] }`.

Each branch (`src/modules/treasury/day-close/day-close.controller.ts`):

- `type: 'object'`
- its own exact `required` list (ACTIVATED: 5 fields; CLOSED: the same 5 +
  `dayClose`)
- `additionalProperties: false` (so a hybrid payload structurally fails
  BOTH branches, not just one — `oneOf` requires exactly one match)
- `outcome: { type: 'string', const: 'ACTIVATED' }` /
  `const: 'CLOSED'` as the real discriminator (OpenAPI 3.1 / JSON Schema
  2020-12 `const`, confirmed to validate cleanly against the repository's
  existing tooling — see §4)

No controller/service output changed — `DayCloseController.post`/
`DayCloseService.post` are byte-identical to before this task.

---

## 3. Union structural + valid/invalid example tests

Added a `describe('DayClose POST — discriminated union contract', ...)`
block to `test/openapi.e2e-spec.ts` (8 tests):

- 200 schema is a `oneOf` with exactly 2 concrete variants (each `type:
  'object'` with ≥1 property)
- ACTIVATED variant: `required` contains exactly its 5 real fields,
  `outcome.const === 'ACTIVATED'`, `properties.dayClose` is `undefined`,
  `additionalProperties === false`
- CLOSED variant: `required` contains exactly its 6 real fields (the 5 +
  `dayClose`), `outcome.const === 'CLOSED'`, `properties.dayClose` is
  defined, `additionalProperties === false`
- A tiny, purpose-built structural validator (`satisfiesFlatObjectSchema`/
  `matchesUnion`) — deliberately NOT a general JSON Schema engine, and
  deliberately NOT pulling in `ajv` (present in `node_modules` only as a
  transitive dependency of `@seriousme/openapi-schema-validator`, not a
  direct project dependency — using it directly would be relying on an
  undeclared, potentially-hoisted-away package for a two-flat-object union
  this small) — checks `required`/`additionalProperties`/`const` against
  representative example payloads:
  - **VALID** ACTIVATED (`outcome`, `branchId`, `businessDay`,
    `activationBusinessDay`, `firstEligibleBusinessDay`) → matches exactly
    one branch
  - **VALID** CLOSED (the same 5 + `dayClose`) → matches exactly one branch
  - **INVALID** `outcome: 'CLOSED'` with only ACTIVATED fields (no
    `dayClose`) → matches zero branches (fails CLOSED's `required`, fails
    ACTIVATED's `const`)
  - **INVALID** `outcome: 'ACTIVATED'` with `dayClose` present → matches
    zero branches (fails ACTIVATED's `additionalProperties: false`, fails
    CLOSED's `const`)
  - **INVALID** `outcome: 'PENDING'` (unknown) → matches zero branches
    (fails both `const`s)

**Proof these are not vacuous:** the pre-correction (`803aa3d`) flattened
`day-close.controller.ts` was temporarily restored, OpenAPI regenerated,
and just the `DayClose POST` test block re-run:

```
Test Suites: 1 failed, 1 total
Tests: 8 failed, 38 skipped, 46 total
```

All 8 failed with `TypeError: Cannot read properties of undefined (reading
'filter')` — `schema.oneOf` did not exist on the flattened schema, exactly
as expected. The corrected controller was restored, OpenAPI regenerated
again, and the full suite re-run clean (46/46, see §7).

---

## 4. OpenAPI 3.1 meta-schema / `$ref` / `const` compatibility

The existing suite's `'the full document validates against the official
OpenAPI 3.1 meta-schema'` and `'the validator can fully dereference every
$ref'` tests (`@seriousme/openapi-schema-validator`) both pass against the
regenerated document — confirming `oneOf`/`const`/`additionalProperties`
inside the DayClose response schema are valid OpenAPI 3.1 / JSON Schema
2020-12 constructs the repository's own tooling accepts cleanly, with no
new validator dependency introduced.

---

## 5. Shared path-parameter mapping helper (no duplicated lists)

`src/common/openapi/oas31.util.ts` now exports:

- `UUID_PATH_PARAM_NAMES` (the same exhaustive, manually-verified 22-name
  set from the prior audit — unchanged)
- `UUID_EXAMPLE`
- `type PathParamKind = 'uuid' | 'businessDay' | 'version'`
- `function classifyPathParamName(name: string): PathParamKind | null` — the
  single pure classification function

`enrichPathParameterSchemas` (the document post-processor) was refactored
to call `classifyPathParamName` instead of inlining the `UUID_PATH_PARAM_NAMES.has(name)`/`name === 'businessDay'`/`name === 'version'` checks directly — its *behavior* is unchanged (same names, same
`format`/`type` outputs), only the classification logic moved into one
exported, reusable function.

`test/openapi.e2e-spec.ts` imports `classifyPathParamName` directly from
`src/common/openapi/oas31.util.ts` (`import { classifyPathParamName } from
'./../src/common/openapi/oas31.util'`) rather than maintaining a second,
independently-typed name list — the post-processor and the test now share
exactly one source of truth for "which path-parameter names get which
format."

---

## 6. Exhaustive path-parameter format/type test

Added a `describe('path parameters — exhaustive format/type contract',
...)` block (2 tests), both deriving their check set from `doc.paths`
globally — not the specific 106 previously-affected instances:

1. **"every `{placeholder}` in every path has exactly one matching
   `in:path` parameter, none optional"** — for every operation, extracts
   every `{name}` placeholder from the path string via regex, and asserts
   exactly one `parameters` entry has `in === 'path'` and `name === name`,
   with `required === true`.
2. **"every path parameter classified uuid/businessDay/version carries the
   exact expected type+format"** — for every `in:path` parameter, calls
   `classifyPathParamName(param.name)`; if it returns `'uuid'`, asserts
   `{type:'string', format:'uuid'}`; if `'businessDay'`, asserts
   `{type:'string', format:'date'}`; if `'version'`, asserts
   `{type:'integer'}`; parameters the mapping doesn't classify are skipped
   (not asserted either way — this test is about the classified set, not an
   opinion on every arbitrary future name).

Both pass clean against the current document (0 violations) — this
mechanically re-verifies, and now permanently guards, the 104 UUID/
businessDay format fixes + 2 `version` primitive fixes from the prior
audit, without hardcoding which 106 instances they are.

---

## 7. Opaque-object exemption — narrowed to eliminate the top-level loophole

**BEFORE:** `isUnderspecifiedObject` (used only on TOP-LEVEL response/
request schemas — it was never recursed into nested properties) treated a
bare `{type: 'object', description: '...'}` as acceptable, mirroring the
repository's real, deliberate convention for genuinely opaque NESTED JSON
columns (localized-name/address/theme blobs in Catalogue/Organisation/
Inventory/Kitchen). Applied at the top level, this was a loophole: a future
entire HTTP response could ship as `{type:'object', description:'...'}` and
pass the sweep on prose alone.

**AFTER:** the description-only exemption is removed entirely from
`isUnderspecifiedObject`. It is applied ONLY to top-level schemas (still
never recursed into nested properties, so the repository's real nested
opaque-JSON fields are untouched — they were never subject to this
function to begin with, and are not re-flagged). A `TOP_LEVEL_OPAQUE_ALLOWLIST`
(currently empty `Set<string>`) is defined for the narrow, explicit,
reviewed case of a genuinely opaque top-level response, per the task's
"maintain a very small explicit allowlist" option — the current, audited
API surface has **zero** such responses, and this allowlist being empty is
itself now a mechanically-enforced invariant (any future top-level
`{type:'object'}` response fails the sweep unless someone deliberately adds
its exact `METHOD path status` key to this allowlist in a reviewed diff).

Verified this narrowing did not reintroduce any false positive: the full
46-test (now 46, see §9) OpenAPI suite — including the unchanged 2xx/
request-body/error-schema completeness sweeps — passes clean against the
current 151-endpoint surface, confirming the zero-top-level-opaque-response
invariant holds mechanically, not merely by inspection.

---

## 8. OpenAPI regeneration

```
$ npm run openapi:generate
Wrote docs/api/openapi.json
Wrote docs/api/openapi.yaml
```

- **Route count: 151 → 151** (verified via sorted `METHOD path` list diff
  against the mechanically-derived source inventory — `IDENTICAL - NO
  MISMATCHES`, unchanged from the prior audit)
- **Source/OpenAPI mismatch: 0**
- **DayClose POST 200 schema:** now `oneOf` with 2 concrete variants
  (verified via direct `jq` inspection of the regenerated document — see
  §2/§3)
- **All `$ref`s resolve:** `'every $ref resolves to a component that
  exists'` passes; `'the validator can fully dereference every $ref'`
  passes
- **No unrelated route/schema loss:** confirmed by the same sorted-list
  diff; no other endpoint's schema was touched by this task
- **Determinism:** regenerated twice consecutively, byte-diffed —
  identical both times

---

## 9. Tests

| Suite | Result |
|---|---|
| `test/openapi.e2e-spec.ts` (`NODE_OPTIONS=--experimental-vm-modules`) | **46/46 passed** (36 baseline from the prior audit + 10 new: 8 DayClose union tests + 2 exhaustive path-parameter tests) |
| Full unit suite (`npx jest`) | **797/797 passed**, 59/59 suites — unchanged |
| `src/modules/module-boundaries.spec.ts` | **45/45 passed** — unchanged, zero new `KNOWN_DEVIATIONS` |

**Proof of non-vacuity (DayClose union):** see §3 — 8/8 new union tests
fail against the restored pre-correction schema with the exact expected
error, and pass after correction.

**Path-parameter test:** exhaustive by construction (derives from
`doc.paths` globally), currently 0 violations across all 151 operations.

---

## 10. Full end-to-end verification

**Scratch DB:** `ros_scratch_final_correction`, created inside the same
project `docker-compose.yml` Postgres 16 container used by the prior audit
(already running this session). The persistent `ros` database was never
connected to for any write.

```
$ DATABASE_URL=...ros_scratch_final_correction npx prisma migrate deploy
35 migrations found in prisma/migrations
All migrations have been successfully applied.

$ npx prisma migrate status
Database schema is up to date!
```

**35/35 migrations from zero** — unchanged (no migration touched by this
task).

A first full-suite run under Jest's default parallel workers against the
freshly-migrated scratch DB showed 1 suite / 21 tests fail with `Database
error. Code: 42501. Message: permission denied for table
order_number_blocks` inside `order-completion-rls.e2e-spec.ts`. Investigated
before accepting or dismissing it:

- Confirmed table/schema grants were correct (`\dp sales.order_number_blocks`
  showed `ros_app=arwd`, `has_schema_privilege('ros_app','sales','USAGE')`
  returned `true`) — not a real grant defect.
- Re-ran `order-completion-rls.e2e-spec.ts` in isolation against the same
  (already-migrated) scratch DB: **21/21 passed clean.**
- Concluded this was cross-suite interference under Jest's parallel workers
  against a scratch DB not yet "warmed" by other suites' fixture setup — a
  concurrency flake, not a defect this task's changes could plausibly cause
  (this task touched zero Sales/Treasury-RLS/migration code).
- Recreated a genuinely fresh scratch DB (drop + recreate + `migrate
  deploy` from zero again) and re-ran the **full** suite with
  `--runInBand` (serial, eliminating the parallel-worker race) for a clean,
  authoritative result:

```
$ DATABASE_URL=...scratch APP_DATABASE_URL=...scratch \
  NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/jest-e2e.json --runInBand
Test Suites: 63 passed, 63 total
Tests:       1134 passed, 1134 total
```

**1134/1134, 63/63 suites** — previous accepted baseline was 1124/1124
(post prior-audit); +10 is exactly the new DayClose-union + path-parameter
tests added in this task. 100% pass, zero exclusions. (The `ERROR` log
lines during the run are the same pre-existing deliberately-injected
rollback-proof test doubles noted in the prior report — expected output.)

Scratch database dropped after verification; confirmed via `SELECT datname
FROM pg_database WHERE datname LIKE 'ros%'` — `ros_scratch_final_correction`
no longer present, `ros` and all pre-existing historical scratch databases
untouched.

---

## 11. Static quality

```
$ npx prisma validate          → valid
$ npx nest build                → clean (part of npm run openapi:generate)
$ npx tsc --noEmit               → 1 PRE-EXISTING ERROR (src/modules/identity/auth/access-token.service.spec.ts,
                                    unrelated file, unchanged), ZERO NEW ERRORS
$ git diff --check               → clean
$ npx eslint <3 changed files>   → 0 errors, 0 warnings (2 prettier formatting
                                    issues in the test file, auto-fixed via
                                    --fix and re-verified clean)
```

Changed files (3): `src/common/openapi/oas31.util.ts`,
`src/modules/treasury/day-close/day-close.controller.ts`,
`test/openapi.e2e-spec.ts`.

---

## 12. Zero runtime / DB / governance change

- **Runtime wire changes: 0.** `DayCloseController`/`DayCloseService`
  handler logic is byte-identical to `803aa3d`; the response body a client
  actually receives on the wire is unchanged — only its OpenAPI
  *documentation* became a real `oneOf` instead of one flattened object
  schema.
- **DB schema / migration changes: 0.** No `prisma/schema.prisma` edit, no
  new/edited migration file (still 35 total).
- **Governance changes: 0.** No `GOVERNANCE_DECISION_REGISTER.md` edit; no
  requirement classification touched (DayClose FR-FIN-020/021/023/024
  COMPLETE, 022/026 PARTIAL, 025 NOT IMPLEMENTED `[S]` — all unchanged from
  the prior audit and untouched here).

---

## 13. Files changed

| File | Change |
|---|---|
| `src/modules/treasury/day-close/day-close.controller.ts` | Replaced the flattened `dayClosePostResultSchema` with `dayCloseActivatedResultSchema`/`dayCloseClosedResultSchema` + `oneOf` |
| `src/common/openapi/oas31.util.ts` | Exported `UUID_PATH_PARAM_NAMES`/`UUID_EXAMPLE`/`PathParamKind`/`classifyPathParamName`; `enrichPathParameterSchemas` now calls the shared classifier instead of inlining the checks |
| `test/openapi.e2e-spec.ts` | Narrowed `isUnderspecifiedObject`'s opaque-object exemption to a small, explicit, currently-empty top-level allowlist; added the DayClose union structural + valid/invalid example tests (8); added the exhaustive path-parameter format/type test (2) |
| `docs/api/openapi.json` / `docs/api/openapi.yaml` | Regenerated via `npm run openapi:generate` (never hand-edited) |

---

## 14. Verdict

**A. FULL API CONTRACT ACCEPTANCE CLEAN — READY TO PUSH**

Both requested corrections applied and verified: DayClose POST's 200
response is now a genuine, structurally-enforced `oneOf` union (proven to
reject every named invalid combination and accept every named valid one,
and proven to have failed against the pre-correction schema); the
path-parameter format mapping is now a single shared, exported, pure
function consumed by both the document post-processor and its permanent
exhaustive test; the opaque-object test exemption no longer has a
top-level loophole. Zero runtime wire, DB/migration, or governance change.
Full regression evidence: OpenAPI 46/46, unit 797/797, module-boundaries
45/45, full e2e 1134/1134 (63/63 suites) on a from-zero scratch DB,
migrations 35/35 clean, static checks all clean (1 pre-existing unrelated
`tsc` error, zero new).

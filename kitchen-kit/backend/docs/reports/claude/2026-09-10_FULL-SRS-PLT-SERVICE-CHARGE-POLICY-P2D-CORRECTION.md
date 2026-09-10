# FULL-SRS-PLT-SERVICE-CHARGE-POLICY-P2D-CORRECTION — Precedence-Wording Correction + Strengthened Acceptance Evidence

**Report type:** Implementation correction report (evidence, not governance).
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority.
This correction implements **no new design and no governance action** —
`P2D-R1` is unchanged and unreopened. It resolves exactly two acceptance
issues raised against the already-implemented `P2D` slice
(`docs/reports/claude/2026-09-10_FULL-SRS-PLT-SERVICE-CHARGE-POLICY-P2D.md`,
commits `8715474`/`aaa41ed`).
**Date:** 2026-09-10
**HEAD at task start:** `aaa41ed` (tip of `full-srs/lane-d4-reporting-demo`
— the P2D report's own hash-recording follow-up commit).
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree at task start:** clean except pre-existing untracked report
files from earlier tasks in this session (not part of this task's diff).
**Task identifier:** `FULL-SRS-PLT-SERVICE-CHARGE-POLICY-P2D-CORRECTION`

---

## 1. Mission recap

Resolve exactly TWO acceptance issues raised against P2D, both
IMPLEMENTATION-CORRECTION-ONLY (no redesign, no governance change, no
service-charge computation):

1. **CRITICAL** — determine whether `computeWinningVersion`'s actual
   PRECEDENCE + LOCK semantics match the ratified `P2D-R1` hierarchy (lower
   configured level overrides a higher one UNLESS the higher is locked), or
   whether the P2D report's own description of that algorithm ("stops at
   the first level carrying ANY version — locked or not") was correct
   instead — fix whichever is wrong, add the ten enumerated precedence
   test scenarios with explicit `id`/`level`/`locked` assertions, and
   verify Order pinning uses the corrected resolver.
2. Add an executable, DATABASE-boundary proof of anti-backdating — a raw
   INSERT that omits `created_at`, supplies a past `effective_from`, and
   must fail specifically because `ck_scp_no_backdating` is violated —
   distinct from the existing service-layer 400 and the existing
   `created_at`-forgery-blocked evidence.

---

## 2. Finding — precedence/lock semantics: SOURCE WAS ALREADY CORRECT; the P2D REPORT'S PROSE WAS WRONG

**Investigated first, before changing anything**, per this task's own
instruction not to assume.

### 2.1 Source inspection

`service-charge-policy.resolver.ts`'s `computeWinningVersion`
(unchanged by this correction — reproduced verbatim):

```ts
export function computeWinningVersion(
  entries: readonly ServiceChargePolicyBreakdownEntry[],
): ResolvedServiceChargePolicyVersion | null {
  let winner: ResolvedServiceChargePolicyVersion | null = null;
  for (const entry of entries) {
    if (!entry.eligible || entry.version === null) continue;
    winner = entry.version;
    if (entry.version.locked) break;
  }
  return winner;
}
```

Walking `entries` in fixed `[tenant, brand, branch]` order: every eligible,
CONFIGURED level **overwrites** the running `winner` — so a lower
configured level always supersedes a higher one — and the loop **only
stops** (`break`) when the level it just assigned as winner is `locked`.
An unlocked higher-level version never blocks a lower one; it is simply
overwritten by it. This is **exactly** the ratified `P2D-R1` hierarchy
this task's own pseudocode states, clause for clause.

### 2.2 Test inspection

The existing unit suite (`service-charge-policy.resolver.spec.ts`, as
committed in `8715474`) already asserted this correct behavior — e.g.
`'tenant + brand => brand wins (4)'` created an **unlocked** tenant
version and an unlocked brand version and asserted the winner is the
**brand** version — which would have been **impossible** under the
report's mischaracterized "first level with ANY version wins" reading. The
existing tests were already passing under the real, correct algorithm.

### 2.3 Root cause

The defect is entirely in **§13 of the P2D report's prose**
(`2026-09-10_FULL-SRS-PLT-SERVICE-CHARGE-POLICY-P2D.md`), which stated:

> "stops at the first level carrying ANY version — locked or not — since a
> version's mere presence at a higher level already outranks every lower
> level regardless of its own lock flag"

This sentence is **factually wrong** and contradicts both the source it
was describing and that report's own unit-test evidence one paragraph
away. It was a writing error made while summarizing the algorithm, not a
misimplementation. **No source change was required or made for this
finding.**

### 2.4 Disposition of the original report

Per this repository's established correction convention (`CI-1` →
`CI-1 (ACCEPTANCE CORRECTION)`, `P2A2`, `P2A3`), **the original P2D report
file is left unedited** — reports are append-only evidence, never silently
rewritten. This correction report is the authoritative statement that §13
of the original report mischaracterized (but did not misrepresent the
correctness of) the implementation, and that the actual, shipped algorithm
has always matched `P2D-R1`.

---

## 3. Strengthened precedence tests

`service-charge-policy.resolver.spec.ts` rewritten (same file, same pure
`computeWinningVersion` under test — no production code changed) to state
the ten scenarios enumerated by this correction task explicitly, each
asserting `winner.id`, `winner.level`, AND `winner.locked` via a new
`expectWinner` helper (never mere reference-identity `toBe`, and never
only an HTTP status):

| # | Scenario | Winner |
|---|---|---|
| 1 | no policy anywhere | `null` |
| 2 | tenant only | tenant |
| 3 | tenant unlocked + brand configured | **brand** |
| 4 | tenant unlocked + brand unlocked + branch configured | **branch** |
| 5 | tenant locked + brand + branch configured | **tenant** |
| 6 | tenant unlocked + brand locked + branch configured | **brand** |
| 7 | tenant unlocked + brand unlocked + branch locked | **branch**, `locked: true` |
| 8 | empty tenant `rules: []` unlocked + brand configured | **brand** |
| 9 | empty brand `rules: []` unlocked + branch configured | **branch** |
| 10 | empty brand `rules: []` LOCKED + branch configured | **brand** (rules `[]`, still locks) |

Two supplementary tests (ineligible-level exclusion; strict array-position
walk order, independent of id ordering) are retained unchanged from the
original suite — both still valid, still passing.

**12/12 passing** (`npx jest --testPathPatterns "service-charge-policy.resolver.spec"`).

---

## 4. Order pinning — verified against the corrected understanding

The resolver needed no fix, so `OrdersService.create`'s pinning call
(unchanged) was already using the correct algorithm. Verified explicitly,
end-to-end through the real HTTP admin surface and real `OrdersService`:

- **Unlocked override** — already proven by the existing (unmodified)
  e2e test `'B/C/D: pins tenant, then branch override, then a higher
  LOCKED version'`: an unlocked tenant version, then a branch version
  created on top, and the next order pins the **branch** version — the
  exact "unlocked tenant + branch → pins branch" pair this task requires.
- **Locked-higher blocks lower** — new e2e test added, `'H: a LOCKED
  tenant version wins over a configured (unlocked) branch version'`: a
  fresh, isolated scope (own brand/branch/terminal/employee via
  `mkOrderScope()`) gets an unlocked branch-level version, then the
  **tenant** level is (re-)configured with `locked: true`; the next order
  pins the **tenant** version and explicitly asserts it is NOT the branch
  version — the exact "locked tenant + branch → pins tenant" pair this
  task requires. Placed as the LAST test in the file (a locked
  tenant-level version, once created, governs every subsequent order for
  `tenantA` that has no branch/brand override of its own — the same
  test-pollution discipline the original P2D e2e suite already
  established for `mkOrderScope()`).

---

## 5. DB anti-backdating — executable, database-boundary proof

Three INDEPENDENT pieces of evidence, kept distinct as instructed
("keep all three if useful"):

1. **`SERVICE_BACKDATED_WRITE`** — NEW e2e test,
   `'rejects a past effectiveFrom with a friendly 400, before any DB
   write is attempted'`: hits the real `POST /service-charge-policy/
   tenant` route with a past `effectiveFrom`, asserts `400` and the
   friendly message text. This is the service-layer UX guard — it did
   not previously have a dedicated e2e test (the guard existed in
   `ServiceChargePolicyService.parseEffectiveFrom` since the original
   P2D implementation, but was never independently exercised via the
   real HTTP route in the original P2D e2e suite).
2. **`DB_RAW_BACKDATED_INSERT`** — the pre-existing e2e test `'B: a raw
   INSERT with a past effectiveFrom fails at the DB CHECK, even
   bypassing the service'` (unchanged data/shape) had its assertion
   **strengthened** from a generic `.rejects.toThrow()` (which would
   have matched ANY failure reason, including an unrelated one) to
   `.rejects.toThrow(/ck_scp_no_backdating/)` — now unambiguous evidence
   that the rejection is specifically the `ck_scp_no_backdating` CHECK
   constraint, not merely "some error occurred." The INSERT omits
   `created_at` (so it takes the `statement_timestamp()` default = now)
   and supplies an explicit past `effective_from`, reaching real
   PostgreSQL through `appPrisma.withAuthContext` (the real application
   DB role, no service layer involved) — confirmed to still pass with
   the strengthened, specific assertion.
3. **`CREATED_AT_FORGERY_BLOCKED`** — the pre-existing e2e test `"F:
   created_at cannot be supplied through the application role's granted
   INSERT column set"` (unchanged) — proves the granted-column-set
   boundary that makes evidence #2 meaningful in the first place: a
   caller cannot simply supply an old `created_at` alongside an old
   `effective_from` to dodge the CHECK, because `created_at` is not in
   `ros_app`'s granted INSERT column list at all.

**No grants or RLS were weakened to make any of these three tests pass** —
all three exercise the existing, unmodified privilege/CHECK boundary from
the original P2D migration.

---

## 6. Regression

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |
| `npx eslint` (both changed test files) | clean, 0 errors, 0 warnings |
| `service-charge-policy.resolver.spec.ts` (unit) | **12/12** |
| `service-charge-policy.e2e-spec.ts` (e2e) | **27/27** (was 25; +2 new: `SERVICE_BACKDATED_WRITE`, Order-pinning Case H) |
| Full local unit suite (88 suites) | **1214/1214** (was 1212; +2 new precedence assertions) |
| `sales.e2e-spec.ts` / `sales-lines.e2e-spec.ts` / `sales-fire.e2e-spec.ts` / `platform-settings.e2e-spec.ts` (Orders creation, Sales order flow, cash-rounding, Country Pack/tax regression) | **149/150** — the one failure is the SAME pre-existing, unrelated `orders.controller.ts` route-list assertion documented in the original P2D report (§20); confirmed again this task touches zero lines of `orders.controller.ts`/`orders.service.ts` |
| `module-boundaries.spec.ts` + `authorization-coverage.spec.ts` | **55/55**, zero new `KNOWN_DEVIATIONS` |
| `npx prisma validate` / `generate` | not run — no schema change in this correction |
| `npm run openapi:generate` | run to confirm; **empty diff** (`git status --short docs/api` — nothing) — no source/schema/API surface changed, only two test files |

No full E2E suite run, per this task's own instruction.

---

## 7. Scope discipline

Confirmed unchanged, per this task's explicit fence: `P2D-R1` governance,
`ServiceChargePolicy` storage architecture, the JSONB rule schema,
`Order.openedAt` as the governing instant, permissions, the admin route
design, cash rounding, tax, `P2C1`, and P2E computation. **Zero production
source files were modified** — this correction touched exactly two test
files (`service-charge-policy.resolver.spec.ts`,
`test/service-charge-policy.e2e-spec.ts`). No `serviceChargeTotal`
calculation and no `serviceChargeTaxable` application were added.

---

## 8. Requirement status

Independently reassessed, consistent with — not superseding — the
original P2D report's own reassessment:

- **FR-PLT-025** — COMPLETE, unchanged.
- **FR-PLT-026** — COMPLETE, unchanged.
- **FR-PLT-027** — COMPLETE, unchanged (narrow domain-owned read surface
  remains sufficient per `P2D-R1` clause 12).
- **FR-PLT-028** — **remains PARTIAL. Not marked COMPLETE.** The
  precedence/lock semantics are now proven correct beyond doubt, but this
  correction adds no computation — `Order.serviceChargeTotal` stays zero
  for every order. P2E is still required before this can become COMPLETE.
- **FR-POS-055** — configuration portion remains COMPLETE (branch/
  orderType/guestCount dimensions); the requirement as a whole remains NOT
  COMPLETE pending P2E.

**P2E is still required and was not started.**

---

## 9. Files changed

**Modified (test-only):**
- `src/modules/sales/service-charge-policy/service-charge-policy.resolver.spec.ts`
  — restated as the ten enumerated scenarios with explicit
  `id`/`level`/`locked` assertions (12 tests total, was 10).
- `test/service-charge-policy.e2e-spec.ts` — added the
  `SERVICE_BACKDATED_WRITE` test, strengthened the `DB_RAW_BACKDATED_
  INSERT` (test B) assertion to match the specific CHECK constraint name,
  and added Order-pinning Case H (27 tests total, was 25).

**New:**
- `docs/reports/claude/2026-09-10_FULL-SRS-PLT-SERVICE-CHARGE-POLICY-P2D-CORRECTION.md`
  (this report).

No Prisma schema, migration, controller, service, resolver, DTO, or
OpenAPI file was touched.

---

## 10. Commit

Correction (two test files) + this report + `INDEX.md` committed together
as `COMMIT` below, per this task's instruction. No push.

`COMMIT`: *(recorded after commit — see §11)*

---

## 11. Post-commit hash record

*(Updated by this same commit's own final line, or a follow-up docs-only
commit if the report needs to be amended after — matching this session's
established convention.)*

---

## 12. Blockers or uncertainties

None. Both acceptance issues resolved: issue 1 required no source change
(the report's prose was the defect, now corrected here and made
unambiguous by twelve executable, explicitly-asserted unit tests plus one
new end-to-end Order-pinning case); issue 2 added one new e2e test and
strengthened one existing assertion to name the exact CHECK constraint.
Zero regressions across the full targeted battery; the one pre-existing,
unrelated `sales.e2e-spec.ts` failure is unchanged from the original P2D
report and out of this task's scope fence.

**SAFE_TO_BEGIN_P2E:** Yes. The configuration substrate's precedence/lock
semantics are now proven correct with unambiguous, explicit evidence, and
its anti-backdating enforcement has an executable database-boundary proof
distinct from the service-layer guard. `FR-PLT-028`/`FR-POS-055` remain
correctly PARTIAL pending P2E's actual computation work.

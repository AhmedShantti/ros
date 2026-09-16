# PREFIRE-VOID-NO-REASON-P0 — Implementation & Verification

**Report type:** Implementation/verification report.
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions (specifically the "Pre-Fire Void Reason
Removed" entry this task adds to
`docs/governance/GOVERNANCE_DECISION_REGISTER.md`) remain authoritative.
**Date:** 2026-09-16
**HEAD (backend):** `c710403a9f72fefde4a22c3b54f2e9fdebc08a6f` on
`kds-station-discovery` — **unchanged; all work below is in the working
tree, NOT committed** (no commit instruction was given).
**HEAD (frontend):** `ca1c350758f63fb1ae81a79cfd4023d334b4a373` on `main` —
**unchanged; all work below is in the working tree, NOT committed.**
**Working tree summary:** See file lists in each section below. The
pre-existing, unrelated frontend WIP
(`app/(console)/menu/pricing/page.tsx`, `content/console/ar.ts`,
`content/console/en.ts`, `app/(console)/menu/pricing/new-price-list-drawer.test.tsx`)
was **not touched, read, or referenced** — confirmed present and unchanged
in the final `git status`.
**Task identifier:** PREFIRE-VOID-NO-REASON-P0

---

## 1. Product decision recorded

Appended a new unnumbered ratified entry, **"PREFIRE-VOID-NO-REASON-P0 —
Pre-Fire Void Reason Removed — RATIFIED 2026-09-16"**, to
`kitchen-kit/backend/docs/governance/GOVERNANCE_DECISION_REGISTER.md`
(end of file), following the exact style of the most recent precedent
entries (`CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0`, `P2D-R1`, etc.):
blockquote recording note, "The decision", "Why a pre-fire void has nothing
for a reason to classify", "Requirement impact" (FR-POS-075, FR-POS-013 —
both explicitly NARROWED for pre-fire void only, both unchanged everywhere
else), "Binding constraints on implementation", "Preservation", "Evidence",
and a `**Status:**` line. Did not touch the baselined SRS PDF, did not
renumber or reopen D-1..D-20 or any other unnumbered entry.

## 2. Backend

### 2.1 Pre-fire void (`DELETE /orders/{businessDay}/{id}/lines/{lineId}` → `OrderLinesService.voidLinePreFire`)

- **`src/modules/sales/sales.dto.ts`** — `VoidOrderLineDto` is now an empty
  class (no `reasonCodeId` field, required or otherwise). The global
  `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` means a
  client that still sends `reasonCodeId` now gets a genuine 400 (proven by
  a new test, §2.4) — the contract does not merely ignore an old field, it
  refuses it.
- **`src/modules/sales/orders/order-lines.service.ts`** — `VoidLineInput`
  dropped `reasonCodeId`; `voidLinePreFire` no longer performs
  `tx.reasonCode.findUnique(...)` at all (no `inventory.reason_codes`
  lookup, no validation). `orderLine.update`'s `data` no longer sets
  `voidReasonId` (stays `null` — never fabricated). The audit entry's
  `metadata` (→ `afterState`) now carries `reasonCodeId: null` and a new
  `voidType: 'PRE_FIRE_VOID'` marker identifying the operation explicitly,
  as required.
- **`src/modules/sales/orders/orders.controller.ts`** — `voidLine` no
  longer passes `reasonCodeId` to the service call; corrected two adjacent,
  now-stale doc comments that claimed the post-fire path was "not
  implemented" (it has been, since POS-FIN-1 — pre-existing staleness,
  fixed in passing since directly adjacent to the code being edited).
- **Authorization**: `@RequirePermission(SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE)`
  and every guard on the route are untouched.
- **Idempotency**: the route's existing `If-Match` concurrency check is
  untouched; this route never carried an `Idempotency-Key` (DELETE, no
  `@Idempotent()`) before or after.

### 2.2 New migration — `20260916120000_prefire_void_reason_optional`

`ck_order_line_void_reason` (`sales.order_lines`) previously required
`void_reason_id IS NOT NULL` whenever `state = 'voided'`, with no way to
tell a pre-fire void from a post-fire one at the constraint level (both
transition to `voided`). Replaced with:

```sql
CHECK ("state" <> 'voided' OR "void_reason_id" IS NOT NULL OR "fired_at" IS NULL)
```

`fired_at IS NULL` is exactly the fact `ck_order_line_fired_at` (unchanged)
already guarantees for every pre-fire void and denies for every post-fire
one — this is real DB-level enforcement, not a blanket relaxation: **a
voided line that WAS fired still requires a reason**, enforced by Postgres
itself, independent of the application layer.

### 2.3 Post-fire void — unchanged

`src/modules/sales/orders/post-fire-void.service.ts`,
`VoidOrderLinePostFireDto`, the `pos.order.void_line_postfire` permission,
and every inventory/disposition/audit consequence are **byte-unchanged**.
Verified by diff (only the three files in §2.1 plus the DTO file changed)
and by test (§2.4 — post-fire e2e suite passes unmodified, plus one new
test closing a pre-existing coverage gap).

### 2.4 Backend tests added/changed

- `test/sales-lines.e2e-spec.ts` ("Clarification C"): renamed and adjusted
  the existing pre-fire-void test to send no reason; added four new tests —
  a no-body void, a rejected legacy `reasonCodeId` (400, proves the
  contract genuinely refuses one now), an audit-entry assertion (actor,
  before/after state, `reasonCodeId: null`, `voidType: 'PRE_FIRE_VOID'`),
  and a no-inventory-effect assertion (zero `post_fire_void`-referenced
  stock movements, no `PostFireVoidRecord` row).
- `test/pos-financial-corrections.e2e-spec.ts` (§E, post-fire): added
  `E2b` — missing `reasonCodeId` on the post-fire route is still a 400
  (this exact case had no prior explicit e2e assertion, unlike discount/
  refund/cancel's equivalents — closed as a pre-existing coverage gap,
  directly relevant to proving post-fire is unweakened).
- `test/pos-reason-codes.e2e-spec.ts`: extended `A2` to assert the
  `void_prefire` purpose still excludes `category: 'waste'` reason codes
  (the route is retained on the contract per the governance entry even
  though the pre-fire UI no longer calls it).

### 2.5 Backend verification run (real Docker Postgres, ephemeral instance — see §4)

| Gate | Result |
|---|---|
| `npx prisma migrate deploy` (incl. the new migration) | PASS — applied cleanly |
| `npm run typecheck` | PASS — clean |
| `npm run test` (unit) | PASS — 1232/1232 |
| `module-boundaries.spec.ts` + `authorization-coverage.spec.ts` | PASS — 55/55 (unchanged) |
| Focused e2e (`sales-lines`, `pos-financial-corrections`, `pos-reason-codes`, `pos-order-cancellation`) | PASS — 116/116 |
| Full e2e (`npm run test:e2e`) | 1838/1848 — **10 failures, all pre-existing** |
| `npm run openapi:generate` | PASS — clean regen |

The 10 full-e2e failures are the **exact same 10 tests, in the exact same 8
suite files** (`catalogue`, `inventory`, `openapi`,
`procurement-supplier-foundation`, `reporting-authorization`, `sales`,
`scheduler-rls`, `tenant-isolation/generated-cross-tenant`) independently
established as pre-existing and unaffected by the immediately-prior
POS-SESSION-RESILIENCE-P1 closure session (rigorous A/B-verified there
against `c710403`'s own parent commit, under this same real-Docker-Postgres
methodology — see
`2026-09-16_POS-SESSION-RESILIENCE-P1_closure-verification_02.md`). None
touch identity, void, reason-codes, or anything this task changed. Total
test count rose from 1843→1848 (+5, exactly the tests added in §2.4), all
new tests passing; failed count is unchanged at 10.

## 3. Frontend

### 3.1 `components/terminal/pos-live.tsx` (`VoidLineDrawer`)

- The `reasons` fetch (`useAsync`) is now gated on `!preFire` — a pre-fire
  line never calls `GET /orders/reason-codes?purpose=void_prefire` (or
  anything else).
- The reason `Select`/`AsyncPanel` (and, as a direct consequence, the
  `"pos.noReasonCodes"` blocker, which only renders inside that panel) now
  render only when `!preFire`.
- `submit()`'s gate changed from `if (!reasonCodeId) return;` to
  `if (!preFire && !reasonCodeId) return;` — pre-fire always proceeds.
- The footer button's `disabled` changed from `!reasonCodeId` to
  `!preFire && !reasonCodeId` — enabled immediately for a pre-fire line.
- `services.sales.mutations.voidLine(...)` is called with no reason
  argument for pre-fire (see §3.2); the post-fire branch
  (`voidLinePostFire`) is byte-unchanged.
- The confirmation `Callout` (pre-fire vs post-fire copy, already existed)
  is unchanged — it is the confirmation surface the task allows to remain.

### 3.2 Service layer

- `lib/console/services/types.ts` — `voidLine`'s `reasonCodeId` parameter
  removed from the interface signature.
- `lib/console/services/http.ts` — `voidLine` wrapper no longer takes
  `reasonCodeId`; calls `api.sales.voidLine(..., {}, ...)` (empty body).
- `lib/api/endpoints.ts` — unchanged; its `body: S.VoidOrderLineDto`
  parameter type-checks against the now-empty `VoidOrderLineDto` with no
  code change needed there.

### 3.3 Generated OpenAPI contract — manual, scoped patch; generator blocked (see §5)

`api/openapi.json`'s `VoidOrderLineDto` schema and `lib/api/schema.ts`'s
`VoidOrderLineDto` interface were both hand-patched to the exact
empty-object shape the backend's own regenerated `docs/api/openapi.json`
now produces (verified byte-for-byte against the backend's diff — see
§2.5). **This is a deliberate, narrow exception to "GENERATED — do not
edit"**, made only because the full generator is blocked by an unrelated,
pre-existing bug (§5) — not a decision to hand-maintain these files going
forward. `git diff` on `api/openapi.json` is exactly one schema, 9 lines
removed / 1 changed, nothing else.

### 3.4 Frontend tests changed (`components/terminal/pos-live.test.tsx`)

- Replaced test 1 ("loads void reasons...") with one asserting a pre-fire
  void **never** calls `salesReasonCodes`/`inventoryReasonCodes` and
  renders neither the reason selector nor the "no reason codes" blocker.
- Replaced test 2 with one asserting the submit button is enabled with no
  reason picked, and `voidLine` is called with exactly 4 arguments
  (businessDay, orderId, lineId, options) — no fabricated reason argument.
- Left the post-fire test ("a postfire line uses the postfire purpose...")
  byte-unchanged — still asserts `void_postfire` purpose, reason
  requirement, and mutation shape exactly as before.
- Moved the "permission-denied reason read" test from the (now
  reason-fetch-free) pre-fire scenario to a post-fire (`state: "fired"`)
  line, where a reason-fetch failure is still a live scenario.
- Left the KDS-isolation test unchanged.

### 3.5 Frontend verification run

| Gate | Result |
|---|---|
| `npx vitest run components/terminal/pos-live.test.tsx` | PASS — 17/17 |
| `npm run test` (full vitest suite) | PASS — 18 files / 191 tests |
| `npm run typecheck` | PASS — clean |
| `npm run build` (production Next.js build) | PASS — 86 routes, no errors |
| `npx eslint` on every touched file | **0 new errors/warnings** — confirmed by diffing against the identical lint run on the unmodified `HEAD` via `git stash`: baseline and post-change both report 6 errors/5 warnings, all at different, pre-existing lines (`pos-live.tsx` setState-in-effect issues unrelated to void, one pre-existing empty-interface violation elsewhere in `schema.ts`, one pre-existing unused-disable in `http.ts`) |

## 4. Verification environment

Ran against a fresh, ephemeral Docker Postgres 16 container
(`ros-verify-pg2` / `ros-verify-pgdata2`, port 5547), created and destroyed
by this session, entirely separate from the project's real persistent dev
database (`ros-postgres` / `backend_ros-pgdata`) — confirmed untouched
before and after (`docker ps -a` shows it still `Exited (0)`, same as the
prior session left it). Real backend `.env` was never read or modified;
connection strings were passed as shell-exported environment variables,
which `dotenv/config`'s non-overriding default respects.

## 5. Blocker found, not fixed (out of scope) — `npm run api:types` operation-name collision

Running the frontend's full generator (`node scripts/generate-api-types.mjs`
against a freshly-copied current backend `openapi.json`) throws:

```
Error: Two operations map to sales.cancel: OrdersController_cancel and ServiceChargePolicyController_cancel
```

Both routes (`POST /orders/{businessDay}/{id}/cancel` and
`DELETE /service-charge-policy/versions/{versionId}`) are tagged `sales`
and both derive the short name `cancel` — a real, pre-existing naming
collision in the generator's tag+method-name scheme, unrelated to this
task (neither controller was touched here; `ServiceChargePolicyController`
dates to `8715474`, well before this task). It was not hit before because
the frontend's checked-in `api/openapi.json`/`schema.ts`/`endpoints.ts`
snapshot has been significantly stale (confirmed: a full regen attempt
produced a 61,000-line diff on `api/openapi.json` alone, 152→183 paths,
107→128 DTOs) — nobody has fully re-synced it since both operations
existed simultaneously in the backend spec. This session **reverted** the
accidental full-snapshot copy and the resulting full `schema.ts` rewrite
(`git checkout -- api/openapi.json lib/api/schema.ts`) rather than either
committing a 61k-line unrelated diff or fixing the collision itself
(touching `ServiceChargePolicyController`/`OrdersController` naming is
outside this task's scope and was not attempted). See §3.3 for the scoped
manual patch used instead.

**This blocks any future FULL regeneration of the frontend's OpenAPI
client until either the collision is resolved (e.g. disambiguating the
generator's naming when two controllers share a tag+method-name) or the
two operations are given non-colliding names on the backend.** Flagged
here as a real, pre-existing gap — not fixed, per scope discipline.

---

PRODUCT DECISION RECORDED: YES

PREFIRE REASON REQUIRED: NO
PREFIRE REASON-CODE REQUEST REMOVED: YES
PREFIRE INVENTORY EFFECT: NONE
PREFIRE AUDIT PRESERVED: YES

POSTFIRE REASON REQUIRED: YES
POSTFIRE DISPOSITION PRESERVED: YES
POSTFIRE INVENTORY SEMANTICS PRESERVED: YES

BACKEND TESTS: PASS — unit 1232/1232, architecture 55/55, focused e2e
116/116, full e2e 1838/1848 (10 pre-existing failures, unrelated — see §2.5)
FRONTEND TESTS: PASS — 18 files / 191 tests
TYPECHECK: PASS (both repos)
BUILD: PASS (frontend production build; backend `nest build` implicit in
`openapi:generate`, also clean)
OPENAPI: BACKEND PASS (clean regen, minimal diff — `VoidOrderLineDto` only,
plus one unrelated pre-existing doc-string catch-up); FRONTEND PARTIAL —
scoped manual patch applied and verified correct, full generator blocked by
a pre-existing, unrelated collision (§5), not fixed

BACKEND FINAL SHA: `c710403a9f72fefde4a22c3b54f2e9fdebc08a6f` (HEAD
unchanged — all changes are uncommitted in the working tree; no commit was
instructed)
FRONTEND FINAL SHA: `ca1c350758f63fb1ae81a79cfd4023d334b4a373` (HEAD
unchanged — same)

DEPLOYED: NO
SAFE TO PUSH: N/A — nothing is committed yet. Once reviewed and committed,
the change is verification-clean on both sides; the one open item (§5) is
a pre-existing generator limitation, not a defect in this change.

BLOCKERS:
1. `npm run api:types` (frontend) cannot run a full regeneration due to a
   pre-existing `sales.cancel` operation-name collision between
   `OrdersController` and `ServiceChargePolicyController` — unrelated to
   this task, not fixed (§5). This task's own OpenAPI contract change was
   applied via a verified, minimal manual patch instead.
2. None on the backend side.
3. Nothing has been committed or pushed — that decision is left to the
   user, per "Do NOT deploy or push yet."

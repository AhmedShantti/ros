# Internal MVP — Current State (Post-Reporting / DayClose Check)

**Report type:** AUDIT / REPORT ONLY. No implementation, no source/test/schema/
migration/governance edits, no OpenAPI regeneration, no commit/push/deploy
were performed in this task.

**Authority statement:** This report is non-authoritative evidence only. The
SRS (`ROS_SRS_v1.0.pdf`) and ratified entries in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority.
Nothing in this report creates, amends, or reinterprets any ratified
decision.

**Date:** 2026-09-01
**HEAD:** `7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c` ("feat: add minimum
operational reporting") — confirmed via `git rev-parse HEAD`; matches the
last known accepted baseline named in the task.
**Branch:** `feat/production-spec`
**Working tree summary:** HEAD is unchanged/clean at the accepted baseline,
but the working tree carries a large **uncommitted** DayClose implementation:
13 modified tracked files and ~17 untracked files (new DayClose source
modules, one new Prisma migration directory, and ten new/queued report
documents under `docs/reports/claude/`, dated 2026-08-26 through 2026-08-31).
Nothing was staged or committed during this task.
**Task identifier:** ROS — INTERNAL MVP CURRENT STATE / POST-REPORTING /
DAYCLOSE CHECK (audit-only, per user instruction).

---

## 1. Baseline

```
HEAD:   7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c
BRANCH: feat/production-spec
LOG:
  7bc5d2c feat: add minimum operational reporting
  38e007b feat: complete KDS operator lifecycle
  121b889 feat: add cash session close
  0f10afe feat: add cash close policy substrate
  1f9ea1f feat: add governance approval runtime
```

`git status --short --untracked-files=all` (relevant subset):

Modified (13): `docs/governance/GOVERNANCE_DECISION_REGISTER.md`,
`docs/reports/claude/INDEX.md`, `prisma/schema.prisma`,
`src/modules/governance/audit/audit.constants.ts`,
`src/modules/module-boundaries.spec.ts`,
`src/modules/sales/contract/index.ts`,
`src/modules/sales/orders/orders.service.ts`,
`src/modules/sales/sales.module.ts`,
`src/modules/treasury/cash-session-close/cash-session-close.service.ts`,
`src/modules/treasury/contract/events.ts`,
`src/modules/treasury/contract/index.ts`,
`src/modules/treasury/treasury.module.ts`,
`src/modules/treasury/treasury.permissions.ts`.

Untracked (new, DayClose-relevant): 10 dated `docs/reports/claude/2026-08-2[6-8]…`
and `2026-08-31_DAYCLOSE-*`/`POST-REPORTING_*` reports;
`prisma/migrations/20260831010000_treasury_day_close/migration.sql`;
`src/modules/sales/contract/day-close-sales-facts.query.ts`;
`src/modules/sales/orders/day-close-sales-facts.query.service.ts`;
`src/modules/treasury/contract/day-close-state.query.ts`;
`src/modules/treasury/day-close/day-close-state.query.service.ts`;
`src/modules/treasury/day-close/day-close.controller.ts`;
`src/modules/treasury/day-close/day-close.dto.ts`;
`src/modules/treasury/day-close/day-close.service.ts`.

**Conclusion:** DayClose implementation HAS started in current source. It is
present only in the uncommitted working tree — HEAD itself is still exactly
the accepted `7bc5d2c` baseline.

---

## 2–3. MVP Happy Path — edge-by-edge (current source, including uncommitted tree)

| # | Edge | Status | Evidence |
|---|---|---|---|
| 1 | PIN / staff auth | COMPLETE | Pre-existing, unchanged this HEAD (accepted baseline; not re-audited in depth per task scope). |
| 2 | Terminal | COMPLETE | Pre-existing, unchanged. |
| 3 | CashSession open | COMPLETE | Pre-existing, unchanged. |
| 4 | Order creation | COMPLETE | Pre-existing; additively extended (see §5 cutover fence). |
| 5 | Priced/taxed lines | COMPLETE | Pre-existing, unchanged. |
| 6 | Fire | COMPLETE | Pre-existing, unchanged. |
| 7 | KDS display | COMPLETE | Pre-existing (accepted `38e007b`), unchanged. |
| 8 | KDS bump / readiness | COMPLETE | Pre-existing (accepted `38e007b`), unchanged. |
| 9 | Payment | COMPLETE | Pre-existing, unchanged. |
| 10 | Order completion | COMPLETE | Pre-existing, unchanged. |
| 11 | Inventory depletion / COGS | COMPLETE | Pre-existing, unchanged. |
| 12 | Receipt | BLOCKED BY GOVERNANCE | CARRIED ITEM P1C-1 (fiscal/receipt exclusion), reaffirmed by P1F-2 (2026-08-25) and left unchanged by RPT-R2 cl.13; zero `Receipt`/document/print-job code anywhere in source. See §6. |
| 13 | CashSession close | COMPLETE | Pre-existing (accepted `121b889`); additively extended in the uncommitted tree to also write `closed_business_day` (DC-R2) in the same transaction — see §5. |
| 14 | Daily Trading Report | COMPLETE | Pre-existing, accepted at this HEAD (`7bc5d2c`). |
| 15 | DayClose | PARTIAL | Substantial, coherent implementation present in the **uncommitted working tree only** — not yet committed, not tested, not accepted. See §5. |
| 16 | Manager can inspect the closed trading day | PARTIAL | Historical `GET .../day-closes/{businessDay}` exists in the uncommitted DayClose controller (DC-R3), gated by `report.view.financial`; depends entirely on edge 15's acceptance status. |

---

## 4. Already-accepted MVP capabilities — drift check

Order/pricing/tax, Fire, KDS, Payment/Completion, Inventory depletion/COGS,
CashSession close, and Minimum Operational Reporting are the accepted,
source-control-closed baseline at `7bc5d2c`. Diffing the uncommitted tree
against that commit for the three touched previously-accepted files:

- `src/modules/sales/orders/orders.service.ts` (+30/−0): purely additive — one
  new constructor-injected `DAY_CLOSE_STATE_QUERY` dependency and one new
  check (`isClosed` → 409 `ConflictException`) inserted **after** the
  existing `ros_order_number` advisory-lock acquisition and **before** the
  `Order` insert. No existing logic path altered.
- `src/modules/treasury/cash-session-close/cash-session-close.service.ts`
  (+58/−11): the −11 lines are pure reformatting (Prettier line-wrapping) of
  pre-existing statements; the substantive addition is one new
  constructor-injected `DAILY_TRADING_SALES_QUERY` dependency used to derive
  `closed_business_day` at the `CLOSED` transition, written once in the same
  transaction that already writes `expected_cash`/`counted_cash`/`variance`.
  No existing behavior altered.
- `src/modules/treasury/treasury.permissions.ts`: purely additive — seeds
  `cash.day.close` (previously deliberately un-seeded, "no executable
  consumer") and adds a `REPORT_VIEW_FINANCIAL` string-literal constant
  mirroring the existing `SETTINGS_BRANCH_MANAGE` precedent. No existing
  permission code changed or removed.

**Conclusion: no drift.** All changes to previously-accepted logic are
additive DayClose wiring, consistent with DC-R1/R2's own text. No regression
evidence found. (`module-boundaries.spec.ts` — 45/45 passing at this working
tree — and the treasury+sales suites — 83/83 passing — corroborate this; see
§9.)

---

## 5. DayClose — current implementation status

**Classification: IMPLEMENTED — NEEDS ACCEPTANCE.**

This is a substantially complete, carefully cross-referenced implementation
against DC-R1/R2/R3 and the four prior design-gate/correction reports, but it
is uncommitted, has zero dedicated tests, and OpenAPI has not been
regenerated.

Evidence for each searched item:

| Item | Found? | Evidence |
|---|---|---|
| migration #35 | YES | `prisma/migrations/20260831010000_treasury_day_close/migration.sql` (429 lines); `module-boundaries.spec.ts` now asserts a migration-directory count of **35** (was 34) — this updated expectation currently **passes** (see §9). |
| `treasury.day_closes` | YES | `model DayClose` at `prisma/schema.prisma:2649`; migration creates `treasury.day_closes`. |
| `day_close_activations` | YES | `model DayCloseActivation` at `schema.prisma:2614`; `UNIQUE(tenant_id, branch_id)` — exactly one immutable row per branch. |
| `day_close_sessions` / snapshot children | YES | `model DayCloseSession` (`schema.prisma:2789`), `model DayCloseTaxClassTotal` (`:2741`), `model DayCloseOrderTypeTotal` (`:2763`). |
| `cash_sessions.closed_business_day` | YES | `schema.prisma:2358` (`DateTime? @db.Date`, nullable — legacy tolerance), written by `cash-session-close.service.ts` at the `CLOSED` transition (see §4). |
| `DAY_CLOSE_STATE_QUERY` | YES | `treasury/contract/day-close-state.query.ts`, implemented by `day-close-state.query.service.ts`; the Order-create/DayClose cutover fence's Treasury side — **consumed by** `orders.service.ts` (Order-create side, §4). |
| `DAY_CLOSE_SALES_FACTS_QUERY` | YES | `sales/contract/day-close-sales-facts.query.ts`, implemented by `sales/orders/day-close-sales-facts.query.service.ts`; wired into `sales.module.ts` as Sales' third published contract query; injected into `DayCloseService`. |
| `cash.day.close` POST | YES | `POST /branches/:branchId/day-closes/:businessDay` in `day-close.controller.ts`, `@RequirePermission(TREASURY_PERMISSIONS.CASH_DAY_CLOSE)`, `@Idempotent()`, `@AllowPosSession()`. |
| historical DayClose/Z GET | YES | `GET /branches/:branchId/day-closes/:businessDay`, same controller, `@RequirePermission(TREASURY_PERMISSIONS.REPORT_VIEW_FINANCIAL)`; returns persisted-only, 404 if no row (DC-R3, "never a retroactively-manufactured Z"). |
| `report.view.financial` on historical GET | YES | Confirmed above; declared as a plain string literal on `TREASURY_PERMISSIONS`, per DC-R3's "no new permission code" clause. |
| ACTIVATED outcome | YES | `DayCloseService.attempt()`: first POST per branch creates `dayCloseActivation`, commits, returns `outcome: 'ACTIVATED'`, never throws. |
| CLOSED outcome | YES | Same method, once `activationBusinessDay < target < currentBusinessDay`: full Z snapshot persisted, returns `outcome: 'CLOSED'`. |
| Idempotency-Key | YES (framework-level) | `@Idempotent()` decorator on the POST route (`common/idempotency/idempotent.decorator.ts`); `@ApiHeader({ name: 'idempotency-key', required: true, ... })` documents the contract. Not a DayClose-specific reimplementation — reuses the existing repo-wide idempotency mechanism, consistent with other write routes. |
| FR-FIN-021 global session blocker | YES | Step 6 of `attempt()`: blocks close if **any** `cashSession` at the branch has `status <> 'closed'`, unqualified by business day — matches the register's "IN FULL" language verbatim. |
| open-order blocker | YES | Step 5: `sales.openOrderIds.length > 0` → 409 with `blockingOrderIds`. |
| `ros_order_number` shared fence | YES | `FENCE_KEY = 'ros_order_number'`; `pg_advisory_xact_lock(hashtext($1), hashtext($2))` on `(branchId, businessDay)` — the exact primitive `allocateOrderNumber` already uses; confirmed also consumed from the Order-create side (§4). |
| `zNumber` | YES | `MAX(z_number)+1` computed inside the transaction; `UNIQUE(tenant,branch,z_number)` structural backstop; P2002 on either constraint triggers one bounded local retry (`MAX_ATTEMPTS = 5`) from a fresh transaction. |
| `DAY_CLOSE_ACTIVATED` audit | YES | `AUDIT_ACTION.DAY_CLOSE_ACTIVATED` (new, `audit.constants.ts`), recorded on the activation path. |
| `DAY_CLOSED` audit | YES | `AUDIT_ACTION.DAY_CLOSED` (new), recorded on the close path. |
| `day.closed` event | YES | `DAY_CLOSED_EVENT_TYPE = 'day.closed'` in `treasury/contract/events.ts` (new); published via `ctx.publishEvent` inside the same UnitOfWork, before commit; payload documented as matching SRS §5.5.4's event catalogue (publisher Treasury, subscribers Analytics/Fiscal/Reporting — those subscribers are not implemented, which is expected/out of scope). |
| DayClose tests | **NOT FOUND** | No `*.spec.ts` file anywhere under `src/modules/treasury/day-close/` or referencing `DayCloseService`/`DayCloseController`. Zero dedicated unit or integration test coverage for this ~975-line service and its controller. |
| DayClose OpenAPI | **NOT FOUND** | `grep -c "day-close\|DayClose\|day_close"` against `docs/api/openapi.yaml` and `docs/api/openapi.json` returns 0 in both. OpenAPI has not been regenerated (consistent with the task's explicit "DO NOT REGENERATE OPENAPI" instruction — this is reported as a gap, not treated as an error). |

**Additional verification performed (read-only, non-destructive):**
- `npx tsc --noEmit` — clean except one **pre-existing, unrelated** error in
  `src/modules/identity/auth/access-token.service.spec.ts:28` (a JWT-library
  type mismatch, present in a file untouched by this changeset). DayClose
  code itself compiles cleanly.
- `npx prisma validate` — schema is valid.
- `npx jest src/modules/module-boundaries.spec.ts` — **45/45 passing**,
  including the updated migration-count assertion (34→35).
- `npx jest src/modules/treasury src/modules/sales` — **83/83 passing**, no
  regressions in the modules DayClose touches.
- Whether the migration has been **applied to any database** cannot be
  verified from source alone; no evidence either way was found in-tree
  (no scratch-DB report for this specific migration exists yet, unlike prior
  accepted slices' reports).

**What remains for DayClose (PARTIAL → FINAL ACCEPTED):**
1. Dedicated unit/integration/e2e test coverage (currently zero) — the
   pattern established by every prior accepted Treasury/Sales slice (e.g.
   cash-session-close, KDS) is unit + e2e coverage before acceptance.
2. Migration verified applied cleanly to a scratch/dev database from zero,
   alongside the existing 34.
3. OpenAPI regeneration (explicitly out of scope for this audit task, but a
   real remaining step before acceptance).
4. Formal implementation-acceptance report and user ratification of the
   implementation itself (distinct from the already-ratified DC-R1/R2/R3
   design decisions) — no such acceptance report exists yet among the
   working-tree's ten new/queued report documents, which are design-gate and
   correction reports, not an acceptance report.
5. Staging/commit (explicitly not authorized in this audit task).

Nothing in the implementation itself contradicts DC-R1/R2/R3 or the four
prior correction reports; the code's own docblocks cite them section-by-
section and the logic matches. The `SCOPE_BLOCK` constant in
`day-close.service.ts` honestly declares FR-FIN-022/025/026's remaining
NOT-IMPLEMENTED/PARTIAL limbs in every response, consistent with DC-R1.

---

## 6. Receipt — MVP blocker status

**Status: BLOCKED BY P1C-1.**

- `grep -rn -i "receipt"` across `src/modules/sales` and
  `src/modules/treasury` returns no implementation — the one hit
  (`treasury.dto.ts:103`) is an unrelated doc comment ("server receipt
  time").
- CARRIED ITEM P1C-1 ("Fiscal remains otherwise out of scope: no tax
  documents, invoice templates, fiscal submissions...") is reaffirmed
  verbatim by P1F-2 (2026-08-25) and left explicitly unchanged by RPT-R2
  clause 13, per the register.
- The most recent prior report (`2026-08-31_POST-REPORTING_MVP-rebase-and-
  next-slice.md`, §11) records: Receipt is still blocked by the ratified
  fiscal exclusion; **whether the Internal MVP requires a non-fiscal receipt
  despite that exclusion is explicitly recorded as UNRESOLVED** — an open
  user decision, not something this or any prior report has answered or
  implemented around. DayClose does not depend on Receipt (§6.M/§6.N of that
  report, re-confirmed by this audit: DayClose's Z number is structurally
  unrelated to any invoice/fiscal sequence).
- **Does the current Internal-MVP exit require resolving it?** Per the task's
  own MVP definition ("receipt as required by the accepted MVP/governance
  posture"), this is exactly the open question — the governing posture is
  that Receipt is a **parallel, currently unresolved** item; it has not been
  affirmatively declared either in-scope or out-of-scope for Internal-MVP
  exit specifically (only out of scope for the *fiscal/Country-Pack* sense).
  This audit does not resolve it; it is reported as open.

---

## 7. Branch authorization — MVP blocker status

**Status: D-2 RATIFIED (2026-08-17, option (a)) — CORE ONLY; broader
branch-scoped RBAC remains an explicit, unreopened deferral. Not a hard
blocker for Internal-MVP exit.**

- D-2 in the register ("PIN / Branch-Scoped RBAC Scope") is RATIFIED, not
  open/pending. Its ratified content: the synchronous PIN half of
  `FR-SEC-032` is core/in-scope; **broader branch-scoped RBAC
  (`FR-SEC-002`/`003`/`004`) is explicitly deferred** — `permission
  resolution is not made branch-aware`. This deferral is reaffirmed unchanged
  by essentially every later register entry that touches it (dozens of
  citations through 2026-08-31).
- Current source implements a **tenant-shape, single-active-branch
  carve-out**, not branch-aware RBAC — confirmed directly in
  `day-close.service.ts`'s own docblock and code (`attempt()`, steps
  preceding the fence lock): it queries `operativeBranches` (a tenant-shape
  fact from `org.branches.status`, via
  `organisation/contract/branch-reporting-scope.query.ts`), and fails closed
  (403) unless the tenant has **exactly one** active branch and the
  requested `branchId` matches it. The query service's own docblock states
  explicitly: *"This is NOT branch-aware RBAC and does NOT reopen D-2... it
  never consults `identity.membership_roles.branch_id`."* This is the same
  pattern already accepted for the Minimum Operational Reporting slice
  (`7bc5d2c`), reused verbatim for DayClose.
- **Posture:** D-2's branch-scoped RBAC deferral is a **production/
  multi-branch readiness gap**, not an Internal-MVP blocker — the
  Internal-MVP definition itself specifies "one operational branch," which
  the single-active-branch carve-out safely satisfies. It only becomes a
  blocker if/when the product moves to genuine multi-branch operation.

---

## 8–9. Other MVP gaps / current blocker table

| Capability | Status | Hard MVP blocker? | Why |
|---|---|---|---|
| Reporting (Minimum Operational Reporting) | COMPLETE | No | Accepted at `7bc5d2c`; unchanged. |
| DayClose | PARTIAL (implemented, uncommitted, untested) | **YES** | Only missing executable edge in the MVP happy path with no non-DayClose workaround (Receipt is the other, and is a separately-unresolved open question, not "missing implementation"). |
| Receipt | BLOCKED BY P1C-1 | **Open/unresolved** — treated as a parallel blocker pending an explicit user decision on whether Internal-MVP exit requires it | Fiscal exclusion is ratified; whether an MVP-scoped non-fiscal receipt is required is not yet decided by any ratified entry. |
| Branch authorization (D-2) | RATIFIED — core-only, single-branch carve-out in place | No (for Internal-MVP) | Deferred broader RBAC is a production/multi-branch gap only; current carve-out is safe and already used successfully by Reporting and now DayClose. |
| Post-fire void | Present (pre-existing) | No | `voided` is an existing `OrderState`/line-state value (`order-state.ts`), part of the already-accepted order lifecycle; not new, not modified by this task's diffs. |
| Served/Expediter | Served present; Expediter deferred | No | `served` exists in the accepted KDS lifecycle (`38e007b`). A dedicated Expediter role/permission (FR-KDS-013 `[S]`, Should-have) is explicitly named as future scope by KDS-R11 and not implemented — non-blocking, Should-have only. |
| Automatic DayClose | NOT IMPLEMENTED | No | `day-close.service.ts`'s own `SCOPE_BLOCK` records "FR-FIN-025: automatic close (no scheduler)" as not implemented; `[S]` Should-have — manual DayClose (the implemented path) suffices for Internal-MVP. |
| Exports (CSV/PDF) | Present in Reporting module | No | Predates this task; part of the accepted Minimum Operational Reporting baseline, not re-audited in depth (out of DayClose scope). |
| Read replica / rollups / multi-branch consolidation | NOT IMPLEMENTED | No | Not required by the single-tenant/single-branch Internal-MVP definition. |
| Offline | NOT IMPLEMENTED | No | Internal-MVP definition is explicitly "online"; only hit was an unrelated doc comment about FR-POS-002's offline-*generated order code format*, not offline operation. |
| Tax-by-rate reporting | NOT IMPLEMENTED (component sum only) | No | Explicitly accepted as PARTIAL/out-of-scope by DC-R1 itself ("`FR-FIN-022` [M] remains PARTIAL... tax by rate... NOT IMPLEMENTED") — a known, governance-accepted gap, not a newly discovered one. |
| FR-FIN-026 full integrations (fiscal finalisation, inventory day-end snapshot, report pre-aggregation, accounting export) | NOT IMPLEMENTED | No | Explicitly and repeatedly declared PARTIAL/out-of-scope by DC-R1; requires an outbox (`FR-PLT-041`) that does not exist in this repository — a known, accepted, larger deferral. |

**CURRENT HARD INTERNAL-MVP BLOCKERS: 1**
- **DayClose acceptance** (implemented but uncommitted, zero test coverage,
  OpenAPI not regenerated, not yet formally accepted/ratified as an
  implementation).

Receipt is tracked separately as an **open, unresolved MVP-scope question**
rather than a counted hard blocker, because no ratified entry currently
states that Internal-MVP exit requires it — but it cannot be waved off
either, since the task's own MVP definition names "receipt as required by
the accepted MVP/governance posture" and that posture has not yet been
pinned down. This audit surfaces it as the one open decision standing
between "DayClose accepted" and "Internal-MVP exit ready to declare,"
without resolving it.

---

## 10. MVP progress (non-authoritative views)

**A. 33-capability matrix style** (informal; not an SRS requirement count):
Of capabilities spot-checked in this audit (happy-path edges + the six
listed in §9, deduplicated):
- COMPLETE: 12 (PIN/auth, terminal, cash-session open, order, pricing/tax,
  fire, KDS display, KDS bump, payment, completion, inventory/COGS, reporting)
- PARTIAL: 2 (DayClose implementation-pending-acceptance; manager historical
  inspection, which depends on it)
- BLOCKED: 1 (Receipt)
- NOT IMPLEMENTED (accepted/non-blocking deferrals): remainder (automatic
  close, tax-by-rate, offline, multi-branch consolidation, full FR-FIN-026,
  Expediter) — all `[S]`/deferred-by-governance, none MVP-required.

**B. Core Internal-MVP capability view:** 14 of 16 happy-path capability
edges (§2–3) are COMPLETE. DayClose (edge 15) is implemented but not yet
accepted; manager historical inspection (edge 16) depends on it. **14/16
core edges complete; the sole remaining hard gate to full completion is
DayClose acceptance** (test coverage + commit + formal acceptance), with
Receipt's MVP-scope status as the one open decision alongside it.

**What actually prevents MVP exit:** not missing implementation of DayClose
— that exists and appears carefully done — but the **absence of test
coverage, a commit, and a formal acceptance/ratification pass** for it, plus
an outstanding **decision** (not implementation) on whether Receipt is
required for Internal-MVP exit specifically.

---

## 11. Next action

**Selected: C. RUN DAYCLOSE ACCEPTANCE**

Rationale, from current source only: DayClose is not "not started" (A) or
"needs continued implementation" (B) — the implementation is functionally
complete and internally consistent with all three ratified decisions and the
four correction reports; nothing found in this audit indicates unfinished
core logic. What is missing is verification/acceptance activity: writing and
running the (currently absent) test suite for `day-close.service.ts` /
`day-close.controller.ts`, applying the migration to a scratch database
end-to-end alongside the existing 34, and producing a formal implementation-
acceptance report — i.e., an acceptance pass, not further design or further
coding. Receipt (D) and D-2 (E) are not selected: D-2 is already ratified and
non-blocking for Internal-MVP; Receipt is a separate open decision that does
not block starting DayClose acceptance and is not itself an implementation
task.

---

## 12. Note on report provenance

This report's evidence was gathered directly from the current working tree
via `Read`/`Grep`/`git diff`/`git status`, plus read-only verification
(`tsc --noEmit`, `prisma validate`, targeted `jest` runs) — no source, test,
schema, migration, or governance file was modified, and nothing was staged
or committed.

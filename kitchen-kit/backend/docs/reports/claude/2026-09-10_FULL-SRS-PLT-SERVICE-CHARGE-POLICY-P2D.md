# FULL-SRS-PLT-SERVICE-CHARGE-POLICY-P2D — ServiceChargePolicy Configuration Substrate Implementation

**Report type:** Implementation report (evidence, not governance).
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority.
This report implements, and is bound by, the already-RATIFIED `P2D-R1`
entry (`GOVERNANCE_DECISION_REGISTER.md`, "P2D-R1 — ServiceChargePolicy
Configuration/Version Semantics Ratification — RATIFIED 2026-09-10") and the
unreopened `P2A-R1` clauses it implements-in-detail (clauses 3, 7-16). This
report decides nothing new; any apparent design choice below not already
fixed by `P2D-R1`/`P2A-R1` is an implementation detail, not a governance
act.
**Date:** 2026-09-10
**HEAD at task start:** `19e5746` (tip of `full-srs/lane-d4-reporting-demo`
at the start of this task; this is the P2C1-implementation commit +
hash-recording follow-up from the immediately prior task in this session).
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree at task start:** clean except pre-existing untracked report
files from earlier tasks in this session (not part of this task's diff).
**Task identifier:** `FULL-SRS-PLT-SERVICE-CHARGE-POLICY-P2D`

---

## 1. Mission recap

Implement the COMPLETE `ServiceChargePolicy` **configuration** substrate
ratified in `P2D-R1`: immutable, effective-dated policy versions; a
complete typed rule-set per version; tenant→brand→branch hierarchy with
lock semantics; anti-backdating; future-only cancellation; tenant RLS;
audit; an admin read/write surface; a point-in-time resolver; `Order`
pinning at `Order.openedAt`; deterministic historical reconstruction.

**Explicit scope fence (P2D-R1 clause 9), respected throughout:** no rule
matching/evaluation, no `serviceChargeTotal` computation, no
`CountryPack.serviceChargeTaxable` application, no tax-on-service-charge,
no tips/tip pooling, no discount interaction, no receipt/fiscal changes, no
computed-service-charge event-payload changes, no P2E, no frontend, no
placeholder calculation. P2D-era orders remain zero service charge.
`FR-PLT-028` remains PARTIAL — not marked COMPLETE.

---

## 2. Governance basis

- **Controlling decision:** `P2D-R1` (ratified 2026-09-10, unnumbered
  entry — no new `D-` number, 20-decision tally unchanged: 17 RATIFIED · 1
  IN PART · 1 BLOCKED · 1 OPEN).
- **Controlling design report:** `2026-09-10_FULL-SRS-PLT-SERVICE-CHARGE-
  CONFIG-SHAPE-AND-LOCK-COHERENCE-P2C2.md` §2-§5/§8.
- **Non-reopened parent:** `P2A-R1` clauses 3, 7-16 (Sales ownership,
  effective-dating, immutability, anti-backdating, future-only
  cancellation, tenant→brand→branch precedence/lock-walk) — carried
  forward verbatim, not redecided here.
- This implementation task **ratifies nothing new**. Every structural
  choice below traces to one of `P2D-R1`'s twelve clauses; see §4-§14 for
  the clause-by-clause mapping.

---

## 3. Data model

`prisma/schema.prisma`:

- `enum ServiceChargePolicyLevel { tenant brand branch }` — closed,
  three-value, `@@schema("sales")`. Deliberately NOT the broader generic
  `platform."SettingLevel"` (P2D-R1 clause 2: no `platform`/
  `country_pack`/`terminal` level exists for this table).
- `model ServiceChargePolicy` — `id`, `tenantId`, `level`, `targetId` (no
  FK — its meaning depends on `level`, validated at the application layer
  via `organisation/contract`, same pattern as
  `platform.setting_values.target_id`), `rules Json` (one immutable typed
  array, NOT a child table — P2D-R1 clause 3/4), `locked Boolean @default
  (false)`, `effectiveFrom`/`createdAt` both `@default(dbgenerated
  ("statement_timestamp()"))`, `createdBy`. `@@unique([tenantId, id])`
  (composite-FK target for `Order`'s pin), `@@unique([tenantId, level,
  targetId, effectiveFrom], map: "uq_scp_scope_effective_from")`,
  `@@index(..., map: "service_charge_policies_resolve_idx")`.
- `Order.serviceChargePolicyVersionId String?` + relation
  `serviceChargePolicyVersion ServiceChargePolicy?` (see §11).
- `Tenant.serviceChargePolicies` / `User.serviceChargePoliciesCreated` back
  -relations.

`npx prisma validate`: **valid**. `npx prisma generate`: clean, run
repeatedly through the session with no errors.

---

## 4. Migration

`prisma/migrations/20260910010000_sales_service_charge_policies/
migration.sql` (151 lines, hand-authored per this repository's convention
— not `prisma migrate dev`). Creates `sales."ServiceChargePolicyLevel"`,
`sales.service_charge_policies` (PK, `ck_scp_rules_is_array`
`jsonb_typeof` backstop CHECK, `ck_scp_no_backdating` CHECK), the two
unique indexes and the resolve index described in §3, tenant/created_by
FKs, then adds `sales.orders.service_charge_policy_version_id` with its
tenant-leading composite FK. Applied cleanly across every e2e run this
session (46 total migrations, zero errors, including the fresh-database
bootstrap path).

---

## 5. RLS

`ENABLE`+`FORCE ROW LEVEL SECURITY` on `service_charge_policies`. Three
policies, all fail-closed via `tenant_id = NULLIF(current_setting
('app.tenant_id', true), '')::uuid`:

- `SELECT` — plain tenant predicate.
- `INSERT` — plain tenant predicate (`WITH CHECK`).
- `DELETE` — tenant predicate **AND** `effective_from >
  statement_timestamp()` — the future-only-cancellation enforcement lives
  at the database boundary, not merely in application logic (P2A-R1 clause
  11; extends the `recipe_versions`/`status = 'draft'` status-predicated
  DELETE-policy precedent to an instant predicate).
- No `UPDATE` policy — matches the total absence of an `UPDATE` grant
  (§6): versions are immutable facts once created; a not-yet-effective
  version is cancelled (deleted), never edited.

---

## 6. Privileges

- `GRANT SELECT` — table-level.
- `GRANT INSERT (id, tenant_id, level, target_id, rules, locked,
  effective_from, created_by)` — **column-scoped, excludes `created_at`**,
  so `ros_app` cannot forge the creation instant and defeat the
  anti-backdating CHECK (the `cash_close_policies` precedent, applied
  verbatim).
- `GRANT DELETE` — table-level (narrowed by the RLS instant predicate
  above).
- `REVOKE UPDATE, TRUNCATE FROM ros_app` — explicit, matching the "no
  UPDATE grant, ever" P2A-R1 clause 11 requirement.

---

## 7. Anti-backdating

`effective_from >= created_at` CHECK, both columns `DEFAULT
statement_timestamp()` (evaluated once per statement, so an "effective
immediately" INSERT that omits `effectiveFrom` satisfies the CHECK by
equality using DATABASE time only, never the application process's
clock), plus the column-scoped INSERT grant excluding `created_at` — the
three-part pattern verified end-to-end by e2e Cases D/E/F/G (a past
`effectiveFrom` rejected with 400 at the application layer before ever
reaching the DB write, and a raw-privilege probe confirming `created_at`
truly cannot be supplied through the granted INSERT column set even if the
application check were bypassed).

---

## 8. Future-delete enforcement

Enforced at TWO independent layers, both proven by e2e: (1) `Service
ChargePolicyService.cancel` reads the target row and rejects (409) a
version whose `effectiveFrom` is not still in the future — the ordinary,
expected path; (2) the RLS `DELETE` policy's `effective_from >
statement_timestamp()` predicate is the actual, un-bypassable database-
level backstop, re-evaluated fresh at DELETE-execution time so a version
that became effective between an application-layer check and the DELETE
statement can never be removed by any race.

---

## 9. Rule schema and validation

`service-charge-policy-rules.ts`. `ServiceChargePolicyRule = { orderType:
OrderType | null; minGuestCount: number | null; ratePercent: string }`.
`parseServiceChargePolicyRules(raw)` validates the WHOLE array or throws
`ServiceChargePolicyRuleValidationError` — no partial/best-effort result.

- `orderType` — validated against the real, generated Prisma `OrderType`
  enum (closed vocabulary — not an arbitrary string), or `null` (all
  types).
- `minGuestCount` — non-negative integer, or `null` (no condition).
- `ratePercent` — `parseExactDecimal` (ADR-008 discipline, the SAME
  function `country-pack.parser.ts`'s `asRatePercent` uses): a JSON
  `number` is rejected outright (binary-float cannot represent every
  rate exactly), exponent notation rejected, negative rejected, no upper
  bound invented (none exists in SRS/precedent).

20 unit tests in `service-charge-policy-rules.spec.ts`, all passing —
covering acceptance, every rejection path, and whole-or-nothing
multi-rule validation.

---

## 10. Empty-rules semantics

`rules: []` is explicitly VALID and preserved exactly — "no service charge
configured at this level" (P2D-R1 clause 3). It is never coerced into "no
rules supplied," never rejected as empty, and — critically — an empty-
rules version still WINS the precedence walk and still LOCKS if `locked:
true` is set on it, exactly like any non-empty version. Proven by unit
test #9 in `service-charge-policy.resolver.spec.ts` ("an empty rules []
version is a CONFIGURED winner, never treated as inheritance").

---

## 11. Target validation

`ServiceChargePolicyService.validateTarget` resolves the supplied
`brandId`/`branchId` against the existing, published Organisation contract
query `BRANCH_BRAND_QUERY.findBranchAuthorizationFacts` (no private
cross-module import, no new Organisation-owned query invented) to confirm
the target actually exists and belongs to the caller's tenant before any
write, and (for branch-level writes) to derive the branch's owning brand
for the imperative per-level authorization check in §16.

---

## 12. Organisation contracts used or added

Used, unmodified: `organisation/contract`'s `BRANCH_BRAND_QUERY`/
`BranchBrandQuery` (target validation + hierarchy-context derivation, §11)
and the built-in `branchFromQueryOrTenant('branchId')` static-gate
primitive (resolve route's coarse authorization target, §15). No new
Organisation-owned contract query was added — none was needed. `identity/
contract`'s `ScopeAuthorizationPort`/`ScopeTargetResolver`/
`AuthorizationTarget` and `governance/contract`'s `AuditService`/
`AUDIT_ACTION`/`AUDIT_ENTITY` are also consumed, unmodified.

---

## 13. Resolver

`service-charge-policy.resolver.ts`. Two-part design, deliberately
separated for testability (P2D-R1 clause 2's precedence/lock walk needs no
database to prove correct):

- **`computeWinningVersion(entries)`** — a PURE function taking three
  `{level, eligible, targetId, version}` entries (tenant/brand/branch, in
  that fixed array order) and returning the winning version or `null`.
  Walks high-to-low, skips ineligible levels (e.g. no `brandId` supplied),
  and stops at the first level carrying ANY version — locked or not —
  since a version's mere presence at a higher level already outranks
  every lower level regardless of its own lock flag; `locked` only matters
  for whether a LOWER level's own version could otherwise have overridden
  it, which the walk's stop-on-first-hit already guarantees. 10 unit tests
  in `service-charge-policy.resolver.spec.ts`, all passing, with zero
  database.
- **`ServiceChargePolicyResolver.resolve(tx, input)`** — the DB-backed
  half: for each eligible level, `fetchLevel`/`selectLatest` issue a raw
  `$queryRaw` (`ORDER BY effective_from DESC LIMIT 1 WHERE effective_from
  <= at`), builds the three entries, and delegates to
  `computeWinningVersion`. Proven against a real database by e2e §10
  (DB-backed precedence, historical stability, cross-tenant rejection —
  the twelve-item resolver test list's database-dependent half).

---

## 14. Precedence and lock semantics

`tenant → brand → branch` only (P2D-R1 clause 2), matching `P2A-R1` clause
7/9 exactly — no `platform`/`country_pack`/`terminal` level. A version's
presence at any level stops the walk (lock or no lock); an ineligible
level (no `brandId`/`branchId` supplied for that request) never
contributes. All twelve resolver-scenario items from the task's own
requirement list are covered: 2 (no policy anywhere ⇒ null), 3-5 (single-
/multi-level winner), 6-8 (lock at each level), 9 (empty-rules is a real
winner), and the DB-backed items (no policy in DB, future invisibility,
historical-resolve stability, cross-tenant rejection) in e2e.

---

## 15. Historical reconstruction

Every resolve call takes an explicit `at` instant and queries only
versions with `effectiveFrom <= at` — so resolving at a past instant after
a later version has since been added still returns the SAME version it
would have returned at that instant originally (deterministic, proven by
e2e §11 "a fixed historical instant keeps resolving to the SAME version
after a later version is added"). The `at` instant is captured by the
TEST PROCESS itself (`new Date()`), never reconstructed from a version's
own JSON-round-tripped `effectiveFrom` string, to avoid a millisecond-
truncation vs. the database's microsecond-precision stored value.

---

## 16. Order pinning field and governing instant

`Order.serviceChargePolicyVersionId` (nullable, tenant-leading composite
FK, `ON DELETE RESTRICT`) — P2D-R1 clause 8, implemented exactly as
specified. Governing instant is `Order.openedAt` — the SAME server-clock
instant already used to pin `Order.countryPackVersion` (P2D-R1 clause 7).
`OrdersService.create` resolves `branchFacts` via `BRANCH_BRAND_QUERY`,
calls `ServiceChargePolicyResolver.resolve(tx, {tenantId, brandId:
branchFacts?.brandId ?? null, branchId, at})` immediately after country-
pack resolution, and writes `serviceChargePolicyVersionId:
breakdown.winner?.id ?? null` into the same `tx.order.create` call —
same-transaction pinning, `NULL` when nothing is configured, never a
fabricated default. Order-pinning is proven end-to-end by e2e §12 (Cases
B-G): a version created before Order-open governs it; one created after
Order-open does not retroactively apply; `NULL` when nothing is
configured anywhere in scope; and a later version does not change an
already-pinned historical Order's `serviceChargePolicyVersionId`.

**P2D-era orders remain zero service charge** — `Order.serviceChargeTotal`
(pre-existing column) is untouched by this change; pinning the winning
CONFIGURATION version never computes or applies a non-zero amount.

---

## 17. Admin surface

`service-charge-policy.controller.ts` — six routes, all tagged `sales`
(never `pos`):

- **Create:** `POST /service-charge-policy/tenant`,
  `.../brand/:brandId`, `.../branch/:branchId` — `@RequirePermission
  (TENANT_MANAGE)` (tenant/brand routes) / `@RequirePermission
  (BRANCH_MANAGE)` (branch route), `@Idempotent()`, body =
  `CreateServiceChargePolicyDto {rules: unknown; locked?: boolean;
  effectiveFrom?: string}`.
- **Read:** `GET /service-charge-policy/resolve?brandId&branchId` (current
  effective version for a hierarchy context, `null` if nothing configured
  — authorization target is the built-in `branchFromQueryOrTenant
  ('branchId')` primitive, no custom resolver needed for this narrow
  admin read) and `GET /service-charge-policy/versions?level&targetId`
  (every version for ONE exact scope, newest first, including future-
  scheduled ones `resolve` cannot show — for admin auditability).
- **Cancel:** `DELETE /service-charge-policy/versions/:versionId` — the
  route-level `@RequireAnyPermission(TENANT_MANAGE, BRANCH_MANAGE)` gate
  is intentionally COARSE; the PRECISE, scope-correct decision (a branch-
  only manager may cancel only a branch-level version at their own
  branch, never a tenant/brand-level version) happens imperatively inside
  `ServiceChargePolicyService.cancel` via `ScopeAuthorizationPort.
  assertAuthorized`, after the row's own `level`/`targetId` is known from
  the DB — a dedicated `ServiceChargePolicyTargetResolver`
  (`ScopeTargetResolver` implementation reading the row by `versionId`)
  supplies the real `TargetScope` for that check. This two-layer design
  was a deliberate self-correction during this task: a purely static
  `tenantTarget` gate would have wrongly rejected a legitimate branch-only
  manager cancelling their own branch's version.

All six routes reuse `ORGANISATION_PERMISSIONS.TENANT_MANAGE`/
`BRANCH_MANAGE`/`TENANT_READ`/`BRANCH_READ` — **no new permission code was
minted**, per P2D-R1 clause 11.

---

## 18. Permissions

Confirmed by direct source inspection: every route and every imperative
`assertAuthorized` call in `service-charge-policy.controller.ts`/
`.service.ts` uses only `ORGANISATION_PERMISSIONS.{TENANT,BRANCH}_
{MANAGE,READ}` — zero new permission constants, zero new permission-def
rows.

---

## 19. Audit

`AUDIT_ACTION.SERVICE_CHARGE_POLICY_VERSION_CREATED` /
`_CANCELLED` (P2D-R1 clause 10, literal names). `AUDIT_ENTITY.
SERVICE_CHARGE_POLICY = 'service_charge_policy'` (new entity constant).
`ServiceChargePolicyService.create`/`.cancel` each write exactly one
audit event inside the SAME transaction as the create/cancel write — never
a separate, unguarded post-commit call — matching the existing
`AuditService` transactional-write convention used throughout the
codebase (e.g. `CashClosePolicyService`).

---

## 20. Test coverage

**Unit** — `service-charge-policy-rules.spec.ts` (20 tests, pure rule
validation) + `service-charge-policy.resolver.spec.ts` (10 tests, pure
`computeWinningVersion` precedence/lock walk, zero database). Both new
this task, both 100% passing, both explicitly documented as covering the
DB-INDEPENDENT half of the resolver/rule-validation test matrix (see each
file's own docblock cross-referencing the e2e file for the DB-dependent
half).

**e2e** — `test/service-charge-policy.e2e-spec.ts` (959 lines, new): DB
boundary/RLS/privileges (Cases A-F: cross-tenant isolation, RLS SELECT/
INSERT/DELETE enforcement, the `created_at` column-grant exclusion probe,
future-only DELETE), resolver precedence via the real admin surface (DB-
backed items 1, 9-12 from the task's twelve-item list), rule validation
through the HTTP layer, admin create/read/cancel (permission-boundary
cases for tenant/brand/branch-scoped actors, including the branch-only-
manager cancel case that drove the target-resolver design in §17),
historical-resolve stability, and Order pinning (Cases B-G). **25/25
passing.**

**Targeted regression** (per task's explicit "no full E2E suite"
instruction):
- `sales.e2e-spec.ts` / `sales-lines.e2e-spec.ts` / `sales-fire.e2e-spec.ts`
  / `platform-settings.e2e-spec.ts` (Orders creation, Sales order flow,
  cash-rounding payment regression, Country Pack/tax regression) — **149/
  150 passing**. The one failure
  (`sales.e2e-spec.ts`, a hardcoded `/orders` route-list assertion missing
  `/orders/reason-codes`) is **pre-existing and unrelated to this task** —
  confirmed by `git diff` showing **zero changes to `orders.controller.ts`**
  from this task, and by `git log` showing the `/orders/reason-codes` route
  was added in an earlier, unrelated commit (`0952fc1`, "feat(sales): add
  narrow POS-safe reason-code read...") whose test assertion was never
  updated. Not fixed in this task — out of scope, and fixing an unrelated
  pre-existing test would violate this task's own scope fence.
- `src/modules/module-boundaries.spec.ts` + `src/modules/authorization-
  coverage.spec.ts` — **55/55 passing, zero new `KNOWN_DEVIATIONS`.**
- Full local unit suite (all 88 suites, including the two new files above
  and the corrected `receipt.views.spec.ts` fixture) — **1212/1212
  passing.**

---

## 21. Module graph

New module: `src/modules/sales/service-charge-policy/` — Sales-owned, no
new cross-module dependency beyond the existing published contracts in
§12. Registered in `sales.module.ts` (controller + resolver + service +
target-resolver provider, DI token bound). `orders.service.ts` imports
`ServiceChargePolicyResolver` (constructor-injected) and
`BRANCH_BRAND_QUERY` (already imported for country-pack resolution
elsewhere in the same file's neighborhood — no new module import edge
beyond one new provider class). `module-boundaries.spec.ts`'s import scan
confirms no `contract/`-boundary violation was introduced.

---

## 22. Known deviations

**Zero new `KNOWN_DEVIATIONS` entries added.** `authorization-coverage.
spec.ts` passes with no new allowlist entries required — every new route
is covered by a `@RequirePermission`/`@RequireAnyPermission` declarative
gate.

---

## 23. Requirement reassessment

Independently reassessed against current source (this task, 2026-09-10),
not carried forward from any prior report's snapshot:

- **FR-PLT-025** (hierarchical settings resolver) — **COMPLETE**,
  unchanged. `ServiceChargePolicy` is explicitly NOT part of this generic
  hierarchy (P2A-R1 clause 3 / P2D-R1 clause 2 — a separate, Sales-owned,
  three-level precedence walk) — its existence does not extend or narrow
  FR-PLT-025's own scope.
- **FR-PLT-026** (Country Pack lock enforcement) — **COMPLETE**,
  unchanged — this task touches no generic `SettingValue`/lock code path.
- **FR-PLT-027** (settings inspector) — **COMPLETE** for its own generic
  scope, unchanged. P2D-R1 clause 12 explicitly does NOT require
  `ServiceChargePolicy` to integrate with the generic inspector; the
  narrow `GET /service-charge-policy/resolve` + `.../versions` read
  surface built here is domain-owned and sufficient per that clause.
- **FR-PLT-028** ("historical transactions SHALL be interpreted using the
  settings/rates effective at the time of the transaction") — **remains
  PARTIAL. Not marked COMPLETE.** Tax and cash-rounding sub-clauses stay
  COMPLETE (unaffected by this task). The service-charge sub-clause now
  has a COMPLETE, versioned, immutable, correctly-pinned CONFIGURATION
  substrate — but per P2D-R1 clause 9's own explicit text, "a versioned-
  but-never-computed setting does not yet... 'affect financial
  computation.'" `Order.serviceChargeTotal` stays zero for every P2D-era
  order. FR-PLT-028 becomes eligible for COMPLETE only after P2E proves
  real transaction computation actually uses the pinned policy.
- **FR-POS-055** ("service charge... configurable per branch, per order
  type, and conditional on guest count") — the CONFIGURATION portion (the
  three named dimensions: branch-level scoping via the tenant→brand→
  branch hierarchy, `orderType` per rule, `minGuestCount` per rule) is now
  **COMPLETE**. The requirement AS A WHOLE remains **NOT COMPLETE** — no
  computation exists yet to actually apply a configured rate to an order's
  total (P2E).
- **FR-POS-058** — unaffected by this task; no evidence gathered or
  reassessed here beyond confirming this task touches no code path
  FR-POS-058 depends on.

---

## 24. Service-charge configuration substrate — summary

Storage (§3-§8), rule schema/validation (§9-§10), target validation (§11),
resolver/precedence/lock (§13-§15), Order pinning (§16), admin surface
(§17-§19), and test coverage (§20) together constitute the COMPLETE
configuration substrate `P2D-R1` ratifies. **P2E remains required** for:
rule-matching/tie-breaking inside a pinned rule-set, `serviceChargeTotal`
computation, `CountryPack.serviceChargeTaxable` application, tax-on-
service-charge, tips/tip pooling, discount interaction, and any receipt/
event-payload change — none of which this task implements, per its own
scope fence (§1).

---

## 25. Verification results

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |
| `npx prisma validate` | valid |
| `npx prisma generate` | clean, repeated runs |
| `npm run openapi:generate` | clean; diff reviewed §26 |
| `npx eslint` (all changed/new files) | clean, 0 errors, 0 warnings, after fixing 129 prettier-formatting findings and 10 real findings (1 unused-var, 9 unsafe-`any`-member-access — all in test/rule-parser code, fixed with explicit types / a typed `idOf` helper, never suppressed) |
| Unit — new (`*-rules.spec.ts`, `*.resolver.spec.ts`) | 30/30 |
| Unit — full suite (88 suites) | 1212/1212 |
| e2e — new (`service-charge-policy.e2e-spec.ts`) | 25/25 |
| e2e — targeted regression (sales/orders/cash-rounding/country-pack) | 149/150 (1 pre-existing, unrelated failure — §20) |
| `module-boundaries.spec.ts` + `authorization-coverage.spec.ts` | 55/55, zero new deviations |

---

## 26. OpenAPI diff review

`git diff --stat -- docs/api`: **740 insertions / 0 deletions**
(`openapi.json`), **503 insertions / 0 deletions** (`openapi.yaml`) —
purely additive, no existing route or schema altered. Manually reviewed
the full diff (not just a keyword grep):

- New schema `CreateServiceChargePolicyDto` — properties exactly `rules`
  (object/unknown, required), `locked` (boolean, optional), `effective
  From` (string, optional). **No `tenantId`/`createdBy`/`level`/`targetId`
  /`id`/`createdAt` injection fields** — those are server-derived from the
  route path, the authenticated actor, or the database, never client-
  settable.
- Six new paths, all under the `sales` tag, operationIds
  `ServiceChargePolicyController_{createTenantPolicy,createBrandPolicy,
  createBranchPolicy,resolve,listVersions,cancel}`. **No accidental POS
  exposure** — nothing appears under the `pos` tag.
- Create-route 201 response schemas show `id, tenantId, level, targetId,
  rules, locked, effectiveFrom, createdAt, createdBy` — `createdAt`/
  `createdBy` appear only as READ-ONLY fields of the returned entity
  (server-owned, never accepted in a request body — confirmed against the
  `CreateServiceChargePolicyDto` schema above), not as client-settable
  injection points.
- **Zero occurrences of `serviceChargePolicyVersionId`** anywhere in the
  diff — the `Order` API response schema in `orders.controller.ts` is
  completely untouched, confirming the new pin field is not exposed
  through the existing Order API surface. This is the conservative,
  correct choice for this slice: no existing Order-API convention calls
  for exposing an internal FK to an as-yet-uncomputed configuration
  substrate, and P2D-R1 does not require it.

No manual edits were made to any generated OpenAPI file.

---

## 27. Files changed

**New:**
- `prisma/migrations/20260910010000_sales_service_charge_policies/migration.sql`
- `src/modules/sales/service-charge-policy/` (9 files: rules parser +
  spec, resolver + spec, service, controller, target-resolver, dto,
  views — 2636 total lines including the new e2e spec)
- `test/service-charge-policy.e2e-spec.ts`

**Modified:**
- `prisma/schema.prisma` (ServiceChargePolicy model/enum, Order pin field,
  back-relations)
- `src/modules/governance/audit/audit.constants.ts` (2 new AUDIT_ACTION
  entries, 1 new AUDIT_ENTITY entry)
- `src/modules/sales/orders/orders.service.ts` (+37 lines — resolver
  injection, `branchFacts` lookup, pin write; zero changes to
  `orders.controller.ts`)
- `src/modules/sales/sales.module.ts` (module wiring)
- `src/modules/sales/receipt.views.spec.ts` (fixture fix — added
  `serviceChargePolicyVersionId: null` to `baseOrder()`)
- `docs/api/openapi.json` / `docs/api/openapi.yaml` (generated, purely
  additive — §26)

---

## 28. Commit

Implementation, migration, tests, generated OpenAPI, this report, and
`INDEX.md` are committed together as `IMPLEMENTATION_COMMIT` below, per
this task's own instruction. A second, docs-only follow-up commit records
that hash back into this report (the established convention from every
prior task this session).

`IMPLEMENTATION_COMMIT`: `8715474`
`REPORT_HASH_COMMIT_IF_ANY`: recorded below (§29)

---

## 29. Post-commit hash record

Implementation, migration, tests, generated OpenAPI, this report, and
`INDEX.md` were committed as `8715474` on `full-srs/lane-d4-reporting-demo`
(starting from `19e5746`). This section itself is amended by a second,
docs-only follow-up commit recording that hash, matching the
`7cd43e5→5dc916c` / `b5f67d5→19e5746` / `9a7da00`→(recorded in-commit)
convention from earlier tasks in this session.

---

## 30. Blockers or uncertainties

None. All targeted verification passed; the one non-passing test
(`sales.e2e-spec.ts` route-list assertion) is pre-existing, independently
confirmed unrelated to this task's diff (§20), and out of this task's
scope fence to fix.

**SAFE_TO_INTEGRATE:** Yes, within the explicit scope of this task
(CONFIGURATION substrate only). P2E (rule matching, computation, receipt/
event consequences) remains required before `FR-PLT-028`/`FR-POS-055` can
be marked COMPLETE.

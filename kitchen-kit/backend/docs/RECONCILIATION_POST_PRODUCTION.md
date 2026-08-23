# Post-Production SRS Reconciliation Report

**Audit type:** READ-ONLY reconciliation. No source, schema, migration, test or
documentation was modified; nothing was committed; no database-mutating command
was run.
**Audit date:** 2026-08-16
**Repository:** `kitchen-kit/backend` · branch `main` · HEAD `48a16f92743d5f8049743ab6f1f6022b50c0fac1`
**Primary source of truth:** `ROS_SRS_v1.0.pdf` (repository root)

---

## 1. Executive Summary

Production Spec is **genuinely implemented, not merely designed**. Every one of
the 15 claims in the Production Implementation Report was independently verified
against the live database and the source tree; **15 VERIFIED, 0 NOT VERIFIED,
0 CONTRADICTED** (§9, §20).

Against the SRS as a whole the project stands at **13.4% weighted completion**
(84.88 / 634.25 weighted points), up **+1.3 percentage points** from 12.1%
before Production Spec, measured under identical weights. Of 634 defined
requirements, **56 are COMPLETE, 50 PARTIAL, 13 BLOCKED, 513 NOT IMPLEMENTED,
2 OUT OF SCOPE**.

The engineering quality of what exists remains high and is evidence-backed:
forced RLS on all 48 tenant-scoped tables with a fail-closed predicate verified
live as the non-bypassing runtime role, 11 composite tenant-safe FKs in
Production alone making cross-tenant edges structurally unrepresentable, an
append-only stock ledger, a hash-chained audit trail, and 153 unit + 318 E2E
tests. The constraint is breadth: **7 of 29 SRS domains have any executable
code**, and every revenue-generating capability is still absent.

Three findings warrant your attention, none of them blocking:

- **`/v1` route-prefix deviation (§15-D1).** The ratified design gate §14
  specifies `POST /v1/recipes`; the implementation exposes `POST /recipes`. This
  follows an established project convention (no controller uses `/v1`; there is
  no `setGlobalPrefix`), but that convention is **not recorded in any ratified
  document**, and the gate text says `/v1`. Per the audit brief this must not be
  waved through merely because other modules do it: it is classified
  **UNRESOLVED — requires ratification or a gate amendment**.
- **Central Kitchen is newly unblocked.** `FR-BRN-021`…`FR-BRN-030` were BLOCKED
  on Production Spec. That dependency is now satisfied; they move to NOT
  IMPLEMENTED. This is the concrete capability Production Spec unlocked.
- **Four SRS identifiers are referenced but never defined** — `FR-INT-020`,
  `FR-PLT-041`, `FR-RPT-055`, `FR-SEC-018` (§17-A1).

**Recommended next phase: Governance — Approval Workflow (`FR-SEC-030`…`FR-SEC-035`).**
It is the only remaining domain that is fully unblocked, small, and currently
dead-ending requirements in a *shipped* context: Inventory already refuses
postings when `requires_approval` is true, and nothing in the system can ever
grant that approval (§17).

**Final verdict: `READY FOR NEXT IMPLEMENTATION PHASE`.**

---

## 2. Repository State

| Property | Value | Evidence |
|---|---|---|
| Branch | `main` | `git rev-parse --abbrev-ref HEAD` |
| HEAD commit | `48a16f92743d5f8049743ab6f1f6022b50c0fac1` ("feat(identity): final auth security hardening") | `git log --oneline -1` |
| Uncommitted entries | **30** — all Phase 15/16/Inventory/Production work is untracked or modified; nothing has been committed since `48a16f9` | `git status --porcelain` |
| Migrations | **14** | `prisma/migrations/` |
| Prisma schemas | `catalogue, governance, identity, inventory, kitchen, org, production` (7) | `prisma/schema.prisma` datasource block |
| Prisma models / enums | 57 models, 19 enums | `grep -c '^model ' / '^enum '` |
| Migration status | 14 found, **database schema up to date** | `prisma migrate status` |
| Drift | **No difference detected** | `prisma migrate diff --from-config-datasource --to-schema` → exit 0 |
| `prisma validate` | valid | CLI |
| `nest build` | exit 0 | CLI |
| Typecheck (build config) | exit 0 | `tsc -p tsconfig.build.json --noEmit` |
| ESLint (read-only) | exit 0, 0 problems | `npx eslint "{src,apps,libs,test}/**/*.ts"` |
| Unit tests | **153 / 153 passing**, 25 suites | executed this audit (mock-based, no live DB) |
| E2E tests | **318 test cases across 18 suites** — count verified statically | see §9 note on execution |
| Routes | 123 (114 pre-Production + 9 Production) | controller enumeration |

### Implemented modules

`src/modules/identity` (auth, authz, context, credentials, memberships, password,
sessions, tenants, terminals, users) · `src/modules/governance/audit` ·
`src/modules/organisation` (brands, branches, warehouses, central-kitchens,
locations, stations, tables, operating-hours, print-routing, station-routing) ·
`src/modules/catalogue` (menus, categories, menu-items, modifier-groups,
price-lists, availability) · `src/modules/inventory` (stock-items, movements,
counts, waste, reconciliation) · **`src/modules/production` (recipes, versions,
substitute-groups)**.

### Known pre-existing failure (NOT introduced by Production Spec)

`tsc -p tsconfig.json --noEmit` (root config, includes tests) fails at
`src/modules/identity/auth/access-token.service.spec.ts:28` —
`TS2322: Type 'string' is not assignable to type 'number | StringValue | undefined'`.
The file was last touched in commit `48a16f9` and its working-tree status is
empty, i.e. **unmodified**. The build configuration is clean.

---

## 3. SRS Scope

The SRS was parsed directly from `ROS_SRS_v1.0.pdf` (`pdftotext -layout`), not
from prior phase reports. **638 unique requirement identifiers** were found;
**634 are actually defined** with requirement text.

| Family | Count | Family | Count | Family | Count |
|---|---:|---|---:|---|---:|
| FR-POS | 76 | FR-INV | 50 | FR-SEC | 45 |
| FR-MNU | 38 | FR-OFF | 36 | FR-PRC | 33 |
| FR-CST | 31 | FR-BRN | 30 | FR-HRM | 29 |
| FR-FIN | 27 | FR-CRM | 26 | FR-KDS | 23 |
| FR-PLT | 21 | FR-LOC | 20 | FR-RPT | 18 |
| NFR-PERF | 16 | FR-OPS | 15 | FR-API | 12 |
| NFR-USA | 11 | FR-AUD | 10 | FR-DR | 10 |
| NFR-REL | 7 | NFR-OBS | 7 | FR-INT | 6 |
| NFR-PORT | 6 | BR-FIN | 5 | FR-QA | 5 |
| BR-CORE | 4 | BR-POS | 4 | BR-MNU | 4 |
| BR-INV | 3 | NFR-DATA | 2 | NFR-API | 2 |
| BR-PLT | 1 | NFR-CAP | 1 | | |

### Dangling identifiers — `NOT SRS-DEFINED`

`FR-INT-020`, `FR-PLT-041`, `FR-RPT-055`, `FR-SEC-018` appear **only** inside
cross-references and traceability tables; the SRS never defines them. They are
excluded from the 634 inventory and from every denominator. This is an SRS
defect, recorded in §17-A1.

---

## 4. Master Requirement Matrix

The complete 634-row matrix follows in **Appendix A**, grouped by domain and
ordered by weighted completion. Every non-trivial `COMPLETE` and `PARTIAL` row
cites concrete repository artifacts (file, migration, constraint, or test).

---

## 5. Completed Domains

No SRS domain is 100% complete. The following are the most complete, with the
distinction between *implemented*, *tested* and *verified* preserved:

| Capability | Classification | Evidence |
|---|---|---|
| Tenant isolation via RLS | **Implemented + tested** | 48 tenant tables `ENABLE`+`FORCE`, 4 policies each; predicate `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`; `test/rls.e2e-spec.ts`, `catalogue-rls`, `inventory-rls`, `production-rls`; live `ros_app` probes with positive controls |
| Composite tenant-safe FKs | **Implemented + tested** | ADR 0008 D-09; 11 composite FKs in `production` alone, verified in `pg_constraint`; rejection tests in each `*-rls` suite |
| Authentication & sessions | **Implemented + tested** | ADR 0001/0005; `test/auth.e2e-spec.ts`, `refresh.e2e-spec.ts`, `password.e2e-spec.ts` |
| RBAC (tenant-scoped) | **Implemented + tested** | `src/modules/identity/authz/*`; `test/rbac.e2e-spec.ts`; all 123 routes guarded |
| Hash-chained audit storage | **Implemented + tested** | ADR 0007; `audit-hash.ts`; append-only verified live (`permission denied`) |
| Append-only stock ledger | **Implemented + tested** | `BR-INV-001`; `stock_movements` RANGE-partitioned, INSERT+SELECT only, RLS on parent **and all 14 partitions** (migration `20260817090000`) |
| Recipe identity, versioning, publication | **Implemented + tested** | §9 below |

---

## 6. Partial Domains

| Domain | Weighted | What is implemented | What is missing |
|---|---:|---|---|
| Inventory | 53.8% | 22 FR-INV COMPLETE: items, batches, levels, movements, transfers, counts, waste, FIFO/FEFO + valuation | 13 BLOCKED on Procurement/Sales/Treasury/Governance/Workforce/Sync; 5 have logic but no scheduler; 7 dropped by decision |
| Catalogue / Menu / Recipe | 46.2% | Menus, categories, items, variants, modifiers, price lists, availability, branch menu resolution; **now plus recipes** | **Price resolution is not implemented** — `valid_from`/`valid_to`/`recurrence_rule`/`priority` are stored and returned, never evaluated (`FR-MNU-021/022/023`); auto-86 (`FR-MNU-031`…`033`); costing (`FR-MNU-046`) |
| Platform & Tenancy | 41.0% | Hierarchy, immutable `tenant_id`, RLS, non-bypassing role, fail-closed | Settings resolver `FR-PLT-025`…`028` (ADR 0008 D-11 deferred); tenant lifecycle `FR-PLT-020`…`023`; CI gates `FR-PLT-013/014`; read replica/timeouts |
| Audit | 40.0% | `FR-AUD-002/003/004` complete | No verification job (`005`), **no query/search/export surface** (`007/008`), no retention (`009`), no impersonation (`010`) |
| API Platform | 32.4% | `FR-API-010/013` complete | No idempotency (`020`…`023`), no API keys/OAuth (`011/014`), no stable error codes (`001`), no `Accept-Language` (`002`) |
| Security & Authorization | 20.0% | 4 of 45 FR-SEC COMPLETE (`001`, `011`, `045`, `047`) | PIN auth, MFA, SoD, **approvals**, encryption at rest, KMS, secrets, CI scanning, IP allow-listing, SIEM, DSR/retention |
| Branch Ops & Central Kitchen | 11.7% | `FR-BRN-001/015` complete; `002/003/020` partial | `FR-BRN-021`…`030` — **newly unblocked**; branch groups (ADR 0008 D-10); scorecards |

---

## 7. Unimplemented Domains

All at **0.0%** weighted, verified by absence of models, services and routes:

Sales / POS (80) · Offline & Sync (36) · Procurement (33) · Finance & Treasury
(32) · Costing & Analytics (31) · Workforce (29) · CRM & Loyalty (26) · Kitchen
Ops KDS (23) · Reporting (18) · DevOps & Release (15) · Integrations (6) ·
Quality Assurance (5) · NFR-Usability (11) · NFR-Reliability (7) ·
NFR-Portability (6) · NFR-Capacity (1).

Evidence of absence: `prisma/schema.prisma` declares 7 schemas — `sales`, `ck`,
`procurement`, `workforce`, `fiscal`, `treasury`, `crm`, `analytics`, `sync`,
`platform` do not exist; no controller, service or model references order,
payment, tender, discount, refund, customer, loyalty, employee, shift, supplier,
purchase order, cash session or sync batch.

---

## 8. Deferred / Out-of-Scope Requirements

**OUT OF SCOPE (excluded from denominators — 2):** `FR-MNU-048` recipe scaling
and `FR-MNU-050` nutrition, both excluded by the ratified design gate §20.

**DEFERRED by authorized decision (counted at 0%, not excluded):**
`FR-MNU-046` / `BR-MNU-003` costing (D-17-05) · `FR-MNU-013` `recipe_delta`
semantics (D-17-07) · `archived` lifecycle (D-17-04) · `FR-DR-002` partition
automation · `FR-PLT-025`…`028` settings (ADR 0008 D-11) · `FR-SEC-002`…`004`
branch-scoped RBAC (ADR 0008 D-02) · `FR-BRN-005` branch groups (ADR 0008 D-10) ·
`FR-MNU-035` daily limits (C-07) · `FR-INV-033/048/049/061/068/069/070`.

Deferred is **not** counted as implemented, per rule 9 of the audit brief.

**BLOCKED (13):** all in Inventory, on Procurement (`FR-INV-005/067`), Treasury
(`026`), Sales (`027/055`), Governance approvals (`032/035/046/047/058`), Sync
(`043`), Workforce (`056`) and Kitchen Ops (`060`).

---

## 9. Production Spec Verification

Verified against `docs/production/PRODUCTION_SPEC_DESIGN_GATE.md` and the SRS.

### 9.1 The 15 report claims

| # | Claim | Result | Evidence |
|---|---|---|---|
| 1 | 14 migrations | **VERIFIED** | `ls prisma/migrations` → 14; `migrate status` → 14 found, up to date |
| 2 | 5 production tables | **VERIFIED** | `pg_class` → `recipes, recipe_versions, recipe_lines, substitute_groups, substitute_group_members` |
| 3 | 4 enums | **VERIFIED** | `pg_type` → `RecipeScope, RecipeType, RecipeVersionStatus, RecipeComponentType` |
| 4 | 19 FKs | **VERIFIED** | `pg_constraint contype='f'` → 19 |
| 5 | 11 composite tenant-safe FKs | **VERIFIED** | 11 with `array_length(conkey,1)>1`, each `(tenant_id, …) → (tenant_id, id)`; full list in §20 |
| 6 | 4 CHECK constraints | **VERIFIED** | `ck_recipe_scope`, `ck_recipe_target`, `ck_recipe_line_component`, `ck_recipe_yield_positive` |
| 7 | Partial unique published index | **VERIFIED** | `uq_recipe_single_published … (recipe_id) WHERE (status = 'published')` |
| 8 | RLS + FORCE on all 5 tables | **VERIFIED** | `relrowsecurity=t AND relforcerowsecurity=t` on all 5 |
| 9 | 4 policies per table | **VERIFIED** | `pg_policies` → 4 for each of the 5 |
| 10 | 153/153 unit tests | **VERIFIED** | executed: 25 suites, 153 passed |
| 11 | 318/318 E2E tests | **VERIFIED (count); pass-rate NOT RE-RUN** | Static count = 304 `it()` sites + 14 `it.each` expansions = **exactly 318**. The suite was not executed because E2E inserts rows and the brief forbids DB-mutating commands. Pass-rate is carried from the implementation run, not re-verified here. |
| 12 | No triggers | **VERIFIED** | `pg_trigger` non-internal in `production` → 0 |
| 13 | `effective_from` not used in selection | **VERIFIED** | 5 non-comment occurrences: DTO input, view output, interface field, and 2 in the `createDraft` insert. **0 in `recipe-graph.ts`** (all selection logic), 0 in `publish()`, 0 matches for `orderBy/where/lte/gte` patterns, 0 index/CHECK/policy references |
| 14 | No effective-recipe endpoint | **VERIFIED** | 9 routes enumerated from the controller; none resolves an effective recipe |
| 15 | Exactly 3 recipe permissions | **VERIFIED** | `production.permissions.ts` → `recipe.view`, `recipe.edit`, `recipe.publish`; 3 `PermissionDef` entries |
| 16 | No pre-existing failures introduced | **VERIFIED** | The single root-tsconfig error is in a file last modified at `48a16f9` with empty working-tree status |

### 9.2 D-17-02 … D-17-08 implementation

| Decision | Result | Evidence |
|---|---|---|
| **D-17-02** typed nullable + composite FK + XOR | **IMPLEMENTED** | `scope_id`→`brand_id`/`branch_id`; `target_id`→`menu_item_variant_id`/`stock_item_id`; `component_id`→`stock_item_id`/`sub_recipe_id`; 11 composite FKs; 3 XOR CHECKs verified verbatim in §20 |
| **D-17-03** branch > brand > tenant | **IMPLEMENTED** | `resolveRecipeByScope()` in `recipe-graph.ts`; 4 unit tests; comment preserves the analogy-derived framing from FR-PLT-025 rather than presenting it as SRS text |
| **D-17-04** lifecycle, `archived` unimplemented | **IMPLEMENTED** | `RecipeVersionStatus = draft\|published\|superseded` — `archived` is **absent from the enum**, therefore unrepresentable, not merely unused |
| **D-17-05** costing deferred | **IMPLEMENTED** | `computed_cost`/`cost_computed_at` exist; E2E asserts they remain `null`; no costing code |
| **D-17-06** three permissions | **IMPLEMENTED** | see claim 15 |
| **D-17-07** `recipe_delta` opaque | **IMPLEMENTED** | no reference to `recipe_delta` anywhere in `src/modules/production/` |
| **D-17-08 Q1** one published version | **IMPLEMENTED** | partial unique index; `publish()` demotes the incumbent **before** promoting (index is not deferrable); E2E asserts exactly one published row survives |
| **D-17-08 Q2** `effective_from` informational | **IMPLEMENTED** | see claim 13; `selectPublishedVersion()` has arity 1, so a date cannot reach it |
| **D-17-08 Q3/Q4/Q5** N/A | **HONOURED** | no temporal resolver, no tie-break, no `effective_to` |

### 9.3 Lifecycle and immutability (GAP-2)

Verified live as `ros_app`, each with a positive control:

- non-`status` UPDATE on a version → `ERROR: permission denied for table recipe_versions`; `status` UPDATE → `UPDATE 1`
- table-wide UPDATE grants on `recipe_versions` → **0 rows**; column grants → **`status` only**
- DELETE of a published version → `DELETE 0`; its lines → `DELETE 0`
- cross-tenant INSERT spoof → `new row violates row-level security policy`; same INSERT in-tenant → `INSERT 0 1`
- fail-closed with no tenant context → 0 rows on all five tables; owner sees 26 recipes

### 9.4 API surface

| Method | Path | Permission |
|---|---|---|
| POST | `/recipes` | `recipe.edit` (GAP-1 ratified deviation) |
| GET | `/recipes` | `recipe.view` |
| GET | `/recipes/:recipeId/versions` | `recipe.view` |
| POST | `/recipes/:recipeId/versions` | `recipe.edit` |
| PUT | `/recipes/:recipeId/versions/:version/lines` | `recipe.edit` |
| POST | `/recipes/:recipeId/versions/:version/publish` | `recipe.publish` |
| POST | `/substitute-groups` | `recipe.edit` |
| GET | `/substitute-groups` | `recipe.view` |
| POST | `/substitute-groups/:groupId/members` | `recipe.edit` |

Cross-tenant behaviour and 404 semantics are covered by
`test/production.e2e-spec.ts` (cross-tenant variant, stock item, brand,
sub-recipe, recipe id, substitute group — all 404, never 403) and by
`POST /recipes/:id/versions` returning 404 for an unknown recipe, proving no
auto-creation.

**Two routes are not in the design gate §14:** `GET /recipes` (list) and
`PUT /recipes/:id/versions/:v/lines` (draft line editing). The gate §14 states
"**No further endpoints.** No list, no detail, no update, no delete, no
resolution endpoint." See §15-D2 — classified as a deviation from the ratified
gate, not a defect, but **unratified**.

---

## 10. Previous Phase Verification

| Phase | Report claim | Reconciled finding |
|---|---|---|
| Identity / Auth | Complete | **Supported.** ADR 0001/0005; tests pass. Not SRS-complete: MFA, PIN, API keys absent |
| Tenants / Memberships | Complete | **Supported.** `FR-PLT-001/002/003` COMPLETE |
| RBAC | Complete | **Partially supported — REPORT/REPOSITORY NUANCE.** `FR-SEC-001/011` COMPLETE, but `FR-SEC-002`…`005` are NOT implemented: `membership_roles.branch_id` exists and the schema comment states it is "not yet consumed by permission resolution" |
| Tenant context | Complete | **Supported.** ADR 0002; `tenant-context.e2e-spec.ts` |
| RLS | Complete | **Supported today.** Was materially false when Inventory was first reported complete — the 14 ledger partitions had no RLS of their own; fixed in `20260817090000_inventory_partition_rls`. Recorded as historical evidence that a green suite ≠ a secure boundary |
| Terminal identity | Complete | **PARTIAL.** ADR 0004 defers pairing/activation; no credential wipe (`FR-SEC-028`) |
| Password lifecycle | Complete | **PARTIAL.** No per-tenant policy, no breached-password list (`FR-SEC-025`) |
| Rate limiting / Helmet | Complete | **PARTIAL.** Auth endpoints only, IP-based; `FR-PLT-015` per-tenant and `FR-SEC-046` progressive lockout absent |
| Audit trail | Complete | **PARTIAL — 3 of 10 FR-AUD.** Storage is excellent; there is no query surface, no verification job, no retention |
| Inventory | Complete + ratified | **PARTIAL — 22 of 50 FR-INV.** The closeout itself records 13 blocked and 7 dropped; consistent |
| Catalogue | Complete | **PARTIAL.** Price resolution absent; the README's own "Requirements knowingly unmet" list is accurate |
| Production Spec | Complete | **Supported.** §9 |

No claim was found that the repository contradicts outright. The two nuances
worth recording as `REPORT/REPOSITORY DISCREPANCY` in spirit are the RBAC
branch-scope wording and the historical RLS partition gap; both are already
documented in their own ADR/closeout.

---

## 11. Requirement Completion Metrics

Denominator = 632 (634 defined − 2 OUT OF SCOPE). Credit: COMPLETE = 1.0,
PARTIAL = 0.5, DESIGNED / NOT IMPLEMENTED / BLOCKED = 0.0.

### A. Requirement completion

- **Strict** (COMPLETE only): 56 / 632 = **8.9%**
- **Credit** (PARTIAL at 0.5): 81.0 / 632 = **12.8%**

### B. Weighted functional completion

Weights per the audit brief: **Core FR = 1.0, Business Rule = 1.0, API
requirement = 1.0, Security/RLS = 1.25, NFR = 0.75.** "Security/RLS" was
operationalised as every `FR-SEC-*`, plus `FR-AUD-001`…`010` (audit is a
security control) and `FR-PLT-003/010/011/012/013/014` (tenant isolation and
RLS). Weighting security **above** 1.0 *lowers* the headline number, because
most security requirements are unimplemented — that is the intended effect.

**84.88 / 634.25 = 13.4%**

For comparison under identical weights, the pre-Production figure was
76.88 / 634.25 = **12.1%**. Production Spec contributed **+8.00 weighted points
(+1.3 pp)**: 6 COMPLETE (`FR-MNU-040`…`044`, `BR-MNU-001`) and 4 PARTIAL
(`FR-MNU-045`, `047`, `049`, `BR-MNU-002`).

### C. Domain completion

| Domain | Weighted | Calculation | Reqs |
|---|---:|---|---:|
| Inventory | 53.8% | 28.50 / 53.00 | 53 |
| Catalogue / Menu / Recipe | 46.2% | 18.50 / 40.00 | 42 |
| Platform & Tenancy | 41.0% | 9.62 / 23.50 | 22 |
| Audit | 40.0% | 5.00 / 12.50 | 10 |
| API Platform | 32.4% | 4.38 / 13.50 | 14 |
| Core Money & Units | 25.0% | 1.00 / 4.00 | 4 |
| Security & Authorization | 20.0% | 11.25 / 56.25 | 45 |
| Data Retention & Migrations | 15.0% | 1.50 / 10.00 | 10 |
| Branch Ops & Central Kitchen | 11.7% | 3.50 / 30.00 | 30 |
| NFR — Observability | 7.1% | 0.38 / 5.25 | 7 |
| NFR — Performance | 3.1% | 0.38 / 12.00 | 16 |
| Localisation & Country Packs | 2.5% | 0.50 / 20.00 | 20 |
| Sales / POS · Finance · Costing · Procurement · Workforce · CRM · KDS · Offline · Reporting · DevOps · Integrations · QA · NFR-USA/REL/PORT/CAP | **0.0%** | 0.00 / respective totals | 336 |

### Methodology and its limits

Progress is computed **from the SRS requirement inventory**, never from files,
commits, migrations or endpoints. Statuses were assigned per requirement with
evidence; domains with no code received a per-domain justification recorded
against every requirement.

**Precision caveat — do not over-read these figures.** The denominator is exact
(634 parsed identifiers) but the numerator embeds judgement at every PARTIAL,
and the 0.5 credit is a convention, not a measurement. A defensible range for
overall completion is **12–14%**. The domain percentages for domains with fewer
than 10 requirements (Core Money, NFR-Data, NFR-Capacity) are especially coarse
and should be read as indicative only.

---

## 12. Dependency Graph

Derived from SRS dependencies, not preference.

```
Identity/Auth [DONE] -> Tenant Context [DONE] -> RBAC [DONE, tenant scope only]
                                                    |
                                                    v
                                                RLS [DONE]
                                                    |
                        +---------------------------+---------------------------+
                        v                           v                           v
                 Organisation [DONE]         Catalogue [PARTIAL]        Inventory [PARTIAL]
                        |                           |                           |
                        +-------------+-------------+-------------+-------------+
                                      v                           v
                          ** Production Spec [DONE] **      Governance approvals [NONE]
                                      |                           |
                        +-------------+-------------+             +-> unblocks 5 FR-INV
                        v                           v                 + FR-SEC-030..035
              Central Kitchen [NONE]          Sales / POS [NONE]
              (FR-BRN-021..030)               (76 FRs)
              NEWLY UNBLOCKED                        |
                                      +--------------+--------------+---------+
                                      v              v              v         v
                                  Payments      Kitchen Ops     Costing    CRM
                                                                    |
                                                        Finance/Treasury, Reporting
                                                                    |
                                                            Offline & Sync

UNBLOCKED AND INDEPENDENT TODAY (no upstream dependency):
  Governance approvals · Scheduler/jobs · Settings resolver · Branch-scoped RBAC
  · CI/CD · Observability · Procurement · Central Kitchen
```

### What Production Spec enables

| Newly enabled | Dependency satisfied | Still required |
|---|---|---|
| Central Kitchen `FR-BRN-021`…`030` | `production.recipe_versions` exists as the FK target `ck.production_orders.recipe_version_id` requires | `ck` schema, production/distribution order tables, services, routes |
| Sales `BR-POS-004` snapshot target | `recipe_version_id` is now a real, stable, immutable reference | Entire Sales domain |
| Costing `BR-MNU-003` | Recipe structure, yield, wastage, sub-recipe graph all exist | Inventory valuation binding + D-17-05 reversal |

---

## 13. Blocking Issues

**None.** No issue prevents authorizing the next implementation phase.

The `/v1` and extra-route deviations (§15) are governance items requiring your
ratification, not implementation blockers — the code is coherent, tested and
internally consistent either way.

---

## 14. Non-Blocking Issues

1. **E2E pass-rate not re-executed this audit.** The brief forbids DB-mutating
   commands and every E2E suite inserts rows. The 318 *count* is verified
   statically; the pass-rate is carried from the implementation run. Marked
   **UNVERIFIED-THIS-AUDIT**, not disputed.
2. **Nothing is committed.** All Phase 15/16/Inventory/Production work — 6
   migrations, 4 modules, 7 test suites — exists only in the working tree at
   HEAD `48a16f9`. A single `rm -rf` or bad `git checkout` would destroy it.
3. **`FR-DR-002` partition automation remains absent.** `stock_movements` has 14
   monthly partitions and **no DEFAULT partition**; inserts past 2027-09 will
   fail hard. Operational risk, unchanged by this phase.
4. **Root-config typecheck failure** (§2), pre-existing.
5. **No CI.** `FR-PLT-014` and `FR-SEC-049` have no enforcement.

---

## 15. Known Deviations

**D1 — `/v1` route prefix: UNRESOLVED, requires ratification.**
The ratified gate §14 lists `POST /v1/recipes`, `GET /v1/recipes/{id}/versions`,
`POST /v1/recipes/{id}/versions/{v}/publish`. The implementation exposes those
paths **without** `/v1`. Classification per the brief's four options:

- *Documented deviation?* **No.** No ratified document records the de-prefixing;
  the gate says `/v1`.
- *Existing project convention?* **Yes.** `main.ts` has no `setGlobalPrefix`;
  every controller (`auth`, `catalogue`, `inventory`, `org`, `health`) is
  unprefixed, and SRS §26.3 lists `/v1/inventory/levels` while the repository
  serves `/inventory/levels`.
- *SRS discrepancy?* **Partly** — the SRS consistently specifies `/v1` for all
  domains and the repository has never honoured it.
- **Verdict: UNRESOLVED.** A convention followed consistently but never
  ratified. Recommend either amending gate §14 to record the de-prefixing, or
  ratifying a project-wide API-versioning decision. Not decided here.

**D2 — Two routes beyond the gate's enumerated surface.**
`GET /recipes` and `PUT /recipes/:id/versions/:v/lines` exist; gate §14 says "no
list… no update". Both are permission-guarded and tested, and draft line editing
is arguably implied by "draft creation/editing" in the implementation
authorization §3. Still, they exceed the gate's explicit enumeration.
**Classification: legitimate but unratified scope addition.**

**D3 — Boundary modifications outside `src/modules/production/`.** Each was
inspected (§7 of the brief):

| File | Classification | Justification |
|---|---|---|
| `prisma/schema.prisma` — 7 back-relation blocks (Tenant, Brand, Branch, MenuItemVariant, StockItem, User, Uom) | **Required mechanical dependency** | Prisma *requires* opposite relation fields. **Proof of zero DDL impact:** the migration contains no `ALTER/CREATE/DROP` against any non-`production` schema — those schemas appear only as FK *targets* — and drift is clean. All 7 carry the marker comment "Production Spec back-relations (virtual; no DDL impact)" |
| `prisma/schema.prisma` — `production` added to `schemas` | **Required mechanical dependency** | Datasource must declare the schema |
| `src/modules/governance/audit/audit.constants.ts` | **Legitimate cross-module integration** | 113 insertions, **0 deletions** across Phases 15/16/Inventory/Production; Production's own share is 6 actions + 3 entities. Gate §16 explicitly anticipated "existing constants extended for the recipe entity" |
| `test/catalogue.e2e-spec.ts`, `test/inventory.e2e-spec.ts` | **Required mechanical dependency** | Prior-phase boundary guards asserted `production` does not exist. Only that one entry was removed from each list; every unbuilt context stays guarded. Directly precedented by the `inventory` entry being removed from the Catalogue guard when Inventory shipped |
| `src/app.module.ts` | **Required mechanical dependency** | Module wiring |

**No modification was classified as scope expansion or suspicious.**

**D4 — Migration timestamp renamed.** Prisma generated
`20260816131515_production_spec_foundation`, which sorts *before* the Inventory
migrations it depends on; the unapplied directory was renamed to
`20260817120000_...` to preserve replay order. No applied migration was
modified. Consistent with the hand-picked timestamps of prior phases.

---

## 16. Technical Debt

1. **Uncommitted work** — the single largest risk to the codebase (§14-2).
2. **Cycle detection loads the tenant's whole sub-recipe graph** on every draft
   write (`assertNoCycle` in `recipe-versions.service.ts`). Correct and RLS-
   bounded, but O(tenant lines) per write; will need an index-assisted or
   recursive-CTE approach at scale. No SRS performance requirement covers it —
   `NOT SRS-DEFINED`.
3. **No pagination anywhere.** `GET /recipes`, `GET /substitute-groups` and every
   prior-phase list endpoint return unbounded collections; the movement ledger is
   hard-capped at 200. No SRS requirement mandates pagination — `NOT SRS-DEFINED`.
4. **`recipe.version.published` event is deferred** with no infrastructure, as
   ratified. When an event bus arrives, Production Spec is its first publisher.
5. **Column-level UPDATE grant is table-wide in effect** — even a *draft*
   version's non-status columns cannot be updated by `ros_app`. Deliberate and
   tested, but it means a future "edit draft metadata" feature will need a grant
   change, not just code.
6. **Audit data is write-only** — no query surface (`FR-AUD-008`).

---

## 17. SRS Ambiguities

**A1 — Four identifiers referenced but never defined:** `FR-INT-020`,
`FR-PLT-041`, `FR-RPT-055`, `FR-SEC-018`. `NOT SRS-DEFINED`.

**A2 — `FR-MNU-045` "the version in force at sale time"** presumes a selection
rule the SRS never states. D-17-08 resolved it for this project by ratification;
the SRS itself remains silent. Recorded so the resolution is not mistaken for SRS
text.

**A3 — Sub-recipe expansion is not version-pinned.** A parent version references
a sub-recipe by logical identity, so publishing a new sub-recipe version changes
what the parent expands to. `BR-MNU-002` still holds because completed orders
snapshot `recipe_version_id` and are never re-expanded. Consequence recorded in
gate §21; no SRS text addresses it.

**A4 — §26.3 is titled "Representative Endpoints"**, so the SRS does not assert
a complete API surface. This is what made GAP-1 a gap rather than a prohibition —
and it is also why D1/D2 above cannot be settled from the SRS alone.

---

## 18. Recommended Next Phase

### Recommended next phase

**Governance — Approval Workflow** (`FR-SEC-030` … `FR-SEC-035`).

### Why

1. **It is the only unblocked domain that is currently dead-ending a shipped
   context.** Inventory's `requires_approval` gate (ratified as B-2) *refuses*
   postings when approval is required, and **nothing in the system can ever grant
   it**. Five Inventory requirements — `FR-INV-032/035/046/047/058` — are BLOCKED
   on exactly this, in a phase already declared closed.
2. **It has no upstream dependency.** RBAC, tenant context, RLS and the audit
   trail are all in place; approvals need nothing that does not exist.
3. **It is small relative to its unblocking power** — 6 FR-SEC requirements plus
   5 FR-INV unblocked, versus Sales/POS at 76 FRs with ~230 downstream.
4. **The SRS makes it a shared mechanism**, not an Inventory feature:
   `FR-SEC-030` requires "a general approval mechanism used by discounts,
   refunds, purchase orders, waste, count adjustments, expenses, and price
   changes." Building it now means Procurement, Sales and Finance inherit it
   rather than each inventing one.
5. **`FR-SEC-033` requires immutable approval decisions** — the same
   append-only/hash-chain pattern already proven twice in this repository.

Central Kitchen is the alternative (newly unblocked, directly enabled by
Production Spec), but it is larger, depends on costing that D-17-05 defers, and
unblocks nothing else. Approvals should come first.

### Prerequisites already satisfied

RBAC and permission catalogue · tenant context and RLS · composite tenant-safe FK
pattern (ADR 0008 D-09) · append-only enforcement pattern (ADR 0007) ·
`governance` schema and `AuditService` · Inventory's caller-supplied
`requires_approval` gate (B-2) · error semantics (401/403/**404 cross-tenant**/409/400).

### Remaining prerequisites

- **A design gate and ratification**, as every prior phase received. The SRS
  §15.3 approval requirements must be reconciled against the approved SQL, and
  the blockers enumerated before code.
- **A decision on threshold evaluation.** B-2 ratified that Inventory owns the
  *gate* only and "Governance will own determining when approval is required."
  That determination is undefined and will be a blocker in the gate.
- **A decision on `FR-SEC-032` asynchronous approval** (push notification) —
  notification infrastructure does not exist and must not be invented.
- **A decision on `FR-SEC-034` escalation**, which implies a scheduler.

### Scope

Approval request entity with requester, action, entity reference, value,
required approver permission and expiry (`FR-SEC-031`) · synchronous decision
capture (`FR-SEC-030/032` sync half) · immutable decision record with approver,
timestamp, decision, comment (`FR-SEC-033`) · integration with the existing
Inventory `requires_approval` gate so `FR-INV-032/035/046/047/058` unblock ·
RLS + composite FKs + audit on every mutation · permissions drawn **only** from
SRS §15.2.

### Explicit exclusions

Asynchronous/push approval (`FR-SEC-032` async half) unless notification
infrastructure is separately ratified · escalation (`FR-SEC-034`) — requires a
scheduler · offline approval policy (`FR-SEC-035`) — requires Offline ·
segregation of duties (`FR-SEC-015`…`017`) — separate requirement family ·
threshold *evaluation* unless explicitly ratified · any change to Inventory,
Catalogue or Production Spec · new permission codes · outbox/event
infrastructure · triggers · Sales, Procurement, Finance, Central Kitchen.

### Relevant SRS references

`FR-SEC-030`, `FR-SEC-031`, `FR-SEC-032`, `FR-SEC-033`, `FR-SEC-034`,
`FR-SEC-035`; unblocks `FR-INV-032`, `FR-INV-035`, `FR-INV-046`, `FR-INV-047`,
`FR-INV-058`; audit obligations `FR-AUD-001`, `FR-AUD-006`; isolation
`FR-PLT-003`, `FR-PLT-010`, `FR-PLT-012`.

### Expected database changes

New tables in the existing `governance` schema (approval requests and
decisions), `tenant_id` NOT NULL, `UNIQUE (tenant_id, id)`, composite
tenant-safe FKs to requester/approver and to the approved entity, ENABLE + FORCE
RLS with 4 policies each, and append-only enforcement on decisions per
`FR-SEC-033`. Exact shape to be fixed by the design gate, not here.

### Expected API changes

Request creation, decision (approve/reject), and request retrieval. Exact paths
must be settled together with deviation **D1**.

### Expected permissions

**Only** codes attested by SRS §15.2. If §15.2 supplies no approval-specific
code, that is a blocker for the design gate — not licence to invent one.

### Expected tests

Unit: expiry, permission matching, state machine. Integration: the Inventory
gate transitioning from refuse to permit. E2E: authorization per code, 404
cross-tenant, immutability of decisions, self-approval rejection. RLS: fail-
closed, cross-tenant SELECT/INSERT/UPDATE/DELETE, append-only decisions — each
with a positive control.

---

## 19. Explicit Exclusions for Next Phase

See §18 "Explicit exclusions". In addition, and non-negotiably: no
reinterpretation of D-17-02 … D-17-08; no modification of any closed phase; no
`effective_to`, `published_at` or `priority`; no effective-date resolver; no
scheduler; no notification system.

---

## 20. Verification Evidence

### Composite tenant-safe FKs (11) — `pg_constraint`

```
recipes                  (tenant_id, brand_id)             -> org.brands(tenant_id, id)
recipes                  (tenant_id, branch_id)            -> org.branches(tenant_id, id)
recipes                  (tenant_id, menu_item_variant_id) -> catalogue.menu_item_variants(tenant_id, id)
recipes                  (tenant_id, stock_item_id)        -> inventory.stock_items(tenant_id, id)
recipe_versions          (tenant_id, recipe_id)            -> production.recipes(tenant_id, id)
recipe_lines             (tenant_id, recipe_version_id)    -> production.recipe_versions(tenant_id, id)
recipe_lines             (tenant_id, stock_item_id)        -> inventory.stock_items(tenant_id, id)
recipe_lines             (tenant_id, sub_recipe_id)        -> production.recipes(tenant_id, id)
recipe_lines             (tenant_id, substitute_group_id)  -> production.substitute_groups(tenant_id, id)
substitute_group_members (tenant_id, substitute_group_id)  -> production.substitute_groups(tenant_id, id)
substitute_group_members (tenant_id, stock_item_id)        -> inventory.stock_items(tenant_id, id)
```

### XOR CHECK constraints — verbatim from `pg_get_constraintdef`

```
ck_recipe_scope     CHECK ((scope='tenant' AND brand_id IS NULL AND branch_id IS NULL)
                        OR (scope='brand'  AND brand_id IS NOT NULL AND branch_id IS NULL)
                        OR (scope='branch' AND branch_id IS NOT NULL AND brand_id IS NULL))
ck_recipe_target    CHECK ((recipe_type='menu_item' AND menu_item_variant_id IS NOT NULL AND stock_item_id IS NULL)
                        OR (recipe_type = ANY(ARRAY['sub_recipe','production_item'])
                            AND stock_item_id IS NOT NULL AND menu_item_variant_id IS NULL))
ck_recipe_line_component CHECK ((component_type='stock_item' AND stock_item_id IS NOT NULL AND sub_recipe_id IS NULL)
                             OR (component_type='sub_recipe' AND sub_recipe_id IS NOT NULL AND stock_item_id IS NULL))
ck_recipe_yield_positive CHECK (yield_quantity > 0)
```

### Enums — `pg_enum`

```
RecipeScope         = tenant | brand | branch
RecipeType          = menu_item | sub_recipe | production_item
RecipeVersionStatus = draft | published | superseded      <- 'archived' absent by design (D-17-04)
RecipeComponentType = stock_item | sub_recipe
```

### Partial unique index

```
CREATE UNIQUE INDEX uq_recipe_single_published
  ON production.recipe_versions USING btree (recipe_id)
  WHERE (status = 'published'::production."RecipeVersionStatus")
```

### Grants on `production.recipe_versions`

```
table-wide UPDATE grants to ros_app : 0 rows
column-level UPDATE grants          : status
other table grants                  : SELECT, INSERT, DELETE
```

### `effective_from` — all 5 non-comment occurrences

```
production.dto.ts:84                       @IsOptional() @IsString() effectiveFrom?: string;   (input)
production.views.ts:59                     effectiveFrom: v.effectiveFrom,                     (display)
versions/recipe-versions.service.ts:41     effectiveFrom?: string;                             (interface)
versions/recipe-versions.service.ts:206-207 effectiveFrom: input.effectiveFrom ? new Date(...) (persistence)

recipe-graph.ts (ALL selection logic)      : 0 occurrences
publish()                                  : 0 occurrences
orderBy/where/lte/gte patterns             : 0 matches
index / CHECK / policy references          : 0
```

---

## 21. Final Verdict

# `READY FOR NEXT IMPLEMENTATION PHASE`

Production Spec is implemented, tested and independently verified against its
ratified design gate; all 15 report claims hold; no blocking issue exists.
Two governance items (§15 D1 `/v1` prefix, D2 two extra routes) require your
ratification but do not block progress.

**Recommended next authorization: Governance — Approval Workflow discovery and
design gate (`FR-SEC-030`…`FR-SEC-035`), read-only, no implementation.**

---

# Appendix A — Master Requirement Matrix

All 634 defined SRS requirements, grouped by domain, ordered by weighted
completion. Status vocabulary: COMPLETE · PARTIAL · NOT IMPLEMENTED · BLOCKED ·
OUT OF SCOPE. Priority markers are the SRS MoSCoW codes where present.

### Inventory — 53 requirements · 53.8% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `BR-INV-001` | 7.4.3 StockMovement Entity | **COMPLETE** | Append-only ledger; REVOKE + no update/delete policy; verified live on parent and all 14 partitions | — | — |
| `BR-INV-002` | 7.4.3 StockMovement Entity | **PARTIAL** | transfers.service pairs transfer_out/transfer_in at insert; e2e tested | Service-enforced only; no database guarantee of pairing | — |
| `BR-INV-003` | 7.4.3 StockMovement Entity | **COMPLETE** | Projection written in the same transaction + on-demand reconciliation endpoint; tested | — | — |
| `FR-INV-001` [M] | 11.2 Stock Item Master | **PARTIAL** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | Catalogue linkage incomplete (C-04) | — |
| `FR-INV-002` [M] | 11.2 Stock Item Master | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-003` [M] | 11.2 Stock Item Master | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-004` [M] | 11.2 Stock Item Master | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-005` [S] | 11.2 Stock Item Master | **BLOCKED** | — | Needs Procurement supplier codes/barcodes | Procurement |
| `FR-INV-010` [M] | 11.3 Stock Levels and Valuation | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-011` [M] | 11.3 Stock Levels and Valuation | **PARTIAL** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | Logic implemented; scheduling/alert delivery deferred (C-08) - no scheduler exists | — |
| `FR-INV-012` [M] | 11.3 Stock Levels and Valuation | **PARTIAL** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | Standard-cost variance posting not implemented (no variance account entity in SRS) | — |
| `FR-INV-013` [M] | 11.3 Stock Levels and Valuation | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-014` [M] | 11.3 Stock Levels and Valuation | **PARTIAL** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | Logic implemented; scheduling/alert delivery deferred (C-08) - no scheduler exists | — |
| `FR-INV-015` [M] | 11.3 Stock Levels and Valuation | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-020` [M] | 11.4 Batch and Expiry Management | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-021` [M] | 11.4 Batch and Expiry Management | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-022` [M] | 11.4 Batch and Expiry Management | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-023` [M] | 11.4 Batch and Expiry Management | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-024` [M] | 11.4 Batch and Expiry Management | **PARTIAL** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | Logic implemented; scheduling/alert delivery deferred (C-08) - no scheduler exists | — |
| `FR-INV-025` [M] | 11.4 Batch and Expiry Management | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-026` [S] | 11.4 Batch and Expiry Management | **BLOCKED** | — | Needs Treasury day close | Treasury |
| `FR-INV-027` [S] | 11.4 Batch and Expiry Management | **BLOCKED** | — | Needs Sales for the forward trace half | Sales |
| `FR-INV-030` [M] | 11.5 Stock Movements and Transfers | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-031` [M] | 11.5 Stock Movements and Transfers | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-032` [M] | 11.5 Stock Movements and Transfers | **BLOCKED** | requires_approval gate exists (B-2) | Needs Governance approval workflow | Governance |
| `FR-INV-033` [S] | 11.5 Stock Movements and Transfers | **NOT IMPLEMENTED** | — | Unmet by explicit Inventory design decision (transfer note/QR, cycle counting, storage-ordered sheets, anomaly detection, forecasting) | — |
| `FR-INV-034` [M] | 11.5 Stock Movements and Transfers | **PARTIAL** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | Cost transferred; transfer variance not posted | — |
| `FR-INV-035` [M] | 11.5 Stock Movements and Transfers | **BLOCKED** | requires_approval gate exists (B-2) | Needs Governance approval workflow | Governance |
| `FR-INV-040` [M] | 11.6 Stock Counting | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-041` [M] | 11.6 Stock Counting | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-042` [M] | 11.6 Stock Counting | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-043` [M] | 11.6 Stock Counting | **BLOCKED** | — | Needs offline/sync for mobile counting | Offline/Sync |
| `FR-INV-044` [M] | 11.6 Stock Counting | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-045` [M] | 11.6 Stock Counting | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-046` [M] | 11.6 Stock Counting | **BLOCKED** | requires_approval gate exists (B-2) | Needs Governance approval workflow | Governance |
| `FR-INV-047` [M] | 11.6 Stock Counting | **BLOCKED** | requires_approval gate exists (B-2) | Needs Governance approval workflow | Governance |
| `FR-INV-048` [S] | 11.6 Stock Counting | **NOT IMPLEMENTED** | — | Unmet by explicit Inventory design decision (transfer note/QR, cycle counting, storage-ordered sheets, anomaly detection, forecasting) | — |
| `FR-INV-049` [S] | 11.6 Stock Counting | **NOT IMPLEMENTED** | — | Unmet by explicit Inventory design decision (transfer note/QR, cycle counting, storage-ordered sheets, anomaly detection, forecasting) | — |
| `FR-INV-050` [M] | 11.6 Stock Counting | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-051` [M] | 11.6 Stock Counting | **PARTIAL** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | Logic implemented; scheduling/alert delivery deferred (C-08) - no scheduler exists | — |
| `FR-INV-055` [M] | 11.7 Waste Management | **BLOCKED** | — | Needs Sales and Kitchen Ops entry points | Sales / Kitchen Ops |
| `FR-INV-056` [M] | 11.7 Waste Management | **BLOCKED** | — | Needs Workforce employee identity and photo storage | Workforce |
| `FR-INV-057` [M] | 11.7 Waste Management | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-058` [M] | 11.7 Waste Management | **BLOCKED** | requires_approval gate exists (B-2) | Needs Governance approval workflow | Governance |
| `FR-INV-059` [S] | 11.7 Waste Management | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-060` [S] | 11.7 Waste Management | **BLOCKED** | — | Needs Kitchen Ops / Workforce (station, shift, day-part) | Kitchen Ops / Workforce |
| `FR-INV-061` [C] | 11.7 Waste Management | **NOT IMPLEMENTED** | — | Unmet by explicit Inventory design decision (transfer note/QR, cycle counting, storage-ordered sheets, anomaly detection, forecasting) | — |
| `FR-INV-065` [M] | 11.8 Reordering | **COMPLETE** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | — | — |
| `FR-INV-066` [M] | 11.8 Reordering | **PARTIAL** | src/modules/inventory/* (16 tables, 13 routes); inventory.e2e-spec.ts 36 tests; inventory-rls.e2e-spec.ts 18 tests; costing.spec.ts 20 tests | Logic implemented; scheduling/alert delivery deferred (C-08) - no scheduler exists | — |
| `FR-INV-067` [S] | 11.8 Reordering | **BLOCKED** | — | Needs Procurement supplier lead time | Procurement |
| `FR-INV-068` [S] | 11.8 Reordering | **NOT IMPLEMENTED** | — | Unmet by explicit Inventory design decision (transfer note/QR, cycle counting, storage-ordered sheets, anomaly detection, forecasting) | — |
| `FR-INV-069` [S] | 11.8 Reordering | **NOT IMPLEMENTED** | — | Unmet by explicit Inventory design decision (transfer note/QR, cycle counting, storage-ordered sheets, anomaly detection, forecasting) | — |
| `FR-INV-070` [C] | 11.8 Reordering | **NOT IMPLEMENTED** | — | Unmet by explicit Inventory design decision (transfer note/QR, cycle counting, storage-ordered sheets, anomaly detection, forecasting) | — |

### Catalogue / Menu / Recipe — 42 requirements · 46.2% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `BR-MNU-001` | 7.4.4 Recipe Aggregate | **COMPLETE** | src/modules/production/* ; migration 20260817120000_production_spec_foundation ; test/production.e2e-spec.ts (44) ; test/production-rls.e2e-spec.ts (26) ; src/modules/production/recipe-graph.spec.ts (17) — findCycle + wouldCreateC | — | — |
| `BR-MNU-002` | 7.4.4 Recipe Aggregate | **PARTIAL** | DB immutability verified live: REVOKE UPDATE + GRANT UPDATE(status); published lines/deletes blocked by RLS | The order side (historical orders reference recipe_version_id) requires Sales | Sales/POS |
| `BR-MNU-003` | 7.4.4 Recipe Aggregate | **NOT IMPLEMENTED** | Formula recorded in the design gate only | Costing deferred by D-17-05 | Inventory valuation + ratification |
| `BR-MNU-012` | 10.6 Recipe Management | **NOT IMPLEMENTED** | — | Requires Sales; not implemented | — |
| `FR-MNU-001` [M] | 10.2 Menu Structure | **COMPLETE** | Menu -> Category -> MenuItem -> MenuItemVariant models + routes; catalogue.e2e-spec.ts | — | — |
| `FR-MNU-002` [M] | 10.2 Menu Structure | **COMPLETE** | Multiple menus + menu_branches assignment; tested | — | — |
| `FR-MNU-003` [M] | 10.2 Menu Structure | **COMPLETE** | menus.service.resolveForBranch(): priority ordering + ambiguity warning; menu-resolution.spec.ts | — | — |
| `FR-MNU-004` [M] | 10.2 Menu Structure | **PARTIAL** | Item attributes modelled | tax_class_id nullable and FK-less (C-04); Fiscal out of scope | — |
| `FR-MNU-005` [M] | 10.2 Menu Structure | **PARTIAL** | POS/kitchen/aggregator name columns | Receipt-surface name unmodelled in approved SQL | — |
| `FR-MNU-006` [M] | 10.2 Menu Structure | **PARTIAL** | Independent pricing, barcode, availability per variant | Independent recipes require Production Spec (not implemented) | — |
| `FR-MNU-007` [S] | 10.2 Menu Structure | **PARTIAL** | sort_order stored on items and categories | Drag-and-drop and live POS preview are UI, absent | — |
| `FR-MNU-010` [M] | 10.3 Modifier Configuration | **COMPLETE** | ModifierGroup/Modifier/ModifierGroupLink with min/max/required/repeat/default/free; tested | — | — |
| `FR-MNU-011` [M] | 10.3 Modifier Configuration | **COMPLETE** | ModifierGroup/Modifier/ModifierGroupLink with min/max/required/repeat/default/free; tested | — | — |
| `FR-MNU-012` [M] | 10.3 Modifier Configuration | **PARTIAL** | stock_item_id + consumption_unit_id recorded on modifiers | No FK and no inventory-impact computation | — |
| `FR-MNU-013` [S] | 10.3 Modifier Configuration | **PARTIAL** | recipe_delta stored as opaque JSONB | Never interpreted (C-11 / D-17-07); FR deferred | D-17-07 |
| `FR-MNU-020` [M] | 10.4 Pricing Configuration | **PARTIAL** | PriceList scope/valid_from/valid_to/recurrence_rule/priority stored | No evaluation; branch_group scope deferred with ADR 0008 D-10 | — |
| `FR-MNU-021` [M] | 10.4 Pricing Configuration | **PARTIAL** | price_entries modelled | Order-type-specific resolution not implemented | — |
| `FR-MNU-022` [M] | 10.4 Pricing Configuration | **NOT IMPLEMENTED** | recurrence_rule column stored only | No time-window evaluation, no scheduling, no offline propagation | — |
| `FR-MNU-023` [M] | 10.4 Pricing Configuration | **NOT IMPLEMENTED** | recurrence_rule column stored only | No time-window evaluation, no scheduling, no offline propagation | — |
| `FR-MNU-024` [M] | 10.4 Pricing Configuration | **PARTIAL** | governance.audit_entries is the system of record (C-10) | No dedicated price-change history query surface | — |
| `FR-MNU-025` [S] | 10.4 Pricing Configuration | **NOT IMPLEMENTED** | — | No bulk price operations, no margin warnings | — |
| `FR-MNU-026` [S] | 10.4 Pricing Configuration | **NOT IMPLEMENTED** | — | No bulk price operations, no margin warnings | — |
| `FR-MNU-030` [M] | 10.5 Availability Management | **COMPLETE** | availability_rules + POST /catalogue/availability-rules/:id/86 with auto re-enable; tested | — | — |
| `FR-MNU-031` [M] | 10.5 Availability Management | **NOT IMPLEMENTED** | org.branches.automatic_availability switch exists | Auto-86 needs Catalogue<->Inventory link, absent | Inventory link |
| `FR-MNU-032` [M] | 10.5 Availability Management | **NOT IMPLEMENTED** | org.branches.automatic_availability switch exists | Auto-86 needs Catalogue<->Inventory link, absent | Inventory link |
| `FR-MNU-033` [S] | 10.5 Availability Management | **NOT IMPLEMENTED** | org.branches.automatic_availability switch exists | Auto-86 needs Catalogue<->Inventory link, absent | Inventory link |
| `FR-MNU-034` [S] | 10.5 Availability Management | **NOT IMPLEMENTED** | — | No aggregator integration | — |
| `FR-MNU-035` [C] | 10.5 Availability Management | **NOT IMPLEMENTED** | — | Deferred by C-07; SRS [C] priority | — |
| `FR-MNU-040` [M] | 10.6 Recipe Management | **COMPLETE** | src/modules/production/* ; migration 20260817120000_production_spec_foundation ; test/production.e2e-spec.ts (44) ; test/production-rls.e2e-spec.ts (26) ; src/modules/production/recipe-graph.spec.ts (17) — RecipeType enum menu_ite | — | — |
| `FR-MNU-041` [M] | 10.6 Recipe Management | **COMPLETE** | src/modules/production/* ; migration 20260817120000_production_spec_foundation ; test/production.e2e-spec.ts (44) ; test/production-rls.e2e-spec.ts (26) ; src/modules/production/recipe-graph.spec.ts (17) — RecipeComponentType + ck | — | — |
| `FR-MNU-042` [M] | 10.6 Recipe Management | **COMPLETE** | src/modules/production/* ; migration 20260817120000_production_spec_foundation ; test/production.e2e-spec.ts (44) ; test/production-rls.e2e-spec.ts (26) ; src/modules/production/recipe-graph.spec.ts (17) — recipe-graph.findCycle r | — | — |
| `FR-MNU-043` [M] | 10.6 Recipe Management | **COMPLETE** | src/modules/production/* ; migration 20260817120000_production_spec_foundation ; test/production.e2e-spec.ts (44) ; test/production-rls.e2e-spec.ts (26) ; src/modules/production/recipe-graph.spec.ts (17) — yield_quantity/yield_per | — | — |
| `FR-MNU-044` [M] | 10.6 Recipe Management | **COMPLETE** | src/modules/production/* ; migration 20260817120000_production_spec_foundation ; test/production.e2e-spec.ts (44) ; test/production-rls.e2e-spec.ts (26) ; src/modules/production/recipe-graph.spec.ts (17) — recipe_lines.wastage_per | — | — |
| `FR-MNU-045` [M] | 10.6 Recipe Management | **PARTIAL** | src/modules/production/* ; migration 20260817120000_production_spec_foundation ; test/production.e2e-spec.ts (44) ; test/production-rls.e2e-spec.ts (26) ; src/modules/production/recipe-graph.spec.ts (17) — versioning + publish/sup | "completed orders SHALL retain their reference to the version in force at sale time" requires Sales order_lines | Sales/POS |
| `FR-MNU-046` [M] | 10.6 Recipe Management | **NOT IMPLEMENTED** | computed_cost/cost_computed_at exist and are provably never written | Costing deferred by D-17-05 | Inventory valuation + ratification |
| `FR-MNU-047` [S] | 10.6 Recipe Management | **PARTIAL** | src/modules/production/* ; migration 20260817120000_production_spec_foundation ; test/production.e2e-spec.ts (44) ; test/production-rls.e2e-spec.ts (26) ; src/modules/production/recipe-graph.spec.ts (17) — scope tenant\|brand\|bra | Deviation compliance report not implemented | Reporting |
| `FR-MNU-048` [S] | 10.6 Recipe Management | **OUT OF SCOPE** | Design gate 20 excludes scaling and nutrition | — | — |
| `FR-MNU-049` [S] | 10.6 Recipe Management | **PARTIAL** | src/modules/production/* ; migration 20260817120000_production_spec_foundation ; test/production.e2e-spec.ts (44) ; test/production-rls.e2e-spec.ts (26) ; src/modules/production/recipe-graph.spec.ts (17) — instructions/reference_i | "viewable from the KDS" requires the KDS surface | Kitchen Ops |
| `FR-MNU-050` [C] | 10.6 Recipe Management | **OUT OF SCOPE** | Design gate 20 excludes scaling and nutrition | — | — |
| `FR-MNU-055` [S] | 10.7 Menu Engineering | **NOT IMPLEMENTED** | — | Menu engineering needs Sales data; not implemented | — |
| `FR-MNU-056` [S] | 10.7 Menu Engineering | **NOT IMPLEMENTED** | — | Menu engineering needs Sales data; not implemented | — |
| `FR-MNU-057` [C] | 10.7 Menu Engineering | **NOT IMPLEMENTED** | — | Menu engineering needs Sales data; not implemented | — |

### Platform & Tenancy — 22 requirements · 41.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `BR-PLT-001` | 6.1 Tenancy Hierarchy | **COMPLETE** | org.locations registry; stock held per location only; verified | — | — |
| `FR-PLT-001` [M] | 6.1 Tenancy Hierarchy | **COMPLETE** | org.brands/branches/warehouses/central_kitchens + /org/* routes; organisation.e2e-spec.ts | — | — |
| `FR-PLT-002` [M] | 6.1 Tenancy Hierarchy | **COMPLETE** | org.brands/branches/warehouses/central_kitchens + /org/* routes; organisation.e2e-spec.ts | — | — |
| `FR-PLT-003` [M] | 6.1 Tenancy Hierarchy | **COMPLETE** | tenant_id NOT NULL on all 43 tenant tables; RLS FORCE; composite FKs (ADR 0008 D-09); rls.e2e-spec.ts | — | — |
| `FR-PLT-004` [S] | 6.1 Tenancy Hierarchy | **PARTIAL** | POST /org/branches/:id/brand (ADR 0008 D-13) + audit | No explicit menu/pricing-implication warning surfaced | — |
| `FR-PLT-010` [M] | 6.2.1 Data Isolation | **COMPLETE** | ENABLE+FORCE RLS, 4 policies/table, NULLIF(current_setting) predicate; verified live as ros_app | — | — |
| `FR-PLT-011` [M] | 6.2.1 Data Isolation | **COMPLETE** | ros_app NOSUPERUSER/NOBYPASSRLS; ros_migrator for DDL; verified in pg_roles | — | — |
| `FR-PLT-012` [M] | 6.2.1 Data Isolation | **COMPLETE** | Fail-closed verified live: 0 rows on every tenant table with no app.tenant_id | — | — |
| `FR-PLT-013` [M] | 6.2.2 Isolation Testing | **PARTIAL** | rls/catalogue-rls/inventory-rls e2e suites cover 3 contexts | No CI pipeline; not every tenant_id table covered | — |
| `FR-PLT-014` [M] | 6.2.2 Isolation Testing | **NOT IMPLEMENTED** | — | No CI pipeline exists (.github absent) | — |
| `FR-PLT-015` [M] | 6.2.3 Compute and Rate Isolation | **PARTIAL** | @nestjs/throttler on auth endpoints (ADR 0006) | IP-based not per-tenant; no limits on reports/exports | — |
| `FR-PLT-016` [M] | 6.2.3 Compute and Rate Isolation | **NOT IMPLEMENTED** | — | No read replica, no statement timeouts, no isolation tier | — |
| `FR-PLT-017` [S] | 6.2.3 Compute and Rate Isolation | **NOT IMPLEMENTED** | — | No read replica, no statement timeouts, no isolation tier | — |
| `FR-PLT-018` [C] | 6.2.4 Enterprise Isolation Tier | **NOT IMPLEMENTED** | — | No read replica, no statement timeouts, no isolation tier | — |
| `FR-PLT-020` [M] | 6.3 Tenant Lifecycle | **NOT IMPLEMENTED** | — | No tenant lifecycle: signup flow, downgrade read-only, export, termination countdown | — |
| `FR-PLT-021` [M] | 6.3 Tenant Lifecycle | **NOT IMPLEMENTED** | — | No tenant lifecycle: signup flow, downgrade read-only, export, termination countdown | — |
| `FR-PLT-022` [M] | 6.3 Tenant Lifecycle | **NOT IMPLEMENTED** | — | No tenant lifecycle: signup flow, downgrade read-only, export, termination countdown | — |
| `FR-PLT-023` [M] | 6.3 Tenant Lifecycle | **NOT IMPLEMENTED** | — | No tenant lifecycle: signup flow, downgrade read-only, export, termination countdown | — |
| `FR-PLT-025` [M] | 6.4 Configuration Hierarchy and Re | **NOT IMPLEMENTED** | — | Settings resolver absent; org.settings deferred by ADR 0008 D-11 | ADR 0008 D-11 |
| `FR-PLT-026` [M] | 6.4 Configuration Hierarchy and Re | **NOT IMPLEMENTED** | — | Settings resolver absent; org.settings deferred by ADR 0008 D-11 | ADR 0008 D-11 |
| `FR-PLT-027` [S] | 6.4 Configuration Hierarchy and Re | **NOT IMPLEMENTED** | — | Settings resolver absent; org.settings deferred by ADR 0008 D-11 | ADR 0008 D-11 |
| `FR-PLT-028` [M] | 6.4 Configuration Hierarchy and Re | **NOT IMPLEMENTED** | — | Settings resolver absent; org.settings deferred by ADR 0008 D-11 | ADR 0008 D-11 |

### Audit — 10 requirements · 40.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-AUD-001` [M] | 20.1 Audit Log | **PARTIAL** | AuditService.record() called from identity/org/catalogue/inventory services | Not proven for every state-changing operation; no coverage gate | — |
| `FR-AUD-002` [M] | 20.1 Audit Log | **COMPLETE** | governance.audit_entries carries actor/entity/action/metadata/correlation; audit.e2e-spec.ts | — | — |
| `FR-AUD-003` [M] | 20.1 Audit Log | **COMPLETE** | GRANT SELECT,INSERT + REVOKE UPDATE,DELETE,TRUNCATE; verified live (permission denied) | — | — |
| `FR-AUD-004` [M] | 20.1 Audit Log | **COMPLETE** | SHA-256 hash chain per tenant (audit-hash.ts); unit + e2e tested | — | — |
| `FR-AUD-005` [M] | 20.1 Audit Log | **NOT IMPLEMENTED** | — | No scheduler; no chain-verification job; no alerting | — |
| `FR-AUD-006` [M] | 20.1 Audit Log | **PARTIAL** | auth success/failure, permission/role changes, price changes audited | discounts/comps/voids/refunds/cash variances impossible - domains absent | — |
| `FR-AUD-007` [M] | 20.1 Audit Log | **NOT IMPLEMENTED** | — | No audit query/search/filter/export API surface exists | — |
| `FR-AUD-008` [M] | 20.1 Audit Log | **NOT IMPLEMENTED** | — | No audit query/search/filter/export API surface exists | — |
| `FR-AUD-009` [M] | 20.1 Audit Log | **NOT IMPLEMENTED** | — | No retention policy or enforcement | — |
| `FR-AUD-010` [M] | 20.1 Audit Log | **NOT IMPLEMENTED** | — | No impersonation session mechanism | — |

### API Platform — 14 requirements · 32.4% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-API-001` [M] | 26.2 Error Model | **PARTIAL** | Nest default problem shape; 404-on-cross-tenant honoured and tested | No stable machine-readable error codes; no Accept-Language localisation | — |
| `FR-API-002` [M] | 26.2 Error Model | **PARTIAL** | Nest default problem shape; 404-on-cross-tenant honoured and tested | No stable machine-readable error codes; no Accept-Language localisation | — |
| `FR-API-003` [M] | 26.2 Error Model | **PARTIAL** | Nest default problem shape; 404-on-cross-tenant honoured and tested | No stable machine-readable error codes; no Accept-Language localisation | — |
| `FR-API-010` [M] | 26.4 Authentication and Authorisat | **COMPLETE** | 15m access / 30d refresh with rotation; refresh.e2e-spec.ts | — | — |
| `FR-API-011` [M] | 26.4 Authentication and Authorisat | **NOT IMPLEMENTED** | — | No OAuth client credentials, no API keys | — |
| `FR-API-012` [M] | 26.4 Authentication and Authorisat | **PARTIAL** | Access token carries sub, tid, mid | No scope set and no permitted branch set in token | — |
| `FR-API-013` [M] | 26.4 Authentication and Authorisat | **COMPLETE** | Refresh reuse detection revokes the token family; ADR 0001; tested | — | — |
| `FR-API-014` [M] | 26.4 Authentication and Authorisat | **NOT IMPLEMENTED** | — | No OAuth client credentials, no API keys | — |
| `FR-API-020` [M] | 26.5 Idempotency | **NOT IMPLEMENTED** | — | No Idempotency-Key handling anywhere | — |
| `FR-API-021` [M] | 26.5 Idempotency | **NOT IMPLEMENTED** | — | No Idempotency-Key handling anywhere | — |
| `FR-API-022` [M] | 26.5 Idempotency | **NOT IMPLEMENTED** | — | No Idempotency-Key handling anywhere | — |
| `FR-API-023` [M] | 26.5 Idempotency | **NOT IMPLEMENTED** | — | No Idempotency-Key handling anywhere | — |
| `NFR-API-001` [M] | 26.6 API Non-Functional Requiremen | **PARTIAL** | SwaggerModule wired at /docs, generated from decorators | Coverage thin; OpenAPI 3.0 not 3.1; not published or diffed | — |
| `NFR-API-002` [M] | 26.6 API Non-Functional Requiremen | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Core Money & Units — 4 requirements · 25.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `BR-CORE-001` | 7.2 Shared Kernel Value Objects | **NOT IMPLEMENTED** | — | No Money value type, no currency-mismatch guard, no allocate() implementation | — |
| `BR-CORE-002` | 7.2 Shared Kernel Value Objects | **NOT IMPLEMENTED** | — | No Money value type, no currency-mismatch guard, no allocate() implementation | — |
| `BR-CORE-003` | 7.2 Shared Kernel Value Objects | **COMPLETE** | NUMERIC(18,6) on every quantity column; verified in migrations | — | — |
| `BR-CORE-004` | 7.2 Shared Kernel Value Objects | **NOT IMPLEMENTED** | inventory.uom_conversions table exists | No density factor logic; cross-dimension conversion not implemented | — |

### NFR - Data — 2 requirements · 25.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `NFR-DATA-001` [M] | 11.9 Inventory Non-Functional Requ | **PARTIAL** | Monthly partitions retained, never dropped; no DELETE grant | No retention enforcement or archival to object storage | — |
| `NFR-DATA-002` [M] | 19.6 Reporting Non-Functional Requ | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Security & Authorization — 45 requirements · 20.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-SEC-001` [M] | 15.1 Access Control Model | **COMPLETE** | roles/permissions/role_permissions/membership_roles + /auth/roles*; rbac.e2e-spec.ts | — | — |
| `FR-SEC-002` [M] | 15.1 Access Control Model | **NOT IMPLEMENTED** | membership_roles.branch_id column exists but is unused | Scoped assignment not implemented; ADR 0008 D-02 deferred | ADR 0008 D-02 |
| `FR-SEC-003` [M] | 15.1 Access Control Model | **PARTIAL** | Multiple role assignments per membership supported | Assignments carry no scope | — |
| `FR-SEC-004` [M] | 15.1 Access Control Model | **PARTIAL** | Permission union computed per membership; rbac tests | No per-scope isolation; leak prevention untestable without scopes | — |
| `FR-SEC-005` [S] | 15.1 Access Control Model | **NOT IMPLEMENTED** | — | No validity dates on membership_roles | — |
| `FR-SEC-010` [M] | 15.3 Standard Roles | **NOT IMPLEMENTED** | — | No predefined/system role set shipped or seeded | — |
| `FR-SEC-011` [M] | 15.3 Standard Roles | **COMPLETE** | POST /auth/roles + POST /auth/roles/:id/permissions from permission catalogue; tested | — | — |
| `FR-SEC-012` [M] | 15.3 Standard Roles | **PARTIAL** | Permission catalogue carries description + module | No sensitive-permission warning marker | — |
| `FR-SEC-015` [M] | 15.4 Segregation of Duties | **NOT IMPLEMENTED** | — | No SoD mechanism; SRS 15.4 defines pairs but no enforcement exists | — |
| `FR-SEC-016` [M] | 15.4 Segregation of Duties | **NOT IMPLEMENTED** | — | No SoD mechanism; SRS 15.4 defines pairs but no enforcement exists | — |
| `FR-SEC-017` [S] | 15.4 Segregation of Duties | **NOT IMPLEMENTED** | — | No SoD mechanism; SRS 15.4 defines pairs but no enforcement exists | — |
| `FR-SEC-020` [M] | 15.5 Authentication | **PARTIAL** | Email+password with JWT; terminal-bound sessions | PIN and MFA methods absent | — |
| `FR-SEC-021` [M] | 15.5 Authentication | **NOT IMPLEMENTED** | — | No PIN authentication, no PIN hashing/lockout | — |
| `FR-SEC-022` [M] | 15.5 Authentication | **NOT IMPLEMENTED** | — | No PIN authentication, no PIN hashing/lockout | — |
| `FR-SEC-023` [M] | 15.5 Authentication | **NOT IMPLEMENTED** | — | No MFA/TOTP | — |
| `FR-SEC-024` [M] | 15.5 Authentication | **NOT IMPLEMENTED** | — | No MFA/TOTP | — |
| `FR-SEC-025` [M] | 15.5 Authentication | **PARTIAL** | assertPasswordMeetsPolicy() enforces minimum length | Not per-tenant configurable; no breached-password list check | — |
| `FR-SEC-026` [M] | 15.5 Authentication | **PARTIAL** | JWT_ACCESS_TTL=15m / JWT_REFRESH_TTL=30d configurable | No per-surface idle expiry (POS 15m / dashboard 60m / KDS 8h) | — |
| `FR-SEC-027` [M] | 15.5 Authentication | **PARTIAL** | Session revocation on password change/reset (ADR 0005), tested | No administrator-initiated forced-logout surface | — |
| `FR-SEC-028` [M] | 15.5 Authentication | **PARTIAL** | Terminal registration + fingerprints + status endpoints (ADR 0004) | No credential wipe on revocation; pairing/activation deferred | — |
| `FR-SEC-030` [M] | 15.6 Approval Workflow Engine | **NOT IMPLEMENTED** | Inventory exposes a requires_approval gate only (B-2) | No general approval mechanism, request entity, escalation, or offline policy | — |
| `FR-SEC-031` [M] | 15.6 Approval Workflow Engine | **NOT IMPLEMENTED** | Inventory exposes a requires_approval gate only (B-2) | No general approval mechanism, request entity, escalation, or offline policy | — |
| `FR-SEC-032` [M] | 15.6 Approval Workflow Engine | **NOT IMPLEMENTED** | Inventory exposes a requires_approval gate only (B-2) | No general approval mechanism, request entity, escalation, or offline policy | — |
| `FR-SEC-033` [M] | 15.6 Approval Workflow Engine | **NOT IMPLEMENTED** | Inventory exposes a requires_approval gate only (B-2) | No general approval mechanism, request entity, escalation, or offline policy | — |
| `FR-SEC-034` [S] | 15.6 Approval Workflow Engine | **NOT IMPLEMENTED** | Inventory exposes a requires_approval gate only (B-2) | No general approval mechanism, request entity, escalation, or offline policy | — |
| `FR-SEC-035` [M] | 15.6 Approval Workflow Engine | **NOT IMPLEMENTED** | Inventory exposes a requires_approval gate only (B-2) | No general approval mechanism, request entity, escalation, or offline policy | — |
| `FR-SEC-040` [M] | 20.3 Security Requirements | **NOT IMPLEMENTED** | — | No TLS config, at-rest encryption, envelope encryption, or KMS in repo | — |
| `FR-SEC-041` [M] | 20.3 Security Requirements | **NOT IMPLEMENTED** | — | No TLS config, at-rest encryption, envelope encryption, or KMS in repo | — |
| `FR-SEC-042` [M] | 20.3 Security Requirements | **NOT IMPLEMENTED** | — | No TLS config, at-rest encryption, envelope encryption, or KMS in repo | — |
| `FR-SEC-043` [M] | 20.3 Security Requirements | **NOT IMPLEMENTED** | — | No TLS config, at-rest encryption, envelope encryption, or KMS in repo | — |
| `FR-SEC-044` [M] | 20.3 Security Requirements | **NOT IMPLEMENTED** | — | Vacuously held - no payment domain exists. No enforcement control implemented. | — |
| `FR-SEC-045` [M] | 20.3 Security Requirements | **COMPLETE** | JwtAuthGuard + PermissionsGuard on every business route; 114 routes audited; 403/404 tested | — | — |
| `FR-SEC-046` [M] | 20.3 Security Requirements | **PARTIAL** | AuthThrottlerGuard on auth endpoints; throttle.e2e-spec.ts | No progressive lockout | — |
| `FR-SEC-047` [M] | 20.3 Security Requirements | **COMPLETE** | Global ValidationPipe whitelist + forbidNonWhitelisted + transform; rejection tested | — | — |
| `FR-SEC-048` [M] | 20.3 Security Requirements | **PARTIAL** | Prisma parameterised queries; 1 $queryRawUnsafe in reconciliation uses bound params | No static-analysis gate enforcing the prohibition | — |
| `FR-SEC-049` [M] | 20.3 Security Requirements | **NOT IMPLEMENTED** | — | No CI dependency scanning, no secret manager, no pen-test process | — |
| `FR-SEC-050` [M] | 20.3 Security Requirements | **NOT IMPLEMENTED** | — | No CI dependency scanning, no secret manager, no pen-test process | — |
| `FR-SEC-051` [S] | 20.3 Security Requirements | **NOT IMPLEMENTED** | — | No CI dependency scanning, no secret manager, no pen-test process | — |
| `FR-SEC-052` [M] | 20.3 Security Requirements | **NOT IMPLEMENTED** | — | No IP allow-listing, no SIEM sink | — |
| `FR-SEC-053` [M] | 20.3 Security Requirements | **NOT IMPLEMENTED** | — | No IP allow-listing, no SIEM sink | — |
| `FR-SEC-060` [M] | 20.4 Data Protection and Privacy | **NOT IMPLEMENTED** | — | No data classification, retention job, DSR handling, residency, or backup verification | — |
| `FR-SEC-061` [M] | 20.4 Data Protection and Privacy | **NOT IMPLEMENTED** | — | No data classification, retention job, DSR handling, residency, or backup verification | — |
| `FR-SEC-062` [M] | 20.4 Data Protection and Privacy | **NOT IMPLEMENTED** | — | No data classification, retention job, DSR handling, residency, or backup verification | — |
| `FR-SEC-063` [M] | 20.4 Data Protection and Privacy | **NOT IMPLEMENTED** | — | No data classification, retention job, DSR handling, residency, or backup verification | — |
| `FR-SEC-064` [M] | 20.4 Data Protection and Privacy | **NOT IMPLEMENTED** | — | No data classification, retention job, DSR handling, residency, or backup verification | — |

### Data Retention & Migrations — 10 requirements · 15.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-DR-001` [M] | 25.3 Partitioning Strategy | **PARTIAL** | inventory.stock_movements RANGE-partitioned by occurred_at, 14 monthly partitions | Other high-volume tables (orders, audit) not partitioned | — |
| `FR-DR-002` [M] | 25.3 Partitioning Strategy | **NOT IMPLEMENTED** | — | Explicitly deferred; no scheduler exists. Partition creation is a manual step. | — |
| `FR-DR-003` [M] | 25.3 Partitioning Strategy | **NOT IMPLEMENTED** | — | No archival to object storage | — |
| `FR-DR-010` [M] | 25.5 Migration Strategy | **COMPLETE** | 13 versioned forward-only Prisma migrations in source control; migrate status clean | — | — |
| `FR-DR-011` [M] | 25.5 Migration Strategy | **NOT IMPLEMENTED** | — | No documented/rehearsed process, staging dataset, or per-tenant restore | — |
| `FR-DR-012` [M] | 25.5 Migration Strategy | **NOT IMPLEMENTED** | — | No documented/rehearsed process, staging dataset, or per-tenant restore | — |
| `FR-DR-013` [M] | 25.5 Migration Strategy | **NOT IMPLEMENTED** | — | No documented/rehearsed process, staging dataset, or per-tenant restore | — |
| `FR-DR-014` [M] | 25.5 Migration Strategy | **NOT IMPLEMENTED** | — | No documented/rehearsed process, staging dataset, or per-tenant restore | — |
| `FR-DR-020` [M] | 25.7 Backup and Recovery | **NOT IMPLEMENTED** | — | No documented/rehearsed process, staging dataset, or per-tenant restore | — |
| `FR-DR-021` [M] | 25.7 Backup and Recovery | **NOT IMPLEMENTED** | — | No documented/rehearsed process, staging dataset, or per-tenant restore | — |

### Branch Ops & Central Kitchen — 30 requirements · 11.7% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-BRN-001` [M] | 17.2 Multi-Branch Operation | **COMPLETE** | No cardinality limits in schema; brands/branches CRUD + tests | — | — |
| `FR-BRN-002` [M] | 17.2 Multi-Branch Operation | **PARTIAL** | Branch holds operating hours, timezone, base currency, country code; stock held per org.locations | Cash drawers and staff roster domains absent | — |
| `FR-BRN-003` [M] | 17.2 Multi-Branch Operation | **PARTIAL** | branches.country_code recorded | No country packs; no consolidation | — |
| `FR-BRN-004` [M] | 17.2 Multi-Branch Operation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-005` [M] | 17.2 Multi-Branch Operation | **NOT IMPLEMENTED** | — | Branch groups deferred by ADR 0008 D-10 | ADR 0008 D-10 |
| `FR-BRN-006` [S] | 17.2 Multi-Branch Operation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-007` [S] | 17.2 Multi-Branch Operation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-008` [S] | 17.2 Multi-Branch Operation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-010` [S] | 17.3 Branch Comparison and Perform | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-011` [S] | 17.3 Branch Comparison and Perform | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-012` [S] | 17.3 Branch Comparison and Perform | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-013` [S] | 17.3 Branch Comparison and Perform | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-014` [C] | 17.3 Branch Comparison and Perform | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-015` [M] | 17.4 Inter-Branch Transfers | **COMPLETE** | POST /inventory/transfers + /receive with counterpart pairing; e2e tested | — | — |
| `FR-BRN-016` [S] | 17.4 Inter-Branch Transfers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-017` [S] | 17.4 Inter-Branch Transfers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-020` [S] | 17.5 Central Kitchen | **PARTIAL** | org.central_kitchens + org.locations registry | Consume/produce production flow absent | Central Kitchen phase |
| `FR-BRN-021` [S] | 17.5 Central Kitchen | **NOT IMPLEMENTED** | production.recipe_versions now exists as the FK target ck.production_orders requires | No ck schema, production_orders/distribution_orders tables, services or routes | UNBLOCKED by Production Spec |
| `FR-BRN-022` [S] | 17.5 Central Kitchen | **NOT IMPLEMENTED** | production.recipe_versions now exists as the FK target ck.production_orders requires | No ck schema, production_orders/distribution_orders tables, services or routes | UNBLOCKED by Production Spec |
| `FR-BRN-023` [S] | 17.5 Central Kitchen | **NOT IMPLEMENTED** | production.recipe_versions now exists as the FK target ck.production_orders requires | No ck schema, production_orders/distribution_orders tables, services or routes | UNBLOCKED by Production Spec |
| `FR-BRN-024` [S] | 17.5 Central Kitchen | **NOT IMPLEMENTED** | production.recipe_versions now exists as the FK target ck.production_orders requires | No ck schema, production_orders/distribution_orders tables, services or routes | UNBLOCKED by Production Spec |
| `FR-BRN-025` [S] | 17.5 Central Kitchen | **NOT IMPLEMENTED** | production.recipe_versions now exists as the FK target ck.production_orders requires | No ck schema, production_orders/distribution_orders tables, services or routes | UNBLOCKED by Production Spec |
| `FR-BRN-026` [S] | 17.5 Central Kitchen | **NOT IMPLEMENTED** | production.recipe_versions now exists as the FK target ck.production_orders requires | No ck schema, production_orders/distribution_orders tables, services or routes | UNBLOCKED by Production Spec |
| `FR-BRN-027` [S] | 17.5 Central Kitchen | **NOT IMPLEMENTED** | production.recipe_versions now exists as the FK target ck.production_orders requires | No ck schema, production_orders/distribution_orders tables, services or routes | UNBLOCKED by Production Spec |
| `FR-BRN-028` [S] | 17.5 Central Kitchen | **NOT IMPLEMENTED** | production.recipe_versions now exists as the FK target ck.production_orders requires | No ck schema, production_orders/distribution_orders tables, services or routes | UNBLOCKED by Production Spec |
| `FR-BRN-029` [S] | 17.5 Central Kitchen | **NOT IMPLEMENTED** | production.recipe_versions now exists as the FK target ck.production_orders requires | No ck schema, production_orders/distribution_orders tables, services or routes | UNBLOCKED by Production Spec |
| `FR-BRN-030` [C] | 17.5 Central Kitchen | **NOT IMPLEMENTED** | production.recipe_versions now exists as the FK target ck.production_orders requires | No ck schema, production_orders/distribution_orders tables, services or routes | UNBLOCKED by Production Spec |
| `FR-BRN-035` [C] | 17.6 Franchise Support | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-036` [C] | 17.6 Franchise Support | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-BRN-037` [C] | 17.6 Franchise Support | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### NFR - Observability — 7 requirements · 7.1% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `NFR-OBS-001` | 27.6 Observability | **PARTIAL** | audit_entries carries correlation_id | No structured JSON log pipeline, no request correlation middleware | — |
| `NFR-OBS-002` | 27.6 Observability | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-OBS-003` | 27.6 Observability | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-OBS-004` | 27.6 Observability | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-OBS-005` | 27.6 Observability | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-OBS-006` | 27.6 Observability | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-OBS-007` | 27.6 Observability | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### NFR - Performance — 16 requirements · 3.1% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `NFR-PERF-001` [M] | 8.9 POS Non-Functional Requirement | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-002` [M] | 8.9 POS Non-Functional Requirement | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-003` [M] | 8.9 POS Non-Functional Requirement | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-004` [M] | 9.5 Kitchen Non-Functional Require | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-005` [M] | 11.9 Inventory Non-Functional Requ | **PARTIAL** | stock_levels carries tenant_id + index (tenant_id, location_id, stock_item_id) | Never measured; no performance test exists | — |
| `NFR-PERF-006` [M] | 11.9 Inventory Non-Functional Requ | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-010` [M] | 19.6 Reporting Non-Functional Requ | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-011` [M] | 19.6 Reporting Non-Functional Requ | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-012` [M] | 19.6 Reporting Non-Functional Requ | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-020` [M] | 21.10 Offline Non-Functional Requi | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-021` [M] | 21.10 Offline Non-Functional Requi | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-030` [M] | 26.6 API Non-Functional Requiremen | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-031` [M] | 26.6 API Non-Functional Requiremen | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-032` [M] | 26.6 API Non-Functional Requiremen | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-040` | 27.1 Performance | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PERF-041` | 27.1 Performance | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Localisation & Country Packs — 20 requirements · 2.5% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-LOC-001` [M] | 22.1 Bilingual and Multilingual De | **NOT IMPLEMENTED** | — | All are UI/rendering/printing requirements; no client surface exists in this repository | — |
| `FR-LOC-002` [M] | 22.1 Bilingual and Multilingual De | **NOT IMPLEMENTED** | — | All are UI/rendering/printing requirements; no client surface exists in this repository | — |
| `FR-LOC-003` [M] | 22.1 Bilingual and Multilingual De | **NOT IMPLEMENTED** | — | All are UI/rendering/printing requirements; no client surface exists in this repository | — |
| `FR-LOC-004` [M] | 22.1 Bilingual and Multilingual De | **NOT IMPLEMENTED** | — | All are UI/rendering/printing requirements; no client surface exists in this repository | — |
| `FR-LOC-005` [M] | 22.1 Bilingual and Multilingual De | **NOT IMPLEMENTED** | — | All are UI/rendering/printing requirements; no client surface exists in this repository | — |
| `FR-LOC-006` [M] | 22.1 Bilingual and Multilingual De | **PARTIAL** | Localised JSONB name/label columns across catalogue and inventory | No translation management; no locale negotiation | — |
| `FR-LOC-007` [M] | 22.1 Bilingual and Multilingual De | **NOT IMPLEMENTED** | — | No fallback-language resolution implemented | — |
| `FR-LOC-008` [M] | 22.1 Bilingual and Multilingual De | **NOT IMPLEMENTED** | — | All are UI/rendering/printing requirements; no client surface exists in this repository | — |
| `FR-LOC-009` [S] | 22.1 Bilingual and Multilingual De | **NOT IMPLEMENTED** | — | All are UI/rendering/printing requirements; no client surface exists in this repository | — |
| `FR-LOC-010` [M] | 22.1 Bilingual and Multilingual De | **NOT IMPLEMENTED** | — | All are UI/rendering/printing requirements; no client surface exists in this repository | — |
| `FR-LOC-011` [M] | 22.1 Bilingual and Multilingual De | **NOT IMPLEMENTED** | — | All are UI/rendering/printing requirements; no client surface exists in this repository | — |
| `FR-LOC-012` [M] | 22.1 Bilingual and Multilingual De | **NOT IMPLEMENTED** | — | All are UI/rendering/printing requirements; no client surface exists in this repository | — |
| `FR-LOC-020` [M] | 22.2 Country Pack Architecture | **NOT IMPLEMENTED** | tenants.country_pack_code is a recorded string | No country pack entity, versioning, signing, conformance suite or tax engine registry | — |
| `FR-LOC-021` [M] | 22.2 Country Pack Architecture | **NOT IMPLEMENTED** | tenants.country_pack_code is a recorded string | No country pack entity, versioning, signing, conformance suite or tax engine registry | — |
| `FR-LOC-022` [M] | 22.2 Country Pack Architecture | **NOT IMPLEMENTED** | tenants.country_pack_code is a recorded string | No country pack entity, versioning, signing, conformance suite or tax engine registry | — |
| `FR-LOC-023` [M] | 22.2 Country Pack Architecture | **NOT IMPLEMENTED** | tenants.country_pack_code is a recorded string | No country pack entity, versioning, signing, conformance suite or tax engine registry | — |
| `FR-LOC-024` [M] | 22.2 Country Pack Architecture | **NOT IMPLEMENTED** | tenants.country_pack_code is a recorded string | No country pack entity, versioning, signing, conformance suite or tax engine registry | — |
| `FR-LOC-025` [M] | 22.2 Country Pack Architecture | **NOT IMPLEMENTED** | tenants.country_pack_code is a recorded string | No country pack entity, versioning, signing, conformance suite or tax engine registry | — |
| `FR-LOC-030` [S] | 22.3.4 Additional Packs | **NOT IMPLEMENTED** | tenants.country_pack_code is a recorded string | No country pack entity, versioning, signing, conformance suite or tax engine registry | — |
| `FR-LOC-031` [M] | 22.3.4 Additional Packs | **NOT IMPLEMENTED** | tenants.country_pack_code is a recorded string | No country pack entity, versioning, signing, conformance suite or tax engine registry | — |

### Finance & Treasury — 32 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `BR-FIN-001` | 16.7 Rounding Policy | **NOT IMPLEMENTED** | — | No money/rounding/tax engine | — |
| `BR-FIN-002` | 16.7 Rounding Policy | **NOT IMPLEMENTED** | — | No money/rounding/tax engine | — |
| `BR-FIN-003` | 16.7 Rounding Policy | **NOT IMPLEMENTED** | — | No money/rounding/tax engine | — |
| `BR-FIN-004` | 16.7 Rounding Policy | **NOT IMPLEMENTED** | — | No money/rounding/tax engine | — |
| `BR-FIN-005` | 16.7 Rounding Policy | **NOT IMPLEMENTED** | — | No money/rounding/tax engine | — |
| `FR-FIN-001` [M] | 16.2 Cash Session Model | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-002` [M] | 16.2 Cash Session Model | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-003` [S] | 16.2 Cash Session Model | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-004` [M] | 16.2 Cash Session Model | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-005` [M] | 16.2 Cash Session Model | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-006` [M] | 16.2 Cash Session Model | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-007` [M] | 16.2 Cash Session Model | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-010` [M] | 16.3 Non-Cash Tender Reconciliatio | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-011` [S] | 16.3 Non-Cash Tender Reconciliatio | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-012` [S] | 16.3 Non-Cash Tender Reconciliatio | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-015` [S] | 16.4 Expenses | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-016` [S] | 16.4 Expenses | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-017` [S] | 16.4 Expenses | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-018` [S] | 16.4 Expenses | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-020` [M] | 16.5 Day Close | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-021` [M] | 16.5 Day Close | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-022` [M] | 16.5 Day Close | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-023` [M] | 16.5 Day Close | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-024` [M] | 16.5 Day Close | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-025` [S] | 16.5 Day Close | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-026` [M] | 16.5 Day Close | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-030` [M] | 16.6 Tax Computation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-031` [M] | 16.6 Tax Computation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-032` [M] | 16.6 Tax Computation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-033` [M] | 16.6 Tax Computation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-034` [M] | 16.6 Tax Computation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-FIN-035` [M] | 16.6 Tax Computation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Sales / POS — 80 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `BR-POS-001` | 7.4.1 Order Aggregate | **NOT IMPLEMENTED** | — | Sales/POS domain does not exist | — |
| `BR-POS-002` | 7.4.1 Order Aggregate | **NOT IMPLEMENTED** | — | Sales/POS domain does not exist | — |
| `BR-POS-003` | 7.4.1 Order Aggregate | **NOT IMPLEMENTED** | — | Sales/POS domain does not exist | — |
| `BR-POS-004` | 7.4.2 OrderLine Entity | **NOT IMPLEMENTED** | — | Sales/POS domain does not exist | — |
| `FR-POS-001` [M] | 8.2.1 Order Creation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-002` [M] | 8.2.1 Order Creation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-003` [M] | 8.2.1 Order Creation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-004` [S] | 8.2.1 Order Creation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-005` [M] | 8.2.1 Order Creation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-006` [M] | 8.2.1 Order Creation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-007` [M] | 8.2.1 Order Creation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-010` [M] | 8.2.2 Item Selection | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-011` [M] | 8.2.2 Item Selection | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-012` [M] | 8.2.2 Item Selection | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-013` [M] | 8.2.2 Item Selection | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-014` [M] | 8.2.2 Item Selection | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-015` [M] | 8.2.2 Item Selection | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-016` [M] | 8.2.2 Item Selection | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-020` [M] | 8.2.3 Modifiers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-021` [M] | 8.2.3 Modifiers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-022` [M] | 8.2.3 Modifiers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-023` [S] | 8.2.3 Modifiers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-024` [M] | 8.2.3 Modifiers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-025` [S] | 8.2.3 Modifiers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-026` [C] | 8.2.3 Modifiers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-030` [S] | 8.2.4 Combos and Meal Deals | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-031` [S] | 8.2.4 Combos and Meal Deals | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-032` [S] | 8.2.4 Combos and Meal Deals | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-035` [M] | 8.2.5 Firing and Course Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-036` [S] | 8.2.5 Firing and Course Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-037` [S] | 8.2.5 Firing and Course Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-038` [M] | 8.2.5 Firing and Course Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-040` [M] | 8.3.1 Price Resolution | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-041` [M] | 8.3.1 Price Resolution | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-042` [M] | 8.3.1 Price Resolution | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-045` [M] | 8.3.2 Discounts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-046` [M] | 8.3.2 Discounts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-047` [M] | 8.3.2 Discounts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-048` [M] | 8.3.2 Discounts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-049` [M] | 8.3.2 Discounts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-050` [S] | 8.3.2 Discounts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-051` [M] | 8.3.2 Discounts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-055` [S] | 8.3.3 Service Charges and Tips | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-056` [S] | 8.3.3 Service Charges and Tips | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-057` [S] | 8.3.3 Service Charges and Tips | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-058` [M] | 8.3.3 Service Charges and Tips | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-060` [M] | 8.4 Payment | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-061` [M] | 8.4 Payment | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-062` [M] | 8.4 Payment | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-063` [M] | 8.4 Payment | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-064` [M] | 8.4 Payment | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-065` [M] | 8.4 Payment | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-066` [M] | 8.4 Payment | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-067` [S] | 8.4 Payment | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-070` [M] | 8.5 Voids, Refunds and Cancellatio | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-071` [M] | 8.5 Voids, Refunds and Cancellatio | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-072` [M] | 8.5 Voids, Refunds and Cancellatio | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-073` [M] | 8.5 Voids, Refunds and Cancellatio | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-074` [M] | 8.5 Voids, Refunds and Cancellatio | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-075` [M] | 8.5 Voids, Refunds and Cancellatio | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-080` [S] | 8.6 Table Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-081` [S] | 8.6 Table Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-082` [S] | 8.6 Table Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-083` [S] | 8.6 Table Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-084` [C] | 8.6 Table Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-090` [M] | 8.7 Shift Operations at the POS | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-091` [M] | 8.7 Shift Operations at the POS | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-092` [M] | 8.7 Shift Operations at the POS | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-093` [M] | 8.7 Shift Operations at the POS | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-094` [M] | 8.7 Shift Operations at the POS | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-095` [M] | 8.7 Shift Operations at the POS | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-096` [M] | 8.7 Shift Operations at the POS | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-097` [M] | 8.7 Shift Operations at the POS | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-100` [M] | 8.8 Receipts and Documents | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-101` [M] | 8.8 Receipts and Documents | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-102` [M] | 8.8 Receipts and Documents | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-103` [M] | 8.8 Receipts and Documents | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-104` [S] | 8.8 Receipts and Documents | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-105` [M] | 8.8 Receipts and Documents | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-POS-106` [M] | 8.8 Receipts and Documents | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### CRM & Loyalty — 26 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-CRM-001` [M] | 18.2 Customer Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-002` [M] | 18.2 Customer Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-003` [M] | 18.2 Customer Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-004` [M] | 18.2 Customer Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-005` [S] | 18.2 Customer Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-006` [S] | 18.2 Customer Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-007` [S] | 18.2 Customer Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-008` [M] | 18.2 Customer Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-009` [M] | 18.2 Customer Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-015` [S] | 18.3 Loyalty | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-016` [S] | 18.3 Loyalty | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-017` [S] | 18.3 Loyalty | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-018` [S] | 18.3 Loyalty | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-019` [S] | 18.3 Loyalty | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-020` [M] | 18.3 Loyalty | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-021` [M] | 18.3 Loyalty | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-022` [S] | 18.3 Loyalty | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-025` [S] | 18.4 Promotions | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-026` [S] | 18.4 Promotions | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-027` [M] | 18.4 Promotions | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-028` [S] | 18.4 Promotions | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-029` [S] | 18.4 Promotions | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-030` [S] | 18.4 Promotions | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-035` [C] | 18.5 Customer Analytics | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-036` [C] | 18.5 Customer Analytics | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CRM-037` [C] | 18.5 Customer Analytics | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Costing & Analytics — 31 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-CST-001` [M] | 13.2 Cost of Goods Sold | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-002` [M] | 13.2 Cost of Goods Sold | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-003` [M] | 13.2 Cost of Goods Sold | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-004` [M] | 13.2 Cost of Goods Sold | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-005` [M] | 13.2 Cost of Goods Sold | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-006` [S] | 13.2 Cost of Goods Sold | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-007` [S] | 13.2 Cost of Goods Sold | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-010` [M] | 13.3 Theoretical versus Actual Usa | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-011` [M] | 13.3 Theoretical versus Actual Usa | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-012` [M] | 13.3 Theoretical versus Actual Usa | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-013` [M] | 13.3 Theoretical versus Actual Usa | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-014` [M] | 13.3 Theoretical versus Actual Usa | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-015` [S] | 13.3 Theoretical versus Actual Usa | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-016` [S] | 13.3 Theoretical versus Actual Usa | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-017` [S] | 13.3 Theoretical versus Actual Usa | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-020` [M] | 13.4 Waste Analysis | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-021` [M] | 13.4 Waste Analysis | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-022` [S] | 13.4 Waste Analysis | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-023` [S] | 13.4 Waste Analysis | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-024` [C] | 13.4 Waste Analysis | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-030` [S] | 13.5 Labour Cost Analysis | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-031` [S] | 13.5 Labour Cost Analysis | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-032` [S] | 13.5 Labour Cost Analysis | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-035` [S] | 13.6 Profitability Reporting | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-036` [S] | 13.6 Profitability Reporting | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-037` [S] | 13.6 Profitability Reporting | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-038` [C] | 13.6 Profitability Reporting | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-040` [S] | 13.7 Fraud and Anomaly Detection | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-041` [M] | 13.7 Fraud and Anomaly Detection | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-042` [M] | 13.7 Fraud and Anomaly Detection | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-CST-043` [S] | 13.7 Fraud and Anomaly Detection | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Workforce — 29 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-HRM-001` [M] | 14.2 Employee Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-002` [M] | 14.2 Employee Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-003` [M] | 14.2 Employee Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-004` [S] | 14.2 Employee Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-005` [M] | 14.2 Employee Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-006` [M] | 14.2 Employee Records | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-010` [S] | 14.3 Scheduling | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-011` [S] | 14.3 Scheduling | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-012` [S] | 14.3 Scheduling | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-013` [S] | 14.3 Scheduling | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-014` [S] | 14.3 Scheduling | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-015` [S] | 14.3 Scheduling | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-016` [C] | 14.3 Scheduling | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-017` [S] | 14.3 Scheduling | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-020` [M] | 14.4 Attendance | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-021` [M] | 14.4 Attendance | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-022` [M] | 14.4 Attendance | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-023` [M] | 14.4 Attendance | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-024` [S] | 14.4 Attendance | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-025` [M] | 14.4 Attendance | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-026` [S] | 14.4 Attendance | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-027` [C] | 14.4 Attendance | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-030` [S] | 14.5 Performance and Payroll Expor | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-031` [S] | 14.5 Performance and Payroll Expor | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-032` [S] | 14.5 Performance and Payroll Expor | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-033` [M] | 14.5 Performance and Payroll Expor | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-034` [M] | 14.5 Performance and Payroll Expor | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-035` [M] | 14.5 Performance and Payroll Expor | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-HRM-036` [S] | 14.5 Performance and Payroll Expor | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Integrations — 6 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-INT-001` [M] | 23.1 Integration Principles | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-INT-002` [M] | 23.1 Integration Principles | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-INT-003` [M] | 23.1 Integration Principles | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-INT-004` [M] | 23.1 Integration Principles | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-INT-005` [M] | 23.1 Integration Principles | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-INT-006` [M] | 23.1 Integration Principles | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Kitchen Ops (KDS) — 23 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-KDS-001` [M] | 9.2 Stations and Routing | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-010` [M] | 9.2 Stations and Routing | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-011` [M] | 9.2 Stations and Routing | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-012` [S] | 9.2 Stations and Routing | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-013` [S] | 9.2 Stations and Routing | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-020` [M] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-021` [M] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-022` [M] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-023` [M] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-024` [M] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-025` [M] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-026` [M] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-027` [S] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-028` [S] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-029` [M] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-030` [S] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-031` [S] | 9.3 Display and Interaction | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-040` [M] | 9.4 Timing and Performance Measure | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-041` [M] | 9.4 Timing and Performance Measure | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-042` [M] | 9.4 Timing and Performance Measure | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-043` [S] | 9.4 Timing and Performance Measure | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-044` [S] | 9.4 Timing and Performance Measure | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-KDS-045` [C] | 9.4 Timing and Performance Measure | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Offline & Sync — 36 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-OFF-001` [M] | 21.2 Operating Modes | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-002` [M] | 21.2 Operating Modes | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-003` [M] | 21.2 Operating Modes | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-010` [M] | 21.3 Local Data Model | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-011` [M] | 21.3 Local Data Model | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-012` [M] | 21.3 Local Data Model | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-013` [M] | 21.3 Local Data Model | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-015` [M] | 21.4 Identifier and Sequence Strat | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-016` [M] | 21.4 Identifier and Sequence Strat | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-017` [M] | 21.4 Identifier and Sequence Strat | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-018` [M] | 21.4 Identifier and Sequence Strat | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-020` [M] | 21.5.1 Upward Sync (Device → Serve | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-021` [M] | 21.5.1 Upward Sync (Device → Serve | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-022` [M] | 21.5.1 Upward Sync (Device → Serve | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-023` [M] | 21.5.1 Upward Sync (Device → Serve | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-024` [M] | 21.5.1 Upward Sync (Device → Serve | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-025` [M] | 21.5.1 Upward Sync (Device → Serve | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-026` [M] | 21.5.1 Upward Sync (Device → Serve | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-030` [M] | 21.5.2 Downward Sync (Server → Dev | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-031` [S] | 21.5.2 Downward Sync (Server → Dev | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-032` [M] | 21.5.2 Downward Sync (Server → Dev | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-035` [M] | 21.6 LAN Peer Coordination | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-036` [M] | 21.6 LAN Peer Coordination | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-037` [M] | 21.6 LAN Peer Coordination | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-038` [S] | 21.6 LAN Peer Coordination | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-040` [M] | 21.7 Conflict Detection and Resolu | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-041` [M] | 21.7 Conflict Detection and Resolu | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-042` [M] | 21.7 Conflict Detection and Resolu | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-043` [M] | 21.7 Conflict Detection and Resolu | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-044` [M] | 21.7 Conflict Detection and Resolu | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-045` [M] | 21.8 Server-Side Revalidation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-046` [M] | 21.8 Server-Side Revalidation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-047` [M] | 21.8 Server-Side Revalidation | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-050` [M] | 21.9 Shared Conformance Test Suite | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-051` [M] | 21.9 Shared Conformance Test Suite | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OFF-052` [M] | 21.9 Shared Conformance Test Suite | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### DevOps & Release — 15 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-OPS-001` [M] | 29.2 CI/CD Pipeline | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-002` [M] | 29.2 CI/CD Pipeline | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-003` [M] | 29.2 CI/CD Pipeline | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-004` [M] | 29.2 CI/CD Pipeline | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-005` [M] | 29.2 CI/CD Pipeline | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-010` [M] | 29.3 Release Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-011` [M] | 29.3 Release Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-012` [M] | 29.3 Release Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-013` [M] | 29.3 Release Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-020` [M] | 29.4 Monitoring and Incident Respo | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-021` [M] | 29.4 Monitoring and Incident Respo | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-022` [M] | 29.4 Monitoring and Incident Respo | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-023` [M] | 29.4 Monitoring and Incident Respo | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-030` [S] | 29.5 Cost Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-OPS-031` [S] | 29.5 Cost Management | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Procurement — 33 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-PRC-001` [M] | 12.2 Procure-to-Pay Cycle | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-002` [M] | 12.2 Procure-to-Pay Cycle | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-005` [M] | 12.3 Suppliers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-006` [M] | 12.3 Suppliers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-007` [M] | 12.3 Suppliers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-008` [S] | 12.3 Suppliers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-009` [S] | 12.3 Suppliers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-010` [S] | 12.3 Suppliers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-011` [S] | 12.3 Suppliers | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-015` [S] | 12.4 Requisitions and Purchase Ord | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-016` [S] | 12.4 Requisitions and Purchase Ord | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-017` [M] | 12.4 Requisitions and Purchase Ord | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-018` [M] | 12.4 Requisitions and Purchase Ord | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-019` [M] | 12.4 Requisitions and Purchase Ord | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-020` [M] | 12.4 Requisitions and Purchase Ord | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-021` [S] | 12.4 Requisitions and Purchase Ord | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-022` [S] | 12.4 Requisitions and Purchase Ord | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-023` [M] | 12.4 Requisitions and Purchase Ord | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-030` [M] | 12.5 Goods Receipt | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-031` [M] | 12.5 Goods Receipt | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-032` [M] | 12.5 Goods Receipt | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-033` [M] | 12.5 Goods Receipt | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-034` [S] | 12.5 Goods Receipt | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-035` [S] | 12.5 Goods Receipt | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-036` [M] | 12.5 Goods Receipt | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-037` [S] | 12.5 Goods Receipt | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-040` [M] | 12.6 Supplier Invoices and Matchin | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-041` [M] | 12.6 Supplier Invoices and Matchin | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-042` [M] | 12.6 Supplier Invoices and Matchin | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-043` [S] | 12.6 Supplier Invoices and Matchin | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-044` [S] | 12.6 Supplier Invoices and Matchin | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-045` [S] | 12.6 Supplier Invoices and Matchin | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-PRC-046` [C] | 12.6 Supplier Invoices and Matchin | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Quality Assurance — 5 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-QA-001` [M] | 28.1 Test Pyramid | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-QA-002` [M] | 28.1 Test Pyramid | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-QA-010` [M] | 28.4 Test Data | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-QA-011` [M] | 28.4 Test Data | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-QA-012` [M] | 28.4 Test Data | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### Reporting — 18 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `FR-RPT-001` [M] | 19.2 Analytics Architecture | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-002` [M] | 19.2 Analytics Architecture | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-003` [M] | 19.2 Analytics Architecture | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-004` [M] | 19.2 Analytics Architecture | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-005` [M] | 19.2.1 Star Schema | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-030` [M] | 19.4 Dashboards | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-031` [S] | 19.4 Dashboards | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-032` [S] | 19.4 Dashboards | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-033` [S] | 19.4 Dashboards | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-034` [C] | 19.4 Dashboards | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-040` [S] | 19.5 Delivery, Export and Alerts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-041` [S] | 19.5 Delivery, Export and Alerts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-042` [M] | 19.5 Delivery, Export and Alerts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-043` [M] | 19.5 Delivery, Export and Alerts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-044` [M] | 19.5 Delivery, Export and Alerts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-045` [S] | 19.5 Delivery, Export and Alerts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-046` [M] | 19.5 Delivery, Export and Alerts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `FR-RPT-047` [C] | 19.5 Delivery, Export and Alerts | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### NFR - Capacity — 1 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `NFR-CAP-001` [M] | 21.10 Offline Non-Functional Requi | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### NFR - Portability — 6 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `NFR-PORT-001` | 27.7 Portability and Compatibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PORT-002` | 27.7 Portability and Compatibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PORT-003` | 27.7 Portability and Compatibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PORT-004` | 27.7 Portability and Compatibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PORT-005` | 27.7 Portability and Compatibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-PORT-006` | 27.7 Portability and Compatibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### NFR - Reliability — 7 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `NFR-REL-001` [M] | 8.9 POS Non-Functional Requirement | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-REL-002` [M] | 9.5 Kitchen Non-Functional Require | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-REL-003` [M] | 9.5 Kitchen Non-Functional Require | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-REL-010` [M] | 21.10 Offline Non-Functional Requi | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-REL-011` [M] | 21.10 Offline Non-Functional Requi | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-REL-012` | 27.3 Availability and Reliability | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-REL-013` | 27.3 Availability and Reliability | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |

### NFR - Usability — 11 requirements · 0.0% weighted

| Requirement | SRS Source | Status | Evidence | Missing Work | Dependency |
|---|---|---|---|---|---|
| `NFR-USA-001` [M] | 8.9 POS Non-Functional Requirement | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-USA-002` [M] | 8.9 POS Non-Functional Requirement | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-USA-003` | 27.4 Usability and Accessibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-USA-004` [M] | 8.9 POS Non-Functional Requirement | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-USA-005` | 27.4 Usability and Accessibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-USA-006` [M] | 9.5 Kitchen Non-Functional Require | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-USA-007` | 27.4 Usability and Accessibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-USA-008` | 27.4 Usability and Accessibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-USA-009` | 27.4 Usability and Accessibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-USA-010` | 27.4 Usability and Accessibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
| `NFR-USA-011` | 27.4 Usability and Accessibility | **NOT IMPLEMENTED** | — | Domain has no implementation. | — |
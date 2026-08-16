# PHASE 15 DISCOVERY REPORT

## ROS Backend — Organisation Foundation (Discovery + Schema Design Gate)

- Date: 2026-08-16
- Phase: 15 (Organisation bounded context)
- Status: **BLOCKED — CLARIFICATION REQUIRED** (see §22)
- Scope of this document: discovery and schema design **only**. No migration,
  no `schema.prisma` change, no application code, no tests, no Auth changes.
- Companion decision record: `docs/adr/0008-organisation-foundation.md`
  (Accepted 2026-08-15, 14 decisions ratified)

---

## 1. Repository Findings

| Concern | Actual location | Notes |
|---|---|---|
| Prisma schema | `kitchen-kit/backend/prisma/schema.prisma` | `schemas = ["governance", "identity"]` |
| Migrations | `prisma/migrations/` — **8 applied**, `provider = postgresql` | Latest `20260812175712_governance_audit_entries` |
| Tenant context | `src/modules/identity/context/tenant-context{.ts,.service.ts,.guard.ts}` | `branchId` declared, documented "RESERVED — not populated" |
| PermissionGuard | `src/modules/identity/authz/guards/permission.guard.ts` | Consumes memoised `request.authorization`; 403 only |
| Principal | `src/modules/identity/auth/auth.types.ts`, `guards/jwt-auth.guard.ts` | 401 only |
| `withAuthContext` | `src/prisma/prisma.service.ts` | One interactive tx; `set_config('app.user_id',$1,true), set_config('app.tenant_id',$2,true)`; **not nestable** |
| RLS precedent | `20260812145207_identity_rls`, `20260812151804_identity_terminals` | `NULLIF(current_setting('app.tenant_id', true), '')::uuid`; child-inherits-via-`EXISTS` |
| IDs | `src/common/ids.ts` | `newId()` ULID-as-UUID; `UUID_PATTERN` (`@IsUUID()` would wrongly reject) |
| DTO conventions | `src/main.ts` | `whitelist`, `forbidNonWhitelisted`, `transform` |
| Audit | `src/modules/governance/audit/audit.service.ts` | `record(tx, e)` / `emit(e)`; `AUDIT_ACTION` / `AUDIT_ENTITY` maps |
| Permission seeding | `src/modules/identity/authz/permissions.service.ts` → `upsertMany` | Called **only from e2e setup**; no runtime seeder exists |
| Tests | `src/**/*.spec.ts` (unit), `test/*.e2e-spec.ts` + `test/rls-admin.ts` | `createMigratorClient()` for privileged arrange only |
| Docs / ADRs | `docs/adr/0001…0008`, `docs/auth/*` | ADR 0008 Accepted 2026-08-15 |
| Sources | SRS at `/Users/mac/Public/ROS_SRS_v1.0.pdf`; SQL at `/Users/mac/projects/ros/ROS_DrawDB_Compatible_v3.sql` | SRS is **outside** the repository |

**Existing Organisation implementation: none.** STOP condition 9 is clear. The
only org-adjacent code is `identity.terminals.branchId` (a recorded UUID, no FK)
and `membership_roles.branch_id` (present, unconsumed).

**Verification performed without modifying the repository.** `schema.prisma` was
copied to a scratchpad, the candidate Organisation models appended, then
`prisma validate` (**passes**) and `prisma migrate diff --from-empty --script`
were run to inspect the generated DDL. `schema.prisma` and `prisma/migrations/`
are untouched. This validation surfaced two blockers that reading alone would
not have found (§22).

---

## 2. SRS Findings

| Ref | Priority | Meaning | Affects |
|---|---|---|---|
| FR-PLT-001 | **[M]** | tenants/brands/branches/warehouses/CKs distinct, "with the hierarchy above" (§6.1 tree puts Warehouse/CK under **Brand**) | **Deviated — D-08** |
| FR-PLT-002 | [M] | tenant → many brands; brand → many branches | Brand, Branch cardinality |
| FR-PLT-003 | [M] | `tenant_id` immutable; records not transferable between tenants | All tenant-scoped; drives D-09 |
| FR-PLT-004 | [S] | branch reassignable between brands **within same tenant**, by Tenant Owner, with full audit | `branches.brand_id` mutable |
| BR-PLT-001 | rule | inventory held at a **location**; two brands sharing a kitchen = two branches **sharing a warehouse** | D-08, D-17 |
| FR-PLT-010/011/012 | [M] | RLS `USING` + `WITH CHECK`; app role no `BYPASSRLS`; fail closed | All org RLS |
| FR-PLT-013/014 | [M] | CI cross-tenant read+write suite enumerated from `information_schema` over tables **containing `tenant_id`** | Test matrix |
| §7.3 #4 / #5 / #6 | model | Brand (contains BrandTheme, DefaultSettings) "belongs to one tenant"; Branch (contains OperatingHours, **Stations**, PrintRouting) "belongs to one brand; one timezone; one base currency"; Warehouse "belongs to one tenant" | Aggregates |
| §7.3 #24 | model | **Station \| Kitchen Ops \| contains RoutingRules** — contradicts #5 | Resolved by D-07 |
| §25.1 | normative | `org` = brands, branches, warehouses, central_kitchens, stations, tables, settings; `kitchen` = tickets, ticket_lines, **station_routing_rules** | Schema placement |
| FR-BRN-001 | [M] | unlimited branches per brand, brands per tenant | No cardinality caps |
| FR-BRN-002 | [M] | branch holds own hours, timezone, currency, tax config, **country pack** | country pack **has no column** |
| FR-BRN-005 | **[M]** | branch groups as permission-scoping + reporting dimension | **Deferred — D-10** |
| FR-KDS-001 | [M] | stations per branch: name, **display colour**, capacity | colour **has no column** |
| FR-KDS-010 | [M] | routing resolution precedence | **Kitchen Ops behaviour — excluded** |
| FR-POS-002 | [M] | order number `<branch_code>-<seq>`, generated offline | `branches.code` effectively immutable |
| FR-POS-081 | [S] | 7 live table states (order-driven) | **D-05: `status` omitted** |
| FR-SEC-002/003/004 | **[M]** | assignment scope tenant/brand/branch-set/branch; union within scope; no leak across scopes | **Deferred — D-02** |
| §15.2 | — | catalogue "representative … full catalogue in **Appendix C**" — **Appendix C absent**; only `settings.{tenant,branch}.manage` present | D-01 |
| §15.3 | [M] | standard roles incl. Auditor "read-only everything" | D-01 read codes |
| §24.6.5 | normative | soft delete; hard delete only for unreferenced rows via audited admin op | D-12 |
| §24.6.4 | normative | "Aggregates carry a **version**" | **no `version` column on any org table** |
| Glossary "Business Day" | — | "A branch closing at 03:00 attributes those sales to the previous business day" | **Overnight is SRS-mandated** |
| FR-OFF-015 | [M] | entities created **on a device** get a client-generated ULID | See §17 |

---

## 3. ADR 0008 Decisions Applied

All 14 ratified decisions verified against the ADR text and carried into this
design:

- **D-01** — exactly four permission codes, no others.
- **D-02** — deferred: no `TenantContext.branchId` population, no
  `membership_roles.branch_id` read in authorization, no guard changes.
- **D-03** — `branches.status` enum `active | inactive`, not a state machine.
- **D-04** — overnight SRS-mandated; split shifts allowed, overlaps rejected in
  the service layer; `day_of_week` origin `0 = Sunday`.
- **D-05** — `org.tables.status` omitted.
- **D-06** — `kitchen` schema created, containing only `station_routing_rules`.
- **D-07** — Station is an Organisation aggregate root.
- **D-08** — Warehouse/CK tenant-owned; FR-PLT-001 deviation accepted.
- **D-09** — composite tenant-safe FKs mandatory.
- **D-10 / D-11 / D-14** — no `branch_groups`, no `org.settings`, no
  `org.locations`.
- **D-12** — no delete/deactivate endpoints.
- **D-13** — schema implications only this phase.
- **D-15** — exactly six additional unique constraints.
- **D-16** — composite relation to `identity.terminals(branch_id, id)`; no
  reverse FK.
- **D-17** — `warehouse_type` enum; **no** correlation CHECK.

---

## 4. Organisation Entity Matrix

| Entity | Tenant owned? | Tenant source | RLS anchor | Composite FK requirement | Notes |
|---|---|---|---|---|---|
| Brand | **Yes, direct** | own `tenant_id` | `tenant_id = app.tenant_id` | is a **target**: needs `UNIQUE(tenant_id, id)` | root of org tree |
| Branch | **Yes, direct** | own `tenant_id` | `tenant_id = app.tenant_id` | `(tenant_id, brand_id) → brands` + target `UNIQUE(tenant_id, id)` | |
| Warehouse | **Yes, direct** | own `tenant_id` | `tenant_id = app.tenant_id` | `(tenant_id, branch_id) → branches` + target `UNIQUE(tenant_id, id)` | `branch_id` nullable |
| CentralKitchen | **Yes, direct** | own `tenant_id` | `tenant_id = app.tenant_id` | `(tenant_id, warehouse_id) → warehouses` | no `created_at` in source |
| Station | No | via `branch_id` | `EXISTS(branches …)` | `(branch_id, display_terminal_id) → terminals`; is a **target**: `UNIQUE(branch_id, id)` | D-07 root, D-16 |
| Table | No | via `branch_id` | `EXISTS(branches …)` | none | `status` omitted (D-05) |
| OperatingHours | No | via `branch_id` | `EXISTS(branches …)` | none | |
| PrintRouting | No | via `branch_id` | `EXISTS(branches …)` | `(branch_id, station_id) → stations` | |
| StationRoutingRule | No | via `branch_id` | `EXISTS(branches …)` | `(branch_id, station_id) → stations` | `kitchen` schema |

No `tenant_id` is added to any table the approved SQL leaves without one.

---

## 5. Aggregate / Ownership Model

| Aggregate root | Children | Basis |
|---|---|---|
| **Brand** | none (theme / default_settings are JSONB attributes) | §7.3 #4 |
| **Branch** | OperatingHours, Table, PrintRouting | §7.3 #5 |
| **Station** | StationRoutingRule | §7.3 #24 structure + D-07 |
| **Warehouse** | none | §7.3 #6 |
| **CentralKitchen** | none | **Not explicitly established by source** — §7.3 defines no CK aggregate (#4/#5/#6 are Brand/Branch/Warehouse only). Treated as a root because the approved SQL gives it its own tenant-scoped table. |

- **Transaction boundaries.** One `withAuthContext` per aggregate-root operation.
- **Invariants (source only).** Branch belongs to one brand, one timezone, one
  base currency (§7.3 #5). Warehouse belongs to one tenant (§7.3 #6).
- **No lifecycle invariant** is established for any entity except
  `branches.status` (D-03), which is explicitly not a state machine.

---

## 6. Field-Level Schema Specification

Sources: **[SQL]** approved SQL · **[ADR]** ratified decision · **[REPO]**
repository convention.

### Brand — `org.brands`, PK `id` UUID

| Field | Type | Null | Default | Source |
|---|---|---|---|---|
| `id` | UUID | no | — (ULID-as-UUID, app-generated) | [SQL] / [REPO] |
| `tenant_id` | UUID | no | — | [SQL] |
| `name` | VARCHAR(120) | no | — | [SQL] |
| `theme` | JSONB | no | `{}` | [SQL] |
| `default_settings` | JSONB | no | `{}` | [SQL] |
| `created_at` | TIMESTAMPTZ(6) | no | `now()` | [SQL] |

### Branch — `org.branches`, PK `id` UUID

| Field | Type | Null | Default | Source |
|---|---|---|---|---|
| `id` | UUID | no | — | [SQL] |
| `tenant_id` | UUID | no | — | [SQL] |
| `brand_id` | UUID | no | — (mutable only via D-13 operation) | [SQL] |
| `code` | VARCHAR(16) | no | — · **immutable after create** | [ADR D-13] / FR-POS-002 |
| `name` | VARCHAR(120) | no | — | [SQL] |
| `timezone` | VARCHAR(48) | no | — (IANA zone) | [SQL] |
| `base_currency` | CHAR(3) | no | — (ISO-4217) | [SQL] |
| `country_code` | CHAR(2) | no | — (ISO-3166-1 alpha-2) | [SQL] |
| `address` | JSONB | yes | — (opaque, no schema imposed) | [SQL] |
| `status` | enum `BranchStatus` | no | `active` | [ADR D-03] |
| `automatic_availability` | BOOLEAN | no | `true` — stored, **no behaviour** | [SQL] / FR-MNU-031 |
| `created_at` | TIMESTAMPTZ(6) | no | `now()` | [SQL] |

### Warehouse — `org.warehouses`, PK `id` UUID

| Field | Type | Null | Default | Source |
|---|---|---|---|---|
| `id` | UUID | no | — | [SQL] |
| `tenant_id` | UUID | no | — | [SQL] |
| `name` | VARCHAR(120) | no | — | [SQL] |
| `warehouse_type` | enum `WarehouseType` | no | `branch` | [ADR D-17] |
| `branch_id` | UUID | **yes** | — (NULL = standalone) | [SQL] |
| `created_at` | TIMESTAMPTZ(6) | no | `now()` | [SQL] |

### CentralKitchen — `org.central_kitchens`, PK `id` UUID

| Field | Type | Null | Default | Source |
|---|---|---|---|---|
| `id` | UUID | no | — | [SQL] |
| `tenant_id` | UUID | no | — | [SQL] |
| `warehouse_id` | UUID | no | — | [SQL] |
| `name` | VARCHAR(120) | no | — | [SQL] |

No `created_at` — the approved SQL does not define one.

### Station — `org.stations`, PK `id` UUID

| Field | Type | Null | Default | Source |
|---|---|---|---|---|
| `id` | UUID | no | — | [SQL] |
| `branch_id` | UUID | no | — | [SQL] |
| `name` | VARCHAR(64) | no | — | [SQL] |
| `capacity_config` | JSONB | no | `{}` (opaque) | [SQL] |
| `display_terminal_id` | UUID | yes | — | [SQL] / [ADR D-16] |
| `created_at` | TIMESTAMPTZ(6) | no | `now()` | [SQL] |

**No colour column** — FR-KDS-001 [M] requires one; neither source provides it
(§20 item 4).

### BranchTable — `org.tables`, PK `id` UUID

| Field | Type | Null | Default | Source |
|---|---|---|---|---|
| `id` | UUID | no | — | [SQL] |
| `branch_id` | UUID | no | — | [SQL] |
| `label` | VARCHAR(16) | no | — | [SQL] |
| `section` | VARCHAR(64) | yes | — | [SQL] |
| `seat_capacity` | SMALLINT | yes | — | [SQL] |

`status` **intentionally omitted** — [ADR D-05].

### OperatingHours — `org.operating_hours`, PK `id` UUID

| Field | Type | Null | Default | Source |
|---|---|---|---|---|
| `id` | UUID | no | — | [SQL] |
| `branch_id` | UUID | no | — | [SQL] |
| `day_of_week` | SMALLINT | no | — · **CHECK 0..6**, `0 = Sunday` | [SQL] / [ADR D-04] |
| `opens_at` | TIME(6) | no | — | [SQL] |
| `closes_at` | TIME(6) | no | — · `< opens_at` ⇒ **overnight** | [SQL] / SRS glossary |
| `business_day_cutover` | TIME(6) | no | `'00:00'` | [SQL] |

Overlap policy is enforced in the service layer (400), not by a constraint
— [ADR D-04].

### PrintRouting — `org.print_routing`, PK `id` UUID

| Field | Type | Null | Default | Source |
|---|---|---|---|---|
| `id` | UUID | no | — | [SQL] |
| `branch_id` | UUID | no | — | [SQL] |
| `document_type` | VARCHAR(24) | no | — (`receipt`, `kitchen_ticket`, `bar_ticket` per SQL comment) | [SQL] |
| `printer_target` | VARCHAR(64) | no | — | [SQL] |
| `station_id` | UUID | yes | — | [SQL] |

**No priority and no active column** — neither source defines them (§20 item 5).

### StationRoutingRule — `kitchen.station_routing_rules`, PK `id` UUID

| Field | Type | Null | Default | Source |
|---|---|---|---|---|
| `id` | UUID | no | — | [SQL] |
| `branch_id` | UUID | no | — | [SQL] |
| `station_id` | UUID | no | — | [SQL] |
| `menu_item_id` | UUID | yes | — · **no FK** (Catalogue absent) | [SQL] |
| `category_id` | UUID | yes | — · **no FK** | [SQL] |
| `priority` | SMALLINT | no | `0` | [SQL] |

---

## 7. Relationship Matrix

| Parent | Child | Cardinality | FK | Tenant safety | Source |
|---|---|---|---|---|---|
| Tenant | Brand | 1 → N | `tenant_id` | direct RLS anchor | [SQL] |
| Tenant | Branch | 1 → N | `tenant_id` | direct RLS anchor | [SQL] |
| Tenant | Warehouse | 1 → N | `tenant_id` | direct RLS anchor | [SQL] |
| Tenant | CentralKitchen | 1 → N | `tenant_id` | direct RLS anchor | [SQL] |
| Brand | Branch | 1 → N | `(tenant_id, brand_id)` | **composite** | [SQL] + [ADR D-09] |
| Branch | Warehouse | 1 → 0..N | `(tenant_id, branch_id)` | **composite** | [SQL] + [ADR D-09] |
| Warehouse | CentralKitchen | 1 → 0..1 | `(tenant_id, warehouse_id)` | **composite** | [SQL] + [ADR D-09/D-15] |
| Branch | Station | 1 → N | `branch_id` (CASCADE) | inherited | [SQL] |
| Branch | Table | 1 → N | `branch_id` (CASCADE) | inherited | [SQL] |
| Branch | OperatingHours | 1 → N | `branch_id` (CASCADE) | inherited | [SQL] |
| Branch | PrintRouting | 1 → N | `branch_id` (RESTRICT) | inherited | [SQL] |
| Branch | StationRoutingRule | 1 → N | `branch_id` (RESTRICT) | inherited | [SQL] |
| Station | PrintRouting | 1 → 0..N | `(branch_id, station_id)` | **composite** | [SQL] + [ADR D-09] |
| Station | StationRoutingRule | 1 → N | `(branch_id, station_id)` | **composite** | [SQL] + [ADR D-09] |
| Terminal | Station (display) | 1 → 0..N | `(branch_id, display_terminal_id)` | **composite** | [SQL] + [ADR D-16] |

**`onDelete` behaviour.** `CASCADE` for stations / tables / operating_hours
(source-specified). `RESTRICT` everywhere else — the approved SQL specifies no
action, and Prisma's default for a required relation is `RESTRICT`. This
diverges from the shipped `Terminal.tenant` (`Cascade`); the approved SQL
outranks repository convention in the stated priority order, so the source is
followed and the inconsistency flagged (§20 item 7).

---

## 8. Composite Tenant-Safe FK Matrix

| Child | Parent | Child tenant source | Parent tenant source | Plain FK safe? | Composite required? | Required UNIQUE |
|---|---|---|---|---|---|---|
| branches | brands | own `tenant_id` | own `tenant_id` | **NO** | **YES** `(tenant_id, brand_id)` | `brands(tenant_id, id)` |
| warehouses | branches | own `tenant_id` | own `tenant_id` | **NO** | **YES** `(tenant_id, branch_id)` | `branches(tenant_id, id)` |
| central_kitchens | warehouses | own `tenant_id` | own `tenant_id` | **NO** | **YES** `(tenant_id, warehouse_id)` | `warehouses(tenant_id, id)` |
| stations | terminals | via branch | own `tenant_id` + `branch_id` | **NO** | **YES** `(branch_id, display_terminal_id)` | `identity.terminals(branch_id, id)` |
| stations | branches | via branch | own `tenant_id` | **YES** | no | — |
| tables | branches | via branch | own `tenant_id` | **YES** | no | — |
| operating_hours | branches | via branch | own `tenant_id` | **YES** | no | — |
| station_routing_rules | branches | via branch | own `tenant_id` | **YES** | no | — |
| station_routing_rules | stations | via branch | via branch | **NO** | **YES** `(branch_id, station_id)` | `stations(branch_id, id)` |
| print_routing | branches | via branch | own `tenant_id` | **YES** | no | — |
| print_routing | stations | via branch | via branch | **NO** | **YES** `(branch_id, station_id)` | `stations(branch_id, id)` |

### Why the "plain FK safe" rows are safe

PostgreSQL evaluates referential-integrity checks **with row security
disabled**, so a plain FK never validates tenancy. Two distinct cases follow:

- A child that carries **no independent `tenant_id`** cannot *disagree* with its
  parent — its tenant *is* whatever branch it points at. The RLS `WITH CHECK`
  predicate (`EXISTS (branches b WHERE b.id = branch_id AND b.tenant_id =
  app.tenant_id)`) rejects an insert naming a foreign branch. Plain FK is
  sufficient.
- A composite FK is required exactly where the child either (a) carries its own
  `tenant_id` that could contradict the parent's, or (b) references a **sibling**
  whose tenancy the branch-anchored RLS predicate does not validate
  (`print_routing.station_id`, `station_routing_rules.station_id`,
  `stations.display_terminal_id`).

All five composite FKs were confirmed to generate correctly from the validated
candidate schema.

---

## 9. Uniqueness Matrix

| Table | Constraint | Purpose | Source |
|---|---|---|---|
| `org.brands` | `(tenant_id, name)` | 409 conflict semantics | [ADR D-15] |
| `org.brands` | `(tenant_id, id)` | FK target | [ADR D-09] |
| `org.branches` | `(tenant_id, code)` — `uq_branch_code` | branch code per tenant | **[SQL]** |
| `org.branches` | `(tenant_id, id)` | FK target | [ADR D-09] |
| `org.warehouses` | `(tenant_id, name)` | 409 | [ADR D-15] |
| `org.warehouses` | `(tenant_id, id)` | FK target | [ADR D-09] |
| `org.central_kitchens` | `(tenant_id, name)` | 409 | [ADR D-15] |
| `org.central_kitchens` | `(warehouse_id)` | one CK per warehouse | [ADR D-15] |
| `org.stations` | `(branch_id, name)` | 409 | [ADR D-15] |
| `org.stations` | `(branch_id, id)` | FK target | [ADR D-09 / D-16] |
| `org.tables` | `(branch_id, label)` — `uq_table_label` | table label per branch | **[SQL]** |
| `org.print_routing` | `(branch_id, document_type, station_id)` | 409 — **see Blocker 1** | [ADR D-15] |
| `identity.terminals` | `(branch_id, id)` | FK target (additive) | [ADR D-16] |

No additional uniqueness invented. `org.operating_hours` and
`kitchen.station_routing_rules` remain deliberately unconstrained.

Every key is prefixed by `tenant_id` or `branch_id`, so uniqueness is enforced
**within** the tenant boundary and never across it — a global unique on
`brands.name` would let Tenant A discover Tenant B's brand names by probing for
409 responses.

---

## 10. Index Plan

The FK-target uniques are themselves tenant-prefixed composite indexes, so a
separate `@@index([tenantId])` on brands / branches / warehouses would be
**redundant** and is not proposed.

| Index | Table | Justification |
|---|---|---|
| `(tenant_id, id)` UNIQUE | brands, branches, warehouses | FK target + tenant-prefix lookups |
| `(branch_id, id)` UNIQUE | stations, identity.terminals | FK target |
| `(tenant_id, brand_id)` | branches | list branches by brand |
| `(tenant_id, branch_id)` | warehouses | list warehouses by branch |
| `(branch_id, day_of_week)` | operating_hours | hours lookup per branch/day |
| `(branch_id, station_id)` | station_routing_rules | routing lookup |
| natural-key uniques (§9) | various | conflict detection |

The approved SQL defines **no indexes at all**, so all indexing is inferred from
query patterns and the SRS performance requirements.

---

## 11. RLS Plan

Phase 8/9 pattern verbatim; no new context mechanism. `ENABLE` + `FORCE` on all
nine tables.

### Direct `tenant_id` — brands, branches, warehouses, central_kitchens

```sql
ALTER TABLE "org"."brands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"."brands" FORCE ROW LEVEL SECURITY;

CREATE POLICY brands_select ON "org"."brands" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY brands_insert ON "org"."brands" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY brands_update ON "org"."brands" FOR UPDATE
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY brands_delete ON "org"."brands" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

### Branch-inherited — stations, tables, operating_hours, print_routing, kitchen.station_routing_rules

```sql
ALTER TABLE "org"."stations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"."stations" FORCE ROW LEVEL SECURITY;

CREATE POLICY stations_select ON "org"."stations" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "org"."branches" b
                 WHERE b.id = branch_id
                   AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

CREATE POLICY stations_insert ON "org"."stations" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b
                      WHERE b.id = branch_id
                        AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

CREATE POLICY stations_update ON "org"."stations" FOR UPDATE
  USING      (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
                        AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
                        AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

CREATE POLICY stations_delete ON "org"."stations" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
                   AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
```

### How tenant ownership is derived through the parent

The child carries no `tenant_id`; the predicate resolves `branch_id` against
`org.branches` and compares that row's `tenant_id` to the transaction-local
setting. **This is not novel** — it is the exact mechanism already in production
for `role_permissions → roles`, `membership_roles → memberships`, and
`device_fingerprints → terminals` (the last against a table that is itself
`ENABLE` + `FORCE`), and it is covered by the passing Phase 8/9 e2e suites. It
is safely expressible with the existing `withAuthContext` architecture — **no
STOP is required on hard-stop condition 4.**

### Fail-closed proof

`current_setting('app.tenant_id', true)` returns `NULL` when unset;
`NULLIF(…, '')` maps empty string → `NULL`; `col = NULL` evaluates to `NULL`,
which is not true, so the row is rejected. `withAuthContext` passes `''` for an
absent scope, so a missing tenant context fails closed on every operation
(FR-PLT-012).

### Runtime role — unchanged

`ros_app` (`NOSUPERUSER`, `NOBYPASSRLS`, no DDL) for runtime; `ros_migrator`
for migrations only. No migrator runtime path, no `BYPASSRLS`, no RLS disabled
for convenience.

New grants required:

```sql
GRANT USAGE ON SCHEMA "org", "kitchen" TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON <each new table> TO ros_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA "org"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA "kitchen"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;
```

`DELETE` is granted and `DELETE` policies are created **even though D-12 exposes
no delete endpoint**, so that FR-PLT-013's cross-tenant DELETE test proves the
*RLS* boundary rather than a missing privilege.

---

## 12. Prisma Schema Proposal

**Validated** — `prisma validate` passes on the scratchpad candidate. This
confirms Prisma accepts scalar reuse across relations, composite references to
`@@unique([tenantId, id])`, and cross-schema relations.

```prisma
// datasource: schemas = ["governance", "identity", "kitchen", "org"]

enum BranchStatus {
  active
  inactive

  @@schema("org")
}

enum WarehouseType {
  branch
  central
  virtual

  @@schema("org")
}

model Brand {
  id              String   @id @db.Uuid
  tenantId        String   @map("tenant_id") @db.Uuid
  name            String   @db.VarChar(120)
  theme           Json     @default("{}") @db.JsonB
  defaultSettings Json     @default("{}") @map("default_settings") @db.JsonB
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  tenant   Tenant   @relation(fields: [tenantId], references: [id])
  branches Branch[]

  @@unique([tenantId, id])     // D-09 FK target
  @@unique([tenantId, name])   // D-15
  @@map("brands")
  @@schema("org")
}

model Branch {
  id                    String       @id @db.Uuid
  tenantId              String       @map("tenant_id") @db.Uuid
  brandId               String       @map("brand_id") @db.Uuid
  code                  String       @db.VarChar(16)   // immutable after create (FR-POS-002)
  name                  String       @db.VarChar(120)
  timezone              String       @db.VarChar(48)
  baseCurrency          String       @map("base_currency") @db.Char(3)
  countryCode           String       @map("country_code") @db.Char(2)
  address               Json?        @db.JsonB
  status                BranchStatus @default(active)  // D-03
  automaticAvailability Boolean      @default(true) @map("automatic_availability")
  createdAt             DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)

  tenant Tenant @relation(fields: [tenantId], references: [id])
  brand  Brand  @relation(fields: [tenantId, brandId], references: [tenantId, id]) // D-09

  warehouses     Warehouse[]
  stations       Station[]
  tables         BranchTable[]
  operatingHours OperatingHours[]
  printRouting   PrintRouting[]
  routingRules   StationRoutingRule[]

  @@unique([tenantId, id])
  @@unique([tenantId, code], map: "uq_branch_code")
  @@index([tenantId, brandId])
  @@map("branches")
  @@schema("org")
}

model Warehouse {
  id            String        @id @db.Uuid
  tenantId      String        @map("tenant_id") @db.Uuid
  name          String        @db.VarChar(120)
  warehouseType WarehouseType @default(branch) @map("warehouse_type") // D-17, no CHECK
  branchId      String?       @map("branch_id") @db.Uuid
  createdAt     DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)

  tenant          Tenant           @relation(fields: [tenantId], references: [id])
  branch          Branch?          @relation(fields: [tenantId, branchId], references: [tenantId, id])
  centralKitchens CentralKitchen[]

  @@unique([tenantId, id])
  @@unique([tenantId, name])
  @@index([tenantId, branchId])
  @@map("warehouses")
  @@schema("org")
}

model CentralKitchen {
  id          String @id @db.Uuid
  tenantId    String @map("tenant_id") @db.Uuid
  warehouseId String @map("warehouse_id") @db.Uuid
  name        String @db.VarChar(120)

  tenant    Tenant    @relation(fields: [tenantId], references: [id])
  warehouse Warehouse @relation(fields: [tenantId, warehouseId], references: [tenantId, id])

  @@unique([tenantId, name])
  @@unique([warehouseId])   // D-15: one CK per warehouse
  @@map("central_kitchens")
  @@schema("org")
}

model Station {                         // D-07: aggregate root, tenant via branch
  id                String   @id @db.Uuid
  branchId          String   @map("branch_id") @db.Uuid
  name              String   @db.VarChar(64)
  capacityConfig    Json     @default("{}") @map("capacity_config") @db.JsonB
  displayTerminalId String?  @map("display_terminal_id") @db.Uuid
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  branch          Branch    @relation(fields: [branchId], references: [id], onDelete: Cascade)
  displayTerminal Terminal? @relation(fields: [branchId, displayTerminalId], references: [branchId, id]) // D-16

  printRouting PrintRouting[]
  routingRules StationRoutingRule[]

  @@unique([branchId, id])     // FK target for print_routing / routing rules
  @@unique([branchId, name])   // D-15
  @@map("stations")
  @@schema("org")
}

model BranchTable {
  id           String  @id @db.Uuid
  branchId     String  @map("branch_id") @db.Uuid
  label        String  @db.VarChar(16)
  section      String? @db.VarChar(64)
  seatCapacity Int?    @map("seat_capacity") @db.SmallInt
  // status intentionally omitted — D-05

  branch Branch @relation(fields: [branchId], references: [id], onDelete: Cascade)

  @@unique([branchId, label], map: "uq_table_label")
  @@map("tables")
  @@schema("org")
}

model OperatingHours {
  id                 String   @id @db.Uuid
  branchId           String   @map("branch_id") @db.Uuid
  dayOfWeek          Int      @map("day_of_week") @db.SmallInt  // 0 = Sunday (D-04)
  opensAt            DateTime @map("opens_at") @db.Time(6)
  closesAt           DateTime @map("closes_at") @db.Time(6)     // < opensAt ⇒ overnight
  businessDayCutover DateTime @default(dbgenerated("'00:00:00'::time without time zone")) @map("business_day_cutover") @db.Time(6)

  branch Branch @relation(fields: [branchId], references: [id], onDelete: Cascade)

  @@index([branchId, dayOfWeek])
  @@map("operating_hours")
  @@schema("org")
}

model PrintRouting {
  id            String  @id @db.Uuid
  branchId      String  @map("branch_id") @db.Uuid
  documentType  String  @map("document_type") @db.VarChar(24)
  printerTarget String  @map("printer_target") @db.VarChar(64)
  stationId     String? @map("station_id") @db.Uuid

  branch  Branch   @relation(fields: [branchId], references: [id])
  station Station? @relation(fields: [branchId, stationId], references: [branchId, id])

  @@unique([branchId, documentType, stationId])  // D-15 — see Blocker 1
  @@map("print_routing")
  @@schema("org")
}

model StationRoutingRule {
  id         String  @id @db.Uuid
  branchId   String  @map("branch_id") @db.Uuid
  stationId  String  @map("station_id") @db.Uuid
  menuItemId String? @map("menu_item_id") @db.Uuid  // no FK — Catalogue absent
  categoryId String? @map("category_id") @db.Uuid   // no FK
  priority   Int     @default(0) @db.SmallInt

  branch  Branch  @relation(fields: [branchId], references: [id])
  station Station @relation(fields: [branchId, stationId], references: [branchId, id])

  @@index([branchId, stationId])
  @@map("station_routing_rules")
  @@schema("kitchen")
}
```

### Constraints Prisma cannot express — raw SQL required in the migration

1. `CHECK (day_of_week BETWEEN 0 AND 6)` on `org.operating_hours`.
2. All RLS enablement, `FORCE`, and policies.
3. All grants and default privileges.
4. `UNIQUE … NULLS NOT DISTINCT` on `org.print_routing` (Blocker 1).

---

## 13. Migration Plan — ONE coherent migration

Prisma emits objects in dependency-safe order (schemas → enums → tables →
indexes → foreign keys), which already places the
`identity.terminals(branch_id, id)` unique **before** the `stations` composite
FK. Verified against the generated output.

1. `CREATE SCHEMA IF NOT EXISTS "org";` and `"kitchen";`
2. `CREATE TYPE "org"."BranchStatus"`, `CREATE TYPE "org"."WarehouseType"`
3. Create eight `org` tables + `kitchen.station_routing_rules`
4. Unique indexes — including all FK targets and the additive
   `identity.terminals(branch_id, id)` (D-16)
5. Secondary indexes (§10)
6. Plain foreign keys, then the **five composite foreign keys**
7. **Raw:** `ALTER TABLE "org"."operating_hours" ADD CONSTRAINT
   operating_hours_day_of_week_check CHECK (day_of_week BETWEEN 0 AND 6);`
8. **Raw (pending Blocker 1):** drop Prisma's `print_routing` unique index and
   recreate it with `NULLS NOT DISTINCT`
9. **Raw:** grants — `USAGE` on both schemas, per-table DML,
   `ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator`
10. **Raw:** `ENABLE` + `FORCE` ROW LEVEL SECURITY on all nine tables
11. **Raw:** 36 policies (4 per table × 9 tables)

Constraints: no database reset; no edits to the eight existing migrations; one
coherent Phase 15 migration. Post-migration verification: `prisma format`,
`prisma validate`, `prisma generate`, `prisma migrate status`, then the full
test suite.

---

## 14. Permission Mapping

Exactly the four ratified codes (D-01); no others. `module` = `settings`,
matching the SRS code prefix.

| Permission | Entities | Operations |
|---|---|---|
| `settings.tenant.read` | Brand, Warehouse, CentralKitchen | list, get |
| `settings.tenant.manage` | Brand, Warehouse, CentralKitchen, **+ branch↔brand reassignment (D-13)** | create, update |
| `settings.branch.read` | Branch, Station, Table, OperatingHours, StationRouting, PrintRouting | list, get |
| `settings.branch.manage` | Branch, Station, Table, OperatingHours, StationRouting, PrintRouting | create, update, status change |

Seeded through the existing `PermissionsService.upsertMany`. **No
`PermissionGuard` or `TenantContextService` change. No branch-scoped RBAC
(D-02).**

Open implementation question for the build phase: permissions are currently
seeded only from e2e setup — no runtime seeding path exists.

---

## 15. Audit Mapping (document only — not implemented)

| Action | Entity | Audit required? | Reason | Source |
|---|---|---|---|---|
| `BRANCH_BRAND_REASSIGNED` | branch | **YES — mandatory** | "with a full audit record" | FR-PLT-004 [S] |
| `BRANCH_STATUS_CHANGED` | branch | **YES** | availability-affecting configuration | D-03 + brief §19 |
| `BRAND_CREATED` / `BRAND_UPDATED` | brand | YES | tenant-level configuration mutation | brief §19 |
| `BRANCH_CREATED` / `BRANCH_UPDATED` | branch | YES | tenant-level configuration mutation | brief §19 |
| `WAREHOUSE_*` | warehouse | YES | tenant-level configuration | brief §19 |
| `CENTRAL_KITCHEN_*` | central_kitchen | YES | tenant-level configuration | brief §19 |
| `STATION_*` | station | YES | operational routing configuration | brief §19 |
| `PRINT_ROUTING_*` | print_routing | YES | operational routing configuration | brief §19 |
| `STATION_ROUTING_*` | station_routing_rule | YES | operational routing configuration | brief §19 |
| `TABLE_*` | table | YES | branch configuration | brief §19 |
| `OPERATING_HOURS_*` | operating_hours | YES | feeds the out-of-hours fraud control | §22 control catalogue |
| any read / list | all | **NO** | do not audit SELECT | brief §19 |

Use `AuditService.record(tx, …)` inside the mutation's own `withAuthContext`
transaction. No secrets in metadata; tenant identity from context only; no
second audit mechanism.

---

## 16. API Surface Proposal (design only — no controllers or DTOs)

| Endpoint | Classification |
|---|---|
| `POST /branches/:branchId/brand` | **ADR-MANDATED** (D-13) + **SOURCE-MANDATED** (FR-PLT-004) |
| `POST` / `GET` / `GET /:id` / `PATCH` on `/brands`, `/branches`, `/warehouses`, `/central-kitchens`, `/stations`, `/branches/:id/tables`, `/branches/:id/operating-hours`, `/print-routing`, `/station-routing-rules` | **REPOSITORY CONVENTION** — REST shape follows `terminal.controller.ts`; the SRS specifies no HTTP surface |
| No `DELETE` on any Phase 15 resource | **ADR-MANDATED** (D-12) |
| No generic `PATCH` accepting `brandId` | **ADR-MANDATED** (D-13) |
| Error codes 401 / 403 / 404 / 409 / 400 | **REPOSITORY CONVENTION** |
| Pagination, filtering, sorting | **NOT SPECIFIED** by any source |
| FR-PLT-004's "explicit warning" delivery | **NOT SPECIFIED** — UI concern, no API contract |

DTO rules (repository convention): no DTO accepts `tenantId`; no DTO accepts an
ownership field the server derives; unknown fields rejected with 400 via
`forbidNonWhitelisted`; id-shaped fields validated with `UUID_PATTERN`.

---

## 17. Offline / ID / HLC Analysis

| Entity | Client-generated ID | HLC / sync metadata | Verdict |
|---|---|---|---|
| Brand | not required | not required | **NOT REQUIRED** |
| Branch | not required | not required | **NOT REQUIRED** |
| Warehouse | not required | not required | **NOT REQUIRED** |
| CentralKitchen | not required | not required | **NOT REQUIRED** |
| Station | not required | not required | **NOT REQUIRED** |
| Table | not required | not required | **NOT REQUIRED** |
| OperatingHours | not required | not required | **NOT REQUIRED** |
| PrintRouting | not required | not required | **NOT REQUIRED** |
| StationRoutingRule | not required | not required | **NOT REQUIRED** |

**SRS reference.** FR-OFF-015 [M] scopes client-generated ULIDs to "entities
created **on a device**". The §20 sync/HLC apparatus and the approved SQL's
`hlc` / `sync_state` columns appear only on transactional tables
(`sales.orders`, `sales.order_lines`). **No `org` table in the approved SQL
carries any sync column.**

Server-side ULID-as-UUID generation via `newId()` is retained (SRS §25.1 / §7.2).
**No sync fields are added speculatively.** Note that FR-BRN-008 [S] (branch
template) and offline branch provisioning are out of scope, so nothing here
forecloses a later sync design.

---

## 18. Test Matrix

### Authentication

- Every Organisation endpoint, unauthenticated → **401**.

### Authorization (RBAC)

- Missing / wrong permission code → **403**.
- `settings.branch.read` cannot perform any mutation → **403**.
- Client-supplied `tenantId` in body → **400** (`forbidNonWhitelisted`) or ignored.
- Client-supplied ownership field (e.g. `brandId` on a generic update) → rejected.

### Tenant isolation (per entity × 9)

- Tenant A sees its own records.
- Tenant A cannot see Tenant B → **404** (no existence disclosure).
- Tenant A cannot update Tenant B → **404**.
- Tenant A cannot delete Tenant B → **404**.
- Tenant A cannot spoof `tenant_id` in the request body.

### RLS (as `ros_app`, through `withAuthContext`)

- Valid tenant context → expected rows.
- **Missing tenant context → fail closed** (zero rows / rejected write).
- Cross-tenant SELECT, UPDATE, DELETE, INSERT for all nine tables — **including
  the five branch-inherited tables**, which FR-PLT-013's `tenant_id`-column
  sweep does **not** reach and which therefore need explicit cases.

### Relationship security (composite-FK proofs)

- Branch → foreign-tenant Brand → rejected by composite FK.
- Warehouse → foreign-tenant Branch → rejected by composite FK.
- CentralKitchen → foreign-tenant Warehouse → rejected by composite FK.
- Station → foreign-tenant Branch → rejected by RLS `WITH CHECK`.
- Station → foreign-tenant / foreign-branch Terminal → rejected by composite FK.
- Table → foreign-tenant Branch → rejected by RLS `WITH CHECK`.
- PrintRouting → Station in another branch → rejected by composite FK.
- StationRoutingRule → Station in another branch → rejected by composite FK.

### Uniqueness (409)

- Each of the constraints in §9, **including a `print_routing` duplicate with
  `station_id IS NULL`** — the exact case Blocker 1 identifies as currently
  passing.

### Regression

- The entire Phase 1–14 unit and e2e suite must pass unchanged.

No test case implies a business requirement not present in the sources.

---

## 19. Documentation Plan (proposed contents — files not created)

`backend/docs/organisation/`

| File | Contents |
|---|---|
| `README.md` | Scope, the nine entities, what is deliberately absent and why |
| `architecture.md` | Layering, aggregate roots (§5), transaction boundaries, module structure |
| `domain-model.md` | Field-level specification (§6), relationship matrix (§7), SRS traceability |
| `authorization.md` | The four permission codes, entity mapping, **the explicit D-02 intra-tenant gap** |
| `rls.md` | Direct vs inherited anchors, policy shapes, fail-closed proof, composite-FK rationale |
| `security-review.md` | Phase 15 security checklist, cross-tenant matrix results, accepted deviations |

---

## 20. Contradictions / Ambiguities

1. **§7.3 #5 vs §7.3 #24** — Station is listed both as a Branch-contained entity
   and as a Kitchen Ops aggregate root. *Resolved by ratified D-07; recorded,
   not reconciled.*
2. **FR-PLT-001 [M] vs §7.3 / glossary / BR-PLT-001 / FR-BRN-015 + approved
   SQL** — Warehouse and Central Kitchen ownership. *Resolved by ratified D-08
   as an accepted deviation from a mandatory requirement.*
3. **`business_day_cutover` per-row vs per-branch** — the column sits on each
   weekday row, while the SRS glossary treats the business day as a branch-level
   property; seven rows could disagree. Implemented verbatim.
   **Unresolved by source.**
4. **SRS attributes with no column** — station display colour (FR-KDS-001 [M]),
   branch country pack (FR-BRN-002 [M]), seat count / floor area
   (FR-BRN-011 [S]), aggregate `version` (§24.6.4), permission sensitivity
   marker (FR-SEC-012 [M]). **Not invented.**
5. **`print_routing` has no priority and no active column** — both were asked
   about; neither source defines them. **Not invented.**
6. **`station_routing_rules.menu_item_id` / `category_id`** — both-null and
   both-set are unconstrained; no source rule exists. **Not invented.**
7. **`onDelete` on org → tenant FKs** — the approved SQL specifies none
   (⇒ `RESTRICT`), while the shipped `Terminal.tenant` uses `Cascade`. The
   approved SQL is followed per the stated priority order; the inconsistency is
   flagged rather than silently harmonised.

---

## 21. Known Deferred Requirements

| Item | Deferred to | Requirement status |
|---|---|---|
| Scope-aware RBAC (D-02) | Dedicated RBAC-scope phase | **FR-SEC-002/003/004 [M] unmet** |
| Branch groups (D-10) | RBAC-scope phase | **FR-BRN-005 [M] unmet** |
| Settings cascade (D-11) | Dedicated settings phase | **FR-PLT-025/026/028 [M] unmet** |
| Location abstraction (D-14) | Inventory | BR-PLT-001 mechanism undefined |
| `terminals.branch_id → org.branches` FK (D-16) | Follow-up | Annotated intent in approved SQL |
| Station routing resolution (FR-KDS-010) | Kitchen Ops | Configuration only this phase |
| Table live state (D-05) | Sales | FR-POS-081 [S] |
| Floor-plan geometry (FR-POS-080) | Sales | [S] |
| Branch scorecard (FR-BRN-010…014) | Analytics | [S] / [C] |
| Branch template (FR-BRN-008) | After Catalogue + Workforce | [S] |
| Central menu / recipe override (FR-BRN-006/007) | Catalogue / Production Spec | [S] |
| Franchise support (FR-BRN-035…037) | After D-10 + Fiscal | [C] |

---

## 22. Implementation Readiness Verdict

# BLOCKED — CLARIFICATION REQUIRED

Three blockers. The first two were discoverable only by validating the candidate
schema, not by reading the sources.

### Blocker 1 — the ratified D-15 `print_routing` unique does not enforce what it states

- **Exact source.** ADR 0008 D-15, `print_routing (branch_id, document_type,
  station_id)`; approved SQL declares `station_id UUID` **nullable**.
- **Exact conflict.** PostgreSQL treats `NULL`s as distinct in unique
  constraints. The generated DDL is a plain
  `CREATE UNIQUE INDEX … ("branch_id","document_type","station_id")`, so
  **unlimited duplicate `(branch, 'receipt', NULL)` rows are permitted** —
  precisely the branch-default routing rule the constraint exists to make
  unique.
- **Why it materially affects schema / security / API.** D-15's stated purpose
  is 409 conflict semantics; for the most common row shape there is no conflict
  to detect. Print routing is a lookup keyed by this triple and is meaningless
  with duplicates. The API would silently accept contradictory configuration.
- **Minimum decision required.** Choose one:
  (a) `UNIQUE … NULLS NOT DISTINCT` via raw SQL — available on PostgreSQL 15+,
  and `docker-compose.yml` pins **postgres:16**; Prisma cannot express it, so
  the migration would drop and recreate Prisma's index;
  (b) two partial unique indexes (one `WHERE station_id IS NULL` on
  `(branch_id, document_type)`, one on all three `WHERE station_id IS NOT NULL`);
  (c) accept the gap and document it.

### Blocker 2 — implementing D-09 and D-16 in Prisma requires back-relation fields on `Tenant` and `Terminal`

- **Exact source.** ADR 0008 D-16 authorised "`UNIQUE(branch_id, id)` — **index
  only**, no column added, no column altered, no semantics change, no Identity
  application code touched." The approved SQL places
  `tenant_id … REFERENCES identity.tenants(id)` on brands, branches, warehouses
  and central_kitchens.
- **Exact conflict.** Prisma requires **both** sides of every relation to be
  declared. Modelling those foreign keys means adding `brands Brand[]`,
  `branches Branch[]`, `warehouses Warehouse[]`, `centralKitchens
  CentralKitchen[]` to the `Tenant` model, and `displayStations Station[]` to
  the `Terminal` model — edits to Identity model blocks. Declaring the FKs only
  in raw SQL is **not** a safe alternative: Prisma manages foreign keys, so an
  undeclared constraint reads as drift and a later `prisma migrate dev` would
  generate a migration to drop it.
- **Why it materially affects schema / security / API.** It touches Identity
  model declarations — adjacent to the hard-stop on modifying Auth architecture
  — and changes the generated Prisma client types. It adds no column, no table
  change and no behaviour, and it is the minimum required to honour D-09 and
  D-16 as ratified.
- **Minimum decision required.** Confirm that additive back-relation fields on
  `Tenant` and `Terminal` fall within D-16's "no behaviour change"
  authorisation — or direct that the `tenant_id → identity.tenants` foreign keys
  be dropped from the org tables, which would itself be an unratified deviation
  from the approved SQL.

### Blocker 3 — environment verification outstanding

- **Exact source.** Phase 15 brief §25 and §31 (pre-migration state, no drift).
- **Exact issue.** Docker is not running, so `prisma migrate status` cannot
  confirm that all eight migrations are applied and that no drift exists.
- **Why it matters.** Not architectural, but the Phase 15 migration must not be
  authored against an unverified baseline.
- **Minimum action required.** Start Docker Desktop, then `npm run db:up`, then
  `npx prisma migrate status`.

---

## Change control

Nothing in the repository was created or modified during this discovery other
than this report. No migration, no `schema.prisma` change, no controllers,
services, repositories, DTOs or guards, no Auth, TenantContext, PermissionGuard,
RLS, seed, test or generated-code changes. Schema validation was performed
against a throwaway scratchpad copy outside the repository.

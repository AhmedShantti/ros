# ADR 0008 — Organisation bounded context (foundation)

- Status: **Accepted.** All fourteen open decisions were ratified by the project
  owner on 2026-08-15. No Phase 15 code, schema, or migration exists yet —
  ratification authorises implementation; it does not constitute it.
- Date: 2026-08-15
- Phase: 15
- Deciders: Project owner (ratified interactively, decision by decision,
  2026-08-15). Thirteen decisions were ratified as recommended; **D-17 was
  changed** by the owner from the recommended verbatim `VARCHAR` to an enum.
- Supersedes: nothing. Amends: nothing (see "Relationship to ADR 0001–0007").

> **Reading note.** Every decision below carries an explicit status:
> **RATIFIED** (explicitly approved by the project owner), **SAFE** (derivable
> from the SRS or existing architecture; no ratification needed), or
> **DEFERRED**. Fourteen decisions were presented individually with their SRS
> evidence, SQL evidence, and the consequences of accepting versus rejecting;
> each was answered explicitly. Nothing was resolved by inference. The
> deviations and knowingly unmet mandatory requirements recorded below survive
> ratification unchanged — they are accepted, not discharged.

## Context

Authentication is complete through Phase 14 (ADR 0001–0007). Phase 15 builds the
Organisation bounded context — the first business context — on top of that
foundation. Organisation is where `tenant_id` stops being an identity concern and
starts being the anchor for every subsequent context: `sales.orders.branch_id`,
`kitchen.tickets.station_id`, `treasury.drawers.branch_id`,
`ck.production_orders.central_kitchen_id`, `workforce.scheduled_shifts.station_id`
and `inventory.stock_levels.location_id` all resolve here. Errors made now
propagate into every later phase, which is why this ADR is written before any
code.

Discovery (2026-08-15) inspected the full SRS (ROS_SRS_v1.0.pdf, 161 pp),
`ROS_DrawDB_Compatible_v3.sql`, ADR 0001–0007, `prisma/schema.prisma`, all eight
applied migrations, and the identity/governance modules. It produced a decision
register of 19 items. This ADR formalises D-01 … D-17; D-18 (SRS attributes with
no column) and D-19 (approved-SQL columns with unclear semantics) are catalogued
under "Deferred and catalogued items".

Three discovery findings frame everything below.

**The approved SQL is an ERD artifact, not a deployment script.** It contains no
`ROW LEVEL SECURITY`, no `CREATE POLICY`, no `GRANT`, no `current_setting`, and
not one `CREATE INDEX` for any `org` table. It therefore does not conflict with
the Phase 8 RLS architecture — it is silent on it. All Organisation RLS and
indexing is governed by SRS FR-PLT-010 … FR-PLT-014 plus the Phase 8/9 precedent
(ADR 0003, ADR 0004).

**PostgreSQL evaluates referential-integrity checks with row security disabled.**
RLS hides another tenant's row from `SELECT`, but does not prevent a foreign key
pointing at it. Single-column FKs are therefore insufficient to make cross-tenant
parenting impossible (D-09).

**The shipped RBAC key cannot express the SRS scope model.** ADR 0001 replaced the
approved `identity.user_roles` with `membership_roles(membership_id, role_id,
branch_id?)` keyed `@@id([membershipId, roleId])`. That key admits one row per
membership+role, so "Cashier at Branch 1 and Cashier at Branch 2" — the shape
FR-SEC-003 requires — is unrepresentable (D-02).

## Preserved architecture (non-negotiable, unchanged by this ADR)

Phase 15 consumes the following and changes none of it:

- **`TenantContext`** — server-derived from the signed JWT, validated once per
  request by `TenantContextService`, memoised at `request.authorization`. No
  tenant identity is ever read from body, query, headers, or DTO.
- **`PrismaService.withAuthContext(scope, fn)`** — the single mechanism
  establishing DB tenant context. One interactive transaction whose first
  statement is
  `SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)`.
  Transaction-local; never nested; no second mechanism; no manual
  `SET app.tenant_id`; no `AsyncLocalStorage`; no global mutable state.
- **`ros_app`** — runtime role, `NOSUPERUSER`, `NOBYPASSRLS`, no DDL. Migrations
  run separately as `ros_migrator`. No migrator runtime path.
- **PostgreSQL RLS** — `ENABLE` + `FORCE`, per-operation policies, predicates read
  as `NULLIF(current_setting('app.tenant_id', true), '')::uuid` so that missing
  context yields `NULL` → false → **fail closed** (FR-PLT-012).
- **Guard chain** — `JwtAuthGuard` (401) → `TenantContextGuard` (403) →
  `PermissionGuard` (403) → controller → service → Prisma → RLS.
- **`AuditService`** — the only audit implementation (ADR 0007).

## Scope of Phase 15

**In scope.** Brand, Branch, Warehouse, Central Kitchen, Station, Table,
Operating Hours, Station Routing (configuration only), Print Routing
(configuration only); their RLS policies, grants, indexes; authorization
integration through the existing `PermissionGuard`; audit integration through the
existing `AuditService`; unit and e2e coverage including the cross-tenant matrix.

**Explicitly out of scope.** Catalogue, Production Spec, Inventory, Procurement,
Sales, Kitchen Ops behaviour, Treasury, Workforce, CRM, Fiscal, Sync,
Integrations, Analytics. Also out of scope within Organisation: branch groups
(D-10), the settings cascade (D-11), the location abstraction (D-14), and
branch-scoped RBAC (D-02).

**No behaviour is implemented for configuration this phase creates.** Station
routing rules are stored, not resolved (FR-KDS-010 is Kitchen Ops). Print routing
is stored, not dispatched. `branches.automatic_availability` is stored, not acted
on (FR-MNU-031 is Catalogue + Inventory).

---

## Decisions

### D-01 — Organisation permission codes

- **Status: RATIFIED** (2026-08-15). The SRS permission catalogue is
  incomplete; the two invented read codes were explicitly approved.
- **Decision (ratified).** Guard Organisation endpoints with the two SRS codes
  `settings.tenant.manage` (tenant-level objects: brand, warehouse, central
  kitchen) and `settings.branch.manage` (branch-level objects: branch
  configuration, station, table, operating hours, routing), plus exactly two
  invented read companions, `settings.tenant.read` and `settings.branch.read`.
  All four are seeded through the existing `PermissionsService.upsertMany` and
  declared with the existing `@RequirePermission` decorator. The two invented
  codes are marked provisional and carry a documented remap procedure.
- **Rationale.** SRS §15.2 states the catalogue is "representative rather than
  exhaustive; the full catalogue is maintained in Appendix C" — and the document
  contains no Appendix C (the string occurs exactly once, in that sentence). The
  only Organisation-adjacent codes in the entire SRS are `settings.branch.manage`
  and `settings.tenant.manage`. Using only those makes a read-only Organisation
  role unexpressible, contradicting the §15.3 Auditor role ("Read-only everything
  including audit log"). Inventing a full 18-code `organisation.<entity>.<action>`
  taxonomy maximises the chance of colliding with the real Appendix C, and a
  later rename across roles, role_permissions, seeds, tests and docs is a *silent
  privilege change* on any tenant that has already composed custom roles
  (FR-SEC-011). Two symmetric read codes are the smallest addition that restores
  the read/write split.
- **SRS references.** §15.2 (catalogue + Appendix C); §15.3 (standard roles,
  Auditor); FR-SEC-011 [M] custom roles from the catalogue; FR-SEC-012 [M]
  per-permission description and sensitivity marker.
- **SQL/schema evidence.** `identity.permissions(id, code VARCHAR(80) UNIQUE,
  description TEXT NOT NULL, module VARCHAR(32) NOT NULL)`; the approved SQL's
  own comment gives the code style (`-- e.g. order.cancel_after_production`).
  Structure exists, contents do not. `identity.permissions` has no sensitivity
  column, so FR-SEC-012's marker is unimplementable (see D-18).
- **Security implications.** Collapsing read into manage over-grants: anyone able
  to view branch configuration would also be able to mutate it. Conversely a
  fabricated fine-grained catalogue encodes authorization semantics the SRS may
  later contradict; renaming a code that tenants have already granted changes
  effective privilege without any visible role edit.
- **Tenant/RLS implications.** None. Permissions are a global reference catalogue
  and are deliberately not RLS-scoped (ADR 0003, "Excluded tables"). Permission
  resolution remains membership-scoped and unchanged.
- **Classification.** Implementation decision using SRS-mandated codes, **plus an
  explicit deviation** (two invented codes) requiring ratification.

### D-02 — RBAC assignment scope (tenant | brand | branch-set | branch)

- **Status: RATIFIED as DEFERRED** (2026-08-15). Scope-aware RBAC is deferred
  to a dedicated later phase. FR-SEC-002/003/004 [M] remain knowingly unmet.
- **Decision (ratified).** **Branch-scoped RBAC is NOT implemented in Phase 15.**
  Organisation ships tenant-scoped authorization only.
  `TenantContext.branchId` remains declared and **unpopulated**;
  `membership_roles.branch_id` remains present and **unconsumed**;
  `PermissionGuard` and `TenantContextService` are not modified. The
  FR-SEC-002/003/004 gap is recorded here as a known, dated deviation. Scope-aware
  RBAC receives its own phase, its own ADR superseding the relevant parts of
  ADR 0002 and ADR 0004, and its own security review.
- **This must not be implemented accidentally in Phase 15.** Concretely, during
  Phase 15 no code may: populate `TenantContext.branchId`; read
  `membership_roles.branch_id` in any authorization path; add a branch parameter
  to `PermissionGuard`, `@RequirePermission`, or `TenantContextService.require`;
  or introduce a per-branch permission check in an Organisation service. Any
  Organisation endpoint that would need branch-level least privilege must instead
  be guarded at tenant level and the limitation noted, not worked around.
- **Rationale.** ADR 0002 ("Branch scope") and ADR 0004 ("Branch authorization —
  DEFERRED") both deferred this *until the org/branch context and SRS branch rules
  are available*. Phase 15 satisfies that precondition, so deferral is now a
  conscious re-decision rather than an inherited default. It is re-deferred
  because implementing it means changing the single most security-critical and
  most-tested path in the repository — the resolver that Phase 13 and 14 signed
  off — inside a phase that is simultaneously introducing nine new entities, ten
  new tables and a new schema. Two large changes in one verification gate is the
  condition under which cross-tenant regressions get missed. Additionally the
  shipped primary key blocks the full model outright: `@@id([membershipId,
  roleId])` permits one row per membership+role, so FR-SEC-003's own worked
  example ("Branch Manager at Branch 1 and Cashier at Branch 2") is only
  half-representable and "Cashier at Branch 1 **and** Cashier at Branch 2" is not
  representable at all. Fixing that is a change to the RBAC table's identity, not
  an additive column.
- **SRS references.** FR-SEC-002 [M] "Role assignments SHALL carry a scope,
  restricting the assignment to a tenant, a brand, a set of branches, or a single
  branch"; FR-SEC-003 [M] multiple assignments with different scopes;
  FR-SEC-004 [M] "effective permissions SHALL be the union of granted permissions
  within each assignment's own scope. Permissions SHALL NOT leak across scopes";
  FR-SEC-005 [S] validity dates; §15.3 (Scope column on every standard role);
  FR-BRN-005 [M] branch groups as "a reporting and **permission-scoping**
  dimension".
- **SQL/schema evidence.** Approved: `identity.user_roles(user_id, role_id,
  branch_id) PRIMARY KEY (user_id, role_id, branch_id)` — single optional branch
  only, no brand scope, no branch-set, no validity dates; and the key is
  unimplementable as written because a PK column cannot be NULL, contradicting
  its own `-- optional scoping to a single branch` comment. Shipped (ADR 0001
  override): `membership_roles(membership_id, role_id, branch_id?)` with
  `@@id([membershipId, roleId])` and `branch_id` nullable and outside the key.
  `TenantContext.branchId` is declared optional and documented "RESERVED — not
  populated this phase".
- **Security implications.** This is a knowingly accepted **intra-tenant**
  authorization gap: within one tenant, a principal holding
  `settings.branch.manage` can mutate every branch, not only the branches they
  operate. It is **not** a cross-tenant gap — RLS, `withAuthContext` and the
  guard chain are unchanged, and the cross-tenant boundary is untouched. The gap
  must be stated in `docs/organisation/authorization.md` and in the Phase 15
  security review rather than left implicit. The alternative — modifying the
  resolver now — carries a cross-tenant risk, which is strictly worse.
- **Tenant/RLS implications.** None. All Organisation RLS anchors on
  `app.tenant_id` only. No branch predicate enters any policy this phase, so the
  later introduction of branch scoping is additive at the policy layer rather
  than a rewrite.
- **Classification.** Explicitly **deferred**; the unimplemented portion of
  FR-SEC-002/003/004 [M] is a documented deviation from the SRS, not from the SQL.

### D-03 — Branch lifecycle (`branches.status`)

- **Status: RATIFIED** (2026-08-15).
- **Decision (ratified).** `status` is an availability flag with exactly two
  values, `active | inactive`, modelled as a Prisma enum with a matching DB
  constraint. It is **not** a state machine: no transition graph, no guard
  conditions, no side effects, and no security meaning this phase.
- **Rationale.** The column is `NOT NULL` and must be given a domain, but neither
  source defines one. The SRS defines a *tenant* lifecycle and no *branch*
  lifecycle. §24.6.5 requires master data to be deactivatable, which two values
  satisfy. Copying the eight-state tenant lifecycle onto branches would import
  semantics the SRS never sanctions; leaving `VARCHAR(16)` free-form puts
  unconstrained text into a column later code will branch on. Phase 14 invented
  `TerminalStatus` only because that brief explicitly authorised "minimum-safe +
  document"; the Phase 15 brief instead forbids inventing state machines, so the
  domain is kept to the minimum that makes the column meaningful.
- **SRS references.** §6.3 tenant lifecycle (the only lifecycle defined);
  §24.6.5 "Soft Delete with Referential Preservation"; FR-PLT-021 [M] no data
  destruction. No FR defines a branch lifecycle.
- **SQL/schema evidence.** `org.branches.status VARCHAR(16) NOT NULL DEFAULT
  'active'` — no CHECK, no comment. Notably every sibling status column in the
  approved SQL *does* carry an inline value list
  (`warehouse_type -- branch, central, virtual`;
  `tables.status -- free, seated, reserved`;
  `ck.production_orders.status -- planned, in_progress, completed, cancelled`).
  `branches.status` is the exception.
- **Security implications.** Branch status will eventually gate terminal binding
  and order opening. Choosing values now that later acquire security meaning —
  e.g. a `suspended` value that some future code treats as blocking login —
  would create an authorization semantic by accident. Two values with no
  behaviour attached minimises that surface.
- **Tenant/RLS implications.** None; `branches` carries a direct `tenant_id` and
  is isolated by the standard policy set regardless of status.
- **Classification.** Explicit **deviation** from the approved SQL (constrains an
  open `VARCHAR` and introduces an enum, following the ADR 0004 precedent).

### D-04 — Operating hours: overlap policy and day-of-week origin

- **Status: RATIFIED** (2026-08-15), both sub-questions. A third sub-question
  (overnight operation) was already resolved by the SRS glossary and needed no
  ratification.
- **Resolved (SAFE): overnight operation.** `closes_at < opens_at` denotes an
  interval crossing midnight. This is directly mandated, not inferred: the SRS
  glossary defines Business Day as "An operational day, which may not align with
  the calendar day. **A branch closing at 03:00 attributes those sales to the
  previous business day.**"
- **Decision (ratified), overlap.** Multiple intervals per (branch, weekday) are
  permitted — this is how split shifts (11:00–15:00, 18:00–23:00) are modelled —
  but *overlapping* intervals on the same weekday are rejected with 400. No
  unique constraint is added.
- **Decision (ratified), origin.** `day_of_week` is `0 = Sunday … 6 = Saturday`,
  aligned with PostgreSQL `EXTRACT(DOW)`.
- **Rationale.** The approved SQL's deliberate omission of a unique constraint on
  `(branch_id, day_of_week)` implies multiple rows per weekday are intended, and
  split shifts are near-universal in the target market (SRS §2.3). Nothing in
  either source states whether overlaps are an error, a union, or acceptable
  data; rejecting them is the conservative reading, since a union silently
  accepts contradictory configuration. Aligning the weekday origin with
  `EXTRACT(DOW)` avoids a translation layer in later analytics joins
  (`analytics.dim_date.day_of_week` is equally unanchored). **Both remain
  guesses about intent and are not resolved unilaterally.**
- **SRS references.** FR-BRN-002 [M] each branch holds its own operating hours and
  timezone; glossary "Business Day"; §22 control catalogue, "Transactions outside
  trading hours — Sales recorded when the branch is closed" (operating hours feed
  fraud detection). No FR addresses overlap or weekday numbering.
- **SQL/schema evidence.** `org.operating_hours(id, branch_id → org.branches ON
  DELETE CASCADE, day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND
  6), opens_at TIME NOT NULL, closes_at TIME NOT NULL, business_day_cutover TIME
  NOT NULL DEFAULT '00:00')`. No unique constraint; no `tenant_id`.
- **Security implications.** None directly. Operational and financial impact is
  material: a wrong weekday origin shifts every branch's trading calendar by one
  day, generating false out-of-hours fraud flags on legitimate trade and masking
  genuine after-hours activity.
- **Tenant/RLS implications.** `operating_hours` carries no `tenant_id` (approved
  design). Isolation is inherited through the parent branch — see "Tenant
  isolation model" below.
- **Classification.** Overnight semantics = **SRS-mandated**. Overlap policy and
  weekday origin = **inferred**, requiring ratification. A separate open modelling
  question is recorded in D-19: `business_day_cutover` is per-row (per weekday)
  although the glossary describes the business day as a branch-level property, so
  seven rows could disagree.

### D-05 — `org.tables.status`

- **Status: RATIFIED** (2026-08-15).
- **Decision (ratified).** Omit `status` from `org.tables` in Phase 15. Ship
  `label`, `section`, `seat_capacity` as pure configuration. Live table state is
  introduced by the Sales phase with its own conflict semantics.
- **Rationale.** The two sources define different, non-overlapping state sets, and
  the SRS's set is explicitly *live* state driven by the order lifecycle. The SRS
  also classifies table state as "low stakes, **high churn**", resolved
  last-writer-wins with HLC — a write pattern that does not belong on a
  configuration row. Storing it in the Organisation aggregate would mean the Sales
  context mutating an Organisation-owned row, breaking the aggregate boundary the
  Phase 15 brief requires, and would route every seat/clear event through the
  Organisation audit trail.
- **SRS references.** FR-POS-081 [S] live table state: "available, seated,
  ordered, food served, bill requested, payment in progress, needs cleaning"
  (seven values); FR-POS-080 [S] floor plan editor; FR-POS-082 [S] merge/split/
  transfer with audit; §20 sync conflict table, "Table state — last-writer-wins
  with HLC — low stakes, high churn".
- **SQL/schema evidence.** `org.tables(id, branch_id → org.branches ON DELETE
  CASCADE, label VARCHAR(16) NOT NULL, section VARCHAR(64), seat_capacity
  SMALLINT, status VARCHAR(16) NOT NULL DEFAULT 'free' -- free, seated,
  reserved)`, `CONSTRAINT uq_table_label UNIQUE (branch_id, label)`. Also
  `sales.orders.table_id UUID REFERENCES org.tables(id)`.
- **Security implications.** Negligible directly. The aggregate-boundary argument
  is the substantive one: if Sales can write Organisation rows, the invariant
  "only Organisation endpoints mutate Organisation data" becomes false, which
  weakens the basis for auditing and authorising those mutations in one place.
- **Tenant/RLS implications.** None. `org.tables` carries no `tenant_id`;
  isolation is inherited through the parent branch either way.
- **Classification.** Explicit **deviation** from the approved SQL — a `NOT NULL`
  column present in the approved design is not created.

### D-06 — `kitchen.station_routing_rules` schema placement

- **Status: RATIFIED** (2026-08-15).
- **Decision (ratified).** Create the `kitchen` schema in Phase 15 containing
  **only** `station_routing_rules`, with `ros_app` grants, default privileges for
  `ros_migrator`-created tables, and RLS inherited through `branch_id`. Expose it
  as Organisation configuration API. No Kitchen Ops behaviour is implemented — no
  tickets, no ticket lines, no routing resolution.
- **Rationale.** Both authoritative sources place this table in `kitchen`, and
  §25.1's schema map is normative. Relocating it to `org` would create a permanent
  divergence from the schema map that every future Kitchen query must account for.
  Creating a schema ahead of its context is well precedented: Phase 12 created
  `governance` for `audit_entries` alone. Storing routing *configuration* is not
  implementing the Kitchen context; FR-KDS-010's resolution precedence is the
  behaviour, and it stays out.
- **SRS references.** §25.1 schema map — `org` = "brands, branches, warehouses,
  central_kitchens, stations, tables, settings"; `kitchen` = "tickets,
  ticket_lines, **station_routing_rules**". FR-KDS-010 [M] routing resolution
  precedence (Kitchen Ops behaviour, out of scope). §7.3 #24 lists RoutingRules as
  contained entities of the Station aggregate.
- **SQL/schema evidence.** `CREATE TABLE kitchen.station_routing_rules (id UUID
  PRIMARY KEY, branch_id UUID NOT NULL REFERENCES org.branches(id), station_id
  UUID NOT NULL REFERENCES org.stations(id), menu_item_id UUID, category_id UUID,
  priority SMALLINT NOT NULL DEFAULT 0)`. `menu_item_id` and `category_id` are
  intentionally FK-less (Catalogue does not exist); the comment reads
  `nullable = category rule`. No `active` flag, no uniqueness, no `tenant_id`.
- **Security implications.** A new schema requires its own `GRANT USAGE`, explicit
  table DML grants, and `ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator` — the
  same pattern as `governance`, and a missed grant fails closed (permission
  denied) rather than open. The rows have no independent tenant anchor; isolation
  rests entirely on `branch_id → org.branches.tenant_id`, which is sound provided
  D-09's composite FK prevents a cross-tenant `branch_id`.
- **Tenant/RLS implications.** `ENABLE` + `FORCE`; all four operations gated by
  `EXISTS (SELECT 1 FROM org.branches b WHERE b.id = branch_id AND b.tenant_id =
  NULLIF(current_setting('app.tenant_id', true), '')::uuid)`.
- **Classification.** **SRS-mandated placement**; the decision requiring
  ratification is *timing* (creating a future context's schema during Phase 15).

### D-07 — Station aggregate ownership

- **Status: RATIFIED** (2026-08-15).
- **Decision (ratified).** Station is an **aggregate root within the Organisation
  context**, whose tenant scope is inherited through Branch, and which owns
  StationRoutingRules as child entities.
- **Rationale.** The SRS contradicts itself: §7.3 row #5 lists Stations among the
  Branch aggregate's contained entities, while §7.3 row #24 lists Station as an
  aggregate root in the Kitchen Ops context containing RoutingRules. An aggregate
  root cannot also be a contained entity, and the distinction is not cosmetic — it
  determines ownership, transaction boundary, repository boundary, and which
  mutations are permitted. The resolution weighs three facts: §25.1 places the
  table in `org`, not `kitchen`; the approved SQL gives stations their own table
  with their own primary key; and four future contexts reference
  `org.stations(id)` directly (`kitchen.tickets.station_id`,
  `catalogue.menu_items.station_id`, `workforce.scheduled_shifts.station_id`,
  `org.print_routing.station_id`). Entities referenced that widely behave as roots
  in practice. Treating Station as root reconciles #24's *structure* with §25.1's
  *placement*.
- **SRS references.** §7.3 #5 (Branch contains OperatingHours, Stations,
  PrintRouting); §7.3 #24 (Station | Kitchen Ops | contains RoutingRules); §25.1
  (`stations` under `org`); FR-KDS-001 [M] "definition of preparation stations per
  branch, with configurable name, display colour, and capacity"; §6.1 hierarchy
  (Station under Branch, sibling of Terminal).
- **SQL/schema evidence.** `org.stations(id UUID PRIMARY KEY, branch_id UUID NOT
  NULL REFERENCES org.branches(id) ON DELETE CASCADE, name VARCHAR(64) NOT NULL,
  capacity_config JSONB NOT NULL DEFAULT '{}', display_terminal_id UUID REFERENCES
  identity.terminals(id), created_at TIMESTAMPTZ)`. No `tenant_id`, no status, no
  colour column, no uniqueness.
- **Security implications.** Treating Station as a Branch-contained entity would
  be *stricter*: no `/stations/:id` endpoints, therefore no station-level object
  reference to abuse, with every mutation reached through a branch the caller has
  already been authorised for. Root status adds endpoints, each of which must
  resolve the station within the acting tenant (404 on cross-tenant, never 403)
  and rely on RLS as the final boundary. Under D-02's tenant-only scope the extra
  surface remains tenant-isolated.
- **Tenant/RLS implications.** Either way, `org.stations` carries no `tenant_id`
  and inherits isolation via `branch_id`. Root status does not change the policy;
  it changes the API surface those policies protect.
- **Classification.** **Inferred** resolution of a genuine SRS self-contradiction.
  Requires ratification precisely because it is a reading, not a derivation.

### D-08 — Warehouse and Central Kitchen ownership

- **Status: RATIFIED** (2026-08-15). Highest-scrutiny item: the ratified
  decision knowingly contradicts a mandatory requirement (FR-PLT-001 [M]). The
  conflict below is preserved in full and is not discharged by ratification.

**The conflict, stated exactly.**

*Position A — brand-owned.* SRS §6.1 "Tenancy Hierarchy" draws the tree:

```
Tenant
└── Brand
    ├── Branch          (selling location; inventory and cash boundary)
    │   ├── Terminal
    │   ├── Drawer
    │   └── Station
    ├── Warehouse       (non-selling stock location)
    └── Central Kitchen (production location)
```

Warehouse and Central Kitchen are drawn as children of **Brand**. FR-PLT-001 **[M]**
ratifies the diagram by reference: "The System SHALL model tenants, brands,
branches, warehouses, and central kitchens as distinct entities **with the
hierarchy above**."

*Position B — tenant-owned.* Four other SRS statements contradict Position A:

1. §7.3 #6 — Warehouse aggregate, key invariant: "**Belongs to one tenant**."
2. Glossary — "Warehouse: A stock-holding location that does not sell to end
   customers. May be standalone or **attached to a branch**." Brand is not
   mentioned; the only stated attachment is to a branch.
3. BR-PLT-001 — "Two brands operating from the same physical kitchen must be
   modelled as two branches **sharing a warehouse**, not as one location with two
   brands." A brand-owned warehouse cannot be shared by two brands, so Position A
   makes the SRS's own prescribed cloud-kitchen model impossible.
4. FR-BRN-015 [M] — "stock transfers between any two locations **within a
   tenant**." Transfers are scoped to the tenant, not the brand.

*Position C — the approved SQL.* Agrees with Position B and has no `brand_id`
at all:

```sql
CREATE TABLE org.warehouses (
    id             UUID PRIMARY KEY,
    tenant_id      UUID NOT NULL REFERENCES identity.tenants(id),
    name           VARCHAR(120) NOT NULL,
    warehouse_type VARCHAR(16) NOT NULL DEFAULT 'branch', -- branch, central, virtual
    branch_id      UUID REFERENCES org.branches(id),      -- NULL when standalone
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE org.central_kitchens (
    id           UUID PRIMARY KEY,
    tenant_id    UUID NOT NULL REFERENCES identity.tenants(id),
    warehouse_id UUID NOT NULL REFERENCES org.warehouses(id),
    name         VARCHAR(120) NOT NULL
);
```

- **Decision (ratified).** Adopt **Position B/C**: Warehouse and Central Kitchen
  are **tenant-owned**, carrying a direct `tenant_id` and no `brand_id`. A
  warehouse may optionally reference one branch; a central kitchen references
  exactly one warehouse.
- **What is being accepted, explicitly.** We accept a **deviation from
  FR-PLT-001 [M]** insofar as FR-PLT-001 incorporates the §6.1 tree's placement of
  Warehouse and Central Kitchen under Brand. Everything else in FR-PLT-001 is
  honoured: tenants, brands, branches, warehouses and central kitchens are modelled
  as distinct entities, and the Tenant → Brand → Branch spine of the tree is
  implemented exactly. What is **not** implemented is the Brand → Warehouse and
  Brand → Central Kitchen edges. This is a deviation from a **mandatory**
  requirement and is recorded as such, not glossed as a schema detail.
- **Rationale.** The SRS is internally inconsistent here and the ASCII tree is the
  outlier: four independent statements plus the approved SQL place these entities
  at tenant level, and one of them (BR-PLT-001) is a business rule whose stated
  rationale — cloud kitchens running 5–8 virtual brands from one kitchen — is
  *unimplementable* under brand ownership. Choosing the tree would break the SRS's
  own worked example.
- **SRS references.** Supporting brand ownership: §6.1 tenancy hierarchy tree;
  FR-PLT-001 [M] ("with the hierarchy above"). Supporting tenant ownership:
  §7.3 #6 (Warehouse — "Belongs to one tenant"); glossary, Warehouse ("standalone
  or attached to a branch"); BR-PLT-001 (two branches sharing a warehouse);
  FR-BRN-015 [M] (transfers between any two locations within a tenant). Also
  FR-BRN-020 [S], central kitchens as stock-consuming/producing locations. Note
  §7.3 defines **no** Central Kitchen aggregate at all — rows #4/#5/#6 cover
  Brand, Branch and Warehouse only.
- **SQL/schema evidence.** `org.warehouses(id, tenant_id UUID NOT NULL REFERENCES
  identity.tenants(id), name, warehouse_type VARCHAR(16) NOT NULL DEFAULT
  'branch', branch_id UUID REFERENCES org.branches(id), created_at)` and
  `org.central_kitchens(id, tenant_id UUID NOT NULL REFERENCES
  identity.tenants(id), warehouse_id UUID NOT NULL REFERENCES org.warehouses(id),
  name)` — reproduced in full in the conflict block above. Neither table has a
  `brand_id` column, and neither has any unique constraint (see D-15).
- **Security implications.** Ownership selects the RLS anchor. Tenant ownership
  gives both tables a direct `tenant_id` and the simple, fail-closed Phase 8 policy
  set. Brand ownership would make Brand the authorization parent, so a future
  brand-scoped role (§15.3 Brand Manager, Operations Director) would gate warehouse
  access — which only becomes meaningful once D-02 lands. Reversing this decision
  after data exists is a data migration **plus** an authorization-semantics change
  applied to live rows, which is materially harder than deciding it now.
- **Tenant/RLS implications.** Both tables carry `tenant_id NOT NULL` → direct
  `ENABLE` + `FORCE` policies on all four operations keyed on `app.tenant_id`,
  identical to the `terminals` precedent. `warehouses.branch_id` and
  `central_kitchens.warehouse_id` are cross-tenant-writable unless D-09 is
  ratified.
- **Classification.** **Explicit deviation from a mandatory SRS requirement**
  (FR-PLT-001's hierarchy edges), aligned with the approved SQL. Requires
  ratification.

### D-09 — Composite tenant-safe foreign keys

- **Status: RATIFIED** (2026-08-15). Structural security control.
- **Decision (ratified).** Add `UNIQUE (tenant_id, id)` to each tenant-scoped
  Organisation parent (`brands`, `branches`, `warehouses`) and make every
  child reference the composite key rather than the bare primary key — e.g.
  `branches FOREIGN KEY (tenant_id, brand_id) REFERENCES org.brands (tenant_id,
  id)`. For children that carry no `tenant_id` (operating_hours, stations,
  tables, print_routing, station_routing_rules), anchor sibling references on the
  branch composite instead — e.g. `print_routing FOREIGN KEY (branch_id,
  station_id) REFERENCES org.stations (branch_id, id)`, which requires
  `UNIQUE (branch_id, id)` on `org.stations`.
- **Rationale.** PostgreSQL evaluates referential-integrity checks with row
  security **disabled** — the RI triggers run as the constraint owner and are
  exempt from RLS. RLS therefore hides Tenant B's brand from Tenant A's `SELECT`,
  but does **not** prevent Tenant A inserting `branches(tenant_id = A, brand_id =
  <B's brand id>)`. The resulting row is invisible to B (its `tenant_id` is A) and
  visible to A, so reads still fail closed — but the tenancy graph is corrupted,
  FR-PLT-003 is violated, and any later join written through `brand_id` surfaces
  B's brand identity inside A. A composite FK makes the cross-tenant edge
  *unrepresentable* rather than merely *validated*, which is the difference the
  Phase 15 brief asks for ("Do not rely solely on application checks";
  "SQL constraints enforce structural invariants").
- **SRS references.** FR-PLT-003 [M] "Every tenant-scoped record SHALL carry an
  immutable tenant_id. Records SHALL NOT be transferable between tenants";
  FR-PLT-010 [M] RLS with both `USING` and `WITH CHECK`; FR-PLT-012 [M] fail
  closed; FR-PLT-013 [M] cross-tenant read *and write* isolation suite.
- **SQL/schema evidence.** Every Organisation FK in the approved SQL is
  single-column: `branches.brand_id → org.brands(id)`;
  `warehouses.branch_id → org.branches(id)`;
  `central_kitchens.warehouse_id → org.warehouses(id)`;
  `stations.branch_id`, `tables.branch_id`, `operating_hours.branch_id`;
  `print_routing.branch_id`, `print_routing.station_id`;
  `station_routing_rules.branch_id`, `station_routing_rules.station_id`;
  `stations.display_terminal_id → identity.terminals(id)` (see D-16). The
  approved SQL contains no unique constraint capable of supporting a composite
  reference.
- **Security implications.** Without this control, cross-tenant parenting is a
  *writable* edge in the foundation on which every later context builds, defended
  only by application code. With it, the database rejects the write regardless of
  application correctness — the same defence-in-depth argument that justified RLS
  in ADR 0003.
- **Tenant/RLS implications.** Complements RLS rather than replacing it. RLS
  governs visibility and the tenant of the row being written; composite FKs govern
  the tenant of the row being *referenced* — a case RLS structurally cannot cover.
  The additional `UNIQUE (tenant_id, id)` indexes also serve tenant-scoped lookups,
  so the cost is marginal.
- **Classification.** Explicit **deviation** from the approved SQL (additive DDL:
  unique indexes plus composite FKs). Precedent: ADR 0004 added two unique
  constraints as documented deviations.

### D-10 — Branch groups

- **Status: DEFERRED.**
- **Decision.** Not implemented in Phase 15. No `branch_groups` table, no
  membership table, no `group_id` column.
- **Rationale.** FR-BRN-005 is mandatory but has **no** schema support anywhere in
  the approved SQL, and §25.1's `org` contents list omits it. Its two consumers
  are permission scoping (D-02, deferred) and reporting (Analytics, far later).
  The SRS never states whether a branch may belong to several groups, whether
  groups nest, or whether a group is tenant- or brand-scoped — so any table built
  now would encode invented cardinality that later becomes authorization-relevant
  retroactively.
- **SRS references.** FR-BRN-005 [M] branch groups as "a reporting and
  permission-scoping dimension"; FR-SEC-002 [M] "a set of branches" as an
  assignment scope; §18 promotions scoped to "brand, branch, or branch group";
  FR-BRN-014 [C], FR-BRN-035…037 [C] franchise.
- **SQL/schema evidence.** No table, no column, no reference in the approved SQL.
- **Security implications.** Building it speculatively creates an
  authorization-relevant object with invented semantics.
- **Tenant/RLS implications.** None this phase.
- **Classification.** **Deferred** — to be decided together with D-02.
  FR-BRN-005 [M] is recorded as an unimplemented mandatory requirement.

### D-11 — Settings cascade (`org.settings`)

- **Status: DEFERRED.**
- **Decision.** Not implemented in Phase 15.
- **Rationale.** Out of the Phase 15 scope list, and the approved table cannot
  satisfy its own mandatory requirements: it models three of the six cascade
  levels FR-PLT-025 specifies (no Platform Default, no Country Pack, no Terminal),
  has no `locked` column for FR-PLT-026 [M], and no effective-dating for
  FR-PLT-028 [M]. It also has **no `tenant_id`**, and `scope_id` is a polymorphic
  UUID with no FK — so it cannot be RLS-anchored as designed without either adding
  `tenant_id` or writing a `scope_type`-aware policy. That is a design exercise,
  not a foundation task.
- **SRS references.** FR-PLT-025 [M] six-level resolver; FR-PLT-026 [M] locking
  with the locking level named; FR-PLT-027 [S] settings inspector; FR-PLT-028 [M]
  effective-dated financial settings interpreted at transaction time.
- **SQL/schema evidence.** `org.settings(id, scope_type VARCHAR(16) -- tenant,
  brand, branch, scope_id UUID, key VARCHAR(120), value JSONB, updated_at)`,
  `CONSTRAINT uq_setting UNIQUE (scope_type, scope_id, key)`. Listed under `org`
  in §25.1.
- **Security implications.** If built later to drive tax class or rounding policy
  (FR-PLT-028 names both), a cross-tenant `scope_id` write becomes a financial
  integrity issue. Whatever is eventually built must carry `tenant_id` and a
  `scope_type`-aware ownership check from the first migration.
- **Tenant/RLS implications.** None this phase. Recorded so the later design does
  not inherit the un-anchored `scope_id` uncritically.
- **Classification.** **Deferred.** Note the partial overlap with
  `brands.default_settings JSONB` and `brands.theme JSONB`, which *are* in scope —
  see D-19.

### D-12 — Deactivation versus deletion

- **Status: RATIFIED** (2026-08-15).
- **Decision.** Phase 15 exposes **no delete and no deactivate
  endpoints** for brand, warehouse, central kitchen, station, table, operating
  hours, or routing configuration. Resources are created, read and updated only.
  Branch alone carries `status` per D-03.
- **Rationale.** §24.6.5 is a normative persistence pattern, but the approved SQL
  provides no mechanism for it on seven of the nine Organisation entities, while
  simultaneously declaring `ON DELETE CASCADE` from branches to operating_hours,
  stations and tables. Adding seven `is_active` columns implements the pattern at
  the cost of a seven-column deviation with no consumer this phase; offering hard
  deletes contradicts §24.6.5 as soon as transactions reference these rows, which
  they will. Exposing no destructive path is the only option that neither invents
  schema nor contradicts the SRS.
- **SRS references.** §24.6.5 "Soft Delete with Referential Preservation —
  Master data … is deactivated rather than deleted while transactions reference
  it. Hard deletion is available only for records with no references and only via
  an explicitly audited administrative operation"; FR-PLT-021 [M]; FR-HRM-006 [M]
  (same pattern for employees).
- **SQL/schema evidence.** Only `org.branches` has a status column. `org.brands`,
  `org.warehouses`, `org.central_kitchens`, `org.stations`,
  `org.operating_hours`, `org.print_routing`, `kitchen.station_routing_rules`
  have no status/is_active/deactivated_at column. `operating_hours`, `stations`
  and `tables` are `ON DELETE CASCADE` from branches; `warehouses.branch_id`,
  `print_routing.branch_id` and `station_routing_rules.branch_id` are not.
- **Security implications.** A hard delete of a branch or station would cascade
  away configuration that audit entries reference by id. The audit rows survive
  (the trail is append-only) but their targets do not, degrading the forensic
  value of the Phase 12 trail. No destructive path at all is the safest posture
  for a foundation phase.
- **Tenant/RLS implications.** No `DELETE` policy is exercised by application
  code this phase. `DELETE` policies are still created for completeness and are
  still proven by the cross-tenant matrix (FR-PLT-013 requires delete isolation to
  be tested).
- **Classification.** **Implementation decision** consistent with the SRS; no
  schema deviation.

### D-13 — Branch reassignment between brands

- **Status: RATIFIED** (2026-08-15). The D-09 precondition is satisfied:
  composite tenant-safe foreign keys were ratified, so this decision stands as
  written rather than reverting to DEFERRED.
- **Decision (ratified).** Implement as a dedicated, explicit operation
  (`POST /branches/:branchId/brand`) with mandatory audit — **not** as a field in
  a general-purpose branch `PATCH`. `branches.code` is **immutable after
  creation** and is not affected by reassignment. The target brand must belong to
  the acting tenant, enforced structurally by D-09's composite FK rather than by
  application validation alone. **If D-09 is not ratified, this decision reverts
  to DEFERRED** — the operation must not ship defended only by application code.
  If D-01 is unresolved there is also no permission code to guard it.
- **Rationale.** FR-PLT-004 is [S] and permits reassignment strictly within one
  tenant, so `brand_id` is deliberately mutable while `tenant_id` is not
  (FR-PLT-003 [M]). An explicit endpoint satisfies the brief's requirement for
  explicit state transitions over generic update-everything endpoints, and gives
  the audit entry a specific action rather than a diff buried in a field update.
  `code` immutability is not stylistic: FR-POS-002 [M] embeds `<branch_code>` in
  offline-generated order numbers, so mutating it would make historical
  human-readable identifiers ambiguous.
- **SRS references.** FR-PLT-004 [S] "A branch MAY be reassigned between brands
  within the same tenant by a Tenant Owner, with a full audit record and an
  explicit warning regarding menu and pricing implications"; FR-PLT-003 [M]
  immutable `tenant_id`; FR-POS-002 [M] order number format
  `<branch_code>-<business_day_seq>`.
- **SQL/schema evidence.** `org.branches.brand_id UUID NOT NULL REFERENCES
  org.brands(id)` — mutable, with no constraint preventing a cross-tenant target;
  `CONSTRAINT uq_branch_code UNIQUE (tenant_id, code)`.
- **Security implications.** This is the highest-value cross-tenant target in the
  Organisation model: repointing a branch at another tenant's brand. It is exactly
  the case D-09 exists to make impossible. Two further constraints follow: the
  actor named by FR-PLT-004 ("Tenant Owner") maps to no permission code in §15.2,
  so authorization depends on D-01; and the "explicit warning" the SRS requires is
  a UI concern with no defined API contract, so it is **not** invented here.
- **Tenant/RLS implications.** The operation runs inside a single
  `withAuthContext({ tenantId })` transaction together with its audit write. RLS
  already prevents selecting a cross-tenant brand; the composite FK prevents
  referencing one.
- **Classification.** **Implementation decision** honouring an [S] requirement,
  **dependent on** the D-09 deviation.

### D-14 — Location abstraction

- **Status: DEFERRED (mechanism) / SAFE (documentation).**
- **Decision.** No `org.locations` registry or location-type discriminator is
  created in Phase 15. Branch, Warehouse and Central Kitchen ship as three
  independent entities. The open question and its tenant-scoping requirement are
  documented in `docs/organisation/` so the Inventory phase inherits a stated
  constraint rather than an accident.
- **Rationale.** The SRS treats branch, warehouse and central kitchen as
  interchangeable "locations", but neither source says how a location is
  identified. Because all ids are ULID-as-UUID and globally unique, a shared id
  space happens to work — but nothing guarantees it and nothing constrains a
  `location_id` to the acting tenant. Inventing `org.locations` now would create
  an entity neither source defines.
- **SRS references.** BR-PLT-001 "Inventory is held at a location (branch,
  warehouse, or central kitchen), never at brand or tenant level"; FR-BRN-015 [M]
  "stock transfers between any two locations within a tenant"; FR-BRN-020 [S]
  central kitchens as locations consuming and producing stock.
- **SQL/schema evidence.** `inventory.stock_levels(stock_item_id, location_id UUID
  NOT NULL, …) PRIMARY KEY (stock_item_id, location_id)` — no FK, no type
  discriminator. The same untyped pattern recurs in `inventory.stock_movements`
  and `inventory.stock_level_batch_allocations`.
- **Security implications.** An unconstrained `location_id` is a future
  cross-tenant write vector in Inventory (stock posted to another tenant's
  warehouse). Deciding the mechanism in Organisation is cheaper than retrofitting
  it beneath live stock data — which is precisely why the constraint is recorded
  now even though the mechanism is deferred.
- **Tenant/RLS implications.** None this phase.
- **Classification.** **Deferred** to Inventory, with a documented contract.

### D-15 — Missing uniqueness constraints

- **Status: RATIFIED** (2026-08-15).
- **Decision (ratified).** Add natural-key unique constraints absent from the
  approved SQL: `brands (tenant_id, name)`; `stations (branch_id, name)`;
  `warehouses (tenant_id, name)`; `central_kitchens (tenant_id, name)` and
  `central_kitchens (warehouse_id)`; `print_routing (branch_id, document_type,
  station_id)`. Leave `station_routing_rules` unconstrained and
  `operating_hours` unconstrained (D-04).
- **Rationale.** The SRS states uniqueness invariants for other contexts (§7.3:
  unique tenant slug, unique user email, "unique code per tenant" for suppliers,
  unique customer phone) but says nothing about Organisation entities. Without
  constraints, duplicate brand names and duplicate station names per branch are
  legal, and the 409 conflict semantics the phase requires have nothing to fire
  on. `central_kitchens (warehouse_id)` is the one with downstream consequence:
  `warehouse_id` is `NOT NULL` and implies a 1:1 relationship, but nothing
  prevents two central kitchens sharing one warehouse, which would make later
  stock attribution ambiguous. Precedent: ADR 0004 added
  `(tenant_id, branch_id, name)` on terminals and `(terminal_id,
  fingerprint_hash)` on fingerprints for the same reason.
  `station_routing_rules` uniqueness is entangled with Catalogue keys that do not
  exist yet and is deliberately left open.
- **SRS references.** §7.3 aggregate catalogue (uniqueness invariants for other
  contexts only). No SRS statement on Organisation uniqueness.
- **SQL/schema evidence.** Present in the approved SQL: `uq_branch_code UNIQUE
  (tenant_id, code)`, `uq_table_label UNIQUE (branch_id, label)`, `uq_setting
  UNIQUE (scope_type, scope_id, key)`. Absent: any unique on `org.brands`,
  `org.warehouses`, `org.central_kitchens`, `org.stations`,
  `org.print_routing`, `kitchen.station_routing_rules`.
- **Security implications.** Low. Duplicate names are an operational and UX
  defect, not a boundary failure. All proposed keys are tenant- or branch-scoped,
  so none creates a cross-tenant uniqueness collision that could leak the
  existence of another tenant's record.
- **Tenant/RLS implications.** Each key is prefixed by `tenant_id` or `branch_id`,
  so uniqueness is enforced within the tenant boundary and never across it. This
  matters: a global unique on `brands.name` would let Tenant A infer Tenant B's
  brand names from 409 responses.
- **Classification.** Explicit **deviation** from the approved SQL (additive
  constraints).

### D-16 — Station → Terminal relationship

- **Status: RATIFIED** (2026-08-15). Touches an Identity table (additive index
  only).
- **Decision (ratified).** Implement `stations.display_terminal_id` with a
  **composite** foreign key on `(branch_id, display_terminal_id) → identity.terminals
  (branch_id, id)`, which requires adding `UNIQUE (branch_id, id)` to
  `identity.terminals`. That addition is an **index only** — no column is added,
  no column is altered, no semantics change, and no Identity application code is
  touched. The reverse FK `identity.terminals.branch_id → org.branches(id)`,
  which the approved SQL annotates as intended, is **deferred** to a follow-up.
- **Rationale.** This is the only `org → identity` foreign key in the Organisation
  block, and it crosses a bounded-context boundary. Three problems make a plain FK
  unsafe. First, `org.stations` has no `tenant_id` (isolated via `branch_id`)
  while `identity.terminals` has `tenant_id NOT NULL`, so nothing structurally
  guarantees the display terminal belongs to the same tenant — and per D-09 the FK
  check will not enforce it. Second, nothing prevents
  Station(branch = 1).display_terminal_id pointing at Terminal(branch = 2), even
  though §7.3 #3 binds a terminal to exactly one branch. Anchoring on
  `(branch_id, …)` enforces same-branch and therefore transitively same-tenant,
  closing both. Third, the reverse FK is deferred deliberately: ADR 0004 recorded
  `terminals.branch_id` as "a recorded UUID (no cross-context FK)" because org did
  not exist, and adding it now would place a new constraint on a live, shipped
  Auth table — a larger change than this phase should absorb, and one that would
  require re-running the full Auth regression suite for a benefit unrelated to
  Organisation.
- **SRS references.** §6.1 hierarchy (Terminal and Station as **siblings** under
  Branch); §7.3 #3 Terminal invariant "**Bound to exactly one branch**";
  FR-KDS-001 [M] stations defined per branch. The SRS **never states** that a
  station references a terminal — the relationship exists only in the approved SQL.
- **SQL/schema evidence.** `org.stations.display_terminal_id UUID REFERENCES
  identity.terminals(id)` — nullable, uncommented, no uniqueness. Approved
  `identity.terminals.branch_id UUID NOT NULL, -- FK org.branches(id)`: the
  intent is annotated but the constraint was never written. Shipped
  `identity.terminals` has `@@unique([tenantId, branchId, name])`,
  `@@index([tenantId])`, `@@index([branchId])` — no `(branch_id, id)` unique.
- **Security implications.** A plain nullable FK leaves a cross-branch — and,
  because stations carry no `tenant_id`, potentially cross-tenant — pointer that
  application code alone would have to defend. The composite form makes it
  unrepresentable. The countervailing risk is that the fix modifies an Identity
  table at all; it is constrained to an additive unique index specifically to keep
  the change non-behavioural, and the Auth e2e suite must still pass unchanged as
  part of the Phase 15 gate.
- **Tenant/RLS implications.** No RLS policy on `identity.terminals` changes. The
  new index does not alter visibility, only referenceability. `org.stations`
  continues to inherit isolation through `org.branches`.
- **Classification.** Explicit **deviation** from the approved SQL, and the only
  Phase 15 change touching an Identity table. See "Relationship to ADR 0001–0007".

### D-17 — `warehouse_type` versus `branch_id`

- **Status: RATIFIED — CHANGED FROM RECOMMENDATION** (2026-08-15). The ADR
  recommended verbatim `VARCHAR`; the project owner ratified an enum instead,
  for consistency with D-03. The superseded recommendation is retained below
  under "Rejected alternative".
- **Decision (ratified).** `warehouse_type` is modelled as an **enum with exactly
  the three values the approved SQL enumerates in its comment**:
  `branch | central | virtual`. `branch_id` remains a nullable reference to
  `org.branches`, protected by the D-09 composite foreign key. **No `CHECK`
  constraint correlates `warehouse_type` with `branch_id`**, and no consistency
  rule between them is imposed. The ambiguity between the two columns, and the
  inability of a single nullable `branch_id` to express BR-PLT-001's shared
  warehouse, are recorded as open items for the Inventory phase.
- **Rationale for the ratified form.** Enumerating the three values closes the
  column's value domain without inventing the correlation rule that neither
  source states. It is consistent with D-03, where an open `VARCHAR` status
  column was likewise constrained to an enum, and with the ADR 0004 precedent
  (`TerminalStatus` / `TerminalType`). The values are taken verbatim from the
  approved SQL's own comment, so no value is invented — only the constraint that
  the column must hold one of them.
- **Rejected alternative (the ADR's original recommendation).** Implement both
  columns **verbatim** as the approved SQL defines them — `warehouse_type` left
  as an unconstrained `VARCHAR(16)`, no `CHECK`, no enum. Rejected by the project
  owner on consistency grounds: having ratified an enum for `branches.status` in
  D-03, leaving `warehouse_type` as free text would apply two different standards
  to the same problem. Also rejected: an enum **plus** a `CHECK` correlating the
  two columns (fabricates a business rule and forecloses a modelling option
  Inventory may need), and adding a junction table for branch sharing now
  (invents a table neither source defines, during a phase that excludes
  Inventory).
- **Rationale (shared analysis).** The approved SQL encodes the same fact twice —
  `warehouse_type IN (branch, central, virtual)` and a nullable `branch_id` — with
  no stated relationship between them. Neither source says whether
  `type = 'branch'` with `branch_id IS NULL` is legal, whether `type = 'central'`
  with a non-null `branch_id` is legal, or what `virtual` denotes. Inventing a
  `CHECK` such as `type = 'branch' ⟺ branch_id IS NOT NULL` would be a fabricated
  business rule, and it would make `type = 'central'` the *only* mechanism for the
  shared warehouse BR-PLT-001 prescribes. A separate, more consequential gap: a
  single nullable `branch_id` on the warehouse expresses **one branch per
  warehouse**, whereas BR-PLT-001 requires **two branches sharing one warehouse**.
  The approved SQL cannot represent the SRS's own cloud-kitchen model. Resolving
  that requires a junction table, which is an Inventory-scoped modelling decision,
  not an Organisation-foundation one.
- **SRS references.** Glossary "Warehouse … May be standalone or attached to a
  branch"; BR-PLT-001 "two branches **sharing a warehouse**"; §7.3 #6 "Belongs to
  one tenant"; FR-BRN-015 [M] transfers between any two locations within a tenant.
- **SQL/schema evidence.** `org.warehouses.warehouse_type VARCHAR(16) NOT NULL
  DEFAULT 'branch' -- branch, central, virtual`;
  `org.warehouses.branch_id UUID REFERENCES org.branches(id) -- NULL when
  standalone warehouse`.
- **Security implications.** None directly; both columns are inside a
  tenant-scoped table covered by the standard policy set. The cross-tenant risk on
  `branch_id` is covered by D-09.
- **Tenant/RLS implications.** `org.warehouses` carries `tenant_id NOT NULL` →
  direct policies. `branch_id` requires the D-09 composite FK to guarantee the
  referenced branch is in the same tenant.
- **Classification.** Explicit **deviation** from the approved SQL — an enum where
  the SQL used `VARCHAR`, covered by deviation #9 alongside `branches.status`
  (D-03). The *values* are not a deviation; they are taken verbatim from the
  approved SQL's comment. No cross-column rule is introduced, so the
  `warehouse_type`/`branch_id` consistency question and the shared-warehouse
  limitation remain open for Inventory.

---

## Classification summary

### Directly mandated by the SRS (no discretion exercised)

- Tenant → Brand → Branch hierarchy; a brand belongs to one tenant, a branch to
  one brand (FR-PLT-001, FR-PLT-002, §7.3 #4/#5).
- Immutable `tenant_id`; records never transferable between tenants (FR-PLT-003).
- RLS `ENABLE` + `FORCE` on every tenant-scoped table, `USING` and `WITH CHECK`,
  application role without `BYPASSRLS`, fail-closed on missing context
  (FR-PLT-010, FR-PLT-011, FR-PLT-012).
- Cross-tenant read **and** write isolation proven by test for every table
  carrying `tenant_id` (FR-PLT-013, FR-PLT-014).
- Overnight operating hours (`closes_at < opens_at`) — SRS glossary, Business Day.
- Schema placement: `org` for brands/branches/warehouses/central_kitchens/
  stations/tables/settings; `kitchen` for station_routing_rules (§25.1).
- Stations are defined per branch (FR-KDS-001).
- Master data is deactivated rather than deleted (§24.6.5).

### Inferred from the existing architecture (ADR 0001–0007 precedent)

- Child tables without `tenant_id` inherit isolation via
  `EXISTS (parent WHERE parent.tenant_id = app.tenant_id)` — precedent:
  `role_permissions`, `membership_roles` (ADR 0003), `device_fingerprints`
  (ADR 0004).
- Policy predicate idiom `NULLIF(current_setting('app.tenant_id', true), '')::uuid`.
- Grant pattern: `GRANT USAGE ON SCHEMA` + explicit per-table DML +
  `ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator`.
- IDs are ULID-as-UUID via `newId()`; DTO id fields validated with `UUID_PATTERN`,
  never `@IsUUID()` (ULID-derived UUIDs are not RFC-4122).
- DTOs under the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`);
  no DTO accepts `tenantId` or any ownership field the server derives.
- Services take `tenantId: string` explicitly and wrap work in
  `withAuthContext`; controllers stay thin; `*.view.ts` mappers shape responses.
- Error semantics: 401 unauthenticated, 403 no context / missing permission,
  404 for cross-tenant (no existence disclosure), 409 on `P2002`, 400 malformed.
- Audit through `AuditService` only, with new `AUDIT_ACTION` / `AUDIT_ENTITY`
  entries; no secrets in metadata; tenant identity never client-supplied.
- Enums preferred where the approved SQL used `VARCHAR` with an enumerated
  comment (precedent: ADR 0004, `TerminalStatus` / `TerminalType`).
- Indexes on `tenant_id`, parent foreign keys, and unique lookup fields — the
  approved SQL defines none, so all indexing is inferred.
- No sync/HLC fields: FR-OFF-015 applies to device-created transactional
  entities, and no `org` table in the approved SQL carries sync columns.

### Deviations from the approved SQL (all ratified 2026-08-15)

| # | Deviation | Decision |
|---|---|---|
| 1 | `UNIQUE (tenant_id, id)` on org parents + composite child FKs | D-09 |
| 2 | Natural-key unique constraints on brands, stations, warehouses, central kitchens, print_routing | D-15 |
| 3 | `branches.status` constrained to an enum domain the SQL leaves open | D-03 |
| 4 | `org.tables.status` **not created** — a `NOT NULL` column omitted | D-05 |
| 5 | `UNIQUE (branch_id, id)` added to `identity.terminals` (Identity table) | D-16 |
| 6 | Two invented permission codes `settings.{tenant,branch}.read` | D-01 |
| 7 | `kitchen` schema created ahead of the Kitchen bounded context | D-06 |
| 8 | Warehouse/CK modelled tenant-owned, against FR-PLT-001's hierarchy edges | D-08 |
| 9 | Enums where the approved SQL used `VARCHAR`, covering **both** ratified enum columns: `org.branches.status` (`active \| inactive`) and `org.warehouses.warehouse_type` (`branch \| central \| virtual`). In each case the enum constrains an open `VARCHAR`; the `warehouse_type` values are taken verbatim from the approved SQL's comment. Precedent: ADR 0004 (`TerminalStatus` / `TerminalType`). | D-03, D-17 |

Deviation 8 is a deviation from a **mandatory SRS requirement**, not merely from
the SQL, and is called out separately for that reason.

### Intentionally deferred to later phases

| Item | Deferred to | Requirement status |
|---|---|---|
| Branch-scoped RBAC assignment (D-02) | Dedicated RBAC-scope phase | FR-SEC-002/003/004 **[M]** unimplemented |
| Branch groups (D-10) | RBAC-scope phase | FR-BRN-005 **[M]** unimplemented |
| Settings cascade (D-11) | Dedicated settings phase | FR-PLT-025/026/028 **[M]** unimplemented |
| Location abstraction (D-14) | Inventory | BR-PLT-001 mechanism undefined |
| `identity.terminals.branch_id` FK (D-16) | Follow-up | Annotated intent in approved SQL |
| Station routing resolution (FR-KDS-010) | Kitchen Ops | Configuration only this phase |
| Table live state (D-05) | Sales | FR-POS-081 [S] |
| Floor-plan geometry (FR-POS-080) | Sales | [S] |
| Branch scorecard (FR-BRN-010…014) | Analytics | [S]/[C] |
| Branch template (FR-BRN-008) | After Catalogue + Workforce | [S] |
| Franchise support (FR-BRN-035…037) | After D-10 + Fiscal | [C] |

## Tenant isolation model for Organisation

Unchanged from ADR 0003; applied to the new tables.

**Direct `tenant_id` (ENABLE + FORCE, four per-operation policies each):**
`org.brands`, `org.branches`, `org.warehouses`, `org.central_kitchens`.
Predicate: `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`
in both `USING` and `WITH CHECK`.

**Inherited via parent branch (ENABLE + FORCE, `EXISTS` predicate):**
`org.operating_hours`, `org.stations`, `org.tables`, `org.print_routing`,
`kitchen.station_routing_rules`. These carry no `tenant_id` in the approved
design, and none is added — consistent with ADR 0003 and with the Phase 15
instruction not to add `tenant_id` for reassurance. FR-PLT-013/014's generated CI
sweep enumerates tables *containing* `tenant_id`, so these are correctly outside
its scope and must be covered explicitly by the Organisation cross-tenant matrix
instead.

**Roles.** Runtime remains `ros_app` (`NOBYPASSRLS`); migrations remain
`ros_migrator`. No `BYPASSRLS`, no migrator runtime path, no RLS disabled for
convenience. Tests prove runtime isolation exclusively through `ros_app` over
HTTP; `createMigratorClient()` is used only for privileged arrange/teardown, as in
Phases 8–12.

## Relationship to ADR 0001–0007

**No existing ADR is amended or superseded by this document.**

- **ADR 0001** (identity/tenancy/sessions) — unchanged. Its `membership_roles`
  override is *cited* as evidence in D-02 but is not modified.
- **ADR 0002** (tenant context) — unchanged. Its "Branch scope" section deferred
  branch authorization "until the org/branch context and SRS branch rules are
  available". Phase 15 satisfies that precondition and **consciously extends the
  deferral** (D-02). Because the outcome is unchanged, no amendment to ADR 0002 is
  required; the re-decision is recorded here instead. When branch scoping is
  implemented, that phase's ADR will supersede ADR 0002's branch-scope section.
- **ADR 0003** (RLS) — unchanged and extended by application. Organisation adds
  tables under the same mechanism, roles and predicate idiom; no new mechanism.
- **ADR 0004** (terminal identity) — its branch-authorization deferral is extended
  for the same reason as ADR 0002. **One additive change is proposed to an
  Identity table**: `UNIQUE (branch_id, id)` on `identity.terminals` (D-16). This
  is an index only — no column added or altered, no behaviour changed, no Identity
  code touched — so it does not amend ADR 0004's decisions. If the product owner
  prefers, D-16 option (c) omits `display_terminal_id` entirely and leaves
  `identity.terminals` untouched.
- **ADR 0005, 0006** — unaffected.
- **ADR 0007** (audit trail) — unchanged and reused. Organisation adds
  `AUDIT_ACTION` and `AUDIT_ENTITY` entries and calls the existing service. No
  second audit implementation.

## Consequences

- Nine Organisation entities gain tenant isolation at the database layer, and the
  `tenant_id` anchor every later bounded context depends on is established.
- Cross-tenant parenting becomes structurally impossible **only if D-09 is
  ratified**. Without it, Organisation ships with a writable cross-tenant foreign
  key edge defended solely by application code.
- A known intra-tenant authorization gap is accepted for the duration of D-02's
  deferral, and must be stated in `docs/organisation/authorization.md` and in the
  Phase 15 security review rather than left implicit.
- Four mandatory SRS requirements (FR-SEC-002/003/004, FR-BRN-005, FR-PLT-025/026/
  028, and FR-PLT-001's hierarchy edges) are knowingly unimplemented or deviated
  from, each recorded above with its reason and its target phase.
- The existing Auth architecture is unchanged: same guard chain, same
  `TenantContext`, same `withAuthContext`, same roles, same audit service. The
  entire Phase 1–14 test suite must pass unmodified as part of the Phase 15
  verification gate.

## Ratification record

All fourteen open decisions were ratified by the project owner on 2026-08-15,
presented one at a time with their SRS evidence, SQL evidence, and the
consequences of accepting versus rejecting. **No decision remains BLOCKED.**

Ratified as recommended (13): D-01, D-02, D-03, D-04 (both sub-questions), D-05,
D-06, D-07, D-08, D-09, D-12, D-13, D-15, D-16.

Ratified with a change (1): **D-17** — an enum
(`branch | central | virtual`) instead of the recommended verbatim `VARCHAR`,
for consistency with D-03. Deviation #9 was widened accordingly.

Rejected outright: none.

Deferred and acknowledged: D-10 (branch groups), D-11 (settings cascade),
D-14 (location abstraction), the `identity.terminals.branch_id → org.branches`
follow-up from D-16, and D-18 (SRS attributes with no column).

**Ratification does not discharge the recorded gaps.** Five mandatory SRS
requirements remain knowingly unmet or deviated from and must be carried into the
Phase 15 final report and security review: FR-SEC-002/003/004 (deferred, D-02),
FR-BRN-005 (deferred, D-10), FR-PLT-025/026/028 (deferred, D-11),
FR-PLT-001's hierarchy edges (deviated, D-08), and FR-SEC-012's sensitivity
marker (no column, D-18).

**Environment prerequisite (not an architectural item).** Docker is not running,
so `prisma migrate status` cannot confirm that all eight migrations are applied
and that no drift exists. This must be verified before the first Organisation
migration is created, and has no bearing on any decision above.

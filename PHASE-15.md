# PHASE 15 — ORGANISATION FOUNDATION
## ROS Backend — Claude Code Implementation Brief

You are continuing the ROS backend implementation after completion of Authentication Phases 1–14.

This is NOT a greenfield implementation.

The authentication subsystem is already implemented, tested, committed, and considered the security foundation of the system.

Your task is to implement:

PHASE 15 — ORGANISATION FOUNDATION

The scope of this phase is ONLY the Organisation bounded context.

Do NOT implement Catalogue, Production, Inventory, Procurement, Sales, Kitchen, Treasury, Workforce, CRM, Fiscal, Sync, Integrations, or Analytics in this phase.

============================================================
0. AUTHORITATIVE SOURCES
============================================================

Before writing code, inspect the repository and all available ROS source material.

The authoritative functional source is:

ROS_SRS_v1.0.pdf

The approved database design/source material includes:

ROS_DrawDB_Compatible_v3.sql

Also inspect the existing repository documentation and ADRs.

IMPORTANT:

The SRS is authoritative for requirements.

Do not invent business requirements.

Do not silently modify SRS semantics.

Do not "improve" the domain by adding features that are not supported by the SRS.

If the SRS is ambiguous about a behavior that materially affects architecture, database semantics, security, or API behavior:

STOP and report the ambiguity.

Do not guess.

============================================================
1. CURRENT SYSTEM STATE
============================================================

Authentication is COMPLETE through Phase 14.

The existing system already contains:

- Users
- Credentials
- Sessions
- JWT access tokens
- Refresh-token rotation
- Refresh-token reuse detection
- Logout
- Tenant selection
- Tenant memberships
- RBAC
- Permissions
- PermissionGuard
- TenantContext
- PostgreSQL RLS
- ros_app runtime DB role
- ros_migrator migration role
- Terminal / device identity
- Password change
- Password reset
- Rate limiting
- Security headers
- Tamper-evident audit trail
- Security hardening
- Integration/security documentation
- Comprehensive unit and E2E tests

Do NOT rewrite or refactor working authentication code unless absolutely required by a concrete Organisation requirement.

Treat the existing Auth architecture as a dependency, not a target for redesign.

The existing security flow is:

JwtAuthGuard
    ↓
TenantContextGuard
    ↓
PermissionGuard
    ↓
Controller
    ↓
Service
    ↓
Repository
    ↓
Prisma / PostgreSQL
    ↓
RLS

Organisation must integrate into this architecture.

============================================================
2. EXISTING SECURITY MODEL — MUST BE PRESERVED
============================================================

Every tenant-scoped Organisation operation MUST derive tenant identity from the authoritative TenantContext.

NEVER trust:

- tenantId from request body
- tenantId from query parameters
- tenantId from arbitrary headers
- tenantId supplied by the frontend
- tenantId hidden inside a DTO
- client-controlled authorization claims

The tenant comes from the authenticated principal / TenantContext.

The existing PostgreSQL RLS mechanism MUST remain active.

Runtime database access MUST continue using ros_app.

Never use ros_migrator from application runtime.

Never introduce BYPASSRLS.

Never disable RLS to make Organisation queries easier.

Do not introduce global mutable tenant state.

Do not introduce AsyncLocalStorage unless the existing architecture is explicitly changed through a documented ADR and justified by the SRS.

Prefer explicit TenantContext propagation consistent with the existing architecture.

============================================================
3. ORGANISATION BOUNDED CONTEXT
============================================================

Implement the Organisation bounded context.

Based on the existing approved schema/ERD, the Organisation domain includes:

- Brand
- Branch
- Warehouse
- Central Kitchen
- Station
- Table
- Operating Hours
- Station Routing Rules
- Print Routing

The existing ERD establishes relationships including:

Tenant → Brand
Brand → Branch
Tenant → Warehouse
Branch → Warehouse
Tenant → Central Kitchen
Central Kitchen → Warehouse
Branch → Station
Station → Terminal
Branch → Table
Branch → Station Routing Rule
Station → Station Routing Rule
Branch → Print Routing
Station → Print Routing

Verify all of this against the SRS and approved SQL before implementation.

Do NOT blindly copy the ERD if the SRS establishes a different invariant.

============================================================
4. FIRST TASK — DISCOVERY ONLY
============================================================

Before modifying anything, inspect:

- prisma/schema.prisma
- prisma migrations
- existing src/modules structure
- identity module
- TenantContext implementation
- PermissionGuard
- RLS implementation
- audit implementation
- existing ID generation utilities
- existing DTO conventions
- existing error handling
- existing test setup
- existing module conventions
- existing ADRs
- ROS_SRS_v1.0.pdf
- ROS_DrawDB_Compatible_v3.sql

Search the SRS specifically for:

- Chapter 7 — Domain Model
- Organisation / Brand / Branch / Warehouse / Central Kitchen
- Station
- Table
- Operating Hours
- Print Routing
- Station Routing
- Branch lifecycle
- Organisation lifecycle rules
- permissions related to Organisation
- branch rules
- terminal/branch relationship
- any requirements referencing these entities
- relevant business rules
- relevant functional requirements
- NFRs affecting Organisation

Create a temporary internal implementation map before coding.

Do not start coding until you understand:

1. Entity relationships
2. Aggregate boundaries
3. Tenant scope
4. Branch scope
5. Lifecycle/state rules
6. Required fields
7. Uniqueness rules
8. Required permissions
9. Required audit events
10. Required invariants
11. Required API behavior

============================================================
5. IMPORTANT DOMAIN DISTINCTIONS
============================================================

Do NOT conflate:

Tenant
Brand
Branch
Warehouse
Central Kitchen
Station
Terminal
Table

They are distinct concepts.

In particular:

- Terminal is already implemented by Auth/Identity.
- Branch is Organisation.
- Terminal may belong to a Branch.
- Station may belong to a Branch and may be associated with a Terminal.
- Warehouse is not a Branch.
- Central Kitchen is not a Branch.
- Table is a physical/service-location concept under Branch.
- Employee is NOT User.
- User is NOT Employee.

Preserve these distinctions exactly as defined by the SRS.

============================================================
6. DATABASE IMPLEMENTATION
============================================================

Implement only the database structures required for Phase 15.

Do NOT create the entire ROS database.

Do NOT create future bounded-context tables just because they are referenced by foreign keys.

Only create what is required now.

Use Prisma migrations.

Do NOT edit an already-applied migration.

Create a new migration.

Before migration:

- inspect existing schema
- verify whether any Organisation tables already exist
- verify existing FK targets
- verify naming conventions
- verify tenant_id conventions

For tenant-scoped tables:

- include tenant_id where required by the approved design
- add appropriate indexes
- apply RLS
- use FORCE ROW LEVEL SECURITY where consistent with the existing Phase 8 policy
- use tenant context through app.tenant_id
- use user context through app.user_id when required
- preserve fail-closed behavior

Do NOT add tenant_id merely because it feels safer.

Follow the approved data architecture.

============================================================
7. RLS REQUIREMENTS
============================================================

Every tenant-scoped Organisation table must be reviewed for:

SELECT isolation
INSERT protection
UPDATE protection
DELETE protection

Test:

Tenant A cannot see Tenant B.

Tenant A cannot update Tenant B.

Tenant A cannot delete Tenant B.

Tenant A cannot insert a Tenant B record by spoofing tenant_id.

Missing tenant context must fail closed.

RLS must continue working through the Prisma adapter and existing withAuthContext mechanism.

Do not bypass RLS in tests.

Use the existing migrator only for test setup/fixtures where appropriate.

Use ros_app to prove runtime isolation.

============================================================
8. AGGREGATE / DOMAIN DESIGN
============================================================

Do not treat every table as an independent CRUD resource.

Identify the actual aggregate roots from the SRS.

For each aggregate:

- define ownership
- define lifecycle
- define invariants
- define transaction boundary
- define repository boundary
- define allowed mutations

Do not allow arbitrary child manipulation if the SRS says the child belongs to an aggregate.

Do not create generic "update everything" endpoints.

If the SRS specifies state transitions, implement explicit state transition methods.

Do NOT invent a state machine if the SRS does not define one.

This rule is important because Phase 14 explicitly avoided inventing a terminal state machine.

Use the same discipline here.

============================================================
9. BRAND
============================================================

Implement Brand according to the SRS.

Determine from the SRS:

- fields
- lifecycle
- tenant ownership
- uniqueness
- whether multiple brands per tenant are supported
- whether a brand can be disabled
- relationships to branches
- permissions
- audit requirements

Implement only what the SRS supports.

Potential API shape should be determined from the existing API conventions, not invented independently.

Expected REST style may include:

POST   /brands
GET    /brands
GET    /brands/:id
PATCH  /brands/:id

But verify naming and semantics against the SRS and repository conventions before implementing.

============================================================
10. BRANCH
============================================================

Branch is a core Organisation entity.

Implement all SRS-defined:

- fields
- lifecycle
- branch identity
- brand relationship
- tenant relationship
- operating configuration
- hours
- operational status
- required invariants

Pay special attention to:

Tenant → Brand → Branch

and the rule that a branch must never belong to a different tenant's brand.

Cross-tenant IDOR/BOLA must be impossible.

A Branch belonging to Tenant B must never be reachable by Tenant A.

Do not rely solely on application checks.

RLS must provide the DB-level boundary.

============================================================
11. WAREHOUSE
============================================================

Implement Warehouse according to the SRS.

Preserve the distinction:

Warehouse ≠ Branch

Verify:

- tenant ownership
- optional branch relationship
- lifecycle
- uniqueness
- fields
- allowed relationships

Do not implement inventory behavior yet.

This phase only establishes the Organisation foundation.

Inventory stock levels, stock movements, batches, transfers, counts, etc. belong to the Inventory phase.

============================================================
12. CENTRAL KITCHEN
============================================================

Implement Central Kitchen only to the extent required by the Organisation bounded context.

Verify its relationship with:

Tenant
Warehouse

Do not implement:

Production Orders
Recipes
Inventory consumption
Distribution logic

Those belong to later bounded contexts.

============================================================
13. STATIONS
============================================================

Implement Station according to the SRS.

Verify:

- branch ownership
- terminal relationship
- station identity
- lifecycle/status if specified
- uniqueness
- routing relationship

Do not duplicate Terminal data.

Terminal is an Identity entity.

Station may reference Terminal according to the approved design.

Do not create a second device/terminal identity model.

============================================================
14. TABLES
============================================================

Implement Branch Tables according to the SRS.

Verify:

- branch ownership
- identifiers/numbers
- status if defined
- uniqueness
- physical/service semantics
- relationships to orders if later required

Do NOT implement Order relationships unless the current database architecture requires the FK and the SRS explicitly supports it.

Sales belongs to a later phase.

Do not prematurely couple Table to Sales.

============================================================
15. OPERATING HOURS
============================================================

Implement Operating Hours according to the SRS.

Pay attention to:

- day-of-week
- open/close time
- overnight periods
- branch association
- validation
- overlapping intervals

Do NOT assume simple 09:00–17:00 logic if the SRS supports overnight operation.

If the SRS does not define overlapping-hour semantics, STOP and ask rather than inventing a policy.

============================================================
16. STATION ROUTING
============================================================

Implement Station Routing Rules according to the SRS.

Determine:

- branch ownership
- station ownership
- routing criteria
- priority
- active/inactive semantics
- uniqueness
- conflict behavior

Do not implement Kitchen Ticket generation yet.

Only implement the Organisation-side routing configuration.

============================================================
17. PRINT ROUTING
============================================================

Implement Print Routing according to the SRS.

Determine:

- branch
- station
- destination/printer model
- routing conditions
- priority
- activation/deactivation
- uniqueness

Do not invent printer hardware integrations.

This is configuration only unless the SRS explicitly requires more.

============================================================
18. PERMISSIONS
============================================================

Do NOT invent the full business permission catalogue.

The existing Auth implementation deliberately did not invent business permissions.

Before adding permissions:

Search the SRS for the official permission catalogue.

If the SRS contains Organisation permissions:

Implement/seed them exactly.

Examples might look like:

organisation.brand.read
organisation.brand.manage

BUT:

DO NOT assume these exact names unless supported by the SRS.

If no official Organisation permission catalogue exists:

STOP before inventing permission semantics.

Report the missing source and ask for a decision.

Do not silently create a permission system that later conflicts with the SRS.

============================================================
19. AUDIT
============================================================

The Phase 12 audit trail already exists.

Integrate Organisation security-sensitive mutations with the existing audit service.

Do NOT create another audit implementation.

Determine from the SRS which actions require audit.

At minimum, review:

- create
- update
- delete/deactivate
- status changes
- security-sensitive configuration changes

Do not blindly audit every SELECT.

Audit events must contain:

- actor
- tenant context where available
- target/entity
- action
- outcome
- relevant metadata

Never place secrets in audit metadata.

Never trust client-provided tenant identity.

Use the existing audit abstraction.

============================================================
20. API DESIGN
============================================================

Follow the existing API conventions.

Controllers should remain thin.

Architecture:

Controller
  ↓
Guard
  ↓
Application Service
  ↓
Domain / Repository
  ↓
Prisma

Do not put business logic inside controllers.

DTOs must:

- validate input
- reject unknown fields according to existing project convention
- never accept tenantId when tenant is derived from context
- never accept authorization fields
- never allow client-controlled ownership

For resource IDs:

- validate format
- scope lookup by TenantContext
- avoid cross-tenant enumeration
- preserve the existing 404/403 security semantics

============================================================
21. ERROR SEMANTICS
============================================================

Preserve existing conventions.

Typical:

401 = unauthenticated / invalid authentication

403 = authenticated but not authorized / no tenant context

404 = resource not found or intentionally hidden cross-tenant

409 = uniqueness/conflict

400 = malformed/invalid request

Do not reveal whether a cross-tenant resource exists.

============================================================
22. TRANSACTIONS
============================================================

Use transactions around aggregate operations that require atomicity.

Do not wrap every database call in an unnecessary transaction.

When tenant isolation is required, use:

PrismaService.withAuthContext(...)

and preserve transaction/connection affinity.

Do not manually call:

SET app.tenant_id

outside the established mechanism.

Do not create a second tenant-context mechanism.

============================================================
23. OFFLINE / HLC
============================================================

Do not prematurely implement the complete offline-sync system.

However, inspect the SRS for Organisation entities that must support offline creation or synchronization.

If the SRS requires:

- client-generated IDs
- HLC
- sync metadata

implement only what is required by the current Organisation entity.

Do not invent sync fields simply because future Sales will need them.

The complete offline-sync bounded context belongs to a later phase.

============================================================
24. TESTING REQUIREMENTS
============================================================

Every implemented aggregate/resource requires:

### Unit tests

Test:

- valid creation
- invalid input
- business invariants
- uniqueness
- lifecycle rules
- authorization decisions
- service behavior
- repository behavior where appropriate

### E2E tests

Test:

Authentication:

- unauthenticated request → 401

Tenant isolation:

- Tenant A sees own records
- Tenant A cannot see Tenant B
- Tenant A cannot modify Tenant B
- Tenant A cannot delete Tenant B
- Tenant A cannot spoof tenant_id

RBAC:

- permitted action → success
- missing permission → 403
- client-supplied tenantId ignored/rejected
- client-supplied ownership ignored/rejected

RLS:

- ros_app
- correct tenant context
- missing tenant context
- cross-tenant SELECT
- cross-tenant UPDATE
- cross-tenant DELETE
- cross-tenant INSERT spoof

Relationships:

- Brand cannot attach to another tenant's branch
- Branch cannot reference another tenant's Brand
- Station cannot cross tenant boundaries
- Table cannot cross tenant boundaries
- Warehouse/Central Kitchen relationships cannot cross tenant boundaries

Do not only test the happy path.

============================================================
25. MIGRATION SAFETY
============================================================

Before migration:

- inspect current DB
- verify migration state
- ensure no drift
- verify existing auth migrations

Create ONE coherent Organisation migration unless the architecture requires more than one.

Do NOT reset the database.

Do NOT delete existing migrations.

Do NOT edit previous migration files.

After migration:

prisma format
prisma validate
prisma generate
prisma migrate status

Then run the full test suite.

============================================================
26. PERFORMANCE
============================================================

Follow the SRS performance requirements.

Add indexes based on:

- tenant_id
- parent foreign keys
- unique lookup fields
- status fields where useful
- common query patterns

Do not blindly index every column.

Avoid N+1 queries.

Do not load unrelated bounded-context data.

Do not introduce caching unless the SRS/architecture requires it.

Redis belongs to the platform architecture and should not be introduced just to make Organisation CRUD "faster".

============================================================
27. SECURITY REVIEW
============================================================

Before declaring Phase 15 complete, perform a dedicated security review.

Check:

[ ] No tenantId trusted from client
[ ] No cross-tenant IDOR
[ ] No BOLA
[ ] RLS active
[ ] FORCE RLS where required
[ ] ros_app has no BYPASSRLS
[ ] No migrator runtime path
[ ] No tenant context leakage
[ ] No global mutable tenant state
[ ] No AsyncLocalStorage introduced
[ ] DTOs reject unexpected ownership fields
[ ] Authorization runs before mutation
[ ] Cross-tenant resources don't enumerate
[ ] Audit contains no secrets
[ ] SQL constraints enforce structural invariants
[ ] Transactions preserve atomicity
[ ] No previous Auth behavior regressed

============================================================
28. DOCUMENTATION
============================================================

Create/update documentation for:

backend/docs/organisation/

At minimum:

README.md
architecture.md
domain-model.md
authorization.md
tenant-isolation.md
api.md
testing.md
security.md

Also create an ADR if a real architectural decision is required.

Do NOT create an ADR for trivial implementation details.

If the SRS is ambiguous and requires a decision:

STOP and create a clearly marked GAP/decision report.

Do not silently resolve it.

============================================================
29. IMPLEMENTATION ORDER
============================================================

Implement in this order:

PHASE 15.1
Organisation schema/domain analysis

PHASE 15.2
Brand

PHASE 15.3
Branch

PHASE 15.4
Warehouse

PHASE 15.5
Central Kitchen

PHASE 15.6
Station

PHASE 15.7
Table

PHASE 15.8
Operating Hours

PHASE 15.9
Station Routing

PHASE 15.10
Print Routing

PHASE 15.11
Authorization integration

PHASE 15.12
Audit integration

PHASE 15.13
RLS verification

PHASE 15.14
Full integration tests

PHASE 15.15
Documentation

Do not move to Catalogue.

============================================================
30. STOP CONDITIONS
============================================================

STOP and ask me before continuing if:

1. The SRS and approved SQL conflict materially.
2. A required field is not defined.
3. A lifecycle rule is ambiguous.
4. A permission catalogue is missing.
5. A tenant-scope rule is ambiguous.
6. A branch-scope rule materially affects authorization.
7. A relationship would require inventing business semantics.
8. An existing Auth/RLS architecture must be changed.
9. A new global state mechanism appears necessary.
10. A new external dependency is required.
11. A migration would require destructive changes.
12. The implementation would require changing an existing ADR.
13. A future bounded context must be implemented prematurely.

Never resolve these by guessing.

============================================================
31. VERIFICATION GATE
============================================================

Phase 15 is NOT complete until all of the following pass:

Prisma:
- format ✓
- validate ✓
- generate ✓
- migrate status ✓
- no drift ✓

Build:
- Nest build ✓

Lint:
- ESLint ✓

Unit:
- all existing tests ✓
- all Organisation tests ✓

E2E:
- all existing Auth tests ✓
- all RLS tests ✓
- all RBAC tests ✓
- all TenantContext tests ✓
- all Organisation tests ✓

Security:
- cross-tenant matrix ✓
- tenant spoofing ✓
- IDOR/BOLA ✓
- missing-context fail-closed ✓

Database:
- runtime uses ros_app ✓
- migrations use ros_migrator ✓
- RLS policies verified ✓
- grants verified ✓

No database reset.

No migration edits.

No test bypasses.

============================================================
32. COMMIT STRATEGY
============================================================

Use small logical commits.

Suggested:

1. feat(org): add organisation domain schema
2. feat(org): add brand and branch
3. feat(org): add warehouses and central kitchens
4. feat(org): add stations and tables
5. feat(org): add operating and routing configuration
6. feat(org): integrate authorization and audit
7. test(org): add organisation integration coverage
8. docs(org): document organisation architecture

If the repository convention prefers fewer commits, use logical grouping.

Every commit must leave the repository buildable and testable.

============================================================
33. FINAL REPORT
============================================================

At the end, report:

1. What was implemented
2. Tables added
3. Migrations added
4. APIs added
5. Permissions added
6. Audit events added
7. RLS policies added
8. Unit test count
9. E2E test count
10. Build result
11. Lint result
12. Prisma result
13. Security review result
14. Any deviations from SRS
15. Any new ADRs
16. Any unresolved gaps
17. Commit hashes

Most importantly:

DO NOT claim Phase 15 complete if any verification gate fails.

If everything passes, STOP.

Do NOT automatically begin Phase 16 / Catalogue.

============================================================
34. ABSOLUTE RULE
============================================================

The goal is not to produce as much code as possible.

The goal is to produce a correct, maintainable, scalable implementation of the ROS SRS.

Prefer:

correctness > completeness
SRS fidelity > assumptions
security > convenience
explicit architecture > magic
bounded contexts > giant modules
tested behavior > generated code
migration safety > speed

The authentication subsystem took 14 phases because security and tenancy were treated as foundations.

Organisation must follow the same standard.

Start with DISCOVERY.

Do not code until the SRS, current schema, existing architecture, and ADRs have been inspected.
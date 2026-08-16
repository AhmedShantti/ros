# Organisation — tenant isolation

Mechanism is unchanged from ADR 0003: `PrismaService.withAuthContext` opens one
interactive transaction whose first statement is
`set_config('app.user_id', …, true), set_config('app.tenant_id', …, true)`.
Runtime connects as `ros_app` (`NOSUPERUSER`, `NOBYPASSRLS`).

## Two anchors

**Direct `tenant_id`** — `brands`, `branches`, `warehouses`, `central_kitchens`:

```sql
USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
```

**Inherited through the parent branch** — `stations`, `tables`,
`operating_hours`, `print_routing`, `kitchen.station_routing_rules`. These carry
**no `tenant_id`**, exactly as the approved SQL defines them; none was added:

```sql
EXISTS (SELECT 1 FROM org.branches b
        WHERE b.id = branch_id
          AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
```

This is the same child-inheritance pattern already proven for
`role_permissions`, `membership_roles` and `device_fingerprints` (ADR 0003/0004).

All 9 tables are `ENABLE` **and** `FORCE` ROW LEVEL SECURITY, with 4 policies each
(36 total). A missing context yields `NULL` → predicate false → **fail closed**.

> **Coverage note.** FR-PLT-013/014's generated CI sweep enumerates tables that
> *contain* a `tenant_id` column, so the five branch-inherited tables fall outside
> it. They are covered explicitly by `test/organisation.e2e-spec.ts` instead.

## Composite tenant-safe foreign keys (D-09)

PostgreSQL evaluates referential-integrity checks with row security **disabled**,
so a plain FK cannot stop a row referencing another tenant's parent. Five edges
use composite FKs:

| Child | FK | Target key |
|---|---|---|
| `branches` | `(tenant_id, brand_id)` | `brands(tenant_id, id)` |
| `warehouses` | `(tenant_id, branch_id)` | `branches(tenant_id, id)` |
| `central_kitchens` | `(tenant_id, warehouse_id)` | `warehouses(tenant_id, id)` |
| `stations` | `(branch_id, display_terminal_id)` | `identity.terminals(branch_id, id)` |
| `print_routing`, `station_routing_rules` | `(branch_id, station_id)` | `stations(branch_id, id)` |

`stations → branches`, `tables → branches`, `operating_hours → branches`,
`print_routing → branches` and `station_routing_rules → branches` use plain FKs:
those children carry no independent `tenant_id`, so they cannot contradict their
parent, and the RLS `WITH CHECK` already rejects a foreign `branch_id`.

The D-16 edge required adding `UNIQUE (branch_id, id)` to `identity.terminals` —
an **additive index only**: no column added or altered, no behaviour changed, no
Identity code touched.

## `NULLS NOT DISTINCT` (D-15)

`print_routing (branch_id, document_type, station_id)` is created with
`NULLS NOT DISTINCT`. PostgreSQL's default treats NULLs as distinct, which would
permit unlimited duplicate branch-level defaults (`station_id IS NULL`) — exactly
the row shape the constraint exists to de-duplicate. Prisma cannot express this,
so the migration drops the generated index and recreates it. Verified:
`pg_index.indnullsnotdistinct = true`.

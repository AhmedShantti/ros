# Inventory Phase — Close-Out and Ratification

**Status: CLOSED — RATIFIED**
**Close-out date: 2026-08-16**
**Authority:** user command "INVENTORY PHASE — CLOSE-OUT / RATIFICATION ONLY"; the
Inventory implementation report was accepted.

No production code, schema, migration, test, or infrastructure was created or
modified by this close-out. This document is a record only.

---

## 1. Final Phase Status

Inventory implementation is **COMPLETE**.

| Gate | Result |
|---|---|
| Unit tests | **136 / 136 passing** (24 suites) |
| E2E tests | **248 / 248 passing** (16 suites) |
| ESLint (read-only, no `--fix`) | **clean** — exit 0, 0 problems |
| `nest build` | **clean** — exit 0 |
| TypeScript, build config (`tsconfig.build.json --noEmit`) | **clean** — exit 0 |
| `prisma validate` | **clean** |
| Migrations | **13 applied, no drift** |

---

## 2. Migrations of Record

| Migration | Purpose |
|---|---|
| `20260816180000_org_location_registry` | Phase 15 location-registry prerequisite (P15-1 … P15-5): `(tenant_id, id)` unique on `org.central_kitchens`, `org.locations` table, `ck_location_target` XOR CHECK, grants, RLS, idempotent backfill of 58 rows |
| `20260816210000_inventory_foundation` | 16 tables, 5 enums, `PARTITION BY RANGE (occurred_at)` on `stock_movements` + 14 monthly partitions (no DEFAULT partition, by design), CHECK constraints, grants, append-only REVOKE loop, RLS |
| `20260817090000_inventory_partition_rls` | Remediation of the partition-RLS defect recorded in §3 |

---

## 3. Security Defect — Partitioned-Ledger RLS Bypass (RESOLVED)

**Classification: RESOLVED. Not an outstanding blocker.**

### Defect

The initial implementation failed to apply RLS independently to the 14
`inventory.stock_movements` partitions. `ENABLE`/`FORCE ROW LEVEL SECURITY` and
`CREATE POLICY` on a partitioned **parent** govern access made *through the
parent*; PostgreSQL applies a **partition's own** policies when that partition is
named directly. RLS was enabled only on the parent while `SELECT, INSERT` was
granted on every partition.

### Exposure

Found by **live `ros_app` verification probes**, not by the test suite — the
tests exercise Prisma, and Prisma always addresses the parent. The application
path was never affected; the database enforcement boundary was.

Observed pre-fix, as `ros_app`:

- `SELECT count(*) FROM inventory.stock_movements_2026_08` → **43 rows with no
  tenant context at all** (fail-closed bypassed)
- scoped to tenant O, filtering for tenant T → **11 rows leaked cross-tenant**

### Remediation

Migration `20260817090000_inventory_partition_rls` corrected **every existing
partition**, applying the already-ratified ledger policy with a byte-identical
predicate plus the append-only REVOKE. This was implementation of an
already-ratified decision, not a new design decision, and therefore did not
trigger the STOP condition.

### Post-fix verification

- Direct partition access, no tenant context → **0 rows** (was 43)
- Direct partition access, wrong tenant → **0 rows** (was 11)
- Positive control, owning tenant via partition → **11 rows** (proves the zeros
  are RLS filtering, not absent data)
- `UPDATE` / `DELETE` on a partition directly → **permission denied**
- Parent-path access unchanged → 11 rows for the owning tenant
- All 14 partitions: RLS enabled **and** forced, 2 policies each, no
  `UPDATE`/`DELETE`/`TRUNCATE` grant to `ros_app`

The guard was proven to bite: disabling RLS on one partition inside a
rolled-back transaction reproduced the 11-row leak exactly.

### Regression protection

Four regression tests in `test/inventory-rls.e2e-spec.ts` assert the database
boundary itself (partition RLS state, partition grants, direct-partition access
without context, direct-partition access cross-tenant).

---

## 4. Forward Partition Obligation (STANDING)

Every future `stock_movements` partition **MUST** receive, at creation:

1. `ENABLE ROW LEVEL SECURITY`
2. `FORCE ROW LEVEL SECURITY`
3. the ratified tenant **SELECT** policy
4. the ratified tenant **INSERT / WITH CHECK** policy
5. `REVOKE UPDATE, DELETE, TRUNCATE`
6. the same append-only protections as existing partitions

**FR-DR-002 partition automation remains DEFERRED.** Partition creation is a
manual operational step today. The regression tests in §3 fail loudly if this
obligation is skipped.

---

## 5. Documented Architectural Limitation — `org.locations` Registry

**Classification: documented architectural limitation / operational invariant.
NOT an Inventory implementation blocker.**

- Registry population is **application-enforced** through `BranchesService`,
  `WarehousesService`, and `CentralKitchensService`.
- Migration backfill covers all pre-existing rows.
- **No database trigger was added**, because triggers were not ratified.
- Direct writes that bypass the three Organisation services **can create an org
  location entity without a registry row**.
- **No trigger is to be introduced now.** Any change to this enforcement model
  requires its own ratification.

---

## 6. Catalogue Boundary-Test Change

- Catalogue's "no `inventory` schema" assertion was updated because Inventory is
  now an **authorized, completed phase** (D-17-01 re-sequenced the roadmap to
  Catalogue → Inventory → Production Spec).
- The boundary guard still protects: **production, fiscal, sales, procurement,
  workforce, treasury, crm, analytics, sync**.
- **Catalogue itself was not modified functionally.** The only other Catalogue
  test change was a fixture correction: it created branches via the migrator
  client, bypassing `BranchesService.create()`, and now registers the matching
  `org.locations` row.

---

## 7. Pre-Existing Issue (NOT introduced, NOT modified)

`tsc -p tsconfig.json --noEmit` (root config, includes tests) still fails at:

```
src/modules/identity/auth/access-token.service.spec.ts:28
error TS2322: Type 'string' is not assignable to type 'number | StringValue | undefined'.
```

Committed in `48a16f9`, predates Inventory, untouched by this phase. The **build
configuration remains clean**.

---

## 8. Confirmed Inventory Boundaries

The following were **NOT** implemented, and remain out of scope:

- ❌ Production Spec implementation
- ❌ Procurement implementation
- ❌ Sales implementation
- ❌ Governance approval workflow
- ❌ Platform scheduler / jobs / outbox / notifications
- ❌ New permissions (only the 10 SRS-attested Inventory codes are used)
- ❌ Catalogue functional changes
- ❌ New trigger infrastructure

---

## 9. Binding Design Record

The ratified Inventory decisions **D-INV-01 through D-INV-09**, together with
**B-1** (`last_movement_occurred_at` + enforced composite FK into the partitioned
ledger) and **B-2** (caller-supplied `requires_approval`; Inventory owns the
approval *gate* only, Governance will later own *when* approval is required),
are preserved as the **binding design record**.

Source of record: `docs/inventory/INVENTORY_DESIGN_GATE.md` (29 sections,
including §26.1 on the partitioned-ledger RLS bypass).

---

## 10. Next Phase

**Production Spec implementation is NOT started and is NOT authorized.**

Remaining blocker: **D-17-08** — still BLOCKED, unresolved at ratification of
Phase 17. Production Spec cannot begin until D-17-08 is ratified.

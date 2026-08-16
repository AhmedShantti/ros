# INVENTORY — FINAL DESIGN GATE / DESIGN FREEZE

- Date: 2026-08-16
- Status: **DESIGN FROZEN — AWAITING IMPLEMENTATION AUTHORIZATION**
- Phase numbering: the ratified sequence is **Phase 16 → Inventory → Production Spec**
  (decision D-17-01, "Inventory first"). This document deliberately avoids a phase
  number, since Production Spec was originally scoped as Phase 17.
- Basis: blockers C-01 … C-09 as ratified by the project owner. **Nothing below
  reinterprets, weakens or replaces those decisions.**

## Baseline at time of freeze

| Item | State |
|---|---|
| HEAD | `48a16f9` |
| Migrations | 10 applied, no drift |
| Schemas | `catalogue, governance, identity, kitchen, org` |
| `inventory` / `production` tables | none |
| Phase 15 / 16 | untouched |

**Nothing in this document has been implemented.** No migration, no Prisma schema
change, no application code, no ADR.

---

## 1. Bounded-Context Scope

**Inventory** — "what physically exists, where, and what it cost."

Ubiquitous language (SRS §5.3): **"Item" here means STOCKABLE.** In Catalogue it
means sellable. Translation happens at the boundary and no Catalogue entity is
copied.

**Owns:** stock item master, units of measure, batches, the movement ledger,
stock-level projections, counting, waste, reason codes, per-location reorder
configuration.

**Consumes:** Organisation (locations), Identity (users, tenancy).

**Does not own:** recipes (Production Spec), sellable items (Catalogue), purchase
orders and goods receipts (Procurement), orders and depletion triggering (Sales),
COGS accounting (Costing), approvals (Governance), scheduling (platform).

---

## 2. Final Aggregate Boundaries

| Aggregate root | Contained entities | Boundary rule |
|---|---|---|
| **StockItem** | UomConversions (item-specific), PackagingUnits, per-location ReorderConfig | Base unit immutable once any movement exists (FR-INV-002) |
| **StockLevel** | BatchAllocations | **Projection only** — never authored directly; folded from the ledger |
| **Batch** | — | Created on receipt/production; `quantity_remaining` mutated by allocation |
| **StockMovement** | — | **Append-only**; never updated or deleted; reversal is a new opposite-sign movement |
| **CountSession** | CountSessionItems, CountLines (+ recount lineage) | Post-once; posting emits `count_adjustment` movements |
| **WasteRecord** | WasteLines | Posting emits `waste` movements |
| **ReasonCode** | — | Tenant reference data |
| **Uom** | — | **Global, un-tenanted** platform reference data |

---

## 3. Complete Proposed Table List (16)

**`org` schema — 1 new table (Phase-15 impact, see §8):**

- `org.locations`

**`inventory` schema — 15 tables:**

`uom` · `uom_conversions` · `packaging_units` · `stock_items` ·
`stock_item_categories` · `stock_item_reorder_configs` *(new, C-04)* ·
`stock_batches` · `stock_movements` *(partitioned)* · `stock_levels` ·
`stock_level_batch_allocations` · `count_sessions` ·
`count_session_items` *(new, C-05)* · `count_lines` · `waste_records` ·
`waste_lines` · `reason_codes`

**Enums:** `inventory.movement_type_enum` (13 values, verbatim from approved SQL),
plus new enums for costing method, batch-selection strategy, count scope, and
location type.

---

## 4. Columns Added / Changed Relative to the Approved SQL

| # | Change | Ratified by |
|---|---|---|
| 1 | `stock_movements` PK → `(id, occurred_at)` | C-01 (PostgreSQL requirement, proven §9) |
| 2 | `stock_movements.counterpart_occurred_at` added | C-01 (self-FK repair) |
| 3 | `stock_movements` → `PARTITION BY RANGE (occurred_at)` | C-01 |
| 4 | `location_id` on 6 tables → real FK to `org.locations` | C-02 |
| 5 | `stock_items.expiry_tracked BOOLEAN NOT NULL DEFAULT false` | C-04 |
| 6 | `stock_items.shelf_life_days INTEGER NULL` | C-04 |
| 7 | `stock_items.reorder_point` / `reorder_quantity` **removed**; replaced by `stock_item_reorder_configs` | C-04 (resolves FR-INV-065 [M] conflict) |
| 8 | `stock_items.batch_strategy` enum (`fifo \| fefo`) | C-03 (selection ≠ valuation) |
| 9 | `count_sessions.scope_type` / `scope_id` + `count_session_items` | C-05 |
| 10 | `tenant_id` added to `stock_levels` and `stock_level_batch_allocations` | C-09 |
| 11 | `reason_codes` UNIQUE `(tenant_id, category, code)` | C-09 |
| 12 | `(tenant_id, id)` uniques added across inventory parents | D-09 / §13 |
| 13 | `tenant_id` FKs to `identity.tenants` where the approved SQL declared the column without one | D-09 consistency |

**Deliberately NOT added** (per C-04): default supplier, min/max stock,
is-sellable-directly, is-produced, multiple barcodes, allergens, account code.

---

## 5. Primary Keys and Unique Constraints

| Table | PK | Additional uniques |
|---|---|---|
| `stock_movements` | **`(id, occurred_at)`** | `(tenant_id, id, occurred_at)` |
| `stock_levels` | `(stock_item_id, location_id)` | `(tenant_id, stock_item_id, location_id)` |
| `stock_level_batch_allocations` | `(stock_item_id, location_id, batch_id)` | — |
| `stock_items` | `id` | `(tenant_id, id)`, `uq_stock_item_sku (tenant_id, sku)` |
| `stock_item_categories` | `id` | `(tenant_id, id)` |
| `stock_item_reorder_configs` | `id` | `(tenant_id, stock_item_id, location_id)` |
| `stock_batches` | `id` | `(tenant_id, id)` |
| `count_sessions` | `id` | `(tenant_id, id)` |
| `count_session_items` | `id` | `(count_session_id, stock_item_id)` |
| `count_lines` | `id` | — |
| `waste_records` | `id` | `(tenant_id, id)` |
| `waste_lines` | `id` | — |
| `reason_codes` | `id` | `(tenant_id, id)`, **`(tenant_id, category, code)`** |
| `uom` | `id` | `code` (global) |
| `uom_conversions` | `id` | `uq_uom_conv (from_unit_id, to_unit_id, stock_item_id)` |
| `org.locations` | `id` | `(tenant_id, id)`, `(tenant_id, location_type, ref_id)` |

---

## 6. Composite Tenant-Safe Foreign Keys (D-09 / §13)

```
org.locations         (tenant_id, branch_id)          -> org.branches(tenant_id, id)
                      (tenant_id, warehouse_id)       -> org.warehouses(tenant_id, id)
                      (tenant_id, central_kitchen_id) -> org.central_kitchens(tenant_id, id)  [needs P15-1]

stock_items           (tenant_id, category_id)        -> stock_item_categories(tenant_id, id)
stock_item_reorder_configs
                      (tenant_id, stock_item_id)      -> stock_items(tenant_id, id)
                      (tenant_id, location_id)        -> org.locations(tenant_id, id)
stock_batches         (tenant_id, stock_item_id)      -> stock_items(tenant_id, id)
                      (tenant_id, location_id)        -> org.locations(tenant_id, id)
stock_movements       (tenant_id, stock_item_id)      -> stock_items(tenant_id, id)
                      (tenant_id, location_id)        -> org.locations(tenant_id, id)
                      (tenant_id, batch_id)           -> stock_batches(tenant_id, id)
                      (tenant_id, reason_code_id)     -> reason_codes(tenant_id, id)
                      (tenant_id, counterpart_movement_id, counterpart_occurred_at)
                                                      -> stock_movements(tenant_id, id, occurred_at)
stock_levels          (tenant_id, stock_item_id)      -> stock_items(tenant_id, id)
                      (tenant_id, location_id)        -> org.locations(tenant_id, id)
count_sessions        (tenant_id, location_id)        -> org.locations(tenant_id, id)
count_session_items   (count_session_id)              -> count_sessions(id)
count_lines           (count_session_id)              -> count_sessions(id)
waste_records         (tenant_id, location_id)        -> org.locations(tenant_id, id)
                      (tenant_id, reason_code_id)     -> reason_codes(tenant_id, id)
waste_lines           (waste_record_id)               -> waste_records(id)
```

---

## 7. RLS Strategy — Every Inventory Table

| Table | Anchor |
|---|---|
| `uom`, `uom_conversions`, `packaging_units` | **No RLS — global reference data.** Precedent: `identity.permissions` (ADR 0003 "Excluded tables") |
| `org.locations`, `stock_items`, `stock_item_categories`, `stock_item_reorder_configs`, `stock_batches`, `stock_movements`, `stock_levels`, `stock_level_batch_allocations`, `count_sessions`, `waste_records`, `reason_codes` | **Direct `tenant_id`** — `ENABLE` + `FORCE`, 4 per-operation policies, predicate `NULLIF(current_setting('app.tenant_id', true), '')::uuid`, fail-closed |
| `count_session_items`, `count_lines`, `waste_lines` | **`EXISTS(parent)` inheritance** (ADR 0003) |

**`stock_movements` additionally:**

```sql
GRANT SELECT, INSERT ON inventory.stock_movements TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON inventory.stock_movements FROM ros_app;
-- and NO update/delete policy
```

This is the exact ADR 0007 `governance.audit_entries` pattern, satisfying
**BR-INV-001** ("append-only; no UPDATE or DELETE permitted") at the database
rather than in application code.

Runtime remains `ros_app` (`NOSUPERUSER`, `NOBYPASSRLS`); migrations remain
`ros_migrator`.

---

## 8. `org.locations` Design and Exact Phase-15 Impact

### Design

```
org.locations
  id             uuid PK
  tenant_id      uuid NOT NULL -> identity.tenants(id)
  location_type  enum(branch | warehouse | central_kitchen) NOT NULL
  ref_id         uuid NOT NULL              -- the concrete org entity
  branch_id           uuid NULL             -- typed, XOR-constrained
  warehouse_id        uuid NULL
  central_kitchen_id  uuid NULL
  created_at     timestamptz NOT NULL DEFAULT now()

  UNIQUE (tenant_id, id)
  UNIQUE (tenant_id, location_type, ref_id)
  CHECK  exactly one of branch_id / warehouse_id / central_kitchen_id IS NOT NULL
         AND that column agrees with location_type
  FK (tenant_id, branch_id)          -> org.branches(tenant_id, id)
  FK (tenant_id, warehouse_id)       -> org.warehouses(tenant_id, id)
  FK (tenant_id, central_kitchen_id) -> org.central_kitchens(tenant_id, id)
```

**Why this shape.** It yields a **single non-null, FK-able `location_id`** — which
is what the projection tables require, since `stock_levels` has
`PRIMARY KEY (stock_item_id, location_id)` and PostgreSQL forbids nullable PK
columns. A nullable typed triple could not have satisfied those primary keys.
Structural tenant safety is retained through three real composite FKs plus the
XOR CHECK.

### Exact Phase-15 impact — nothing implemented

| # | Change | Type |
|---|---|---|
| **P15-1** | **`org.central_kitchens` must gain UNIQUE `(tenant_id, id)`.** Verified absent — `org.branches` and `org.warehouses` already have it; `org.central_kitchens` does **not**. Without it the third composite FK cannot be created. | Additive index; no column, no behaviour change |
| **P15-2** | New table `org.locations` inside the Phase-15-owned `org` schema | Additive |
| **P15-3** | Prisma back-relations `locations Location[]` on `Branch`, `Warehouse`, `CentralKitchen`, `Tenant` | Additive schema declarations |
| **P15-4** | **Registry population.** A `locations` row must exist for every branch, warehouse and central kitchen. Requires either backfill plus writes in `BranchesService`, `WarehousesService`, `CentralKitchensService` — **a behavioural change to Phase 15 code** — or database triggers. | **Requires explicit authorization** |
| **P15-5** | Phase 15 e2e suites re-run; registry-population coverage added | Verification |

**P15-4 is the only item that changes Phase 15 behaviour.** Per the ratification it
is reported, not implemented, and needs its own authorization. Options to weigh at
that point: service-layer write vs database trigger vs reconciliation backfill.

---

## 9. `stock_movements` Partitioning, Key and Self-Reference Design

### Empirically proven on PostgreSQL 16.15

| Test | Result |
|---|---|
| `PRIMARY KEY (id)` on a `RANGE (occurred_at)`-partitioned table | **FAILS** — `ERROR: unique constraint on partitioned table must include all partitioning columns … PRIMARY KEY constraint on table "t1" lacks column "occurred_at"` |
| `PRIMARY KEY (id, occurred_at)` | **Succeeds** |
| Composite **self-referencing** FK `(counterpart_id, counterpart_occurred_at) -> (id, occurred_at)` on the partitioned table | **Succeeds** |
| Non-partitioned child referencing the partitioned parent | **Succeeds** |

The approved SQL's `PRIMARY KEY (id)` is therefore **invalid as written** once
partitioning is applied.

### Resolution

```
PRIMARY KEY (id, occurred_at)
UNIQUE      (tenant_id, id, occurred_at)

counterpart_movement_id   uuid        NULL
counterpart_occurred_at   timestamptz NULL
FOREIGN KEY (tenant_id, counterpart_movement_id, counterpart_occurred_at)
  REFERENCES inventory.stock_movements (tenant_id, id, occurred_at)
```

**No invalid FK to `stock_movements(id)` is left anywhere in the design.**
BR-INV-002's equal-absolute-quantity pairing remains a service-enforced invariant;
the FK guarantees only that the counterpart exists within the same tenant.

### Partitioning

- `PARTITION BY RANGE (occurred_at)`, **monthly** partitions.
- Designed for **24 months online** (FR-DR-001 [M]).
- **NFR-DATA-001 [M] 7-year retention preserved** — partitions are archived, never
  dropped, so retention is an operational policy over an intact ledger.
- Initial partitions created explicitly in the migration.
- **FR-DR-002 automated partition creation is DEFERRED (C-08).** This creates a
  standing operational obligation: a missing future partition causes inserts to be
  **rejected**. This must be tracked as an operational risk, not a nicety.

### Indexes (from §25.2 plus tenancy)

`(stock_item_id, location_id, occurred_at DESC)` ·
`(reference_type, reference_id)` · `(tenant_id, occurred_at)`

---

## 10. StockLevel Projection and Reconciliation Design

`stock_levels` is a **projection** (SRS §7.3 #13, FR-INV-010 [M]) and is never
authored directly.

Every mutation path — receipt, depletion, transfer, count adjustment, waste —
writes a movement inside `PrismaService.withAuthContext` and updates the
projection **in the same transaction**, setting `last_movement_id` and the
movement's `balance_after`.

**Reconciliation (BR-INV-003, FR-INV-011 [M], FR-INV-051 [M]):** fold
`SUM(quantity) GROUP BY (stock_item_id, location_id)` over the ledger and compare
against `quantity_on_hand`. Implemented as an **on-demand service operation that
returns divergences**; `last_reconciled_at` is stamped on success.
**Scheduling and alert delivery are deferred (C-08).**

**FR-INV-014 [M]:** negative stock levels are **permitted and recorded**; the
transaction is never blocked. The required "alert" is surfaced in the response and
report — **delivery deferred (C-08)**.

**FR-INV-015 [M]:** historical valuation at any date is computed by replaying the
ledger up to that timestamp. No snapshot table is introduced.

---

## 11. Costing-Method Design (C-03 — all three)

`stock_items.costing_method` enum `weighted_average | fifo | standard`;
`standard_cost BIGINT` used only when `standard`.

**Weighted average** — on each inbound movement:
`average_cost = (existing_value + received_value) / (existing_qty + received_qty)`,
stored on `stock_levels.average_cost`. Outbound is valued at the prevailing
average.

**FIFO** — outbound consumes batches in **receipt order**;
`stock_level_batch_allocations` is decremented per batch; every consuming movement
records the `batch_id` and that batch's `unit_cost` (FR-INV-013 [M]).

**Standard** — outbound valued at `standard_cost`. The purchase-price difference is
**computed and reported but NOT posted**: no variance-account entity exists in the
SRS or approved SQL, and C-03 forbids inventing accounting infrastructure.
FR-INV-012's "purchase price variance posted separately" is **unmet by explicit
decision**.

**FR-INV-034 [M]** — transfers move at the **sending location's cost**; any
difference is computed and surfaced, **not posted**, for the same reason.

---

## 12. FIFO / FEFO Interaction Boundary

Two **orthogonal** axes, exactly as ratified in C-03:

| Axis | Column | Values | Governs |
|---|---|---|---|
| **Batch selection** | `stock_items.batch_strategy` | `fifo` \| `fefo` | *Which physical batch* is consumed |
| **Valuation** | `stock_items.costing_method` | `weighted_average` \| `fifo` \| `standard` | *What cost* is recorded |

FEFO is the default where `expiry_tracked = true` (FR-INV-023 [M]).
**FEFO is never assumed to imply FIFO costing.**

**Documented, not invented (residual ambiguity §29-1):** the SRS does not define the
cost basis when `batch_strategy = fefo` **and** `costing_method = fifo` — i.e.
whether the consumed batch's own cost applies, or the oldest remaining batch's
cost. The design records the consumed `batch_id` and its `unit_cost` on every
movement, which preserves the information required to satisfy either reading once
the SRS is clarified. **No behaviour is invented for this combination.**

---

## 13. Item Expiry / Shelf-Life Design (C-04)

- `stock_items.expiry_tracked BOOLEAN NOT NULL DEFAULT false`
- `stock_items.shelf_life_days INTEGER NULL`

On batch creation, `expiry_date` defaults to `production_date + shelf_life_days`
where both are present, overridable at receipt (**FR-INV-021 [M]**).
`expiry_tracked = true` causes `batch_strategy` to default to `fefo`
(**FR-INV-023 [M]**).

Approved-SQL batch CHECKs retained verbatim: `quantity_remaining >= 0` and
`expiry_date >= production_date`.

**Deferred:** expiry-alert horizons (FR-INV-024 — computation available on demand,
delivery deferred per C-08); automatic write-off at day close (FR-INV-026 —
Treasury dependency).

---

## 14. Per-Location Reorder Design (C-04)

```
inventory.stock_item_reorder_configs
  id, tenant_id, stock_item_id, location_id,
  reorder_point    NUMERIC(18,6),
  reorder_quantity NUMERIC(18,6)
  UNIQUE (tenant_id, stock_item_id, location_id)
```

This resolves the **FR-INV-065 [M] vs approved-SQL conflict** in favour of the SRS
(per-location, not per-item). The item-level `reorder_point` / `reorder_quantity`
columns are **not created**.

FR-INV-066 low-stock detection is an on-demand computation; **alerting deferred
(C-08)**. FR-INV-067–070 remain out of scope (suggested-order formulas require
supplier lead time — Procurement).

---

## 15. Count-Session Scope Design, Including Ad-Hoc Item Lists (C-05)

```
count_sessions.scope_type  enum(full_location | category | item_list) NOT NULL
count_sessions.scope_id    uuid NULL   -- category id when scope_type = category

inventory.count_session_items (count_session_id, stock_item_id)  -- ad-hoc list only
```

**Ad-hoc item lists** are represented by `count_session_items`, a child entity of
the session **inside the Inventory context**, referencing `stock_items`. **No new
bounded context and no physical storage-area entity is introduced**, exactly as
C-05 requires. `scope_id` is used only for `category` (referencing
`stock_item_categories`), so it is a **typed** reference, not a polymorphic one.

**FR-INV-044 [M] count-window handling:** `expected_quantity` is frozen per line at
session open. At posting, movements occurring during the window are identified by
`occurred_at > count_sessions.started_at`, so variance is computed against the
frozen snapshot with concurrent trading accounted for.

**Blind count** (`is_blind_count`, default true per FR-INV-042 [M]) suppresses
`expected_quantity` from read views for the duration of the session.

**FR-INV-048 [S]** (cycle-count A/B/C classes) and **FR-INV-049 [S]**
(storage-ordered count sheets) are **unmet by explicit decision** — the latter
would require the storage-area entity C-05 forbids.

---

## 16. Transfer Discrepancy Representation (C-06)

`transfer_out` and `transfer_in` remain **exactly paired with equal absolute
quantity**, linked by the composite counterpart FK. **BR-INV-002 is preserved
unweakened, and no discrepancy table is introduced.**

Where the received quantity differs from the dispatched quantity, an **additional
`manual_adjustment` movement is recorded at the receiving location** for the
difference, carrying a mandatory `reason_code_id` — already enforced by the
approved SQL's `ck_reason_required` CHECK.

In-transit stock remains visible as the interval between the paired movements
(BR-INV-002).

The "requiring investigation and approval" half of **FR-INV-032 [M]** follows C-07
and is **blocked by the missing Governance approval context**.

---

## 17. Approval-Gated Behaviour and Deferred Governance Dependency (C-07)

`requires_approval` is computed and persisted where the schema can represent it
(`waste_records.requires_approval`). Where an operation requires approval,
**posting is refused** — the operation never silently completes.

`waste_records.approval_request_id` remains **null and unused**.
**`governance.approval_requests` is NOT created.** Threshold *configuration* has no
defined home — `org.settings` was deferred by ADR 0008 D-11 — so thresholds are not
stored and **no threshold-configuration storage is invented**.

**Explicitly blocked by the missing Governance approval context:**

| FR | Requirement |
|---|---|
| FR-INV-035 [M] | Manual adjustments require approval above a value threshold |
| FR-INV-046 [M] | Variances beyond threshold require recount or written explanation |
| FR-INV-047 [M] | Count posting is an approval-requiring action for high-value adjustments |
| FR-INV-058 [M] | Waste above threshold requires manager approval before posting |

---

## 18. Scheduled-Job and Alerting Deferrals (C-08)

**No scheduler, job runner, `platform.jobs`, outbox, notifications or alert-delivery
infrastructure is created.** Underlying logic is implemented and exposed on demand;
triggering is deferred.

| FR | Logic implemented | Scheduling / delivery |
|---|---|---|
| FR-INV-011 [M] | reconciliation computation | **deferred** |
| FR-INV-051 [M] | same reconciliation | **deferred** |
| FR-INV-014 [M] | negative-stock detection | alert delivery **deferred** |
| FR-INV-024 [M] | expiry-horizon computation | **deferred** |
| FR-INV-066 [M] | low-stock computation | **deferred** |
| FR-DR-002 [M] | none | **deferred** — manual partition pre-creation |

**None of these requirements is claimed as fully satisfied.**

---

## 19. `reason_codes` Uniqueness (C-09)

`UNIQUE (tenant_id, category, code)` — the minimum structurally meaningful key.
`category` ∈ `waste | adjustment` (approved SQL comment). **No additional
uniqueness rules invented.**

The 13 default reason codes of FR-INV-057 [M] (Expired, Spoiled, Damaged in
delivery, Preparation error, Overproduction, Incorrect portion, Burnt/overcooked,
Customer return, Order error, Staff meal, Sampling/tasting, Equipment failure,
Theft/unexplained) are **seedable data**, not schema.

---

## 20. Permission Mapping — SRS §15.2 Only

| Permission | Guards |
|---|---|
| `inventory.view` | stock levels, batches, movements (read), reason codes, reorder configs |
| `inventory.count.perform` | open session, enter counted quantities, recount |
| `inventory.count.post` | post session → `count_adjustment` movements |
| `inventory.approve_high_variance` | post beyond variance threshold *(gate refuses pending C-07)* |
| `inventory.adjust` | `manual_adjustment` movements, including the C-06 discrepancy adjustment |
| `inventory.transfer.create` | `transfer_out` |
| `inventory.transfer.receive` | `transfer_in` |
| `inventory.waste.record` | create waste record and lines |
| `inventory.waste.approve` | approve above threshold *(gate refuses pending C-07)* |
| `inventory.cost.view` | `unit_cost`, `total_cost`, `average_cost`, valuation reports |

**Ten codes, all attested by the SRS. None invented.** This is the first context in
the project requiring no invented permission codes.

`inventory.cost.view` implies cost fields are **omitted from read views** unless the
caller holds it.

§15.4 names `inventory.count.perform` + `inventory.count.post` as an **incompatible
pair** (segregation of duties — "counter approves own count"). This is a
warn-on-combination requirement; **not implemented**, because no source defines the
mechanism.

**Gap (§29-3):** no attested permission covers stock-item **master** maintenance.

---

## 21. FR-INV-001 … FR-INV-070 Coverage Matrix

### Implemented

001 *(partial per C-04)*, 002, 003, 004, 010, 012, 013, 014ᴸ, 015, 020, 021, 022,
023, 025, 030, 031, 034ᶜ, 040, 041, 042, 044, 045, 050, 057, 059, 065

### Logic implemented, scheduling/delivery deferred (C-08)

011, 014ᴸ, 024, 051, 066

### Blocked by dependency

| FR | Blocking context |
|---|---|
| 005 | Procurement (supplier codes/barcodes) |
| 026 | Treasury (day close) |
| 027 | Sales (forward trace half) |
| 032ᵃ | Governance (investigation/approval half) |
| 035ᵃ, 046ᵃ, 047ᵃ, 058ᵃ | Governance approval workflow |
| 043 | Sync (offline mobile counting) |
| 055 | Sales / Kitchen Ops (POS and KDS entry points) |
| 056 | Workforce (employee identity), photo storage |
| 060 | Kitchen Ops / Workforce (station, shift, day-part) |
| 067 | Procurement (supplier lead time) |

### Unmet by explicit decision

012's variance posting · 033 (transfer note/QR) · 034ᶜ's variance posting ·
048 (cycle counting) · 049 (storage-ordered sheets) · 061 (anomaly detection) ·
068 / 069 / 070 (forecasting)

*ᴸ logic present, delivery deferred · ᶜ cost transferred, variance not posted ·
ᵃ approval-blocked (C-07)*

---

## 22. NFR Coverage

| NFR | Status |
|---|---|
| **NFR-PERF-005 [M]** — 3,000-item stock-level query < 500 ms p95 | Addressed by C-09's direct `tenant_id` on `stock_levels` plus index `(tenant_id, location_id, stock_item_id)`; no `EXISTS(stock_items)` join on the hot path. **To be measured, not assumed.** |
| **NFR-PERF-006 [M]** — recipe expansion + depletion < 200 ms inside the order transaction | **Out of scope** (Sales + Production Spec) |
| **NFR-DATA-001 [M]** — 7-year movement retention | Preserved; partitions archived, never dropped |

---

## 23. Boundary-Compliance Check

Inventory does **NOT** implement:

Procurement · Sales · Production Spec · Kitchen Ops · Costing/COGS accounting ·
Treasury · Workforce · Governance workflow · Sync · Analytics · Fiscal ·
Integrations · `platform` job/outbox/notification infrastructure

Also not implemented: variance/accounting entities · physical storage-area entity ·
transfer-discrepancy table · threshold-configuration storage · cycle-count classes ·
statistical anomaly detection.

`catalogue.modifiers.stock_item_id` is **not** retrofitted with a foreign key —
that would touch Phase 16.

---

## 24. Migration Ordering and Dependency Graph

```
[M-A] org: central_kitchens UNIQUE (tenant_id, id)          <- P15-1
        |
        +-- [M-B] org.locations + composite FKs + XOR CHECK
        |         + RLS + grants                            <- P15-2
        |
        +-- [M-C] org.locations population/backfill         <- P15-4
                  (AUTHORIZATION REQUIRED)
                    |
                    +-- [M-D] inventory schema
                          |-- enums (movement_type, costing_method,
                          |          batch_strategy, count_scope, location_type)
                          |-- uom -> uom_conversions, packaging_units
                          |-- stock_item_categories -> stock_items
                          |       -> stock_item_reorder_configs
                          |-- stock_batches
                          |-- stock_movements (PARTITIONED) + initial partitions
                          |       -> composite self-FK (after PK exists)
                          |-- stock_levels, stock_level_batch_allocations
                          |-- count_sessions -> count_session_items, count_lines
                          |-- reason_codes -> waste_records -> waste_lines
                          |-- CHECK constraints
                          |-- grants + ALTER DEFAULT PRIVILEGES
                          |-- REVOKE UPDATE/DELETE on stock_movements
                          +-- RLS ENABLE + FORCE + policies
```

**M-A, M-B and M-C touch Phase 15 and are gated on separate authorization.**
Whether this ships as one migration or two (org, then inventory) is an open
implementation choice.

---

## 25. Everything Requiring a Phase 15 / 16 Change

**Phase 15 — required:**

- **P15-1** UNIQUE `(tenant_id, id)` on `org.central_kitchens` *(verified absent)*
- **P15-2** new table `org.locations`
- **P15-3** Prisma back-relations on `Branch`, `Warehouse`, `CentralKitchen`, `Tenant`
- **P15-4** registry population — **the only behavioural change; needs its own authorization**
- **P15-5** Phase 15 e2e re-verification

**Phase 16 — none.** No Catalogue table, service or contract is touched;
`modifiers.stock_item_id` remains FK-less and opaque.

**Identity / Auth — none.**

---

## 26. Security / RLS Attack-Surface Review

| Surface | Mitigation |
|---|---|
| Cross-tenant location reference | `org.locations` composite FKs + XOR CHECK; `(tenant_id, location_id)` composites on every consumer |
| Cross-tenant stock item / batch / reason code | Composite FKs on every edge |
| Ledger tampering | REVOKE UPDATE/DELETE + no policy (ADR 0007 pattern) |
| Missing tenant context | Fail-closed `NULLIF(current_setting(...))` on all 11 anchored tables |
| Cost disclosure | `inventory.cost.view` gates cost fields in read views |
| Fraud via waste | Reason code mandatory (`ck_reason_required`); posting refused when approval required — **threshold enforcement blocked (C-07)** |
| Segregation of duties | **Not implemented** — §15.4 is warn-only and defines no mechanism |
| `uom_conversions` cross-tenant readability | **Residual ambiguity §29-2** |
| Direct access to a ledger **partition** | RLS enabled + forced + both policies on **every partition**, not just the parent — see §26.1 |

### 26.1 Partitioned-ledger RLS — a bypass this design originally missed

`ENABLE`/`FORCE ROW LEVEL SECURITY` and `CREATE POLICY` on a **partitioned
parent** govern access made *through the parent*. When a **partition is named
directly**, PostgreSQL applies **that partition's own policies**. The Inventory
foundation migration enabled RLS only on `inventory.stock_movements` while
granting `SELECT, INSERT` on all 14 partitions, so

```sql
SELECT * FROM inventory.stock_movements_2026_08;
```

read **every tenant's ledger, with no tenant context at all**. Found by a live
`ros_app` probe during the implementation verification gate — not by the test
suite, which exercises Prisma, and Prisma always addresses the parent. The
application path was never affected; the *database boundary* was.

Closed by migration `20260817090000_inventory_partition_rls`, which applies the
already-ratified ledger policy (byte-identical predicate) plus the append-only
`REVOKE` to each partition. Guarded by four regression tests in
`test/inventory-rls.e2e-spec.ts`.

> **FORWARD OBLIGATION.** Every future `stock_movements` partition MUST repeat
> `ENABLE` + `FORCE` + both policies + `REVOKE UPDATE, DELETE, TRUNCATE`.
> Partition creation is manual today (FR-DR-002 automation is deferred), so this
> is a standing manual step; the regression test fails loudly if it is skipped.

---

## 27. Performance Implications

The hot path is `stock_levels` queried by `(tenant_id, location_id)`. C-09's
`tenant_id` makes the RLS predicate an index-friendly equality rather than a
correlated `EXISTS` subquery — directly serving **NFR-PERF-005 [M]**.

Ledger reads are partition-pruned by `occurred_at` and served by
`(stock_item_id, location_id, occurred_at DESC)`.

Reconciliation is a full fold over the ledger and is therefore **explicitly
on-demand**, never on the read path.

FIFO consumption touches `stock_level_batch_allocations` ordered by receipt date
(FIFO) or expiry date (FEFO).

---

## 28. Data-Integrity Invariants and Enforcement Point

| Invariant | Enforced at |
|---|---|
| `quantity <> 0` | **DB CHECK** |
| Batch required for `purchase_receipt` / `production_output` | **DB CHECK** (`ck_batch_required`) |
| Reason required for `waste` / `manual_adjustment` | **DB CHECK** (`ck_reason_required`) |
| `quantity_remaining >= 0` | **DB CHECK** |
| `expiry_date >= production_date` | **DB CHECK** |
| Exactly one location type | **DB CHECK** (XOR on `org.locations`) |
| Ledger append-only (BR-INV-001) | **DB privilege** (REVOKE + no policy) |
| Tenant isolation | **RLS + composite FK** |
| Unique SKU / reason code / reorder config / location | **DB UNIQUE** |
| Transfer pair balanced (BR-INV-002) | **Service** |
| Base-unit immutability (FR-INV-002) | **Service** — conditional on ledger state |
| Level = fold of movements (BR-INV-003) | **Service** (same transaction) + **on-demand reconciliation** |
| Count posts exactly once | **Service** (status guard) |
| FEFO / FIFO batch selection | **Service** |
| Costing computation | **Service** |
| Variance / threshold approval | **Deferred** (C-07) |
| Scheduled reconciliation and alerts | **Deferred** (C-08) |
| Segregation of duties | **Deferred** — no defined mechanism |

---

## 29. Remaining Ambiguities That Cannot Be Resolved

1. **FEFO batch selection combined with FIFO costing** — the SRS does not define the
   cost basis. The design records `batch_id` and `unit_cost` on every movement so
   either reading remains satisfiable later. **Not invented.**
2. **`uom_conversions` tenancy** — the table is un-tenanted (approved SQL) yet
   carries item-specific density rows keyed to a tenant-owned `stock_item_id`.
   Whether item-specific conversions should be tenant-isolated is unstated.
3. **No permission for stock-item master maintenance** — §15.2 has no code for
   creating or editing items; `inventory.adjust` covers quantities only.
4. **`performed_by` / `recorded_by`: user vs employee** — the SRS says *employee*
   (Workforce); the approved SQL references `identity.users`. §5.3 states these are
   distinct concepts.
5. **`stock_levels.quantity_reserved`** — "allocated to open orders/production"; no
   writer exists within Inventory scope.
6. **Threshold configuration home** — undefined, since `org.settings` was deferred
   by ADR 0008 D-11.
7. **Who seeds the global `uom` table** — un-tenanted with a globally unique `code`;
   the SRS never says.

None of these blocks the frozen design; each is documented rather than resolved.

---

## Appendix — Correction: an unintended database change, made and reverted

While proving the partitioning constraints in §9, a probe was run with
`psql --single-transaction`, which **commits on success**. The second probe
therefore created a `probe` schema containing three throwaway tables in the
development database rather than rolling back as intended.

It was detected in the same step and removed with `DROP SCHEMA probe CASCADE`.
Re-verified afterwards: schemas are exactly
`catalogue, governance, identity, kitchen, org`; `prisma migrate status` reports 10
migrations up to date; the drift check returns an empty migration; the working tree
is unchanged. No application schema, migration or file was affected.

This is recorded because the instruction was that nothing be modified, and the
revert should not be silent.

The two findings that probe established are load-bearing and were worth proving
rather than asserting: `PRIMARY KEY (id)` is **rejected** on the partitioned ledger,
and the composite self-FK **is** creatable — which is what makes the C-01
`counterpart_movement_id` resolution valid.

---

**Design frozen. Nothing implemented — no migration, no Prisma schema change, no
application code, no ADR.** Awaiting explicit implementation authorization, noting
that **P15-4 (locations-registry population) requires its own authorization**, being
the one item that changes Phase 15 behaviour.

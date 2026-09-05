/**
 * The tables this job maintains, and exactly what "safe" means for each one.
 *
 * ── SCOPE: THE THREE TABLES ALREADY PARTITIONED TODAY ───────────────────────
 * FR-DR-001 names six range-partitioned tables. Of those six, only three exist
 * as partitioned tables in this repository right now — `inventory.
 * stock_movements` (`20260816210000_inventory_foundation`) and `sales.orders`
 * / `sales.order_lines` (`20260820120000_sales_order_foundation`), all monthly.
 * The other three are NOT in this registry, deliberately:
 *
 *   - `governance.audit_entries` exists but was created as an ordinary,
 *     non-partitioned table. Converting it now means a physical table rewrite
 *     of live audit history under an append-only, hash-chained invariant —
 *     out of scope for a job whose brief is to MAINTAIN existing partition
 *     topology, and a real data-migration risk this slice does not take on.
 *   - `analytics.fact_sales_line` does not exist anywhere in this repository —
 *     there is no `analytics` schema at all yet.
 *   - `sync.sync_operations` was explicitly designed non-partitioned "for
 *     exactly this reason" (its own migration's comment): partitioning needed
 *     a partition-lifecycle job that did not exist. That job exists now, but
 *     converting an already-populated, append-only, weekly-partitioned table
 *     is a physical migration with its own correctness obligations (existing
 *     rows must land in the right partition, `op_id` identity must not move,
 *     concurrent writers must never see a gap) that this slice has not
 *     designed, reviewed, or proven safe. See the accompanying report's
 *     follow-up section.
 *
 * All three are real, precise gaps — recorded, not silently dropped.
 *
 * ── WHY THIS IS CODE, NOT A DATABASE TABLE ──────────────────────────────────
 * Which physical tables are partitioned, on which column, with which RLS
 * shape, is a property of the schema itself — it changes only when a
 * migration changes it. Encoding it in a database row would let it drift from
 * the migrations that actually define the tables, with nothing to keep them
 * in sync. A code constant reviewed alongside the migration that creates or
 * changes a partitioned table is the same discipline `ScheduledJobRegistry`
 * already applies to job handlers themselves.
 */

/**
 * The two RLS shapes actually in use on the tables this job maintains — see
 * `20260816210000_inventory_foundation` (stock_movements: append-only) and
 * `20260820120000_sales_order_foundation` (orders/order_lines: full DML,
 * including the tenant-scoped UPDATE for order status transitions). A new
 * partitioned table with a genuinely different policy shape needs a third
 * variant added here deliberately, not a silent generalisation.
 */
export type PartitionRlsShape = 'append_only' | 'full_dml';

export interface PartitionedTableConfig {
  readonly schema: string;
  readonly table: string;
  /** The `RANGE`-partitioned column. `DATE` or `TIMESTAMPTZ`; both accept the
   * same `'YYYY-MM-01'` bound literals. */
  readonly partitionKeyColumn: string;
  readonly rlsShape: PartitionRlsShape;
  /** Shared across every partition of this parent — matches the
   * `DROP POLICY IF EXISTS <prefix>_select ...` naming the foundation
   * migrations already use, which is safe to re-run. `orders` and
   * `order_lines` intentionally share `sales_part` (as their own foundation
   * migration's DO block already does): policy names only need to be unique
   * WITHIN one table, and each partition is its own table. */
  readonly policyNamePrefix: string;
}

export const PARTITIONED_TABLES: readonly PartitionedTableConfig[] = [
  {
    schema: 'inventory',
    table: 'stock_movements',
    partitionKeyColumn: 'occurred_at',
    rlsShape: 'append_only',
    policyNamePrefix: 'stock_movements_part',
  },
  {
    schema: 'sales',
    table: 'orders',
    partitionKeyColumn: 'business_day',
    rlsShape: 'full_dml',
    policyNamePrefix: 'sales_part',
  },
  {
    schema: 'sales',
    table: 'order_lines',
    partitionKeyColumn: 'business_day',
    rlsShape: 'full_dml',
    policyNamePrefix: 'sales_part',
  },
] as const;

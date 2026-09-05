/**
 * Sales PUBLIC contract — B1-3 resource-derived authorization targets.
 *
 * `sales.orders` is a partitioned table keyed by `(tenant_id, id, business_day)`,
 * so both path segments are needed to identify one row without scanning every
 * partition. `orders.branch_id` is the order's real owning branch and is
 * covered by `uq_orders_tenant_id_business_day_branch`.
 */
export const SALES_ORDER_TARGET_RESOLVER = Symbol(
  'SALES_ORDER_TARGET_RESOLVER',
);

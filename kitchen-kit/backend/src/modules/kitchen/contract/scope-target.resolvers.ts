/**
 * Kitchen PUBLIC contract — B1-3 resource-derived authorization targets.
 *
 * KDS line/ticket operations address a ticket by its own id. `kitchen.tickets`
 * carries `branch_id` under a partition-safe composite FK back to the order
 * (`(tenant_id, order_id, business_day, branch_id)`), which is what proves the
 * branch on the ticket is genuinely the order's branch and not a copy that can
 * drift.
 */
export const KDS_TICKET_TARGET_RESOLVER = Symbol('KDS_TICKET_TARGET_RESOLVER');

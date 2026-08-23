import { PermissionDef } from '../identity/authz/permissions.constants';

/**
 * Sales permission codes — taken VERBATIM from the SRS §15.2 catalogue.
 *
 * `pos.order.create` is quoted there as "Create and modify orders", and
 * `pos.order.void_line_prefire` as "Void a line before firing". No code is
 * invented: the same zero-invented-codes discipline D-17-06 imposed on
 * Production Spec applies here, and every route below names an SRS code.
 *
 * `pos.order.void_line_postfire` exists in the catalogue and is deliberately
 * NOT used: no route performs a post-fire void, because Clarification C makes it
 * a privileged operation and no ratified rule defines its approval semantics.
 *
 * ── WHY READS ALSO USE `pos.order.create` ───────────────────────────────────
 * §15.2 defines no `pos.order.read`. Inventing one would break the discipline;
 * leaving reads unguarded would be worse. The catalogue entry is "Create and
 * MODIFY orders", and a terminal cannot modify an order it may not read — the
 * If-Match/ETag flow requires fetching the current version first. Reads
 * therefore sit behind the same capability, and no route grants visibility that
 * `pos.order.create` does not already imply.
 *
 * Authorization is TENANT-scoped. D-2's branch-scoped RBAC deferral stands: no
 * handler consults `TenantContext.branchId`. Branch safety on these routes comes
 * from the terminal binding and the employee's permitted-branch set, which are
 * FR-SEC-021 facts rather than RBAC scoping.
 */
export const SALES_PERMISSIONS = {
  ORDER_CREATE: 'pos.order.create',
  /**
   * SRS 15.2 verbatim: "Void a line before firing". Kept SEPARATE from
   * `pos.order.void_line_postfire`, which the catalogue also defines and this
   * release does NOT implement. Collapsing the two into one code would hand a
   * cashier the post-fire authority Clarification C withholds.
   */
  ORDER_VOID_LINE_PREFIRE: 'pos.order.void_line_prefire',
} as const;

export const SALES_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: SALES_PERMISSIONS.ORDER_CREATE,
    module: 'pos',
    description: 'Create and modify orders',
  },
  {
    code: SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE,
    module: 'pos',
    description: 'Void a line before firing',
  },
];

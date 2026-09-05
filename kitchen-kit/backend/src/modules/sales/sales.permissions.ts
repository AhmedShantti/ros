import { PermissionDef } from '../identity/authz/permissions.constants';

/**
 * Sales permission codes — taken VERBATIM from the SRS §15.2 catalogue,
 * except `ORDER_FIRE` (see its own doc comment).
 *
 * `pos.order.create` is quoted there as "Create and modify orders", and
 * `pos.order.void_line_prefire` as "Void a line before firing". No code is
 * invented from thin air: the same zero-invented-codes discipline D-17-06
 * imposed on Production Spec applies here, and every route below names an
 * SRS code or an explicitly governance-ratified one.
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
  /**
   * P1E-6 — "Fire Authorization Ratification — 2026-08-24"
   * (`docs/governance/GOVERNANCE_DECISION_REGISTER.md`). SRS §15.2's
   * catalogue names no distinct Fire permission; `pos.order.create` covers
   * pre-fire capture/correction only (CARRIED ITEM P1C-4) and does NOT imply
   * authority to fire. The ratification introduces this code explicitly so
   * UC-POS-01 step 6 / FR-POS-035's explicit Fire action has a permission of
   * its own, separate from `pos.order.create`.
   */
  ORDER_FIRE: 'pos.order.fire',
  /**
   * P1F-1 — CARRIED ITEM P1D-F
   * (`docs/governance/GOVERNANCE_DECISION_REGISTER.md`). SRS §15.2's Sales
   * list contains no payment verb at all, so — unlike every other code in
   * this file — this one is a NEW code created by explicit user
   * authorisation, the one recorded exception to the zero-invented-codes
   * discipline. Deliberately separate from `pos.order.create` so a tenant
   * may grant order entry without granting payment capture. Does NOT
   * authorise refunds, different-tender refunds, voids, price overrides,
   * CashSession management, or approvals.
   */
  PAYMENT_CAPTURE: 'pos.payment.capture',

  // ── POS-FIN-1 — SRS §15.2 verbatim, previously named but unused ─────────
  // (design gate §1: `discount|refund|comp\.|cancel` matched zero routes
  // before this slice). Adding these completes the same "taken VERBATIM
  // from the SRS §15.2 catalogue" discipline this file's own docblock
  // states — it does not invent a new code.
  /** SRS §15.2: "Apply discounts within limits". */
  DISCOUNT_APPLY: 'pos.discount.apply',
  /** SRS §15.2: "Approve discounts above limits". Also reused as the one
   *  generic manager-override permission for refund approval (FR-POS-073) —
   *  the catalogue names no distinct refund-approve code, and inventing one
   *  is forbidden; this is the closest literal "approve a financial
   *  threshold" authority the catalogue provides. */
  DISCOUNT_APPROVE: 'pos.discount.approve',
  /** SRS §15.2: "Apply discounts without limit" — the one per-actor
   *  threshold override this slice implements for FR-POS-047. */
  DISCOUNT_UNLIMITED: 'pos.discount.unlimited',
  /** SRS §15.2: "Give complimentary items" (FR-POS-050). */
  COMP_APPLY: 'pos.comp.apply',
  /** SRS §15.2: "Void a line after firing". Named in this file's own P1E-6
   *  doc comment above as deliberately not yet declared/used; this slice is
   *  the first to declare and use it (FR-POS-070/071). */
  ORDER_VOID_LINE_POSTFIRE: 'pos.order.void_line_postfire',
  /** SRS §15.2: "Issue a refund" (FR-POS-072/073). */
  REFUND_ISSUE: 'pos.refund.issue',
  /** SRS §15.2: "Refund to a tender other than the original" (FR-POS-074). */
  REFUND_DIFFERENT_TENDER: 'pos.refund.different_tender',
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
  {
    code: SALES_PERMISSIONS.ORDER_FIRE,
    module: 'pos',
    description: 'Fire pending order lines to production',
  },
  {
    code: SALES_PERMISSIONS.PAYMENT_CAPTURE,
    module: 'pos',
    description: 'Capture an ordinary POS customer payment',
  },
  {
    code: SALES_PERMISSIONS.DISCOUNT_APPLY,
    module: 'pos',
    description: 'Apply discounts within limits',
  },
  {
    code: SALES_PERMISSIONS.DISCOUNT_APPROVE,
    module: 'pos',
    description: 'Approve discounts above limits',
  },
  {
    code: SALES_PERMISSIONS.DISCOUNT_UNLIMITED,
    module: 'pos',
    description: 'Apply discounts without limit',
  },
  {
    code: SALES_PERMISSIONS.COMP_APPLY,
    module: 'pos',
    description: 'Give complimentary items',
  },
  {
    code: SALES_PERMISSIONS.ORDER_VOID_LINE_POSTFIRE,
    module: 'pos',
    description: 'Void a line after firing',
  },
  {
    code: SALES_PERMISSIONS.REFUND_ISSUE,
    module: 'pos',
    description: 'Issue a refund',
  },
  {
    code: SALES_PERMISSIONS.REFUND_DIFFERENT_TENDER,
    module: 'pos',
    description: 'Refund to a tender other than the original',
  },
];

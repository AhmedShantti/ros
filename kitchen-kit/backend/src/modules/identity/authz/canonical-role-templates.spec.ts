import { KDS_PERMISSIONS } from '../../kitchen/contract';
import { SALES_PERMISSIONS } from '../../sales/contract';
import { CANONICAL_ROLE_TEMPLATES } from './canonical-role-templates';

/**
 * GOLDEN-PATH-BACKEND-CLOSURE (2026-09-07) — regression coverage for the
 * refund-permission canonical-role gap identified by the consolidated
 * 27-step demo golden-path audit (step 23): `pos.refund.issue` was absent
 * from every staff canonical role template, making the real, fully-wired
 * refund flow unusable by any non-Owner actor. No prior spec asserted the
 * canonical templates' permission-code contents at all.
 */
describe('canonical role templates — refund permission separation', () => {
  it('Cashier can INITIATE a refund (pos.refund.issue)', () => {
    expect(
      CANONICAL_ROLE_TEMPLATES.cashier.permissionCodes,
    ).toContain(SALES_PERMISSIONS.REFUND_ISSUE);
  });

  it('Cashier does NOT get different-tender refund or manager-approval power (separation preserved)', () => {
    const codes = CANONICAL_ROLE_TEMPLATES.cashier.permissionCodes;
    expect(codes).not.toContain(SALES_PERMISSIONS.REFUND_DIFFERENT_TENDER);
    expect(codes).not.toContain(SALES_PERMISSIONS.DISCOUNT_APPROVE);
    expect(codes).not.toContain('treasury.cash_session.close_other');
  });

  it('Shift Supervisor inherits refund-issue from Cashier and separately holds manager approval, but still not different-tender', () => {
    const codes = CANONICAL_ROLE_TEMPLATES.shift_supervisor.permissionCodes;
    expect(codes).toContain(SALES_PERMISSIONS.REFUND_ISSUE);
    expect(codes).toContain(SALES_PERMISSIONS.DISCOUNT_APPROVE);
    expect(codes).not.toContain(SALES_PERMISSIONS.REFUND_DIFFERENT_TENDER);
  });

  it('Branch Manager template is unchanged by this fix (smallest-scope correction, no broadened grant)', () => {
    expect(
      CANONICAL_ROLE_TEMPLATES.branch_manager.permissionCodes,
    ).not.toContain(SALES_PERMISSIONS.REFUND_ISSUE);
  });

  it('Kitchen Staff remains EXACTLY kds.operate (KDS-R11 — must not be split by an unrelated change)', () => {
    expect(CANONICAL_ROLE_TEMPLATES.kitchen_staff.permissionCodes).toEqual([
      KDS_PERMISSIONS.OPERATE,
    ]);
  });
});

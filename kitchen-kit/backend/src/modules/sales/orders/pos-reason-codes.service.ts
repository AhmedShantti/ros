/**
 * DEMO-POS-REASON-CODES-BACKEND-P0 — the narrowest POS-safe read of
 * `inventory.reason_codes`.
 *
 * ── WHY NOT `GET /inventory/reason-codes` ────────────────────────────────
 * That route requires `inventory.view` (tenant-wide Inventory administration
 * visibility) — Cashier deliberately does not hold it, and granting it just
 * so POS could populate a reason-code picker would hand a cashier the whole
 * Inventory read surface for one unrelated need. This route instead
 * authorises against the SAME real, action-specific permission each mutation
 * already requires (`pos.discount.apply`, `pos.comp.apply`,
 * `pos.refund.issue`, `pos.order.void_line_prefire`,
 * `pos.order.void_line_postfire`) — no new permission is invented.
 *
 * ── WHY `purpose` GATES AUTHORIZATION, NOT ROW FILTERING ─────────────────
 * `fiscal... inventory.reason_codes.category` is a free-text, admin-supplied
 * VARCHAR(16) (`CreateReasonCodeDto.category`) with no enum and no
 * Sales-purpose vocabulary. Traced across every real caller — `discounts
 * .service.ts`'s `requireReasonCode` (line + order discount + comp),
 * `refunds.service.ts`, `post-fire-void.service.ts`, and
 * `order-lines.service.ts`'s pre-fire void — NONE filter by `category`; each
 * only proves the id exists AND is visible to the tenant (RLS). Every
 * existing e2e fixture that seeds a Sales-purpose reason code
 * (`pos-financial-corrections.e2e-spec.ts`, `sales-lines.e2e-spec.ts`) tags
 * it `category: 'adjustment'` — the SAME category, reused identically for
 * discount, comp, refund and void. The model therefore GENUINELY has no
 * purpose distinction, and the exposure IS equivalent: an actor authorised
 * for any one of these five actions could already submit ANY existing
 * tenant reason code id to that action. Given that, `purpose` exists to gate
 * WHICH real permission the caller must hold (least privilege, and forward
 * compatible if a future pack ever does distinguish purposes) — not to
 * filter which rows come back, which would invent a distinction the data
 * does not carry and could hide a legitimately-usable reason code.
 *
 * `category: 'waste'` rows (the ONLY other value ever used — exclusively by
 * `WasteRecord`, never by Sales) ARE excluded from this response: unlike the
 * four Sales-used purposes, waste genuinely is a different, Inventory-only
 * concept, and showing "Spoiled / discarded" on a refund screen would be
 * exactly the "unrelated adjustment configuration" the mission asks not to
 * expose. This is a READ-side narrowing only — it does not change what any
 * mutation accepts, so it can never make the read MORE permissive than a
 * write.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { SCOPE_AUTHORIZATION } from '../../identity/contract';
import type {
  RequestAuthorization,
  ScopeAuthorizationPort,
} from '../../identity/contract';
import { PosReasonCodePurpose } from '../sales.dto';
import { SALES_PERMISSIONS } from '../sales.permissions';

export interface PosReasonCode {
  readonly id: string;
  readonly code: string;
  readonly label: Record<string, unknown>;
}

const PURPOSE_PERMISSION: Record<PosReasonCodePurpose, string> = {
  discount: SALES_PERMISSIONS.DISCOUNT_APPLY,
  comp: SALES_PERMISSIONS.COMP_APPLY,
  refund: SALES_PERMISSIONS.REFUND_ISSUE,
  void_prefire: SALES_PERMISSIONS.ORDER_VOID_LINE_PREFIRE,
  void_postfire: SALES_PERMISSIONS.ORDER_VOID_LINE_POSTFIRE,
};

/** The route's own declarative gate — every code a `purpose` can require. */
export const POS_REASON_CODE_ANY_PERMISSION: string[] =
  Object.values(PURPOSE_PERMISSION);

@Injectable()
export class PosReasonCodesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SCOPE_AUTHORIZATION)
    private readonly scopeAuthorization: ScopeAuthorizationPort,
  ) {}

  async listForPurpose(
    authorization: RequestAuthorization,
    purpose: PosReasonCodePurpose,
  ): Promise<readonly PosReasonCode[]> {
    const required = PURPOSE_PERMISSION[purpose];
    const tenantId = authorization.context.tenantId;
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      // A SECOND, purpose-specific decision beyond the route's coarse
      // `RequireAnyPermission` gate — the same `assertCloseAuthority`/
      // refund-different-tender precedent (`ScopeAuthorizationPort`, checked
      // in-transaction). Tenant-scoped: `ReasonCode` carries no branch.
      await this.scopeAuthorization.assertAuthorized(
        authorization,
        { codes: [required], mode: 'all' },
        { type: 'tenant' },
        tx,
      );
      const rows = await tx.reasonCode.findMany({
        where: { category: { not: 'waste' } },
        orderBy: { code: 'asc' },
        select: { id: true, code: true, label: true },
      });
      return rows.map((row) => ({
        id: row.id,
        code: row.code,
        label: row.label as Record<string, unknown>,
      }));
    });
  }
}

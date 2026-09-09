import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { BRANCH_BRAND_QUERY } from '../organisation/contract';
import type { BranchBrandQuery } from '../organisation/contract';
import { TERMINAL_FACTS_QUERY } from '../identity/contract';
import type { TerminalFactsQuery } from '../identity/contract';
import type {
  RequestedSettingsScope,
  ResolvedSettingsScope,
} from './settings-hierarchy.types';

/**
 * FR-PLT-025 — "The resolver must not accept inconsistent hierarchy: terminal
 * belonging to another branch; branch belonging to another tenant; brand
 * outside tenant; branch/brand mismatch where hierarchy requires them to
 * match; cross-tenant ids. Fail closed."
 *
 * The ONLY place that validates and derives a settings request's scope.
 * Every id is checked through the OWNING module's published contract — never
 * a raw cross-module Prisma read — and every check runs inside the caller's
 * own `tenantId` RLS transaction, so a foreign-tenant id is simply invisible
 * (the same fail-closed shape `AuthorizationTargetResolver` uses).
 */
@Injectable()
export class SettingsScopeService {
  constructor(
    @Inject(BRANCH_BRAND_QUERY)
    private readonly branchBrand: BranchBrandQuery,
    @Inject(TERMINAL_FACTS_QUERY)
    private readonly terminalFacts: TerminalFactsQuery,
  ) {}

  /**
   * Validates every supplied id and derives every implied parent.
   *
   * Precedence of derivation: `terminalId` (deepest) derives `branchId`,
   * which derives `brandId`. A caller-supplied id at a shallower level is
   * checked against the derived one and REJECTED on mismatch — it is never
   * silently overwritten, because a mismatch is exactly the "branch/brand
   * mismatch where hierarchy requires them to match" case FR-PLT-025 names.
   */
  async deriveScope(
    tx: Prisma.TransactionClient,
    tenantId: string,
    requested: Omit<RequestedSettingsScope, 'tenantId'>,
  ): Promise<ResolvedSettingsScope> {
    let branchId = requested.branchId ?? null;
    let brandId = requested.brandId ?? null;
    const terminalId = requested.terminalId ?? null;

    if (terminalId) {
      const terminal = await this.terminalFacts.getById(tx, terminalId);
      if (!terminal) {
        throw new NotFoundException('Terminal not found.');
      }
      if (branchId && branchId !== terminal.branchId) {
        throw new NotFoundException('terminalId does not belong to branchId.');
      }
      branchId = terminal.branchId;
    }

    if (branchId) {
      const branch = await this.branchBrand.findBranchAuthorizationFacts(
        tx,
        branchId,
      );
      if (!branch) {
        throw new NotFoundException('Branch not found.');
      }
      if (brandId && brandId !== branch.brandId) {
        throw new NotFoundException('branchId does not belong to brandId.');
      }
      brandId = branch.brandId;
    } else if (brandId) {
      const visible = await this.branchBrand.brandIsVisible(tx, brandId);
      if (!visible) {
        throw new NotFoundException('Brand not found.');
      }
    }

    return { tenantId, brandId, branchId, terminalId };
  }
}

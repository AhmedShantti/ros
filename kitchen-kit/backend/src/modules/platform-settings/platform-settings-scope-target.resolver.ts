import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import {
  TERMINAL_FACTS_QUERY,
  type ScopeTargetResolver,
  type ScopeTargetResolverInput,
  type TargetScope,
  type TerminalFactsQuery,
} from '../identity/contract';
import { BRANCH_BRAND_QUERY } from '../organisation/contract';
import type { BranchBrandQuery } from '../organisation/contract';

export const PLATFORM_SETTINGS_SCOPE_TARGET_RESOLVER = Symbol(
  'PLATFORM_SETTINGS_SCOPE_TARGET_RESOLVER',
);

/**
 * The `@AuthorizationTarget` resolver for the combined GET resolve/inspect
 * routes, which accept `brandId`/`branchId`/`terminalId` as independent,
 * mutually-narrowing OPTIONAL query params (SRS §6.4's request shape: "an
 * optional brandId, optional branchId, optional terminalId"). Picks the
 * DEEPEST supplied id — terminal, else branch, else brand — and derives its
 * real owning scope exactly the way `SettingsScopeService.deriveScope` does
 * for a write, so a read's authorization target and a write's hierarchy
 * validation never disagree about what a supplied id means.
 *
 * There is no "terminal" `TargetScope` in the RBAC lattice (`authz/scope.ts`
 * — only tenant/brand/branch): a terminal-scoped read is authorized at the
 * BRANCH its terminal belongs to, the same posture
 * `IDENTITY_TERMINAL_TARGET_RESOLVER` already uses for Identity's own
 * terminal-addressed routes.
 */
@Injectable()
export class PlatformSettingsScopeTargetResolver implements ScopeTargetResolver {
  constructor(
    @Inject(TERMINAL_FACTS_QUERY)
    private readonly terminalFacts: TerminalFactsQuery,
    @Inject(BRANCH_BRAND_QUERY)
    private readonly branchBrand: BranchBrandQuery,
  ) {}

  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const terminalId = input.keys.terminalId;
    const brandId = input.keys.brandId;
    let branchId = input.keys.branchId;

    if (terminalId) {
      const terminal = await this.terminalFacts.getById(tx, terminalId);
      if (!terminal) return null;
      if (branchId && branchId !== terminal.branchId) return null;
      branchId = terminal.branchId;
    }

    if (branchId) {
      const facts = await this.branchBrand.findBranchAuthorizationFacts(
        tx,
        branchId,
      );
      if (!facts) return null;
      if (brandId && brandId !== facts.brandId) return null;
      return { type: 'branch', branchId, brandId: facts.brandId };
    }

    if (brandId) {
      const visible = await this.branchBrand.brandIsVisible(tx, brandId);
      if (!visible) return null;
      return { type: 'brand', brandId };
    }

    return { type: 'tenant' };
  }
}

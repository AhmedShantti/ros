import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BranchJurisdictionUnknownError,
  CountryPackService,
} from '../country-pack/country-pack.service';
import { CountryPackUnavailableError } from '../country-pack/country-pack.registry';
import type {
  ResolveSellableTaxClassInput,
  SellableTaxClass,
  SellableTaxClassesForBranchInput,
  SellableTaxClassesQuery,
} from '../contract/sellable-tax-classes.query';
import { TaxClassService } from './tax-class.service';

/**
 * PRIVATE adapter implementing `SellableTaxClassesQuery`
 * (`localisation/contract/sellable-tax-classes.query.ts`).
 *
 * Bound to `SELLABLE_TAX_CLASSES_QUERY` only inside `LocalisationModule` —
 * never imported directly by a consumer. Delegates entirely to the existing
 * `CountryPackService`/`TaxClassService` — no new pack-resolution or
 * provisioning logic here, only the read/validate narrowing Catalogue needs.
 */
@Injectable()
export class SellableTaxClassesQueryService implements SellableTaxClassesQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly countryPacks: CountryPackService,
    private readonly taxClasses: TaxClassService,
  ) {}

  async listSellableForBranch(
    input: SellableTaxClassesForBranchInput,
  ): Promise<readonly SellableTaxClass[]> {
    const pack = await this.resolvePackForBranch(
      input.tenantId,
      input.branchId,
    );
    const rows = await this.prisma.withAuthContext(
      { tenantId: input.tenantId },
      (tx) => this.taxClasses.listForPackCode(tx, input.tenantId, pack.code),
    );
    return rows
      .filter((row) => row.isActive)
      .map((row) => ({
        id: row.id,
        code: row.code,
        names: row.names as Record<string, string>,
      }));
  }

  async resolveSellable(
    input: ResolveSellableTaxClassInput,
  ): Promise<SellableTaxClass | null> {
    const row = await this.prisma.withAuthContext(
      { tenantId: input.tenantId },
      (tx) =>
        tx.taxClass.findFirst({
          where: { tenantId: input.tenantId, id: input.taxClassId },
          select: { id: true, code: true, names: true, isActive: true },
        }),
    );
    if (!row || !row.isActive) return null;
    return { id: row.id, code: row.code, names: row.names as Record<string, string> };
  }

  private async resolvePackForBranch(tenantId: string, branchId: string) {
    try {
      return await this.countryPacks.resolveForBranch(
        tenantId,
        branchId,
        new Date(),
      );
    } catch (error) {
      if (error instanceof BranchJurisdictionUnknownError) {
        throw new NotFoundException('Branch not found.');
      }
      if (error instanceof CountryPackUnavailableError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }
}

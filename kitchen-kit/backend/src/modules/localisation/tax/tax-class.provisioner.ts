import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CountryPackService } from '../country-pack/country-pack.service';
import { TAX_CLASS_PROVISIONER, TaxClassProvisioner } from './tax-class.port';
import { TaxClassService } from './tax-class.service';

/**
 * Materialise a tenant's TaxClass identities from the pack in force for its
 * jurisdiction.
 *
 * Runs at the moment the jurisdiction is assigned rather than at every sale:
 * creating identities lazily during a checkout would make the first sale of the
 * day slower than the rest and would race two terminals into duplicate rows.
 * The unique index would catch the race, but the right answer is not to run it.
 *
 * `resolveEffective`, not `requireEffective`: a tenant whose pack is not
 * activated yet is created without tax classes, and its items are simply not
 * sellable until one is. Refusing to create the tenant would be worse and is not
 * something any source requires.
 */
@Injectable()
export class TaxClassProvisioningService implements TaxClassProvisioner {
  private readonly logger = new Logger(TaxClassProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly packs: CountryPackService,
    private readonly taxClasses: TaxClassService,
  ) {}

  async provisionForTenant(
    tenantId: string,
    countryPackCode: string,
  ): Promise<number> {
    const pack = this.packs.registry.resolveEffective(
      countryPackCode,
      new Date(),
    );
    if (!pack) {
      this.logger.warn(
        `Tenant ${tenantId}: no activated country pack for ${countryPackCode}; ` +
          'no tax class identity was provisioned and its items are not sellable ' +
          'until one is.',
      );
      return 0;
    }
    const ids = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      this.taxClasses.ensureFromPack(tx, tenantId, pack),
    );
    this.taxClasses.logProvisioned(tenantId, pack.code, ids.size);
    return ids.size;
  }
}

export { TAX_CLASS_PROVISIONER };

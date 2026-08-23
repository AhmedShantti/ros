import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Tenant, TenantStatus } from '../../../generated/prisma/client';
import { TAX_CLASS_PROVISIONER } from '../../localisation/tax/tax-class.port';
import type { TaxClassProvisioner } from '../../localisation/tax/tax-class.port';
import { PrismaService } from '../../../prisma/prisma.service';

export interface CreateTenantInput {
  slug: string;
  legalName: string;
  defaultCurrency: string;
  countryPackCode: string;
  defaultLocale?: string;
  ownerUserId?: string;
  status?: TenantStatus;
}

/**
 * Tenant reads/writes. Tenant provisioning is an administrative/bootstrap
 * operation (no public self-serve endpoint in the Identity context).
 */
@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TAX_CLASS_PROVISIONER)
    private readonly taxClasses: TaxClassProvisioner,
  ) {}

  /**
   * `country_pack_code` is the tenant's jurisdiction assignment, so this is the
   * point at which its TaxClass identities (C-04 AMENDMENT) should exist.
   *
   * Provisioning is best-effort and deliberately NOT inside the tenant insert:
   * a tenant whose pack is not activated yet must still be creatable. Its menu
   * items then carry no tax class and line capture refuses them, which is the
   * correct outcome rather than a silent default.
   */
  async create(input: CreateTenantInput): Promise<Tenant> {
    const tenant = await this.prisma.tenant.create({
      data: {
        id: newId(),
        slug: input.slug,
        legalName: input.legalName,
        defaultCurrency: input.defaultCurrency,
        countryPackCode: input.countryPackCode,
        defaultLocale: input.defaultLocale ?? 'ar',
        ownerUserId: input.ownerUserId ?? null,
        status: input.status ?? 'active',
      },
    });
    try {
      await this.taxClasses.provisionForTenant(
        tenant.id,
        tenant.countryPackCode,
      );
    } catch (error) {
      this.logger.error(
        `Tenant ${tenant.id} was created but its tax class identities could not ` +
          `be provisioned: ${(error as Error).message}`,
      );
    }
    return tenant;
  }

  findById(id: string): Promise<Tenant | null> {
    return this.prisma.tenant.findUnique({ where: { id } });
  }

  setStatus(id: string, status: TenantStatus): Promise<Tenant> {
    return this.prisma.tenant.update({ where: { id }, data: { status } });
  }
}

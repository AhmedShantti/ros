import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Tenant, TenantStatus } from '../../../generated/prisma/client';
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
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateTenantInput): Promise<Tenant> {
    return this.prisma.tenant.create({
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
  }

  findById(id: string): Promise<Tenant | null> {
    return this.prisma.tenant.findUnique({ where: { id } });
  }

  setStatus(id: string, status: TenantStatus): Promise<Tenant> {
    return this.prisma.tenant.update({ where: { id }, data: { status } });
  }
}

import { Tenant, TenantStatus } from '../../../generated/prisma/client';

export interface TenantSummary {
  id: string;
  slug: string;
  legalName: string;
  status: TenantStatus;
  defaultCurrency: string;
  defaultLocale: string;
}

export function toTenantSummary(tenant: Tenant): TenantSummary {
  return {
    id: tenant.id,
    slug: tenant.slug,
    legalName: tenant.legalName,
    status: tenant.status,
    defaultCurrency: tenant.defaultCurrency,
    defaultLocale: tenant.defaultLocale,
  };
}

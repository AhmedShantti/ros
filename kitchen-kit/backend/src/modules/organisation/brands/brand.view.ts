import { Brand } from '../../../generated/prisma/client';

export interface BrandSummary {
  id: string;
  name: string;
  theme: unknown;
  defaultSettings: unknown;
  createdAt: Date;
}

/** tenantId is deliberately not exposed: it is server-derived, never client data. */
export function toBrandSummary(brand: Brand): BrandSummary {
  return {
    id: brand.id,
    name: brand.name,
    theme: brand.theme,
    defaultSettings: brand.defaultSettings,
    createdAt: brand.createdAt,
  };
}

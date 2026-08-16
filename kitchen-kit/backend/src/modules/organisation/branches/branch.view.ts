import { Branch, BranchStatus } from '../../../generated/prisma/client';

export interface BranchSummary {
  id: string;
  brandId: string;
  code: string;
  name: string;
  timezone: string;
  baseCurrency: string;
  countryCode: string;
  address: unknown;
  status: BranchStatus;
  automaticAvailability: boolean;
  createdAt: Date;
}

export function toBranchSummary(branch: Branch): BranchSummary {
  return {
    id: branch.id,
    brandId: branch.brandId,
    code: branch.code,
    name: branch.name,
    timezone: branch.timezone,
    baseCurrency: branch.baseCurrency,
    countryCode: branch.countryCode,
    address: branch.address,
    status: branch.status,
    automaticAvailability: branch.automaticAvailability,
    createdAt: branch.createdAt,
  };
}

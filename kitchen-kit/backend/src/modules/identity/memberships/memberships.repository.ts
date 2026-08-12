import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import {
  Membership,
  MembershipStatus,
  Prisma,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export type MembershipWithTenant = Prisma.MembershipGetPayload<{
  include: { tenant: true };
}>;

@Injectable()
export class MembershipsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByIdWithTenant(id: string): Promise<MembershipWithTenant | null> {
    return this.prisma.membership.findUnique({
      where: { id },
      include: { tenant: true },
    });
  }

  /** Selectable = active membership whose tenant is also active. */
  listSelectableByUser(userId: string): Promise<MembershipWithTenant[]> {
    return this.prisma.membership.findMany({
      where: { userId, status: 'active', tenant: { status: 'active' } },
      include: { tenant: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  create(input: {
    userId: string;
    tenantId: string;
    status?: MembershipStatus;
  }): Promise<Membership> {
    return this.prisma.membership.create({
      data: {
        id: newId(),
        userId: input.userId,
        tenantId: input.tenantId,
        status: input.status ?? 'active',
      },
    });
  }

  setStatus(id: string, status: MembershipStatus): Promise<Membership> {
    return this.prisma.membership.update({ where: { id }, data: { status } });
  }
}

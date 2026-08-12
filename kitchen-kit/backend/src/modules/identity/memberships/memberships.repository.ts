import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import {
  Membership,
  MembershipStatus,
  Prisma,
} from '../../../generated/prisma/client';

export type MembershipWithTenant = Prisma.MembershipGetPayload<{
  include: { tenant: true };
}>;

/**
 * Data access for memberships. Every method takes the transaction client of an
 * open `withAuthContext` scope so the query runs under the RLS tenant/user
 * context (memberships is RLS-protected).
 */
@Injectable()
export class MembershipsRepository {
  findByIdWithTenant(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<MembershipWithTenant | null> {
    return tx.membership.findUnique({
      where: { id },
      include: { tenant: true },
    });
  }

  /** Selectable = active membership whose tenant is also active. */
  listSelectableByUser(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<MembershipWithTenant[]> {
    return tx.membership.findMany({
      where: { userId, status: 'active', tenant: { status: 'active' } },
      include: { tenant: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  create(
    tx: Prisma.TransactionClient,
    input: { userId: string; tenantId: string; status?: MembershipStatus },
  ): Promise<Membership> {
    return tx.membership.create({
      data: {
        id: newId(),
        userId: input.userId,
        tenantId: input.tenantId,
        status: input.status ?? 'active',
      },
    });
  }

  setStatus(
    tx: Prisma.TransactionClient,
    id: string,
    status: MembershipStatus,
  ): Promise<Membership> {
    return tx.membership.update({ where: { id }, data: { status } });
  }
}

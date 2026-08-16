import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

/**
 * Resolve a branch inside the caller's already-established RLS context.
 *
 * Branch-owned Organisation rows (stations, tables, operating hours, print
 * routing, station routing rules) carry no tenant_id — the approved design — so
 * their tenant boundary is the parent branch. A branch belonging to another
 * tenant is invisible under RLS, so this yields 404 rather than 403 and a
 * foreign branch id cannot be probed for existence.
 *
 * MUST be called inside `PrismaService.withAuthContext`.
 */
export async function assertBranchInScope(
  tx: Prisma.TransactionClient,
  branchId: string,
): Promise<void> {
  const branch = await tx.branch.findUnique({
    where: { id: branchId },
    select: { id: true },
  });
  if (!branch) {
    throw new NotFoundException('Branch not found.');
  }
}

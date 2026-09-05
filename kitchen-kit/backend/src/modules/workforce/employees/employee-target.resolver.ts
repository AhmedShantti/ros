import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
  TargetScope,
} from '../../identity/contract';

/** PRIVATE implementation of `WORKFORCE_EMPLOYEE_TARGET_RESOLVER`. */
@Injectable()
export class EmployeeTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const employeeId = input.keys.employeeId;
    if (!employeeId) return null;
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { homeBranchId: true },
    });
    return employee
      ? { type: 'branch', branchId: employee.homeBranchId }
      : null;
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { CredentialsService } from '../credentials/credentials.service';
import type {
  TerminalPinVerifier,
  VerifiedTerminalPrincipal,
  VerifyTerminalPinInput,
} from '../contract/pin-verification.contract';

/** FR-SEC-020: "a 4–8 digit PIN". */
const PIN_PATTERN = /^\d{4,8}$/;

export interface PinAuthResult {
  employeeId: string;
  userId: string;
  branchId: string;
  terminalId: string;
  /**
   * The employee's ACTIVE membership in the tenant they signed in to.
   *
   * Authorization in ROS is resolved per request from a membership
   * (`TenantContextService`), so a POS session that carried no membership could
   * not satisfy a single permission-guarded route — FR-SEC-020's PIN session
   * would authenticate and then be able to do nothing. Resolving it here keeps
   * the token's claims server-derived and leaves the D-2 deferral untouched:
   * the permissions are the same TENANT-scoped set a dashboard session gets, and
   * FR-SEC-021's dashboard exclusion is enforced separately by the `pos` session
   * audience.
   */
  membershipId: string;
}

/**
 * PIN authentication — FR-SEC-020 / FR-SEC-021 / FR-SEC-022, authorised by the
 * D-2 amendment.
 *
 * ── STORAGE (FR-SEC-022) ────────────────────────────────────────────────────
 * The PIN reuses the existing `identity.credentials` row with
 * `credential_type = 'pin'`, hashed by the same Argon2id path as passwords. No
 * second credential system is introduced, no plaintext or reversible PIN is
 * stored, and no deterministic digest is added merely to make a UNIQUE index
 * possible.
 *
 * ── BRANCH UNIQUENESS (FR-SEC-022) ──────────────────────────────────────────
 * "PINs SHALL be unique within a branch." Argon2 hashes are salted, so equality
 * comparison is impossible by construction and a UNIQUE index cannot express
 * this. Uniqueness is therefore verified in the application: the candidate PIN
 * is checked against the PIN of every other employee reachable in the branches
 * concerned. To keep that safe under concurrency, the check and the write run
 * inside one transaction holding a per-tenant advisory lock — the same
 * `pg_advisory_xact_lock` pattern `AuditService` already uses for its chain.
 *
 * ── LOCKOUT (FR-SEC-022) ────────────────────────────────────────────────────
 * The threshold is configurable. FR-SEC-022 does not state a number, so none is
 * invented as a requirement: the value comes from configuration, and the
 * repository's existing explicit-default convention (as used by
 * `AUTH_THROTTLE_LIMIT`) supplies an IMPLEMENTATION-level default that is
 * documented in `env.validation.ts` rather than hidden here. Counter and lock
 * expiry are persisted on the credential row, so a lockout survives request and
 * process boundaries.
 */
@Injectable()
export class PinService implements TerminalPinVerifier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private get maxFailedAttempts(): number {
    return this.config.getOrThrow<number>('PIN_MAX_FAILED_ATTEMPTS');
  }

  private get lockoutMs(): number {
    return this.config.getOrThrow<number>('PIN_LOCKOUT_MS');
  }

  private assertPinShape(pin: string): void {
    if (!PIN_PATTERN.test(pin)) {
      // Never echo the PIN itself.
      throw new BadRequestException('PIN must be 4 to 8 digits.');
    }
  }

  /** Serialise PIN mutation per tenant so two writers cannot both pass the check. */
  private async lockTenant(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      'ros_pin',
      tenantId,
    );
  }

  /**
   * Reject the candidate PIN if any OTHER employee reachable in `branchIds`
   * already uses it (FR-SEC-022 branch uniqueness).
   */
  private async assertUniqueInBranches(
    tx: Prisma.TransactionClient,
    employeeId: string,
    branchIds: readonly string[],
    pin: string,
  ): Promise<void> {
    if (branchIds.length === 0) return;

    const neighbours = await tx.employeeBranch.findMany({
      where: {
        branchId: { in: [...branchIds] },
        employeeId: { not: employeeId },
      },
      select: { employeeId: true, branchId: true },
    });
    if (neighbours.length === 0) return;

    const employees = await tx.employee.findMany({
      where: { id: { in: neighbours.map((n) => n.employeeId) } },
      select: { id: true, userId: true },
    });
    const userIds = employees
      .map((e) => e.userId)
      .filter((u): u is string => u !== null);
    if (userIds.length === 0) return;

    const creds = await tx.credential.findMany({
      where: { userId: { in: userIds }, credentialType: 'pin' },
      select: { userId: true, secretHash: true },
    });

    for (const cred of creds) {
      const clash = await this.credentials.verifyPasswordSafe(
        cred.secretHash,
        pin,
      );
      if (clash) {
        const owner = employees.find((e) => e.userId === cred.userId);
        const branch = neighbours.find((n) => n.employeeId === owner?.id);
        throw new ConflictException(
          `That PIN is already in use in branch ${branch?.branchId ?? 'this branch'}. ` +
            'FR-SEC-022 requires PINs to be unique within a branch.',
        );
      }
    }
  }

  /**
   * Validator for `EmployeesService.addPermittedBranch` — adding a branch must
   * not create a duplicate in the newly reachable branch.
   */
  assertPinStillUniqueOnBranchAdd = async (
    tx: Prisma.TransactionClient,
    employeeId: string,
    branchIds: string[],
  ): Promise<void> => {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { userId: true },
    });
    if (!employee?.userId) return; // no login ⇒ no PIN ⇒ nothing to collide

    const cred = await tx.credential.findUnique({
      where: {
        userId_credentialType: {
          userId: employee.userId,
          credentialType: 'pin',
        },
      },
      select: { secretHash: true },
    });
    if (!cred) return;

    // The stored hash cannot be reversed, so uniqueness is checked from the
    // other side: does any neighbour's PIN verify against THIS employee's hash?
    const neighbours = await tx.employeeBranch.findMany({
      where: { branchId: { in: branchIds }, employeeId: { not: employeeId } },
      select: { employeeId: true },
    });
    if (neighbours.length === 0) return;

    throw new ConflictException(
      'Adding this branch cannot be verified as PIN-unique because stored PINs ' +
        'are salted hashes and cannot be compared. Re-set this employee’s PIN ' +
        'after adding the branch, which re-runs the FR-SEC-022 uniqueness check.',
    );
  };

  /** Set or rotate an employee's PIN. */
  async setPin(
    tenantId: string,
    actorId: string,
    employeeId: string,
    pin: string,
  ): Promise<void> {
    this.assertPinShape(pin);

    await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        await this.lockTenant(tx, tenantId);

        const employee = await tx.employee.findUnique({
          where: { id: employeeId },
          select: {
            id: true,
            userId: true,
            branches: { select: { branchId: true } },
          },
        });
        if (!employee) {
          throw new NotFoundException('Employee not found.');
        }
        if (!employee.userId) {
          throw new ConflictException(
            'This employee has no linked user, so no PIN credential can exist. ' +
              'SRS §14 permits an Employee with no User; such an employee simply ' +
              'cannot authenticate.',
          );
        }

        const branchIds = employee.branches.map((b) => b.branchId);
        await this.assertUniqueInBranches(tx, employeeId, branchIds, pin);

        const secretHash = await this.credentials.hashPassword(pin);
        await tx.credential.upsert({
          where: {
            userId_credentialType: {
              userId: employee.userId,
              credentialType: 'pin',
            },
          },
          create: {
            id: newId(),
            userId: employee.userId,
            credentialType: 'pin',
            secretHash,
            pinForTerminal: true,
          },
          update: {
            secretHash,
            pinForTerminal: true,
            rotatedAt: new Date(),
            failedAttempts: 0,
            lockedUntil: null,
          },
        });

        // Never place the PIN, or anything derived from it, in the audit payload.
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.PIN_SET,
          entityType: AUDIT_ENTITY.EMPLOYEE,
          actorType: 'user',
          actorId,
          entityId: employeeId,
          metadata: { branchCount: branchIds.length },
        });
      },
    );
  }

  /**
   * Authenticate a PIN at a terminal — the full FR-SEC-021 check.
   *
   * All three conditions are executable here: the terminal must be registered
   * and active, the terminal's branch must be one of the employee's permitted
   * branches, and the resulting session is POS-only (the caller stamps
   * `typ: 'pos'`, which `JwtAuthGuard` refuses on dashboard routes).
   */
  async authenticate(
    tenantId: string,
    terminalId: string,
    employeeCode: string,
    pin: string,
  ): Promise<PinAuthResult> {
    this.assertPinShape(pin);

    const result = await this.prisma.withAuthContext(
      { tenantId },
      async (tx) => {
        const terminal = await tx.terminal.findUnique({
          where: { id: terminalId },
          select: { id: true, branchId: true, status: true },
        });
        // FR-SEC-028: a revoked or unregistered terminal fails immediately.
        if (!terminal || terminal.status !== 'active') {
          throw new UnauthorizedException('Invalid PIN, terminal or employee.');
        }

        const employee = await tx.employee.findFirst({
          where: { code: employeeCode },
          select: {
            id: true,
            userId: true,
            status: true,
            branches: { select: { branchId: true } },
          },
        });
        if (!employee || employee.status !== 'active' || !employee.userId) {
          throw new UnauthorizedException('Invalid PIN, terminal or employee.');
        }

        // FR-SEC-021: only within the employee's permitted branches.
        const permitted = employee.branches.some(
          (b) => b.branchId === terminal.branchId,
        );
        if (!permitted) {
          throw new UnauthorizedException('Invalid PIN, terminal or employee.');
        }

        const cred = await tx.credential.findUnique({
          where: {
            userId_credentialType: {
              userId: employee.userId,
              credentialType: 'pin',
            },
          },
          select: {
            id: true,
            secretHash: true,
            failedAttempts: true,
            lockedUntil: true,
          },
        });
        if (!cred) {
          throw new UnauthorizedException('Invalid PIN, terminal or employee.');
        }

        // FR-SEC-022 lockout — a locked credential fails even with the right PIN.
        const now = new Date();
        if (cred.lockedUntil !== null && cred.lockedUntil > now) {
          throw new UnauthorizedException(
            'This PIN is temporarily locked after too many failed attempts.',
          );
        }

        const ok = await this.credentials.verifyPasswordSafe(
          cred.secretHash,
          pin,
        );
        if (!ok) {
          // The counter update must NOT ride on this transaction: throwing here
          // would roll it back and the lockout would never accumulate. Report the
          // failure to the caller instead, which persists it separately.
          return {
            outcome: 'bad_pin' as const,
            credentialId: cred.id,
            attempts: cred.failedAttempts,
          };
        }

        if (cred.failedAttempts !== 0 || cred.lockedUntil !== null) {
          await tx.credential.update({
            where: { id: cred.id },
            data: { failedAttempts: 0, lockedUntil: null },
          });
        }

        // The membership is what carries the permissions; without an active
        // one there is no authorization context and the session must not issue.
        const membership = await tx.membership.findUnique({
          where: {
            userId_tenantId: { userId: employee.userId, tenantId },
          },
          select: { id: true, status: true },
        });
        if (!membership || membership.status !== 'active') {
          throw new UnauthorizedException('Invalid PIN, terminal or employee.');
        }

        return {
          outcome: 'ok' as const,
          employeeId: employee.id,
          userId: employee.userId,
          branchId: terminal.branchId,
          terminalId: terminal.id,
          membershipId: membership.id,
        };
      },
    );

    if (result.outcome === 'bad_pin') {
      await this.recordFailure(result.credentialId, result.attempts);
      throw new UnauthorizedException('Invalid PIN, terminal or employee.');
    }

    return {
      employeeId: result.employeeId,
      userId: result.userId,
      branchId: result.branchId,
      terminalId: result.terminalId,
      membershipId: result.membershipId,
    };
  }

  /**
   * `TerminalPinVerifier.verifyTerminalPin` — Identity's first public
   * contract implementation (`contract/pin-verification.contract.ts`).
   *
   * Reuses {@link authenticate} verbatim for the entire verification path
   * (terminal, employee, branch, PIN hash, lockout, membership) — nothing is
   * duplicated. Adds exactly one further read: the SAME membership's
   * effective permission codes, via the identical membership -> role ->
   * permission shape `TenantContextService.resolve` uses, resolved in its
   * OWN transaction (never the caller's — see the contract's docblock on why
   * this must run before any consuming module's business transaction).
   *
   * The returned object is deliberately constructed via a cast: the brand
   * field on `VerifiedTerminalPrincipal` is an ambient `unique symbol` with
   * no runtime representation, so no plain object literal can satisfy the
   * interface structurally. `module-boundaries.spec.ts` confines this exact
   * cast pattern to `src/modules/identity/`.
   */
  async verifyTerminalPin(
    input: VerifyTerminalPinInput,
  ): Promise<VerifiedTerminalPrincipal> {
    const authResult = await this.authenticate(
      input.tenantId,
      input.terminalId,
      input.employeeCode,
      input.pin,
    );

    const membership = await this.prisma.withAuthContext(
      { userId: authResult.userId, tenantId: input.tenantId },
      (tx) =>
        tx.membership.findUniqueOrThrow({
          where: { id: authResult.membershipId },
          select: {
            membershipRoles: {
              where: {
                role: {
                  OR: [{ tenantId: input.tenantId }, { isSystem: true }],
                },
              },
              select: {
                role: {
                  select: {
                    rolePermissions: {
                      select: { permission: { select: { code: true } } },
                    },
                  },
                },
              },
            },
          },
        }),
    );

    const permissions = new Set<string>();
    for (const mr of membership.membershipRoles) {
      for (const rp of mr.role.rolePermissions) {
        permissions.add(rp.permission.code);
      }
    }

    return {
      userId: authResult.userId,
      employeeId: authResult.employeeId,
      membershipId: authResult.membershipId,
      branchId: authResult.branchId,
      terminalId: authResult.terminalId,
      permissions,
    } as unknown as VerifiedTerminalPrincipal;
  }

  /**
   * Persist a failed attempt in its own transaction, so the counter survives the
   * 401 that follows. At the configured threshold the credential is locked for
   * the configured window and the counter resets.
   */
  private async recordFailure(
    credentialId: string,
    previousAttempts: number,
  ): Promise<void> {
    const attempts = previousAttempts + 1;
    const lock = attempts >= this.maxFailedAttempts;
    await this.prisma.credential.update({
      where: { id: credentialId },
      data: {
        failedAttempts: lock ? 0 : attempts,
        lockedUntil: lock ? new Date(Date.now() + this.lockoutMs) : null,
      },
    });
  }
}

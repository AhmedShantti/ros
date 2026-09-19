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
  ApproverPinVerifier,
  VerifiedApproverPrincipal,
  VerifyApproverPinInput,
} from '../contract/pin-verification.contract';

/** FR-SEC-020: "a 4–8 digit PIN". */
const PIN_PATTERN = /^\d{4,8}$/;

export interface PinAuthResult {
  employeeId: string;
  userId: string;
  branchId: string;
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

/** One reachable neighbour's PIN credential — identity + hash, nothing more. */
interface NeighbourPinCredential {
  credentialId: string;
  userId: string;
  secretHash: string;
}

/**
 * A point-in-time FR-SEC-022 uniqueness snapshot: every OTHER employee's PIN
 * credential reachable in a given set of branches, plus enough
 * employee/branch shape to name the colliding branch in a conflict message.
 */
interface PinUniquenessSnapshot {
  neighbourEmployeeBranches: { employeeId: string; branchId: string }[];
  credentials: NeighbourPinCredential[];
  userIdToEmployeeId: Map<string, string>;
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
 * concerned.
 *
 * EMPLOYEE-PIN-SET-500-P0 (2026-09-19): that verification is O(N) sequential
 * Argon2id work (deliberately expensive — see `credentials.service.ts`). Doing
 * it inside a single Prisma interactive transaction (as originally written)
 * meant a branch with enough existing PIN holders could exceed Prisma's
 * default 5000ms interactive-transaction timeout, surfacing as an unhandled
 * `PrismaClientKnownRequestError` (P2028) — a 500, not a 409 — once N grew
 * large enough. `setPin` below is therefore split into three phases: a cheap
 * read-only snapshot, the expensive Argon2 verification with NO transaction
 * open, then a short atomic write transaction (still holding the same
 * per-tenant `pg_advisory_xact_lock` `AuditService`'s chain also uses) that
 * re-checks only what changed since the snapshot — identity + hash, never a
 * timestamp — before writing. See
 * `docs/reports/claude/2026-09-19_EMPLOYEE-PIN-SET-500-P0_investigation.md`.
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
export class PinService implements ApproverPinVerifier {
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
   * FR-SEC-022 branch-uniqueness snapshot — every OTHER employee's PIN
   * credential reachable in `branchIds`, plus enough employee/branch shape
   * to name the colliding branch in a conflict message. Pure reads, no
   * Argon2 work, no throw. Reused identically by Phase 1 (a fresh snapshot)
   * and Phase 3 (a fresh, CURRENT snapshot used to compute the delta).
   */
  private async snapshotBranchUniqueness(
    tx: Prisma.TransactionClient,
    employeeId: string,
    branchIds: readonly string[],
  ): Promise<PinUniquenessSnapshot> {
    const empty: PinUniquenessSnapshot = {
      neighbourEmployeeBranches: [],
      credentials: [],
      userIdToEmployeeId: new Map(),
    };
    if (branchIds.length === 0) return empty;

    const neighbourEmployeeBranches = await tx.employeeBranch.findMany({
      where: {
        branchId: { in: [...branchIds] },
        employeeId: { not: employeeId },
      },
      select: { employeeId: true, branchId: true },
    });
    if (neighbourEmployeeBranches.length === 0) return empty;

    const neighbourEmployeeIds = [
      ...new Set(neighbourEmployeeBranches.map((n) => n.employeeId)),
    ];
    const neighbourEmployees = await tx.employee.findMany({
      where: { id: { in: neighbourEmployeeIds } },
      select: { id: true, userId: true },
    });
    const userIdToEmployeeId = new Map<string, string>();
    for (const e of neighbourEmployees) {
      if (e.userId) userIdToEmployeeId.set(e.userId, e.id);
    }
    const userIds = [...userIdToEmployeeId.keys()];
    if (userIds.length === 0) {
      return { neighbourEmployeeBranches, credentials: [], userIdToEmployeeId };
    }

    const creds = await tx.credential.findMany({
      where: { userId: { in: userIds }, credentialType: 'pin' },
      select: { id: true, userId: true, secretHash: true },
    });

    return {
      neighbourEmployeeBranches,
      credentials: creds.map((c) => ({
        credentialId: c.id,
        userId: c.userId,
        secretHash: c.secretHash,
      })),
      userIdToEmployeeId,
    };
  }

  /**
   * The expensive half of FR-SEC-022 uniqueness: verify `pin` against every
   * credential in `credentials` (Argon2id, sequential). Deliberately takes
   * NO `tx` — callers must invoke this with no DB transaction open, so this
   * O(N) work never counts against Prisma's interactive-transaction timeout
   * (root cause of EMPLOYEE-PIN-SET-500-P0 / P2028).
   */
  private async findPinClash(
    pin: string,
    credentials: readonly NeighbourPinCredential[],
  ): Promise<NeighbourPinCredential | null> {
    for (const cred of credentials) {
      const clash = await this.credentials.verifyPasswordSafe(
        cred.secretHash,
        pin,
      );
      if (clash) return cred;
    }
    return null;
  }

  /** The exact FR-SEC-022 conflict, naming the colliding branch when known. */
  private branchUniquenessConflict(
    snapshot: Pick<PinUniquenessSnapshot, 'neighbourEmployeeBranches' | 'userIdToEmployeeId'>,
    matchedUserId: string,
  ): ConflictException {
    const ownerEmployeeId = snapshot.userIdToEmployeeId.get(matchedUserId);
    const branch = snapshot.neighbourEmployeeBranches.find(
      (n) => n.employeeId === ownerEmployeeId,
    );
    return new ConflictException(
      `That PIN is already in use in branch ${branch?.branchId ?? 'this branch'}. ` +
        'FR-SEC-022 requires PINs to be unique within a branch.',
    );
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

  /**
   * Set or rotate an employee's PIN — EMPLOYEE-PIN-SET-500-P0's three-phase
   * design (see this class's docblock). Never runs Argon2 verification work
   * with a DB transaction open.
   */
  async setPin(
    tenantId: string,
    actorId: string,
    employeeId: string,
    pin: string,
  ): Promise<void> {
    this.assertPinShape(pin);

    // ── PHASE 1 — short, read-only, RLS-scoped snapshot. No Argon2, no
    // advisory lock, no write. The 404/409 employee-shape checks live here,
    // unchanged from before this fix.
    const phase1 = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const employee = await tx.employee.findUnique({
          where: { id: employeeId },
          select: {
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
        const snapshot = await this.snapshotBranchUniqueness(
          tx,
          employeeId,
          branchIds,
        );
        return { targetUserId: employee.userId, snapshot };
      },
    );

    // ── PHASE 2 — outside any transaction / DB connection. This is the O(N)
    // Argon2id work that used to run inside the write transaction and could
    // exceed its 5000ms timeout (root cause). Candidate hashing (already
    // outside any transaction before this fix) stays here too.
    const secretHash = await this.credentials.hashPassword(pin);
    const clash = await this.findPinClash(pin, phase1.snapshot.credentials);
    if (clash) {
      throw this.branchUniquenessConflict(phase1.snapshot, clash.userId);
    }

    // ── PHASE 3 — short atomic write transaction. Re-reads CURRENT branch
    // reachability and CURRENT neighbour credentials, computes the DELTA
    // against the Phase 1 snapshot by credential identity + secretHash
    // (never a timestamp), verifies the candidate against ONLY that delta
    // (bounded by how many credentials actually changed since Phase 1 — not
    // by branch headcount), then performs the existing atomic write.
    await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        await this.lockTenant(tx, tenantId);

        const employee = await tx.employee.findUnique({
          where: { id: employeeId },
          select: { branches: { select: { branchId: true } } },
        });
        if (!employee) {
          throw new NotFoundException('Employee not found.');
        }
        const currentBranchIds = employee.branches.map((b) => b.branchId);
        const currentSnapshot = await this.snapshotBranchUniqueness(
          tx,
          employeeId,
          currentBranchIds,
        );

        const phase1HashByCredentialId = new Map(
          phase1.snapshot.credentials.map((c) => [c.credentialId, c.secretHash]),
        );
        const delta = currentSnapshot.credentials.filter((c) => {
          const previousHash = phase1HashByCredentialId.get(c.credentialId);
          return previousHash === undefined || previousHash !== c.secretHash;
        });

        if (delta.length > 0) {
          const deltaClash = await this.findPinClash(pin, delta);
          if (deltaClash) {
            throw this.branchUniquenessConflict(
              currentSnapshot,
              deltaClash.userId,
            );
          }
        }

        await tx.credential.upsert({
          where: {
            userId_credentialType: {
              userId: phase1.targetUserId,
              credentialType: 'pin',
            },
          },
          create: {
            id: newId(),
            userId: phase1.targetUserId,
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
          metadata: { branchCount: currentBranchIds.length },
        });
      },
    );
  }

  /**
   * Authenticate a PIN at a branch — the full FR-SEC-021 check.
   *
   * ── CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 ─────────────────────────────
   * POS and KDS are application SESSIONS, not registered device identities
   * (product decision, 2026-09-13; supersedes the original FR-SEC-020/021
   * "terminal" wording — see the product-decision record). The branch is
   * supplied directly by the caller (the operator's chosen operating
   * branch), never derived from a device registration. All three conditions
   * are executable here: the branch must exist and be active, it must be
   * one of the employee's permitted branches, and the resulting session is
   * POS/KDS-only (the caller stamps `typ: 'pos' | 'kds'`, which
   * `JwtAuthGuard` refuses on dashboard routes by default).
   */
  async authenticate(
    tenantId: string,
    branchId: string,
    employeeCode: string,
    pin: string,
  ): Promise<PinAuthResult> {
    this.assertPinShape(pin);

    const result = await this.prisma.withAuthContext(
      { tenantId },
      async (tx) => {
        const branch = await tx.branch.findUnique({
          where: { id: branchId },
          select: { id: true, status: true },
        });
        // Invisible cross-tenant under RLS -> falls through to the same
        // generic refusal. An inactive branch fails closed too.
        if (!branch || branch.status !== 'active') {
          throw new UnauthorizedException('Invalid PIN, branch or employee.');
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
          throw new UnauthorizedException('Invalid PIN, branch or employee.');
        }

        // FR-SEC-021: only within the employee's permitted branches.
        const permitted = employee.branches.some(
          (b) => b.branchId === branch.id,
        );
        if (!permitted) {
          throw new UnauthorizedException('Invalid PIN, branch or employee.');
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
          throw new UnauthorizedException('Invalid PIN, branch or employee.');
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
          throw new UnauthorizedException('Invalid PIN, branch or employee.');
        }

        return {
          outcome: 'ok' as const,
          employeeId: employee.id,
          userId: employee.userId,
          branchId: branch.id,
          membershipId: membership.id,
        };
      },
    );

    if (result.outcome === 'bad_pin') {
      await this.recordFailure(result.credentialId, result.attempts);
      throw new UnauthorizedException('Invalid PIN, branch or employee.');
    }

    return {
      employeeId: result.employeeId,
      userId: result.userId,
      branchId: result.branchId,
      membershipId: result.membershipId,
    };
  }

  /**
   * `ApproverPinVerifier.verifyApproverPin` — Identity's first public
   * contract implementation (`contract/pin-verification.contract.ts`).
   *
   * Reuses {@link authenticate} verbatim for the entire verification path
   * (branch, employee, PIN hash, lockout, membership) — nothing is
   * duplicated. Adds exactly one further read: the SAME membership's
   * effective permission codes, via the identical membership -> role ->
   * permission shape `TenantContextService.resolve` uses, resolved in its
   * OWN transaction (never the caller's — see the contract's docblock on why
   * this must run before any consuming module's business transaction).
   *
   * The returned object is deliberately constructed via a cast: the brand
   * field on `VerifiedApproverPrincipal` is an ambient `unique symbol` with
   * no runtime representation, so no plain object literal can satisfy the
   * interface structurally. `module-boundaries.spec.ts` confines this exact
   * cast pattern to `src/modules/identity/`.
   */
  async verifyApproverPin(
    input: VerifyApproverPinInput,
  ): Promise<VerifiedApproverPrincipal> {
    const authResult = await this.authenticate(
      input.tenantId,
      input.branchId,
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
      permissions,
    } as unknown as VerifiedApproverPrincipal;
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

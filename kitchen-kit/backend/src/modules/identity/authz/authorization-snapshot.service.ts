import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AssignmentScope,
  PermittedBranchSet,
  ScopeSetEntry,
  buildPermittedBranchSet,
  permittedBranchSetUnits,
  renderScope,
} from './scope';

/**
 * The SRS-required authorization snapshot carried by a tenant-bound access
 * token (FR-API-012 clause 1: "Tokens SHALL carry: subject, tenant, scope set,
 * and permitted branch set").
 *
 * `sub` and `tid` are already on the token; this adds the scope set, the
 * permitted branch set, and the epoch that makes staleness DETECTABLE.
 */
export interface AuthorizationSnapshot {
  /** FR-API-012 "scope set" — one compact entry per assignment scope held. */
  readonly scp: readonly ScopeSetEntry[];
  /** FR-API-012 "permitted branch set" — SYMBOLIC, never an expanded list. */
  readonly pbr: PermittedBranchSet;
  /** `memberships.authz_epoch` at mint time. */
  readonly epo: number;
}

/**
 * Maximum snapshot units a token may carry.
 *
 * ── WHY A BUDGET EXISTS, AND WHY IT IS NOT A BRANCH-COUNT LIMIT ─────────────
 * `FR-BRN-001` [M] permits an UNLIMITED number of branches per brand and brands
 * per tenant, so a naive "list every permitted branch id" claim would be
 * unbounded by requirement — precisely the "unbounded unsafe header" the
 * ratified amendment's clause 8 forbids.
 *
 * The symbolic representation removes the dependency on branch COUNT entirely:
 * a tenant-wide actor costs ONE unit whether the tenant has 3 branches or
 * 30,000, and a brand-wide actor costs one unit per BRAND. Only assignments
 * that are individually enumerable — explicit brand and branch scopes — consume
 * units, and those are bounded by how many role assignments an administrator
 * actually created for one person.
 *
 * 128 units is therefore a guard against pathological assignment data, not a
 * product limit: at roughly 45 bytes per rendered entry it caps the two claims
 * near 6 KB, comfortably inside the ~8 KB header budget of common reverse
 * proxies while leaving room for the rest of the token. An actor who exceeds it
 * is expressing per-branch authority that a BRAND or TENANT scope would express
 * in one unit.
 *
 * Overflow FAILS CLOSED (clause 8): the token is refused, never truncated.
 * Silent truncation would hand out a token whose snapshot understates authority
 * — and, worse, would train readers to treat an incomplete set as complete.
 */
export const MAX_SNAPSHOT_UNITS = 128;

@Injectable()
export class AuthorizationSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the snapshot for a membership, from live database state.
   *
   * Called at every token-minting site (login-with-PIN, tenant selection,
   * refresh, terminal bind). It reads the SAME rows the request-time resolver
   * reads, so the snapshot describes real authority at mint time — but it is
   * still only a snapshot: `TenantContextService` re-resolves on every request
   * and the snapshot never authorises anything.
   */
  async build(
    userId: string,
    tenantId: string,
    membershipId: string,
  ): Promise<AuthorizationSnapshot> {
    const result = await this.prisma.withAuthContext(
      { userId, tenantId },
      async (tx) => {
        const [{ now }] = await tx.$queryRaw<
          [{ now: Date }]
        >`SELECT now() AS now`;
        const membership = await tx.membership.findFirst({
          where: { id: membershipId, tenantId },
          select: {
            authzEpoch: true,
            membershipRoles: {
              where: {
                validFrom: { lte: now },
                OR: [{ validTo: null }, { validTo: { gt: now } }],
                role: { OR: [{ tenantId }, { isSystem: true }] },
              },
              select: {
                scopeType: true,
                scopeBrandId: true,
                scopeBranchId: true,
              },
            },
          },
        });
        return membership;
      },
    );

    // No membership visible → an EMPTY snapshot, never an absent one. Zero
    // authority is a real, representable state; omission must never be read as
    // unrestricted (R-8).
    if (!result) {
      return {
        scp: [],
        pbr: buildPermittedBranchSet([]),
        epo: 0,
      };
    }

    const scopes: AssignmentScope[] = [];
    for (const mr of result.membershipRoles) {
      if (mr.scopeType === 'tenant') {
        scopes.push({ type: 'tenant' });
      } else if (mr.scopeType === 'brand' && mr.scopeBrandId) {
        scopes.push({ type: 'brand', brandId: mr.scopeBrandId });
      } else if (mr.scopeType === 'branch' && mr.scopeBranchId) {
        scopes.push({ type: 'branch', branchId: mr.scopeBranchId });
      }
      // An inconsistent row contributes NOTHING rather than a wildcard.
    }

    const pbr = buildPermittedBranchSet(scopes);
    const units = permittedBranchSetUnits(pbr);
    if (units > MAX_SNAPSHOT_UNITS) {
      // Deterministic, fail-closed server outcome. No assignment is dropped and
      // no token is issued: the caller is told exactly what to do about it.
      throw new ForbiddenException(
        `Authorization scope set is too large to represent in an access token ` +
          `(${units} scope entries, limit ${MAX_SNAPSHOT_UNITS}). ` +
          'Consolidate the affected role assignments to brand or tenant scope. ' +
          'No partial scope set is issued.',
      );
    }

    // Deduplicated and sorted, so the same authority state always renders to the
    // same snapshot — which is what makes the epoch comparison meaningful.
    const scp = [...new Set(scopes.map(renderScope))].sort();

    return { scp, pbr, epo: result.authzEpoch };
  }
}

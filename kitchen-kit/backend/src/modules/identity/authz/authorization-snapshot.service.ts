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
 * 64 units is therefore a guard against pathological assignment data, not a
 * product limit. An actor who exceeds it is expressing per-branch authority
 * that a BRAND or TENANT scope would express in one unit.
 *
 * ── WHY 64, AND NOT THE 128 THIS FILE ORIGINALLY CARRIED ────────────────────
 * B1-2 set 128 on an ESTIMATE — "roughly 45 bytes per rendered entry ... near
 * 6 KB, comfortably inside the ~8 KB header budget of common reverse proxies".
 * B1-3 measured it instead, and the estimate was low by about 2.6x: a
 * worst-allowed 128-unit token serialised to **15,037 bytes**, a **15,061-byte**
 * `Authorization` header, at **113.3 bytes per unit**. The estimate counted a
 * rendered entry once; in fact an explicit branch id is carried TWICE — as a
 * `branch:<uuid>` scope-set entry AND as a raw uuid in `pbr.branches` — and the
 * payload is then base64url-encoded, expanding it by a further 4/3.
 *
 * A 128-unit token therefore did NOT fit the DEFAULT per-header limit of nginx
 * (`large_client_header_buffers` 8k) or Apache (`LimitRequestFieldSize` 8190);
 * such a deployment would answer 431/400 and the holder simply could not use the
 * system. The measured break-even is 67 units, which is an EDGE, not a budget —
 * 64 is the nearest power of two below it and leaves real margin.
 *
 * The ratified amendment fixed no concrete number. Clause 8 requires a BOUNDED,
 * DETERMINISTIC representation with fail-closed overflow and no truncation, and
 * all three are unchanged: this is an implementation detail moving to match
 * measured reality, not a change of contract. The `FR-API-012` token SHAPE is
 * untouched.
 *
 * Overflow FAILS CLOSED (clause 8): the token is refused, never truncated.
 * Silent truncation would hand out a token whose snapshot understates authority
 * — and, worse, would train readers to treat an incomplete set as complete.
 */
export const MAX_SNAPSHOT_UNITS = 64;

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

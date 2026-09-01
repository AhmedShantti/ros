import { Prisma } from '../../../generated/prisma/client';

/**
 * Organisation PUBLIC contract — the two `kitchen.branch_kds_config` facts
 * the KDS operator lifecycle needs at runtime: FR-KDS-025's recall window and
 * FR-KDS-029's cancelled-line visibility period.
 *
 * `branch_kds_config` is physically stored in the `kitchen` Postgres schema
 * but is logically OWNED by Organisation (ADR 0008 D-06/D-07, "stored, not
 * resolved" — the same split `RoutingConfigQuery` already established for
 * `station_routing_rules`/the fallback station on this same table). Physical
 * co-location is not ownership: Kitchen must still reach these two fields
 * only through this contract, never a direct `tx.branchKdsConfig` query.
 *
 * `recallWindowSeconds` always resolves to a concrete number: the schema
 * default (1800s, FR-KDS-025's own "default 30 minutes") applies whether the
 * config row exists with the column at its default or does not exist at all
 * — a branch that never configured KDS still gets the source-supplied
 * default, never a second invented one. `cancelledLineVisibilitySeconds`
 * stays nullable in both cases — FR-KDS-029 names no default (P1E-5
 * acceptance correction), so "not configured" and "no row at all" are
 * indistinguishable to the caller by design.
 */
export const KDS_BRANCH_CONFIG_QUERY = Symbol('KDS_BRANCH_CONFIG_QUERY');

export interface KdsBranchConfigResult {
  readonly recallWindowSeconds: number;
  readonly cancelledLineVisibilitySeconds: number | null;
}

export interface KdsBranchConfigQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
}

export interface KdsBranchConfigQuery {
  find(
    tx: Prisma.TransactionClient,
    input: KdsBranchConfigQueryInput,
  ): Promise<KdsBranchConfigResult>;
}

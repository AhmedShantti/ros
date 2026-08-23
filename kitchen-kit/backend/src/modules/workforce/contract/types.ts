/**
 * Workforce PUBLIC contract — DTOs that cross the module boundary.
 *
 * SRS §5.4 fixes the shape: `modules/<context>/contract/` is the ONLY directory
 * another module may import, and `types.ts` holds "DTOs crossing the boundary".
 * Nothing here exposes a Workforce entity, repository or Prisma model — a
 * consumer learns the shift's identity and ownership and nothing else.
 */

/** FR-OFF-015 — the device's ULID for the shift. Preserved exactly. */
export interface OpenShiftCommand {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly employeeId: string;
  /** The instant the duty period starts. Server-derived, never client-supplied. */
  readonly openedAt: Date;
}

export interface OpenedShift {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly employeeId: string;
  readonly status: 'open' | 'closed';
  readonly openedAt: Date;
  /** True when this call created the row; false when it reused an identical one. */
  readonly created: boolean;
}

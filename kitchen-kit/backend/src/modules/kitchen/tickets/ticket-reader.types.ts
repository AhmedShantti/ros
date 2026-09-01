/**
 * FR-KDS-020 card DTOs — plain, Kitchen-owned, no Prisma model instance
 * crosses this boundary (same convention as `organisation/contract`'s
 * `RoutingConfigResult`). No pricing field anywhere (P1E-4 §F).
 *
 * Widened for the KDS operator lifecycle (design gate §11, §17, §23): every
 * FR-KDS-040 lifecycle timestamp the client needs to render and operate a
 * ticket, plus `elapsedSeconds` (server-computed at response time — the KDS
 * clock must not be trusted for a displayed SLA, design gate §17).
 */
export interface TicketCardModifierDto {
  readonly id: string;
  readonly nameSnapshot: unknown;
  /** FR-KDS-021 — the addition/removal/substitution distinction. */
  readonly kind: 'addition' | 'removal' | 'substitution';
  readonly quantity: number;
}

export interface TicketCardLineDto {
  readonly id: string;
  readonly orderLineId: string;
  readonly itemNameSnapshot: unknown;
  /** `DECIMAL(12,3)` rendered as a string — never a JS number. */
  readonly quantity: string;
  readonly course: number | null;
  readonly sequence: number;
  readonly preparationNotes: string | null;
  readonly status: string;
  readonly firstViewedAt: string | null;
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly bumpedAt: string | null;
  readonly recalledAt: string | null;
  readonly cancelledAt: string | null;
  readonly modifiers: readonly TicketCardModifierDto[];
}

export interface TicketCardDto {
  readonly id: string;
  readonly stationId: string;
  readonly orderId: string;
  /** `YYYY-MM-DD` — network-ready contract convention (P1E-1A). */
  readonly businessDay: string;
  /** FR-KDS-020 "order number". */
  readonly orderNumber: string;
  /** FR-KDS-020 "order type". */
  readonly orderType: string;
  /** FR-KDS-020 "table or customer reference". */
  readonly serviceReference: string | null;
  /** FR-KDS-020 "elapsed time" anchor — ISO-8601. */
  readonly routedAt: string;
  /** Server-computed at response time — never a client value (design gate §17). */
  readonly elapsedSeconds: number;
  /** Always `null` until FR-KDS-044 `[S]` populates it — never fabricated. */
  readonly targetReadyAt: string | null;
  readonly status: string;
  readonly firstViewedAt: string | null;
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly bumpedAt: string | null;
  readonly recalledAt: string | null;
  readonly recallCount: number;
  readonly lines: readonly TicketCardLineDto[];
}

/** `GET /kds/stations/{stationId}/queue` response envelope (design gate §21). */
export interface StationQueueDto {
  readonly tickets: readonly TicketCardDto[];
  /** `branch_kds_config.recall_window_seconds` — FR-KDS-025's own default (1800). */
  readonly recallWindowSeconds: number;
  /** `null` when the branch has not configured FR-KDS-029's period — never guessed. */
  readonly cancelledLineVisibilitySeconds: number | null;
}

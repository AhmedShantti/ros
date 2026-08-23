/**
 * FR-KDS-020 card DTOs — plain, Kitchen-owned, no Prisma model instance
 * crosses this boundary (same convention as `organisation/contract`'s
 * `RoutingConfigResult`). No pricing field anywhere (P1E-4 §F).
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
  readonly itemNameSnapshot: unknown;
  /** `DECIMAL(12,3)` rendered as a string — never a JS number. */
  readonly quantity: string;
  readonly course: number | null;
  readonly sequence: number;
  readonly preparationNotes: string | null;
  readonly status: string;
  readonly cancelledAt: string | null;
  readonly modifiers: readonly TicketCardModifierDto[];
}

export interface TicketCardDto {
  readonly id: string;
  readonly stationId: string;
  /** FR-KDS-020 "order number". */
  readonly orderNumber: string;
  /** FR-KDS-020 "order type". */
  readonly orderType: string;
  /** FR-KDS-020 "table or customer reference". */
  readonly serviceReference: string | null;
  /** FR-KDS-020 "elapsed time" anchor — ISO-8601. */
  readonly routedAt: string;
  readonly status: string;
  readonly lines: readonly TicketCardLineDto[];
}

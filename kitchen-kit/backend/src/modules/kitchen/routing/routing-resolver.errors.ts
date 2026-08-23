/**
 * FR-KDS-010 typed resolver failures (R5/R6). Both are ordinary `Error`
 * subclasses with a stable `code` discriminant — no HTTP framing here, since
 * this resolver has no HTTP endpoint; a future caller (Fire) maps `code` to
 * whatever transport-level error shape it needs.
 */
export class RoutingConfigurationConflictError extends Error {
  readonly code = 'ROUTING_CONFIGURATION_CONFLICT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'RoutingConfigurationConflictError';
  }
}

export class RoutingNoDestinationError extends Error {
  readonly code = 'ROUTING_NO_DESTINATION' as const;

  constructor(message: string) {
    super(message);
    this.name = 'RoutingNoDestinationError';
  }
}

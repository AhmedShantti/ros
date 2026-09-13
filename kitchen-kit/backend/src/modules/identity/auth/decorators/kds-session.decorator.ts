import { SetMetadata } from '@nestjs/common';

export const ALLOW_KDS_SESSION = 'allowKdsSession';

/**
 * Opt a route in to KDS (PIN-issued) sessions.
 *
 * CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0: KDS is its own application
 * session type, distinct from `pos` (see `AllowPosSession`). FR-SEC-021's
 * "SHALL NOT grant access to the web dashboard" applies identically to a KDS
 * session — `JwtAuthGuard` refuses a `typ: 'kds'` token by default, so no
 * dashboard/back-office/Sales/Treasury route can become reachable from a KDS
 * session by accident.
 *
 * Kitchen's KDS routes annotate themselves with this decorator.
 */
export const AllowKdsSession = () => SetMetadata(ALLOW_KDS_SESSION, true);

import { SetMetadata } from '@nestjs/common';

export const ALLOW_POS_SESSION = 'allowPosSession';

/**
 * Opt a route in to POS (PIN-issued) sessions.
 *
 * FR-SEC-021: PIN authentication "SHALL NOT grant access to the web dashboard".
 * `JwtAuthGuard` therefore REFUSES a `typ: 'pos'` token by default, so no
 * existing dashboard or back-office route can become reachable from a PIN
 * session by accident — including routes added later, which are denied unless
 * their author opts in deliberately.
 *
 * Future POS routes annotate themselves with this decorator.
 */
export const AllowPosSession = () => SetMetadata(ALLOW_POS_SESSION, true);

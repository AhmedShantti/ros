import { Injectable, Logger } from '@nestjs/common';

export const PASSWORD_RESET_NOTIFIER = Symbol('PASSWORD_RESET_NOTIFIER');

export interface PasswordResetNotification {
  userId: string;
  email: string;
  /** Raw single-use token — for delivery only; must never be persisted/logged. */
  token: string;
}

/**
 * Transport seam for delivering a reset token to the user (e.g. email). Kept as
 * a port so the raw token is handed to exactly one place and email/SMS infra can
 * be plugged in later without touching the reset logic.
 *
 * Production provider contract (see docs/auth/security.md):
 *  - Deliver `token` to `email` over a secure channel; the token is single-use
 *    and short-lived (1 hour).
 *  - NEVER log, persist, or otherwise expose the raw `token`.
 *  - Read provider credentials from environment / secret management only.
 *  - `notify` runs AFTER the forgot-password request has already returned its
 *    generic 202 to the caller, so a delivery failure must NOT change the API
 *    response or reveal whether the account exists — throw/log internally only.
 * Wire a production implementation by overriding the PASSWORD_RESET_NOTIFIER
 * provider in IdentityModule with `{ provide: PASSWORD_RESET_NOTIFIER, useClass:
 * YourEmailNotifier }`.
 */
export interface PasswordResetNotifier {
  notify(notification: PasswordResetNotification): Promise<void> | void;
}

/**
 * Default (development) notifier. Real email/SMS infrastructure is a deployment
 * concern, so this only records that a reset was issued — WITHOUT the token or
 * any secret. A production deployment MUST replace this (see the contract above).
 */
@Injectable()
export class LoggingPasswordResetNotifier implements PasswordResetNotifier {
  private readonly logger = new Logger('PasswordReset');

  notify(notification: PasswordResetNotification): void {
    // Never log the token. userId only.
    this.logger.log(`Password reset issued for user ${notification.userId}`);
  }
}

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
 */
export interface PasswordResetNotifier {
  notify(notification: PasswordResetNotification): Promise<void> | void;
}

/**
 * Default notifier. Email infrastructure is out of scope for this phase, so it
 * only records that a reset was issued — WITHOUT the token or any secret.
 */
@Injectable()
export class LoggingPasswordResetNotifier implements PasswordResetNotifier {
  private readonly logger = new Logger('PasswordReset');

  notify(notification: PasswordResetNotification): void {
    // Never log the token. userId only.
    this.logger.log(`Password reset issued for user ${notification.userId}`);
  }
}

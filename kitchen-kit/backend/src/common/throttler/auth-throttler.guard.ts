import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit guard for sensitive auth endpoints. Keys by IP AND account (email)
 * when the request carries one (login / forgot-password), so a single account
 * cannot be brute-forced across IPs and a single IP cannot hammer many accounts;
 * endpoints without an email (refresh / reset / change) fall back to IP. This
 * deliberately does not rely on IP alone.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const ips = req.ips as string[] | undefined;
    const ip =
      (req.ip as string | undefined) ??
      (ips && ips.length > 0 ? ips[0] : undefined) ??
      'unknown';
    const body = req.body as { email?: unknown } | undefined;
    const email =
      typeof body?.email === 'string' ? body.email.toLowerCase() : '';
    return Promise.resolve(email ? `${ip}:${email}` : ip);
  }
}

import { createHash, randomBytes } from 'node:crypto';

/**
 * Refresh tokens are opaque, cryptographically random secrets. The client holds
 * the raw token; the database stores only a SHA-256 hash of it. A fast hash is
 * appropriate here (unlike passwords) because the token is high-entropy (512
 * bits) and not user-chosen, so it is not brute-forceable.
 */
export function generateRefreshToken(): string {
  return randomBytes(64).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

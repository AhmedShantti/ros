import { createHash, randomBytes } from 'node:crypto';

/**
 * Password reset tokens are opaque, cryptographically random secrets. The user
 * receives the raw token (out of band); the database stores only its SHA-256
 * hash. A fast hash is appropriate — the token is high-entropy (384 bits), not
 * a user-chosen secret.
 */
export function generateResetToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

import { createHash } from 'node:crypto';

/**
 * Device fingerprints identify a device; they are NOT passwords. The approved
 * schema stores `fingerprint_hash`, so the raw value is hashed here and never
 * persisted or logged. A fast hash is appropriate — the fingerprint is a device
 * identifier, not a low-entropy secret to be brute-forced.
 */
export function hashDeviceFingerprint(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

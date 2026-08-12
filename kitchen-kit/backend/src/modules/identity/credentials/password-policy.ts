import { BadRequestException } from '@nestjs/common';

/**
 * Centralised password policy (master guide §13 / §17). Deliberately minimal:
 * a floor on length, a ceiling to avoid pathological hashing input, and a small
 * blocklist of obviously-weak values. No silent truncation, no arbitrary
 * composition rules. Tighten here (not scattered across controllers) if the SRS
 * later mandates a stricter policy.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  '12345678',
  '123456789',
  'qwertyui',
  'iloveyou',
  'admin123',
  'changeme',
  'letmein1',
]);

export function assertPasswordMeetsPolicy(password: string): void {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new BadRequestException(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new BadRequestException(
      `Password must be at most ${PASSWORD_MAX_LENGTH} characters long.`,
    );
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new BadRequestException('Password is too common; choose another.');
  }
}

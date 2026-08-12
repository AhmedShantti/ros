import { BadRequestException } from '@nestjs/common';
import {
  assertPasswordMeetsPolicy,
  PASSWORD_MAX_LENGTH,
} from './password-policy';

describe('assertPasswordMeetsPolicy', () => {
  it('accepts a reasonable password', () => {
    expect(() => assertPasswordMeetsPolicy('s3cure-passphrase')).not.toThrow();
  });

  it('rejects a too-short password', () => {
    expect(() => assertPasswordMeetsPolicy('short')).toThrow(
      BadRequestException,
    );
  });

  it('rejects an over-long password (no silent truncation)', () => {
    const tooLong = 'a'.repeat(PASSWORD_MAX_LENGTH + 1);
    expect(() => assertPasswordMeetsPolicy(tooLong)).toThrow(
      BadRequestException,
    );
  });

  it('rejects a common password', () => {
    expect(() => assertPasswordMeetsPolicy('password1')).toThrow(
      BadRequestException,
    );
  });
});

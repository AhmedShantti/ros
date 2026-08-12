import { JwtService } from '@nestjs/jwt';
import { AccessTokenService } from './access-token.service';
import { AccessTokenPayload } from './auth.types';

/**
 * Proves the Phase 14 JWT verification constraints: the access token is only
 * accepted when signed by this service with the pinned algorithm, issuer and
 * audience. Mirrors the JwtModule wiring in identity.module.ts.
 */
const SECRET = 'x'.repeat(48);
const ISSUER = 'ros-identity';
const AUDIENCE = 'ros-identity-api';
const payload: AccessTokenPayload = { sub: 'user-1', sid: 'sid-1' };

function signerWith(overrides: {
  algorithm?: 'HS256' | 'HS512';
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  secret?: string;
}): JwtService {
  return new JwtService({
    secret: overrides.secret ?? SECRET,
    signOptions: {
      algorithm: overrides.algorithm ?? 'HS256',
      issuer: overrides.issuer ?? ISSUER,
      audience: overrides.audience ?? AUDIENCE,
      expiresIn: overrides.expiresIn ?? '15m',
    },
  });
}

describe('AccessTokenService (hardened verification)', () => {
  // The verifier is configured exactly like the JwtModule registration.
  const service = new AccessTokenService(
    new JwtService({
      secret: SECRET,
      verifyOptions: {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      },
    }),
  );

  it('accepts a valid token signed with the pinned algorithm/issuer/audience', async () => {
    const token = await signerWith({}).signAsync(payload);
    await expect(service.verify(token)).resolves.toMatchObject({
      sub: 'user-1',
    });
  });

  it('rejects a token signed with a different algorithm (HS512)', async () => {
    const token = await signerWith({ algorithm: 'HS512' }).signAsync(payload);
    await expect(service.verify(token)).rejects.toBeDefined();
  });

  it('rejects a token with the wrong issuer', async () => {
    const token = await signerWith({ issuer: 'evil-issuer' }).signAsync(
      payload,
    );
    await expect(service.verify(token)).rejects.toBeDefined();
  });

  it('rejects a token with the wrong audience', async () => {
    const token = await signerWith({ audience: 'someone-else' }).signAsync(
      payload,
    );
    await expect(service.verify(token)).rejects.toBeDefined();
  });

  it('rejects a token signed with the wrong secret (bad signature)', async () => {
    const token = await signerWith({ secret: 'y'.repeat(48) }).signAsync(
      payload,
    );
    await expect(service.verify(token)).rejects.toBeDefined();
  });

  it('rejects a tampered signature', async () => {
    const token = await signerWith({}).signAsync(payload);
    const parts = token.split('.');
    parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('aa') ? 'bb' : 'aa');
    await expect(service.verify(parts.join('.'))).rejects.toBeDefined();
  });

  it('rejects an expired token', async () => {
    const token = await signerWith({ expiresIn: '-1s' }).signAsync(payload);
    await expect(service.verify(token)).rejects.toBeDefined();
  });

  it('rejects a malformed token', async () => {
    await expect(service.verify('not-a-jwt')).rejects.toBeDefined();
  });
});

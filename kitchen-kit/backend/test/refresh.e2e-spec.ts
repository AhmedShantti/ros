import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import {
  generateRefreshToken,
  hashRefreshToken,
} from './../src/modules/identity/sessions/refresh-token';
import { UsersService } from './../src/modules/identity/users/users.service';
import { PrismaService } from './../src/prisma/prisma.service';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

describe('Refresh & logout (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;
  let userId: string;

  const email = `refresh.e2e.${Date.now()}@example.com`;
  const password = 's3cure-passphrase';

  const login = async (): Promise<TokenPair> => {
    const res = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body as TokenPair;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    http = app.getHttpServer();
    const user = await app
      .get(UsersService)
      .createUser({ email, password, displayName: 'Refresh E2E' });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await app.close();
  });

  it('refreshes successfully and rotates the token (old token rejected)', async () => {
    const { refreshToken } = await login();

    const rotated = await request(http)
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    const next = rotated.body as TokenPair;

    expect(typeof next.accessToken).toBe('string');
    expect(next.refreshToken).not.toBe(refreshToken);

    // The new token works...
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: next.refreshToken })
      .expect(200);
    // ...and the original (now-rotated) token is rejected.
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });

  it('rejects a revoked session', async () => {
    const token = generateRefreshToken();
    await prisma.session.create({
      data: {
        id: newId(),
        userId,
        refreshTokenHash: hashRefreshToken(token),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      },
    });
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: token })
      .expect(401);
  });

  it('rejects an expired session', async () => {
    const token = generateRefreshToken();
    await prisma.session.create({
      data: {
        id: newId(),
        userId,
        refreshTokenHash: hashRefreshToken(token),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: token })
      .expect(401);
  });

  it('rejects an unknown refresh token (no user/session leak)', () =>
    request(http)
      .post('/auth/refresh')
      .send({ refreshToken: generateRefreshToken() })
      .expect(401));

  it('detects reuse and revokes the whole rotation chain', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    const first = await login();

    const rotated = await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    const second = rotated.body as TokenPair;

    // Replay the already-rotated original token -> reuse detected -> 401.
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);

    // The successor token from the compromised chain is now revoked too.
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: second.refreshToken })
      .expect(401);

    // A warning was logged, and it never contains the raw token.
    const warned = warnSpy.mock.calls.flat().join(' ');
    expect(warned).toContain('reuse detected');
    expect(warned).not.toContain(first.refreshToken);
    warnSpy.mockRestore();
  });

  it('handles concurrent refresh with the same token: exactly one wins', async () => {
    const { refreshToken } = await login();

    const results = await Promise.all([
      request(http).post('/auth/refresh').send({ refreshToken }),
      request(http).post('/auth/refresh').send({ refreshToken }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401]);
  });

  it('logs out (revokes session) and blocks refresh afterwards', async () => {
    const { accessToken, refreshToken } = await login();

    await request(http)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });

  it('never stores a plaintext refresh token in the DB', async () => {
    const { refreshToken } = await login();
    const row = await prisma.session.findUnique({
      where: { refreshTokenHash: hashRefreshToken(refreshToken) },
    });
    expect(row).not.toBeNull();
    expect(row?.refreshTokenHash).toBe(hashRefreshToken(refreshToken));
    expect(row?.refreshTokenHash).not.toContain(refreshToken);
  });
});

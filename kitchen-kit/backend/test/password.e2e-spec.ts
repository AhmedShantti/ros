import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaClient } from './../src/generated/prisma/client';
import { hashResetToken } from './../src/modules/identity/password/password-reset-token';
import {
  PASSWORD_RESET_NOTIFIER,
  PasswordResetNotification,
} from './../src/modules/identity/password/password-reset.notifier';
import { UsersService } from './../src/modules/identity/users/users.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

describe('Password change/reset (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let http: App;

  const captured: { token?: string; userId?: string } = {};
  const ts = Date.now();
  const emails = {
    change: `pw.change.${ts}@example.com`,
    wrong: `pw.wrong.${ts}@example.com`,
    disabled: `pw.disabled.${ts}@example.com`,
    reset: `pw.reset.${ts}@example.com`,
    reset2: `pw.reset2.${ts}@example.com`,
    reset3: `pw.reset3.${ts}@example.com`,
  };
  const ORIG = 'orig-password-123';
  const NEXT = 's3cure-next-passphrase';
  const userIds: string[] = [];

  const login = (email: string, pw: string) =>
    request(http).post('/auth/login').send({ email, password: pw });

  const forgot = async (email: string): Promise<void> => {
    delete captured.token;
    await request(http)
      .post('/auth/password/forgot')
      .send({ email })
      .expect(202);
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PASSWORD_RESET_NOTIFIER)
      .useValue({
        notify: (n: PasswordResetNotification) => {
          captured.token = n.token;
          captured.userId = n.userId;
        },
      })
      .compile();
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
    admin = createMigratorClient(app);
    http = app.getHttpServer();

    const users = app.get(UsersService);
    for (const email of Object.values(emails)) {
      const u = await users.createUser({
        email,
        password: ORIG,
        displayName: 'PW',
      });
      userIds.push(u.id);
    }
  });

  afterAll(async () => {
    await prisma.user
      .deleteMany({ where: { id: { in: userIds } } })
      .catch(() => undefined);
    await admin.$disconnect();
    await app.close();
  });

  it('change: wrong current password → 401', async () => {
    const { accessToken } = (await login(emails.wrong, ORIG).expect(200))
      .body as Tokens;
    await request(http)
      .post('/auth/password/change')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'not-it', newPassword: NEXT })
      .expect(401);
    // Old password still works (unchanged).
    await login(emails.wrong, ORIG).expect(200);
  });

  it('change: rotates credential, keeps current session, revokes others', async () => {
    const current = (await login(emails.change, ORIG).expect(200))
      .body as Tokens;
    const other = (await login(emails.change, ORIG).expect(200)).body as Tokens;

    await request(http)
      .post('/auth/password/change')
      .set('Authorization', `Bearer ${current.accessToken}`)
      .send({ currentPassword: ORIG, newPassword: NEXT })
      .expect(204);

    await login(emails.change, ORIG).expect(401); // old fails
    await login(emails.change, NEXT).expect(200); // new works
    // The other session's refresh token is revoked...
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: other.refreshToken })
      .expect(401);
    // ...the current session's refresh still works.
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: current.refreshToken })
      .expect(200);
  });

  it('change: a disabled account cannot change its password → 403', async () => {
    const { accessToken } = (await login(emails.disabled, ORIG).expect(200))
      .body as Tokens;
    await admin.user.update({
      where: { email: emails.disabled },
      data: { status: 'disabled' },
    });
    await request(http)
      .post('/auth/password/change')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: ORIG, newPassword: NEXT })
      .expect(403);
  });

  it('forgot: known and unknown accounts are indistinguishable (no enumeration)', async () => {
    const known = await request(http)
      .post('/auth/password/forgot')
      .send({ email: emails.reset })
      .expect(202);
    const unknown = await request(http)
      .post('/auth/password/forgot')
      .send({ email: `nobody.${ts}@example.com` })
      .expect(202);
    expect(known.body).toEqual(unknown.body);
  });

  it('reset: the token is stored only as a hash (raw never persisted)', async () => {
    await forgot(emails.reset);
    const raw = captured.token as string;
    const row = await admin.passwordResetToken.findFirstOrThrow({
      where: { userId: captured.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.tokenHash).toBe(hashResetToken(raw));
    expect(row.tokenHash).not.toContain(raw);
  });

  it('reset: single-use — changes password, revokes all sessions, blocks replay', async () => {
    const pre = (await login(emails.reset2, ORIG).expect(200)).body as Tokens;
    await forgot(emails.reset2);
    const token = captured.token as string;

    await request(http)
      .post('/auth/password/reset')
      .send({ token, newPassword: NEXT })
      .expect(204);

    await login(emails.reset2, ORIG).expect(401); // old fails
    await login(emails.reset2, NEXT).expect(200); // new works
    // All pre-reset sessions revoked.
    await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: pre.refreshToken })
      .expect(401);
    // Replay of the consumed token is rejected.
    await request(http)
      .post('/auth/password/reset')
      .send({ token, newPassword: 'another-passphrase-9' })
      .expect(401);
  });

  it('reset: expired token → 401', async () => {
    await forgot(emails.reset3);
    const token = captured.token as string;
    await admin.passwordResetToken.updateMany({
      where: { userId: captured.userId, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await request(http)
      .post('/auth/password/reset')
      .send({ token, newPassword: NEXT })
      .expect(401);
  });

  it('reset: unknown token → 401; malformed token → 400', async () => {
    await request(http)
      .post('/auth/password/reset')
      .send({ token: 'x'.repeat(64), newPassword: NEXT })
      .expect(401);
    await request(http)
      .post('/auth/password/reset')
      .send({ token: 'short', newPassword: NEXT })
      .expect(400);
  });
});

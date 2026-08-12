import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { UsersService } from './../src/modules/identity/users/users.service';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let userId: string;

  const email = `auth.e2e.${Date.now()}@example.com`;
  const password = 's3cure-passphrase';

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
    jwt = app.get(JwtService);
    const user = await app
      .get(UsersService)
      .createUser({ email, password, displayName: 'Auth E2E' });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await app.close();
  });

  it('POST /auth/login returns tokens for valid credentials', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    const body = res.body as {
      tokenType: string;
      accessToken: string;
      refreshToken: string;
      user: Record<string, unknown>;
    };
    expect(body.tokenType).toBe('Bearer');
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.user).not.toHaveProperty('secretHash');
  });

  it('POST /auth/login rejects a wrong password with 401', () =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(401));

  it('POST /auth/login rejects an unknown email with 401 (no enumeration)', () =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password })
      .expect(401));

  it('GET /auth/me returns the user with a valid token', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const { accessToken } = login.body as { accessToken: string };

    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body).toMatchObject({ id: userId, email });
    expect(res.body).not.toHaveProperty('secretHash');
  });

  it('GET /auth/me without a token returns 401', () =>
    request(app.getHttpServer()).get('/auth/me').expect(401));

  it('GET /auth/me with an invalid token returns 401', () =>
    request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401));

  it('GET /auth/me with an expired token returns 401', async () => {
    const expired = await jwt.signAsync(
      { sub: userId, sid: 'expired-session' },
      { expiresIn: '-1s' },
    );
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${expired}`)
      .expect(401);
  });
});

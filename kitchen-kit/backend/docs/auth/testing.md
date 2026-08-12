# Testing & Verification

## Prerequisites
- Local Postgres via Docker on host port **5544**: `npm run db:up` (see `docker-compose.yml`).
- `.env` from `.env.example` with `DATABASE_URL` (ros_migrator) and `APP_DATABASE_URL` (ros_app).
- Migrations applied: `npx prisma migrate status` should print **"Database schema is up to date!"**.

## Commands
```bash
# Prisma
npx prisma format
npx prisma validate
npx prisma generate            # → src/generated/prisma (gitignored)
npx prisma migrate status

# Tests
npm test                       # unit (jest, ts-jest)
npm run test:e2e               # e2e (needs NODE_OPTIONS=--experimental-vm-modules — set by the script)

# Quality
npm run build                  # nest build
npx eslint "{src,test}/**/*.ts"    # lint without auto-fix
```

## Layout
- **Unit** specs live next to code (`*.spec.ts`, `rootDir: src`).
- **E2E** specs in `test/*.e2e-spec.ts` (config `test/jest-e2e.json`). They boot the real Nest app
  against the dev DB. Privileged arrange/inspection of RLS tables uses the migrator client helper
  `test/rls-admin.ts` (`createMigratorClient(app)`); the app under test always runs as `ros_app`.

## Current status (Phase 13 gate)
- Unit: **70 passed / 70** (17 suites). E2E: **90 passed / 90** (11 suites). Build + lint PASS.
- E2E suites cover: auth, refresh/logout, tenant selection, tenant-context, RBAC, RLS enforcement,
  terminal, password change/reset, rate limiting, audit.

## Notes
- E2E is DB-stateful; the app's global advisory lock serializes the shared sentinel audit chain
  across jest workers. Never run `prisma migrate reset` against a database you care about — use an
  isolated/throwaway DB for clean-apply testing.

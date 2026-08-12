# ADR 0006 — Rate limiting & security headers

- Status: Accepted
- Date: 2026-08-12
- Phase: 11

## Context

Sensitive auth endpoints need abuse/brute-force protection. Full rate limiting
was scheduled for this phase; the earlier phases were designed to be throttle-
ready (distinct endpoints, no response-shape coupling).

## Decisions

### Rate limiting (`@nestjs/throttler`)
- Applied to the sensitive endpoints only — **not globally** — so the many other
  identity endpoints are unaffected: `POST /auth/login`, `POST /auth/refresh`,
  `POST /auth/password/change`, `POST /auth/password/forgot`,
  `POST /auth/password/reset`.
- **`AuthThrottlerGuard`** keys by **IP + account (email)** when the request body
  carries an email (login / forgot), otherwise by **IP** (refresh / reset /
  change). This deliberately does not rely on IP alone: a single account cannot
  be brute-forced across IPs, and a single IP cannot fan out across accounts.
- Limits are **config-driven** via `AUTH_THROTTLE_TTL` (ms window) and
  `AUTH_THROTTLE_LIMIT` (max per key). Defaults: `60000` / `50`. **Defaults are
  intentionally lenient; production should tighten** (e.g. limit 5–10 / 60s).
  Over-limit → `429 Too Many Requests`.
- Storage is the in-memory default (per process). A shared store (e.g. Redis)
  can be introduced later for multi-instance deployments without changing the
  guard.

The guard counts every request reaching it (including failed 401s), so repeated
wrong-password / unknown-account attempts are throttled. Because failed attempts
still return the existing generic errors, enumeration-safety is preserved.

### Security headers (`helmet`)
`helmet({ contentSecurityPolicy: false })` is applied at bootstrap — adds HSTS,
`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, etc., and removes
`X-Powered-By`. CSP is left off so the Swagger UI at `/docs` keeps working;
enable a tailored CSP once a fixed front-end origin is known.

## Consequences
- Multi-instance deployments should switch the throttler to a shared store to
  make limits global rather than per-process.
- No change to the JWT/refresh/session architecture; no new authorization state.

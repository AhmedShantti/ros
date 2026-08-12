# ROS — Claude Code Master Prompt
## Full Authentication & Authorization Implementation

> Use this document as the master instruction for Claude Code. Implement the complete ROS Authentication/Authorization foundation directly in the existing repository. Do not generate a separate demo project.

---

## 1. Mission

You are the senior backend engineer implementing the complete **Identity + Authentication + Authorization** foundation for the ROS (Restaurant Operating System).

Technology target:

- NestJS
- TypeScript
- Prisma
- PostgreSQL
- Modular Monolith
- ROS SRS v1.0
- Approved ROS database design

Your job is to inspect the repository first, understand its current architecture, then implement Auth incrementally, safely, and completely.

This is an **implementation task**, not a request to redesign the architecture.

---

# 2. SOURCE OF TRUTH

Use this priority:

1. Existing working repository architecture
2. ROS SRS and ADRs
3. Approved ROS database design / SQL schema
4. Existing backend engineering guidelines
5. Existing project conventions
6. Reasonable defaults only when the above do not specify something

If sources conflict:

- identify the conflict;
- inspect the relevant SRS/ADR;
- do not silently invent a rule;
- stop and report genuine unresolved security/business ambiguity.

Never replace an explicit SRS decision with your personal preference.

---

# 3. FIRST ACTION — DO NOT CODE YET

Start by auditing the repository.

Run/inspect:

```bash
pwd
git status
git branch --show-current
cat package.json
find src -maxdepth 5 -type f | sort
find prisma -maxdepth 5 -type f | sort 2>/dev/null || true
find test -maxdepth 5 -type f | sort 2>/dev/null || true
find . -iname '*srs*' -o -iname '*adr*' -o -iname '*architecture*' -o -iname '*database*'
```

Inspect:

- NestJS bootstrap
- AppModule
- existing modules
- PrismaService
- Prisma schema
- migrations
- configuration
- environment validation
- global guards
- pipes
- interceptors
- exception filters
- logging
- existing auth code
- existing RBAC code
- test setup
- Docker/development setup
- SRS
- database design
- backend engineering guidelines

Before modifying files, produce a concise internal implementation plan.

Do not create code until the repository audit is complete.

---

# 4. ARCHITECTURAL CONSTRAINTS

The ROS backend is a **Modular Monolith**.

Preserve:

```text
NestJS
  ↓
bounded contexts / modules
  ↓
PostgreSQL
```

Do NOT:

- convert to microservices;
- introduce another database;
- replace Prisma;
- create a generic CRUD architecture;
- bypass module boundaries;
- directly query other bounded contexts' tables from Identity.

Identity/Auth must remain a bounded context.

---

# 5. AUTH SCOPE

Implement the complete Auth/Identity foundation:

```text
Identity
├── Users
├── Credentials
├── Sessions
├── Authentication
├── Access tokens
├── Refresh tokens
├── Tenant identity
├── Memberships
├── Roles
├── Permissions
├── Membership → Role
├── Role → Permission
├── Tenant context
├── Authorization guards
├── Terminal/device identity foundation
├── Password change/reset
├── Rate limiting
└── Security/audit integration
```

Do not implement unrelated business domains.

Do not touch Sales, Inventory, Catalogue, Procurement, Kitchen, Treasury, CRM, etc. unless a minimal Auth integration contract is explicitly required.

---

# 6. NON-NEGOTIABLE SECURITY RULES

## Passwords

- Argon2id only.
- Never store plaintext passwords.
- Never log passwords.
- Never return password hashes.
- Do not put credentials in JWTs.

## Access tokens

- Short-lived.
- Signed with a strong secret/key from configuration.
- Minimal payload.
- No password.
- No refresh token.
- No large permission list.
- Tampered/expired tokens return 401.

## Refresh tokens

- Cryptographically random.
- Never stored plaintext.
- Store only a secure hash/verifier.
- Rotate on refresh.
- Old refresh token becomes invalid.
- Detect refresh-token reuse.
- Revoked/expired sessions cannot refresh.

## Authentication vs authorization

Authentication answers:

> Who is this?

Authorization answers:

> What may this authenticated principal do?

JWT validity does NOT equal authorization.

## Tenant security

Never trust a client-provided tenant ID.

Always establish:

```text
Authenticated User
      ↓
Membership
      ↓
Allowed Tenant
      ↓
Tenant Context
```

Tenant-scoped data must be protected by PostgreSQL RLS according to the SRS.

---

# 7. ID STRATEGY

The SRS requires **ULIDs**.

Do not replace them with:

- bigint;
- auto-increment;
- UUIDv4;
- arbitrary strings.

Inspect the approved database design and existing Prisma representation first.

If the project represents ULIDs in a UUID-compatible 16-byte form, follow the established implementation.

Do not change ID strategy merely because another option is easier.

---

# 8. DATABASE-FIRST IMPLEMENTATION

Inspect whether these already exist:

```text
identity.users
identity.credentials
identity.sessions
identity.tenants
identity.memberships
identity.roles
identity.permissions
identity.role_permissions
identity.membership_roles
identity.terminals
```

If they exist, do not recreate them.

If they do not exist, implement them through proper Prisma migrations according to the approved database design.

Do not use destructive resets.

---

# 9. PRISMA RULES

Before changing Prisma:

```bash
npx prisma validate
npx prisma format
npx prisma migrate status
```

After changes:

```bash
npx prisma format
npx prisma validate
npx prisma generate
npx prisma migrate status
```

Use migrations.

Do not casually use:

```bash
npx prisma db push
```

for a migration-controlled backend.

Do not delete existing migrations.

---

# 10. DEPENDENCIES

Inspect existing dependencies before installing anything.

Only add missing packages.

Expected capabilities may include:

```bash
npm install argon2
npm install @nestjs/jwt
npm install @nestjs/config
npm install class-validator class-transformer
npm install @nestjs/throttler
```

But first check whether equivalent functionality already exists.

Do not install duplicate authentication/JWT/hash/validation libraries.

---

# 11. CONFIGURATION

Use the existing configuration architecture.

Required concepts:

```env
DATABASE_URL=
JWT_ACCESS_SECRET=
JWT_ACCESS_TTL=
JWT_REFRESH_TTL=
```

Use the project's actual variable naming conventions if they differ.

Requirements:

- validate required variables at startup;
- never hard-code secrets;
- never commit `.env`;
- production secrets must come from secret management;
- never print secret values.

Generate a local random secret if needed:

```bash
openssl rand -base64 64
```

---

# 12. MODULE STRUCTURE

Follow existing repository conventions.

If there is no established Identity structure, use a clean bounded-context structure similar to:

```text
src/
└── modules/
    └── identity/
        ├── identity.module.ts
        ├── auth/
        │   ├── auth.controller.ts
        │   ├── auth.service.ts
        │   ├── dto/
        │   ├── guards/
        │   ├── strategies/
        │   └── decorators/
        ├── users/
        ├── credentials/
        ├── sessions/
        ├── tenants/
        ├── memberships/
        ├── roles/
        ├── permissions/
        ├── terminals/
        └── security/
```

Do not duplicate services/repositories that already exist.

Do not create one giant `AuthService` containing the whole identity domain.

---

# 13. PHASE 0 — REPOSITORY AUDIT

Complete the audit and establish:

```text
Existing architecture
Existing database
Existing auth
Existing conventions
Missing capabilities
Implementation sequence
Potential conflicts
```

Do not make destructive changes.

If existing Auth partially exists, extend it rather than creating a parallel Auth system.

---

# 14. PHASE 1 — USER + CREDENTIALS

Implement according to the approved schema.

Conceptual model:

```text
User 1 ───── 1 Credential
```

User owns identity/account state.

Credential owns password authentication material.

Do not place:

```text
password
password_hash
```

in public User DTOs.

---

# 15. USER CREATION

Flow:

```text
request
 ↓
DTO validation
 ↓
password policy
 ↓
Argon2id hash
 ↓
transaction
 ↓
User + Credential
```

Creating a user must not result in a partially-created authentication identity.

Use a transaction where required.

---

# 16. ARGON2ID

Use:

```typescript
import * as argon2 from 'argon2';

const hash = await argon2.hash(password, {
  type: argon2.argon2id,
});
```

Verify with:

```typescript
await argon2.verify(passwordHash, password);
```

Never substitute:

```text
MD5
SHA256(password)
plain SHA
bcrypt
plaintext
```

unless a documented legacy migration requirement exists.

---

# 17. PASSWORD POLICY

Centralize password policy.

At minimum:

- minimum length;
- no silent truncation;
- safe validation;
- brute-force protection.

Do not create arbitrary complexity rules unless required by the SRS.

---

# 18. PHASE 2 — LOGIN

Implement:

```http
POST /auth/login
```

Flow:

```text
HTTP
 ↓
DTO validation
 ↓
AuthService
 ↓
resolve user
 ↓
load credentials
 ↓
check user status
 ↓
Argon2id verify
 ↓
create session
 ↓
issue access token
 ↓
issue refresh token
 ↓
response
```

Unknown email and wrong password must not be distinguishable through externally visible error semantics.

Use a generic authentication failure.

Do not leak account existence.

---

# 19. ACCESS JWT

Use a short-lived access token.

Target:

```text
15 minutes
```

unless the SRS/repository specifies otherwise.

Payload should be minimal, conceptually:

```json
{
  "sub": "USER_ID",
  "sid": "SESSION_ID",
  "iat": 0,
  "exp": 0
}
```

Do not put the complete permission set in the JWT.

Do not put tenant access data into the token unless explicitly required by the approved architecture.

Keep authorization server-side.

---

# 20. JWT AUTH GUARD

Implement a proper NestJS authentication guard.

Flow:

```text
Authorization: Bearer token
        ↓
extract token
        ↓
verify signature
        ↓
verify expiration
        ↓
validate claims
        ↓
establish authenticated principal
```

Missing/invalid/expired token:

```text
401 Unauthorized
```

Use a typed authentication context.

Avoid:

```typescript
request.user: any
```

---

# 21. AUTHENTICATION CONTEXT

Create a typed context that can represent:

```text
userId
sessionId
tenantId
membershipId
terminalId
```

Only populate values that have actually been established.

Do not invent tenant IDs from headers.

---

# 22. /AUTH/ME

Implement:

```http
GET /auth/me
```

Requires valid authentication.

Return safe user data.

Never return:

```text
password_hash
refresh_token_hash
credential material
internal secrets
```

Tests:

```text
valid token -> 200
missing token -> 401
invalid token -> 401
expired token -> 401
```

---

# 23. PHASE 3 — SESSIONS

Implement session persistence according to the approved schema.

Conceptual:

```text
Session
├── id
├── user_id
├── refresh_token_hash
├── expires_at
├── revoked_at
├── created_at
├── last_used_at
└── approved metadata/context
```

Do not add fields without justification.

---

# 24. REFRESH TOKEN GENERATION

Use Node crypto:

```typescript
import { randomBytes } from 'node:crypto';

const refreshToken = randomBytes(64).toString('base64url');
```

Never generate refresh tokens using:

```text
Math.random()
timestamp
email
user ID
predictable strings
```

---

# 25. REFRESH TOKEN STORAGE

Client receives:

```text
actual token
```

Database stores:

```text
hash/verifier
```

Never store raw refresh tokens.

---

# 26. REFRESH ENDPOINT

Implement:

```http
POST /auth/refresh
```

Flow:

```text
refresh token
 ↓
locate session
 ↓
verify token against stored hash
 ↓
check expiry
 ↓
check revoked state
 ↓
rotate token
 ↓
issue new access token
 ↓
issue new refresh token
```

Use a transaction for the rotation.

Handle concurrent refresh requests safely.

---

# 27. REFRESH TOKEN ROTATION

Example:

```text
RT1
 ↓
RT1 invalidated
RT2 issued
 ↓
RT2 invalidated
RT3 issued
```

Reuse of an old token must be detected.

Do not issue a fresh token after a known reuse event.

Apply the SRS/security policy for session invalidation.

---

# 28. LOGOUT

Implement:

```http
POST /auth/logout
```

Revoke the current session server-side.

Do not rely on the client deleting tokens.

If logout-all is required by the SRS, implement it as a separate domain operation.

---

# 29. PHASE 4 — TENANTS

Implement tenant identity according to the SRS.

Do not mix Tenant with the Organisation bounded context unless the SRS explicitly defines that ownership.

Follow the approved database design for lifecycle/state fields.

---

# 30. MEMBERSHIPS

Implement:

```text
User
  |
  +-- Membership -- Tenant
```

A user can belong to multiple tenants.

Never assume:

```text
one user = one tenant
```

---

# 31. TENANT SELECTION

If multiple tenant memberships exist:

```text
authenticated user
 ↓
available memberships
 ↓
select tenant
 ↓
verify membership
 ↓
establish tenant context
```

Never trust:

```http
X-Tenant-ID
```

without server-side membership validation.

---

# 32. TENANT CONTEXT

Centralize tenant resolution.

A request should eventually have trusted context:

```text
user
session
tenant
membership
terminal
```

Do not make every controller independently parse tenant headers.

Do not allow:

```typescript
service.getOrders(tenantIdFromRequest)
```

without verifying that the tenant belongs to the authenticated principal.

---

# 33. PHASE 5 — ROLES

Implement roles according to SRS/domain design.

Examples may include:

```text
OWNER
BRANCH_MANAGER
CASHIER
KITCHEN_MANAGER
INVENTORY_MANAGER
ACCOUNTANT
```

Do not hard-code role logic across controllers.

Roles are authorization data.

---

# 34. PERMISSIONS

Implement stable permission codes.

Examples:

```text
orders.read
orders.create
orders.refund
inventory.read
inventory.adjust
employees.read
employees.manage
```

Prefer:

```text
permission = "orders.refund"
```

over:

```typescript
if (role === 'manager')
```

---

# 35. ROLE → PERMISSION

Implement:

```text
Role
  |
  +-- Permission
```

Use a join table according to the database design.

Add uniqueness constraints to prevent duplicate assignments.

---

# 36. MEMBERSHIP → ROLE

Implement:

```text
Membership
  |
  +-- Role
```

Do NOT use a global:

```text
user.role_id
```

as the tenant authorization model.

A user can have different roles in different tenants.

---

# 37. PHASE 6 — PERMISSION DECORATOR

Implement an authorization decorator similar to:

```typescript
@RequirePermission('orders.refund')
```

The decorator attaches metadata.

It must not itself perform authorization.

---

# 38. PERMISSION GUARD

Expected flow:

```text
JwtAuthGuard
      ↓
TenantContextGuard
      ↓
PermissionGuard
      ↓
Controller
```

Permission resolution:

```text
User
 ↓
Membership
 ↓
Roles
 ↓
Permissions
 ↓
required permission
```

Authenticated but forbidden:

```text
403 Forbidden
```

---

# 39. PHASE 7 — POSTGRESQL RLS

Follow the approved ROS RLS strategy.

For tenant-scoped tables:

```sql
ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
ALTER TABLE ... FORCE ROW LEVEL SECURITY;
```

Use the project's approved tenant context mechanism.

Conceptually:

```sql
tenant_id = current_setting(
  'app.tenant_id',
  true
)::YOUR_APPROVED_ID_TYPE
```

Do not assume UUID if the schema uses another representation.

---

# 40. RLS TRANSACTION CONTEXT

Tenant context must be transaction-local.

Conceptually:

```sql
SET LOCAL app.tenant_id = 'TENANT_ID';
```

Important:

- context must exist in the same DB transaction as protected queries;
- never use a persistent connection-level tenant context;
- prevent tenant context leakage through connection pooling.

Implement this using the existing Prisma transaction architecture.

---

# 41. RLS TESTS

Use real PostgreSQL, not mocks.

Required:

```text
Tenant A context + Tenant A row -> allowed
Tenant A context + Tenant B row -> blocked
Tenant B context + Tenant A row -> blocked
No tenant context -> blocked
Invalid tenant context -> blocked
```

---

# 42. DATABASE PRIVILEGES

Inspect PostgreSQL roles.

Separate:

```text
migration/admin
application
```

Do not give application role unnecessary superuser/admin privileges.

Follow SRS database role/grant rules.

---

# 43. PHASE 8 — TERMINAL / DEVICE IDENTITY

Human users and terminals are different identities.

Conceptually:

```text
Tenant
 ↓
Branch
 ↓
Terminal
```

Do not model:

```text
terminal = user
```

Implement terminal identity according to the SRS and approved schema.

---

# 44. DEVICE CREDENTIALS

If required:

- cryptographically secure;
- hashed/securely stored;
- revocable;
- rotatable;
- tenant/branch scoped;
- auditable.

Do not invent an offline protocol.

Before implementing offline authentication, read the SRS offline/sync chapter and follow it exactly.

If it is genuinely ambiguous, stop and report the ambiguity.

---

# 45. PHASE 9 — PASSWORD CHANGE

If required:

```http
POST /auth/change-password
```

Flow:

```text
authenticated user
 ↓
verify current password
 ↓
validate new password
 ↓
Argon2id hash
 ↓
transactional credential update
 ↓
apply session invalidation policy
```

Do not log passwords.

---

# 46. PHASE 10 — PASSWORD RESET

If required:

```text
forgot password
 ↓
random reset token
 ↓
store token hash + expiry
 ↓
delivery mechanism
 ↓
verify token
 ↓
change password
 ↓
invalidate token
```

Do not reveal account existence.

Do not store reset token plaintext.

---

# 47. PHASE 11 — RATE LIMITING

Protect at minimum:

```text
POST /auth/login
POST /auth/refresh
POST /auth/forgot-password
POST /auth/reset-password
```

Use existing project infrastructure if present.

Otherwise use NestJS throttling.

Do not rely exclusively on IP.

---

# 48. PHASE 12 — AUDIT

Use the existing Governance/Audit abstraction if present.

Do not create a competing audit system.

Potential events:

```text
LOGIN_SUCCESS
LOGIN_FAILURE
LOGOUT
SESSION_REVOKED
REFRESH_TOKEN_ROTATED
REFRESH_TOKEN_REUSE_DETECTED
PASSWORD_CHANGED
PASSWORD_RESET_REQUESTED
PASSWORD_RESET_COMPLETED
USER_SUSPENDED
TERMINAL_REGISTERED
TERMINAL_REVOKED
```

Never place credentials/tokens in audit payloads.

Follow the SRS append-only/hash-chain audit design.

---

# 49. TRANSACTIONS

Use DB transactions for operations that must be atomic.

Examples:

```text
create user + credential
login + session
refresh rotation
password change
password reset completion
membership/role assignment
```

Do not allow partially-valid identity states.

---

# 50. CONCURRENCY

Protect against races in:

```text
refresh token rotation
refresh reuse
session revocation
membership assignment
role assignment
permission assignment
```

Use:

- database constraints;
- transactions;
- appropriate locking/atomic updates.

Do not rely solely on application-level `if` checks when concurrent requests can race.

---

# 51. VALIDATION

Every external input uses DTO validation.

Validate:

```text
email
password
IDs
refresh token
reset token
role/permission assignment
tenant selection
```

Do not trust raw request values.

---

# 52. ERROR SEMANTICS

Use:

```text
400 invalid request
401 unauthenticated
403 authenticated but forbidden
404 appropriate resource-not-found cases
409 conflict
429 rate limited
```

Do not expose SQL errors or stack traces.

---

# 53. CORS / COOKIES

Inspect existing frontend/client architecture before deciding token transport.

If cookies are used, configure:

```text
HttpOnly
Secure in production
appropriate SameSite
CSRF protection where required
```

If explicit refresh tokens are used, document the client storage/security model.

Do not arbitrarily change the project's authentication transport.

---

# 54. TESTING — REQUIRED

The implementation is incomplete without tests.

Include:

```text
unit
integration
e2e
database/RLS
security
```

---

# 55. UNIT TEST MATRIX

Password:

```text
correct password
wrong password
hash generation
```

Login:

```text
valid credentials
unknown account
wrong password
disabled account
missing credential
```

JWT:

```text
valid
invalid signature
expired
malformed
```

Sessions:

```text
create
revoke
expire
refresh
rotate
reuse
```

Authorization:

```text
permission granted
permission denied
missing membership
wrong tenant
multiple memberships
multiple roles
```

---

# 56. E2E TEST MATRIX

Test actual HTTP endpoints:

```text
POST /auth/login
GET /auth/me
POST /auth/refresh
POST /auth/logout
```

Plus any additional implemented endpoints.

Verify:

```text
status
response shape
auth headers
failure semantics
```

---

# 57. MULTI-TENANT E2E

Create:

```text
Tenant A
Tenant B
User U
```

Give U only Tenant A.

Verify:

```text
U + Tenant A -> allowed
U + Tenant B -> denied
```

Then grant Tenant B membership.

Verify:

```text
U + Tenant B -> allowed
```

This test is mandatory.

---

# 58. SECURITY TESTS

Test:

```text
account enumeration
brute force
refresh token reuse
expired session
revoked session
tenant spoofing
permission spoofing
JWT tampering
missing tenant context
cross-tenant access
```

JWT tampering must result in:

```text
401
```

---

# 59. API DOCUMENTATION

If Swagger/OpenAPI exists, document all Auth endpoints.

At minimum:

```text
POST /auth/login
POST /auth/refresh
POST /auth/logout
GET /auth/me
```

Include:

```text
request
response
400
401
403
429
```

Never expose credential internals.

---

# 60. LOGGING

Safe:

```text
login failed
session revoked
refresh reuse detected
password changed
```

Unsafe:

```text
password=...
passwordHash=...
accessToken=...
refreshToken=...
```

Never log secrets.

---

# 61. MODULE BOUNDARIES

Identity must not directly access other bounded-context tables.

Do not do:

```typescript
prisma.order.findMany(...)
```

inside Identity.

Use approved module/application contracts/events.

The Modular Monolith boundary is architectural, not optional.

---

# 62. NO GOD SERVICE

Avoid one enormous service.

Separate responsibilities logically:

```text
AuthenticationService
CredentialService
SessionService
TenantMembershipService
AuthorizationService
RoleService
PermissionService
TerminalIdentityService
```

Use repository conventions/names already present.

---

# 63. NO GENERIC CRUD

Do not generate generic CRUD for every identity entity just because the database contains the table.

Implement domain operations required by the SRS.

---

# 64. SEEDING

If roles/permissions require seed data:

- use existing Prisma seed mechanism;
- make it idempotent;
- use stable permission codes;
- do not create duplicates;
- never create a hard-coded production password.

Inspect:

```bash
cat package.json
cat prisma/seed.ts 2>/dev/null || true
```

---

# 65. INITIAL ADMIN / BOOTSTRAP

If the SRS requires bootstrap:

- do not auto-create admin on every startup;
- do not hard-code a password;
- use controlled seed/bootstrap;
- require explicit credentials/configuration;
- make it idempotent.

---

# 66. PERFORMANCE

Keep authorization efficient.

Avoid:

```text
load every membership
load every role
load every permission
load unrelated data
```

on every request.

Use indexed queries and only retrieve the data needed.

Do not add caching before measuring a real bottleneck.

---

# 67. GIT CHECKPOINTS

Create incremental commits.

Examples:

```bash
git add .
git commit -m "feat(identity): add users and credentials"

git add .
git commit -m "feat(auth): implement password login"

git add .
git commit -m "feat(auth): add jwt authentication"

git add .
git commit -m "feat(auth): add sessions and refresh rotation"

git add .
git commit -m "feat(identity): add tenant memberships"

git add .
git commit -m "feat(identity): add rbac"

git add .
git commit -m "feat(identity): enforce tenant isolation"
```

Do not create one massive commit.

---

# 68. VALIDATION AFTER EVERY PHASE

Run the repository's equivalents of:

```bash
npx prisma format
npx prisma validate
npx prisma generate
npx prisma migrate status

npm run lint
npm run build
npm test
```

Run E2E tests where available:

```bash
npm run test:e2e
```

If scripts differ, inspect:

```bash
cat package.json
```

Do not knowingly proceed while the project is broken.

---

# 69. DESTRUCTIVE COMMAND RULE

Never automatically execute:

```bash
npx prisma migrate reset
DROP DATABASE
DROP SCHEMA
TRUNCATE
rm -rf
git reset --hard
```

If a destructive action becomes genuinely necessary, stop and ask for explicit approval.

Never destroy existing data just to make migrations pass.

---

# 70. STOP CONDITIONS

Stop and report instead of guessing when:

1. SRS contradicts the database design.
2. Existing repository architecture conflicts with the requested implementation.
3. ULID representation is ambiguous.
4. Offline authentication is genuinely underspecified.
5. RLS cannot safely be implemented with the current transaction architecture.
6. Existing Auth code conflicts with the new design.
7. A migration requires destructive data loss.
8. A security-critical decision is unspecified.
9. An external dependency/integration is missing.
10. You would have to invent a business rule.

---

# 71. PHASE EXECUTION PROTOCOL

Work through these phases in order:

```text
PHASE 0  Repository audit
PHASE 1  Dependencies/configuration
PHASE 2  Users/credentials
PHASE 3  Login/JWT
PHASE 4  Sessions/refresh/logout
PHASE 5  Tenants/memberships
PHASE 6  Roles/permissions
PHASE 7  Tenant context/authorization
PHASE 8  PostgreSQL RLS
PHASE 9  Terminal/device identity
PHASE 10 Password change/reset
PHASE 11 Rate limiting/security hardening
PHASE 12 Audit integration
PHASE 13 Full tests/documentation
PHASE 14 Final security review
```

At the end of each phase:

```text
1. format
2. validate
3. migrate/check DB
4. run tests
5. inspect diff
6. inspect changed files
7. summarize
8. continue only if healthy
```

---

# 72. FINAL ACCEPTANCE CRITERIA

Authentication:

```text
[ ] valid user can log in
[ ] invalid credentials rejected
[ ] inactive account rejected
[ ] password is Argon2id
[ ] password never returned/logged
[ ] access token expires
[ ] JWT tampering rejected
```

Sessions:

```text
[ ] session created
[ ] refresh token stored only as hash
[ ] refresh token rotates
[ ] old refresh token invalid
[ ] revoked session cannot refresh
[ ] expired session cannot refresh
[ ] reuse detected
```

Authorization:

```text
[ ] multiple tenant memberships
[ ] membership roles
[ ] role permissions
[ ] permission guard
[ ] 401 vs 403 correct
```

Tenant isolation:

```text
[ ] tenant cannot be spoofed
[ ] membership required
[ ] RLS enabled
[ ] RLS forced where required
[ ] cross-tenant read blocked
[ ] cross-tenant write blocked
[ ] missing tenant context blocked
```

Quality:

```text
[ ] migrations clean
[ ] Prisma validation passes
[ ] lint passes
[ ] build passes
[ ] unit tests pass
[ ] integration tests pass
[ ] e2e tests pass
[ ] RLS tests pass
[ ] no unrelated modules changed
```

---

# 73. FINAL REVIEW

Before completion run:

```bash
git status
git diff --stat
git diff
```

Review every changed file.

Verify:

```text
No hard-coded secrets
No plaintext passwords
No plaintext refresh tokens
No credentials in logs
No tenant spoofing
No authorization bypass
No RLS bypass
No cross-module table access
No destructive migration
No unrelated refactor
No disabled tests
No unexplained any/@ts-ignore
```

---

# 74. FINAL REPORT

When done, report:

## Implementation

Every Auth capability implemented.

## Database

All migrations/tables/indexes/RLS policies added.

## API

All Auth endpoints.

## Security

Explain:

- Argon2id
- JWT
- refresh rotation
- session revocation
- tenant authorization
- RLS
- rate limiting
- audit

## Tests

Report:

```text
unit:
integration:
e2e:
RLS:
coverage:
```

## Files changed

List relevant files.

## Known limitations

Only real remaining limitations.

## Commands executed

List validation/test commands.

---

# 75. START

Now start with:

```text
PHASE 0 — REPOSITORY AUDIT
```

Do not write implementation code before inspecting the repository and the ROS SRS/database design.

After the audit, proceed phase-by-phase.

You are allowed to modify the repository, but you must preserve the architecture, protect data, and never guess about security-critical requirements.

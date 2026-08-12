# ROS — Authentication & Authorization Implementation Guide
## Manual implementation reference — NestJS + Prisma + PostgreSQL

> **Purpose:** This document is a hands-on implementation guide for building the ROS Identity/Auth foundation manually, without having an AI generate the implementation for you.
>
> **Source of truth:** ROS SRS v1.0 and the approved ROS database design. Where this guide gives an implementation choice, the SRS/ADR decisions take priority.
>
> **Important:** This guide intentionally explains *what to build, why it exists, commands to run, checks to perform, and how the pieces connect*. It does not ask an AI to generate the system for you.

---

# 0. Definition of Done

Do not consider Auth complete until all of these work:

- [ ] User can be created with an Argon2id password hash.
- [ ] Plain-text passwords are never stored.
- [ ] Login verifies credentials without revealing whether an email exists.
- [ ] Access tokens are short-lived.
- [ ] Refresh tokens are long-lived, stored only as hashes, and rotated.
- [ ] Sessions can be revoked.
- [ ] `/auth/me` identifies the authenticated user.
- [ ] Tenant membership is explicit.
- [ ] A user can belong to multiple tenants with different roles.
- [ ] Roles resolve to permissions.
- [ ] Permission checks return `403` when access is denied.
- [ ] Authentication failures return `401`.
- [ ] Tenant context cannot be selected arbitrarily by the client.
- [ ] PostgreSQL RLS protects tenant-scoped data.
- [ ] Cross-tenant access tests fail as expected.
- [ ] Terminal/device identity is kept separate from human identity.
- [ ] Sensitive auth events are auditable.
- [ ] Rate limiting/brute-force protection exists before production.
- [ ] Secrets are supplied through environment/secret management.
- [ ] Auth tests cover happy paths and abuse paths.

---

# 1. Architecture

ROS Auth is not just email + password.

```text
                         CLIENT
                 Web / POS / KDS
                       |
                       v
              +------------------+
              | Authentication   |
              | login / refresh  |
              | logout / reset   |
              +--------+---------+
                       |
                       v
              +------------------+
              | User / Session   |
              | Identity         |
              +--------+---------+
                       |
                       v
              +------------------+
              | Tenant Membership|
              +--------+---------+
                       |
                       v
              +------------------+
              | Role             |
              | Permission       |
              +--------+---------+
                       |
                       v
              +------------------+
              | Tenant Context   |
              +--------+---------+
                       |
                       v
              +------------------+
              | PostgreSQL RLS   |
              +------------------+
```

Authentication answers:

> Who are you?

Authorization answers:

> What can you do?

Tenant isolation answers:

> Which tenant's data are you allowed to operate on?

These are three separate concerns.

---

# 2. ROS-specific identity model

Use this mental model:

```text
User
 |
 +---- Membership ---- Tenant
 |                       |
 |                       +---- Roles
 |                              |
 |                              +---- Permissions
 |
 +---- Sessions
 |
 +---- Credentials

Terminal / Device
 |
 +---- belongs to Tenant / Branch
 |
 +---- may have its own device identity
```

A user must NOT simply have one global `role_id`.

A user may have:

```text
Ahmed
 |
 +-- Restaurant A -> Owner
 |
 +-- Restaurant B -> Branch Manager
```

This is why the system uses memberships.

---

# 3. Recommended implementation order

Implement in this exact order:

```text
01. Project inspection
02. Identity database tables
03. Prisma migration
04. User creation
05. Argon2id password hashing
06. Login
07. JWT access token
08. JWT authentication guard
09. /auth/me
10. Sessions
11. Refresh token rotation
12. Logout / revocation
13. Tenant
14. Membership
15. Roles
16. Permissions
17. Permission guard
18. Tenant context
19. PostgreSQL RLS
20. Terminal/device identity
21. Password reset/change
22. Rate limiting
23. Audit events
24. Security tests
25. Integration tests
```

**Do not skip ahead because a later feature looks easy.**

---

# 4. Before touching code

## 4.1 Verify versions

Run:

```bash
node -v
npm -v
npx nest --version
npx prisma -v
psql --version
```

Also inspect:

```bash
cat package.json
cat prisma/schema.prisma
```

Check:

```bash
git status
git branch --show-current
```

Create a checkpoint:

```bash
git add .
git commit -m "chore: checkpoint before identity auth implementation"
```

If the repository is not clean, understand the existing changes before continuing.

---

# 5. Required packages

Only install packages that are actually needed.

For Argon2id:

```bash
npm install argon2
```

For Nest JWT:

```bash
npm install @nestjs/jwt
```

For validation, if not already installed:

```bash
npm install class-validator class-transformer
```

If rate limiting is not already present:

```bash
npm install @nestjs/throttler
```

Do not blindly install alternative authentication libraries. The goal is to understand and own the implementation.

---

# 6. Environment variables

Create/update `.env` locally.

Example:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB"

JWT_ACCESS_SECRET="GENERATE_A_LONG_RANDOM_SECRET"
JWT_ACCESS_TTL="15m"
JWT_REFRESH_TTL="30d"
```

Generate a strong secret on macOS/Linux:

```bash
openssl rand -base64 64
```

Do not commit `.env`.

Verify:

```bash
git status
```

Make sure `.env` is ignored.

Production secrets must come from the deployment secret manager, not source control.

---

# 7. Identity database — first slice

Do NOT create every ROS table now.

Create the first identity slice:

```text
identity.users
identity.credentials
```

Later:

```text
identity.sessions
identity.tenants
identity.memberships
identity.roles
identity.permissions
identity.role_permissions
identity.membership_roles
identity.terminals
```

The exact columns must follow the approved ROS database design.

---

# 8. User entity

Conceptually:

```text
users
----------------
id
email
display_name
status
created_at
updated_at
```

Important rules:

- `email` must have a uniqueness policy.
- Decide whether email normalization is part of the domain rule.
- User status must be explicit.
- Never store a password here.

Example Prisma shape:

```prisma
model User {
  id          String     @id
  email       String     @unique
  displayName String?
  status      UserStatus @default(ACTIVE)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  credential Credential?

  @@map("users")
  @@schema("identity")
}

enum UserStatus {
  ACTIVE
  SUSPENDED
  DISABLED

  @@schema("identity")
}
```

**Do not copy this blindly if your approved schema uses different ID/database types.**

---

# 9. Credential entity

Conceptually:

```text
credentials
----------------
id
user_id
password_hash
created_at
updated_at
```

Relationship:

```text
User 1 ---- 1 Credential
```

The database contains:

```text
Argon2id(password)
```

Never:

```text
password
```

---

# 10. Create the migration

After updating Prisma:

```bash
npx prisma format
npx prisma validate
```

Then:

```bash
npx prisma migrate dev --name identity_users_credentials
```

Inspect:

```bash
npx prisma migrate status
```

Open Prisma Studio if useful:

```bash
npx prisma studio
```

Verify the actual PostgreSQL schemas/tables.

---

# 11. User creation

Create a service method that does:

```text
input password
     |
     v
validate password policy
     |
     v
Argon2id hash
     |
     v
create user
     |
     v
create credential
```

Do not hash passwords in controllers.

Controller:

```text
HTTP input
   |
   v
DTO validation
   |
   v
Service
   |
   v
Password hashing
   |
   v
Repository/Prisma
```

---

# 12. Password hashing with Argon2id

Install:

```bash
npm install argon2
```

Hash:

```typescript
import * as argon2 from 'argon2';

const passwordHash = await argon2.hash(password, {
  type: argon2.argon2id,
});
```

Verify:

```typescript
const valid = await argon2.verify(
  passwordHash,
  password,
);
```

Never log:

```text
password
passwordHash
accessToken
refreshToken
```

Do not put any of them in application logs.

---

# 13. Password policy

Define a policy before production.

At minimum:

- minimum length
- reject obviously compromised/common passwords
- do not require arbitrary complexity rules that make passwords harder without meaningful benefit
- do not silently truncate passwords
- rate-limit repeated login failures

The exact policy should be recorded as a project decision.

---

# 14. Build the Identity module

Recommended structure:

```text
src/
└── modules/
    └── identity/
        ├── identity.module.ts
        │
        ├── auth/
        │   ├── auth.controller.ts
        │   ├── auth.service.ts
        │   ├── guards/
        │   ├── strategies/
        │   ├── decorators/
        │   └── dto/
        │
        ├── users/
        │   ├── users.service.ts
        │   └── users.repository.ts
        │
        ├── credentials/
        │   └── credentials.service.ts
        │
        ├── sessions/
        │   ├── sessions.service.ts
        │   └── sessions.repository.ts
        │
        ├── tenants/
        ├── memberships/
        ├── roles/
        ├── permissions/
        └── terminals/
```

Keep domain responsibilities separated.

---

# 15. Login

Endpoint:

```http
POST /auth/login
```

Input:

```json
{
  "email": "user@example.com",
  "password": "..."
}
```

Flow:

```text
Controller
  |
  v
DTO validation
  |
  v
AuthService
  |
  v
Find user
  |
  +--> not found -> generic 401
  |
  v
Check status
  |
  +--> inactive -> generic 401
  |
  v
Load credential
  |
  v
Argon2 verify
  |
  +--> invalid -> generic 401
  |
  v
Create session
  |
  v
Issue tokens
```

Never return:

```text
"email does not exist"
```

Use a generic credential failure.

---

# 16. JWT access token

Use a short TTL.

Recommended starting point:

```text
15 minutes
```

Payload should remain small.

Example:

```json
{
  "sub": "USER_ID",
  "sid": "SESSION_ID",
  "iat": 1234567890,
  "exp": 1234568790
}
```

Do NOT put the entire permission list into the JWT.

Permissions can change while a token is still alive.

Do not put secrets or sensitive personal data in JWT payloads.

---

# 17. JWT signing secret

Do not do:

```typescript
secret: 'secret123'
```

Use configuration:

```typescript
JwtModule.register({
  secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
});
```

Prefer Nest's `ConfigModule`:

```bash
npm install @nestjs/config
```

If not already installed.

---

# 18. JWT Guard

The guard's responsibility:

```text
Authorization header
       |
       v
Bearer token
       |
       v
verify signature
       |
       v
check expiration
       |
       v
extract sub/sid
       |
       v
request.user
```

A valid JWT does NOT mean:

```text
"this user can do anything"
```

It only establishes authentication.

---

# 19. `/auth/me`

Endpoint:

```http
GET /auth/me
Authorization: Bearer <access-token>
```

Flow:

```text
JWT Guard
   |
   v
request.user
   |
   v
UsersService
   |
   v
current user
```

Return only fields appropriate for the client.

Never return:

```text
password_hash
refresh_token_hash
security secrets
```

---

# 20. Sessions

Create:

```text
identity.sessions
```

Conceptually:

```text
id
user_id
tenant_id       -- when tenant context is established by the design
refresh_token_hash
expires_at
revoked_at
created_at
last_used_at
ip_address
user_agent
```

Check the approved database design before deciding which columns are mandatory.

A session represents an authenticated client session.

---

# 21. Refresh token generation

Generate a cryptographically random opaque token.

Do not use:

```text
user_id
timestamp
email
predictable random values
```

Use Node's cryptographic random generator.

Conceptually:

```typescript
import { randomBytes } from 'node:crypto';

const refreshToken = randomBytes(64).toString('base64url');
```

Store only a hash of it.

---

# 22. Refresh token storage

Never:

```text
sessions.refresh_token = actual_token
```

Instead:

```text
actual refresh token
        |
        v
secure hash
        |
        v
sessions.refresh_token_hash
```

The client receives the actual token.

The database does not.

---

# 23. Refresh token endpoint

Endpoint:

```http
POST /auth/refresh
```

Flow:

```text
Refresh Token
      |
      v
Find candidate session
      |
      v
Verify token against stored hash
      |
      v
Check not revoked
      |
      v
Check not expired
      |
      v
Rotate refresh token
      |
      +---- revoke/replace previous credential
      |
      v
Issue new access token
      |
      v
Issue new refresh token
```

---

# 24. Refresh token rotation

Never allow one refresh token to live forever.

Example:

```text
RT1
 |
 +--> refresh
       |
       +--> RT1 invalidated
       +--> RT2 issued
```

Then:

```text
RT2 -> RT3
RT3 -> RT4
```

If an old token is reused, treat it as a security event and follow the session-reuse policy defined by the project.

---

# 25. Logout

Endpoint:

```http
POST /auth/logout
```

The server revokes the current session.

Conceptually:

```sql
UPDATE identity.sessions
SET revoked_at = NOW()
WHERE id = $session_id;
```

Do not rely on deleting the access token from the browser/client as the security mechanism.

The server controls session validity.

---

# 26. Multi-tenant model

After basic authentication works, add:

```text
identity.tenants
identity.memberships
```

Conceptually:

```text
users
  |
  | 1:N
  v
memberships
  |
  | N:1
  v
tenants
```

Example:

```text
Ahmed
 |
 +-- membership --> Restaurant A
 |
 +-- membership --> Restaurant B
```

Membership is the tenant-specific relationship.

---

# 27. Tenant selection

Do not trust:

```http
X-Tenant-Id: someone_else_tenant
```

just because it exists in a request.

The server must establish:

```text
authenticated user
      |
      v
valid membership
      |
      v
allowed tenant
      |
      v
tenant context
```

If a user is a member of multiple tenants, the system needs an explicit tenant-selection flow.

The selected tenant must always be checked against the user's memberships.

---

# 28. Roles

Create:

```text
identity.roles
```

Roles belong to the authorization model, not authentication.

Examples:

```text
OWNER
BRANCH_MANAGER
CASHIER
KITCHEN_MANAGER
ACCOUNTANT
INVENTORY_MANAGER
```

Do not hard-code these role names throughout the codebase.

The SRS/domain rules are the source of truth.

---

# 29. Permissions

Create:

```text
identity.permissions
```

Permission codes should be stable machine identifiers.

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

Avoid:

```text
if user.role === 'manager'
```

throughout the code.

Prefer:

```text
if user has permission('orders.refund')
```

---

# 30. Role → Permission

Create:

```text
role_permissions
```

Relationship:

```text
Role
 |
 +--- Permission
 +--- Permission
 +--- Permission
```

Example:

```text
BRANCH_MANAGER
    |
    +-- orders.read
    +-- orders.create
    +-- orders.refund
    +-- inventory.read
```

---

# 31. Membership → Role

Create:

```text
membership_roles
```

Why?

Because:

```text
User
```

does not globally have:

```text
Manager
```

Instead:

```text
User
  |
  +-- Membership A
  |      |
  |      +-- Branch Manager
  |
  +-- Membership B
         |
         +-- Viewer
```

---

# 32. Permission guard

Create a decorator conceptually:

```typescript
@RequirePermission('orders.refund')
```

Then:

```text
Request
  |
  v
JwtAuthGuard
  |
  v
TenantContextGuard
  |
  v
PermissionGuard
  |
  +--> allowed -> Controller
  |
  +--> denied -> 403
```

Use:

- `401 Unauthorized` when authentication is missing/invalid.
- `403 Forbidden` when authenticated but not authorized.

---

# 33. Request context

You eventually need a consistent request context:

```text
request.user
request.session
request.tenant
request.membership
request.terminal
```

Do not let every service independently interpret headers and tokens.

Centralize context construction in guards/interceptors/services.

---

# 34. PostgreSQL RLS

RLS is a database-level defense.

The goal:

```text
Tenant A request
       |
       v
PostgreSQL
       |
       +--> Tenant A rows
       |
       X    Tenant B rows
```

For a tenant-scoped table:

```sql
ALTER TABLE some_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE some_table FORCE ROW LEVEL SECURITY;
```

Then a policy can use the transaction-local tenant context.

Conceptually:

```sql
CREATE POLICY tenant_isolation
ON some_table
USING (
  tenant_id = current_setting(
    'app.tenant_id',
    true
  )::uuid
);
```

Use the exact ID type and RLS pattern from the approved ROS schema.

---

# 35. Setting tenant context

The application should establish the tenant context inside the database transaction.

Conceptually:

```sql
SET LOCAL app.tenant_id = 'TENANT_ID';
```

`SET LOCAL` is important because the setting is transaction-scoped.

Do not use a globally persistent database session setting for request-specific tenant identity.

---

# 36. RLS testing

Create at least these tests:

```text
Tenant A + Tenant A row -> allowed
Tenant A + Tenant B row -> blocked
Tenant B + Tenant A row -> blocked
No tenant context -> blocked
Invalid tenant context -> blocked
```

Do not trust an RLS implementation until these tests exist.

---

# 37. Database roles and privileges

RLS is not a substitute for proper database privileges.

Your architecture should distinguish:

```text
application database role
migration/admin role
```

The application role should have only the privileges required by the application.

Review the SRS/ADR requirements before finalizing PostgreSQL grants.

---

# 38. Terminal / POS identity

Human users and POS terminals are different concepts.

Example:

```text
Tenant
 |
 Branch
 |
 +-- POS-001
 +-- POS-002
 +-- POS-003
```

A terminal should have its own identity/registration lifecycle.

Do not make:

```text
terminal_id = user_id
```

A terminal is not a person.

---

# 39. POS authentication model

A possible model:

```text
Terminal registration
        |
        v
Device credential
        |
        v
Human employee authentication
        |
        v
User + Tenant + Branch + Terminal context
```

The exact offline behavior must follow the SRS offline/sync requirements.

Do not invent an offline authentication mechanism that contradicts the SRS.

---

# 40. Password change

Endpoint:

```http
POST /auth/change-password
```

Flow:

```text
authenticated user
       |
       v
verify current password
       |
       v
validate new password
       |
       v
hash new password
       |
       v
replace credential
       |
       v
apply session revocation policy
```

Decide explicitly whether changing a password revokes:

```text
current session only
all other sessions
all sessions
```

For a production security posture, revoking other active sessions is often appropriate, but record the exact project decision.

---

# 41. Password reset

Do not build password reset as:

```text
email + new password
```

Use a short-lived, single-use reset credential.

Flow:

```text
forgot password
      |
      v
create random reset token
      |
      v
store hash + expiry
      |
      v
send reset link
      |
      v
verify token
      |
      v
change password
      |
      v
invalidate token
```

Do not reveal whether an account exists.

---

# 42. Rate limiting

Protect at minimum:

```text
POST /auth/login
POST /auth/refresh
POST /auth/forgot-password
POST /auth/reset-password
```

Install if needed:

```bash
npm install @nestjs/throttler
```

Rate-limit by a strategy appropriate to the endpoint, potentially including:

```text
IP
account identifier
device/terminal
```

Do not rely solely on IP because users can share an IP and attackers can rotate IPs.

---

# 43. Security logging / audit

Authentication events worth recording include:

```text
LOGIN_SUCCESS
LOGIN_FAILURE
LOGOUT
SESSION_REVOKED
REFRESH_ROTATED
REFRESH_REUSE_DETECTED
PASSWORD_CHANGED
PASSWORD_RESET_REQUESTED
PASSWORD_RESET_COMPLETED
USER_SUSPENDED
```

Never put:

```text
password
password hash
refresh token
access token
```

in the audit payload.

The governance/audit design in the SRS is the source of truth for the final audit implementation.

---

# 44. Error handling

Use consistent semantics.

### 401

```text
missing token
invalid token
expired token
invalid credentials
revoked session
```

### 403

```text
authenticated user
but permission denied
```

### 400

```text
malformed input
validation failure
```

Do not leak internal database errors to clients.

---

# 45. Common mistakes to avoid

## Mistake 1

Putting password on `users`.

Wrong:

```text
users.password
```

Use:

```text
credentials.password_hash
```

---

## Mistake 2

Putting all permissions in JWT.

Avoid.

Permissions can change while JWT remains valid.

---

## Mistake 3

Trusting `tenant_id` from frontend.

Never.

Validate membership server-side.

---

## Mistake 4

Only using application-level tenant filtering.

Bad:

```sql
SELECT *
FROM orders
WHERE tenant_id = ?
```

Application authorization should exist, but ROS also requires database-level isolation through RLS.

---

## Mistake 5

Storing refresh tokens in plaintext.

Don't.

---

## Mistake 6

Using one global role on User.

Avoid:

```text
users.role_id
```

for tenant-specific authorization.

---

## Mistake 7

Returning different errors for unknown email vs wrong password.

Avoid account enumeration.

---

## Mistake 8

Putting secrets in Git.

Check:

```bash
git diff
git status
```

before commits.

---

# 46. Manual implementation checklist

## Phase A — Foundation

- [ ] Inspect existing NestJS structure
- [ ] Inspect Prisma setup
- [ ] Verify PostgreSQL connection
- [ ] Verify Git state
- [ ] Add required packages
- [ ] Configure environment variables

Commands:

```bash
node -v
npm -v
npx prisma -v
npx prisma validate
npx prisma migrate status
```

---

## Phase B — Identity

- [ ] Create `identity` schema
- [ ] Create `users`
- [ ] Create `credentials`
- [ ] Add constraints
- [ ] Add indexes
- [ ] Run migration
- [ ] Verify in PostgreSQL
- [ ] Create user service
- [ ] Implement Argon2id
- [ ] Test password verification

---

## Phase C — Authentication

- [ ] Login DTO
- [ ] Login controller
- [ ] Login service
- [ ] JWT module
- [ ] JWT strategy/verification
- [ ] Auth guard
- [ ] `/auth/me`

---

## Phase D — Sessions

- [ ] Sessions table
- [ ] Random refresh token generation
- [ ] Hash refresh token
- [ ] Store hash
- [ ] Refresh endpoint
- [ ] Rotation
- [ ] Revocation
- [ ] Logout
- [ ] Reuse detection

---

## Phase E — Authorization

- [ ] Tenants
- [ ] Memberships
- [ ] Roles
- [ ] Permissions
- [ ] Role-permission mapping
- [ ] Membership-role mapping
- [ ] Tenant selection/context
- [ ] Permission decorator
- [ ] Permission guard

---

## Phase F — Isolation

- [ ] RLS
- [ ] FORCE RLS
- [ ] Tenant transaction context
- [ ] Database grants
- [ ] Cross-tenant integration tests

---

## Phase G — ROS client identity

- [ ] Terminals
- [ ] Device credentials
- [ ] Terminal registration
- [ ] Branch association
- [ ] User + terminal context
- [ ] Offline authentication behavior according to SRS

---

## Phase H — Security hardening

- [ ] Rate limiting
- [ ] Password reset
- [ ] Password change
- [ ] Audit events
- [ ] Session management
- [ ] Security headers/CORS review
- [ ] Secret management
- [ ] Logging review
- [ ] Dependency audit

---

# 47. Testing commands

Basic:

```bash
npm test
```

Watch:

```bash
npm run test:watch
```

Coverage:

```bash
npm run test:cov
```

E2E if configured:

```bash
npm run test:e2e
```

Before committing:

```bash
npm run lint
npm run build
npm test
```

Check Prisma:

```bash
npx prisma validate
npx prisma migrate status
```

---

# 48. Minimum Auth test matrix

| Test | Expected |
|---|---|
| Valid login | 200 |
| Unknown email | 401 |
| Wrong password | 401 |
| Disabled user | 401 |
| Missing JWT | 401 |
| Invalid JWT | 401 |
| Expired JWT | 401 |
| Valid `/auth/me` | 200 |
| Valid refresh | 200 |
| Expired refresh | 401 |
| Revoked session refresh | 401 |
| Reused refresh token | Security response / session invalidation policy |
| Logout | Session revoked |
| Missing permission | 403 |
| Valid permission | Allowed |
| User outside tenant | 403/404 according to resource policy |
| Tenant A reading Tenant B | Blocked |
| No RLS tenant context | Blocked |

---

# 49. Manual debugging workflow

When something fails, do not immediately ask AI to rewrite everything.

Use this sequence:

```text
1. Read the exact error.
2. Identify the layer.
3. Reproduce the smallest case.
4. Inspect database state.
5. Inspect request headers/body.
6. Inspect guard output.
7. Inspect service input/output.
8. Check transaction boundaries.
9. Fix one layer.
10. Run tests again.
```

Classify the problem:

```text
Database
Prisma
HTTP/DTO
Authentication
Authorization
Tenant context
RLS
Session
Configuration
Infrastructure
```

This prevents random changes.

---

# 50. Useful PostgreSQL commands

Connect:

```bash
psql "$DATABASE_URL"
```

List schemas:

```sql
\dn
```

List tables:

```sql
\dt identity.*
```

Describe a table:

```sql
\d identity.users
```

Check RLS:

```sql
SELECT
    schemaname,
    tablename,
    rowsecurity,
    forcerowsecurity
FROM pg_tables
WHERE schemaname = 'identity';
```

List policies:

```sql
SELECT *
FROM pg_policies
WHERE schemaname = 'identity';
```

Exit:

```sql
\q
```

---

# 51. Useful Prisma commands

Format:

```bash
npx prisma format
```

Validate:

```bash
npx prisma validate
```

Generate client:

```bash
npx prisma generate
```

Migration status:

```bash
npx prisma migrate status
```

Create development migration:

```bash
npx prisma migrate dev --name <migration_name>
```

Open Studio:

```bash
npx prisma studio
```

Inspect database into Prisma:

```bash
npx prisma db pull
```

Do not casually use:

```bash
npx prisma db push
```

for a migration-driven production architecture. Understand when it is appropriate before using it.

---

# 52. Git checkpoints

Create a commit after each stable milestone.

Suggested commits:

```bash
git add .
git commit -m "feat(identity): add user and credential persistence"

git add .
git commit -m "feat(auth): add password authentication"

git add .
git commit -m "feat(auth): add jwt authentication"

git add .
git commit -m "feat(auth): add session and refresh token rotation"

git add .
git commit -m "feat(identity): add tenant memberships"

git add .
git commit -m "feat(identity): add roles and permissions"

git add .
git commit -m "feat(auth): add tenant authorization"

git add .
git commit -m "feat(identity): add postgres row level security"
```

If a milestone breaks later, you can return to the last known-good state.

---

# 53. What to implement first — exact task

Your immediate task is NOT JWT.

Start here:

```text
TASK 01
Create identity.users
Create identity.credentials
Create Prisma models
Create migration
Verify database
```

Then:

```text
TASK 02
Implement user creation
Implement Argon2id
Create one test user
Verify stored hash
```

Then:

```text
TASK 03
Implement POST /auth/login
Verify password
Return temporary user identity
```

Then JWT.

Do not move to the next task until the current task works.

---

# 54. How to use this document while coding

For every task:

```text
READ
  ↓
UNDERSTAND
  ↓
IMPLEMENT YOURSELF
  ↓
RUN COMMAND
  ↓
VERIFY RESULT
  ↓
WRITE TEST
  ↓
COMMIT
  ↓
NEXT TASK
```

Do not ask an AI:

```text
"Build the whole Auth module."
```

If you use AI while learning, use it as a reviewer/debugger:

```text
"I implemented X.
Here is my code.
Here is the error.
Explain the root cause.
Do not rewrite the entire module."
```

That keeps you in control of the architecture and implementation.

---

# 55. Final architecture target

When the Auth foundation is complete, you should be able to explain this flow yourself:

```text
Client
  |
  | credentials
  v
POST /auth/login
  |
  v
AuthService
  |
  +--> User
  |
  +--> Credential
  |
  +--> Argon2id
  |
  v
Session
  |
  +--> Access Token
  |
  +--> Refresh Token
              |
              v
       hashed in database


Authenticated request
  |
  v
JWT Guard
  |
  v
User + Session
  |
  v
Tenant Membership
  |
  v
Tenant Context
  |
  v
Permission Guard
  |
  v
Controller
  |
  v
Service
  |
  v
PostgreSQL transaction
  |
  v
RLS
  |
  v
Tenant-scoped data
```

That is the foundation for the rest of ROS.

---

# 56. Final rule

Do not optimize for:

> "How fast can I finish Auth?"

Optimize for:

> "Can I explain every security decision and every request path in Auth?"

If the answer is yes, the implementation is doing its job.

The database schema, SRS ADRs, and domain rules remain the authoritative sources. This guide is an implementation workflow, not a replacement for those documents.

# Organisation — Phase 15 security review

Verified against the running database and the passing test suites.

| Check | Result |
|---|---|
| No `tenantId` accepted from any client | ✔ no DTO declares it; `forbidNonWhitelisted` → 400 (e2e) |
| No cross-tenant IDOR / BOLA | ✔ cross-tenant reads/updates/status changes → 404 (e2e) |
| RLS active on every new table | ✔ 9/9 `ENABLE` + `FORCE` (`pg_class`) |
| Policies present | ✔ 36 (4 per table, `pg_policies`) |
| Missing tenant context fails closed | ✔ 0 rows on all org tables as `ros_app` with no context |
| Cross-tenant INSERT spoof rejected | ✔ `new row violates row-level security policy` |
| `ros_app` has no BYPASSRLS | ✔ unchanged (`rolbypassrls = f`) |
| No migrator runtime path | ✔ runtime uses `APP_DATABASE_URL`; `env.validation` rejects `ros_migrator` there |
| Cross-tenant parenting impossible | ✔ 5 composite FKs; 7 e2e cases → 404 |
| Cross-branch terminal display rejected (D-16) | ✔ e2e → 404 |
| Uniqueness cannot leak other tenants' names | ✔ every key is tenant/branch-prefixed; same brand name in two tenants both succeed (e2e) |
| Branch-level print default de-duplicated | ✔ `NULLS NOT DISTINCT`; duplicate → 409 (e2e) |
| Authorization runs before mutation | ✔ `PermissionGuard` in the guard chain; read-only token → 403 on write |
| Audit contains no secrets | ✔ existing `sanitizeMetadata`; metadata is ids/names only |
| Audit is mandatory for FR-PLT-004 | ✔ `record(tx, …)` in-transaction, not best-effort `emit` |
| Reads are not audited | ✔ asserted in e2e |
| No global mutable state / AsyncLocalStorage | ✔ none introduced |
| Existing Auth behaviour unchanged | ✔ full Phase 1–14 suites pass |

## Accepted, documented limitations

1. **Intra-tenant authorization gap** — branch-scoped RBAC deferred (D-02);
   FR-SEC-002/003/004 [M] unimplemented. See `authorization.md`.
2. **Access-token revocation window** — a revoked session's access token stays
   valid ≤ 15 min (Phase 14 `P14-1`), so an Organisation mutation is possible in
   that window.
3. **No rate limiting on Organisation endpoints** — throttling is applied
   per-route to auth/password only; FR-PLT-015 [M] per-tenant API limiting is not
   implemented (audit F-M6).
4. **F-H1 self-grant path** — now reaches `settings.*` codes. Unresolved.
5. **`identity.tenants` / `users` have no RLS** (audit F-M7) — Organisation code
   never queries them unscoped; verified by review.

# PROD-AUTH-EXPIRY-P0 — Real session must refresh, never fall back to mock

**Report type:** Implementation / verification report
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document
records what was done and verified in this session only.
**Date:** 2026-09-06
**HEAD (backend, this task's parent):** `3e4f85c` (DEMO-SESSION-ISOLATION-HOTFIX, docs-only)
**HEAD (frontend, this task's parent):** `61651e1`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** Frontend touched `lib/api/session.ts`,
`lib/api/client.ts`, `lib/console/providers.tsx`. **No backend change** —
no contract gap was found or needed; the bug was entirely client-side
state management. Unrelated, concurrently-in-progress backend report files
(`PROD-DEMO-SMOKE`, `DEMO-GOLDEN-PATH-AUDIT`, two `GOLDEN-PATH-AUDIT`
reports) belong to other work and are left untouched by this task.
**Task identifier:** PROD-AUTH-EXPIRY-P0 (around access-token expiry
(~900s), a real session appeared to fall back to mock/sample identity and
data)

## REFRESH_BEFORE

`lib/api/client.ts`'s `refreshSession()` did a 3-step replay — base token
refresh (`POST /auth/refresh`) → tenant reselect (`POST /auth/tenant`) →
terminal rebind (`POST /auth/terminal`) — calling the shared `setTokens()`
after EACH step. `setTokens()` unconditionally called `announce()`
(the `onSessionChange` broadcast), so every intermediate step fired a
session-changed event, not just the final one. Concurrent refreshes were
already correctly coalesced by a `refreshInFlight` single-flight promise —
that part was not the bug.

## MOCK_FALLBACK_LOCATION

`lib/console/providers.tsx`, inside `SessionProvider`'s `useMemo<SessionValue>`:

```ts
const tenant = (live ? org.tenant : null) ?? tenants.find((t) => t.id === ACTIVE_TENANT_ID)!;
```

`tenants` here is the raw, unshadowed mock fixture import from
`lib/console/mock/org.ts` (`ACTIVE_TENANT_ID = "tnt_0001"`). Whenever
`org.tenant` was momentarily `null`/`undefined` while `live` and
`authenticated` were both still true — exactly what happens mid-refresh,
see ROOT_CAUSE — this `??` fell straight through to the mock tenant, which
`useMemo` then handed out as if it were the real one. Same file's
`brands`/`branches` derivations use the identical `live ? org.X : mockX`
shape but are locally SHADOWED (`const brands = live ? org.brands :
mockBrands;`) — they were never vulnerable. `tenants` (the raw import) was
the only unshadowed identifier, and the only leak found in this codebase
(confirmed by a full sweep of every `live ?` ternary in this file, and a
separate agent-run sweep of the rest of the frontend for the same
class of bug — see "Search sweep" below).

## CONSOLE_REFRESH_FLOW

Expired console token → `refreshSession()` (`activeSurface === "console"`,
so all reads/writes go through `ros.api.*` keys only) → `POST
/auth/refresh` with the console refresh token → **silent** `setTokens`
(no `announce()` yet) → tenant reselect (`POST /auth/tenant` using the
existing console `tenantId`) → silent `setTokens` → terminal rebind is
skipped (no `ros.api.terminalId`-scoped bind applies to a console session
in practice; the existing shared `terminalId` key, if present, is only
meaningful to a terminal surface) → **one** final `announceSessionChange()`.
Same Owner/Manager tenant remains active because the tenant reselect step
uses the SAME tenant id that was already active, and `useLiveOrgContext`'s
bootstrap only re-runs once, after the whole replay is done, against a
fully-restored token+tenant pair.

## TERMINAL_REFRESH_FLOW

Expired terminal token → `refreshSession()` reads/writes exclusively
through `ros.terminal.*` keys (`activeSurface === "terminal"`, set by
`app/(terminal)/layout.tsx`'s `<ConsoleProvider surface="terminal">`,
already in place from DEMO-SESSION-ISOLATION-HOTFIX). The refresh never
touches `ros.api.*` — verified by code inspection of `identityKeys()` in
`lib/api/session.ts`, which is a pure function of `activeSurface` with no
code path that reads the other surface's key set. POS/PIN identity
(`posEmployee`, `cashSessionId`) is untouched by any part of
`refreshSession()` — it never manipulates those shared, non-identity keys.

## ROOT_CAUSE

Two independent, compounding bugs:

1. **The mock leak** (see MOCK_FALLBACK_LOCATION) — a momentary
   `org.tenant === null/undefined` during any live-mode render (not only
   during refresh — any bootstrap tick where the org-context fetch hasn't
   resolved yet) fell through to a mock tenant object with no signal that
   this had happened.
2. **The race that produced the momentary null.** Each intermediate
   `setTokens()` call inside `refreshSession()`'s 3-step replay fired
   `announce()`, which synchronously updates `useLiveOrgContext`'s
   `tokenStamp` (via its `onSessionChange` listener) and schedules a
   re-render. Because `refreshSession()` is `async` and yields at each
   `await`, React could process that state update and re-run
   `useLiveOrgContext`'s effect — calling `loadContext()` again — **before**
   the full replay (tenant reselect, terminal rebind) had finished. That
   premature bootstrap could run against a token that had only completed
   step 1 of 3, could 401/403 on tenant-scoped calls, and `useLiveOrgContext`
   correctly degrades a failed fetch to "no tenant yet" (`org.tenant ===
   null`) — which is precisely the input the mock leak above needed to
   substitute a fake tenant in its place.

A third, related but independently-discovered gap: `authenticated`
(`ros.console.auth`, this surface's own "am I signed in" flag) was only
ever set by `signIn()`/`signOut()`; a **genuinely failed** refresh
(`clearSession()` called directly from `client.ts` after `POST
/auth/refresh` itself failed) never told `authenticated` about it. That
left `authenticated` stuck `true` with no real token behind it —
`ConsoleShell`'s `useAuthGuard()` redirect-to-`/login` never fired, and
the screen would show whatever the last real fetch had returned, frozen —
not the mock-tenant bug, but the same user-visible symptom class ("stale
identity presented as if live") the ticket's hard rule targets.

## FIX

**1. Eliminate the mock leak (`lib/console/providers.tsx`):**
```ts
const lastRealTenantRef = useRef<Tenant | null>(null);
if (live && org.tenant) lastRealTenantRef.current = org.tenant;
if (!authenticated) lastRealTenantRef.current = null;
...
const tenant =
  (live ? (org.tenant ?? lastRealTenantRef.current) : null) ??
  tenants.find((t) => t.id === ACTIVE_TENANT_ID)!;
```
A momentary `org.tenant` gap during a live, authenticated session now
holds the last confirmed-real tenant instead of falling through to the
mock fixture. The ref is cleared the moment `authenticated` goes false
(sign-out or the reconciliation effect below), so a genuinely new/failed
session never reuses a stale real tenant either. `tenant`'s type stays
non-nullable (avoided a ~29-call-site type change out of scope for this
ticket); the one remaining accepted gap is the true first-ever bootstrap
tick before any real tenant has ever loaded, which is not "recovery from
an expired session" and was judged out of scope.

**2. Eliminate the race (`lib/api/session.ts` + `lib/api/client.ts`):**
```ts
// session.ts
export function setTokens(tokens, options?: { silent?: boolean }): void {
  ...
  if (!options?.silent) announce();
}
export function announceSessionChange(): void { announce(); }
```
```ts
// client.ts — refreshSession()'s 3-step replay now calls
// setTokens(result, { silent: true }) at every intermediate step, and
// exactly one announceSessionChange() after the whole replay (including
// tenant reselect and terminal rebind) has completed.
```
`useLiveOrgContext` can no longer observe a partially-completed refresh —
it only ever re-bootstraps once, against the fully-restored token/tenant/
terminal state.

**3. Reconcile `authenticated` with real token loss
(`lib/console/providers.tsx`):**
```ts
useEffect(() => {
  if (!live) return;
  return onSessionChange(() => {
    if (!isSignedIn() && authenticated) {
      setAuthenticated(false);
      write(KEY_AUTH, "false");
    }
  });
}, [live, authenticated]);
```
`isSignedIn()` is already surface-aware (reads through `identityKeys()`),
so this only ever reacts to THIS provider's own surface losing its token
— a Console provider's effect never fires because a Terminal token
disappeared, and vice versa. When a refresh definitively fails,
`clearSession()` (already called from `client.ts`) removes the token,
the next `announce()`/`onSessionChange` tick observes `isSignedIn() ===
false`, and `authenticated` flips to `false` — `ConsoleShell`'s existing
`useAuthGuard()` then redirects to `/login` (Console) exactly as it
already does for a normal sign-out. No new redirect code was written; the
guard already existed and is now fed a correct signal.

## SINGLE_FLIGHT

`refreshInFlight` (pre-existing) was already correct for coalescing
concurrent callers of `refreshSession()` into one in-flight promise — no
change needed there. What was added is that the single in-flight refresh
now only broadcasts ONE session-change event at its very end, instead of
one per internal step, which is what stopped the bootstrap effect from
racing against its own middle.

## FAILED_REFRESH_BEHAVIOR

Unchanged code path, now correctly observed: `refreshSession()`'s `catch`
around the base `POST /auth/refresh` call calls `clearSession()` (surface-
scoped — clears only the active surface's own four identity keys, per
DEMO-SESSION-ISOLATION-HOTFIX) and returns `false`; no mock user/session is
selected anywhere in this path. The NEW reconciliation effect (fix #3)
ensures Console's `authenticated` flag catches up to that cleared state so
`useAuthGuard()` sends the browser to `/login`. Terminal has no equivalent
"authenticated" flag to reconcile — a terminal surface's own screens
already gate directly on `isSignedIn()`/`getPosEmployee()` (pre-existing,
unchanged), so a cleared terminal session already surfaces as "no PIN
session" without any new code.

## LIVE_MOCK_GATING

Full sweep of `lib/console/providers.tsx` (every `live ?` ternary in the
file): `brands`/`branches` — shadowed, safe. `scopeLocked` — a boolean, no
identity carried. `tenant` — the one real leak, now fixed (see FIX #1).
A separate background sweep of the rest of the frontend (`lib/`, `app/`,
`components/`) for the same bug class — unshadowed mock/fixture fallbacks
reachable in live mode, catch handlers that silently return mock data, and
any other mock-identity construction — found no further leaks;
`REGISTRATION_IS_WIRED` and `DemoAccountPicker` were re-confirmed benign/
properly `live`-gated (checked in an earlier ticket this session). All 9
`lib/console/mock/*.ts` fixture files and their 25 importers were checked:
every consumer is either a mock-only component never mounted in live mode
(each live route swaps in its own dedicated `Live*` component), or
`components/console/live-panels.tsx`, which gates every export on
`DATA_MODE` itself. `app/(auth)/login` and `reset-password` were checked
specifically as the highest-relevance auth-identity surfaces: their live
branch `return`s on both success and failure, making the demo-account
fallback structurally unreachable in live mode.

One pre-existing, **out-of-scope** gap was flagged during the sweep:
`app/(console)/finance/cash-sessions/page.tsx` still renders a separate,
pre-existing localStorage-simulated demo engine (`lib/console/live/
state.ts`/`store.tsx`) unconditionally, regardless of `DATA_MODE` — unlike
`kds/page.tsx`, which already gates the same engine behind `DATA_MODE ===
"http"`. This is a "page not yet converted to live data" gap (catalogue/
session-list data), not an error/expiry/failed-auth recovery path, so it
does not match this ticket's bug class and was left unchanged — worth a
separate, dedicated ticket.

## FILES_CHANGED

- `lib/api/session.ts` — `setTokens({ silent })`, `announceSessionChange()`.
- `lib/api/client.ts` — `refreshSession()`'s 3-step replay uses silent
  intermediate writes and one final `announceSessionChange()`.
- `lib/console/providers.tsx` — `lastRealTenantRef` last-known-good tenant
  pattern; `tenant` derivation updated; new `authenticated`/`isSignedIn()`
  reconciliation effect; `useRef`, `isSignedIn`, `onSessionChange` added to
  imports.

No backend file changed.

## TESTS

No frontend unit/component test harness exists in this repo (established
in every prior report this session — backend e2e only is the project's
test convention). Verified by direct trace, before and after, of: every
`live ?` ternary in `providers.tsx`; the full read/write path of
`identityKeys()`/`activeSurface` under a simulated refresh sequence (traced
step-by-step against the new silent-write code, not executed against a
running server); and the `onSessionChange` subscriber graph (`client.ts`'s
`announce()` call sites, `useLiveOrgContext`'s listener,
`providers.tsx`'s two listeners — the pre-existing hydration one and the
new reconciliation one). Controlled-expiry/expired-token-fixture testing
was considered per the ticket's explicit ask; no such fixture or harness
exists in this frontend project to build one against without introducing
a new, out-of-scope test infrastructure piece, so this was not built —
noted here rather than silently skipped.

## TYPECHECK

Clean (`npx tsc --noEmit`, zero errors) — after fixing one ordering defect
introduced during editing (`live` was referenced in the new reconciliation
effect's dependency array before its own `const live = ...` declaration;
moved the `const live` declaration above the effect).

## BUILD

Clean (`npm run build`) — all `(console)`/`(auth)`/`(terminal)` routes
prerender, no new build errors or warnings introduced.

## FRONTEND_COMMIT

Pending (this report is committed alongside the source change in one
frontend commit; see repository history for the exact SHA).

## BACKEND_COMMIT_IF_ANY

Report-only commit (no source change) — same pattern as the two
immediately preceding tickets (DEMO-POS-BRANCH-CONTEXT-HOTFIX,
DEMO-SESSION-ISOLATION-HOTFIX), since no backend contract gap was found or
needed.

## SAFE_TO_DEPLOY

Yes, with the one documented residual gap noted in FIX #1 (true
first-ever bootstrap before any real tenant has ever loaded still falls
back to the mock tenant fixture by design — this is the pre-existing demo
mode fallback path, not a live-session-expiry regression, and is outside
this ticket's stated scope of "recovery from an expired/failed real
session").

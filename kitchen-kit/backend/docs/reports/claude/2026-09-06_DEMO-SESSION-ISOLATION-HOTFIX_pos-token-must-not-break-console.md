# DEMO-SESSION-ISOLATION-HOTFIX — POS token must not break Console

**Report type:** Implementation / verification report
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document
records what was done and verified in this session only.
**Date:** 2026-09-06
**HEAD (backend, this task's parent):** `8fad55d` (DEMO-POS-BRANCH-CONTEXT-HOTFIX)
**HEAD (frontend, this task's parent):** `fd0cbd1`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** Frontend touched `lib/api/session.ts`,
`lib/console/providers.tsx`, `app/(terminal)/layout.tsx`,
`components/terminal/pos-live.tsx`. **No backend change** — no contract
gap was found or needed. Same pre-existing, unrelated `INDEX.md`/
`PROD-DEMO-SMOKE` items left untouched.
**Task identifier:** DEMO-SESSION-ISOLATION-HOTFIX (a PIN/POS login
silently replacing a signed-in Owner's dashboard token)

## Trace (the 10 items asked for)

1. **`lib/api/session.ts` token persistence** — a SINGLE global
   `localStorage` key set (`ros.api.accessToken`/`refreshToken`/
   `expiresAt`/`tenantId`), read/written by plain module functions with no
   notion of "which app is calling."
2. **Dashboard login** (`signIn`/`selectTenant` in `lib/api/auth.ts`) —
   called `setTokens`/`setTenantId` on that SAME shared slot.
3. **`POST /auth/pin`** (`signInWithPin`) — called the SAME `setTokens`/
   `setTenantId`, unconditionally overwriting whatever was already there.
4. **Terminal binding** (`bindTerminal`, used only by `/register-device`)
   — also the SAME `setTokens`.
5. **POS/KDS bootstrap** — `components/terminal/pos-live.tsx`'s `LivePos`
   calls `useSession()` (the SAME provider console pages use) for its
   `scope`, plus its own `getTerminalId()`/`bound = useAsync(api.terminals.list)`.
6. **Console bootstrap** — `SessionProvider`/`useLiveOrgContext` (`org/access`,
   `auth/permissions`, `auth/tenants`, `auth/tenant`), gated on a SEPARATE,
   already-namespaced `authenticated` flag (`localStorage` key
   `"ros.console.auth"`, set only by the real `/login` page's own
   `useSession().signIn(...)` call — confirmed NEVER touched by
   `signInWithPin`).
7. **Navigation** between `/dashboard`, `/pos`, `/kds` — all three mount
   the SAME `ConsoleProvider`/`SessionProvider` tree; nothing distinguished
   which route group was active.
8. **"Console" button** — a plain `<Link href="/dashboard">` in
   `components/terminal/chrome.tsx`.
9. **Logout** (`signOut`, in `lib/api/auth.ts`) — called from
   `components/console/switchers.tsx` only (confirmed: never from
   terminal code, which has its own lighter-weight "sign off" —
   `setPosEmployee(null)` directly, no token change).
10. **Refresh** — `lib/api/client.ts`'s shared `refreshSession()` rotates
    the base token, then REPLAYS `POST /auth/tenant` (using `getTenantId()`)
    and `POST /auth/terminal` (using `getTerminalId()`) unconditionally —
    the SAME shared-storage problem, one layer deeper: a stale console
    session refreshing while `terminalId` still held a LEFTOVER value from
    an earlier POS session would replay a terminal bind the Owner never
    asked for.

## ROOT_CAUSE

**Yes to the first three of the four determinations asked for:** PIN login
overwrites the same `accessToken`/`refreshToken`/`tenantId` keys Console
reads (confirmed); terminal binding does too, for the same reason
(confirmed, though in practice unused — see FIX below); Console bootstrap
blindly accepts whatever token is in that shared slot, with no check that
it is actually a console-shaped one (confirmed — `PermissionGuard` itself
is what eventually 403s, but only after ~13 requests already went out).
**Terminal screens and the dashboard do share one global session store** —
confirmed, and this is the actual root cause: `lib/api/session.ts` had
never had a notion of "whose session is this."

The `orders?limit=100 -> 200` line in the production evidence is
independent confirmation, not a contradiction: `pos.order.view` IS a
permission the Cashier's canonical role holds, so the ONE dashboard call
that happened to succeed is exactly the one a Cashier's own token would
authorize — every other listed call (`branches`, `terminals`,
`permissions`, `tenants`, `access`, `warehouses`, …) needs a
tenant-owner-only or dashboard-only permission the Cashier does not have.

## SHARED_STORAGE_KEYS / CONSOLE_SESSION_SOURCE / TERMINAL_SESSION_SOURCE

**SHARED_STORAGE_KEYS (before):** `ros.api.accessToken`,
`ros.api.refreshToken`, `ros.api.expiresAt`, `ros.api.tenantId` — read and
written by BOTH `lib/api/auth.ts`'s console functions (`signIn`,
`selectTenant`, `bindTerminal`) and its terminal function
(`signInWithPin`), with no separation.

**CONSOLE_SESSION_SOURCE (after):** `ros.api.accessToken`/
`refreshToken`/`expiresAt`/`tenantId` (names unchanged, so an already
signed-in Owner is not forced to re-login by this deploy) — now used ONLY
when `activeSurface === "console"`.

**TERMINAL_SESSION_SOURCE (after):** new, independent
`ros.terminal.accessToken`/`refreshToken`/`expiresAt`/`tenantId` — used
ONLY when `activeSurface === "terminal"`. A currently-open POS/KDS session
is signed out by this deploy (a PIN session's own designed cost — FR-SEC-020
already treats re-entering a PIN as cheap); no Console session is affected.

**No pre-existing separate storage mechanism existed to reuse** — confirmed
by reading every export of `lib/api/session.ts` before starting; this is
genuinely new, and the smallest version of it that closes the actual gap.

## FIX

`lib/api/session.ts`: added an in-memory `activeSurface: "console" |
"terminal"` flag (`setActiveSurface`/`getActiveSurface`), defaulting to
`"console"` (the safer failure mode). The four identity-bearing functions
(`getTokens`/`setTokens`/`getAccessToken`/`getRefreshToken`/
`isAccessTokenStale`/`isSignedIn`/`clearSession`/`getTenantId`/
`setTenantId`) now resolve their storage key through `identityKeys()`,
which picks the console or terminal key set based on the flag —
**every existing call site keeps calling the exact same function names**
(`lib/api/auth.ts`, `lib/api/client.ts`, `lib/console/services/http.ts`'s
~50 `getTenantId()` reads, `pos-live.tsx`) and is automatically correct
for whichever surface it runs on. `clearSession()` now also only clears
the ACTIVE surface's own identity (a console sign-out no longer wipes an
unrelated terminal's PIN session or its open drawer, and vice versa — this
falls out of the model, not a separately invented behaviour).

`terminalId`/`kdsStationId` are kept as a SINGLE shared value, deliberately
— they name the PHYSICAL DEVICE, not an authenticated identity, and
`/register-device` (console-authenticated) sets the terminal binding
`/pos`/`/kds` must then see. `cashSessionId`/`cashSessionOpening`/
`posEmployee` are also kept shared — already exclusively terminal-only in
every existing call site, so no cross-surface collision was ever possible
for them.

**A real functional gap found and fixed while implementing this:** the
Cashier PIN sign-on form (`pos-live.tsx`) reads a tenantId to even attempt
`POST /auth/pin`, and had NO tenant picker of its own (FR-SEC-020 — a till
identifies staff by code and PIN, never a typed tenant id) — it silently
relied on the SAME shared `tenantId` slot happening to already hold the
right value, because the SAME browser had, at some point, ALSO been used
for a console login by the manager who registered this device. Separating
storage would have broken that (a brand-new terminal's own `tenantId` slot
starts empty, and nothing populates it before the very first PIN sign-on).
Fixed with a third, explicitly DEVICE-level fact,
`getDeviceTenantId()`/backed by `ros.api.deviceTenantId` — written
whenever EITHER surface's `setTenantId` resolves a tenant, never cleared
by a mere sign-out of either one (the till does not change tenants because
someone logged out of it) — and the sign-on form now reads THIS instead of
the surface-scoped `getTenantId()`.

`lib/console/providers.tsx`: `ConsoleProvider` (shared by `(console)`,
`(auth)` AND `(terminal)` — the same live-org-context/session plumbing
backs all three) gained an optional `surface?: "console" | "terminal"`
prop, defaulting to `"console"`, and calls `setActiveSurface(surface)`
synchronously in its own render body — before `SessionProvider` (its
child) or anything beneath it can fire a request, since React renders a
parent's function body before any child's. `app/(terminal)/layout.tsx` is
the only caller that passes `surface="terminal"`; `(console)`/`(auth)`
omit it and get the safe default.

## ROUTE_GUARD

**Already existed, and is now correct rather than accidentally
compensating for a bug.** `ConsoleShell`'s `useAuthGuard()` redirects to
`/login` whenever `authenticated` is false, and `useLiveOrgContext` itself
skips its ENTIRE bootstrap (`org/access`, `permissions`, `tenants`,
`tenant`) when not `authenticated` — no new guard code was added.
`authenticated` is derived from a THIRD, already-distinctly-named
`localStorage` key (`"ros.console.auth"`, set only by the real `/login`
page's own `useSession().signIn(...)` call) that PIN login never touches
— so a browser that has never done a console login gets `authenticated
=== false` and is redirected before firing a single console request,
exactly as required. The reported mass-403 case (an Owner who HAD
genuinely logged into console) correctly does NOT redirect — `authenticated`
is legitimately true — and now correctly SUCCEEDS instead of 403ing, because
the token it reads is the Owner's own, never overwritten by the later PIN
login.

## CONSOLE_BUTTON_BEHAVIOR

Unchanged code (`components/terminal/chrome.tsx`'s plain `<Link
href="/dashboard">`), now correct BECAUSE the underlying session model is:
landing on `/dashboard` either finds the Owner's still-valid, untouched
console session (`authenticated === true`, a genuine console token) and
renders it, or finds none (`authenticated === false`) and
`useAuthGuard()` sends the user to `/login`. It can no longer, under any
circumstance, present the POS/PIN token as a dashboard session, because
that token no longer lives in the slot Console reads from.

## Tests

Frontend `typecheck`: clean.
Frontend `build`: clean — every route, `(console)`/`(auth)`/`(terminal)`
groups all included, prerenders.

No backend change was needed or made (confirmed via `git status`), so no
backend suite was re-run. No frontend component/unit test harness exists
in this repo to target narrowly (the project's test convention is backend
e2e only); the fix was verified by direct trace of every reader/writer of
the four identity-bearing storage keys, before and after, across
`lib/api/auth.ts`, `lib/api/client.ts`, `lib/console/services/http.ts`,
and every terminal component.

## SRS relevance

No requirement reinterpreted. FR-SEC-020/021 (a PIN session must never
grant dashboard access) is unchanged and was never the defect — the
backend already, correctly, refuses a `pos`-typed or wrongly-scoped token
on every dashboard-only route; this task closes the CLIENT-SIDE gap where
the wrong token was being SENT in the first place, and does so without
touching any backend authorization code (FR-SEC-045: the server remains
the sole authority; this is presentation-layer session hygiene).

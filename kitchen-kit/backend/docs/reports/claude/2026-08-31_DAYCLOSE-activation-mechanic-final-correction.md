# DAY CLOSE — Activation Mechanic Final Correction

| Field | Value |
|---|---|
| **Task / slice name** | DAY CLOSE — `day_close_activations` lifecycle / transaction-semantics correction |
| **Report type** | Design correction. **No implementation.** No migration, no schema change, no source change, no governance edit, no commit, no push, no deploy. No agents launched. |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report corrects **one** defect in `2026-08-31_DAYCLOSE-pre-ratification-final-correction.md` §2.3. **All previous DayClose reports are preserved byte-unmodified**; where they differ from this report, **this report governs**. **DC-R1 / DC-R2 / DC-R3 are NOT reopened.** |
| **Date** | 2026-08-31 |
| **HEAD** | `7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c` |
| **Branch** | `feat/production-spec` |
| **Working tree** | Dirty **only** in `docs/reports/claude/` (INDEX.md + 8 untracked reports). **Zero** source / schema / migration / test / OpenAPI drift. 34 migrations. |
| **Task identifier** | DAYCLOSE-activation-mechanic-final-correction |
| **Status** | COMPLETE |
| **Tests** | **No test suite executed in this session.** Every claim is traced to a source path and line. |

---

## §0. VERDICT

> # **A. DAYCLOSE ACTIVATION MECHANIC CLEAN — RATIFICATIONS READY**
>
> **The defect is REAL and is confirmed by two independent mechanisms**, not one:
> the transaction rolls back **and** the idempotency reservation is released.
> My prior §2.3 wording — *"the first request always returns 409 … the
> activation nevertheless persists"* — was **self-contradictory and is
> WITHDRAWN**.
>
> **Resolved by OPTION A**, using a **ratified repository precedent already in
> the accepted P1G-1 close service**: a durable state change **COMMITS and
> returns an outcome discriminator**; it never throws.
>
> **No new user decision. DC-R1 / DC-R2 / DC-R3 unchanged.**

---

## §1. BASELINE

```
git rev-parse HEAD        -> 7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c   MATCH
git branch --show-current -> feat/production-spec                        MATCH
migrations                -> 34
dirty paths               -> 9, all under docs/reports/claude/
```

**Nothing outside `docs/reports/claude/`. BASELINE UNCHANGED — not verdict E.**
All previous DayClose reports were read, **not modified**.

---

## §2. THE DEFECT — CONFIRMED, AND WORSE THAN STATED

### 2.1 What the prior design said

> *"`treasury.day_close_activations` is created lazily and idempotently on the
> first DayClose request … the first request always refused (409) — it
> activates the branch and reports the first closable day."*

### 2.2 Why it cannot work — **two** independent failures

**Failure 1 — transaction rollback.** The activation `INSERT` and the
`ConflictException` would occur in the *same* `withAuthContext` transaction.
NestJS propagates the exception out of the callback, Prisma's interactive
transaction rolls back, and **the `INSERT` is discarded**. Nothing persists.

**Failure 2 — the idempotency reservation is released too.** Verified this
session in `common/idempotency/idempotency.interceptor.ts`:

| Handler outcome | Interceptor action | Line |
|---|---|---|
| **success** | `idempotency.complete(tenantId, key, { status, body })` — the response is **stored** for replay | `:129-136` |
| **throw** | `idempotency.release(tenantId, key)` — *"reservation released, so a retry can proceed"* | `:137-141` |
| **replay** | sets `Idempotent-Replay: true`, restores the stored status/body, **handler never runs** | `:97-101`, `:118-123` |

So a thrown 409 stores **nothing** either.

> ## **CONSEQUENCE, STATED EXPLICITLY: every request would be "the first request", forever.**
> The branch could never become eligible, `firstEligibleBusinessDay` would never
> stabilise, and `FR-FIN-020` would be permanently unreachable. **This was a
> genuine correctness defect, not a wording problem.**

### 2.3 The generalisable invariant this exposes

> ### **Throw only when NOTHING durable was written. When a durable state change has been made, COMMIT and report the outcome in the body.**

This is not invented here. It is the **ratified R-6(a) rule**, recorded verbatim
in the accepted P1G-1 design-acceptance closure: *"Rejection must **COMMIT**
(never throw after the decision INSERT) and returns **200 with an outcome
discriminator**, not 4xx, since a 4xx would make the idempotency interceptor
release the reservation and let a replay create a second request."*

And it is **already implemented** in accepted Treasury code:

```
cash-session-close.service.ts:802-806
  private buildFinalizeResult(session, outcome: 'closed' | 'rejected') {
    return { cashSessionId: session.id, status: session.status, outcome };
  }
```

*(A second discriminator precedent sits at `:797` — `created: justCreated` on
`declareClose`.)*

---

## §3. OPTION EVALUATION — **OPTION A SELECTED**

| | Option | Assessment |
|---|---|---|
| **A** | **Explicit committed activation result** — one transaction yielding `ACTIVATED` **or** `CLOSED`; the activation path **commits and does not throw** | ✅ **SELECTED.** Self-contained in the new slice · uses a **ratified precedent already implemented in this exact module** · **no migration data seeding** · **no business-day maths in SQL** · covers branches created *after* migration 35 automatically · honest audit and idempotency semantics · smallest change |
| **B** | **Activation seeded during migration 35** with a conservative immutable fence | ❌ **REJECTED.** (i) A migration cannot resolve a branch's business day without `timezone` + per-weekday `business_day_cutover` maths in SQL — **a second business-day algorithm**, which the design forbids. (ii) The only safe SQL-expressible bound is a UTC-date fence (a branch at UTC+14 can be a calendar day *ahead* of the UTC date), so it must be set at `utc_date + 1`, **excluding roughly two extra days for every branch** — it errs safely but wastefully. (iii) **It cannot cover a branch created after migration 35**, and absence-of-row is then ambiguous between *"new branch, no legacy risk"* and *"seed missed"* — a fail-closed reading bricks new branches, a fail-open reading defeats the whole guarantee. *(Data-seeding migrations are precedented — exactly one, `20260816180000_org_location_registry` — but it seeds from **existing relational facts**, never from a derived temporal computation.)* |
| **C** | **Separate Treasury bootstrap/init operation** | ❌ **REJECTED.** It invents an operator-facing workflow, plus a route, plus a permission (§15.2 supplies none), for something Option A obtains as a by-product of the first genuine command. The brief's own constraint applies: *"Do not invent an operator-facing workflow unless necessary"* — and it is not necessary |
| **D** | Another mechanism | none cleaner found |

---

## §4. THE SELECTED MECHANISM

### 4.1 One transaction, two committed outcomes

Inside the DayClose command's **single** `withAuthContext` transaction
(READ COMMITTED, holding the accepted `ros_order_number(branch, businessDay)`
fence — §7):

```
1. acquire the (branch, targetBusinessDay) advisory fence          [unchanged, §7]
2. read the branch's activation row
3. IF ABSENT:
     A := branchCurrentBusinessDay        (authoritative resolver, live clock)
     INSERT day_close_activations(tenant, branch, activation_business_day = A, …)
     write the activation audit entry                              [§6]
     ── COMMIT ──  return 200 { outcome: 'ACTIVATED', activationBusinessDay: A,
                                firstEligibleBusinessDay: A + 1 }
     ***  NO EXCEPTION IS THROWN ON THIS PATH  ***
4. ELSE: evaluate the close normally.
     Eligible  → seal the day, COMMIT, return { outcome: 'CLOSED', … }
     Ineligible/blocked → THROW (409/400) — nothing durable was written,
                          so rollback loses nothing and release is correct
```

### 4.2 Why the first request can never also close a day — proof

On the first request at instant `T`, the rule sets `A := branchCurrentBusinessDay(T) = C`.
Eligibility requires `A < target < C`, i.e. `C < target < C` — **an empty
interval**. ∎ Therefore `ACTIVATED` is *always* the first outcome, and the two
outcomes can never collide in one request.

### 4.3 Response shape

Mirrors `buildFinalizeResult` exactly — a discriminated result, not a status-code
overload:

```
200 { branchId, businessDay,
      outcome: 'ACTIVATED' | 'CLOSED',
      activationBusinessDay, firstEligibleBusinessDay,
      dayClose?: { … }            // present only when outcome === 'CLOSED'
    }
```

**`ACTIVATED` is a success**: a durable, audited, idempotent state change was
made and is reported honestly. It is **not** a disguised failure.

---

## §5. REQUIRED PROPERTIES — ALL ELEVEN

| # | Property | How it is guaranteed |
|---|---|---|
| 1 | **Activation persists exactly once** | Committed on a non-throwing path (§4.1 step 3) + `UNIQUE (tenant_id, branch_id)` |
| 2 | **No failed transaction is relied on** | The activation path **never throws**. This is the entire correction |
| 3 | **No speculative backfill** of legacy `closed_business_day` | Unchanged — activation records a *boundary*, never a value for a legacy row |
| 4 | **Activation boundary immutable** | `SELECT` + column-level `INSERT`; **no `UPDATE`, no `DELETE`, no `TRUNCATE`** for `ros_app` — the accepted `cash_close_policies` grant pattern |
| 5 | **Pre-activation DayClose cannot be created** | Enforced in the same transaction as the insert: `activation_business_day < target < branchCurrentBusinessDay` |
| 6 | **Historical GET never manufactures a pre-activation Z** | Unchanged — retrieval returns **persisted rows only**; **404** when none exists |
| 7 | **Retry/replay deterministic** | §6 |
| 8 | **No second activation row under concurrency** | `UNIQUE (tenant_id, branch_id)`; the loser's unique violation is handled by the **same local bounded retry** already designed for the `z_number` collision — it re-reads the now-existing row and takes the normal path |
| 9 | **Tenant + branch uniqueness** | `UNIQUE (tenant_id, branch_id)`, with the ADR 0008 D-09 composite FK to `org.branches(tenant_id, id)` |
| 10 | **RLS / append-only** | `ENABLE` + `FORCE ROW LEVEL SECURITY`, select/insert policies on `app.tenant_id`, **no UPDATE policy, no DELETE policy** |
| 11 | **Zero `KNOWN_DEVIATIONS` growth** | The mechanism is entirely inside Treasury; it adds **no** cross-module import. The only cross-module call is the already-designed public business-day contract |

---

## §6. IDEMPOTENCY

The DayClose `POST` carries `@Idempotent()` (`FR-API-020` — financially
significant). Interaction, resolved against the interceptor's verified behaviour
(§2.2):

| Question | Answer |
|---|---|
| **What response is persisted when the first POST only activates?** | The **committed `200 { outcome: 'ACTIVATED', … }`** body and status, stored by `idempotency.complete()` because the handler **returned** rather than threw |
| **Does repeating the SAME key reproduce it?** | **YES** — `Idempotent-Replay: true` with the byte-identical stored body, and the handler does not run. **This is correct**: the same key is the *same command*, and `FR-API-022` mandates exactly this. It is **not** a stale conflict being replayed — it is the true, permanent outcome of that specific command, which really did activate the branch and really did close no day |
| **Does a NEW key later permit an eligible DayClose?** | **YES.** A new key is a new command; the interceptor's store is keyed by `(tenant, key)`. Once `firstEligibleBusinessDay ≤ target < current`, a fresh key performs a real close and returns `outcome: 'CLOSED'` |
| **Is the "activation-era conflict replayed forever" hazard present?** | **NO — and this is precisely why Option A is required.** Under the withdrawn design the first request *threw*, so **nothing** was stored and **nothing** persisted. Under Option A what is replayed is a **committed success**, replayed only for **the same key**, which *is* the established `FR-API-022` semantic for an exact replay |
| **Is activation part of the financially-significant command's identity?** | **YES.** It is a durable state change produced by the same authenticated, permissioned, idempotent `POST`, and it is audited (§7). It is **not** hidden inside a refusal |
| **Same key, DIFFERENT body?** | **409** (`FR-API-023`) — unchanged; the request body is empty, so this arises only from a genuine client defect |

---

## §7. AUDIT

> **An audit entry IS required.** Activation is created by a **user `POST`** and
> is a durable state change. `FR-AUD-001` binds state-changing operations, and
> the entry must **not** disappear from the audit model merely because no
> DayClose row was produced.

| Element | Value |
|---|---|
| **Action literal** | one new `AUDIT_ACTION` entry, e.g. `DAY_CLOSE_ACTIVATED`, distinct from `DAY_CLOSED` |
| **Entity** | the activation row and its id |
| **Context** | `branchId`, `activationBusinessDay`, `firstEligibleBusinessDay` |
| **Actor** | the identity **user** and the **employee** (P1D-E) |
| **`before` / `after`** | `before` **null** (insert-once); `after` carries the boundary |
| **Transaction** | the **same** transaction as the `INSERT` — so the audit cannot survive without the row, nor the row without the audit |

**No user governance decision is created for the literal.** The P1G-1
ratification records verbatim that *"the audit action literal"* is a
*"Design-Gate / implementation detail"*.

---

## §8. FIRST ELIGIBLE DAY — EXACT SEMANTICS AND TERMINOLOGY

### 8.1 Two distinct names — the prior report's terminology is corrected

| Term | Meaning | Stored? |
|---|---|---|
| **`activationBusinessDay`** (`A`) | the branch's business day **at the activation instant** | **YES** — one immutable `DATE` column |
| **`firstEligibleBusinessDay`** | **`A + 1`** — the earliest business day that may ever be closed | **NO — derived**, so there is exactly one source of truth. Reported in every response |

> **`A` is NEVER closeable, and must never be called "the first closable day".**
> The prior report's phrase *"naming the branch's first closable business day"*
> is retained in meaning but the field is now named
> **`firstEligibleBusinessDay`**, and `A` is named **`activationBusinessDay`**.
> The two are never used interchangeably.

### 8.2 Why `A` itself is excluded

Migration 35 lands *during* some business day. Sessions that closed **earlier in
that same day**, before `closed_business_day` attribution became authoritative,
carry `NULL`; sessions closing later in that day carry a value. **Day `A` is
therefore provably mixed**, and a Z for it could not claim a complete variance
summary. Only a business day lying **entirely** after `A` is fully attributed and
therefore trustworthy.

### 8.3 The rule, and the worked example

```
activationBusinessDay  <  targetBusinessDay  <  branchCurrentBusinessDay
```

> **Activation happens on `D`** ⇒ `activationBusinessDay = D`,
> `firstEligibleBusinessDay = D + 1`.
> **When the branch's current business day becomes `D + 2`**, the first eligible
> target is **`D + 1`** — because it must be `> D` and `< D + 2`.
> **`D` itself is never closeable.**

---

## §9. CONCURRENCY — THE ACCEPTED CUTOVER SOLUTION IS PRESERVED

**Not reopened, and restated for completeness:** DayClose and Order creation
share the existing `ros_order_number(branch, businessDay)` advisory fence; Order
creation checks the public Treasury `DAY_CLOSE_STATE_QUERY` **after** acquiring
that fence and **before** its `INSERT`; DayClose acquires the same fence before
checking and closing `D`; **READ COMMITTED**; **SERIALIZABLE is not claimed** to
solve the cutover race.

### Does activation introduce a new race into that ordering? **NO.**

| Interaction | Analysis |
|---|---|
| **Order creation vs. activation** | Order creation **never reads or writes `day_close_activations`**. The accepted fence ordering is **untouched** |
| **Fence acquired before activation** | The activation read/insert happens **after** step 1's advisory lock, so it is inside the existing critical section — it adds no new section and no new lock |
| **Two concurrent first-requests, SAME target day** | They contend on the **same** advisory key and serialise; the second sees the committed activation and takes the normal path |
| **Two concurrent first-requests, DIFFERENT past days, same branch** | They hold **different** advisory keys, so both may reach the `INSERT`; `UNIQUE (tenant_id, branch_id)` lets exactly one win. The loser blocks on the index tuple, then receives the unique violation and is handled by the **local bounded retry**, re-reading the committed row |
| **Deadlock risk** | **None.** Neither transaction ever waits on the other's *advisory* lock; the only cross-wait is the one-directional unique-index tuple wait |
| **Loser's response** | On retry the activation exists, so the loser takes the normal path: for an ineligible day this is a **409 naming `firstEligibleBusinessDay`** — consistent with every other ineligible request, and honest, since **that** transaction wrote nothing durable |

**Key-space summary:** the advisory fence is `(branch, businessDay)`; the
activation constraint is `(tenant, branch)`. Different granularities, no
interference.

---

## §10. RATIFICATIONS — UNCHANGED, EXACTLY THREE

| | Decision | Recommendation |
|---|---|---|
| **DC-R1** | Internal-MVP DayClose sequencing while the named `FR-FIN-022` / `FR-FIN-026` limbs remain PARTIAL / NOT IMPLEMENTED | **YES** — unchanged |
| **DC-R2** | Spanning-session variance ownership | **CLOSE-BUSINESS-DAY OWNERSHIP** — unchanged |
| **DC-R3** | Historical Z read authority | **Extend `report.view.financial`** to `GET /branches/{branchId}/day-closes/{businessDay}` — unchanged |

> **NO FOURTH USER DECISION.** Everything in this report is transaction
> semantics, idempotency mechanics, an audit literal, and a field name — each
> already classified as Design-Gate / implementation detail by the P1G-1 and
> RPT-R1/R2 precedents. **No business semantic was discovered.**

---

## §11. MIGRATION AND DoD DELTAS

**Migration expectation is unchanged: ONE additive Treasury migration #35**, still
including `treasury.day_close_activations`
`(tenant_id, branch_id, activation_business_day DATE, activated_at, activated_by)`
with `UNIQUE (tenant_id, branch_id)`, RLS `ENABLE`+`FORCE`, and append-only
grants. **No migration is created by this task, and no data is seeded by it.**

### DoD additions

1. **The first `POST` for a branch COMMITS the activation** and returns
   `200 { outcome: 'ACTIVATED' }` — asserted by re-reading the row **after** the
   request, on a fresh connection.
2. **No exception is thrown on the activation path** — a guard test proving the
   activation survives, which the withdrawn design would have failed.
3. **Same-key replay** returns the byte-identical `ACTIVATED` body with
   `Idempotent-Replay: true`, and creates **no** second row and **no** second
   audit entry.
4. **A new key, once eligible**, performs a real close returning
   `outcome: 'CLOSED'`.
5. **Two concurrent first-requests** (deterministic barrier, no sleeps) ⇒
   **exactly one** activation row; the loser retries and receives the normal
   ineligible-day 409.
6. **Activation is audited** — exactly one `DAY_CLOSE_ACTIVATED` entry, in the
   same transaction, hash-chain intact, `before` null.
7. **Activation is immutable** — `UPDATE` and `DELETE` both fail as an
   unprivileged `NOBYPASSRLS` role.
8. **`activationBusinessDay` (`A`) is never closeable**; `A + 1` becomes
   closeable once the current business day reaches `A + 2`.
9. **A branch created after migration 35** activates on first use with no
   special-casing.

All previously specified DayClose tests are **preserved**.

---

## §12. WHAT THIS TASK DID AND DID NOT DO

**Did:** verified the baseline; read all previous DayClose reports **without
modifying them**; verified the idempotency interceptor's store/release/replay
behaviour and the accepted `outcome` discriminator line by line; produced this
correction; appended **exactly one** `INDEX.md` row.

**Did NOT:** implement product code · create or modify a migration · modify the
Prisma schema or any source file · add a route or permission · edit governance ·
reopen DC-R1/DC-R2/DC-R3 · run any test suite · launch any agent · stage ·
commit · push · deploy.

---

## §13. VERDICT

> # **A. DAYCLOSE ACTIVATION MECHANIC CLEAN — RATIFICATIONS READY**
>
> **Not B** — the transaction and idempotency semantics are resolved by a
> committed, audited, replayable `ACTIVATED` outcome on a non-throwing path,
> using a precedent already implemented in accepted Treasury code.
> **Not C** — no migration seeding is used, and no legacy value is ever inferred.
> **Not D** — no business decision was discovered; all of it is mechanics.
> **Not E** — baseline unchanged.

---

*End of report. **Non-authoritative evidence.** The SRS and the ratified
governance decisions remain authoritative. All previous DayClose reports are
preserved **byte-unmodified**; this report governs where they differ, and
everything they settled that is not named here stands unchanged. It withdraws
one claim made by this model — that a lazily created activation row could
persist through a 409-throwing request.*

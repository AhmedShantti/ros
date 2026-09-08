# ORG-PR-CONSOLIDATION-1 — Organisation Repository PR Audit and Containment Proof

**Report type:** Read-only audit / integration-strategy analysis (no writes, no merges, no closes)
**Authority statement:** This report is non-authoritative evidence. It does not ratify, close, merge, or resolve anything. The SRS and ratified governance decisions in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authoritative sources; findings below are git-evidence-backed observations for a human decision-maker to act on.
**Date:** 2026-09-05
**Local HEAD:** `358feb4` (repo working tree: 4 untracked report files pre-existing this task, no changes made by this task)
**Local branch:** `feat/production-spec`
**Working tree summary:** Clean except pre-existing untracked report files (`2026-08-26_MVP_current-state-and-next-slice.md`, `2026-08-27_RENDER_empty-db-demo-provisioning-check.md`, `2026-08-28_P1G1_cash-close-design-gate.md`, `2026-08-28_POST-P1F2_MVP_next-slice-rebase.md`); this task added only this report file and its INDEX.md entry.
**Task identifier:** ORG-PR-CONSOLIDATION-1

No commits, pushes, merges, rebases, force-pushes, PR closes, or conflict resolutions were performed. A single throwaway detached-HEAD worktree was created for a merge preview (§8) and removed cleanly afterward; no existing worktree was touched.

---

## 0. Tooling note

`gh` (GitHub CLI) is **not installed** in this environment, so PR metadata (base/head branch as recorded by GitHub, review state, mergeable flag) could not be pulled via `gh pr view`. All findings below are derived directly from git refs on `origin` (fetched fresh this session) plus PR merge-commit messages already present in `origin/main`'s history, which name the PR numbers explicitly (e.g. "Merge pull request #14 from ..."). Branch-name-to-PR-number mapping is taken as given in the task brief; if the actual PR numbers differ, only the numeric labels in this report would need correcting — the branch-level evidence stands independent of PR numbering.

---

## 1. Remote / repo safety

- `ORG_REMOTE` = **`origin`** → `https://github.com/OffBrand-org/kitchen-kit-backend.git` (confirmed via `git remote -v`).
- A second remote `upstream` → `https://github.com/AhmedShantti/ros.git` also exists; not touched, not relevant to this task.
- `git worktree list` shows 9 pre-existing worktrees (`ros-worktrees/integration`, `lane-a` … `lane-g`) — all pre-existing, untouched by this task.
- No remote URLs were changed. `git fetch --all --prune` was run; no destructive flags used.

## 2. Latest accepted branch vs. ORG_REMOTE — critical finding

The brief states `full-srs/lane-d4-reporting-demo` HEAD = `1ab5fa4`. On `origin` today, that branch has **already moved past** that commit:

- `origin/full-srs/lane-d4-reporting-demo` HEAD = **`656db4c`** (a "Merge branch 'main' into full-srs/lane-d4-reporting-demo" commit).
- `1ab5fa4` **is** an ancestor of `656db4c` (branch advanced, not diverged/rewritten).
- `656db4c` is itself an ancestor of `origin/main`.

**`ORG_MAIN_HEAD` = `b88d265`** (`origin/main`, "Merge pull request #14 from OffBrand-org/full-srs/lane-a-perf-inventory").

**`1ab5fa4` is already an ancestor of `origin/main`.** The merge commit history on `origin/main` shows `1ab5fa4` was merged in as **PR #7** ("Merge pull request #7 from OffBrand-org/full-srs/lane-d4-reporting-demo", commit `6fe5a5a`). In other words: **the "lane-d4 → main consolidation PR" the brief asks about in §7 has already happened on the org remote.** `main` did not need publishing from local state — it is already ahead of `1ab5fa4`, not behind it.

`origin/main` additionally contains, as separately merged PRs on top of `1ab5fa4`:

| PR # | Lane | Merge commit |
|---|---|---|
| #1 | `feat/production-spec` | `ad5d3c0` |
| #2 | `full-srs/4day-integration` | `edfbed6` |
| #4 | `full-srs/lane-g2-observability` | `460ce00` |
| #5 | `full-srs/lane-g2-ci-security-gates` | `0921313` |
| #6 | `full-srs/lane-f2-dr-partition-lifecycle` | `9d4bb4c` |
| #7 | `full-srs/lane-d4-reporting-demo` (= `1ab5fa4`) | `6fe5a5a` |
| #8 | `full-srs/lane-e2-scheduler-foundation` | `2a340f3` |
| #10 | `full-srs/lane-b2-workforce-core` (HR-1) | `9b70ae7` |
| #11 | `full-srs/lane-c2-audit-production` | `889a8d7` |
| #13 | `full-srs/lane-a2-inventory-concurrency` | `1d7838f` |
| #14 | `full-srs/lane-a-perf-inventory` | `b88d265` |

52 commits total separate `1ab5fa4` from `origin/main`; net tree diff `1ab5fa4` → `origin/main` is small (18 files, +172/−372 lines, no new migrations, no OpenAPI delta, no `package.json` delta) because most of that work is additive-then-refined on top of content `1ab5fa4` already carried via the earlier `full-srs/4day-integration` cumulative build.

## 3–4. Per-PR audit (steps A–H) and accepted-heads cross-check

All five target branches were checked for: HEAD, ancestry (`merge-base --is-ancestor`), patch equivalence (`git cherry -v`), cherry-aware log, file-level diff stat, migration-directory diff, and direct file-content equivalence against both `1ab5fa4` and `origin/main`. Full command transcripts were run interactively this session (not reproduced verbatim here per reporting policy on report length, but every number below is from a live command, not inferred).

### PR #16 — `full-srs/lane-d2-offline-domain`
- HEAD: `a304e54`
- Ancestor of `1ab5fa4`/`origin/main`: NO (not a fast-forward ancestor).
- `git cherry -v 1ab5fa4 <branch>`: 5 of 6 commits marked `-` (patch-equivalent, already present). 1 commit (`1fe490f`, "docs: record offline domain handler verification") marked `+`.
- Inspected the one non-equivalent commit directly: it only adds a lane-specific report file (`docs/reports/claude/full-srs-4day/2026-09-03_D4-1B_offline-domain-handlers.md`) and an INDEX row — no source, schema, or test content. Not a functional gap.
- Migrations: zero new migration directories vs `1ab5fa4`.
- **Classification: ALREADY_CONTAINED / PATCH_EQUIVALENT.**

### PR #15 — `full-srs/lane-b-security-platform`
- HEAD: `9de7103`
- Ancestor of `1ab5fa4`/`origin/main`: NO.
- `git cherry -v`: **all 5 commits marked `+`** (patch-id mismatch against both `1ab5fa4` and `origin/main`) — on `cherry` alone this would look GENUINELY_MISSING.
- **File-level proof overrides the cherry result** (per the task's own instruction not to conclude "missing" from hash/patch differences alone): direct content diff of the branch's key artifacts against `origin/main` —
  - `docs/adr/0009-scoped-rbac.md`: diff = 0 lines (byte-identical).
  - `prisma/migrations/20260902010000_identity_scoped_role_assignments/migration.sql`: present in `origin/main` under the identical directory name, diff = 0 lines.
  - `src/modules/identity/authz/scope-authorization.service.ts`: diff = 0 lines.
  - All other named files in the PR (`scope.ts`, `scope-target.resolvers.ts`, `rbac.controller.ts`, ADR, governance register entries, reports) exist at identical paths in `origin/main`.
- Conclusion: the scoped-RBAC feature was integrated into `main` (almost certainly via squash or non-atomic merge during an earlier lane consolidation), which changes patch-ids and defeats `git cherry`, but the resulting tree content is identical. This is exactly the "previous ROS integration used cherry-pick heavily" caveat the brief warns about, taken to its file-content conclusion.
- **Classification: ALREADY_CONTAINED** (proven by file-content equivalence, not by patch-id).

### PR #12 — `full-srs/lane-a3-pos-financial-corrections`
- HEAD: `0ca3c4b`
- Ancestor of `1ab5fa4`/`origin/main`: NO.
- `git cherry -v 1ab5fa4 <branch>`: **all 8 commits marked `-`** (fully patch-equivalent).
- Direct two-dot tree diff `1ab5fa4` vs branch tip: **only deletions on the branch side** (branch is missing ~21k lines / newer files like `workforce-hr1.e2e-spec.ts` and later tenant-isolation specs that `1ab5fa4` has since gained) with no unique additions on the branch side — i.e. `1ab5fa4`/`main` are a strict superset.
- Migrations: zero new migration directories vs `1ab5fa4`.
- **Classification: ALREADY_CONTAINED / PATCH_EQUIVALENT** (this is also the accepted **POS-FIN `0ca3c4b`** head named in the brief's §4 cross-check — confirmed contained by both patch-equivalence and superset-tree evidence, despite not being a literal ancestor).

### PR #9 — `full-srs/lane-d-kds-offline`
- HEAD: `9ecc910`
- Ancestor of `1ab5fa4`/`origin/main`: NO.
- `git cherry -v`: all 3 commits marked `+` against both `1ab5fa4` and `origin/main`.
- File-level check (all 41 files added by this branch vs. its merge-base): **every file exists in `origin/main`**; a majority (25/41) are byte-identical, the remainder differ only because `main` has since extended the same files with later, already-contained work (e.g. PR #16's D4-1B offline-domain handlers build directly on this D4-1A sync-protocol-kernel base). No file is missing.
- Migrations: `20260902010000_sync_protocol_kernel` present verbatim in `origin/main`.
- **Classification: ALREADY_CONTAINED** (foundational work later extended, not superseded-differently).

### PR #3 — `full-srs/lane-g3-dependency-remediation`
- HEAD: `d3e9629`
- Ancestor of `1ab5fa4`: NO. Ancestor of `origin/main`: NO (as a whole branch), but **6 of its 8 commits are literal ancestors of `origin/main`** (they are the shared tenant-isolation/CI-gate commits — `2833727`, `49bed33`, `04dcc53`, `fc90beb`, `fb51925`, `ed4342d` — that also landed via PR #5 `lane-g2-ci-security-gates`). Only 2 commits (`18eb2b1` build(deps) remediation, `d3e9629` docs closure) are unique to this branch vs. `origin/main`.
- Direct content check of those 2 remaining commits: `package.json` diff `origin/main` vs branch = **0 lines** (byte-identical, including the `overrides` block for `deepmerge-ts`/`mysql2` and the `@prisma/*`/`prisma` 7.10.0 alignment). `package-lock.json` diff = **0 lines**.
- Migrations: zero new migration directories vs `1ab5fa4`.
- **Classification: ALREADY_CONTAINED** (this is also the accepted **dependency-remediation `d3e9629`** head named in the brief's §4 — confirmed fully contained, both via shared ancestor commits and via direct `package.json`/`package-lock.json` byte-equivalence).

### Accepted-heads cross-check (§4), explicit results

| Accepted head | Ancestor of `1ab5fa4`? | Ancestor of `origin/main`? | Disposition |
|---|---|---|---|
| `d3e9629` (dependency remediation, PR #3 HEAD) | NO | NO (6/8 commits are, 2 remain unique) | Content byte-equivalent in `main` via `package.json`/lock — **contained** |
| `0ca3c4b` (POS-FIN, PR #12 HEAD) | NO | NO | Fully patch-equivalent (`cherry` all `-`) + `1ab5fa4`/`main` are a superset tree — **contained** |
| `b8ac578` (HR-1) | NO | **YES** | Directly merged into `main` via PR #10 `lane-b2-workforce-core` — **contained** |
| `d4fccfa` (MTMB) | **YES** | **YES** | Direct ancestor of both — **contained** |
| `1ab5fa4` (Reporting) | (is itself) | **YES** | Direct ancestor of `main` via PR #7 — **contained** |

Note: `b8ac578` is the HEAD of the local worktree branch `full-srs/lane-b2-workforce-core`, a **different** lane from PR #15's `full-srs/lane-b-security-platform` — same letter-prefix, different lane number, different subject (workforce/HR vs. RBAC/security). Both are independently confirmed contained above.

## 5. PRs safe to recommend for closure

All five audited PRs classify as **ALREADY_CONTAINED**. Per the task's explicit instruction, none were merged, rebased, cherry-picked again, or had conflicts resolved. Proposed close comment (identical text for all five, as specified in the brief):

> "Superseded by the consolidated Full-SRS integration branch. The accepted changes from this lane are already present in full-srs/lane-d4-reporting-demo (1ab5fa4). Closing to avoid replaying historical lane conflicts."

One refinement worth flagging to the human decision-maker before using this exact text: `1ab5fa4` is no longer `origin/main`'s current tip — `origin/main` (`b88d265`) is now the better reference point, since it is what actually contains the PR content plus everything since (including, for PR #15, the byte-identical scoped-RBAC files that only prove out against current `main`, not against `1ab5fa4` alone in PR #15's case at the ancestor level). Recommend updating the close-comment wording to reference `origin/main` (`b88d265`) rather than `1ab5fa4` alone, or citing both.

**No PRs were closed. This is a recommendation only, pending explicit authorization.**

## 6. Genuinely missing patches

**None found.** No PR classified as PARTIALLY_CONTAINED or GENUINELY_MISSING. No cherry-pick plan is required.

## 7. Main integration strategy

The consolidation PR the brief asks whether to prepare (`full-srs/lane-d4-reporting-demo` → `main`) **already exists and is already merged**, as PR #7 (`6fe5a5a`) on `origin/main`. There is no outstanding "lane-d4 → main" action to take.

`origin/main` has 11 merged PRs' worth of unique, valuable commits beyond `1ab5fa4` (§2 table). **None of these should be overwritten, rebased, or force-pushed over** — they represent already-accepted, already-integrated work from lanes a, a2, b2, c2, e2, f2, g2 (×2), plus the production-spec and 4-day-integration branches themselves.

## 8. Final main-conflict preview

Created a throwaway detached-HEAD worktree at `origin/main` (`b88d265`) and ran `git merge --no-commit --no-ff 1ab5fa4`:

```
Already up to date.
```

**Zero conflicts, zero conflicted files.** This is the direct, mechanical consequence of `1ab5fa4` already being a fully-merged ancestor of `origin/main` — there is nothing left to reconcile between them. The worktree was removed cleanly (`git worktree remove --force`) immediately after; `git worktree list` confirms no residual worktree and no existing worktree was disturbed.

No preview merge of the 5 old conflicting PR branches against `main` was attempted — per the brief, §8 scopes the conflict preview to `main`+`1ab5fa4` only, and resolving/previewing the old lane branches' conflicts is explicitly out of scope for this audit.

---

## 9. OUTPUT (per brief's required format)

```
STATUS: AUDIT COMPLETE — no writes, no merges, no closes performed.

ORG_REMOTE: origin (https://github.com/OffBrand-org/kitchen-kit-backend.git)
ORG_MAIN_HEAD: b88d265 (origin/main)
LATEST_ACCEPTED_HEAD (per brief): 1ab5fa4 — CONFIRMED ancestor of ORG_MAIN_HEAD (merged as PR #7)
LATEST_BRANCH_ON_ORG_REMOTE: full-srs/lane-d4-reporting-demo HEAD = 656db4c (has advanced past 1ab5fa4;
  1ab5fa4 is an ancestor of 656db4c, not a divergence — branch was updated by merging main into it)

PR_16 (full-srs/lane-d2-offline-domain)
  HEAD: a304e54
  CLASSIFICATION: ALREADY_CONTAINED / PATCH_EQUIVALENT
  MISSING_PATCHES: none (1 non-equivalent commit is a report/INDEX-only file, no functional content)

PR_15 (full-srs/lane-b-security-platform)
  HEAD: 9de7103
  CLASSIFICATION: ALREADY_CONTAINED (proven by file-content equivalence; git cherry patch-id check
    alone would have misclassified this as missing — see §3)
  MISSING_PATCHES: none

PR_12 (full-srs/lane-a3-pos-financial-corrections)
  HEAD: 0ca3c4b
  CLASSIFICATION: ALREADY_CONTAINED / PATCH_EQUIVALENT
  MISSING_PATCHES: none

PR_9 (full-srs/lane-d-kds-offline)
  HEAD: 9ecc910
  CLASSIFICATION: ALREADY_CONTAINED
  MISSING_PATCHES: none

PR_3 (full-srs/lane-g3-dependency-remediation)
  HEAD: d3e9629
  CLASSIFICATION: ALREADY_CONTAINED
  MISSING_PATCHES: none

ACCEPTED_HEADS_PROVEN_PRESENT:
  d3e9629 (dependency remediation) — contained (package.json/lock byte-equivalent in main)
  0ca3c4b (POS-FIN) — contained (patch-equivalent + superset tree)
  b8ac578 (HR-1) — contained (direct ancestor of main via PR #10)
  d4fccfa (MTMB) — contained (direct ancestor of both 1ab5fa4 and main)
  1ab5fa4 (Reporting) — contained (direct ancestor of main via PR #7, already merged)

OLD_PRS_SAFE_TO_CLOSE (recommended, NOT executed): #16, #15, #12, #9, #3 — all ALREADY_CONTAINED

OLD_PRS_THAT_MUST_NOT_BE_CLOSED: none identified among the 5 audited (none are genuinely missing)

MAIN_UNIQUE_COMMITS (must not be overwritten): 52 commits / 11 merged PRs beyond 1ab5fa4 —
  #1 feat/production-spec, #2 full-srs/4day-integration, #4 lane-g2-observability,
  #5 lane-g2-ci-security-gates, #6 lane-f2-dr-partition-lifecycle, #7 lane-d4-reporting-demo (=1ab5fa4),
  #8 lane-e2-scheduler-foundation, #10 lane-b2-workforce-core (HR-1), #11 lane-c2-audit-production,
  #13 lane-a2-inventory-concurrency, #14 lane-a-perf-inventory

FINAL_PR_RECOMMENDATION:
  The "lane-d4 -> main" consolidation this task asked about is ALREADY DONE on the org remote
  (merged as PR #7). No new consolidation PR is needed for that purpose. The only remaining action
  is administrative: close PRs #16, #15, #12, #9, #3 as superseded (pending explicit human
  authorization — not done in this audit), since all five are proven ALREADY_CONTAINED in
  origin/main. Recommend the close-comment cite origin/main (b88d265) alongside 1ab5fa4, since
  main is now the more current supersedes-reference (see §5).

FINAL_MAIN_CONFLICT_PREVIEW:
  git merge --no-commit --no-ff 1ab5fa4 against a detached-HEAD copy of origin/main -> "Already up
  to date." Zero conflicted files. (1ab5fa4 is already a fully-merged ancestor of origin/main.)
  Preview worktree created and removed cleanly; no existing worktree touched.

EXACT_NEXT_ACTIONS (for human authorization, none taken by this task):
  1. Decide whether to update local main to origin/main (currently local main = 01c0b0f, far
     behind origin/main = b88d265) — a simple fast-forward fetch/checkout, not evaluated further
     here as it was outside this audit's read-only scope beyond the throwaway preview.
  2. If authorized: close PR #16, #15, #12, #9, #3 on GitHub with the superseded-by comment (§5),
     without merging, rebasing, or resolving their conflicts.
  3. No cherry-picks are required — no genuinely missing patches were found.
  4. Re-run `gh pr view` for all five once `gh` is installed/authenticated, to confirm GitHub's own
     base/head/mergeable metadata agrees with the git-ref-level evidence above before closing.
```

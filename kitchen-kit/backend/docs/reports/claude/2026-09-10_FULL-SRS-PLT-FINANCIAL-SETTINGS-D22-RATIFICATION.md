# FULL-SRS-PLT-FINANCIAL-SETTINGS-D22-RATIFICATION

**Slice:** FULL-SRS-PLT-FINANCIAL-SETTINGS-D22-RATIFICATION
**Report type:** Governance recording — NO IMPLEMENTATION
**Authority statement:** This report is **non-authoritative evidence**. The ROS SRS (`ROS_SRS_v1.0.pdf`) remains authoritative for requirement text. The binding record of the decision this report documents is `docs/governance/GOVERNANCE_DECISION_REGISTER.md`'s new **P2A-R1** entry, not this report — where this report's narrative and the register's clauses differ, the register governs.
**Date:** 2026-09-10
**HEAD at start:** `3402c37dd893ce8cc50782d1d7888346ee63126d`
**HEAD at end:** see COMMIT below (this task creates exactly one new commit)
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** Three files changed: `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (new P2A-R1 entry appended at the true end of the file), this report (new), `docs/reports/claude/INDEX.md` (one new row appended). No source file, Prisma schema, migration, or generated OpenAPI file was touched.
**Task identifier:** `FULL-SRS-PLT-FINANCIAL-SETTINGS-D22-RATIFICATION`

**Scope discipline:** This task performs governance recording only, per explicit user instruction. It does not implement `CountryPack.settingsLocks`, any parser/resolver/Prisma change, `ServiceChargePolicy`, cash rounding, service-charge computation, any POS change, a Platform Administrator actor, or any new permission. `git status`/`git diff` at the end of this session, re-verified before committing, show only the three files named above.

---

## 1. Ratifying instruction, recorded verbatim in substance

The project owner (user), in this session, explicitly stated: *"I, the project owner, explicitly RATIFY the governance decision proposed in `docs/reports/claude/2026-09-10_FULL-SRS-PLT-FINANCIAL-SETTINGS-GOVERNANCE-CORRECTION-P2A3.md`... Use the full D-22 REVISION 3 decision text from that report as the controlling decision, including all clauses carried forward from P2A/P2A2 and the anti-backdating clause added by P2A3. This is explicit user governance action."* This is the same class of action, and is held to the same bar, as every prior ratification in this register (P1C-3, P1G-1, RPT-R1, AUD-R1, ...): a session-level record of the user's own words authorizing the decision, immediately followed by recording it in the register in the register's own established format.

## 2. Identifier assignment — inspected before use, not assumed

All three P2A design-gate reports labelled their proposal a placeholder, **"D-22,"** explicitly flagging it as pending "the register maintainer's actual numbering at ratification time." Before recording, this session inspected `docs/governance/GOVERNANCE_DECISION_REGISTER.md` directly (`grep -n "D-21\|D-22"`, 8927 lines total) and confirmed:

- **No `D-21` or `D-22` exists anywhere in the register.** Every occurrence of the string `D-21` (23 hits, re-verified) is a **negation** — every carried-item and dated-ratification entry since D-20 explicitly states *"NOT a new numbered decision — no D-21 is created and the 20-decision tally is unchanged (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN)"* — a convention repeated verbatim across at least fifteen separate entries (P0, P1A, P1C, P1D, Fire Authorization, P1F-2, FIFO Exhaustion, Approval Runtime Minimum Resolution, P1G-1, KDS MVP, Minimum Operational Reporting, Day Close, RCPT-R1, D1-1, AUD-R1).
- **The established convention for every ratification after D-20 is a slice-tagged, dated, unnumbered heading** — e.g. `## P1G-1 Cash-Close Policy Ratification — 2026-08-30`, `## RCPT-R1 — Internal-MVP Non-Fiscal Receipt Ratification — 2026-09-01`, `## D1-1 — Offline / Sync Protocol Foundation Ratification — 2026-09-02`, `## AUD-R1 — Audit Log Query/Export Permissions & Surface (FR-AUD-007/008)` — never a new `D-`-numbered slot.
- **Conclusion, per instruction not to "blindly use D-22":** the D-1..D-20 numbered-decision space is closed and has not been extended by any ratification since 2026-08-18 (D-20). This ratification follows the SAME convention used for every financial/operational decision ratified since: an unnumbered, slice-tagged, dated heading. This session assigns the tag **`P2A-R1`** — directly traceable to the report family that produced the design (`GOVERNANCE-GATE-P2A` → `CORRECTION-P2A2` → `CORRECTION-P2A3`), and following the `<TAG>-R1` shape already used by `RCPT-R1`/`AUD-R1` for "the first ratification of this slice family." The register's own 20-decision tally (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN) is unchanged by this entry, exactly as every predecessor states of itself.

## 3. Where recorded

New section appended at the **true end** of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (immediately after the existing final entry, `AUD-R1`, whose own closing `**Status:**` line was at the file's previous last line) — not inserted mid-document near the earlier "Final Decision Matrix" summary tables (lines ~8228-8790), which are a pre-existing, self-contained summary of D-1..D-20 only and are never the insertion point for a later entry; every entry recorded after D-20 in this register's history was appended strictly after the immediately-preceding entry, and this one follows that same practice.

The new section: **`## P2A-R1 — Financial Settings Governance Ratification (Country Pack Generic Lock Representation & FR-PLT-028 Effective-Dated Financial-Policy Storage) — 2026-09-10`**, structured exactly like `P1G-1`/`AUD-R1` — a boilerplate-consistent header block (RECORDED-by-explicit-user-governance-action, the no-D-21 disclaimer, the controlling-report note naming P2A3 as authoritative where the three reports differ), a **"The question"** framing section, a **"RATIFICATION"** section carrying **all eighteen clauses from the task's own instruction verbatim in substance** (reproduced from P2A3's D-22 REVISION 3 text, with the "D-22" placeholder identifier itself struck per §2 above — the SUBSTANCE of every clause is preserved exactly, only the never-adopted numbered-decision label is not carried forward), a **"Requirement impact"** section (FR-PLT-026 PARTIAL, FR-PLT-028 NOT_IMPLEMENTED, neither closed by governance alone), a **"What is ratified now / what remains implementation / what remains out of scope"** section, an **"Evidence (non-authoritative)"** section naming all four reports (the three P2A design-gate reports plus this one), and a closing **`Status: RATIFIED`** line naming 2026-09-10 and explicit user governance action, matching every prior entry's closing-line convention.

## 4. Traceability — P2A3 as the controlling text

Per instruction, the register entry states explicitly (in its header block) that **P2A3 supersedes P2A/P2A2's earlier text where they differ**: specifically, P2A's original setting-key reuse proposal (which would have created a `Localisation → PlatformSettings` cycle) is superseded by P2A2 §1's ownership split; P2A's original, unqualified "generic lock mechanism" statement for domain-owned financial policies is superseded by P2A2 §2's lock-on-immutable-version-row model; P2A2's original "no UPDATE/DELETE grant once effective" (not a real, enforceable PostgreSQL mechanism as stated) is superseded by P2A2 §3's RLS future-only-deletion policy; and P2A2's storage design (which had no `createdAt`/anti-backdating protection) is superseded by P2A3's clause 13/14 addition. The register entry's eighteen ratified clauses are drawn from P2A3's own final, corrected D-22 REVISION 3 text — the version the task instructed be used as controlling — not from the earlier, since-corrected P2A/P2A2 drafts.

## 5. Requirement impact — recorded exactly as instructed

Per instruction, neither requirement is marked COMPLETE from governance alone:

- **FR-PLT-026: still PARTIAL after ratification.** The register's own new entry states this explicitly. The governance blocker (no ratified representation for how Country Pack should express a generic settings lock) is now removed; the parser/model/resolver code implementing clause 1 is not written by this task and remains owed.
- **FR-PLT-028: still NOT_IMPLEMENTED after ratification.** The register's own new entry states this explicitly. The governance/design blockers (storage architecture, ownership matrix, lock model, anti-backdating invariant, transaction-pinning model) are now removed; the new domain table, resolver, `Order` columns, and full FR-POS-055..058 computation are not written by this task and remain owed.

## 6. Verification performed this session

- `git status --short` before writing: identical to the P2A3 session's ending state (only pre-existing untracked report files plus the three new P2A/P2A2/P2A3 reports from the prior three turns of this conversation).
- `grep -n "D-21\|D-22"` against the full register, re-run before writing the new entry, to confirm no numbered decision in that range exists anywhere (§2 above).
- Confirmed the exact byte-offset of the register's current final line (`AUD-R1`'s closing `**Status:**` sentence) before appending, so the new entry is provably appended after the existing content rather than inserted mid-document.
- After writing: `git status --short` and `git diff --stat` confirm exactly three files changed (register, this report, `INDEX.md`) and zero files under `src/`, `prisma/`, or `docs/api/` touched.

---

## RETURN

**PREVIOUS_HEAD:** `3402c37dd893ce8cc50782d1d7888346ee63126d`

**GOVERNANCE_DECISION_ID:** `P2A-R1` (an unnumbered, slice-tagged, dated ratification entry — per §2 above, `D-22` is explicitly NOT used; the D-1..D-20 numbered space remains closed and unchanged, 17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN)

**STATUS:** RATIFIED

**RATIFIED_BY_EXPLICIT_USER_ACTION:** Yes — recorded in the register as "RECORDED 2026-09-10 by explicit user governance action," per the user's own ratifying instruction quoted in §1 above.

**FR_PLT_026_STATUS_AFTER_RATIFICATION:** PARTIAL (unchanged). Governance blocker removed; implementation (Country Pack `settingsLocks` parser/model/resolver wiring) still required and not performed by this task.

**FR_PLT_028_STATUS_AFTER_RATIFICATION:** NOT_IMPLEMENTED (unchanged). Design/governance blocker removed; implementation (domain-owned financial-policy storage, resolver, `Order` pinning, FR-POS-055..058 computation) still required and not performed by this task.

**REGISTER_PATH:** `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (new `P2A-R1` section appended at the true end of the file)

**REPORT_PATH:** `docs/reports/claude/2026-09-10_FULL-SRS-PLT-FINANCIAL-SETTINGS-D22-RATIFICATION.md`

**INDEX_UPDATED:** Yes — one new row appended to `docs/reports/claude/INDEX.md`.

**FILES_CHANGED:**
```
docs/governance/GOVERNANCE_DECISION_REGISTER.md   (+P2A-R1 ratification entry)
docs/reports/claude/2026-09-10_FULL-SRS-PLT-FINANCIAL-SETTINGS-D22-RATIFICATION.md   (this report, new)
docs/reports/claude/INDEX.md   (+1 row)
```

**COMMIT:** see below (created after this report was written, containing exactly the three files above)

**SOURCE_FILES_TOUCHED:** None — `git diff --stat` confirms zero files under `src/`.

**PRISMA_TOUCHED:** None — `git diff --stat` confirms zero files under `prisma/`; no migration created; no generated OpenAPI file touched.

**SAFE_TO_BEGIN_P2B:** Yes, from a governance standpoint — the P2A-R1 ratification removes the governance blocker P2A3's own `SAFE_TO_START_IMPLEMENTATION: Not yet` was conditioned on. P2B (Country Pack `settingsLocks` parser/model/resolver wiring) may now begin as its own implementation slice. This task does not itself begin P2B, per its explicit scope.

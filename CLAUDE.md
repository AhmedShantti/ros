# ROS — Repository Instructions for Claude Code

## ROS Reporting Policy

- All substantive implementation, audit, design-gate, verification, and
  handoff reports MUST be written to `kitchen-kit/backend/docs/reports/claude/`.
- Maintain `kitchen-kit/backend/docs/reports/claude/INDEX.md`.
- Never overwrite previous substantive reports. Use dated, slice-specific
  Markdown filenames: `YYYY-MM-DD_<SLICE>_<short-description>.md` (kebab-case,
  no spaces). If more than one report for the same slice is produced on the
  same date, append `_02`, `_03`, etc.
- Every report must open with the required header (task/slice name, report
  type, authority statement, date, HEAD, branch, working tree summary, task
  identifier) before the task-specific sections.
- Reports are non-authoritative evidence; the SRS and ratified governance
  decisions remain authoritative. Every report must state this distinction
  explicitly.
- Final chat responses MUST be concise (roughly 3-6 lines) and point to the
  report path instead of reproducing the report. Do not paste report content,
  including tables or long explanations, into chat.
- If a report is long, write it entirely to the file; do not split it across
  chat messages or truncate it to save chat tokens.
- If a task is interrupted before a report is complete, keep the partial file,
  mark its header/status as PARTIAL, state exactly where work stopped, and
  update INDEX.md accordingly. A later continuation either completes the same
  file (same interrupted run) or creates a new `_02` report (new run). Never
  silently replace or lose prior evidence.
- Preserve exact requirement IDs, verification results, blockers, and
  requirement classifications in the report. Use only evidence actually
  verified in the current session; do not report old test/verification
  results as if newly executed.
- Do not commit unless explicitly instructed by the user.

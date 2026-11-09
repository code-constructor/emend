---
paths:
  - ".wt/review-log.md"
---

# Review rounds

A review exists to ship a correct change, not a perfect one. `/e-work` and `/e-pr-finalize` review
in rounds with a fixed budget. Never polish in an open loop.

## Classes

Sort every finding before you act on it:

- **blocking:** a bug, a security hole, data loss, a broken contract, a broken non-negotiable, a
  failing check, or a "Done when" line the change does not meet;
- **defect:** wrong or misleading text, a missing test for new behaviour, or another rule in
  `AGENTS.md` that the change breaks;
- **preference:** naming, structure, style or wording that is not wrong.

A finding about code the change did not touch, or outside the issue, is a **follow-up**, whatever
its class. A finding a reviewer calls a bug or a security issue is blocking, and every
`emend-security-reviewer` finding is at least a defect. To dispute a blocking finding, have a fresh
Codex review try to refute it, as `/e-pr-finalize` step 5 says. Only a confirmed false positive
moves to "Not changed".

## Rounds

- Commit before each round, so the reviewers read committed work and the log names that head.
- **Round 1** reviews the whole change.
- Fix every blocking finding and every defect, in one batch. Leave preferences as they are and list
  each one under "Not changed" in the PR body, with one line of reason. List follow-ups under
  "Follow-ups"; they never go into the change.
- After a round with fixes, run a **check round**: give the reviewers the earlier findings and the
  diff of the fixes only, and ask for each finding FIXED, NOT FIXED or REGRESSED, plus anything the
  fixes broke. A check round does not review the rest of the change.
- Stop at a round with nothing to fix, or at the budget.

## Budget

- `/e-work`: round 1, then at most two check rounds, `check-1` and `check-2`.
- `/e-pr-finalize`: one `final` round over the whole change, then at most one `final-check`. Skip
  the final round, and log `final-skipped`, when `/e-work`'s round 1 found no blocking finding or
  defect at the current head.
- Each batch of owner feedback from emend: one `owner-check` over its fixes, outside the finalize
  budget.
- A rebase alone needs no round.

## At the budget

- Defects and preferences still open go under "Not changed", with the reason.
- A blocking finding from the last allowed round: fix it, prove the fix with a test and
  `pnpm verify`, and name it under Evidence in the PR body. A fix you cannot prove stays open.
- An open blocking finding stops the work: run `<main>/bin/wt notify blocked`, name the finding and
  why the fixes did not hold, and wait for the owner.
- Never start a round past the budget.

## Log

Append one line per round to `.wt/review-log.md` in the worktree (gitignored), after the round's
fixes are committed. Use the Edit tool, or the Write tool when the file is new. Never copy finding
text into it. Each line holds the date and time, the skill, the round, the head the reviewers read,
found/fixed for blocking findings and defects, the counts of preferences and follow-ups, and the
blocking findings still open:

`2026-11-09 10:12 e-work check-1 3f2a91c blocking 1/1 defect 2/2 preference 3 follow-up 1 open 0`

Round names: `1`, `check-1`, `check-2`, `final`, `final-skipped`, `final-check`, `owner-check`. The
work loop reads only lines in this format, and from them only the round names and numbers.

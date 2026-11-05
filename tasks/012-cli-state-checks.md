---
id: 012
title: CLI state checks
status: open
owner: agent + your approval
depends_on: [005]
done_on:
---

# 012 — CLI state checks

Plan task 4.5b. The security review of plan task 4.5 found two gaps that every CLI command shares.
You agreed to both on 2026-11-05, the size cap on the condition that it never stops a publish.

## Steps

- [ ] Modes: before it reads a token, the CLI refuses a state folder or a token file that has
      group or other permission bits. One stderr line names the path and the `chmod` fix, and
      nothing changes. The server already checks the folder; the CLI does not yet.
- [ ] Reply cap: the CLI reads at most 64 MiB of a server reply, four times the largest hand-off
      the server sends. Uploads keep their own limits, so a publish never fails on this cap.
- [ ] Reviews pass: emend-reviewer, the Codex review and emend-security-reviewer.

## Done when

Both checks have landed and passed their reviews.

## Notes

- 2026-11-05: Opened from the security review of plan task 4.5. The sandbox hint for `emend ls`
  and `emend status` is no longer needed: the setup docs stopped listing sandbox exemptions the
  same day.

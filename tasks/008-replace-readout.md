---
id: 008
title: Replace readout
status: open
owner: agent + your approval
depends_on: [005]
done_on:
---

# 008 — Replace readout

Plan tasks 4.1–4.11 (slice 4). A readout page becomes an emend review without a diff: a docs-only
review that usually nobody waits on. Prepare now, and switch only after task 007 passes. The plan's
slice intro gives the order: 4.1 → 4.2 first; 4.3 and 4.5 share their contract work; 4.4 follows
4.3; 4.6 builds on 1.12b; 4.7 and 4.8 any time; 4.9 and 4.11 after task 007; 4.10 runs inside
task 007.

## Steps

- [x] 4.1: `emend publish <path>`, a shortcut for docs.
- [x] 4.2: the `emend-publish` skill, readout's skill on emend.
- [ ] 4.3: snooze, retire and delete, next to Approve. You confirmed the snooze proposal.
- [ ] 4.4: the Send bar says whether an agent waits; one resume command for any agent. After a
      Send, a window waits for the agent to pick it up and shows the resume command if none does;
      a review shows "Not picked up yet" or "Picked up" from the agent's confirmation.
- [ ] 4.5: agent commands `emend ls` and `emend status`.
- [ ] 4.6: built-in features for HTML docs. Waits for your go on plan task 1.12b.
- [ ] 4.7: any text file as a doc, shown as source.
- [ ] 4.8: larger size limits, measured first.
- [ ] 4.9: the hosted service and its cost. Discussion, after task 007.
- [ ] 4.10: sign-in per browser on the phone. You check it during task 007.
- [ ] You: 4.11, the switch from readout, after task 007 and 4.1–4.4 and 1.12b.

## Done when

You have switched from readout (plan task 4.11), or dropped the switch.

## Notes

- 2026-11-03: Slice started. 4.1 landed as e246d9e and 4409261.
- 2026-11-04: 4.2 landed as fd892f5. 4.3's first commit (contract, database, API and agent side)
  landed as 6f657cf; the web UI follows.
- 2026-11-04: 4.4 grows a pick-up window after Send and the "Not picked up yet" and "Picked up"
  states, from your feedback. A pick-up means the agent's CLI confirmed the delivery, never that
  the agent is working on it.

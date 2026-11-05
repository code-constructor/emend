---
id: 014
title: Parallel work in worktrees
status: in-progress
owner: agent + your approval
depends_on: []
done_on:
---

# 014 — Parallel work in worktrees

Slice 5, plan task 5.1, from the plan of record for parallel work. Work on emend runs in linked
worktrees under `.claude/worktrees/`, from spawn to a merge the owner approved in emend. `bin/wt`
is a plain developer tool that owns worktree setup, history rewrites, pushes, pull request creation
and merges, and the herdr calls. Seven `/e-*` skills drive it, and call `gh` directly for reads.
One step below per plan task, in the plan's order. The guard, sandbox and protection steps of plan
task 3 are dropped; tasks 4 to 11 are done in the plain-tool form.

## Steps

- [x] 1: Dropped with the sandbox: the probe of the sandbox door.
- [x] 2: Dropped with the sandbox: the worktree half of that probe.
- [x] 3: Dropped: the guard, the sandbox and the protection steps. The delivery rules landed in
      `AGENTS.md`.
- [x] 4: `bin/wt` core: setup, list, cleanup, the registry, ports and the safety guard.
- [x] 5: Tasks, reservations, gc and the interactive menus; rewrite this directory's README.
- [x] 6: Free text, push and pull requests through `bin/wt`.
- [x] 7: Rebase, restack, land, sync-main and digest.
- [x] 8: herdr: spawn, notify and workspace close.
- [x] 9: Skills `/e-work` and `/e-spawn`.
- [x] 10: Skills `/e-pr`, `/e-pr-finalize` and `/e-rebase`.
- [x] 11: Skills `/e-pr-merge` and `/e-merge-local`.
- [ ] 12: Dry runs on the GitHub path, the behind case, the local path and the manual path; fix
      what they find; close this task.
- [ ] 13: Follow-up: `bin/wt` verifies the emend approval itself (needs a CLI or API surface).

## Done when

A spawned task reached an emend-approved merge and cleanup, and a second one landed locally.

## Notes

- New branches start from local `main`, which can be ahead of `origin/main`; `setup --from <ref>`
  overrides it. `setup` copies the gitignored files that `.worktreeinclude` lists.
- 2026-11-04: Opened. Main took 012 and 013 first, so this task is 014.

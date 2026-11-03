---
id: 003
title: Spike the diff renderer
status: done
owner: agent; you name the branch
depends_on: [002]
done_on: 2026-11-03
---

# 003 — Spike the diff renderer

Plan task 0.3. Try `@pierre/diffs` on a large branch in `spikes/diffs/` (gitignored, never
committed). Record numbers only, never paths, file names or code from the branch.

## Steps

- [ ] ~~You: name the branch.~~ Dropped.
- [ ] ~~Build the spike page and run it on the branch.~~ Dropped.
- [x] Answer the plan's ten questions in its build log, with a verdict: go, or a change of plan.

## Done when

The verdict is recorded. A change of plan goes back to you before slice 1.

## Notes

- 2026-10-26: Provisional go, on a synthetic branch of 400 files and 29,240 changed lines with a
  50,000-line file. The library covers full-text input, split and unified views, line selection
  with sides, React threads under lines, the ten languages and word changes, and virtualization,
  and the app's CSP needs no change with the `shiki-js` highlighter. Task 1.11 must parse diffs off
  the main thread and mount only files near the viewport: one lockfile-sized parse took 22 s. The
  browser checks (first file in 1.5 s, scrolling, memory, 390 px, gutter drag, CSP enforcement)
  are still open, because the agent sandbox cannot run a browser or a local server. The run on a
  branch you name is still open too.
- 2026-11-03: Done; the go stands. Plan task 1.11 built the diff pane on the library, and the
  owner's first real review ran on it. The first two steps were dropped: the spike ran on a
  synthetic branch only, the run on a named branch was never made, and real use replaces it. The
  browser speed bars (first file in 1.5 s, scroll stalls, memory) were never measured.

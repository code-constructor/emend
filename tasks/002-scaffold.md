---
id: 002
title: Scaffold the workspace and the gate
status: done
owner: agent + your approval
depends_on: [001]
done_on: 2026-11-03
---

# 002 — Scaffold the workspace and the gate

Plan task 0.2. pnpm workspaces with `apps/emend`, `apps/web`, `packages/contract` and
`packages/core`; lint, typecheck, test and build in `pnpm verify`; CI on Node 24 and 26.

## Steps

- [x] You: approve the dependencies the plan lists for this task.
- [x] Write the failing tests, install, implement the scaffold.
- [x] `pnpm verify` passes, and `node apps/emend/dist/emend.mjs --version` prints `emend 0.1.0`.
- [x] You: push, and CI is green on both Node versions.

## Done when

The full gate is green locally and in CI.

## Notes

- 2026-10-26: Scaffold implemented with the dependency versions the plan lists. The required
  tests were red before the implementation and pass now. `pnpm verify` is green locally, and the
  built CLI prints its version. CI on Node 24 and 26 waits for the owner's push.
- 2026-11-03: Done. CI is green on Node 24 and 26 for pushed `main` (checked on 4409261). The
  later run for 30f2c91 failed on Node 24 only, with Node 26 green; that failure is outside this
  task.

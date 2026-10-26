---
id: 002
title: Scaffold the workspace and the gate
status: open
owner: agent + your approval
depends_on: [001]
done_on:
---

# 002 — Scaffold the workspace and the gate

Plan task 0.2. pnpm workspaces with `apps/emend`, `apps/web`, `packages/contract` and
`packages/core`; lint, typecheck, test and build in `pnpm verify`; CI on Node 24 and 26.

## Steps

- [ ] You: approve the dependencies the plan lists for this task.
- [ ] Write the failing tests, install, implement the scaffold.
- [ ] `pnpm verify` passes, and `node apps/emend/dist/emend.mjs --version` prints `emend 0.1.0`.
- [ ] You: push, and CI is green on both Node versions.

## Done when

The full gate is green locally and in CI.

## Notes

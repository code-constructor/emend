# Tasks

The work queue for this repo. One file per task, numbered in the order they should happen. The
design and the plan of record live outside this repo, with the owner. Task content comes from the
plan, and each task names the plan's task numbers.

## "What should I do now?"

When the owner asks what to do next:

1. Read the table below and each task file's frontmatter.
2. Pick the lowest-numbered task whose `status` is `open` and whose `depends_on` tasks are all
   `done`.
3. Answer with its title, who does it (`owner`), the first unchecked step, and its "Done when"
   line. Mention anything `blocked`.
4. For task 008, the next step is the first unchecked step in its list, in the order its
   intro gives.
5. If no task qualifies, say so and point to the plan. Do not invent work.

## Keeping it current

- Tick a step's checkbox when it is done.
- When a task is done: set `status: done` and `done_on: YYYY-MM-DD`, add one line under "Notes",
  and update the table below in the same change.
- A task that is no longer needed gets `status: dropped`, `done_on` and a line under "Notes".
- New work comes from the plan. It gets the next free number below 099 and a row in the table.
  Keep the frontmatter fields.
- `owner: you` means the owner runs it. Agents may prepare and guide, but never run the commands
  `AGENTS.md` reserves for the owner.

## Queue

| # | Task | Owner | Depends on | Status |
|---|---|---|---|---|
| 001 | [Port the harness](001-port-harness.md) | agent + your approval | — | done |
| 002 | [Scaffold the workspace and the gate](002-scaffold.md) | agent + your approval | 001 | done |
| 003 | [Spike the diff renderer](003-spike-diffs.md) | agent; you name the branch | 002 | done |
| 004 | [Spike SQLite with Drizzle](004-spike-sqlite.md) | agent | 002 | done |
| 005 | [Build the MVP](005-build-mvp.md) | agent + your approval | 003, 004 | done |
| 006 | [Brainstorm the layout and the phone menu](006-layout-brainstorm.md) | you, with the agent | — | done |
| 007 | [Run the success test](007-success-test.md) | you | 005 | open |
| 008 | [Replace readout](008-replace-readout.md) | agent + your approval | 005 | open |

---
id: 004
title: Spike SQLite with Drizzle
status: done
owner: agent
depends_on: [002]
done_on: 2026-10-26
---

# 004 — Spike SQLite with Drizzle

Plan task 0.4. Try `node:sqlite` through Drizzle's `sqlite-proxy` driver in `spikes/sqlite/`
(gitignored).

## Steps

- [x] Build the spike and answer the plan's six questions in its build log.
- [x] Verdict: go, or fall back to `better-sqlite3` (that goes back to you).

## Done when

The verdict is recorded.

## Notes

- 2026-10-26: Go. One `DatabaseSync` handle behind the `sqlite-proxy` driver, with positional
  rows. Claim counts come from the raw statement result. Transactions on the handle are
  serialized, and migrations are embedded in the bundle. Node 24 and 26 print no experimental
  warning.

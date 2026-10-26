---
id: 001
title: Port the harness
status: done
owner: agent + your approval
depends_on: []
done_on: 2026-10-26
---

# 001 — Port the harness

Plan task 0.1. Bring the agent rules, guards, reviewers and gate checks into this repo, adapted to
the monorepo: the server binds loopback unless told otherwise, and the Cloudflare-only rules go.

## Steps

- [x] Copy and adapt the agents, hooks, settings, Codex rules, check scripts, CI and rule files.
- [x] `pnpm verify` reports `check:budget`, `check:sync` and `test:harness` ok.
- [x] The guard refuses `git push` and `pnpm publish` with their reasons.
- [x] The public hygiene grep finds nothing.
- [x] `emend-security-reviewer` reviews the guards, settings and CI.

## Done when

`pnpm verify` passes and the security review's findings are fixed or recorded.

## Notes

- 2026-10-26: done. The security review led to these changes: the guard refuses every push
  (the repo is public) and Codex sessions outside the repo; the settings deny the macOS state
  directory and nested `.env` files and ask before edits to agents, rules and CI; the rule files
  carry the exact cookie, CSP, pairing and Host values; the CLI rule covers git filter drivers.
  Open: `check:budget` does not yet check `.codex/config.toml` (`network_access = false`) or
  `sandbox.failIfUnavailable`; plan task 0.2 sets a temporary `EMEND_HOME` for every test run.

---
id: 013
title: Release emend and document every setup
status: open
owner: agent + your approval
depends_on: [005]
done_on:
---

# 013 — Release emend and document every setup

Plan slice 6 (tasks 6.1 to 6.3). You asked on 2026-11-04 for a real release and clean setup docs,
with an agent prompt for each part. Anyone installs and runs their own emend and sets it up as they
like: local only, their own hub over Tailscale, their own hub on their own network, more machines
attached to their hub, or all of them. The first outside user starts on 2026-11-05, on macOS.

6.1 and 6.2 come first, before that user starts. 6.3 follows, R.3 first. One commit per step.

## Steps

6.1 Release pipeline:

- [x] R.1: `apps/emend/package.json`, `apps/emend/src/version.ts` and `plugin.json` carry the
      same version. `version.test.ts` fails when `version.ts` differs, and `check:package` fails
      when `plugin.json` differs. `pnpm release` writes all three; nobody edits them by hand.
- [x] R.2: `pnpm release <x.y.z>` bumps the versions, drafts `CHANGELOG.md` from the commits since
      the last tag, runs the gate and writes the commit message. It never commits, tags, pushes or
      publishes. `docs/releasing.md` holds the policy and your checklist.
- [x] R.4: the docs install the Claude Code plugin from `shllg/emend@release`.
- [ ] You: publish 0.1.0 to npm, then push `main`, the tag and `release`.

6.2 Setup docs:

- [x] D.1: the README becomes a landing page with absolute links; usage moves to `docs/usage.md`.
- [x] D.2: `docs/setup.md` keeps its URL and becomes the index with the one-prompt setup.
- [x] D.3 to D.8: `docs/setup/local.md`, `hub-tailscale.md`, `attach.md`, `agents.md`,
      `update.md` and `troubleshooting.md`, each for Linux and macOS.
- [x] D.9: one prompt per page and one per step, for Claude Code and Codex.
- [x] D.10: dry run of the packed tarball with a fresh `EMEND_HOME`, following `local.md`.

6.3 Smooth updates and any network:

- [ ] R.3: a release workflow publishes a signed tag to npm with provenance.
- [ ] N.1: `emend serve --public-url <origin>` for a hub behind your own address;
      `docs/setup/hub-network.md`.
- [ ] S.1: `emend` and `emend service status` say when the running server is another version.
- [ ] S.2: `emend stop`.
- [ ] S.3: `publish`, `wait`, `feedback`, `reply` and `mcp` refuse an `emend` that resolves inside
      the current repository, as `emend service install` already does. Under mise, a repo's own
      tool config can point `emend` at its code, and agents run these commands with full rights.
- [ ] S.4: emend remembers the Tailscale Serve route it created, so a route left by a crash is
      still removed on the next stop (open owner item 31).

## Done when

0.1.0 is on npm, a reader with a new Linux or macOS machine reaches a working setup from the
README alone, every setup has its page with prompts, and the 6.3 steps have landed and passed
their reviews.

## Notes

- 2026-11-05: For plan task 6.2, you chose to leave sandbox setup to each agent's own
  documentation. The setup docs drop the sandbox and deny rules, and say that any program that can
  read emend's state folder can act as you. Developing from a checkout moves from the README to
  `docs/setup/development.md`.
- 2026-11-04: Opened from your request. You chose the `release` branch for the plugin and open
  networking. 012 stays with plan task 5.1.
- 2026-11-04: Codex was not reachable (no `codex` MCP server), so Sonnet sub-agents built and a
  second Sonnet reviewer stood in for the Codex review. The security reviews added S.3 and S.4,
  and moved the publish step to a fresh clone of the pushed tag.
- 2026-11-04: R.1 first injected the version at build time (`__EMEND_VERSION__`). The gate failed:
  three test files load `apps/emend/src` through plain Node or their own esbuild call, where that
  global does not exist. R.1 now keeps the literal in `version.ts`, and `pnpm release` writes it.
  R.1 lands in R.2's commit, since both change `scripts/check-package.ts`.

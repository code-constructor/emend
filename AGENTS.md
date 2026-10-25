# emend client — working rules

This repository is the public client for an emend server: the `emend` CLI, its installer and the
v1 API contract. It is open source (MIT). The server is a separate project that implements the
contract kept here.

emend is a review surface next to Hunk. The owner comments on an agent's review writeup (a span, a
group or the whole review) and presses one Send. The agent waiting in `hunk-plan wait` gets those
comments together with the owner's Hunk notes.

Status: nothing built yet. The toolchain and `pnpm verify` come with the first scaffold.

## What will live here

- `cli/`: the `emend` CLI (`publish`, `take`, `reply`). TypeScript on Node 22, bundled into one
  file with no runtime dependencies.
- `bin/emend`: a POSIX sh wrapper that runs the bundle.
- `install.sh`: links the CLI into the user's home. Idempotent. Never replaces a file or a symlink
  it does not own.
- `contract/`: zod schemas for the page model, the hand-off and the API. A server pins this repo
  at a commit and imports them.
- `docs/api.md`: the v1 HTTP contract, the source of truth for the API.
- `sync/`: the manifest of surfaces shared with hunk-review-skill, and synthetic fixtures.

## Rules

1. **Public by default.** Never add personal paths, private hostnames, private repository names,
   client content, secrets, or notes about anyone's infrastructure.
2. **Contract first.** The API is versioned under `/api/v1`. A CLI or server change that needs a
   new endpoint or field changes `contract/` and `docs/api.md` first. Additive fields are fine;
   breaking changes need `/api/v2`.
3. **The CLI never runs code from the repo under review.** No repo scripts, no package manager,
   git only for allowlisted read-only lookups. Config comes from `EMEND_URL`, `EMEND_TOKEN` and
   `git config --local emend.publish`, never from files in that repo.
4. **Keep `hunk-plan` callers working.** A change to a shared surface carries a `Sync:` trailer.
5. **Fixtures are synthetic.** Real hunk state files and text from reviewed repos never become
   fixtures, tests or commit messages.
6. **Never read secrets.** No tokens or `.env` values in output, code or commits. Check a variable
   with `[[ -n $VAR ]]`.
7. **No AI attribution** in commits, trailers, comments, docs or PRs.

## Before you touch

| You touch | Read first |
|---|---|
| `cli/`, `bin/`, `install.sh` | `.claude/rules/cli.md` |
| `contract/`, `docs/api.md`, `sync/` or a path in `sync/manifest.json` | "Sync with hunk-review-skill" below |

## Sync with hunk-review-skill

[hunk-review-skill](https://github.com/vendis-ai/hunk-review-skill) writes the review plan, the
report directory and the hand-off contracts emend reads. It is not being retired: both projects
stay maintained. Every improvement made here is checked against hunk-review-skill and applied there
in its own way when it fits, and every improvement there is checked against emend. That covers
contract and CLI changes, review wording and review insights alike. The local path of its checkout
is in `.sync-counterpart-path` (gitignored).

`sync/manifest.json` lists the shared surfaces: plan schema, report directory, page model,
hand-off, wait contract, notes journal, note handling and review wording. Each surface's `self`
globs are this repo's paths.

1. A commit touches a `self` path or anything under `sync/`.
2. Open the counterpart in the sibling checkout (`.sync-counterpart-path`).
3. Make the matching change there under that repo's rules, or decide none is needed.
4. Give the commit one trailer:
   - `Sync: hunk-review-skill@<sha>`
   - `Sync: none — <reason>`
   - `Sync: pending hunk-review-skill <task>`

An improvement that touches no listed path is still checked against hunk-review-skill. Record the
outcome in the commit body. New code for a shared surface adds its globs to `self` in the
same commit.

## Delivery

- Until the first release, all work lands directly on `main`. No feature branches, no PRs.
- Commit only when the owner asks. One logical change per commit.
- Agents never push. The owner pushes `main`. Never push tags, never force-push.

## Commits

[Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): summary`.

- **Types:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`.
- **Scopes:** `cli`, `install`, `contract` (`contract/` and `docs/api.md`), `sync`, `harness`,
  `deps`. Omit the scope when a change spans the repo.
- **Summary:** lowercase, no trailing period, at most 72 characters, the effect a user sees.
- **Breaking changes:** `!` after the type or scope, plus a `BREAKING CHANGE:` footer.
- Trailers: `Sync:` and `BREAKING CHANGE:` only. No co-author or attribution trailers.

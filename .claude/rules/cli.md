---
paths:
  - "cli/**"
  - "bin/**"
  - "install.sh"
---

# The emend CLI

The CLI is the only bridge between the laptop's files and an emend server. It runs inside repos
under review, so treat those repos as hostile.

- Config comes only from `EMEND_URL`, `EMEND_TOKEN` and `git config --local --get emend.publish`.
  Never from files in the reviewed repo, from global or `-c` git config, or from `package.json`.
- `EMEND_URL` is https, except a loopback host. Never print the token, and never send it anywhere
  but `EMEND_URL`.
- emend counts as configured only when `command -v emend` succeeds, both variables are non-empty,
  and the repo's local git config sets `emend.publish` to `true`. Otherwise each command exits as
  if emend did not exist.
- Read only the report directory, the plan, the doc pages `meta.json` lists, and the CLI's own
  state files. List the doc pages before you upload them. Resolve real paths, read regular files
  only, and enforce the size limits.
- Never run code from the reviewed repo: no scripts, hooks or package managers. Call git with an
  argv array, never through a shell. Allow only read-only lookups (`rev-parse`, `config --get`,
  `symbolic-ref`, `cat-file`). Pass `-c core.fsmonitor=false`, and never use a command that runs
  filters, pagers or an external diff.
- `emend take` writes a `go.json` only by the claim and fold rules of the hand-off contract. It
  never overwrites a `go.json` it did not claim, and it never writes stdout.
- When emend is down or rejects the token, print one line on stderr and change nothing.
- Hunk notes never leave the laptop.
- `go.json`, `delivered.json`, `emend.json` and the wait contract are shared surfaces. A change
  needs a `Sync:` trailer.
- Tests use temp directories and synthetic fixtures only, never `~/.local/state/hunk`.

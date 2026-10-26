---
paths:
  - "apps/emend/src/cli/**"
  - "apps/emend/bin/**"
  - "install.sh"
---

# The emend CLI

The CLI runs inside repos under review, so treat those repos as hostile.

- Config comes only from emend's own state directory (`EMEND_HOME`, else the XDG data directory)
  and the environment. Never from files in the reviewed repo, from its git config or from its
  `package.json`.
- Never run code from the reviewed repo: no scripts, hooks or package managers. Call git with an
  argv array, never through a shell, and only in the allowlisted forms: `rev-parse`, `merge-base`,
  `diff --name-status`, `diff --numstat`, `show`, `cat-file`, `ls-files`,
  `config --get remote.origin.url`. Each runs with `-c core.fsmonitor=false` and
  `GIT_OPTIONAL_LOCKS=0`; `diff` and `show` also with `--no-ext-diff --no-textconv`. Anything else
  throws `GitNotAllowed`.
- Filter drivers (`filter.<name>.clean`, `.process`, chosen by `.gitattributes`) run whenever git
  hashes a working-tree file. Every call also passes `--attr-source=<the empty tree>`, so no
  attribute picks a driver, and working-tree contents are read from disk, never through git.
  `cat-file` never takes `--filters` or `--textconv`.
- Read only what the manifest names: the manifest itself, the changed paths through git, the doc
  sources and the assets inside each HTML doc's folder. Resolve real paths, read regular files
  only, skip symlinks that leave the doc's folder, and enforce the size limits.
- stdout is a contract: `emend publish` prints one JSON line; `emend wait` and `emend feedback`
  print one JSON object with `kind` `go`, `approve` or `pending` and exit 0. Any error prints one
  line on stderr, nothing on stdout, and exits 1.
- Tokens come from the state directory (`agent.token`, `admin.token`, `hub.token`). Never print a
  token, and never send it anywhere but the server it belongs to.
- When the server or the hub is down, or rejects the token, print one line on stderr and change
  nothing.
- `emend wait` confirms a delivery only after its stdout has flushed.
- Tests use temporary `EMEND_HOME` folders and git repos built in the test, never real state.

---
paths:
  - "apps/emend/src/cli/**"
  - "apps/emend/bin/**"
---

# The emend CLI

The CLI runs inside repos under review, so treat those repos as hostile.

- Config comes only from emend's own state directory (`EMEND_HOME`, else the XDG data directory)
  and the environment. Never from files in the reviewed repo, from its git config or from its
  `package.json`.
- Never run code from the reviewed repo: no scripts, hooks or package managers. Call git with an
  argv array, never through a shell, by an absolute path resolved from the absolute `PATH`
  entries only, and only in the plumbing forms of the `GitCall` union in
  `apps/emend/src/cli/git.ts`: `--version`, `rev-parse`, `diff-tree` (tree against tree),
  `ls-tree`, `ls-files`, `cat-file -s` and `cat-file blob` by object id,
  `config --bool --get core.filemode` and `config --get remote.origin.url`. Anything else throws
  `GitNotAllowed`. Porcelain `diff`, `show` and `status`, and `diff-index` and `diff-files`, stay
  out: they compare against the worktree.
- Each call runs with `-c core.fsmonitor=false`, `-c core.hooksPath=/dev/null`,
  `-c core.attributesFile=/dev/null`, `-c protocol.allow=never`, `-c core.untrackedCache=false`,
  and an environment of the absolute `PATH` entries, `HOME`, `GIT_OPTIONAL_LOCKS=0`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `GIT_NO_LAZY_FETCH=1` and `LC_ALL=C`. Every call but
  the two bootstrap calls (`--version` and `rev-parse --show-object-format`, which come before the
  empty tree is known) adds `--attr-source=<the empty tree>`. `diff-tree` also takes
  `--no-ext-diff --no-textconv`. git 2.44 is the floor.
- The worktree root is the nearest ancestor of the working directory that holds `.git`, found on
  disk. Repo config never moves it: when `rev-parse --show-toplevel` disagrees (`core.worktree`),
  the CLI refuses the repo. The root follows the `docRoots` rules, checked before any git call or
  manifest read: publish refuses a root that is the filesystem root, the home folder or holds it,
  or holds or sits inside the state folder.
- Filter drivers (`filter.<name>.clean`, `.process`) run whenever git hashes a working-tree file,
  and `.git/info/attributes` picks them past every fence: git re-hashes a "racy" index entry
  through the filter in any index-to-worktree comparison. So git never touches the worktree.
  The CLI reads worktree files from disk and hashes them as git blobs itself. `cat-file` never
  takes `--filters` or `--textconv`.
- Read only what the manifest names: the manifest itself, the changed paths through git, the doc
  sources and the assets inside each HTML doc's folder. Resolve real paths, read regular files
  only, skip symlinks that leave the doc's folder, and enforce the size limits. A path behind a
  symlinked folder is absent, as git sees it, and no read lands inside the git folder or the
  common git folder.
- stdout is a contract: `emend publish` prints one JSON line; `emend wait` and `emend feedback`
  print one JSON object with `kind` `go`, `approve` or `pending` and exit 0. Any error prints one
  line on stderr, nothing on stdout, and exits 1.
- Tokens come from the state directory (`agent.token`, `admin.token`, `hub.token`). Never print a
  token, and never send it anywhere but the server it belongs to.
- When the hub is down, or the server or the hub rejects the token, print one line on stderr and
  change nothing. A local server that is down is not an error: `publish`, `wait`, `feedback`,
  `reply` and `mcp` then work on the state directory's database directly and never start a server.
  Only `emend` with no arguments and the service start one.
- `emend wait` confirms a delivery only after its stdout has flushed.
- Tests use temporary `EMEND_HOME` folders and git repos built in the test, never real state.

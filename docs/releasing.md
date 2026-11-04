# Releasing emend

This page is for maintainers. It covers the versioning policy, the one-time setup and the release
checklist for `@shllg/emend` and the Claude Code plugin.

## Versioning

emend follows semantic versioning, read this way before 1.0:

- **Patch** (`0.1.1`): fixes only.
- **Minor** (`0.2.0`): new features, and any change that needs the hub updated before the machines
  attached to it.
- **`MIN_CLIENT_VERSION`** in `packages/contract` rises only when a server stops serving an older
  client. Raise it in the same release that drops the old behavior, never earlier.
- **Breaking API change**: it goes to `/api/v2`. `/api/v1` keeps its shape (additive fields only).

Three files carry the version: `apps/emend/package.json`, `plugin/.claude-plugin/plugin.json` and
the `VERSION` constant in `apps/emend/src/version.ts`. `pnpm release` writes all three. The plugin
file matters because Claude Code caches a plugin by that value: a release that does not change it
never reaches plugin users. `version.test.ts` fails when `version.ts` differs from `package.json`.
`pnpm check:package` fails when `plugin.json` differs, and it checks the packed `emend --version`.
Nobody edits the three files by hand.

## One-time setup

Make the GitHub repository public before the first release: the release clone, the plugin
marketplace and the setup prompts all read it anonymously.

1. Create an npm account and make it the owner of the `@shllg` scope. Set two-factor authentication
   to the "authorization and writes" level, so publishing asks for a code. In the package's
   settings on npmjs.com, require two-factor authentication to publish.
2. In the GitHub repository, add a ruleset: only the owner may update the `release` branch, with no
   force pushes and no deletion; and tags matching `v*` cannot be moved or deleted. The Claude Code
   marketplace follows `release`, so whoever can move it controls what plugin users receive.
3. Publish the first release by hand (the checklist below). The `release` branch does not exist
   until the first push to `refs/heads/release`; that push creates it.
4. Later, a release workflow with npm trusted publishing will replace the hand publish; it is not
   built yet. Until it exists, steps 4 and 5 of the checklist are yours.

## Release checklist

Work in your own terminal, not in an agent session: other sessions may write to a shared checkout.

1. `pnpm release <x.y.z>` on `main` with a clean working tree. It refuses unless the version is
   plain `x.y.z` without leading zeros and above the highest `v<x.y.z>` tag merged into `HEAD` (the
   first release may equal the current package version), no tag `v<x.y.z>` exists locally, the
   branch is `main`, the tree is clean and `CHANGELOG.md` has no section for the version. It bumps the three version files, drafts `CHANGELOG.md` from the
   commits since that tag, runs `pnpm verify` (unless `--skip-gate`) and prints the steps below. It
   never commits, tags, pushes or publishes.
2. Review `CHANGELOG.md`, then stage the four files and look at the staged diff:

   ```sh
   git add apps/emend/package.json plugin/.claude-plugin/plugin.json \
     apps/emend/src/version.ts CHANGELOG.md
   git diff --staged
   ```

   The diff must show only the version lines and the new changelog section, because another
   session could have edited the files while the gate ran.
3. `git commit -S -m "chore: release <x.y.z>"`, then `git tag -s v<x.y.z> -m "emend <x.y.z>"`, then
   `git push origin main v<x.y.z>`. Every commit is signed; the signed tag marks what is released;
   the code and the tag must be public before the package that points at them. The release commit
   touches no shared surface from `sync/manifest.json`, so it needs no `Sync:` trailer.
4. Pack from a fresh clone of the pushed tag, so neither the packing script nor its inputs come
   from a working tree that other sessions write to:

   ```sh
   d="$(mktemp -d)"
   git clone --depth 1 --branch v<x.y.z> https://github.com/shllg/emend.git "$d/emend"
   node "$d/emend/scripts/release-pack.ts" <x.y.z>
   ```

   Run it with plain `node`, not `pnpm run`, so nothing installs from the checkout first. The
   script refuses in an agent session, unless the clone is clean and its `HEAD` is the tag's
   commit, unless the tag is signed and valid, unless `origin` has the same commit, and unless the
   tag's three version files all carry `<x.y.z>`. It extracts
   exactly that commit, installs from the lockfile without running dependency scripts, builds,
   packs once, runs `check:package` on that exact tarball, refuses if the tarball changed during
   the check and keeps the folder. `git verify-tag` accepts any key in your keyring, so keep only
   keys you trust there; the script does not pin a fingerprint.
5. Run the `npm publish ...` command it prints, exactly as printed. It passes `--ignore-scripts`
   because the packed manifest lists `prepack` and `postpack`, which need the repository, and it
   names the public registry. Compare the `shasum` it printed with npm's `shasum:` line, and the
   start and end of the `integrity` it printed with npm's shortened `integrity:` line, before you
   enter the two-factor code; npm asks for the code here.
6. Check that the package is live:
   `npm view @shllg/emend@<x.y.z> version --registry=https://registry.npmjs.org/`. Continue only
   when it prints `<x.y.z>`. The marketplace follows `release`, so plugin users would otherwise
   get skills for a CLI version that is not on npm yet.
7. `git push origin 'v<x.y.z>^{commit}:refs/heads/release'` (quoted for zsh). This moves the
   `release` branch to the tagged commit.
8. Remove the two temporary folders: `"$d"` and the one `release-pack` kept.

Steps 4 and 5 go away once a release workflow exists.

### If the gate fails

`pnpm release` leaves the bumped files in place. On a first release `CHANGELOG.md` is untracked:
restore the three version files with `git checkout -- apps/emend/package.json
plugin/.claude-plugin/plugin.json apps/emend/src/version.ts` and delete `CHANGELOG.md`. On later
releases restore `CHANGELOG.md` too, with `git checkout --`. Fix the cause and run `pnpm release` again; it refuses to run twice
for a version once `CHANGELOG.md` has its section.

`--skip-gate` skips `pnpm verify`. The script says so; the gate must pass before you tag.

## What users see

- **npm users** get the new version through `mise upgrade` or `npm install -g @shllg/emend`.
- **Claude Code users** get the new skills when `release` moves and they update the plugin, or
  when they have plugin auto-update on.

## Verify a release

```sh
npm view @shllg/emend version --registry=https://registry.npmjs.org/
prefix="$(mktemp -d)"
npm install -g --registry=https://registry.npmjs.org/ --prefix "$prefix" @shllg/emend@<version>
"$prefix/bin/emend" --version
```

The versions must match the released one. Check that the `release` branch points at the tagged
commit with `git ls-remote origin refs/heads/release`.

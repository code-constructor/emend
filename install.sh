#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

dry_run=0
for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) dry_run=1 ;;
    -h|--help)
      printf 'Usage: install.sh [-n|--dry-run] [-h|--help]\n'
      exit 0 ;;
    *) printf 'install.sh: unknown option %s\n' "$arg" >&2; exit 2 ;;
  esac
done

case "${HOME:-}" in
  /*) ;;
  *) fail 'HOME must be an absolute path.' ;;
esac

script="${BASH_SOURCE[0]}"
hops=0
while :; do
  directory=$(CDPATH= cd -P -- "$(dirname -- "$script")" && pwd -P)
  script="$directory/$(basename -- "$script")"
  [ -L "$script" ] || break
  [ "$hops" -lt 40 ] || fail 'too many levels of symlinks'
  hops=$((hops + 1))
  link=$(readlink "$script")
  case "$link" in
    /*) script="$link" ;;
    *) script="$directory/$link" ;;
  esac
done

checkout="$directory"
source_path="$checkout/apps/emend/bin/emend"
bin_dir="$HOME/.local/bin"
target="$bin_dir/emend"

command -v node >/dev/null 2>&1 || fail 'Node is required; install the version specified in apps/emend/package.json.'
node_version=$(node -p process.versions.node 2>/dev/null) || fail 'could not read the Node version.'
node - "$checkout/apps/emend/package.json" "$node_version" <<'NODE'
// Keep this check parseable by old Node releases so they receive one error line.
var readFileSync = require("fs").readFileSync;
try {
  var floor = JSON.parse(readFileSync(process.argv[2], "utf8")).engines.node;
  var required = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(floor);
  var actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.argv[3]);
  if (!required) throw new Error("unsupported engine floor");
  var supported = Boolean(actual);
  for (var index = 1; actual && index <= 3; index++) {
    if (Number(actual[index]) === Number(required[index])) continue;
    supported = Number(actual[index]) > Number(required[index]);
    break;
  }
  if (!supported) {
    console.error("install.sh: Node " + floor + " is required (found " + process.argv[3] + ").");
    process.exit(1);
  }
} catch (error) {
  console.error("install.sh: could not read the Node engine floor from apps/emend/package.json.");
  process.exit(1);
}
NODE

command -v pnpm >/dev/null 2>&1 || fail 'pnpm is required; run corepack enable, then run install.sh again.'

# Resolve links component by component, including dangling targets. Resolving ..
# after each symlink keeps a path through a foreign directory from looking owned.
check_destination() {
  node - "$checkout" "$bin_dir" "$target" "$source_path" "$1" <<'NODE'
const { accessSync, constants, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } = require("node:fs");
const { dirname, isAbsolute, join } = require("node:path");
const [checkout, bin, target, source, mode] = process.argv.slice(2);
const foreign = "~/.local/bin/emend exists and was not made by this checkout; move it away, then run install.sh again.";
const unusable = "~/.local/bin is not a folder this user can write to; fix it, then run install.sh again.";
function fail(message) {
  console.error(`install.sh: ${message}`);
  process.exit(1);
}
function resolvePath(path, depth = 0) {
  if (depth > 40) throw new Error("symlink loop");
  let current = "/";
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      const link = readlinkSync(current);
      current = resolvePath(isAbsolute(link) ? link : `${dirname(current)}/${link}`, depth + 1);
    }
  }
  return current;
}
try {
  const identity = statSync(checkout);
  function physical(path) {
    let current = "/";
    let missing = false;
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (missing) return;
        current = dirname(current);
        continue;
      }
      current = join(current, part);
      if (missing) continue;
      try {
        const stat = lstatSync(current, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink()) return;
        if (!stat) missing = true;
      } catch {
        return;
      }
    }
    return current;
  }
  function inside(path) {
    if (!path) return false;
    for (;;) {
      try {
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (stat?.dev === identity.dev && stat.ino === identity.ino) return true;
      } catch {
        return false;
      }
      if (path === "/") return false;
      path = dirname(path);
    }
  }
  function owned(path) {
    return inside(physical(path));
  }
  let resolvedBin;
  try {
    resolvedBin = resolvePath(bin);
  } catch {
    fail(unusable);
  }
  if (owned(resolvedBin)) {
    fail("~/.local/bin points into this checkout; move it away, then run install.sh again.");
  }
  let writable = bin;
  try {
    while (!lstatSync(writable, { throwIfNoEntry: false })) {
      writable = dirname(writable);
    }
    if (!statSync(writable).isDirectory()) fail(unusable);
    accessSync(writable, constants.W_OK | constants.X_OK);
  } catch {
    fail(unusable);
  }
  const stat = lstatSync(target, { throwIfNoEntry: false });
  let already = false;
  if (stat) {
    if (!stat.isSymbolicLink()) fail(foreign);
    const link = readlinkSync(target);
    const named = isAbsolute(link) ? link : `${resolvedBin}/${link}`;
    let resolved;
    try {
      resolved = resolvePath(target);
    } catch {
      fail(foreign);
    }
    if (!owned(named) || !owned(resolved)) fail(foreign);
    already = link === source;
  }
  if (mode === "check") {
    console.log(already ? "already" : "link");
  } else {
    mkdirSync(bin, { recursive: true });
    if (!stat) {
      try {
        symlinkSync(source, target);
      } catch (error) {
        if (error.code === "EEXIST") fail(foreign);
        throw error;
      }
    } else if (!already) {
      const temporary = join(bin, `.emend-link-${process.pid}`);
      let created = false;
      try {
        symlinkSync(source, temporary);
        created = true;
        renameSync(temporary, target);
      } catch (error) {
        if (created) rmSync(temporary, { force: true });
        throw error;
      }
    }
    console.log(already ? "already" : "linked");
  }
} catch (error) {
  fail(`could not check ~/.local/bin/emend (${error.code || error.message}).`);
}
NODE
}
link_state=$(check_destination check)

physical_home=$(CDPATH= cd -P -- "$HOME" 2>/dev/null && pwd -P) || physical_home="$HOME"
display_path() {
  case "$1" in
    "$HOME") printf '~' ;;
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    "$physical_home") printf '~' ;;
    "$physical_home"/*) printf '~/%s' "${1#"$physical_home"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

if [ "$dry_run" = 1 ]; then
  printf 'would run pnpm install --frozen-lockfile\n'
  printf 'would run pnpm build\n'
else
  cd -- "$checkout"
  pnpm install --frozen-lockfile || fail 'pnpm install --frozen-lockfile failed.'
  pnpm build || fail 'pnpm build failed.'
  link_state=$(check_destination link)
fi

if [ "$link_state" = already ]; then
  printf '~/.local/bin/emend already linked\n'
elif [ "$dry_run" = 1 ]; then
  printf 'would link ~/.local/bin/emend -> %s\n' "$(display_path "$source_path")"
else
  printf 'linked ~/.local/bin/emend -> %s\n' "$(display_path "$source_path")"
fi

case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) printf 'install.sh: warning: ~/.local/bin is not on PATH; add it to run emend.\n' >&2 ;;
esac

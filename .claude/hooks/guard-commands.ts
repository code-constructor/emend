// PreToolUse hook for Bash, Monitor, PowerShell and the Codex MCP tools. It stops accidental
// deploys and publishes, remote writes, every push, merges, visibility changes, edits to the
// guards themselves and Codex sessions outside this repo (AGENTS.md, "Delivery").
//
// It is a seatbelt against mistakes and prompt-injected commands, not a wall. The wall is the
// Claude Code sandbox; the repo is public, so a push that slips through publishes its content.
// A false positive costs a rephrase, a false negative costs a leak, so every doubt blocks.
//
// Two layers run on each command:
//   1. A raw-text backstop that ignores quoting, escapes and variables.
//   2. A structured pass over segments, wrappers, package scripts, script files and git.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageInfo {
  name?: string;
  scripts: Record<string, string>;
}

export interface GuardContext {
  cwd: string;
  /** The checked-out branch, or null when HEAD is detached. */
  currentBranch(dir: string): string | null;
  /** Every tag name in the repository at `dir`. */
  tagNames(dir: string): Set<string>;
  /** Git aliases at `dir`, with lowercase names. */
  aliases(dir: string): Record<string, string>;
  /** `push.*` and `remote.*` git config at `dir`, with lowercase keys. */
  pushConfig(dir: string): Record<string, string>;
  /** `<dir>/package.json`, or null when it is not a readable regular file. */
  packageJson(dir: string): PackageInfo | null;
  /** The text of a regular file of at most 64 KB, or null. */
  readScript(file: string): string | null;
}

const MAX_COMMAND_CHARS = 50000;
const MAX_SEGMENTS = 500;
const MAX_SCRIPT_DEPTH = 5;
const MAX_SCRIPT_FILE_BYTES = 64 * 1024;
const DEADLINE_MS = 6000;
const GIT_TIMEOUT_MS = 1500;

let deadline = Number.POSITIVE_INFINITY;

const PUSH_MESSAGE = "Agents never push in this repo. The owner pushes.";
const COMMIT_HINT =
  "If this is only a commit message, write it to a file and use `git commit -F <file>`. " +
  "Inside the sandbox, `.git` is read-only, so follow the global commit-signing rule instead.";
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const RUNNERS = new Set(["npx", "pnpx", "bunx"]);
const SHELL_KEYWORDS = new Set(["!", "{", "if", "then", "elif", "else", "do", "while", "until"]);
// Wrapper programs and the flags that take a separate value.
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"]),
  env: new Set(["-u", "-C"]),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(["-a"]),
  nohup: new Set(),
  time: new Set(),
  nice: new Set(["-n"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  setsid: new Set(),
  noglob: new Set(),
  coproc: new Set(),
  corepack: new Set(),
  xargs: new Set(["-I", "-n", "-P", "-L", "-s", "-E", "-d", "-a"]),
  eval: new Set(),
};
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const PM_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  pnpm: new Set(["-C", "--dir", "--filter", "-F", "--reporter", "--loglevel"]),
  npm: new Set(["-C", "--prefix", "-w", "--workspace"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd"]),
};
const PM_EXEC_SUBS: Record<string, ReadonlySet<string>> = {
  pnpm: new Set(["exec", "dlx"]),
  npm: new Set(["exec", "x"]),
  yarn: new Set(["exec", "dlx"]),
  bun: new Set(["x"]),
};
const PM_BUILTINS = new Set(
  (
    "add install i remove rm uninstall un update up upgrade link ln unlink list ls ll la outdated " +
    "audit why exec dlx x run run-script test t start stop restart store init publish pack patch " +
    "patch-commit patch-remove rebuild rb prune fetch import create env config get set root bin " +
    "setup self-update approve-builds ignored-builds dedupe deploy doctor licenses cache " +
    "completion help version info login logout whoami team access token owner dist-tag deprecate " +
    "unpublish explore"
  ).split(" "),
);
const NPM_IMPLICIT_SCRIPTS = new Set(["test", "t", "start", "stop", "restart"]);
const WRANGLER_VALUE_FLAGS = new Set([
  "--config",
  "-c",
  "--env",
  "-e",
  "--cwd",
  "--env-file",
  "--persist-to",
  "--port",
  "--ip",
  "--log-level",
  "--command",
  "--file",
]);
const PUSH_OPTIONS = new Set([
  "-u",
  "--set-upstream",
  "-n",
  "--dry-run",
  "-v",
  "--verbose",
  "-q",
  "--quiet",
  "--progress",
  "--no-progress",
  "--porcelain",
]);
const PUSH_WORDS = new Set([
  "push",
  "git-push",
  "send-pack",
  "git-send-pack",
  "http-push",
  "git-http-push",
  "git-receive-pack",
  "receive-pack",
]);
const BLOCKED_GIT_PROGRAMS = new Set(["git-push", "git-send-pack", "git-http-push", "git-receive-pack"]);
const BLOCKED_GIT_SUBS = new Set(["send-pack", "http-push", "receive-pack", "apply", "am"]);
const LAYER1_WRANGLER_WORDS = new Set([
  "deploy",
  "login",
  "logout",
  "secret",
  "secrets-store",
  "versions",
  "rollback",
  "publish",
  "deployments",
  "tail",
  "whoami",
  "triggers",
  "pages",
  "queues",
  "hyperdrive",
  "vectorize",
  "workflows",
  "containers",
  "bucket",
  "namespace",
  "upload",
]);
const GUARD_PATH_MARKERS = [
  ".claude/settings",
  ".claude/hooks",
  ".codex/",
  ".git/config",
  ".git/hooks",
  ".config/git",
  ".gitconfig",
];
const READERS = new Set([
  "cat",
  "head",
  "tail",
  "rg",
  "grep",
  "diff",
  "wc",
  "ls",
  "stat",
  "jq",
  "sha256sum",
]);
const READER_GIT_SUBS = new Set(["diff", "log", "show", "status", "blame"]);
const SEARCH_PROGRAMS = new Set(["rg", "grep", "cat", "head", "tail", "wc", "ls", "jq"]);
const SEARCH_GIT_SUBS = new Set(["log", "diff", "show", "grep", "status", "blame"]);
// Reader flags that run another command or write a file.
const RUNNING_FLAGS = /^(?:--pre(?:-glob)?(?:=|$)|--hostname-bin|-O|--open-files-in-pager|--ext-diff|--output)/;
const DYNAMIC_WORD = /[$`(*?[{]/;
const WRANGLER_NAME = /^(?:cf-)?wrangler2?$/;
const WRANGLER_TOKEN = /(?:^|\/)(?:cf-)?wrangler2?(?:@[^/\s]*)?(?:\.js)?$/;
const ENV_NAMES =
  /(?<![a-z0-9_])(?:git_config\w*|git_dir|git_work_tree|git_ssh\w*|git_exec_path|git_askpass|claudecode|claude_code_\w*|codex_\w*|cloudflare_\w*|wrangler_\w*)(?![a-z0-9_])/;

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** The program name: basename without an `@version` suffix, a `.js` suffix or a leading `=`. */
function normalizeProgram(token: string): string {
  const name = path.posix.basename(token).replace(/(.)@[^/]*$/, "$1").replace(/\.js$/, "");
  return name.startsWith("=") ? name.slice(1) : name;
}

function canonicalProgram(name: string): string {
  return WRANGLER_NAME.test(name) ? "wrangler" : name;
}

function isGitToken(token: string): boolean {
  const base = path.posix.basename(token);
  return base === "git" || base.startsWith("git-");
}

function skipFlags(tokens: string[], valueFlags: ReadonlySet<string> = new Set()): string[] {
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
    const flag = tokens[i];
    i += 1;
    if (flag === "--") break;
    if (valueFlags.has(flag)) i += 1;
  }
  return tokens.slice(i);
}

function cleaned(command: string): string {
  return command.replace(/\\\n/g, " ").replace(/\\/g, "").replace(/['"]/g, "");
}

/** Splits a command line into segments of tokens. Quotes and escapes are dropped. */
function segments(command: string): string[][] {
  return cleaned(command)
    .split(/\$\(|[;&|\n`()]/)
    .map((segment) => segment.split(/\s+/).filter((token) => token !== ""))
    .filter((tokens) => tokens.length > 0);
}

/** Like `segments`, but keeps `$(`, backticks and parentheses inside words. */
function rawSegments(command: string): string[][] {
  return cleaned(command)
    .split(/[;&|\n]/)
    .map((segment) =>
      segment
        .split(/\s+/)
        .filter((token) => token !== "")
        .map((token) => token.replace(/^\(+/, "")),
    )
    .filter((tokens) => tokens.length > 0 && tokens[0] !== "");
}

interface Unwrapped {
  argv: string[];
  /** The command receives extra arguments from stdin, which the guard cannot see. */
  xargs: boolean;
  /** A shell script file, from `sh file`, `source file` or `. file`. */
  scriptFile?: string;
}

interface PmParse {
  sub: string | undefined;
  rest: string[];
  dir?: string;
  filter?: string;
  workspaceRoot: boolean;
}

function parsePm(pm: string, tokens: string[]): PmParse {
  const valueFlags = PM_VALUE_FLAGS[pm];
  const result: PmParse = { sub: undefined, rest: [], workspaceRoot: false };
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
    let flag = tokens[i];
    let value: string | undefined;
    const eq = flag.indexOf("=");
    if (flag.startsWith("--") && eq !== -1) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
      i += 1;
    } else if (valueFlags.has(flag)) {
      value = tokens[i + 1];
      i += 2;
    } else if (!flag.startsWith("--") && flag.length > 2 && valueFlags.has(flag.slice(0, 2))) {
      value = flag.slice(2);
      flag = flag.slice(0, 2);
      i += 1;
    } else {
      i += 1;
    }
    if (flag === "--") break;
    if (flag === "-C" || flag === "--dir" || flag === "--prefix" || flag === "--cwd") {
      result.dir = value ?? "";
    } else if (
      flag === "--filter" ||
      flag === "-F" ||
      (pm === "npm" && (flag === "-w" || flag === "--workspace"))
    ) {
      result.filter = value ?? "";
    } else if (
      (pm === "pnpm" && (flag === "-w" || flag === "--workspace-root")) ||
      ["-r", "--recursive", "--workspaces", "-ws"].includes(flag)
    ) {
      // These run scripts in packages the guard does not resolve.
      result.workspaceRoot = true;
    }
  }
  result.sub = tokens[i];
  result.rest = tokens.slice(i + 1);
  return result;
}

/** Finds directory and filter flags anywhere in the tokens that follow the subcommand. */
function scanDirFlags(pm: string, tokens: string[]): { dirs: string[]; filters: string[]; wide: boolean } {
  const out = { dirs: [] as string[], filters: [] as string[], wide: false };
  const dirFlags = new Set(["-C", "--dir", "--prefix", "--cwd"]);
  const filterFlags = new Set(pm === "npm" ? ["--filter", "-F", "-w", "--workspace"] : ["--filter", "-F"]);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const eq = t.startsWith("--") ? t.indexOf("=") : -1;
    const flag = eq === -1 ? t : t.slice(0, eq);
    const inline = eq === -1 ? undefined : t.slice(eq + 1);
    if (dirFlags.has(flag)) out.dirs.push(inline ?? tokens[(i += 1)] ?? "");
    else if (filterFlags.has(flag)) out.filters.push(inline ?? tokens[(i += 1)] ?? "");
    else if (!t.startsWith("--") && t.length > 2 && dirFlags.has(t.slice(0, 2))) out.dirs.push(t.slice(2));
    else if (!t.startsWith("--") && t.length > 2 && filterFlags.has(t.slice(0, 2))) out.filters.push(t.slice(2));
    else if (["-r", "--recursive", "--workspaces", "-ws"].includes(flag) || (pm === "pnpm" && flag === "-w")) {
      out.wide = true;
    }
  }
  return out;
}

/** Strips wrappers from the front of a segment and reduces the program to its basename. */
function unwrap(tokens: string[]): Unwrapped {
  let t = tokens;
  let xargs = false;
  for (;;) {
    if (t.length === 0) return { argv: t, xargs };
    const first = t[0];
    if (isAssignment(first) || SHELL_KEYWORDS.has(first)) {
      t = t.slice(1);
      continue;
    }
    if (/^\d*(?:>>?|<)/.test(first)) {
      // A leading redirection. A bare operator takes the next token as its target.
      t = /^\d*(?:>>?|<)$/.test(first) ? t.slice(2) : t.slice(1);
      continue;
    }
    if (first === "source" || first === ".") {
      return { argv: [], xargs, scriptFile: t[1] ?? "" };
    }
    const name = normalizeProgram(first);
    const wrapperFlags = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (wrapperFlags) {
      if (name === "xargs") xargs = true;
      t = skipFlags(t.slice(1), wrapperFlags);
    } else if (SHELLS.has(name)) {
      const rest = skipFlags(t.slice(1));
      const flags = t.slice(1, t.length - rest.length);
      if (!flags.some((f) => /^-[a-z]*c/.test(f)) && rest.length > 0) {
        return { argv: [], xargs, scriptFile: rest[0] };
      }
      t = rest;
    } else if (name === "timeout") {
      t = skipFlags(t.slice(1), new Set(["-s", "-k", "--signal", "--kill-after"])).slice(1);
    } else if (RUNNERS.has(name)) {
      t = skipFlags(t.slice(1), new Set(["-p", "--package"]));
    } else if (name === "find") {
      const at = t.findIndex((x) => ["-exec", "-execdir", "-ok", "-okdir"].includes(x));
      if (at === -1) return { argv: [name, ...t.slice(1)], xargs };
      t = t.slice(at + 1);
    } else if (name === "node") {
      const rest = skipFlags(t.slice(1));
      if (rest[0] !== undefined && /(?:^|\/)(?:cf-)?wrangler2?(?:\.js)?$/.test(rest[0])) {
        t = ["wrangler", ...rest.slice(1)];
      } else {
        return { argv: [name, ...t.slice(1)], xargs };
      }
    } else if (PACKAGE_MANAGERS.has(name)) {
      const parsed = parsePm(name, t.slice(1));
      const sub = parsed.sub;
      if (sub !== undefined && PM_EXEC_SUBS[name].has(sub)) {
        t = skipFlags(parsed.rest);
      } else if (
        sub !== undefined &&
        ["wrangler", "drizzle-kit"].includes(canonicalProgram(normalizeProgram(sub)))
      ) {
        t = [sub, ...parsed.rest];
      } else {
        return { argv: [name, ...t.slice(1)], xargs };
      }
    } else {
      return { argv: [canonicalProgram(name), ...t.slice(1)], xargs };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Layer 1: raw-text backstop

interface Layer1 {
  reason: string | null;
  tokens: string[];
  /** How often each guarded program appears as a word. Layer 2 must recognize every one. */
  counts: { wrangler: number; gh: number; drizzle: number };
}

/** Programs and subcommands built at runtime hide what runs, so they block. */
function dynamicWordReason(command: string): string | null {
  const blocked = (word: string): string =>
    `a program or subcommand built at runtime (${word}) is blocked: write the command out`;
  for (const segment of rawSegments(command)) {
    const { argv } = unwrap(segment);
    if (argv.length === 0) continue;
    const [program, ...args] = argv;
    if (DYNAMIC_WORD.test(program)) return blocked(program);
    const positional = args.filter((a) => !a.startsWith("-"));
    let checked: string[] = [];
    if (program === "git" || program === "drizzle-kit") {
      checked = positional.slice(0, 1);
    } else if (program === "gh") {
      checked = positional.slice(0, 2);
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "-X" || args[i] === "--method") checked.push(args[i + 1] ?? "");
        else if (/^-X./.test(args[i]) || args[i].startsWith("--method=")) checked.push(args[i]);
      }
    } else if (program === "wrangler") {
      checked = args;
    } else if (PACKAGE_MANAGERS.has(program)) {
      checked = positional.slice(0, 2);
    }
    const word = checked.find((w) => DYNAMIC_WORD.test(w));
    if (word !== undefined) return blocked(word);
  }
  return null;
}

/**
 * A segment that only reads. Its arguments are search terms or paths, so words such as `wrangler`
 * or `push` there do not count as a command. Flags that run another program keep it a command.
 */
function isReaderSegment(segment: string[]): boolean {
  const { argv, xargs, scriptFile } = unwrap(segment);
  if (xargs || scriptFile !== undefined || argv.length === 0) return false;
  const [program, ...args] = argv;
  let reader = SEARCH_PROGRAMS.has(program);
  if (program === "git") {
    reader = args[0] !== undefined && !args[0].startsWith("-") && SEARCH_GIT_SUBS.has(args[0]);
  }
  return reader && !args.some((a) => RUNNING_FLAGS.test(a));
}

/** Checks that only read-only commands name the guard files. */
function guardPathReason(command: string, tokens: string[]): string | null {
  if (!GUARD_PATH_MARKERS.some((marker) => tokens.some((t) => t.includes(marker)))) return null;
  const message =
    "naming the guard files (.claude/settings, .claude/hooks, .codex, .git/config, .git/hooks, git config) is blocked unless a read-only command reads them. Changing them is the owner's step";
  // Redirects that only reshape output do not write a file.
  const plain = command.replace(/\d*>&\d*/g, "").replace(/&?\d*>>?\s*\/dev\/null/g, "");
  if (plain.includes(">")) return message;
  for (const segment of rawSegments(command)) {
    const text = segment.join(" ").toLowerCase();
    if (!GUARD_PATH_MARKERS.some((marker) => text.includes(marker))) continue;
    const { argv } = unwrap(segment);
    const [program, ...args] = argv;
    if (program === undefined) return message;
    if (READERS.has(program)) continue;
    if (program === "git" && READER_GIT_SUBS.has(args.find((a) => !a.startsWith("-")) ?? "")) continue;
    if (program === "node" && args.includes("--test")) continue;
    return message;
  }
  return null;
}

const GLOB_CHARS = /[*?[{]/;
const PROTECTED_LEADS = [".claude", ".codex", ".git", ".dev", ".env"];
const SECRET_LEADS = [".dev", ".env"];

/** Whether a glob argument could expand to one of the protected paths. */
function globHitsProtected(arg: string, leads: string[]): boolean {
  if (!GLOB_CHARS.test(arg)) return false;
  const lead = arg.replace(/^(?:\.\/)+/, "").split("/")[0];
  if (!lead.startsWith(".")) return false; // a glob does not match a leading dot
  const at = lead.search(GLOB_CHARS);
  if (at === -1) return leads.some((l) => lead.startsWith(l));
  const fixed = lead.slice(0, at);
  return leads.some((l) => l.startsWith(fixed) || fixed.startsWith(l));
}

/** Globs aimed at the guard or secret paths. Readers are checked for secrets only. */
function globPathReason(command: string): string | null {
  for (const segment of segments(command)) {
    const { argv } = unwrap(segment);
    const args = argv.slice(1);
    const leads = isReaderSegment(segment) ? SECRET_LEADS : PROTECTED_LEADS;
    const hit = args.find((a) => globHitsProtected(a, leads));
    if (hit !== undefined) {
      return `the glob ${hit} could reach the guard or secret files (.claude, .codex, .git, .dev.vars, .env). Name the path without a glob`;
    }
  }
  return null;
}

function layer1(command: string): Layer1 {
  const shell = "(?:bash|sh|zsh|dash|ksh|fish)";
  const feeding: [RegExp, string][] = [
    [new RegExp(`\\|&?[^|;&\\n]*?(?<![\\w.-])${shell}(?![\\w-])`, "i"), "a pipe into a shell"],
    [
      new RegExp(`(?:^|[^\\w/.-]|/)${shell}\\s+(?:-[A-Za-z]+\\s+)*-[A-Za-z]*s[A-Za-z]*(?:\\s|$)`, "i"),
      "a shell that reads its script from stdin (-s)",
    ],
    [
      new RegExp(`(?:^|[^\\w/.-]|/)${shell}\\b[^;&|\\n]*(?:<<<|<\\()`, "i"),
      "a shell fed by a here-string or a process substitution",
    ],
    [
      /(?:^|[\s;&|(`{])(?:source|\.)\s+(?:\/dev\/(?:stdin|fd\/)|<\()/,
      "source of stdin or a process substitution",
    ],
    [/\$'[^']*\\/, "a $'...' string with a backslash escape"],
    [
      /(?:^|[\s;&|(`{])(?:printf|echo\s+-[A-Za-z]*e[A-Za-z]*)\s[^;&|\n]*\\(?:[0-7]{2,3}|x[0-9A-Fa-f]|u[0-9A-Fa-f])/,
      "printf or echo -e with an escape sequence",
    ],
    [/(?:^|[\s;&|(`{])eval(?:\s|$)/, "eval"],
  ];
  const tokenize = (text: string): string[] =>
    text
      .toLowerCase()
      .replace(/\\\n/g, "")
      .replace(/[\\'"`${}]/g, "")
      .replace(/[=,;|&()<>\n]/g, " ")
      .split(/\s+/)
      .filter((token) => token !== "");
  // Guard-path, secret and environment rules see every word. The command rules skip the
  // arguments of reader segments such as `rg -n wrangler AGENTS.md`.
  const allTokens = tokenize(command);
  const tokens = segments(command.replace(/\\\n/g, ""))
    .filter((segment) => !isReaderSegment(segment))
    .flatMap((segment) => tokenize(segment.join(" ")));
  const counts = {
    wrangler: tokens.filter((t) => WRANGLER_TOKEN.test(t)).length,
    gh: tokens.filter((t) => t === "gh" || t.endsWith("/gh")).length,
    drizzle: tokens.filter((t) => /(?:^|\/)drizzle-kit(?:@[^/\s]*)?$/.test(t)).length,
  };
  const stop = (reason: string): Layer1 => ({ reason, tokens, counts });

  for (const [pattern, name] of feeding) {
    if (pattern.test(command)) {
      return stop(`${name} is blocked: the guard cannot see the command it runs. Run the command directly`);
    }
  }

  const envName = ENV_NAMES.exec(command.toLowerCase())?.[0];
  if (envName !== undefined) {
    return stop(
      `environment variable ${envName.toUpperCase()} is blocked: it can change git, Claude Code, Codex, Cloudflare or wrangler behavior`,
    );
  }

  if (
    allTokens.some(
      (t) => t === ".dev.vars" || t.endsWith("/.dev.vars") || t === ".env" || t.endsWith("/.env") || t.includes(".wrangler/config"),
    )
  ) {
    return stop("reading secrets (.dev.vars, .env, wrangler login config) is blocked");
  }

  const has = (word: string): boolean => tokens.includes(word);
  const hasAny = (...words: string[]): boolean => words.some(has);

  if (counts.wrangler > 0) {
    const word = tokens.find((t) => LAYER1_WRANGLER_WORDS.has(t));
    if (word !== undefined) {
      return stop(`wrangler ${word} is blocked: deploying and remote setup are the owner's step`);
    }
    if (tokens.some((t) => t === "-r" || t.startsWith("--remote"))) {
      return stop("wrangler with -r or --remote is blocked: emend has no remote environment");
    }
  }

  if (counts.drizzle > 0 && hasAny("push", "migrate", "studio")) {
    return stop("drizzle-kit push, migrate and studio are blocked: generate migrations and apply them locally");
  }

  if (counts.gh > 0) {
    const blockedGh =
      hasAny("merge", "visibility", "--visibility", "alias", "secret", "--public") ||
      tokens.some((t) => t.startsWith("--approve")) ||
      (has("release") && hasAny("create", "delete", "edit", "upload")) ||
      (has("workflow") && hasAny("run", "enable", "disable")) ||
      (has("repo") && hasAny("create", "delete", "archive", "rename", "transfer", "edit")) ||
      (has("variable") && hasAny("set", "delete"));
    if (blockedGh) {
      return stop(
        "this gh command is blocked: merges, approvals, settings, secrets and visibility are the owner's step",
      );
    }
  }

  const guardReason = guardPathReason(command, allTokens);
  if (guardReason !== null) return stop(guardReason);

  const globReason = globPathReason(command);
  if (globReason !== null) return stop(globReason);

  const dynamicReason = dynamicWordReason(command);
  if (dynamicReason !== null) return stop(dynamicReason);

  return { reason: null, tokens, counts };
}

// ---------------------------------------------------------------------------------------------
// Layer 2: structured rules

interface Run {
  ctx: GuardContext;
  depth: number;
  /** The working directory after literal `cd` commands, or null when unknown. */
  dir: string | null;
  /** How many pushes layer 2 recognized and allowed. */
  pushes: number;
  /** How many guarded programs layer 2 recognized and allowed. */
  seen: { wrangler: number; gh: number; drizzle: number };
  /** The command also runs `git tag` or `git update-ref`. */
  tagPresent: boolean;
}

function requireDir(dir: string | null, what: string): string {
  if (dir === null) {
    throw new Error(`the working directory is unknown after cd, so ${what} cannot be checked`);
  }
  return dir;
}

function checkWrangler(args: string[]): string | null {
  const positional: string[] = [];
  let help = false;
  let local = false;
  let remote = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("-")) {
      if (a === "--help" || a === "-h") help = true;
      else if (a === "--local" || a === "-l" || a === "--local=true") local = true;
      else if (a === "-r" || a.startsWith("--remote")) remote = true;
      else if (WRANGLER_VALUE_FLAGS.has(a)) i += 1;
    } else {
      positional.push(a);
    }
  }
  if (remote) return "wrangler with -r or --remote is blocked: emend has no remote environment";
  if (help || args[0] === "--version" || args[0] === "-v") return null;
  const [sub, sub2, sub3] = positional;
  if (sub === undefined) return null;
  const allowed = (() => {
    switch (sub) {
      case "dev":
        return local;
      case "types":
      case "version":
      case "help":
        return true;
      case "d1":
        if (sub2 === "migrations") {
          if (sub3 === "create") return true;
          return (sub3 === "list" || sub3 === "apply") && local;
        }
        return sub2 === "execute" && local;
      case "r2":
        return sub2 === "object" && local;
      case "kv":
        return sub2 === "key" && local;
      default:
        return false;
    }
  })();
  if (allowed) return null;
  const name = positional.slice(0, 3).join(" ");
  const hint = sub === "dev" ? " (use `wrangler dev --local`)" : "";
  return `wrangler ${name} is blocked: deploying and remote setup are the owner's step${hint}`;
}

const FORBIDDEN_GIT_CONFIG =
  /^(?:alias\.|remote\.|push\.|url\.|credential\.|hook\.|include|filter\.|diff\.external|sequence\.editor|gpg\.program|core\.(?:hookspath|sshcommand|pager|editor|gitproxy|askpass))/i;
const GIT_CONFIG_READ_FLAGS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
  "--show-origin",
  "--show-scope",
]);
const GIT_CONFIG_SCOPE_FLAGS = new Set(["--local", "--global", "--system", "--worktree"]);

function validBranch(b: string): boolean {
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(b)) return false;
  if (["main", "master", "head"].includes(b.toLowerCase())) return false;
  if (/^(?:refs|heads|tags)\//.test(b)) return false;
  if (b.includes("..") || b.includes("//") || b.endsWith("/") || b.endsWith(".lock")) return false;
  return !/^\.+$/.test(b);
}

function checkPush(rest: string[], run: Run, dir: string | null): string | null {
  const positional: string[] = [];
  for (const a of rest) {
    if (a.startsWith("-")) {
      if (positional.length > 0 || !PUSH_OPTIONS.has(a)) {
        return `git push ${a} is not allowed. ${PUSH_MESSAGE}`;
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) return `git push needs exactly a remote and a branch. ${PUSH_MESSAGE}`;
  const [remote, ref] = positional;
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
    return `git push to remote "${remote}" is not allowed. ${PUSH_MESSAGE}`;
  }
  const colon = ref.indexOf(":");
  let branch = ref;
  if (colon !== -1) {
    const src = ref.slice(0, colon);
    branch = ref.slice(colon + 1);
    if (src !== "HEAD" && src !== branch) return `git push ${ref} is not allowed. ${PUSH_MESSAGE}`;
  }
  if (!validBranch(branch)) return `git push ${ref} is not allowed. ${PUSH_MESSAGE}`;
  const where = requireDir(dir, "git push");
  if (run.ctx.tagNames(where).has(branch)) return `git push ${ref} names a tag. ${PUSH_MESSAGE}`;
  const followTags = run.ctx.pushConfig(where)["push.followtags"];
  if (followTags !== undefined && /^(?:true|yes|on|1)$/i.test(followTags.trim())) {
    return `git config push.followTags is true, so this push would send tags. ${PUSH_MESSAGE}`;
  }
  // Even a well-formed push to a feature branch publishes it: the repo is public.
  return `git push ${ref} is blocked. ${PUSH_MESSAGE}`;
}

function aliasPushes(name: string, aliases: Record<string, string>, depth = 0): boolean {
  const expansion = aliases[name];
  if (expansion === undefined) return false;
  if (expansion.trimStart().startsWith("!")) return true;
  const words = expansion
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.some((w) => PUSH_WORDS.has(w))) return true;
  return depth < 5 && words.some((w) => aliasPushes(w, aliases, depth + 1));
}

function checkGit(args: string[], run: Run, xargs: boolean): string | null {
  let dir = run.dir;
  const globalOptions: string[] = [];
  const config: string[] = [];
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    globalOptions.push(a);
    if (a.startsWith("--config-env")) return "git --config-env is blocked: it can change aliases and remotes";
    if (a === "-c") {
      if (args[i + 1] !== undefined) config.push(args[i + 1]);
      i += 2;
    } else if (a.startsWith("-c") && !a.startsWith("--")) {
      config.push(a.slice(2));
      i += 1;
    } else if (a === "-C") {
      dir = dir !== null && args[i + 1] !== undefined ? path.resolve(dir, args[i + 1]) : null;
      i += 2;
    } else if (
      a === "--git-dir" ||
      a === "--work-tree" ||
      a === "--namespace" ||
      a === "--exec-path" ||
      a === "--super-prefix"
    ) {
      if (a !== "--namespace") dir = null;
      i += 2;
    } else {
      if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) dir = null;
      i += 1;
    }
  }
  for (const entry of config) {
    const key = entry.split("=")[0];
    if (
      FORBIDDEN_GIT_CONFIG.test(key) ||
      (/^core\.fsmonitor$/i.test(key) && entry.split("=")[1] !== "false")
    ) {
      return `git -c ${key} is blocked: it can change aliases, remotes, hooks or push targets`;
    }
  }
  const sub = args[i];
  if (sub === undefined) return null;
  const rest = args.slice(i + 1);
  const lower = sub.toLowerCase();

  if (BLOCKED_GIT_SUBS.has(lower)) {
    return `git ${sub} is blocked: it pushes or applies patches that can change the guard files. ${PUSH_MESSAGE}`;
  }
  if (lower.startsWith("credential")) {
    return `git ${sub} is blocked: it handles credentials`;
  }
  if (lower === "push") {
    if (globalOptions.length > 0) {
      return `git ${globalOptions[0]} before push is not allowed. ${PUSH_MESSAGE}`;
    }
    if (xargs) return `git push with arguments from xargs is not allowed. ${PUSH_MESSAGE}`;
    if (run.tagPresent) {
      return `this command also creates a tag, so the push is not allowed. ${PUSH_MESSAGE}`;
    }
    return checkPush(rest, run, dir);
  }
  if (xargs && lower.startsWith("-")) return "git with arguments from xargs is not allowed";

  const aliases = run.ctx.aliases(requireDir(dir, "git aliases"));
  if (aliasPushes(lower, aliases)) {
    return `git ${sub} is an alias that pushes or runs a shell command. ${PUSH_MESSAGE}`;
  }
  if (lower === "config") return checkGitConfig(rest);
  return null;
}

/** Allows git config reads only: a read flag, or a single key with no value. */
function checkGitConfig(args: string[]): string | null {
  const flags = args.filter((a) => a.startsWith("-"));
  const positional = args.filter((a) => !a.startsWith("-"));
  const reading = flags.some((f) => GIT_CONFIG_READ_FLAGS.has(f));
  const onlyKnown = flags.every((f) => GIT_CONFIG_READ_FLAGS.has(f) || GIT_CONFIG_SCOPE_FLAGS.has(f));
  if (onlyKnown && (reading || positional.length === 1)) return null;
  return "git config writes are the owner's step. Only reads are allowed: --get, --get-all, --get-regexp, --list, --show-origin, --show-scope or a single key";
}

function ghMethods(args: string[]): string[] {
  const methods: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "-X" || a === "--method") methods.push((args[i + 1] ?? "").toUpperCase());
    else if (a.startsWith("--method=")) methods.push(a.slice("--method=".length).toUpperCase());
    else if (/^-X./.test(a)) methods.push(a.slice(2).toUpperCase());
  }
  return methods;
}

function checkGh(args: string[]): string | null {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "-R" || a === "--repo" || a === "--hostname") i += 1;
    else if (!a.startsWith("-")) positional.push(a);
  }
  const [group, action] = positional;
  const blocked = (): string =>
    `gh ${[group, action].filter(Boolean).join(" ")} is blocked: merges, approvals, settings, secrets and visibility are the owner's step`;
  const credentials = (): string =>
    `gh ${[group, action].filter(Boolean).join(" ")} is blocked: it handles credentials, keys or extensions`;
  switch (group) {
    case "pr":
      if (action === "merge") return blocked();
      if (action === "review" && args.some((a) => a === "-a" || a.startsWith("--approve"))) return blocked();
      return null;
    case "repo":
      if (action === "deploy-key" || action === "sync") return credentials();
      return ["create", "edit", "delete", "archive", "rename", "transfer", "set-default"].includes(action)
        ? blocked()
        : null;
    case "auth":
      return action === "status" && !args.some((a) => a === "--show-token" || a === "-t") ? null : credentials();
    case "ssh-key":
    case "gpg-key":
    case "extension":
      return credentials();
    case "config":
      return action === "set" ? credentials() : null;
    case "secret":
    case "alias":
      return blocked();
    case "gist":
      return action === "create" && args.some((a) => a === "--public" || a === "-p") ? blocked() : null;
    case "variable":
      return action === "set" || action === "delete" ? blocked() : null;
    case "release":
      return ["create", "delete", "edit", "upload"].includes(action) ? blocked() : null;
    case "workflow":
      return ["run", "enable", "disable"].includes(action) ? blocked() : null;
    case "api": {
      const methods = ghMethods(args);
      if (methods.length > 1) return blocked();
      if (methods.length === 1 && methods[0] !== "GET") return blocked();
      if (action === "graphql" && args.some((a) => a.includes("mutation"))) return blocked();
      if (methods.length === 0) {
        const writes = args.some(
          (a) =>
            /^-[fF]./.test(a) ||
            ["-f", "-F", "--field", "--raw-field", "--input"].includes(a) ||
            a.startsWith("--field=") ||
            a.startsWith("--raw-field=") ||
            a.startsWith("--input="),
        );
        if (writes) return blocked();
      }
      return null;
    }
    default:
      return null;
  }
}

/** Resolves the package script a package manager command runs and checks its body. */
function checkPackageManager(pm: string, args: string[], run: Run): string | null {
  const parsed = parsePm(pm, args);
  const sub = parsed.sub;
  if (sub === undefined) return null;
  let name: string | undefined;
  const runWords = pm === "yarn" || pm === "bun" ? ["run"] : ["run", "run-script"];
  const isRun = runWords.includes(sub);
  if (isRun) {
    name = skipFlags(parsed.rest, PM_VALUE_FLAGS[pm])[0];
  } else if (pm === "npm") {
    const alias = sub === "t" || sub === "tst" ? "test" : sub;
    name = NPM_IMPLICIT_SCRIPTS.has(alias) || alias === "deploy" || alias === "publish" ? alias : undefined;
  } else {
    name = sub;
  }
  if (name === undefined) return null;
  if (name === "deploy" || name === "publish") {
    return `${pm} ${name} is blocked: publishing emend is the owner's step`;
  }

  // Directory and filter flags count wherever they appear, before or after the script name.
  const scan = scanDirFlags(pm, parsed.rest);
  const dirs = [...(parsed.dir !== undefined ? [parsed.dir] : []), ...scan.dirs];
  const filters = [...(parsed.filter !== undefined ? [parsed.filter] : []), ...scan.filters];
  let dir: string | null = parsed.workspaceRoot || scan.wide ? null : run.dir;
  if (dirs.length > 1 || filters.length > 1) dir = null;
  if (dir !== null && dirs.length === 1) dir = path.resolve(dir, dirs[0]);
  if (dir !== null && filters.length === 1) {
    const f = filters[0];
    if (f === "." || f.startsWith("./") || f.endsWith("/")) {
      dir = path.resolve(dir, f);
    } else {
      // A named filter is resolvable only when it is the root package.
      dir = run.ctx.packageJson(dir)?.name === f ? dir : null;
    }
  }
  if (dir === null) {
    return `${pm} ${name} is blocked: its package directory cannot be resolved. Run it from the package directory with cd`;
  }
  const pkg = run.ctx.packageJson(dir);
  if (pkg === null) return `${pm} ${name} is blocked: ${dir}/package.json is not a readable file`;

  const hasScript = Object.hasOwn(pkg.scripts, name);
  if (isRun && !hasScript) {
    return `${pm} run ${name} is blocked: ${dir}/package.json has no script "${name}"`;
  }
  for (const script of [`pre${name}`, name, `post${name}`]) {
    const body = Object.hasOwn(pkg.scripts, script) ? pkg.scripts[script] : undefined;
    if (body === undefined) continue;
    if (run.depth + 1 > MAX_SCRIPT_DEPTH) {
      return `script "${script}" nests deeper than ${MAX_SCRIPT_DEPTH} levels, so it is blocked`;
    }
    const reason = evaluateFull(body, run.ctx, run.depth + 1, dir);
    if (reason !== null) return `script "${script}": ${reason}`;
  }
  // pnpm, yarn and bun fall back to a binary of that name when no script matches.
  if (!hasScript && !isRun && pm !== "npm" && !PM_BUILTINS.has(name)) {
    return evaluateSegment([sub, ...parsed.rest], run);
  }
  return null;
}

function checkScriptFile(file: string, run: Run): string | null {
  const unreadable = (why: string): string => `script file "${file}" ${why}, so it is blocked`;
  if (file === "" || file.startsWith("<(") || file.startsWith("/dev/")) return unreadable("cannot be read");
  const dir = requireDir(run.dir, "a script file");
  const content = run.ctx.readScript(path.resolve(dir, file));
  if (content === null) return unreadable("is missing, not a regular file or over 64 KB");
  if (run.depth + 1 > MAX_SCRIPT_DEPTH) return unreadable(`nests deeper than ${MAX_SCRIPT_DEPTH} levels`);
  const reason = evaluateFull(content, run.ctx, run.depth + 1, dir);
  return reason === null ? null : `script file "${file}": ${reason}`;
}

function evaluateSegment(raw: string[], run: Run): string | null {
  if (raw.some((t) => t === "--remote" || t.startsWith("--remote="))) {
    return "--remote is blocked: emend has no remote environment";
  }
  const { argv, xargs, scriptFile } = unwrap(raw);
  if (scriptFile !== undefined) return checkScriptFile(scriptFile, run);
  if (argv.length === 0) return null;
  const [program, ...args] = argv;

  if (program.includes("$")) {
    return "a program that comes from a variable is blocked: write the command out";
  }
  if (BLOCKED_GIT_PROGRAMS.has(program)) {
    return `${program} is blocked: it pushes. ${PUSH_MESSAGE}`;
  }
  if (program === "patch") {
    return "patch is blocked: it can change the guard files. Use the editor tools";
  }
  if (program === "cd" || program === "pushd") {
    const operands = args.filter((a) => !["-P", "-L", "-e", "-@"].includes(a));
    const target = operands[0];
    if (operands.length !== 1 || /[$~*?`]/.test(target) || target === "-") run.dir = null;
    else run.dir = run.dir !== null ? path.resolve(run.dir, target) : null;
    return null;
  }

  const viaStdin = "gets arguments from xargs, which the guard cannot check";
  switch (program) {
    case "wrangler": {
      if (xargs) return `wrangler ${viaStdin}`;
      const reason = checkWrangler(args);
      if (reason === null) run.seen.wrangler += 1;
      return reason;
    }
    case "drizzle-kit":
      if (xargs || args[0] === "push" || args[0] === "migrate" || args[0] === "studio") {
        return "drizzle-kit push, migrate and studio are blocked: generate migrations and apply them locally";
      }
      run.seen.drizzle += 1;
      return null;
    case "git":
      return checkGit(args, run, xargs);
    case "gh": {
      if (xargs) return `gh ${viaStdin}`;
      const reason = checkGh(args);
      if (reason === null) run.seen.gh += 1;
      return reason;
    }
    case "pnpm":
    case "npm":
    case "yarn":
    case "bun":
      return xargs ? `${program} ${viaStdin}` : checkPackageManager(program, args, run);
    default:
      return null;
  }
}

function evaluateFull(command: string, ctx: GuardContext, depth: number, dir: string | null): string | null {
  if (command.length > MAX_COMMAND_CHARS) {
    return `the command is longer than ${MAX_COMMAND_CHARS} characters, so it is blocked. Split it up`;
  }
  const first = layer1(command);
  if (first.reason !== null) return first.reason;

  const segs = segments(command);
  if (segs.length > MAX_SEGMENTS) {
    return `the command has more than ${MAX_SEGMENTS} segments, so it is blocked. Split it up`;
  }
  const run: Run = {
    ctx,
    depth,
    dir,
    pushes: 0,
    seen: { wrangler: 0, gh: 0, drizzle: 0 },
    tagPresent: first.tokens.some((t) => t === "tag" || t === "update-ref") && first.tokens.some(isGitToken),
  };
  for (const segment of segs) {
    const reason = evaluateSegment(segment, run);
    if (reason !== null) return reason;
  }

  // Every guarded program word that layer 1 saw must be one layer 2 recognized and allowed.
  // This catches wrappers and spellings the structured pass does not know.
  const unrecognized = (["wrangler", "gh", "drizzle"] as const).find(
    (program) => first.counts[program] > run.seen[program],
  );
  if (unrecognized !== undefined) {
    const name = unrecognized === "drizzle" ? "drizzle-kit" : unrecognized;
    return `${name} form not recognized: the guard cannot see how it runs. Run it directly, without wrappers`;
  }
  const pushWords = first.tokens.filter((t) => PUSH_WORDS.has(path.posix.basename(t))).length;
  if (first.tokens.some(isGitToken) && pushWords > run.pushes) {
    return `push form not recognized. ${PUSH_MESSAGE}`;
  }
  return null;
}

/** True when a `git commit` with a message flag is part of the command. */
function commitsWithMessage(command: string): boolean {
  return /\bgit\b[^;&|\n]*\bcommit\b[^;&|\n]*\s(?:-[A-Za-z]*m|--message)\b/.test(command);
}

/** Returns the reason a command is blocked, or null when it may run. */
export function evaluate(command: string, ctx: GuardContext): string | null {
  let reason: string | null;
  try {
    reason = evaluateFull(command, ctx, 0, ctx.cwd);
  } catch (error) {
    reason = `the command could not be checked (${(error as Error).message}), so it is blocked`;
  }
  if (reason !== null && commitsWithMessage(command)) return `${reason}. ${COMMIT_HINT}`;
  return reason;
}

function containsFullAccess(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (typeof value === "string") return value.toLowerCase().replace(/[-_\s]/g, "") === "dangerfullaccess";
  if (Array.isArray(value)) return value.some((v) => containsFullAccess(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((v) => containsFullAccess(v, depth + 1));
  }
  return false;
}

// Codex tools that start a session in a working directory.
const CODEX_SESSION_TOOLS = new Set(["mcp__codex__codex", "mcp__codex__codex-start"]);

/**
 * Outside the project, the project's Codex config (no network) and rules do not apply, and a
 * workspace-write session could change files such as ~/.gitconfig that later git commands run.
 */
function codexCwdReason(name: string, toolInput: unknown, root: string): string | null {
  const hasCwd = typeof toolInput === "object" && toolInput !== null && Object.hasOwn(toolInput, "cwd");
  if (!CODEX_SESSION_TOOLS.has(name) && !hasCwd) return null;
  const cwd = hasCwd ? (toolInput as { cwd?: unknown }).cwd : undefined;
  const message = `Codex sessions start in this repository (${root}) or below it`;
  if (typeof cwd !== "string" || cwd === "" || cwd.includes("\0")) return `${message}; the cwd is missing`;
  const target = path.resolve(root, cwd);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return `${message}; ${cwd} is outside it`;
  return null;
}

/** Checks one hook payload. Returns the reason to block, or null. */
export function evaluateTool(input: unknown, ctx?: GuardContext): string | null {
  if (typeof input !== "object" || input === null) return "unreadable hook input";
  const {
    tool_name: toolName,
    tool_input: toolInput,
    cwd,
  } = input as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  const name = typeof toolName === "string" ? toolName : "";

  if (name.startsWith("mcp__codex__")) {
    if (containsFullAccess(toolInput)) {
      return "Codex with danger-full-access is blocked. Use sandbox workspace-write and decline escalation requests";
    }
    const root = path.resolve(
      ctx?.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? (typeof cwd === "string" ? cwd : process.cwd()),
    );
    const cwdReason = codexCwdReason(name, toolInput, root);
    if (cwdReason !== null) return cwdReason;
    const decision = (toolInput as { decision?: unknown } | null)?.decision;
    if (
      name === "mcp__codex__codex-interaction-resolve" &&
      (decision === "accept" || decision === "acceptForSession")
    ) {
      return "Accepting a Codex request is blocked. Decline it and report the request instead";
    }
    return null;
  }

  const command = (toolInput as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return null;
  const context = ctx ?? realContext(typeof cwd === "string" ? cwd : process.cwd());
  return evaluate(command, context);
}

function git(dir: string, args: string[]): string {
  if (Date.now() > deadline) throw new Error("deadline passed");
  return execFileSync("git", ["-C", dir, "-c", "core.fsmonitor=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

/** `git config --get-regexp` exits 1 when nothing matches. */
function configLines(dir: string, pattern: string): string[] {
  try {
    return git(dir, ["config", "--get-regexp", pattern])
      .split("\n")
      .filter((l) => l !== "");
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

export function realContext(cwd: string): GuardContext {
  const cache = new Map<string, unknown>();
  const memo = <T>(key: string, load: () => T): T => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key) as T;
  };
  const parseConfig = (lines: string[], prefix: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of lines) {
      const space = line.search(/\s/);
      const key = (space === -1 ? line : line.slice(0, space)).toLowerCase();
      out[key.slice(prefix.length)] = space === -1 ? "" : line.slice(space + 1).trim();
    }
    return out;
  };
  return {
    cwd,
    currentBranch(dir) {
      return memo(`branch:${dir}`, () => {
        try {
          return git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || null;
        } catch (error) {
          // Exit 1 means a detached HEAD. Anything else is a failed lookup.
          if ((error as { status?: number }).status === 1) return null;
          throw error;
        }
      });
    },
    tagNames(dir) {
      return memo(`tags:${dir}`, () => {
        const out = git(dir, ["for-each-ref", "--format=%(refname)", "refs/tags"]);
        return new Set(
          out
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => l.replace(/^refs\/tags\//, "")),
        );
      });
    },
    aliases(dir) {
      return memo(`aliases:${dir}`, () => parseConfig(configLines(dir, "^alias\\."), "alias."));
    },
    pushConfig(dir) {
      return memo(`push:${dir}`, () => parseConfig(configLines(dir, "^(push|remote)\\."), ""));
    },
    packageJson(dir) {
      return memo(`pkg:${dir}`, () => {
        try {
          const file = path.join(dir, "package.json");
          if (!lstatSync(file).isFile()) return null;
          const pkg: unknown = JSON.parse(readFileSync(file, "utf8"));
          if (typeof pkg !== "object" || pkg === null) return null;
          const { name, scripts } = pkg as { name?: unknown; scripts?: unknown };
          const out: Record<string, string> = {};
          if (typeof scripts === "object" && scripts !== null) {
            for (const [key, value] of Object.entries(scripts)) {
              if (typeof value === "string") out[key] = value;
            }
          }
          return { name: typeof name === "string" ? name : undefined, scripts: out };
        } catch {
          return null;
        }
      });
    },
    readScript(file) {
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_SCRIPT_FILE_BYTES) return null;
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
  };
}

function main(): void {
  deadline = Date.now() + DEADLINE_MS;
  const timer = setTimeout(() => {
    process.stderr.write("guard-commands: deadline passed\n");
    process.exit(2);
  }, DEADLINE_MS);
  try {
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      input = null;
    }
    if (typeof input !== "object" || input === null) {
      process.stderr.write("guard-commands: unreadable hook input\n");
      process.exit(2);
    }
    const reason = evaluateTool(input);
    clearTimeout(timer);
    if (reason !== null) {
      process.stderr.write(`BLOCKED: ${reason}\n`);
      process.exit(2);
    }
    process.exit(0);
  } catch {
    process.stderr.write("guard-commands: internal error\n");
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

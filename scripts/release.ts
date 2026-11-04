// Prepares a release: bumps the three version files, drafts CHANGELOG.md from the commits since the
// last tag, runs the gate and prints the owner's next steps. It never commits, tags, pushes or
// publishes (AGENTS.md, "Delivery"). The release commit's paths are not in sync/manifest.json, so
// the printed commit message needs no Sync trailer.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type GateRunner = (root: string) => void;

export interface ReleaseOptions {
  root: string;
  version: string;
  date: string;
  gate: GateRunner;
  skipGate?: boolean;
  stdout?: (line: string) => void;
}

export interface ReleaseResult {
  version: string;
  previousTag?: string;
  changelogSection: string;
  nextSteps: string[];
}

export class ReleaseError extends Error {}

const VERSION_SOURCE = "apps/emend/src/version.ts";
const VERSION_FILES = ["apps/emend/package.json", "plugin/.claude-plugin/plugin.json", VERSION_SOURCE];
const CHANGELOG_HEADER =
  "# Changelog\n\nNewest first. Each entry is a Conventional Commit subject since the previous release.\n";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_VALUE = /("version"\s*:\s*")([^"]*)(")/;

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

// "Newest" means the highest plain v<x.y.z> tag merged into HEAD. Prerelease or odd tags and tags
// on other branches do not count. No tags is an empty list; a git failure refuses the release.
export function lastTag(root: string): string | undefined {
  let listing: string;
  try {
    listing = git(root, ["tag", "--merged", "HEAD", "--list", "v*"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new ReleaseError(`release: could not list tags (${reason})`);
  }
  let newest: string | undefined;
  for (const tag of listing.split("\n")) {
    if (!tag.startsWith("v") || !VERSION_PATTERN.test(tag.slice(1))) continue;
    if (newest === undefined || compareVersions(tag.slice(1), newest.slice(1)) > 0) newest = tag;
  }
  return newest;
}

function topLevelVersion(text: string, file: string): unknown {
  try {
    return (JSON.parse(text) as { version?: unknown }).version;
  } catch {
    throw new ReleaseError(`release: ${file} is not valid JSON`);
  }
}

function readVersion(root: string, file: string): string {
  const found = topLevelVersion(readFileSync(join(root, file), "utf8"), file);
  if (typeof found !== "string") throw new ReleaseError(`release: no top-level version in ${file}`);
  return found;
}

// Changes only the first "version" value, so key order, indentation and the final newline stay.
// It returns the new text and refuses unless the top-level version is now the target, so a nested
// "version" key that comes first is never mistaken for it.
export function bumpedVersionText(root: string, file: string, version: string): string {
  const text = readFileSync(join(root, file), "utf8");
  const bumped = text.replace(VERSION_VALUE, (_all, open, _old, close) => `${open}${version}${close}`);
  if (topLevelVersion(bumped, file) !== version) {
    throw new ReleaseError(`release: could not set the top-level version in ${file}`);
  }
  return bumped;
}

const VERSION_LINE = /^(export const VERSION = ")([^"\n]*)(";)$/gm;

// Replaces only the string literal in the single `export const VERSION = "<x>";` line.
export function bumpedSourceText(root: string, file: string, version: string): string {
  const text = readFileSync(join(root, file), "utf8");
  if ((text.match(VERSION_LINE) ?? []).length !== 1) {
    throw new ReleaseError(`release: ${file} must have exactly one 'export const VERSION = "...";' line`);
  }
  const bumped = text.replace(VERSION_LINE, (_all, open, _old, close) => `${open}${version}${close}`);
  if (!bumped.includes(`export const VERSION = "${version}";`)) {
    throw new ReleaseError(`release: could not set the version in ${file}`);
  }
  return bumped;
}

export function localDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function parseArgs(args: string[]): { version: string; skipGate: boolean } {
  const skipGate = args.includes("--skip-gate");
  const rest = args.filter((arg) => arg !== "--skip-gate");
  const [version] = rest;
  if (version === undefined || rest.length !== 1 || version.startsWith("-")) {
    throw new ReleaseError("Usage: pnpm release <x.y.z> [--skip-gate]");
  }
  return { version, skipGate };
}

interface Entry {
  group: "breaking" | "feat" | "fix" | "perf";
  line: string;
}

const GROUPS: [Entry["group"], string][] = [
  ["breaking", "Breaking changes"],
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
];

export function classifyCommit(subject: string, body: string): Entry | undefined {
  const match = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject.trim());
  if (!match) return;
  const [, type = "", scope, bang, summary = ""] = match;
  const line = `- ${summary.trim()}${scope ? ` (${scope})` : ""}`;
  if (bang || /^BREAKING[ -]CHANGE:/m.test(body)) return { group: "breaking", line };
  if (type === "feat" || type === "fix" || type === "perf") return { group: type, line };
}

export function changelogSection(
  root: string,
  version: string,
  date: string,
  previousTag: string | undefined,
): string {
  const heading = `## ${version} (${date})`;
  if (!previousTag) return `${heading}\n\nFirst release.\n`;
  const log = git(root, ["log", `${previousTag}..HEAD`, "--format=%s%x1f%b%x1e"]);
  const entries: Entry[] = [];
  for (const record of log.split("\x1e")) {
    const [subject = "", body = ""] = record.replace(/^\n/, "").split("\x1f");
    const entry = classifyCommit(subject, body);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return `${heading}\n\nMaintenance release.\n`;
  const blocks = GROUPS.flatMap(([group, title]) => {
    const lines = entries.filter((entry) => entry.group === group).map((entry) => entry.line);
    return lines.length === 0 ? [] : [`### ${title}\n\n${lines.join("\n")}\n`];
  });
  return `${heading}\n\n${blocks.join("\n")}`;
}

function insertSection(existing: string | undefined, section: string): string {
  if (existing === undefined || !existing.startsWith("# Changelog")) {
    return `${CHANGELOG_HEADER}\n${section}${existing ? `\n${existing}` : ""}`;
  }
  const at = existing.search(/^## /m);
  if (at === -1) return `${existing.trimEnd()}\n\n${section}`;
  return `${existing.slice(0, at)}${section}\n${existing.slice(at)}`;
}

export function nextSteps(version: string): string[] {
  return [
    "Review CHANGELOG.md.",
    "git add apps/emend/package.json plugin/.claude-plugin/plugin.json apps/emend/src/version.ts CHANGELOG.md",
    "git diff --staged",
    "Check that it shows only the version lines and the new changelog section; another session could have edited the files while the gate ran.",
    `git commit -S -m "chore: release ${version}"`,
    `git tag -s v${version} -m "emend ${version}"`,
    `git push origin main v${version}`,
    `d="$(mktemp -d)" && git clone --depth 1 --branch v${version} https://github.com/shllg/emend.git "$d/emend" && node "$d/emend/scripts/release-pack.ts" ${version}`,
    "Run the npm publish command it prints; compare its shasum line, and the start and end of its integrity line, with npm's before you enter the 2FA code.",
    `npm view @shllg/emend@${version} version --registry=https://registry.npmjs.org/`,
    `Continue only when it prints ${version}; the marketplace follows the release branch.`,
    `git push origin 'v${version}^{commit}:refs/heads/release'`,
    'Remove the two temporary folders: "$d" and the one release-pack kept.',
  ];
}

function checkChangelog(root: string, version: string): void {
  const file = join(root, "CHANGELOG.md");
  if (!existsSync(file)) return;
  const escaped = version.replaceAll(".", "\\.");
  if (new RegExp(`^## ${escaped}( |$)`, "m").test(readFileSync(file, "utf8"))) {
    throw new ReleaseError(`release: CHANGELOG.md already has a section for ${version}`);
  }
}

export function release(options: ReleaseOptions): ReleaseResult {
  const { root, version, date, gate } = options;
  const out = options.stdout ?? (() => {});
  if (!VERSION_PATTERN.test(version)) {
    throw new ReleaseError(`release: version must be plain x.y.z, got "${version}"`);
  }
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch !== "main") throw new ReleaseError(`release: run on main, not "${branch}"`);
  if (git(root, ["status", "--porcelain"]).trim() !== "") {
    throw new ReleaseError("release: the working tree is not clean");
  }
  if (spawnSync("git", ["-C", root, "rev-parse", "-q", "--verify", `refs/tags/v${version}`]).status === 0) {
    throw new ReleaseError(`release: the tag v${version} already exists`);
  }
  const previousTag = lastTag(root);
  if (previousTag) {
    if (compareVersions(version, previousTag.slice(1)) <= 0) {
      throw new ReleaseError(`release: ${version} is not greater than ${previousTag}`);
    }
  } else {
    const current = readVersion(root, VERSION_FILES[0] as string);
    if (compareVersions(version, current) < 0) {
      throw new ReleaseError(`release: ${version} is lower than the current version ${current}`);
    }
  }
  checkChangelog(root, version);

  const section = changelogSection(root, version, date, previousTag);
  const bumped = VERSION_FILES.map(
    (file) =>
      [file, (file === VERSION_SOURCE ? bumpedSourceText : bumpedVersionText)(root, file, version)] as const,
  );
  for (const [file, text] of bumped) writeFileSync(join(root, file), text);
  const changelog = join(root, "CHANGELOG.md");
  const existing = existsSync(changelog) ? readFileSync(changelog, "utf8") : undefined;
  writeFileSync(changelog, insertSection(existing, section));
  out(`Bumped ${VERSION_FILES.join(", ")} to ${version}; drafted CHANGELOG.md.`);

  if (options.skipGate !== true) {
    try {
      gate(root);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ReleaseError(
        `release: the gate failed (${reason}); the bumped files are left in place for you to inspect`,
      );
    }
  }
  if (options.skipGate === true) out("The gate did not run (--skip-gate); pnpm verify must pass before you tag.");
  const steps = nextSteps(version);
  out("Next steps, in this order:");
  steps.forEach((step, index) => {
    out(`${index + 1}. ${step}`);
  });
  return { version, previousTag, changelogSection: section, nextSteps: steps };
}

export const runGate: GateRunner = (root) => {
  execFileSync("pnpm", ["verify"], { cwd: root, stdio: "inherit" });
};

if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  try {
    const { version, skipGate } = parseArgs(process.argv.slice(2));
    release({
      root,
      version,
      date: localDate(),
      gate: runGate,
      skipGate,
      stdout: (line) => console.log(line),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message.split("\n")[0] : String(error));
    process.exitCode = 1;
  }
}

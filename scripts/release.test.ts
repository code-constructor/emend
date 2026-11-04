import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type GateRunner, localDate, nextSteps, parseArgs, release } from "./release.ts";

// Throwaway fixtures only: no user git config applies, so their commits and tags are unsigned.
const base = mkdtempSync(join(tmpdir(), "emend-release-test-"));
const emptyConfig = join(base, "gitconfig");
writeFileSync(emptyConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
test.after(() => rmSync(base, { recursive: true, force: true }));

const CLI_JSON = `{
    "name": "@shllg/emend",
    "version": "0.1.0",
    "scripts": { "build": "x" }
}
`;
const PLUGIN_JSON = `{
  "name": "emend",
  "version": "9.9.9",
  "keywords": ["review"]
}
`;

const VERSION_TS = `// The CLI version.
export const VERSION = "0.1.0";
export const OTHER = "0.1.0";
`;

let counter = 0;

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { encoding: "utf8" },
  );
}

function commit(root: string, subject: string, body?: string): void {
  writeFileSync(join(root, "note.txt"), `${++counter}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", subject, ...(body ? ["-m", body] : []));
}

function fixture(t: TestContext) {
  const root = join(base, `repo-${++counter}`);
  mkdirSync(join(root, "apps/emend/src"), { recursive: true });
  mkdirSync(join(root, "plugin/.claude-plugin"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "apps/emend/package.json"), CLI_JSON);
  writeFileSync(join(root, "plugin/.claude-plugin/plugin.json"), PLUGIN_JSON);
  writeFileSync(join(root, "apps/emend/src/version.ts"), VERSION_TS);
  commit(root, "chore: start");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const passGate: GateRunner = () => {};
const run = (root: string, version: string, gate = passGate, lines: string[] = []) =>
  release({ root, version, date: "2026-11-05", gate, stdout: (line) => lines.push(line) });

function unchanged(root: string) {
  assert.equal(readFileSync(join(root, "apps/emend/package.json"), "utf8"), CLI_JSON);
  assert.equal(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8"), PLUGIN_JSON);
  assert.equal(readFileSync(join(root, "apps/emend/src/version.ts"), "utf8"), VERSION_TS);
  assert.equal(git(root, "status", "--porcelain"), "");
}

test("refuses a version that is not plain x.y.z", (t) => {
  const root = fixture(t);
  for (const version of ["1.0", "v1.0.0", "1.0.0-rc.1", "1.0.0+x", ""]) {
    assert.throws(() => run(root, version), /plain x\.y\.z/);
  }
  unchanged(root);
});

test("refuses off main", (t) => {
  const root = fixture(t);
  git(root, "switch", "-q", "-c", "topic");
  assert.throws(() => run(root, "0.1.0"), /run on main, not "topic"/);
  unchanged(root);
});

test("refuses a dirty working tree", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "stray.txt"), "x");
  assert.throws(() => run(root, "0.1.0"), /not clean/);
  assert.equal(readFileSync(join(root, "apps/emend/package.json"), "utf8"), CLI_JSON);
});

test("refuses a version that is not above the last tag", (t) => {
  const root = fixture(t);
  git(root, "tag", "v0.2.0");
  commit(root, "feat: more");
  assert.throws(() => run(root, "0.2.0"), /tag v0\.2\.0 already exists/);
  assert.throws(() => run(root, "0.1.9"), /not greater than v0\.2\.0/);
  unchanged(root);
});

test("refuses when the tag exists even if it is not merged into HEAD", (t) => {
  const root = fixture(t);
  git(root, "switch", "-q", "-c", "other");
  commit(root, "feat: elsewhere");
  git(root, "tag", "v0.5.0");
  git(root, "switch", "-q", "main");
  assert.throws(() => run(root, "0.5.0"), /tag v0\.5\.0 already exists/);
  unchanged(root);
});

test("refuses versions with leading zeros", (t) => {
  const root = fixture(t);
  for (const version of ["0.02.0", "1.00.0", "01.0.0", "1.0.00"]) {
    assert.throws(() => run(root, version), /plain x\.y\.z/);
  }
  unchanged(root);
});

test("refuses a first release below the current package version", (t) => {
  const root = fixture(t);
  assert.throws(() => run(root, "0.0.9"), /lower than the current version 0\.1\.0/);
  unchanged(root);
});

test("first release with an equal version says First release.", (t) => {
  const root = fixture(t);
  commit(root, "feat(cli): something");
  const lines: string[] = [];
  const result = run(root, "0.1.0", passGate, lines);
  assert.equal(result.previousTag, undefined);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /^# Changelog\n\nNewest first\./);
  assert.match(changelog, /\n## 0\.1\.0 \(2026-11-05\)\n\nFirst release\.\n$/);
  assert.doesNotMatch(changelog, /something/);
  assert.deepEqual(lines.slice(1), [
    "Next steps, in this order:",
    ...nextSteps("0.1.0").map((step, index) => `${index + 1}. ${step}`),
  ]);
  const steps = nextSteps("0.1.0");
  assert.equal(steps.length, 13);
  assert.equal(
    steps[1],
    "git add apps/emend/package.json plugin/.claude-plugin/plugin.json apps/emend/src/version.ts CHANGELOG.md",
  );
  assert.equal(steps[2], "git diff --staged");
  assert.equal(steps[4], 'git commit -S -m "chore: release 0.1.0"');
  assert.equal(steps[5], 'git tag -s v0.1.0 -m "emend 0.1.0"');
  assert.equal(steps[6], "git push origin main v0.1.0");
  assert.match(
    steps[7] as string,
    /git clone --depth 1 --branch v0\.1\.0 https:\/\/github\.com\/shllg\/emend\.git .*node .*release-pack\.ts" 0\.1\.0$/,
  );
  assert.equal(steps[9], "npm view @shllg/emend@0.1.0 version --registry=https://registry.npmjs.org/");
  assert.match(steps[10] as string, /^Continue only when it prints 0\.1\.0/);
  assert.equal(steps[11], "git push origin 'v0.1.0^{commit}:refs/heads/release'");
  // No printed command carries a trailing comment: zsh without interactive comments breaks on it.
  for (const step of steps) assert.doesNotMatch(step, /\s#\s/);
});

test("--skip-gate prints that the gate did not run", (t) => {
  const root = fixture(t);
  const lines: string[] = [];
  release({ root, version: "0.1.0", date: "2026-11-05", skipGate: true, gate: passGate, stdout: (l) => lines.push(l) });
  const note = lines.findIndex((line) => /gate did not run/.test(line));
  assert.ok(note > 0 && note < lines.findIndex((line) => line.startsWith("Next steps")));
});

test("a prerelease or odd tag does not hide the real last tag", (t) => {
  const root = fixture(t);
  git(root, "tag", "v0.2.0");
  commit(root, "feat: a");
  git(root, "tag", "v0.3.0-rc.1");
  git(root, "tag", "vfoo");
  assert.throws(() => run(root, "0.2.0"), /tag v0\.2\.0 already exists/);
  assert.equal(run(root, "0.2.1").previousTag, "v0.2.0");
});

test("newest means the highest tag merged into HEAD", (t) => {
  const root = fixture(t);
  git(root, "tag", "v0.1.0");
  git(root, "switch", "-q", "-c", "other");
  commit(root, "feat: elsewhere");
  git(root, "tag", "v0.9.0");
  git(root, "switch", "-q", "main");
  commit(root, "fix: here");
  assert.equal(run(root, "0.1.1").previousTag, "v0.1.0");
});

test("refuses when a nested version key comes before the top-level one", (t) => {
  const root = fixture(t);
  const nested = '{\n  "meta": { "version": "1" },\n  "name": "x",\n  "version": "0.1.0"\n}\n';
  writeFileSync(join(root, "apps/emend/package.json"), nested);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "chore: nested");
  assert.throws(() => run(root, "0.2.0"), /could not set the top-level version/);
  assert.equal(readFileSync(join(root, "apps/emend/package.json"), "utf8"), nested);
  assert.equal(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8"), PLUGIN_JSON);
});

test("localDate uses local time", () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["1.2.3"]), { version: "1.2.3", skipGate: false });
  assert.deepEqual(parseArgs(["--skip-gate", "1.2.3"]), { version: "1.2.3", skipGate: true });
  assert.deepEqual(parseArgs(["1.2.3", "--skip-gate"]), { version: "1.2.3", skipGate: true });
  for (const bad of [[], ["--skip-gate"], ["1.2.3", "4.5.6"], ["-x"], ["--other", "1.2.3"]]) {
    assert.throws(() => parseArgs(bad), /Usage: pnpm release/);
  }
});

test("inserts into a CHANGELOG without a header", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "CHANGELOG.md"), "old notes\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "chore: notes");
  run(root, "0.1.0");
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /^# Changelog\n\nNewest first\.[^\n]*\n\n## 0\.1\.0 \(2026-11-05\)\n\nFirst release\.\n\nold notes\n$/);
});

test("a later release groups commits and skips other types", (t) => {
  const root = fixture(t);
  run(root, "0.1.0");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "chore: release 0.1.0");
  git(root, "tag", "v0.1.0");
  commit(root, "feat(cli): add stop");
  commit(root, "fix(api): handle empty body");
  commit(root, "perf(core): faster ids");
  commit(root, "docs: words");
  commit(root, "test: more");
  commit(root, "chore(deps): bump");
  commit(root, "refactor(db)!: drop a column");
  commit(root, "feat: new flag", "BREAKING CHANGE: the flag changes meaning");
  commit(root, "not conventional at all");
  const result = run(root, "0.2.0");
  assert.equal(result.previousTag, "v0.1.0");
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.equal(
    result.changelogSection,
    `## 0.2.0 (2026-11-05)

### Breaking changes

- new flag
- drop a column (db)

### Features

- add stop (cli)

### Fixes

- handle empty body (api)

### Performance

- faster ids (core)
`,
  );
  assert.ok(changelog.indexOf("## 0.2.0") < changelog.indexOf("## 0.1.0"));
  assert.equal(changelog.match(/^# Changelog/gm)?.length, 1);
  assert.doesNotMatch(changelog, /words|more\n|bump/);
});

test("omits empty groups and falls back to Maintenance release.", (t) => {
  const root = fixture(t);
  git(root, "tag", "v0.1.0");
  commit(root, "fix: one thing");
  assert.doesNotMatch(run(root, "0.1.1").changelogSection, /Features|Breaking|Performance/);
  const other = fixture(t);
  git(other, "tag", "v0.1.0");
  commit(other, "docs: only docs");
  assert.match(run(other, "0.1.1").changelogSection, /\n\nMaintenance release\.\n$/);
});

test("changes only the version values, byte for byte", (t) => {
  const root = fixture(t);
  run(root, "0.3.0");
  assert.equal(
    readFileSync(join(root, "apps/emend/package.json"), "utf8"),
    CLI_JSON.replace('"0.1.0"', '"0.3.0"'),
  );
  assert.equal(
    readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8"),
    PLUGIN_JSON.replace('"9.9.9"', '"0.3.0"'),
  );
  assert.equal(
    readFileSync(join(root, "apps/emend/src/version.ts"), "utf8"),
    VERSION_TS.replace('VERSION = "0.1.0"', 'VERSION = "0.3.0"'),
  );
});

test("refuses when version.ts lacks the VERSION line or has it twice", (t) => {
  for (const content of ['export const OTHER = "0.1.0";\n', VERSION_TS + VERSION_TS, 'export const VERSION: string = X;\n']) {
    const root = fixture(t);
    writeFileSync(join(root, "apps/emend/src/version.ts"), content);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "chore: odd");
    assert.throws(() => run(root, "0.2.0"), /exactly one 'export const VERSION = "...";' line/);
    assert.equal(readFileSync(join(root, "apps/emend/package.json"), "utf8"), CLI_JSON);
    assert.equal(readFileSync(join(root, "apps/emend/src/version.ts"), "utf8"), content);
  }
});

test("a second run for the same version is refused", (t) => {
  const root = fixture(t);
  run(root, "0.1.0");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "chore: release 0.1.0");
  assert.throws(() => run(root, "0.1.0"), /already has a section for 0\.1\.0/);
});

test("the gate runs after the files are written and its failure is reported", (t) => {
  const root = fixture(t);
  let seen = "";
  const failing: GateRunner = (gateRoot) => {
    seen = readFileSync(join(gateRoot, "apps/emend/package.json"), "utf8");
    assert.match(readFileSync(join(gateRoot, "CHANGELOG.md"), "utf8"), /## 0\.1\.0/);
    throw new Error("lint failed");
  };
  const lines: string[] = [];
  assert.throws(() => run(root, "0.1.0", failing, lines), /gate failed \(lint failed\).*left in place/);
  assert.match(seen, /"version": "0\.1\.0"/);
  assert.ok(!lines.some((line) => line.startsWith("Next steps")));

  const skipped = fixture(t);
  let called = false;
  release({
    root: skipped,
    version: "0.1.0",
    date: "2026-11-05",
    skipGate: true,
    gate: () => {
      called = true;
    },
  });
  assert.equal(called, false);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Runner } from "./install-local.ts";
import { publishCommand, releasePack, remoteTagCommit, shellQuote } from "./release-pack.ts";

const SHA = "abc123def4567890abc123def4567890abc123de";

interface Options {
  tag?: boolean;
  verify?: boolean;
  remote?: string | null;
  cliVersion?: string;
  pluginVersion?: string;
  sourceVersion?: string | null;
  packedVersion?: string;
  failOn?: string;
  base?: string;
  head?: string;
  dirty?: string;
  env?: NodeJS.ProcessEnv;
  mutateTarball?: boolean;
}

function setup(options: Options = {}) {
  const base = options.base ?? mkdtempSync(join(tmpdir(), "emend-release-pack-test-"));
  const calls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const run: Runner = async (program, args, { cwd }) => {
    calls.push([program, ...args]);
    const label = `${program} ${args[0]}`;
    if (options.failOn === label) throw new Error("boom");
    if (program === "git" && args[0] === "rev-parse") {
      if (args[1] === "HEAD") return `${options.head ?? SHA}\n`;
      if (options.tag === false) throw new Error("no tag");
      return `${SHA}\n`;
    }
    if (program === "git" && args[0] === "status") return options.dirty ?? "";
    if (program === "node" && options.mutateTarball) writeFileSync(args[2] as string, "tampered");
    if (program === "git" && args[0] === "verify-tag") {
      if (options.verify === false) throw new Error("bad signature");
      return "";
    }
    if (program === "git" && args[0] === "ls-remote") {
      if (options.remote === null) return "";
      return `${options.remote ?? SHA}\trefs/tags/v0.1.0^{}\n`;
    }
    if (program === "git" && args[0] === "show") {
      if (args[1]?.endsWith("apps/emend/src/version.ts")) {
        if (options.sourceVersion === null) return "export const OTHER = 1;\n";
        return `export const VERSION = "${options.sourceVersion ?? "0.1.0"}";\n`;
      }
      const version = args[1]?.endsWith("apps/emend/package.json") ? options.cliVersion : options.pluginVersion;
      return JSON.stringify({ version: version ?? "0.1.0" });
    }
    if (label === "pnpm pack") {
      writeFileSync(join(args[2] as string, "shllg-emend-0.1.0.tgz"), "tarball bytes");
      assert.ok(cwd.endsWith(join("src", "apps/emend")));
    }
    if (program === "tar" && args[0] === "-xzOf") return JSON.stringify({ version: options.packedVersion ?? "0.1.0" });
    return "";
  };
  const finish = () => rmSync(base, { recursive: true, force: true });
  const go = (args: string[] = ["0.1.0"]) =>
    releasePack(args, {
      root: join(base, "root"),
      env: options.env ?? {},
      run,
      temporaryRoot: base,
      signals: { on() {}, off() {} },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
  const folders = () => readdirSync(base).filter((name) => name.startsWith("emend-release-pack-"));
  return { calls, out, err, go, finish, folders, base };
}

test("a shallow clone of a tag has the tag ref, its commit and a matching origin listing", () => {
  const base = mkdtempSync(join(tmpdir(), "emend-release-pack-clone-"));
  try {
    const config = join(base, "gitconfig");
    writeFileSync(config, "");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd,
        env,
        encoding: "utf8",
      }).trim();
    const work = join(base, "work");
    mkdirSync(work);
    git(work, "init", "-q", "-b", "main");
    writeFileSync(join(work, "f"), "a");
    git(work, "add", "f");
    git(work, "commit", "-q", "-m", "one");
    git(work, "tag", "-a", "v0.1.0", "-m", "emend 0.1.0");
    writeFileSync(join(work, "f"), "b");
    git(work, "commit", "-q", "-a", "-m", "two");
    const bare = join(base, "bare.git");
    git(base, "clone", "-q", "--bare", work, bare);
    const clone = join(base, "clone");
    git(base, "clone", "-q", "--depth", "1", "--branch", "v0.1.0", `file://${bare}`, clone);
    const commit = git(clone, "rev-parse", "--verify", "refs/tags/v0.1.0^{commit}");
    assert.equal(commit, git(work, "rev-parse", "v0.1.0^{commit}"));
    const listing = git(clone, "ls-remote", "origin", "refs/tags/v0.1.0^{}", "refs/tags/v0.1.0");
    assert.equal(remoteTagCommit(listing, "refs/tags/v0.1.0"), commit);
    assert.ok(git(clone, "archive", "--format=tar", commit).length > 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("rejects a bad version argument", async () => {
  const t = setup();
  assert.equal(await t.go(["v0.1.0"]), 2);
  assert.equal(await t.go(["0.02.0"]), 2);
  assert.equal(await t.go(["1.00.0"]), 2);
  assert.equal(await t.go([]), 2);
  assert.deepEqual(t.calls, []);
  t.finish();
});

test("refuses a missing tag before anything is created", async () => {
  const t = setup({ tag: false });
  assert.equal(await t.go(), 1);
  assert.match(t.err.join("\n"), /tag v0\.1\.0 does not exist/);
  assert.deepEqual(t.folders(), []);
  t.finish();
});

test("refuses inside an agent session before running anything", async () => {
  const t = setup({ env: { CLAUDECODE: "1" } });
  assert.equal(await t.go(), 1);
  assert.match(t.err.join("\n"), /own terminal, not in an agent session/);
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.folders(), []);
  t.finish();
});

test("refuses unless HEAD is the tag's commit", async () => {
  const t = setup({ head: "e".repeat(40) });
  assert.equal(await t.go(), 1);
  assert.match(t.err.join("\n"), /HEAD is e+, not v0\.1\.0.*fresh clone/);
  assert.deepEqual(t.folders(), []);
  t.finish();
});

test("refuses a dirty working tree", async () => {
  const t = setup({ dirty: " M scripts/release-pack.ts\n" });
  assert.equal(await t.go(), 1);
  assert.match(t.err.join("\n"), /working tree is not clean/);
  assert.deepEqual(t.folders(), []);
  t.finish();
});

test("refuses when the tarball changes during the check", async () => {
  const t = setup({ mutateTarball: true });
  assert.equal(await t.go(), 1);
  assert.match(t.err.join("\n"), /tarball changed while it was checked/);
  assert.deepEqual(t.folders(), []);
  assert.ok(!t.out.some((line) => line.startsWith("npm publish")));
  t.finish();
});

test("refuses a tag without a valid signature", async () => {
  const t = setup({ verify: false });
  assert.equal(await t.go(), 1);
  assert.match(t.err.join("\n"), /no valid signature; sign it with git tag -s/);
  assert.ok(!t.calls.some((call) => call[1] === "archive"));
  t.finish();
});

test("refuses a tag that origin does not have or has elsewhere", async () => {
  for (const [remote, message] of [
    [null, /origin has no v0\.1\.0; push the tag first/],
    ["f".repeat(40), /push the tag first/],
  ] as const) {
    const t = setup({ remote });
    assert.equal(await t.go(), 1);
    assert.match(t.err.join("\n"), message);
    assert.deepEqual(t.folders(), []);
    assert.ok(!t.calls.some((call) => call[1] === "archive"));
    t.finish();
  }
});

test("says so when the tag's version.ts has no VERSION line", async () => {
  const t = setup({ sourceVersion: null });
  assert.equal(await t.go(), 1);
  assert.match(t.err.join("\n"), /version\.ts at v0\.1\.0 has no 'export const VERSION = "...";' line/);
  assert.doesNotMatch(t.err.join("\n"), /undefined/);
  assert.deepEqual(t.folders(), []);
  t.finish();
});

test("refuses a tag whose version files disagree", async () => {
  for (const options of [{ cliVersion: "0.0.9" }, { pluginVersion: "9.9.9" }, { sourceVersion: "0.0.8" }]) {
    const t = setup(options);
    assert.equal(await t.go(), 1);
    assert.match(t.err.join("\n"), /says (0\.0\.9|9\.9\.9|0\.0\.8), not 0\.1\.0/);
    assert.ok(!t.calls.some((call) => call[1] === "archive"));
    assert.deepEqual(t.folders(), []);
    t.finish();
  }
});

test("resolves the tag once, uses the commit, checks the packed file and prints the command", async () => {
  const t = setup();
  assert.equal(await t.go(), 0);
  assert.deepEqual(
    t.calls.filter((call) => call[1] === "rev-parse" && call[2] !== "HEAD"),
    [["git", "rev-parse", "--verify", "refs/tags/v0.1.0^{commit}"]],
  );
  for (const call of t.calls) {
    if (call[1] === "show") assert.ok(call[2]?.startsWith(`${SHA}:`));
  }
  assert.equal(t.calls.find((call) => call[1] === "archive")?.at(-1), SHA);
  assert.deepEqual(
    t.calls.map((call) => call.slice(0, 2).join(" ")),
    [
      "git rev-parse",
      "git rev-parse",
      "git status",
      "git verify-tag",
      "git ls-remote",
      "git show",
      "git show",
      "git show",
      "git archive",
      "tar -xf",
      "pnpm install",
      "pnpm build",
      "pnpm pack",
      "node scripts/check-package.ts",
      "tar -xzOf",
    ],
  );
  assert.deepEqual(t.calls.find((call) => call[1] === "install"), [
    "pnpm",
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
  ]);
  const [folder] = t.folders();
  assert.ok(folder);
  const tarball = join(t.base, folder, "pack", "shllg-emend-0.1.0.tgz");
  assert.ok(existsSync(tarball));
  const check = t.calls.find((call) => call[1] === "scripts/check-package.ts");
  assert.deepEqual(check, ["node", "scripts/check-package.ts", "--tarball", tarball]);
  const expected = `sha512-${createHash("sha512").update("tarball bytes").digest("base64")}`;
  assert.ok(t.out.includes(`integrity: ${expected}`));
  assert.ok(t.out.includes(`shasum: ${createHash("sha1").update("tarball bytes").digest("hex")}`));
  assert.ok(t.out.some((line) => /shasum line, and the start and end of the integrity line/.test(line)));
  assert.ok(t.out.includes(`npm publish --ignore-scripts --registry=https://registry.npmjs.org/ '${tarball}'`));
  assert.ok(t.out.some((line) => line.includes(SHA)));
  assert.ok(t.out.some((line) => line.includes("kept") && line.includes(folder)));
  t.finish();
});

test("quotes a path with a space and a single quote", () => {
  assert.equal(shellQuote("/a b/it's"), "'/a b/it'\\''s'");
  assert.equal(
    publishCommand("/tmp/a b/it's.tgz"),
    "npm publish --ignore-scripts --registry=https://registry.npmjs.org/ '/tmp/a b/it'\\''s.tgz'",
  );
});

test("remoteTagCommit prefers the peeled ref and accepts a lightweight tag", () => {
  const ref = "refs/tags/v1.0.0";
  assert.equal(remoteTagCommit(`aaa\t${ref}\nbbb\t${ref}^{}\n`, ref), "bbb");
  assert.equal(remoteTagCommit(`aaa\t${ref}\n`, ref), "aaa");
  assert.equal(remoteTagCommit("", ref), undefined);
});

test("refuses a packed manifest with another version and cleans up", async () => {
  const t = setup({ packedVersion: "0.0.1" });
  assert.equal(await t.go(), 1);
  assert.match(t.err.join("\n"), /packed version is 0\.0\.1, not 0\.1\.0/);
  assert.deepEqual(t.folders(), []);
  assert.ok(!t.out.some((line) => line.startsWith("npm publish")));
  t.finish();
});

test("removes the folder when a step fails", async () => {
  for (const failOn of ["pnpm build", "node scripts/check-package.ts", "pnpm install", "pnpm pack"]) {
    const t = setup({ failOn });
    assert.equal(await t.go(), 1);
    assert.match(t.err.join("\n"), /failed/);
    assert.deepEqual(t.folders(), []);
    t.finish();
  }
});

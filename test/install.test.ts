import { spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const refusal =
  "install.sh: ~/.local/bin/emend exists and was not made by this checkout; move it away, then run install.sh again.\n";
const unusableBin =
  "install.sh: ~/.local/bin is not a folder this user can write to; fix it, then run install.sh again.\n";
const caseInsensitive = (() => {
  const probe = mkdtempSync(join(tmpdir(), "emend-case-probe-"));
  try {
    writeFileSync(join(probe, "CaseProbe"), "synthetic probe");
    return lstatSync(join(probe, "caseprobe"), { throwIfNoEntry: false }) !== undefined;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
let root: string;
let home: string;
let checkout: string;
let fakeBin: string;
let log: string;
let target: string;
let env: NodeJS.ProcessEnv;

async function command(program: string, args: string[], environment: NodeJS.ProcessEnv, cwd = root) {
  // Regular files also capture output on sandboxes that restrict child stdio sockets.
  const output = mkdtempSync(join(root, "output-"));
  const stdout = join(output, "stdout");
  const stderr = join(output, "stderr");
  const descriptors = [openSync(stdout, "w"), openSync(stderr, "w")];
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const child = spawn(program, args, {
        cwd,
        env: environment,
        stdio: ["ignore", ...descriptors],
        timeout: 20_000,
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === null) reject(new Error(`Child terminated by ${signal}`));
        else resolve(code);
      });
    });
    return { status, stdout: readFileSync(stdout, "utf8"), stderr: readFileSync(stderr, "utf8") };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

function executable(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, { mode: 0o755 });
}

function copyCheckout(destination = checkout) {
  mkdirSync(join(destination, "apps/emend"), { recursive: true });
  copyFileSync(join(repo, "install.sh"), join(destination, "install.sh"));
  copyFileSync(join(repo, "apps/emend/package.json"), join(destination, "apps/emend/package.json"));
}

function run(args: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
  return command("/bin/bash", [join(checkout, "install.sh"), ...args], { ...env, ...overrides });
}

function calls(): { args: string[]; cwd: string }[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function fakeNode(version: string) {
  executable(
    join(fakeBin, "node"),
    '#!/bin/sh\nif [ "$1" = "-p" ] && [ "$2" = "process.versions.node" ]; then\n' +
      '  printf "%s\\n" "$TEST_NODE_VERSION"\nelse\n  exec "$TEST_REAL_NODE" "$@"\nfi\n',
  );
  env.TEST_NODE_VERSION = version;
}

function toolPath(name: string) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, name);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Missing test tool: ${name}`);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "emend-install-")));
  home = join(root, "home with spaces");
  checkout = join(root, "checkout with spaces");
  fakeBin = join(root, "fake-bin");
  log = join(root, "pnpm.jsonl");
  target = join(home, ".local/bin/emend");
  mkdirSync(home);
  executable(
    join(fakeBin, "pnpm"),
    `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_PNPM_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args[0] === process.env.TEST_PNPM_FAIL) process.exit(7);
if (args[0] === "build" && process.env.TEST_PNPM_CREATE_FOREIGN === "1") {
  const bin = join(process.env.HOME, ".local/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "emend"), "keep the file created during build");
}
`,
  );
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    TEST_PNPM_LOG: log,
    TEST_REAL_NODE: process.execPath,
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test.each(["--dry-run", "-n"])("%s prints the steps without writing to HOME or running pnpm", async (flag) => {
  copyCheckout();
  const result = await run([flag]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("would run pnpm install --frozen-lockfile");
  expect(result.stdout).toContain("would run pnpm build");
  expect(result.stdout).toContain(`would link ~/.local/bin/emend -> ${checkout}/apps/emend/bin/emend`);
  expect(readdirSync(home)).toEqual([]);
  expect(calls()).toEqual([]);
});

test("installs then builds in the checkout, links the launcher and warns about PATH", async () => {
  copyCheckout();
  const result = await run();
  expect(result.status).toBe(0);
  expect(calls()).toEqual([
    { args: ["install", "--frozen-lockfile"], cwd: checkout },
    { args: ["build"], cwd: checkout },
  ]);
  expect(readlinkSync(target)).toBe(join(checkout, "apps/emend/bin/emend"));
  expect(result.stderr).toContain("~/.local/bin is not on PATH");
  expect(result.stdout + result.stderr).not.toContain(home);
});

test("refuses a foreign file created by the build without changing its contents", async () => {
  copyCheckout();
  const result = await run([], { TEST_PNPM_CREATE_FOREIGN: "1" });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(refusal);
  expect(readFileSync(target, "utf8")).toBe("keep the file created during build");
  expect(calls().map(({ args }) => args)).toEqual([["install", "--frozen-lockfile"], ["build"]]);
});

test("does not replace a file appearing between the final check and symlink creation", async () => {
  copyCheckout();
  const preload = join(root, "race.cjs");
  writeFileSync(
    preload,
    `const fs = require("node:fs");
const symlink = fs.symlinkSync;
fs.symlinkSync = (source, target, ...args) => {
  if (target === process.env.TEST_LINK_TARGET) fs.writeFileSync(target, "keep the racing file");
  return symlink(source, target, ...args);
};
`,
  );
  const result = await run([], { NODE_OPTIONS: `--require=${preload}`, TEST_LINK_TARGET: target });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(refusal);
  expect(readFileSync(target, "utf8")).toBe("keep the racing file");
});

test("a second run rebuilds but preserves the link and directory inode and timestamps", async () => {
  copyCheckout();
  expect((await run()).status).toBe(0);
  const linkBefore = lstatSync(target);
  const directoryBefore = lstatSync(dirname(target));
  const result = await run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("already linked");
  expect(readlinkSync(target)).toBe(join(checkout, "apps/emend/bin/emend"));
  expect(lstatSync(target).ino).toBe(linkBefore.ino);
  expect(lstatSync(target).mtimeMs).toBe(linkBefore.mtimeMs);
  expect(lstatSync(dirname(target)).ino).toBe(directoryBefore.ino);
  expect(lstatSync(dirname(target)).mtimeMs).toBe(directoryBefore.mtimeMs);
  expect(calls().map(({ args }) => args)).toEqual([
    ["install", "--frozen-lockfile"],
    ["build"],
    ["install", "--frozen-lockfile"],
    ["build"],
  ]);
});

test("dry-run preserves an existing link and reports already linked", async () => {
  copyCheckout();
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(join(checkout, "apps/emend/bin/emend"), target);
  const before = lstatSync(target);
  const result = await run(["--dry-run"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("already linked");
  expect(lstatSync(target).ino).toBe(before.ino);
  expect(calls()).toEqual([]);
});

test.each(["file", "directory", "foreign symlink", "dangling symlink", "sibling checkout symlink"])(
  "refuses a %s before any pnpm step, including in dry-run",
  async (kind) => {
    copyCheckout();
    mkdirSync(dirname(target), { recursive: true });
    if (kind === "file") writeFileSync(target, "keep me");
    else if (kind === "directory") mkdirSync(target);
    else {
      const foreign = kind === "sibling checkout symlink" ? `${checkout}-other/emend` : join(root, "foreign");
      if (kind === "foreign symlink") writeFileSync(foreign, "keep me");
      symlinkSync(foreign, target);
    }
    const before = lstatSync(target);
    for (const args of [[], ["--dry-run"]]) {
      const result = await run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(refusal);
      expect(result.stdout).toBe("");
    }
    expect(lstatSync(target).ino).toBe(before.ino);
    expect(calls()).toEqual([]);
  },
);

test.each(["absolute", "relative", "dangling", "directory"])(
  "relinks a %s symlink into this checkout",
  async (kind) => {
    copyCheckout();
    mkdirSync(dirname(target), { recursive: true });
    const previous = join(checkout, kind === "dangling" ? "apps/emend/bin/old-name" : "previous");
    if (kind === "directory") mkdirSync(previous);
    else if (kind !== "dangling") writeFileSync(previous, "old launcher");
    const link = kind === "relative" ? relative(dirname(target), previous) : previous;
    symlinkSync(link, target);
    expect((await run(["--dry-run"])).status).toBe(0);
    expect(readlinkSync(target)).toBe(link);
    expect(calls()).toEqual([]);
    expect((await run()).status).toBe(0);
    expect(readlinkSync(target)).toBe(join(checkout, "apps/emend/bin/emend"));
    if (kind === "directory") expect(readdirSync(previous)).toEqual([]);
    else if (kind !== "dangling") expect(readFileSync(previous, "utf8")).toBe("old launcher");
  },
);

test.each(["link", "directory"])("refuses foreign %s indirection into this checkout", async (kind) => {
  copyCheckout();
  const launcher = copyLauncher();
  mkdirSync(dirname(target), { recursive: true });
  const indirect = join(root, "foreign indirection");
  const indirectText = kind === "link" ? launcher : dirname(launcher);
  symlinkSync(indirectText, indirect);
  const text = kind === "link" ? indirect : join(indirect, "emend");
  symlinkSync(text, target);
  const before = lstatSync(target);
  const indirectBefore = lstatSync(indirect);
  for (const args of [[], ["--dry-run"]]) {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal);
  }
  expect(readlinkSync(target)).toBe(text);
  expect(lstatSync(target).ino).toBe(before.ino);
  expect(readlinkSync(indirect)).toBe(indirectText);
  expect(lstatSync(indirect).ino).toBe(indirectBefore.ino);
  expect(calls()).toEqual([]);
});

test.each(["ancestor", "trailing slash"])("refuses a checkout alias with %s before pnpm", async (kind) => {
  checkout = join(root, "source", "checkout with spaces");
  copyCheckout();
  const launcher = copyLauncher();
  mkdirSync(dirname(target), { recursive: true });
  const alias = join(root, "checkout alias");
  const aliasText = kind === "ancestor" ? dirname(checkout) : checkout;
  symlinkSync(aliasText, alias);
  const text = kind === "ancestor" ? join(alias, relative(dirname(checkout), launcher)) : `${alias}/`;
  symlinkSync(text, target);
  const before = lstatSync(target);
  const aliasBefore = lstatSync(alias);
  for (const args of [[], ["--dry-run"]]) {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal);
    expect(result.stdout).toBe("");
  }
  expect(readlinkSync(target)).toBe(text);
  expect(lstatSync(target).ino).toBe(before.ino);
  expect(readlinkSync(alias)).toBe(aliasText);
  expect(lstatSync(alias).ino).toBe(aliasBefore.ino);
  expect(calls()).toEqual([]);
});

test.each(["absolute", "relative"])("refuses an alias followed by .. before pnpm (%s)", async (kind) => {
  copyCheckout();
  const launcher = copyLauncher();
  mkdirSync(dirname(target), { recursive: true });
  const directory = join(root, "alias destination");
  mkdirSync(directory);
  const alias = join(root, "checkout alias");
  symlinkSync(directory, alias);
  const prefix = kind === "relative" ? relative(dirname(target), alias) : alias;
  const text = `${prefix}/../${relative(root, launcher)}`;
  symlinkSync(text, target);
  const before = lstatSync(target);
  const aliasBefore = lstatSync(alias);
  for (const args of [[], ["--dry-run"]]) {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal);
    expect(result.stdout).toBe("");
  }
  expect(readlinkSync(target)).toBe(text);
  expect(lstatSync(target).ino).toBe(before.ino);
  expect(readlinkSync(alias)).toBe(directory);
  expect(lstatSync(alias).ino).toBe(aliasBefore.ino);
  expect(calls()).toEqual([]);
});

test("refuses a path leaving the checkout through .. before pnpm", async () => {
  copyCheckout();
  mkdirSync(dirname(target), { recursive: true });
  const directory = join(root, "other folder");
  mkdirSync(directory);
  const foreign = join(directory, "emend");
  writeFileSync(foreign, "keep this launcher");
  const text = `${checkout}/../other folder/emend`;
  symlinkSync(text, target);
  const before = lstatSync(target);
  for (const args of [[], ["--dry-run"]]) {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal);
    expect(result.stdout).toBe("");
  }
  expect(readlinkSync(target)).toBe(text);
  expect(lstatSync(target).ino).toBe(before.ino);
  expect(readFileSync(foreign, "utf8")).toBe("keep this launcher");
  expect(calls()).toEqual([]);
});

test("refuses .. after a missing path component before pnpm", async () => {
  copyCheckout();
  copyLauncher();
  mkdirSync(dirname(target), { recursive: true });
  const text = `${checkout}/missing/../apps/emend/bin/emend`;
  symlinkSync(text, target);
  const before = lstatSync(target);
  for (const args of [[], ["--dry-run"]]) {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal);
    expect(result.stdout).toBe("");
  }
  expect(readlinkSync(target)).toBe(text);
  expect(lstatSync(target).ino).toBe(before.ino);
  expect(existsSync(join(checkout, "missing"))).toBe(false);
  expect(calls()).toEqual([]);
});

test("refuses a link through a foreign file before pnpm", async () => {
  copyCheckout();
  mkdirSync(dirname(target), { recursive: true });
  const file = join(root, "foreign file");
  writeFileSync(file, "keep this file");
  const text = join(file, "emend");
  symlinkSync(text, target);
  const before = lstatSync(target);
  for (const args of [[], ["--dry-run"]]) {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal);
    expect(result.stdout).toBe("");
  }
  expect(readlinkSync(target)).toBe(text);
  expect(lstatSync(target).ino).toBe(before.ino);
  expect(readFileSync(file, "utf8")).toBe("keep this file");
  expect(calls()).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)("refuses a link through a foreign unreadable folder before pnpm", async () => {
  copyCheckout();
  mkdirSync(dirname(target), { recursive: true });
  const directory = join(root, "foreign unreadable folder");
  mkdirSync(join(directory, "d"), { recursive: true });
  const text = join(directory, "d/emend");
  symlinkSync(text, target);
  const before = lstatSync(target);
  chmodSync(directory, 0o000);
  try {
    for (const args of [[], ["--dry-run"]]) {
      const result = await run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(refusal);
      expect(result.stdout).toBe("");
    }
    expect(readlinkSync(target)).toBe(text);
    expect(lstatSync(target).ino).toBe(before.ino);
    expect(calls()).toEqual([]);
  } finally {
    chmodSync(directory, 0o755);
  }
});

test("refuses a checkout alias whose chain goes through a file before pnpm", async () => {
  copyCheckout();
  mkdirSync(dirname(target), { recursive: true });
  const file = join(root, "foreign file");
  writeFileSync(file, "keep this file");
  const alias = join(checkout, "alias");
  symlinkSync(file, alias);
  const text = join(alias, "emend");
  symlinkSync(text, target);
  const before = lstatSync(target);
  const aliasBefore = lstatSync(alias);
  for (const args of [[], ["--dry-run"]]) {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal);
    expect(result.stdout).toBe("");
  }
  expect(readlinkSync(target)).toBe(text);
  expect(lstatSync(target).ino).toBe(before.ino);
  expect(readlinkSync(alias)).toBe(file);
  expect(lstatSync(alias).ino).toBe(aliasBefore.ino);
  expect(readFileSync(file, "utf8")).toBe("keep this file");
  expect(calls()).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)(
  "refuses a checkout alias whose chain enters an unreadable folder before pnpm",
  async () => {
    copyCheckout();
    mkdirSync(dirname(target), { recursive: true });
    const directory = join(root, "foreign unreadable folder");
    mkdirSync(join(directory, "d"), { recursive: true });
    const alias = join(checkout, "alias");
    symlinkSync(directory, alias);
    const text = join(alias, "d/emend");
    symlinkSync(text, target);
    const before = lstatSync(target);
    const aliasBefore = lstatSync(alias);
    chmodSync(directory, 0o000);
    try {
      for (const args of [[], ["--dry-run"]]) {
        const result = await run(args);
        expect(result.status).toBe(1);
        expect(result.stderr).toBe(refusal);
        expect(result.stdout).toBe("");
      }
      expect(readlinkSync(target)).toBe(text);
      expect(lstatSync(target).ino).toBe(before.ino);
      expect(readlinkSync(alias)).toBe(directory);
      expect(lstatSync(alias).ino).toBe(aliasBefore.ino);
      expect(calls()).toEqual([]);
    } finally {
      chmodSync(directory, 0o755);
    }
  },
);

test("cleans the temporary link after a failed rename and reports the actual error", async () => {
  copyCheckout();
  mkdirSync(dirname(target), { recursive: true });
  const previous = join(checkout, "previous");
  symlinkSync(previous, target);
  const preload = join(root, "rename-error.cjs");
  writeFileSync(
    preload,
    `require("node:fs").renameSync = () => {
  throw Object.assign(new Error("synthetic rename failure"), { code: "EACCES" });
};
`,
  );
  const result = await run([], { NODE_OPTIONS: `--require=${preload}` });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("install.sh: could not check ~/.local/bin/emend (EACCES).\n");
  expect(readlinkSync(target)).toBe(previous);
  expect(readdirSync(dirname(target))).toEqual(["emend"]);
});

test.each([false, true])("refuses ~/.local/bin pointing into the checkout (dangling: %s)", async (dangling) => {
  copyCheckout();
  mkdirSync(join(home, ".local"));
  const directory = join(checkout, "destination");
  if (!dangling) mkdirSync(directory);
  symlinkSync(directory, dirname(target));
  const result = await run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("~/.local/bin");
  expect(result.stderr).not.toContain(home);
  expect(calls()).toEqual([]);
  if (!dangling) expect(readdirSync(directory)).toEqual([]);
  else expect(existsSync(directory)).toBe(false);
});

test.skipIf(!caseInsensitive)("refuses a bin symlink using another case for the checkout", async () => {
  copyCheckout();
  mkdirSync(join(home, ".local"));
  const alternate = join(dirname(checkout), "CHECKOUT WITH SPACES");
  symlinkSync(alternate, dirname(target));
  const result = await run();
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(
    "install.sh: ~/.local/bin points into this checkout; move it away, then run install.sh again.\n",
  );
  expect(readlinkSync(dirname(target))).toBe(alternate);
  expect(calls()).toEqual([]);
});

test.each(["relative", "unset", "empty"])("refuses %s HOME before pnpm", async (kind) => {
  copyCheckout();
  const result = await run([], { HOME: kind === "relative" ? "h" : kind === "empty" ? "" : undefined });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("install.sh: HOME must be an absolute path.\n");
  expect(result.stdout).toBe("");
  expect(calls()).toEqual([]);
  expect(readdirSync(home)).toEqual([]);
  expect(existsSync(join(checkout, "h"))).toBe(false);
});

test.each(["dangling symlink", "file"])("refuses a %s at ~/.local/bin before pnpm", async (kind) => {
  copyCheckout();
  mkdirSync(join(home, ".local"));
  const bin = dirname(target);
  if (kind === "file") writeFileSync(bin, "keep this file");
  else symlinkSync(join(root, "missing bin"), bin);
  const before = lstatSync(bin);
  for (const args of [[], ["--dry-run"]]) {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(unusableBin);
    expect(result.stdout).toBe("");
  }
  expect(lstatSync(bin).ino).toBe(before.ino);
  expect(calls()).toEqual([]);
});

test.each(["run", "dry-run"])("refuses dangling ~/.local before pnpm (%s)", async (mode) => {
  copyCheckout();
  const local = join(home, ".local");
  const missing = join(root, "missing", "local");
  symlinkSync(missing, local);
  const before = lstatSync(local);
  const result = await run(mode === "dry-run" ? ["--dry-run"] : []);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(unusableBin);
  expect(result.stdout).toBe("");
  expect(calls()).toEqual([]);
  expect(readlinkSync(local)).toBe(missing);
  expect(lstatSync(local).ino).toBe(before.ino);
  expect(existsSync(join(root, "missing"))).toBe(false);
  expect(readdirSync(home)).toEqual([".local"]);
});

test.each([".local", ".local/bin"])("installs through %s pointing to a writable foreign folder", async (path) => {
  copyCheckout();
  copyLauncher();
  const directory = join(root, "writable foreign folder");
  mkdirSync(directory);
  const alias = join(home, path);
  mkdirSync(dirname(alias), { recursive: true });
  symlinkSync(directory, alias);
  const before = lstatSync(alias);
  expect((await run(["--dry-run"])).status).toBe(0);
  expect(calls()).toEqual([]);
  expect(readdirSync(directory)).toEqual([]);
  const result = await run();
  expect(result.status).toBe(0);
  expect(readlinkSync(target)).toBe(join(checkout, "apps/emend/bin/emend"));
  expect(readlinkSync(alias)).toBe(directory);
  expect(lstatSync(alias).ino).toBe(before.ino);
  expect(calls()).toEqual([
    { args: ["install", "--frozen-lockfile"], cwd: checkout },
    { args: ["build"], cwd: checkout },
  ]);
});

test("refuses a file at ~/.local before pnpm", async () => {
  copyCheckout();
  const local = join(home, ".local");
  writeFileSync(local, "keep this file");
  for (const args of [[], ["--dry-run"]]) {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(unusableBin);
    expect(result.stdout).toBe("");
  }
  expect(readFileSync(local, "utf8")).toBe("keep this file");
  expect(calls()).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)("refuses an unreadable bin ancestor before pnpm", async () => {
  copyCheckout();
  const local = join(home, ".local");
  mkdirSync(local);
  chmodSync(local, 0o000);
  try {
    for (const args of [[], ["--dry-run"]]) {
      const result = await run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(unusableBin);
      expect(result.stdout).toBe("");
    }
    expect(calls()).toEqual([]);
  } finally {
    chmodSync(local, 0o755);
  }
});

test.skipIf(process.getuid?.() === 0).each(["bin", "ancestor"])("refuses a read-only %s before pnpm", async (kind) => {
  copyCheckout();
  const directory = kind === "bin" ? dirname(target) : join(home, ".local");
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o555);
  try {
    for (const args of [[], ["--dry-run"]]) {
      const result = await run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(unusableBin);
      expect(result.stdout).toBe("");
    }
    expect(calls()).toEqual([]);
  } finally {
    chmodSync(directory, 0o755);
  }
});

test.skipIf(process.getuid?.() === 0)("refuses a writable bin without search permission before pnpm", async () => {
  copyCheckout();
  const bin = dirname(target);
  mkdirSync(bin, { recursive: true });
  chmodSync(bin, 0o200);
  try {
    for (const args of [[], ["--dry-run"]]) {
      const result = await run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(unusableBin);
      expect(result.stdout).toBe("");
    }
    expect(calls()).toEqual([]);
  } finally {
    chmodSync(bin, 0o755);
  }
});

test("refuses a symlink loop in the target chain before pnpm", async () => {
  copyCheckout();
  mkdirSync(dirname(target), { recursive: true });
  const first = join(checkout, "first");
  const second = join(checkout, "second");
  symlinkSync(second, first);
  symlinkSync(first, second);
  symlinkSync(first, target);
  const before = lstatSync(target);
  for (const args of [[], ["--dry-run"]]) {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal);
    expect(result.stdout).toBe("");
  }
  expect(readlinkSync(target)).toBe(first);
  expect(lstatSync(target).ino).toBe(before.ino);
  expect(readlinkSync(first)).toBe(second);
  expect(readlinkSync(second)).toBe(first);
  expect(calls()).toEqual([]);
});

test.each([false, true])("refuses a checkout symlink that resolves outside (through ..: %s)", async (throughParent) => {
  copyCheckout();
  mkdirSync(dirname(target), { recursive: true });
  const foreign = join(root, "foreign");
  writeFileSync(foreign, "keep me");
  const externalDirectory = join(root, "external-directory");
  mkdirSync(externalDirectory);
  symlinkSync(throughParent ? externalDirectory : foreign, join(checkout, "alias"));
  symlinkSync(throughParent ? `${checkout}/alias/../foreign` : join(checkout, "alias"), target);
  expect((await run()).stderr).toBe(refusal);
  expect(calls()).toEqual([]);
});

test.each(["install", "build"])("a failed pnpm %s returns 1 and leaves HOME untouched", async (step) => {
  copyCheckout();
  const result = await run([], { TEST_PNPM_FAIL: step });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("install.sh:");
  expect(calls().map(({ args }) => args[0])).toEqual(step === "install" ? ["install"] : ["install", "build"]);
  expect(readdirSync(home)).toEqual([]);
});

test.each([
  ["24.17.9", 1],
  ["24.18.0", 0],
  ["24.18.1", 0],
  ["25.0.0", 0],
])("Node %s is checked against the full package engine floor", async (version, status) => {
  copyCheckout();
  fakeNode(version);
  const result = await run(["--dry-run"]);
  expect(result.status).toBe(status);
  if (status === 1) expect(result.stderr).toMatch(/^install\.sh: .*24\.18\.0.*\n$/);
  expect(calls()).toEqual([]);
  expect(readdirSync(home)).toEqual([]);
});

test("reads a changed Node floor from the package manifest", async () => {
  copyCheckout();
  const manifestPath = join(checkout, "apps/emend/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.engines.node = ">=999.0.0";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  fakeNode(process.versions.node);
  const result = await run();
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^install\.sh: .*999\.0\.0.*\n$/);
  expect(calls()).toEqual([]);
  expect(readdirSync(home)).toEqual([]);
});

test.each(["node", "pnpm"])("missing %s is refused before touching HOME", async (missing) => {
  copyCheckout();
  const limitedBin = join(root, "limited-bin");
  mkdirSync(limitedBin);
  for (const tool of ["dirname", "basename", "readlink"]) {
    symlinkSync(toolPath(tool), join(limitedBin, tool));
  }
  if (missing !== "node") symlinkSync(process.execPath, join(limitedBin, "node"));
  const result = await run([], { PATH: limitedBin });
  expect(result.status).toBe(1);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toContain(missing === "node" ? "Node" : "corepack enable");
  expect(calls()).toEqual([]);
  expect(readdirSync(home)).toEqual([]);
});

test.each(["--help", "-h"])("%s works without prerequisites", async (flag) => {
  copyCheckout();
  const result = await run([flag], { PATH: "" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage: install.sh [-n|--dry-run] [-h|--help]");
  expect(result.stderr).toBe("");
  expect(calls()).toEqual([]);
});

test("an unknown option exits 2 with one stderr line", async () => {
  copyCheckout();
  const result = await run(["--unknown"]);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^install\.sh: .*--unknown.*\n$/);
  expect(calls()).toEqual([]);
});

test("abbreviates checkout paths under HOME and does not warn when the bin directory is on PATH", async () => {
  checkout = join(home, "checkout with spaces");
  copyCheckout();
  const result = await run([], { PATH: `${dirname(target)}:${env.PATH}` });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("~/checkout with spaces/apps/emend/bin/emend");
  expect(result.stdout).not.toContain(home);
  expect(result.stderr).toBe("");
});

test("finds the checkout through installer symlinks in another folder", async () => {
  copyCheckout();
  const alias = join(root, "installer link");
  const second = join(root, "installer relative link");
  symlinkSync(join(checkout, "install.sh"), alias);
  symlinkSync("installer link", second);
  const result = await command("/bin/bash", [second, "--dry-run"], env);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`${checkout}/apps/emend/bin/emend`);
  expect(calls()).toEqual([]);
  expect(readdirSync(home)).toEqual([]);
});

test("abbreviates checkout paths under a symlinked HOME", async () => {
  checkout = join(home, "checkout with spaces");
  copyCheckout();
  const alias = join(root, "home alias");
  symlinkSync(home, alias);
  const result = await run(["--dry-run"], { HOME: alias });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("would link ~/.local/bin/emend -> ~/checkout with spaces/apps/emend/bin/emend");
  expect(result.stdout).not.toContain(home);
  expect(calls()).toEqual([]);
});

function copyLauncher() {
  const launcher = join(checkout, "apps/emend/bin/emend");
  mkdirSync(dirname(launcher), { recursive: true });
  copyFileSync(join(repo, "apps/emend/bin/emend"), launcher);
  expect(lstatSync(launcher).mode & 0o777).toBe(0o755);
  return launcher;
}

test("the executable POSIX launcher follows two symlinks, including a relative target, and preserves arguments", async () => {
  const launcher = copyLauncher();
  const dist = join(checkout, "apps/emend/dist");
  mkdirSync(dist);
  writeFileSync(
    join(dist, "emend.mjs"),
    `if (process.argv.length === 3 && process.argv[2] === "--version") {
  console.log("synthetic-emend 0.0.0");
} else {
  console.log(JSON.stringify(process.argv.slice(2)));
  process.exitCode = 17;
}
`,
  );
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(launcher, join(root, "launcher link"));
  symlinkSync(relative(dirname(target), join(root, "launcher link")), target);
  const version = await command(target, ["--version"], env);
  expect(version.status).toBe(0);
  expect(version.stdout).toBe("synthetic-emend 0.0.0\n");
  const result = await command(target, ["--version", "argument with spaces", "", "*"], env);
  expect(result.status).toBe(17);
  expect(JSON.parse(result.stdout)).toEqual(["--version", "argument with spaces", "", "*"]);
  expect(result.stderr).toBe("");
});

test("the launcher gives a single actionable error when the build is missing", async () => {
  const result = await command(copyLauncher(), ["--version"], env);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("emend: not built; run install.sh in the emend checkout\n");
});

test("the launcher stops after 40 symlink hops", async () => {
  const first = join(root, "loop first");
  const second = join(root, "loop second");
  symlinkSync(second, first);
  symlinkSync(first, second);
  const text = readFileSync(join(repo, "apps/emend/bin/emend"), "utf8");
  const result = await command("/bin/sh", ["-c", text, first], env);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("emend: too many levels of symlinks\n");
});

test("the installer is executable", () => {
  expect(lstatSync(join(repo, "install.sh")).mode & 0o777).toBe(0o755);
});

test("pnpm pack --dry-run includes the launcher and built app, without src or a tarball", async () => {
  const pkg = join(root, "package");
  mkdirSync(pkg);
  copyFileSync(join(repo, "apps/emend/package.json"), join(pkg, "package.json"));
  // Packing resolves workspace devDependencies even though it excludes node_modules.
  // Supply synthetic manifests without installing anything or changing the package manifest.
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  for (const [name, version] of Object.entries(manifest.devDependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;
    const dependency = join(pkg, "node_modules", name);
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
  }
  for (const path of ["bin/emend", "dist/emend.mjs", "dist/web/index.html", "src/x.ts"]) {
    mkdirSync(dirname(join(pkg, path)), { recursive: true });
    writeFileSync(join(pkg, path), "synthetic package fixture\n");
  }
  const pnpm = process.env.npm_execpath;
  const args = ["pack", "--dry-run", "--json"];
  const result = await command(
    pnpm ? process.execPath : "pnpm",
    pnpm ? [pnpm, ...args] : args,
    { ...env, PATH: process.env.PATH, COREPACK_ENABLE_NETWORK: "0" },
    pkg,
  );
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain("bin/emend");
  expect(result.stdout).toContain("dist/emend.mjs");
  expect(result.stdout).toContain("dist/web/index.html");
  expect(result.stdout).not.toContain("src/");
  expect(readdirSync(pkg).some((file) => file.endsWith(".tgz"))).toBe(false);
  expect(calls()).toEqual([]);
});

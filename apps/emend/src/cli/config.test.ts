import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { expect, onTestFinished, test, vi } from "vitest";
import { StateFolderWriteError } from "../state/files.ts";
import { readConfig, validateDocRoot } from "./config.ts";
import * as reader from "./publish/read.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "emend-config-"));
  onTestFinished(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, path: join(dir, "config.json") };
}

test("a missing configuration uses defaults", async () => {
  const { dir } = await fixture();
  expect(await readConfig(dir)).toEqual({ docRoots: [], openBrowser: false });
});

test.each([{}, { openBrowser: true }, { openBrowser: false }, { unknown: "ignored" }])(
  "optional keys and unknown keys are accepted: %j",
  async (config) => {
    const { dir, path } = await fixture();
    await writeFile(path, JSON.stringify(config));
    expect(await readConfig(dir)).toEqual({ docRoots: [], openBrowser: "openBrowser" in config && config.openBrowser });
  },
);

test("docRoots and openBrowser can be used together", async () => {
  const { dir, path } = await fixture();
  const config = { docRoots: [join(dir, "docs")], openBrowser: true };
  await writeFile(path, JSON.stringify(config));
  expect(await readConfig(dir)).toEqual(config);
});

test.each([
  "null",
  "[]",
  "true",
  "42",
  '"config"',
  "{",
  '{"docRoots": null}',
  '{"docRoots": "docs"}',
  '{"docRoots": [42]}',
  '{"docRoots": ["relative/docs"]}',
  '{"openBrowser": null}',
  '{"openBrowser": "true"}',
  '{"openBrowser": 1}',
  '{"openBrowser": []}',
  '{"openBrowser": {}}',
])("invalid configuration is refused: %s", async (config) => {
  const { dir, path } = await fixture();
  await writeFile(path, config);
  await expect(readConfig(dir)).rejects.toThrow(/^invalid emend configuration$/);
});

test.each(["EACCES", "EPERM", "EROFS"])("configuration retains the state-folder diagnostic for %s", async (code) => {
  const { dir, path } = await fixture();
  vi.spyOn(reader, "readRegular").mockRejectedValueOnce(Object.assign(new Error("synthetic denial"), { code, path }));
  await expect(readConfig(dir)).rejects.toEqual(new StateFolderWriteError(dir));
});

test("configuration retains regular-file and size limits", async () => {
  const { dir, path } = await fixture();
  const source = join(dir, "source.json");
  await writeFile(source, "{}");
  await symlink(source, path);
  await expect(readConfig(dir)).rejects.toThrow(/^invalid emend configuration$/);
  await rm(path);
  await writeFile(path, "{}".padEnd(LIMITS.publicJsonBytes, " "));
  expect(await readConfig(dir)).toEqual({ docRoots: [], openBrowser: false });
  await appendFile(path, " ");
  await expect(readConfig(dir)).rejects.toThrow(/^invalid emend configuration$/);
});

async function rootFixture() {
  const f = await fixture();
  const root = await realpath(f.dir);
  const homeParent = join(root, "homes");
  const home = join(homeParent, "reviewer");
  const stateParent = join(root, "data");
  const state = join(stateParent, "emend");
  const docs = join(home, "docs");
  await mkdir(docs, { recursive: true });
  await mkdir(state, { recursive: true, mode: 0o700 });
  return { root, homeParent, home, stateParent, state, docs };
}

test("root validation refuses both the real home and its parent", async () => {
  const f = await rootFixture();
  const alias = join(f.root, "home-alias");
  await symlink(f.home, alias, "dir");
  for (const home of [f.home, alias]) {
    for (const root of [f.home, f.homeParent]) {
      await expect(validateDocRoot(root, home, f.state)).rejects.toThrow(
        /^docRoots cannot be the home folder or hold it$/,
      );
    }
  }
});

test("root validation refuses both directions of containment with the real state folder", async () => {
  const f = await rootFixture();
  const child = join(f.state, "nested");
  await mkdir(child);
  const alias = join(f.root, "state-alias");
  await symlink(f.state, alias, "dir");
  for (const state of [f.state, alias]) {
    for (const root of [f.state, f.stateParent, child]) {
      await expect(validateDocRoot(root, f.home, state)).rejects.toThrow(
        /^docRoots cannot hold or sit inside emend's state folder$/,
      );
    }
  }
});

test.each([false, true])("a custom state below a doc root is refused (exists: %s)", async (exists) => {
  const f = await rootFixture();
  const state = join(f.docs, "state");
  if (exists) await mkdir(state);
  await expect(validateDocRoot(f.docs, f.home, state)).rejects.toThrow(
    /^docRoots cannot hold or sit inside emend's state folder$/,
  );
});

test("a missing state folder resolves through a symlinked parent", async () => {
  const f = await rootFixture();
  const target = join(f.root, "dot");
  await mkdir(join(target, "share"), { recursive: true });
  const link = join(f.root, "linked");
  await symlink(target, link, "dir");
  const state = join(link, "share", "emend");
  await expect(validateDocRoot(target, f.home, state)).rejects.toThrow(
    /^docRoots cannot hold or sit inside emend's state folder$/,
  );
  await expect(validateDocRoot(f.docs, f.home, state)).resolves.toBeUndefined();
});

test("a missing home folder does not fail as a raw error", async () => {
  const f = await rootFixture();
  const home = join(f.root, "no-home", "reviewer");
  await expect(validateDocRoot(f.docs, home, f.state)).resolves.toBeUndefined();
  await expect(validateDocRoot(join(f.root, "no-home"), home, f.state)).rejects.toThrow(
    /^docRoots cannot be the home folder or hold it$/,
  );
});

test("root validation permits home/docs and sibling names that merely share a path prefix", async () => {
  const f = await rootFixture();
  for (const root of [f.docs, `${f.home}-docs`, `${f.state}-docs`]) {
    if (root !== f.docs) await mkdir(root);
    await expect(validateDocRoot(root, f.home, f.state)).resolves.toBeUndefined();
  }
});

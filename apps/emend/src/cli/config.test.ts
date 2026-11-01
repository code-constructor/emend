import { appendFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { expect, onTestFinished, test, vi } from "vitest";
import { StateFolderWriteError } from "../state/files.ts";
import { readConfig } from "./config.ts";
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

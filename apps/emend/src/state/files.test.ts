import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { StateDirModeError, writeSecretFile } from "./files.ts";

const writes = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync(fd: number) {
      writes.push(fs.fstatSync(fd).isDirectory() ? "sync directory" : "sync file");
      fs.fsyncSync(fd);
    },
    renameSync(from: string, to: string) {
      writes.push("rename");
      fs.renameSync(from, to);
    },
  };
});

test("secret writes create private parents, replace files and tighten existing permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-files-"));
  const parent = join(dir, "state", "nested");
  const file = join(parent, "secret");
  try {
    await writeSecretFile(file, "synthetic first", join(dir, "state"));
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "state"))).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await chmod(parent, 0o755);
    await chmod(file, 0o644);
    await writeSecretFile(file, new TextEncoder().encode("synthetic replacement"), join(dir, "state"));
    expect(await readFile(file, "utf8")).toBe("synthetic replacement");
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(parent)).toEqual(["secret"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an existing public state directory is refused without chmodding it or its ancestors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-state-mode-"));
  const state = join(dir, "state");
  try {
    await chmod(dir, 0o755);
    await mkdir(state, { mode: 0o755 });
    await chmod(state, 0o755);
    expect(() => writeSecretFile(join(state, "secret"), "synthetic")).toThrow(StateDirModeError);
    expect(() => writeSecretFile(join(state, "secret"), "synthetic")).toThrow(`chmod 700 '${state}'`);
    expect((await stat(state)).mode & 0o777).toBe(0o755);
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    await writeSecretFile(join(dir, "new", "private", "secret"), "synthetic");
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    expect((await stat(join(dir, "new"))).mode & 0o777).toBe(0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secret replacement fsyncs the file before rename and the directory afterward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-durable-write-"));
  try {
    writes.length = 0;
    writeSecretFile(join(dir, "secret"), "synthetic");
    expect(writes).toEqual(["sync file", "rename", "sync directory"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

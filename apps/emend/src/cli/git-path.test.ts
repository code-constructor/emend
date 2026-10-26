import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
test.each(["", "bin"])("git ignores the %j PATH entry", async (entry) => {
  const root = await mkdtemp(join(tmpdir(), "emend-git-path-"));
  try {
    const folder = join(root, entry);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "git"), "#!/bin/sh\nprintf executed > marker\nprintf 'git version 0.0.0\\n'\n");
    await chmod(join(folder, "git"), 0o755);
    vi.stubEnv("PATH", `${entry}:${process.env.PATH}`);
    vi.resetModules();
    const { git } = await import("./git.ts");
    expect((await git(root, ["--version"])).toString()).toMatch(/^git version /);
    await expect(access(join(root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("missing absolute git has a fixed error", async () => {
  vi.stubEnv("PATH", ":relative");
  vi.resetModules();
  const { git } = await import("./git.ts");
  await expect(git("/tmp", ["--version"])).rejects.toThrow("git was not found on PATH");
});

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ensureServer } from "../server-client.ts";
import { publishCommand } from "./publish.ts";

vi.mock("../server-client.ts", () => ({
  ensureServer: vi.fn(async () => {
    throw new Error("server startup reached");
  }),
}));
vi.mock("../git.ts", async (original) => ({
  ...(await original<typeof import("../git.ts")>()),
  createGitSession: () => async (cwd: string, call: string[]) =>
    Buffer.from(
      call[0] === "config"
        ? "https://example.test/synthetic.git"
        : call[1] === "--abbrev-ref"
          ? "main"
          : call[1] === "--git-common-dir"
            ? join(cwd, ".git")
            : cwd,
    ),
}));
vi.mock("../publish/collect.ts", () => ({ collectChanges: async () => [] }));

test("an unchanged listed diff or invalid source starts no server, even without instance state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-startup-"));
  const manifest = join(dir, "manifest.json");
  const io = { stdout: vi.fn(), stderr: vi.fn(), env: { EMEND_HOME: dir } };
  const common = {
    version: 1,
    title: "Synthetic",
    topics: [],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  };
  try {
    await mkdir(join(dir, ".git"));
    vi.mocked(ensureServer).mockClear();
    await writeFile(
      manifest,
      JSON.stringify({
        ...common,
        base: "a".repeat(40),
        head: "worktree",
        files: [{ path: "unchanged.ts", role: "diff" }],
      }),
    );
    await expect(publishCommand(dir, ["--manifest", manifest], io, dir)).rejects.toThrow("not changed in");
    await writeFile(manifest, JSON.stringify({ ...common, files: [{ path: "missing.md", role: "doc" }] }));
    await expect(publishCommand(dir, ["--manifest", manifest, "--key", "plan"], io, dir)).rejects.toThrow();
    expect(ensureServer).not.toHaveBeenCalled();
    await writeFile(join(dir, "plan.md"), "# Valid");
    await writeFile(manifest, JSON.stringify({ ...common, files: [{ path: "plan.md", role: "doc" }] }));
    await expect(publishCommand(dir, ["--manifest", manifest, "--key", "plan"], io, dir)).rejects.toThrow(
      "server startup reached",
    );
    expect(ensureServer).toHaveBeenCalledOnce();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([".git/config", "alias/config"])("manifest read %s cannot expose Git metadata", async (path) => {
  const dir = await mkdtemp(join(tmpdir(), "emend-manifest-git-"));
  try {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git/config"), "synthetic metadata");
    await symlink(".git", join(dir, "alias"));
    vi.mocked(ensureServer).mockClear();
    await expect(
      publishCommand(
        dir,
        ["--manifest", join(dir, path), "--key", "docs"],
        {
          stdout: vi.fn(),
          stderr: vi.fn(),
          env: { EMEND_HOME: dir },
        },
        dir,
      ),
    ).rejects.toThrow("refusing to read inside the git folder:");
    expect(ensureServer).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

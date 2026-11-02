import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, type PublishManifest } from "@emend/contract";
import { expect, test, vi } from "vitest";
import { resolvePublish } from "./resolve.ts";

const { mkdir, mkdtemp, rm, symlink, truncate, writeFile } = fs;

// Expose configurable exports so the realpath spy can replace the built-in function.
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

vi.mock("../git.ts", async (original) => ({
  ...(await original<typeof import("../git.ts")>()),
  createGitSession: () => async (cwd: string, call: string[]) =>
    Buffer.from(`${call[1] === "--git-common-dir" ? join(cwd, ".git") : cwd}\n`),
}));

const manifest = (source?: string): PublishManifest => ({
  version: 1,
  title: "Synthetic",
  topics: [],
  files: [{ path: "plan.md", role: "doc", ...(source ? { source } : {}) }],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
});
test("doc sources resolve only inside the worktree or configured real doc roots", async () => {
  const dir = await fs.realpath(await mkdtemp(join(tmpdir(), "emend-docs-")));
  try {
    const root = join(dir, "repo");
    const state = join(dir, "state");
    const docs = join(dir, "docs");
    for (const folder of [root, state, docs]) await mkdir(folder);
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "plan.md"), "local doc");
    await writeFile(join(docs, "plan.md"), "external doc");
    const collect = (source?: string) =>
      resolvePublish(manifest(source), { manifest: "synthetic", key: "plan" }, state, "instance", root, () => {});
    expect((await [...(await collect()).blobs.values()][0]?.read())?.toString()).toBe("local doc");
    await writeFile(join(state, "config.json"), JSON.stringify({ openBrowser: true }));
    expect((await [...(await collect()).blobs.values()][0]?.read())?.toString()).toBe("local doc");
    await expect(collect(join(docs, "plan.md"))).rejects.toThrow("outside the allowed doc roots");
    await symlink(join(docs, "plan.md"), join(root, "escape.md"));
    await expect(collect("escape.md")).rejects.toThrow("outside the allowed doc roots");
    await writeFile(join(root, "config.json"), JSON.stringify({ docRoots: [docs] }));
    await expect(collect("escape.md")).rejects.toThrow("outside the allowed doc roots");
    await writeFile(join(state, "config.json"), JSON.stringify({ docRoots: [docs] }));
    expect((await [...(await collect("escape.md")).blobs.values()][0]?.read())?.toString()).toBe("external doc");
    await writeFile(join(state, "config.json"), JSON.stringify({ docRoots: [docs], openBrowser: true }));
    expect((await [...(await collect("escape.md")).blobs.values()][0]?.read())?.toString()).toBe("external doc");
    await writeFile(join(state, "config.json"), JSON.stringify({ docRoots: [docs], openBrowser: "true" }));
    await expect(collect("escape.md")).rejects.toThrow("invalid emend configuration");
    await writeFile(join(state, "config.json"), JSON.stringify({ docRoots: [docs] }));
    await truncate(join(docs, "plan.md"), LIMITS.markdownDocBytes + 1);
    await expect(collect("escape.md")).rejects.toThrow("size limit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("HTML and each asset and their cumulative bytes have pre-read limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-limits-"));
  try {
    await mkdir(join(dir, ".git"));
    const input = { ...manifest(), files: [{ path: "plan.html", role: "doc" as const }] };
    const collect = () => resolvePublish(input, { manifest: "synthetic", key: "plan" }, dir, "instance", dir, () => {});
    await writeFile(join(dir, "plan.html"), '<img src="a.png"><img src="b.png"><img src="c.png">');
    for (const name of ["a.png", "b.png", "c.png"]) {
      await writeFile(join(dir, name), "");
      await truncate(join(dir, name), LIMITS.assetBytes);
    }
    await expect(collect()).rejects.toThrow("HTML doc and assets exceed");
    await truncate(join(dir, "a.png"), LIMITS.assetBytes + 1);
    await expect(collect()).rejects.toThrow("asset exceeds");
    await truncate(join(dir, "plan.html"), LIMITS.htmlDocBytes + 1);
    await expect(collect()).rejects.toThrow("size limit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTML docs sharing an asset publish it once under its first parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-shared-assets-"));
  try {
    await mkdir(join(dir, ".git"));
    for (const path of ["one.html", "two.html"])
      await writeFile(join(dir, path), '<link href="style.css" rel="stylesheet">');
    await writeFile(join(dir, "style.css"), "body { color: black }");
    const result = await resolvePublish(
      {
        ...manifest(),
        files: [
          { path: "one.html", role: "doc" },
          { path: "two.html", role: "doc" },
        ],
      },
      { manifest: "synthetic", key: "plan" },
      dir,
      "instance",
      dir,
      () => {},
    );
    expect(result.request.files.filter((f) => f.role === "asset")).toMatchObject([
      { path: "style.css", parent: "one.html" },
    ]);
    expect(result.request.files.filter((f) => f.role === "doc").map((f) => f.assets)).toEqual([
      ["style.css"],
      ["style.css"],
    ]);
    expect(result.blobs.size).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["data", "first.html"])(
  "HTML doc and assets share the checked first resolution when an alias swaps from %s",
  async (name) => {
    const root = await mkdtemp(join(tmpdir(), "emend-doc-asset-swap-"));
    const realpath = fs.realpath;
    const probe = vi.spyOn(fs, "realpath");
    try {
      await mkdir(join(root, ".git"));
      await mkdir(join(root, ".private"));
      await writeFile(join(root, ".private", name), '<script src="first.js"></script>');
      await writeFile(join(root, ".private", "first.js"), "Synthetic first doc asset");
      const wrongContent = "Synthetic content from the wrong folder";
      await writeFile(join(root, ".private", "secret.js"), wrongContent);
      await writeFile(join(root, "real.html"), '<script src="secret.js"></script>');
      await writeFile(join(root, "secret.js"), "Synthetic second doc asset");
      const alias = join(root, "notes.html");
      await symlink(`.private/${name}`, alias);
      let resolutions = 0;
      probe.mockImplementation(async (path, ...args) => {
        const actual = await realpath(path, ...args);
        if (String(path) === alias) {
          await rm(alias);
          await symlink(++resolutions % 2 ? "real.html" : `.private/${name}`, alias);
        }
        return actual;
      });
      const publishing = resolvePublish(
        { ...manifest(), files: [{ path: "notes.html", role: "doc" }] },
        { manifest: "synthetic", key: "docs" },
        root,
        "instance",
        root,
        () => {},
      );
      if (name === "data") {
        await expect(publishing).rejects.toThrow(
          "doc source must end in .md, .markdown, .html or .htm, like its path.",
        );
      } else {
        const result = await publishing;
        expect(result.blobs.has(createHash("sha256").update(wrongContent).digest("hex"))).toBe(false);
        expect(result.request.files.map((file) => file.path)).toEqual(["notes.html", "first.js"]);
        const asset = result.request.files.find((file) => file.role === "asset");
        expect((await result.blobs.get(asset?.newBlob ?? "")?.read())?.toString()).toBe("Synthetic first doc asset");
      }
      expect(resolutions).toBe(1);
    } finally {
      probe.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([".git/config", ".GIT./config", ".g\u206ait/config", "link/config", "leaf.md"])(
  "doc source %j cannot expose Git metadata",
  async (source) => {
    const root = await mkdtemp(join(tmpdir(), "emend-doc-git-"));
    try {
      await mkdir(join(root, ".git"));
      await writeFile(join(root, ".git/config"), "synthetic metadata");
      await symlink(".git", join(root, "link"));
      await symlink(".git/config", join(root, "leaf.md"));
      await expect(
        resolvePublish(manifest(source), { manifest: "synthetic", key: "docs" }, root, "instance", root, () => {}),
      ).rejects.toThrow("refusing to read inside the git folder:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("doc upload rereads recheck aliases for Git metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "emend-doc-reread-"));
  try {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git/config"), "synthetic metadata");
    await writeFile(join(root, "safe.md"), "synthetic doc");
    await symlink("safe.md", join(root, "alias.md"));
    const resolved = await resolvePublish(
      manifest("alias.md"),
      { manifest: "synthetic", key: "docs" },
      root,
      "instance",
      root,
      () => {},
    );
    await rm(join(root, "alias.md"));
    await symlink(".git/config", join(root, "alias.md"));
    await expect([...resolved.blobs.values()][0]?.read()).rejects.toThrow("refusing to read inside the git folder:");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["nested worktree repo", "docRoot repo"])(
  "doc aliases cannot publish metadata from a %s, including upload rereads",
  async (location) => {
    const dir = await fs.realpath(await mkdtemp(join(tmpdir(), "emend-doc-nested-git-")));
    try {
      const root = join(dir, "repo");
      const state = join(dir, "state");
      const nested = location === "docRoot repo" ? join(dir, "external") : join(root, "vendor/lib");
      await mkdir(join(root, "docs"), { recursive: true });
      await mkdir(state);
      await mkdir(join(root, ".git"));
      await promisify(execFile)("git", ["init", nested]);
      await writeFile(join(state, "config.json"), JSON.stringify({ docRoots: [nested] }));
      await writeFile(join(root, "docs/safe.md"), "synthetic doc");
      const alias = join(root, "docs/n.md");
      await symlink("safe.md", alias);
      const collect = () =>
        resolvePublish(
          manifest("docs/n.md"),
          { manifest: "synthetic", key: "docs" },
          state,
          "instance",
          root,
          () => {},
        );
      const resolved = await collect();
      await rm(alias);
      await symlink(location === "docRoot repo" ? join(nested, ".git/config") : "../vendor/lib/.git/config", alias);
      await expect(collect()).rejects.toThrow(`refusing to read inside the git folder: ${nested}/.git/config`);
      await expect([...resolved.blobs.values()][0]?.read()).rejects.toThrow(
        `refusing to read inside the git folder: ${nested}/.git/config`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("HTML asset reads and upload rereads refuse a leaf alias into the Git folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "emend-asset-git-"));
  try {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git/config"), "synthetic metadata");
    await writeFile(join(root, "safe.png"), "synthetic image");
    await symlink("safe.png", join(root, "asset.png"));
    await writeFile(join(root, "plan.html"), '<img src="asset.png">');
    const collect = () =>
      resolvePublish(
        { ...manifest(), files: [{ path: "plan.html", role: "doc" }] },
        { manifest: "synthetic", key: "docs" },
        root,
        "instance",
        root,
        () => {},
      );
    const result = await collect();
    const hash = result.request.files.find((file) => file.role === "asset")?.newBlob;
    await rm(join(root, "asset.png"));
    await symlink(".git/config", join(root, "asset.png"));
    await expect(result.blobs.get(hash ?? "")?.read()).rejects.toThrow("refusing to read inside the git folder:");
    await expect(collect()).rejects.toThrow("refusing to read inside the git folder:");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

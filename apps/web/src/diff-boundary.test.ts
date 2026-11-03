// @vitest-environment node
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("only diff adapter modules and the parse worker import the diff library; route is lazy", async () => {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter(
    (path) => /\.tsx?$/.test(path) && !path.includes(".test."),
  );
  const importers: string[] = [];
  for (const path of files)
    if ((await readFile(`${root}${path}`, "utf8")).includes("@pierre/diffs")) importers.push(path);
  expect(importers.sort()).toEqual([
    "components/diff/FileDiff.tsx",
    "components/diff/GutterComment.tsx",
    "components/diff/parse.worker.ts",
    "components/diff/theme.ts",
  ]);
  expect(await readFile(`${root}components/diff/LazyDiffPane.tsx`, "utf8")).toContain('() => import("./DiffPane.tsx")');
  expect(await readFile(`${root}components/diff/LazyDiffPane.tsx`, "utf8")).toContain("lazy(load)");
});

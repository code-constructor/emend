import { type LinesTarget, Placement } from "@emend/contract";
import { expect, test } from "vitest";
import { renderDoc, renderMarkdown } from "../render/markdown.ts";
import { type PlaceContext, placeThread } from "./place.ts";
import { makeSpan } from "./span.ts";

function context(): PlaceContext {
  return { writeup: [], docs: new Map(), files: new Map(), renamedFrom: new Map(), topics: new Set(), last: null };
}

test("an unreadable HTML document leaves its spans unplaced", () => {
  const ctx = context();
  ctx.docs.set("docs/seed.html", { kind: "html", text: null });
  expect(
    placeThread({ kind: "html-span", path: "docs/seed.html", quote: "seed", prefix: "", suffix: "" }, ctx),
  ).toEqual({ status: "unplaced", reason: "block-gone" });
});

test("review is always placed and topic slugs must still exist", () => {
  const ctx = context();
  ctx.topics.add("new-garden");
  expect(placeThread({ kind: "review" }, ctx)).toEqual({ status: "placed", location: { kind: "review" } });
  expect(placeThread({ kind: "topic", slug: "new-garden" }, ctx)).toEqual({
    status: "placed",
    location: { kind: "topic", slug: "new-garden" },
  });
  expect(placeThread({ kind: "topic", slug: "old-garden" }, ctx)).toEqual({ status: "unplaced", reason: "topic-gone" });
});

test("files use their latest placed path across successive renames and handle deletion", () => {
  const ctx = context();
  const target = { kind: "file" as const, path: "src/seed.ts" };
  ctx.files.set("src/plant.ts", {});
  ctx.renamedFrom.set(target.path, "src/plant.ts");
  const first = placeThread(target, ctx);
  expect(first).toEqual({ status: "placed", location: { kind: "file", path: "src/plant.ts" } });
  if (first.status !== "placed") throw new Error("Expected placement");
  ctx.last = { location: first.location };
  ctx.renamedFrom = new Map([["src/plant.ts", "src/grow.ts"]]);
  ctx.files = new Map([["src/grow.ts", {}]]);
  expect(placeThread(target, ctx)).toEqual({ status: "placed", location: { kind: "file", path: "src/grow.ts" } });
  ctx.files.clear();
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "file-gone" });
});

test("explicit renames win over a newly created file at the original path", () => {
  const ctx = context();
  ctx.files = new Map([
    ["src/seed.ts", {}],
    ["src/grow.ts", {}],
  ]);
  ctx.renamedFrom.set("src/seed.ts", "src/grow.ts");
  expect(placeThread({ kind: "file", path: "src/seed.ts" }, ctx)).toEqual({
    status: "placed",
    location: { kind: "file", path: "src/grow.ts" },
  });
});

test("Markdown spans stay within their document even if identical text exists elsewhere", async () => {
  const [block] = await renderDoc("Sprout keeps seeds.", "docs/seeds.md");
  if (!block) throw new Error("Missing block");
  const target = { kind: "doc-span" as const, path: "docs/seeds.md", ...makeSpan(block, 0, 6) };
  const ctx = context();
  ctx.writeup = [block];
  ctx.docs.set("docs/other.md", { kind: "markdown", blocks: [block] });
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "file-gone" });
  ctx.docs.set(target.path, { kind: "markdown", blocks: [] });
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "block-gone" });
});

test("writeup spans never search document blocks", async () => {
  const [block] = await renderMarkdown("Sprout keeps seeds.", "overview");
  if (!block) throw new Error("Missing block");
  const ctx = context();
  ctx.docs.set("docs/seeds.md", { kind: "markdown", blocks: [block] });
  expect(placeThread({ kind: "writeup-span", ...makeSpan(block, 0, 6) }, ctx)).toEqual({
    status: "unplaced",
    reason: "block-gone",
  });
});

test("follows renamed Markdown and HTML documents without crossing formats", async () => {
  const [block] = await renderDoc("Sprout keeps seeds.", "docs/seeds.md");
  if (!block) throw new Error("Missing block");
  const ctx = context();
  ctx.renamedFrom.set("docs/seeds.md", "docs/grow.md");
  ctx.docs.set("docs/grow.md", { kind: "markdown", blocks: await renderDoc("Sprout keeps seeds.", "docs/grow.md") });
  const target = { kind: "doc-span" as const, path: "docs/seeds.md", ...makeSpan(block, 0, 6) };
  const result = placeThread(target, ctx);
  expect(result).toMatchObject({
    status: "placed",
    location: { kind: "doc-span", path: "docs/grow.md", start: 0, end: 6 },
  });
  expect(Placement.safeParse(result).success).toBe(true);
  ctx.docs.set("docs/grow.md", { kind: "html", text: "Sprout keeps seeds." });
  expect(placeThread(target, ctx)).toEqual({ status: "unplaced", reason: "block-gone" });
  const htmlTarget = {
    kind: "html-span" as const,
    path: "docs/seeds.md",
    quote: "Sprout",
    prefix: "",
    suffix: " keeps seeds.",
  };
  expect(placeThread(htmlTarget, ctx)).toEqual({
    status: "placed",
    location: { kind: "html-span", path: "docs/grow.md", start: 0, end: 6 },
  });
  ctx.docs.clear();
  expect(placeThread(htmlTarget, ctx)).toEqual({ status: "unplaced", reason: "file-gone" });
});

test("uses the latest placed block identity when an older original block reappears", async () => {
  const [original] = await renderMarkdown("Sprout keeps seeds.", "overview");
  const [moved] = await renderMarkdown("Sprout keeps seeds.", "t-garden-body");
  if (!original || !moved) throw new Error("Missing blocks");
  const ctx = context();
  ctx.writeup = [original, moved];
  ctx.last = { location: { kind: "writeup-span", blockId: moved.id, start: 0, end: 6 } };
  expect(placeThread({ kind: "writeup-span", ...makeSpan(original, 0, 6) }, ctx)).toEqual({
    status: "placed",
    location: { kind: "writeup-span", blockId: moved.id, start: 0, end: 6 },
  });
});

test("uses the latest line range and sides, and keeps the original target immutable", () => {
  const target: LinesTarget = {
    kind: "lines",
    path: "src/seed.ts",
    side: "old",
    start: 1,
    end: 1,
    lines: ["seed"],
    before: [],
    after: [],
  };
  const ctx = context();
  ctx.last = {
    location: { kind: "lines", path: "src/grow.ts", side: "old", start: 3, end: 3 },
    sides: { oldText: "one\ntwo\nseed\n" },
  };
  ctx.files.set("src/grow.ts", { oldText: "zero\none\ntwo\nseed\n", newText: "seed\n" });
  expect(placeThread(target, ctx)).toEqual({
    status: "placed",
    location: { kind: "lines", path: "src/grow.ts", side: "old", start: 4, end: 4 },
  });
  expect(target.path).toBe("src/seed.ts");
  expect(target.start).toBe(1);
  ctx.last = null;
  ctx.files.set(target.path, { oldText: "seed\n" });
  expect(placeThread(target, ctx)).toMatchObject({
    status: "placed",
    location: { path: target.path, start: 1, end: 1 },
  });
});

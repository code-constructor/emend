import { BlockId } from "@emend/contract";
import { expect, test } from "vitest";
import { blockText } from "./blocks.ts";
import { topics, writeup } from "./fixtures/writeup.ts";
import { renderWriteup } from "./writeup.ts";

test("renders sections and labels in importance order with stable ties", async () => {
  const rendered = await renderWriteup(writeup, topics);
  expect(rendered.sections.map((section) => section.key)).toEqual([
    "overview",
    "tldr",
    "decisions",
    "glossary",
    "t-search-why",
    "t-search-example",
    "t-search-body",
    "t-sorting-why",
    "t-labels-why",
    "t-labels-body",
  ]);
  expect(rendered.sections.map((section) => section.label)).toEqual([
    "Overview",
    "TL;DR",
    "Decisions and drift",
    "Glossary",
    "Shelf search — Why",
    "Shelf search — Example",
    "Shelf search — Details",
    "Stable sorting — Why",
    "Clear labels — Why",
    "Clear labels — Details",
  ]);
  expect(rendered.sections.map((section) => section.topic)).toEqual([
    null,
    null,
    null,
    null,
    "search",
    "search",
    "search",
    "sorting",
    "labels",
    "labels",
  ]);
  expect(topics.map((topic) => topic.slug)).toEqual(["labels", "search", "sorting"]);
  for (const section of rendered.sections) {
    for (const block of section.blocks) {
      expect(block.section).toBe(section.key);
      expect(BlockId.safeParse(block.id).success).toBe(true);
    }
  }
});

test("blockText equals text for HTML blocks, explicitly skipping diagram blocks", async () => {
  const rendered = await renderWriteup(
    { ...writeup, overview: `${writeup.overview}\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`` },
    topics,
  );
  const blocks = rendered.sections.flatMap((section) => section.blocks);
  expect(blocks.filter((block) => block.kind === "diagram")).toHaveLength(1);
  for (const block of blocks) {
    if (block.kind === "diagram") continue;
    expect(blockText(block.html)).toBe(block.text);
  }
});

test("null decisions produce the exact required paragraph", async () => {
  const rendered = await renderWriteup(writeup, topics);
  const blocks = rendered.sections.find((section) => section.key === "decisions")?.blocks;
  expect(blocks).toHaveLength(1);
  expect(blocks?.[0]).toMatchObject({
    kind: "paragraph",
    text: "Decisions and drift: not written. Only the session where the change was asked for can tell what drifted from it.",
  });
});

test("omits missing optional sections but preserves explicitly empty sections", async () => {
  const rendered = await renderWriteup({ overview: "", tldr: "", decisions: "", topics: {} }, topics);
  expect(rendered.sections.map((section) => section.key)).toEqual(["overview", "tldr", "decisions"]);
  expect(rendered.sections.every((section) => section.blocks.length === 0)).toBe(true);
});

test("sanitizes raw glossary HTML through the same pipeline", async () => {
  const rendered = await renderWriteup(
    {
      ...writeup,
      glossary:
        '<div onclick="bad()" style="position:fixed" class="thread-card" id="glossary" data-foo="x"><script>bad()</script><iframe src="https://example.com"></iframe><svg onload="bad()"></svg><a href="javascript:bad()">Term</a><img src=x onerror="bad()"></div>',
    },
    topics,
  );
  const blocks = rendered.sections.find((section) => section.key === "glossary")?.blocks ?? [];
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    expect(block.html).not.toMatch(
      /<(script|style|iframe|object|embed|form|svg)|\s(on\w+|style|data-[\w-]+)=|javascript:|data:|vbscript:/i,
    );
    expect(block.text).toBe("Term");
    expect(block.html).toContain("user-content-thread-card");
    expect(block.html).toContain('id="user-content-glossary"');
  }
});

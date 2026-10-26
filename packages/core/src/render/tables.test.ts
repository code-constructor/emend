import { expect, test } from "vitest";
import { renderMarkdown } from "./markdown.ts";

test("a narrow source with an enormous rectangular table stays a bounded code block", async () => {
  await renderMarkdown("warmup", "overview");
  const source = `${"|x".repeat(1000)}|\n${"|-".repeat(1000)}|\n${"x\n".repeat(30000)}`;
  const start = Date.now();
  const blocks = await renderMarkdown(source, "overview");
  expect(Date.now() - start).toBeLessThan(1000);
  const output = JSON.stringify(blocks);
  expect(output).not.toContain("<table");
  expect(output).toContain("<pre");
  expect(output.length).toBeLessThan(source.length * 6);
});

test("ordinary tables keep their semantics and oversized source stays escaped", async () => {
  const small = await renderMarkdown("| a | b |\n| - | - |\n| x | y |", "overview");
  expect(JSON.stringify(small)).toContain("<table>");
  const source = `${"|<script>evil()</script>".repeat(1000)}|\n${"|-".repeat(1000)}|\n${"x\n".repeat(101)}`;
  const blocks = await renderMarkdown(source, "overview");
  const html = blocks.map((block) => block.html).join("");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&#x3C;script>");
});

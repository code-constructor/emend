import { describe, expect, test } from "vitest";
import { PublishManifest, WriteupInput } from "./index.ts";

const topic = { slug: "routing", title: "Routing", importance: 20, summary: "Simplify route lookup." };
const manifest = {
  version: 1,
  title: "Review the sample router",
  topics: [topic],
  files: [{ path: "src/router.ts", role: "diff", topic: "routing" }],
  writeup: {
    overview: "A small router.",
    tldr: "Fewer branches.",
    decisions: null,
    topics: { routing: { why: "Clarity." } },
  },
};

describe("publish manifest", () => {
  test("accepts docs-only and resolved commit or worktree ranges", () => {
    expect(
      PublishManifest.parse({ ...manifest, files: [{ path: "docs/plan.md", role: "doc", source: "drafts/plan.md" }] }),
    ).toBeDefined();
    for (const head of ["worktree", "b".repeat(40), "c".repeat(64)]) {
      expect(PublishManifest.safeParse({ ...manifest, base: "a".repeat(40), head }).success).toBe(true);
    }
  });

  test.each([{ base: "a".repeat(40) }, { head: "worktree" }])("requires base and head together: %j", (range) => {
    expect(PublishManifest.safeParse({ ...manifest, ...range }).success).toBe(false);
  });

  test.each([
    { version: 2 },
    { title: "" },
    { title: "x".repeat(201) },
    { base: "main", head: "worktree" },
    { base: `${"a".repeat(40)}\n`, head: "worktree" },
    { base: "a".repeat(40), head: "HEAD" },
    { files: [{ path: "a.ts", role: "asset" }] },
    { files: [{ path: "a.ts", role: "diff", topic: "missing" }] },
    { topics: [topic, topic] },
    { files: [manifest.files[0], manifest.files[0]] },
    { writeup: { ...manifest.writeup, topics: { missing: { why: "Unlisted." } } } },
  ])("rejects an invalid manifest: %j", (change) => {
    expect(PublishManifest.safeParse({ ...manifest, ...change }).success).toBe(false);
  });

  test.each([
    { slug: "Other Stuff" },
    { slug: "routing\n" },
    { slug: "a".repeat(65) },
    { importance: 101 },
    { importance: -1 },
    { door: "three-way" },
    { blastRadius: { scope: "two words", note: "A note." } },
    { blastRadius: { scope: "module\n", note: "A note." } },
    { blastRadius: { scope: "module", note: "  " } },
  ])("rejects invalid topic metadata: %j", (change) => {
    expect(PublishManifest.safeParse({ ...manifest, topics: [{ ...topic, ...change }] }).success).toBe(false);
  });

  test("reserves the fallback topic slug with the specified error", () => {
    const result = PublishManifest.safeParse({
      ...manifest,
      topics: [{ ...topic, slug: "other" }],
      files: [],
      writeup: { ...manifest.writeup, topics: {} },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message)).toContain("topic slug other is reserved");
  });

  test("accepts the exact title and file-count limits and refuses one extra file", () => {
    const files = Array.from({ length: 10000 }, (_, i) => ({ path: `src/file-${i}.ts`, role: "diff" }));
    expect(PublishManifest.safeParse({ ...manifest, title: "x".repeat(200), files }).success).toBe(true);
    expect(
      PublishManifest.safeParse({ ...manifest, files: [...files, { path: "extra.ts", role: "diff" }] }).success,
    ).toBe(false);
  });

  test("strips unknown keys throughout the manifest without altering Markdown", () => {
    const parsed = PublishManifest.parse({
      ...manifest,
      owner_id: "untrusted",
      topics: [{ ...topic, extra: true }],
      files: [{ ...manifest.files[0], extra: true }],
      writeup: { ...manifest.writeup, extra: true, topics: { routing: { why: "  **Clarity.**\n", extra: true } } },
    });
    expect(parsed).not.toHaveProperty("owner_id");
    expect(parsed.topics[0]).not.toHaveProperty("extra");
    expect(parsed.files[0]).not.toHaveProperty("extra");
    expect(parsed.writeup).not.toHaveProperty("extra");
    expect(parsed.writeup.topics.routing).toEqual({ why: "  **Clarity.**\n" });
  });

  test("requires decisions to be a string or null and validates writeup topic keys", () => {
    expect(WriteupInput.safeParse({ overview: "", tldr: "", topics: {} }).success).toBe(false);
    expect(WriteupInput.safeParse({ ...manifest.writeup, topics: { "Other Stuff": { why: "" } } }).success).toBe(false);
    expect(
      WriteupInput.safeParse({
        ...manifest.writeup,
        decisions: "Keep the public interface.",
        glossary: "Router: selects a handler.",
      }).success,
    ).toBe(true);
  });
});

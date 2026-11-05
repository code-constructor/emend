import { expect, test } from "vitest";
import { LIMITS, PublishManifest, PublishRequest, RevisionView } from "./index.ts";

const manifest = {
  version: 1,
  title: "Review",
  topics: [],
  files: [{ path: "doc.md", role: "doc", title: "Named" }],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
};
test("manifest and wire preserve optional bounded nonblank doc titles", () => {
  expect(PublishManifest.parse(manifest).files[0]?.title).toBe("Named");
  for (const title of ["", "  ", "a".repeat(LIMITS.titleChars + 1)])
    expect(PublishManifest.safeParse({ ...manifest, files: [{ ...manifest.files[0], title }] }).success).toBe(false);
  expect(
    PublishManifest.parse({ ...manifest, files: [{ ...manifest.files[0], title: "\u200b" }] }).files[0]?.title,
  ).toBe("\u200b");
  expect(
    PublishRequest.shape.files.element.parse({
      path: "doc.md",
      role: "doc",
      title: "Named",
      oldPath: null,
      oldBlob: null,
      newBlob: "a".repeat(64),
      flag: null,
    }).title,
  ).toBe("Named");
});
test("doc view metadata is additive and bounded", () => {
  const doc = { path: "doc.md", kind: "markdown", blocks: [] };
  const schema = RevisionView.shape.docs;
  expect(schema.parse([doc])).toEqual([doc]);
  const value = { ...doc, title: "Named", headings: [{ level: 2, text: "Section", id: "section" }] };
  expect(schema.parse([value])).toEqual([value]);
  expect(schema.safeParse([{ ...value, headings: [{ level: 1, text: "No" }] }]).success).toBe(false);
  expect(
    schema.safeParse([{ ...value, headings: [{ level: 2, text: "x".repeat(LIMITS.headingTextChars + 1) }] }]).success,
  ).toBe(false);
  expect(
    schema.safeParse([{ ...value, headings: Array(LIMITS.headingsPerDoc + 1).fill({ level: 2, text: "x" }) }]).success,
  ).toBe(false);
});

test("heading ids are bounded to 256 characters", () => {
  const doc = {
    path: "doc.md",
    kind: "markdown",
    blocks: [],
    headings: [{ level: 2, text: "X", id: "x".repeat(257) }],
  };
  expect(RevisionView.shape.docs.safeParse([doc]).success).toBe(false);
});

test("only doc files may carry a title", () => {
  expect(PublishManifest.safeParse({ ...manifest, files: [{ path: "a.ts", role: "diff", title: "No" }] }).success).toBe(
    false,
  );
  for (const role of ["diff", "asset"])
    expect(
      PublishRequest.shape.files.element.safeParse({
        path: "a.png",
        role,
        title: "No",
        oldPath: null,
        oldBlob: null,
        newBlob: "a".repeat(64),
        flag: null,
      }).success,
    ).toBe(false);
});

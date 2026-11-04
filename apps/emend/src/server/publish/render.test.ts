import { LIMITS, type PublishRequest } from "@emend/contract";
import { type Block, blockHash, renderMarkdown } from "@emend/core";
import { expect, test, vi } from "vitest";
import { renderRevision } from "./render.ts";
import { executeWork, serializeRendered } from "./work.ts";

const input = (paths: string[]): PublishRequest => ({
  reviewKey: "a".repeat(64),
  repo: null,
  branch: null,
  title: "Synthetic",
  base: null,
  head: null,
  topics: [],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  files: paths.map((path) => ({
    path,
    role: "doc",
    oldPath: null,
    oldBlob: null,
    newBlob: "b".repeat(64),
    flag: null,
  })),
});
test("one shared Markdown render produces exactly each path's normal block identities", async () => {
  const source =
    "# Title\n\nrepeat\n\nrepeat\n\nFoot[^1].\n\n[^1]: note\n\n<script>bad()</script>\n\n[bad](javascript:bad)";
  const stored = new Map<string, Buffer>();
  const execute = vi.fn(executeWork);
  const result = await renderRevision(
    input(["one.md", "two.md"]),
    execute,
    async (hash) => Uint8Array.from(stored.get(hash) ?? Buffer.from(source)).buffer,
    async (bytes) => {
      const key = String(stored.size);
      stored.set(key, bytes);
      return key;
    },
  );
  expect(execute.mock.calls.filter(([work]) => work.kind === "doc")).toHaveLength(1);
  for (const path of ["one.md", "two.md"]) {
    const blob = stored.get(result.docBlobs.get(path) ?? "");
    expect(JSON.parse(blob?.toString() ?? "null")).toEqual(
      await renderMarkdown(source, `doc-${await blockHash(path)}`),
    );
  }
});
test("the block cap counts repeated paths and stops every later Markdown doc", async () => {
  const blocks: Block[] = Array.from({ length: 3000 }, (_, i) => ({
    id: `doc-aaaaaaaa-${i.toString(16).padStart(8, "0")}`,
    section: "doc-aaaaaaaa",
    kind: "paragraph",
    html: "<p>x</p>",
    text: "x",
  }));
  const execute = vi.fn(async (work: Parameters<typeof executeWork>[0]) =>
    work.kind === "doc" ? { kind: "doc" as const, ...serializeRendered(blocks) } : executeWork(work),
  );
  const body = input(Array.from({ length: 40 }, (_, i) => `${i}.md`));
  const result = await renderRevision(
    body,
    execute,
    async () => serializeRendered(blocks).bytes,
    async () => "stored",
  );
  expect(result.count).toBe(99001); // 99,000 doc blocks plus the writeup block.
  expect(result.unrendered).toEqual(body.files.slice(33).map((f) => f.path));
  expect(execute.mock.calls.filter(([work]) => work.kind === "doc")).toHaveLength(1);
});
test("an over-cap writeup fails before any rendered blob is stored", async () => {
  const blocks: Block[] = Array.from({ length: LIMITS.blocksPerRevision + 1 }, () => ({
    id: "overview-aaaaaaaa",
    section: "overview",
    kind: "paragraph",
    html: "x",
    text: "x",
  }));
  const put = vi.fn(async () => "stored");
  await expect(
    renderRevision(
      input([]),
      async () => ({
        kind: "writeup",
        ...serializeRendered({ sections: [{ key: "overview", label: "Overview", topic: null, blocks }] }),
      }),
      async () => new ArrayBuffer(0),
      put,
    ),
  ).rejects.toMatchObject({ code: "too_large", message: "The writeup has too many blocks." });
  expect(put).not.toHaveBeenCalled();
});
test("the writeup renders images that parentless assets declare, and only those", async () => {
  const body = input([]);
  body.writeup.overview = "![Shot](media/a.png) ![Other](media/b.png) ![Doc asset](docs/c.png)";
  const asset = (path: string, newBlob: string, parent?: string) => ({
    path,
    role: "asset" as const,
    oldPath: null,
    oldBlob: null,
    newBlob,
    flag: null,
    ...(parent ? { parent } : {}),
  });
  body.files = [asset("media/a.png", "c".repeat(64)), asset("docs/c.png", "d".repeat(64), "docs/plan.html")];
  const stored: Buffer[] = [];
  await renderRevision(
    body,
    executeWork,
    async () => new ArrayBuffer(0),
    async (bytes) => {
      stored.push(bytes);
      return String(stored.length - 1);
    },
  );
  const rendered = JSON.parse(stored[0]?.toString() ?? "null") as { sections: { blocks: { html: string }[] }[] };
  const html = rendered.sections.flatMap((s) => s.blocks.map((b) => b.html)).join("");
  expect(html).toContain(`src="/api/v1/media/${"c".repeat(64)}"`);
  expect(html).not.toContain("media/b.png");
  expect(html).not.toContain("d".repeat(64));
});
test("a Markdown doc keeps no image source even when the writeup declares that media path", async () => {
  const body = input(["notes.md"]);
  body.writeup.overview = "![Shot](media/a.png)";
  body.files = [
    ...body.files,
    { path: "media/a.png", role: "asset", oldPath: null, oldBlob: null, newBlob: "c".repeat(64), flag: null },
  ];
  const stored: Buffer[] = [];
  const docSource = Buffer.from("See ![x](media/a.png) here");
  const result = await renderRevision(
    body,
    executeWork,
    async () => Uint8Array.from(docSource).buffer,
    async (bytes) => {
      stored.push(bytes);
      return String(stored.length - 1);
    },
  );
  const doc = stored[Number(result.docBlobs.get("notes.md"))]?.toString() ?? "";
  expect(doc).toContain("<img");
  expect(doc).not.toContain("src=");
  expect(doc).not.toContain("/api/v1/media/");
  expect(stored.map((blob) => blob.toString()).join("")).toContain(`src=\\"/api/v1/media/${"c".repeat(64)}\\"`);
});

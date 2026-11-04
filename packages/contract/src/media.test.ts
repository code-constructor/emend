import { describe, expect, test } from "vitest";
import { LIMITS, MEDIA_EXTENSIONS, PublishManifest, PublishRequest } from "./index.ts";

const writeup = { overview: "![Before](media/a.png)", tldr: "Summary", decisions: null, topics: {} };
const manifest = { version: 1, title: "Synthetic review", topics: [], files: [], writeup };
const request = {
  reviewKey: "a".repeat(64),
  repo: null,
  branch: null,
  title: "Synthetic review",
  base: null,
  head: null,
  topics: [],
  writeup,
  files: [],
};
const image = {
  path: "media/a.png",
  oldPath: null,
  role: "asset",
  oldBlob: null,
  newBlob: "c".repeat(64),
  flag: null,
};
const html = {
  path: "docs/plan.html",
  oldPath: null,
  role: "doc",
  assets: [] as string[],
  oldBlob: null,
  newBlob: "b".repeat(64),
  flag: null,
};

describe("manifest media", () => {
  test("allows image extensions only, without SVG", () => {
    expect([...MEDIA_EXTENSIONS].sort()).toEqual(["avif", "gif", "jpeg", "jpg", "png", "webp"]);
    expect(LIMITS.mediaPerRevision).toBe(50);
  });

  test("accepts media with and without a source, in any extension case", () => {
    const media = [{ path: "media/a.png" }, { path: "media/b.JPG", source: "/tmp/shots/b.jpg" }];
    expect(PublishManifest.parse({ ...manifest, media }).media).toEqual(media);
    expect(PublishManifest.parse(manifest).media).toBeUndefined();
  });

  test.each([
    ["an svg", [{ path: "media/a.svg" }]],
    ["no extension", [{ path: "media/a" }]],
    ["a script", [{ path: "media/a.js" }]],
    ["a hidden file", [{ path: "media/.a.png" }]],
    ["a hidden folder", [{ path: ".shots/a.png" }]],
    ["a duplicate path", [{ path: "media/a.png" }, { path: "media/a.png" }]],
    ["a colon", [{ path: "media/a:b.png" }]],
    ["a traversal path", [{ path: "../a.png" }]],
    ["a control character in the source", [{ path: "media/a.png", source: "a\u0000.png" }]],
    ["an empty source", [{ path: "media/a.png", source: "" }]],
  ])("refuses %s", (_name, media) => {
    expect(PublishManifest.safeParse({ ...manifest, media }).success).toBe(false);
  });

  test("refuses a media path that is a doc path", () => {
    const files = [{ path: "media/a.png", role: "doc" }];
    expect(PublishManifest.safeParse({ ...manifest, files, media: [{ path: "media/a.png" }] }).success).toBe(false);
    expect(PublishManifest.safeParse({ ...manifest, files, media: [{ path: "media/b.png" }] }).success).toBe(true);
  });

  test("allows a diff file at the same path as media", () => {
    const files = [{ path: "media/a.png", role: "diff" }];
    expect(PublishManifest.safeParse({ ...manifest, files, media: [{ path: "media/a.png" }] }).success).toBe(true);
  });

  test("caps the count", () => {
    const media = (count: number) => Array.from({ length: count }, (_, i) => ({ path: `media/${i}.png` }));
    expect(PublishManifest.safeParse({ ...manifest, media: media(LIMITS.mediaPerRevision) }).success).toBe(true);
    expect(PublishManifest.safeParse({ ...manifest, media: media(LIMITS.mediaPerRevision + 1) }).success).toBe(false);
  });
});

describe("publish request media", () => {
  test("accepts parentless image assets", () => {
    expect(PublishRequest.safeParse({ ...request, files: [image] }).success).toBe(true);
    expect(PublishRequest.safeParse({ ...request, files: [{ ...image, path: "shots/B.WEBP" }] }).success).toBe(true);
  });

  test("keeps the parent rules for HTML assets", () => {
    const asset = { ...image, path: "docs/a.png", parent: "docs/plan.html" };
    expect(PublishRequest.safeParse({ ...request, files: [{ ...html, assets: ["docs/a.png"] }, asset] }).success).toBe(
      true,
    );
    expect(PublishRequest.safeParse({ ...request, files: [asset] }).success).toBe(false);
  });

  test.each([
    ["an svg", { path: "media/a.svg" }],
    ["a stylesheet", { path: "media/a.css" }],
    ["a hidden path", { path: "media/.a.png" }],
    ["a colon", { path: "media/a:b.png" }],
    ["a topic", { topic: "routing" }],
    ["an asset list", { assets: [] }],
    ["notes", { notes: [] }],
    ["an old blob", { oldBlob: "d".repeat(64) }],
    ["no blob", { newBlob: null }],
    ["a flag", { flag: "binary", newBlob: null }],
  ])("refuses parentless media with %s", (_name, patch) => {
    const topics = [{ slug: "routing", title: "Routing", importance: 20, summary: "A sample router." }];
    expect(PublishRequest.safeParse({ ...request, topics, files: [{ ...image, ...patch }] }).success).toBe(false);
  });

  test("refuses media that an HTML doc lists as its asset", () => {
    const files = [{ ...html, path: "media/plan.html", assets: ["media/a.png"] }, image];
    expect(PublishRequest.safeParse({ ...request, files }).success).toBe(false);
  });

  test("refuses duplicate media paths and media that collide with a doc", () => {
    expect(PublishRequest.safeParse({ ...request, files: [image, image] }).success).toBe(false);
    const doc = { ...html, path: "media/a.png", assets: undefined };
    expect(PublishRequest.safeParse({ ...request, files: [doc, image] }).success).toBe(false);
  });

  test("caps parentless assets per request", () => {
    const files = (count: number) => Array.from({ length: count }, (_, i) => ({ ...image, path: `media/${i}.png` }));
    expect(PublishRequest.safeParse({ ...request, files: files(LIMITS.mediaPerRevision) }).success).toBe(true);
    expect(PublishRequest.safeParse({ ...request, files: files(LIMITS.mediaPerRevision + 1) }).success).toBe(false);
  });
});

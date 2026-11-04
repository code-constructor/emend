import { describe, expect, test } from "vitest";
import { PublishLinks, PublishManifest, PublishRequest, RepoUrl } from "./index.ts";

const link = { url: "https://example.test/o/r/pull/7", label: "PR 7", kind: "pr" as const };
const manifest = {
  version: 1,
  title: "Synthetic",
  topics: [],
  files: [],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
};

describe("links", () => {
  test("accept https links with a label and an optional kind", () => {
    expect(PublishLinks.parse([link, { url: "https://example.test/i/1", label: "Issue" }])).toHaveLength(2);
    expect(PublishLinks.safeParse(Array.from({ length: 8 }, () => link)).success).toBe(true);
    expect(PublishLinks.safeParse(Array.from({ length: 9 }, () => link)).success).toBe(false);
  });

  test.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "http://example.test/x",
    "https://user@example.test/x",
    "https://user:pw@example.test/x",
    "//example.test/x",
    "https://",
    "https://example.test/a b",
    "https://example.test/‮",
    `https://example.test/${"a".repeat(2048)}`,
  ])("refuse the url %j", (url) => {
    expect(PublishLinks.safeParse([{ ...link, url }]).success).toBe(false);
  });

  test.each(["", "   ", "x".repeat(61), "a\nb", "a‮b"])("refuse the label %j", (label) => {
    expect(PublishLinks.safeParse([{ ...link, label }]).success).toBe(false);
  });

  test("refuse an unknown kind", () => {
    expect(PublishLinks.safeParse([{ ...link, kind: "video" }]).success).toBe(false);
  });
});

describe("repoUrl", () => {
  test.each(["https://github.com/owner/name", "https://git.example.test:8443/o/r.js", "https://a.b-c.test/x_y/z.z"])(
    "accepts %s",
    (value) => expect(RepoUrl.safeParse(value).success).toBe(true),
  );

  test.each([
    "http://github.com/o/r",
    "https://user@github.com/o/r",
    "https://github.com/o",
    "https://github.com/o/r/sub",
    "https://github.com/o/r/",
    "https://github.com/o/r?x=1",
    "https://github.com/o/r#x",
    "https://github.com/../r",
    "https://GitHub.com/o/r",
    "https://gïthub.com/o/r",
    "https://github.com/o/r r",
    "ssh://git@github.com/o/r",
    "file:///tmp/o/r",
    `https://github.com/o/${"r".repeat(2048)}`,
  ])("refuses %j", (value) => expect(RepoUrl.safeParse(value).success).toBe(false));
});

describe("manifest and request", () => {
  test("a manifest takes links, and drops an invalid repoUrl instead of failing", () => {
    expect(PublishManifest.parse({ ...manifest, links: [link], repoUrl: "https://github.com/o/r" })).toMatchObject({
      links: [link],
      repoUrl: "https://github.com/o/r",
    });
    expect(PublishManifest.parse({ ...manifest, repoUrl: "javascript:alert(1)" }).repoUrl).toBeUndefined();
    // null is a deliberate opt-out of the derived address, and stays null.
    expect(PublishManifest.parse({ ...manifest, repoUrl: null }).repoUrl).toBeNull();
    expect(PublishManifest.safeParse({ ...manifest, links: [{ ...link, url: "javascript:x" }] }).success).toBe(false);
  });

  test("a request refuses an invalid repoUrl or link", () => {
    const request = { reviewKey: "a".repeat(64), repo: null, branch: null, title: "T", base: null, head: null };
    const base = { ...request, topics: [], writeup: manifest.writeup, files: [] };
    expect(PublishRequest.safeParse({ ...base, links: [link], repoUrl: "https://github.com/o/r" }).success).toBe(true);
    expect(PublishRequest.safeParse({ ...base, repoUrl: "http://github.com/o/r" }).success).toBe(false);
    expect(PublishRequest.safeParse({ ...base, links: [{ ...link, url: "http://x.test" }] }).success).toBe(false);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { RevisionView } from "@emend/contract";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { devices, files, reviews, revisions } from "../../db/schema.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import { BRIDGE_SOURCE } from "./bridge.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
let docUrl: string;
let secondUrl: string;
const origin = "http://127.0.0.1:3636";
const csp =
  "sandbox allow-scripts; default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'";
const docCsp = csp.replace(
  "script-src 'none'",
  `script-src 'sha256-${createHash("sha256").update(BRIDGE_SOURCE).digest("base64")}'`,
);
const source =
  '<body><p>Synthetic seeds</p><link rel="stylesheet" href="shared.css"><script src="classic.js"></script><img src="seed.svg"></body>';
beforeEach(async () => {
  f = await mailboxFixture();
  const entries = [
    ["docs/a #é.html", "doc", source],
    ["docs/b.html", "doc", source],
    ["docs/shared.css", "asset", "p { color: green; }"],
    ["docs/classic.js", "asset", "window.synthetic = true;"],
    ["docs/seed.svg", "asset", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["docs/data.css", "asset", '{"synthetic":true}'],
    ["docs/unlisted.css", "asset", "p {}"],
    ["docs/change.html", "diff", "<script>synthetic()</script>"],
  ];
  const inputFiles = [];
  for (const [path, role, text] of entries) {
    if (!path || !role || text === undefined) throw new Error("Invalid fixture");
    const hash = await f.deps.blobs.put(f.ownerId, Buffer.from(text), "application/octet-stream");
    inputFiles.push({
      path,
      role,
      oldPath: null,
      oldBlob: null,
      newBlob: hash,
      flag: null,
      ...(role === "doc" ? { assets: ["docs/shared.css", "docs/classic.js", "docs/seed.svg", "docs/data.css"] } : {}),
      ...(role === "asset" ? { parent: "docs/a #é.html" } : {}),
    });
  }
  const published = await f.request(
    "/publish",
    "POST",
    {
      reviewId: f.reviewId,
      reviewKey: "a".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic HTML",
      base: null,
      head: null,
      topics: [],
      files: inputFiles,
      writeup: { overview: "Synthetic", tldr: "Summary", decisions: null, topics: {} },
    },
    "agent",
  );
  expect(published.status).toBe(200);
  await f.db.query((q) =>
    q
      .update(files)
      .set({ mediaType: "application/json" })
      .where(and(eq(files.ownerId, f.ownerId), eq(files.path, "docs/data.css"))),
  );
  const view = RevisionView.parse(await (await f.request(`/reviews/${f.reviewId}/revisions/2`, "GET")).json());
  const first = view.docs[0],
    second = view.docs[1];
  if (first?.kind !== "html" || second?.kind !== "html") throw new Error("Missing docs");
  docUrl = first.contentUrl;
  secondUrl = second.contentUrl;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
function request(path: string, method = "GET", headers: Record<string, string> = {}) {
  return f.app.request(`${origin}${path}`, { method, headers: { Host: "127.0.0.1:3636", ...headers } });
}
function headers(response: Response, asset = false) {
  expect(response.headers.get("Content-Security-Policy")).toBe(response.ok && !asset ? docCsp : csp);
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(asset ? "cross-origin" : "same-origin");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.has("X-Frame-Options")).toBe(false);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(asset ? "*" : null);
}
test("doc key names one HTML doc; GET/HEAD serve injected docs and byte-exact relative assets", async () => {
  expect(docUrl).toMatch(/^\/content\/[A-Za-z0-9_-]{43}[0-9a-f]{32}\/docs\/a%20%23%C3%A9.html$/);
  for (const method of ["GET", "HEAD"]) {
    const response = await request(docUrl, method, { Cookie: "emend_session=ignored", Authorization: "ignored" });
    expect(response.status).toBe(200);
    headers(response);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await response.text();
    if (method === "HEAD") expect(text).toBe("");
    else {
      const scripts = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
      expect(scripts).toEqual([BRIDGE_SOURCE]);
      const hash = createHash("sha256")
        .update(scripts[0] ?? "")
        .digest("base64");
      expect(response.headers.get("Content-Security-Policy")).toContain(`script-src 'sha256-${hash}';`);
      expect(text).toContain("<p>Synthetic seeds</p>");
    }
    for (const [path, type, bytes] of [
      ["shared.css", "text/css; charset=utf-8", "p { color: green; }"],
      ["classic.js", "text/javascript; charset=utf-8", "window.synthetic = true;"],
      ["seed.svg", "image/svg+xml; charset=utf-8", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ["data.css", "application/json; charset=utf-8", '{"synthetic":true}'],
    ]) {
      const url = new URL(path ?? "", origin + docUrl);
      const asset = await request(url.pathname, method, { Origin: "null" });
      expect(asset.status).toBe(200);
      headers(asset, true);
      expect(asset.headers.get("Content-Type")).toBe(type);
      expect(await asset.text()).toBe(method === "HEAD" ? "" : bytes);
    }
  }
});
test("shared asset loads under both doc keys, but other docs, diff files and unlisted assets never do", async () => {
  for (const url of [docUrl, secondUrl]) {
    expect((await request(new URL("shared.css", origin + url).pathname)).status).toBe(200);
    for (const path of ["unlisted.css", "change.html", "missing.css", url === docUrl ? "b.html" : "a%20%23%C3%A9.html"])
      expect((await request(new URL(path, origin + url).pathname)).status).toBe(404);
  }
});
test("script text before the real body close preserves the injected script and its CSP hash", async () => {
  const html = '<body><p>Seed</p><script>const ending = "</body>";</script></body>';
  const blob = await f.deps.blobs.put(f.ownerId, Buffer.from(html), "text/html");
  await f.db.query((q) =>
    q
      .update(files)
      .set({ newBlob: blob })
      .where(and(eq(files.ownerId, f.ownerId), eq(files.path, "docs/a #é.html"))),
  );
  const response = await request(docUrl);
  expect(response.status).toBe(200);
  headers(response);
  const texts = [...(await response.text()).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  expect(texts).toEqual(['const ending = "</body>";', BRIDGE_SOURCE]);
  const hash = createHash("sha256")
    .update(texts[1] ?? "")
    .digest("base64");
  expect(response.headers.get("Content-Security-Policy")).toContain(`script-src 'sha256-${hash}';`);
});
test("bad keys and paths have content headers even with a valid reviewer cookie", async () => {
  const key = docUrl.split("/")[2] ?? "";
  const revision = await f.db.read((q) =>
    q
      .select()
      .from(revisions)
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.seq, 2)))
      .get(),
  );
  if (!revision) throw new Error("Missing revision");
  const otherKey = "Z".repeat(43);
  await f.db.query((q) =>
    q
      .update(revisions)
      .set({ contentKey: otherKey })
      .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.id, f.revisionId))),
  );
  const { createToken, SESSION_MS } = await import("../auth/tokens.ts");
  const deviceId = randomUUID();
  await f.db.query((q) =>
    q.insert(devices).values({ id: deviceId, ownerId: f.ownerId, kind: "browser", name: "Synthetic" }),
  );
  const session = await createToken(f.db, f.ownerId, "reviewer", { deviceId, expiresAt: f.deps.now() + SESSION_MS });
  expect((await request("/api/v1/reviews", "GET", { Cookie: `emend_session=${session.secret}` })).status).toBe(200);
  for (const path of [
    `/content/${key.slice(1)}/docs/b.html`,
    `/content/${key}0/docs/b.html`,
    `/content/${revision.contentKey}${randomUUID().replaceAll("-", "")}/docs/b.html`,
    `/content/${otherKey}${key.slice(43)}/docs/b.html`,
    `/content/${key}/docs/%`,
    `/content/${key}/docs//shared.css`,
    `/content/${key}/docs/%2e%2e%2fshared.css`,
    `/content/${key}/docs/%00`,
    `/content/${key}/docs/%2Fshared.css`,
    "/content/",
  ]) {
    const response = await request(path, "GET", { Cookie: `emend_session=${session.secret}` });
    expect(response.status, path).toBe(404);
    headers(response);
  }
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await request(docUrl, method);
    expect(response.status).toBe(404);
    headers(response);
  }
  const refused = await request(docUrl, "GET", { Host: "invalid.example" });
  expect(refused.status).toBe(403);
  headers(refused);
});
test("blob failures retain content headers without CORS", async () => {
  vi.spyOn(f.deps.blobs, "get").mockResolvedValue(null);
  const response = await request(docUrl);
  expect(response.status).toBe(404);
  headers(response);
});
test("asset associations are owner/revision constrained and content keys are unique", async () => {
  const rows = await f.db.read((q) =>
    q
      .select()
      .from(files)
      .where(and(eq(files.ownerId, f.ownerId), eq(files.role, "doc"))),
  );
  const doc = rows[0];
  if (!doc) throw new Error("Missing doc");
  await expect(
    f.db.query((q) =>
      q.run(sql`INSERT INTO doc_assets VALUES (${f.otherOwnerId}, ${doc.revisionId}, ${doc.id}, ${doc.id})`),
    ),
  ).rejects.toThrow();
  await expect(
    f.db.query((q) => q.run(sql`INSERT INTO doc_assets VALUES (${f.ownerId}, ${f.revisionId}, ${doc.id}, ${doc.id})`)),
  ).rejects.toThrow();
  const key = docUrl.split("/")[2]?.slice(0, 43);
  await expect(
    f.db.query((q) =>
      q
        .update(revisions)
        .set({ contentKey: key })
        .where(and(eq(revisions.ownerId, f.ownerId), eq(revisions.id, f.revisionId))),
    ),
  ).rejects.toThrow();
});

test("a real foreign doc id cannot be combined with this revision capability", async () => {
  const reviewId = randomUUID(),
    revisionId = randomUUID(),
    fileId = randomUUID();
  await f.db.query(async (q) => {
    await q.insert(reviews).values({
      id: reviewId,
      ownerId: f.otherOwnerId,
      originInstanceId: f.instanceId,
      reviewKey: "b".repeat(64),
      title: "Synthetic foreign review",
    });
    await q
      .insert(revisions)
      .values({ id: revisionId, ownerId: f.otherOwnerId, reviewId, seq: 1, contentKey: "f".repeat(43) });
    await q.insert(files).values({
      id: fileId,
      ownerId: f.otherOwnerId,
      revisionId,
      role: "doc",
      path: "docs/b.html",
      mediaType: "text/html",
      ord: 0,
    });
  });
  const key = docUrl.split("/")[2]?.slice(0, 43);
  const response = await request(`/content/${key}${fileId.replaceAll("-", "")}/docs/b.html`);
  expect(response.status).toBe(404);
  headers(response);
});

test("publishing more than 500 associations retains every shared asset under both docs", async () => {
  const blob = await f.deps.blobs.put(f.ownerId, Buffer.from("p {}"), "text/css");
  const assets = Array.from({ length: 501 }, (_, i) => `many/${i}.css`);
  const published = await f.request(
    "/publish",
    "POST",
    {
      reviewId: f.reviewId,
      reviewKey: "a".repeat(64),
      repo: null,
      branch: null,
      title: "Synthetic shared assets",
      base: null,
      head: null,
      topics: [],
      writeup: { overview: "Synthetic", tldr: "Summary", decisions: null, topics: {} },
      files: [
        ...["many/a.html", "many/b.html"].map((path) => ({
          path,
          role: "doc",
          oldPath: null,
          oldBlob: null,
          newBlob: blob,
          flag: null,
          assets,
        })),
        ...assets.map((path) => ({
          path,
          role: "asset",
          oldPath: null,
          oldBlob: null,
          newBlob: blob,
          flag: null,
          parent: "many/a.html",
        })),
      ],
    },
    "agent",
  );
  expect(published.status).toBe(200);
  const view = RevisionView.parse(await (await f.request(`/reviews/${f.reviewId}/revisions/3`, "GET")).json());
  for (const doc of view.docs) {
    if (doc.kind !== "html") throw new Error("Missing HTML doc");
    for (const name of ["0.css", "499.css", "500.css"])
      expect((await request(new URL(name, origin + doc.contentUrl).pathname)).status).toBe(200);
  }
  expect(await f.db.read((q) => q.values(sql`SELECT count(*) FROM doc_assets WHERE owner_id = ${f.ownerId}`))).toEqual([
    [1010],
  ]);
});

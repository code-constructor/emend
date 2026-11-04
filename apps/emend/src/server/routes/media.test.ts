import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { files } from "../../db/schema.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});

// A synthetic 1x1 PNG header; the route serves bytes without decoding them.
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

async function seed(overrides: Partial<typeof files.$inferInsert> = {}) {
  await f.db.query((q) =>
    q.insert(files).values({
      id: randomUUID(),
      ownerId: f.ownerId,
      revisionId: f.revisionId,
      path: `${randomUUID()}.png`,
      role: "asset",
      ord: 0,
      mediaType: "image/png",
      ...overrides,
    }),
  );
}

test("serves a declared image with locked-down headers for GET and HEAD", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await seed({ newBlob: hash });
  for (const method of ["GET", "HEAD"]) {
    const response = await f.request(`/media/${hash}`, method);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(["Content-Type", ...headerNames].map((n) => [n, response.headers.get(n)]))).toEqual({
      "Content-Type": "image/png",
      ...expected,
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      method === "HEAD" ? new Uint8Array() : new Uint8Array(png),
    );
  }
});
const expected = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "Content-Disposition": "inline",
};
const headerNames = Object.keys(expected);

test("an HTML doc's parented PNG asset is not served, while writeup media is", async () => {
  const docHash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  const doc = randomUUID();
  await seed({ id: doc, path: "plan.html", role: "doc", mediaType: "text/html", newBlob: docHash });
  await seed({ path: "a.png", parentDocId: doc, newBlob: docHash });
  await error(await f.request(`/media/${docHash}`, "GET"), 404, "not_found");
  // Another image of the same owner, as writeup media, still resolves.
  const shot = await f.deps.blobs.put(f.ownerId, Buffer.concat([png, Buffer.from("shot")]), "image/png");
  await seed({ path: "media/shot.png", newBlob: shot });
  expect((await f.request(`/media/${shot}`, "GET")).status).toBe(200);
});

test("the same bytes as a doc asset and as writeup media are served through the parentless row", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  const doc = randomUUID();
  await seed({ id: doc, path: "plan.html", role: "doc", mediaType: "text/html", newBlob: hash });
  // The parented row sorts first by type, so only the parentless filter lets the media row win.
  await seed({ path: "a.gif", mediaType: "image/gif", parentDocId: doc, newBlob: hash });
  await seed({ path: "media/a.png", mediaType: "image/png", newBlob: hash });
  const response = await f.request(`/media/${hash}`, "GET");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/png");
});

test("the same bytes stored as two image types serve one stable type", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await seed({ path: "a.gif", mediaType: "image/gif", newBlob: hash });
  await seed({ path: "a.png", mediaType: "image/png", newBlob: hash });
  const types = [];
  for (let i = 0; i < 2; i++) types.push((await f.request(`/media/${hash}`, "GET")).headers.get("Content-Type"));
  expect(types).toEqual(["image/gif", "image/gif"]);
});

test("refuses bad hashes, other owners, diff blobs, SVG, missing bytes and non-image assets", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await seed({ newBlob: hash });
  for (const bad of ["abc", hash.toUpperCase(), `${hash}0`, "g".repeat(64), "%2e%2e"])
    await error(await f.request(`/media/${bad}`, "GET"), 404, "not_found");
  await error(await f.request(`/media/${hash}`, "GET", undefined, "foreign"), 404, "not_found");
  await error(await f.request(`/media/${"e".repeat(64)}`, "GET"), 404, "not_found");

  const diff = await f.deps.blobs.put(f.ownerId, Buffer.from("synthetic diff side"), "text/plain");
  await seed({ role: "diff", mediaType: "text/plain", newBlob: diff, oldBlob: diff });
  await error(await f.request(`/media/${diff}`, "GET"), 404, "not_found");

  const svg = await f.deps.blobs.put(f.ownerId, Buffer.from('<svg onload="x"/>'), "image/svg+xml");
  await seed({ path: "a.svg", mediaType: "image/svg+xml", newBlob: svg });
  await error(await f.request(`/media/${svg}`, "GET"), 404, "not_found");

  const css = await f.deps.blobs.put(f.ownerId, Buffer.from("body{}"), "text/css");
  await seed({ path: "a.css", mediaType: "text/css", newBlob: css });
  await error(await f.request(`/media/${css}`, "GET"), 404, "not_found");

  vi.spyOn(f.deps.blobs, "get").mockResolvedValue(null);
  await error(await f.request(`/media/${hash}`, "GET"), 404, "not_found");
});

test("an unauthenticated request is refused like other API routes", async () => {
  const hash = await f.deps.blobs.put(f.ownerId, png, "image/png");
  await seed({ newBlob: hash });
  const response = await f.app.request(`http://127.0.0.1:3636/api/v1/media/${hash}`, {
    headers: { Host: "127.0.0.1:3636" },
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("Content-Type")).not.toMatch(/^image\//);
});

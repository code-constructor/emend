import { createHash } from "node:crypto";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { blobs } from "../db/schema.ts";
import { testDb } from "../db/test-support.ts";
import { BlobMismatchError, BlobStore } from "./blobs.ts";

test("blobs share content-addressed files but require a separate owner row", async () => {
  const ctx = await testDb();
  const store = new BlobStore(ctx.db, ctx.dir);
  const bytes = new TextEncoder().encode("Synthetic blob content");
  const expected = createHash("sha256").update(bytes).digest("hex");
  try {
    const sha = await store.put(ctx.ownerId, bytes, "text/plain");
    expect(sha).toBe(expected);
    const file = join(ctx.dir, "blobs", sha.slice(0, 2), sha);
    expect(new Uint8Array(await readFile(file))).toEqual(bytes);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(ctx.dir, "blobs", sha.slice(0, 2)))).mode & 0o777).toBe(0o700);
    expect((await stat(join(ctx.dir, "blobs"))).mode & 0o777).toBe(0o700);
    expect(await store.has(ctx.ownerId, sha)).toBe(true);
    expect(await store.get(ctx.ownerId, sha)).toEqual(bytes);
    expect(await store.has(ctx.otherOwnerId, sha)).toBe(false);
    expect(await store.get(ctx.otherOwnerId, sha)).toBeNull();
    await store.put(ctx.ownerId, bytes, "text/plain", sha);
    await store.put(ctx.otherOwnerId, bytes, "text/plain");
    expect(await store.get(ctx.otherOwnerId, sha)).toEqual(bytes);
    expect(await readdir(join(ctx.dir, "blobs", sha.slice(0, 2)))).toEqual([sha]);
    expect(
      await ctx.db.query((q) =>
        q
          .select()
          .from(blobs)
          .where(and(eq(blobs.ownerId, ctx.ownerId), eq(blobs.sha256, sha))),
      ),
    ).toEqual([{ ownerId: ctx.ownerId, sha256: sha, size: bytes.length, mediaType: "text/plain" }]);
  } finally {
    await ctx.cleanup();
  }
});

test("a mismatched expected hash creates neither a file nor an owner row", async () => {
  const ctx = await testDb();
  const store = new BlobStore(ctx.db, ctx.dir);
  try {
    await expect(
      store.put(ctx.ownerId, new Uint8Array([1, 2, 3]), "application/octet-stream", "a".repeat(64)),
    ).rejects.toBeInstanceOf(BlobMismatchError);
    expect(await ctx.db.query((q) => q.select().from(blobs).where(eq(blobs.ownerId, ctx.ownerId)))).toEqual([]);
    await expect(stat(join(ctx.dir, "blobs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.has(ctx.ownerId, "a".repeat(64))).toBe(false);
    expect(await store.get(ctx.ownerId, "a".repeat(64))).toBeNull();
    expect(await store.get(ctx.ownerId, "../../outside")).toBeNull();
  } finally {
    await ctx.cleanup();
  }
});

test("blob reuse tightens folders and files, refuses truncated reads and repairs corrupt content", async () => {
  const ctx = await testDb();
  const store = new BlobStore(ctx.db, ctx.dir);
  // Pick synthetic content that exercises the ab shard specified by the state layout.
  let bytes = new Uint8Array();
  for (let i = 0; ; i++) {
    bytes = new TextEncoder().encode(`Synthetic ab blob ${i}`);
    if (createHash("sha256").update(bytes).digest("hex").startsWith("ab")) break;
  }
  try {
    const sha = await store.put(ctx.ownerId, bytes, "text/plain");
    const shard = join(ctx.dir, "blobs", "ab");
    const file = join(shard, sha);
    for (const reuse of [() => store.put(ctx.ownerId, bytes, "text/plain"), () => store.get(ctx.ownerId, sha)]) {
      await chmod(join(ctx.dir, "blobs"), 0o755);
      await chmod(shard, 0o755);
      await chmod(file, 0o644);
      await reuse();
      expect((await stat(join(ctx.dir, "blobs"))).mode & 0o777).toBe(0o700);
      expect((await stat(shard)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    await writeFile(file, bytes.subarray(0, 3));
    expect(await store.get(ctx.ownerId, sha)).toBeNull();
    await store.put(ctx.ownerId, bytes, "text/plain");
    expect(await store.get(ctx.ownerId, sha)).toEqual(bytes);
    await writeFile(file, new Uint8Array(bytes.length));
    await store.put(ctx.ownerId, bytes, "text/plain");
    expect(await store.get(ctx.ownerId, sha)).toEqual(bytes);
  } finally {
    await ctx.cleanup();
  }
});

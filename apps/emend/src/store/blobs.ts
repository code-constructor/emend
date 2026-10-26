import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { blobs } from "../db/schema.ts";
import { ensurePrivateDir, ensureStateDir, tightenSecretFile, writeSecretFile } from "../state/files.ts";

export class BlobMismatchError extends Error {
  constructor() {
    super("Blob content does not match the expected SHA-256");
    this.name = "BlobMismatchError";
  }
}

export class BlobStore {
  private readonly db: Db;
  private readonly dir: string;

  constructor(db: Db, dir: string) {
    ensureStateDir(dir);
    this.db = db;
    this.dir = dir;
  }

  async put(ownerId: string, bytes: Uint8Array, mediaType: string, expectedSha?: string): Promise<string> {
    // Snapshot caller-owned bytes before hashing or awaiting anything.
    const content = Uint8Array.from(bytes);
    const sha = createHash("sha256").update(content).digest("hex");
    if (expectedSha !== undefined && sha !== expectedSha) throw new BlobMismatchError();
    const file = this.path(sha);
    ensurePrivateDir(dirname(file), this.dir);
    const valid = tightenSecretFile(file) && createHash("sha256").update(readFileSync(file)).digest("hex") === sha;
    if (!valid) writeSecretFile(file, content, this.dir);
    await this.db.query(async (q) => {
      await q
        .insert(blobs)
        .values({ ownerId, sha256: sha, size: content.length, mediaType })
        .onConflictDoNothing({ target: [blobs.ownerId, blobs.sha256] });
    });
    return sha;
  }

  async has(ownerId: string, sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return false;
    return this.db.query(async (q) =>
      Boolean(
        await q
          .select({ sha256: blobs.sha256 })
          .from(blobs)
          .where(and(eq(blobs.ownerId, ownerId), eq(blobs.sha256, sha)))
          .get(),
      ),
    );
  }

  async get(ownerId: string, sha: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    const row = await this.db.query((q) =>
      q
        .select({ size: blobs.size })
        .from(blobs)
        .where(and(eq(blobs.ownerId, ownerId), eq(blobs.sha256, sha)))
        .get(),
    );
    if (!row) return null;
    try {
      const file = this.path(sha);
      ensurePrivateDir(dirname(file), this.dir);
      if (!tightenSecretFile(file)) return null;
      const bytes = new Uint8Array(await readFile(file));
      return bytes.byteLength === row.size ? bytes : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private path(sha: string): string {
    return join(this.dir, "blobs", sha.slice(0, 2), sha);
  }
}

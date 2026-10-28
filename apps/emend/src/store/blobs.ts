import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db, Queries } from "../db/client.ts";
import { blobs } from "../db/schema.ts";
import { ensurePrivateDir, ensureStateDir, syncDirectory, tightenSecretFile, writeSecretFile } from "../state/files.ts";

export class BlobMismatchError extends Error {
  constructor() {
    super("Blob content does not match the expected SHA-256");
    this.name = "BlobMismatchError";
  }
}
export class BlobTooLargeError extends Error {}

export class BlobStore {
  private readonly db: Db;
  private readonly dir: string;

  constructor(db: Db, dir: string) {
    ensureStateDir(dir);
    this.db = db;
    this.dir = dir;
  }

  async put(
    ownerId: string,
    bytes: Uint8Array,
    mediaType: string,
    expectedSha?: string,
    scope?: Queries,
  ): Promise<string> {
    // Snapshot caller-owned bytes before hashing or awaiting anything.
    const content = Uint8Array.from(bytes);
    const sha = createHash("sha256").update(content).digest("hex");
    if (expectedSha !== undefined && sha !== expectedSha) throw new BlobMismatchError();
    const file = this.path(sha);
    ensurePrivateDir(dirname(file), this.dir);
    const valid = tightenSecretFile(file) && createHash("sha256").update(readFileSync(file)).digest("hex") === sha;
    if (!valid) writeSecretFile(file, content, this.dir);
    const record = async (q: Queries) => {
      await q
        .insert(blobs)
        .values({ ownerId, sha256: sha, size: content.length, mediaType })
        .onConflictDoNothing({ target: [blobs.ownerId, blobs.sha256] });
    };
    if (scope) await record(scope);
    else await this.db.transaction(record, { offThread: true });
    return sha;
  }

  async has(ownerId: string, sha: string, scope?: Queries): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return false;
    return this.query(
      scope,
      async (q) =>
        Boolean(
          await q
            .select({ sha256: blobs.sha256 })
            .from(blobs)
            .where(and(eq(blobs.ownerId, ownerId), eq(blobs.sha256, sha)))
            .get(),
        ),
      true,
    );
  }

  async get(ownerId: string, sha: string, scope?: Queries): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    const row = await this.query(scope, (q) =>
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
      return bytes.byteLength === row.size && createHash("sha256").update(bytes).digest("hex") === sha ? bytes : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async putStream(
    ownerId: string,
    stream: AsyncIterable<Uint8Array>,
    sha: string,
    size: number,
    limit: number,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(sha) || !Number.isSafeInteger(size) || size < 0) throw new BlobMismatchError();
    if (size > limit) throw new BlobTooLargeError();
    const file = this.path(sha);
    ensurePrivateDir(dirname(file), this.dir);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let received = 0;
    try {
      for await (const bytes of stream) {
        received += bytes.byteLength;
        if (received > limit) throw new BlobTooLargeError();
        if (received > size) throw new BlobMismatchError();
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) offset += (await handle.write(bytes, offset)).bytesWritten;
      }
      if (received !== size || hash.digest("hex") !== sha) throw new BlobMismatchError();
      await handle.sync();
      await handle.close();
      await rename(temporary, file);
      syncDirectory(dirname(file));
      await this.db.query((q) =>
        q
          .insert(blobs)
          .values({ ownerId, sha256: sha, size, mediaType: "application/octet-stream" })
          .onConflictDoNothing({ target: [blobs.ownerId, blobs.sha256] }),
      );
    } finally {
      await handle.close();
      await rm(temporary, { force: true });
    }
  }

  private query<T>(scope: Queries | undefined, fn: (q: Queries) => Promise<T>, readOnly = false): Promise<T> {
    return scope ? fn(scope) : readOnly ? this.db.read(fn) : this.db.query(fn);
  }

  private path(sha: string): string {
    return join(this.dir, "blobs", sha.slice(0, 2), sha);
  }
}

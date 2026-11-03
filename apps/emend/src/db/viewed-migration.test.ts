import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { openDb } from "./client.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.gen.ts";
import { viewedFiles } from "./schema.ts";

test.each([false, true])(
  "viewed migration applies with previous database=%s without changing existing rows",
  async (previous) => {
    const dir = await mkdtemp(join(tmpdir(), "emend-viewed-"));
    const db = openDb(join(dir, "test.db"));
    const owner = randomUUID(),
      instance = randomUUID(),
      review = randomUUID();
    try {
      if (previous)
        await db.transaction(async (q) => {
          await q.exec(
            "CREATE TABLE __emend_migrations (hash text primary key, tag text not null, applied_at integer not null)",
          );
          for (const migration of MIGRATIONS.slice(0, -1)) {
            for (const statement of migration.statements) await q.exec(statement);
            await q.run(sql`INSERT INTO __emend_migrations VALUES (${migration.hash}, ${migration.tag}, 0)`);
          }
          await q.run(sql`INSERT INTO owners (id) VALUES (${owner})`);
          await q.run(sql`INSERT INTO instances (id, name) VALUES (${instance}, 'Synthetic')`);
          await q.run(
            sql`INSERT INTO reviews (id, owner_id, origin_instance_id, review_key, title, created_at, updated_at) VALUES (${review}, ${owner}, ${instance}, 'synthetic', 'Synthetic', 0, 0)`,
          );
        });
      const before = await db.read((q) =>
        q.values(sql`SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`),
      );
      expect(await migrate(db)).toBe(previous ? 1 : MIGRATIONS.length);
      expect(await migrate(db)).toBe(0);
      expect(await db.read((q) => q.select().from(viewedFiles).where(sql`${viewedFiles.ownerId} = ${owner}`))).toEqual(
        [],
      );
      if (previous) {
        expect(
          await db.read((q) => q.values(sql`SELECT title FROM reviews WHERE owner_id = ${owner} AND id = ${review}`)),
        ).toEqual([["Synthetic"]]);
        expect(
          await db.read((q) =>
            q.values(
              sql`SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'viewed_files%' AND name != 'files_owner_revision_path_idx' ORDER BY name`,
            ),
          ),
        ).toEqual(before);
      }
      expect(await db.read((q) => q.values(sql`PRAGMA foreign_key_check`))).toEqual([]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

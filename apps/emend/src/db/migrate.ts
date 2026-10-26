import { sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { MIGRATIONS } from "./migrations.gen.ts";

export function migrate(db: Db): Promise<number> {
  return db.transaction(async (q) => {
    await q.run(
      sql`CREATE TABLE IF NOT EXISTS __emend_migrations (hash text primary key, tag text not null, applied_at integer not null)`,
    );
    const applied = new Set((await q.values<[string]>(sql`SELECT hash FROM __emend_migrations`)).map(([hash]) => hash));
    let count = 0;
    for (const migration of [...MIGRATIONS].sort((a, b) => a.when - b.when)) {
      if (applied.has(migration.hash)) continue;
      for (const statement of migration.statements) await q.exec(statement);
      await q.run(
        sql`INSERT INTO __emend_migrations (hash, tag, applied_at) VALUES (${migration.hash}, ${migration.tag}, ${Date.now()})`,
      );
      applied.add(migration.hash);
      count++;
    }
    return count;
  });
}

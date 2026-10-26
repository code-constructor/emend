import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, fchmodSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { ensureStateDir, tightenSecretFile } from "../state/files.ts";
import * as schema from "./schema.ts";

// Raw all/get assume object rows; use typed builders or values() for positional SQL.
export type Queries = Omit<SqliteRemoteDatabase<typeof schema>, "transaction" | "all" | "get"> & {
  // Trusted application SQL only, including complete migration chunks.
  exec(sql: string): Promise<void>;
};
type Operation<T> = (queries: Queries) => Promise<T>;

export class NestedDbCallError extends Error {
  constructor() {
    super("Nested database calls are not allowed; use the current query scope");
    this.name = "NestedDbCallError";
  }
}

export interface Db {
  // Await all work through the supplied scope; do not nest calls back into Db.
  query<T>(fn: Operation<T>): Promise<T>;
  transaction<T>(fn: Operation<T>): Promise<T>;
  close(): Promise<void>;
}

export function openDb(file: string): Db {
  ensureStateDir(dirname(file));
  const fd = openSync(file, "a", 0o600);
  try {
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  for (const sidecar of [`${file}-wal`, `${file}-shm`]) tightenSecretFile(sidecar);
  const raw = new DatabaseSync(file);
  try {
    raw.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    for (const [name, expected] of [
      ["journal_mode", "wal"],
      ["busy_timeout", 5000],
      ["foreign_keys", 1],
    ] as const) {
      const row = raw.prepare(`PRAGMA ${name}`).get();
      if (!row || Object.values(row)[0] !== expected) throw new Error(`SQLite pragma ${name} was not applied`);
    }
  } catch (error) {
    raw.close();
    throw error;
  }

  let queue = Promise.resolve();
  const scope = new AsyncLocalStorage<{ active: boolean }>();
  let closing: Promise<void> | undefined;
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function execute<T>(fn: Operation<T>, transaction: boolean): Promise<T> {
    if (scope.getStore()?.active) return Promise.reject(new NestedDbCallError());
    if (closing) return Promise.reject(new Error("Database is closed"));
    return enqueue(async () => {
      const context = { active: true };
      return scope.run(context, async () => {
        const queries = drizzle(
          async (query, params, method) => {
            if (!context.active) throw new Error("Database query scope has ended");
            const statement = raw.prepare(query);
            if (method === "run") {
              statement.run(...params);
              return { rows: [] };
            }
            statement.setReturnArrays(true);
            if (method === "get") {
              // The proxy type omits undefined for a missing positional row.
              return { rows: statement.get(...params) as unknown as unknown[] };
            }
            return { rows: statement.all(...params) as unknown as unknown[][] };
          },
          { schema, logger: false },
        );
        const scoped = Object.assign(queries, {
          async exec(query: string) {
            if (!context.active) throw new Error("Database query scope has ended");
            raw.exec(query);
          },
        });
        if (transaction) raw.exec("BEGIN IMMEDIATE");
        try {
          const value = await fn(scoped);
          if (transaction) raw.exec("COMMIT");
          return value;
        } catch (error) {
          if (transaction) raw.exec("ROLLBACK");
          throw error;
        } finally {
          context.active = false;
        }
      });
    });
  }

  return {
    query: (fn) => execute(fn, false),
    transaction: (fn) => execute(fn, true),
    close() {
      if (scope.getStore()?.active) return Promise.reject(new NestedDbCallError());
      closing ??= enqueue(async () => {
        raw.close();
      });
      return closing;
    },
  };
}

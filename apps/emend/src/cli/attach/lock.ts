import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureStateDir } from "../../state/files.ts";
import { CliError } from "../http.ts";

export function lockAttach(stateDir: string): () => void {
  ensureStateDir(stateDir);
  let db: DatabaseSync | undefined;
  try {
    const path = join(stateDir, "attach.lock");
    // SQLite gives its journal the database file's permissions. Never unlink
    // this file: every copier must lock the same inode, including after a crash.
    // Opening and closing an existing file outside SQLite could drop another
    // connection's POSIX locks in this process.
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    db = new DatabaseSync(path, { timeout: 0 });
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    try {
      db?.close();
    } catch {}
    if (error instanceof Error && "errcode" in error && error.errcode === 5)
      throw new CliError("another emend attach is running. Nothing was changed.");
    throw new CliError("could not lock the emend state folder.");
  }
  const held = db;
  return () => {
    try {
      held.exec("ROLLBACK");
    } catch {
      // Closing still releases the lock; preserve the command's own result.
    } finally {
      try {
        held.close();
      } catch {}
    }
  };
}

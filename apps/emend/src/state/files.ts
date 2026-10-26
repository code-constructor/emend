import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class StateDirModeError extends Error {
  constructor(dir: string) {
    const quoted = `'${dir.replaceAll("'", "'\\''")}'`;
    super(`State directory ${dir} has group or other permissions; fix it with chmod 700 ${quoted}`);
    this.name = "StateDirModeError";
  }
}

// Only chmod directories this call creates. Existing ancestors are not emend's to change.
function createPrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      createPrivateDir(dirname(dir));
      createPrivateDir(dir);
      return;
    }
    if (code === "EEXIST" && statSync(dir).isDirectory()) return;
    throw error;
  }
  chmodSync(dir, 0o700);
}

export function ensureStateDir(dir: string): void {
  const absolute = resolve(dir);
  createPrivateDir(absolute);
  if (statSync(absolute).mode & 0o077) throw new StateDirModeError(absolute);
}

export function ensurePrivateDir(dir: string, stateDirectory: string): void {
  const root = resolve(stateDirectory);
  const suffix = relative(root, resolve(dir));
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error("Private directory must be inside the state directory");
  }
  ensureStateDir(root);
  let current = root;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part);
    createPrivateDir(current);
    chmodSync(current, 0o700);
  }
}

export function tightenSecretFile(path: string): boolean {
  try {
    chmodSync(path, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function syncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeSecretFile(path: string, data: string | Uint8Array, stateDirectory = dirname(path)): void {
  const dir = dirname(path);
  ensurePrivateDir(dir, stateDirectory);
  const temporary = join(dir, `.emend-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(dir);
  } finally {
    rmSync(temporary, { force: true });
  }
}

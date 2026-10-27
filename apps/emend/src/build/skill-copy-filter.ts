import { execFile } from "node:child_process";
import { cp, lstat, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function copySkills(checkout: string, output: string): Promise<void> {
  try {
    await lstat(join(checkout, ".git"));
    const { stdout } = await exec("git", ["ls-files", "--others", "-z", "--", "skills"], { cwd: checkout });
    const untracked = stdout.split("\0").filter(Boolean);
    if (untracked.length) throw new Error(`Untracked skill files: ${untracked.join(", ")}`);
  } catch (error) {
    // Source archives and builds without git still enforce the copy filter.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(output, { recursive: true, force: true });
  await cp(join(checkout, "skills"), output, { recursive: true, filter: skillCopyFilter });
}

export async function skillCopyFilter(source: string): Promise<boolean> {
  const symlink = (path: string) => new Error(`Skill source contains a symlink: ${path}`);
  const entry = await lstat(source);
  if (entry.isSymbolicLink()) throw symlink(source);
  if (!basename(source).startsWith(".")) return true;
  // Hidden folders are not copied, but symlinks anywhere in the source are an error.
  if (entry.isDirectory()) {
    for (const child of await readdir(source, { recursive: true, withFileTypes: true })) {
      if (child.isSymbolicLink()) throw symlink(join(child.parentPath, child.name));
    }
  }
  return false;
}

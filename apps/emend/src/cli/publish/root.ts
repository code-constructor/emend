import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { GitRunner } from "../git.ts";
import { CliError } from "../http.ts";
import { readRegular } from "./read.ts";

export async function gitFolders(root: string, run: GitRunner): Promise<string[]> {
  const entry = join(root, ".git");
  const info = await lstat(entry);
  const target = info.isDirectory()
    ? entry
    : (await readRegular(entry, 16384)).toString().match(/^gitdir: ([^\r\n\0]+)\r?\n?$/)?.[1];
  if (!target) throw new CliError("invalid repository entry");
  const common = (await run(root, ["rev-parse", "--git-common-dir"])).toString().replace(/\r?\n$/, "");
  return [...new Set(await Promise.all([realpath(resolve(root, target)), realpath(resolve(root, common))]))];
}

export async function worktreeRoot(cwd: string): Promise<string | null> {
  let directory = await realpath(cwd);
  for (;;) {
    const entry = join(directory, ".git");
    try {
      const info = await lstat(entry);
      if (info.isDirectory()) return directory;
      if (info.isFile() && /^gitdir: [^\r\n\0]+\r?\n?$/.test((await readRegular(entry, 16384)).toString()))
        return directory;
      throw new CliError("invalid repository entry");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

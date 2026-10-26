import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export async function readTokenFile(path: string, tighten = false): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Token file must be a regular file.");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Token file must be a regular file.");
      if (tighten) await file.chmod(0o600);
      return (await file.readFile("utf8")).replace(/[\r\n]+$/, "");
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

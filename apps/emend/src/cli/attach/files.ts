import { rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

/** Remove credential paths, including an empty directory that prevented a write. Never recurse. */
export async function removeAttachment(stateDir: string) {
  const results = await Promise.allSettled(
    ["hub.token", "attach.json"].map(async (name) => {
      const path = join(stateDir, name);
      try {
        await rm(path, { force: true });
      } catch (error) {
        if (!["EISDIR", "ERR_FS_EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await rmdir(path);
      }
    }),
  );
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

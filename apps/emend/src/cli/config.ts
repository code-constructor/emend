import { isAbsolute, join } from "node:path";
import { LIMITS } from "@emend/contract";
import { StateFolderWriteError, stateAccessError } from "../state/files.ts";
import { CliError } from "./http.ts";
import { readRegular } from "./publish/read.ts";

export async function readConfig(stateDir: string): Promise<{ docRoots: string[]; openBrowser: boolean }> {
  let value: unknown;
  try {
    value = JSON.parse((await readRegular(join(stateDir, "config.json"), LIMITS.publicJsonBytes)).toString());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { docRoots: [], openBrowser: false };
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) throw mapped;
    throw new CliError("invalid emend configuration");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("invalid emend configuration");
  const { docRoots = [], openBrowser = false } = value as Record<string, unknown>;
  if (
    !Array.isArray(docRoots) ||
    !docRoots.every((root) => typeof root === "string" && isAbsolute(root)) ||
    typeof openBrowser !== "boolean"
  )
    throw new CliError("invalid emend configuration");
  return { docRoots, openBrowser };
}

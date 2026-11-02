import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { LIMITS } from "@emend/contract";
import { StateFolderWriteError, stateAccessError } from "../state/files.ts";
import { CliError } from "./http.ts";
import { inside, readRegular } from "./publish/read.ts";

interface Config {
  docRoots: string[];
  openBrowser: boolean;
}

/** The real path of `path`; a missing tail is appended to its nearest existing ancestor's real path. */
async function realpathThroughAncestors(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** The caller supplies a real doc root; home and state paths may still contain symlinks. */
export async function validateDocRoot(root: string, home: string, stateDir: string): Promise<void> {
  if (root === parse(root).root) throw new CliError("docRoots cannot be the filesystem root");
  if (inside(root, await realpathThroughAncestors(home)))
    throw new CliError("docRoots cannot be the home folder or hold it");
  const state = await realpathThroughAncestors(stateDir);
  if (inside(root, state) || inside(state, root))
    throw new CliError("docRoots cannot hold or sit inside emend's state folder");
}

export async function readConfig(stateDir: string): Promise<Config> {
  const { docRoots, openBrowser } = await readConfigDocument(stateDir);
  return { docRoots, openBrowser };
}

/** Validate once and retain future settings when the config command writes the document. */
export async function readConfigDocument(stateDir: string): Promise<Config & Record<string, unknown>> {
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
  return { ...value, docRoots, openBrowser };
}

import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { LIMITS } from "@emend/contract";
import { StateFolderWriteError, stateAccessError } from "../state/files.ts";
import { escapeReference, quoteShellArgument } from "./escape.ts";
import { CliError } from "./http.ts";
import { inside, readRegular } from "./publish/read.ts";

interface Config {
  docRoots: string[];
  openBrowser: boolean;
}

export const rootRules = {
  filesystem: { config: "docRoots cannot be the filesystem root", publish: "is the filesystem root" },
  home: { config: "docRoots cannot be the home folder or hold it", publish: "is the home folder or holds it" },
  state: {
    config: "docRoots cannot hold or sit inside emend's state folder",
    publish: "holds or sits inside emend's state folder",
  },
};

export class DocRootError extends CliError {
  readonly reason: keyof typeof rootRules;
  constructor(reason: keyof typeof rootRules) {
    super(rootRules[reason].config);
    this.reason = reason;
  }
}

const accountHome = () => userInfo().homedir;

/** The real path of `path`; a missing tail is appended to its nearest existing ancestor's real path. */
async function realpathThroughAncestors(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  let hops = 0;
  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) throw error;
      if (code === "ENOENT") {
        const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
          throw error;
        });
        if (info?.isSymbolicLink()) {
          if (++hops > 40) throw Object.assign(new Error("too many symlink levels"), { code: "ELOOP", path: current });
          current = resolve(await realpath(parent), await readlink(current));
          continue;
        }
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

async function checkedFolder(path: string): Promise<string> {
  try {
    return await realpathThroughAncestors(path);
  } catch {
    throw new CliError(`cannot check docRoots: ${escapeReference(path)} cannot be read`);
  }
}

/** The caller supplies a real doc root; home and state paths may still contain symlinks. */
export async function validateDocRoot(
  root: string,
  home: string,
  stateDir: string,
  getAccountHome: () => string = accountHome,
): Promise<void> {
  if (root === parse(root).root) throw new DocRootError("filesystem");
  const homes = new Set([home]);
  try {
    homes.add(getAccountHome());
  } catch {
    // A process without a passwd entry still has its environment home.
  }
  for (const folder of homes) if (inside(root, await checkedFolder(folder))) throw new DocRootError("home");
  const state = await checkedFolder(stateDir);
  if (inside(root, state) || inside(state, root)) throw new DocRootError("state");
}

/** Check stored roots in order before publish reads any document. */
export async function readDocRoots(
  stateDir: string,
  home = homedir(),
  getAccountHome: () => string = accountHome,
): Promise<string[]> {
  const { docRoots } = await readConfig(stateDir);
  const roots: string[] = [];
  for (const entry of docRoots) {
    const refuse = (problem: string) => {
      const escaped = escapeReference(entry);
      return new CliError(
        `docRoots entry ${escaped} ${problem}; remove it with emend config remove docRoots ${quoteShellArgument(entry)}`,
      );
    };
    let actual: string;
    try {
      actual = await realpath(entry);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw refuse("cannot be read");
    }
    if (actual !== entry) throw refuse("is not a real path");
    try {
      await validateDocRoot(actual, home, stateDir, getAccountHome);
    } catch (error) {
      if (error instanceof DocRootError) throw refuse(rootRules[error.reason].publish);
      throw error;
    }
    roots.push(actual);
  }
  return roots;
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

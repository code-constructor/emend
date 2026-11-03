import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { ASSET_EXTENSIONS, FilePath, LIMITS } from "@emend/contract";
import { htmlAssetReferences } from "@emend/core";
import { escapeReference } from "../escape.ts";
import {
  checkPublishedFolders,
  GitFolderRead,
  inside,
  leadingFolders,
  outsideGit,
  type PublishedFolder,
  PublishedFolderEscape,
  readRegular,
} from "./read.ts";

export const assetWarning = (raw: string, reason: string) => `emend: skipped ${escapeReference(raw)}: ${reason}\n`;

export function* assetCandidates(file: string, content: string, warn: (line: string) => void, skipNodeModules = false) {
  const seen = new Set<string>();
  for (const raw of htmlAssetReferences(content)) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const skip = (reason: string) => warn(assetWarning(raw, reason));
    let ref = raw.split(/[?#]/, 1)[0]?.replace(/^(?:\.\/)+/, "") ?? "";
    if (
      !ref ||
      ref.startsWith("/") ||
      ref.includes(":") ||
      ref.split("/").some((s) => s.startsWith(".")) ||
      !FilePath.safeParse(ref).success
    ) {
      skip("not a local visible path");
      continue;
    }
    try {
      ref = decodeURIComponent(ref);
    } catch {
      skip("invalid URL encoding");
      continue;
    }
    if (!FilePath.safeParse(ref).success || ref.split("/").some((s) => s.startsWith(".")) || ref.includes(":")) {
      skip("invalid asset path");
      continue;
    }
    if (skipNodeModules && ref.split("/").includes("node_modules")) continue;
    if (ref === basename(file) || !ASSET_EXTENSIONS.has(extname(ref).slice(1).toLowerCase())) {
      skip("not an asset");
      continue;
    }
    yield { raw, ref, file: join(dirname(file), ref) };
  }
}

export async function collectAssets(
  htmlFile: string,
  warn: (line: string) => void = (line) => process.stderr.write(line),
  html?: string,
  gitDirs: string[] = [],
  skipNodeModules = false,
  publishedFolders: readonly PublishedFolder[] = [],
): Promise<{ ref: string; file: string }[]> {
  const file = await realpath(htmlFile);
  checkPublishedFolders(file, publishedFolders);
  outsideGit(file, gitDirs);
  const folder = dirname(file);
  const content = html ?? (await readRegular(file, LIMITS.htmlDocBytes, [folder], undefined, gitDirs)).toString("utf8");
  const result: { ref: string; file: string }[] = [];
  const accepted = new Set<string>();
  for (const { raw, ref, file: original } of assetCandidates(file, content, warn, skipNodeModules)) {
    const skip = (reason: string) => warn(assetWarning(raw, reason));
    try {
      const actual = await realpath(original);
      checkPublishedFolders(actual, publishedFolders);
      if (skipNodeModules && actual.split(sep).includes("node_modules")) {
        skip("target is in node_modules");
        continue;
      }
      outsideGit(actual, gitDirs, [folder]);
      if (publishedFolders.length && !(await lstat(original)).isFile()) {
        skip("not a regular file");
        continue;
      }
      if (!(await leadingFolders(folder, original))) {
        skip("target is behind a symlink or non-folder");
        continue;
      }
      if (
        !inside(folder, actual) ||
        Array.from(actual).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        relative(folder, actual)
          .split("/")
          .some((s) => s.startsWith("."))
      ) {
        skip("target leaves the visible doc folder");
        continue;
      }
      if (!(await stat(actual)).isFile()) {
        skip("not a regular file");
        continue;
      }
      if (!accepted.has(ref)) {
        accepted.add(ref);
        result.push({ ref, file: original });
      }
    } catch (error) {
      if (error instanceof GitFolderRead || error instanceof PublishedFolderEscape) throw error;
      skip("file does not exist");
    }
  }
  return result;
}

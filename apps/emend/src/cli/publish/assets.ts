import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { ASSET_EXTENSIONS, FilePath, LIMITS } from "@emend/contract";
import { htmlAssetReferences } from "@emend/core";
import { escapeReference } from "../escape.ts";
import { GitFolderRead, inside, leadingFolders, outsideGit, readRegular } from "./read.ts";

export async function collectAssets(
  htmlFile: string,
  warn: (line: string) => void = (line) => process.stderr.write(line),
  html?: string,
  gitDirs: string[] = [],
): Promise<{ ref: string; file: string }[]> {
  const file = await realpath(htmlFile);
  outsideGit(file, gitDirs);
  const folder = dirname(file);
  const content = html ?? (await readRegular(file, LIMITS.htmlDocBytes, [folder], undefined, gitDirs)).toString("utf8");
  const result: { ref: string; file: string }[] = [];
  const seen = new Set<string>();
  const accepted = new Set<string>();
  for (const raw of htmlAssetReferences(content)) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const skip = (reason: string) => warn(`emend: skipped ${escapeReference(raw)}: ${reason}\n`);
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
    if (ref === basename(file) || !ASSET_EXTENSIONS.has(extname(ref).slice(1).toLowerCase())) {
      skip("not an asset");
      continue;
    }
    try {
      const original = join(folder, ref);
      const actual = await realpath(original);
      outsideGit(actual, gitDirs, [folder]);
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
      if (error instanceof GitFolderRead) throw error;
      skip("file does not exist");
    }
  }
  return result;
}

import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { LIMITS, PublishManifest } from "@emend/contract";
import { cleanDocTitle } from "@emend/core";
import { workerExecutor } from "../../server/publish/executor.ts";
import { readDocRoots } from "../config.ts";
import { escapeReference } from "../escape.ts";
import { CliError } from "../http.ts";
import { manifestError } from "./manifest-error.ts";
import { inside, NotRegularFile, outsideGitSegments, type PublishedFolder, sourcePath } from "./read.ts";
import type { publishContext } from "./resolve.ts";
import { isDoc, SHORTCUT_LIMITS, visible, walkDocs } from "./shortcut-walk.ts";

export interface ShortcutOptions {
  paths: string[];
  title?: string;
  main?: string;
  key?: string;
  review?: string;
  new?: boolean;
}

const isHtml = (path: string) => /\.html?$/i.test(path);
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

function entry(paths: string[]): string {
  return (
    (paths.length === 1 ? paths[0] : undefined) ??
    paths.find((path) => path === "index.html") ??
    (paths.filter(isHtml).length === 1 ? paths.find(isHtml) : undefined) ??
    paths.find((path) => path === "index.md") ??
    paths.find((path) => path === "README.md") ??
    (paths.filter(isMarkdown).length === 1 ? paths.find(isMarkdown) : undefined) ??
    paths[0] ??
    ""
  );
}

/** Build an ordinary docs manifest; identity is finalized only when publish knows the instance. */
export async function shortcutManifest(
  options: ShortcutOptions,
  stateDir: string,
  cwd: string,
  context: Awaited<ReturnType<typeof publishContext>>,
) {
  const roots = [...(context.worktree ? [context.worktree] : []), ...(await readDocRoots(stateDir))];
  const checked = async (file: string) => {
    outsideGitSegments(file, context.root);
    try {
      return await sourcePath(file, roots, context.gitDirs);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw new CliError(`doc not found: ${escapeReference(file)}`);
      throw error;
    }
  };
  const inputs = new Set<string>();
  const bases: string[] = [];
  const docs = new Map<string, string>();
  const folders = new Map<string, PublishedFolder[]>();
  const skipped = new Set<string>();
  const skippedArguments: string[] = [];
  const add = (actual: string, source: string) => {
    if (!visible(basename(actual)) || !isDoc(actual)) {
      skipped.add(actual);
      return;
    }
    docs.set(actual, source);
    if (docs.size > LIMITS.filesPerRevision) throw new CliError("too many files in the review");
  };
  const budget = { entries: 0, directories: 0 };
  for (const path of options.paths) {
    const source = resolve(cwd, path);
    const actual = await checked(source);
    const info = await lstat(actual);
    if (info.isFile() && (!visible(basename(actual)) || !isDoc(actual))) {
      skippedArguments.push(path);
      inputs.add(actual);
      continue;
    }
    if (inputs.has(actual)) continue;
    inputs.add(actual);
    if (info.isDirectory()) {
      bases.push(actual);
      await walkDocs(
        actual,
        path,
        checked,
        (file, source) => {
          add(file, source);
          const origins = folders.get(file) ?? [];
          origins.push({ root: actual, argument: path });
          folders.set(file, origins);
        },
        (file) => skipped.add(file),
        budget,
      );
    } else if (info.isFile()) {
      bases.push(dirname(actual));
      // A walked file keeps its regular source and merged boundaries when an alias names it too.
      if (!folders.has(actual)) add(actual, source);
    } else throw new NotRegularFile();
  }
  if (!docs.size) {
    const names = skippedArguments.slice(0, SHORTCUT_LIMITS.warnings).map(escapeReference).join(", ");
    const more = skippedArguments.length - SHORTCUT_LIMITS.warnings;
    throw new CliError(
      `no Markdown or HTML docs to publish${names ? `; skipped ${names}${more > 0 ? ` and ${more} more files` : ""}` : ""}`,
    );
  }
  let base = bases[0] ?? cwd;
  for (const folder of bases) while (!inside(base, folder)) base = dirname(base);
  const reviewPath = (file: string) => relative(base, file).split(sep).join("/");
  const files = [...docs].map(([actual, source]) => ({ path: reviewPath(actual), source, role: "doc" as const }));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let main = entry(files.map((file) => file.path));
  if (options.main !== undefined) {
    const chosen = files.find((file) => file.path === options.main);
    if (chosen) main = chosen.path;
    else {
      const actual = await checked(resolve(cwd, options.main));
      if (!docs.has(actual)) throw new CliError("--main must name a published doc");
      main = reviewPath(actual);
    }
  }
  const givenTitle = cleanDocTitle(options.title ?? "");
  const fallbackTitle = cleanDocTitle(basename(main)) || "Document";
  const titleFromMain = givenTitle
    ? undefined
    : async (bytes: Uint8Array) => {
        const execute = workerExecutor();
        try {
          const result = await execute({
            kind: "doc-metadata",
            format: isHtml(main) ? "html" : "markdown",
            bytes: Uint8Array.from(bytes).buffer,
          });
          return (result.kind === "doc-metadata" && result.title) || fallbackTitle;
        } catch {
          return fallbackTitle;
        } finally {
          await execute.close();
        }
      };
  const parsed = PublishManifest.safeParse(
    {
      version: 1,
      title: givenTitle || fallbackTitle,
      main,
      topics: [],
      files,
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    },
    { reportInput: true },
  );
  if (!parsed.success) throw new CliError(manifestError(parsed.error.issues));
  const paths = [...inputs].sort();
  const key =
    options.key ??
    (options.new
      ? `new:${randomUUID()}`
      : (id: string) =>
          `path:${createHash("sha256")
            .update(JSON.stringify([id, ...paths]))
            .digest("hex")
            .slice(0, 16)}`);
  const docFolders = new Map([...folders].map(([file, origins]) => [reviewPath(file), origins]));
  return {
    manifest: parsed.data,
    key,
    titleFromMain,
    docFolders,
    skippedArguments,
    skipped: [...skipped].map(reviewPath),
  };
}

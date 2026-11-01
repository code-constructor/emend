import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { LIMITS, OTHER_TOPIC, type PublishFile, type PublishManifest, PublishRequest } from "@emend/contract";
import { UnchangedFilesError, withOtherChanges } from "@emend/core";
import { StateFolderWriteError, stateAccessError } from "../../state/files.ts";
import { escapeReference } from "../escape.ts";
import { createGitSession, GitFailed } from "../git.ts";
import { CliError } from "../http.ts";
import { collectAssets } from "./assets.ts";
import { collectChanges } from "./collect.ts";
import { docsKey, normalizeRemote, reviewKey } from "./key.ts";
import { outsideGitSegments, readRegular, sourcePath } from "./read.ts";
import { gitFolders, worktreeRoot } from "./root.ts";
import { readSide } from "./sides.ts";

import type { BlobSource } from "./upload.ts";

export type PublishOptions = { manifest: string; review?: string; key?: string };
async function docRoots(stateDir: string): Promise<string[]> {
  let value: unknown;
  try {
    value = JSON.parse((await readRegular(join(stateDir, "config.json"), LIMITS.publicJsonBytes)).toString());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    const mapped = stateAccessError(stateDir, error);
    if (mapped instanceof StateFolderWriteError) throw mapped;
    throw new CliError("invalid emend configuration");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("docRoots" in value) ||
    !Array.isArray(value.docRoots) ||
    !value.docRoots.every((root) => typeof root === "string" && isAbsolute(root))
  )
    throw new CliError("invalid emend configuration");
  return Promise.all((value.docRoots as string[]).map((root) => realpath(root)));
}
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export async function publishContext(cwd: string) {
  const git = createGitSession();
  const worktree = await worktreeRoot(cwd);
  if (worktree) {
    const configured = await realpath(
      (await git(cwd, ["rev-parse", "--show-toplevel"])).toString().replace(/\r?\n$/, ""),
    );
    if (configured !== worktree) throw new CliError("the repository's worktree is configured elsewhere");
  }
  const root = worktree ?? (await realpath(cwd));
  const gitDirs = worktree ? await gitFolders(worktree, git) : [];
  return { git, worktree, root, gitDirs };
}
export async function resolvePublish(
  manifest: PublishManifest,
  options: PublishOptions,
  stateDir: string,
  instanceId: string | null,
  cwd: string,
  warn: (line: string) => void,
  context?: Awaited<ReturnType<typeof publishContext>>,
) {
  const { git, worktree, root, gitDirs } = context ?? (await publishContext(cwd));
  const code = manifest.base !== undefined;
  if (code && !worktree) throw new CliError("not a git repository");
  const branchName = code ? (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toString().trim() : "HEAD";
  const branch = branchName === "HEAD" ? null : branchName;
  if ((!code || !branch) && !options.review && !options.key) throw new CliError("pass --review or --key");
  let repo: PublishRequest["repo"] = null;
  if (code) {
    let remote: string;
    try {
      remote = (await git(root, ["config", "--get", "remote.origin.url"])).toString().trim();
    } catch (error) {
      if (error instanceof GitFailed && error.exitCode === 1) remote = "";
      else throw error;
    }
    const identity = remote ? normalizeRemote(remote) : (gitDirs.at(-1) ?? root);
    repo = { key: sha256(identity), name: basename(identity) };
  }
  const changes = code ? await collectChanges(root, manifest.base ?? "", manifest.head ?? "", git, warn, gitDirs) : [];
  let grouped: ReturnType<typeof withOtherChanges>;
  try {
    grouped = withOtherChanges(changes, manifest.files);
  } catch (error) {
    if (error instanceof UnchangedFilesError)
      throw new CliError(
        `not changed in ${escapeReference(`${manifest.base}..${manifest.head}`)}: ${error.paths.map(escapeReference).join(", ")}`,
      );
    throw error;
  }
  const topics = [...manifest.topics];
  if (grouped.files.length > LIMITS.filesPerRevision) throw new CliError("too many files in the review");
  if (grouped.other.length)
    topics.push({ ...OTHER_TOPIC, importance: 100, summary: "Changed files not assigned to a declared topic." });
  const blobs = new Map<string, BlobSource>();
  let totalBytes = Buffer.byteLength(JSON.stringify(manifest.writeup));
  if (totalBytes > LIMITS.revisionBytes) throw new CliError("the docs pass the revision size limit");
  const add = (bytes: Buffer, read: BlobSource["read"]) => {
    const hash = sha256(bytes);
    if (!blobs.has(hash)) {
      if (totalBytes + bytes.length > LIMITS.revisionBytes) return null;
      totalBytes += bytes.length;
      blobs.set(hash, { size: bytes.length, read });
    }
    return hash;
  };
  const addRequired = (bytes: Buffer, read: BlobSource["read"]) => {
    const hash = add(bytes, read);
    if (!hash) throw new CliError("the docs pass the revision size limit");
    return hash;
  };
  const ranks = new Map([...manifest.topics].sort((a, b) => a.importance - b.importance).map((t, i) => [t.slug, i]));
  grouped.files.sort((a, b) => {
    if (a.role === "doc" || b.role === "doc") return Number(b.role === "doc") - Number(a.role === "doc");
    return (ranks.get(a.topic ?? "") ?? ranks.size) - (ranks.get(b.topic ?? "") ?? ranks.size);
  });
  const files: PublishFile[] = [];
  let assetCount = 0;
  const assetPaths = new Set<string>();
  const roots = [...(worktree ? [worktree] : []), ...(await docRoots(stateDir))];
  for (const file of grouped.files) {
    if (file.role === "diff") {
      const change = changes.find((c) => c.path === file.path);
      if (!change || !manifest.base || !manifest.head) throw new CliError("diff files require base and head");
      const before = new Set(blobs.keys());
      const beforeBytes = totalBytes;
      const resolved: PublishFile = {
        path: change.path,
        oldPath: change.oldPath,
        status: change.status,
        role: "diff",
        topic: file.topic,
        flag: null,
        oldBlob: null,
        newBlob: null,
      };
      for (const side of ["old", "new"] as const) {
        const head = manifest.head;
        const read = async () => {
          const value = await readSide(root, head, change, side, git, gitDirs);
          if (!value || !("bytes" in value)) throw new CliError("diff changed before upload");
          return value.bytes;
        };
        const value = await readSide(root, head, change, side, git, gitDirs);
        if (!value) continue;
        if ("flag" in value) {
          resolved.flag = value.flag;
          break;
        }
        const hash = add(value.bytes, read);
        if (!hash) {
          resolved.flag = "oversized";
          break;
        }
        resolved[side === "old" ? "oldBlob" : "newBlob"] = hash;
      }
      if (resolved.flag) {
        resolved.oldBlob = resolved.newBlob = null;
        for (const hash of blobs.keys()) if (!before.has(hash)) blobs.delete(hash);
        totalBytes = beforeBytes;
      }
      files.push(resolved);
      continue;
    }
    const original = resolve(root, file.source ?? file.path);
    // Check the written alias here; sourcePath also checks its resolved target.
    outsideGitSegments(original, root);
    const source = await sourcePath(original, roots, gitDirs);
    const html = /\.html?$/i.test(file.path);
    if (!html && !/\.(md|markdown)$/i.test(file.path))
      throw new CliError("doc path must end in .md, .markdown, .html or .htm");
    const checkExtension = (path: string) => {
      if (!(html ? /\.html?$/i : /\.(md|markdown)$/i).test(path))
        throw new CliError("doc source must end in .md, .markdown, .html or .htm, like its path.");
    };
    if (file.source !== undefined) checkExtension(file.source);
    checkExtension(source);
    const readResolvedDoc = (actual: string) =>
      readRegular(actual, html ? LIMITS.htmlDocBytes : LIMITS.markdownDocBytes, roots, undefined, gitDirs);
    const readDoc = async () => {
      const actual = await sourcePath(original, roots, gitDirs);
      checkExtension(actual);
      return readResolvedDoc(actual);
    };
    const bytes = await readResolvedDoc(source);
    const resolvedDoc: PublishFile = {
      path: file.path,
      oldPath: null,
      role: "doc",
      topic: file.topic,
      oldBlob: null,
      newBlob: addRequired(bytes, readDoc),
      flag: null,
      ...(html ? { assets: [] } : {}),
    };
    files.push(resolvedDoc);
    if (!html) continue;
    const assets = await collectAssets(source, warn, bytes.toString(), gitDirs);
    resolvedDoc.assets = assets.map((asset) => posix.join(posix.dirname(file.path), asset.ref));
    let size = bytes.length;
    for (const asset of assets) {
      const info = await stat(asset.file);
      if (info.size > LIMITS.assetBytes) throw new CliError("asset exceeds its size limit");
      size += info.size;
      if (size > LIMITS.htmlDocWithAssetsBytes) throw new CliError("HTML doc and assets exceed their size limit");
    }
    let actualSize = bytes.length;
    for (const asset of assets) {
      const path = posix.join(posix.dirname(file.path), asset.ref);
      if (assetPaths.has(path)) continue;
      assetPaths.add(path);
      if (grouped.files.length + ++assetCount > LIMITS.filesPerRevision)
        throw new CliError("too many files in the review");
      const content = await readRegular(
        await sourcePath(asset.file, [dirname(source)], gitDirs),
        Math.min(LIMITS.assetBytes, LIMITS.htmlDocWithAssetsBytes - actualSize),
        [dirname(source)],
        undefined,
        gitDirs,
      );
      actualSize += content.length;
      files.push({
        path,
        oldPath: null,
        role: "asset",
        parent: file.path,
        oldBlob: null,
        newBlob: addRequired(content, async () =>
          readRegular(
            await sourcePath(asset.file, [dirname(source)], gitDirs),
            LIMITS.assetBytes,
            [dirname(source)],
            undefined,
            gitDirs,
          ),
        ),
        flag: null,
      });
    }
  }
  const keyFor = (id: string) =>
    options.key || !code || !branch ? docsKey(id, options.key ?? options.review ?? "") : reviewKey(id, root, branch);
  const request = PublishRequest.safeParse({
    reviewId: options.review,
    reviewKey: keyFor(instanceId ?? ""),
    repo,
    branch,
    title: manifest.title,
    base: manifest.base ?? null,
    head: manifest.head ?? null,
    main: manifest.main,
    topics,
    writeup: manifest.writeup,
    files,
  });
  if (!request.success) throw new CliError("invalid resolved publish request");
  if (Buffer.byteLength(JSON.stringify(request.data)) > LIMITS.publishJsonBytes)
    throw new CliError("publish request exceeds its size limit");
  return { request: request.data, blobs, forInstance: (id: string) => ({ ...request.data, reviewKey: keyFor(id) }) };
}

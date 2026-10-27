import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LIMITS, PublishManifest, PublishResponse } from "@emend/contract";
import type { Io } from "../../main.ts";
import { escapeReference } from "../escape.ts";
import { apiRequest, CliError, printJson, publishAnswerIncomplete } from "../http.ts";
import { GitFolderRead, inside, readRegular } from "../publish/read.ts";
import { type PublishOptions, publishContext, resolvePublish } from "../publish/resolve.ts";
import { upload } from "../publish/upload.ts";
import { ensureServer } from "../server-client.ts";
import { localTarget } from "../target.ts";

export function parsePublishArgs(args: string[]): PublishOptions {
  const opts: Partial<PublishOptions> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (
      !name ||
      !["--manifest", "--review", "--key"].includes(name) ||
      !value ||
      value.startsWith("--") ||
      value.length > LIMITS.pathChars ||
      Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw new CliError("usage: emend publish --manifest <file> [--review <id>] [--key <name>]");
    const key = name.slice(2) as keyof PublishOptions;
    if (opts[key] !== undefined) throw new CliError("duplicate publish option");
    opts[key] = value;
  }
  if (!opts.manifest) throw new CliError("pass --manifest <file>");
  if (opts.review && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(opts.review))
    throw new CliError("invalid review id");
  return opts as PublishOptions;
}
export const publishTimeoutMs = (files: { role: string; path: string }[]) =>
  30000 +
  15000 +
  10000 * (1 + files.filter((file) => file.role === "doc" && /\.(md|markdown)$/i.test(file.path)).length) +
  3 * 30000;
export async function publishCommand(stateDir: string, args: string[], io: Io, cwd = process.cwd()): Promise<void> {
  const options = parsePublishArgs(args);
  const context = await publishContext(cwd);
  const manifestPath = resolve(cwd, options.manifest);
  const unsafeManifest = new CliError(
    `the manifest ${escapeReference(manifestPath)} can be changed by other users; write it in a private folder`,
  );
  let manifest: PublishManifest;
  try {
    manifest = PublishManifest.parse(
      JSON.parse(
        (
          await readRegular(
            manifestPath,
            LIMITS.publishJsonBytes,
            inside(context.root, manifestPath) ? [context.root] : undefined,
            undefined,
            context.gitDirs,
            async (info, actual) => {
              if (!process.getuid || (context.worktree && inside(context.worktree, actual))) return;
              const uid = process.getuid();
              if (info.uid !== uid || (info.mode & 0o002) !== 0) throw unsafeManifest;
              if ((info.mode & 0o020) !== 0) {
                const folder = await lstat(dirname(actual)).catch(() => {
                  throw unsafeManifest;
                });
                if (!folder.isDirectory() || folder.uid !== uid || (folder.mode & 0o077) !== 0) throw unsafeManifest;
              }
            },
          )
        ).toString(),
      ),
    );
  } catch (error) {
    if (error instanceof GitFolderRead || error === unsafeManifest) throw error;
    throw new CliError("invalid publish manifest");
  }
  if (!manifest.base && !options.key && !options.review) throw new CliError("pass --review or --key");
  // Resolve all paths and unchanged-file checks before creating any server state.
  const warnings: string[] = [];
  const collected = await resolvePublish(
    manifest,
    options,
    stateDir,
    null,
    cwd,
    (line) => warnings.push(line),
    context,
  );
  const server = await ensureServer(stateDir);
  let instanceId: string;
  try {
    const instance = JSON.parse(
      (await readRegular(join(stateDir, "instance.json"), LIMITS.publicJsonBytes)).toString(),
    );
    if (typeof instance.id !== "string" || !/^[a-f0-9-]{36}$/i.test(instance.id)) throw new Error("invalid");
    instanceId = instance.id;
  } catch {
    throw new CliError("invalid emend instance");
  }
  const request = collected.forInstance(instanceId);
  await upload(stateDir, server.url, collected.blobs);
  const result = PublishResponse.safeParse(
    await apiRequest(stateDir, await localTarget(stateDir, server.url), "/publish", {
      method: "POST",
      body: request,
      timeoutMs: publishTimeoutMs(request.files),
    }),
  );
  if (!result.success) throw new CliError(publishAnswerIncomplete);
  await printJson(io, result.data);
  for (const warning of warnings) io.stderr(warning);
  for (const path of result.data.unrendered) io.stderr(`emend: could not render ${escapeReference(path)}\n`);
  io.stderr(`emend: published revision ${result.data.revision}: ${escapeReference(result.data.url)}\n`);
}

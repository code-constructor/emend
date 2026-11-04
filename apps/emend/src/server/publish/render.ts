import { setImmediate } from "node:timers/promises";
import { LIMITS, type PublishRequest } from "@emend/contract";
import { ApiError } from "../http/errors.ts";
import { WorkTimeout } from "./executor.ts";
import { checkPublishSignal } from "./lifecycle.ts";
import { mediaType } from "./media.ts";
import type { Executor, RenderedBytes } from "./work.ts";

export async function renderRevision(
  input: PublishRequest,
  execute: Executor,
  read: (hash: string) => Promise<ArrayBuffer>,
  put: (bytes: Buffer) => Promise<string>,
  signal?: AbortSignal,
  onRendered?: (bytes: number) => void,
) {
  let rendered: RenderedBytes;
  try {
    const media: [string, string][] = [];
    for (const file of input.files)
      if (file.role === "asset" && file.parent === undefined && file.newBlob) media.push([file.path, file.newBlob]);
    const result = await execute({
      kind: "writeup",
      source: input.writeup,
      topics: input.topics,
      links: input.links,
      repoUrl: input.repoUrl,
      media,
    });
    if (result.kind !== "writeup") throw new Error("wrong result");
    rendered = result;
  } catch (error) {
    checkPublishSignal(signal);
    if (error instanceof WorkTimeout) throw new ApiError("too_large", "writeup_timeout");
    throw new ApiError("invalid_request", "writeup_failed");
  }
  const ids = [rendered.ids];
  const renderedBytes = Buffer.from(rendered.bytes);
  onRendered?.(renderedBytes.length);
  let count = rendered.count;
  let bytes = renderedBytes.length;
  if (count > LIMITS.blocksPerRevision || bytes > LIMITS.renderedBytesPerRevision)
    throw new ApiError("too_large", "writeup_blocks");
  // Give the worker reply's allocation/GC turn back before hashing and persisting
  // its bytes; those two individually bounded stretches must not run together.
  await setImmediate();
  checkPublishSignal(signal);
  const renderedBlob = await put(renderedBytes);
  await setImmediate();
  checkPublishSignal(signal);
  // The source blob keeps the publish-level fields beside the writeup so an export and import carry them.
  const sourceBlob = await put(
    Buffer.from(
      JSON.stringify({
        ...input.writeup,
        ...(input.links?.length ? { links: input.links } : {}),
        ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
      }),
    ),
  );
  const cache = new Map<string, string | null>();
  const docBlobs = new Map<string, string>();
  const unrendered: string[] = [];
  let exhausted = false;
  for (const file of input.files) {
    checkPublishSignal(signal);
    if (file.role !== "doc" || !file.newBlob || mediaType(file.path) !== "text/markdown") continue;
    if (exhausted) {
      unrendered.push(file.path);
      continue;
    }
    let result: RenderedBytes;
    const shared = cache.get(file.newBlob);
    if (shared === null) {
      unrendered.push(file.path);
      continue;
    }
    try {
      const rendered = await execute(
        shared === undefined
          ? { kind: "doc", path: file.path, source: await read(file.newBlob), repoUrl: input.repoUrl }
          : { kind: "resection", path: file.path, bytes: await read(shared) },
      );
      if (rendered.kind !== "doc") throw new Error("wrong result");
      result = rendered;
    } catch {
      checkPublishSignal(signal);
      cache.set(file.newBlob, null);
      unrendered.push(file.path);
      continue;
    }
    const json = Buffer.from(result.bytes);
    onRendered?.(json.length);
    if (count + result.count > LIMITS.blocksPerRevision || bytes + json.length > LIMITS.renderedBytesPerRevision) {
      exhausted = true;
      unrendered.push(file.path);
      continue;
    }
    count += result.count;
    bytes += json.length;
    await setImmediate();
    checkPublishSignal(signal);
    const blob = await put(json);
    docBlobs.set(file.path, blob);
    if (shared === undefined) cache.set(file.newBlob, blob);
    ids.push(result.ids);
  }
  return { ids, renderedBlob, sourceBlob, docBlobs, count, unrendered };
}

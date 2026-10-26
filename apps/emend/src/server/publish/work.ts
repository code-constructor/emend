import type { Placement, PlacementLocation, Target, TopicMeta, WriteupInput } from "@emend/contract";
import {
  type Block,
  blockHash,
  composeRenames,
  docText,
  type FileSides,
  type PlaceContext,
  placeThread,
  type RenderedWriteup,
  renderDoc,
  renderWriteup,
  resectionBlocks,
} from "@emend/core";

export type SharedSides = { oldHash?: string; newHash?: string };
export type WorkLast = { location: PlacementLocation; sides?: SharedSides } | null;
export type Work =
  | { kind: "writeup"; source: WriteupInput; topics: TopicMeta[] }
  | { kind: "doc"; path: string; source: ArrayBuffer }
  | { kind: "resection"; path: string; bytes: ArrayBuffer }
  | { kind: "changed"; previous: { format: "writeup" | "doc"; bytes: ArrayBuffer }[]; next: ArrayBuffer[] }
  | {
      kind: "place";
      writeup: string | null;
      docs: Map<string, { kind: "markdown"; hash: string | null } | { kind: "html"; hash: string }>;
      texts: Map<string, ArrayBuffer>;
      files: Map<string, SharedSides>;
      topics: Set<string>;
      threads: {
        id: string;
        target: Target;
        last: WorkLast;
        renames: Map<string, string | null>[];
        carried?: { path: string | null; side?: "old" | "new" };
      }[];
    };
export type WorkResult =
  | ({ kind: "writeup" | "doc" } & RenderedBytes)
  | { kind: "changed"; bytes: ArrayBuffer }
  | { kind: "place"; placements: { id: string; placement: Placement }[] };
export type RenderedBytes = { bytes: ArrayBuffer; ids: ArrayBuffer; count: number };
const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);
const parse = (bytes: ArrayBuffer, format: "writeup" | "doc"): Block[] => {
  const value = JSON.parse(decode(bytes));
  return format === "writeup" ? (value as RenderedWriteup).sections.flatMap((s) => s.blocks) : (value as Block[]);
};
export function serializeRendered(value: RenderedWriteup | Block[]): RenderedBytes {
  const blocks = Array.isArray(value) ? value : value.sections.flatMap((s) => s.blocks);
  return {
    bytes: new TextEncoder().encode(JSON.stringify(value)).buffer,
    ids: new TextEncoder().encode(blocks.map(({ id }) => id).join("\n")).buffer,
    count: blocks.length,
  };
}
export type Executor = (work: Work) => Promise<WorkResult>;
export const executeWork: Executor = async (work) => {
  if (work.kind === "writeup")
    return { kind: "writeup", ...serializeRendered(await renderWriteup(work.source, work.topics)) };
  if (work.kind === "doc")
    return { kind: "doc", ...serializeRendered(await renderDoc(decode(work.source), work.path)) };
  if (work.kind === "resection")
    return {
      kind: "doc",
      ...serializeRendered(resectionBlocks(parse(work.bytes, "doc"), `doc-${await blockHash(work.path)}`)),
    };
  if (work.kind === "changed") {
    const seen = new Set<string>();
    for (const blob of work.previous) for (const block of parse(blob.bytes, blob.format)) seen.add(block.id);
    const changed: string[] = [];
    for (const packed of work.next)
      for (const id of decode(packed).split("\n"))
        if (id && !seen.has(id)) {
          seen.add(id);
          changed.push(id);
        }
    // Newline-delimited JSON strings allow bounded JSON-array inserts without per-id
    // objects or escaping on the main thread. Block IDs never contain newlines.
    return {
      kind: "changed",
      bytes: new TextEncoder().encode(changed.map((id) => JSON.stringify(id)).join("\n")).buffer,
    };
  }
  const docs: PlaceContext["docs"] = new Map();
  const decoded = new Map<string, string>();
  const text = (hash: string) => {
    const cached = decoded.get(hash);
    if (cached !== undefined) return cached;
    const source = work.texts.get(hash);
    if (source === undefined) throw new Error("Missing placement text");
    const value = decode(source);
    decoded.set(hash, value);
    return value;
  };
  const sides = (value: SharedSides): FileSides =>
    ({
      ...(value.oldHash ? { oldHash: value.oldHash, oldText: text(value.oldHash) } : {}),
      ...(value.newHash ? { newHash: value.newHash, newText: text(value.newHash) } : {}),
    }) as FileSides;
  const htmlTexts = new Map<string, string | null>();
  for (const [path, doc] of work.docs) {
    if (doc.kind === "html") {
      if (!htmlTexts.has(doc.hash)) htmlTexts.set(doc.hash, docText(text(doc.hash)));
      docs.set(path, { kind: "html", text: htmlTexts.get(doc.hash) ?? null });
    } else
      docs.set(path, {
        kind: "markdown",
        blocks: doc.hash ? parse(work.texts.get(doc.hash) ?? new ArrayBuffer(0), "doc") : [],
      });
  }
  const writeup = work.writeup ? parse(work.texts.get(work.writeup) ?? new ArrayBuffer(0), "writeup") : [];
  const files = new Map([...work.files].map(([path, value]) => [path, sides(value)]));
  return {
    kind: "place",
    placements: work.threads.map((thread) => {
      if ("path" in thread.target && thread.carried?.path === null)
        return { id: thread.id, placement: { status: "unplaced" as const, reason: "file-gone" as const } };
      const target =
        "path" in thread.target && thread.carried?.path
          ? { ...thread.target, path: thread.carried.path }
          : thread.target;
      const location = thread.last?.location;
      const carriedLocation =
        location && "path" in location && thread.carried?.path ? { ...location, path: thread.carried.path } : location;
      return {
        id: thread.id,
        placement: placeThread(target, {
          writeup,
          docs,
          files,
          topics: work.topics,
          last:
            thread.last && carriedLocation
              ? { location: carriedLocation, sides: thread.last.sides ? sides(thread.last.sides) : undefined }
              : null,
          renamedFrom: thread.renames.length === 1 ? (thread.renames[0] ?? new Map()) : composeRenames(thread.renames),
        }),
      };
    }),
  };
};

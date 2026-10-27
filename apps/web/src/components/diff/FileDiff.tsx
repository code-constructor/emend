import type { FileView, RevisionView, Target, ThreadView } from "@emend/contract";
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { FileDiff as PierreFileDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { useQuery } from "@tanstack/react-query";
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitLines } from "../../../../../packages/core/src/place/linemap.ts";
import { getText } from "../../api/client.ts";
import { useLayout } from "../../lib/layout.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { LineComposer } from "./LineComposer.tsx";
import { linesTarget } from "./linesTarget.ts";
import { type DiffParser, parseOffThread } from "./parse-client.ts";
import { type FileLocation, lineLabel } from "./targets.ts";

export type ParsedDiff = FileDiffMetadata;
type Annotation = DiffLineAnnotation<ReactElement>;
const poolOptions = { workerFactory: () => new DiffWorker(), poolSize: 2 };
const highlighterOptions = { preferredHighlighter: "shiki-js" as const, tokenizeMaxLineLength: 1000 };
export function DiffWorkers({ children, workerFactory }: { children: ReactNode; workerFactory?: () => Worker }) {
  const pool = useMemo(() => (workerFactory ? { ...poolOptions, workerFactory } : poolOptions), [workerFactory]);
  return (
    <WorkerPoolContextProvider poolOptions={pool} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}
export function DiffView({
  fileDiff,
  diffStyle,
  annotations,
  onSelect,
  selected,
  onSlots,
}: {
  fileDiff: ParsedDiff;
  diffStyle: "split" | "unified";
  annotations: Annotation[];
  onSelect: (range: SelectedLineRange | null) => void;
  selected: SelectedLineRange | null;
  onSlots?: (slots: Set<string>) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onSlots || !container.current) return;
    const root = container.current;
    let shadow: ShadowRoot | null | undefined;
    const sync = () => {
      const next = root.querySelector("diffs-container")?.shadowRoot;
      if (next && next !== shadow) {
        shadow = next;
        observer.observe(next, { childList: true, subtree: true, attributes: true, attributeFilter: ["name"] });
      }
      onSlots(
        new Set(
          [...(shadow?.querySelectorAll('slot[name^="annotation-"]') ?? [])].map(
            (slot) => slot.getAttribute("name") ?? "",
          ),
        ),
      );
    };
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    sync();
    return () => {
      observer.disconnect();
      onSlots(new Set());
    };
  }, [onSlots]);
  return (
    <div ref={container}>
      <PierreFileDiff<ReactElement>
        fileDiff={fileDiff}
        options={{
          preferredHighlighter: "shiki-js",
          tokenizeMaxLength: 1000,
          diffStyle,
          lineDiffType: "word",
          overflow: "wrap",
          disableFileHeader: true,
          enableLineSelection: true,
          // Placed comments must also be visible in otherwise collapsed context.
          expandUnchanged: annotations.length > 0,
          onLineSelectionEnd: onSelect,
        }}
        selectedLines={selected}
        lineAnnotations={annotations}
        renderAnnotation={(annotation) => annotation.metadata}
      />
    </div>
  );
}
const lockfiles = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "pubspec.lock",
  "mix.lock",
  "Podfile.lock",
]);
export type DiffContext = {
  reviewId: string;
  revision: number;
  threads: ThreadView[];
  changedBlocks: RevisionView["changedBlocks"];
  active: Target | null;
  onActive: (target: Target | null) => void;
  parser?: DiffParser;
  fileForTarget: (target: FileLocation) => FileView | undefined;
};
export function FileDiff({ file, ...context }: DiffContext & { file: FileView }) {
  const ref = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  const [height, setHeight] = useState(200);
  const [expanded, setExpanded] = useState(false);
  const [slots, setSlots] = useState(new Set<string>());
  const onSlots = useCallback(
    (next: Set<string>) =>
      setSlots((previous) =>
        previous.size === next.size && [...previous].every((name) => next.has(name)) ? previous : next,
      ),
    [],
  );
  const lineThreads = context.threads.flatMap((thread) => {
    if (thread.placement.status !== "placed") return [];
    const location = thread.placement.location;
    return location.kind === "lines" && context.fileForTarget(location)?.id === file.id ? [{ thread, location }] : [];
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (!entry.isIntersecting) setHeight(Math.max(200, element.getBoundingClientRect().height));
        setNear(entry.isIntersecting);
      },
      { root: element.closest("[data-diff-scroll]"), rootMargin: "800px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fileThreads = context.threads.filter(
    (thread) =>
      thread.placement.status === "placed" &&
      thread.placement.location.kind === "file" &&
      context.fileForTarget(thread.placement.location)?.id === file.id,
  );
  const close = () => context.onActive(null);
  const active = context.active;
  const selected = active?.kind === "lines" && context.fileForTarget(active)?.id === file.id ? active : null;
  const mounted = near || !!selected;
  const lockfile = lockfiles.has(file.path.split("/").at(-1) ?? "");
  return (
    <section
      ref={ref}
      data-diff-section
      aria-label={`File ${file.path}`}
      className="my-4 rounded-lg border border-neutral-200 dark:border-neutral-800"
      style={{ minHeight: mounted || file.flag ? undefined : height }}
    >
      <header data-file-header className="space-y-2 p-3">
        <h4 className="break-words font-mono text-sm">{file.path}</h4>
        {file.oldPath && <p className="break-words text-sm">Renamed from {file.oldPath}</p>}
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{file.status}</p>
        <Button onClick={() => context.onActive({ kind: "file", path: file.path })}>Comment on file</Button>
        {active?.kind === "file" && context.fileForTarget(active)?.id === file.id && (
          <Composer
            surface="diff"
            reviewId={context.reviewId}
            revision={context.revision}
            target={active}
            onSaved={close}
            onCancel={close}
          />
        )}
        {fileThreads.map((thread) => (
          <ThreadCard surface="diff" key={thread.id} {...context} thread={thread} />
        ))}
        {lineThreads
          .filter(
            ({ location }) =>
              !slots.has(`annotation-${location.side === "old" ? "deletions" : "additions"}-${location.end}`),
          )
          .map(({ thread, location }) => (
            <div key={thread.id}>
              <p className="text-sm">{lineLabel(location)}</p>
              <ThreadCard surface="diff" {...context} thread={thread} />
            </div>
          ))}
      </header>
      {selected && (
        <LineComposer
          reviewId={context.reviewId}
          revision={context.revision}
          target={selected}
          onSaved={close}
          onCancel={close}
        />
      )}
      {file.flag ? (
        <p className="p-3">{file.flag === "binary" ? "Not shown: binary file" : "Not shown: larger than 1 MiB"}</p>
      ) : lockfile && !expanded ? (
        <Summary text="Collapsed: lockfile" onExpand={() => setExpanded(true)} />
      ) : mounted ? (
        <FileBody
          {...context}
          file={file}
          expanded={expanded}
          slots={slots}
          onSlots={onSlots}
          onExpand={() => setExpanded(true)}
        />
      ) : (
        <p className="p-3 text-sm text-neutral-500">Loads near viewport</p>
      )}
    </section>
  );
}
function Summary({ text, onExpand }: { text: string; onExpand: () => void }) {
  return (
    <div className="space-y-2 p-3">
      <p>{text}</p>
      <Button onClick={onExpand}>Show diff</Button>
    </div>
  );
}
function FileBody({
  file,
  expanded,
  onExpand,
  slots,
  onSlots,
  ...context
}: DiffContext & {
  file: FileView;
  expanded: boolean;
  slots: Set<string>;
  onSlots: (slots: Set<string>) => void;
  onExpand: () => void;
}) {
  const sideQuery = (side: "old" | "new", exists: boolean) => ({
    queryKey: ["file", file.id, side],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      getText(`/api/v1/files/${encodeURIComponent(file.id)}/${side}`, signal),
    staleTime: Infinity,
    enabled: exists,
  });
  const old = useQuery(sideQuery("old", file.hasOld));
  const next = useQuery(sideQuery("new", file.hasNew));
  const ready = (!file.hasOld || old.isSuccess) && (!file.hasNew || next.isSuccess);
  const lines = ready ? splitLines(old.data ?? "").length + splitLines(next.data ?? "").length : 0;
  const collapsed = !expanded && lines > 20000;
  const parsed = useQuery({
    queryKey: ["file-diff", file.id],
    staleTime: Infinity,
    enabled: ready && !collapsed,
    queryFn: ({ signal }) =>
      (context.parser ?? parseOffThread)(
        {
          oldFile: file.hasOld
            ? { name: file.oldPath ?? file.path, contents: old.data ?? "", cacheKey: `${file.id}:old` }
            : null,
          newFile: file.hasNew ? { name: file.path, contents: next.data ?? "", cacheKey: `${file.id}:new` } : null,
        },
        signal,
      ),
  });
  const layout = useLayout();
  const [error, setError] = useState("");
  const active = context.active;
  const selected = active?.kind === "lines" && context.fileForTarget(active)?.id === file.id ? active : null;
  const onSelect = (range: SelectedLineRange | null) => {
    setError("");
    if (!range) {
      context.onActive(null);
      return;
    }
    if (!range.side || (range.endSide && range.endSide !== range.side)) {
      context.onActive(null);
      setError("Select lines on one side.");
      return;
    }
    const side = range.side === "deletions" ? "old" : "new";
    const result = linesTarget(
      file,
      side,
      Math.min(range.start, range.end),
      Math.max(range.start, range.end),
      (side === "old" ? old.data : next.data) ?? "",
    );
    if ("error" in result) {
      context.onActive(null);
      setError(
        result.error === "too-many-lines"
          ? "Select at most 1000 lines."
          : result.error === "too-long"
            ? "This selection is too long. Select fewer lines."
            : "Select valid lines.",
      );
    } else context.onActive(result);
  };
  const grouped = new Map<string, { side: "deletions" | "additions"; lineNumber: number; threads: ThreadView[] }>();
  for (const thread of context.threads) {
    if (thread.placement.status !== "placed") continue;
    const location = thread.placement.location;
    if (location.kind !== "lines" || context.fileForTarget(location)?.id !== file.id) continue;
    const side = location.side === "old" ? "deletions" : "additions";
    const key = `annotation-${side}-${location.end}`;
    const group = grouped.get(key) ?? { side, lineNumber: location.end, threads: [] };
    group.threads.push(thread);
    grouped.set(key, group);
  }
  const annotations: Annotation[] = [...grouped].map(([key, group]) => ({
    side: group.side,
    lineNumber: group.lineNumber,
    metadata: (
      <div>
        {slots.has(key) &&
          group.threads.map((thread) => <ThreadCard surface="diff" key={thread.id} {...context} thread={thread} />)}
      </div>
    ),
  }));
  const selection: SelectedLineRange | null = selected
    ? { side: selected.side === "old" ? "deletions" : "additions", start: selected.start, end: selected.end }
    : null;
  if (old.isError || next.isError || parsed.isError)
    return (
      <div className="p-3">
        <p role="alert">Could not load this diff.</p>
        <Button
          onClick={() => {
            if (old.isError) void old.refetch();
            if (next.isError) void next.refetch();
            if (parsed.isError) void parsed.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (collapsed) return <Summary text={`Collapsed: ${lines} lines`} onExpand={onExpand} />;
  return (
    <div>
      {error && (
        <p role="alert" className="p-3">
          {error}
        </p>
      )}
      {parsed.data ? (
        <DiffWorkers>
          <DiffView
            fileDiff={parsed.data}
            diffStyle={layout === "phone" ? "unified" : "split"}
            annotations={annotations}
            onSlots={onSlots}
            onSelect={onSelect}
            selected={selection}
          />
        </DiffWorkers>
      ) : (
        <p role="status" className="p-3">
          Loading diff…
        </p>
      )}
    </div>
  );
}

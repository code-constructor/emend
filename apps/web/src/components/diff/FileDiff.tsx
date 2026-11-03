import type { FileView, RevisionView, Target, ThreadView } from "@emend/contract";
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  FileDiffOptions,
  GetHoveredLineResult,
  SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff as PierreFileDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { useQuery } from "@tanstack/react-query";
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitLines } from "../../../../../packages/core/src/place/linemap.ts";
import { getText } from "../../api/client.ts";
import { plural } from "../../lib/count.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { annotationExpansions } from "./annotation-expansion.ts";
import { FileHeader } from "./FileHeader.tsx";
import { GutterComment } from "./GutterComment.tsx";
import { LineComposer } from "./LineComposer.tsx";
import { linesTarget } from "./linesTarget.ts";
import { type DiffParser, parseOffThread } from "./parse-client.ts";
import { type DiffCounts, type DiffStyle, diffCounts } from "./presentation.ts";
import { diffShadowCSS } from "./shadow.ts";
import type { FileLocation } from "./targets.ts";
import { diffTheme } from "./theme.ts";

export type ParsedDiff = FileDiffMetadata;
type Annotation = DiffLineAnnotation<ReactElement>;
type BodyState = { diff?: ParsedDiff; blocked: boolean };
type SlotState = { names: Set<string>; rendered: boolean };
const poolOptions = { workerFactory: () => new DiffWorker(), poolSize: 2 };
const highlighterOptions = {
  theme: diffTheme.name,
  preferredHighlighter: "shiki-js" as const,
  tokenizeMaxLineLength: 1000,
};
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
  overflow = "scroll",
  annotations,
  onSelect,
  selected,
  onSlots,
}: {
  fileDiff: ParsedDiff;
  diffStyle: "split" | "unified";
  overflow?: "scroll" | "wrap";
  annotations: Annotation[];
  onSelect: (range: SelectedLineRange | null) => void;
  selected: SelectedLineRange | null;
  onSlots?: (slots: SlotState) => void;
}) {
  const hoveredLine = useRef<GetHoveredLineResult<"diff"> | undefined>(undefined);
  const expansionState = useRef<{
    instance: Parameters<NonNullable<FileDiffOptions<ReactElement, undefined>["onPostRender"]>>[1];
    diff: ParsedDiff;
    counts: Map<string, number>;
  } | null>(null);
  const onPostRender = useCallback<NonNullable<FileDiffOptions<ReactElement, undefined>["onPostRender"]>>(
    (node, instance, phase) => {
      if (phase === "unmount") expansionState.current = null;
      // The initial mount callback can precede async rendering. Once code exists,
      // Pierre has committed its annotation slots in the same render as the lines.
      const rendered = phase !== "unmount" && !!node.shadowRoot?.querySelector("[data-line]");
      if (rendered) {
        if (expansionState.current?.instance !== instance || expansionState.current.diff !== fileDiff)
          expansionState.current = { instance, diff: fileDiff, counts: new Map() };
        const counts = expansionState.current.counts;
        const pending = [];
        for (const [key, expansion] of annotationExpansions(fileDiff, annotations)) {
          const previous = counts.get(key) ?? 0;
          if (expansion.count <= previous) continue;
          // Record before expanding: an unmanaged instance can render synchronously.
          counts.set(key, expansion.count);
          pending.push({ ...expansion, count: expansion.count - previous });
        }
        for (const { index, direction, count } of pending) instance.expandHunk(index, direction, count);
      }
      onSlots?.({
        rendered,
        names: new Set(
          [...(rendered ? (node.shadowRoot?.querySelectorAll('slot[name^="annotation-"]') ?? []) : [])].map(
            (slot) => slot.getAttribute("name") ?? "",
          ),
        ),
      });
    },
    [onSlots, fileDiff, annotations],
  );
  return (
    <div className="em-diff-code">
      <PierreFileDiff<ReactElement>
        className="em-diff-host"
        style={{ colorScheme: "inherit" }}
        fileDiff={fileDiff}
        options={{
          preferredHighlighter: "shiki-js",
          tokenizeMaxLength: 1000,
          diffStyle,
          theme: diffTheme.name,
          themeType: "system",
          lineDiffType: "word",
          diffIndicators: "classic",
          hunkSeparators: "line-info",
          lineHoverHighlight: "both",
          enableGutterUtility: true,
          onLineEnter: ({ lineNumber, annotationSide, numberElement }) => {
            hoveredLine.current = { lineNumber, side: annotationSide };
            // 1.6.1 pins the utility to a selection's end. This pointer affordance
            // belongs to the hovered row even while another composer is open.
            const root = numberElement.getRootNode();
            const utility = root instanceof ShadowRoot ? root.querySelector("[data-gutter-utility-slot]") : null;
            if (utility) numberElement.append(utility);
          },
          onLineLeave: () => {
            hoveredLine.current = undefined;
          },
          unsafeCSS: diffShadowCSS,
          overflow,
          disableFileHeader: true,
          enableLineSelection: true,
          expandUnchanged: false,
          onLineSelectionEnd: onSelect,
          onPostRender,
        }}
        selectedLines={selected}
        lineAnnotations={annotations}
        renderAnnotation={(annotation) => annotation.metadata}
        renderGutterUtility={(getHoveredLine) => (
          <GutterComment getHoveredLine={() => hoveredLine.current ?? getHoveredLine()} onSelect={onSelect} />
        )}
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
  topics?: RevisionView["topics"];
  active: Target | null;
  onActive: (target: Target | null) => void;
  parser?: DiffParser;
  fileForTarget: (target: FileLocation) => FileView | undefined;
  diffStyle: DiffStyle;
  overflow?: "scroll" | "wrap";
  counts: Map<string, DiffCounts>;
  onParsed: (id: string, counts: DiffCounts) => void;
  collapsedFiles: Set<string>;
  toggleFile: (id: string) => void;
  revealedFile?: string;
  onContentRendered: () => void;
};
export function FileDiff({
  file,
  topicCollapsed,
  ...context
}: DiffContext & { file: FileView; topicCollapsed: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  const [height, setHeight] = useState(200);
  const [expanded, setExpanded] = useState(false);
  const [slotState, setSlots] = useState<SlotState>({ names: new Set(), rendered: false });
  const slots = slotState.names;
  const [bodyState, setBodyState] = useState<BodyState>({ blocked: false });
  const onBodyState = useCallback((next: BodyState) => {
    setBodyState((previous) => (previous.diff === next.diff && previous.blocked === next.blocked ? previous : next));
  }, []);
  const onSlots = useCallback(
    (next: SlotState) =>
      setSlots((previous) =>
        previous.rendered === next.rendered &&
        previous.names.size === next.names.size &&
        [...previous.names].every((name) => next.names.has(name))
          ? previous
          : next,
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
  const mounted = near || !!selected || context.revealedFile === file.id;
  const lockfile = lockfiles.has(file.path.split("/").at(-1) ?? "");
  const collapsed = context.collapsedFiles.has(file.id);
  const { onContentRendered } = context;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Navigation retries after the fallback or annotation DOM commits.
  useEffect(() => onContentRendered(), [onContentRendered, slotState, bodyState, mounted, expanded]);
  const slotPending = (side: "old" | "new", end: number) => {
    if (file.flag || (lockfile && !expanded) || bodyState.blocked || slotState.rendered) return false;
    const diff = bodyState.diff;
    // The parser uses complete contents; per-region expansion exposes annotations.
    // Identical files (no hunks) and out-of-range lines have permanent fallbacks.
    return (
      !diff ||
      (diff.hunks.length > 0 && end > 0 && end <= (side === "old" ? diff.deletionLines : diff.additionLines).length)
    );
  };
  return (
    <section
      ref={ref}
      data-diff-section
      aria-label={`File ${file.path}`}
      className="em-diff-file"
      style={{ minHeight: collapsed || topicCollapsed || mounted || file.flag ? undefined : height }}
    >
      <FileHeader
        file={file}
        collapsed={collapsed}
        counts={context.counts.get(file.id)}
        threads={fileThreads.length + lineThreads.length}
        onToggle={() => context.toggleFile(file.id)}
        onComment={() => context.onActive({ kind: "file", path: file.path })}
      />
      <div className="em-diff-discussion">
        {active?.kind === "file" && context.fileForTarget(active)?.id === file.id && (
          <Composer
            surface="diff"
            reviewId={context.reviewId}
            revision={context.revision}
            target={active}
            topics={context.topics}
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
            <div key={thread.id} data-slot-pending={slotPending(location.side, location.end) || undefined}>
              <ThreadCard surface="diff" {...context} thread={thread} />
            </div>
          ))}
      </div>
      {selected && !slots.has(`annotation-${selected.side === "old" ? "deletions" : "additions"}-${selected.end}`) && (
        <div data-slot-pending={slotPending(selected.side, selected.end) || undefined}>
          <LineComposer
            reviewId={context.reviewId}
            revision={context.revision}
            target={selected}
            topics={context.topics}
            onSaved={close}
            onCancel={close}
          />
        </div>
      )}
      {!collapsed && !topicCollapsed && (
        <div className="em-diff-body">
          {file.flag ? (
            <p className="em-diff-summary">
              {file.flag === "binary" ? "Not shown: binary file" : "Not shown: larger than 1 MiB"}
            </p>
          ) : lockfile && !expanded ? (
            <Summary text="Collapsed: lockfile" onExpand={() => setExpanded(true)} />
          ) : mounted ? (
            <FileBody
              {...context}
              file={file}
              expanded={expanded}
              slots={slots}
              onSlots={onSlots}
              onBodyState={onBodyState}
              onExpand={() => setExpanded(true)}
            />
          ) : (
            <p className="em-diff-summary">Loads near viewport</p>
          )}
        </div>
      )}
    </section>
  );
}
function Summary({ text, onExpand }: { text: string; onExpand: () => void }) {
  return (
    <div className="em-diff-summary">
      <p>{text}</p>
      <Button size="sm" variant="ghost" onClick={onExpand}>
        Show diff
      </Button>
    </div>
  );
}
function FileBody({
  file,
  expanded,
  onExpand,
  slots,
  onSlots,
  onBodyState,
  ...context
}: DiffContext & {
  file: FileView;
  expanded: boolean;
  slots: Set<string>;
  onSlots: (slots: SlotState) => void;
  onBodyState: (state: BodyState) => void;
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
  const { onParsed } = context;
  useEffect(() => {
    onBodyState({ diff: parsed.data, blocked: collapsed });
  }, [onBodyState, parsed.data, collapsed]);
  useEffect(() => {
    if (parsed.data) onParsed(file.id, diffCounts(parsed.data));
  }, [file.id, parsed.data, onParsed]);
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
  const selectedKey = selected
    ? `annotation-${selected.side === "old" ? "deletions" : "additions"}-${selected.end}`
    : null;
  if (selected && selectedKey && !grouped.has(selectedKey))
    grouped.set(selectedKey, {
      side: selected.side === "old" ? "deletions" : "additions",
      lineNumber: selected.end,
      threads: [],
    });
  const annotations: Annotation[] = [...grouped].map(([key, group]) => ({
    side: group.side,
    lineNumber: group.lineNumber,
    metadata: (
      <div className="em-diff-annotation">
        {slots.has(key) && (
          <>
            {group.threads.map((thread) => (
              <ThreadCard surface="diff" key={thread.id} {...context} thread={thread} />
            ))}
            {selected && key === selectedKey && (
              <Composer
                surface="diff"
                reviewId={context.reviewId}
                revision={context.revision}
                target={selected}
                topics={context.topics}
                onSaved={() => context.onActive(null)}
                onCancel={() => context.onActive(null)}
              />
            )}
          </>
        )}
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
  if (collapsed) return <Summary text={`Collapsed: ${lines} ${plural(lines, "line")}`} onExpand={onExpand} />;
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
            diffStyle={context.diffStyle}
            overflow={context.overflow}
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

import { type FileView, OTHER_TOPIC, type RevisionView, type Target, type TopicMeta } from "@emend/contract";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { claimDraft } from "../../lib/composer-owner.ts";
import { DiffNavigation, type NavigateDiff } from "../../lib/diff-navigation.ts";
import { draftKey, type SavedDraft } from "../../lib/drafts.ts";
import { useLayout } from "../../lib/layout.ts";
import { rankedTopics } from "../../lib/topics.ts";
import type { ReviewSearch } from "../../router.tsx";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { DiffToolbar } from "./DiffToolbar.tsx";
import type { DiffParser } from "./parse-client.ts";
import { type DiffCounts, scrollDiffTarget, useDiffStyle } from "./presentation.ts";
import { TopicSection } from "./TopicSection.tsx";
import { type FileLocation, isDiffTarget, resolveFile } from "./targets.ts";

export type DiffPaneProps = {
  reviewId: string;
  revision: RevisionView;
  parser?: DiffParser;
  resume?: SavedDraft;
  onResumeEnd?: () => void;
  onRendered?: () => void;
  onNavigator?: (navigate: NavigateDiff | null) => void;
  currentTopic?: string;
  writeupVisible?: boolean;
  search?: ReviewSearch;
};
export function DiffPane({
  reviewId,
  revision,
  parser,
  resume,
  onResumeEnd,
  onRendered,
  onNavigator,
  currentTopic,
  writeupVisible = true,
  search = {},
}: DiffPaneProps) {
  const layout = useLayout();
  const [style, setStyle] = useDiffStyle();
  const [collapsedTopics, setCollapsedTopics] = useState(new Set<string>());
  const [collapsedFiles, setCollapsedFiles] = useState(new Set<string>());
  const [counts, setCounts] = useState(new Map<string, DiffCounts>());
  const [jump, setJump] = useState<FileView | null>(null);
  const [revealedFile, setRevealedFile] = useState<string>();
  const [, setRendered] = useState(0);
  const onContentRendered = useCallback(() => {
    // Wake both the route's pending intent and a composer's deferred focus claim.
    setRendered((value) => value + 1);
    onRendered?.();
  }, [onRendered]);
  const root = useRef<HTMLDivElement>(null);
  const onParsed = useCallback(
    (id: string, count: DiffCounts) =>
      setCounts((previous) => {
        const old = previous.get(id);
        return old?.additions === count.additions && old.deletions === count.deletions
          ? previous
          : new Map(previous).set(id, count);
      }),
    [],
  );
  const toggle = (previous: Set<string>, key: string) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Expansion commits must wake the route's pending scroll retry.
  useEffect(() => {
    // The route's scroll retry relies on topic sections rendering in the same commit as this pane.
    onRendered?.();
  }, [onRendered, collapsedTopics, collapsedFiles, revealedFile]);
  const [active, setActive] = useState<Target | null>(null);
  const onActive = (target: Target | null) => {
    if (target) {
      claimDraft(draftKey(reviewId, target), "diff");
      revealTarget(target);
    }
    if (resume && (!target || draftKey(reviewId, target) !== resume.key)) onResumeEnd?.();
    setActive(target);
  };
  const groups = new Map<string, { topic: TopicMeta; files: FileView[] }>();
  for (const topic of revision.topics.toSorted((a, b) => a.importance - b.importance))
    groups.set(topic.slug, { topic, files: [] });
  const other = groups.get(OTHER_TOPIC.slug) ?? { topic: { ...OTHER_TOPIC, importance: 0, summary: "" }, files: [] };
  other.topic = { ...other.topic, title: OTHER_TOPIC.title };
  groups.delete(OTHER_TOPIC.slug);
  for (const file of revision.files.filter((file) => file.role === "diff").toSorted((a, b) => a.order - b.order)) {
    (groups.get(file.topic ?? "") ?? other).files.push(file);
  }
  if (other.files.length || revision.topics.some((topic) => topic.slug === OTHER_TOPIC.slug))
    groups.set(OTHER_TOPIC.slug, other);
  const resolved = new Map<FileLocation, FileView | undefined>();
  const fileForTarget = (target: FileLocation) => {
    if (!resolved.has(target)) resolved.set(target, resolveFile(revision.files, target));
    return resolved.get(target);
  };
  const topicForFile = (file: FileView) =>
    [...groups.values()].find((group) => group.files.some((item) => item.id === file.id))?.topic.slug;
  const expand = (topic?: string, file?: string) => {
    const changed =
      (!!topic && collapsedTopics.has(topic)) || (!!file && (collapsedFiles.has(file) || revealedFile !== file));
    if (file && revealedFile !== file) setRevealedFile(file);
    if (topic && collapsedTopics.has(topic))
      setCollapsedTopics((previous) => {
        const next = new Set(previous);
        next.delete(topic);
        return next;
      });
    if (file && collapsedFiles.has(file))
      setCollapsedFiles((previous) => {
        const next = new Set(previous);
        next.delete(file);
        return next;
      });
    return changed;
  };
  const revealTarget = (target: FileLocation & { slug?: string }) => {
    const file = fileForTarget(target);
    return expand(target.kind === "topic" ? target.slug : file && topicForFile(file), file?.id);
  };
  const revealResumed = useEffectEvent(revealTarget);
  useEffect(() => {
    if (resume?.target && isDiffTarget(resume.target)) {
      revealResumed(resume.target);
      setActive(resume.target);
    }
  }, [resume]);
  const navigateDiff: NavigateDiff = ({ elementId, element, target, commentId }) => {
    elementId ??= element?.closest("[data-thread-card]")?.id;
    const thread = revision.threads.find(
      (thread) =>
        `diff-thread-${thread.id}` === elementId ||
        (commentId && thread.comments.some((comment) => comment.id === commentId)),
    );
    const location = thread ? (thread.placement.status === "placed" ? thread.placement.location : undefined) : target;
    const file = location
      ? fileForTarget(location)
      : revision.files.find((file) => `diff-file-${file.id}` === elementId);
    const topic =
      location?.kind === "topic"
        ? location.slug
        : file
          ? topicForFile(file)
          : elementId?.startsWith("diff-topic-")
            ? elementId.slice(11)
            : undefined;
    if (expand(topic, file?.id)) return false;
    const id =
      elementId ??
      (thread ? `diff-thread-${thread.id}` : file ? `diff-file-${file.id}` : topic ? `diff-topic-${topic}` : undefined);
    const anchor = element && root.current?.contains(element) ? element : id ? document.getElementById(id) : undefined;
    if (!anchor || !root.current?.contains(anchor) || anchor.closest("[hidden], [data-slot-pending]")) return false;
    scrollDiffTarget(anchor);
    return true;
  };
  useLayoutEffect(() => {
    onNavigator?.(navigateDiff);
    return () => onNavigator?.(null);
  });
  const navigateJump = useEffectEvent(navigateDiff);
  useLayoutEffect(() => {
    if (!jump) return;
    if (navigateJump({ elementId: `diff-file-${jump.id}` })) setJump(null);
  });
  const ranks = new Map(
    rankedTopics(revision.topics.toSorted((a, b) => a.importance - b.importance)).map(({ topic, rank }) => [
      topic.slug,
      rank,
    ]),
  );
  const context = {
    reviewId,
    revision: revision.seq,
    threads: revision.threads,
    changedBlocks: revision.changedBlocks,
    topics: revision.topics,
    active,
    onActive,
    parser,
    fileForTarget,
    diffStyle: layout === "phone" ? ("unified" as const) : style,
    counts,
    onParsed,
    collapsedFiles,
    revealedFile,
    onContentRendered,
    toggleFile: (id: string) => setCollapsedFiles((previous) => toggle(previous, id)),
  };
  const hasSection = (target: { kind: string; slug?: string; path?: string; side?: string }) =>
    target.kind === "topic" ? groups.has(target.slug ?? "") : !!fileForTarget(target);
  const unplaced = revision.threads.filter(
    (thread) =>
      isDiffTarget(thread.target) && (thread.placement.status === "unplaced" || !hasSection(thread.placement.location)),
  );
  return (
    <DiffNavigation value={navigateDiff}>
      <div ref={root} className="em-diff-pane" data-toolbar={layout !== "phone" || undefined}>
        <h2 className="sr-only">Diff</h2>
        {layout !== "phone" && (
          <DiffToolbar
            groups={[...groups.values()]}
            ranks={ranks}
            counts={counts}
            style={style}
            onStyle={setStyle}
            onJump={(file) => {
              setJump(file);
            }}
          />
        )}
        {unplaced.length > 0 && (
          <section aria-label="Unplaced comments" className="mb-5 space-y-3">
            <h3 className="font-semibold">Unplaced comments</h3>
            {unplaced.map((thread) => (
              <ThreadCard key={thread.id} surface="diff" {...context} thread={thread} />
            ))}
          </section>
        )}
        {active && isDiffTarget(active) && !hasSection(active) && (
          <section data-diff-section className="space-y-2">
            <Composer
              surface="diff"
              reviewId={reviewId}
              revision={revision.seq}
              target={active}
              topics={revision.topics}
              onSaved={() => onActive(null)}
              onCancel={() => onActive(null)}
            />
          </section>
        )}
        {!revision.files.some((file) => file.role === "diff") && (
          <p className="mb-4 text-sm text-neutral-500">No changed files.</p>
        )}
        {[...groups.values()].map(({ topic, files }) => (
          <TopicSection
            key={topic.slug}
            {...context}
            topic={topic}
            files={files}
            rank={ranks.get(topic.slug)}
            current={layout !== "phone" && writeupVisible && currentTopic === topic.slug}
            writeupLink={
              (!revision.writeupEmpty || revision.main === "writeup") &&
              topic.slug !== OTHER_TOPIC.slug &&
              (layout === "phone" || !writeupVisible)
                ? `/r/${encodeURIComponent(reviewId)}?tab=writeup${search.rev === undefined ? "" : `&rev=${search.rev}`}#topic-${topic.slug}`
                : undefined
            }
            collapsed={collapsedTopics.has(topic.slug)}
            onToggle={() => setCollapsedTopics((previous) => toggle(previous, topic.slug))}
          />
        ))}
      </div>
    </DiffNavigation>
  );
}
export default DiffPane;

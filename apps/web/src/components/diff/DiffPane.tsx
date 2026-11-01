import { type FileView, OTHER_TOPIC, type RevisionView, type Target, type TopicMeta } from "@emend/contract";
import { useEffect, useState } from "react";
import { claimDraft } from "../../lib/composer-owner.ts";
import { draftKey, type SavedDraft } from "../../lib/drafts.ts";
import { Composer } from "../threads/Composer.tsx";
import { Unplaced } from "../threads/Unplaced.tsx";
import type { DiffParser } from "./parse-client.ts";
import { TopicSection } from "./TopicSection.tsx";
import { type FileLocation, isDiffTarget, resolveFile, targetLabel } from "./targets.ts";

export type DiffPaneProps = {
  reviewId: string;
  revision: RevisionView;
  parser?: DiffParser;
  resume?: SavedDraft;
  onResumeEnd?: () => void;
  onRendered?: () => void;
};
export function DiffPane({ reviewId, revision, parser, resume, onResumeEnd, onRendered }: DiffPaneProps) {
  useEffect(() => {
    // The route's scroll retry relies on topic sections rendering in the same commit as this pane.
    onRendered?.();
  }, [onRendered]);
  const [active, setActive] = useState<Target | null>(null);
  const onActive = (target: Target | null) => {
    if (target) claimDraft(draftKey(reviewId, target), "diff");
    if (resume && (!target || draftKey(reviewId, target) !== resume.key)) onResumeEnd?.();
    setActive(target);
  };
  useEffect(() => {
    if (resume?.target && isDiffTarget(resume.target)) setActive(resume.target);
  }, [resume]);
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
  const context = {
    reviewId,
    revision: revision.seq,
    threads: revision.threads,
    changedBlocks: revision.changedBlocks,
    active,
    onActive,
    parser,
    fileForTarget,
  };
  const hasSection = (target: { kind: string; slug?: string; path?: string; side?: string }) =>
    target.kind === "topic" ? groups.has(target.slug ?? "") : !!fileForTarget(target);
  const unplaced = revision.threads.filter(
    (thread) =>
      isDiffTarget(thread.target) && (thread.placement.status === "unplaced" || !hasSection(thread.placement.location)),
  );
  return (
    <div className="p-5">
      <h2 className="mb-5 font-semibold">Diff</h2>
      {unplaced.length > 0 && (
        <section aria-label="Unplaced comments" className="mb-5 space-y-3">
          <h3 className="font-semibold">Unplaced comments</h3>
          {unplaced.map((thread) => (
            <div key={thread.id}>
              <p className="text-sm">{isDiffTarget(thread.target) ? targetLabel(thread.target) : ""}</p>
              <Unplaced surface="diff" {...context} thread={thread} />
            </div>
          ))}
        </section>
      )}
      {active && isDiffTarget(active) && !hasSection(active) && (
        <section data-diff-section className="space-y-2">
          <p>{targetLabel(active)}</p>
          <Composer
            surface="diff"
            reviewId={reviewId}
            revision={revision.seq}
            target={active}
            onSaved={() => onActive(null)}
            onCancel={() => onActive(null)}
          />
        </section>
      )}
      {!revision.files.some((file) => file.role === "diff") && (
        <p className="mb-4 text-sm text-neutral-500">No changed files.</p>
      )}
      {[...groups.values()].map(({ topic, files }) => (
        <TopicSection key={topic.slug} {...context} topic={topic} files={files} />
      ))}
    </div>
  );
}
export default DiffPane;

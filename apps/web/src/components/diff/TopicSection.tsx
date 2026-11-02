import type { FileView, TopicMeta as Topic } from "@emend/contract";
import { ChevronDown, ChevronRight, FileText, MessageSquarePlus } from "lucide-react";
import { plural } from "../../lib/count.ts";
import { TopicMeta } from "../reading/TopicMeta.tsx";
import { TopicRank } from "../status/TopicRank.tsx";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { type DiffContext, FileDiff } from "./FileDiff.tsx";
import { ThreadCount } from "./ThreadCount.tsx";

export function TopicSection({
  topic,
  files,
  rank,
  current,
  writeupLink,
  collapsed,
  onToggle,
  ...context
}: DiffContext & {
  topic: Topic;
  files: FileView[];
  rank?: number;
  current: boolean;
  writeupLink?: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const active = context.active;
  const close = () => context.onActive(null);
  const threads = context.threads.filter(
    (thread) =>
      thread.placement.status === "placed" &&
      thread.placement.location.kind === "topic" &&
      thread.placement.location.slug === topic.slug,
  );
  const fileIds = new Set(files.map((file) => file.id));
  const threadCount = context.threads.filter((thread) => {
    if (thread.placement.status !== "placed") return false;
    const location = thread.placement.location;
    return location.kind === "topic"
      ? location.slug === topic.slug
      : fileIds.has(context.fileForTarget(location)?.id ?? "");
  }).length;
  return (
    <section
      id={`diff-topic-${topic.slug}`}
      data-diff-section
      data-topic={topic.slug}
      className="em-diff-topic"
      aria-label={`Topic ${topic.title}`}
    >
      <header data-topic-header className="em-topic" aria-current={current ? "true" : undefined}>
        {rank ? (
          <TopicRank rank={rank} current={current} />
        ) : (
          <span
            aria-hidden="true"
            className="inline-grid h-5 min-w-[22px] place-items-center rounded-sm bg-active font-mono text-11 text-fg-3"
          >
            —
          </span>
        )}
        <div className="min-w-0 wrap-anywhere">
          <h3 className="text-fg-1 [font:var(--type-h3)]">{topic.title}</h3>
          {topic.summary && (
            <p className="mt-0.5 whitespace-pre-wrap text-13 leading-[1.45] text-fg-2">{topic.summary}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-fg-3 [font:var(--type-meta)]">
            <TopicMeta topic={topic} note />
            <span>
              {files.length} {plural(files.length, "file")}
            </span>
            <ThreadCount count={threadCount} />
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          {writeupLink && (
            <Button asChild variant="ghost" size="sm" icon={FileText}>
              <a href={writeupLink}>Writeup</a>
            </Button>
          )}
          <IconButton
            label="Comment on topic"
            icon={MessageSquarePlus}
            size="sm"
            onClick={() => context.onActive({ kind: "topic", slug: topic.slug })}
          />
          <IconButton
            label={collapsed ? "Expand topic" : "Collapse topic"}
            icon={collapsed ? ChevronRight : ChevronDown}
            size="sm"
            aria-expanded={!collapsed}
            onClick={onToggle}
          />
        </div>
      </header>
      <div className="em-diff-discussion">
        {active?.kind === "topic" && active.slug === topic.slug && (
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
        {threads.map((thread) => (
          <ThreadCard surface="diff" key={thread.id} {...context} thread={thread} />
        ))}
      </div>
      <div hidden={collapsed} className="px-3 pb-3">
        {files.map((file) => (
          <FileDiff key={file.id} file={file} topicCollapsed={collapsed} {...context} />
        ))}
      </div>
    </section>
  );
}

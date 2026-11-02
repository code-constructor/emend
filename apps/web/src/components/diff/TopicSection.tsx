import type { FileView, TopicMeta } from "@emend/contract";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { type DiffContext, FileDiff } from "./FileDiff.tsx";

export function TopicSection({ topic, files, ...context }: DiffContext & { topic: TopicMeta; files: FileView[] }) {
  const active = context.active;
  const close = () => context.onActive(null);
  const threads = context.threads.filter(
    (thread) =>
      thread.placement.status === "placed" &&
      thread.placement.location.kind === "topic" &&
      thread.placement.location.slug === topic.slug,
  );
  return (
    <section
      id={`diff-topic-${topic.slug}`}
      data-diff-section
      data-topic={topic.slug}
      className="mb-6"
      aria-label={`Topic ${topic.title}`}
    >
      <header data-topic-header className="space-y-2">
        <h3 className="font-semibold">{topic.title}</h3>
        {topic.summary && <p className="whitespace-pre-wrap break-words text-sm">{topic.summary}</p>}
        {topic.door && <p className="text-sm">{topic.door === "one-way" ? "One-way door" : "Two-way door"}</p>}
        {topic.blastRadius && (
          <div className="text-sm">
            <p>Blast radius: {topic.blastRadius.scope}</p>
            <p className="whitespace-pre-wrap break-words">{topic.blastRadius.note}</p>
          </div>
        )}
        <Button onClick={() => context.onActive({ kind: "topic", slug: topic.slug })}>Comment on topic</Button>
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
      </header>
      {files.map((file) => (
        <FileDiff key={file.id} file={file} {...context} />
      ))}
    </section>
  );
}

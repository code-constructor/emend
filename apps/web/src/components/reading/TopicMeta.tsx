import type { TopicMeta as Topic } from "@emend/contract";
import { AttentionChip } from "./TopicChips.tsx";

export function TopicMeta({ topic, note = false }: { topic: Topic; note?: boolean }) {
  return (
    <>
      <AttentionChip attention={topic.attention} />
      {topic.door && (
        <span className={topic.door === "one-way" ? "font-medium text-warning-fg" : undefined}>
          {topic.door === "one-way" ? "One-way door" : "Two-way door"}
        </span>
      )}
      {topic.blastRadius && (
        <span className="min-w-0 wrap-anywhere">
          Blast radius{" "}
          <span className="font-mono text-[11.5px] font-stretch-mono text-fg-2">{topic.blastRadius.scope}</span>
          {note && topic.blastRadius.note && <> · {topic.blastRadius.note}</>}
        </span>
      )}
    </>
  );
}

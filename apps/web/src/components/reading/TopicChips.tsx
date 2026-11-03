import type { TopicMeta } from "@emend/contract";

export function AttentionChip({ attention }: { attention: TopicMeta["attention"] }) {
  return attention ? (
    <span className="em-topic-chip" data-attention={attention}>
      {attention.toUpperCase()}
    </span>
  ) : null;
}

export function TopicChips({ topic }: { topic: TopicMeta }) {
  return (
    <>
      <AttentionChip attention={topic.attention} />
      {topic.door && (
        <span className="em-topic-chip" data-door={topic.door}>
          {topic.door.toUpperCase()}
        </span>
      )}
    </>
  );
}

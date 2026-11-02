import type { RenderedWriteup, RevisionView } from "@emend/contract";
import { rankedTopics } from "../../lib/topics.ts";
import type { ReviewSearch } from "../../router.tsx";
import { TopicRank } from "../status/TopicRank.tsx";
import { BlockReader, type ReaderGroup, type ReaderProps } from "./BlockReader.tsx";
import { TopicMeta } from "./TopicMeta.tsx";
import { TopicsMap } from "./TopicsMap.tsx";

export function Writeup({
  writeup,
  topics = [],
  files = [],
  search = {},
  phone = false,
  ...props
}: ReaderProps & {
  writeup: RenderedWriteup;
  topics?: RevisionView["topics"];
  files?: RevisionView["files"];
  search?: ReviewSearch;
  phone?: boolean;
}) {
  const ranked = rankedTopics(topics);
  const bySlug = new Map(ranked.map((entry) => [entry.topic.slug, entry]));
  const counts = new Map<string, number>();
  for (const file of files) {
    if (file.role === "diff" && file.topic) counts.set(file.topic, (counts.get(file.topic) ?? 0) + 1);
  }
  const fileCount = (slug: string) => counts.get(slug) ?? 0;
  const link = (hash: string, diff = false) => {
    const next = { tab: diff && phone ? "diff" : search.tab, rev: search.rev };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value !== undefined) params.set(key, String(value));
    return `/r/${encodeURIComponent(props.reviewId)}${params.size ? `?${params}` : ""}#${hash}`;
  };
  const groups: ReaderGroup[] = [];
  for (const section of writeup.sections) {
    const entry = section.topic ? bySlug.get(section.topic) : undefined;
    if (!entry) {
      groups.push({ key: section.key, heading: section.label, blocks: section.blocks });
      continue;
    }
    const { topic, rank } = entry;
    let group = groups.at(-1);
    if (group?.id !== `topic-${topic.slug}`) {
      group = {
        key: section.key,
        id: `topic-${topic.slug}`,
        topic: true,
        heading: (
          <>
            <TopicRank rank={rank} />
            <span>
              <span className="sr-only">Topic {rank}: </span>
              {topic.title}
            </span>
          </>
        ),
        blocks: [],
        subsections: [],
        action: fileCount(topic.slug) > 0 && (
          <a
            href={link(`diff-topic-${topic.slug}`, true)}
            aria-label={`Files in diff: ${topic.title}`}
            className="ml-auto whitespace-nowrap text-12 text-fg-3 hover:text-link"
          >
            Files in diff <span aria-hidden="true">→</span>
          </a>
        ),
        meta: (topic.door || topic.blastRadius) && (
          <div className="-mt-0.5 mb-4 flex flex-wrap gap-x-3 gap-y-1 text-fg-3 [font:var(--type-meta)]">
            <TopicMeta topic={topic} note />
          </div>
        ),
      };
      groups.push(group);
    }
    const suffix = section.key.slice(section.key.lastIndexOf("-") + 1);
    const heading = suffix === "why" ? "Why" : suffix === "example" ? "Example" : "Details";
    group.subsections?.push({ key: section.key, heading, blocks: section.blocks });
  }
  if (ranked.length) {
    const written = new Set(groups.flatMap((group) => (group.id ? [group.id] : [])));
    const afterIntro = groups.findLastIndex((group) => group.key === "overview" || group.key === "tldr") + 1;
    groups.splice(afterIntro, 0, {
      key: "topics-map",
      heading: "Topics",
      blocks: [],
      content: (
        <TopicsMap
          topics={ranked}
          fileCount={fileCount}
          href={(slug) =>
            written.has(`topic-${slug}`)
              ? link(`topic-${slug}`)
              : fileCount(slug) > 0
                ? link(`diff-topic-${slug}`, true)
                : undefined
          }
        />
      ),
    });
  }
  return <BlockReader {...props} topics={topics} groups={groups} />;
}

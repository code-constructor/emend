import type { PublishLinks, TopicMeta, WriteupInput } from "@emend/contract";
import type { Block } from "./blocks.ts";
import { renderMarkdownWithBudget } from "./markdown.ts";

export type RenderedWriteup = {
  sections: { key: string; label: string; topic: string | null; blocks: Block[] }[];
  /** Publish-level links and the repo base, kept beside the sections in the stored blob. */
  links?: PublishLinks;
  repoUrl?: string;
};

const unwrittenDecisions =
  "Decisions and drift: not written. Only the session where the change was asked for can tell what drifted from it.";

/** `meta.media` maps declared media paths to their SHA-256; only those paths resolve as images. */
export async function renderWriteup(
  writeup: WriteupInput,
  topics: TopicMeta[],
  meta: { links?: PublishLinks; repoUrl?: string; media?: ReadonlyMap<string, string> } = {},
): Promise<RenderedWriteup> {
  const sections: RenderedWriteup["sections"] = [];
  const highlightBudget = { highlightedBytes: 0 };
  const append = async (key: string, label: string, markdown: string | undefined, topic: string | null = null) => {
    if (markdown === undefined) return;
    sections.push({
      key,
      label,
      topic,
      blocks: await renderMarkdownWithBudget(markdown, key, highlightBudget, meta.repoUrl, meta.media),
    });
  };
  await append("overview", "Overview", writeup.overview);
  await append("tldr", "TL;DR", writeup.tldr);
  await append("decisions", "Decisions and drift", writeup.decisions ?? unwrittenDecisions);
  await append("glossary", "Glossary", writeup.glossary);
  // ECMAScript's stable sort preserves manifest order for equal importance.
  for (const topic of topics.toSorted((a, b) => a.importance - b.importance)) {
    if (!Object.hasOwn(writeup.topics, topic.slug)) continue;
    const content = writeup.topics[topic.slug];
    if (!content) continue;
    await append(`t-${topic.slug}-why`, `${topic.title} — Why`, content.why, topic.slug);
    await append(`t-${topic.slug}-example`, `${topic.title} — Example`, content.example, topic.slug);
    await append(`t-${topic.slug}-body`, `${topic.title} — Details`, content.body, topic.slug);
  }
  return {
    sections,
    ...(meta.links?.length ? { links: meta.links } : {}),
    ...(meta.repoUrl ? { repoUrl: meta.repoUrl } : {}),
  };
}

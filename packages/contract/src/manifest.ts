import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { FilePath, OTHER_TOPIC, TopicMeta, TopicSlug } from "./review.ts";

const encoder = new TextEncoder();
const markdown = z
  .string()
  .refine(
    (text) => encoder.encode(text).byteLength <= LIMITS.writeupSectionBytes,
    "writeup section exceeds the UTF-8 byte limit",
  );

export const WriteupInput = z
  .object({
    overview: markdown,
    tldr: markdown,
    decisions: markdown.nullable(),
    glossary: markdown.optional(),
    topics: z
      .record(TopicSlug, z.object({ why: markdown, example: markdown.optional(), body: markdown.optional() }))
      .refine((topics) => Object.keys(topics).length <= LIMITS.topicsPerReview, "too many writeup topics")
      .transform((topics) => Object.assign(Object.create(null) as typeof topics, topics)),
  })
  .refine((writeup) => {
    const sections = [writeup.overview, writeup.tldr, writeup.decisions, writeup.glossary];
    for (const topic of Object.values(writeup.topics)) sections.push(topic.why, topic.example, topic.body);
    return (
      sections.reduce((bytes, section) => bytes + encoder.encode(section ?? "").byteLength, 0) <= LIMITS.writeupBytes
    );
  }, "writeup exceeds the total UTF-8 byte limit");
export type WriteupInput = z.infer<typeof WriteupInput>;

const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a full commit hash");
const source = z
  .string()
  .min(1)
  .max(LIMITS.pathChars)
  .refine((path) => path.isWellFormed(), "source must be well-formed UTF-16")
  .refine(
    (path) => !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    "source must not contain control characters",
  );

export const PublishManifest = z
  .object({
    version: z.literal(1),
    title: z
      .string()
      .min(1)
      .max(LIMITS.titleChars)
      .refine((title) => /\S/.test(title), "title must not be blank"),
    base: commit.optional(),
    head: z.union([commit, z.literal("worktree")]).optional(),
    topics: z.array(TopicMeta).max(LIMITS.topicsPerReview),
    files: z
      .array(
        z.object({
          path: FilePath,
          role: z.enum(["diff", "doc"]),
          topic: TopicSlug.optional(),
          source: source.optional(),
        }),
      )
      .max(LIMITS.filesPerRevision),
    writeup: WriteupInput,
  })
  .superRefine((manifest, ctx) => {
    if ((manifest.base === undefined) !== (manifest.head === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [manifest.base === undefined ? "base" : "head"],
        message: "base and head must be supplied together",
      });
    }
    const topics = new Set<string>();
    for (const [index, topic] of manifest.topics.entries()) {
      if (topic.slug === OTHER_TOPIC.slug) {
        ctx.addIssue({ code: "custom", path: ["topics", index, "slug"], message: "topic slug other is reserved" });
      }
      if (topics.has(topic.slug)) {
        ctx.addIssue({ code: "custom", path: ["topics", index, "slug"], message: "duplicate topic slug" });
      }
      topics.add(topic.slug);
    }
    const paths = new Set<string>();
    for (const [index, file] of manifest.files.entries()) {
      const key = `${file.role}:${file.path}`;
      if (paths.has(key)) {
        ctx.addIssue({ code: "custom", path: ["files", index, "path"], message: "duplicate file path" });
      }
      paths.add(key);
      if (file.topic !== undefined && !topics.has(file.topic)) {
        ctx.addIssue({ code: "custom", path: ["files", index, "topic"], message: "file topic is not declared" });
      }
    }
    for (const slug of Object.keys(manifest.writeup.topics)) {
      if (!topics.has(slug)) {
        ctx.addIssue({ code: "custom", path: ["writeup", "topics", slug], message: "writeup topic is not declared" });
      }
    }
  });
export type PublishManifest = z.infer<typeof PublishManifest>;

import { z } from "zod";
import { LIMITS } from "./limits.ts";

export const FileRole = z.enum(["diff", "doc", "asset"]);
export type FileRole = z.infer<typeof FileRole>;

export const FileStatus = z.enum(["added", "modified", "deleted", "renamed", "mode-changed"]);
export type FileStatus = z.infer<typeof FileStatus>;

export const FileFlag = z.enum(["binary", "oversized"]);
export type FileFlag = z.infer<typeof FileFlag>;

export const FilePath = z
  .string()
  .min(1)
  .max(LIMITS.pathChars)
  .refine((path) => path.isWellFormed(), "path must be well-formed UTF-16")
  .refine(
    (path) => path.split("/").every((part) => part.length <= LIMITS.pathSegmentChars),
    "path segment exceeds the character limit",
  )
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !/^[a-z]:/i.test(path) &&
      !path.includes("\\") &&
      !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "expected a relative path without traversal or control characters",
  );
export type FilePath = z.infer<typeof FilePath>;

export const TopicSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type TopicSlug = z.infer<typeof TopicSlug>;

export const OTHER_TOPIC = { slug: "other", title: "Other changes" } as const;

export const TopicMeta = z.object({
  slug: TopicSlug,
  title: z
    .string()
    .min(1)
    .max(LIMITS.titleChars)
    .refine((title) => /\S/.test(title), "title must not be blank"),
  importance: z.number().min(0).max(100),
  summary: z.string().max(LIMITS.summaryChars),
  door: z.enum(["one-way", "two-way"]).optional(),
  blastRadius: z
    .object({
      scope: z.string().max(LIMITS.blastScopeChars).regex(/^\S+$/, "scope must be one word"),
      note: z
        .string()
        .max(LIMITS.blastNoteChars)
        .refine((note) => /\S/.test(note), "note must not be empty"),
    })
    .optional(),
});
export type TopicMeta = z.infer<typeof TopicMeta>;

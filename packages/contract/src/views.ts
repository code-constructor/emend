import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { FilePath } from "./review.ts";

export const PublishResponse = z.object({
  reviewId: z.uuid(),
  revision: z.int().positive(),
  url: z.url({ protocol: /^https?$/ }).max(LIMITS.pathChars),
  placed: z.int().nonnegative(),
  unplaced: z.int().nonnegative(),
  unrendered: z.array(FilePath).max(LIMITS.filesPerRevision).default([]),
});
export type PublishResponse = z.infer<typeof PublishResponse>;

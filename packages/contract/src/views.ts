import { z } from "zod";
import { LIMITS } from "./limits.ts";

export const PublishResponse = z.object({
  reviewId: z.uuid(),
  revision: z.int().positive(),
  url: z.url({ protocol: /^https?$/ }).max(LIMITS.pathChars),
  placed: z.int().nonnegative(),
  unplaced: z.int().nonnegative(),
});
export type PublishResponse = z.infer<typeof PublishResponse>;

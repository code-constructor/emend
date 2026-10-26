import { z } from "zod";
import { LIMITS } from "./limits.ts";

export const ThreadState = z.enum(["open", "sent", "answered", "resolved"]);
export type ThreadState = z.infer<typeof ThreadState>;

export const Outcome = z.enum(["fixed", "explained", "held", "declined"]);
export type Outcome = z.infer<typeof Outcome>;

export const CommentBody = z
  .string()
  .min(1)
  .max(LIMITS.commentBodyChars)
  .refine((body) => /\S/.test(body), "comment body must not be blank");
export type CommentBody = z.infer<typeof CommentBody>;

export const ReplyRequest = z.object({ outcome: Outcome, body: CommentBody });
export type ReplyRequest = z.infer<typeof ReplyRequest>;

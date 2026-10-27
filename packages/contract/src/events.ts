import { z } from "zod";

export const ReviewEventName = z.enum(["publish", "send", "thread", "waiting"]);
export type ReviewEventName = z.infer<typeof ReviewEventName>;
const review = { reviewId: z.uuid(), revision: z.int().positive() };
export const ReviewEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("publish"), ...review }),
  z.object({ type: z.literal("send"), ...review, sendId: z.uuid() }),
  z.object({ type: z.literal("thread"), ...review, threadId: z.uuid(), commentId: z.uuid().optional() }),
  z.object({ type: z.literal("waiting"), ...review }),
]);
export type ReviewEvent = z.infer<typeof ReviewEvent>;

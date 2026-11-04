import { z } from "zod";

export const ReviewEventName = z.enum([
  "publish",
  "send",
  "thread",
  "waiting",
  "claimed",
  "confirmed",
  "viewed",
  "snooze",
  "unsnooze",
  "retire",
  "reopen",
  "delete",
]);
export type ReviewEventName = z.infer<typeof ReviewEventName>;
const review = { reviewId: z.uuid(), revision: z.int().positive() };
export const ReviewEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("publish"), ...review }),
  z.object({ type: z.literal("send"), ...review, sendId: z.uuid() }),
  z.object({ type: z.literal("thread"), ...review, threadId: z.uuid(), commentId: z.uuid().optional() }),
  z.object({ type: z.literal("waiting"), ...review }),
  z.object({ type: z.literal("claimed"), ...review }),
  z.object({ type: z.literal("confirmed"), ...review, deliveryId: z.uuid() }),
  z.object({ type: z.literal("viewed"), reviewId: z.uuid() }),
  z.object({ type: z.literal("snooze"), ...review }),
  z.object({ type: z.literal("unsnooze"), ...review }),
  z.object({ type: z.literal("retire"), ...review }),
  z.object({ type: z.literal("reopen"), ...review }),
  z.object({ type: z.literal("delete"), ...review }),
]);
export type ReviewEvent = z.infer<typeof ReviewEvent>;

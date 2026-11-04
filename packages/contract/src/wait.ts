import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { Placement } from "./placement.ts";
import { GoMode, MODE_LABELS } from "./send.ts";
import { Target } from "./target.ts";
import { CommentBody, Outcome } from "./thread.ts";

export const LEASE_SECONDS = 120;
export const MAX_TAKE_WAIT_SECONDS = 25;

/** Result kinds a client announces it can parse, beyond go, approve and pending. */
export const TakeAccept = z.enum(["closed"]);
export type TakeAccept = z.infer<typeof TakeAccept>;

export const TakeRequest = z.object({
  accepts: z.array(TakeAccept).max(4).optional(),
  waitSeconds: z.number().min(0).max(MAX_TAKE_WAIT_SECONDS).default(0),
  maxBytes: z.int().min(65536).max(LIMITS.handoffBytes).optional(),
});
export type TakeRequest = z.infer<typeof TakeRequest>;

export const HandoffComment = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  target: Target,
  placement: Placement,
  body: CommentBody,
  historyTrimmed: z
    .boolean()
    .optional()
    .describe("Some history was left out, by the per-comment cap or the byte budget"),
  history: z
    .array(z.object({ author: z.enum(["user", "agent"]), body: CommentBody, outcome: Outcome.optional() }))
    .max(LIMITS.historyPerComment)
    .describe("The newest eligible entries before this comment, in oldest-first insertion order"),
});
export type HandoffComment = z.infer<typeof HandoffComment>;

export const WaitResult = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("go"),
      reviewId: z.uuid(),
      deliveryId: z.uuid(),
      revision: z.int().positive(),
      sentOn: z.int().positive(),
      mode: GoMode,
      modeLabel: z.enum(Object.values(MODE_LABELS)),
      instructions: z.array(z.string().max(LIMITS.instructionChars)).max(LIMITS.instructionsPerHandoff),
      approvalSetAside: z.boolean(),
      comments: z.array(HandoffComment).max(LIMITS.commentsPerHandoff),
    })
    .superRefine((result, ctx) => {
      if (result.modeLabel !== MODE_LABELS[result.mode]) {
        ctx.addIssue({ code: "custom", path: ["modeLabel"], message: "modeLabel must match mode" });
      }
      if (result.sentOn > result.revision) {
        ctx.addIssue({ code: "custom", path: ["sentOn"], message: "sentOn cannot be newer than revision" });
      }
    }),
  z.object({ kind: z.literal("approve"), reviewId: z.uuid(), deliveryId: z.uuid(), revision: z.int().positive() }),
  z.object({ kind: z.literal("pending"), reviewId: z.uuid(), waitedSeconds: z.number().nonnegative() }),
  // Keep pending third: callers read its shape through WaitResult.options[2].
  z
    .object({
      kind: z.literal("closed"),
      reviewId: z.uuid(),
      deliveryId: z.uuid(),
      revision: z.int().positive(),
      reason: z.enum(["retired", "snoozed"]),
      until: z.iso.datetime().nullable(),
    })
    .superRefine((result, ctx) => {
      if (result.reason === "retired" && result.until !== null)
        ctx.addIssue({ code: "custom", path: ["until"], message: "until must be null when retired" });
    }),
]);
export type WaitResult = z.infer<typeof WaitResult>;

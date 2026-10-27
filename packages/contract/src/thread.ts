import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { Target } from "./target.ts";

export const ThreadState = z.enum(["open", "sent", "answered", "resolved"]);
export type ThreadState = z.infer<typeof ThreadState>;

export const Outcome = z.enum(["fixed", "explained", "held", "declined"]);
export type Outcome = z.infer<typeof Outcome>;

export const CommentBody = z
  .string()
  .min(1)
  .max(LIMITS.commentBodyChars)
  .refine((body) => body.isWellFormed(), "comment body must be well-formed UTF-16")
  .refine((body) => /\S/.test(body), "comment body must not be blank");
export type CommentBody = z.infer<typeof CommentBody>;

export const ReplyRequest = z.object({ outcome: Outcome, body: CommentBody });
export type ReplyRequest = z.infer<typeof ReplyRequest>;

export const CreateThreadRequest = z.object({ revision: z.int().positive(), target: Target, body: CommentBody });
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;
export const AddCommentRequest = z.object({ body: CommentBody });
export type AddCommentRequest = z.infer<typeof AddCommentRequest>;
export const EditCommentRequest = AddCommentRequest;
export type EditCommentRequest = z.infer<typeof EditCommentRequest>;
export const ThreadCreated = z.object({ threadId: z.uuid(), commentId: z.uuid() });
export type ThreadCreated = z.infer<typeof ThreadCreated>;
export const CommentCreated = z.object({ commentId: z.uuid() });
export type CommentCreated = z.infer<typeof CommentCreated>;
export const ReplyCreated = z.object({ commentId: z.uuid(), threadId: z.uuid(), state: ThreadState });
export type ReplyCreated = z.infer<typeof ReplyCreated>;

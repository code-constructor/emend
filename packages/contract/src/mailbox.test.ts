import { expect, test } from "vitest";
import {
  AddCommentRequest,
  CommentCreated,
  CreateThreadRequest,
  EditCommentRequest,
  HandoffComment,
  LIMITS,
  ReviewEvent,
  SendCreated,
  TakeRequest,
  ThreadCreated,
  UnplacedReason,
} from "./index.ts";

const id = "11111111-1111-4111-8111-111111111111";
test("handoffs have a byte budget, optional history truncation, and an absent-placement reason", () => {
  expect(LIMITS.handoffBytes).toBe(16777216);
  expect(LIMITS.waitingTakesPerOwner).toBe(32);
  expect(UnplacedReason.parse("not-placed")).toBe("not-placed");
  const comment = {
    id,
    threadId: id,
    target: { kind: "review" },
    placement: { status: "unplaced", reason: "not-placed" },
    body: "Note",
    history: [],
    historyTrimmed: true,
  };
  expect(HandoffComment.parse(comment)).toEqual(comment);
  expect(HandoffComment.safeParse({ ...comment, historyTrimmed: "true" }).success).toBe(false);
});
test("take defaults to an immediate poll and bounds the wait", () => {
  expect(TakeRequest.parse({})).toEqual({ waitSeconds: 0 });
  expect(TakeRequest.parse({ waitSeconds: 25 })).toEqual({ waitSeconds: 25 });
  for (const waitSeconds of [-1, 26, Infinity, "1"]) expect(TakeRequest.safeParse({ waitSeconds }).success).toBe(false);
});
test("take optionally narrows the handoff byte budget within the public bounds", () => {
  for (const maxBytes of [65536, 3145728, LIMITS.handoffBytes]) {
    expect(TakeRequest.parse({ maxBytes })).toEqual({ waitSeconds: 0, maxBytes });
  }
  for (const maxBytes of [0, 65535, LIMITS.handoffBytes + 1, 65536.5, Infinity, "65536", null]) {
    expect(TakeRequest.safeParse({ maxBytes }).success).toBe(false);
  }
});
test("thread and comment requests validate bodies and targets", () => {
  expect(CreateThreadRequest.parse({ revision: 1, target: { kind: "review" }, body: " note " }).body).toBe(" note ");
  for (const schema of [AddCommentRequest, EditCommentRequest]) {
    expect(schema.parse({ body: "note", ownerId: id })).toEqual({ body: "note" });
    expect(schema.safeParse({ body: " " }).success).toBe(false);
  }
  expect(CreateThreadRequest.safeParse({ revision: 0, target: { kind: "review" }, body: "note" }).success).toBe(false);
  expect(
    CreateThreadRequest.safeParse({ revision: 1, target: { kind: "file", path: "../bad" }, body: "note" }).success,
  ).toBe(false);
  expect(ThreadCreated.parse({ threadId: id, commentId: id })).toEqual({ threadId: id, commentId: id });
  expect(CommentCreated.parse({ commentId: id })).toEqual({ commentId: id });
  expect(SendCreated.parse({ sendId: id })).toEqual({ sendId: id });
});
test("events contain only their discriminator, ids and revision sequence", () => {
  for (const type of ["publish", "send", "thread", "waiting"]) {
    const value = {
      type,
      reviewId: id,
      revision: 1,
      ...(type === "send" ? { sendId: id } : {}),
      ...(type === "thread" ? { threadId: id, commentId: id } : {}),
    };
    expect(ReviewEvent.parse({ ...value, body: "private text", instruction: "private text" })).toEqual(value);
    expect(ReviewEvent.safeParse({ ...value, revision: 0 }).success).toBe(false);
  }
});

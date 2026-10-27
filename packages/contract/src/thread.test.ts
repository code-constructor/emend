import { expect, test } from "vitest";
import * as contract from "./index.ts";
import { Outcome, ReplyRequest, ThreadState } from "./index.ts";

test("reply creation identifies the comment and thread and reports its resulting state", () => {
  const reply = {
    commentId: "00000000-0000-4000-8000-000000000001",
    threadId: "00000000-0000-4000-8000-000000000002",
    state: "answered",
  };
  expect(contract.ReplyCreated.parse(reply)).toEqual(reply);
  expect(contract.ReplyCreated.safeParse({ ...reply, state: "fixed" }).success).toBe(false);
  expect(contract.ReplyCreated.safeParse({ commentId: reply.commentId }).success).toBe(false);
});

test("keeps thread states separate from agent outcomes", () => {
  expect(ThreadState.options).toEqual(["open", "sent", "answered", "resolved"]);
  expect(Outcome.options).toEqual(["fixed", "explained", "held", "declined"]);
  for (const outcome of Outcome.options) {
    expect(ReplyRequest.parse({ outcome, body: "A reply.", extra: true })).toEqual({ outcome, body: "A reply." });
  }
});

test.each([
  { outcome: "resolved", body: "Done." },
  { outcome: "fixed", body: "" },
  { outcome: "fixed", body: " \n" },
  { outcome: "fixed", body: "x".repeat(20001) },
])("rejects an invalid reply %#", (reply) => {
  expect(ReplyRequest.safeParse(reply).success).toBe(false);
});

test("accepts the comment body limit without trimming the content", () => {
  expect(ReplyRequest.parse({ outcome: "explained", body: "x".repeat(20000) }).body).toHaveLength(20000);
  expect(ReplyRequest.parse({ outcome: "held", body: "  A reason.\n" }).body).toBe("  A reason.\n");
});

test.each(["\ud800", "\udfff", "text\ud800tail"])("rejects a malformed comment body %#", (body) => {
  expect(contract.CommentBody.safeParse(body).success).toBe(false);
});

test("preserves a valid surrogate pair in a comment body", () => {
  expect(contract.CommentBody.parse("  Pair: \ud83d\ude80  ")).toBe("  Pair: \ud83d\ude80  ");
});

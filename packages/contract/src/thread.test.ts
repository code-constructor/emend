import { expect, test } from "vitest";
import { Outcome, ReplyRequest, ThreadState } from "./index.ts";

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

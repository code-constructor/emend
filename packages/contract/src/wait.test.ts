/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { HandoffComment, WaitResult } from "./index.ts";

const fixtureDirectory = new URL("../fixtures/", import.meta.url);
const fixtures = readdirSync(fixtureDirectory).filter((name) => /^wait-.*\.json$/.test(name));

test("includes go, approve, pending and approval-set-aside fixtures", () => {
  expect(fixtures).toEqual(
    expect.arrayContaining([
      "wait-go.json",
      "wait-approve.json",
      "wait-pending.json",
      "wait-go-approval-set-aside.json",
      "wait-closed.json",
    ]),
  );
});

test.each(fixtures)("parses synthetic fixture %s without losing fields", (name) => {
  const fixture: unknown = JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8"));
  expect(WaitResult.parse(fixture)).toEqual(fixture);
});

test("validates handoff ids, comment bodies, history and nested placement", () => {
  const comment = {
    id: "33333333-3333-4333-8333-333333333333",
    threadId: "44444444-4444-4444-8444-444444444444",
    target: { kind: "review" },
    placement: { status: "placed", location: { kind: "review" } },
    body: "Explain the route.",
    history: [{ author: "agent", body: "Kept the interface.", outcome: "held" }],
  };
  expect(HandoffComment.parse({ ...comment, extra: true })).toEqual(comment);
  for (const change of [
    { id: "invalid" },
    { body: "" },
    { body: "x".repeat(20001) },
    { history: [{ author: "agent", body: "Done.", outcome: "resolved" }] },
    { history: [{ author: "system", body: "Done." }] },
  ]) {
    expect(HandoffComment.safeParse({ ...comment, ...change }).success).toBe(false);
  }
});

test("validates wait discriminators, numeric bounds and matching mode labels", () => {
  const go = {
    kind: "go",
    reviewId: "11111111-1111-4111-8111-111111111111",
    deliveryId: "22222222-2222-4222-8222-222222222222",
    revision: 2,
    sentOn: 1,
    mode: "fix-clear",
    modeLabel: "Fix what's clear, ask about the rest",
    instructions: [],
    approvalSetAside: false,
    comments: [],
  };
  expect(WaitResult.parse({ ...go, extra: true })).toEqual(go);
  for (const change of [
    { kind: "done" },
    { deliveryId: "invalid" },
    { revision: 0 },
    { sentOn: 0 },
    { sentOn: 3 },
    { modeLabel: "Fix everything" },
    { instructions: ["x".repeat(4001)] },
  ]) {
    expect(WaitResult.safeParse({ ...go, ...change }).success).toBe(false);
  }
  expect(WaitResult.safeParse({ kind: "pending", reviewId: go.reviewId, waitedSeconds: 540 }).success).toBe(true);
  expect(WaitResult.safeParse({ kind: "pending", reviewId: go.reviewId, waitedSeconds: -1 }).success).toBe(false);
});

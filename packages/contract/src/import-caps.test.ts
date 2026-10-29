import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { ImportBundle } from "./import.ts";

const id = randomUUID(),
  at = "2026-01-01T00:00:00.000Z";
const cases = [
  [
    "revisions",
    1000,
    { id, reviewId: id, seq: 1, base: null, head: null, main: null, writeupEmpty: true, createdAt: at },
  ],
  [
    "threads",
    1000,
    {
      id,
      reviewId: id,
      target: { kind: "review" },
      state: "open",
      createdRevisionId: id,
      createdAt: at,
      updatedAt: at,
    },
  ],
  [
    "comments",
    10000,
    {
      id,
      reviewId: id,
      threadId: id,
      author: "user",
      body: "x",
      outcome: null,
      sendId: null,
      createdAt: at,
      updatedAt: at,
    },
  ],
  [
    "sends",
    1000,
    {
      id,
      reviewId: id,
      revisionId: id,
      kind: "go",
      mode: "fix-clear",
      instruction: "x",
      deliveryId: null,
      setAsideAt: null,
      createdAt: at,
    },
  ],
  ["deliveries", 1000, { id, reviewId: id, leaseUntil: at, confirmedAt: null, createdAt: at }],
] as const;
test.each(cases)("%s array accepts %i rows and rejects one extra", (key, cap, row) => {
  const schema = ImportBundle.shape[key];
  expect(schema.safeParse(Array.from({ length: cap }, () => row)).success).toBe(true);
  expect(schema.safeParse(Array.from({ length: cap + 1 }, () => row)).success).toBe(false);
});

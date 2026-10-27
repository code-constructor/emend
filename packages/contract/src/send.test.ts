import { expect, test } from "vitest";
import { DEFAULT_MODE, GoMode, MODE_LABELS, SendRequest } from "./index.ts";

test("keeps the shared modes, exact labels and default", () => {
  expect(GoMode.options).toEqual(["fix-clear", "explain", "fix-all"]);
  expect(MODE_LABELS).toEqual({
    "fix-clear": "Fix what's clear, ask about the rest",
    explain: "Explain only, change nothing",
    "fix-all": "Fix everything",
  });
  expect(DEFAULT_MODE).toBe("fix-clear");
});

test("accepts go with optional mode and instruction, and approve without either", () => {
  expect(SendRequest.parse({ kind: "go", revision: 1 })).toEqual({ kind: "go", revision: 1 });
  expect(
    SendRequest.safeParse({ kind: "go", revision: 1, mode: "explain", instruction: "x".repeat(4000) }).success,
  ).toBe(true);
  expect(SendRequest.parse({ kind: "approve", revision: 2, extra: true })).toEqual({ kind: "approve", revision: 2 });
});

test.each([
  { kind: "go", revision: 1, instruction: "x".repeat(4001) },
  { kind: "approve", revision: 1, mode: "fix-all" },
  { kind: "approve", revision: 1, instruction: "Do this." },
  { kind: "go", revision: 0 },
  { kind: "go", revision: 1.5 },
  { kind: "go", revision: 1, mode: "resolve" },
])("rejects an invalid send %#", (send) => {
  expect(SendRequest.safeParse(send).success).toBe(false);
});

test.each(["\ud800", "\udfff", "text\ud800tail"])("rejects a malformed Send instruction %#", (instruction) => {
  expect(SendRequest.safeParse({ kind: "go", revision: 1, instruction }).success).toBe(false);
});

test("preserves a valid surrogate pair in a Send instruction", () => {
  const instruction = "  Pair: \ud83d\ude80  ";
  expect(SendRequest.parse({ kind: "go", revision: 1, instruction })).toMatchObject({ instruction });
});

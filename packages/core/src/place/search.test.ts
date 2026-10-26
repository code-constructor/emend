import { expect, test } from "vitest";
import { firstTwoMatches } from "./search.ts";

test("counts overlapping matches and stops at two for strings and arrays", () => {
  expect(firstTwoMatches("aaaa", "aa")).toEqual([0, 1]);
  expect(firstTwoMatches(["seed", "seed", "seed"], ["seed", "seed"])).toEqual([0, 1]);
  expect(firstTwoMatches("prefix seed suffix", "seed")).toEqual([7]);
  expect(firstTwoMatches("ababababac", "ababac")).toEqual([4]);
  expect(firstTwoMatches("seed", "weed")).toEqual([]);
  expect(firstTwoMatches("", "seed")).toEqual([]);
  expect(firstTwoMatches("seed", "")).toEqual([]);
});

test("string indices remain UTF-16 offsets", () => {
  expect(firstTwoMatches("🪴seed 🪴seed", "seed")).toEqual([2, 9]);
});

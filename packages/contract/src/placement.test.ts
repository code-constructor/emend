import { expect, test } from "vitest";
import { Placement, UnplacedReason } from "./index.ts";

test.each([
  { kind: "writeup-span", blockId: "overview-1234abcd", start: 0, end: 5 },
  { kind: "doc-span", path: "docs/plan.md", blockId: "doc-1234abcd-5678abcd", start: 0, end: 5 },
  { kind: "html-span", path: "docs/demo.html", start: 0, end: 5 },
  { kind: "lines", path: "src/router.ts", side: "new", start: 1, end: 1 },
  { kind: "file", path: "src/router.ts" },
  { kind: "topic", slug: "routing" },
  { kind: "review" },
])("describes a placed location: %j", (location) => {
  expect(Placement.parse({ status: "placed", location, extra: true })).toEqual({ status: "placed", location });
});

test("accepts precisely the five unplaced reasons", () => {
  const reasons = ["block-gone", "ambiguous", "topic-gone", "file-gone", "lines-gone"];
  expect(UnplacedReason.options).toEqual(reasons);
  for (const reason of reasons)
    expect(Placement.parse({ status: "unplaced", reason })).toEqual({ status: "unplaced", reason });
  expect(Placement.safeParse({ status: "unplaced", reason: "unknown" }).success).toBe(false);
});

test("rejects missing locations and invalid span offsets", () => {
  expect(Placement.safeParse({ status: "placed" }).success).toBe(false);
  for (const range of [
    { start: -1, end: 2 },
    { start: 1, end: 1 },
    { start: 2, end: 1 },
    { start: 0.5, end: 2 },
  ]) {
    expect(
      Placement.safeParse({ status: "placed", location: { kind: "html-span", path: "docs/demo.html", ...range } })
        .success,
    ).toBe(false);
  }
});

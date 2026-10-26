import { expect, test } from "vitest";
import { withOtherChanges } from "./topics.ts";

test("unlisted changed paths go to Other changes and unchanged listed diffs fail", () => {
  const changed = [{ path: "a.ts", oldPath: null, status: "modified" as const }];
  expect(withOtherChanges(changed, [])).toEqual({
    files: [{ path: "a.ts", role: "diff", topic: "other" }],
    other: ["a.ts"],
  });
  expect(() => withOtherChanges(changed, [{ path: "b.ts", role: "diff" }])).toThrow("b.ts");
  expect(withOtherChanges(changed, [{ path: "a.ts", role: "doc" }]).other).toEqual(["a.ts"]);
});

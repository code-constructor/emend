import { expect, test } from "vitest";
import { FileView, LIMITS, ViewedRequest } from "./index.ts";

test("viewed requests validate revision, paths, booleans and batch limits", () => {
  const body = { revision: 1, paths: ["src/a.ts"], viewed: true };
  expect(ViewedRequest.parse(body)).toEqual(body);
  expect(ViewedRequest.parse({ ...body, viewed: false }).viewed).toBe(false);
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
    expect(ViewedRequest.safeParse({ ...body, revision }).success).toBe(false);
  }
  for (const paths of [[], ["../a"], ["/a"], ["a\\b"], Array(LIMITS.filesPerRevision + 1).fill("a")]) {
    expect(ViewedRequest.safeParse({ ...body, paths }).success).toBe(false);
  }
  expect(ViewedRequest.safeParse({ ...body, paths: Array(LIMITS.filesPerRevision).fill("a") }).success).toBe(true);
  expect(ViewedRequest.safeParse({ ...body, viewed: "true" }).success).toBe(false);
});

test("viewed fields are additive and validate the mark state and revision", () => {
  const file = {
    id: "11111111-1111-4111-8111-111111111111",
    path: "a.ts",
    oldPath: null,
    role: "diff",
    status: "added",
    topic: null,
    order: 0,
    mediaType: "text/plain",
    flag: null,
    hasOld: false,
    hasNew: true,
  };
  expect(FileView.parse(file)).toEqual(file);
  for (const viewed of ["viewed", "stale"]) {
    expect(FileView.parse({ ...file, viewed, viewedOn: 2 })).toEqual({ ...file, viewed, viewedOn: 2 });
  }
  expect(FileView.safeParse({ ...file, viewed: "none" }).success).toBe(false);
  for (const viewedOn of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    expect(FileView.safeParse({ ...file, viewedOn }).success).toBe(false);
  }
});

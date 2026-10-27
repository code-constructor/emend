import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { run } from "../../main.ts";
import { commandFixture } from "../test-support.ts";

test("feedback takes once without waiting and prints pending with zero waited seconds", async () => {
  const f = await commandFixture();
  const reviewId = randomUUID();
  let takes = 0;
  f.setResponse(async (url, init) => {
    expect(String(url)).toMatch(/\/take$/);
    expect(JSON.parse(String(init?.body))).toEqual({ waitSeconds: 0 });
    takes++;
    return Response.json({ kind: "pending", reviewId, waitedSeconds: 0.01 });
  });
  expect(await run(["feedback", reviewId], f.io)).toBe(0);
  expect(takes).toBe(1);
  expect(f.stdout).toEqual([`${JSON.stringify({ kind: "pending", reviewId, waitedSeconds: 0 })}\n`]);
});

test.each([[], ["invalid"], [randomUUID(), "--timeout", "1"]])(
  "feedback refuses extra or invalid arguments %j",
  async (...args) => {
    const f = await commandFixture();
    expect(await run(["feedback", ...args], f.io)).toBe(2);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
  },
);

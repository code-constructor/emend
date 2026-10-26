import { expect, test } from "vitest";

test("the core entry point can be imported", async () => {
  await expect(import("./index.ts")).resolves.toBeDefined();
});

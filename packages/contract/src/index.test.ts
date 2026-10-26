import { expect, test } from "vitest";
import { CONTRACT_VERSION } from "./index.ts";

test("the contract version is 1", () => {
  expect(CONTRACT_VERSION).toBe(1);
});

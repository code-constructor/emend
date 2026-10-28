import { expect, test } from "vitest";
import { DeviceList, DeviceView } from "./index.ts";

const device = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "browser",
  name: "Synthetic browser",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
  current: true,
};
test("device views validate ids, UTC dates, kinds and current", () => {
  expect(DeviceList.parse({ items: [device] })).toEqual({ items: [device] });
  for (const change of [
    { id: "bad" },
    { kind: "admin" },
    { createdAt: "yesterday" },
    { lastSeenAt: "2026-01-01T00:00:00+01:00" },
    { current: "yes" },
  ])
    expect(DeviceView.safeParse({ ...device, ...change }).success).toBe(false);
});

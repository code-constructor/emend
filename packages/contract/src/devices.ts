import { z } from "zod";

export const DeviceView = z.object({
  id: z.uuid(),
  kind: z.enum(["browser", "machine"]),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  current: z.boolean(),
});
export type DeviceView = z.infer<typeof DeviceView>;
export const DeviceList = z.object({ items: z.array(DeviceView) });
export type DeviceList = z.infer<typeof DeviceList>;

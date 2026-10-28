import { DeviceList, DeviceView } from "@emend/contract";
import type { Io } from "../../main.ts";
import { escapeReference } from "../escape.ts";
import { apiRequest, CliError, CliUsageError } from "../http.ts";
import { humanServer } from "../human-server.ts";

export async function devicesCommand(stateDir: string, args: string[], io: Io) {
  if (args.length && (args.length !== 2 || args[0] !== "--revoke" || !DeviceView.shape.id.safeParse(args[1]).success))
    throw new CliUsageError("Usage: emend devices [--revoke <id>].");
  const target = await humanServer(stateDir);
  const result = DeviceList.safeParse(await apiRequest(stateDir, target, "/devices", { method: "GET" }));
  if (!result.success) throw new CliError("The emend server returned an invalid response.");
  if (args.length) {
    const device = result.data.items.find((item) => item.id === args[1]);
    if (!device) throw new CliError("Unknown device.");
    await apiRequest(stateDir, target, `/devices/${device.id}`, { method: "DELETE" });
    io.stdout(`Revoked ${escapeReference(device.name)}.\n`);
  } else
    for (const device of result.data.items)
      io.stdout(
        `${escapeReference(device.name)}\t${device.kind}\t${device.createdAt.slice(0, 10)}\t${device.lastSeenAt?.slice(0, 10) ?? "never"}\t${device.id}\n`,
      );
}

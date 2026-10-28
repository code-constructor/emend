import { isIP } from "node:net";
import { PairingCreated } from "@emend/contract";
import { renderUnicodeCompact } from "uqr";
import type { Io } from "../../main.ts";
import { apiRequest, CliError, CliUsageError } from "../http.ts";
import { humanServer } from "../human-server.ts";

export async function pairCommand(stateDir: string, args: string[], io: Io) {
  if (args.length) throw new CliUsageError("Usage: emend pair.");
  const target = await humanServer(stateDir);
  const result = PairingCreated.safeParse(
    await apiRequest(stateDir, target, "/pairings", { method: "POST", body: { purpose: "device" } }),
  );
  if (!result.success) throw new CliError("The emend server returned an invalid response.");
  const { url, code } = result.data;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  io.stdout(
    `${url}\n${loopback ? "This link works only on this machine. To pair a phone, run emend serve --tailscale.\n" : ""}${code}\n${renderUnicodeCompact(url, { border: 4 })}\nValid for 10 minutes, once.\n`,
  );
}

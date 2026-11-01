import { isIP } from "node:net";
import { PairingCreated } from "@emend/contract";
import { renderUnicodeCompact } from "uqr";
import type { Io } from "../../main.ts";
import { apiRequest, CliError, CliUsageError } from "../http.ts";
import { humanServer } from "../human-server.ts";

export async function pairCommand(stateDir: string, args: string[], io: Io) {
  const machine = args.length === 1 && args[0] === "--machine";
  if (args.length && !machine) throw new CliUsageError("Usage: emend pair [--machine].");
  if (!io.isTTY) throw new CliError("emend pair prints one-time codes only in a terminal.");
  const target = await humanServer(stateDir);
  const result = PairingCreated.safeParse(
    await apiRequest(stateDir, target, "/pairings", {
      method: "POST",
      body: { purpose: machine ? "machine" : "device" },
    }),
  );
  if (!result.success) throw new CliError("The emend server returned an invalid response.");
  const { url, code } = result.data;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (machine) {
    io.stdout(
      `${url}\n${loopback ? "This link works only on this machine. To attach another machine, run emend serve --tailscale.\n" : ""}${code}\nValid for 10 minutes, once.\nOn the other machine, run: emend attach ${url}\n`,
    );
    return;
  }
  io.stdout(
    `${url}\n${loopback ? "This link works only on this machine. To pair a phone, run emend serve --tailscale.\n" : ""}${code}\n${renderUnicodeCompact(url, { border: 4 })}\nValid for 10 minutes, once.\n`,
  );
}

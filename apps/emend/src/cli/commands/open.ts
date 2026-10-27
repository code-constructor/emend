import { spawn } from "node:child_process";
import { PairingCreated } from "@emend/contract";
import type { Io } from "../../main.ts";
import { apiRequest, CliError } from "../http.ts";
import { ensureServer } from "../server-client.ts";
import { localTarget } from "../target.ts";

export async function openBrowser(url: string, env = process.env, timeoutMs = 5_000): Promise<boolean> {
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!command) return false;
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [url], { detached: true, stdio: "ignore" });
      let settled = false;
      const finish = (opened: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.unref();
        resolve(opened);
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
    } catch {
      resolve(false);
    }
  });
}
export async function openCommand(stateDir: string, io: Io) {
  let url: string;
  try {
    ({ url } = await ensureServer(stateDir));
  } catch {
    throw new CliError("Could not start the emend server.");
  }
  const response = PairingCreated.safeParse(
    await apiRequest(stateDir, await localTarget(stateDir, url, "admin"), "/pairings", {
      method: "POST",
      body: { purpose: "device" },
    }),
  );
  if (!response.success) throw new CliError("The emend server returned an invalid response.");
  let opened = false;
  try {
    opened = await (io.openUrl ?? openBrowser)(response.data.url);
  } catch {
    /* Offer the same one-time link. */
  }
  io.stdout(opened ? "Opening emend in your browser.\n" : `Open this link within 10 minutes: ${response.data.url}\n`);
}

import type { Io } from "../../main.ts";
import { startServer } from "../../server/serve.ts";

export class UsageError extends Error {}
export function parseServeArgs(args: string[]) {
  let host = "127.0.0.1";
  let port = 3636;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag || !value || seen.has(flag)) throw new UsageError("Invalid serve options.");
    seen.add(flag);
    if (flag === "--host" && /^[a-zA-Z0-9:][a-zA-Z0-9.:-]*$/.test(value)) host = value;
    else if (flag === "--port" && /^\d{1,5}$/.test(value) && Number(value) <= 65535) port = Number(value);
    else throw new UsageError("Invalid serve options.");
  }
  return { host, port };
}
export async function serveCommand(stateDir: string, options: ReturnType<typeof parseServeArgs>, io: Io) {
  const server = await startServer({ stateDir, ...options });
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      server.close().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    io.stdout(`emend is serving ${server.url}\n`);
  });
}

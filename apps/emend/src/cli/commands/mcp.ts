import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Io } from "../../main.ts";
import { createMcpServer } from "../../mcp/server.ts";
import { CliUsageError } from "../http.ts";

export async function mcpCommand(stateDir: string, args: string[], io: Io) {
  if (args.length) throw new CliUsageError("Usage: emend mcp.");
  const mcp = createMcpServer(stateDir, io.stderr);
  const transport = new StdioServerTransport();
  // SDK send() can finish on write() returning true, before its callback. Receipt
  // requires the callback, including small responses that do not apply backpressure.
  transport.send = async (message) => {
    await (io.stdoutAsync ?? io.stdout)(`${JSON.stringify(message)}\n`);
  };
  const close = () => {
    void mcp.server.close();
  };
  process.stdin.once("end", close);
  mcp.server.onclose = () => {
    process.stdin.off("end", close);
  };
  await mcp.connect(transport);
}

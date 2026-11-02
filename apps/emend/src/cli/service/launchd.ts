import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../http.ts";
import {
  clearServicePending,
  readOwnedService,
  type ServiceAction,
  type ServiceContext,
  type ServiceTool,
  serviceFile,
  servicePending,
  serviceStatus,
  unsupportedService,
  validatePaths,
  writeService,
} from "./common.ts";
import { markServicePending, removeServiceOptions, saveServiceOptions, serviceInstallOptions } from "./options.ts";

const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function plist(context: ServiceContext): string {
  const { home, node, entry, flags, stateDir } = context;
  const log = xml(join(home, "Library/Logs/emend.log"));
  return `${declaration}
<!-- written by emend -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.emend.server</string>
  <key>ProgramArguments</key>
  <array>
${[node, entry, "serve", ...flags].map((word) => `    <string>${xml(word)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EMEND_HOME</key>
    <string>${xml(stateDir)}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

export async function launchdService(action: ServiceAction, context: ServiceContext, uid: number) {
  const { home, io, tool, stateDir } = context;
  const launchctl = await tool("launchctl").catch((error) => {
    if (error instanceof CliError && error.message === "launchctl was not found on PATH")
      throw new CliError(unsupportedService);
    throw error;
  });
  const path = join(home, "Library/LaunchAgents/dev.emend.server.plist");
  const domain = `gui/${uid}`;
  const target = `${domain}/dev.emend.server`;
  validatePaths(path);
  if (action === "status") {
    if (!(await serviceFile(path))) io.stdout("emend: service not installed\n");
    else {
      const result = await launchctl(["print", target], "ignore");
      serviceStatus(io, path, result.code === 0 && serviceState(result.stdout) === "running");
    }
    return;
  }
  const previous = await readOwnedService(path, `${declaration}\n<!-- written by emend -->\n`);
  if (action === "uninstall") {
    if (previous === undefined) {
      await removeServiceOptions(stateDir);
      await clearServicePending(stateDir);
      io.stdout("emend: the service is not installed.\n");
      return;
    }
    await launchctl(["bootout", target], "report");
    await removeServiceOptions(stateDir);
    await clearServicePending(stateDir);
    await unlink(path);
    io.stdout("emend: service uninstalled\n");
    return;
  }
  const { flags, resetToDefaults } = await serviceInstallOptions(context, previous);
  const content = plist({ ...context, flags });
  const pending = await servicePending(stateDir);
  markServicePending(stateDir, flags, content);
  const stop = previous !== undefined || pending;
  if (stop) await launchctl(["bootout", target], "ignore");
  await mkdir(join(home, "Library/Logs"), { recursive: true });
  if (previous !== content) await writeService(path, content);
  saveServiceOptions(stateDir, flags);
  if (resetToDefaults && previous !== content)
    io.stdout("emend: no saved service options; the service now uses the defaults\n");
  if (stop) await waitForBootout(launchctl, target, context);
  await launchctl(["bootstrap", domain, path]);
  await clearServicePending(stateDir);
  io.stdout("emend: service installed\n");
}

async function waitForBootout(launchctl: ServiceTool, target: string, context: ServiceContext) {
  const deadline = context.now() + 10000;
  while ((await launchctl(["print", target], "ignore")).code === 0) {
    const remaining = deadline - context.now();
    if (remaining <= 0) throw new CliError("the old emend service did not stop; try again.");
    await context.sleep(Math.min(200, remaining));
  }
}

function serviceState(output: string): string | undefined {
  let depth = 0;
  for (const line of output.split("\n")) {
    const text = line.trim();
    if (depth === 1 && text.startsWith("state = ")) return text.slice("state = ".length);
    if (text.endsWith("{")) depth++;
    else if (text === "}") depth--;
  }
  return undefined;
}

import { unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { CliError } from "../http.ts";
import {
  clearServicePending,
  readOwnedService,
  type ServiceAction,
  type ServiceContext,
  serviceFile,
  serviceStatus,
  unsupportedService,
  validatePaths,
  writeService,
} from "./common.ts";
import { markServicePending, removeServiceOptions, saveServiceOptions, serviceInstallOptions } from "./options.ts";

export function systemdWord(word: string, execStart: boolean): string {
  let escaped = word.replaceAll("%", "%%");
  if (execStart) escaped = escaped.replaceAll("$", "$$$$");
  return /[ \t"'\\]/.test(escaped) ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : escaped;
}

function unit(context: ServiceContext): string {
  const { node, entry, flags, stateDir } = context;
  return `# written by emend
[Unit]
Description=emend review server

[Service]
Type=exec
ExecStart=${systemdWord(node, false)} ${[entry, "serve", ...flags].map((word) => systemdWord(word, true)).join(" ")}
Environment=${systemdWord(`EMEND_HOME=${stateDir}`, false)}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

export async function systemdService(action: ServiceAction, context: ServiceContext, username?: string) {
  const { home, io, tool, stateDir } = context;
  if (action === "install" && /[$"'\\]/.test(context.node))
    throw new CliError(
      "the node path contains $, quotes or a backslash, which a systemd unit cannot run; use a node installed at a plain path.",
    );
  const systemctl = await tool("systemctl").catch((error) => {
    if (error instanceof CliError && error.message === "systemctl was not found on PATH")
      throw new CliError(unsupportedService);
    throw error;
  });
  const config = io.env.XDG_CONFIG_HOME;
  const path = join(config && isAbsolute(config) ? config : join(home, ".config"), "systemd/user/emend.service");
  validatePaths(path);
  if (action === "status") {
    if (!(await serviceFile(path))) io.stdout("emend: service not installed\n");
    else serviceStatus(io, path, (await systemctl(["--user", "is-active", "emend"], "ignore")).code === 0);
    return;
  }
  const previous = await readOwnedService(path, "# written by emend\n");
  if (action === "uninstall") {
    if (previous === undefined) {
      await removeServiceOptions(stateDir);
      await clearServicePending(stateDir);
      io.stdout("emend: the service is not installed.\n");
      return;
    }
    await systemctl(["--user", "disable", "--now", "emend"], "report");
    await removeServiceOptions(stateDir);
    await clearServicePending(stateDir);
    await unlink(path);
    await systemctl(["--user", "daemon-reload"]);
    io.stdout("emend: service uninstalled\n");
    return;
  }
  const { flags, resetToDefaults } = await serviceInstallOptions(context, previous);
  const content = unit({ ...context, flags });
  markServicePending(stateDir, flags, content);
  if (previous !== content) {
    await writeService(path, content);
  }
  saveServiceOptions(stateDir, flags);
  if (resetToDefaults && previous !== content)
    io.stdout("emend: no saved service options; the service now uses the defaults\n");
  await systemctl(["--user", "daemon-reload"]);
  await systemctl(["--user", "enable", "emend"]);
  await systemctl(["--user", "restart", "emend"]);
  await clearServicePending(stateDir);
  io.stdout("emend: service installed\n");
  try {
    const loginctl = await tool("loginctl");
    const result = await loginctl(
      ["show-user", username ?? userInfo().username, "--property=Linger", "--value"],
      "ignore",
    );
    if (result.code === 0 && result.stdout.trim() === "no")
      io.stdout("To keep emend running after you log out, run sudo loginctl enable-linger $USER.\n");
  } catch {
    // Linger advice is optional when loginctl is unavailable.
  }
}

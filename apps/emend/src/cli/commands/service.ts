import { homedir } from "node:os";
import { setTimeout } from "node:timers/promises";
import type { Io } from "../../main.ts";
import { CliError, CliUsageError } from "../http.ts";
import { cliRuntime } from "../runtime.ts";
import {
  runService,
  type ServiceContext,
  serviceTool,
  unsupportedService,
  validatePaths,
  validateServiceRuntime,
} from "../service/common.ts";
import { launchdService } from "../service/launchd.ts";
import { systemdService } from "../service/systemd.ts";
import { parseServeArgs, UsageError } from "./serve.ts";

export async function serviceCommand(stateDir: string, args: string[], io: Io) {
  const [action, ...flags] = args;
  if (action !== "install" && action !== "uninstall" && action !== "status")
    throw new CliUsageError("Usage: emend service install [serve options] | uninstall | status.");
  if (action !== "install" && flags.length) throw new CliUsageError(`emend service ${action} takes no options.`);
  try {
    if (action === "install") parseServeArgs(flags);
    const options = io.service ?? {};
    const platform = options.platform ?? process.platform;
    if (platform !== "linux" && platform !== "darwin") throw new CliError(unsupportedService);
    const home = options.home ?? homedir();
    const runtime = cliRuntime(options);
    validatePaths(home);
    if (action === "install") {
      validatePaths(runtime.node, runtime.entry, stateDir);
      await validateServiceRuntime(runtime, options.cwd ?? process.cwd());
    }
    const context: ServiceContext = {
      ...runtime,
      home,
      stateDir,
      flags,
      io,
      tool: (name) => serviceTool(name, home, io, options.runner ?? runService),
      now: options.now ?? (() => performance.now()),
      sleep: options.sleep ?? setTimeout,
    };
    if (platform === "linux") await systemdService(action, context, options.username);
    else {
      const uid = options.uid ?? process.getuid?.();
      if (uid === undefined) throw new CliError("Could not determine the service user.");
      await launchdService(action, context, uid);
    }
  } catch (error) {
    if (error instanceof UsageError) throw new CliUsageError(error.message);
    if (error instanceof CliError) throw error;
    throw new CliError("Could not manage the emend service.");
  }
}

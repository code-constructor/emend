import { type ChildProcess, spawn } from "node:child_process";
import { basename, delimiter, dirname, isAbsolute } from "node:path";
import { findExecutable } from "./executable.ts";
import { CliError } from "./http.ts";

const occupied =
  "port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.";
const unreadable = "could not read the output of tailscale status.";
export const tailscaleUnavailable = "Tailscale is not running or not logged in.";
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
interface RunOptions {
  deadlineMs?: number;
  platform?: NodeJS.Platform;
  appPath?: string;
  fixedPort?: boolean;
}
const escalations = new Set<Promise<void>>();
/** Serve keeps its signal handlers installed until every scheduled group kill has run. */
export async function waitForTailscaleEscalations(): Promise<void> {
  while (escalations.size) await Promise.all(escalations);
}
async function execute(
  args: string[],
  env = process.env,
  signal?: AbortSignal,
  {
    deadlineMs = 10_000,
    platform = process.platform,
    appPath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    fixedPort = true,
  }: RunOptions = {},
): Promise<string> {
  signal?.throwIfAborted();
  const searchPath = (env.PATH ?? "").split(delimiter).filter(isAbsolute).join(delimiter);
  const binary = await findExecutable("tailscale", searchPath)
    .catch((error) => {
      if (platform !== "darwin") throw error;
      return findExecutable(basename(appPath), dirname(appPath));
    })
    .catch(() => {
      throw new CliError("tailscale is not installed or not on PATH.");
    });
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const serve = args[0] === "serve";
    const failure = (stderr = "") => {
      const setupHint = fixedPort
        ? ` Run \`sudo tailscale serve --bg --https=443 ${args[3]}\` once as root, then try again. emend uses that route and never removes it.`
        : " Use a fixed --port, run `sudo tailscale serve --bg --https=443 http://127.0.0.1:<port>` once as root with that port, then try again.";
      const hint =
        serve && /permission|access denied|not permitted|sudo tailscale|operator/i.test(stderr)
          ? args[1] === "--bg"
            ? setupHint
            : " Run `sudo tailscale set --operator=$USER` once, then try again."
          : "";
      return new CliError(`${serve ? "Could not configure Tailscale Serve." : tailscaleUnavailable}${hint}`);
    };
    let child: ChildProcess;
    try {
      // execFile does not forward detached; cleanup must survive signals to emend's group.
      child = spawn(binary.file, args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: searchPath || "/usr/bin:/bin:/usr/sbin:/sbin", HOME: env.HOME, LC_ALL: "C" },
      });
    } catch {
      reject(failure());
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let overflow = false;
    let timedOut = false;
    let terminating = false;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let drainGrace: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals | 0) => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        // The group may already be gone, including after a failed spawn.
        return false;
      }
    };
    const destroyPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const terminateGroup = () => {
      if (terminating) return;
      terminating = true;
      if (signalGroup("SIGTERM")) {
        // Keep this referenced and independent of call settlement: a launcher can
        // exit on SIGTERM while its descendants ignore it and outlive emend.
        const escalation = Promise.withResolvers<void>();
        escalations.add(escalation.promise);
        setTimeout(() => {
          if (signalGroup(0)) signalGroup("SIGKILL");
          escalations.delete(escalation.promise);
          escalation.resolve();
        }, 1_000);
      }
    };
    const terminate = () => {
      if (settled) return;
      terminateGroup();
      destroyPipes();
    };
    const finish = (code: number | null, exitSignal: NodeJS.Signals | null, failed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(drainGrace);
      signal?.removeEventListener("abort", terminate);
      // A clean group adds no delay; descendants without open pipes still need cleanup.
      if (!terminating && signalGroup(0)) terminateGroup();
      destroyPipes();
      if (signal?.aborted) return reject(signal.reason);
      if (overflow) return reject(new CliError(unreadable));
      if (timedOut)
        return reject(
          new CliError(
            `tailscale did not answer within ${deadlineMs / 1_000} second${deadlineMs === 1_000 ? "" : "s"}.`,
          ),
        );
      if (!failed && code === 0 && exitSignal === null) return resolve(Buffer.concat(stdout).toString("utf8"));
      reject(failure(Buffer.concat(stderr).toString("utf8")));
    };
    // EMFILE/ENFILE can leave null pipes and emit error on the next tick.
    child.once("error", () => finish(null, null, true));
    child.once("close", finish);
    child.once("exit", (code, exitSignal) => {
      if (settled) return;
      // Drain normal output through close. A descendant can keep stdio open,
      // so give it only this grace period, still bounded by the call's deadline.
      drainGrace = setTimeout(() => {
        if (!terminating && signalGroup(0)) terminateGroup();
        destroyPipes();
        finish(code, exitSignal);
      }, 250);
    });
    deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, deadlineMs);
    // The startup signal tracks running calls only; completed calls unregister.
    signal?.addEventListener("abort", terminate, { once: true });
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      let bytes = 0;
      stream?.on("data", (chunk: Buffer) => {
        if (overflow) return;
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          overflow = true;
          terminate();
        } else chunks.push(chunk);
      });
    }
    if (signal?.aborted) terminate();
  });
}
export async function tailscaleSelf(
  env = process.env,
  signal?: AbortSignal,
  options?: RunOptions,
): Promise<{ dnsName: string } | null> {
  const output = await execute(["status", "--json"], env, signal, options);
  let status: unknown;
  try {
    status = JSON.parse(output);
  } catch {
    throw new CliError(unreadable);
  }
  if (
    !record(status) ||
    status.BackendState !== "Running" ||
    !record(status.Self) ||
    typeof status.Self.DNSName !== "string"
  )
    return null;
  const dnsName = status.Self.DNSName.replace(/\.$/, "").toLowerCase();
  const labels = dnsName.split(".");
  if (
    dnsName.length > 253 ||
    labels.length < 2 ||
    !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  return { dnsName };
}
/** Unknown shapes are occupied: never repair or replace someone else's Serve config. */
function handlerState(config: unknown, target: string, dnsName?: string): "empty" | "same" | "occupied" {
  if (
    !record(config) ||
    Object.keys(config).some((key) => !["TCP", "Web", "Services", "AllowFunnel", "Foreground"].includes(key))
  )
    return "occupied";
  if (config.Services !== undefined && !record(config.Services)) return "occupied";
  if (config.Foreground !== undefined && (!record(config.Foreground) || Object.keys(config.Foreground).length))
    return "occupied";
  if (config.AllowFunnel !== undefined) {
    if (!record(config.AllowFunnel)) return "occupied";
    for (const [host, allowed] of Object.entries(config.AllowFunnel)) {
      if (!/^[a-z0-9.-]+:[1-9]\d{0,4}$/.test(host) || typeof allowed !== "boolean") return "occupied";
      if (allowed && (dnsName ? host === `${dnsName}:443` : host.endsWith(":443"))) return "occupied";
    }
  }
  if (config.TCP !== undefined && !record(config.TCP)) return "occupied";
  if (config.Web !== undefined && !record(config.Web)) return "occupied";
  const tcp = config.TCP ?? {};
  const web = config.Web ?? {};
  if (!record(tcp) || !record(web)) return "occupied";
  if (
    Object.entries(tcp).some(
      ([port, handler]) => !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 || !record(handler),
    ) ||
    Object.entries(web).some(([host, handler]) => !/^[a-z0-9.-]+:[1-9]\d{0,4}$/.test(host) || !record(handler))
  )
    return "occupied";
  const endpoints = Object.entries(web).filter(([host]) => host.endsWith(":443"));
  const listener = tcp["443"];
  if (listener === undefined && endpoints.length === 0) return "empty";
  if (
    !record(listener) ||
    listener.HTTPS !== true ||
    Object.keys(listener).some((key) => key !== "HTTPS") ||
    endpoints.length !== 1
  )
    return "occupied";
  if (dnsName && endpoints[0]?.[0] !== `${dnsName}:443`) return "occupied";
  const endpoint = endpoints[0]?.[1];
  if (!record(endpoint) || Object.keys(endpoint).some((key) => key !== "Handlers") || !record(endpoint.Handlers))
    return "occupied";
  const handlers = endpoint.Handlers;
  const root = handlers["/"];
  return Object.keys(handlers).length === 1 &&
    record(root) &&
    Object.keys(root).length === 1 &&
    (root.Proxy === target || root.Proxy === `${target}/`)
    ? "same"
    : "occupied";
}
async function serveConfig(env: NodeJS.ProcessEnv, options?: RunOptions): Promise<unknown> {
  const output = await execute(["serve", "status", "--json"], env, undefined, options);
  try {
    return JSON.parse(output);
  } catch {
    throw new CliError(unreadable);
  }
}
function otherHttpsPorts(config: unknown, dnsName?: string): boolean {
  if (!dnsName || !record(config) || !record(config.TCP)) return false;
  const web = record(config.Web) ? config.Web : {};
  return Object.entries(config.TCP).some(
    ([port, listener]) =>
      port !== "443" &&
      record(listener) &&
      (listener.TerminateTLS === dnsName || (listener.HTTPS === true && Object.hasOwn(web, `${dnsName}:${port}`))),
  );
}
export async function ensureTailscaleServe(
  port: number,
  env = process.env,
  dnsName?: string,
  onSetupAttempt?: () => void,
  options?: RunOptions,
): Promise<{ created: boolean; otherHttpsPorts: boolean }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError("Invalid Tailscale Serve port.");
  const config = await serveConfig(env, options);
  const target = `http://127.0.0.1:${port}`;
  const state = handlerState(config, target, dnsName);
  if (state === "occupied") throw new CliError(occupied);
  if (state === "empty") {
    onSetupAttempt?.();
    await execute(["serve", "--bg", "--https=443", target], env, undefined, options);
  }
  return { created: state === "empty", otherHttpsPorts: otherHttpsPorts(config, dnsName) };
}
export async function removeTailscaleServe(port: number, env = process.env, dnsName?: string): Promise<void> {
  const config = await serveConfig(env);
  if (handlerState(config, `http://127.0.0.1:${port}`, dnsName) === "same")
    await execute(["serve", "--https=443", "off"], env);
}

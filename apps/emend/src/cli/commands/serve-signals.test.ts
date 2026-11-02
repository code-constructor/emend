import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { appendFile, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, onTestFinished, test, vi } from "vitest";

const name = "hub.example.ts.net";
let entryDir: string;
let entry: string;
let socketEntry: string;
beforeAll(async () => {
  entryDir = await mkdtemp(join(tmpdir(), "emend-signal-entry-"));
  entry = join(entryDir, "cli.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../../cli.ts", import.meta.url))],
    outfile: entry,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: ["node:*"],
  });
  // New lifecycle cases need real processes/signals, but no TCP socket. Keep the
  // existing end-to-end cases on the real listener, and exercise actual state/close
  // code with this socket double for the phase-gated cases.
  socketEntry = join(entryDir, "cli-socket.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../../cli.ts", import.meta.url))],
    outfile: socketEntry,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    plugins: [
      {
        name: "synthetic-listener",
        setup(builder) {
          builder.onResolve({ filter: /^node:http$/ }, (args) => {
            if (args.importer.endsWith("/server/serve.ts")) return { path: "http", namespace: "socket-double" };
          });
          builder.onLoad({ filter: /.*/, namespace: "socket-double" }, () => ({
            contents: `
import { EventEmitter } from "node:events";
import { existsSync, renameSync, writeFileSync } from "node:fs";
class Socket extends EventEmitter {
  listening = false;
  listen(options, ready) {
    this.keepAlive = setInterval(() => {}, 1000);
    this.listening = true;
    const marker = process.env.EMEND_TEST_LISTEN;
    if (!marker) { queueMicrotask(ready); return; }
    writeFileSync(marker + ".tmp", String(process.pid));
    renameSync(marker + ".tmp", marker);
    const timer = setInterval(() => {
      if (!existsSync(process.env.EMEND_TEST_RELEASE)) return;
      clearInterval(timer);
      ready();
    }, 5);
  }
  address() { return { address: "127.0.0.1", port: 41999 }; }
  closeAllConnections() {}
  close(done) {
    if (process.env.EMEND_TEST_CLOSED) writeFileSync(process.env.EMEND_TEST_CLOSED, "closed");
    const marker = process.env.EMEND_TEST_CLOSE;
    if (!marker) { clearInterval(this.keepAlive); this.listening = false; done(); return; }
    writeFileSync(marker + ".tmp", String(process.pid));
    renameSync(marker + ".tmp", marker);
    const timer = setInterval(() => {
      if (!existsSync(process.env.EMEND_TEST_RELEASE)) return;
      clearInterval(timer);
      clearInterval(this.keepAlive);
      this.listening = false;
      done();
    }, 5);
  }
}
export const createServer = () => new Socket();
`,
          }));
        },
      },
    ],
  });
});
afterAll(async () => {
  if (entryDir) await rm(entryDir, { recursive: true, force: true });
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function killIfPresent(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
async function stopped(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  const { stdout } = await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "stat="], {
    env: { PATH: process.env.PATH, LC_ALL: "C" },
  });
  return stdout.trim().startsWith("Z");
}
async function fixture(
  options: {
    timeout?: boolean;
    phase?: "status" | "listen" | "bg" | "off" | "close";
    stderrFailure?: "throw" | "event";
    socketDouble?: boolean;
    closedStdout?: boolean;
    stubbornDescendant?: boolean;
    keepAlive?: boolean;
  } = {},
) {
  const phase = options.phase ?? "status";
  const dir = await mkdtemp(join(tmpdir(), "emend-serve-signals-"));
  const stateDir = join(dir, "state");
  const configPath = join(dir, "config.json");
  const callsPath = join(dir, "calls");
  const holdPath = join(dir, "hold-cleanup");
  const enteredPath = join(dir, "cleanup-started");
  const releasePath = join(dir, "release-cleanup");
  const reportPath = join(dir, "report-attempts");
  const bootstrap = join(dir, "bootstrap.mjs");
  const listenErrorPath = join(dir, "listen-error");
  const stdoutErrorPath = join(dir, "stdout-error");
  const descendantPath = join(dir, "descendant");
  const socketClosedPath = join(dir, "socket-closed");
  await writeFile(
    bootstrap,
    `
import { existsSync, writeFileSync, appendFileSync } from "node:fs";
import { Server } from "node:http";
import { errorMonitor } from "node:events";
${options.keepAlive ? "setInterval(() => {}, 1000);" : ""}
process.stdout.on(errorMonitor, (error) => writeFileSync(${JSON.stringify(stdoutErrorPath)}, error.code));
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once("error", (error) => writeFileSync(${JSON.stringify(listenErrorPath)}, error.code ?? "unknown"));
  return listen.apply(this, args);
};
${
  options.stderrFailure
    ? `
process.stderr.write = () => {
  appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ discovery: existsSync(${JSON.stringify(join(stateDir, "server.json"))}) }) + "\\n");
  const error = Object.assign(new Error("write EIO"), { code: "EIO" });
  ${options.stderrFailure === "throw" ? "throw error;" : 'queueMicrotask(() => process.stderr.emit("error", error)); return false;'}
};`
    : ""
}
`,
  );
  const gate = `
    printf '%s' "$$" > ${quote(`${enteredPath}.tmp`)}
    /bin/mv ${quote(`${enteredPath}.tmp`)} ${quote(enteredPath)}
    while [ ! -f ${quote(releasePath)} ]; do :; done
    /bin/rm -f ${quote(enteredPath)}
  `;
  await writeFile(configPath, "{}");
  await writeFile(callsPath, "");
  await writeFile(
    join(dir, "tailscale"),
    `#!/bin/sh
trap 'exit 0' TERM
trap ${quote(`/bin/rm -f ${quote(enteredPath)}`)} EXIT
printf '%s %s\\n' "$$" "$*" >> ${quote(callsPath)}
if [ "$1" = status ]; then
  ${
    options.stubbornDescendant
      ? `/bin/sh -c ${quote(`trap '' TERM\nprintf '%s' "$$" > ${quote(`${descendantPath}.tmp`)}\n/bin/mv ${quote(`${descendantPath}.tmp`)} ${quote(descendantPath)}\nwhile [ ! -f ${quote(releasePath)} ]; do :; done`)} &
  while [ ! -f ${quote(descendantPath)} ]; do :; done`
      : ""
  }
  ${options.timeout ? gate : `printf '%s\\n' '${JSON.stringify({ BackendState: "Running", Self: { DNSName: name } })}'`}
elif [ "$2" = status ]; then
  ${phase === "status" ? `if [ -f ${quote(holdPath)} ]; then ${gate} fi` : ""}
  /bin/cat ${quote(configPath)}
elif [ "$2" = --bg ]; then
  printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"${name}:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$4" > ${quote(configPath)}
  ${phase === "bg" ? gate : ""}
elif [ "$2" = --https=443 ] && [ "$3" = off ]; then
  ${phase === "off" ? gate : ""}
  ${options.stderrFailure ? "printf 'permission denied' >&2; exit 1" : ":"}
  printf '{}' > ${quote(configPath)}
else exit 7
fi
`,
    { mode: 0o700 },
  );
  const calls = async () =>
    (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ pid: Number(line.slice(0, line.indexOf(" "))), args: line.slice(line.indexOf(" ") + 1) }));
  const stdoutPath = join(dir, "stdout");
  const stderrPath = join(dir, "stderr");
  // Own both ends of an OS pipe so closing the reader reaches the writer itself.
  if (options.closedStdout)
    await promisify(execFile)("/usr/bin/mkfifo", [stdoutPath], { env: { PATH: process.env.PATH, LC_ALL: "C" } });
  const stdoutReader = options.closedStdout
    ? await open(stdoutPath, constants.O_RDONLY | constants.O_NONBLOCK)
    : undefined;
  const stdoutFile = await open(stdoutPath, "w");
  const stderrFile = await open(stderrPath, "w");
  // Files also preserve writes when the terminal's pipe has gone away.
  // A separate group lets the test signal the entire job without signalling Vitest.
  const child = spawn(
    process.execPath,
    ["--import", bootstrap, options.socketDouble ? socketEntry : entry, "serve", "--tailscale", "--port", "0"],
    {
      cwd: dir,
      detached: true,
      stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
      env: {
        EMEND_HOME: stateDir,
        HOME: dir,
        PATH: dir,
        LC_ALL: "C",
        NODE_NO_WARNINGS: "1",
        ...(phase === "close" ? { EMEND_TEST_CLOSE: enteredPath, EMEND_TEST_RELEASE: releasePath } : {}),
        ...(phase === "listen"
          ? {
              EMEND_TEST_LISTEN: enteredPath,
              EMEND_TEST_RELEASE: releasePath,
              EMEND_TEST_CLOSED: socketClosedPath,
            }
          : {}),
      },
    },
  );
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await stdoutReader?.close();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await writeFile(releasePath, "");
    if (child.pid && child.exitCode === null && child.signalCode === null) killIfPresent(-child.pid);
    // Release the fake we still hold at the gate. Never replay historical pids:
    // an exited fake's pid may now belong to an unrelated process.
    if (phase !== "close" && phase !== "listen") {
      await vi.waitFor(
        async () => {
          await expect(stat(enteredPath)).rejects.toMatchObject({ code: "ENOENT" });
        },
        { timeout: 2_000, interval: 5 },
      );
    }
    await closed;
    if (options.stubbornDescendant) {
      const descendant = await readFile(descendantPath, "utf8").catch(() => "");
      if (descendant)
        await vi.waitFor(async () => expect(await stopped(Number(descendant))).toBe(true), {
          timeout: 2_000,
          interval: 10,
        });
    }
    await stdoutFile.close();
    await stderrFile.close();
    await rm(dir, { recursive: true, force: true });
  };
  onTestFinished(cleanup);
  return {
    child,
    closed,
    cleanup,
    logOldPid: (pid: number) => appendFile(callsPath, `${pid} old completed call\n`),
    reports: async () =>
      (await readFile(reportPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    startedPid: async () => Number(await readFile(enteredPath, "utf8")),
    calls,
    configPath,
    stateDir,
    stderr: () => readFile(stderrPath, "utf8"),
    stdoutError: () => readFile(stdoutErrorPath, "utf8"),
    descendantPid: async () => Number(await readFile(descendantPath, "utf8")),
    socketClosed: () => readFile(socketClosedPath, "utf8"),
    async gateEntered() {
      await vi.waitFor(
        async () => {
          if (spawnError) throw spawnError;
          const listenError = await readFile(listenErrorPath, "utf8").catch(() => "");
          expect(child.exitCode, `${await readFile(stderrPath, "utf8")} (listen ${listenError})`).toBeNull();
          await stat(enteredPath);
        },
        { timeout: 3_000, interval: 5 },
      );
    },
    async ready() {
      await vi.waitFor(
        async () => {
          if (spawnError) throw spawnError;
          const stderr = await readFile(stderrPath, "utf8");
          const listenError = await readFile(listenErrorPath, "utf8").catch(() => "");
          expect(
            await readFile(stdoutPath, "utf8"),
            `${stderr} (listen ${listenError}, exit ${child.exitCode}, signal ${child.signalCode})`,
          ).toBe(`emend: serving https://${name}\n`);
        },
        { timeout: 3_000, interval: 5 },
      );
    },
    holdCleanup: () => writeFile(holdPath, ""),
    cleanupStarted: () => stat(enteredPath),
    releaseCleanup: () => writeFile(releasePath, ""),
  };
}

test.each([
  ["process", "SIGHUP", "SIGHUP"],
  ["process", "SIGTERM", "SIGINT"],
  ["group", "SIGHUP", "SIGHUP"],
  ["group", "SIGTERM", "SIGINT"],
] as const)("signals to the %s: %s then %s allow cleanup to finish", async (target, first, second) => {
  const f = await fixture();
  await f.ready();
  expect(f.child.pid).toBeTypeOf("number");
  const pid = f.child.pid as number;
  await f.holdCleanup();
  process.kill(target === "group" ? -pid : pid, first);
  // The fake holds the cleanup status call so the next real signal lands during it.
  await vi.waitFor(() => f.cleanupStarted(), { timeout: 2_000, interval: 5 });
  await delay(10);
  process.kill(target === "group" ? -pid : pid, second);
  await f.releaseCleanup();
  expect(await f.closed).toEqual({ code: 0, signal: null });
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).map((call) => call.args).filter((args) => args === "serve --https=443 off")).toHaveLength(1);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(join(f.stateDir, "server-url.json"), "utf8"))).toEqual({
    baseUrl: `https://${name}`,
  });
});

test("a detached Tailscale child is still killed by the ten-second timeout", async () => {
  const started = performance.now();
  const f = await fixture({ timeout: true });
  await vi.waitFor(async () => expect(await f.calls(), await f.stderr()).toHaveLength(1), {
    timeout: 3_000,
    interval: 5,
  });
  const pid = (await f.calls())[0]?.pid;
  expect(pid).toBeTypeOf("number");
  // A negative pid addresses the group: this must be the fake's own group, not emend's.
  expect(() => process.kill(-(pid as number), 0)).not.toThrow();
  expect(await f.closed).toEqual({ code: 1, signal: null });
  expect(performance.now() - started).toBeGreaterThanOrEqual(9_900);
  expect(performance.now() - started).toBeLessThan(12_000);
  expect(await f.stderr()).toBe("emend: tailscale did not answer within 10 seconds.\n");
  expect(() => process.kill(pid as number, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}, 15_000);

test("startup SIGTERM waits for the referenced escalation after the launcher exits", async () => {
  const f = await fixture({ timeout: true, stubbornDescendant: true });
  await f.gateEntered();
  const descendant = await f.descendantPid();
  const started = performance.now();
  process.kill(f.child.pid as number, "SIGTERM");
  expect(await f.closed).toEqual({ code: 143, signal: null });
  expect(performance.now() - started).toBeGreaterThanOrEqual(900);
  expect(performance.now() - started).toBeLessThan(1_500);
  await vi.waitFor(async () => expect(await stopped(descendant)).toBe(true), { timeout: 500, interval: 10 });
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).map((call) => call.args)).toEqual(["status --json"]);
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("SIGTERM during listen closes the late server and exits 143", async () => {
  const f = await fixture({ phase: "listen", socketDouble: true });
  await f.gateEntered();
  process.kill(f.child.pid as number, "SIGTERM");
  await delay(100);
  await f.releaseCleanup();
  await vi.waitFor(() => expect(f.child.exitCode).toBe(143), { timeout: 2_000, interval: 10 });
  expect(await f.closed).toEqual({ code: 143, signal: null });
  expect(await f.socketClosed()).toBe("closed");
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).map((call) => call.args)).toEqual(["status --json"]);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["SIGTERM", "SIGHUP"] as const)(
  "a second %s while startup escalation is pending cannot leave a descendant alive",
  async (second) => {
    const f = await fixture({ timeout: true, stubbornDescendant: true });
    await f.gateEntered();
    const descendant = await f.descendantPid();
    const started = performance.now();
    process.kill(f.child.pid as number, "SIGTERM");
    await vi.waitFor(() => expect(f.cleanupStarted()).rejects.toMatchObject({ code: "ENOENT" }), {
      timeout: 500,
      interval: 5,
    });
    await delay(100);
    expect(await stopped(descendant)).toBe(false);
    process.kill(f.child.pid as number, second);
    expect(await f.closed).toEqual({ code: 143, signal: null });
    expect(performance.now() - started).toBeLessThan(1_500);
    await vi.waitFor(async () => expect(await stopped(descendant)).toBe(true), { timeout: 500, interval: 10 });
    expect(await f.stderr()).toBe("");
    expect((await f.calls()).map((call) => call.args)).toEqual(["status --json"]);
    await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)("%s forces exit %s after startup cleanup despite an unrelated open handle", async (signal, code) => {
  const f = await fixture({ timeout: true, keepAlive: true });
  await f.gateEntered();
  const launcher = await f.startedPid();
  process.kill(f.child.pid as number, signal);
  await vi.waitFor(() => expect(f.child.exitCode).toBe(code), { timeout: 2_500, interval: 10 });
  expect(await f.closed).toEqual({ code, signal: null });
  expect(await stopped(launcher)).toBe(true);
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).map((call) => call.args)).toEqual(["status --json"]);
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([false, true])(
  "SIGTERM during --bg removes only the applied setup (socket double: %s)",
  async (socketDouble) => {
    const f = await fixture({ phase: "bg", socketDouble });
    await f.gateEntered();
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    expect(config.Web[`${name}:443`].Handlers["/"].Proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    process.kill(f.child.pid as number, "SIGTERM");
    await delay(25);
    await f.releaseCleanup();
    expect(await f.closed).toEqual({ code: 0, signal: null });
    expect(await f.stderr()).toBe("");
    expect((await f.calls()).map((call) => call.args)).toEqual([
      "status --json",
      "serve status --json",
      `serve --bg --https=443 ${config.Web[`${name}:443`].Handlers["/"].Proxy}`,
      "serve status --json",
      "serve --https=443 off",
    ]);
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
    await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(f.stateDir, "server-url.json"), "utf8"))).toEqual({
      baseUrl: config.Web[`${name}:443`].Handlers["/"].Proxy,
    });
  },
);

test.each([false, true])(
  "a closed stdout pipe keeps serving and later SIGTERM cleans up (socket double: %s)",
  async (socketDouble) => {
    const f = await fixture({ phase: "bg", socketDouble, closedStdout: true });
    await f.gateEntered();
    await f.releaseCleanup();
    await vi.waitFor(async () => expect(await f.stdoutError()).toBe("EPIPE"), { timeout: 2_000, interval: 5 });
    // The error event is asynchronous; give an uncaught exception time to exit.
    await delay(100);
    expect(f.child.exitCode, await f.stderr()).toBeNull();
    expect((await stat(join(f.stateDir, "server.json"))).isFile()).toBe(true);
    process.kill(f.child.pid as number, "SIGTERM");
    expect(await f.closed).toEqual({ code: 0, signal: null });
    expect(await f.stderr()).toBe("");
    expect((await f.calls()).filter((call) => call.args === "serve --https=443 off")).toHaveLength(1);
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
    await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)("%s before listening exits %s and kills the detached status call", async (signal, code) => {
  const f = await fixture({ timeout: true });
  let fakePid = 0;
  await vi.waitFor(
    async () => {
      fakePid = await f.startedPid();
      expect(fakePid).toBeGreaterThan(0);
    },
    { timeout: 3_000, interval: 5 },
  );
  process.kill(f.child.pid as number, signal);
  expect(await f.closed).toEqual({ code, signal: null });
  await vi.waitFor(() => expect(() => process.kill(fakePid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" })), {
    timeout: 2_000,
    interval: 5,
  });
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).map((call) => call.args)).toEqual(["status --json"]);
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  ["off", "SIGHUP", "SIGHUP"],
  ["off", "SIGTERM", "SIGINT"],
  ["close", "SIGHUP", "SIGHUP"],
  ["close", "SIGTERM", "SIGINT"],
] as const)("a second signal during %s (%s then %s) lets cleanup finish", async (phase, first, second) => {
  const f = await fixture({ phase, socketDouble: true });
  await f.ready();
  const pid = f.child.pid as number;
  process.kill(-pid, first);
  await vi.waitFor(() => f.cleanupStarted(), { timeout: 2_000, interval: 5 });
  await delay(10);
  process.kill(-pid, second);
  await f.releaseCleanup();
  expect(await f.closed).toEqual({ code: 0, signal: null });
  expect(await f.stderr()).toBe("");
  expect((await f.calls()).filter((call) => call.args === "serve --https=443 off")).toHaveLength(1);
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["throw", "event"] as const)(
  "SIGHUP with failed removal and stderr %s still closes before reporting",
  async (stderrFailure) => {
    const f = await fixture({ stderrFailure, socketDouble: true });
    await f.ready();
    process.kill(f.child.pid as number, "SIGHUP");
    expect(await f.closed).toEqual({ code: 0, signal: null });
    await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.reports()).toEqual([{ discovery: false }]);
    expect((await f.calls()).filter((call) => call.args === "serve --https=443 off")).toHaveLength(1);
  },
);

test("teardown never signals a completed call's old pid", async () => {
  const f = await fixture({ socketDouble: true });
  await f.ready();
  // This owned sentinel stands in for a pid reused since an earlier fake exited.
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    env: { PATH: process.env.PATH, HOME: entryDir, LC_ALL: "C" },
  });
  const done = new Promise<void>((resolve) => sentinel.once("close", () => resolve()));
  onTestFinished(async () => {
    if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill("SIGKILL");
    await done;
  });
  await f.logOldPid(sentinel.pid as number);
  process.kill(f.child.pid as number, "SIGTERM");
  await f.closed;
  await f.cleanup();
  // Let close events from any erroneous teardown kill arrive.
  await delay(50);
  expect(sentinel.signalCode).toBeNull();
  expect(() => process.kill(sentinel.pid as number, 0)).not.toThrow();
});

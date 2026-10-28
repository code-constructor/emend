import { type ChildProcess, execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { CliError } from "./http.ts";
import { ensureTailscaleServe, tailscaleSelf } from "./tailscale.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => vi.mocked(spawn).mockClear());
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: "hub.example.ts.net" } });
const deadlineMs = 1_000;

async function fixture(body: (dir: string) => string) {
  const dir = await mkdtemp(join(tmpdir(), "emend-tailscale-process-"));
  await writeFile(join(dir, "tailscale"), `#!/bin/sh\n${body(dir)}\n`, { mode: 0o700 });
  const children: { child: ChildProcess; closed: boolean; done: Promise<void> }[] = [];
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation((...args: Parameters<typeof spawn>) => {
    const child = actual.spawn(...args);
    const held = { child, closed: false, done: Promise.resolve() };
    held.done = new Promise<void>((resolve) =>
      child.once("close", () => {
        held.closed = true;
        resolve();
      }),
    );
    children.push(held);
    return child;
  });
  onTestFinished(async () => {
    await writeFile(join(dir, "release"), "");
    for (const held of children) {
      // The child, or a descendant still holding its pipes, owns this live group.
      const childAlive = held.child.exitCode === null && held.child.signalCode === null;
      const openPipe = !held.child.stdout?.destroyed || !held.child.stderr?.destroyed;
      if (!held.closed && held.child.pid && (childAlive || openPipe)) {
        try {
          process.kill(-held.child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await held.done;
    }
    const descendant = await readFile(join(dir, "descendant"), "utf8").catch(() => "");
    if (descendant)
      await vi.waitFor(async () => expect(await stopped(Number(descendant))).toBe(true), {
        timeout: 2_000,
        interval: 10,
      });
    vi.mocked(spawn).mockImplementation(actual.spawn);
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, env: { PATH: dir, HOME: dir }, children };
}

async function stopped(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  // Orphans can briefly remain as zombies until init reaps them; they are already dead.
  const { stdout } = await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "stat="]);
  return stdout.trim().startsWith("Z");
}

test.each(["timeout", "overflow", "exit"] as const)(
  "%s ends a call whose descendant holds stdout and terminates the descendant",
  async (mode) => {
    const f = await fixture(
      (dir) => `
/bin/sleep 30 &
descendant=$!
printf '%s' "$descendant" > ${quote(join(dir, "descendant"))}
${mode === "exit" ? `printf '%s' '${status}'; exit 0` : mode === "overflow" ? `trap '' TERM\n/bin/dd if=/dev/zero bs=1048576 count=17 2>/dev/null\nwhile :; do :; done` : "wait"}
`,
    );
    const started = performance.now();
    const result = tailscaleSelf(f.env, undefined, { deadlineMs });
    const assertion =
      mode === "exit"
        ? expect(result).resolves.toEqual({ dnsName: "hub.example.ts.net" })
        : expect(result).rejects.toThrow(
            mode === "timeout"
              ? "tailscale did not answer within 1 second."
              : "could not read the output of tailscale status.",
          );
    await assertion;
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(mode === "timeout" ? deadlineMs + 2_000 : mode === "exit" ? 1_000 : 3_000);
    if (mode === "exit") expect(elapsed).toBeGreaterThanOrEqual(200);
    const pid = Number(await readFile(join(f.dir, "descendant"), "utf8"));
    await vi.waitFor(async () => expect(await stopped(pid)).toBe(true), { timeout: 1_000, interval: 10 });
  },
  5_000,
);

test("a child ignoring SIGTERM is killed about one second after the deadline", async () => {
  const f = await fixture(() => "trap '' TERM\nwhile :; do :; done");
  const started = performance.now();
  await expect(tailscaleSelf(f.env, undefined, { deadlineMs })).rejects.toThrow(
    "tailscale did not answer within 1 second.",
  );
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(deadlineMs + 900);
  expect(elapsed).toBeLessThan(deadlineMs + 2_000);
  expect(f.children[0]?.child.signalCode).toBe("SIGKILL");
}, 5_000);

test.each(["timeout", "exit", "overflow", "abort"] as const)(
  "%s settles before escalation but still kills a descendant that traps SIGTERM",
  async (mode) => {
    const f = await fixture(
      (dir) => `
trap 'exit 0' TERM
/bin/sh ${quote(join(dir, "descendant.sh"))} &
while [ ! -f ${quote(join(dir, "descendant"))} ]; do :; done
${mode === "exit" ? `printf '%s' '${status}'; exit 0` : mode === "overflow" ? "/bin/dd if=/dev/zero bs=1048576 count=17 2>/dev/null; wait" : "wait"}
`,
    );
    await writeFile(
      join(f.dir, "descendant.sh"),
      `trap ${quote(`printf term > ${quote(join(f.dir, "term"))}`)} TERM
printf '%s' "$$" > ${quote(join(f.dir, "descendant"))}
while [ ! -f ${quote(join(f.dir, "release"))} ]; do :; done
`,
    );
    const abort = new AbortController();
    const started = performance.now();
    const result = tailscaleSelf(f.env, abort.signal, { deadlineMs });
    const assertion =
      mode === "exit"
        ? expect(result).resolves.toEqual({ dnsName: "hub.example.ts.net" })
        : expect(result).rejects.toThrow(
            mode === "timeout"
              ? "tailscale did not answer within 1 second."
              : mode === "overflow"
                ? "could not read the output of tailscale status."
                : "synthetic abort",
          );
    if (mode === "abort") {
      await vi.waitFor(() => readFile(join(f.dir, "descendant")), { timeout: 1_000, interval: 5 });
      abort.abort(new Error("synthetic abort"));
    }
    await assertion;
    const settledAt = performance.now();
    expect(settledAt - started).toBeLessThan(mode === "timeout" ? deadlineMs + 500 : 1_000);
    const pid = Number(await readFile(join(f.dir, "descendant"), "utf8"));
    expect(await stopped(pid)).toBe(false);
    await vi.waitFor(async () => expect(await readFile(join(f.dir, "term"), "utf8")).toBe("term"), {
      timeout: 500,
      interval: 5,
    });
    await vi.waitFor(async () => expect(await stopped(pid)).toBe(true), { timeout: 1_500, interval: 10 });
    expect(performance.now() - settledAt).toBeLessThan(1_500);
  },
  5_000,
);

test("about 1 MiB of valid status JSON is read completely when the fake exits at once", async () => {
  const f = await fixture((dir) => `/bin/cat ${quote(join(dir, "status.json"))}\nexit 0`);
  await writeFile(join(f.dir, "status.json"), `${" ".repeat(1024 * 1024)}${status}`);
  await expect(tailscaleSelf(f.env)).resolves.toEqual({ dnsName: "hub.example.ts.net" });
});

test("status output arriving between exit and close is drained", async () => {
  const f = await fixture(() => "exit 0");
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(() => {
      child.stdout.write(status.slice(0, -1));
      child.emit("exit", 0, null);
      setTimeout(() => {
        child.stdout.end(status.slice(-1));
        child.stderr.end();
        child.emit("close", 0, null);
      }, 20);
    });
    return child as unknown as ChildProcess;
  });
  await expect(tailscaleSelf(f.env)).resolves.toEqual({ dnsName: "hub.example.ts.net" });
});

test("the deadline still bounds output draining after exit", async () => {
  const f = await fixture(() => "exit 0");
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    let closed = 0;
    for (const stream of [child.stdout, child.stderr])
      stream.once("close", () => {
        if (++closed === 2) child.emit("close", 0, null);
      });
    setImmediate(() => {
      child.stdout.write(status);
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcess;
  });
  const started = performance.now();
  await expect(tailscaleSelf(f.env, undefined, { deadlineMs: 100 })).rejects.toThrow(
    "tailscale did not answer within 0.1 seconds.",
  );
  expect(performance.now() - started).toBeLessThan(250);
});

test("a clean exit checks the group but sends no signal and adds no grace period", async () => {
  const f = await fixture(() => `printf '%s' '${status}'`);
  const kill = vi.spyOn(process, "kill");
  try {
    const started = performance.now();
    await expect(tailscaleSelf(f.env)).resolves.toEqual({ dnsName: "hub.example.ts.net" });
    expect(performance.now() - started).toBeLessThan(250);
    expect(kill.mock.calls).toEqual([[-(f.children[0]?.child.pid as number), 0]]);
  } finally {
    kill.mockRestore();
  }
});

test.each([false, true])("escalation probes the group before SIGKILL (still present: %s)", async (present) => {
  const f = await fixture(() => "exit 0");
  const pid = 12345;
  let groupExists = true;
  const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    expect(target).toBe(-pid);
    if (signal === 0 && !groupExists) throw Object.assign(new Error("group gone"), { code: "ESRCH" });
    return true;
  });
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough() });
    process.nextTick(() => {
      child.stdout.end(status);
      child.stderr.end();
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child as unknown as ChildProcess;
  });
  vi.useFakeTimers();
  try {
    await expect(tailscaleSelf(f.env)).resolves.toEqual({ dnsName: "hub.example.ts.net" });
    expect(kill.mock.calls).toEqual([
      [-pid, 0],
      [-pid, "SIGTERM"],
    ]);
    kill.mockClear();
    groupExists = present;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill.mock.calls).toEqual(
      present
        ? [
            [-pid, 0],
            [-pid, "SIGKILL"],
          ]
        : [[-pid, 0]],
    );
  } finally {
    vi.useRealTimers();
    kill.mockRestore();
  }
});

test.each(["status", "serve"] as const)(
  "a synchronous %s spawn failure uses only the generic error",
  async (command) => {
    const f = await fixture(() => "exit 0");
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw Object.assign(new Error("synthetic private spawn detail"), { code: "E2BIG" });
    });
    const result = command === "status" ? tailscaleSelf(f.env) : ensureTailscaleServe(3636, f.env);
    await expect(result).rejects.toEqual(
      new CliError(
        command === "status" ? "Tailscale is not running or not logged in." : "Could not configure Tailscale Serve.",
      ),
    );
  },
);

test.each(["EMFILE", "ENFILE"])("%s with null pipes is handled before the child error event", async (code) => {
  const f = await fixture(() => "exit 0");
  let hadErrorListener = false;
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null });
    process.nextTick(() => {
      hadErrorListener = child.listenerCount("error") > 0;
      // Keep the red run from crashing Vitest itself; the assertion still catches the missing listener.
      if (hadErrorListener) child.emit("error", Object.assign(new Error("synthetic spawn failure"), { code }));
      child.emit("close", -1, null);
    });
    return child as ChildProcess;
  });
  await expect(tailscaleSelf(f.env)).rejects.toEqual(new CliError("Tailscale is not running or not logged in."));
  expect(hadErrorListener).toBe(true);
});

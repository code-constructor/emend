import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { run } from "../../main.ts";
import * as serverModule from "../../server/serve.ts";

// Exercise real server state and CLI lifecycle without reserving a privileged TCP port.
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    listening = false;
    port = 0;
    listen(options: { port: number }, ready: () => void) {
      this.port = options.port || 41999;
      this.listening = true;
      queueMicrotask(ready);
    }
    address() {
      return { address: "127.0.0.1", port: this.port };
    }
    closeAllConnections() {}
    close(done: () => void) {
      this.listening = false;
      done();
    }
  }
  return { ...actual, createServer: () => new Socket() };
});
const name = "hub.example.ts.net";
const occupied = {
  TCP: { "443": { HTTPS: true } },
  Web: { [`${name}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture(
  initial: "empty" | "same" | "occupied" | "other-port" | "tls-port" = "empty",
  failure: "setup" | "stop" | "setup-after-write" | "setup-timeout" | undefined = undefined,
) {
  const dir = await mkdtemp(join(tmpdir(), "emend-serve-fix1-"));
  const configPath = join(dir, "config.json");
  const callsPath = join(dir, "calls");
  const own = {
    TCP: { "443": { HTTPS: true } },
    Web: { [`${name}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:41999" } } } },
  };
  const config =
    initial === "empty"
      ? {}
      : initial === "occupied"
        ? occupied
        : initial === "same"
          ? own
          : initial === "tls-port"
            ? { TCP: { "8443": { TCPForward: "127.0.0.1:8080", TerminateTLS: name } } }
            : {
                ...own,
                TCP: { ...own.TCP, "8443": { HTTPS: true } },
                Web: { ...own.Web, [`${name}:8443`]: { Handlers: { "/": { Text: "Synthetic other page" } } } },
              };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(
    join(dir, "tailscale"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(callsPath)}
if [ "$1" = status ]; then printf '%s\\n' '${JSON.stringify({ BackendState: "Running", Self: { DNSName: name } })}'
elif [ "$2" = status ]; then /bin/cat ${quote(configPath)}
elif [ "$2" = --bg ]; then
  ${failure === "setup" ? "printf 'permission denied' >&2; exit 1" : `printf '%s' ${quote(JSON.stringify(own))} > ${quote(configPath)}`}
  ${failure === "setup-after-write" ? "printf 'synthetic configuration failed' >&2; exit 1" : failure === "setup-timeout" ? "while :; do :; done" : ":"}
elif [ "$2" = --https=443 ] && [ "$3" = off ]; then ${failure === "stop" ? "printf 'permission denied' >&2; exit 1" : `printf '{}' > ${quote(configPath)}`}
else exit 7
fi
`,
    { mode: 0o700 },
  );
  const start = vi.spyOn(serverModule, "startServer");
  if (failure === "setup-timeout") {
    const tailscale = await import("../tailscale.ts");
    const ensure = tailscale.ensureTailscaleServe;
    vi.spyOn(tailscale, "ensureTailscaleServe").mockImplementation((port, env, name, onSetup, options) =>
      ensure(port, env, name, onSetup, { ...options, deadlineMs: 1_000 }),
    );
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    env: { EMEND_HOME: dir, PATH: dir, HOME: dir },
    stdout: (line: string) => {
      stdout.push(line);
    },
    stderr: (line: string) => {
      stderr.push(line);
    },
  };
  onTestFinished(async () => {
    process.emit("SIGTERM");
    for (const result of start.mock.results)
      if (result.type === "return") await result.value.then((server) => server.close());
    vi.restoreAllMocks();
    await rm(dir, { force: true, recursive: true });
  });
  return {
    dir,
    io,
    stdout,
    stderr,
    configPath,
    saved: async () => JSON.parse(await readFile(join(dir, "server-url.json"), "utf8")),
    calls: async () => (await readFile(callsPath, "utf8")).trim().split("\n"),
  };
}

test.each([80, 0])("startServer returns the actual numeric bound port for %s", async (port) => {
  const f = await fixture();
  const server = await serverModule.startServer({ stateDir: f.dir, port, publicOrigin: `https://${name}` });
  expect(server.port).toBe(port || 41999);
  expect(await f.saved()).toEqual({ baseUrl: server.url });
});
test.each(["occupied", "permission"] as const)(
  "failed setup (%s) retains only the loopback address for direct publishing",
  async (failure) => {
    const f = await fixture(
      failure === "occupied" ? "occupied" : "empty",
      failure === "permission" ? "setup" : undefined,
    );
    await writeFile(join(f.dir, "server-url.json"), JSON.stringify({ baseUrl: `https://${name}` }));
    expect(await run(["serve", "--tailscale", "--port", "0"], f.io)).toBe(1);
    expect(await f.saved()).toEqual({ baseUrl: "http://127.0.0.1:41999" });
    await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.calls()).not.toContain("serve --https=443 off");
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual([
      failure === "permission"
        ? "emend: Could not configure Tailscale Serve. Use a fixed --port, run `sudo tailscale serve --bg --https=443 http://127.0.0.1:<port>` once as root with that port, then try again.\n"
        : "emend: port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.\n",
    ]);
  },
);
test.each(["setup-after-write", "setup-timeout"] as const)(
  "a failed setup (%s) removes a half-applied handler and preserves the original error",
  async (failure) => {
    const f = await fixture("empty", failure);
    expect(await run(["serve", "--tailscale", "--port", "0"], f.io)).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual([
      failure === "setup-timeout"
        ? "emend: tailscale did not answer within 1 second.\n"
        : "emend: Could not configure Tailscale Serve.\n",
    ]);
    expect(await f.calls()).toEqual([
      "status --json",
      "serve status --json",
      "serve --bg --https=443 http://127.0.0.1:41999",
      "serve status --json",
      "serve --https=443 off",
    ]);
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
    expect(await f.saved()).toEqual({ baseUrl: "http://127.0.0.1:41999" });
    await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
  },
  5_000,
);
test("a failed setup without a write rechecks status and leaves the config untouched", async () => {
  const f = await fixture("tls-port", "setup");
  const before = await readFile(f.configPath, "utf8");
  expect(await run(["serve", "--tailscale", "--port", "41999"], f.io)).toBe(1);
  expect(f.stderr).toEqual([
    "emend: Could not configure Tailscale Serve. Run `sudo tailscale serve --bg --https=443 http://127.0.0.1:41999` once as root, then try again. emend uses that route and never removes it.\n",
  ]);
  expect(await f.calls()).toEqual([
    "status --json",
    "serve status --json",
    "serve --bg --https=443 http://127.0.0.1:41999",
    "serve status --json",
  ]);
  expect(await readFile(f.configPath, "utf8")).toBe(before);
  expect(await f.saved()).toEqual({ baseUrl: "http://127.0.0.1:41999" });
});
test.each(["empty", "same"] as const)(
  "a stop after %s setup removes only a Serve route created by this process",
  async (initial) => {
    const f = await fixture(initial);
    const before = await readFile(f.configPath, "utf8");
    const result = run(["serve", "--tailscale", "--port", "0"], f.io);
    await vi.waitFor(() => expect(f.stdout).toEqual([`emend: serving https://${name}\n`]));
    expect(await f.saved()).toEqual({ baseUrl: `https://${name}` });
    process.emit(initial === "empty" ? "SIGINT" : "SIGTERM");
    expect(await result).toBe(0);
    expect(await f.calls()).toEqual([
      "status --json",
      "serve status --json",
      ...(initial === "empty"
        ? ["serve --bg --https=443 http://127.0.0.1:41999", "serve status --json", "serve --https=443 off"]
        : []),
    ]);
    expect(await readFile(f.configPath, "utf8")).toBe(before);
    expect(f.stderr).toEqual([]);
    expect(await f.saved()).toEqual({ baseUrl: `https://${name}` });
    await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
test("SIGHUP removes the matching handler and discovery file, retaining the public address", async () => {
  const f = await fixture();
  const result = run(["serve", "--tailscale", "--port", "0"], f.io);
  try {
    await vi.waitFor(() => expect(f.stdout).toHaveLength(1));
    expect((await stat(join(f.dir, "server.json"))).isFile()).toBe(true);
    process.emit("SIGHUP");
    await vi.waitFor(async () => expect(await f.calls()).toContain("serve --https=443 off"));
    expect(await result).toBe(0);
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
    await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.saved()).toEqual({ baseUrl: `https://${name}` });
    expect(f.stderr).toEqual([]);
  } finally {
    process.emit("SIGTERM");
    await result;
  }
});
test("a handler replaced before shutdown is never removed", async () => {
  const f = await fixture();
  const result = run(["serve", "--tailscale", "--port", "0"], f.io);
  await vi.waitFor(() => expect(f.stdout).toHaveLength(1));
  await writeFile(f.configPath, JSON.stringify(occupied));
  process.emit("SIGTERM");
  expect(await result).toBe(0);
  expect(await f.calls()).not.toContain("serve --https=443 off");
});
test("cleanup failure prints one stderr line and keeps a successful exit code", async () => {
  const f = await fixture("empty", "stop");
  const result = run(["serve", "--tailscale", "--port", "0"], f.io);
  await vi.waitFor(() => expect(f.stdout).toHaveLength(1));
  process.emit("SIGTERM");
  expect(await result).toBe(0);
  expect(f.stderr).toHaveLength(1);
  expect(f.stderr[0]).toContain("Run `sudo tailscale set --operator=$USER` once, then try again.");
});
test("a throwing shutdown stderr writer cannot change the exit code or run before close", async () => {
  const f = await fixture("empty", "stop");
  const discoveryAtReport: boolean[] = [];
  f.io.stderr = () => {
    discoveryAtReport.push(existsSync(join(f.dir, "server.json")));
    throw Object.assign(new Error("write EIO"), { code: "EIO" });
  };
  const result = run(["serve", "--tailscale", "--port", "0"], f.io);
  await vi.waitFor(() => expect(f.stdout).toHaveLength(1));
  process.emit("SIGHUP");
  await expect(result).resolves.toBe(0);
  expect(discoveryAtReport).toEqual([false]);
  await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
test("a throwing stdout writer keeps serving until a signal cleans up", async () => {
  const f = await fixture();
  let attempted = false;
  f.io.stdout = () => {
    attempted = true;
    throw new Error("synthetic stdout failure");
  };
  let settled = false;
  const result = run(["serve", "--tailscale", "--port", "0"], f.io).then((code) => {
    settled = true;
    return code;
  });
  try {
    await vi.waitFor(() => expect(attempted).toBe(true));
    expect(settled).toBe(false);
    expect(await f.saved()).toEqual({ baseUrl: `https://${name}` });
    expect(existsSync(join(f.dir, "server.json"))).toBe(true);
    expect(await f.calls()).not.toContain("serve --https=443 off");
  } finally {
    process.emit("SIGTERM");
    await result;
  }
  expect(await result).toBe(0);
  expect(await f.calls()).toContain("serve --https=443 off");
  expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual({});
  expect(await f.saved()).toEqual({ baseUrl: `https://${name}` });
  expect(f.stderr).toEqual([]);
  await expect(stat(join(f.dir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
test.each(["other-port", "tls-port"] as const)(
  "another HTTPS port (%s) on the same name warns once and startup continues",
  async (initial) => {
    const f = await fixture(initial);
    const result = run(["serve", "--tailscale", "--port", "0"], f.io);
    try {
      await vi.waitFor(() => expect(f.stdout).toHaveLength(1));
      expect(f.stderr).toEqual([
        `emend: warning: Tailscale Serve also serves other HTTPS ports on ${name}; pages there receive emend's sign-in cookie.\n`,
      ]);
    } finally {
      process.emit("SIGTERM");
      await result;
    }
  },
);

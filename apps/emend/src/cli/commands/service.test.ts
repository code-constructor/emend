import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { LIMITS } from "@emend/contract";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type Io, run } from "../../main.ts";
import * as stateFiles from "../../state/files.ts";
import type { ServiceOptions, ServiceResult, ServiceRunner } from "../service/common.ts";
import { writeService } from "../service/common.ts";

vi.mock("../service/common.ts", async (original) => {
  const actual = await original<typeof import("../service/common.ts")>();
  return { ...actual, writeService: vi.fn(actual.writeService) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), unlink: vi.fn(actual.unlink) };
});
vi.mock("../../state/files.ts", async (original) => ({ ...(await original<typeof import("../../state/files.ts")>()) }));

const ok: ServiceResult = { code: 0, stdout: "", stderr: "" };
const failed: ServiceResult = { code: 1, stdout: "", stderr: "first failure\nmore detail\n" };
const unsupported = "emend: emend service supports systemd on Linux and launchd on macOS; run emend serve yourself.\n";
const linger = "To keep emend running after you log out, run sudo loginctl enable-linger $USER.\n";

let root: string;
let home: string;
let state: string;
let bin: string;
let stdout: string[];
let stderr: string[];
let options: ServiceOptions;
let io: Io;
let recorded: ReturnType<typeof vi.fn<ServiceRunner>>;
let elapsed: number;
let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(process.env.EMEND_HOME as string, "service-")));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(unlink).mockImplementation(actual.unlink);
  // Only synthetic repositories belong to this fixture, including on hosts with a .git above it.
  vi.mocked(lstat).mockImplementation(async (...args) => {
    const entry = String(args[0]);
    if (entry.endsWith(`${sep}.git`) && !entry.startsWith(`${root}${sep}`))
      throw Object.assign(new Error("no synthetic repository entry"), { code: "ENOENT" });
    return actual.lstat(...args);
  });
  home = join(root, "home space%&");
  state = join(home, "state");
  bin = join(root, "bin");
  await mkdir(home);
  await mkdir(state, { mode: 0o700 });
  await mkdir(bin);
  for (const tool of ["systemctl", "loginctl", "launchctl"]) {
    // These are only resolved, never executed: every call goes to the recorded runner.
    await writeFile(join(bin, tool), "synthetic executable\n", { mode: 0o755 });
  }
  stdout = [];
  stderr = [];
  recorded = vi.fn(async (_file, args) => (args[0] === "print" ? failed : ok));
  elapsed = 0;
  sleep = vi.fn(async (ms) => {
    elapsed += ms;
  });
  const cwd = join(root, "cwd");
  await mkdir(cwd);
  await mkdir(join(cwd, ".git"));
  await writeFile(join(home, "node"), "synthetic node");
  await writeFile(join(home, "emend.mjs"), "synthetic entry");
  options = {
    platform: "linux",
    home,
    node: join(home, "node"),
    entry: join(home, "emend.mjs"),
    username: "synthetic-user",
    uid: 501,
    runner: recorded,
    cwd,
    now: () => elapsed,
    sleep,
  };
  io = {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    env: { HOME: home, EMEND_HOME: state, PATH: bin },
    service: options,
  };
});

function unitPath() {
  return join(home, ".config/systemd/user/emend.service");
}
function plistPath() {
  return join(home, "Library/LaunchAgents/dev.emend.server.plist");
}
function pendingPath() {
  return join(state, "service.pending");
}
function optionsPath() {
  return join(state, "service.json");
}
async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
function calls() {
  return recorded.mock.calls.map(([file, args]) => [file, ...args]);
}
function systemctl(...args: string[]) {
  return [join(bin, "systemctl"), "--user", ...args];
}
function loginctl() {
  return [join(bin, "loginctl"), "show-user", "synthetic-user", "--property=Linger", "--value"];
}
function launchctl(...args: string[]) {
  return [join(bin, "launchctl"), ...args];
}
function resetOutput() {
  recorded.mockClear();
  stdout.length = 0;
  stderr.length = 0;
}
async function invoke(...args: string[]) {
  return run(["service", ...args], io);
}

test("Linux writes the exact unit with port 4000, spaces, percent, and the resolved state directory", async () => {
  expect(await invoke("install", "--port", "4000")).toBe(0);
  const escapedHome = home.replaceAll("%", "%%");
  expect(await readFile(unitPath(), "utf8")).toBe(`# written by emend
[Unit]
Description=emend review server

[Service]
Type=exec
ExecStart="${escapedHome}/node" "${escapedHome}/emend.mjs" serve --port 4000
Environment="EMEND_HOME=${escapedHome}/state"
Restart=on-failure

[Install]
WantedBy=default.target
`);
  expect(calls()).toEqual([
    systemctl("daemon-reload"),
    systemctl("enable", "emend"),
    systemctl("restart", "emend"),
    loginctl(),
  ]);
  expect(stderr).toEqual([]);
});

test.each(["deleted unit", "failed uninstall"])(
  "Linux replaces a running public-host service after a %s",
  async (cause) => {
    let running = "";
    recorded.mockImplementation(async (_file, args) => {
      if (args.includes("disable")) return failed;
      // systemd start leaves an active process alone; restart always uses the current unit.
      if (args.includes("restart") || (args.includes("enable") && args.includes("--now") && !running))
        running = await readFile(unitPath(), "utf8");
      return ok;
    });
    expect(await invoke("install", "--host", "0.0.0.0")).toBe(0);
    expect(running).toContain("--host 0.0.0.0");
    if (cause === "deleted unit") await unlink(unitPath());
    else {
      expect(await invoke("uninstall")).toBe(0);
      expect(stderr).toHaveLength(1);
    }
    await expect(lstat(unitPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(running).toContain("--host 0.0.0.0");
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(calls()).toEqual([
      systemctl("daemon-reload"),
      systemctl("enable", "emend"),
      systemctl("restart", "emend"),
      loginctl(),
    ]);
    expect(running).toBe(await readFile(unitPath(), "utf8"));
    expect(running).not.toContain("--host");
    expect(stdout).toEqual(["emend: service installed\n"]);
  },
);

test("Linux reloads an unchanged unit with no pending record after an interrupted uninstall", async () => {
  let loaded = "";
  let running = "";
  recorded.mockImplementation(async (_file, args) => {
    if (args.includes("disable")) return failed;
    if (args.includes("daemon-reload")) loaded = await readFile(unitPath(), "utf8");
    if (args.includes("restart")) running = loaded;
    return ok;
  });
  expect(await invoke("install", "--host", "0.0.0.0")).toBe(0);
  expect(running).toContain("--host 0.0.0.0");
  const writer = stateFiles.writeSecretFile;
  const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementation((file, ...args) => {
    if (file === optionsPath()) throw new Error("synthetic interruption after unit rename");
    return writer(file, ...args);
  });
  try {
    expect(await invoke("install", "--port", "3636")).toBe(1);
  } finally {
    spy.mockRestore();
  }
  const content = await readFile(unitPath(), "utf8");
  expect(content).toContain("serve --port 3636");
  expect(content).not.toContain("--host");
  expect(loaded).toContain("--host 0.0.0.0");
  await expect(lstat(pendingPath())).resolves.toBeDefined();

  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(unlink).mockImplementation(async (file) => {
    if (file === unitPath()) throw new Error("synthetic interruption before unit removal");
    return actual.unlink(file);
  });
  resetOutput();
  try {
    expect(await invoke("uninstall")).toBe(1);
  } finally {
    vi.mocked(unlink).mockImplementation(actual.unlink);
  }
  expect(calls()).toEqual([systemctl("disable", "--now", "emend")]);
  await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(unitPath(), "utf8")).toBe(content);
  expect(loaded).toContain("--host 0.0.0.0");

  resetOutput();
  vi.mocked(writeService).mockClear();
  expect(await invoke("install", "--port", "3636")).toBe(0);
  expect(writeService).not.toHaveBeenCalled();
  expect(calls()).toEqual([
    systemctl("daemon-reload"),
    systemctl("enable", "emend"),
    systemctl("restart", "emend"),
    loginctl(),
  ]);
  expect(loaded).toBe(content);
  expect(running).toBe(content);
  expect(stdout).toEqual(["emend: service installed\n"]);
  expect(stderr).toEqual([]);
  await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
});

test("macOS writes the exact plist with port 4000 and XML-escaped paths", async () => {
  options.platform = "darwin";
  options.node = join(home, `node<>"'`);
  await writeFile(options.node, "synthetic node");
  expect(await invoke("install", "--port", "4000")).toBe(0);
  const xmlHome = home.replaceAll("&", "&amp;");
  expect(await readFile(plistPath(), "utf8")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!-- written by emend -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.emend.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlHome}/node&lt;&gt;&quot;&apos;</string>
    <string>${xmlHome}/emend.mjs</string>
    <string>serve</string>
    <string>--port</string>
    <string>4000</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EMEND_HOME</key>
    <string>${xmlHome}/state</string>
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
  <string>${xmlHome}/Library/Logs/emend.log</string>
  <key>StandardErrorPath</key>
  <string>${xmlHome}/Library/Logs/emend.log</string>
</dict>
</plist>
`);
  expect(calls()).toEqual([launchctl("bootstrap", "gui/501", plistPath())]);
  expect((await stat(join(home, "Library/Logs"))).isDirectory()).toBe(true);
  expect(stderr).toEqual([]);
});

test.each([undefined, "relative", "/absolute"])(
  "Linux selects the unit directory for XDG_CONFIG_HOME=%s",
  async (value) => {
    io.env.XDG_CONFIG_HOME = value === "/absolute" ? join(root, "custom-config") : value;
    expect(await invoke("install")).toBe(0);
    const path = value === "/absolute" ? join(root, "custom-config/systemd/user/emend.service") : unitPath();
    expect(await readFile(path, "utf8")).toContain(" serve\n");
  },
);

describe.each(["linux", "darwin"])("%s service lifecycle", (platform) => {
  const path = () => (platform === "linux" ? unitPath() : plistPath());
  beforeEach(() => {
    options.platform = platform;
  });

  test("identical install preserves bytes and mtime while restarting the service", async () => {
    expect(await invoke("install", "--port", "4000")).toBe(0);
    const content = await readFile(path());
    await utimes(path(), 1000, 1000);
    const before = await stat(path());
    resetOutput();
    expect(await invoke("install", "--port", "4000")).toBe(0);
    expect(await readFile(path())).toEqual(content);
    expect((await stat(path())).mtimeMs).toBe(before.mtimeMs);
    expect(calls()).toEqual(
      platform === "linux"
        ? [systemctl("daemon-reload"), systemctl("enable", "emend"), systemctl("restart", "emend"), loginctl()]
        : [
            launchctl("bootout", "gui/501/dev.emend.server"),
            launchctl("print", "gui/501/dev.emend.server"),
            launchctl("bootstrap", "gui/501", path()),
          ],
    );
  });

  test("changed install applies the flags in their original order", async () => {
    expect(await invoke("install", "--port", "4000")).toBe(0);
    resetOutput();
    if (platform === "darwin") recorded.mockResolvedValueOnce(failed).mockResolvedValueOnce(failed);
    expect(await invoke("install", "--port", "4001", "--host", "192.0.2.1")).toBe(0);
    const content = await readFile(path(), "utf8");
    expect(content.indexOf("4001")).toBeLessThan(content.indexOf("--host"));
    expect(content).toContain("192.0.2.1");
    expect(calls()).toEqual(
      platform === "linux"
        ? [systemctl("daemon-reload"), systemctl("enable", "emend"), systemctl("restart", "emend"), loginctl()]
        : [
            launchctl("bootout", "gui/501/dev.emend.server"),
            launchctl("print", "gui/501/dev.emend.server"),
            launchctl("bootstrap", "gui/501", path()),
          ],
    );
    expect(stderr).toEqual([]);
  });

  test.each([false, true])("uninstall removes an owned file even when stop fails: %s", async (stopFails) => {
    expect(await invoke("install")).toBe(0);
    resetOutput();
    if (stopFails) recorded.mockResolvedValueOnce(failed);
    expect(await invoke("uninstall")).toBe(0);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls()).toEqual(
      platform === "linux"
        ? [systemctl("disable", "--now", "emend"), systemctl("daemon-reload")]
        : [launchctl("bootout", "gui/501/dev.emend.server")],
    );
    expect(stderr).toHaveLength(stopFails ? 1 : 0);
    if (stopFails) {
      expect(stderr[0]).toContain("first failure\n");
      expect(stderr[0]?.split("\n")).toHaveLength(2);
      expect(stderr[0]).toContain(platform === "linux" ? "systemctl --user disable --now emend" : "launchctl bootout");
    }
  });

  test("uninstall of an absent service succeeds without running a command", async () => {
    await writeFile(optionsPath(), "invalid stale options");
    expect(await invoke("uninstall")).toBe(0);
    expect(stdout).toEqual(["emend: the service is not installed.\n"]);
    expect(stderr).toEqual([]);
    expect(calls()).toEqual([]);
    await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["install", "uninstall"])("%s leaves a foreign file byte for byte unchanged", async (command) => {
    const foreign =
      platform === "linux" ? "# foreign\n# written by emend\n" : "<!-- foreign -->\n<!-- written by emend -->\n";
    await put(path(), foreign);
    expect(await invoke(command)).toBe(1);
    expect(await readFile(path(), "utf8")).toBe(foreign);
    expect(stderr).toEqual([`emend: ${path()} was not written by emend; move it away, then try again.\n`]);
    expect(stdout).toEqual([]);
    expect(calls()).toEqual([]);
  });

  test("a marker line at EOF still identifies an owned service", async () => {
    await put(
      path(),
      platform === "linux" ? "# written by emend" : '<?xml version="1.0" encoding="UTF-8"?>\n<!-- written by emend -->',
    );
    expect(await invoke("uninstall")).toBe(0);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["install", "uninstall"])(
    "%s refuses a symlink even when its target carries the marker",
    async (command) => {
      expect(await invoke("install")).toBe(0);
      const target = path();
      const content = await readFile(target);
      options.home = join(root, "other-home");
      await mkdir(options.home);
      const linked =
        platform === "linux"
          ? join(options.home, ".config/systemd/user/emend.service")
          : join(options.home, "Library/LaunchAgents/dev.emend.server.plist");
      await mkdir(dirname(linked), { recursive: true });
      await symlink(target, linked);
      resetOutput();
      expect(await invoke(command)).toBe(1);
      expect(await readFile(target)).toEqual(content);
      expect((await lstat(linked)).isSymbolicLink()).toBe(true);
      expect(calls()).toEqual([]);
    },
  );

  test.each(["absent", "stopped", "running", "failed-query"])(
    "status reports %s in one stdout line",
    async (status) => {
      if (status !== "absent") await put(path(), "foreign but installed\n");
      recorded.mockResolvedValue(
        status === "failed-query" || (platform === "linux" && status === "stopped")
          ? failed
          : { ...ok, stdout: status === "running" ? "target = {\n\tstate = running\n}\n" : "state = not running\n" },
      );
      expect(await invoke("status")).toBe(0);
      expect(stdout).toEqual([
        status === "absent"
          ? "emend: service not installed\n"
          : `emend: service ${status === "running" ? "running" : "installed but not running"} (${path()})\n`,
      ]);
      expect(stderr).toEqual([]);
      expect(calls()).toEqual(
        status === "absent"
          ? []
          : platform === "linux"
            ? [systemctl("is-active", "emend")]
            : [launchctl("print", "gui/501/dev.emend.server")],
      );
    },
  );
});

test("an identical but unloaded launch agent is bootstrapped without rewriting", async () => {
  options.platform = "darwin";
  expect(await invoke("install")).toBe(0);
  await utimes(plistPath(), 1000, 1000);
  resetOutput();
  recorded.mockResolvedValueOnce(failed);
  expect(await invoke("install")).toBe(0);
  expect((await stat(plistPath())).mtimeMs).toBe(1000000);
  expect(calls()).toEqual([
    launchctl("bootout", "gui/501/dev.emend.server"),
    launchctl("print", "gui/501/dev.emend.server"),
    launchctl("bootstrap", "gui/501", plistPath()),
  ]);
});

test.each(["no", "yes", "failed", "missing"])("linger %s prints only the prescribed advice when off", async (value) => {
  if (value === "missing") await chmod(join(bin, "loginctl"), 0o644);
  recorded.mockImplementation(async (file) =>
    file.endsWith("/loginctl") ? (value === "failed" ? failed : { ...ok, stdout: `${value}\n` }) : ok,
  );
  expect(await invoke("install")).toBe(0);
  expect(stdout.filter((line) => line.includes("linger"))).toEqual(value === "no" ? [linger] : []);
  expect(stderr).toEqual([]);
});

test.each(
  [
    [],
    ["unknown"],
    ["install", "--tailscale", "--tailscale"],
    ["install", "--port", "65536"],
    ["install", "--port", "4000", "--port", "4001"],
    ["status", "--port", "4000"],
    ["uninstall", "extra"],
  ].map((args) => ({ args })),
)("invalid service arguments $args are usage errors before side effects", async ({ args }) => {
  expect(await invoke(...args)).toBe(2);
  expect(stderr).toHaveLength(1);
  expect(stderr[0]?.split("\n")).toHaveLength(2);
  expect(stdout).toEqual([]);
  expect(calls()).toEqual([]);
  await expect(lstat(join(home, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["win32", "freebsd", "linux"])(
  "unsupported %s or missing systemctl fails before writes",
  async (platform) => {
    options.platform = platform;
    io.env.PATH = ":relative";
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([unsupported]);
    expect(calls()).toEqual([]);
    await expect(lstat(join(home, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("missing launchctl fails before writing a plist", async () => {
  options.platform = "darwin";
  io.env.PATH = "relative";
  expect(await invoke("install")).toBe(1);
  expect(stderr).toEqual([unsupported]);
  expect(calls()).toEqual([]);
  await expect(lstat(join(home, "Library"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a fake systemctl in a relative PATH entry is never run", async () => {
  await mkdir(join(home, "relative"));
  await writeFile(join(home, "relative/systemctl"), "synthetic relative executable\n", { mode: 0o755 });
  io.env.PATH = `${relative(process.cwd(), join(home, "relative"))}::${bin}`;
  expect(await invoke("install")).toBe(0);
  expect(calls()).toEqual([
    systemctl("daemon-reload"),
    systemctl("enable", "emend"),
    systemctl("restart", "emend"),
    loginctl(),
  ]);
  expect(recorded.mock.calls[0]).toEqual([
    join(bin, "systemctl"),
    ["--user", "daemon-reload"],
    { cwd: home, env: { ...io.env, PATH: bin } },
  ]);
});

test.each(["\n", "\r", "\t", "\0", "\u001b", "\u007f", "\u0085"])(
  "control character %j is refused before writing anything",
  async (control) => {
    options.entry = join(home, `entry${control}.mjs`);
    expect(await invoke("install")).toBe(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.split("\n")).toHaveLength(2);
    expect(calls()).toEqual([]);
    await expect(lstat(join(home, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["node", "entry", "home"] as const)("relative %s is refused before writing", async (key) => {
  options[key] = "relative";
  expect(await invoke("install")).toBe(1);
  expect(stderr).toHaveLength(1);
  expect(calls()).toEqual([]);
});

describe.each(["linux", "darwin"])("%s pending installs", (platform) => {
  const path = () => (platform === "linux" ? unitPath() : plistPath());
  const changedCalls = () =>
    platform === "linux"
      ? [systemctl("daemon-reload"), systemctl("enable", "emend"), systemctl("restart", "emend"), loginctl()]
      : [
          launchctl("bootout", "gui/501/dev.emend.server"),
          launchctl("print", "gui/501/dev.emend.server"),
          launchctl("bootstrap", "gui/501", path()),
        ];
  beforeEach(() => {
    options.platform = platform;
  });

  for (const previous of ["absent", "changed"]) {
    const steps =
      platform === "linux"
        ? ["write", "daemon-reload", "enable", "restart"]
        : ["write", ...(previous === "changed" ? ["wait"] : []), "bootstrap"];
    test.each(steps)(`a failed ${previous} install at %s is finished by a retry`, async (step) => {
      if (previous === "changed") expect(await invoke("install")).toBe(0);
      resetOutput();
      if (step === "write") vi.mocked(writeService).mockRejectedValueOnce(new Error("synthetic write failure"));
      recorded.mockImplementation(async (_file, args) => {
        await expect(lstat(pendingPath())).resolves.toBeDefined();
        if (args[0] === "print") return step === "wait" ? ok : failed;
        return args.includes(step) ? failed : ok;
      });
      expect(await invoke("install", "--port", "4000")).toBe(1);
      await expect(lstat(pendingPath())).resolves.toBeDefined();
      if (step !== "write") expect(await readFile(path(), "utf8")).toContain("4000");
      expect(stderr).toHaveLength(1);
      expect(stderr[0]?.split("\n")).toHaveLength(2);
      if (step !== "write" && step !== "wait") {
        expect(stderr[0]).toContain(step);
        expect(stderr[0]).toContain("first failure\n");
      }
      expect(stdout).toEqual([]);
      const identical = step !== "write";
      const content = identical ? await readFile(path()) : undefined;
      if (identical) await utimes(path(), 1000, 1000);
      resetOutput();
      recorded.mockImplementation(async (_file, args) => (args[0] === "print" ? failed : ok));
      expect(await invoke("install", "--port", "4000")).toBe(0);
      expect(calls()).toEqual(changedCalls());
      if (identical) {
        expect(await readFile(path())).toEqual(content);
        expect((await stat(path())).mtimeMs).toBe(1000000);
      }
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      resetOutput();
      recorded.mockImplementation(async (_file, args) => (args[0] === "print" ? failed : ok));
      expect(await invoke("install", "--port", "4000")).toBe(0);
      expect(calls()).toEqual(
        platform === "linux"
          ? [systemctl("daemon-reload"), systemctl("enable", "emend"), systemctl("restart", "emend"), loginctl()]
          : [
              launchctl("bootout", "gui/501/dev.emend.server"),
              launchctl("print", "gui/501/dev.emend.server"),
              launchctl("bootstrap", "gui/501", path()),
            ],
      );
    });
  }

  test.each([false, true])("uninstall clears a pending marker with an installed file: %s", async (installed) => {
    if (installed) expect(await invoke("install")).toBe(0);
    await writeFile(pendingPath(), "pending\n");
    expect(await invoke("uninstall")).toBe(0);
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("status ignores a pending marker", async () => {
    await writeFile(pendingPath(), "pending\n");
    expect(await invoke("status")).toBe(0);
    expect(stdout).toEqual(["emend: service not installed\n"]);
    expect(await readFile(pendingPath(), "utf8")).toBe("pending\n");
    expect(calls()).toEqual([]);
  });
});

test.each([false, true])("launchd waits for disappearance even when bootout fails: %s", async (bootoutFails) => {
  options.platform = "darwin";
  expect(await invoke("install")).toBe(0);
  resetOutput();
  recorded
    .mockResolvedValueOnce(bootoutFails ? failed : ok)
    .mockResolvedValueOnce(ok)
    .mockResolvedValueOnce(ok)
    .mockResolvedValueOnce(failed);
  expect(await invoke("install", "--port", "4000")).toBe(0);
  expect(calls()).toEqual([
    launchctl("bootout", "gui/501/dev.emend.server"),
    ...Array.from({ length: 3 }, () => launchctl("print", "gui/501/dev.emend.server")),
    launchctl("bootstrap", "gui/501", plistPath()),
  ]);
  expect(sleep.mock.calls).toEqual([[200], [200]]);
  expect(elapsed).toBe(400);
  expect(stderr).toEqual([]);
});

test("launchd stops waiting at ten seconds, keeps the marker, and never bootstraps the dying job", async () => {
  options.platform = "darwin";
  expect(await invoke("install")).toBe(0);
  resetOutput();
  recorded.mockResolvedValue(ok);
  expect(await invoke("install", "--port", "4000")).toBe(1);
  expect(elapsed).toBe(10000);
  expect(sleep.mock.calls).toEqual(Array.from({ length: 50 }, () => [200]));
  expect(calls().filter((call) => call[1] === "bootstrap")).toEqual([]);
  expect(stderr).toEqual(["emend: the old emend service did not stop; try again.\n"]);
  await expect(lstat(pendingPath())).resolves.toBeDefined();
});

test.each(["$", '"', "'", "\\"])("Linux refuses node paths containing %j before writing", async (char) => {
  options.node = join(home, `node${char}`);
  await writeFile(options.node, "synthetic node");
  expect(await invoke("install")).toBe(1);
  expect(stderr).toEqual([
    "emend: the node path contains $, quotes or a backslash, which a systemd unit cannot run; use a node installed at a plain path.\n",
  ]);
  expect(calls()).toEqual([]);
  await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(home, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("Linux keeps dollar escaping for the entry and literal dollars in Environment", async () => {
  options.entry = join(home, "entry$VAR%.mjs");
  await writeFile(options.entry, "synthetic entry");
  io.env.EMEND_HOME = join(home, "state$VAR%");
  expect(await invoke("install")).toBe(0);
  const content = await readFile(unitPath(), "utf8");
  expect(content).toContain("entry$$VAR%%.mjs");
  expect(content).toContain("state$VAR%%");
});

test.each(["$", '"', "'", "\\"])("macOS still accepts node paths containing %j", async (char) => {
  options.platform = "darwin";
  options.node = join(home, `node${char}`);
  await writeFile(options.node, "synthetic node");
  expect(await invoke("install")).toBe(0);
  expect(calls()).toEqual([launchctl("bootstrap", "gui/501", plistPath())]);
});

describe.each(["linux", "darwin"])("%s install boundaries", (platform) => {
  const path = () => (platform === "linux" ? unitPath() : plistPath());
  beforeEach(() => {
    options.platform = platform;
  });

  test.each([
    { key: "node", linked: false },
    { key: "node", linked: true },
    { key: "entry", linked: false },
    { key: "entry", linked: true },
  ] as const)("refuses $key resolved inside the current repository (symlink=$linked)", async ({ key, linked }) => {
    const repo = join(root, "reviewed");
    options.cwd = join(repo, "nested");
    await mkdir(options.cwd, { recursive: true });
    await mkdir(join(repo, ".git"));
    const target = join(repo, "node_modules/@shllg/emend/dist", key);
    await put(target, "synthetic runtime");
    const link = join(home, `${key}-link`);
    await symlink(target, link);
    options[key] = linked ? link : target;
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([
      "emend: this emend runs from inside the current repository; run emend service install from outside it.\n",
    ]);
    expect(calls()).toEqual([]);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    resetOutput();
    options.cwd = join(root, "cwd");
    expect(await invoke("install")).toBe(0);
  });

  for (const nested of ["sub", ".worktrees/feat"]) {
    test.each([
      { key: "node", linked: false },
      { key: "node", linked: true },
      { key: "entry", linked: false },
      { key: "entry", linked: true },
    ] as const)(`from ${nested}, refuses $key in the outer repository (symlink=$linked)`, async ({ key, linked }) => {
      const repo = join(root, "reviewed");
      const inner = join(repo, nested);
      await mkdir(join(repo, ".git", nested === "sub" ? "modules/sub" : "worktrees/feat"), { recursive: true });
      await put(
        join(inner, ".git"),
        `gitdir: ${nested === "sub" ? "../.git/modules/sub" : "../../.git/worktrees/feat"}\n`,
      );
      const cwd = join(inner, "nested");
      await mkdir(cwd);
      // Resolve the current directory too: its spelling need not be inside either repository.
      options.cwd = join(root, "cwd-link");
      await symlink(cwd, options.cwd);
      const target = join(repo, "node_modules/@shllg/emend/dist", key);
      await put(target, "synthetic runtime");
      const link = join(home, `${key}-link`);
      await symlink(target, link);
      options[key] = linked ? link : target;
      expect(await invoke("install")).toBe(1);
      expect(stderr).toEqual([
        "emend: this emend runs from inside the current repository; run emend service install from outside it.\n",
      ]);
      expect(stdout).toEqual([]);
      expect(calls()).toEqual([]);
      await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      resetOutput();
      options.cwd = join(root, "cwd");
      expect(await invoke("install")).toBe(0);
      expect(stderr).toEqual([]);
      expect((await lstat(path())).isFile()).toBe(true);
      expect(calls()).toEqual(
        platform === "linux"
          ? [systemctl("daemon-reload"), systemctl("enable", "emend"), systemctl("restart", "emend"), loginctl()]
          : [launchctl("bootstrap", "gui/501", plistPath())],
      );
    });
  }

  test.each(["malformed file", "symlink", "dangling symlink"])(
    "refuses a %s .git above the nearest repository before writing",
    async (kind) => {
      const repo = join(root, "reviewed");
      options.cwd = join(repo, "sub");
      await mkdir(join(options.cwd, ".git"), { recursive: true });
      if (kind === "malformed file") await writeFile(join(repo, ".git"), "not a repository\n");
      else await symlink(kind === "symlink" ? home : join(root, "missing"), join(repo, ".git"));
      expect(await invoke("install")).toBe(1);
      expect(stderr).toEqual(["emend: invalid repository entry\n"]);
      expect(stdout).toEqual([]);
      expect(calls()).toEqual([]);
      await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("without a .git ancestor, install allows node and entry inside the current directory", async () => {
    options.cwd = home;
    expect(await invoke("install")).toBe(0);
    expect(stderr).toEqual([]);
    expect((await lstat(path())).isFile()).toBe(true);
    expect(calls()).toEqual(
      platform === "linux"
        ? [systemctl("daemon-reload"), systemctl("enable", "emend"), systemctl("restart", "emend"), loginctl()]
        : [launchctl("bootstrap", "gui/501", plistPath())],
    );
  });

  test.each(["install", "uninstall"])(
    "%s refuses a folder at the service path and leaves it intact",
    async (action) => {
      await mkdir(path(), { recursive: true });
      await writeFile(join(path(), "keep"), "synthetic content");
      expect(await invoke(action)).toBe(1);
      expect((await lstat(path())).isDirectory()).toBe(true);
      expect(await readFile(join(path(), "keep"), "utf8")).toBe("synthetic content");
      expect(stderr).toEqual([`emend: ${path()} was not written by emend; move it away, then try again.\n`]);
      expect(calls()).toEqual([]);
    },
  );

  test("a control character in the tool path keeps its own error", async () => {
    const tools = join(root, "bad\npath");
    await mkdir(tools);
    await writeFile(join(tools, platform === "linux" ? "systemctl" : "launchctl"), "synthetic tool", { mode: 0o755 });
    io.env.PATH = tools;
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual(["emend: Service paths must not contain control characters.\n"]);
    expect(calls()).toEqual([]);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("launchd status uses the first service-level state, never nested states", async () => {
  options.platform = "darwin";
  await put(plistPath(), "installed\n");
  recorded.mockResolvedValue({
    ...ok,
    stdout: `gui/501/dev.emend.server = {
\tstate = not running
\tresource coalition = {
\t\tstate = running
\t}
\tstate = running
}
`,
  });
  expect(await invoke("status")).toBe(0);
  expect(stdout).toEqual([`emend: service installed but not running (${plistPath()})\n`]);
});

test.each(["linux", "darwin"])("%s service install preserves tailscale serve flags", async (platform) => {
  options.platform = platform;
  expect(await invoke("install", "--tailscale", "--port", "4000")).toBe(0);
  const content = await readFile(platform === "linux" ? unitPath() : plistPath(), "utf8");
  expect(content).toContain(platform === "linux" ? "serve --tailscale --port 4000" : "<string>--tailscale</string>");
});

test("launchd installs a fixed trusted PATH including both Homebrew locations", async () => {
  options.platform = "darwin";
  io.env.PATH = `${bin}:./node_modules/.bin:/synthetic/review/node_modules/.bin`;
  expect(await invoke("install", "--tailscale")).toBe(0);
  const content = await readFile(plistPath(), "utf8");
  expect(content).toContain(
    "<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
  );
  expect(content).not.toContain("node_modules");
});

describe.each(["linux", "darwin"])("%s saved service options", (platform) => {
  const path = () => (platform === "linux" ? unitPath() : plistPath());
  const saved = async () => JSON.parse(await readFile(optionsPath(), "utf8"));
  const invalid = "emend: invalid saved service options; run emend service install with your options\n";
  const defaults = "emend: no saved service options; the service now uses the defaults\n";
  beforeEach(() => {
    options.platform = platform;
  });

  test.each([{ flags: ["--tailscale"] }, { flags: ["--port", "4000", "--host", "192.0.2.1"] }])(
    "a bare reinstall keeps $flags in order and announces them first",
    async ({ flags }) => {
      expect(await invoke("install", ...flags)).toBe(0);
      expect(stdout).toEqual(["emend: service installed\n"]);
      expect(await saved()).toEqual(flags);
      expect((await stat(optionsPath())).mode & 0o777).toBe(0o600);
      const content = await readFile(path(), "utf8");
      resetOutput();
      expect(await invoke("install")).toBe(0);
      expect(stdout).toEqual([`emend: keeping the service options ${flags.join(" ")}\n`, "emend: service installed\n"]);
      expect(await readFile(path(), "utf8")).toBe(content);
      expect(await saved()).toEqual(flags);
      expect(calls()).toContainEqual(
        platform === "linux" ? systemctl("restart", "emend") : launchctl("bootstrap", "gui/501", path()),
      );
    },
  );

  test("empty saved options never print a keep line", async () => {
    for (let i = 0; i < 2; i++) {
      resetOutput();
      expect(await invoke("install")).toBe(0);
      expect(await saved()).toEqual([]);
      expect(stdout).toEqual(["emend: service installed\n"]);
    }
  });

  test("given options replace the whole saved list, including tailscale", async () => {
    expect(await invoke("install", "--tailscale", "--port", "4000")).toBe(0);
    resetOutput();
    expect(await invoke("install", "--port", "3636")).toBe(0);
    expect(await saved()).toEqual(["--port", "3636"]);
    expect(await readFile(path(), "utf8")).not.toContain("--tailscale");
    expect(stdout).toEqual(["emend: service installed\n"]);
  });

  test.each([false, true])("an older install announces defaults once (legacy pending marker: %s)", async (pending) => {
    expect(await invoke("install", "--tailscale")).toBe(0);
    await unlink(optionsPath());
    if (pending) await writeFile(pendingPath(), "");
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual([]);
    expect(await readFile(path(), "utf8")).not.toContain("--tailscale");
    expect(stdout).toEqual([defaults, "emend: service installed\n"]);
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(stdout).toEqual(["emend: service installed\n"]);
  });

  test("an older install already using defaults prints no defaults notice", async () => {
    expect(await invoke("install")).toBe(0);
    const content = await readFile(path(), "utf8");
    await unlink(optionsPath());
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await readFile(path(), "utf8")).toBe(content);
    expect(await saved()).toEqual([]);
    expect(stdout).toEqual(["emend: service installed\n"]);
  });

  test("an older install announces defaults before a failed restart or bootstrap", async () => {
    expect(await invoke("install", "--tailscale")).toBe(0);
    await unlink(optionsPath());
    const start = platform === "linux" ? "restart" : "bootstrap";
    let outputAtStart: string[] | undefined;
    recorded.mockImplementation(async (_file, args) => {
      if (args.includes(start)) {
        outputAtStart = [...stdout];
        return failed;
      }
      return args[0] === "print" ? failed : ok;
    });
    resetOutput();
    expect(await invoke("install")).toBe(1);
    expect(outputAtStart).toEqual([defaults]);
    expect(stdout).toEqual([defaults]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain(start);
    expect(await saved()).toEqual([]);
    expect(await readFile(path(), "utf8")).not.toContain("--tailscale");
    await expect(lstat(pendingPath())).resolves.toBeDefined();
  });

  test("explicit options on an older install print no defaults notice", async () => {
    expect(await invoke("install", "--tailscale")).toBe(0);
    await unlink(optionsPath());
    resetOutput();
    expect(await invoke("install", "--port", "3636")).toBe(0);
    expect(await saved()).toEqual(["--port", "3636"]);
    expect(stdout).toEqual(["emend: service installed\n"]);
  });

  test("saved empty options print no defaults notice when the runtime changes", async () => {
    expect(await invoke("install")).toBe(0);
    options.entry = join(home, "updated-emend.mjs");
    await writeFile(options.entry, "synthetic updated entry");
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await readFile(path(), "utf8")).toContain("updated-emend.mjs");
    expect(stdout).toEqual(["emend: service installed\n"]);
  });

  test.each([false, true])("a deleted unit discards a saved host (pending record: %s)", async (pending) => {
    const flags = ["--host", "0.0.0.0"];
    expect(await invoke("install", ...flags)).toBe(0);
    const content = await readFile(path(), "utf8");
    if (pending)
      await writeFile(
        pendingPath(),
        JSON.stringify({ flags, hash: createHash("sha256").update(content).digest("hex") }),
      );
    await unlink(path());
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual([]);
    expect(await readFile(path(), "utf8")).not.toContain("--host");
    expect(stdout).toEqual(["emend: service installed\n"]);
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["invalid", "symlink"])("a first install ignores orphaned %s saved options", async (kind) => {
    const target = join(root, "orphaned-options");
    if (kind === "symlink") {
      await writeFile(target, '["--host","0.0.0.0"]');
      await symlink(target, optionsPath());
    } else await writeFile(optionsPath(), "invalid stale options");
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual([]);
    expect(await readFile(path(), "utf8")).not.toContain("--host");
    expect(stdout).toEqual(["emend: service installed\n"]);
    if (kind === "symlink") expect(await readFile(target, "utf8")).toBe('["--host","0.0.0.0"]');
  });

  test.each(["not valid JSON", '{"flags":[],"content":"x"}'])(
    "a first install ignores a broken orphaned pending record (case %#)",
    async (pending) => {
      await writeFile(pendingPath(), pending);
      await writeFile(optionsPath(), '["--host","0.0.0.0"]');
      expect(await invoke("install")).toBe(0);
      expect(await saved()).toEqual([]);
      expect(await readFile(path(), "utf8")).not.toContain("--host");
      expect(stdout).toEqual(["emend: service installed\n"]);
      expect(stderr).toEqual([]);
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("an owned unit with a round-0 pending record refuses a bare install and accepts explicit flags", async () => {
    expect(await invoke("install", "--tailscale")).toBe(0);
    const content = await readFile(path(), "utf8");
    const pending = JSON.stringify({ flags: ["--tailscale"], content });
    await writeFile(pendingPath(), pending);
    resetOutput();
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([invalid]);
    expect(stdout).toEqual([]);
    expect(calls()).toEqual([]);
    expect(await readFile(path(), "utf8")).toBe(content);
    expect(await readFile(pendingPath(), "utf8")).toBe(pending);
    resetOutput();
    expect(await invoke("install", "--port", "3636")).toBe(0);
    expect(await saved()).toEqual(["--port", "3636"]);
    expect(await readFile(path(), "utf8")).not.toContain("--tailscale");
    expect(stdout).toEqual(["emend: service installed\n"]);
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([false, true])("an interrupted uninstall leaves defaults (pending record: %s)", async (pending) => {
    const flags = ["--host", "0.0.0.0"];
    expect(await invoke("install", ...flags)).toBe(0);
    const content = await readFile(path(), "utf8");
    if (pending)
      await writeFile(
        pendingPath(),
        JSON.stringify({ flags, hash: createHash("sha256").update(content).digest("hex") }),
      );
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(unlink).mockImplementation(async (file) => {
      if (file === path()) {
        await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
        throw new Error("synthetic interruption before unit removal");
      }
      return actual.unlink(file);
    });
    resetOutput();
    try {
      expect(await invoke("uninstall")).toBe(1);
    } finally {
      vi.mocked(unlink).mockImplementation(actual.unlink);
    }
    expect(await readFile(path(), "utf8")).toBe(content);
    await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual([]);
    expect(await readFile(path(), "utf8")).not.toContain("--host");
    expect(stdout).toEqual([defaults, "emend: service installed\n"]);
  });

  test.each(["options", "pending", "unit"])(
    "an interrupted uninstall after removing %s never restores a stale public host",
    async (step) => {
      expect(await invoke("install", "--host", "0.0.0.0")).toBe(0);
      const writer = stateFiles.writeSecretFile;
      const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementation((file, ...args) => {
        if (file === optionsPath()) throw new Error("synthetic interruption after unit rename");
        return writer(file, ...args);
      });
      try {
        expect(await invoke("install", "--port", "3636")).toBe(1);
      } finally {
        spy.mockRestore();
      }
      expect(await saved()).toEqual(["--host", "0.0.0.0"]);
      const content = await readFile(path(), "utf8");
      expect(content).not.toContain("--host");
      expect(content).toContain("3636");
      const pending = await readFile(pendingPath(), "utf8");
      expect(JSON.parse(pending)).toEqual({
        flags: ["--port", "3636"],
        hash: createHash("sha256").update(content).digest("hex"),
      });

      const order = [optionsPath(), pendingPath(), path()];
      const count = step === "options" ? 1 : step === "pending" ? 2 : 3;
      const removed: string[] = [];
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(unlink).mockImplementation(async (file) => {
        await actual.unlink(file);
        removed.push(String(file));
        if (file === order[count - 1]) throw new Error("synthetic interruption after uninstall step");
      });
      resetOutput();
      try {
        expect(await invoke("uninstall")).toBe(1);
      } finally {
        vi.mocked(unlink).mockImplementation(actual.unlink);
      }
      expect(removed).toEqual(order.slice(0, count));
      await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
      if (step === "options") expect(await readFile(pendingPath(), "utf8")).toBe(pending);
      else await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      if (step === "unit") await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(path(), "utf8")).toBe(content);

      resetOutput();
      expect(await invoke("install")).toBe(0);
      expect(await saved()).toEqual(step === "options" ? ["--port", "3636"] : []);
      expect(await readFile(path(), "utf8")).not.toContain("--host");
      expect(stdout).toEqual([
        ...(step === "options"
          ? ["emend: keeping the service options --port 3636\n"]
          : step === "pending"
            ? [defaults]
            : []),
        "emend: service installed\n",
      ]);
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("a state folder with mode 0755 keeps the precise chmod hint", async () => {
    await chmod(state, 0o755);
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([
      `State directory ${state} has group or other permissions; fix it with chmod 700 '${state}'\n`,
    ]);
    expect(stdout).toEqual([]);
    expect(calls()).toEqual([]);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a state-folder write error keeps its precise diagnostic", async () => {
    const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementationOnce(() => {
      throw new stateFiles.StateFolderWriteError(state);
    });
    try {
      expect(await invoke("install")).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(stderr).toEqual([`emend cannot write its state folder ${state}.\n`]);
    expect(stdout).toEqual([]);
    expect(calls()).toEqual([]);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("long paths install successfully and recover through a small hashed pending record", async () => {
    home = join(root, ...Array.from({ length: 8 }, () => "long-path-".repeat(18)));
    state = join(home, "state");
    options.home = home;
    options.node = join(home, "node");
    options.entry = join(home, "emend.mjs");
    io.env.HOME = home;
    io.env.EMEND_HOME = state;
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeFile(options.node, "synthetic node");
    await writeFile(options.entry, "synthetic entry");
    expect(await invoke("install", "--tailscale")).toBe(0);
    expect(Buffer.byteLength(await readFile(path(), "utf8"))).toBeGreaterThan(LIMITS.publicJsonBytes);
    const writer = stateFiles.writeSecretFile;
    const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementation((file, ...args) => {
      if (file === optionsPath()) throw new Error("synthetic interruption after unit rename");
      return writer(file, ...args);
    });
    try {
      expect(await invoke("install", "--port", "4000")).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const content = await readFile(path(), "utf8");
    const pending = await readFile(pendingPath(), "utf8");
    expect(Buffer.byteLength(content)).toBeGreaterThan(LIMITS.publicJsonBytes);
    expect(Buffer.byteLength(pending)).toBeLessThan(LIMITS.publicJsonBytes);
    expect(JSON.parse(pending)).toEqual({
      flags: ["--port", "4000"],
      hash: createHash("sha256").update(content).digest("hex"),
    });
    expect(await saved()).toEqual(["--tailscale"]);
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual(["--port", "4000"]);
    expect(await readFile(path(), "utf8")).toBe(content);
    expect(stdout).toEqual(["emend: keeping the service options --port 4000\n", "emend: service installed\n"]);
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    "{",
    "null",
    "{}",
    '"--tailscale"',
    "[1]",
    '["--unknown"]',
    '["--port"]',
    '["--port","65536"]',
    '["--tailscale","--tailscale"]',
    '["--tailscale","--host","0.0.0.0"]',
    JSON.stringify(["--host", "bad\n\u001b[31m\u202e"]),
    JSON.stringify(["--host", "a".repeat(LIMITS.publicJsonBytes)]),
  ])(
    "invalid saved options refuse without changing the unit, and explicit flags repair them (case %#)",
    async (bad) => {
      expect(await invoke("install", "--tailscale")).toBe(0);
      const content = await readFile(path(), "utf8");
      await writeFile(optionsPath(), bad);
      resetOutput();
      expect(await invoke("install")).toBe(1);
      expect(stderr).toEqual([invalid]);
      expect(stdout).toEqual([]);
      expect(calls()).toEqual([]);
      expect(await readFile(path(), "utf8")).toBe(content);
      expect(await readFile(optionsPath(), "utf8")).toBe(bad);
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      resetOutput();
      expect(await invoke("install", "--port", "3636")).toBe(0);
      expect(await saved()).toEqual(["--port", "3636"]);
      expect(stdout).toEqual(["emend: service installed\n"]);
    },
  );

  test.each([false, true])("a saved-options symlink is invalid even if dangling: %s", async (dangling) => {
    expect(await invoke("install")).toBe(0);
    const content = await readFile(path(), "utf8");
    await unlink(optionsPath());
    const target = join(root, "synthetic-options");
    if (!dangling) await writeFile(target, '["--tailscale"]');
    await symlink(target, optionsPath());
    resetOutput();
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([invalid]);
    expect(calls()).toEqual([]);
    expect(await readFile(path(), "utf8")).toBe(content);
    resetOutput();
    expect(await invoke("install", "--port", "3636")).toBe(0);
    expect((await lstat(optionsPath())).isSymbolicLink()).toBe(false);
    expect(await saved()).toEqual(["--port", "3636"]);
    if (!dangling) expect(await readFile(target, "utf8")).toBe('["--tailscale"]');
    else await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.skipIf(process.getuid?.() === 0)(
    "unreadable saved options refuse, and explicit flags replace the file",
    async () => {
      expect(await invoke("install", "--tailscale")).toBe(0);
      const content = await readFile(path(), "utf8");
      await chmod(optionsPath(), 0o000);
      try {
        resetOutput();
        expect(await invoke("install")).toBe(1);
        expect(stderr).toEqual([invalid]);
        expect(stdout).toEqual([]);
        expect(calls()).toEqual([]);
        expect(await readFile(path(), "utf8")).toBe(content);
        resetOutput();
        expect(await invoke("install", "--port", "3636")).toBe(0);
        expect(await saved()).toEqual(["--port", "3636"]);
        expect((await stat(optionsPath())).mode & 0o777).toBe(0o600);
      } finally {
        await chmod(optionsPath(), 0o600);
      }
    },
  );

  for (const installed of [false, true]) {
    test.each(["pending", "unit", "options", "restart"])(
      `a failed ${installed ? "repeat" : "first"} install at %s recovers the options for the unit on disk`,
      async (step) => {
        if (installed) expect(await invoke("install", "--tailscale")).toBe(0);
        resetOutput();
        const writer = stateFiles.writeSecretFile;
        const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementation((file, ...args) => {
          if (file === (step === "options" ? optionsPath() : step === "pending" ? pendingPath() : ""))
            throw new Error("synthetic state write failure");
          return writer(file, ...args);
        });
        if (step === "unit") vi.mocked(writeService).mockRejectedValueOnce(new Error("synthetic unit write failure"));
        if (step === "restart") {
          recorded.mockImplementation(async (_file, args) =>
            args[0] === "print" || args.includes(platform === "linux" ? "enable" : "bootstrap") ? failed : ok,
          );
        }
        try {
          expect(await invoke("install", "--port", "4000")).toBe(1);
        } finally {
          spy.mockRestore();
        }
        const renamed = step === "options" || step === "restart";
        const expected = renamed ? ["--port", "4000"] : installed ? ["--tailscale"] : [];
        if (renamed) expect(await readFile(path(), "utf8")).toContain("4000");
        if (step !== "pending") expect((await stat(pendingPath())).mode & 0o777).toBe(0o600);
        resetOutput();
        recorded.mockImplementation(async (_file, args) => (args[0] === "print" ? failed : ok));
        expect(await invoke("install")).toBe(0);
        expect(await saved()).toEqual(expected);
        expect(stdout).toEqual([
          ...(expected.length ? [`emend: keeping the service options ${expected.join(" ")}\n`] : []),
          "emend: service installed\n",
        ]);
        const content = await readFile(path(), "utf8");
        expect(content.includes("4000")).toBe(renamed);
        expect(content.includes("--tailscale")).toBe(!renamed && installed);
        await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  }

  test("a second failed explicit update cannot discard an earlier pending options recovery", async () => {
    expect(await invoke("install", "--tailscale")).toBe(0);
    const writer = stateFiles.writeSecretFile;
    const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementation((file, ...args) => {
      if (file === optionsPath()) throw new Error("synthetic options write failure");
      return writer(file, ...args);
    });
    try {
      expect(await invoke("install", "--port", "4000")).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(await saved()).toEqual(["--tailscale"]);
    expect(await readFile(path(), "utf8")).toContain("4000");
    vi.mocked(writeService).mockRejectedValueOnce(new Error("synthetic unit write failure"));
    expect(await invoke("install", "--port", "5000")).toBe(1);
    expect(await saved()).toEqual(["--port", "4000"]);
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual(["--port", "4000"]);
    expect(await readFile(path(), "utf8")).toContain("4000");
    expect(stdout[0]).toBe("emend: keeping the service options --port 4000\n");
  });
});

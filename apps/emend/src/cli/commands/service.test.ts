import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type Io, run } from "../../main.ts";
import type { ServiceOptions, ServiceResult, ServiceRunner } from "../service/common.ts";
import { writeService } from "../service/common.ts";

vi.mock("../service/common.ts", async (original) => {
  const actual = await original<typeof import("../service/common.ts")>();
  return { ...actual, writeService: vi.fn(actual.writeService) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

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
  await mkdir(state);
  await mkdir(bin);
  for (const tool of ["systemctl", "loginctl", "launchctl"]) {
    // These are only resolved, never executed: every call goes to the recorded runner.
    await writeFile(join(bin, tool), "synthetic executable\n", { mode: 0o755 });
  }
  stdout = [];
  stderr = [];
  recorded = vi.fn(async () => ok);
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
  expect(calls()).toEqual([systemctl("daemon-reload"), systemctl("enable", "--now", "emend"), loginctl()]);
  expect(stderr).toEqual([]);
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

  test("identical install preserves bytes and mtime while ensuring the service is enabled", async () => {
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
        ? [systemctl("enable", "--now", "emend"), loginctl()]
        : [launchctl("print", "gui/501/dev.emend.server")],
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
    expect(await invoke("uninstall")).toBe(0);
    expect(stdout).toEqual(["emend: the service is not installed.\n"]);
    expect(stderr).toEqual([]);
    expect(calls()).toEqual([]);
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
    ["install", "--tailscale"],
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
  expect(calls()).toEqual([systemctl("daemon-reload"), systemctl("enable", "--now", "emend"), loginctl()]);
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
        ? ["write", "daemon-reload", "enable", ...(previous === "changed" ? ["restart"] : [])]
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
      recorded.mockResolvedValue(ok);
      expect(await invoke("install", "--port", "4000")).toBe(0);
      expect(calls()).toEqual(
        platform === "linux"
          ? [systemctl("enable", "--now", "emend"), loginctl()]
          : [launchctl("print", "gui/501/dev.emend.server")],
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
          ? [systemctl("daemon-reload"), systemctl("enable", "--now", "emend"), loginctl()]
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
        ? [systemctl("daemon-reload"), systemctl("enable", "--now", "emend"), loginctl()]
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

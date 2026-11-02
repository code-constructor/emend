import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test, vi } from "vitest";
import { type Io, run } from "../../main.ts";
import { readDocRoots } from "../config.ts";
import { escapeReference, quoteShellArgument } from "../escape.ts";
import * as reader from "./read.ts";

vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()) }));
vi.mock("../git.ts", async (original) => ({
  ...(await original<typeof import("../git.ts")>()),
  createGitSession: () => async (cwd: string, call: string[]) =>
    Buffer.from(call[1] === "--git-common-dir" ? join(cwd, ".git") : cwd),
}));

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "emend-publish-roots-")));
  const repo = join(root, "repo");
  const stateParent = join(root, "data");
  const state = join(stateParent, "state");
  const homeParent = join(root, "homes");
  const home = join(homeParent, "reviewer");
  const accountParent = join(root, "accounts");
  const account = join(accountParent, "reviewer");
  const docs = join(root, "docs");
  for (const folder of [join(repo, ".git"), state, home, account, docs]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
  }
  await writeFile(join(repo, "plan.md"), "# Synthetic worktree doc");
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(os, "userInfo").mockReturnValue({
    homedir: account,
    username: "synthetic",
    uid: 1000,
    gid: 1000,
    shell: null,
  });
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  const reads = vi.spyOn(reader, "readRegular");
  const fetcher = vi.fn(() => {
    throw new Error("publish must stay local");
  });
  vi.stubGlobal("fetch", fetcher);
  onTestFinished(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });
  const config = join(state, "config.json");
  const manifest = join(repo, "review.json");
  async function command(args: string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: Io = {
      env: { EMEND_HOME: state, HOME: home },
      stdout: (line) => {
        stdout.push(line);
      },
      stderr: (line) => {
        stderr.push(line);
      },
    };
    const code = await run(args, io);
    expect(fetcher).not.toHaveBeenCalled();
    return { code, stdout, stderr };
  }
  return {
    root,
    repo,
    state,
    stateParent,
    home,
    homeParent,
    account,
    accountParent,
    docs,
    config,
    reads,
    command,
    store: (entries: string[]) => writeFile(config, JSON.stringify({ docRoots: entries })),
    async publish(source?: string) {
      await writeFile(
        manifest,
        JSON.stringify({
          version: 1,
          title: "Synthetic roots review",
          topics: [],
          files: [{ path: "plan.md", role: "doc", ...(source ? { source } : {}) }],
          writeup: { overview: "", tldr: "", decisions: null, topics: {} },
        }),
      );
      return command(["publish", "--manifest", manifest, "--key", "roots"]);
    },
  };
}

const refusal = (entry: string, problem: string) => {
  const escaped = escapeReference(entry);
  const quoted = quoteShellArgument(entry);
  return {
    code: 1,
    stdout: [],
    stderr: [`emend: docRoots entry ${escaped} ${problem}; remove it with emend config remove docRoots ${quoted}\n`],
  };
};

test.each(["symlink", "filesystem", "home", "home-parent", "state", "state-parent", "state-child", "controls"])(
  "publish refuses a stored %s before reading any doc",
  async (kind) => {
    const f = await fixture();
    let entry = f.docs;
    let problem = "is not a real path";
    if (kind === "symlink" || kind === "controls") {
      entry = join(f.root, kind === "controls" ? "reviewer's\n\u001b[31m" : "alias");
      await symlink(f.docs, entry, "dir");
    } else if (kind === "filesystem") {
      entry = parse(f.root).root;
      problem = "is the filesystem root";
    } else if (kind === "home" || kind === "home-parent") {
      entry = kind === "home" ? f.home : f.homeParent;
      problem = "is the home folder or holds it";
    } else {
      entry = kind === "state-parent" ? f.stateParent : kind === "state-child" ? join(f.state, "nested") : f.state;
      if (kind === "state-child") await mkdir(entry);
      problem = "holds or sits inside emend's state folder";
    }
    await f.store([f.docs, entry]);
    const result = await f.publish();
    expect(result).toEqual(refusal(entry, problem));
    expect(result.stderr.join("").split("\n")).toHaveLength(2);
    expect(f.reads.mock.calls.some(([path]) => path === join(f.repo, "plan.md"))).toBe(false);
    await expect(stat(join(f.state, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "controls") {
      expect(result.stderr).toEqual([
        "emend: docRoots entry " +
          f.root +
          "/reviewer's\\u{a}\\u{1b}[31m is not a real path; remove it with emend config remove docRoots $'" +
          f.root +
          "/reviewer\\'s\\x0a\\x1b[31m'\n",
      ]);
    }
  },
);

test.each(["folder", "filesystem", "home"])(
  "publish refuses a doc root replaced by a symlink to %s",
  async (target) => {
    const f = await fixture();
    await f.store([f.docs]);
    await rm(f.docs, { recursive: true });
    await symlink(target === "filesystem" ? parse(f.root).root : target === "home" ? f.home : f.repo, f.docs, "dir");
    expect(await f.publish()).toEqual(refusal(f.docs, "is not a real path"));
  },
);

test("stored entries are checked in order", async () => {
  const f = await fixture();
  const alias = join(f.root, "alias");
  await symlink(f.docs, alias, "dir");
  const root = parse(f.root).root;
  await f.store([root, alias]);
  expect(await f.publish()).toEqual(refusal(root, "is the filesystem root"));
  await f.store([alias, root]);
  expect(await f.publish()).toEqual(refusal(alias, "is not a real path"));
});

test.each(["symlink", "dot-segment"])(
  "the suggested remove command removes a non-real %s entry literally",
  async (kind) => {
    const f = await fixture();
    const entry = kind === "symlink" ? join(f.root, "alias") : `${f.docs}/.`;
    if (kind === "symlink") await symlink(f.docs, entry, "dir");
    await f.store([entry]);
    expect(await f.publish()).toEqual(refusal(entry, "is not a real path"));
    expect(await f.command(["config", "remove", "docRoots", entry])).toEqual({
      code: 0,
      stdout: [`emend: removed ${entry} from docRoots\n`],
      stderr: [],
    });
    expect(JSON.parse(await readFile(f.config, "utf8")).docRoots).toEqual([]);
  },
);

test.each(["ENOENT", "ENOTDIR"])("publish skips a %s entry and still publishes a worktree doc", async (code) => {
  const f = await fixture();
  const parent = join(f.root, "missing");
  if (code === "ENOTDIR") await writeFile(parent, "Synthetic non-directory");
  const missing = join(parent, "docs");
  await f.store([missing, f.docs]);
  expect(await readDocRoots(f.state, f.home, () => f.account)).toEqual([f.docs]);
  const result = await f.publish();
  expect(result.code).toBe(0);
  expect(result.stdout).toHaveLength(1);
  expect(JSON.parse(result.stdout.join(""))).toMatchObject({ revision: 1, unrendered: [] });
});

for (const [name, character, literalEscape, quotedEscape] of [
  ["newline", "\n", "\\u{a}", "\\x0a"],
  ["U+202E", "\u202e", "\\u202E", "\\xe2\\x80\\xae"],
] as const) {
  test(`the printed remove argument under LC_ALL=C selects the ${name} entry and keeps its literal twin`, async ({
    skip,
  }) => {
    const f = await fixture();
    const entry = join(f.root, `a${character}b`);
    const literal = join(f.root, `a${literalEscape}b`);
    await symlink(f.docs, entry, "dir");
    await mkdir(literal);
    await f.store([entry, literal]);
    const result = await f.publish();
    expect(result).toEqual(refusal(entry, "is not a real path"));
    const argument = result.stderr.join("").split("; remove it with emend config remove docRoots ")[1]?.trimEnd();
    expect(argument).toBe(`$'${f.root}/a${quotedEscape}b'`);
    let decoded: string;
    try {
      const result = await promisify(execFile)("bash", ["--norc", "--noprofile", "-c", `printf %s ${argument}`], {
        env: { PATH: process.env.PATH, LC_ALL: "C" },
      });
      decoded = result.stdout;
      expect(result.stderr).toBe("");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return skip("bash is not on PATH");
      throw error;
    }
    expect(decoded).toBe(entry);
    expect(await f.command(["config", "remove", "docRoots", decoded])).toEqual({
      code: 0,
      stdout: [`emend: removed ${escapeReference(entry)} from docRoots\n`],
      stderr: [],
    });
    expect(JSON.parse(await readFile(f.config, "utf8")).docRoots).toEqual([literal]);
  });
}

test("a doc beneath a missing stored root still reports doc not found", async () => {
  const f = await fixture();
  const missing = join(f.root, "missing");
  const source = join(missing, "plan.md");
  await f.store([missing]);
  expect(await f.publish(source)).toEqual({
    code: 1,
    stdout: [],
    stderr: [`emend: doc not found: ${source}\n`],
  });
});

test.skipIf(process.getuid?.() === 0)("publish refuses an EACCES entry with its removal command", async () => {
  const f = await fixture();
  const denied = join(f.root, "denied");
  const entry = join(denied, "docs");
  await mkdir(entry, { recursive: true });
  await f.store([entry]);
  await chmod(denied, 0o000);
  try {
    expect(await f.publish()).toEqual(refusal(entry, "cannot be read"));
  } finally {
    await chmod(denied, 0o700);
  }
});

test("publish refuses a symlink loop as unreadable", async () => {
  const f = await fixture();
  const entry = join(f.root, "loop");
  await symlink(entry, entry);
  await f.store([entry]);
  expect(await f.publish()).toEqual(refusal(entry, "cannot be read"));
});

test.skipIf(process.getuid?.() === 0).each(["HOME", "account home"])(
  "config add and publish name an unreadable %s without advising removal of a valid entry",
  async (kind) => {
    const f = await fixture();
    const parent = kind === "HOME" ? f.homeParent : f.accountParent;
    const folder = kind === "HOME" ? f.home : f.account;
    await f.store([f.docs]);
    const original = await readFile(f.config, "utf8");
    await chmod(parent, 0o000);
    try {
      const expected = {
        code: 1,
        stdout: [],
        stderr: [`emend: cannot check docRoots: ${folder} cannot be read\n`],
      };
      expect(await f.command(["config", "add", "docRoots", f.docs])).toEqual(expected);
      expect(await f.publish()).toEqual(expected);
      expect(await readFile(f.config, "utf8")).toBe(original);
      expect(f.reads.mock.calls.some(([path]) => path === join(f.repo, "plan.md"))).toBe(false);
      await expect(stat(join(f.state, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(parent, 0o700);
    }
  },
);

test("config add and publish protect the passwd home even when HOME differs", async () => {
  const f = await fixture();
  expect(f.home).not.toBe(f.account);
  expect(await f.command(["config", "add", "docRoots", f.accountParent])).toEqual({
    code: 1,
    stdout: [],
    stderr: ["emend: docRoots cannot be the home folder or hold it\n"],
  });
  await f.store([f.accountParent]);
  expect(await f.publish()).toEqual(refusal(f.accountParent, "is the home folder or holds it"));
});

test("both callers use HOME alone when userInfo throws", async () => {
  const f = await fixture();
  vi.mocked(os.userInfo).mockImplementation(() => {
    throw new Error("no passwd entry");
  });
  expect((await f.command(["config", "add", "docRoots", f.docs])).code).toBe(0);
  expect((await f.publish()).code).toBe(0);
  expect(await f.command(["config", "add", "docRoots", f.homeParent])).toEqual({
    code: 1,
    stdout: [],
    stderr: ["emend: docRoots cannot be the home folder or hold it\n"],
  });
  await f.store([f.homeParent]);
  expect(await f.publish()).toEqual(refusal(f.homeParent, "is the home folder or holds it"));
});

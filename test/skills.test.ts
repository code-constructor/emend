import { execFile, execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { copySkills } from "../apps/emend/src/build/skill-copy-filter.ts";
import { run } from "../apps/emend/src/main.ts";
import { PublishManifest, WaitResult } from "../packages/contract/src/index.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(repo, path), "utf8");
const json = (path: string) => JSON.parse(read(path));
const names = ["emend-review", "emend-feedback"];
const skillFiles = [...names.map((name) => `skills/${name}/SKILL.md`), "skills/emend-review/references/manifest.md"];
const gitTest = test.skipIf(!existsSync(join(repo, ".git")));
const exec = promisify(execFile);
const surfaces = [
  {
    name: "review-wording",
    self: ["skills/emend-review/**"],
    counterpart: ["skills/hunk-review/SKILL.md"],
  },
  {
    name: "topic-vocabulary",
    self: ["packages/contract/src/review.ts"],
    counterpart: ["extension/review-plan/plan.ts"],
  },
  {
    name: "modes-outcomes",
    self: ["packages/contract/src/send.ts", "packages/contract/src/thread.ts", "skills/emend-feedback/**"],
    counterpart: ["extension/review-plan/go.ts", "skills/hunk-handle-notes/SKILL.md"],
  },
  {
    name: "wait-result",
    self: ["packages/contract/src/wait.ts", "apps/emend/src/cli/commands/wait.ts"],
    counterpart: ["bin/hunk-plan"],
  },
];
let temporary: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "emend-skill-files-"));
  const home = join(temporary, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("EMEND_HOME", join(temporary, "state"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  env = { ...process.env };
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(temporary, { recursive: true, force: true });
});

const gitFiles = (...args: string[]) =>
  execFileSync("git", ["ls-files", "-z", ...args], { cwd: repo, env, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

const fixedWaitRedirect =
  /\d*>(?:>|\|)?[ \t]*(?:"(?:[^"\r\n]*\/)?wait\.json"|'(?:[^'\r\n]*\/)?wait\.json'|(?:[^\s"'|;]*\/)?wait\.json(?=$|[\s;)]))/m;

test("no skill file redirects hand-offs into a fixed wait.json", () => {
  const skills = join(repo, "skills");
  for (const path of readdirSync(skills, { recursive: true, encoding: "utf8" })) {
    if (!statSync(join(skills, path)).isFile()) continue;
    const text = readFileSync(join(skills, path), "utf8");
    expect(text, path).not.toMatch(fixedWaitRedirect);
  }
});

test.each([">", ">>", ">|", "1>", "2>"])("the fixed wait.json guard rejects %s redirects", (operator) => {
  for (const before of ["", " "]) {
    for (const after of ["", " "]) {
      for (const quote of ["", '"', "'"]) {
        for (const target of ["wait.json", "/tmp/review/wait.json", "<review-folder>/wait.json"]) {
          expect(`emend feedback <review-id>${before}${operator}${after}${quote}${target}${quote}`).toMatch(
            fixedWaitRedirect,
          );
        }
      }
    }
  }
});

test("the fixed wait.json guard allows ownership listings and timestamped results", () => {
  expect('find "<review-folder>" -maxdepth 1 -type f -user "$(id -u)" -name wait.json').not.toMatch(fixedWaitRedirect);
  expect(
    '(umask 077; set -C; emend wait <review-id> --timeout 540 > "<review-folder>/wait-$(date -u +%Y%m%dT%H%M%SZ).json")',
  ).not.toMatch(fixedWaitRedirect);
});

test.each(skillFiles)("%s saves private hand-offs without clobbering and checks saved-file ownership", (path) => {
  const text = read(path);
  const shellLines = [...text.matchAll(/```sh\n([\s\S]*?)\n```/g)].flatMap((match) => match[1]?.split("\n") ?? []);
  const redirects = shellLines.filter((line) => /\bemend (?:wait|feedback)\b/.test(line));
  expect(redirects.length).toBeGreaterThan(0);
  for (const line of redirects) {
    expect(line).toMatch(
      /^\(umask 077; set -C; emend (?:wait <review-id> --timeout 540|feedback <review-id>) > "<review-folder>\/wait-\$\(date -u \+%Y%m%dT%H%M%SZ\)\.json"\)$/,
    );
  }
  expect(shellLines.filter((line) => line.includes("handled.txt") && !line.startsWith("find "))).toEqual([
    String.raw`(set +C; umask 077; printf '%s\n' '<deliveryId>' >> "<review-folder>/handled.txt")`,
  ]);
  expect(text).not.toMatch(/next number/i);
  expect(text).toContain("handled.txt");
  expect(text).toContain("deliveryId");
  expect(text).toContain(
    String.raw`find "<review-folder>" -maxdepth 1 -type f -user "$(id -u)" \( -name 'wait-*.json' -o -name handled.txt \) | sort`,
  );
  expect(text).toContain(
    String.raw`find "<review-folder>" -mindepth 1 -maxdepth 1 \( ! -user "$(id -u)" -o ! -type f \)`,
  );
  expect(text).toContain("Before reading saved results and before every `emend wait` or `emend feedback`");
  expect(text).toContain(
    "If it prints anything, tell the user each name, take no new hand-off in this folder, and stop.",
  );
  expect(text).toContain("Use a review folder from one session at a time.");
  expect(text).toContain(
    "A second session on the same review creates its own folder only after the first has stopped.",
  );
});

test.each(skillFiles)("%s deletes only empty output from an observed failure and preserves saved results", (path) => {
  const text = read(path);
  expect(text).not.toMatch(/came from a failed command/i);
  expect(text).not.toContain("Delete it instead of reading it.");
  expect(text).not.toContain(
    "If `emend wait` or `emend feedback` exits non-zero, it prints one stderr line and nothing on stdout.",
  );
  expect(text).not.toContain("On a non-zero exit, delete the empty file that command created");
  expect(text).toContain("Delete only what you saw fail.");
  expect(text).toContain(
    "Right after an `emend wait` or `emend feedback` command you ran exits non-zero, inspect the file its redirect created.",
  );
  expect(text).toContain("If that file is empty, delete it: the CLI printed nothing and confirmed nothing.");
  expect(text).toContain("The server offers that feedback again later. Then report the error line and stop.");
  expect(text).toContain("Keep a non-empty file after a non-zero exit.");
  expect(text).toContain("A command stopped by a signal can exit non-zero after it printed and confirmed a hand-off.");
  expect(text).toContain(
    "Read it like any saved result; if it is not complete JSON, keep it and tell the user its name.",
  );
  expect(text).toContain("A name clash creates nothing.");
  expect(text).toContain(
    "If the shell refuses the name because the file exists, that command created no file and ran nothing.",
  );
  expect(text).toContain("Delete nothing, and run the command again a second later.");
  expect(text).toContain("Never delete a saved file you did not see fail.");
  expect(text).toContain("When listing, skip a `wait-*.json` that is empty or not complete JSON.");
  expect(text).toContain("A wait may still be writing it, in this session or another.");
  expect(text).toContain("Do not read or delete it; list it again later.");
  expect(text).toContain("Tell the user its name if it stays empty after the waits you started have finished.");
  expect(text).toContain("Apply the same rule to legacy `wait.json`.");
});

test.each(names)("%s has discoverable frontmatter and only registered commands", async (name) => {
  const text = read(`skills/${name}/SKILL.md`);
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  expect(/^name: (.+)$/m.exec(frontmatter)?.[1]).toBe(name);
  expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
  const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
  expect(description.length).toBeGreaterThan(0);
  expect(description.length).toBeLessThanOrEqual(1024);
  const commands = [...text.matchAll(/(?:^|`)emend ([a-z][a-z-]*)/gm)].map((match) => match[1] as string);
  expect(commands.length).toBeGreaterThan(0);
  for (const command of new Set(commands)) {
    const stderr = vi.fn();
    await run([command, "--invalid-skill-command-probe"], { env, stdout: vi.fn(), stderr });
    expect(stderr.mock.calls.flat().join("")).not.toContain("unknown command");
  }
});

test("the complete example is the synthetic manifest fixture, with no stripped or invented fields", () => {
  const blocks = [...read("skills/emend-review/references/manifest.md").matchAll(/```json\n([\s\S]*?)\n```/g)];
  expect(blocks).toHaveLength(1);
  const example = JSON.parse(blocks[0]?.[1] ?? "");
  expect(example).toEqual(json("sync/fixtures/manifest.json"));
  expect(PublishManifest.parse(example)).toEqual(example);
  expect(example.files.map((file: { role: string }) => file.role)).toEqual(expect.arrayContaining(["doc", "diff"]));
  expect(example.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "docs/retry-prd.md", role: "diff" }),
      expect.objectContaining({ path: "docs/retry-prd.md", role: "doc" }),
    ]),
  );
});

test("the synthetic hand-off is a Go with a comment and no invented fields", () => {
  const fixture = json("sync/fixtures/wait-result.json");
  const parsed = WaitResult.parse(fixture);
  expect(parsed).toEqual(fixture);
  expect(parsed.kind).toBe("go");
  if (parsed.kind === "go") expect(parsed.comments.length).toBeGreaterThan(0);
});

test("plugin and marketplace use the root's default skills scan and match the package", () => {
  const plugin = json(".claude-plugin/plugin.json");
  const marketplace = json(".claude-plugin/marketplace.json");
  expect(Object.keys(plugin).sort()).toEqual([
    "author",
    "description",
    "keywords",
    "license",
    "name",
    "repository",
    "version",
  ]);
  expect(plugin).toMatchObject({
    name: "emend",
    version: json("apps/emend/package.json").version,
    author: { name: "shllg" },
    repository: "https://github.com/shllg/emend",
    license: "MIT",
  });
  expect(plugin.description).toBe(json("apps/emend/package.json").description);
  expect(plugin.keywords.length).toBeGreaterThan(0);
  expect(marketplace).toEqual({
    name: "emend",
    owner: { name: "shllg" },
    description: plugin.description,
    plugins: [{ name: plugin.name, source: "./", description: plugin.description }],
  });
});

function pluginComponents(entries: string[]) {
  const forbidden = [
    "hooks",
    "monitors",
    ".mcp.json",
    "bin",
    "agents",
    "commands",
    "settings.json",
    ".lsp.json",
    "output-styles",
    "workflows",
    "themes",
  ];
  return entries.flatMap((entry) => {
    const separator = entry.indexOf("\t");
    const path = entry.slice(separator + 1);
    const first = path.split("/")[0] ?? "";
    const nonAscii = Array.from(first).some((char) => char.charCodeAt(0) > 127);
    const normalized = first.replace(/[. ]+$/, "").toLowerCase();
    const rootSymlink = entry.startsWith("120000 ") && !path.includes("/");
    return nonAscii || first.includes(":") || first.includes("\\") || forbidden.includes(normalized) || rootSymlink
      ? [path]
      : [];
  });
}

gitTest("the plugin root has no tracked executable components", () => {
  const paths = pluginComponents(gitFiles("-s"));
  expect(paths, `Plugin root must carry no code: ${paths.join(", ")}`).toEqual([]);
});

test("the plugin root guard rejects rewritten names, non-ASCII root names and every root symlink", () => {
  const entries = [
    ["120000", "hooks"],
    ["100644", "sync/fixtures/hooks.json"],
    ["100644", "Hooks/hooks.json"],
    ["100644", "hooks\\hooks.json"],
    ["100644", "hooks./hooks.json"],
    ["100644", "hooks /hooks.json"],
    ["100644", "hooks::$INDEX_ALLOCATION/hooks.json"],
    ["100644", "unlisted:stream/readme.md"],
    ["100644", "hookſ/hooks.json"],
    ["100644", "döcs/readme.md"],
    ["100644", ".MCP.json"],
    ["120000", "unlisted-root-link"],
    ["100644", "apps/emend/bin/emend"],
    ["100644", "docs/café.md"],
  ].map(([mode, path]) => `${mode} ${"a".repeat(40)} 0\t${path}`);
  expect(pluginComponents(entries)).toEqual([
    "hooks",
    "Hooks/hooks.json",
    "hooks\\hooks.json",
    "hooks./hooks.json",
    "hooks /hooks.json",
    "hooks::$INDEX_ALLOCATION/hooks.json",
    "unlisted:stream/readme.md",
    "hookſ/hooks.json",
    "döcs/readme.md",
    ".MCP.json",
    "unlisted-root-link",
  ]);
});

gitTest("all skill source files are tracked, including ignored files", () => {
  const untracked = gitFiles("--others", "--", "skills");
  expect(untracked, `Untracked skill files: ${untracked.join(", ")}`).toEqual([]);
});

test.each(["source archive", "no git"])(
  "the build copies regular files and skips dot entries with %s",
  async (kind) => {
    const source = join(temporary, "skills");
    const output = join(temporary, "dist/skills");
    for (const path of ["emend-review/SKILL.md", "emend-review/.draft", ".hidden/nested/draft.md"]) {
      mkdirSync(dirname(join(source, path)), { recursive: true });
      writeFileSync(join(source, path), "synthetic text\n");
    }
    if (kind === "no git") {
      mkdirSync(join(temporary, ".git"));
      vi.stubEnv("PATH", join(temporary, "no-bin"));
    }
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "stale.md"), "old packaged content");
    await copySkills(temporary, output);
    expect(readFileSync(join(output, "emend-review/SKILL.md"), "utf8")).toBe("synthetic text\n");
    expect(existsSync(join(output, "emend-review/.draft"))).toBe(false);
    expect(existsSync(join(output, ".hidden"))).toBe(false);
    expect(existsSync(join(output, "stale.md"))).toBe(false);
  },
);

test.each(["emend-review/link", "emend-review/.link", ".hidden/nested/link"])(
  "the build refuses a symlink at %s and names it",
  async (path) => {
    const source = join(temporary, "skills");
    const link = join(source, path);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync("missing", link);
    await expect(copySkills(temporary, join(temporary, "dist/skills"))).rejects.toThrow(
      `Skill source contains a symlink: ${link}`,
    );
  },
);

gitTest("the build refuses untracked and ignored skills before replacing its output", async () => {
  const git = (...args: string[]) => exec("git", args, { cwd: temporary, env });
  await git("-c", "init.templateDir=", "init", "-b", "main");
  const source = join(temporary, "skills/emend-review");
  const output = join(temporary, "dist/skills");
  mkdirSync(source, { recursive: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "stale.md"), "keep until preflight passes");
  writeFileSync(join(source, "SKILL.md"), "synthetic skill\n");
  writeFileSync(join(temporary, ".gitignore"), "skills/**/ignored.md\n");
  await git("add", "--", "skills/emend-review/SKILL.md", ".gitignore");
  for (const name of ["untracked.md", "ignored.md"]) {
    writeFileSync(join(source, name), "unpublished text\n");
    await expect(copySkills(temporary, output)).rejects.toThrow(`Untracked skill files: skills/emend-review/${name}`);
    expect(readFileSync(join(output, "stale.md"), "utf8")).toBe("keep until preflight passes");
    rmSync(join(source, name));
  }
  await copySkills(temporary, output);
  expect(readFileSync(join(output, "emend-review/SKILL.md"), "utf8")).toBe("synthetic skill\n");
  expect(existsSync(join(output, "stale.md"))).toBe(false);
});

gitTest("the build fails on git errors inside a checkout", async () => {
  writeFileSync(join(temporary, ".git"), "gitdir: missing\n");
  await expect(copySkills(temporary, join(temporary, "dist/skills"))).rejects.toThrow();
});

gitTest("the real sync parser accepts all four required surfaces in a temporary repository", async () => {
  // This Node script has its own harness and is outside the TypeScript project.
  const { checkSync, globToRegExp } = await import(new URL("../scripts/check-sync.ts", import.meta.url).href);
  const root = join(temporary, "checkout");
  try {
    execFileSync("git", ["-c", "init.templateDir=", "init", "-b", "main", root], {
      env,
      stdio: "ignore",
    });
    mkdirSync(join(root, "sync"));
    copyFileSync(join(repo, "sync/manifest.json"), join(root, "sync/manifest.json"));
    const manifest = json("sync/manifest.json");
    expect(manifest).toEqual({ version: 1, surfaces });
    for (const surface of surfaces) {
      for (const glob of surface.self) {
        const path = glob.replace("/**", "/SKILL.md");
        expect(globToRegExp(glob).test(path)).toBe(true);
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), "synthetic shared surface\n");
      }
    }
    const result = checkSync({ cwd: root });
    expect(result.errors).toEqual([]);
    expect(result.summary).toContain("0 commits");
    for (const surface of surfaces) {
      for (const glob of surface.self) expect(result.notes.join("\n")).toContain(glob.replace("/**", "/SKILL.md"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all counterpart paths exist when the counterpart checkout is readable", ({ skip }) => {
  let counterpart: string;
  try {
    counterpart = resolve(repo, read(".sync-counterpart-path").trim());
    accessSync(counterpart, constants.R_OK | constants.X_OK);
  } catch {
    skip();
    return;
  }
  for (const surface of surfaces) {
    for (const path of surface.counterpart) {
      expect(statSync(join(counterpart, path), { throwIfNoEntry: false })?.isFile(), path).toBe(true);
    }
  }
});

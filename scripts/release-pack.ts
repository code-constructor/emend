// Builds the publishable tarball from exactly the tagged commit, in a clean temporary checkout, so
// a shared working tree (stale dist, other people's uncommitted work) never reaches npm. It never
// publishes: the owner runs the printed `npm publish` command (AGENTS.md, "Delivery"). Run it from
// a fresh clone of the pushed tag with plain node, so the script and its inputs are the tag's.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Runner, runCommand } from "./install-local.ts";

type StopSignal = "SIGINT" | "SIGTERM";

interface SignalSource {
  on(signal: StopSignal, listener: () => void): unknown;
  off(signal: StopSignal, listener: () => void): unknown;
}

export interface ReleasePackOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  signals?: SignalSource;
  temporaryRoot?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_FILES = ["apps/emend/package.json", "plugin/.claude-plugin/plugin.json"];

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// --ignore-scripts: the packed manifest still lists prepack and postpack, which reach for
// ../../scripts and exist only in the repo. The tarball is already packed, so no script is needed.
export function publishCommand(tarball: string): string {
  return `npm publish --ignore-scripts --registry=https://registry.npmjs.org/ ${shellQuote(tarball)}`;
}

export function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function shasum(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

// ls-remote prints "<sha>\t<ref>" lines. The peeled ref (^{}) is the commit of an annotated tag;
// a lightweight tag has only the plain ref.
export function remoteTagCommit(listing: string, ref: string): string | undefined {
  let plain: string | undefined;
  for (const line of listing.split("\n")) {
    const [sha, name] = line.split("\t");
    if (name === `${ref}^{}`) return sha;
    if (name === ref) plain = sha;
  }
  return plain;
}

export async function releasePack(args: string[], options: ReleasePackOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const [version] = args;
  if (args.length !== 1 || version === undefined || !VERSION_PATTERN.test(version)) {
    stderr("Usage: node scripts/release-pack.ts <x.y.z>");
    return 2;
  }

  const root = options.root ?? fileURLToPath(new URL("..", import.meta.url));
  const env = options.env ?? process.env;
  if (env.CLAUDECODE) {
    stderr("release:pack: run this in your own terminal, not in an agent session");
    return 1;
  }
  const run = options.run ?? runCommand;
  const signals = options.signals ?? process;
  const interruption = new AbortController();
  const onInterrupt = () => interruption.abort("SIGINT");
  const onTerminate = () => interruption.abort("SIGTERM");
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  let step = "check tag";
  let temporary: string | undefined;
  let status = 0;
  const command = async (label: string, program: string, argv: string[], cwd = root, capture = false) => {
    step = label;
    interruption.signal.throwIfAborted();
    const output = await run(program, argv, { cwd, env, capture, signal: interruption.signal });
    interruption.signal.throwIfAborted();
    return output;
  };
  const refuse = async (label: string, hint: string, ...call: [string, string[]]) => {
    try {
      return await command(label, call[0], call[1], root, true);
    } catch {
      interruption.signal.throwIfAborted();
      throw new Error(hint);
    }
  };

  signals.on("SIGINT", onInterrupt);
  signals.on("SIGTERM", onTerminate);
  try {
    // The tag resolves once; every later step uses this commit, never the tag name.
    const sha = (
      await refuse("check tag", `tag ${tag} does not exist`, "git", ["rev-parse", "--verify", `${ref}^{commit}`])
    ).trim();
    const head = (await command("read HEAD", "git", ["rev-parse", "HEAD"], root, true)).trim();
    if (head !== sha) {
      throw new Error(`HEAD is ${head}, not ${tag} (${sha}); run this from a fresh clone of the tag`);
    }
    const dirty = await command("git status", "git", ["status", "--porcelain"], root, true);
    if (dirty.trim() !== "") throw new Error("the working tree is not clean; run this from a fresh clone of the tag");
    await refuse("verify tag", `tag ${tag} has no valid signature; sign it with git tag -s and make its key available`, "git", [
      "verify-tag",
      ref,
    ]);
    const listing = await refuse("compare with origin", `could not read ${tag} from origin`, "git", [
      "ls-remote",
      "origin",
      `${ref}^{}`,
      ref,
    ]);
    const remote = remoteTagCommit(listing, ref);
    if (remote === undefined) throw new Error(`origin has no ${tag}; push the tag first`);
    if (remote !== sha) throw new Error(`origin's ${tag} is ${remote}, not ${sha}; push the tag first`);
    for (const file of VERSION_FILES) {
      step = `read ${file} at ${tag}`;
      const text = await command(step, "git", ["show", `${sha}:${file}`], root, true);
      const found = JSON.parse(text).version;
      if (found !== version) throw new Error(`${file} at ${tag} says ${found}, not ${version}`);
    }

    step = "read apps/emend/src/version.ts";
    const versionSource = await command(step, "git", ["show", `${sha}:apps/emend/src/version.ts`], root, true);
    const literal = /^export const VERSION = "([^"\n]*)";$/m.exec(versionSource)?.[1];
    if (literal === undefined) {
      throw new Error(`apps/emend/src/version.ts at ${tag} has no 'export const VERSION = "...";' line`);
    }
    if (literal !== version) {
      throw new Error(`apps/emend/src/version.ts at ${tag} says ${literal}, not ${version}`);
    }

    step = "create temporary folder";
    temporary = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), "emend-release-pack-"));
    const source = join(temporary, "src");
    const pack = join(temporary, "pack");
    mkdirSync(source);
    mkdirSync(pack);
    await command("git archive", "git", ["archive", "--format=tar", `--output=${join(temporary, "src.tar")}`, sha]);
    await command("tar extract", "tar", ["-xf", join(temporary, "src.tar"), "-C", source]);
    await command("pnpm install", "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], source);
    await command("pnpm build", "pnpm", ["build"], source);
    await command("pnpm pack", "pnpm", ["pack", "--pack-destination", pack], join(source, "apps/emend"));
    step = "find tarball";
    const tarballs = readdirSync(pack).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) throw new Error("expected exactly one tarball");
    const tarball = join(pack, tarballs[0] as string);
    const before = readFileSync(tarball);
    await command("check:package", "node", ["scripts/check-package.ts", "--tarball", tarball], source);
    step = "hash tarball";
    const after = readFileSync(tarball);
    if (integrity(before) !== integrity(after)) throw new Error("the tarball changed while it was checked");
    const manifest = await command("read packed manifest", "tar", ["-xzOf", tarball, "package/package.json"], root, true);
    const packed = JSON.parse(manifest).version;
    if (packed !== version) throw new Error(`packed version is ${packed}, not ${version}`);

    stdout(`release:pack: packed @shllg/emend ${version} from ${tag} (${sha}).`);
    stdout(`release:pack: kept ${temporary}; remove it after publishing.`);
    stdout(publishCommand(tarball));
    stdout(`shasum: ${shasum(after)}`);
    stdout(`integrity: ${integrity(after)}`);
    stdout(
      "Compare the shasum line, and the start and end of the integrity line, with npm's before you enter the 2FA code.",
    );
    temporary = undefined;
  } catch (error) {
    const reason = error instanceof Error && !interruption.signal.aborted ? `: ${error.message}` : "";
    stderr(`release:pack: ${step} failed${reason}`);
    status = 1;
  } finally {
    if (temporary) {
      try {
        rmSync(temporary, { recursive: true, force: true });
      } catch {
        stderr("release:pack: cleanup failed");
        status = 1;
      }
    }
    signals.off("SIGINT", onInterrupt);
    signals.off("SIGTERM", onTerminate);
  }
  return interruption.signal.aborted ? (interruption.signal.reason === "SIGINT" ? 130 : 143) : status;
}

if (import.meta.main) process.exitCode = await releasePack(process.argv.slice(2));

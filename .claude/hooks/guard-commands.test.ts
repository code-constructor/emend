import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluate,
  evaluateTool,
  type GuardContext,
  type PackageInfo,
  realContext,
} from "./guard-commands.ts";

const script = fileURLToPath(new URL("./guard-commands.ts", import.meta.url));
const ROOT = "/work/emend";

interface CtxOptions {
  tags?: string[];
  aliases?: Record<string, string>;
  config?: Record<string, string>;
  scripts?: Record<string, string>;
  packages?: Record<string, PackageInfo | null>;
  files?: Record<string, string>;
  fail?: boolean;
  cwd?: string;
  /** The checked-out branch; null means a detached HEAD. */
  branch?: string | null;
}

const DEFAULT_SCRIPTS: Record<string, string> = {
  verify: "pnpm check:budget && pnpm test:harness",
  dev: "vite dev",
  ship: "wrangler deploy",
  test: "wrangler deploy",
  loop: "pnpm loop",
  prebuild: "wrangler deploy",
  build: "vite build",
};

function fakeContext(options: CtxOptions = {}): GuardContext {
  const packages: Record<string, PackageInfo | null> = {
    [ROOT]: { name: "emend", scripts: options.scripts ?? DEFAULT_SCRIPTS },
    ...options.packages,
  };
  const failing = <T>(value: T): T => {
    if (options.fail) throw new Error("lookup failed");
    return value;
  };
  return {
    cwd: options.cwd ?? ROOT,
    currentBranch: () => (options.branch === undefined ? "feat/x" : options.branch),
    tagNames: () => failing(new Set(options.tags ?? [])),
    aliases: () => failing(options.aliases ?? {}),
    pushConfig: () => failing(options.config ?? {}),
    packageJson: (dir) => packages[dir] ?? null,
    readScript: (file) => options.files?.[file] ?? null,
  };
}

const allowed = [
  "wrangler dev --local",
  "wrangler types",
  "pnpm exec wrangler types",
  "wrangler d1 migrations create DB init",
  "wrangler d1 migrations apply DB --local",
  "wrangler --help",
  "wrangler --version",
  "git status",
  "ls /home/someone/src",
  "cat apps/web/home.tsx",
  'echo "$HOME"',
  "env",
  "printenv HOME",
  "read -r line < f",
  "git log --oneline",
  "gh pr view 3 --json mergeable",
  "gh api repos/o/r/pulls",
  "gh auth status",
  "pnpm verify",
  "pnpm dev",
  "rg -n TODO src",
  "cat .claude/settings.json",
  "cat .git/config",
  "git diff .claude/hooks",
  "git log -- .claude/settings.json",
  "rg -n push .claude/hooks",
  "ls .git/hooks",
  "node --test .claude/hooks/guard-commands.test.ts",
  "node --test .claude/hooks/guard-commands.test.ts 2>&1",
  "cat .dev.vars.example",
  "drizzle-kit generate",
  "git commit -F /tmp/message.txt",
  "(cd cli && ls)",
  "rg -n wrangler AGENTS.md",
  'grep -rn "gh pr" docs',
  "git log --grep=push",
  "rg deploy wrangler docs",
  "git grep -n wrangler",
  "cat docs/gh.md",
  "head -n 5 notes/wrangler-deploy.md",
  "git config --get remote.origin.url",
  "git config --list",
  "git config --show-origin --list",
  "git config user.name",
  "git config --local --get-regexp alias",
  "git config --show-scope --get user.name",
  "git add *.ts",
  "cat .c*",
  "ls .git*",
  "git -c core.fsmonitor=false status",
  "git -c hooks.agentProtectedBranches=dev status",
];

for (const command of allowed) {
  test(`allows ${JSON.stringify(command)}`, () => {
    assert.equal(evaluate(command, fakeContext()), null);
  });
}

test("allows an explicit GET with fields", () => {
  assert.equal(evaluate("gh api -X GET search/issues -f q=x", fakeContext()), null);
});

test("allows a script file with harmless content", () => {
  assert.equal(evaluate("sh ok.sh", fakeContext({ files: { [`${ROOT}/ok.sh`]: "echo hi\n" } })), null);
});

// Reason patterns. Each blocked case asserts one, so a block for the wrong reason fails.
const DEPLOY = /deploying and remote setup are the owner's step/;
const REMOTE = /remote/;
const PUSH = /Agents never push in this repo\. The owner pushes\./;
const OWNER = /owner's step/;
const BUILT = /built at runtime/;
const UNRECOGNIZED = /form not recognized/;
const ENV = /environment variable/;
const GUARD = /naming the guard files/;
const SECRET = /reading secrets/;
const SCRIPT_FILE = /script file/;
const CREDENTIALS = /credentials/;
const PIPE = /a pipe into a shell/;
const GLOB = /could reach the guard or secret files/;
const NO_DEPLOY = /publishing emend is the owner's step/;

interface BlockedCase {
  command: string;
  reason: RegExp;
  options?: CtxOptions;
  note?: string;
}

const CLI_ONLY: CtxOptions = {
  scripts: { dev: "vite dev" },
  packages: { [`${ROOT}/cli`]: { name: "cli", scripts: { ship: "wrangler deploy" } } },
};

const blocked: BlockedCase[] = [
  // readers that run commands, and non-readers
  { command: 'rg --pre "wrangler deploy" x', reason: DEPLOY },
  { command: "rg --pre=./run.sh wrangler x", reason: UNRECOGNIZED },
  { command: "git grep -O wrangler", reason: UNRECOGNIZED },
  { command: "git grep --open-files-in-pager=sh wrangler", reason: UNRECOGNIZED },
  { command: "git -c core.pager=x log --grep=push", reason: /git -c core\.pager is blocked/ },
  { command: "git log --output=out.txt --grep=push", reason: /push form not recognized/ },
  { command: "rg wrangler | xargs gh pr merge 1", reason: OWNER },
  { command: "cat x $(wrangler deploy)", reason: DEPLOY },
  { command: "awk 1 wrangler deploy", reason: DEPLOY },
  { command: "sed s/a/b/ x; wrangler deploy", reason: DEPLOY },
  { command: "less wrangler deploy", reason: DEPLOY },
  { command: "rg wrangler; wrangler deploy", reason: DEPLOY },
  // git config writes and more forbidden -c keys
  { command: "git config user.name x", reason: /git config writes/ },
  { command: "git config --unset user.name", reason: /git config writes/ },
  { command: "git config --global alias.p push", reason: /git config writes/ },
  { command: "git config --add x y", reason: /git config writes/ },
  { command: "git config --edit", reason: /git config writes/ },
  { command: "git config -e", reason: /git config writes/ },
  { command: "git config --file x --list", reason: /git config writes/, note: "unknown flag" },
  { command: "git config", reason: /git config writes/, note: "no key" },
  { command: "git -c core.fsmonitor=true status", reason: /git -c core\.fsmonitor is blocked/ },
  { command: "git -c diff.external=x diff", reason: /git -c diff\.external is blocked/ },
  { command: "git -c filter.x.clean=y status", reason: /git -c filter\.x\.clean is blocked/ },
  { command: "git -c sequence.editor=x log", reason: /git -c sequence\.editor is blocked/ },
  { command: "git -c gpg.program=x log", reason: /git -c gpg\.program is blocked/ },
  { command: "git -c core.askpass=x log", reason: /git -c core\.askpass is blocked/ },
  { command: "git -c include.path=x log", reason: /git -c include\.path is blocked/ },
  { command: "git -c includeIf.x.path=y log", reason: /git -c includeIf\.x\.path is blocked/ },
  { command: "git -c hook.agent-push-guard.enabled=false status", reason: /git -c hook\.agent-push-guard\.enabled is blocked/ },
  { command: "git -c hook.pre-push.enabled=false status", reason: /git -c hook\.pre-push\.enabled is blocked/ },
  { command: "git -c Hook.X.Command=true log", reason: /git -c Hook\.X\.Command is blocked/ },
  { command: "git -chook.x.event= status", reason: /git -c hook\.x\.event is blocked/ },
  // globs aimed at guard and secret paths
  { command: "cp x .clau*/settings.json", reason: GLOB },
  { command: "cp x .{claude,y}/settings.json", reason: GLOB },
  { command: "rm .cod?x/rules/default.rules", reason: GLOB },
  { command: "tee .git/h*", reason: GLOB },
  { command: "cp x .*/settings.json", reason: GLOB },
  { command: "cat .dev.v*", reason: GLOB, note: "reader" },
  { command: "cat .env*", reason: GLOB, note: "reader" },
  { command: "rg x .dev.v*", reason: GLOB, note: "reader" },
  // wrangler forms
  { command: "wrangler deploy", reason: DEPLOY },
  { command: "npx wrangler deploy", reason: DEPLOY },
  { command: "npx wrangler@latest deploy", reason: DEPLOY },
  { command: "pnpm dlx wrangler@4 deploy", reason: DEPLOY },
  { command: "npx drizzle-kit@latest push", reason: /drizzle-kit push/ },
  { command: "pnpm exec wrangler deploy", reason: DEPLOY },
  { command: "pnpm -s exec wrangler deploy", reason: DEPLOY },
  { command: "pnpm --filter x exec wrangler deploy", reason: DEPLOY },
  { command: "pnpm -w exec wrangler deploy", reason: DEPLOY },
  { command: "pnpm -C . exec wrangler deploy", reason: DEPLOY },
  { command: "pnpm wrangler deploy", reason: DEPLOY },
  { command: "npm x wrangler deploy", reason: DEPLOY },
  { command: "yarn exec wrangler deploy", reason: DEPLOY },
  { command: "corepack pnpm exec wrangler deploy", reason: DEPLOY },
  { command: "node node_modules/wrangler/bin/wrangler.js deploy", reason: DEPLOY },
  { command: "./node_modules/.bin/wrangler deploy", reason: DEPLOY },
  { command: "node_modules/.bin/wrangler deploy", reason: DEPLOY },
  { command: "wrangler2 deploy", reason: DEPLOY },
  { command: "node_modules/.bin/wrangler2 deploy", reason: DEPLOY },
  { command: "cf-wrangler deploy", reason: DEPLOY },
  { command: "pnpm exec wrangler2 deploy", reason: DEPLOY },
  { command: "pnpm wrangler2 deploy", reason: DEPLOY },
  { command: "pnpm cf-wrangler deploy", reason: DEPLOY },
  { command: "npx -p wrangler wrangler2 deploy", reason: DEPLOY },
  { command: "npm explore wrangler -- wrangler2 deploy", reason: DEPLOY },
  { command: "wrangler --config dev deploy", reason: DEPLOY },
  { command: "wrangler -e types deploy", reason: DEPLOY },
  { command: 'X="a b" wrangler deploy', reason: DEPLOY },
  { command: "$'wrangler' deploy", reason: DEPLOY },
  { command: "wr\\angler deploy", reason: DEPLOY },
  { command: "\\wrangler deploy", reason: DEPLOY },
  { command: "wran\\\ngler deploy", reason: DEPLOY },
  { command: "W=wrangler; $W deploy", reason: DEPLOY },
  { command: ">/dev/null wrangler deploy", reason: DEPLOY },
  { command: "=wrangler deploy", reason: DEPLOY },
  { command: "{wrangler,deploy}", reason: DEPLOY },
  { command: "echo deploy | xargs wrangler", reason: DEPLOY },
  { command: "find . -exec wrangler deploy \\;", reason: DEPLOY },
  { command: "stdbuf -o0 wrangler deploy", reason: DEPLOY },
  { command: "stdbuf -o0 wrangler d1 create x", reason: DEPLOY, note: "layer 2 only" },
  { command: "npm x wrangler d1 create x", reason: DEPLOY, note: "layer 2 only" },
  { command: "setsid wrangler deploy", reason: DEPLOY },
  { command: "timeout --signal KILL 10 wrangler deploy", reason: DEPLOY },
  { command: "exec -a x wrangler deploy", reason: DEPLOY },
  { command: "env FOO=1 wrangler deploy", reason: DEPLOY },
  { command: "nohup wrangler deploy", reason: DEPLOY },
  { command: "time wrangler deploy", reason: DEPLOY },
  { command: "sudo wrangler deploy", reason: DEPLOY },
  { command: "cd x && wrangler deploy", reason: DEPLOY },
  { command: 'bash -c "wrangler deploy"', reason: DEPLOY },
  { command: "echo $(wrangler deploy)", reason: DEPLOY },
  { command: "true; wrangler deploy", reason: DEPLOY },
  { command: "true | wrangler deploy", reason: DEPLOY },
  { command: "wrangler login", reason: DEPLOY },
  { command: "wrangler secret put X", reason: DEPLOY },
  { command: "wrangler d1 create emend", reason: DEPLOY },
  { command: 'wrangler d1 execute DB --command "select 1"', reason: DEPLOY },
  { command: "wrangler d1 execute DB --remote --command x", reason: REMOTE },
  { command: "wrangler dev -r", reason: REMOTE },
  { command: "wrangler dev", reason: /use `wrangler dev --local`/ },
  { command: "wrangler dev --remote=x", reason: REMOTE },
  { command: "wrangler r2 bucket create b", reason: DEPLOY },
  { command: "wrangler r2 object put b/k --file f", reason: DEPLOY },
  { command: "wrangler kv namespace create x", reason: DEPLOY },
  { command: "wrangler whoami", reason: DEPLOY },
  { command: "drizzle-kit push", reason: /drizzle-kit push/ },
  { command: "pnpm exec drizzle-kit migrate", reason: /drizzle-kit push/ },
  { command: "pnpm db:migrate --remote", reason: REMOTE },
  // runtime-built words (round 2, H1)
  { command: "git pu${X}sh origin main", reason: BUILT },
  { command: "git push${X} origin main", reason: BUILT },
  { command: "git pu$@sh origin HEAD:main", reason: BUILT },
  { command: "git $(printf pu)sh origin main", reason: BUILT },
  { command: "git `printf pu`sh origin main", reason: BUILT },
  { command: "git $(printf pu)sh origin HEAD:main", reason: BUILT },
  { command: "git ta${X}g v9 && git push origin v9", reason: BUILT },
  { command: "$(echo wrang)ler deploy", reason: BUILT },
  { command: "`echo wrang`ler deploy", reason: /deploying and remote setup|built at runtime/ },
  { command: "node_modules/.bin/wrangle? deploy", reason: BUILT },
  { command: "node_modules/.bin/wr*ler deploy", reason: BUILT },
  { command: "./node_modules/.bin/wrangle[r] deploy", reason: BUILT },
  { command: "gh pr mer${X}ge 1 --squash", reason: BUILT },
  { command: "gh pr merge$X 1", reason: BUILT },
  { command: "gh pr rev${X}iew 1 -a", reason: BUILT },
  { command: "gh api -X P${X}UT repos/o/r/pulls/1/merge", reason: BUILT },
  { command: "drizzle-kit pu${X}sh", reason: BUILT },
  { command: "$(git --exec-path)/git-push origin HEAD:main", reason: BUILT },
  { command: "R=$(printf -- --rem)ote; wrangler dev --local $R", reason: BUILT },
  { command: "gh repo ed${X}it --visibility=public", reason: OWNER },
  // shell-feeding forms and escapes (H1)
  { command: "echo wrangler deploy | bash", reason: PIPE },
  { command: "echo x | sh", reason: PIPE },
  { command: "cat script | sudo bash", reason: PIPE },
  { command: "echo x | nice sh", reason: PIPE },
  { command: "echo x | stdbuf -o0 bash", reason: PIPE },
  { command: "printf '\\167rangler deploy' | nice sh", reason: PIPE },
  { command: "printf '\\167rangler deploy' | busybox sh", reason: PIPE },
  { command: "printf '\\147it push origin HEAD:main' | stdbuf -o0 bash", reason: PIPE },
  { command: "printf '\\167rangler deploy' > x.sh; sh x.sh", reason: /printf or echo -e/ },
  { command: "sh -c \"$(printf '\\167rangler deploy')\"", reason: /printf or echo -e/ },
  { command: "echo -e 'a\\x41'", reason: /printf or echo -e/ },
  { command: "$'\\x77rangler' deploy", reason: /backslash escape/ },
  { command: "bash <<< 'wrangler deploy'", reason: /here-string/ },
  { command: "bash <(echo wrangler deploy)", reason: /here-string/ },
  { command: "bash -s < script", reason: /stdin \(-s\)/ },
  { command: "source /dev/stdin", reason: /source of stdin/ },
  { command: "eval $(echo wrangler) deploy", reason: /eval/ },
  { command: "builtin eval wrangler deploy", reason: /eval/ },
  // script files (H1)
  { command: "sh x.sh", reason: SCRIPT_FILE, note: "missing file" },
  { command: "bash ./x.sh", reason: SCRIPT_FILE, note: "missing file" },
  { command: "source x.sh", reason: SCRIPT_FILE, note: "missing file" },
  { command: ". x.sh", reason: SCRIPT_FILE, note: "missing file" },
  {
    command: "sh x.sh",
    reason: DEPLOY,
    options: { files: { [`${ROOT}/x.sh`]: "wrangler deploy\n" } },
    note: "file content deploys",
  },
  {
    command: "bash -x x.sh",
    reason: PUSH,
    options: { files: { [`${ROOT}/x.sh`]: "git push origin main\n" } },
    note: "file content pushes",
  },
  {
    command: "source x.sh",
    reason: DEPLOY,
    options: { files: { [`${ROOT}/x.sh`]: "pnpm ship\n" } },
    note: "file content runs a deploying script",
  },
  // unknown wrappers (H2)
  { command: "mise exec -- wrangler d1 create emend", reason: UNRECOGNIZED },
  { command: "flock /tmp/l wrangler d1 create emend", reason: UNRECOGNIZED },
  { command: "ionice -c3 wrangler d1 create emend", reason: UNRECOGNIZED },
  { command: "script -qc 'wrangler d1 create emend' /dev/null", reason: UNRECOGNIZED },
  { command: "flock /tmp/l gh api -X PUT repos/shllg/emend/pulls/1/merge", reason: UNRECOGNIZED },
  { command: "mise exec -- gh api -X PATCH repos/shllg/emend -F private=false", reason: UNRECOGNIZED },
  { command: "mise exec -- drizzle-kit generate", reason: UNRECOGNIZED },
  { command: "flock /tmp/l gh pr merge 1", reason: OWNER },
  // dashed git builtins (H3)
  { command: "/usr/lib/git-core/git-push origin main", reason: /git-push is blocked/ },
  { command: "git-send-pack origin HEAD:main", reason: /git-send-pack is blocked/ },
  { command: "git-http-push origin HEAD:main", reason: /git-http-push is blocked/ },
  { command: "git-receive-pack x", reason: /git-receive-pack is blocked/ },
  { command: "git send-pack git@github.com:shllg/emend.git HEAD:refs/heads/main", reason: /git send-pack is blocked/ },
  { command: "git send-pack origin HEAD:main", reason: /git send-pack is blocked/ },
  { command: "git send-pack ../remote.git feat/x:main", reason: /git send-pack is blocked/ },
  { command: "git http-push origin x", reason: /git http-push is blocked/ },
  { command: "git receive-pack x", reason: /git receive-pack is blocked/ },
  { command: "git apply /tmp/p.diff", reason: /git apply is blocked/ },
  // environment (H4, L4)
  { command: "GIT_CONFIG_PARAMETERS=\"'push.followTags=true'\" git push -u origin feat/x", reason: ENV },
  { command: "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.followTags GIT_CONFIG_VALUE_0=true git push -u origin feat/x", reason: ENV },
  { command: "git_config_count=1 git status", reason: ENV },
  { command: "GIT_DIR=x git status", reason: ENV },
  { command: "export GIT_WORK_TREE=/tmp", reason: ENV },
  { command: "GIT_SSH_COMMAND=x git status", reason: ENV },
  { command: "GIT_EXEC_PATH=/tmp git status", reason: ENV },
  { command: "GIT_ASKPASS=x git status", reason: ENV },
  { command: "unset CLAUDECODE", reason: ENV },
  { command: "CLAUDE_CODE_FOO=1 ls", reason: ENV },
  { command: "export CODEX_HOME=/tmp", reason: ENV },
  { command: "GH_CONFIG_DIR=./cfg gh co", reason: ENV },
  { command: "HOME=./cfg git p origin feat/x", reason: ENV },
  { command: "XDG_CONFIG_HOME=./cfg git status", reason: ENV },
  { command: "GH_REPO=other/repo gh pr create --head feat/x", reason: ENV },
  { command: "export HOME=/tmp/x; git push", reason: ENV },
  { command: "env GH_REPO=o/r gh pr view 1", reason: ENV },
  { command: "env HOME=/tmp/x git status", reason: ENV },
  { command: "unset GH_CONFIG_DIR", reason: ENV },
  { command: "env -u HOME git status", reason: ENV },
  { command: "cd /tmp && XDG_CONFIG_HOME=x git log", reason: ENV },
  { command: "HOME+=/x git p origin feat/x", reason: ENV },
  { command: "export \"HOME=/r\"", reason: ENV },
  { command: "export 'HOME'=/r", reason: ENV },
  { command: "export H\\OME=/r", reason: ENV },
  { command: "unset \"HOME\"", reason: ENV },
  { command: "env -S 'HOME=/p git p origin feat/x'", reason: ENV },
  { command: "export GIT_DI\\R=x", reason: ENV },
  { command: "echo \"HOME=$HOME\"", reason: ENV, note: "expected false positive" },
  { command: "printf -v HOME /p", reason: ENV },
  { command: "read HOME <<< /q", reason: ENV },
  { command: "read -r HOME < f", reason: ENV },
  { command: "mapfile HOME < f", reason: ENV },
  { command: "unset -- HOME", reason: ENV },
  { command: "env -uHOME git status", reason: ENV },
  { command: "set -a; unset -- HOME; : ${HOME:=/s}", reason: ENV },
  { command: ": ${GH_CONFIG_DIR:=/s}", reason: ENV },
  { command: "BASH_ENV=./rc bash -c 'git status'", reason: ENV },
  { command: "ENV=./rc sh -c 'git status'", reason: ENV },
  { command: "ZDOTDIR=./z zsh -c 'git status'", reason: ENV },
  { command: "env -u GIT_SSH_COMMAND git status", reason: ENV },
  { command: "unset CLOUDFLARE_API_TOKEN; $(echo wrang)ler deploy", reason: ENV },
  { command: "env -u CLOUDFLARE_API_TOKEN node_modules/.bin/wrangle? deploy", reason: ENV },
  { command: "WRANGLER_SEND_METRICS=false wrangler types", reason: ENV },
  // package scripts
  { command: "pnpm deploy", reason: NO_DEPLOY },
  { command: "pnpm run deploy", reason: NO_DEPLOY },
  { command: "npm run deploy", reason: NO_DEPLOY },
  { command: "npm run-script deploy", reason: NO_DEPLOY },
  { command: "yarn run deploy", reason: NO_DEPLOY },
  { command: "pnpm ship", reason: /script "ship"/ },
  { command: "pnpm run ship", reason: /script "ship"/ },
  { command: "pnpm -C . ship", reason: /script "ship"/ },
  { command: "pnpm --dir . ship", reason: /script "ship"/ },
  { command: "pnpm --filter . ship", reason: /script "ship"/ },
  { command: "pnpm -r ship", reason: /cannot be resolved/ },
  { command: "npm --prefix . run ship", reason: /script "ship"/ },
  { command: "npm test", reason: /script "test"/ },
  { command: "npm t", reason: /script "test"/ },
  { command: "bun run ship", reason: /script "ship"/ },
  { command: "pnpm loop", reason: /nests deeper/, note: "depth limit" },
  { command: "pnpm --filter nope ship", reason: /cannot be resolved/, note: "unknown filter name" },
  { command: "pnpm build", reason: /script "prebuild"/, note: "prebuild deploys" },
  { command: "pnpm run missing", reason: /has no script "missing"/ },
  { command: "cd cli && pnpm ship", reason: /script "ship"/, options: CLI_ONLY },
  { command: "pnpm -C cli ship", reason: /script "ship"/, options: CLI_ONLY },
  { command: "npm -C cli run ship", reason: /script "ship"/, options: CLI_ONLY },
  { command: "pnpm run --dir cli ship", reason: /script "ship"/, options: CLI_ONLY },
  { command: "pnpm run -C cli ship", reason: /script "ship"/, options: CLI_ONLY },
  { command: "pnpm -Ccli ship", reason: /script "ship"/, options: CLI_ONLY },
  { command: "npm run --prefix cli ship", reason: /script "ship"/, options: CLI_ONLY },
  { command: "npm run ship --prefix cli", reason: /script "ship"/, options: CLI_ONLY },
  { command: "pnpm ship -C cli", reason: /script "ship"/, options: CLI_ONLY },
  { command: "pnpm run ship --dir cli", reason: /script "ship"/, options: CLI_ONLY },
  { command: "pnpm -C a ship --dir b", reason: /cannot be resolved/, note: "two directories" },
  { command: "pnpm git push origin main", reason: PUSH, note: "bin fallback" },
  // git push
  { command: "git push origin main", reason: PUSH },
  { command: "git push -u origin feat/x", reason: PUSH, note: "the repo is public" },
  { command: "git push origin HEAD:feat/x", reason: PUSH },
  { command: "git push --dry-run origin feat/x", reason: PUSH },
  { command: "git push origin HEAD:main", reason: PUSH },
  { command: "git push origin feat/x:refs/heads/main", reason: PUSH },
  { command: "git push origin HEAD:heads/main", reason: PUSH },
  { command: "git push origin heads/main", reason: PUSH },
  { command: "git push origin 'refs/heads/*:refs/heads/*'", reason: PUSH },
  { command: "git push origin refs/tags/x", reason: PUSH },
  { command: "git push --force origin feat/x", reason: PUSH },
  { command: "git push --force-with-lease origin feat/x", reason: PUSH },
  { command: "git push --force-w origin feat/x", reason: PUSH },
  { command: "git push -fu origin feat/x", reason: PUSH },
  { command: "git push --mirror", reason: PUSH },
  { command: "git push --mirr", reason: PUSH },
  { command: "git push --all", reason: PUSH },
  { command: "git push --follow-tags origin feat/x", reason: PUSH },
  { command: "git push --tags", reason: PUSH },
  { command: "git push --ta", reason: PUSH },
  { command: "git push -d origin x", reason: PUSH },
  { command: "git push --delete origin feat/x", reason: PUSH },
  { command: "git push --del origin x", reason: PUSH },
  { command: "git push origin +feat/x", reason: PUSH },
  { command: "git push origin :feat/x", reason: PUSH },
  { command: "git push -o x origin feat/x", reason: PUSH },
  { command: "git push --no-verify origin feat/x", reason: PUSH },
  { command: "git push", reason: PUSH },
  { command: "git push origin", reason: PUSH },
  { command: "cd /tmp && git push", reason: PUSH },
  { command: "git --git-dir .git push origin feat/x", reason: PUSH },
  { command: "git -ccore.x=y push origin feat/x", reason: PUSH },
  { command: "git --no-optional-locks push origin feat/x", reason: PUSH },
  { command: "git -C ../other push origin main", reason: PUSH },
  { command: "git -c alias.p=push p origin feat/x:main", reason: /git -c alias\.p is blocked/ },
  { command: "git -c remote.origin.push=HEAD:main push", reason: /git -c remote\.origin\.push is blocked/ },
  { command: "echo HEAD:main | xargs git push origin", reason: PUSH },
  { command: "git switch main && git push", reason: PUSH },
  { command: "git tag v9 && git push origin v9", reason: /also creates a tag/ },
  { command: "git push origin v1", reason: /names a tag/, options: { tags: ["v1"] } },
  {
    command: "git push origin feat/x",
    reason: /followTags is true/,
    options: { config: { "push.followtags": "true" } },
    note: "followTags",
  },
  { command: "git p origin feat/x", reason: /alias that pushes/, options: { aliases: { p: "push" } } },
  { command: "git q", reason: /alias that pushes/, options: { aliases: { q: "!sh -c x" } }, note: "shell alias" },
  { command: "git r", reason: /alias that pushes/, options: { aliases: { r: "s", s: "send-pack" } }, note: "alias chain" },
  { command: "git config alias.p push", reason: OWNER },
  { command: "git push -u origin feat/x", reason: /could not be checked/, options: { fail: true }, note: "lookup failure" },
  // credentials (M4)
  { command: "git credential fill", reason: CREDENTIALS },
  { command: "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill", reason: CREDENTIALS },
  { command: "git credential-store get", reason: CREDENTIALS },
  { command: "gh auth token", reason: CREDENTIALS },
  { command: "gh auth login", reason: CREDENTIALS },
  { command: "gh auth status --show-token", reason: CREDENTIALS },
  { command: "gh auth status -t", reason: CREDENTIALS },
  { command: "gh ssh-key add /tmp/k.pub", reason: CREDENTIALS },
  { command: "gh gpg-key add /tmp/k.pub", reason: CREDENTIALS },
  { command: "gh extension install someone/gh-x", reason: CREDENTIALS },
  { command: "gh config set git_protocol ssh", reason: CREDENTIALS },
  { command: "gh repo deploy-key add /tmp/k.pub --allow-write --title ci", reason: CREDENTIALS },
  { command: "gh repo sync", reason: CREDENTIALS },
  // gh
  { command: "gh pr merge 1 --squash", reason: OWNER },
  { command: "gh pr create --fill", reason: /`gh pr create` can push the branch/ },
  { command: "gh pr create --head feat/x --fill", reason: /`gh pr create` can push the branch/ },
  { command: "gh pr create --head owner:feat/x", reason: PUSH },
  { command: "gh pr review 1 --approve", reason: OWNER },
  { command: "gh pr review 1 --approve=true", reason: OWNER },
  { command: "gh pr review 1 -a", reason: OWNER, note: "layer 2 only" },
  { command: "gh repo edit --visibility public", reason: OWNER },
  { command: "gh repo delete x", reason: OWNER },
  { command: "gh repo create x --public --source . --push", reason: OWNER },
  { command: "gh secret set X", reason: OWNER },
  { command: "gh variable set X", reason: OWNER },
  { command: "gh release create v1", reason: OWNER },
  { command: "gh workflow run ci.yml", reason: OWNER },
  { command: "gh alias set m 'pr merge'", reason: OWNER },
  { command: "gh gist create --public f", reason: OWNER },
  { command: "gh api -X PUT repos/o/r/pulls/1/merge", reason: OWNER },
  { command: "gh api --method PATCH repos/o/r/pulls/1", reason: OWNER },
  { command: "gh api -X GET repos/o/r/pulls/1/merge --method PUT", reason: OWNER },
  { command: "gh api repos/o/r/pulls/1/merge -f merge_method=squash", reason: OWNER },
  { command: "gh api graphql -f query=mutation{x}", reason: OWNER },
  // guard files and secrets (M2)
  { command: "echo x > .claude/settings.json", reason: GUARD },
  { command: "echo x > .claude/settings.local.json", reason: GUARD },
  { command: "sed -i s/a/b/ .claude/hooks/guard-commands.ts", reason: GUARD },
  { command: "sed -i s/a/b/ .claude/settings.local.json", reason: GUARD },
  { command: "rm .codex/rules/default.rules", reason: GUARD },
  { command: "cp /tmp/x .claude/hooks/guard-commands.ts", reason: GUARD },
  { command: "git checkout -- .claude/settings.json", reason: GUARD },
  { command: "echo x > .git/config", reason: GUARD },
  { command: "printf '[alias]\\n\\tco = !sh x\\n' >> .git/config", reason: GUARD },
  { command: "chmod +x .git/hooks/pre-push", reason: GUARD },
  { command: "rm .git/hooks/pre-push", reason: GUARD },
  { command: "printf x >> ~/.gitconfig", reason: GUARD },
  { command: "cp x ~/.config/git/config", reason: GUARD },
  { command: "ln -s x .claude/hooks/y", reason: GUARD },
  { command: "tee .codex/config.toml", reason: GUARD },
  { command: "python3 -c \"open('.claude/hooks/guard-commands.ts','w').write('')\"", reason: GUARD },
  { command: "node -e \"require('fs').writeFileSync('.claude/settings.json','{}')\"", reason: GUARD },
  { command: "patch .claude/hooks/guard-commands.ts < /tmp/p.diff", reason: GUARD },
  {
    command: "printf '#!/bin/sh\\ngit pu${X}sh origin HEAD:main\\n' > .git/hooks/post-commit && chmod +x .git/hooks/post-commit",
    reason: GUARD,
  },
  { command: "patch -p1 < /tmp/p.diff", reason: /patch is blocked/ },
  { command: "cat .dev.vars", reason: SECRET },
  { command: "cat ./.dev.vars", reason: SECRET },
  { command: "rg x .env", reason: SECRET },
  { command: "cat ~/.config/.wrangler/config/default.toml", reason: SECRET },
];

const seenNames = new Set<string>();

for (const { command, reason, options, note } of blocked) {
  const name = `blocks ${JSON.stringify(command)}${note ? ` (${note})` : ""}`;
  assert.ok(!seenNames.has(name), `duplicate test name: ${name}`);
  seenNames.add(name);
  test(name, () => {
    const result = evaluate(command, fakeContext(options));
    assert.equal(typeof result, "string", `expected a block for: ${command}`);
    assert.match(result as string, reason);
  });
}

test("blocks a command over 50000 characters", () => {
  assert.match(evaluate(`echo ${"a".repeat(50001)}`, fakeContext()) ?? "", /longer than 50000/);
});

test("blocks a command with more than 500 segments", () => {
  assert.match(evaluate(Array(501).fill("true").join("; "), fakeContext()) ?? "", /more than 500 segments/);
});

test("blocks a very long shell word list quickly", () => {
  const started = Date.now();
  const reason = evaluate("sh ".repeat(16000), fakeContext());
  assert.notEqual(reason, null);
  assert.ok(Date.now() - started < 5000);
});

test("blocks when the working directory is unknown after cd", () => {
  assert.match(evaluate("cd $HOME && pnpm dev", fakeContext()) ?? "", /package directory cannot be resolved/);
});

test("blocks a package script when package.json is unreadable", () => {
  const ctx = fakeContext({ packages: { [ROOT]: null } });
  assert.match(evaluate("pnpm dev", ctx) ?? "", /package\.json is not a readable file/);
});

test("the block message for a push says what to do", () => {
  assert.match(evaluate("git push origin main", fakeContext()) ?? "", PUSH);
});

test("a blocked commit message gets the commit -F hint", () => {
  const reason = evaluate('git commit -m "docs: explain wrangler deploy"', fakeContext()) ?? "";
  assert.match(reason, /git commit -F <file>/);
  const long = evaluate('git commit --message "explain wrangler deploy"', fakeContext()) ?? "";
  assert.match(long, /git commit -F <file>/);
  assert.match(reason, /Inside the sandbox, `\.git` is read-only, so follow the global commit-signing rule instead\./);
});

test("a block that is not a commit message gets no commit hint", () => {
  assert.doesNotMatch(evaluate("wrangler deploy", fakeContext()) ?? "", /git commit -F/);
});

test("evaluateTool sends a Monitor command through the rules", () => {
  const input = { tool_name: "Monitor", tool_input: { command: "wrangler deploy" } };
  assert.match(evaluateTool(input, fakeContext()) ?? "", DEPLOY);
});

test("evaluateTool sends a PowerShell command through the rules", () => {
  const input = { tool_name: "PowerShell", tool_input: { command: "wrangler deploy" } };
  assert.match(evaluateTool(input, fakeContext()) ?? "", DEPLOY);
});

test("evaluateTool allows a tool without a command", () => {
  assert.equal(evaluateTool({ tool_name: "Read", tool_input: { file_path: "x" } }, fakeContext()), null);
});

test("evaluateTool blocks Codex danger-full-access anywhere in the input", () => {
  const input = {
    tool_name: "mcp__codex__codex",
    tool_input: { config: { nested: ["danger-full-access"] } },
  };
  assert.match(evaluateTool(input, fakeContext()) ?? "", /danger-full-access is blocked/);
});

function codexRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-root-"));
  temps.push(root);
  mkdirSync(path.join(root, "apps", "emend"), { recursive: true });
  mkdirSync(path.join(root, "apps", "web"), { recursive: true });
  return root;
}

test("evaluateTool accepts Codex workspace-write", () => {
  const root = codexRoot();
  const input = { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: root } };
  assert.equal(evaluateTool(input, fakeContext({ cwd: root })), null);
});

test("evaluateTool accepts a Codex session at the project root spelled exactly", () => {
  const root = codexRoot();
  for (const cwd of [root, `${root}/`, "."]) {
    const input = { tool_name: "mcp__codex__codex-start", tool_input: { sandbox: "read-only", cwd } };
    assert.equal(evaluateTool(input, fakeContext({ cwd: root })), null, cwd);
  }
});

test("evaluateTool blocks every other spelling of the project root", () => {
  const root = codexRoot();
  symlinkSync(root, path.join(root, "apps", "self"));
  symlinkSync(path.join(root, "apps", "web"), path.join(root, "link"));
  const cwds = [
    `${root}/link/..`,
    `${root}/apps/..`,
    `${root}/apps/self`,
    "apps/self",
    `${root}/./`,
    `${root}//apps/..`,
    `${root}/apps/web/../..`,
    "./",
    "..",
  ];
  for (const cwd of cwds) {
    const input = { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd } };
    assert.match(evaluateTool(input, fakeContext({ cwd: root })) ?? "", /must start at the repository root/, cwd);
  }
});

test("evaluateTool accepts the real path of a project root that is itself a symlink", () => {
  const real = codexRoot();
  const holder = mkdtempSync(path.join(tmpdir(), "codex-link-"));
  temps.push(holder);
  const linked = path.join(holder, "repo");
  symlinkSync(real, linked);
  const input = { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: real } };
  assert.equal(evaluateTool(input, fakeContext({ cwd: linked })), null);
});

test("evaluateTool blocks a Codex session in a subdirectory of the project", () => {
  const root = codexRoot();
  for (const cwd of [`${root}/apps/emend`, "apps/web", "apps"]) {
    const input = { tool_name: "mcp__codex__codex-start", tool_input: { sandbox: "read-only", cwd } };
    assert.match(evaluateTool(input, fakeContext({ cwd: root })) ?? "", /nested \.codex\/config\.toml/, cwd);
  }
});

test("evaluateTool blocks a Codex session through a symlink to a subdirectory", () => {
  const root = codexRoot();
  symlinkSync(path.join(root, "apps", "web"), path.join(root, "link-to-web"));
  const input = { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd: "link-to-web" } };
  assert.match(evaluateTool(input, fakeContext({ cwd: root })) ?? "", /is not the root/);
});

test("evaluateTool blocks a Codex session outside the project", () => {
  const root = codexRoot();
  for (const cwd of ["/work", `${root}-other`, `${root}/../x`, "/", "", "/tmp"]) {
    const input = { tool_name: "mcp__codex__codex", tool_input: { sandbox: "workspace-write", cwd } };
    assert.match(
      evaluateTool(input, fakeContext({ cwd: root })) ?? "",
      /Codex sessions must start at the repository root/,
      cwd,
    );
  }
  const missing = { tool_name: "mcp__codex__codex-start", tool_input: { sandbox: "workspace-write" } };
  assert.match(evaluateTool(missing, fakeContext({ cwd: root })) ?? "", /the cwd is missing/);
  const fork = { tool_name: "mcp__codex__codex-thread-fork", tool_input: { cwd: "/tmp" } };
  assert.match(evaluateTool(fork, fakeContext({ cwd: root })) ?? "", /is not the root/);
});

test("evaluateTool lets a Codex call without a session cwd through", () => {
  const input = { tool_name: "mcp__codex__codex-status", tool_input: { jobId: "j" } };
  assert.equal(evaluateTool(input, fakeContext()), null);
});

// The mcp-agents daemon keeps threads per project, so thread-reuse calls need no lookup here.
test("evaluateTool lets Codex thread-reuse calls through", () => {
  const root = codexRoot();
  for (const tool of [
    "mcp__codex__codex-reply",
    "mcp__codex__codex-reply-start",
    "mcp__codex__codex-thread-fork",
    "mcp__codex__codex-review-start",
    "mcp__codex__codex-steer",
  ]) {
    const input = { tool_name: tool, tool_input: { threadId: "0190a000-0000-7000-8000-000000000001", prompt: "go on" } };
    assert.equal(evaluateTool(input, fakeContext({ cwd: root })), null, tool);
  }
});

test("evaluateTool applies the root-only cwd rule to every Codex tool that carries a cwd", () => {
  const root = codexRoot();
  for (const tool of ["mcp__codex__codex", "mcp__codex__codex-start", "mcp__codex__codex-thread-list"]) {
    const sub = { tool_name: tool, tool_input: { cwd: `${root}/apps/web` } };
    assert.match(evaluateTool(sub, fakeContext({ cwd: root })) ?? "", /must start at the repository root/, tool);
    const ok = { tool_name: tool, tool_input: { cwd: root, sandbox: "read-only" } };
    assert.equal(evaluateTool(ok, fakeContext({ cwd: root })), null, tool);
  }
});

test("evaluateTool blocks accepting a Codex request", () => {
  for (const decision of ["accept", "acceptForSession"]) {
    const input = { tool_name: "mcp__codex__codex-interaction-resolve", tool_input: { decision } };
    assert.match(evaluateTool(input, fakeContext()) ?? "", /Decline it/);
  }
});

test("evaluateTool allows declining a Codex request", () => {
  const input = { tool_name: "mcp__codex__codex-interaction-resolve", tool_input: { decision: "decline" } };
  assert.equal(evaluateTool(input, fakeContext()), null);
});

// realContext against a temporary git repository.

const temps: string[] = [];

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-"));
  temps.push(dir);
  git(dir, "init", "-b", "main");
  git(dir, "commit", "--allow-empty", "-m", "init");
  return dir;
}

function withGitEnv<T>(run: () => T): T {
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    return run();
  } finally {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.system;
  }
}

test("realContext reads the current branch and null for a detached HEAD", () => {
  const dir = makeRepo();
  withGitEnv(() => {
    assert.equal(realContext(dir).currentBranch(dir), "main");
  });
  git(dir, "switch", "--detach", "HEAD");
  withGitEnv(() => {
    assert.equal(realContext(dir).currentBranch(dir), null);
  });
});

test("realContext lists tags", () => {
  const dir = makeRepo();
  git(dir, "tag", "v1");
  git(dir, "tag", "-a", "-m", "v2", "release/v2");
  withGitEnv(() => {
    assert.deepEqual([...realContext(dir).tagNames(dir)].sort(), ["release/v2", "v1"]);
  });
});

test("realContext reads aliases with lowercase names", () => {
  const dir = makeRepo();
  git(dir, "config", "alias.P", "push");
  withGitEnv(() => {
    assert.deepEqual(realContext(dir).aliases(dir), { p: "push" });
  });
});

test("realContext returns no aliases when none are set", () => {
  const dir = makeRepo();
  withGitEnv(() => {
    assert.deepEqual(realContext(dir).aliases(dir), {});
  });
});

test("realContext reads push.followTags", () => {
  const dir = makeRepo();
  git(dir, "config", "push.followTags", "true");
  withGitEnv(() => {
    assert.equal(realContext(dir).pushConfig(dir)["push.followtags"], "true");
  });
});

test("realContext reads a regular package.json and refuses a symlink or a missing file", () => {
  const dir = makeRepo();
  writeFileSync(path.join(dir, "package.json"), '{"name":"p","scripts":{"a":"b","n":1}}');
  const ctx = realContext(dir);
  assert.deepEqual(ctx.packageJson(dir), { name: "p", scripts: { a: "b" } });

  const linked = path.join(dir, "linked");
  mkdirSync(linked);
  symlinkSync(path.join(dir, "package.json"), path.join(linked, "package.json"));
  assert.equal(realContext(dir).packageJson(linked), null);
  assert.equal(realContext(dir).packageJson(path.join(dir, "missing")), null);
});

test("realContext reads a small regular script and refuses a missing, linked or oversized file", () => {
  const dir = makeRepo();
  const small = path.join(dir, "small.sh");
  writeFileSync(small, "echo hi\n");
  writeFileSync(path.join(dir, "big.sh"), "x".repeat(64 * 1024 + 1));
  symlinkSync(small, path.join(dir, "link.sh"));
  const ctx = realContext(dir);
  assert.equal(ctx.readScript(small), "echo hi\n");
  assert.equal(ctx.readScript(path.join(dir, "big.sh")), null);
  assert.equal(ctx.readScript(path.join(dir, "link.sh")), null);
  assert.equal(ctx.readScript(path.join(dir, "missing.sh")), null);
  assert.equal(ctx.readScript(dir), null);
});

test("evaluate with the real context blocks a feature-branch push in a temp repo", () => {
  const dir = makeRepo();
  writeFileSync(path.join(dir, "package.json"), '{"scripts":{}}');
  withGitEnv(() => {
    assert.match(evaluate("git push -u origin feat/x", realContext(dir)) ?? "", PUSH);
    assert.match(evaluate("git push -u origin main", realContext(dir)) ?? "", PUSH);
  });
});

// gh: the "new" aliases, clustered short flags, the read-only allowlist.
const GH_CREATE_ALIASES: { command: string; reason: RegExp }[] = [
  { command: "gh pr new --fill", reason: /`gh pr create` can push the branch/ },
  { command: "gh pr new --head feat/x", reason: /`gh pr create` can push the branch/ },
  { command: "gh repo new x --public --source . --push", reason: OWNER },
  { command: "gh release new v1", reason: OWNER },
  { command: "gh gist new --public f", reason: OWNER },
];
for (const { command, reason } of GH_CREATE_ALIASES) {
  test(`blocks the gh alias ${JSON.stringify(command)}`, () => {
    assert.match(evaluate(command, fakeContext()) ?? "", reason);
  });
}

const GH_API_BLOCKED = [
  "gh api -iXPUT repos/o/r/pulls/1/merge",
  "gh api -iX PUT repos/o/r/pulls/1/merge",
  "gh api -iX=PUT repos/o/r/pulls/1/merge",
  "gh api -iF ref=refs/heads/x repos/o/r/git/refs",
  "gh api -if ref=refs/heads/x repos/o/r/git/refs",
  "gh api -sXDELETE repos/o/r/git/refs/heads/x",
  "gh api -X GET -iXPOST repos/o/r",
  "gh api -iZ repos/o/r",
];
for (const command of GH_API_BLOCKED) {
  test(`blocks ${JSON.stringify(command)}`, () => {
    assert.match(evaluate(command, fakeContext()) ?? "", OWNER);
  });
}

const GH_API_ALLOWED = [
  "gh api -i repos/o/r",
  "gh api -iXGET repos/o/r",
  "gh api -iH 'Accept: application/json' repos/o/r",
  "gh api -X GET search/issues -f q=x",
];
for (const command of GH_API_ALLOWED) {
  test(`allows ${JSON.stringify(command)}`, () => {
    assert.equal(evaluate(command, fakeContext()), null);
  });
}

const GH_READ_ONLY = [
  "gh pr view 1",
  "gh pr list --state open",
  "gh pr ls",
  "gh pr status",
  "gh pr diff 1",
  "gh pr checks 1 --watch",
  "gh issue view 1",
  "gh issue list",
  "gh repo view",
  "gh run list",
  "gh run view 1 --log",
  "gh run watch 1",
  "gh pr --repo o/r view 1",
  "gh pr -R o/r view 1",
  "gh pr -Ro/r view 1",
  "gh pr --repo=o/r view 1",
  "gh api repos/o/r --jq .name --paginate",
  "gh workflow list",
  "gh release view v1",
  "gh gist list",
  "gh label list",
  "gh cache list",
  "gh ruleset check main",
  "gh project item-list 1",
  "gh variable list",
  "gh org list",
  "gh search prs foo",
  "gh config get git_protocol",
  "gh status",
  "gh --version",
  "gh help pr",
];
for (const command of GH_READ_ONLY) {
  test(`allows the read-only ${JSON.stringify(command)}`, () => {
    assert.equal(evaluate(command, fakeContext()), null);
  });
}

const GH_WRITES = [
  "gh pr update-branch 1",
  "gh pr revert 1",
  "gh pr close 1",
  "gh pr reopen 1",
  "gh pr lock 1",
  "gh pr edit 1 --title x",
  "gh pr ready 1",
  "gh pr comment 1 --body hi",
  "gh pr review 1 --comment",
  "gh issue create",
  "gh issue comment 1 --body hi",
  "gh issue develop 1 --name x",
  "gh run rerun 1",
  "gh run cancel 1",
  "gh codespace list",
  "gh codespace ssh",
  "gh repo clone o/r",
  "gh repo fork o/r",
  "gh release upload v1 f",
  "gh gist clone 1",
  "gh label create x",
  "gh cache delete 1",
  "gh project edit 1",
  "gh browse",
  "gh frobnicate now",
  "gh config list-all",
];
for (const command of GH_WRITES) {
  test(`blocks the gh write ${JSON.stringify(command)}`, () => {
    assert.match(evaluate(command, fakeContext()) ?? "", /gh .* is blocked/);
  });
}

const GH_FLAG_SHIFT_BLOCKED = [
  "gh pr --title view create",
  "gh repo --description view new x --source . --push",
  "gh release --title view new v1",
  "gh pr --body view revert 1",
  "gh pr --json view merge 1",
  "gh --title co pr create",
  "gh --description co repo new x --push",
  "gh --title status pr merge 1",
  "gh --title api pr merge 1",
];
for (const command of GH_FLAG_SHIFT_BLOCKED) {
  test(`blocks a flag before the action in ${JSON.stringify(command)}`, () => {
    assert.match(evaluate(command, fakeContext()) ?? "", /gh .* is blocked/);
  });
}

const GH_API_LONG_BLOCKED = [
  "gh api repos/o/r/merges --preview -XGET -f base=main -f head=feat",
  "gh api repos/o/r --jq -XGET -f a=b",
  "gh api repos/o/r --template -XGET -f a=b",
  "gh api repos/o/r --header -XGET -f a=b",
  "gh api repos/o/r --frobnicate",
  "gh api repos/o/r --paginate=x",
  "gh api graphql --jq .x -f query=mutation{x}",
];
for (const command of GH_API_LONG_BLOCKED) {
  test(`blocks ${JSON.stringify(command)}`, () => {
    assert.match(evaluate(command, fakeContext()) ?? "", OWNER);
  });
}

// Redirect names are blocked wherever they appear, in both branch policies.
const REDIRECT_NAMES = ["HOME", "XDG_CONFIG_HOME", "BASH_ENV", "ENV", "ZDOTDIR", "GH_CONFIG_DIR"];
const REDIRECT_BLOCKED: string[] = [
  ...REDIRECT_NAMES.map((n) => `for ${n} in /p; do git status; done`),
  ...REDIRECT_NAMES.map((n) => `(( ${n} = 0 ))`),
  ...REDIRECT_NAMES.map((n) => `let '${n} = 0'`),
  ...REDIRECT_NAMES.map((n) => `getopts a ${n} -a`),
  ...REDIRECT_NAMES.map((n) => `${n}[0]=/p`),
  ...REDIRECT_NAMES.map((n) => `${n}[1,-1]=/p`),
  ...REDIRECT_NAMES.map((n) => `: \${${n}::=/p}`),
  ...REDIRECT_NAMES.map((n) => `: \${${n}:=/p}`),
  ...REDIRECT_NAMES.map((n) => `print -v ${n} /p`),
  "X=HOME; export $X=/p",
  'X=HOME; export "$X=/p"',
  'X=HOME; printf -v "$X" /p',
  'X=HOME; read -r "$X" <<< /p',
  "X=HOME; : ${(P)X::=/p}",
  "declare -n R=HOME; R=/p",
  'export "$X=/p"',
  'printf -v "$X" /p',
  'read -r "$X" <<< /p',
  "read $X",
  "typeset -x $X=/p",
  "export${IFS}HOME=/p",
  "export${IFS}$X=/p",
  "getopts a $X -a",
  "env -i git push",
  "env - git push",
  "env --ignore-environment git push",
  "env -iu X git status",
  "exec -c git push",
  "exec -cl git push",
  "exec -a x -c git push",
  "sudo env -i git status",
  'echo "HOME=$HOME"',
  "cat ${HOME::=/p}; git status",
  "ls $[HOME=0]",
  "ls ${a[HOME=0]}",
  "cat ${PWD:HOME=0}",
  "printenv ${HOME::=/p}",
  "cat <<< ${HOME::=/p}",
  "git log ${HOME::=/p}",
  "head -n $[HOME=0] f",
  "X=HO; Y=ME; declare -n R=$X$Y; R=/p",
  'let "$X$Y=0"',
  "let n=$X",
  ": $[ $X$Y = 0 ]",
  ": ${(P)${:-$X$Y}::=/p}",
  "ls ${(P)X::=/p}",
  "typeset -n R=$X$Y",
  "local -n R=${X}",
];
const REDIRECT_ALLOWED: string[] = [
  "env",
  "printenv",
  "printenv HOME",
  "env | sort",
  "echo $HOME",
  "echo ${HOME}",
  "echo ${HOME:-x}",
  "ls $HOME/.config",
  'export PATH="$HOME/bin:$PATH"',
  "read -r line < file",
  'while read -r l; do echo "$l"; done < f',
  "pnpm env use 22",
  "pnpm env use --global 22",
  "pnpm test -- --env=node",
  "NODE_ENV=test pnpm test",
  "gh pr view 3",
  "rg -n 'HOME=' src",
  "grep -rn 'read HOME' .",
  "echo already read home",
  "env -u FOO git status",
  "env FOO=1 git status",
  "rg x $HOME/src",
  'ls "$HOME"',
  "printenv | grep GH_",
  "declare -n R=OTHER",
  "declare -x A=$B",
];
test("a runtime-built name in (( )) keeps blocking and legacy $[ ] arithmetic blocks", () => {
  for (const command of ["(( $X$Y = 0 ))", "echo $[1+1]"]) {
    assert.notEqual(evaluate(command, fakeContext()), null, command);
  }
});

for (const policy of ["main-only", "feature-branches"] as const) {
  for (const command of REDIRECT_BLOCKED) {
    test(`blocks ${JSON.stringify(command)} in ${policy}`, () => {
      assert.match(evaluate(command, fakeContext(), policy) ?? "", /environment variable|variable name built at runtime|clear the environment/);
    });
  }
  for (const command of REDIRECT_ALLOWED) {
    test(`allows ${JSON.stringify(command)} in ${policy}`, () => {
      assert.equal(evaluate(command, fakeContext({ scripts: { ...DEFAULT_SCRIPTS, test: "vitest run" } }), policy), null);
    });
  }
}

const GH_FILE_WRITER_COMMANDS = [
  "gh co 3",
  "gh co -f 3",
  "gh co 3 --repo o/r",
  "gh co -R o/r 3",
  "gh -R o/r co 3",
  "gh pr checkout 3",
  "gh run download 123",
  "gh run download 123 -n report",
  "gh run download -D x 123",
  "gh release download v1",
  "gh release download v1 -p '*.tgz'",
];
const GH_STILL_READ = ["gh pr view 3", "gh run view 123 --log", "gh run list", "gh release view v1", "gh pr checks 3"];
for (const policy of ["main-only", "feature-branches"] as const) {
  for (const command of GH_FILE_WRITER_COMMANDS) {
    test(`blocks the file-writing ${JSON.stringify(command)} in ${policy}`, () => {
      assert.match(evaluate(command, fakeContext(), policy) ?? "", /writes files into the working tree/);
    });
  }
  for (const command of GH_STILL_READ) {
    test(`still allows ${JSON.stringify(command)} in ${policy}`, () => {
      assert.equal(evaluate(command, fakeContext(), policy), null);
    });
  }
}

// The branch policy: main-only is the default, feature-branches is dormant.
interface PolicyCase {
  command: string;
  options?: CtxOptions;
}

const FEATURE_ALLOWED: PolicyCase[] = [
  { command: "git push -u origin feat/x" },
  { command: "git push origin feat/x" },
  { command: "git push --dry-run origin feat/x" },
  { command: "git push origin HEAD:feat/x" },
  { command: "git push -u origin HEAD" },
  { command: "git push --force-with-lease --force-if-includes origin feat/x" },
  { command: "gh pr create --head feat/x --fill" },
  { command: "gh pr new --head feat/x" },
  { command: "gh pr create --head=feat/x --fill" },
  { command: "gh pr create -H feat/x --fill" },
  { command: "gh pr edit 1 --title x" },
  { command: "gh pr ready 1" },
  { command: "gh pr comment 1 --body hi" },
  { command: "gh pr view 1" },
];

const FEATURE_BLOCKED: PolicyCase[] = [
  { command: "gh pr create --fill" },
  { command: "gh pr new --fill" },
  { command: "gh pr create --head main --fill" },
  { command: "gh pr create --head feat/x --head feat/y" },
  { command: "gh pr create --head owner:feat/x" },
  { command: "gh pr create -R o/r --head feat/x" },
  { command: "gh pr create --repo o/r --head feat/x" },
  { command: "gh pr create --repo=o/r --head feat/x" },
  { command: "gh pr edit 1 -R o/r --title x" },
  { command: "git push --force-with-lease=v1:abc --force-if-includes origin HEAD:v1" },
  { command: "git push --force-with-lease=feat/x --force-if-includes origin feat/x" },
  { command: "git push --force-with-lease origin feat/x" },
  { command: "git push --force-if-includes origin feat/x" },
  { command: "git push origin main" },
  { command: "git push origin master" },
  { command: "git push origin HEAD:main" },
  { command: "git push -u origin HEAD", options: { branch: "main" } },
  { command: "git push -u origin HEAD", options: { branch: null } },
  { command: "git push --force origin feat/x" },
  { command: "git push -f origin feat/x" },
  { command: "git push --force origin feat/x" },
  { command: "git push -fu origin feat/x" },
  { command: "git push --force-with-lease origin main" },
  { command: "git push --force-with-lease --force-if-includes origin HEAD:main" },
  { command: "git push --force-with-lease --force-if-includes origin +feat/x" },
  { command: "git push --force-with-lease --force-if-includes --tags" },
  { command: "git push --force-with-lease --delete origin feat/x" },
  { command: "git push --force-with-lease --mirror" },
  { command: "git push origin +feat/x" },
  { command: "git push --tags" },
  { command: "git push origin refs/tags/x" },
  { command: "git push origin v1", options: { tags: ["v1"] } },
  { command: "git push --delete origin feat/x" },
  { command: "git push origin :feat/x" },
  { command: "git push --mirror" },
  { command: "git push --all" },
  { command: "git push" },
  { command: "git push --no-verify origin feat/x" },
  { command: "git tag v9 && git push origin feat/x" },
  { command: "gh pr merge 1 --squash" },
  { command: "gh pr close 1" },
  { command: "gh pr update-branch 1" },
  { command: "gh pr revert 1" },
  { command: "gh pr review 1 --approve" },
  { command: "gh release create v1" },
  { command: "gh release new v1" },
  { command: "gh repo create x --public" },
  { command: "gh repo new x --public" },
  { command: "gh issue create" },
  { command: "gh api -X PUT repos/o/r/pulls/1/merge" },
];

for (const { command, options } of FEATURE_ALLOWED) {
  test(`feature-branches allows ${JSON.stringify(command)}`, () => {
    assert.equal(evaluate(command, fakeContext(options), "feature-branches"), null);
  });
}

for (const { command, options } of FEATURE_BLOCKED) {
  test(`feature-branches blocks ${JSON.stringify(command)}`, () => {
    assert.notEqual(evaluate(command, fakeContext(options), "feature-branches"), null);
  });
}

test("main-only blocks every command the feature-branches table allows, except reads", () => {
  for (const { command, options } of FEATURE_ALLOWED) {
    if (command === "gh pr view 1") continue;
    const reason = evaluate(command, fakeContext(options), "main-only") ?? "";
    assert.notEqual(reason, "", command);
  }
  assert.match(evaluate("git push -u origin feat/x", fakeContext(), "main-only") ?? "", PUSH);
  assert.match(evaluate("gh pr create --fill", fakeContext(), "main-only") ?? "", PUSH);
});

test("the default policy is main-only", () => {
  assert.match(evaluate("git push -u origin feat/x", fakeContext()) ?? "", PUSH);
});

test("a plain force in feature-branches mode points to the lease flags", () => {
  for (const command of ["git push --force origin feat/x", "git push origin +feat/x"]) {
    const reason = evaluate(command, fakeContext(), "feature-branches") ?? "";
    assert.match(reason, /--force-with-lease --force-if-includes/, command);
  }
});

test("main-only blocks lease force pushes", () => {
  const reason = evaluate("git push --force-with-lease --force-if-includes origin feat/x", fakeContext());
  assert.match(reason ?? "", PUSH);
});

test("the feature-branches message does not claim agents never push", () => {
  const reason = evaluate("git push origin main", fakeContext(), "feature-branches") ?? "";
  assert.doesNotMatch(reason, /Agents never push/);
  assert.match(reason, /named feature branch/);
});

// main, through the real process.

const projectRoot = path.dirname(path.dirname(path.dirname(script)));

function runHook(input: string): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectRoot };
  const result = spawnSync(process.execPath, [script], { input, encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function hookInput(toolName: string, toolInput: unknown): string {
  return JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: projectRoot });
}

test("main lets an allowed Bash command through silently", () => {
  const result = runHook(hookInput("Bash", { command: "rg -n TODO src" }));
  assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
});

test("main blocks wrangler deploy from Bash with exit 2", () => {
  const { status, stderr } = runHook(hookInput("Bash", { command: "wrangler deploy" }));
  assert.equal(status, 2);
  assert.match(stderr, /^BLOCKED:/);
});

test("main blocks wrangler deploy from Monitor with exit 2", () => {
  assert.equal(runHook(hookInput("Monitor", { command: "wrangler deploy" })).status, 2);
});

test("main blocks wrangler deploy from PowerShell with exit 2", () => {
  assert.equal(runHook(hookInput("PowerShell", { command: "wrangler deploy" })).status, 2);
});

test("main ignores a tool without a command", () => {
  assert.equal(runHook(JSON.stringify({ tool_name: "Read" })).status, 0);
});

test("main fails closed on unreadable input", () => {
  const { status, stderr } = runHook("not json");
  assert.equal(status, 2);
  assert.match(stderr, /unreadable hook input/);
});

test("main blocks Codex danger-full-access", () => {
  const result = runHook(hookInput("mcp__codex__codex", { sandbox: "danger-full-access" }));
  assert.equal(result.status, 2);
});

test("main allows Codex workspace-write in the project", () => {
  const input = hookInput("mcp__codex__codex", { sandbox: "workspace-write", cwd: projectRoot });
  assert.equal(runHook(input).status, 0);
});

test("main blocks a Codex session outside the project", () => {
  const input = hookInput("mcp__codex__codex", { sandbox: "workspace-write", cwd: path.dirname(projectRoot) });
  assert.equal(runHook(input).status, 2);
});

test("main blocks accepting a Codex request", () => {
  const result = runHook(hookInput("mcp__codex__codex-interaction-resolve", { decision: "accept" }));
  assert.equal(result.status, 2);
});

test("main allows declining a Codex request", () => {
  const result = runHook(hookInput("mcp__codex__codex-interaction-resolve", { decision: "decline" }));
  assert.equal(result.status, 0);
});

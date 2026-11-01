// Keeps the agent instructions small and wired (AGENTS.md, "Who does what").
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Codex silently truncates the AGENTS.md chain at 32 KiB; this leaves room for the user's global file.
const AGENTS_MAX_BYTES = 12288;
const CLAUDE_MAX_BYTES = 1024;
const RULE_MAX_BYTES = 6144;

export interface BudgetResult {
  errors: string[];
  summary: string;
}

/** The lines between the first two `---` lines, or null when there is no frontmatter. */
function frontmatter(text: string): string[] | null {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  return end === -1 ? null : lines.slice(1, end);
}

function pathsEntries(front: string[]): string[] | null {
  const index = front.findIndex((line) => /^paths:/.test(line));
  if (index === -1) return null;
  const inline = front[index].replace(/^paths:\s*/, "").trim();
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
      .filter((entry) => entry !== "");
  }
  const entries: string[] = [];
  for (const line of front.slice(index + 1)) {
    const match = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (!match) break;
    entries.push(match[1].replace(/^["']|["']$/g, ""));
  }
  return entries;
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => path.join(dir, name));
}

interface HookEntry {
  matcher?: unknown;
  hooks?: unknown;
}

// Every tool the guards must cover, and the script that guards it.
const REQUIRED_HOOKS: [tool: string, script: string][] = [
  ["Bash", "guard-commands.ts"],
  ["Monitor", "guard-commands.ts"],
  ["PowerShell", "guard-commands.ts"],
  ["mcp__codex__codex", "guard-commands.ts"],
  ["Agent", "enforce-subagent-model.sh"],
];

const REQUIRED_ASK = [
  "Edit(/.claude/settings.json)",
  "Edit(/.claude/settings.local.json)",
  "Edit(/.claude/hooks/**)",
  "Edit(/.codex/**)",
  "Edit(/.git/config)",
  "Edit(/.git/hooks/**)",
  "Edit(/.git/**)",
  "Edit(~/.config/git/**)",
  "Edit(~/.gitconfig)",
  "Edit(/.claude/agents/**)",
  "Edit(/.claude/rules/**)",
  "Edit(/.github/workflows/**)",
];
// Credential directories and files that sandboxed commands must not read.
const CREDENTIAL_PATHS = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.config/gh",
  "~/.npmrc",
  "~/.docker",
  "~/.config/.wrangler",
  "~/.claude/.credentials.json",
  "~/.codex/auth.json",
  "~/.local/share/opencode/auth.json",
  "~/.kube",
  "~/.config/rclone",
  "~/.local/share/keyrings",
  "~/.config/op",
];
// These are single files; the others are directories.
const CREDENTIAL_FILES = new Set(["~/.npmrc", "~/.claude/.credentials.json", "~/.codex/auth.json", "~/.local/share/opencode/auth.json"]);
const credentialRule = (p: string) => (CREDENTIAL_FILES.has(p) ? `Read(${p})` : `Read(${p}/**)`);
// Loopback and unspecified hosts stay denied, so no allow entry or per-command list can reopen them.
const REQUIRED_DENIED_DOMAINS = ["localhost", "*.localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"];

// emend's state directory holds client diffs: the Linux and the macOS default.
const REQUIRED_DENY_READ = [
  ".env",
  ".env.local",
  "~/.local/share/emend",
  "~/Library/Application Support/emend",
  ...CREDENTIAL_PATHS,
];
const REQUIRED_DENY_WRITE = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks",
  ".codex",
  ".git/config",
  ".git/hooks",
  ".git",
];
const REQUIRED_DENY = [
  "Read(/.env)",
  "Read(/**/.env)",
  "Read(/**/.env.*)",
  "Read(~/.local/share/emend/**)",
  "Read(~/Library/Application Support/emend/**)",
  ...CREDENTIAL_PATHS.map(credentialRule),
];

function matcherCovers(matcher: unknown, tool: string): boolean {
  if (typeof matcher !== "string") return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
}

// Reduces an allowedDomains entry or a WebFetch domain to a bare host: lowercase, no port,
// brackets or trailing dot.
function normalizeHost(entry: string): string {
  let host = entry.trim().toLowerCase();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(host);
  if (bracketed) host = bracketed[1];
  else if (host.split(":").length === 2) host = host.split(":")[0];
  return host.replace(/\.+$/, "");
}

// Why an allowed host would reach local services or every host, or null when it is fine.
function unsafeHost(entry: string): string | null {
  const host = normalizeHost(entry);
  if (host === "*") return "a wildcard for every host";
  if (host === "localhost" || host.endsWith(".localhost")) return "a localhost name";
  if (isIP(host) !== 0 || /^(0x[0-9a-f]+|\d+)$/.test(host)) return "an IP address";
  return null;
}

// The only sandbox keys the settings may carry. Any other key, at any depth, can weaken the sandbox
// (proxy ports, excluded commands, sockets, extra write paths, weaker isolation), so it is refused.
const ALLOWED_SANDBOX_KEYS = new Set([
  "enabled",
  "failIfUnavailable",
  "allowUnsandboxedCommands",
  "network",
  "network.allowedDomains",
  "network.deniedDomains",
  "network.allowLocalBinding",
  "filesystem",
  "filesystem.denyRead",
  "filesystem.denyWrite",
]);

function unknownSandboxKeys(node: unknown, prefix: string, found: string[]): string[] {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return found;
  for (const [key, value] of Object.entries(node)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (!ALLOWED_SANDBOX_KEYS.has(dotted)) found.push(`sandbox.${dotted}`);
    else unknownSandboxKeys(value, dotted, found);
  }
  return found;
}

// This repo's settings carry no env block.
const ALLOWED_ENV_KEYS = new Set<string>();

// Checks that apply to .claude/settings.json and to .claude/settings.local.json alike: nothing there
// may widen the sandbox, the writable paths or the network.
function refusedSettings(
  settings: { sandbox?: unknown; env?: unknown; permissions?: { allow?: unknown; additionalDirectories?: unknown } },
  label: string,
): string[] {
  const errors: string[] = [];
  for (const key of unknownSandboxKeys(settings.sandbox, "", [])) {
    errors.push(`${label} sets ${key}, which is not an allowed sandbox key`);
  }
  const sandbox = (typeof settings.sandbox === "object" && settings.sandbox !== null ? settings.sandbox : {}) as {
    network?: { allowedDomains?: unknown };
  };
  if (settings.permissions && "additionalDirectories" in settings.permissions) {
    // It can add sandbox-writable paths.
    errors.push(`${label} sets permissions.additionalDirectories, which can widen what the sandbox may write`);
  }
  if (typeof settings.env === "object" && settings.env !== null) {
    for (const key of Object.keys(settings.env)) {
      if (!ALLOWED_ENV_KEYS.has(key)) errors.push(`${label} sets env.${key}, which is not an allowed env key`);
    }
  }
  const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  for (const rule of allow) {
    // allowWrite merges with Edit() allow rules, and a bare WebFetch (also WebFetch() and WebFetch(*))
    // opens every domain.
    if (typeof rule === "string" && (/^(Edit|MultiEdit|Write|NotebookEdit)(\(|$)/.test(rule) || /^WebFetch(\(\*?\))?$/.test(rule))) {
      errors.push(`${label} allows ${JSON.stringify(rule)}, which widens writes or the network`);
    }
  }
  const webFetchDomains = allow
    .map((rule) => (typeof rule === "string" ? /^WebFetch\(domain:(.*)\)$/.exec(rule)?.[1] : undefined))
    .filter((domain): domain is string => domain !== undefined);
  const domains = Array.isArray(sandbox.network?.allowedDomains) ? sandbox.network.allowedDomains : [];
  for (const domain of [...domains, ...webFetchDomains]) {
    const reason = typeof domain === "string" ? unsafeHost(domain) : null;
    if (reason) {
      errors.push(`${label} allows the network entry ${JSON.stringify(domain)}, which is ${reason}`);
    }
  }
  return errors;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkSettings(root: string): string[] {
  const file = path.join(root, ".claude", "settings.json");
  if (!existsSync(file)) return [".claude/settings.json is missing"];
  let settings: {
    sandbox?: {
      enabled?: unknown;
      allowUnsandboxedCommands?: unknown;
      network?: { allowedDomains?: unknown; deniedDomains?: unknown };
      filesystem?: { denyRead?: unknown; denyWrite?: unknown };
    };
    permissions?: { allow?: unknown; ask?: unknown; deny?: unknown };
    hooks?: { PreToolUse?: HookEntry[] };
  };
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
    if (!isPlainObject(settings)) return [".claude/settings.json must be a JSON object"];
  } catch (error) {
    return [`.claude/settings.json is not valid JSON (${(error as Error).message})`];
  }
  const errors: string[] = [];
  if (settings.sandbox?.enabled !== true) {
    errors.push(".claude/settings.json needs sandbox.enabled set to true");
  }
  if (settings.sandbox?.allowUnsandboxedCommands !== false) {
    errors.push(".claude/settings.json needs sandbox.allowUnsandboxedCommands set to false");
  }
  const domains = settings.sandbox?.network?.allowedDomains;
  if (!Array.isArray(domains)) {
    errors.push(".claude/settings.json needs sandbox.network.allowedDomains");
  } else {
    for (const domain of domains) {
      if (typeof domain !== "string" || /cloudflare|workers\.dev/i.test(domain)) {
        errors.push(`.claude/settings.json allows the network domain ${JSON.stringify(domain)}; Cloudflare must stay unreachable`);
      }
    }
  }
  errors.push(...refusedSettings(settings, ".claude/settings.json"));
  const denied = settings.sandbox?.network?.deniedDomains;
  for (const domain of REQUIRED_DENIED_DOMAINS) {
    if (!Array.isArray(denied) || !denied.includes(domain)) {
      errors.push(`.claude/settings.json needs sandbox.network.deniedDomains to include ${domain}`);
    }
  }
  for (const [key, required] of [
    ["denyRead", REQUIRED_DENY_READ],
    ["denyWrite", REQUIRED_DENY_WRITE],
  ] as const) {
    const list = settings.sandbox?.filesystem?.[key];
    for (const path of required) {
      if (!Array.isArray(list) || !list.includes(path)) {
        errors.push(`.claude/settings.json needs sandbox.filesystem.${key} to include ${path}`);
      }
    }
  }
  for (const rule of REQUIRED_ASK) {
    if (!Array.isArray(settings.permissions?.ask) || !settings.permissions.ask.includes(rule)) {
      errors.push(`.claude/settings.json needs the permissions.ask rule ${rule}`);
    }
  }
  for (const rule of REQUIRED_DENY) {
    if (!Array.isArray(settings.permissions?.deny) || !settings.permissions.deny.includes(rule)) {
      errors.push(`.claude/settings.json needs the permissions.deny rule ${rule}`);
    }
  }
  const entries = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  for (const entry of entries) {
    const hooks = Array.isArray(entry.hooks) ? (entry.hooks as { onFailure?: unknown }[]) : [];
    if (hooks.some((hook) => hook?.onFailure !== "block")) {
      errors.push(`.claude/settings.json needs onFailure "block" on every hook of matcher ${JSON.stringify(entry.matcher)}`);
    }
  }
  for (const [tool, script] of REQUIRED_HOOKS) {
    const covered = entries.some((entry) => {
      if (!matcherCovers(entry.matcher, tool) || !Array.isArray(entry.hooks)) return false;
      return entry.hooks.some(
        (hook: { command?: unknown }) => typeof hook?.command === "string" && hook.command.includes(script),
      );
    });
    if (!covered) {
      errors.push(`.claude/settings.json needs a PreToolUse hook for ${tool} that runs ${script}`);
    }
  }
  const localFile = path.join(root, ".claude", "settings.local.json");
  if (existsSync(localFile)) {
    const label = ".claude/settings.local.json";
    try {
      const local = JSON.parse(readFileSync(localFile, "utf8"));
      if (!isPlainObject(local)) throw new TypeError("must be a JSON object");
      errors.push(...refusedSettings(local, label));
      if (local.sandbox?.enabled !== undefined && local.sandbox.enabled !== true) {
        errors.push(`${label} must not change sandbox.enabled from true`);
      }
      if (local.sandbox?.allowUnsandboxedCommands !== undefined && local.sandbox.allowUnsandboxedCommands !== false) {
        errors.push(`${label} must not change sandbox.allowUnsandboxedCommands from false`);
      }
    } catch (error) {
      errors.push(
        error instanceof TypeError ? `${label} must be a JSON object` : `${label} is not valid JSON (${(error as Error).message})`,
      );
    }
  }
  return errors;
}

export function checkBudget(root: string): BudgetResult {
  const errors: string[] = [];

  const agentsPath = path.join(root, "AGENTS.md");
  let agentsText = "";
  let agentsBytes = 0;
  if (!existsSync(agentsPath)) {
    errors.push("AGENTS.md is missing");
  } else {
    agentsBytes = statSync(agentsPath).size;
    agentsText = readFileSync(agentsPath, "utf8");
    if (agentsBytes > AGENTS_MAX_BYTES) {
      errors.push(`AGENTS.md is ${agentsBytes} bytes; the limit is ${AGENTS_MAX_BYTES}`);
    }
  }

  const claudePath = path.join(root, "CLAUDE.md");
  if (!existsSync(claudePath)) {
    errors.push("CLAUDE.md is missing");
  } else {
    const claudeBytes = statSync(claudePath).size;
    if (claudeBytes > CLAUDE_MAX_BYTES) {
      errors.push(`CLAUDE.md is ${claudeBytes} bytes; the limit is ${CLAUDE_MAX_BYTES}`);
    }
    if (!readFileSync(claudePath, "utf8").split(/\r?\n/).includes("@AGENTS.md")) {
      errors.push("CLAUDE.md must contain a line that is exactly @AGENTS.md");
    }
  }

  const rules = markdownFiles(path.join(root, ".claude", "rules"));
  for (const file of rules) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const bytes = statSync(file).size;
    if (bytes > RULE_MAX_BYTES) {
      errors.push(`${rel} is ${bytes} bytes; the limit is ${RULE_MAX_BYTES}`);
    }
    const front = frontmatter(readFileSync(file, "utf8"));
    const entries = front === null ? null : pathsEntries(front);
    if (entries === null) {
      errors.push(`${rel} needs frontmatter with a paths: key`);
    } else if (entries.length === 0) {
      errors.push(`${rel} has an empty paths: list`);
    }
    if (!agentsText.includes(rel)) {
      errors.push(`${rel} is not named in AGENTS.md, so Codex is never pointed to it`);
    }
  }

  const agents = markdownFiles(path.join(root, ".claude", "agents"));
  for (const file of agents) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const front = frontmatter(readFileSync(file, "utf8"));
    const modelLine = front?.find((line) => /^model:/.test(line));
    const model = modelLine?.replace(/^model:\s*/, "").replace(/["']/g, "").trim();
    if (!model || model === "inherit") {
      errors.push(`${rel} needs a pinned model: in its frontmatter (not inherit)`);
    }
    const nameLine = front?.find((line) => /^name:/.test(line));
    const agentName = nameLine?.replace(/^name:\s*/, "").replace(/["']/g, "").trim();
    const fileName = path.basename(file, ".md");
    if (agentName !== fileName) {
      errors.push(`${rel} needs name: ${fileName} in its frontmatter, so the model pin finds it`);
    }
  }

  errors.push(...checkSettings(root));

  const summary = `check:budget ok: AGENTS.md ${agentsBytes}/${AGENTS_MAX_BYTES} bytes, ${rules.length} rules, ${agents.length} agents`;
  return { errors, summary };
}

function main(): void {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const { errors, summary } = checkBudget(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(summary);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

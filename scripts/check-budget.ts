// Keeps the agent instructions small and wired (AGENTS.md, "Who does what").
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  "Edit(~/.config/git/**)",
  "Edit(~/.gitconfig)",
  "Edit(/.claude/agents/**)",
  "Edit(/.claude/rules/**)",
  "Edit(/.github/workflows/**)",
];
// emend's state directory holds client diffs: the Linux and the macOS default.
const REQUIRED_DENY_READ = [".env", ".env.local", "~/.local/share/emend", "~/Library/Application Support/emend"];
const REQUIRED_DENY_WRITE = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks",
  ".codex",
  ".git/config",
  ".git/hooks",
];
const REQUIRED_DENY = [
  "Read(/.env)",
  "Read(/**/.env)",
  "Read(/**/.env.*)",
  "Read(~/.local/share/emend/**)",
  "Read(~/Library/Application Support/emend/**)",
];

function matcherCovers(matcher: unknown, tool: string): boolean {
  if (typeof matcher !== "string") return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
}

function checkSettings(root: string): string[] {
  const file = path.join(root, ".claude", "settings.json");
  if (!existsSync(file)) return [".claude/settings.json is missing"];
  let settings: {
    sandbox?: {
      enabled?: unknown;
      allowUnsandboxedCommands?: unknown;
      network?: { allowedDomains?: unknown };
      filesystem?: { denyRead?: unknown; denyWrite?: unknown };
    };
    permissions?: { ask?: unknown; deny?: unknown };
    hooks?: { PreToolUse?: HookEntry[] };
  };
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
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

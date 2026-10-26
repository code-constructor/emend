import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkBudget } from "./check-budget.ts";

const temps: string[] = [];

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

interface TreeOptions {
  agents?: string;
  claude?: string;
  rule?: string;
  settings?: string | null;
}

const VALID_SETTINGS = JSON.stringify({
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: ["registry.npmjs.org", "github.com", "localhost"] },
    filesystem: {
      denyRead: [".env", ".env.local", "~/.local/share/emend", "~/Library/Application Support/emend"],
      denyWrite: [
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".claude/hooks",
        ".codex",
        ".git/config",
        ".git/hooks",
      ],
    },
  },
  permissions: {
    ask: [
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
    ],
    deny: [
      "Read(/.env)",
      "Read(/**/.env)",
      "Read(/**/.env.*)",
      "Read(~/.local/share/emend/**)",
      "Read(~/Library/Application Support/emend/**)",
    ],
  },
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash|Monitor|PowerShell",
        hooks: [{ type: "command", command: "node guard-commands.ts", onFailure: "block" }],
      },
      {
        matcher: "mcp__codex__.*",
        hooks: [{ type: "command", command: "node guard-commands.ts", onFailure: "block" }],
      },
      {
        matcher: "Agent|Task",
        hooks: [{ type: "command", command: "bash enforce-subagent-model.sh", onFailure: "block" }],
      },
    ],
  },
});

const VALID_RULE = '---\npaths:\n  - "cli/**"\n---\n\n# Rule\n';

function makeTree(options: TreeOptions = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "budget-"));
  temps.push(root);
  mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
  mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(
    path.join(root, "AGENTS.md"),
    options.agents ?? "# Rules\n\nRead `.claude/rules/cli.md` first.\n",
  );
  writeFileSync(path.join(root, "CLAUDE.md"), options.claude ?? "@AGENTS.md\n");
  writeFileSync(path.join(root, ".claude", "rules", "cli.md"), options.rule ?? VALID_RULE);
  writeFileSync(
    path.join(root, ".claude", "agents", "worker.md"),
    "---\nname: worker\nmodel: sonnet\n---\n\nBody.\n",
  );
  if (options.settings !== null) {
    writeFileSync(path.join(root, ".claude", "settings.json"), options.settings ?? VALID_SETTINGS);
  }
  return root;
}

test("a valid tree passes", () => {
  const { errors, summary } = checkBudget(makeTree());
  assert.deepEqual(errors, []);
  assert.match(summary, /^check:budget ok: AGENTS\.md \d+\/12288 bytes, 1 rules, 1 agents$/);
});

test("an AGENTS.md over the limit fails", () => {
  const body = "# Rules\n`.claude/rules/cli.md`\n";
  const { errors } = checkBudget(makeTree({ agents: body + "x".repeat(12289 - body.length) }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /AGENTS\.md is 12289 bytes/);
});

test("an AGENTS.md of exactly the limit passes", () => {
  const body = "# Rules\n`.claude/rules/cli.md`\n";
  const { errors } = checkBudget(makeTree({ agents: body + "x".repeat(12288 - body.length) }));
  assert.deepEqual(errors, []);
});

test("a CLAUDE.md without the import fails", () => {
  const { errors } = checkBudget(makeTree({ claude: "Read AGENTS.md\n" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /@AGENTS\.md/);
});

test("a rule without paths fails", () => {
  const { errors } = checkBudget(makeTree({ rule: "---\nname: x\n---\n\n# Rule\n" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cli\.md needs frontmatter with a paths: key/);
});

test("a rule with an empty paths list fails", () => {
  const { errors } = checkBudget(makeTree({ rule: "---\npaths: []\n---\n\n# Rule\n" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /empty paths/);
});

test("a rule not named in AGENTS.md fails", () => {
  const { errors } = checkBudget(makeTree({ agents: "# Rules\n" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not named in AGENTS\.md/);
});

test("an agent with model inherit fails", () => {
  const root = makeTree();
  writeFileSync(
    path.join(root, ".claude", "agents", "worker.md"),
    "---\nname: worker\nmodel: inherit\n---\n\nBody.\n",
  );
  const { errors } = checkBudget(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /worker\.md needs a pinned model/);
});

test("an agent without a model fails", () => {
  const root = makeTree();
  writeFileSync(path.join(root, ".claude", "agents", "worker.md"), "---\nname: worker\n---\n");
  assert.equal(checkBudget(root).errors.length, 1);
});

test("an inline paths list passes", () => {
  const { errors } = checkBudget(makeTree({ rule: '---\npaths: ["cli/**", "x/**"]\n---\n\n# Rule\n' }));
  assert.deepEqual(errors, []);
});

test("a block paths list passes", () => {
  const { errors } = checkBudget(makeTree({ rule: "---\npaths:\n  - cli/**\n  - x/**\n---\n" }));
  assert.deepEqual(errors, []);
});

test("a missing AGENTS.md fails", () => {
  const root = makeTree();
  rmSync(path.join(root, "AGENTS.md"));
  assert.ok(checkBudget(root).errors.includes("AGENTS.md is missing"));
});

test("a missing CLAUDE.md fails", () => {
  const root = makeTree();
  rmSync(path.join(root, "CLAUDE.md"));
  assert.deepEqual(checkBudget(root).errors, ["CLAUDE.md is missing"]);
});

test("a CLAUDE.md over 1024 bytes fails", () => {
  const { errors } = checkBudget(makeTree({ claude: `@AGENTS.md\n${"x".repeat(1100)}\n` }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CLAUDE\.md is \d+ bytes/);
});

test("a rule over 6144 bytes fails", () => {
  const { errors } = checkBudget(makeTree({ rule: `${VALID_RULE}${"x".repeat(6200)}\n` }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cli\.md is \d+ bytes; the limit is 6144/);
});

test("a rule with unterminated frontmatter fails", () => {
  const { errors } = checkBudget(makeTree({ rule: '---\npaths:\n  - "cli/**"\n\n# Rule\n' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /needs frontmatter with a paths: key/);
});

test("an unindented block list passes", () => {
  const { errors } = checkBudget(makeTree({ rule: '---\npaths:\n- "cli/**"\n- "x/**"\n---\n' }));
  assert.deepEqual(errors, []);
});

test("an agent whose name differs from its file name fails", () => {
  const root = makeTree();
  writeFileSync(
    path.join(root, ".claude", "agents", "worker.md"),
    "---\nname: other\nmodel: sonnet\n---\n",
  );
  const { errors } = checkBudget(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /needs name: worker/);
});

test("missing settings.json fails", () => {
  assert.deepEqual(checkBudget(makeTree({ settings: null })).errors, [".claude/settings.json is missing"]);
});

test("settings.json that is not JSON fails", () => {
  const { errors } = checkBudget(makeTree({ settings: "{ nope" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not valid JSON/);
});

test("a missing hook matcher fails", () => {
  const settings = JSON.parse(VALID_SETTINGS);
  settings.hooks.PreToolUse[0].matcher = "Bash|PowerShell";
  const { errors } = checkBudget(makeTree({ settings: JSON.stringify(settings) }));
  assert.deepEqual(errors, [".claude/settings.json needs a PreToolUse hook for Monitor that runs guard-commands.ts"]);
});

test("a matcher is anchored to the whole tool name", () => {
  const settings = JSON.parse(VALID_SETTINGS);
  settings.hooks.PreToolUse[2].matcher = "SubAgent";
  const { errors } = checkBudget(makeTree({ settings: JSON.stringify(settings) }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /hook for Agent/);
});

test("a hook that runs the wrong script fails", () => {
  const settings = JSON.parse(VALID_SETTINGS);
  settings.hooks.PreToolUse[1].hooks[0].command = "node other.ts";
  const { errors } = checkBudget(makeTree({ settings: JSON.stringify(settings) }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /hook for mcp__codex__codex/);
});

function withSettings(change: (settings: Record<string, any>) => void): string[] {
  const settings = JSON.parse(VALID_SETTINGS);
  change(settings);
  return checkBudget(makeTree({ settings: JSON.stringify(settings) })).errors;
}

test("a disabled sandbox fails", () => {
  const errors = withSettings((s) => {
    s.sandbox.enabled = false;
  });
  assert.deepEqual(errors, [".claude/settings.json needs sandbox.enabled set to true"]);
});

test("a missing sandbox block fails", () => {
  const errors = withSettings((s) => {
    delete s.sandbox;
  });
  assert.equal(errors.length, 13);
});

test("a missing sandbox read denial fails", () => {
  const errors = withSettings((s) => {
    s.sandbox.filesystem.denyRead = [".env", ".env.local", "~/Library/Application Support/emend"];
  });
  assert.deepEqual(errors, [".claude/settings.json needs sandbox.filesystem.denyRead to include ~/.local/share/emend"]);
});

test("a missing sandbox write denial fails", () => {
  const errors = withSettings((s) => {
    delete s.sandbox.filesystem;
  });
  assert.equal(errors.length, 10);
  assert.ok(errors.some((e) => /denyWrite to include \.claude\/settings\.json/.test(e)));
});

test("an open escape hatch for unsandboxed commands fails", () => {
  const errors = withSettings((s) => {
    s.sandbox.allowUnsandboxedCommands = true;
  });
  assert.deepEqual(errors, [".claude/settings.json needs sandbox.allowUnsandboxedCommands set to false"]);
});

test("an allowed Cloudflare domain fails", () => {
  for (const domain of ["api.cloudflare.com", "*.workers.dev", "dash.CLOUDFLARE.com"]) {
    const errors = withSettings((s) => {
      s.sandbox.network.allowedDomains.push(domain);
    });
    assert.equal(errors.length, 1, domain);
    assert.match(errors[0], /Cloudflare must stay unreachable/);
  }
});

test("a missing permissions.ask rule fails", () => {
  const errors = withSettings((s) => {
    s.permissions.ask = s.permissions.ask.filter((rule: string) => rule !== "Edit(/.git/config)");
  });
  assert.deepEqual(errors, [".claude/settings.json needs the permissions.ask rule Edit(/.git/config)"]);
});

test("a missing permissions.deny rule fails", () => {
  const errors = withSettings((s) => {
    delete s.permissions.deny;
  });
  assert.equal(errors.length, 5);
  assert.match(errors[0], /permissions\.deny rule/);
});

test("a hook without onFailure block fails", () => {
  const errors = withSettings((s) => {
    delete s.hooks.PreToolUse[2].hooks[0].onFailure;
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /onFailure "block" on every hook of matcher "Agent\|Task"/);
});

test("the real repo passes", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(checkBudget(root).errors, []);
});

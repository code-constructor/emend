import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkBudget, classifyLocalSettings } from "./check-budget.ts";

const temps: string[] = [];

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

interface TreeOptions {
  agents?: string;
  claude?: string;
  rule?: string;
  settings?: string | null;
  localSettings?: string;
}

const VALID_SETTINGS = JSON.stringify({
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: ["registry.npmjs.org", "github.com"],
      deniedDomains: ["localhost", "*.localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"],
    },
    filesystem: {
      denyRead: [
        ".env",
        ".env.local",
        "~/.local/share/emend",
        "~/Library/Application Support/emend",
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
      ],
      denyWrite: [
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".claude/hooks",
        ".codex",
        ".git/config",
        ".git/hooks",
        ".git",
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
      "Edit(/.git/**)",
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
      "Read(~/.ssh/**)",
      "Read(~/.gnupg/**)",
      "Read(~/.aws/**)",
      "Read(~/.config/gh/**)",
      "Read(~/.npmrc)",
      "Read(~/.docker/**)",
      "Read(~/.config/.wrangler/**)",
      "Read(~/.claude/.credentials.json)",
      "Read(~/.codex/auth.json)",
      "Read(~/.local/share/opencode/auth.json)",
      "Read(~/.kube/**)",
      "Read(~/.config/rclone/**)",
      "Read(~/.local/share/keyrings/**)",
      "Read(~/.config/op/**)",
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
  if (options.localSettings !== undefined) {
    writeFileSync(path.join(root, ".claude", "settings.local.json"), options.localSettings);
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
  assert.equal(errors.length, 34);
});

test("a missing sandbox read denial fails", () => {
  const errors = withSettings((s) => {
    s.sandbox.filesystem.denyRead = [
      ".env",
      ".env.local",
      "~/Library/Application Support/emend",
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
  });
  assert.deepEqual(errors, [".claude/settings.json needs sandbox.filesystem.denyRead to include ~/.local/share/emend"]);
});

test("a missing sandbox write denial fails", () => {
  const errors = withSettings((s) => {
    delete s.sandbox.filesystem;
  });
  assert.equal(errors.length, 25);
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

test("a local, address or wildcard network entry fails", () => {
  const entries = [
    "localhost",
    "LocalHost.",
    "localhost:3636",
    "*.localhost",
    "app.localhost",
    "127.0.0.1",
    "127.0.0.1:3636",
    "127.1.2.3",
    "0.0.0.0",
    "[::1]",
    "[::1]:3636",
    "::1",
    "::",
    "[::]",
    "::ffff:127.0.0.1",
    "[::ffff:127.0.0.1]:80",
    "0:0:0:0:0:0:0:1",
    "10.0.0.5",
    "2130706433",
    "*",
  ];
  for (const domain of entries) {
    const errors = withSettings((s) => {
      s.sandbox.network.allowedDomains.push(domain);
    });
    assert.equal(errors.length, 1, domain);
    assert.match(errors[0], /allows the network entry/);
  }
});

test("a WebFetch allow rule for a local, address or wildcard host fails", () => {
  for (const domain of ["localhost", "127.0.0.1:3636", "[::1]", "*.localhost", "0.0.0.0", "*"]) {
    const errors = withSettings((s) => {
      s.permissions.allow = [`WebFetch(domain:${domain})`];
    });
    assert.equal(errors.length, 1, domain);
    assert.match(errors[0], /allows the network entry/);
  }
});

test("a WebFetch allow rule for a public host passes", () => {
  assert.deepEqual(
    withSettings((s) => {
      s.permissions.allow = ["WebFetch(domain:docs.example.com)", "Read(/docs/**)"];
    }),
    [],
  );
});

test("a missing denied domain fails", () => {
  const errors = withSettings((s) => {
    s.sandbox.network.deniedDomains = s.sandbox.network.deniedDomains.filter((d: string) => d !== "[::]");
  });
  assert.deepEqual(errors, [".claude/settings.json needs sandbox.network.deniedDomains to include [::]"]);
});

test("sandbox keys outside the allowlist fail", () => {
  const cases: [string, (s: Record<string, any>) => void][] = [
    ["sandbox.network.httpProxyPort", (s) => (s.sandbox.network.httpProxyPort = 8080)],
    ["sandbox.network.socksProxyPort", (s) => (s.sandbox.network.socksProxyPort = 1080)],
    ["sandbox.excludedCommands", (s) => (s.sandbox.excludedCommands = ["git"])],
    ["sandbox.network.allowUnixSockets", (s) => (s.sandbox.network.allowUnixSockets = ["/run/x.sock"])],
    ["sandbox.network.allowAllUnixSockets", (s) => (s.sandbox.network.allowAllUnixSockets = true)],
    ["sandbox.enableWeakerNestedSandbox", (s) => (s.sandbox.enableWeakerNestedSandbox = true)],
    ["sandbox.filesystem.allowWrite", (s) => (s.sandbox.filesystem.allowWrite = ["/"])],
    ["sandbox.filesystem.allowRead", (s) => (s.sandbox.filesystem.allowRead = ["~/.ssh"])],
    ["sandbox.filesystem.allowGitConfig", (s) => (s.sandbox.filesystem.allowGitConfig = true)],
    ["sandbox.someFutureKey", (s) => (s.sandbox.someFutureKey = { nested: 1 })],
    ["sandbox.network.nested.deeper", (s) => (s.sandbox.network.nested = { deeper: true })],
  ];
  for (const [key, change] of cases) {
    const errors = withSettings(change);
    assert.ok(errors.some((e) => e.includes(`sets ${key.replace(/\.deeper$/, "")}`)), key);
    assert.ok(errors.every((e) => /not an allowed sandbox key/.test(e)), key);
  }
});

test("the allowed sandbox keys pass", () => {
  assert.deepEqual(
    withSettings((s) => {
      s.sandbox.failIfUnavailable = true;
      s.sandbox.network.allowLocalBinding = true;
    }),
    [],
  );
});

test("allowUnsandboxedCommands set to true fails", () => {
  const errors = withSettings((s) => {
    s.sandbox.allowUnsandboxedCommands = true;
  });
  assert.deepEqual(errors, [".claude/settings.json needs sandbox.allowUnsandboxedCommands set to false"]);
});

test("a missing allowUnsandboxedCommands fails", () => {
  const errors = withSettings((s) => {
    delete s.sandbox.allowUnsandboxedCommands;
  });
  assert.deepEqual(errors, [".claude/settings.json needs sandbox.allowUnsandboxedCommands set to false"]);
});

test("allow rules that widen writes or the network fail", () => {
  for (const rule of ["Edit(/src/**)", "Edit", "MultiEdit(/x)", "MultiEdit", "Write(/x)", "Write", "NotebookEdit(/x)", "NotebookEdit", "WebFetch", "WebFetch()", "WebFetch(*)"]) {
    const errors = withSettings((s) => {
      s.permissions.allow = [rule];
    });
    assert.equal(errors.length, 1, rule);
    assert.match(errors[0], /widens writes or the network/);
  }
});

test("harmless allow rules pass", () => {
  assert.deepEqual(
    withSettings((s) => {
      s.permissions.allow = ["Bash(git status)", "WebFetch(domain:docs.example.com)"];
    }),
    [],
  );
});

test("a refused entry in settings.local.json fails", () => {
  const local = (value: unknown) =>
    checkBudget(makeTree({ settings: VALID_SETTINGS, localSettings: JSON.stringify(value) })).errors;
  assert.deepEqual(local({ sandbox: { network: { httpProxyPort: 8080 } } }), [
    ".claude/settings.local.json sets sandbox.network.httpProxyPort, which is not an allowed sandbox key",
  ]);
  assert.match(local({ permissions: { allow: ["Edit(/x)"] } })[0], /settings\.local\.json allows "Edit\(\/x\)"/);
  assert.match(local({ sandbox: { network: { allowedDomains: ["127.0.0.1"] } } })[0], /settings\.local\.json allows the network entry/);
  assert.match(local({ sandbox: { allowUnsandboxedCommands: true } })[0], /must not change sandbox\.allowUnsandboxedCommands/);
  assert.match(local({ sandbox: { enabled: false } })[0], /must not change sandbox\.enabled/);
});

test("a harmless or missing settings.local.json passes", () => {
  const withLocal = (value: string) => checkBudget(makeTree({ settings: VALID_SETTINGS, localSettings: value })).errors;
  assert.deepEqual(withLocal("{}"), []);
  assert.deepEqual(withLocal(JSON.stringify({ permissions: { allow: ["Bash(git status)"] } })), []);
  assert.deepEqual(checkBudget(makeTree({ settings: VALID_SETTINGS })).errors, []);
});

test("an empty settings.local.json counts as absent, anything else blank or broken still fails", () => {
  const withLocal = (value: string, settings: string = VALID_SETTINGS) =>
    checkBudget(makeTree({ settings, localSettings: value })).errors;
  assert.deepEqual(withLocal(""), []);
  assert.match(withLocal(" ")[0], /^\.claude\/settings\.local\.json is not valid JSON \(/);
  assert.match(withLocal("\n")[0], /^\.claude\/settings\.local\.json is not valid JSON \(/);
  assert.match(withLocal("﻿")[0], /^\.claude\/settings\.local\.json is not valid JSON \(/);
  assert.match(withLocal("{")[0], /^\.claude\/settings\.local\.json is not valid JSON \(/);
  // an empty local file never skips the checks on settings.json itself
  assert.ok(withLocal("", "{}").some((e) => e.startsWith(".claude/settings.json")));
});

test("settings.local.json that is not a plain file fails", () => {
  const SYMLINK = [".claude/settings.local.json must not be a symlink"];
  const REGULAR = [".claude/settings.local.json must be a regular file"];
  const tree = () => makeTree({ settings: VALID_SETTINGS });
  const local = (root: string) => path.join(root, ".claude", "settings.local.json");

  let root = tree();
  writeFileSync(path.join(root, "empty.json"), "");
  symlinkSync(path.join(root, "empty.json"), local(root));
  assert.deepEqual(checkBudget(root).errors, SYMLINK);

  root = tree();
  symlinkSync("/dev/null", local(root));
  assert.deepEqual(checkBudget(root).errors, SYMLINK);

  root = tree();
  mkdirSync(local(root));
  assert.deepEqual(checkBudget(root).errors, REGULAR);
});

test("classifyLocalSettings decides what counts as absent", () => {
  const stat = (kind: string, size = 0, rdev = 0) => ({
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
    isCharacterDevice: () => kind === "char",
    size,
    rdev,
  });
  const NULL_RDEV = 259;
  assert.equal(classifyLocalSettings(undefined, NULL_RDEV), "absent");
  assert.equal(classifyLocalSettings(stat("file", 0), NULL_RDEV), "absent");
  assert.equal(classifyLocalSettings(stat("file", 2), NULL_RDEV), "read");
  assert.equal(classifyLocalSettings(stat("char", 0, NULL_RDEV), NULL_RDEV), "hidden");
  assert.equal(classifyLocalSettings(stat("char", 0, 5), NULL_RDEV), "invalid");
  assert.equal(classifyLocalSettings(stat("symlink", 0, NULL_RDEV), NULL_RDEV), "symlink");
  assert.equal(classifyLocalSettings(stat("dir"), NULL_RDEV), "invalid");
});

test("the real settings files pass the settings checks", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const errors = checkBudget(repoRoot).errors.filter((e) => e.startsWith(".claude/settings"));
  assert.deepEqual(errors, []);
});

test("a settings file that is not a JSON object fails", () => {
  for (const value of ["null", "[]", '"text"', "42"]) {
    assert.deepEqual(checkBudget(makeTree({ settings: value })).errors, [".claude/settings.json must be a JSON object"], value);
    assert.deepEqual(
      checkBudget(makeTree({ settings: VALID_SETTINGS, localSettings: value })).errors,
      [".claude/settings.local.json must be a JSON object"],
      value,
    );
  }
});

test("permissions.additionalDirectories fails in either file", () => {
  const errors = withSettings((s) => {
    s.permissions.additionalDirectories = ["/tmp"];
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /settings\.json sets permissions\.additionalDirectories/);
  const local = checkBudget(
    makeTree({ settings: VALID_SETTINGS, localSettings: JSON.stringify({ permissions: { additionalDirectories: ["/tmp"] } }) }),
  ).errors;
  assert.equal(local.length, 1);
  assert.match(local[0], /settings\.local\.json sets permissions\.additionalDirectories/);
});

test("an env key outside the allowlist fails in either file", () => {
  const errors = withSettings((s) => {
    s.env = { ...s.env, GIT_CONFIG_GLOBAL: "/tmp/x" };
  });
  assert.deepEqual(errors, [".claude/settings.json sets env.GIT_CONFIG_GLOBAL, which is not an allowed env key"]);
  const local = checkBudget(
    makeTree({ settings: VALID_SETTINGS, localSettings: JSON.stringify({ env: { LD_PRELOAD: "/tmp/x.so" } }) }),
  ).errors;
  assert.deepEqual(local, [".claude/settings.local.json sets env.LD_PRELOAD, which is not an allowed env key"]);
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
  assert.equal(errors.length, 19);
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

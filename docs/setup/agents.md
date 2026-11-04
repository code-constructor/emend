# Set up your agents for emend

Use this page if emend already runs, on this machine or as a hub you attach to, and you want
Claude Code, Codex or another coding agent to publish to it and wait for your feedback. You get
the review skills, optionally the sandbox rules that let an agent's emend commands reach the
server, optionally deny rules that catch the commands an agent must never run, and optionally the
MCP server. Every other setup page sends you here for its agent side.

## Set it up with an agent

```text
Rules: run the steps yourself and show me what each command printed; before you change an agent's
permission or sandbox settings (for example ~/.claude/settings.json or ~/.codex/rules/), show me
the change and wait for my yes; never read secrets (tokens, .env files, credential stores) or
emend's state folder; never open ~/.claude/settings.json whole; if a dotfiles tool manages a file
or link you would change (a symlink into a dotfiles repository, stow, chezmoi, home-manager or
similar), change its source and tell me how to apply it; never run emend pair, attach, detach,
config or devices yourself, give me the command instead;
never run claude plugin commands yourself, give them to me for my own terminal; never pass --host or any flag this page
does not name; never retry a command through another program (for example script) to get a
terminal; never list the devices on my tailnet; outside your sandbox run only emend skills
install, and no other command; run no process listing yourself, ask me to run pgrep in my own
terminal (Linux: pgrep -af '[e]mend.mjs serve'; macOS: pgrep -lf '[e]mend.mjs serve').
Give my coding agents emend. Follow
https://github.com/shllg/emend/blob/release/docs/setup/agents.md step by step. Ask me which agents
I use (Claude Code, Codex, others that read ~/.agents/skills) and whether I want the sandbox rules,
the deny rules and the MCP server. Skip the agents I do not use.
```

## What you need

- emend installed: `emend --version` prints a version. See [local.md](local.md).
- At least one agent: Claude Code, Codex, or another agent that reads `~/.agents/skills`.
- Access to that agent's settings. You review every change to them.

## 1. Add the plugin to Claude Code

The plugin comes from the `release` branch of the emend repository:

```sh
claude plugin marketplace add shllg/emend@release
claude plugin install emend@emend
```

Restart Claude Code, or run `/reload-plugins` in a running session. To see the skills, run
`/plugin` and check that `emend` is listed as installed. The skills `emend-review`, `emend-publish`
and `emend-feedback` then show in the slash-command list under the `emend:` prefix.

Claude Code can update a marketplace by itself. To switch that on, open `/plugin` in Claude Code,
choose Marketplaces, choose `emend`, and turn on auto-update. Without it, update by hand as
[update.md](update.md) says.

Do not add the marketplace twice from two sources. If you work in an emend checkout, add the
checkout as the marketplace instead of `shllg/emend@release`, never both.

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder; never
run claude plugin commands yourself.
Add the emend plugin to Claude Code: give me claude plugin marketplace add shllg/emend@release and
claude plugin install emend@emend to run in my own terminal, since they change Claude Code's own
plugin folder, which an agent sandbox blocks. Then tell me to restart Claude Code or run
/reload-plugins. Tell me how to turn on auto-update in /plugin, under Marketplaces. Skip this if I
do not use Claude Code.
```

## 2. Link the skills for Codex and other agents

Codex and other agents that read `~/.agents/skills` get the skills as symlinks:

```sh
emend skills install --dry-run
emend skills install
```

`--dry-run` prints `would link <link> -> <skill folder>` for each skill and changes nothing. The
real command prints `linked ...`, or `... already linked` when the link is right. Each link goes
into `~/.agents/skills` and points into the installed package. `--dir <path>` links into another
folder instead.

Run `emend skills install` again after every update. mise keeps each version in its own folder,
and the command moves the links to the new one. A link that points into an old folder breaks when
mise removes that folder.

emend never replaces something it did not make. It stops with `<path> exists and was not made by
emend; move it away, then run emend skills install again`.

If a dotfiles tool manages `~/.agents/skills`, the links belong in its source. Link into that
source with `--dir <path>` and apply the change as the tool says.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder; if a dotfiles tool manages a file or link you would change (a
symlink into a dotfiles repository, stow, chezmoi, home-manager or similar), change its source and
tell me how to apply it; outside your sandbox run only emend skills install (and its --dry-run).
Give Codex and my other agents the emend skills: run emend skills install --dry-run and show me
the output. If ~/.agents/skills is managed by a dotfiles tool, use --dir with its source folder.
After my yes, run emend skills install. Skip this if I use only Claude Code.
```

## 3. Use with sandboxed agents

Do this step when your agent runs in a sandbox: Claude Code with its sandbox turned on, or
Codex with its default sandbox. You can wait until the first sandbox error. An agent's sandbox
keeps `emend` from reaching its server and writing its state folder, so `emend publish` and
`emend wait` fail inside it, and emend prints a line that points here. Let the four commands
agents run leave the sandbox, once per machine, in your own settings. `emend attach`, `emend
detach` and `emend pair` stay inside it, so an agent cannot attach your machine to a hub.

**Read each change closely.** These commands run with your full rights:

- They read the named files or folders, the manifest, the docs it names and their assets, every
  changed or new file git does not ignore, and any `--body-file`.
- They write `--save` results.
- `--save` and `--body-file` reach any folder you can reach, including folders the sandbox hides.
- They store that content in emend's state folder or send it to your emend server or hub.

Add these rules only when `emend` on your `PATH` is an install no agent can write, never a
development checkout that agents work in. Check where `emend` lives:

```sh
command -v emend
```

A path under Homebrew (`/opt/homebrew/...`), under npm's global folder, or inside a mise install
folder is fine. A path inside a git checkout is not.

**mise warning.** With mise, the `emend` that a command runs can depend on the folder: a
repository's `mise.toml` or `.tool-versions` can point `emend` at another build. An excluded
`emend publish` could then run code from the repository under review outside the sandbox. The
one-time `command -v emend` check does not cover this. For agent use, prefer an npm or Homebrew
install of Node.js, or keep mise's per-project config out of agents' reach: use mise's paranoid
mode, do not trust repositories that agents can edit, or do not activate mise in the shell your
agents run in. An activated mise can put a trusted repository's own `emend` on `PATH` even when
your `emend` came from npm or Homebrew.

Add exactly the four entries below, in your own settings, and never a wider pattern such as
`emend *`.

Claude Code: merge this into `~/.claude/settings.json`.

```json
{
  "sandbox": {
    "excludedCommands": ["emend publish *", "emend wait *", "emend feedback *", "emend reply *"]
  }
}
```

If the file does not exist, create it with just that JSON. If it has a `sandbox.excludedCommands`
array already, add the four entries to that array and keep the others.

Claude Code then asks before each run of these commands. To skip that question, also add the four
entries to `permissions.allow`:

```json
{
  "permissions": {
    "allow": ["Bash(emend publish *)", "Bash(emend wait *)", "Bash(emend feedback *)", "Bash(emend reply *)"]
  }
}
```

Adding them means Claude Code runs these four commands outside its sandbox without asking you.
Add them only if you accept that.

Codex: create the folder and add a file `~/.codex/rules/emend.rules`.

```sh
mkdir -p ~/.codex/rules
```

```python
prefix_rule(
    pattern = ["emend", ["publish", "wait", "feedback", "reply"]],
    decision = "allow",
)
```

Codex then runs these four commands outside its sandbox without asking. The MCP server
(`emend mcp`) needs no rule: agents start MCP servers outside their sandbox. See step 5 for what
that means.

`~/.claude/settings.json` can hold tokens, so no agent may open the whole file. An agent reads only
the two keys it needs:

```sh
jq '{sandbox, permissions}' ~/.claude/settings.json
```

It merges the entries with a `jq` command that it shows you first. Every merge uses this shape:

```sh
f=~/.claude/settings.json; test ! -L "$f" && (umask 077; jq '.sandbox.excludedCommands = (((.sandbox.excludedCommands // []) + ["emend publish *", "emend wait *", "emend feedback *", "emend reply *"]) | unique)' "$f" > "$f.tmp") && mv "$f.tmp" "$f" || rm -f "$f.tmp"
```

What the shape does:

- `umask 077` makes the temporary file private (mode 0600). A plain `>` would use your default
  umask, often 0644, and `mv` would then leave a settings file that holds tokens readable by every
  local user. A missing file is created with `umask 077` too.
- `|| rm -f "$f.tmp"` removes the temporary copy if `jq` fails, so no full copy of the settings
  stays behind.
- `test ! -L "$f"` refuses a symlink, because `mv` would silently replace it. If the file is a
  symlink into a dotfiles repository, change the dotfiles source instead and apply it as the tool
  says.

An agent's own sandbox often cannot write `~/.claude/settings.json` at all. Then it gives you the
JSON above to add yourself.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder; never open ~/.claude/settings.json whole, read it only with jq
'{sandbox, permissions}' ~/.claude/settings.json; if a dotfiles tool manages a file or link you
would change (a symlink into a dotfiles repository, stow, chezmoi, home-manager or similar),
change its source and tell me how to apply it; add exactly the four entries below and never emend *;
outside your sandbox, run only the read-only jq command and the merge command I approved, nothing
else; never retry a command through another program (for example script).
Let my coding agents run emend publish, wait, feedback and reply outside their sandbox, as the
"Use with sandboxed agents" step of
https://github.com/shllg/emend/blob/release/docs/setup/agents.md says. First run command -v emend
and tell me where it lives; if it is inside a git checkout, stop. Warn me about mise: a project's
mise.toml or .tool-versions can change which emend runs. For Claude Code, show me the jq command
that merges the four sandbox.excludedCommands entries ("emend publish *", "emend wait *", "emend
feedback *", "emend reply *") and ask whether to add the four permissions.allow entries too; or
give me the JSON to add myself. For Codex, run mkdir -p ~/.codex/rules after my yes and show me
the file ~/.codex/rules/emend.rules. Keep every setting that is already there.
```

## 4. Deny the commands an agent must never run (optional hardening)

Your agents should not run `emend pair`, `attach`, `detach`, `config` or `devices`. Those commands
hand out one-time secrets, join machines to a hub and change who may review. The setup prompts
tell the agent to leave them to you. The denies below block the plain spelling and catch
mistakes. They are not a wall: Claude Code and Codex match the literal leading word, so
`/opt/homebrew/bin/emend pair`, `env emend pair` or `npx @shllg/emend pair` get through. The real
barrier is the agent sandbox's denial of emend's state folder. So never add the state folder, or
`emend *`, to any allow or exclusion list.

Claude Code: add these to `permissions.deny` in `~/.claude/settings.json`.

```json
{
  "permissions": {
    "deny": [
      "Bash(emend pair *)",
      "Bash(emend attach *)",
      "Bash(emend detach *)",
      "Bash(emend config *)",
      "Bash(emend devices *)"
    ]
  }
}
```

Codex: add this to `~/.codex/rules/emend.rules`.

```python
prefix_rule(
    pattern = ["emend", ["pair", "attach", "detach", "config", "devices"]],
    decision = "forbidden",
)
```

You still run these commands yourself, in your own terminal. Follow the same file rules as in
step 3: read with the `jq '{sandbox, permissions}'` command, and merge with the same shape, for
example `.permissions.deny = (((.permissions.deny // []) + ["Bash(emend pair *)", "Bash(emend
attach *)", "Bash(emend detach *)", "Bash(emend config *)", "Bash(emend devices *)"]) | unique)`
as the filter.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder; never open ~/.claude/settings.json whole, read it only with jq
'{sandbox, permissions}' ~/.claude/settings.json; if a dotfiles tool manages a file or link you
would change (a symlink into a dotfiles repository, stow, chezmoi, home-manager or similar),
change its source and tell me how to apply it; outside your sandbox, run only the read-only jq
command and the merge command I approved, nothing else; never retry a command through another
program (for example script).
Add enforced denies for emend pair, attach, detach, config and devices. For Claude Code, show me
the five permissions.deny entries (Bash(emend pair *), Bash(emend attach *), Bash(emend detach *),
Bash(emend config *), Bash(emend devices *)) and the merge, or give me the JSON to add myself. For
Codex, show me the prefix_rule with pattern ["emend", ["pair", "attach", "detach", "config",
"devices"]] and decision "forbidden" for ~/.codex/rules/emend.rules. Skip this if I do not want it.
```

## 5. Register the MCP server (optional)

`emend mcp` runs emend's MCP server over stdio. An agent that speaks MCP gets three tools:
`wait_for_review`, `get_feedback` and `reply`. The server does not publish: publish stays a
command. On an attached machine the server uses the hub.

**Read this closely.** An agent starts the MCP server outside its sandbox and keeps it for the
whole session. It runs with your full rights, like the commands in step 3. Run the same
`command -v emend` check as in step 3, and read the mise warning there. The skills work without
the MCP server: register it only if you want the tools.

Claude Code:

```sh
claude mcp add --scope user emend -- emend mcp
```

Codex has its own command for it:

```sh
codex mcp add emend -- emend mcp
```

If you edit Codex's config by hand instead, add this to `~/.codex/config.toml`. That file can hold
tokens, so an agent must not open it: edit it yourself.

```toml
[mcp_servers.emend]
command = "emend"
args = ["mcp"]
```

Restart the agent. You should see an `emend` server in its MCP list.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder; never open ~/.codex/config.toml or ~/.claude/settings.json; if a
dotfiles tool manages a file or link you would change (a symlink into a dotfiles repository,
stow, chezmoi, home-manager or similar), change its source and tell me how to apply it.
Register emend's MCP server (the command is emend mcp; its tools are wait_for_review,
get_feedback and reply, and it runs outside the sandbox with my full rights for the whole
session). First run command -v emend and tell me where it lives; if it is inside a git checkout,
stop. Warn me about mise: a project's mise.toml can change which emend runs. For Claude Code, show
me claude mcp add --scope user emend -- emend mcp and run it after my yes. For Codex, show me
codex mcp add emend -- emend mcp and run it after my yes. Skip this if I do not want the MCP
server.
```

## 6. Publish docs from other folders (optional)

An agent publishes a doc from outside its repository only from a folder you allowed with
`emend config add docRoots <folder>`. You run that command, once per folder.
[local.md](local.md#6-allow-docs-from-other-folders-optional) explains it and what emend refuses.

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder; never
run emend pair, attach, detach, config or devices yourself, give me the command instead.
Ask me which folders outside my repositories my agents should publish docs from, check that each
exists, and give me one emend config add docRoots command per folder, with the path quoted for my
shell.
```

## Check that it works

1. In Claude Code, run `/plugin`: `emend` is listed as installed. For Codex and other agents,
   `ls -l ~/.agents/skills` shows `emend-feedback`, `emend-publish` and `emend-review` as links.
2. Ask your agent to publish a small doc with emend. It runs `emend publish <file>` and gives you
   a review URL. If the agent reports a line about its sandbox, step 3 is missing or incomplete.
3. Open the URL, leave a comment, and press Send. The waiting agent receives it.

## Update

See [update.md](update.md): `emend skills install` again after each update, and the plugin
commands for Claude Code.

## Undo

Remove what you set up, and nothing else:

- The Claude Code plugin: `claude plugin uninstall emend@emend`, then
  `claude plugin marketplace remove emend`.
- The skill links: `ls -l ~/.agents/skills` shows them. Remove the links, not folders:
  `rm ~/.agents/skills/emend-feedback ~/.agents/skills/emend-publish ~/.agents/skills/emend-review`.
  If you used `--dir`, remove the three links there.
- The sandbox rules: remove the four `excludedCommands` entries, and the four `permissions.allow`
  entries if you added them, from `~/.claude/settings.json`, and delete `~/.codex/rules/emend.rules`.
  Show the change before you make it, and change the source if a dotfiles tool manages the file.
- The deny rules: remove the five `permissions.deny` entries, and the `forbidden` rule from
  `~/.codex/rules/emend.rules` if you keep that file.
- The MCP server: `claude mcp remove emend` and `codex mcp remove emend`, or delete the
  `[mcp_servers.emend]` table from `~/.codex/config.toml` yourself.
- The `docRoots` folders: `emend config remove docRoots <folder>` for each.

## When something goes wrong

- [An agent's sandbox blocks emend](troubleshooting.md#an-agents-sandbox-blocks-emend)
- [The skills links are broken after an update](troubleshooting.md#the-skills-links-are-broken-after-an-update)
- [The plugin does not update](troubleshooting.md#the-plugin-does-not-update)
- [docRoots refusals](troubleshooting.md#docroots-refusals)
- [emend is not running](troubleshooting.md#emend-is-not-running)

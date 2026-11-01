# emend

Open-source, local-first review for work done by coding agents: plans, docs and code. Read the
agent's writeup next to its diff, comment on any of it, press Send, and the waiting agent gets your
feedback. emend starts on your machine with one command. Machines can attach to a hub, so that you
review from any device, your phone included.

[VISION.md](VISION.md) says what emend is for, and what it is not.

emend grew out of [hunk-review-skill](https://github.com/vendis-ai/hunk-review-skill), which stays
maintained alongside it.

Status: nothing built yet.

## Use with sandboxed agents

An agent's sandbox keeps `emend` from reaching its server and writing its state folder, so
`emend publish` and `emend wait` fail inside it, and emend prints a line that points here. Let the
four commands agents run leave the sandbox, once per machine, in your own settings. `emend attach`,
`emend detach` and `emend pair` stay inside it, so an agent cannot attach your machine to a hub.

These commands run with your full rights: they read the manifest, the docs it names and their
assets, every changed or new file git does not ignore, and any `--body-file`; they write
`--save` results; and they store that content in emend's state folder or send it to your emend
server or hub. Add these rules only when `emend` on your `PATH` is an install no agent can
write, never a development checkout that agents work in.

Claude Code: merge this into `~/.claude/settings.json`.

```json
{
  "sandbox": {
    "excludedCommands": ["emend publish *", "emend wait *", "emend feedback *", "emend reply *"]
  }
}
```

Claude Code still asks before it runs each of them. To skip that question, also add
`Bash(emend publish *)`, `Bash(emend wait *)`, `Bash(emend feedback *)` and `Bash(emend reply *)`
to `permissions.allow`.

Codex: add a file `~/.codex/rules/emend.rules`.

```python
prefix_rule(
    pattern = ["emend", ["publish", "wait", "feedback", "reply"]],
    decision = "allow",
)
```

Codex then runs these four commands outside its sandbox without asking. The MCP server
(`emend mcp`) needs nothing: agents start MCP servers outside their sandbox.

## Development

Work from a checkout to try changes before they are released. Use these steps instead of the
published plugin and `emend skills install`, not next to them: two installs list each skill twice.

These steps load the files live from your checkout, uncommitted and untracked files included,
with your full rights in every project. Use a clone that no agent or tool writes to, run the
commands from its root folder, and update it with `git pull` after you have reviewed the change.

1. Build the CLI and put it on your `PATH`:

   ```sh
   pnpm install
   pnpm build
   mkdir -p ~/.local/bin
   ln -s "$PWD/apps/emend/bin/emend" ~/.local/bin/emend
   ```

   `~/.local/bin` must be on your `PATH`; any other folder on your `PATH` works too. Run
   `pnpm build` again after a change.

2. Claude Code: add the checkout as a plugin marketplace and install the plugin from it.

   ```text
   /plugin marketplace add <path to your checkout>
   /plugin install emend@emend
   ```

   Claude Code loads the skills from the checkout's `plugin/` folder. Run `/reload-plugins` after
   you edit a skill.

3. Codex and other agents that read `~/.agents/skills`: link each skill.

   ```sh
   mkdir -p ~/.agents/skills
   ln -s "$PWD/plugin/skills/emend-review" ~/.agents/skills/emend-review
   ln -s "$PWD/plugin/skills/emend-feedback" ~/.agents/skills/emend-feedback
   ```

## License

MIT. See [LICENSE](LICENSE).

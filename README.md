# emend

Open-source, local-first review for work done by coding agents: plans, docs and code. Read the
agent's writeup next to its diff, comment on any of it, press Send, and the waiting agent gets your
feedback. emend starts on your machine with one command. Machines can attach to a hub, so that you
review from any device, your phone included.

[VISION.md](VISION.md) says what emend is for, and what it is not.

emend grew out of [hunk-review-skill](https://github.com/vendis-ai/hunk-review-skill), which stays
maintained alongside it.

Status: in development. The npm package is not published yet; until it is, install from a
checkout as [Development](#development) says.

## Install

emend needs Node.js 24.18 or newer and git 2.44 or newer. Install the package with
[mise](https://mise.jdx.dev) (preferred) or npm:

```sh
mise use -g npm:@shllg/emend
# or
npm install -g @shllg/emend
```

To keep the server running and start it at login, run `emend service install` first. Then run
`emend` in a terminal: it starts the server if none runs, and prints a one-time link to the review
inbox.

A server that `emend` started keeps running until you stop that `emend serve` process
(`pgrep -af '[e]mend.mjs serve'` finds it; `pgrep -lf` on macOS). Stop it before you install the
service or update emend: the service cannot start while it holds the port, and it keeps running
the old version.

Give your agents the review skills:

- Claude Code: `/plugin marketplace add shllg/emend`, then `/plugin install emend@emend`.
- Codex and other agents that read `~/.agents/skills`: `emend skills install`.

Then let the agents' commands leave their sandbox, as
[Use with sandboxed agents](#use-with-sandboxed-agents) says.

[docs/setup.md](docs/setup.md) walks through each step, the optional ones included, with a prompt
for an agent that sets it up together with you.

## Configure

`emend config` lists the settings. `emend config add docRoots <folder>` lets agents publish docs
from a folder outside their repository. `emend config set openBrowser true` makes `emend` open your
browser instead of printing a one-time sign-in link. Run these yourself: an agent in its sandbox
cannot write emend's settings.

## Update

```sh
mise upgrade npm:@shllg/emend
# or
npm install -g @shllg/emend@latest
```

Then run `emend service install` again if you installed the service. It keeps its options and
restarts the server, so the new version runs. Without the service, stop the server `emend` started;
the next `emend` starts the new version. Do the same after you upgrade Node.js: the service
starts emend with the Node.js it was installed with. If you ran `emend skills install`, run it
again too: mise keeps each version in its own folder, and the command moves the links.

Claude Code: `claude plugin marketplace update emend`, then `claude plugin update emend@emend`, and
restart Claude Code.

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

A checkout installs the same way as a release: `pnpm install:local` builds the committed `HEAD` in
a temporary folder, packs it and installs the package. Use a clone that no agent or tool writes to,
review a change before you pull it, and run the command again after each pull.

```sh
pnpm install
pnpm install:local
```

If you linked `apps/emend/bin/emend` into a folder on your `PATH` before (the earlier development
steps and `install.sh` did), remove that link, and stop every emend server that runs from a
checkout: `pgrep -af '[e]mend.mjs serve'` lists them with their paths (`pgrep -lf` on macOS).
Otherwise the commands your agents run outside their sandbox, and the server that serves the review
app, run the checkout's build, which agents can change.

With mise on your `PATH`, the package goes to a folder in mise's data folder that `mise link`
registers as `npm:@shllg/emend@local`; pass `--npm` to use `npm install -g` instead. If `emend` is
not on your `PATH` yet, the command prints the folder to add. It also restarts an installed
service, so the new build runs.

For Claude Code, add the checkout as a plugin marketplace instead of the GitHub one, never both:

```text
/plugin marketplace add <path to your checkout>
/plugin install emend@emend
```

Claude Code reads the skills from the checkout's `plugin/` folder, uncommitted changes included. A
pulled change takes effect at the next session start or after `/reload-plugins`. For other agents,
run `emend skills install` once; its links point into the installed package.

`pnpm verify` runs every check. [AGENTS.md](AGENTS.md) holds the working rules.

## License

MIT. See [LICENSE](LICENSE).

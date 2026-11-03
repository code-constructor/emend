# Set up emend

Each step says what to do and gives a prompt for an agent that does it together with you. Steps 2,
5 and 6 are optional. The commands are the same as in the [README](../README.md). Every prompt
starts with its rules, so each one works on its own.

## The whole setup in one prompt

```text
Rules: show me each change to a file or setting and wait for my yes; never read secrets (tokens,
.env files, credential stores) or emend's state folder; if a dotfiles tool manages a file (a
symlink into a dotfiles repository, stow, chezmoi, home-manager or similar), change its source and
tell me how to apply it; never run emend config, pair, attach or detach yourself, give me the
command instead.
Set me up with emend, the review tool for agent work (https://github.com/shllg/emend). Follow
https://github.com/shllg/emend/blob/main/docs/setup.md step by step, and ask me which optional
steps I want.
```

## 1. Install

emend needs Node.js 24.18 or newer and git 2.44 or newer. Install the package with mise or npm:

```sh
mise use -g npm:@shllg/emend
# or
npm install -g @shllg/emend
```

Until the package is on npm, install from a checkout as the README's
[Development](../README.md#development) section says.

```text
Rules: show me each change and wait for my yes; never read secrets or emend's state folder; if a
dotfiles tool manages a file or link you would change, change its source and tell me how to apply it.
Install emend for me. Check that Node.js 24.18 or newer and git 2.44 or newer are installed. If
mise is installed, run mise use -g npm:@shllg/emend; otherwise run npm install -g @shllg/emend.
Then run emend --version and show me the result.
```

## 2. Keep the server running (optional)

`emend service install` runs the server as a systemd user unit on Linux or a launchd agent on
macOS, started at login. When an emend server already runs, whether `emend` started it or you run
`emend serve` yourself, the command asks it to stop so the service can take over. A server from an
older emend cannot be asked: the command says so, and you stop that `emend serve` process yourself
(`pgrep -af '[e]mend.mjs serve'` finds it; `pgrep -lf` on macOS), then run the command again. It
reports an error, with the place to read the service log, when it cannot confirm that the service's
own server answers. Without the service, `emend` starts the server when you run it.

```text
Rules: show me each change and wait for my yes; never read secrets or emend's state folder; if a
dotfiles tool manages a file or link you would change, change its source and tell me how to apply it.
Install the emend service: run emend service install and emend service status outside your
sandbox, since they need emend's state folder, the service manager and 127.0.0.1, and show me the
output of both. If it reports a server it cannot ask to stop, ask me to run pgrep -af
'[e]mend.mjs serve' (pgrep -lf on macOS) in my own terminal and to end that server, then run emend
service install again; run no process listing yourself.
```

## 3. Give your agents the review skills

- Claude Code: `claude plugin marketplace add shllg/emend`, then
  `claude plugin install emend@emend`, then restart Claude Code.
- Codex and other agents that read `~/.agents/skills`: `emend skills install`.

```text
Rules: show me each change and wait for my yes; never read secrets or emend's state folder; if a
dotfiles tool manages a file or link you would change, change its source and tell me how to apply it.
Give my coding agents the emend skills. For Claude Code, run claude plugin marketplace add
shllg/emend and claude plugin install emend@emend, then tell me to restart Claude Code. For Codex
and other agents that read ~/.agents/skills, run emend skills install. Skip an agent I do not use.
```

## 4. Let the agents' emend commands leave their sandbox

Inside an agent's sandbox, `emend publish`, `wait`, `feedback` and `reply` cannot reach the server.
[Use with sandboxed agents](../README.md#use-with-sandboxed-agents) gives the settings for Claude
Code and Codex, and says what these commands may read and write. Read each change closely: it lets
these four commands run with your full rights.

```text
Rules: show me each change and wait for my yes; never read secrets or emend's state folder; if a
dotfiles tool manages a file or link you would change, change its source and tell me how to apply it.
Let my coding agents run emend publish, wait, feedback and reply outside their sandbox, as the
"Use with sandboxed agents" section of https://github.com/shllg/emend/blob/main/README.md says.
First check that emend on my PATH is an installed package and not a checkout an agent can write
to; if it is a checkout, stop and tell me. For Claude Code, merge the excludedCommands entries
into ~/.claude/settings.json and ask me whether to add the four permissions.allow entries too.
That file can hold tokens: look only at its sandbox and permissions keys, and never print any other
value from it. For Codex, add ~/.codex/rules/emend.rules. Keep every setting that is already there.
```

## 5. Publish docs from other folders (optional)

An agent can publish a doc from outside its repository only from a folder you allowed. Run this
yourself, once per folder:

```sh
emend config add docRoots <folder>
```

`emend config` lists the settings; `emend config remove docRoots <folder>` takes a folder back.
Then `emend publish <folder>/plan.html` prints a review URL. Run it again after editing to update
the same review, or publish the folder to bundle its docs. See [Publish a doc](../README.md#publish-a-doc).

```text
Rules: never read secrets or emend's state folder; never run emend config yourself, give me the
command instead.
I want my agents to publish docs from a folder outside their repositories with emend. Ask me which
folders, check that each exists, and give me one emend config add docRoots command per folder,
with the path quoted for my shell. emend refuses the home folder, any folder that holds it, and
its own state folder.
```

## 6. Review from your phone and other machines (optional)

One always-on machine with [Tailscale](https://tailscale.com) serves as the hub:

```sh
emend service install --tailscale
emend pair
```

With `--tailscale`, emend serves the hub on your tailnet through Tailscale Serve on port 443. If
Tailscale refuses to let your user set that up, run this once as root, then install again:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:3636
```

emend uses that route and never removes a route it did not create. The route stays until you run
`sudo tailscale serve --https=443 off`. Remove it when the machine stops being your hub: while
emend is down, any program listening on port 3636 would receive your phone's requests.

`emend pair` prints a one-time link, a code and a QR code, valid for 10 minutes. Open the link on
your phone, or scan the QR code, and enter the code. To add another machine, run
`emend pair --machine` on the hub, then the `emend attach <link>` command it prints on that
machine.

```text
Rules: show me each change and wait for my yes; never read secrets or emend's state folder; if a
dotfiles tool manages a file or link you would change, change its source and tell me how to apply
it; never run emend pair, attach or detach yourself, give me the command instead.
Help me make this machine the emend hub. Check with tailscale ip -4 that Tailscale runs here
(do not list the other devices on my tailnet). Run
emend service install --tailscale and show me the output. If Tailscale refuses to set up Serve,
give me the sudo tailscale serve command emend prints, to run once as root, then install again.
Then tell me to run emend pair myself
and explain how to open the link on my phone. For another machine, tell me to run emend pair
--machine here and emend attach with the printed link there.
```

## Update

Update the package, then rerun the commands that point at it:

```sh
mise upgrade npm:@shllg/emend      # or: npm install -g @shllg/emend@latest
emend service install              # if you installed the service; keeps its options
emend skills install               # if you ran it before
claude plugin marketplace update emend
claude plugin update emend@emend   # then restart Claude Code
```

Without the service, stop the `emend serve` process that `emend` started
(`pgrep -af '[e]mend.mjs serve'` finds it; `pgrep -lf` on macOS); the next `emend` starts the new
version. After you upgrade Node.js, run `emend service install` again: the service starts
emend with the Node.js it was installed with.

```text
Rules: show me each change and wait for my yes; never read secrets or emend's state folder; if a
dotfiles tool manages a file or link you would change, change its source and tell me how to apply it.
Update emend for me. If mise manages it, run mise upgrade npm:@shllg/emend; otherwise run npm
install -g @shllg/emend@latest. Then, only for the parts I set up: run emend service install
(it keeps its options and restarts the server), run emend skills install, and run claude plugin
marketplace update emend and claude plugin update emend@emend and tell me to restart Claude Code.
Without the service, ask me to run pgrep -af '[e]mend.mjs serve' (pgrep -lf on macOS) in my own
terminal and to end any emend server it lists; run no process listing yourself. Show me emend
--version at the end.
```

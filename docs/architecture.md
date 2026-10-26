# Architecture

emend is a local-first review tool for plans, documents and code. One distributable,
`@shllg/emend`, contains the Node command and server together with the built browser app. Hub
mode is a setting of the same app. This page describes the intended runtime; the initial
workspace scaffold implements the version command and a minimal browser shell.

## Repository boundaries

| Path | Responsibility |
| --- | --- |
| `apps/emend` | The CLI, local server, MCP endpoint and headless service. Serves the web build. |
| `apps/web` | The React and Vite browser app. |
| `packages/contract` | Shared schemas for the API, review manifest, file roles and capabilities. |
| `packages/core` | Pure logic for safe Markdown blocks, block ids, comment placement and topics. |
| `skills` | Creating reviews and handling reviewer feedback. |
| `docs` | The versioned API contract and architecture. |
| `sync` | Surfaces shared with hunk-review-skill and synthetic fixtures. |
| `tasks` | The ordered work queue. |

Core has no Node-only or browser-only APIs; WebCrypto is allowed. Both apps can use it without
introducing a runtime dependency on the other app. Contract and core expose their TypeScript
sources to workspace consumers. Vite builds the browser app first; esbuild bundles the CLI
as Node 24 ESM, then copies the browser output into `apps/emend/dist/web`.

## One machine

The planned default command starts a server if needed and opens the browser with a one-time
link. `emend serve` runs without opening a browser; `emend service install` installs a systemd
user unit or a launchd agent. The server binds `127.0.0.1:3636` unless `--host` or `--tailscale`
explicitly widens access. There is no telemetry.

State is one SQLite database and a content-addressed blob store with SHA-256 names. `EMEND_HOME`
overrides the platform data location: the XDG data directory on Linux, Application Support on
macOS. Each instance has a stable id and a name, defaulting to the hostname. Tests always use
temporary state directories.

## Attached machines and the phone

An always-on machine can serve as the hub. `emend serve --tailscale` exposes its server through
Tailscale Serve HTTPS. Pairing provides a one-time link, QR code and code for browser sessions.
A phone opens the same web app and can install it with Add to Home Screen. Its session has
reviewer privileges only.

A laptop attaches with `emend attach <pairing-link>`, storing the hub URL and a machine token.
Its CLI then publishes to and waits on the hub; it does not need a local server. The default
command opens the hub app, where an unpaired browser sees the pairing page.

Attach copies existing local reviews whole, including revisions, files, threads, comments,
Sends and open deliveries, while retaining review ids. Repeating attach skips reviews already
on the hub. Local copies become read-only links to the hub. Detach makes new reviews local;
reviews already on the hub stay there. There is no two-way synchronization in the MVP.

Reviews on the hub belong to its owner. Each records its origin instance, shown as an inbox
badge; a machine token reaches only that instance's reviews. If the hub is unreachable,
publish and wait fail with one clear line and change nothing. Offline queuing is deferred.

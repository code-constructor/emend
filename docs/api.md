# API v1

The versioned API lives under `/api/v1`. `@emend/contract` exports its zod schemas and inferred
TypeScript types under the same names, with `CONTRACT_VERSION = 1`. All API timestamps are
ISO 8601 UTC strings (for example `2026-01-01T00:10:00.000Z`). Object schemas strip unknown
keys at every level. Additive fields stay in v1; breaking changes require `/api/v2`.

This is the v1 contract and endpoint inventory. Routes are implemented incrementally. Each later
task adds its request and response schemas to `packages/contract/src/api.ts` and documents them
here **before** writing the route. This includes `PublishRequest` (plan task 1.6), `InboxItem`,
`ReviewView`, `RevisionView`, `FileView` and `ThreadView` (plan task 1.9), and `ImportBundle`
(plan task 1.14).

## Credentials and headers

- CLI and MCP requests carry `Authorization: Bearer <token>`. Admin and agent tokens have separate
  scopes. A reviewer credential is accepted only from the session cookie, never as a bearer token.
- The CLI sends `X-Emend-Client: cli/<semver>`. The minimum supported client version is `0.1.0`;
  older clients receive `426 client_outdated`. Other header values are `400 invalid_request`.
- Before sending a bearer, the CLI authenticates the discovered server with public
  `GET /api/v1/capabilities` and `X-Emend-Challenge` (`SERVER_CHALLENGE_HEADER`). `ServerChallenge`
  is 32 fresh random bytes encoded as canonical unpadded base64url (43 characters). The server
  answers `X-Emend-Proof` (`SERVER_PROOF_HEADER`, schema `ServerProof`) with HMAC-SHA256 over the
  challenge's ASCII text, using the decoded 32-byte key stored in private `server.json`, encoded
  as canonical unpadded base64url. The CLI compares the digest in constant time. A missing,
  malformed or wrong proof prevents credential transmission. No challenge means no proof;
  a malformed challenge returns `400 invalid_request`. Capabilities remains public, and its
  proof reveals nothing about the key. Neither header carries a bearer or the server key.
- Browsers use `emend_session`, with `HttpOnly`, `SameSite=Strict`, `Path=/`,
  `Max-Age=2592000` (30 days), and `Secure` on HTTPS. Sessions renew at most once daily.
- JSON bodies use `Content-Type: application/json`. Routes reject bodies over their JSON byte
  limit with `413 too_large` before parsing, then validate with the contract schemas:
  `POST /api/v1/publish` permits at most `publishJsonBytes` (8388608 bytes); `POST /session` and
  `POST /machines` permit `publicJsonBytes` (4096 bytes); other JSON routes permit at most
  `requestJsonBytes` (1048576 bytes).
- Every request checks `Host` against `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`, and
  the listener's actual concrete address, and the tailnet name only when configured with
  `--tailscale`. Other hosts receive `403 bad_host`. Every non-GET/HEAD request with an Origin
  must name an allowed app origin. A non-GET/HEAD request carrying a session cookie must carry
  that Origin; a missing or disallowed origin receives `403 bad_origin`.

Guards run in this order: Host, client version, Origin, declared Content-Length limit,
credential and scope, bounded body streaming, then handler and schema parsing. An unauthorized
request never reads its body. Every API response carries `Cache-Control: no-store`.
Unimplemented listed routes still enforce their scope before `404 not_found`. Unlisted API
paths require a credential before returning `404 not_found`. HEAD inherits the corresponding
GET route's scope unless it has an explicit endpoint entry. Until content serving is implemented,
`/content/*` responses carry `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

Local discovery and the default pairing URL use the listener's numeric address, with IPv6
literals in brackets and wildcard listeners represented by their corresponding loopback address.
An explicit public origin still overrides the pairing URL. The raw HTTP Host guard runs before
the adapter, so malformed hosts receive the same `403 bad_host` JSON body and headers; adapter
request-construction failures receive `400 invalid_request` with the same response contract.

All API requests require credentials except capabilities, session creation and machine registration.
The content path uses its capability key and never reads cookies. The server binds
`127.0.0.1:3636` by default; only `--host` or `--tailscale` widens it. There is no telemetry.

| Token kind | Scopes |
| --- | --- |
| `admin` | `pairings:create`, `devices:manage` |
| `agent` | `publish`, `take`, `reply` |
| `reviewer` | `read`, `comment`, `send`, `pairings:create`, `devices:manage` |

`Scope` is the enum of all eight scope strings; `SCOPES_BY_KIND` is typed against it.

Only the reviewer session creates user comments, Sends and approvals. An agent reply cannot resolve
a thread or count as a Send. Every query filters the authenticated principal's `owner_id`.
A review id that is missing, belongs to another owner, or belongs to another instance for a machine
token returns the same `404 unknown_review`. Every other missing or foreign id returns
`404 not_found`. `403 forbidden` depends only on the principal's kind and scopes and is decided
before any id lookup. The origin instance comes from the agent token, never the request body;
a machine token reaches only reviews from its own instance.

## Endpoints

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/capabilities` | Anyone | API version, app version and supported features. |
| POST | `/api/v1/session` | Browser, no existing credential required | Exchange `SessionRequest` for a reviewer session (204); refuses machine pairings. |
| DELETE | `/api/v1/session` | Reviewer | End the current browser session. |
| POST | `/api/v1/pairings` | Admin, reviewer | Create from `PairingRequest`; return `PairingCreated` (201). |
| GET | `/api/v1/devices` | Admin, reviewer | List paired devices. |
| DELETE | `/api/v1/devices/:id` | Admin, reviewer | Revoke a device. |
| POST | `/api/v1/machines` | Anyone with a pairing secret or code | Register `{secret, instance: {id, name}}` or `{code, instance: {id, name}}`; refuses device pairings (task 1.14). |
| DELETE | `/api/v1/machines/self` | Agent | Detach the current machine. |
| HEAD | `/api/v1/blobs/:sha256` | Agent | Check whether the owner's blob exists. |
| PUT | `/api/v1/blobs/:sha256` | Agent | Upload a blob; verify its size and hash. |
| POST | `/api/v1/publish` | Agent | Create a review or add a revision. |
| POST | `/api/v1/import` | Agent | Import reviews when attaching a machine. |
| GET | `/api/v1/reviews` | Reviewer | List reviews in the inbox. |
| GET | `/api/v1/reviews/:id` | Reviewer | Read a review. |
| GET | `/api/v1/reviews/:id/revisions/:seq` | Reviewer | Read one revision. |
| GET | `/api/v1/files/:fileId/old` | Reviewer | Read the old file side. |
| GET | `/api/v1/files/:fileId/new` | Reviewer | Read the new file side. |
| GET | `/api/v1/reviews/:id/events` | Reviewer | Subscribe to review events using SSE. |
| POST | `/api/v1/reviews/:id/threads` | Reviewer | Create a thread and user comment. |
| POST | `/api/v1/threads/:id/comments` | Reviewer | Add a user comment to a thread. |
| PATCH | `/api/v1/comments/:id` | Reviewer | Edit an unsent user comment. |
| DELETE | `/api/v1/comments/:id` | Reviewer | Delete an unsent user comment. |
| POST | `/api/v1/threads/:id/resolve` | Reviewer | Resolve a thread. |
| POST | `/api/v1/threads/:id/reopen` | Reviewer | Reopen a thread. |
| POST | `/api/v1/reviews/:id/sends` | Reviewer | Send feedback or approve the revision on screen. |
| POST | `/api/v1/reviews/:id/take` | Agent | Claim a delivery, waiting up to `{waitSeconds: 0..25}`. |
| POST | `/api/v1/deliveries/:id/confirm` | Agent | Confirm receipt of a claimed delivery. |
| POST | `/api/v1/comments/:id/reply` | Agent | Answer a comment with an outcome. |
| GET | `/content/:contentKey/*` | Holder of the key | Read isolated HTML docs and assets from a revision. |

## Schemas

`Capabilities = { api: 1, version: string, features: string[] }`. The first feature list is
`["attach", "html-docs", "mcp"]`; clients accept additional feature strings.

`PairingPurpose = "device" | "machine"`. `PairingRequest = { purpose? }` defaults to `"device"`.
`PairingCreated = { url, code, expiresAt }`: the HTTP(S) URL ends in `/pair#<secret>` with no query,
the code is eight canonical Crockford characters displayed as `XXXX-XXXX`, and the expiry is UTC.
`SessionRequest` accepts exactly one of `{ secret }` and `{ code }`. Codes accept lower case and
an optional middle hyphen, normalizing `I`/`L` to `1` and `O` to `0`. Secrets match
`^emp_[A-Za-z0-9_-]{43}$`. Unknown, used, expired and wrong-purpose pairings all return the same
`401 unauthorized`; session redemption accepts only `device`, machine registration only `machine`.
Redemption creates a browser device and reviewer token atomically. Revoked tokens or devices and
expired sessions are unauthorized. Session deletion revokes both and clears the cookie.
If a code matches multiple live device pairings, redemption is unauthorized and consumes none;
the individual secret links remain usable.

`PublishResponse = { reviewId, revision, url, placed, unplaced, unrendered: FilePath[] }`.
An omitted `unrendered` field defaults to `[]`.
HTML doc entries include `assets: FilePath[]`. Each listed path must be an asset in the request
inside that doc's folder. The HTML source plus its own listed assets must fit
`htmlDocWithAssetsBytes`; shared assets count for every doc listing them. Asset rows retain
their first parent, and their blob bytes count once toward the revision byte budget.
`unrendered` lists Markdown docs whose rendering failed, timed out or exceeded rendered-output budgets
(at most `filesPerRevision`). Rendered blocks and JSON bytes count every path, including the writeup.
Docs render in manifest order; once a doc exceeds either budget it and all later Markdown docs
remain unrendered. A writeup alone exceeding either budget returns 413 `too_large` with
"The writeup has too many blocks."
The CLI warns `emend: could not render <path>` for each; the publish still succeeds.
The URL is `<baseUrl>/r/<reviewId>` (HTTP or HTTPS);
it is bounded by `pathChars` (4096 characters). `revision` is a positive integer sequence, and
the placement counts are nonnegative integers.

### Manifest and topics

`PublishRequest = { reviewId?, reviewKey, repo: { key, name } | null, branch: string | null,
title, base: commit | null, head: commit | "worktree" | null, topics, writeup, files }`.
The keys are lowercase 64-character SHA-256 hex; `reviewId` is a UUID. Repo names obey
`titleChars`, branches `pathChars`, and title, commits and writeup obey the manifest limits.
There are at most `topicsPerReview` declared topics plus the optional generated Other changes
topic (importance 100, last); at most `filesPerRevision` files. Base and head are null together.
`PublishFile = { path, oldPath: FilePath | null, role, status?, topic?, oldBlob: sha256 | null,
newBlob: sha256 | null, flag: FileFlag | null, parent?: FilePath, assets?: FilePath[] }`. Paths and topic slugs are
unique within their namespaces (diffs; docs and assets); file and writeup topics must be declared.
`assets` is required for HTML docs (including an empty array) and must be absent on all other files.
Assets name a declared HTML doc in `parent`, stay inside its folder and have no hidden or dot
segments. Allowed extensions are js, mjs, css, png, jpg, jpeg, gif, svg, webp, avif, ico, bmp,
woff, woff2, ttf, otf, mp4, webm, ogg, mp3, wav and m4a (case insensitive). Shared assets are
published once, with the first doc as parent. Diff rows always have media type `text/plain`.
Only assets have parents. Docs and assets have a new blob, no old side and no flag; flagged
diffs have no blobs. Source filenames never leave the CLI.

`HEAD /api/v1/blobs/:sha256` returns 204 for an owner's blob, otherwise 404 `not_found`.
`PUT` takes raw bytes with a required nonnegative integer `Content-Length`, at most
`htmlDocBytes`, and returns 204. Missing/malformed length or hash is 400 `invalid_request`;
hash or actual length mismatch is 400 `blob_mismatch`; excess size is 413 `too_large`.
Content-Length is checked first; credentials and scope are checked before reading any body bytes.
Blob lookups never expose another owner's content.

Publish resolves an explicit id only for the authenticated owner and origin instance, otherwise
404 `unknown_review`. A moved review returns 409 `review_moved`. Without an id the server
atomically finds or creates by owner, token instance and review key. Missing referenced blobs
return 400 `blob_missing`. Each successful publish adds a revision, reopens the review, and
reports placement counts for that revision. Media types and role size limits are server enforced.
Rendering and placement run in a worker: failed or timed-out Markdown docs have no rendered
blocks; failed writeups return 400 `invalid_request` with "The writeup could not be rendered."
A writeup exceeding 10 seconds returns 413 `too_large` with "The writeup rendering timed out."
At most two publishes compute at once per server process. Further publishes wait up to 30 seconds,
then receive 429 `rate_limited`, "The server is busy publishing; try again." Conflicting attempts
reuse rendered results and retry snapshot/placement at most three times. A disconnected request
is abandoned before commit and its workers are stopped. The CLI publish deadline is 30 seconds
for a slot, plus 15 seconds, plus 10 seconds per writeup/Markdown doc, plus three 30-second
placement attempts. A timeout reports "the server did not answer in time; nothing was published".
Placement exceeding 30 seconds returns 413 `too_large` with "The placement timed out."
Other placement failures return 400 `invalid_request` with "The comments could not be placed."
These failures never leave a partial revision.

`PublishManifest = { version: 1, title, base?, head?, topics: TopicMeta[], files, writeup }`.
`base` and `head` appear together or neither appears. Commits are fully resolved lowercase hex
object ids (40 characters for SHA-1 or 64 for SHA-256); `head` also accepts `"worktree"`.
Docs-only reviews can omit both. Manifest files are `{ path, role: "diff" | "doc", topic?, source? }`;
`source` is a non-empty local filename from which the CLI reads a doc, separate from its published
path. It may be absolute or relative, has at most `pathChars` characters, must be well-formed UTF-16,
and cannot contain NUL, C0 controls or DEL.

The CLI resolves `source` with `realpath` and reads it only when the resolved result is a regular
file inside the repository's worktree root or inside a folder the reviewer listed in their own
emend configuration (`docRoots`). Neither the repository nor the manifest can name an allowed
folder. A symlink leading outside these roots is refused. The role's size limit applies.
Plan task 1.6 implements and tests these checks. Assets are collected during publish.

The general `FileRole` vocabulary is `diff`, `doc`, `asset`; `FileStatus` is `added`, `modified`,
`deleted`, `renamed`, `mode-changed`; `FileFlag` is `binary` or `oversized`.
`FilePath` also rejects a segment equal to `.git` or `git~1` after lowercasing and removing
trailing dots/spaces, and rejects HFS-ignorable code points U+206A–U+206F.

`TopicMeta = { slug, title, importance, summary, door?, blastRadius? }`. A slug matches
`^[a-z0-9][a-z0-9-]{0,63}$`. Importance is a number from 0 through 100; lower sorts first.
Door is `one-way` or `two-way`. Blast radius is `{ scope, note }`: scope is one non-whitespace word,
and note must contain non-whitespace text. The fallback is `{ slug: "other", title: "Other changes" }`;
declaring that slug in a manifest fails with `topic slug other is reserved`. It remains a valid
target for automatically grouped changes.

Topic slugs and file paths within each role must be unique within a manifest. A file's topic and every writeup topic
key must name a declared topic. A topic may omit its writeup entry. Titles must contain non-whitespace
text. There are at most `topicsPerReview` declared topics and writeup topic keys. Summaries,
blast-radius scopes and notes obey `summaryChars`, `blastScopeChars` and `blastNoteChars`.
Markdown strings are preserved exactly; the schema does not render or sanitize them.

`WriteupInput = { overview, tldr, decisions: string | null, glossary?, topics }`. Sections are
Markdown strings; `topics` maps slugs to `{ why, example?, body? }`, also Markdown. Decisions is
required, with `null` representing no decisions section.
Every Markdown string is limited to `writeupSectionBytes` UTF-8 bytes; the sum of all present
`overview`, `tldr`, `decisions`, `glossary`, `why`, `example` and `body` strings is limited to
`writeupBytes`. These limits measure UTF-8 bytes, not character count. Parsed `topics` has a null
prototype: an absent `topics["constructor"]` is `undefined`, while an explicitly declared
`constructor` topic remains accessible and serializes normally.

### Targets and placement

`Target` is discriminated by `kind`:

| Kind | Fields |
| --- | --- |
| `writeup-span` | `blockId`, `quote`, `prefix`, `suffix` |
| `doc-span` | `path`, `blockId`, `quote`, `prefix`, `suffix` |
| `html-span` | `path`, `quote`, `prefix`, `suffix` |
| `lines` | `path`, `side: "old" | "new"`, `start`, `end`, `lines`, `before`, `after` |
| `file` | `path` |
| `topic` | `slug` |
| `review` | No additional fields. |

Every span quote is non-empty; prefix and suffix may be empty. Line numbers are positive integers,
1-based and inclusive: `end >= start`, and `lines.length === end - start + 1`. Blank lines are valid
entries. Both context arrays are required and hold at most three strings each.
There are at most `targetLines` quoted lines. Each `before` and `after` entry has at most
`contextLineChars` characters. The combined UTF-16 length of all `lines`, `before` and `after`
entries must not exceed `targetTextChars`; an excess is a validation issue on `lines`.
No text is truncated: placement on later revisions requires the exact original text.

Published and target paths are relative, slash-separated paths. Empty components, `.` and `..`
components, absolute paths (including drive prefixes), backslashes, NUL, ASCII controls and DEL
are rejected, as are C1 controls U+0080–U+009F, bidi controls U+061C, U+200E–U+200F,
U+202A–U+202E, U+2066–U+2069 and zero-width U+200B–U+200D, U+2060, U+FEFF.
Paths must be well-formed UTF-16, with at most `pathChars` characters overall and
`pathSegmentChars` characters per slash-separated segment. These schemas do not perform
filesystem access.

`Placement` is `{ status: "placed", location: PlacementLocation }` or
`{ status: "unplaced", reason }`. Reasons are `block-gone`, `ambiguous`, `topic-gone`, `file-gone`
and `lines-gone`, plus `not-placed`: the server holds no placement for this revision.
Missing placement rows are delivered as `unplaced` with `not-placed` and the original target.
Locations use the target's `kind`. Span locations contain `start` and `end`
instead of quote/context; offsets are zero-based UTF-16 indices with an exclusive end greater than
start, within the normalized block text or HTML document text. Writeup spans retain `blockId`;
doc spans retain `path` and `blockId`; HTML spans retain `path`. Line locations contain `path`,
`side`, `start`, `end`, using the same 1-based inclusive convention. File, topic and review locations
use the same fields as their targets. Placement describes the newest revision; a thread keeps its
original target separately.

### Sends, replies and waiting

`CreateThreadRequest = { revision, target: Target, body: CommentBody }` creates a thread
and its first user comment (201 `ThreadCreated = { threadId, commentId }`). The target must
place at the same location on the named revision or receive `400 invalid_target`; it is also
placed on every newer revision. Concurrent publication retries placement up to three attempts,
then returns `409 publish_conflict` without creating anything.
`AddCommentRequest = { body }` returns 201 `CommentCreated = { commentId }`.
`EditCommentRequest = { body }` returns 204. Deletion, resolve and reopen return 204.
Editing or deleting a sent user comment returns `409 comment_frozen`; an agent comment returns
`404 not_found`. Deleting the last comment deletes the thread and its placements.
Adding a user comment sets its thread to `open`, including from sent, answered, or resolved.
Mutations on a moved review return `409 review_moved`, except confirmation of an existing
delivery, which remains available so receipt can be recorded. Foreign or missing thread,
comment and delivery ids return `404 not_found`,
including ids from another origin instance for an agent.

`TakeRequest = { waitSeconds }` defaults to 0; finite values from 0 through
`MAX_TAKE_WAIT_SECONDS` (25), including fractions, are accepted. On this route only, a missing
or zero-length body means `{}` even without Content-Type. A nonempty body must be JSON.
A take returns 200 `WaitResult`. Each owner may have `waitingTakesPerOwner` (32) waiting takes;
additional waits receive `429 rate_limited`. Before a waiting take retries and before returning,
its token is rechecked through the committed-read connection. Revoked or expired credentials
receive `401 unauthorized` and leave no delivery claimed by that request.
Confirm takes no body and returns 204, with no JSON response. Only a live unconfirmed lease can
be confirmed: a late or repeated confirm returns `404 not_found`.

SSE uses `text/event-stream`, `Cache-Control: no-store` and a comment keepalive every 25 seconds.
`ReviewEventName` is `publish | send | thread | waiting`. `ReviewEvent` has a `type` discriminator
and the same fields as its SSE payload. The SSE `event` line supplies `type`; the JSON `data` is:

| Event | Payload |
| --- | --- |
| `publish` | `{ reviewId, revision }` |
| `send` | `{ reviewId, revision, sendId }` |
| `thread` | `{ reviewId, revision, threadId, commentId? }` |
| `waiting` | `{ reviewId, revision }` |

Events contain ids and a positive revision sequence only, never text bodies or instructions.
The waiting event signals a change: `agentWaiting(reviewId)` stays true during an open take
and for 35 seconds after the last waiting take ends. Each owner may open 32 streams; additional
streams return `429 rate_limited`. A stream buffering over 100 events is closed.
At each 25-second keepalive, the session is rechecked; revocation or expiry closes the stream.

`ThreadState` is `open`, `sent`, `answered` or `resolved`. `Outcome` is `fixed`, `explained`,
`held` or `declined`; `resolved` is never an agent outcome.

| Go mode | Exact label |
| --- | --- |
| `fix-clear` (default) | Fix what's clear, ask about the rest |
| `explain` | Explain only, change nothing |
| `fix-all` | Fix everything |

`SendRequest = { revision, kind: "go" | "approve", mode?, instruction? }`.
Only a Go accepts mode and instruction; an Approve supplying either is rejected. An omitted mode
stays omitted during parsing; the Send handler applies `DEFAULT_MODE = "fix-clear"`. A Go may have
an empty instruction when comments supply the feedback. The handler refuses a Go with no unsent
comments and no instruction (`empty_send`), and an Approve with unsent comments (`unsent_comments`).
Both name the newest revision or fail with `stale_revision`. Each Send owns the comments it sends;
comments saved afterwards wait for the next Send.
Creation returns 201 `SendCreated = { sendId }`. A Go that would bind more than
`commentsPerHandoff` comments, or whose own content exceeds `handoffBytes` in serialized JSON,
returns `413 too_large`, binding none. The byte check includes the response envelope, comment
metadata and space for placement and truncation metadata, so removing history always suffices
to deliver an accepted Send. Blank instructions do not supply feedback.
Comment bodies and Send instructions must be well-formed UTF-16. Lone surrogates are
`400 invalid_request`; valid surrogate pairs are preserved.

`ReplyRequest = { outcome: Outcome, body }`. Bodies must contain non-whitespace text and are
preserved without trimming. Sent user comments are frozen. Only the reviewer resolves or reopens
threads; an agent reply leaves a resolved thread resolved, and other states become answered.
Replies must target a sent user comment; a draft or an agent comment returns `404 not_found`.
`POST /comments/:id/reply` returns 201 `ReplyCreated = { commentId, threadId, state: ThreadState }`,
where `state` is the thread's state after the reply. It creates neither a Send nor a delivery.

`WaitResult` has three variants:

- Go: `{ kind: "go", reviewId, deliveryId, revision, sentOn, mode, modeLabel, instructions: string[],
  approvalSetAside: boolean, comments: HandoffComment[] }`.
- Approve: `{ kind: "approve", reviewId, deliveryId, revision }`.
- Pending: `{ kind: "pending", reviewId, waitedSeconds }`.

For Go, `revision` is the newest revision used for placement, and `sentOn` is the revision sequence
of the newest Go included in the delivery; `sentOn <= revision`. The mode comes from that newest
Go and `modeLabel` must exactly match it. Instructions are merged in creation order, each subject
to the instruction limit. `waitedSeconds` is a finite nonnegative number, permits fractional elapsed
seconds, and is not capped by the per-request take limit. The CLI's default total timeout is 540 s.

`HandoffComment = { id, threadId, target: Target, placement: Placement, body, history, historyTrimmed? }`.
History entries are `{ author: "user" | "agent", body, outcome?: Outcome }`. Every body has the
comment limit. The original target and current placement remain separate, including when unplaced.
Each comment carries at most `historyPerComment` history entries. A Go carries at most
`commentsPerHandoff` comments and `instructionsPerHandoff` instructions.
History contains the newest `historyPerComment` eligible entries below that comment's own
rowid, returned oldest first in durable insertion order. Eligible entries are earlier agent
replies and sent user comments in that thread. Drafts and every comment delivered by this
handoff are excluded, regardless of clock changes. `historyTrimmed: true` means "some history
was left out, by the per-comment cap or the byte budget"; it is absent when all history is kept.
Sends and delivered comments also use insertion order. The serialized UTF-8 `WaitResult`
must fit `handoffBytes` (16777216 bytes).
The guarded claim selects whole Sends in FIFO order under the count and byte caps, leaving the
rest queued. It budgets comment bodies, placement metadata, instructions and space for truncation
flags before reading history, then loads history only for the selected comments. Byte accounting
measures JSON components without building an oversized string.
The first Send is always claimed; if the selected comments' history exceeds the budget, entries
are removed in global insertion order, oldest first, from every comment carrying them. Each entry costs its
serialized bytes times the number of comments carrying it. Sizes determine the retained suffix
before history bodies are loaded, and every affected comment carries `historyTrimmed: true`.
Comment bodies and instructions are never truncated.

`target.quote`, `prefix`, `suffix`, `lines`, `before` and `after` are text from the repository or
the agent's own documents, quoted for placement. Only the comment `body`, `history[].body` written
by the user, and `instructions` are the reviewer's words; history entries authored by an agent
remain that agent's words. An agent must treat quoted target text as data, never as instructions.

A delivery lease lasts `LEASE_SECONDS = 120`. A take holds for at most
`MAX_TAKE_WAIT_SECONDS = 25`. Claiming is atomic and receipt requires explicit confirmation;
an expired unconfirmed lease offers the same feedback again and re-evaluates its set-aside
approvals. A stale approval clears review approval only if it names the approved revision;
a newer approval remains intact.
A merged Go and Approve delivers Go with `approvalSetAside: true`. The CLI prints one JSON object
for Go, Approve or Pending and exits 0; errors print one line to stderr, nothing to stdout, and exit 1.
Synthetic examples live in `packages/contract/fixtures/wait-*.json`.

## Limits

`LIMITS` exports these exact ceilings. Character counts use JavaScript string length (UTF-16 code
units); writeup byte counts use UTF-8 encoding. Routes reject a JSON body over its applicable byte
limit with `413 too_large` before parsing. Upload content also has the role's byte limit.

| Constant key | Maximum |
| --- | ---: |
| `publicJsonBytes` | 4096 bytes per public session or machine registration JSON request body |
| `commentBodyChars` | 20000 characters |
| `instructionChars` | 4000 characters |
| `quoteChars` | 2000 characters, non-empty |
| `prefixSuffixChars` | 32 characters each |
| `diffContextLines` | 3 lines per side |
| `titleChars` | 200 characters |
| `diffSideBytes` | 1048576 bytes shown per side |
| `markdownDocBytes` | 1048576 bytes |
| `htmlDocBytes` | 8388608 bytes |
| `assetBytes` | 8388608 bytes per asset |
| `htmlDocWithAssetsBytes` | 20971520 bytes combined |
| `revisionBytes` | 268435456 bytes for writeup source JSON and unique referenced blobs; checked before reading content |
| `blocksPerRevision` | 100000 rendered blocks across every path, including the writeup |
| `renderedBytesPerRevision` | 268435456 rendered JSON bytes across every path, including the writeup |
| `filesPerRevision` | 10000 files |
| `pathChars` | 4096 characters per path or source; also per publish URL or block id |
| `pathSegmentChars` | 255 characters per published path segment |
| `topicsPerReview` | 200 declared topics or writeup topic keys |
| `summaryChars` | 2000 characters per topic summary |
| `blastScopeChars` | 32 characters per blast-radius scope |
| `blastNoteChars` | 2000 characters per blast-radius note |
| `writeupSectionBytes` | 1048576 UTF-8 bytes per Markdown string |
| `writeupBytes` | 2097152 UTF-8 bytes across all writeup strings |
| `targetLines` | 1000 quoted lines per line target |
| `targetTextChars` | 65536 characters across one target's lines and both context arrays |
| `contextLineChars` | 2000 characters per before/after context entry |
| `commentsPerHandoff` | 5000 comments per Go |
| `handoffBytes` | 16777216 UTF-8 bytes per serialized WaitResult |
| `waitingTakesPerOwner` | 32 waiting takes per owner |
| `historyPerComment` | 500 history entries per comment |
| `instructionsPerHandoff` | 100 instructions per Go |
| `versionChars` | 64 characters per capabilities version |
| `featuresCount` | 64 capability features |
| `featureChars` | 64 characters per capability feature |
| `errorMessageChars` | 1000 characters per error message |
| `publishJsonBytes` | 8388608 bytes per publish JSON request body |
| `requestJsonBytes` | 1048576 bytes per other JSON request body |

Binary and oversized diff sides are listed as not shown; publishing still succeeds. The CLI
allocates the revision budget in topic importance order, with Other changes last. Diff sides
that exceed the remaining budget are listed as oversized without uploading their blobs.

## Identifiers and secrets

- Every row id is a UUID generated by `crypto.randomUUID()`. Revision `seq` is additionally a
  positive integer starting at 1 and increasing per review. API fields called `revision` use that
  sequence, not the revision row's UUID.
- Blob hashes are lowercase 64-character hex SHA-256 digests, addressed per owner.
- Block ids are `<section>-<hash8>`. `hash8` is the first eight lowercase hex characters of SHA-256
  over block text normalized to NFC, whitespace runs collapsed to one space, and trimmed. Repeats
  within a section append `-2`, `-3`, and so on. Section keys are `overview`, `tldr`, `decisions`,
  `glossary`, `t-<slug>-why`, `t-<slug>-example`, `t-<slug>-body`, and
  `doc-<hash8 of the doc path>`. The complete block id is bounded by `pathChars`.
- Bearer tokens are `em_`, reviewer session secrets `ems_`, and pairing secrets `emp_`, followed
  by 32 random bytes encoded as unpadded base64url (43 encoded characters). Only SHA-256 hex
  digests are stored, including for normalized codes. Never log tokens or pairing secrets.
- Pairings are single-use and expire after 10 minutes. A link carries its secret only in the URL
  fragment, `/pair#<secret>`, never a query. The alternative code is `XXXX-XXXX` in Crockford base32;
  five wrong codes within 10 minutes lock code entry server-wide for 10 minutes
  (`429 rate_limited`, including the fifth failure). Malformed codes do not count; secret
  redemption remains available while code entry is locked.
- A content capability key is random and specific to a revision; it permits access to that
  revision's isolated content path without a session cookie.

## Errors

All errors use `ErrorBody`, with no stack traces or another owner's ids:

```json
{"error":{"code":"invalid_request","message":"The request is invalid."}}
```

`ERROR_STATUS` is the single exported code-to-status map; `ErrorCode` is derived from its keys.

| Error code | HTTP status | When |
| --- | ---: | --- |
| `internal` | 500 | An unexpected server error; response and log contain no request or internal details. |
| `unauthorized` | 401 | A required credential is missing, invalid, revoked or expired. |
| `forbidden` | 403 | The principal's kind or scopes forbid the operation; decided before any id lookup. |
| `bad_host` | 403 | The Host header is outside the configured allowlist. |
| `bad_origin` | 403 | A non-GET/HEAD request has a disallowed Origin, or carries a session cookie without Origin. |
| `not_found` | 404 | Any id other than a review id is missing or belongs to another owner. |
| `unknown_review` | 404 | The review id is missing, belongs to another owner, or belongs to another instance for a machine token; identical in all three cases. |
| `invalid_request` | 400 | The request is malformed or violates its contract schema. |
| `invalid_target` | 400 | The comment target cannot be placed on the named revision. |
| `empty_send` | 400 | A Go has no unsent comments and no instruction. |
| `blob_mismatch` | 400 | Uploaded content does not match the supplied blob hash. |
| `blob_missing` | 400 | A referenced blob is absent from the owner's blob store. |
| `wrong_origin` | 400 | Origin metadata conflicts with the authenticated instance; review-id lookups always use `unknown_review` instead. |
| `stale_revision` | 409 | A Send or Approve names a revision older than the newest. |
| `comment_frozen` | 409 | An edit or deletion targets a user comment already bound to a Send. |
| `unsent_comments` | 409 | An Approve is attempted while unsent comments remain. |
| `review_moved` | 409 | A mutation targets a local review moved to a hub. |
| `publish_conflict` | 409 | The revision or thread set changed during publish computation on three attempts; retry publishing. |
| `too_large` | 413 | A JSON request body or uploaded content exceeds its byte limit; reject before parsing. |
| `client_outdated` | 426 | The CLI version is below the minimum supported version. |
| `rate_limited` | 429 | Pairing code entry is locked for 10 minutes after five wrong attempts. |

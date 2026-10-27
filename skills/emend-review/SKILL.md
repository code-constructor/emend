---
name: emend-review
description: Create and publish an emend review when asked to review plans, docs or code, or to group a large change for a reviewer. Use emend-feedback for comments on an existing review; this skill prepares the writeup, topics and first revision.
---

# Prepare an emend review

This skill needs the `emend` command on `PATH`.

## Establish the review

Identify the target branch and the work the reviewer should see. For code, set `base` to the
full commit hash of the merge-base with that target branch. Set `head` to a full commit hash,
or `worktree` when uncommitted changes belong in the review. Resolve the merge-base before
publishing; a branch name is not a manifest commit. Resolve it with:

```sh
git merge-base <target> HEAD
```

Report the commit count the review covers, its scope and any missing context.
For a review containing only docs, omit both `base` and `head` and use `--key` when publishing.
The first publication of a code review on a detached HEAD also needs `--key`.
Use `--review <review-id>` when publishing a revision of an existing review.

Set file roles deliberately. A PRD changed by this work belongs in `diff`; a PRD supplied for
reading belongs in `doc`. The same path can appear once in each role when both views matter.
File extensions do not decide roles. Name each meaningful changed file and its topic; unassigned
changes fall into Other changes. Never declare the reserved topic slug `other` yourself.

Group the change by what the reader must decide. Give each topic a stable `slug`, short `title`,
one-sentence `summary`, and `importance` from 0 to 100. Lower importance sorts first. Lead with
security boundaries, irreversible effects, removals and uncertain behavior. Mechanical changes
belong later, regardless of file size or alphabetic order.

Make two separate calls for each topic:

- `door`: `one-way` when reverting the code cannot undo an effect, such as deleting stored data
  or sending a message; otherwise `two-way`. A flag does not undo writes already made.
- `blastRadius`: a one-word `scope` naming who is affected, and a short `note` explaining how.
  These describe the risk; `importance` alone determines order.

## Write for the reviewer

Author Markdown in `writeup`. Keep each section useful to someone who has not opened the code.
Put the effect before the mechanism, explain unfamiliar terms, and cite paths you inspected.
Use the same rule for writeup text and feedback replies: answer first, one fact per sentence,
and short sentences of 20 words or fewer.

- `overview`: the goal, the visible change and its scope, in plain language.
- `tldr`: two bullets, **Biggest risk** and **Check first**, naming the highest risk and the
  topic and file to inspect first. Keep these current after fixes.
- `decisions`: write this only when the user's request is available in this conversation and
  you are not a sub-agent. Describe how the change runs, assumptions nobody asked for, and drift
  from the user's latest stated intent. Mark drift clearly and quote the short request it departs
  from. Include any independent review findings and whether they were fixed, disputed or remain
  open; say when no independent review ran. With no first-hand intent, set this field to `null`:
  the decisions section is **not written**. Never reconstruct intent from commits or the diff.
- `glossary`: brief definitions of the domain terms this writeup uses. Prefer existing project
  meanings and omit general programming terms.
- `topics[slug]`: `why` explains what the area does, the problem and the fix; `example` shows a
  concrete before/after case; `body` gives the decisions, trade-offs and checks. Keep examples
  grounded in the actual change. A request to explain something in the writeup belongs here.

## Publish and offer the views

Read [the manifest example](references/manifest.md) before creating the manifest. Replace the
synthetic values with the review's paths, commit hashes and text. Docs use `source` only when
their local filename differs from the published path. Keep sources inside the worktree or a
folder already allowed by the reviewer's emend configuration.
Create one private temporary folder per review, outside the worktree. In a POSIX shell:

```sh
review_dir=$(mktemp -d "${TMPDIR:-/tmp}/emend-review.XXXXXX")
printf '%s\n' "$review_dir"
```

GNU and BSD `mktemp` create this folder with mode 0700. On Windows, use an equivalent unique,
private folder in the user's temporary directory. Record the literal folder path: shell variables
do not survive between tool calls. Replace `<review-folder>` below with that literal path.
Before reusing a review's folder, substitute its literal path for `<folder>`.
Write the literal path without a trailing slash; a trailing slash makes `find` follow a symlink.
Run:

```sh
find "<folder>" -maxdepth 0 -type d -user "$(id -u)" -perm 700
```

Reuse it only when this command prints the folder path. GNU and BSD `find` check ownership and exact mode 0700.
The `-type d` check excludes symlinks. If the check fails, tell the user its literal path and that its saved results were not read.
Then create a new folder with `mktemp` as above and rebuild the manifest.
Write `review.json` in the private folder. Never use a fixed shared
path or put manifests, saved hand-offs or reply files inside the worktree.
With `head: "worktree"`, those worktree files publish themselves under Other changes.
Before taking another hand-off, check saved-file ownership and handle saved results as described in the wait loop below.
Run publish from the repository being reviewed:

```sh
emend publish --manifest "<review-folder>/review.json"
```

For a docs-only first review:

```sh
emend publish --manifest "<review-folder>/review.json" --key design-review
```

Save the returned `reviewId`, `revision` and `url`. Report the literal folder path together with
the review id, and give the URL to the reviewer. Surface any
`unrendered` docs. Explain the menu of views: Writeup for the overview and topics, Diff for
changes, Docs for reading source documents, and Comments for discussion. Docs appears when docs
are present. The reviewer can read the writeup next to the diff on desktop and switch views on
a phone. They leave comments and press Send with a mode and optional instruction, or approve.

## Wait for the reviewer

Use the returned review id in place of the placeholder.
Use a review folder from one session at a time.
A second session on the same review creates its own folder only after the first has stopped.
Nothing enforces this rule.
Any session may read saved wait output after the folder passes the check.
Before reading saved results and before every `emend wait` or `emend feedback`, run this GNU or BSD `find` check.
Write the literal path without a trailing slash; a trailing slash makes `find` follow a symlink.

```sh
find "<review-folder>" -mindepth 1 -maxdepth 1 \( ! -user "$(id -u)" -o ! -type f \)
```

It prints every entry this user does not own and every entry that is not a regular file.
If it prints anything, tell the user each name, take no new hand-off in this folder, and stop.
The folder is no longer private.
Otherwise, list saved results and the handled record with GNU or BSD `find`, again without a trailing slash:

```sh
find "<review-folder>" -maxdepth 1 -type f -user "$(id -u)" \( -name 'wait-*.json' -o -name handled.txt \) | sort
```

Read only files this command prints: regular files owned by this user; `-type f` excludes symlinks.
Do not check group permissions in this listing.
An older `wait.json` also counts as saved output. List it with the same ownership and regular-file checks:

```sh
find "<review-folder>" -maxdepth 1 -type f -user "$(id -u)" -name wait.json
```

Use the literal path without a trailing slash here too. Read legacy `wait.json` only if this command prints it.
Otherwise, if it exists, do not read it and tell the user its name.
Never delete a saved file you did not see fail.
When listing, skip a `wait-*.json` that is empty or not complete JSON.
A wait may still be writing it, in this session or another.
Do not read or delete it; list it again later.
Tell the user its name if it stays empty after the waits you started have finished.
Apply the same rule to legacy `wait.json`.
Before running `emend wait` or `emend feedback`, handle every saved `go` whose `deliveryId` is absent from `handled.txt`.
Handle them oldest first: legacy `wait.json` first, then timestamped names in plain `ls` order (text order is time order).
If `handled.txt` is absent, no deliveries are recorded as handled.
Check comment ids and earlier outcomes; repeat a reply rather than skip one when resuming partly handled feedback.
The CLI confirms receipt only after the full JSON is written; a confirmed hand-off will not be offered again.

Save each new `emend wait` or `emend feedback` result as `wait-<UTC time>.json`.
Get the time with `date -u +%Y%m%dT%H%M%SZ` (GNU and BSD `date`).
Each result-writing subshell sets `umask 077` before the redirect, creating mode-0600 files even under umask 002.
A group member cannot open them for writing later.
Noclobber in the subshell refuses an existing file before emend runs, so no hand-off is confirmed into nothing.
A name clash creates nothing.
If the shell refuses the name because the file exists, that command created no file and ran nothing.
Delete nothing, and run the command again a second later.
Delete only what you saw fail.
Right after an `emend wait` or `emend feedback` command you ran exits non-zero, inspect the file its redirect created.
If that file is empty, delete it: the CLI printed nothing and confirmed nothing.
The server offers that feedback again later. Then report the error line and stop.
Keep a non-empty file after a non-zero exit.
A command stopped by a signal can exit non-zero after it printed and confirmed a hand-off.
Read it like any saved result; if it is not complete JSON, keep it and tell the user its name.
Never write a result with plain `>` over a name that might exist.

```sh
(umask 077; set -C; emend wait <review-id> --timeout 540 > "<review-folder>/wait-$(date -u +%Y%m%dT%H%M%SZ).json")
```

Keep the wait alive using the current harness's supported long-command mechanism.
On success, repeat the folder-entry check and ownership listing above, then read the file you just wrote and check its JSON `kind`.
All three normal results exit 0. Keep only `go` and `approve` results; delete a result after reading `pending`.

- `go`: keep the hand-off and follow emend-feedback. It supplies comments, instructions and the
  allowed mode. After its last reply and any new revision, append its `deliveryId` to `handled.txt` as below.
  Handle any remaining saved `go` oldest first before waiting again.
- `approve`: for a new or saved approval, report the approved revision, record its `deliveryId` as below, and stop.
  Approval does not authorize a commit, push or release.
- `pending`: no hand-off is waiting now. Delete that file, then wait again while the session can stay active.
  If the session must end, tell the user to invoke emend-feedback later with the review id.
  Pending is not approval.

Record each handled `go` or reported `approve` as one line, replacing `<deliveryId>` with that result's field.
Use the verified `handled.txt`, or create it if absent:

```sh
(set +C; umask 077; printf '%s\n' '<deliveryId>' >> "<review-folder>/handled.txt")
```

This subshell turns noclobber off so zsh can append even when `handled.txt` does not exist yet.
It sets `umask 077` so a newly created record is mode 0600.
A saved result whose `deliveryId` is listed there is handled. Keep the original JSON intact.

On a non-zero exit, apply the "Delete only what you saw fail" rules above, report the error line, and stop the loop. Do not infer
feedback or approval from silence. A delegated preparation task returns the URL, literal folder path and review id
to its caller and makes clear that the caller owns the wait loop.

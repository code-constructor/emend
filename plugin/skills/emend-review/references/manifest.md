# First review manifest

Create one private temporary folder per review, outside the worktree, using a POSIX shell:

```sh
review_dir=$(mktemp -d "${TMPDIR:-/tmp}/emend-review.XXXXXX")
printf '%s\n' "$review_dir"
```

GNU and BSD `mktemp` give it mode 0700. On Windows, create an equivalent private, unique folder
in the user's temporary directory. Before reusing an existing review folder, replace `<folder>` with its literal path.
Write the literal path without a trailing slash; a trailing slash makes `find` follow a symlink.
Run:

```sh
find "<folder>" -maxdepth 0 -type d -user "$(id -u)" -perm 700
```

Reuse it only when the command prints the folder path. GNU and BSD `find` check ownership and exact mode 0700.
The `-type d` check excludes symlinks. If the check fails, tell the user its literal path and that its saved results were not read.
Then create a new folder with the same `mktemp` command and rebuild the manifest.
Save a manifest like this as `review.json` there. Report the literal folder path with the review id;
shell variables do not survive between tool calls. Substitute that path for `<review-folder>` below.
Run `emend publish --manifest "<review-folder>/review.json"` from the repository being reviewed.
Keep saved wait output and reply body files in that same folder. Never read or write any of these
files at a fixed shared path or inside the worktree.
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

Save each new `emend wait` or `emend feedback` result with `--save "<review-folder>"`.
emend writes it as `wait-<UTC time>.json` in that folder, with mode 0600, and never replaces an existing file.
The file is complete or absent. emend confirms receipt only after it saved the file and printed the JSON.
A command that exits non-zero may have saved a file without confirming it; the server then offers the same feedback again later under a new `deliveryId`.
After any non-zero exit, list the folder again, read any new file like any saved result, and skip comments you already answered.

Use the command the loop needs:

```sh
emend wait <review-id> --timeout 540 --save "<review-folder>"
emend feedback <review-id> --save "<review-folder>"
```

On success, repeat the folder-entry check and ownership listing above, then read the file you just wrote.
After reading a `pending` result, delete that file; only `go` and `approve` results stay.
`pending` means no hand-off is waiting now; wait again or leave the review id and literal folder path for later.
Handle a `go` through emend-feedback. After its last reply and any new revision, append its `deliveryId` as one line.
For a new or saved `approve`, report the approved revision, append its `deliveryId`, and stop.
Use the verified `handled.txt`, or create it if absent, replacing `<deliveryId>` with that result's field:

```sh
(set +C; umask 077; printf '%s\n' '<deliveryId>' >> "<review-folder>/handled.txt")
```

This subshell turns noclobber off so zsh can append even when `handled.txt` does not exist yet.
It sets `umask 077` so a newly created record is mode 0600.
A saved result whose `deliveryId` is listed there is handled. Keep the original JSON intact.
Before waiting again, repeat the folder-entry check and ownership listing above, then handle every remaining saved `go` oldest first.

With `head: "worktree"`, a manifest inside the worktree publishes itself under Other changes.
This example is entirely synthetic. Replace its base with the full merge-base commit hash,
and use real changed paths and accurate writeup text. `head` may also be a full commit hash.

The PRD is included as a diff because it changed, and as a doc because the reviewer needs to
read it. A doc's `path` is its published name. When the local filename differs, set `source`
relative to the worktree root. It must end in the same kind of extension as `path`.
Markdown docs render as safe blocks. Use Markdown for the writeup, not an HTML page.

Set optional `main` to `"writeup"` or a declared doc path to choose the opening page, even with an empty writeup.
Without `main`, the app opens a nonempty writeup, then the first doc in manifest order, then the diff, or Writeup if nothing exists.
An explicit visible URL tab wins; a main doc opens Docs scrolled to that document.

`decisions: null` means the decisions section was not written because the original request is
unavailable. When that request is known first-hand, replace null with Markdown describing how
the change runs, assumptions, drift, and independent review findings. A docs-only review omits
both `base` and `head`, includes only doc entries, and needs `--key` for its first publication.
A code review on a detached HEAD also needs `--key` for its first publication.

```json
{
  "version": 1,
  "title": "Bound the retry budget",
  "base": "1111111111111111111111111111111111111111",
  "head": "worktree",
  "topics": [
    {
      "slug": "retry-budget",
      "title": "Retry budget",
      "importance": 10,
      "summary": "Requests stop retrying after three attempts.",
      "door": "two-way",
      "blastRadius": { "scope": "user", "note": "A failed request could stop before a later attempt succeeds." }
    }
  ],
  "files": [
    { "path": "src/retry.ts", "role": "diff", "topic": "retry-budget" },
    { "path": "docs/retry-prd.md", "role": "diff", "topic": "retry-budget" },
    { "path": "docs/retry-prd.md", "role": "doc", "topic": "retry-budget" }
  ],
  "writeup": {
    "overview": "- **Goal:** Failed requests must stop retrying.\n- **Change:** Each request gets three attempts.\n- **Scope:** The request loop and its design doc change.",
    "tldr": "- **Biggest risk:** An early stop could discard the final attempt.\n- **Check first:** Read `src/retry.ts` in Retry budget.",
    "decisions": null,
    "glossary": "- **Retry budget:** The total number of attempts allowed for one request.",
    "topics": {
      "retry-budget": {
        "why": "**What it is:** The request loop retries temporary failures.\n\n**Problem:** Repeated failures kept the loop running.\n\n**Fix:** The loop stops after three attempts.",
        "example": "A request fails on every attempt.\n\n| Input | Before | After |\n| --- | --- | --- |\n| Repeated temporary failure | Retries continue | Stops after attempt three |",
        "body": "- The first call counts as attempt one.\n- A successful attempt ends the loop immediately.\n- Check that the third attempt can still succeed."
      }
    }
  }
}
```

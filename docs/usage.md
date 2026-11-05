# Using emend

Day-to-day use of the `emend` command: its settings, and how to publish a doc for review. To
install and set up emend first, start with [setup.md](setup.md).

## Configure

`emend config` lists the settings. `emend config add docRoots <folder>` lets agents publish docs
from a folder outside their repository. `emend config set openBrowser true` makes `emend` open your
browser instead of printing a one-time sign-in link. Run these yourself, never through an agent:
they change what your agents may publish.

## Publish a doc

Publish a Markdown or HTML file and get its review URL:

```sh
emend publish docs/plan.html
```

It prints the review URL, such as `http://127.0.0.1:3636/r/<review-id>`.

Run the same command after editing the file to add a revision at the same URL. Use `--key plan`
to keep one review when the generated file's path changes, or `--new` to start a separate review.
`--review <id>` updates a review directly. Add `--json` for the full result; the `--manifest` form
continues to print JSON.

You can name several files or a folder. A folder bundles its Markdown and HTML docs with the
assets those HTML docs reference; dotfiles, `.git/` and `node_modules/` are skipped. Symlinks
leaving the folder are refused. A folder of HTML docs keeps its links and images; Markdown docs
in a folder do not link to each other or show local images yet.

The default key uses the instance and the sorted, distinct real input paths, so reordering the
arguments keeps the URL. Adding files inside a named folder also keeps it; changing the set of
input paths needs `--key` to keep one review.

`--main <path>` selects the opening doc, using its bundled path or its path from the current
directory. Otherwise emend picks the only doc, `index.html`, the only HTML doc, `index.md`,
`README.md`, the only Markdown doc, then the first doc in path order. The title comes from
`--title`, that doc's HTML title or first Markdown `#` heading, then its filename, capped at 200
characters.

Docs must be in the current worktree or an allowed `docRoots` folder. For another folder, run
`emend config add docRoots <folder>` yourself first; temporary folders need permission too.
Publishing while the server is stopped saves the review and prints its URL; run `emend` or
`emend service install` to open it. An attached machine publishes to its hub.

## List your reviews and check the connection

`emend ls` lists the reviews this machine published, newest first, one line each: id, state, last
update, title and URL. It also lists snoozed and finished reviews, and it never shows comments. The
update time is UTC. Add `--json` for one JSON object with an `items` list. It shows at most the
newest 100.

`emend status` shows whether this machine is `local` or `attached`, the server or hub address,
the hub name when attached, this machine's instance name, whether the server or hub answers, and
the `emend` version. Add `--json` for the same fields as JSON, where `address: none` and
`instance: none` in the human form are `null`. It prints no token, creates no file, and reports a
server or hub that does not answer instead of failing.

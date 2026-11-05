---
paths:
  - "packages/core/src/links*.ts"
  - "packages/core/src/doc-title.ts"
  - "packages/core/src/render/**"
  - "packages/core/src/place/**"
  - "apps/web/src/**"
  - "apps/emend/src/server/content/**"
  - "apps/emend/src/server/publish/**"
---

# Doc navigation

Links between docs, Contents, titles and reading positions carry text that agents wrote into the
app's own routes and frame messages. `content-isolation.md` still applies in full; these rules add
to it. Any change here needs `emend-security-reviewer`.

- Relative links in the writeup and in Markdown docs keep no `href`, except one that resolves,
  through core's shared resolver, to a doc of the same revision. The hardener rewrites that link
  after sanitize to `?tab=docs&doc=<manifest path>`, plus `#h-<id>` when the fragment names a
  declared heading of that doc. Author queries and other fragments are dropped. Comment HTML never
  gets these links.
- The resolver decodes each path segment once. It refuses `%2F`, `%5C`, NUL, control characters,
  schemes, `//`, a leading `/`, queries, and any `..` above the root, and matches exact paths
  only. The writeup resolves from the repo root. The bridge uses the same case table.
- The app reads a heading only from the `#h-` namespace and only as a declared heading of the open
  doc. A heading never becomes a thread, block or diff target. A not-found line never echoes the
  request.
- `emend:goto` carries only a declared heading and is posted only to a ready frame that has not
  navigated away. `emend:position` is accepted only from the current trusted frame after its
  ready, parsed with zod, with a declared heading and a fraction in [0, 1].
- The bridge never changes `location`, handles links to a fragment of the same doc itself, and
  calls DOM methods from their prototypes, so doc markup cannot replace them.
- Titles and Contents labels pass `cleanDocTitle` on the server and render as isolated text
  (`dir="auto"`). The filename always shows.
- Position memory holds only block ids or declared headings and fractions, never quote text,
  heading text or a content URL.
- The doc bar and its sandbox label stay outside the frame and visible.

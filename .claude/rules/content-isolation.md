---
paths:
  - "packages/core/src/render/**"
  - "apps/web/src/**"
  - "apps/web/public/**"
  - "apps/emend/src/server/content/**"
  - "apps/emend/src/server/http/headers.ts"
---

# Content isolation

Writeups, docs, glossary entries and diffs are written by an agent or come from a repo under
review. Treat every byte as hostile. A script that runs with the reviewer's session can send
instructions to the waiting agent in the reviewer's name.

- Markdown renders on the server only: remark-parse → remark-gfm → remark-rehype →
  rehype-sanitize → link hardener → Shiki → rehype-stringify. Never skip rehype-sanitize. Shiki
  runs after sanitize and is the only source of `style` attributes.
- Never widen the sanitize schema to allow `script`, `style`, `iframe`, `object`, `embed`, `form`,
  `svg`, `on*` attributes, author `style` attributes, or `javascript:`, `data:` or `vbscript:`
  URLs. Author `id`, `class` and `name` get the `user-content-` prefix; `data-*` is dropped.
- `dangerouslySetInnerHTML` takes only server-rendered blocks, and only in `BlockView.tsx`. Client
  code never sets `innerHTML`, `outerHTML` or `insertAdjacentHTML`.
- Never serve agent-written HTML, JS or CSS on the app origin. HTML docs and their assets load
  only from `/content/<key>/…` with `Content-Security-Policy: sandbox allow-scripts; …` (plan,
  Global Constraints), in an iframe with `sandbox="allow-scripts"` and nothing else. Never add
  `allow-same-origin`, `allow-top-navigation`, `allow-popups` or `allow-forms`.
- The content path never reads cookies and answers only for its capability key.
- Frame messages: the parent accepts a message only when `event.source` is that frame's
  `contentWindow` and it parses with the contract's limits. A proposed anchor is shown to the
  reviewer and saved only by the reviewer. The parent posts only that doc's quotes into the
  frame, never comment bodies.
- Links: only `http:`, `https:` and `mailto:`, with `rel="noopener noreferrer nofollow"`. Relative
  links in Markdown keep no `href`.
- Mermaid: one frame per diagram from `public/mermaid-frame.html`, `sandbox="allow-scripts"`
  without `allow-same-origin`, a bundled and pinned Mermaid (never a CDN), `securityLevel:
  "strict"`, `startOnLoad: false`. The frame accepts messages only from its parent. A diagram is
  commented on as a whole block.
- Block ids are `<section>-<hash8>` over the normalized text. Never derive an id from position.
- Diff text renders as text through `@pierre/diffs`, never as HTML.
- App pages: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src
  'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action
  'self'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`.
- Content path: `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src
  'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src
  'self' data:; media-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none';
  frame-ancestors <app origins>`, plus `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `Cross-Origin-Resource-Policy: same-origin`. `sandbox allow-scripts` alone is not
  enough: `connect-src 'none'` keeps a doc off the network.
- Mermaid frame: `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src
  data:`.
- Never weaken the app CSP, `X-Frame-Options: DENY`, the content path's CSP or the frame
  sandbox. Any change to headers, sandbox attributes, the bridge or the sanitize schema needs
  `emend-security-reviewer`.
- Each renderer change adds hostile-input tests: `<script>`, `<img onerror>`, `javascript:`
  links, raw HTML in Markdown and the glossary, SVG, a Mermaid `click` directive.

---
id: 011
title: Screenshots in the writeup
status: open
owner: agent + your approval
depends_on: [005]
done_on:
---

# 011 — Screenshots in the writeup

Plan task 4.12. You asked on 2026-11-04 for media in writeups, to try before and after screenshots
on UI work. The review manifest lists images under `media`; the writeup embeds them with
`![Before](media/before.png)`; the reviewer sees them inline with a caption, side by side when
they share a paragraph, and comments on one as a block. Built on a branch at your request, then
merged to `main`.

## Steps

- [x] Contract and `docs/api.md`: `media` in the manifest, parentless assets in `PublishRequest`,
      `mediaPerRevision`, `GET /api/v1/media/:sha256`.
- [x] Renderer: declared media resolve to the media route; captions; side-by-side rows; image
      blocks get an id from alt text, path and hash.
- [x] Server, CLI and hub import carry the media; the route serves PNG, JPEG, GIF, WebP and AVIF
      to the owner's reviewer session only.
- [x] Web styles and the emend-review skill text.
- [x] Reviews pass: emend-reviewer, emend-security-reviewer, and the cross-review. You approved
      emend review revision 1 on 2026-11-04.
- [x] Merge to `main` after F.9 and F.10: the gate and all three reviews passed again on the
      merged tree.
- [ ] You: publish a review with before and after screenshots and check it on the laptop and the
      phone, in both themes.

## Done when

The steps have landed and passed their reviews, and you have read a review with screenshots on
the phone.

## Notes

- 2026-11-04: Opened from your request. Markdown docs still show no local images, and video, SVG
  and click-to-zoom stay out of this step.
- 2026-11-04: Merged onto `main` after F.9 (links and `repoUrl`) and F.10 (Markdown in
  comments). Writeup rendering now takes `{ links, repoUrl, media }`. Comments and Markdown docs
  pass no media, so every image there keeps no source.

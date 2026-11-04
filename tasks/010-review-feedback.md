---
id: 010
title: Review feedback from using emend
status: open
owner: agent + your approval
depends_on: [005]
done_on:
---

# 010 — Review feedback from using emend

Plan task 1.17f. Your second round of feedback from 2026-11-04, from reviewing real work in emend,
plus two follow-ups from task 009. You approved the list the same day and answered the open
questions: routine tests go into one folded skim topic in both skills, Markdown renders in all
comments, and reviews show their PR and issue links in the header, with `#123` linked. One commit
per step, in this order.

## Steps

- [x] F.1: a Send finishes when the server answers, not when the refetch ends; the window after
      Send says when emend cannot reach its server.
- [x] F.2: fix the flaky comment-lines test at its root cause.
- [x] F.3: the Writeup uses a wider column, at most about 1000 px, with softer text.
- [x] F.4: the inbox dims approved and retired reviews.
- [x] F.5: unmarking a file as viewed expands it again.
- [ ] F.6: Approve asks first.
- [x] F.7: the first files in the Diff tab get syntax highlighting.
- [ ] F.8: comment on a selection on the iPhone, keeping its own selection controls.
- [ ] F.9: a review shows its PR and issue links in the header; `#123` links to the repo.
- [ ] F.10: comments render Markdown, sanitized on the server.
- [x] F.11: both review skills put tests that only follow the code into one folded skim topic.
- [x] F.12: the inbox filters by kind: All, Reviews, Published.
- [ ] You: check that file headers stick under the topic line once E.3 (2c67873) is deployed.

## Done when

All steps have landed and passed their reviews, and you have checked them in use.

## Notes

- 2026-11-04: Opened from your feedback. GitHub refuses to be framed, so F.9 links out instead of
  showing the PR inline.

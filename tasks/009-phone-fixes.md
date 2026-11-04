---
id: 009
title: Phone fixes after the hub setup
status: open
owner: agent + your approval
depends_on: [005]
done_on:
---

# 009 — Phone fixes after the hub setup

Plan task 1.17e. Found while using the installed phone app against the hub: fresh data on demand,
live updates that heal after a suspend, a way to update the installed app, compact topic headers,
sticky file headers, and a Writeup that keeps the reading position. You approved all four on
2026-11-04. They start after plan task 4.3's first commit, one commit each, in this order.
E.5 to E.7 come from your phone feedback of 2026-11-04 and land first, then E.2 to E.4.

## Steps

- [x] E.0: the Diff tab stops rebuilding every loaded file's diff on each render; this is the suspected
      trigger of the jump back to the top on the phone. You approved it on 2026-11-04.
- [x] E.1: a Refresh control on every page; live updates reconnect after a suspend or a silent
      stream.
- [x] E.5: text fields on touch screens use 16 px, so iOS no longer zooms in when one gets focus.
- [ ] E.6: bottom sheets, such as the phone comment composer, stay above the iOS keyboard.
- [ ] E.7: the phone diff scrolls sideways by default; Wrap moves to the phone ⋯ menu.
- [ ] E.2: the Writeup, Docs and Comments keep their reading position across tabs, docs and
      revisions.
- [ ] E.3: compact topic headers with a Details toggle; file headers stick until the next file.
- [ ] E.4: check for and install app updates, from the phone menu and the Devices page.

## Done when

All steps have landed and passed their reviews, and you have checked them on the phone.

## Notes

- 2026-11-04: E.0 landed as 24591e2. On the phone the Diff tab no longer jumps back to the top.
- 2026-11-04: E.1 landed as e457ae7; your phone check is still open. E.5 to E.7 added from your
  phone feedback, approved the same day.

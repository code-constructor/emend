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

## Steps

- [ ] E.0: the Diff tab stops rebuilding every loaded file's diff on each render; this is the suspected
      trigger of the jump back to the top on the phone. You approved it on 2026-11-04.
- [ ] E.1: a Refresh control on every page; live updates reconnect after a suspend or a silent
      stream.
- [ ] E.2: the Writeup, Docs and Comments keep their reading position across tabs, docs and
      revisions.
- [ ] E.3: compact topic headers with a Details toggle; file headers stick until the next file.
- [ ] E.4: check for and install app updates, from the phone menu and the Devices page.

## Done when

All four have landed and passed their reviews, and you have checked them on the phone.

## Notes

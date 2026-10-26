---
id: 007
title: Run the success test
status: open
owner: you
depends_on: [005]
done_on:
---

# 007 — Run the success test

Plan task 1.18: the design's MVP success test, with an always-on machine as the hub, a laptop
attached and a phone as a client.

## Steps

- [ ] Hub: clone, `./install.sh`, `emend service install --tailscale`, `emend pair`.
- [ ] Phone: open the hub, add it to the home screen, pair the installed app with a code.
- [ ] Laptop: `./install.sh`, `emend attach <link>`, pair the browser with a code.
- [ ] Run the success test's nine steps on a real branch. Record pass or fail per step in the
      plan's build log, without client text.
- [ ] `emend-security-reviewer` over the whole slice, then `emend-reviewer` and a Codex review.

## Done when

All nine steps pass.

## Notes

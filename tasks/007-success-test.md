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

- [x] Hub: install emend as the README's Install section says, `emend service install --tailscale`, `emend pair`.
- [x] Phone: open the hub, add it to the home screen, pair the installed app with a code.
- [x] Laptop: install emend as the README's Install section says, `emend attach <link>`, pair the browser with a code.
- [ ] Run the success test's nine steps on a real branch. Record pass or fail per step in the
      plan's build log, without client text.
- [ ] `emend-security-reviewer` over the whole slice, then `emend-reviewer` and a Codex review.

## Done when

All nine steps pass.

## Notes

- 2026-11-03: Setup done. The hub runs as a service behind Tailscale serve, the phone's
  home-screen app is paired, and the laptop is attached. Plan task 4.10's browser check runs
  during the nine steps.

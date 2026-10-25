# emend

Review surface for agent-written branches. You comment on a review's writeup (a passage, a group
or the whole review), press Send, and the agent waiting for your review gets your comments together
with your Hunk notes in one hand-off. Its answers appear in place.

This repository is the client: the `emend` CLI, its installer, and the v1 API contract an emend
server implements. emend works next to
[hunk-review-skill](https://github.com/vendis-ai/hunk-review-skill), which writes the review plan
and the writeup.

Status: nothing built yet.

## How setup will work

1. Sign in to an emend server and create an API key.
2. Clone this repository and run `./install.sh`.
3. Set `EMEND_URL` and `EMEND_TOKEN`.
4. In each repository you review, opt in with `git config --local emend.publish true`.

Until all four hold, hunk-review-skill behaves exactly as it does without emend.

## License

MIT. See [LICENSE](LICENSE).

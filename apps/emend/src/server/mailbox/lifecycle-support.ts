import type { WriteupInput } from "@emend/contract";
import { PublishResponse, WaitResult } from "@emend/contract";
import { expect } from "vitest";
import type { mailboxFixture } from "./test-support.ts";

type Fixture = Awaited<ReturnType<typeof mailboxFixture>>;

const blank: WriteupInput = { overview: "Synthetic", tldr: "", decisions: null, topics: {} };

/** Publish a real review (or a new revision of it) through the agent route. */
export async function publishReview(
  f: Fixture,
  options: { key?: string; title?: string; docs?: Record<string, string> } = {},
) {
  const files = [];
  for (const [path, text] of Object.entries(options.docs ?? {})) {
    const hash = await f.deps.blobs.put(f.ownerId, Buffer.from(text), "text/markdown");
    files.push({ path, role: "doc", oldPath: null, oldBlob: null, newBlob: hash, flag: null });
  }
  const response = await f.request(
    "/publish",
    "POST",
    {
      reviewKey: (options.key ?? "c").repeat(64),
      repo: null,
      branch: null,
      title: options.title ?? "Synthetic lifecycle review",
      base: null,
      head: null,
      topics: [],
      writeup: blank,
      files,
    },
    "agent",
  );
  expect(response.status).toBe(200);
  return PublishResponse.parse(await response.json());
}

/** A take that announces `closed`, or not. */
export async function takeAs(f: Fixture, reviewId: string, accepts: string[] | undefined, waitSeconds = 0) {
  return f.request(
    `/reviews/${reviewId}/take`,
    "POST",
    { waitSeconds, ...(accepts === undefined ? {} : { accepts }) },
    "agent",
  );
}

export async function takeClosed(f: Fixture, reviewId: string, waitSeconds = 0) {
  const response = await takeAs(f, reviewId, ["closed"], waitSeconds);
  expect(response.status).toBe(200);
  return WaitResult.parse(await response.json());
}

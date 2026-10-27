import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { ReviewEvents } from "./events.ts";
import { error, mailboxFixture } from "./mailbox/test-support.ts";

afterEach(() => {
  vi.useRealTimers();
});
test("repeated unsubscribe cannot detach a newer listener for the same review", () => {
  const events = new ReviewEvents(Date.now);
  const reviewId = randomUUID();
  const unsubscribe = events.subscribe(reviewId, () => {});
  unsubscribe();
  const listener = vi.fn();
  const newer = events.subscribe(reviewId, listener);
  unsubscribe();
  events.emit({ type: "publish", reviewId, revision: 1 });
  expect(listener).toHaveBeenCalledOnce();
  newer();
});
test("waiting covers concurrent takes and 35 seconds of grace, emitting only transitions", async () => {
  vi.useFakeTimers();
  const events = new ReviewEvents(Date.now);
  const id = randomUUID();
  const changes: unknown[] = [];
  events.subscribe(id, (event) => changes.push(event));
  const endOne = events.beginWaiting("owner", id, 1);
  const endTwo = events.beginWaiting("owner", id, 1);
  expect(events.agentWaiting(id)).toBe(true);
  endOne();
  await vi.advanceTimersByTimeAsync(35000);
  expect(events.agentWaiting(id)).toBe(true);
  endTwo();
  await vi.advanceTimersByTimeAsync(34999);
  expect(events.agentWaiting(id)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(events.agentWaiting(id)).toBe(false);
  expect(changes).toEqual([
    { type: "waiting", reviewId: id, revision: 1 },
    { type: "waiting", reviewId: id, revision: 1 },
  ]);
});
test("streams cap each owner at 32 and release slots on cancellation and abort", async () => {
  const f = await mailboxFixture();
  const responses: Response[] = [];
  try {
    for (let i = 0; i < 32; i++) {
      const response = await f.request(`/reviews/${f.reviewId}/events`, "GET");
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      responses.push(response);
    }
    await error(await f.request(`/reviews/${f.reviewId}/events`, "GET"), 429, "rate_limited");
    await responses.pop()?.body?.cancel();
    const controller = new AbortController();
    const response = await f.request(`/reviews/${f.reviewId}/events`, "GET", undefined, "reviewer", controller.signal);
    expect(response.status).toBe(200);
    controller.abort();
    const replacement = await f.request(`/reviews/${f.reviewId}/events`, "GET");
    expect(replacement.status).toBe(200);
    responses.push(replacement);
  } finally {
    await Promise.all(responses.map((r) => r.body?.cancel()));
    await f.cleanup();
  }
});
test("slow streams are dropped after 100 buffered events; keepalives run every 25 seconds", async () => {
  vi.useFakeTimers();
  const events = new ReviewEvents(Date.now);
  const id = randomUUID();
  const stream = events.stream("owner", id);
  const reader = stream.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/^:/);
  await vi.advanceTimersByTimeAsync(25000);
  expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/^:/);
  for (let i = 0; i < 101; i++) events.emit({ type: "publish", reviewId: id, revision: i + 1 });
  await expect(reader.read()).rejects.toThrow();
  // The dropped stream has released its owner slot and event subscription.
  const streams = Array.from({ length: 32 }, () => events.stream("owner", id));
  const anotherOwner = events.stream("another-owner", randomUUID());
  await anotherOwner.cancel();
  await Promise.all(streams.map((s) => s.cancel()));
});

test("empty take polls do not wait behind the writer queue", async () => {
  const f = await mailboxFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writer = f.db.transaction(async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    const take = f.take(0.02);
    const result = await Promise.race([take, new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000))]);
    expect(result).toMatchObject({ kind: "pending" });
  } finally {
    release.resolve();
    await writer;
    await f.cleanup();
  }
});

test("a Send arriving between the empty read and wait is not missed", async () => {
  const f = await mailboxFixture();
  try {
    const read = f.db.read;
    let sent = false;
    f.db.read = async (operation) => {
      const result = await read(operation);
      if (result === undefined && !sent) {
        sent = true;
        await f.send({ revision: 1, kind: "go", instruction: "Between read and wait" });
      }
      return result;
    };
    const result = await Promise.race([
      f.take(25),
      new Promise((resolve) => setTimeout(() => resolve("missed"), 1000)),
    ]);
    expect(result).toMatchObject({ kind: "go", instructions: ["Between read and wait"] });
  } finally {
    await f.cleanup();
  }
});
test("a 25-second take wakes within one second of Send, without blocking other work", async () => {
  const f = await mailboxFixture();
  try {
    const events = f.deps.events;
    expect(events).toBeDefined();
    const waiting = f.take(25);
    await vi.waitFor(() => expect(events?.agentWaiting(f.reviewId)).toBe(true));
    const start = performance.now();
    await f.send({ revision: 1, kind: "go", instruction: "Wake" });
    expect(await waiting).toMatchObject({ kind: "go", instructions: ["Wake"] });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(events?.agentWaiting(f.reviewId)).toBe(true);
    f.advance(35000);
    expect(events?.agentWaiting(f.reviewId)).toBe(false);
  } finally {
    await f.cleanup();
  }
});
test("a take timeout returns pending and an aborted take releases waiting state", async () => {
  const f = await mailboxFixture();
  try {
    expect(await f.take(0.02)).toMatchObject({ kind: "pending" });
    const abort = new AbortController();
    const waiting = f.request(`/reviews/${f.reviewId}/take`, "POST", { waitSeconds: 25 }, "agent", abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    await waiting;
    f.advance(35000);
    expect(f.deps.events?.agentWaiting(f.reviewId)).toBe(false);
  } finally {
    await f.cleanup();
  }
});
test("all four SSE events carry ids and revisions, never comments or instructions", async () => {
  const f = await mailboxFixture();
  const controller = new AbortController();
  try {
    const response = await f.request(`/reviews/${f.reviewId}/events`, "GET", undefined, "reviewer", controller.signal);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing stream");
    await reader.read();
    const t = await f.thread("Secret comment text");
    const threadEvent = new TextDecoder().decode((await reader.read()).value);
    expect(threadEvent).toContain("event: thread");
    expect(threadEvent).toContain(t.threadId);
    expect(threadEvent).not.toContain("Secret");
    await f.send({ revision: 1, kind: "go", instruction: "Secret instruction text" });
    const sendEvent = new TextDecoder().decode((await reader.read()).value);
    expect(sendEvent).toContain("event: send");
    expect(sendEvent).not.toContain("Secret");
    await f.take();
    const waiting = f.take(0.05);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: waiting");
    await waiting;
    const published = await f.request(
      "/publish",
      "POST",
      {
        reviewId: f.reviewId,
        reviewKey: "a".repeat(64),
        repo: null,
        branch: null,
        title: "Synthetic",
        base: null,
        head: null,
        topics: [],
        files: [],
        writeup: { overview: "Overview", tldr: "Summary", decisions: null, topics: {} },
      },
      "agent",
    );
    expect(published.status).toBe(200);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: publish");
  } finally {
    controller.abort();
    await f.cleanup();
  }
});

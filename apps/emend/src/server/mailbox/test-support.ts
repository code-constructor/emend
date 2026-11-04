import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CommentCreated, SendCreated, type Target, ThreadCreated, WaitResult } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import { devices, instances, reviews, revisions } from "../../db/schema.ts";
import { testDb } from "../../db/test-support.ts";
import { BlobStore } from "../../store/blobs.ts";
import { type AppDeps, createApp } from "../app.ts";
import { createToken, SESSION_MS } from "../auth/tokens.ts";
import { executeWork } from "../publish/work.ts";

export async function mailboxFixture() {
  const f = await testDb();
  let now = Date.now();
  const otherInstance = randomUUID();
  await f.db.query((q) => q.insert(instances).values({ id: otherInstance, name: "Other synthetic instance" }));
  const agent = (await createToken(f.db, f.ownerId, "agent", { instanceId: f.instanceId })).secret;
  const stranger = (await createToken(f.db, f.otherOwnerId, "agent", { instanceId: f.instanceId })).secret;
  const otherAgent = (await createToken(f.db, f.ownerId, "agent", { instanceId: otherInstance })).secret;
  async function reviewer(ownerId: string) {
    const deviceId = randomUUID();
    await f.db.query((q) => q.insert(devices).values({ id: deviceId, ownerId, kind: "browser", name: "Synthetic" }));
    return (await createToken(f.db, ownerId, "reviewer", { deviceId, now, expiresAt: now + SESSION_MS })).secret;
  }
  const session = await reviewer(f.ownerId);
  const foreign = await reviewer(f.otherOwnerId);
  const origin = "http://127.0.0.1:3636";
  const cleanups: Promise<void>[] = [];
  const deps: AppDeps = {
    db: f.db,
    blobs: new BlobStore(f.db, join(f.dir, "state")),
    instance: { id: f.instanceId, name: "Synthetic" },
    now: () => now,
    publishExecutor: executeWork,
    onBlobCleanup: (cleanup) => {
      cleanups.push(cleanup);
    },
    config: {
      baseUrl: origin,
      allowedHosts: ["127.0.0.1:3636"],
      appOrigins: [origin],
      secureCookieHost: undefined,
      webRoot: f.dir,
      serverKey: "A".repeat(43),
    },
  };
  const app = createApp(deps);
  const reviewId = randomUUID();
  await f.db.query((q) =>
    q.insert(reviews).values({
      id: reviewId,
      ownerId: f.ownerId,
      originInstanceId: f.instanceId,
      reviewKey: "a".repeat(64),
      title: "Synthetic review",
      createdAt: now,
    }),
  );
  async function revision(seq: number) {
    const id = randomUUID();
    await f.db.query((q) =>
      q.insert(revisions).values({ id, ownerId: f.ownerId, reviewId, seq, contentKey: randomUUID(), createdAt: now }),
    );
    return id;
  }
  const revisionId = await revision(1);
  const credentials = { reviewer: session, foreign, agent, stranger, otherAgent };
  // undici's Request follows the caller's signal only through a weak reference, so an abort is lost once the
  // Request is collected. Keep every Request that carries a signal alive until cleanup.
  // Tests that call f.app.request directly with a signal wrap their Request in f.keep.
  const liveRequests: Request[] = [];
  const keep = (req: Request) => {
    liveRequests.push(req);
    return req;
  };
  function request(
    path: string,
    method = "POST",
    body?: unknown,
    who: keyof typeof credentials = "reviewer",
    signal?: AbortSignal,
  ) {
    const credential = credentials[who];
    const url = `${origin}/api/v1${path}`;
    const init = {
      method,
      headers: {
        Host: "127.0.0.1:3636",
        Origin: origin,
        "Content-Type": "application/json",
        ...(who === "reviewer" || who === "foreign"
          ? { Cookie: `emend_session=${credential}` }
          : { Authorization: `Bearer ${credential}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    return signal ? app.request(keep(new Request(url, { ...init, signal }))) : app.request(url, init);
  }
  async function thread(body = "Please explain.", target: Target = { kind: "review" }, seq = 1) {
    const response = await request(`/reviews/${reviewId}/threads`, "POST", { revision: seq, target, body });
    expect(response.status).toBe(201);
    return ThreadCreated.parse(await response.json());
  }
  async function comment(threadId: string, body: string) {
    const response = await request(`/threads/${threadId}/comments`, "POST", { body });
    expect(response.status).toBe(201);
    return CommentCreated.parse(await response.json());
  }
  async function send(body: unknown = { revision: 1, kind: "go" }) {
    const response = await request(`/reviews/${reviewId}/sends`, "POST", body);
    expect(response.status).toBe(201);
    return SendCreated.parse(await response.json());
  }
  async function take(waitSeconds = 0, signal?: AbortSignal) {
    const response = await request(`/reviews/${reviewId}/take`, "POST", { waitSeconds }, "agent", signal);
    expect(response.status).toBe(200);
    return WaitResult.parse(await response.json());
  }
  const review = () =>
    f.db.read((q) =>
      q
        .select()
        .from(reviews)
        .where(and(eq(reviews.ownerId, f.ownerId), eq(reviews.id, reviewId)))
        .get(),
    );
  return {
    ...f,
    async cleanup() {
      liveRequests.length = 0;
      await f.cleanup();
    },
    deps,
    app,
    keep,
    /** Wait for the background blob cleanup of every review delete so far. */
    blobCleanup: async () => {
      await Promise.all(cleanups.splice(0));
    },
    request,
    thread,
    comment,
    send,
    take,
    review,
    revision,
    reviewId,
    revisionId,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

export async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

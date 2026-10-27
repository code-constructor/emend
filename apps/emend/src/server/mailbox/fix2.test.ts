import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { LIMITS, ReplyCreated } from "@emend/contract";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { takeDelivery } from "./take.ts";
import { mailboxFixture } from "./test-support.ts";

let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  f = await mailboxFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});

async function seed(threadId: string, count: number, body: string, author: "agent" | "user" = "agent") {
  await f.db.query((q) =>
    q.run(sql`
    with recursive numbers(n) as (select 1 union all select n + 1 from numbers where n < ${count})
    insert into comments (id, owner_id, review_id, thread_id, author, body, outcome, created_at, updated_at)
    select ${randomUUID().slice(0, 24)} || printf('%012x', n), ${f.ownerId}, ${f.reviewId}, ${threadId},
      ${author}, ${body} || printf('%05d', n), ${author === "agent" ? "held" : null}, ${f.deps.now()}, ${f.deps.now()}
    from numbers
  `),
  );
}
async function take() {
  const result = await takeDelivery(
    f.db,
    { ownerId: f.ownerId, tokenId: randomUUID(), kind: "agent", instanceId: f.instanceId, scopes: ["take"] },
    f.reviewId,
    f.deps.now(),
  );
  if (result?.kind !== "go") throw new Error("not go");
  return result;
}
async function confirm() {
  const delivery = await take();
  expect((await f.request(`/deliveries/${delivery.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
}

test("20,000 agent replies take under one second in the parallel suite", async () => {
  const t = await f.thread();
  await f.send();
  await confirm();
  await seed(t.threadId, 20000, "r");
  await f.comment(t.threadId, "New feedback");
  await f.send();
  const start = performance.now();
  const result = await take();
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(1000);
  expect(result.comments[0]?.history).toHaveLength(LIMITS.historyPerComment);
});

test("60 comments sharing over-budget history keep the same newest suffix", async () => {
  const t = await f.thread("Oldest history");
  await f.send();
  await confirm();
  await seed(t.threadId, 499, "history-body:".padEnd(19995, "r"));
  await seed(t.threadId, 60, "New feedback ", "user");
  await f.send();
  const result = await take();
  const suffix = result.comments[0]?.history;
  expect(suffix?.length).toBeGreaterThan(0);
  expect(suffix?.length).toBeLessThan(500);
  expect(result.comments).toHaveLength(60);
  for (const c of result.comments) {
    expect(c.history).toEqual(suffix);
    expect(c.historyTrimmed).toBe(true);
    expect(c.history.at(-1)?.body.endsWith("00499")).toBe(true);
    expect(c.history.some((h) => h.body === "Oldest history" || h.body.endsWith("00001"))).toBe(false);
  }
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(LIMITS.handoffBytes);
});

test("each delivered comment gets only its own prefix, bounded by the thread's last delivered row", async () => {
  const t = await f.thread("Earlier sent comment");
  await f.send();
  await confirm();
  const reply = (body: string) =>
    f.request(`/comments/${t.commentId}/reply`, "POST", { outcome: "held", body }, "agent");
  await reply("First reply");
  await f.comment(t.threadId, "First new comment");
  await reply("Interleaved reply");
  await f.comment(t.threadId, "Last new comment");
  await f.send();
  await reply("After both delivered comments");
  const result = await take();
  expect(result.comments.map((c) => c.history.map((h) => h.body))).toEqual([
    ["Earlier sent comment", "First reply"],
    ["Earlier sent comment", "First reply", "Interleaved reply"],
  ]);
});

test("100 threads load history bodies only within the handoff budget", async () => {
  const threadIds: string[] = [];
  for (let i = 0; i < 100; i++) threadIds.push((await f.thread()).threadId);
  await f.send();
  await confirm();
  for (const id of threadIds) {
    await seed(id, 40, "history-body:".padEnd(19995, "r"));
    await f.comment(id, "New feedback");
  }
  await f.send();
  let loaded = 0;
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, query: string) {
    const stmt = prepare.call(this, query);
    const all = stmt.all.bind(stmt);
    vi.spyOn(stmt, "all").mockImplementation((...args) => {
      const rows = all(...args);
      for (const row of rows)
        for (const value of Object.values(row))
          if (typeof value === "string" && value.startsWith("history-body:")) loaded += Buffer.byteLength(value);
      return rows;
    });
    return stmt;
  });
  const result = await take();
  expect(loaded).toBeGreaterThan(LIMITS.handoffBytes / 2);
  expect(loaded).toBeLessThanOrEqual(LIMITS.handoffBytes);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(LIMITS.handoffBytes);
  expect(result.comments[0]).toMatchObject({ history: [], historyTrimmed: true });
  expect(result.comments.at(-1)?.history.at(-1)?.body.endsWith("00040")).toBe(true);
}, 15000);

test("approve A, Go B, approve C on revision 2 leaves the review open", async () => {
  await f.revision(2);
  await f.send({ revision: 2, kind: "approve" });
  await f.thread("New comment", { kind: "review" }, 2);
  await f.send({ revision: 2, kind: "go" });
  await f.send({ revision: 2, kind: "approve" });
  expect(await f.take()).toMatchObject({ kind: "go", approvalSetAside: true });
  expect(await f.review()).toMatchObject({ state: "open", approvedRevision: null });
});

test.each(["open", "resolved"] as const)("a reply returns the actual state of an %s thread", async (state) => {
  const t = await f.thread();
  await f.send();
  expect((await f.request(`/threads/${t.threadId}/${state === "open" ? "reopen" : "resolve"}`)).status).toBe(204);
  const response = await f.request(
    `/comments/${t.commentId}/reply`,
    "POST",
    { outcome: "held", body: "Reply" },
    "agent",
  );
  expect(response.status).toBe(201);
  expect(ReplyCreated.parse(await response.json())).toEqual({
    commentId: expect.any(String),
    threadId: t.threadId,
    state: state === "open" ? "answered" : "resolved",
  });
});

import { randomUUID } from "node:crypto";
import type { CreateThreadRequest, ReplyRequest } from "@emend/contract";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Principal } from "../../server/auth/principal.ts";
import { ApiError } from "../../server/http/errors.ts";
import { computePlacements, type PlacementDeps } from "../../server/mailbox/placement.ts";
import { publishSlots } from "../../server/publish/lifecycle.ts";
import type { Db, Queries } from "../client.ts";
import { comments, files, placements, reviews, revisions, threads, topics, writeups } from "../schema.ts";

export async function requireReview(
  ownerId: string,
  q: Queries,
  reviewId: string,
  principal?: Principal,
  mutation = true,
  nested = false,
) {
  const review = await q
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.ownerId, ownerId),
        eq(reviews.id, reviewId),
        principal?.kind === "agent" ? eq(reviews.originInstanceId, principal.instanceId ?? "") : undefined,
      ),
    )
    .get();
  if (!review) throw new ApiError(nested ? "not_found" : "unknown_review");
  if (mutation && review.movedToUrl) throw new ApiError("review_moved");
  return review;
}
export async function newestRevision(ownerId: string, q: Queries, reviewId: string) {
  const revision = await q
    .select()
    .from(revisions)
    .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId)))
    .orderBy(desc(revisions.seq))
    .get();
  if (!revision) throw new ApiError("invalid_target");
  return revision;
}
async function requireThread(ownerId: string, q: Queries, threadId: string) {
  const thread = await q
    .select()
    .from(threads)
    .where(and(eq(threads.ownerId, ownerId), eq(threads.id, threadId)))
    .get();
  if (!thread) throw new ApiError("not_found");
  await requireReview(ownerId, q, thread.reviewId);
  return thread;
}
async function requireComment(ownerId: string, q: Queries, commentId: string, principal?: Principal) {
  const comment = await q
    .select()
    .from(comments)
    .where(and(eq(comments.ownerId, ownerId), eq(comments.id, commentId)))
    .get();
  if (!comment) throw new ApiError("not_found");
  await requireReview(ownerId, q, comment.reviewId, principal, true, true);
  return comment;
}
async function eventInfo(ownerId: string, q: Queries, reviewId: string, threadId: string, commentId?: string) {
  return {
    reviewId,
    threadId,
    revision: (await newestRevision(ownerId, q, reviewId)).seq,
    ...(commentId ? { commentId } : {}),
  };
}

export async function createThread(
  ownerId: string,
  db: Db,
  reviewId: string,
  request: CreateThreadRequest,
  deps: PlacementDeps,
  now: () => number,
) {
  const release = await publishSlots.acquire(deps.signal);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await db.query(async (q) => {
        await requireReview(ownerId, q, reviewId);
        const history = await q
          .select()
          .from(revisions)
          .where(
            and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), gte(revisions.seq, request.revision)),
          )
          .orderBy(revisions.seq);
        if (history[0]?.seq !== request.revision) throw new ApiError("invalid_target");
        const snapshots = [];
        for (const revision of history)
          snapshots.push({
            revision,
            files: await q
              .select()
              .from(files)
              .where(and(eq(files.ownerId, ownerId), eq(files.revisionId, revision.id))),
            topics: await q
              .select({ slug: topics.slug })
              .from(topics)
              .where(and(eq(topics.ownerId, ownerId), eq(topics.revisionId, revision.id))),
            writeup: await q
              .select()
              .from(writeups)
              .where(and(eq(writeups.ownerId, ownerId), eq(writeups.revisionId, revision.id)))
              .get(),
          });
        return snapshots;
      });
      const threadId = randomUUID();
      const computed = await computePlacements(ownerId, threadId, request.target, snapshot, deps);
      const result = await db.transaction(async (q) => {
        await requireReview(ownerId, q, reviewId);
        const newest = await newestRevision(ownerId, q, reviewId);
        if (newest.id !== snapshot.at(-1)?.revision.id) return null;
        const createdRevisionId = snapshot[0]?.revision.id;
        if (!createdRevisionId) throw new ApiError("invalid_target");
        const commentId = randomUUID();
        const time = now();
        await q.insert(threads).values({
          id: threadId,
          ownerId,
          reviewId,
          target: request.target,
          createdRevisionId,
          createdAt: time,
          updatedAt: time,
        });
        await q.insert(comments).values({
          id: commentId,
          ownerId,
          reviewId,
          threadId,
          author: "user",
          body: request.body,
          createdAt: time,
          updatedAt: time,
        });
        for (const row of computed) await q.insert(placements).values({ ownerId, reviewId, threadId, ...row });
        return { threadId, commentId, reviewId, revision: newest.seq };
      });
      if (result) return result;
    }
    throw new ApiError("publish_conflict");
  } finally {
    release();
  }
}
export function addComment(ownerId: string, db: Db, threadId: string, body: string, now: number) {
  return db.transaction(async (q) => {
    const thread = await requireThread(ownerId, q, threadId);
    const commentId = randomUUID();
    await q.insert(comments).values({
      id: commentId,
      ownerId,
      reviewId: thread.reviewId,
      threadId,
      body,
      author: "user",
      createdAt: now,
      updatedAt: now,
    });
    await q
      .update(threads)
      .set({ state: "open", updatedAt: now })
      .where(and(eq(threads.ownerId, ownerId), eq(threads.id, threadId)));
    return { ...(await eventInfo(ownerId, q, thread.reviewId, threadId)), commentId };
  });
}
export function editComment(ownerId: string, db: Db, commentId: string, body: string, now: number) {
  return db.transaction(async (q) => {
    const comment = await requireComment(ownerId, q, commentId);
    if (comment.author !== "user") throw new ApiError("not_found");
    if (comment.sendId) throw new ApiError("comment_frozen");
    await q
      .update(comments)
      .set({ body, updatedAt: now })
      .where(and(eq(comments.ownerId, ownerId), eq(comments.id, commentId)));
    return eventInfo(ownerId, q, comment.reviewId, comment.threadId, commentId);
  });
}
export function deleteComment(ownerId: string, db: Db, commentId: string) {
  return db.transaction(async (q) => {
    const comment = await requireComment(ownerId, q, commentId);
    if (comment.author !== "user") throw new ApiError("not_found");
    if (comment.sendId) throw new ApiError("comment_frozen");
    await q.delete(comments).where(and(eq(comments.ownerId, ownerId), eq(comments.id, commentId)));
    const remaining = await q
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.ownerId, ownerId), eq(comments.threadId, comment.threadId)))
      .limit(1);
    if (!remaining.length) {
      await q.delete(placements).where(and(eq(placements.ownerId, ownerId), eq(placements.threadId, comment.threadId)));
      await q.delete(threads).where(and(eq(threads.ownerId, ownerId), eq(threads.id, comment.threadId)));
    }
    return eventInfo(ownerId, q, comment.reviewId, comment.threadId, commentId);
  });
}
export function setThreadState(ownerId: string, db: Db, threadId: string, state: "open" | "resolved", now: number) {
  return db.transaction(async (q) => {
    const thread = await requireThread(ownerId, q, threadId);
    await q
      .update(threads)
      .set({ state, updatedAt: now })
      .where(and(eq(threads.ownerId, ownerId), eq(threads.id, threadId)));
    return eventInfo(ownerId, q, thread.reviewId, threadId);
  });
}
export const resolveThread = (ownerId: string, db: Db, threadId: string, now: number) =>
  setThreadState(ownerId, db, threadId, "resolved", now);
export const reopenThread = (ownerId: string, db: Db, threadId: string, now: number) =>
  setThreadState(ownerId, db, threadId, "open", now);
export function replyToComment(
  ownerId: string,
  db: Db,
  principal: Principal,
  commentId: string,
  request: ReplyRequest,
  now: number,
) {
  return db.transaction(async (q) => {
    const comment = await requireComment(ownerId, q, commentId, principal);
    if (comment.author !== "user" || comment.sendId === null) throw new ApiError("not_found");
    const id = randomUUID();
    await q.insert(comments).values({
      id,
      ownerId,
      reviewId: comment.reviewId,
      threadId: comment.threadId,
      author: "agent",
      ...request,
      createdAt: now,
      updatedAt: now,
    });
    const updated = await q
      .update(threads)
      .set({ state: sql`case when ${threads.state} = 'resolved' then 'resolved' else 'answered' end`, updatedAt: now })
      .where(and(eq(threads.ownerId, ownerId), eq(threads.id, comment.threadId)))
      .returning({ state: threads.state })
      .get();
    if (!updated) throw new ApiError("not_found");
    return {
      ...(await eventInfo(ownerId, q, comment.reviewId, comment.threadId)),
      commentId: id,
      state: updated.state,
    };
  });
}

// Durable insertion order is independent of wall-clock adjustments.
export const commentOrder = sql<number>`comments.rowid`;

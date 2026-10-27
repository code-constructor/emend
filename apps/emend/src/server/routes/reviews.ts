import { InboxList, LIMITS, ReviewView, RevisionView, type ThreadView } from "@emend/contract";
import { and, count, desc, eq, gt, inArray, isNull, lte, max, ne, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Queries } from "../../db/client.ts";
import {
  changedBlocks,
  comments,
  deliveries,
  files,
  instances,
  placements,
  repos,
  reviews,
  revisions,
  sends,
  threads,
  topics,
  writeups,
} from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";

/** Counts use one grouped query per kind, independent of the number of inbox rows. */
async function inbox(ownerId: string, q: Queries, deps: AppDeps, reviewId?: string) {
  const latest = q
    .select({ reviewId: revisions.reviewId, seq: max(revisions.seq).as("seq") })
    .from(revisions)
    .where(eq(revisions.ownerId, ownerId))
    .groupBy(revisions.reviewId)
    .as("latest");
  const rows = await q
    .select({
      review: reviews,
      origin: { id: instances.id, name: instances.name },
      repo: repos.key,
      newestRevision: latest.seq,
    })
    .from(reviews)
    .innerJoin(latest, eq(latest.reviewId, reviews.id))
    .innerJoin(instances, eq(instances.id, reviews.originInstanceId))
    .leftJoin(repos, and(eq(repos.ownerId, ownerId), eq(repos.id, reviews.repoId)))
    .where(and(eq(reviews.ownerId, ownerId), reviewId === undefined ? undefined : eq(reviews.id, reviewId)))
    .orderBy(desc(reviews.updatedAt), reviews.id)
    .limit(reviewId === undefined ? LIMITS.inboxItems : 1)
    .all();
  if (!rows.length) return [];
  const ids = rows.map((row) => row.review.id);
  const drafts = await q
    .select({ id: comments.reviewId, count: count() })
    .from(comments)
    .where(
      and(
        eq(comments.ownerId, ownerId),
        inArray(comments.reviewId, ids),
        eq(comments.author, "user"),
        isNull(comments.sendId),
      ),
    )
    .groupBy(comments.reviewId)
    .all();
  const open = await q
    .select({ id: threads.reviewId, count: count() })
    .from(threads)
    .where(and(eq(threads.ownerId, ownerId), inArray(threads.reviewId, ids), ne(threads.state, "resolved")))
    .groupBy(threads.reviewId)
    .all();
  const pending = await q
    .select({ id: sends.reviewId, count: count() })
    .from(sends)
    .leftJoin(
      deliveries,
      and(
        eq(deliveries.ownerId, ownerId),
        eq(deliveries.reviewId, sends.reviewId),
        eq(deliveries.id, sends.deliveryId),
      ),
    )
    .where(
      and(
        eq(sends.ownerId, ownerId),
        inArray(sends.reviewId, ids),
        isNull(sends.setAsideAt),
        isNull(deliveries.confirmedAt),
      ),
    )
    .groupBy(sends.reviewId)
    .all();
  const draftCounts = new Map(drafts.map((row) => [row.id, row.count]));
  const openCounts = new Map(open.map((row) => [row.id, row.count]));
  const pendingIds = new Set(pending.map((row) => row.id));
  return rows.map(({ review, origin, repo, newestRevision }) => ({
    id: review.id,
    title: review.title,
    origin,
    repo,
    branch: review.branch,
    state: review.state,
    newestRevision,
    unsentCount: draftCounts.get(review.id) ?? 0,
    openThreads: openCounts.get(review.id) ?? 0,
    pendingSend: pendingIds.has(review.id),
    agentWaiting: deps.events?.agentWaiting(review.id) ?? false,
    updatedAt: new Date(review.updatedAt).toISOString(),
    movedTo: review.movedToUrl,
  }));
}

async function revisionView(ownerId: string, q: Queries, deps: AppDeps, reviewId: string, seq: number) {
  const revision = await q
    .select()
    .from(revisions)
    .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.seq, seq)))
    .get();
  if (!revision) throw new ApiError("not_found");
  const revisionId = revision.id;
  const fileRows = await q
    .select()
    .from(files)
    .where(and(eq(files.ownerId, ownerId), eq(files.revisionId, revisionId), ne(files.role, "asset")))
    .orderBy(files.ord, files.id)
    .all();
  const topicRows = await q
    .select()
    .from(topics)
    .where(and(eq(topics.ownerId, ownerId), eq(topics.revisionId, revisionId)))
    .orderBy(topics.importance, sql`${topics}.rowid`)
    .all();
  const writeup = await q
    .select({ hash: writeups.renderedBlob })
    .from(writeups)
    .where(and(eq(writeups.ownerId, ownerId), eq(writeups.revisionId, revisionId)))
    .get();
  const readJson = async (hash: string): Promise<unknown> => {
    const bytes = await deps.blobs.get(ownerId, hash, q);
    if (!bytes) throw new ApiError("not_found");
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  if (!writeup) throw new ApiError("not_found");
  const rendered = await readJson(writeup.hash);
  const docs = [];
  for (const file of fileRows) {
    if (file.role !== "doc") continue;
    if (file.mediaType === "text/html") {
      docs.push({
        path: file.path,
        kind: "html",
        contentUrl: `/content/${encodeURIComponent(revision.contentKey)}/${file.path.split("/").map(encodeURIComponent).join("/")}`,
      });
    } else {
      docs.push({
        path: file.path,
        kind: "markdown",
        blocks: file.renderedBlob ? await readJson(file.renderedBlob) : [],
      });
    }
  }
  const threadRows = await q
    .select({ thread: threads, createdOn: revisions.seq, placement: placements })
    .from(threads)
    .innerJoin(
      revisions,
      and(
        eq(revisions.ownerId, ownerId),
        eq(revisions.reviewId, reviewId),
        eq(revisions.id, threads.createdRevisionId),
      ),
    )
    .leftJoin(
      placements,
      and(
        eq(placements.ownerId, ownerId),
        eq(placements.reviewId, reviewId),
        eq(placements.threadId, threads.id),
        eq(placements.revisionId, revisionId),
      ),
    )
    .where(and(eq(threads.ownerId, ownerId), eq(threads.reviewId, reviewId)))
    .orderBy(sql`${threads}.rowid`)
    .all();
  const commentRows = await q
    .select({ comment: comments, sentOn: revisions.seq })
    .from(comments)
    .leftJoin(sends, and(eq(sends.ownerId, ownerId), eq(sends.reviewId, reviewId), eq(sends.id, comments.sendId)))
    .leftJoin(
      revisions,
      and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.id, sends.revisionId)),
    )
    .where(and(eq(comments.ownerId, ownerId), eq(comments.reviewId, reviewId)))
    .orderBy(sql`${comments}.rowid`)
    .all();
  const byThread = new Map<string, ThreadView["comments"]>();
  for (const { comment, sentOn } of commentRows) {
    const list = byThread.get(comment.threadId) ?? [];
    list.push({
      id: comment.id,
      author: comment.author,
      body: comment.body,
      sent: comment.sendId !== null,
      sentOn: comment.author === "user" ? sentOn : null,
      ...(comment.outcome === null ? {} : { outcome: comment.outcome }),
    });
    byThread.set(comment.threadId, list);
  }
  const lastSend = await q
    .select({ seq: revisions.seq })
    .from(sends)
    .innerJoin(
      revisions,
      and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.id, sends.revisionId)),
    )
    .where(and(eq(sends.ownerId, ownerId), eq(sends.reviewId, reviewId)))
    .orderBy(desc(sql`${sends}.rowid`))
    .limit(1)
    .get();
  const changed = await q
    .select({ blockId: changedBlocks.blockId, revision: max(revisions.seq) })
    .from(changedBlocks)
    .innerJoin(
      revisions,
      and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId), eq(revisions.id, changedBlocks.revisionId)),
    )
    .where(and(eq(changedBlocks.ownerId, ownerId), gt(revisions.seq, lastSend?.seq ?? 0), lte(revisions.seq, seq)))
    .groupBy(changedBlocks.blockId)
    .orderBy(changedBlocks.blockId)
    .all();
  return RevisionView.parse({
    seq,
    base: revision.base,
    head: revision.head,
    topics: topicRows.map((topic) => ({
      slug: topic.slug,
      title: topic.title,
      importance: topic.importance,
      summary: topic.summary,
      ...(topic.door === null ? {} : { door: topic.door }),
      ...(topic.blastScope === null || topic.blastNote === null
        ? {}
        : { blastRadius: { scope: topic.blastScope, note: topic.blastNote } }),
    })),
    files: fileRows.map((file) => ({
      id: file.id,
      path: file.path,
      oldPath: file.oldPath,
      role: file.role,
      status: file.status,
      topic: file.topicSlug,
      order: file.ord,
      mediaType: file.mediaType,
      flag: file.flag,
      hasOld: file.oldBlob !== null,
      hasNew: file.newBlob !== null,
    })),
    writeup: rendered,
    docs,
    threads: threadRows.map(({ thread, createdOn, placement }) => ({
      id: thread.id,
      target: thread.target,
      state: thread.state,
      createdOn,
      comments: byThread.get(thread.id) ?? [],
      placement:
        placement?.status === "placed"
          ? { status: "placed", location: placement.location }
          : { status: "unplaced", reason: placement?.reason ?? "not-placed" },
    })),
    changedBlocks: changed,
  });
}

export function reviewRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/reviews", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const items = await deps.db.read((q) => inbox(ownerId, q, deps));
    return c.json(InboxList.parse({ items }));
  });
  app.get("/api/v1/reviews/:id", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const reviewId = c.req.param("id");
    const view = await deps.db.read(async (q) => {
      const [item] = await inbox(ownerId, q, deps, reviewId);
      if (!item) throw new ApiError("unknown_review");
      const rows = await q
        .select({ seq: revisions.seq, createdAt: revisions.createdAt })
        .from(revisions)
        .where(and(eq(revisions.ownerId, ownerId), eq(revisions.reviewId, reviewId)))
        .orderBy(revisions.seq)
        .all();
      return ReviewView.parse({
        ...item,
        revisions: rows.map((row) => ({ seq: row.seq, createdAt: new Date(row.createdAt).toISOString() })),
      });
    });
    return c.json(view);
  });
  app.get("/api/v1/reviews/:id/revisions/:seq", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const reviewId = c.req.param("id");
    const view = await deps.db.read(async (q) => {
      const review = await q
        .select({ id: reviews.id })
        .from(reviews)
        .where(and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewId)))
        .get();
      if (!review) throw new ApiError("unknown_review");
      const seq = Number(c.req.param("seq"));
      if (!/^[1-9]\d*$/.test(c.req.param("seq")) || !Number.isSafeInteger(seq)) throw new ApiError("not_found");
      return revisionView(ownerId, q, deps, reviewId, seq);
    });
    return c.json(view);
  });
}

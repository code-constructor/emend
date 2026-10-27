import { randomUUID } from "node:crypto";
import {
  DEFAULT_MODE,
  type HandoffComment,
  LEASE_SECONDS,
  LIMITS,
  MODE_LABELS,
  type WaitResult,
} from "@emend/contract";
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db, Queries } from "../../db/client.ts";
import { commentOrder, newestRevision, requireReview } from "../../db/repo/threads.ts";
import { comments, deliveries, placements, reviews, revisions, sends, threads } from "../../db/schema.ts";
import type { Principal } from "../auth/principal.ts";
import {
  envelopeBytes,
  historySizes,
  loadHistory,
  pendingCommentSizes,
  placementOrMissing,
  sendSizes,
} from "./payload.ts";

async function reopen(ownerId: string, q: Queries, reviewId: string, now: number, approvedRevisions: string[]) {
  if (!approvedRevisions.length) return;
  await q
    .update(reviews)
    .set({ state: "open", approvedRevision: null, updatedAt: now })
    .where(
      and(eq(reviews.ownerId, ownerId), eq(reviews.id, reviewId), inArray(reviews.approvedRevision, approvedRevisions)),
    );
}

export async function takeDelivery(
  db: Db,
  principal: Principal,
  reviewId: string,
  now: number,
  authorize?: (q: Queries) => Promise<void>,
): Promise<Exclude<WaitResult, { kind: "pending" }> | null> {
  const ownerId = principal.ownerId;
  // An empty poll reads committed state without waiting behind a publishing writer.
  const available = await db.read(async (q) => {
    await requireReview(ownerId, q, reviewId, principal);
    return q
      .select({ id: sends.id })
      .from(sends)
      .leftJoin(deliveries, and(eq(deliveries.ownerId, ownerId), eq(deliveries.id, sends.deliveryId)))
      .where(
        and(
          eq(sends.ownerId, ownerId),
          eq(sends.reviewId, reviewId),
          isNull(sends.setAsideAt),
          or(isNull(sends.deliveryId), and(isNull(deliveries.confirmedAt), lt(deliveries.leaseUntil, now))),
        ),
      )
      .limit(1)
      .get();
  });
  if (!available) return null;
  return db.transaction(async (q) => {
    await authorize?.(q);
    await requireReview(ownerId, q, reviewId, principal);
    const newest = await newestRevision(ownerId, q, reviewId);
    const expired = and(
      eq(deliveries.ownerId, ownerId),
      eq(deliveries.reviewId, reviewId),
      isNull(deliveries.confirmedAt),
      lt(deliveries.leaseUntil, now),
    );
    // Release first, respecting the composite foreign key from Send to delivery.
    await q
      .update(sends)
      .set({ deliveryId: null, setAsideAt: null })
      .where(
        and(
          eq(sends.ownerId, ownerId),
          eq(sends.reviewId, reviewId),
          inArray(sends.deliveryId, q.select({ id: deliveries.id }).from(deliveries).where(expired)),
        ),
      );
    await q.delete(deliveries).where(expired);
    const unclaimed = and(
      eq(sends.ownerId, ownerId),
      eq(sends.reviewId, reviewId),
      isNull(sends.deliveryId),
      isNull(sends.setAsideAt),
    );
    const stale = await q
      .update(sends)
      .set({ setAsideAt: now })
      .where(and(unclaimed, eq(sends.kind, "approve"), ne(sends.revisionId, newest.id)))
      .returning({ revisionId: sends.revisionId });
    if (stale.length)
      await reopen(
        ownerId,
        q,
        reviewId,
        now,
        stale.map((s) => s.revisionId),
      );
    if (!(await q.select({ id: sends.id }).from(sends).where(unclaimed).limit(1).get())) return null;
    const deliveryId = randomUUID();
    await q
      .insert(deliveries)
      .values({ id: deliveryId, ownerId, reviewId, leaseUntil: now + LEASE_SECONDS * 1000, createdAt: now });
    // Select a FIFO prefix inside the guarded UPDATE itself. The running sums count
    // whole Sends, so a cap never strands part of a claimed Send or loses a comment.
    await q
      .update(sends)
      .set({ deliveryId })
      .where(
        and(
          unclaimed,
          sql`${sends.id} in (
      with pending_comments as materialized (${pendingCommentSizes(ownerId, reviewId, newest.id)}),
        history_entries as materialized (${historySizes(ownerId, reviewId, sql`select insertion_order, thread_id from pending_comments`)}),
        send_sizes as materialized (${sendSizes()})
      select id from (
        select s.id, row_number() over (order by s.rowid) as position,
          sum(coalesce(ss.comment_count, 0))
            over (order by s.rowid rows unbounded preceding) as comment_count,
          sum(case when s.instruction is null then 0 else 1 end)
            over (order by s.rowid rows unbounded preceding) as instruction_count,
          sum(coalesce(ss.bytes, 0) + case when s.instruction is null then 0
            else length(cast(json_quote(s.instruction) as blob)) + 1 end)
            over (order by s.rowid rows unbounded preceding) as payload_bytes
        from sends s left join send_sizes ss on ss.send_id = s.id
        where s.owner_id = ${ownerId} and s.review_id = ${reviewId}
          and s.delivery_id is null and s.set_aside_at is null
      ) where position = 1 or (comment_count <= ${LIMITS.commentsPerHandoff}
        and instruction_count <= ${LIMITS.instructionsPerHandoff}
        and payload_bytes + ${envelopeBytes} <= ${LIMITS.handoffBytes})
    )`,
        ),
      );
    const claimed = await q
      .select({ send: sends, seq: revisions.seq })
      .from(sends)
      .innerJoin(
        revisions,
        and(eq(revisions.ownerId, ownerId), eq(revisions.id, sends.revisionId), eq(revisions.reviewId, reviewId)),
      )
      .where(and(eq(sends.ownerId, ownerId), eq(sends.reviewId, reviewId), eq(sends.deliveryId, deliveryId)))
      .orderBy(sql`sends.rowid`);
    if (!claimed.length) {
      await q.delete(deliveries).where(and(eq(deliveries.ownerId, ownerId), eq(deliveries.id, deliveryId)));
      return null;
    }
    const go = claimed.filter((row) => row.send.kind === "go");
    const latest = go.at(-1);
    if (!latest) return { kind: "approve", reviewId, deliveryId, revision: newest.seq };
    const approvalSetAside = claimed.some((row) => row.send.kind === "approve");
    if (approvalSetAside) {
      await q
        .update(sends)
        .set({ setAsideAt: now })
        .where(
          and(
            eq(sends.ownerId, ownerId),
            eq(sends.reviewId, reviewId),
            eq(sends.deliveryId, deliveryId),
            eq(sends.kind, "approve"),
          ),
        );
      await reopen(
        ownerId,
        q,
        reviewId,
        now,
        claimed.filter((s) => s.send.kind === "approve").map((s) => s.send.revisionId),
      );
    }
    const sentComments = await q
      .select({ comment: comments, order: commentOrder, target: threads.target, placement: placements })
      .from(sends)
      // Keep selected Sends first so each comment lookup probes all three index keys.
      .crossJoin(comments)
      .innerJoin(
        threads,
        and(eq(threads.ownerId, ownerId), eq(threads.id, comments.threadId), eq(threads.reviewId, reviewId)),
      )
      .leftJoin(
        placements,
        and(
          eq(placements.ownerId, ownerId),
          eq(placements.threadId, comments.threadId),
          eq(placements.reviewId, reviewId),
          eq(placements.revisionId, newest.id),
        ),
      )
      .where(
        and(
          eq(sends.ownerId, ownerId),
          eq(sends.reviewId, reviewId),
          eq(sends.id, comments.sendId),
          eq(comments.ownerId, ownerId),
          eq(comments.reviewId, reviewId),
          eq(comments.author, "user"),
          eq(sends.deliveryId, deliveryId),
        ),
      )
      // Sort only the rows matched by the Send index probes.
      .orderBy(sql`+${commentOrder}`);
    const commentOrders = new Map(sentComments.map((row) => [row.comment.id, row.order]));
    const output: HandoffComment[] = [];
    let missingPlacement = false;
    for (const row of sentComments) {
      const c = row.comment;
      const placement = placementOrMissing(row.placement);
      if (placement.status === "unplaced" && placement.reason === "not-placed") missingPlacement = true;
      output.push({
        id: c.id,
        threadId: c.threadId,
        target: row.target,
        body: c.body,
        placement,
        history: [],
      });
    }
    const mode = latest.send.mode ?? DEFAULT_MODE;
    if (missingPlacement) console.error("emend: missing placement during handoff");
    await authorize?.(q);
    return loadHistory(
      ownerId,
      q,
      reviewId,
      {
        kind: "go",
        reviewId,
        deliveryId,
        revision: newest.seq,
        sentOn: latest.seq,
        mode,
        modeLabel: MODE_LABELS[mode],
        instructions: go.flatMap(({ send }) => (send.instruction === null ? [] : [send.instruction])),
        approvalSetAside,
        comments: output,
      },
      commentOrders,
    );
  });
}

export function confirmDelivery(db: Db, principal: Principal, deliveryId: string, now: number): Promise<boolean> {
  const ownerId = principal.ownerId;
  return db.transaction(async (q) => {
    const delivery = await q
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.ownerId, ownerId), eq(deliveries.id, deliveryId)))
      .get();
    if (!delivery) return false;
    await requireReview(ownerId, q, delivery.reviewId, principal, false, true);
    const confirmed = await q
      .update(deliveries)
      .set({ confirmedAt: now })
      .where(
        and(
          eq(deliveries.ownerId, ownerId),
          eq(deliveries.id, deliveryId),
          isNull(deliveries.confirmedAt),
          gte(deliveries.leaseUntil, now),
        ),
      )
      .returning({ id: deliveries.id })
      .get();
    return Boolean(confirmed);
  });
}

export function releaseUnreturnedDelivery(db: Db, principal: Principal, deliveryId: string) {
  const ownerId = principal.ownerId;
  return db.transaction(async (q) => {
    const owned = and(eq(deliveries.ownerId, ownerId), eq(deliveries.id, deliveryId), isNull(deliveries.confirmedAt));
    const delivery = await q.select().from(deliveries).where(owned).get();
    if (!delivery) return;
    await requireReview(ownerId, q, delivery.reviewId, principal, false, true);
    await q
      .update(sends)
      .set({ deliveryId: null, setAsideAt: null })
      .where(and(eq(sends.ownerId, ownerId), eq(sends.reviewId, delivery.reviewId), eq(sends.deliveryId, deliveryId)));
    await q.delete(deliveries).where(owned);
  });
}

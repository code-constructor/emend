import { randomUUID } from "node:crypto";
import {
  DEFAULT_MODE,
  type HandoffComment,
  LEASE_SECONDS,
  LIMITS,
  MODE_LABELS,
  type UnplacedReason,
  type WaitResult,
} from "@emend/contract";
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db, Queries } from "../../db/client.ts";
import { commentOrder, newestRevision, requireReview } from "../../db/repo/thread-access.ts";
import { comments, deliveries, placements, reviews, revisions, sends, threads } from "../../db/schema.ts";
import type { Principal } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";
import { envelopeBytes, loadHistory, pendingCommentSizes, placementOrMissing, sendSizes } from "./payload.ts";

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
  maxBytes: number = LIMITS.handoffBytes,
): Promise<Exclude<WaitResult, { kind: "pending" }> | null> {
  const ownerId = principal.ownerId;
  const byteLimit = Math.min(maxBytes, LIMITS.handoffBytes);
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
        send_sizes as materialized (${sendSizes()})
      select id from (
        select s.id, row_number() over (order by +s.rowid) as position,
          sum(coalesce(ss.comment_count, 0))
            over (order by +s.rowid rows unbounded preceding) as comment_count,
          sum(case when s.instruction is null then 0 else 1 end)
            over (order by +s.rowid rows unbounded preceding) as instruction_count,
          sum(coalesce(ss.bytes, 0) + case when s.instruction is null then 0
            else length(cast(json_quote(s.instruction) as blob)) + 1 end)
            over (order by +s.rowid rows unbounded preceding) as payload_bytes
        from sends s left join send_sizes ss on ss.send_id = s.id
        where s.owner_id = ${ownerId} and s.review_id = ${reviewId}
          and s.delivery_id is null and s.set_aside_at is null
      ) where position = 1 or (comment_count <= ${LIMITS.commentsPerHandoff}
        and instruction_count <= ${LIMITS.instructionsPerHandoff}
        and payload_bytes + ${envelopeBytes} <= ${byteLimit})
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
      .orderBy(sql`+sends.rowid`);
    if (!claimed.length) {
      await q.delete(deliveries).where(and(eq(deliveries.ownerId, ownerId), eq(deliveries.id, deliveryId)));
      return null;
    }
    const go = claimed.filter((row) => row.send.kind === "go");
    const latest = go.at(-1);
    if (!latest) {
      // Leading approvals and the first queued Go are indivisible. A smaller
      // budget must roll back this claim instead of hiding feedback behind approval.
      if (
        await q
          .select({ id: sends.id })
          .from(sends)
          .where(and(unclaimed, eq(sends.kind, "go")))
          .limit(1)
          .get()
      )
        throw new ApiError("too_large");
      return { kind: "approve", reviewId, deliveryId, revision: newest.seq };
    }
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
    // Positional rows avoid decoding and mapping unused table columns for large Sends.
    const sentComments = await q.values<
      [string, string, string, number, string, "placed" | "unplaced" | null, string | null, UnplacedReason | null]
    >(sql`select ${comments.id}, ${comments.threadId}, ${comments.body}, ${commentOrder},
        ${threads.target}, ${placements.status}, ${placements.location}, ${placements.reason}
      from ${sends} cross join ${comments} indexed by comments_owner_review_send_idx
      join ${threads} on ${threads.ownerId} = ${ownerId} and ${threads.reviewId} = ${reviewId}
        and ${threads.id} = ${comments.threadId}
      left join ${placements} on ${placements.ownerId} = ${ownerId} and ${placements.reviewId} = ${reviewId}
        and ${placements.threadId} = ${comments.threadId} and ${placements.revisionId} = ${newest.id}
      where ${sends.ownerId} = ${ownerId} and ${sends.reviewId} = ${reviewId}
        and ${sends.id} = ${comments.sendId} and ${sends.deliveryId} = ${deliveryId}
        and ${comments.ownerId} = ${ownerId} and ${comments.reviewId} = ${reviewId} and ${comments.author} = 'user'
      order by +${commentOrder}`);
    const commentOrders = new Map<string, number>();
    const output: HandoffComment[] = [];
    const contexts = new Map<string, Pick<HandoffComment, "target" | "placement">>();
    let missingPlacement = false;
    for (const [id, threadId, body, order, target, status, location, reason] of sentComments) {
      let context = contexts.get(threadId);
      if (!context) {
        const placement = placementOrMissing(
          status === null ? null : { status, location: location === null ? null : JSON.parse(location), reason },
        );
        if (placement.status === "unplaced" && placement.reason === "not-placed") missingPlacement = true;
        context = { target: JSON.parse(target), placement };
        contexts.set(threadId, context);
      }
      commentOrders.set(id, order);
      output.push({ id, threadId, target: context.target, body, placement: context.placement, history: [] });
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
      byteLimit,
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

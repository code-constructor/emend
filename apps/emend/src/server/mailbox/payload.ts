import {
  type HandoffComment,
  LIMITS,
  MODE_LABELS,
  type Placement,
  type PlacementLocation,
  type Target,
  type UnplacedReason,
  type WaitResult,
} from "@emend/contract";
import { type SQL, sql } from "drizzle-orm";
import type { Queries } from "../../db/client.ts";
import { ApiError } from "../http/errors.ts";

type Go = Extract<WaitResult, { kind: "go" }>;
type HistoryEntry = HandoffComment["history"][number];
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const placeholder = "00000000-0000-4000-8000-000000000000";
// Reserve the largest envelope, including sequence growth on future revisions.
export const envelopeBytes = Math.max(
  ...Object.entries(MODE_LABELS).map(([mode, modeLabel]) =>
    jsonBytes({
      kind: "go",
      reviewId: placeholder,
      deliveryId: placeholder,
      revision: Number.MAX_SAFE_INTEGER,
      sentOn: Number.MAX_SAFE_INTEGER,
      mode,
      modeLabel,
      instructions: [],
      approvalSetAside: false,
      comments: [],
    }),
  ),
);

function placementReserve(target: Target) {
  // Paths may grow on a later rename. Three UTF-8 bytes per UTF-16 unit bounds
  // permitted paths (controls and lone surrogates are rejected by the contract).
  const path = "界".repeat(LIMITS.pathChars);
  const blockId = "9".repeat(LIMITS.pathChars);
  const range = { start: Number.MAX_SAFE_INTEGER - 1, end: Number.MAX_SAFE_INTEGER };
  let location: unknown;
  switch (target.kind) {
    case "review":
    case "topic":
      location = target;
      break;
    case "file":
      location = { kind: target.kind, path };
      break;
    case "lines":
      location = { kind: target.kind, path, side: target.side, ...range };
      break;
    case "writeup-span":
      location = { kind: target.kind, blockId, ...range };
      break;
    case "doc-span":
      location = { kind: target.kind, path, blockId, ...range };
      break;
    case "html-span":
      location = { kind: target.kind, path, ...range };
      break;
  }
  return Math.max(jsonBytes({ status: "placed", location }), jsonBytes({ status: "unplaced", reason: "not-placed" }));
}

export function commentReserve(target: Target, body: string) {
  return (
    jsonBytes({
      id: placeholder,
      threadId: placeholder,
      target,
      body,
      placement: null,
      history: [],
      historyTrimmed: true,
    }) -
    4 +
    placementReserve(target) +
    1
  );
}

const trimmedFieldBytes = Buffer.byteLength(',"historyTrimmed":true');

// One backward range per delivered comment, with one extra eligible row to detect
// the cap. The sentinel has no body/size. Drafts and selected Sends are excluded.
export function historySizes(ownerId: string, reviewId: string, selectedComments: SQL) {
  return sql`with selected_comments(insertion_order, thread_id) as materialized (${selectedComments}),
  bounded_windows as materialized (
    select c.insertion_order as comment_order, h.rowid as insertion_order,
      row_number() over (partition by c.insertion_order order by h.rowid desc) as position
    from selected_comments c cross join comments h not indexed
      on h.owner_id = ${ownerId} and h.review_id = ${reviewId} and h.rowid in (
        select candidate.rowid from comments candidate indexed by comments_owner_review_thread_idx
        where candidate.owner_id = ${ownerId} and candidate.review_id = ${reviewId}
          and candidate.thread_id = c.thread_id and candidate.rowid < c.insertion_order
          and candidate.rowid not in (select insertion_order from selected_comments)
          and (candidate.author = 'agent' or candidate.send_id is not null)
        order by candidate.rowid desc limit ${LIMITS.historyPerComment + 1}
      )
  ), entry_sizes as materialized (
    select h.rowid as insertion_order, length(cast(case when h.outcome is null
      then json_object('author', h.author, 'body', h.body)
      else json_object('author', h.author, 'body', h.body, 'outcome', h.outcome) end as blob)) as bytes
    from (select distinct insertion_order from bounded_windows where position <= ${LIMITS.historyPerComment}) w
    cross join comments h not indexed on h.owner_id = ${ownerId} and h.review_id = ${reviewId}
      and h.rowid = w.insertion_order
  ) select w.comment_order, w.insertion_order,
      case when w.position <= ${LIMITS.historyPerComment} then e.bytes else null end as bytes
    from bounded_windows w left join entry_sizes e on e.insertion_order = w.insertion_order`;
}

// Shared by the claim's count/byte aggregates and its per-comment history windows.
// CROSS JOIN keeps selected Sends ahead of the indexed comment membership lookup.
export function pendingCommentSizes(ownerId: string, reviewId: string, revisionId: string) {
  return sql`select c.rowid as insertion_order, c.thread_id, c.send_id, length(cast(json_object(
    'id', c.id, 'threadId', c.thread_id, 'target', json(t.target), 'body', c.body,
    'placement', json(case when p.status = 'placed' and p.location is not null
      then json_object('status', 'placed', 'location', json(p.location))
      else json_object('status', 'unplaced', 'reason', coalesce(p.reason, 'not-placed')) end),
    'history', json('[]')) as blob)) + 1 as bytes
    from sends s
    cross join comments c indexed by comments_owner_review_send_idx
      on c.owner_id = ${ownerId} and c.review_id = ${reviewId} and c.send_id = s.id
    join threads t on t.owner_id = ${ownerId} and t.review_id = ${reviewId} and t.id = c.thread_id
    left join placements p on p.owner_id = ${ownerId} and p.review_id = ${reviewId}
      and p.thread_id = c.thread_id and p.revision_id = ${revisionId}
    where s.owner_id = ${ownerId} and s.review_id = ${reviewId}
      and s.delivery_id is null and s.set_aside_at is null and c.author = 'user'`;
}

export function sendSizes() {
  return sql`with comment_sizes as (
    select c.send_id, c.insertion_order, c.bytes + coalesce(sum(h.bytes + 1), 0)
      + max(case when h.comment_order is not null and h.bytes is null then ${trimmedFieldBytes} else 0 end) as bytes
    from pending_comments c left join history_entries h on h.comment_order = c.insertion_order
    group by c.insertion_order
  ) select send_id, count(*) as comment_count, sum(bytes) as bytes from comment_sizes group by send_id`;
}

export function placementOrMissing(
  row: { status: "placed" | "unplaced"; location: PlacementLocation | null; reason: UnplacedReason | null } | null,
): Placement {
  if (row?.status === "placed" && row.location) return { status: "placed", location: row.location };
  if (row?.status === "unplaced" && row.reason) return { status: "unplaced", reason: row.reason };
  return { status: "unplaced", reason: "not-placed" };
}

export async function loadHistory(
  ownerId: string,
  q: Queries,
  reviewId: string,
  result: Go,
  commentOrders: Map<string, number>,
): Promise<Go> {
  if (!result.comments.length) return result;
  const selectedComments = sql`values ${sql.join(
    result.comments.map((c) => sql`(${commentOrders.get(c.id)}, ${c.threadId})`),
    sql`, `,
  )}`;
  // Only each comment's bounded rowid window and byte counts cross into JS.
  const sizes = await q.values<[number, number, number | null]>(historySizes(ownerId, reviewId, selectedComments));
  const carriers = new Map(result.comments.map((comment) => [commentOrders.get(comment.id), { comment, count: 0 }]));
  type Carrier = { comment: HandoffComment; count: number };
  const entries = new Map<number, { order: number; bytes: number; carriers: Carrier[] }>();
  for (const [commentOrder, order, bytes] of sizes) {
    const carrier = carriers.get(commentOrder);
    if (!carrier) throw new Error("Missing delivered comment within transaction");
    if (bytes === null) {
      carrier.comment.historyTrimmed = true;
      continue;
    }
    const entry = entries.get(order) ?? { order, bytes, carriers: [] };
    entry.carriers.push(carrier);
    entries.set(order, entry);
    carrier.count++;
  }
  const ordered = [...entries.values()].sort((a, b) => a.order - b.order);
  let bytes =
    jsonBytes({ ...result, comments: [], instructions: [] }) +
    result.instructions.reduce(
      (sum, instruction) => sum + jsonBytes(instruction),
      Math.max(0, result.instructions.length - 1),
    ) +
    Math.max(0, result.comments.length - 1);
  for (const carrier of carriers.values()) bytes += jsonBytes(carrier.comment) + Math.max(0, carrier.count - 1);
  for (const entry of ordered) bytes += entry.bytes * entry.carriers.length;
  let dropped = 0;
  for (const entry of ordered) {
    if (bytes <= LIMITS.handoffBytes) break;
    for (const carrier of entry.carriers) {
      bytes -= entry.bytes + (carrier.count > 1 ? 1 : 0);
      carrier.count--;
      if (!carrier.comment.historyTrimmed) {
        carrier.comment.historyTrimmed = true;
        bytes += trimmedFieldBytes;
      }
    }
    dropped++;
  }
  if (bytes > LIMITS.handoffBytes) throw new ApiError("too_large");

  const kept = ordered.slice(dropped);
  // Bound SQL parameters as well as bodies. Shared entries are loaded just once.
  for (let offset = 0; offset < kept.length; offset += LIMITS.historyPerComment) {
    const batch = kept.slice(offset, offset + LIMITS.historyPerComment);
    const bodies = await q.values<[number, HistoryEntry["author"], string, HistoryEntry["outcome"] | null]>(sql`
      select comments.rowid, author, body, outcome from comments not indexed
      where owner_id = ${ownerId} and review_id = ${reviewId}
        and rowid in (${sql.join(
          batch.map(({ order }) => sql`${order}`),
          sql`, `,
        )})
    `);
    const loaded = new Map(
      bodies.map(([order, author, body, outcome]) => [
        order,
        {
          author,
          body,
          ...(outcome ? { outcome } : {}),
        },
      ]),
    );
    for (const entry of batch) {
      const body = loaded.get(entry.order);
      if (!body) throw new Error("History entry disappeared within transaction");
      for (const carrier of entry.carriers) carrier.comment.history.push(body);
    }
  }
  return result;
}

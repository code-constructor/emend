import type { InboxItem } from "@emend/contract";
import { Link } from "@tanstack/react-router";
import { OriginBadge } from "./OriginBadge.tsx";

export function AgentStatus({ review }: { review: Pick<InboxItem, "agentWaiting" | "pendingSend"> }) {
  return review.agentWaiting ? <span>Agent waiting</span> : review.pendingSend ? <span>No agent waiting</span> : null;
}
export function ReviewRow({ review }: { review: InboxItem }) {
  const contents = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <OriginBadge origin={review.origin} />
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{review.state}</span>
      </div>
      <div className="mt-2 font-medium break-words">{review.title}</div>
      <div className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {[review.repo, review.branch].filter(Boolean).join(" · ")}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
        <span>Revision {review.newestRevision}</span>
        <span>{review.unsentCount} unsent</span>
        <span>{review.openThreads} open threads</span>
        <AgentStatus review={review} />
      </div>
      {review.movedTo && <p className="mt-2 text-sm">Moved to {new URL(review.movedTo).host}</p>}
    </>
  );
  return (
    <li className="border-b border-neutral-200 dark:border-neutral-800">
      {review.movedTo ? (
        <div className="p-4 opacity-55" aria-disabled="true">
          {contents}
        </div>
      ) : (
        <Link
          to="/r/$reviewId"
          params={{ reviewId: review.id }}
          search={{ tab: "writeup" }}
          className="block p-4 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-600 dark:hover:bg-neutral-900"
          activeProps={{ className: "bg-blue-50 dark:bg-neutral-900" }}
        >
          {contents}
        </Link>
      )}
    </li>
  );
}

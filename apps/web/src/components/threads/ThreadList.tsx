import type { RevisionView } from "@emend/contract";
import type { SavedDraft } from "../../lib/drafts.ts";
import { DraftList } from "./DraftList.tsx";
import { ThreadCard } from "./ThreadCard.tsx";
import { Unplaced } from "./Unplaced.tsx";

export function ThreadList({
  reviewId,
  revision,
  threads,
  changedBlocks,
  onResume,
}: {
  reviewId: string;
  revision: number;
  threads: RevisionView["threads"];
  changedBlocks: RevisionView["changedBlocks"];
  onResume: (draft: SavedDraft) => void;
}) {
  const props = { reviewId, revision, changedBlocks, surface: "comments" as const };
  return (
    <div className="space-y-6 p-5">
      <DraftList reviewId={reviewId} onResume={onResume} />
      {(["open", "sent", "answered", "resolved"] as const).map((state) => (
        <section key={state} className="space-y-3">
          <h2 className="font-semibold">
            {state[0]?.toUpperCase()}
            {state.slice(1)}
          </h2>
          {threads
            .filter((thread) => thread.state === state && thread.placement.status === "placed")
            .map((thread) => (
              <ThreadCard key={thread.id} {...props} thread={thread} />
            ))}
        </section>
      ))}
      <section aria-label="Unplaced" className="space-y-3">
        <h2 className="font-semibold">Unplaced</h2>
        {threads
          .filter((thread) => thread.placement.status === "unplaced")
          .map((thread) => (
            <Unplaced key={thread.id} {...props} thread={thread} />
          ))}
      </section>
    </div>
  );
}

import { useEffect, useState } from "react";
import { clearDraft, listDrafts, type SavedDraft, subscribeDrafts } from "../../lib/drafts.ts";
import { Button } from "../ui/Button.tsx";

export function DraftList({ reviewId, onResume }: { reviewId: string; onResume: (draft: SavedDraft) => void }) {
  const [drafts, setDrafts] = useState(() => listDrafts(reviewId));
  useEffect(() => {
    const refresh = () => setDrafts(listDrafts(reviewId));
    refresh();
    return subscribeDrafts(refresh);
  }, [reviewId]);
  return (
    <section aria-label="Unsaved comments" className="space-y-3">
      <h2 className="font-semibold">Unsaved comments</h2>
      {drafts.map((draft) => (
        <article key={draft.key} className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <blockquote className="max-h-24 overflow-auto whitespace-pre-wrap break-words border-l-2 pl-2 text-sm">
            {draft.target
              ? "quote" in draft.target
                ? draft.target.quote
                : "lines" in draft.target
                  ? draft.target.lines.join("\n")
                  : "Unsaved comment"
              : "Unreadable target"}
          </blockquote>
          <div className="flex gap-2">
            {draft.target && <Button onClick={() => onResume(draft)}>Resume</Button>}
            <Button onClick={() => clearDraft(draft.key)}>Discard</Button>
          </div>
        </article>
      ))}
    </section>
  );
}

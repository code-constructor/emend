import { LIMITS, type Target } from "@emend/contract";
import { useId, useSyncExternalStore } from "react";
import { mutationMessage, useReviewMutation } from "../../api/mutations.ts";
import { draftKey, loadDraft, saveDraft, subscribeDrafts } from "../../lib/drafts.ts";
import { clipText } from "../../lib/selection.ts";
import { Button } from "../ui/Button.tsx";

export function Composer({
  reviewId,
  revision,
  target,
  threadId,
  storageKey,
  onSaved,
  onCancel,
}: {
  reviewId: string;
  revision: number;
  target: Target;
  threadId?: string;
  storageKey?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const key = storageKey ?? draftKey(reviewId, target, threadId);
  return (
    <DraftComposer
      key={key}
      storageKey={key}
      reviewId={reviewId}
      revision={revision}
      target={target}
      threadId={threadId}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
function DraftComposer({
  storageKey,
  reviewId,
  revision,
  target,
  threadId,
  onSaved,
  onCancel,
}: {
  storageKey: string;
  reviewId: string;
  revision: number;
  target: Target;
  threadId?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const body = useSyncExternalStore(subscribeDrafts, () => loadDraft(storageKey));
  const field = useId();
  const mutation = useReviewMutation(reviewId);
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!body.trim() || mutation.isPending) return;
        mutation.mutate(
          {
            path: threadId
              ? `/api/v1/threads/${encodeURIComponent(threadId)}/comments`
              : `/api/v1/reviews/${encodeURIComponent(reviewId)}/threads`,
            body: threadId ? { body } : { revision, target, body },
            draftKey: storageKey,
          },
          {
            onSuccess: () => {
              onSaved?.();
            },
          },
        );
      }}
    >
      <label htmlFor={field} className="block text-sm font-medium">
        {threadId ? "Reply" : "Comment"}
      </label>
      <textarea
        id={field}
        data-reply-composer={threadId ? true : undefined}
        className="review-input min-h-24"
        maxLength={LIMITS.commentBodyChars}
        value={body}
        disabled={mutation.isPending}
        onChange={(event) => {
          const next = clipText(event.target.value, LIMITS.commentBodyChars);
          saveDraft(storageKey, next);
        }}
      />
      {mutation.error && <p role="alert">{mutationMessage(mutation.error)}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={!body.trim() || body.length > LIMITS.commentBodyChars || mutation.isPending}>
          {threadId ? "Add reply" : "Save comment"}
        </Button>
        {onCancel && (
          <Button disabled={mutation.isPending} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

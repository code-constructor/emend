import { LIMITS, type Target } from "@emend/contract";
import { type ReactNode, type RefObject, useId, useSyncExternalStore } from "react";
import { mutationMessage, useReviewMutation } from "../../api/mutations.ts";
import { useComposerOwner } from "../../lib/composer-owner.ts";
import {
  draftKey,
  editDraftKey,
  hasDraft,
  isDraftSaving,
  loadDraft,
  saveDraft,
  subscribeDrafts,
} from "../../lib/drafts.ts";
import { clipText } from "../../lib/selection.ts";
import { Button } from "../ui/Button.tsx";

export function Composer({
  reviewId,
  revision,
  target,
  threadId,
  commentId,
  storageKey,
  onSaved,
  onCancel,
  surface = "reading",
  wrap,
  placeholder = true,
}: {
  reviewId: string;
  revision: number;
  target: Target;
  threadId?: string;
  commentId?: string;
  storageKey?: string;
  surface?: string;
  wrap?: (editor: ReactNode) => ReactNode;
  placeholder?: boolean;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const key = storageKey ?? (commentId ? editDraftKey(reviewId, commentId) : draftKey(reviewId, target, threadId));
  const owner = useComposerOwner(key, surface);
  if (!owner.owns)
    return placeholder ? (
      <Button data-composer-placeholder onClick={owner.claim} onFocus={owner.claim}>
        {commentId ? "Edit" : threadId ? "Reply" : "Comment"}
      </Button>
    ) : null;
  const editor = (
    <DraftComposer
      key={key}
      inputRef={owner.input}
      onFocus={owner.claim}
      storageKey={key}
      reviewId={reviewId}
      revision={revision}
      target={target}
      threadId={threadId}
      commentId={commentId}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
  return wrap ? wrap(editor) : editor;
}
function DraftComposer({
  inputRef,
  onFocus,
  storageKey,
  reviewId,
  revision,
  target,
  threadId,
  commentId,
  onSaved,
  onCancel,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onFocus: () => void;
  storageKey: string;
  reviewId: string;
  revision: number;
  target: Target;
  threadId?: string;
  commentId?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const body = useSyncExternalStore(subscribeDrafts, () => loadDraft(storageKey));
  const field = useId();
  const mutation = useReviewMutation(reviewId, storageKey);
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!body.trim() || mutation.isPending || isDraftSaving(storageKey)) return;
        mutation.mutate(
          {
            path: commentId
              ? `/api/v1/comments/${encodeURIComponent(commentId)}`
              : threadId
                ? `/api/v1/threads/${encodeURIComponent(threadId)}/comments`
                : `/api/v1/reviews/${encodeURIComponent(reviewId)}/threads`,
            method: commentId ? "PATCH" : "POST",
            body: commentId || threadId ? { body } : { revision, target, body },
            draft: { key: storageKey, text: body },
          },
          {
            onSuccess: () => {
              if (!hasDraft(storageKey)) onSaved?.();
            },
          },
        );
      }}
    >
      <label htmlFor={field} className="block text-sm font-medium">
        {commentId ? "Edit comment" : threadId ? "Reply" : "Comment"}
      </label>
      <textarea
        ref={inputRef}
        onFocus={onFocus}
        id={field}
        data-reply-composer={threadId ? true : undefined}
        className="review-input min-h-24"
        maxLength={LIMITS.commentBodyChars}
        value={body}
        onChange={(event) => {
          const next = clipText(event.target.value, LIMITS.commentBodyChars);
          saveDraft(storageKey, next);
        }}
      />
      {mutation.error && <p role="alert">{mutationMessage(mutation.error)}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={!body.trim() || body.length > LIMITS.commentBodyChars || mutation.isPending}>
          {commentId ? "Save edit" : threadId ? "Add reply" : "Save comment"}
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

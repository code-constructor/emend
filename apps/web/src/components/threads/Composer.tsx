import { LIMITS, type Target, type TopicMeta } from "@emend/contract";
import { Lock } from "lucide-react";
import { type ReactNode, type RefObject, useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { mutationMessage, useReviewMutation } from "../../api/mutations.ts";
import { useComposerOwner } from "../../lib/composer-owner.ts";
import {
  clearDraft,
  draftKey,
  editDraftKey,
  hasDraft,
  isDraftSaving,
  loadDraft,
  saveDraft,
  subscribeDrafts,
} from "../../lib/drafts.ts";
import { useLayout } from "../../lib/layout.ts";
import { clipText } from "../../lib/selection.ts";
import { useCommentCard } from "../diff/comment-lines.ts";
import { targetLabel } from "../diff/targets.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Sheet } from "../ui/Sheet.tsx";

export function Composer({
  reviewId,
  revision,
  target,
  topics,
  threadId,
  commentId,
  storageKey,
  onSaved,
  onCancel,
  onDismiss,
  returnFocus,
  surface = "reading",
  wrap,
  placeholder = true,
  embedded = false,
}: {
  reviewId: string;
  revision: number;
  target: Target;
  topics?: TopicMeta[];
  threadId?: string;
  commentId?: string;
  storageKey?: string;
  surface?: string;
  wrap?: (editor: ReactNode) => ReactNode;
  placeholder?: boolean;
  embedded?: boolean;
  onSaved?: () => void;
  onCancel?: () => void;
  onDismiss?: () => void;
  returnFocus?: (saved: boolean) => HTMLElement | null;
}) {
  const key = storageKey ?? (commentId ? editDraftKey(reviewId, commentId) : draftKey(reviewId, target, threadId));
  const owner = useComposerOwner(key, surface, target, threadId, commentId);
  const phone = useLayout() === "phone";
  const saved = useRef(false);
  useLayoutEffect(() => {
    saved.current = false;
    if (!phone) return;
    // A successful compare-and-clear can unmount this editor before onSaved,
    // which runs after invalidation. Keep the close reason for Sheet's callback.
    return subscribeDrafts(() => {
      if (isDraftSaving(key) && !hasDraft(key)) saved.current = true;
    });
  }, [key, phone]);
  const cancel = onCancel
    ? () => {
        saved.current = false;
        if (!commentId && !loadDraft(key).trim()) clearDraft(key);
        onCancel();
      }
    : undefined;
  if (!owner.owns)
    return placeholder ? (
      <Button variant="ghost" size="sm" data-composer-placeholder onClick={owner.claim} onFocus={owner.claim}>
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
      topics={topics}
      phone={phone}
      embedded={embedded}
      threadId={threadId}
      commentId={commentId}
      onSaved={onSaved}
      onCancel={cancel}
      onDismiss={onDismiss ?? cancel}
    />
  );
  if (phone)
    return (
      <Sheet
        side="bottom"
        title={commentId ? "Edit comment" : threadId ? "Reply" : "New comment"}
        open
        initialFocus={owner.input}
        returnFocus={() => returnFocus?.(saved.current) ?? null}
        onOpenChange={(open) => {
          if (!open && !isDraftSaving(key)) (onDismiss ?? cancel)?.();
        }}
      >
        {editor}
      </Sheet>
    );
  return wrap ? wrap(editor) : editor;
}
function DraftComposer({
  phone,
  embedded,
  inputRef,
  onFocus,
  storageKey,
  reviewId,
  revision,
  target,
  topics,
  threadId,
  commentId,
  onSaved,
  onCancel,
  onDismiss,
}: {
  phone: boolean;
  embedded: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onFocus: () => void;
  storageKey: string;
  reviewId: string;
  revision: number;
  target: Target;
  topics?: TopicMeta[];
  threadId?: string;
  commentId?: string;
  onSaved?: () => void;
  onCancel?: () => void;
  onDismiss?: () => void;
}) {
  const body = useSyncExternalStore(subscribeDrafts, () => loadDraft(storageKey));
  const field = useId();
  const mutation = useReviewMutation(reviewId, storageKey);
  const { label, icon } = targetLabel(target, topics);
  const saveLabel = commentId ? "Save changes" : "Save comment";
  const shortcut = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘↵" : "Ctrl ↵";
  const bare = embedded && !phone;
  const highlightCard = useCommentCard(null, !bare && !phone ? target : null);
  return (
    <form
      ref={highlightCard}
      className={`em-composer ${phone ? "em-composer--sheet" : bare ? "em-composer--inline" : "em-card"}`}
      data-state="draft"
      data-reply={bare && !commentId ? "" : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onDismiss && !phone) {
          event.preventDefault();
          event.stopPropagation();
          if (!mutation.isPending && !isDraftSaving(storageKey)) onDismiss();
        }
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!body.trim() || body.length > LIMITS.commentBodyChars || mutation.isPending || isDraftSaving(storageKey))
          return;
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
      {!bare && (
        <header className="em-card__head">
          <span className="em-card__target em-composer__target" title={label}>
            <Icon icon={icon} size={13} />
            <span>
              {commentId ? "Edit · " : threadId ? "Reply · " : ""}
              {label}
            </span>
          </span>
          <span className="em-card__pill" data-state="draft">
            {commentId ? "Editing" : threadId ? "Reply" : "New comment"}
          </span>
        </header>
      )}
      <div className="em-card__body">
        {!bare && "quote" in target && (
          <p className="em-thread-quote line-clamp-3">
            <mark>{target.quote}</mark>
          </p>
        )}
        <label htmlFor={field} className="sr-only">
          {commentId ? "Edit comment" : threadId ? "Reply" : "Comment"}
        </label>
        <textarea
          ref={inputRef}
          onFocus={onFocus}
          id={field}
          data-reply-composer={threadId ? true : undefined}
          className="em-composer__input"
          placeholder={commentId ? undefined : "Comment. Saved as unsent until you press Send."}
          maxLength={LIMITS.commentBodyChars}
          value={body}
          onChange={(event) => {
            const next = clipText(event.target.value, LIMITS.commentBodyChars);
            saveDraft(storageKey, next);
          }}
        />
        {mutation.error && <p role="alert">{mutationMessage(mutation.error)}</p>}
      </div>
      <div className="em-card__foot em-composer__foot">
        <span className="em-composer__hint">
          <Icon icon={Lock} size={12} />
          Draft kept in this browser
        </span>
        {onCancel && (
          <Button variant="ghost" size={phone ? "lg" : "sm"} disabled={mutation.isPending} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          size={phone ? "lg" : "sm"}
          kbd={phone ? undefined : shortcut}
          aria-label={saveLabel}
          disabled={!body.trim() || body.length > LIMITS.commentBodyChars || mutation.isPending}
        >
          {saveLabel}
        </Button>
      </div>
    </form>
  );
}

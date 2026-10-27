import type { RevisionView, ThreadView } from "@emend/contract";
import { useSyncExternalStore } from "react";
import { mutationMessage, useReviewMutation } from "../../api/mutations.ts";
import { claimDraft } from "../../lib/composer-owner.ts";
import { clearDraft, editDraftKey, hasDraft, saveDraft, subscribeDrafts } from "../../lib/drafts.ts";
import { Button } from "../ui/Button.tsx";
import { Composer } from "./Composer.tsx";

export type ThreadProps = {
  surface?: "reading" | "comments" | "diff";
  reviewId: string;
  revision: number;
  thread: ThreadView;
  changedBlocks: RevisionView["changedBlocks"];
};
export function blockLink(reviewId: string, revision: number, blockId: string, doc = false) {
  return `/r/${encodeURIComponent(reviewId)}?rev=${revision}&tab=${doc ? "docs" : "writeup"}#block-${encodeURIComponent(blockId)}`;
}
function answeredBefore(thread: ThreadView, revision: number) {
  let newestSent = 0;
  let answeredOn = 0;
  for (const comment of thread.comments) {
    if (comment.author === "user" && comment.sentOn !== null) newestSent = Math.max(newestSent, comment.sentOn);
    if (comment.author === "agent") answeredOn = newestSent;
  }
  return answeredOn > 0 && answeredOn < revision;
}
export function ThreadCard({ reviewId, revision, thread, changedBlocks, surface = "reading" }: ThreadProps) {
  const mutation = useReviewMutation(reviewId);
  const location = thread.placement.status === "placed" ? thread.placement.location : null;
  const changed =
    location && "blockId" in location ? changedBlocks.find((change) => change.blockId === location.blockId) : undefined;
  return (
    <article
      data-thread-card
      id={`${surface === "diff" ? "diff-thread" : "thread"}-${thread.id}`}
      className="space-y-3 rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800"
    >
      {"quote" in thread.target && (
        <blockquote className="border-l-2 border-neutral-300 pl-3 text-neutral-600 dark:text-neutral-400">
          {thread.target.quote}
        </blockquote>
      )}
      {changed && location && "blockId" in location && answeredBefore(thread, changed.revision) && (
        <a
          className="text-blue-700 underline dark:text-blue-300"
          href={blockLink(reviewId, revision, location.blockId, location.kind === "doc-span")}
        >
          Changed in revision {changed.revision}
        </a>
      )}
      <ol className="space-y-4">
        {thread.comments.map((comment) => (
          <li key={comment.id} className="space-y-2">
            <p className="flex gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span>{comment.author === "user" ? "You" : "Agent"}</span>
              {comment.author === "user" && comment.sent && <span>Sent</span>}
              {comment.author === "agent" && comment.outcome && <span>{comment.outcome}</span>}
            </p>
            {comment.author === "user" && !comment.sent ? (
              <UnsentComment
                comment={comment}
                reviewId={reviewId}
                revision={revision}
                thread={thread}
                surface={surface}
              />
            ) : (
              <p className="whitespace-pre-wrap break-words">{comment.body}</p>
            )}
          </li>
        ))}
      </ol>
      {mutation.error && <p role="alert">{mutationMessage(mutation.error)}</p>}
      <Button
        disabled={mutation.isPending}
        onClick={() =>
          mutation.mutate({
            path: `/api/v1/threads/${encodeURIComponent(thread.id)}/${thread.state === "resolved" ? "reopen" : "resolve"}`,
          })
        }
      >
        {thread.state === "resolved" ? "Reopen" : "Resolve"}
      </Button>
      <Composer surface={surface} reviewId={reviewId} revision={revision} target={thread.target} threadId={thread.id} />
    </article>
  );
}

function UnsentComment({
  comment,
  reviewId,
  revision,
  thread,
  surface = "reading",
}: {
  comment: ThreadView["comments"][number];
} & Pick<ThreadProps, "reviewId" | "revision" | "thread" | "surface">) {
  const key = editDraftKey(reviewId, comment.id);
  const editing = useSyncExternalStore(subscribeDrafts, () => hasDraft(key));
  const mutation = useReviewMutation(reviewId, key);
  return (
    <>
      {editing ? (
        <Composer
          surface={surface}
          reviewId={reviewId}
          revision={revision}
          target={thread.target}
          commentId={comment.id}
          onCancel={() => clearDraft(key)}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words">{comment.body}</p>
      )}
      <div className="flex gap-2">
        {!editing && (
          <Button
            disabled={mutation.isPending}
            onClick={() => {
              saveDraft(key, comment.body);
              claimDraft(key, surface);
            }}
          >
            Edit
          </Button>
        )}
        <Button
          disabled={mutation.isPending}
          onClick={() =>
            mutation.mutate(
              {
                path: `/api/v1/comments/${encodeURIComponent(comment.id)}`,
                method: "DELETE",
              },
              { onSuccess: () => clearDraft(key) },
            )
          }
        >
          Delete
        </Button>
      </div>
      {mutation.error && <p role="alert">{mutationMessage(mutation.error)}</p>}
    </>
  );
}

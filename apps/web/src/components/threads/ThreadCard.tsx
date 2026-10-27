import { LIMITS, type RevisionView, type ThreadView } from "@emend/contract";
import { useId, useState } from "react";
import { mutationMessage, useReviewMutation } from "../../api/mutations.ts";
import { clipText } from "../../lib/selection.ts";
import { Button } from "../ui/Button.tsx";
import { Composer } from "./Composer.tsx";

export type ThreadProps = {
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
export function ThreadCard({ reviewId, revision, thread, changedBlocks }: ThreadProps) {
  const mutation = useReviewMutation(reviewId);
  const [editing, setEditing] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const field = useId();
  const location = thread.placement.status === "placed" ? thread.placement.location : null;
  const changed =
    location && "blockId" in location ? changedBlocks.find((change) => change.blockId === location.blockId) : undefined;
  return (
    <article
      id={`thread-${thread.id}`}
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
            {editing === comment.id && comment.author === "user" && !comment.sent ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!body.trim() || mutation.isPending) return;
                  mutation.mutate(
                    { path: `/api/v1/comments/${encodeURIComponent(comment.id)}`, method: "PATCH", body: { body } },
                    { onSuccess: () => setEditing(null) },
                  );
                }}
              >
                <label htmlFor={field}>Edit comment</label>
                <textarea
                  id={field}
                  className="review-input"
                  maxLength={LIMITS.commentBodyChars}
                  disabled={mutation.isPending}
                  value={body}
                  onChange={(event) => setBody(clipText(event.target.value, LIMITS.commentBodyChars))}
                />
                <Button type="submit" disabled={!body.trim() || mutation.isPending}>
                  Save edit
                </Button>{" "}
                <Button disabled={mutation.isPending} onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <p className="whitespace-pre-wrap break-words">{comment.body}</p>
            )}
            {comment.author === "user" && !comment.sent && (
              <div className="flex gap-2">
                <Button
                  disabled={mutation.isPending}
                  onClick={() => {
                    setEditing(comment.id);
                    setBody(comment.body);
                  }}
                >
                  Edit
                </Button>
                <Button
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({ path: `/api/v1/comments/${encodeURIComponent(comment.id)}`, method: "DELETE" })
                  }
                >
                  Delete
                </Button>
              </div>
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
      <Composer reviewId={reviewId} revision={revision} target={thread.target} threadId={thread.id} />
    </article>
  );
}

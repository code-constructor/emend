import type { RevisionView, ThreadView, TopicMeta, UnplacedReason } from "@emend/contract";
import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Pencil,
  Reply,
  RotateCcw,
  Trash2,
  Unlink,
  User,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { mutationMessage, useReviewMutation } from "../../api/mutations.ts";
import { claimDraft, useDraftClaim, useReplyComposer } from "../../lib/composer-owner.ts";
import {
  clearDraft,
  draftKey,
  editDraftKey,
  hasDraft,
  loadDraft,
  saveDraft,
  subscribeDrafts,
} from "../../lib/drafts.ts";
import { useThreadActionFocus } from "../../lib/thread-action-focus.ts";
import type { ReviewSearch } from "../../router.tsx";
import { targetLabel } from "../diff/targets.ts";
import { ChangedMarker } from "../status/ChangedMarker.tsx";
import { OutcomeBadge } from "../status/OutcomeBadge.tsx";
import { shownThreadState, ThreadStateBadge } from "../status/ThreadStateBadge.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Composer } from "./Composer.tsx";

export type ThreadProps = {
  surface?: "reading" | "comments" | "diff";
  reviewId: string;
  revision: number;
  thread: ThreadView;
  changedBlocks: RevisionView["changedBlocks"];
  topics?: TopicMeta[];
  showInPlace?: string;
};
export function blockLink(reviewId: string, revision: number, blockId: string, doc?: string) {
  return `/r/${encodeURIComponent(reviewId)}?rev=${revision}&tab=${doc ? `docs&doc=${encodeURIComponent(doc)}` : "writeup"}#block-${encodeURIComponent(blockId)}`;
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

export function threadPlaceLink(reviewId: string, thread: ThreadView, search: ReviewSearch, phone: boolean) {
  if (thread.placement.status !== "placed") return undefined;
  const location = thread.placement.location;
  if (location.kind === "review") return undefined;
  const params = new URLSearchParams();
  if (search.rev !== undefined) params.set("rev", String(search.rev));
  let hash = `thread-${thread.id}`;
  if (location.kind === "writeup-span") params.set("tab", "writeup");
  else if (location.kind === "doc-span" || location.kind === "html-span") {
    params.set("tab", "docs");
    params.set("doc", location.path);
    if (location.kind === "html-span") params.set("thread", thread.id);
  } else {
    params.set("tab", phone ? "diff" : (search.tab ?? "comments"));
    if (search.doc) params.set("doc", search.doc);
    hash = `diff-thread-${thread.id}`;
  }
  return `/r/${encodeURIComponent(reviewId)}?${params}#${encodeURIComponent(hash)}`;
}
const reasons: Record<UnplacedReason, string> = {
  "block-gone": "The block this comment was on is gone.",
  ambiguous: "The quoted text now appears more than once.",
  "topic-gone": "The topic this comment was on is gone.",
  "file-gone": "The file this comment was on is no longer in the diff.",
  "lines-gone": "The lines this comment was on are gone.",
  "not-placed": "This comment has no place in this revision.",
};
export function ThreadCard({
  reviewId,
  revision,
  thread,
  changedBlocks,
  topics,
  showInPlace,
  surface = "reading",
}: ThreadProps) {
  const mutation = useReviewMutation(reviewId);
  const key = draftKey(reviewId, thread.target, thread.id);
  const keys = [key, ...thread.comments.map((comment) => editDraftKey(reviewId, comment.id))];
  const claim = useDraftClaim(keys, surface);
  const { open: replyOpen, close: closeReply } = useReplyComposer(key);
  const replyButton = useThreadActionFocus(reviewId, thread.id, surface, "reply", replyOpen);
  const [collapse, setCollapsed] = useState(
    () => surface === "comments" && thread.state === "resolved" && !keys.some((key) => loadDraft(key).trim()),
  );
  useEffect(() => {
    if (claim) {
      setCollapsed(false);
    }
  }, [claim]);
  const location = thread.placement.status === "placed" ? thread.placement.location : null;
  const changed =
    location && "blockId" in location ? changedBlocks.find((change) => change.blockId === location.blockId) : undefined;
  const showChanged = changed && location && "blockId" in location && answeredBefore(thread, changed.revision);
  const { label, icon } = targetLabel(thread.target, topics);
  const resolved = thread.state === "resolved";
  const collapsed = collapse && resolved;
  const canReply = !resolved && thread.comments.some((comment) => comment.author === "agent" || comment.sent);
  return (
    <article
      data-thread-card
      id={`${surface === "diff" ? "diff-thread" : "thread"}-${thread.id}`}
      className="em-thread"
      data-resolved={resolved ? "" : undefined}
      data-collapsed={collapsed ? "" : undefined}
    >
      <header className="em-thread__head">
        <span className="em-thread__target" title={label}>
          <Icon icon={icon} size={13} />
          <span>{label}</span>
        </span>
        {showChanged && (
          <a
            href={blockLink(
              reviewId,
              revision,
              location.blockId,
              location.kind === "doc-span" ? location.path : undefined,
            )}
          >
            <ChangedMarker revision={changed.revision} />
          </a>
        )}
        <ThreadStateBadge state={shownThreadState(thread)} />
        {surface === "comments" && showInPlace && !showChanged && (
          <IconButton asChild size="sm" icon={ArrowUpRight} label="Show in place">
            <a href={showInPlace}>
              <span className="sr-only">Show in place</span>
            </a>
          </IconButton>
        )}
        {surface === "comments" && resolved && (
          <IconButton
            size="sm"
            icon={collapsed ? ChevronDown : ChevronUp}
            label={collapsed ? "Expand thread" : "Collapse thread"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          />
        )}
      </header>
      {!collapsed && (
        <>
          {thread.placement.status === "unplaced" && (
            <div className="flex items-start gap-2 border-b border-line-1 bg-warning-bg px-3 py-2 text-warning-fg [font:var(--type-meta)]">
              <Icon icon={Unlink} size={14} className="mt-px" />
              <span>
                {reasons[thread.placement.reason]}
                {thread.createdOn !== revision && (
                  <>
                    {" "}
                    Made on{" "}
                    <a
                      className="underline"
                      href={`/r/${encodeURIComponent(reviewId)}?rev=${thread.createdOn}&tab=comments&thread=${encodeURIComponent(thread.id)}#thread-${encodeURIComponent(thread.id)}`}
                    >
                      revision {thread.createdOn}
                    </a>
                    .
                  </>
                )}
              </span>
            </div>
          )}
          {"quote" in thread.target && (
            <p className="em-thread-quote">
              <mark>{thread.target.quote}</mark>
            </p>
          )}
          <ol className="em-thread__comments">
            {thread.comments.map((comment) => (
              <Comment
                key={comment.id}
                comment={comment}
                reviewId={reviewId}
                revision={revision}
                thread={thread}
                topics={topics}
                surface={surface}
              />
            ))}
          </ol>
          {mutation.error && (
            <p className="px-3" role="alert">
              {mutationMessage(mutation.error)}
            </p>
          )}
          {(canReply || resolved) && (
            <footer className="flex items-center gap-1.5 pt-0 pr-2 pb-2 pl-11">
              {canReply && !replyOpen && (
                <Button
                  ref={replyButton.ref}
                  variant="ghost"
                  size="sm"
                  icon={Reply}
                  onClick={() => {
                    claimDraft(key, surface);
                  }}
                >
                  Reply
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                icon={resolved ? RotateCcw : Check}
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({
                    path: `/api/v1/threads/${encodeURIComponent(thread.id)}/${resolved ? "reopen" : "resolve"}`,
                  })
                }
              >
                {resolved ? "Reopen" : "Resolve"}
              </Button>
            </footer>
          )}
          {replyOpen && (
            <Composer
              surface={surface}
              reviewId={reviewId}
              revision={revision}
              target={thread.target}
              topics={topics}
              threadId={thread.id}
              onSaved={closeReply}
              onCancel={closeReply}
              returnFocus={replyButton.returnFocus}
              wrap={(editor) => <div className="m-3">{editor}</div>}
            />
          )}
        </>
      )}
    </article>
  );
}

function Comment({
  comment,
  reviewId,
  revision,
  thread,
  topics,
  surface = "reading",
}: {
  comment: ThreadView["comments"][number];
} & Pick<ThreadProps, "reviewId" | "revision" | "thread" | "topics" | "surface">) {
  const key = editDraftKey(reviewId, comment.id);
  const editing = useSyncExternalStore(subscribeDrafts, () => hasDraft(key));
  const editButton = useThreadActionFocus(reviewId, thread.id, surface, comment.id, editing);
  const mutation = useReviewMutation(reviewId, key);
  const agent = comment.author === "agent";
  const editable = !agent && !comment.sent;
  return (
    <li className="em-comment" data-agent={agent ? "" : undefined}>
      <span className="em-comment__avatar">
        <Icon icon={agent ? Bot : User} size={13} />
      </span>
      <header className="em-comment__head">
        <span className="em-comment__name">{agent ? "Agent" : "You"}</span>
        {agent && comment.outcome && <OutcomeBadge outcome={comment.outcome} />}
        {editable && (
          <span className="ml-auto flex gap-0.5">
            {!editing && (
              <IconButton
                ref={editButton.ref}
                label="Edit"
                icon={Pencil}
                size="sm"
                disabled={mutation.isPending}
                onClick={() => {
                  saveDraft(key, comment.body);
                  claimDraft(key, surface);
                }}
              />
            )}
            <IconButton
              label="Delete"
              icon={Trash2}
              size="sm"
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate(
                  { path: `/api/v1/comments/${encodeURIComponent(comment.id)}`, method: "DELETE" },
                  { onSuccess: () => clearDraft(key) },
                )
              }
            />
          </span>
        )}
      </header>
      <div>
        {editable && editing ? (
          <Composer
            surface={surface}
            reviewId={reviewId}
            revision={revision}
            target={thread.target}
            topics={topics}
            commentId={comment.id}
            onCancel={() => clearDraft(key)}
            returnFocus={editButton.returnFocus}
          />
        ) : (
          <p className="em-comment__body">{comment.body}</p>
        )}
        {mutation.error && <p role="alert">{mutationMessage(mutation.error)}</p>}
      </div>
    </li>
  );
}

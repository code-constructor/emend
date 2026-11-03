import type { ReviewView, RevisionView } from "@emend/contract";
import { FileText, GitBranch, GitCommitHorizontal, MessageSquarePlus } from "lucide-react";
import type { Ref } from "react";
import { plural } from "../../lib/count.ts";
import { AgentStatus, agentStatusOf } from "../status/AgentStatus.tsx";
import { OriginBadge } from "../status/OriginBadge.tsx";
import { StateBadge } from "../status/StateBadge.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { cn } from "../ui/utils.ts";
import { RevisionPicker } from "./RevisionPicker.tsx";

export function ReviewHeader({
  review,
  revision,
  seq,
  ready,
  phone,
  titleRef,
  onRevisionChange,
  onCommentReview,
}: {
  review: ReviewView;
  revision?: RevisionView;
  seq: number;
  ready: number;
  phone: boolean;
  titleRef: Ref<HTMLHeadingElement>;
  onRevisionChange: (seq: number) => void;
  onCommentReview?: () => void;
}) {
  const agent = agentStatusOf(review);
  const commits =
    revision &&
    [revision.base?.slice(0, 7), revision.head === "worktree" ? "working tree" : revision.head?.slice(0, 7)]
      .filter(Boolean)
      .join(" → ");
  const metaItem = "inline-flex min-w-0 items-center gap-[5px] wrap-anywhere";
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1 border-b border-line-1 bg-surface",
        phone ? "px-4 py-3" : "px-5 pt-3 pb-2.5",
      )}
    >
      <div className="flex items-start gap-3">
        <h1
          ref={titleRef}
          tabIndex={-1}
          className="m-0 min-w-0 flex-1 text-pretty wrap-anywhere text-[17px] font-semibold leading-[1.3] tracking-[-0.01em] text-fg-1"
        >
          {review.title}
        </h1>
        {!phone && (
          <Button variant="ghost" size="sm" icon={MessageSquarePlus} disabled={!revision} onClick={onCommentReview}>
            Comment on review
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-fg-3 [font:var(--type-meta)]">
        <span className="inline-flex min-w-0 items-center gap-1.5 wrap-anywhere">
          <OriginBadge origin={review.origin} dot className="size-[7px] opacity-85" />
          {review.origin.name}
        </span>
        {review.state !== "open" && (
          <>
            <span aria-hidden="true" className="text-line-strong">
              ·
            </span>
            <StateBadge state={review.state} />
          </>
        )}
        {(agent === "waiting" || agent === "none") && (
          <>
            <span aria-hidden="true" className="text-line-strong">
              ·
            </span>
            <AgentStatus status={agent} className="font-normal text-fg-3" />
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 font-mono text-12 leading-[1.2] font-stretch-mono text-fg-3">
        {review.branch && (
          <span className={metaItem}>
            <Icon icon={GitBranch} size={13} />
            {review.branch}
          </span>
        )}
        {!phone && commits && (
          <span className={metaItem}>
            <Icon icon={GitCommitHorizontal} size={13} />
            {commits}
          </span>
        )}
        {revision?.files.length === 0 && (
          <span className={metaItem}>
            <Icon icon={FileText} size={13} />
            {revision.docs.length} {plural(revision.docs.length, "doc")} · no code changes
          </span>
        )}
        <RevisionPicker review={review} seq={seq} onChange={onRevisionChange} />
      </div>
      {review.importedAt && (
        <p className="m-0 wrap-anywhere text-fg-3 [font:var(--type-meta)]">
          Copied from {review.origin.name} on {new Date(review.importedAt).toLocaleDateString()}. Comments, Sends and
          approvals before then were made there.
        </p>
      )}
      {ready > seq && (
        <Banner tone="info" actionLabel="Show" onAction={() => onRevisionChange(ready)}>
          Revision {ready} is ready.
        </Banner>
      )}
    </div>
  );
}

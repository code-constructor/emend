import type { ReviewView, RevisionView } from "@emend/contract";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { reviewQuery, revisionQuery } from "../api/queries.ts";
import { OriginBadge } from "../components/inbox/OriginBadge.tsx";
import { AgentStatus } from "../components/inbox/ReviewRow.tsx";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { Panes } from "../components/layout/Panes.tsx";
import { PhoneTabs, ReviewTabs } from "../components/layout/PhoneTabs.tsx";
import { Button } from "../components/ui/Button.tsx";
import { useReviewEvents } from "../lib/events.ts";
import { useInboxCollapsed, useLayout } from "../lib/layout.ts";
import type { ReviewSearch } from "../router.tsx";
import { Inbox } from "./inbox.tsx";

function RevisionPicker({
  review,
  seq,
  onChange,
  menu = false,
}: {
  review: ReviewView;
  seq: number;
  onChange: (seq: number) => void;
  menu?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      {menu && <span>Revision</span>}
      <select
        aria-label={menu ? "Revision" : `Revision ${seq}`}
        value={seq}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-h-10 rounded-md border border-neutral-300 bg-white px-2 dark:border-neutral-700 dark:bg-neutral-900"
      >
        {review.revisions.map((revision) => (
          <option key={revision.seq} value={revision.seq}>
            Revision {revision.seq}
          </option>
        ))}
      </select>
    </label>
  );
}
function Reading({ revision, tab }: { revision: RevisionView; tab: string }) {
  if (tab === "comments")
    return (
      <div className="p-5">
        <h2 className="font-semibold">Comments</h2>
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">{revision.threads.length} threads</p>
      </div>
    );
  return (
    <div className="space-y-5 p-5">
      {tab !== "docs" &&
        revision.writeup.sections.map((section) => (
          <h2 key={section.key} className="border-b border-neutral-100 pb-4 font-medium dark:border-neutral-900">
            {section.label}
          </h2>
        ))}
      {revision.docs.length > 0 && (
        <div>
          <h2 className="mb-3 font-semibold">Documents</h2>
          <ul className="space-y-2 text-sm">
            {revision.docs.map((doc) => (
              <li key={doc.path} className="break-words font-mono">
                {doc.path}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
function Diff({ revision }: { revision: RevisionView }) {
  const files = revision.files.filter((file) => file.role === "diff").toSorted((a, b) => a.order - b.order);
  const topics = revision.topics.map((topic) => ({ slug: topic.slug, title: topic.title }));
  if (files.some((file) => file.topic === null)) topics.push({ slug: "", title: "Other changes" });
  return (
    <div className="p-5">
      <h2 className="mb-5 font-semibold">Diff</h2>
      {files.length === 0 && <p className="text-sm text-neutral-500 dark:text-neutral-400">No changed files.</p>}
      {topics.map((topic) => {
        const group = files.filter((file) => (file.topic ?? "") === topic.slug);
        return (
          group.length > 0 && (
            <section key={topic.slug} className="mb-6">
              <h3 className="mb-3 text-sm font-semibold">{topic.title}</h3>
              <ul className="space-y-3 text-sm">
                {group.map((file) => (
                  <li key={file.id}>
                    <p className="break-words font-mono">{file.path}</p>
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      {[file.status, file.flag].filter(Boolean).join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )
        );
      })}
    </div>
  );
}
function LoadedReview({ review, search, published }: { review: ReviewView; search: ReviewSearch; published: number }) {
  const [initialRevision] = useState(review.newestRevision);
  const seq = search.rev ?? initialRevision;
  const query = useQuery(revisionQuery(review.id, seq));
  const navigate = useNavigate({ from: "/r/$reviewId" });
  const [collapsed, setCollapsed] = useInboxCollapsed();
  const layout = useLayout();
  const setRevision = (rev: number) => {
    void navigate({ search: { ...search, rev } });
  };
  const revision = query.data;
  const hasDocs = (revision?.docs.length ?? 0) > 0;
  const tab = search.tab === "docs" && !hasDocs ? "writeup" : search.tab;
  const tabProps = { id: review.id, search: { ...search, tab }, hasDocs, unsentCount: review.unsentCount };
  const inbox = <Inbox compact />;
  const ready = Math.max(published, review.newestRevision);
  return (
    <AppFrame
      title={review.title}
      isReview
      inbox={inbox}
      desktopAction={
        collapsed ? (
          <Button onClick={() => setCollapsed(false)}>Expand inbox</Button>
        ) : (
          <Button onClick={() => setCollapsed(true)}>Collapse inbox</Button>
        )
      }
      revisionMenu={<RevisionPicker review={review} seq={seq} onChange={setRevision} menu />}
    >
      <Panes
        inbox={inbox}
        collapsed={collapsed}
        tab={tab}
        phoneTabs={<PhoneTabs {...tabProps} />}
        header={
          <div className="shrink-0 border-b border-neutral-200 p-4 dark:border-neutral-800">
            <div className="flex flex-wrap items-center gap-2">
              <OriginBadge origin={review.origin} />
              <span className="text-xs text-neutral-500 dark:text-neutral-400">{review.state}</span>
            </div>
            <h1 className="mt-2 break-words text-xl font-semibold tracking-tight">{review.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-neutral-600 dark:text-neutral-400">
              {(review.repo || review.branch) && (
                <span className="break-words">{[review.repo, review.branch].filter(Boolean).join(" · ")}</span>
              )}
              <RevisionPicker review={review} seq={seq} onChange={setRevision} />
              <AgentStatus review={review} />
            </div>
            {ready > seq && (
              <div
                role="status"
                className="mt-4 flex flex-wrap items-center gap-3 rounded-md bg-blue-50 p-3 text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-200"
              >
                <span>Revision {ready} is ready. Reload to see it.</span>
                <Button onClick={() => setRevision(ready)}>Reload</Button>
              </div>
            )}
          </div>
        }
        reading={
          <>
            {layout !== "phone" && <ReviewTabs {...tabProps} />}
            {query.isPending && (
              <p role="status" className="p-5">
                Loading revision…
              </p>
            )}
            {query.isError && (
              <div className="p-5">
                <p role="alert">Could not load this revision.</p>
                <Button onClick={() => void query.refetch()}>Retry</Button>
              </div>
            )}
            {revision && <Reading revision={revision} tab={tab} />}
          </>
        }
        diff={
          revision ? (
            <Diff revision={revision} />
          ) : (
            <p role={query.isError ? "alert" : "status"} className="p-5">
              {query.isError ? "Could not load this revision." : "Loading revision…"}
            </p>
          )
        }
      />
    </AppFrame>
  );
}
export function ReviewPage() {
  const { reviewId } = useParams({ from: "/r/$reviewId" });
  const search = useSearch({ from: "/r/$reviewId" });
  const query = useQuery(reviewQuery(reviewId));
  const published = useReviewEvents(reviewId);
  if (query.data) return <LoadedReview key={reviewId} review={query.data} search={search} published={published} />;
  return (
    <AppFrame title="Review" isReview>
      <main className="p-5">
        {query.isError ? (
          <>
            <p role="alert">Could not load this review.</p>
            <Button onClick={() => void query.refetch()}>Retry</Button>
          </>
        ) : (
          <p role="status">Loading review…</p>
        )}
      </main>
    </AppFrame>
  );
}

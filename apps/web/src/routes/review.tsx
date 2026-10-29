import type { ReviewView, RevisionView } from "@emend/contract";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { placeSpan } from "../../../../packages/core/src/place/span.ts";
import { reviewQuery, revisionQuery } from "../api/queries.ts";
import { LazyDiffPane } from "../components/diff/LazyDiffPane.tsx";
import { isDiffTarget } from "../components/diff/targets.ts";
import { OriginBadge } from "../components/inbox/OriginBadge.tsx";
import { AgentStatus } from "../components/inbox/ReviewRow.tsx";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { Panes } from "../components/layout/Panes.tsx";
import { PhoneTabs, ReviewTabs } from "../components/layout/PhoneTabs.tsx";
import { DocView } from "../components/reading/DocView.tsx";
import type { HtmlNavigation } from "../components/reading/HtmlDocFrame.tsx";
import { Writeup } from "../components/reading/Writeup.tsx";
import { SendBar } from "../components/send/SendBar.tsx";
import { Composer } from "../components/threads/Composer.tsx";
import { ThreadList } from "../components/threads/ThreadList.tsx";
import { Button } from "../components/ui/Button.tsx";
import { claimDraft } from "../lib/composer-owner.ts";
import { draftKey, hasDraft, type SavedDraft, subscribeDrafts } from "../lib/drafts.ts";
import { useReviewEvents } from "../lib/events.ts";
import { useInboxCollapsed, useLayout } from "../lib/layout.ts";
import { openingView } from "../lib/opening-view.ts";
import { type ReviewSearch, validateReviewSearch } from "../router.tsx";
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
function Reading({
  reviewId,
  revision,
  tab,
  onResume,
  htmlNavigation,
  composingPath,
}: {
  reviewId: string;
  revision: RevisionView;
  tab: string;
  onResume: (draft: SavedDraft) => void;
  htmlNavigation?: HtmlNavigation;
  composingPath?: string;
}) {
  const props = { reviewId, revision: revision.seq, threads: revision.threads, changedBlocks: revision.changedBlocks };
  if (tab === "comments") return <ThreadList {...props} onResume={onResume} />;
  if (tab === "docs")
    return <DocView {...props} docs={revision.docs} navigation={htmlNavigation} composingPath={composingPath} />;
  return <Writeup {...props} writeup={revision.writeup} />;
}
function draftPlacement(draft: SavedDraft, revision: RevisionView) {
  if (draft.threadId) return revision.threads.find((thread) => thread.id === draft.threadId)?.placement;
  const target = draft.target;
  if (target?.kind === "writeup-span")
    return placeSpan(
      revision.writeup.sections.flatMap((section) => section.blocks),
      target,
    );
  if (target?.kind === "doc-span") {
    const doc = revision.docs.find((doc) => doc.path === target.path);
    return placeSpan(doc?.kind === "markdown" ? doc.blocks : [], target);
  }
  return undefined;
}
function readingIntent(search: ReviewSearch, hash: string, seq: number) {
  const reply = search.tab === "comments" && !!search.thread;
  return {
    navigation: JSON.stringify([seq, search.tab, search.thread, hash]),
    elementId: reply ? `thread-${search.thread}` : hash,
    reply,
    threadId: search.thread ?? (hash.startsWith("thread-") ? hash.slice(7) : undefined),
    routeThread: true,
    block: "center" as ScrollLogicalPosition,
  };
}
function LoadedReview({ review, published }: { review: ReviewView; published: number }) {
  // Read search and hash from one location: route matches can lag during navigation.
  const location = useLocation();
  const search = validateReviewSearch(location.search);
  const hash = location.hash;
  const [initialRevision] = useState(review.newestRevision);
  const seq = search.rev ?? initialRevision;
  const query = useQuery(revisionQuery(review.id, seq));
  const navigate = useNavigate({ from: "/r/$reviewId" });
  const [collapsed, setCollapsed] = useInboxCollapsed();
  const layout = useLayout();
  const revision = query.data;
  const [resumed, setResumed] = useState<(SavedDraft & { tab: NonNullable<ReviewSearch["tab"]> }) | null>(null);
  const endResume = () => setResumed((current) => (current === resumed ? null : current));
  useEffect(() => {
    if (!resumed) return;
    const refresh = () => {
      if (!hasDraft(resumed.key)) setResumed((current) => (current === resumed ? null : current));
    };
    refresh();
    return subscribeDrafts(refresh);
  }, [resumed]);
  // A resumed editor needs its destination even when the revision has no content there.
  const hasDocs = (revision?.docs.length ?? 0) > 0 || resumed?.tab === "docs";
  const hasDiff = (revision?.files.some((file) => file.role === "diff") ?? false) || resumed?.tab === "diff";
  const hasWriteup =
    (!!revision && (!revision.writeupEmpty || revision.main === "writeup")) || resumed?.tab === "writeup";
  const opening = revision ? openingView(revision) : { tab: "writeup" as const };
  const useOpening = !search.tab || !{ writeup: hasWriteup, diff: hasDiff, docs: hasDocs, comments: true }[search.tab];
  const tab = useOpening ? opening.tab : (search.tab ?? opening.tab);
  const readingTab = tab === "diff" ? (hasWriteup ? "writeup" : hasDocs ? "docs" : "comments") : tab;
  const setRevision = (rev: number) => {
    void navigate({ search: { ...search, tab, rev } });
  };
  const [requested, setRequested] = useState<ReturnType<typeof readingIntent> | null>(null);
  const [htmlNavigation, setHtmlNavigation] = useState<HtmlNavigation>();
  const pending = useRef<ReturnType<typeof readingIntent> | null>(null);
  const previous = useRef<{ navigation: string; requested: typeof requested } | null>(null);
  const navigateReading = (next: ReviewSearch, nextHash = "") => {
    // A repeated Resume or link click is a new intent even when the URL is unchanged.
    setRequested(readingIntent(next, nextHash, next.rev ?? initialRevision));
    void navigate({ search: next, hash: nextHash });
  };
  const followReadingLink = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (
      !(link instanceof HTMLAnchorElement) ||
      link.hasAttribute("download") ||
      (link.target && link.target !== "_self")
    )
      return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin || url.pathname !== `/r/${encodeURIComponent(review.id)}`) return;
    event.preventDefault();
    navigateReading(validateReviewSearch(Object.fromEntries(url.searchParams)), url.hash.slice(1));
  };
  const resume = (draft: SavedDraft) => {
    if (draft.commentId && revision) {
      const thread = revision.threads.find((thread) =>
        thread.comments.some((comment) => comment.id === draft.commentId),
      );
      if (thread) {
        setResumed(null);
        claimDraft(draft.key, "comments");
        navigateReading({ ...search, tab: "comments", thread: undefined });
      }
      return;
    }
    if (!draft.target || !revision) return;
    if (draft.threadId && revision.threads.some((thread) => thread.id === draft.threadId)) {
      setResumed(null);
      navigateReading({ ...search, tab: "comments", thread: draft.threadId });
      return;
    }
    if (isDiffTarget(draft.target)) {
      claimDraft(draft.key, "diff");
      setResumed({ ...draft, tab: "diff" });
      navigateReading({ ...search, tab: "diff", thread: undefined });
      return;
    }
    claimDraft(draft.key, "resumed");
    if (draft.target.kind === "html-span") {
      setResumed({ ...draft, tab: "docs" });
      navigateReading({ ...search, tab: "docs", thread: undefined }, `html-doc-${draft.target.path}`);
      return;
    }
    const placement = draftPlacement(draft, revision);
    if (placement?.status === "placed" && "blockId" in placement.location) {
      const destination = placement.location.kind === "doc-span" ? "docs" : "writeup";
      setResumed({ ...draft, tab: destination });
      navigateReading({ ...search, tab: destination, thread: undefined }, `block-${placement.location.blockId}`);
    } else {
      setResumed({ ...draft, tab: readingTab });
      navigateReading({ ...search, tab: readingTab, thread: undefined });
    }
  };
  // Data/DOM changes may fulfill an existing intent, but only navigation creates one.
  useEffect(() => {
    const current = readingIntent(search, hash, seq);
    if (requested && requested !== previous.current?.requested) pending.current = { ...requested };
    else if (current.navigation !== previous.current?.navigation && pending.current?.navigation !== current.navigation)
      pending.current = current;
    previous.current = { navigation: current.navigation, requested };
    const intent = pending.current;
    if (!revision || !intent || intent.navigation !== current.navigation) return;
    if (!intent.elementId && !intent.threadId && useOpening && opening.doc) {
      const doc = revision.docs.find((doc) => doc.path === opening.doc);
      intent.elementId = `${doc?.kind === "html" ? "html-doc" : "doc"}-${opening.doc}`;
      intent.block = "start";
    }
    const thread = revision.threads.find((thread) => thread.id === intent.threadId);
    if (intent.routeThread) {
      if (intent.threadId && !thread) return;
      // Placement selects the destination once for this navigation, never on a refetch.
      intent.routeThread = false;
      setHtmlNavigation(undefined);
      if (thread?.target.kind === "html-span") {
        const location = thread.placement.status === "placed" ? thread.placement.location : undefined;
        const placed =
          location?.kind === "html-span" &&
          revision.docs.some((doc) => doc.kind === "html" && doc.path === location.path);
        const next: ReviewSearch = { ...search, tab: placed ? "docs" : "comments" };
        const nextHash = `thread-${thread.id}`;
        intent.elementId = nextHash;
        intent.reply ||= !placed;
        if (placed) setHtmlNavigation({ threadId: thread.id, intent });
        if (search.tab !== next.tab || hash !== nextHash) {
          // The redirect continues this intent; it does not create another one.
          intent.navigation = readingIntent(next, nextHash, seq).navigation;
          void navigate({ search: next, hash: nextHash, replace: true });
          return;
        }
      }
    }
    if (!intent.elementId) {
      pending.current = null;
      return;
    }
    if (intent.reply) {
      if (!thread) return;
      pending.current = null;
      claimDraft(draftKey(review.id, thread.target, thread.id), search.tab === "docs" ? "reading" : "comments");
      return;
    }
    const element = document.getElementById(intent.elementId);
    if (!element) return;
    pending.current = null;
    element.scrollIntoView?.({ block: intent.block });
  });
  const tabProps = {
    id: review.id,
    search: { ...search, tab },
    hasDocs,
    hasDiff,
    hasWriteup,
    unsentCount: review.unsentCount,
  };
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
        hasDiff={hasDiff}
        phoneTabs={<PhoneTabs {...tabProps} />}
        sendBar={
          <SendBar
            key={review.id}
            reviewId={review.id}
            revision={revision?.seq}
            revisionError={query.isError}
            unsentCount={review.unsentCount}
            phone={layout === "phone"}
          />
        }
        header={
          <div className="shrink-0 border-b border-neutral-200 p-4 dark:border-neutral-800">
            <div className="flex flex-wrap items-center gap-2">
              <OriginBadge origin={review.origin} />
              <span className="text-xs text-neutral-500 dark:text-neutral-400">{review.state}</span>
            </div>
            <h1 className="mt-2 break-words text-xl font-semibold tracking-tight">{review.title}</h1>
            {review.importedAt && (
              <p className="mt-2 break-words text-sm">
                Copied from {review.origin.name} on {new Date(review.importedAt).toLocaleDateString()}. Comments, Sends
                and approvals before then were made there.
              </p>
            )}
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
          <div className="contents" onClickCapture={followReadingLink}>
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
            {revision && (
              <Reading
                key={`${seq}:${tab}`}
                reviewId={review.id}
                revision={revision}
                tab={readingTab}
                onResume={resume}
                htmlNavigation={htmlNavigation}
                composingPath={resumed?.target?.kind === "html-span" ? resumed.target.path : undefined}
              />
            )}
            {resumed?.target && !isDiffTarget(resumed.target) && (
              <Composer
                surface="resumed"
                placeholder={false}
                reviewId={review.id}
                revision={seq}
                target={resumed.target}
                threadId={resumed.threadId}
                storageKey={resumed.key}
                onSaved={endResume}
                onCancel={endResume}
                wrap={(editor) => (
                  <section
                    aria-label="Resumed comment"
                    className="sticky bottom-0 space-y-3 border-t border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-950"
                  >
                    {resumed.target && "quote" in resumed.target && (
                      <blockquote className="max-h-24 overflow-auto border-l-2 pl-2 text-sm">
                        {resumed.target.quote}
                      </blockquote>
                    )}
                    {editor}
                  </section>
                )}
              />
            )}
          </div>
        }
        diff={
          revision ? (
            <LazyDiffPane
              key={seq}
              reviewId={review.id}
              revision={revision}
              resume={resumed?.target && isDiffTarget(resumed.target) ? resumed : undefined}
              onResumeEnd={endResume}
            />
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
  const query = useQuery(reviewQuery(reviewId));
  const published = useReviewEvents(reviewId);
  if (query.data) return <LoadedReview key={reviewId} review={query.data} published={published} />;
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

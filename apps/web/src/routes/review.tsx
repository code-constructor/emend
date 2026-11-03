import type { ReviewView, RevisionView } from "@emend/contract";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { type MouseEvent, type Ref, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { placeSpan } from "../../../../packages/core/src/place/span.ts";
import { mutationMessage, useViewedErrors, useViewedMutation, useViewedRevision } from "../api/mutations.ts";
import { reviewQuery, revisionQuery } from "../api/queries.ts";
import { LazyDiffPane } from "../components/diff/LazyDiffPane.tsx";
import { isDiffTarget } from "../components/diff/targets.ts";
import { FilesView } from "../components/files/FilesView.tsx";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { Panes } from "../components/layout/Panes.tsx";
import { PhoneTabs } from "../components/layout/PhoneTabs.tsx";
import { ReviewInbox } from "../components/layout/ReviewInbox.tsx";
import { ReviewTabs } from "../components/layout/ReviewTabs.tsx";
import type { ThreadJump } from "../components/reading/BlockThreads.tsx";
import { DocView } from "../components/reading/DocView.tsx";
import type { HtmlNavigation } from "../components/reading/HtmlDocFrame.tsx";
import { ReadingFoldContext } from "../components/reading/ReadingGroup.tsx";
import { Writeup } from "../components/reading/Writeup.tsx";
import { ReviewHeader } from "../components/review/ReviewHeader.tsx";
import { SendBar } from "../components/send/SendBar.tsx";
import { Composer } from "../components/threads/Composer.tsx";
import { ThreadList } from "../components/threads/ThreadList.tsx";
import { Button } from "../components/ui/Button.tsx";
import { claimDraft } from "../lib/composer-owner.ts";
import { useDiffCounts } from "../lib/diff-counts.ts";
import type { NavigateDiff } from "../lib/diff-navigation.ts";
import { draftKey, hasDraft, type SavedDraft, saveDraft, subscribeDrafts } from "../lib/drafts.ts";
import { usePublishedRevision } from "../lib/events.tsx";
import { useInboxCollapsed, useLayout, usePaneMode } from "../lib/layout.ts";
import { openingView } from "../lib/opening-view.ts";
import { revealReadingTarget } from "../lib/reading-reveal.ts";
import { type ReviewSearch, validateReviewSearch } from "../router.tsx";

function Reading({
  reviewId,
  revision,
  tab,
  onResume,
  htmlNavigation,
  composingPath,
  resumedBlockId,
  activeThreadId,
  threadJump,
  search,
  phone,
  openDoc,
  targeted,
  onOpenDoc,
  onCurrentTopic,
  visible,
}: {
  reviewId: string;
  revision: RevisionView;
  tab: string;
  onResume: (draft: SavedDraft) => void;
  htmlNavigation?: HtmlNavigation;
  composingPath?: string;
  resumedBlockId?: string;
  activeThreadId?: string;
  threadJump?: ThreadJump;
  search: ReviewSearch;
  phone: boolean;
  openDoc?: RevisionView["docs"][number];
  targeted: boolean;
  onOpenDoc: (path: string) => void;
  onCurrentTopic?: (slug: string | undefined) => void;
  visible: boolean;
}) {
  const props = {
    reviewId,
    revision: revision.seq,
    threads: revision.threads,
    changedBlocks: revision.changedBlocks,
    topics: revision.topics,
    activeThreadId,
    threadJump,
  };
  if (tab === "comments") return <ThreadList {...props} search={search} phone={phone} onResume={onResume} />;
  if (tab === "docs")
    return (
      <DocView
        {...props}
        docs={revision.docs}
        openDoc={openDoc}
        search={search}
        targeted={targeted}
        onOpenDoc={onOpenDoc}
        navigation={htmlNavigation}
        composingPath={composingPath}
        resumedBlockId={resumedBlockId}
      />
    );
  return (
    <Writeup
      {...props}
      writeup={revision.writeup}
      files={revision.files}
      search={search}
      phone={phone}
      visible={visible}
      resumedBlockId={resumedBlockId}
      onCurrentTopic={onCurrentTopic}
    />
  );
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
    navigation: JSON.stringify([seq, search.tab, search.doc, search.thread, hash]),
    elementId: reply ? `thread-${search.thread}` : hash,
    reply,
    threadId: search.thread ?? (hash.startsWith("thread-") ? hash.slice(7) : undefined),
    routeThread: true,
    block: "center" as ScrollLogicalPosition,
  };
}
type PendingReadingIntent = ReturnType<typeof readingIntent> & { token: object; jumpThread: boolean };
function resolveOpenDoc(
  revision: RevisionView,
  search: ReviewSearch,
  intent: ReturnType<typeof readingIntent>,
  openingDoc: string | undefined,
  docsVisible: boolean,
) {
  const selected = revision.docs.find((doc) => doc.path === search.doc);
  if (selected) return selected;
  const thread = revision.threads.find((thread) => thread.id === intent.threadId);
  const placement = thread?.placement.status === "placed" ? thread.placement.location : undefined;
  const target = revision.docs.find(
    (doc) =>
      intent.elementId === `doc-${doc.path}` ||
      intent.elementId === `html-doc-${doc.path}` ||
      (doc.kind === "markdown" && doc.blocks.some((block) => intent.elementId === `block-${block.id}`)) ||
      ((placement?.kind === "doc-span" || placement?.kind === "html-span") &&
        placement.path === doc.path &&
        doc.kind === (placement.kind === "html-span" ? "html" : "markdown")),
  );
  return (
    target ??
    revision.docs.find((doc) => doc.path === openingDoc) ??
    (docsVisible && revision.docs.length === 1 ? revision.docs[0] : undefined)
  );
}
function LoadedReview({
  review,
  published,
  titleRef,
  collapsed,
  setCollapsed,
}: {
  review: ReviewView;
  published: number;
  titleRef: Ref<HTMLHeadingElement>;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}) {
  // Read search and hash from one location: route matches can lag during navigation.
  const location = useLocation();
  const search = validateReviewSearch(location.search);
  const hash = location.hash;
  const [initialRevision] = useState(review.newestRevision);
  const seq = search.rev ?? initialRevision;
  const readingFolds = useMemo(
    () => ({ reviewId: review.id, revision: seq, choices: new Map<string, boolean>() }),
    [review.id, seq],
  );
  const query = useQuery(revisionQuery(review.id, seq));
  const viewedMutation = useViewedMutation(review.id);
  const viewedErrors = useViewedErrors(review.id);
  const onViewed = (paths: string[], viewed: boolean) => viewedMutation.mutate({ revision: seq, paths, viewed });
  const { counts: diffCounts } = useDiffCounts();
  const navigate = useNavigate({ from: "/r/$reviewId" });
  const layout = useLayout();
  const paneMode = usePaneMode();
  const readingId = useId();
  // Resolving the lazy pane does not otherwise rerender this route's pending scroll effect.
  const [, setDiffRendered] = useState(0);
  const onDiffRendered = useCallback(() => setDiffRendered((value) => value + 1), []);
  const navigateDiff = useRef<NavigateDiff | null>(null);
  const onDiffNavigator = useCallback((navigate: NavigateDiff | null) => {
    navigateDiff.current = navigate;
  }, []);
  const [currentTopic, setCurrentTopic] = useState<string>();
  const revision = useViewedRevision(review.id, query.data);
  const diffFiles = revision?.files.filter((file) => file.role === "diff") ?? [];
  const [resumed, setResumed] = useState<(SavedDraft & { tab: NonNullable<ReviewSearch["tab"]> }) | null>(null);
  const resumedPlacement = resumed && revision ? draftPlacement(resumed, revision) : undefined;
  const resumedBlockId =
    resumedPlacement?.status === "placed" && "blockId" in resumedPlacement.location
      ? resumedPlacement.location.blockId
      : undefined;
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
  const useOpening =
    !search.tab ||
    !{ writeup: hasWriteup, files: diffFiles.length > 0, diff: hasDiff, docs: hasDocs, comments: true }[search.tab];
  const tab = useOpening ? opening.tab : (search.tab ?? opening.tab);
  const [lastReadingTab, setLastReadingTab] = useState<Exclude<ReviewSearch["tab"], "diff">>();
  if (tab !== "diff" && lastReadingTab !== tab) setLastReadingTab(tab);
  const readingTab =
    tab === "diff"
      ? (layout !== "phone" && paneMode === "tabs" && lastReadingTab) ||
        (hasWriteup ? "writeup" : hasDocs ? "docs" : "comments")
      : tab;
  const docsVisible = readingTab === "docs" && (paneMode === "split" || tab !== "diff");
  const currentIntent = readingIntent(search, hash, seq);
  const openDoc = revision
    ? resolveOpenDoc(revision, search, currentIntent, useOpening ? opening.doc : undefined, docsVisible)
    : undefined;
  const setRevision = (rev: number) => {
    void navigate({ search: { ...search, tab, rev } });
  };
  const [requested, setRequested] = useState<PendingReadingIntent | null>(null);
  const [threadJump, setThreadJump] = useState<ThreadJump & { navigation: string }>();
  const [htmlNavigation, setHtmlNavigation] = useState<HtmlNavigation>();
  const pending = useRef<PendingReadingIntent | null>(null);
  const previous = useRef<{
    navigation: string;
    elementId: string;
    threadId?: string;
    requested: typeof requested;
  } | null>(null);
  const navigateReading = (next: ReviewSearch, nextHash = "") => {
    // A repeated Resume or link click is a new intent even when the URL is unchanged.
    setRequested({ ...readingIntent(next, nextHash, next.rev ?? initialRevision), token: {}, jumpThread: true });
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
    const thread = draft.threadId ? revision.threads.find((thread) => thread.id === draft.threadId) : undefined;
    if (thread) {
      const location = thread.placement.status === "placed" ? thread.placement.location : undefined;
      setResumed(null);
      navigateReading({
        ...search,
        tab: "comments",
        doc: location?.kind === "doc-span" || location?.kind === "html-span" ? location.path : search.doc,
        thread: draft.threadId,
      });
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
      navigateReading(
        { ...search, tab: "docs", doc: draft.target.path, thread: undefined },
        `html-doc-${draft.target.path}`,
      );
      return;
    }
    const placement = draftPlacement(draft, revision);
    if (placement?.status === "placed" && "blockId" in placement.location) {
      const destination = placement.location.kind === "doc-span" ? "docs" : "writeup";
      setResumed({ ...draft, tab: destination });
      navigateReading(
        {
          ...search,
          tab: destination,
          doc: draft.target.kind === "doc-span" ? draft.target.path : search.doc,
          thread: undefined,
        },
        `block-${placement.location.blockId}`,
      );
    } else {
      const destination = draft.target.kind === "doc-span" ? "docs" : readingTab;
      setResumed({ ...draft, tab: destination });
      navigateReading({
        ...search,
        tab: destination,
        doc: draft.target.kind === "doc-span" ? draft.target.path : search.doc,
        thread: undefined,
      });
    }
  };
  const commentOnReview = () => {
    const target = { kind: "review" } as const;
    const key = draftKey(review.id, target);
    if (!hasDraft(key)) saveDraft(key, "");
    resume({ key, target });
  };
  // Data/DOM changes may fulfill an existing intent, but only navigation creates one.
  useEffect(() => {
    const current = currentIntent;
    if (requested && requested !== previous.current?.requested) pending.current = { ...requested };
    else if (current.navigation !== previous.current?.navigation && pending.current?.navigation !== current.navigation)
      pending.current = {
        ...current,
        token: {},
        // A carried-over hash on a tab, doc or revision change is not a new thread jump.
        jumpThread:
          current.elementId !== previous.current?.elementId || current.threadId !== previous.current?.threadId,
      };
    previous.current = {
      navigation: current.navigation,
      elementId: current.elementId,
      threadId: current.threadId,
      requested,
    };
    const intent = pending.current;
    if (!intent || intent.navigation !== current.navigation) return;
    const complete = () => {
      pending.current = null;
      setThreadJump(undefined);
    };
    const opensThread =
      intent.jumpThread && !intent.reply && intent.threadId && intent.elementId === `thread-${intent.threadId}`;
    if (opensThread && intent.threadId) {
      if (threadJump?.token !== intent.token || threadJump.navigation !== current.navigation) {
        setThreadJump({ threadId: intent.threadId, token: intent.token, navigation: current.navigation });
        // Mount the destination's cards before fulfilling the scroll in the next commit.
        return;
      }
    } else if (threadJump) {
      setThreadJump(undefined);
      return;
    }
    if (!revision) return;
    if (docsVisible && search.doc !== openDoc?.path) {
      const next: ReviewSearch = { ...search, doc: openDoc?.path };
      intent.navigation = readingIntent(next, hash, seq).navigation;
      void navigate({ search: next, hash, replace: true });
      return;
    }
    const thread = revision.threads.find((thread) => thread.id === intent.threadId);
    if (intent.routeThread) {
      if (intent.threadId && !thread) return;
      // Placement selects the destination once for this navigation, never on a refetch.
      intent.routeThread = false;
      setHtmlNavigation(undefined);
      if (thread?.target.kind === "html-span" && (search.tab !== "comments" || search.thread)) {
        const location = thread.placement.status === "placed" ? thread.placement.location : undefined;
        const placed =
          location?.kind === "html-span" &&
          revision.docs.some((doc) => doc.kind === "html" && doc.path === location.path);
        const next: ReviewSearch = {
          ...search,
          tab: placed ? "docs" : "comments",
          doc: placed ? (openDoc?.path ?? location.path) : search.doc,
        };
        const nextHash = `thread-${thread.id}`;
        intent.elementId = placed ? `html-doc-${location.path}` : nextHash;
        if (placed) intent.block = "start";
        intent.reply ||= !placed;
        if (placed) setHtmlNavigation({ threadId: thread.id, intent });
        if (search.tab !== next.tab || search.doc !== next.doc || hash !== nextHash) {
          // The redirect continues this intent; it does not create another one.
          intent.navigation = readingIntent(next, nextHash, seq).navigation;
          void navigate({ search: next, hash: nextHash, replace: true });
          return;
        }
      }
    }
    if (!intent.elementId) {
      complete();
      return;
    }
    if (intent.reply) {
      if (!thread) return;
      complete();
      claimDraft(draftKey(review.id, thread.target, thread.id), search.tab === "docs" ? "reading" : "comments");
      return;
    }
    if (intent.elementId.startsWith("diff-")) {
      if (paneMode === "tabs" && hasDiff && tab !== "diff") {
        const next = { ...search, tab: "diff" as const };
        intent.navigation = readingIntent(next, hash, seq).navigation;
        void navigate({ search: next, hash, replace: true });
        return;
      }
      if (navigateDiff.current?.({ elementId: intent.elementId })) complete();
      return;
    }
    const element = document.getElementById(intent.elementId);
    if (!element) return;
    complete();
    revealReadingTarget(element);
    element.scrollIntoView?.({ block: intent.block });
  });
  const tabProps = {
    id: review.id,
    search: { ...search, tab },
    hasDocs,
    hasDiff,
    hasWriteup,
    unsentCount: review.unsentCount,
    filesCount: diffFiles.length,
    viewedCount: diffFiles.filter((file) => file.viewed === "viewed").length,
  };
  const ready = Math.max(published, review.newestRevision);
  return (
    <AppFrame isReview onCommentReview={revision ? commentOnReview : undefined}>
      <div className="contents" onClickCapture={followReadingLink}>
        <Panes
          inbox={<ReviewInbox collapsed={collapsed} onCollapsedChange={setCollapsed} />}
          tab={tab}
          hasDiff={hasDiff}
          phoneTabs={<PhoneTabs {...tabProps} />}
          tabs={<ReviewTabs {...tabProps} docsCount={revision?.docs.length ?? 0} idBase={readingId} />}
          sendBar={
            <SendBar
              key={review.id}
              reviewId={review.id}
              revision={revision?.seq}
              newestRevision={ready}
              revisionError={query.isError}
              unsentCount={review.unsentCount}
              approved={review.state === "approved"}
              phone={layout === "phone"}
            />
          }
          header={
            <>
              {viewedErrors.errors.map((failure) => (
                <div key={failure.id} role="alert" className="px-4 py-2 text-danger-fg">
                  <p>
                    {failure.error && mutationMessage(failure.error)} <bdi>{failure.failedPaths?.[0]}</bdi>
                    {(failure.failedPaths?.length ?? 0) > 1 &&
                      ` and ${(failure.failedPaths?.length ?? 1) - 1} other files`}
                  </p>
                  <Button size="sm" variant="ghost" onClick={() => viewedErrors.dismiss(failure.id)}>
                    Dismiss
                  </Button>
                </div>
              ))}
              {(layout !== "phone" || tab !== "diff") && (
                <ReviewHeader
                  review={review}
                  revision={revision}
                  seq={seq}
                  ready={ready}
                  phone={layout === "phone"}
                  titleRef={titleRef}
                  onRevisionChange={setRevision}
                  onCommentReview={commentOnReview}
                />
              )}
            </>
          }
          reading={
            <div className="contents">
              <div
                {...(layout !== "phone"
                  ? {
                      role: "tabpanel" as const,
                      id: `${readingId}-reading-panel`,
                      "aria-labelledby": `${readingId}-tab-${readingTab}`,
                    }
                  : {})}
              >
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
                  <ReadingFoldContext value={readingFolds}>
                    {readingTab === "files" ? (
                      <FilesView
                        revision={revision}
                        counts={diffCounts}
                        onViewed={onViewed}
                        onNavigate={(file) =>
                          navigateReading(
                            { ...search, tab: paneMode === "tabs" ? "diff" : "files", thread: undefined },
                            `diff-file-${file.id}`,
                          )
                        }
                      />
                    ) : (
                      <Reading
                        key={`${seq}:${readingTab}`}
                        reviewId={review.id}
                        revision={revision}
                        tab={readingTab}
                        visible={paneMode === "split" || tab !== "diff" || !hasDiff}
                        search={search}
                        openDoc={openDoc}
                        targeted={!!hash || !!search.thread}
                        activeThreadId={currentIntent.threadId}
                        threadJump={threadJump?.navigation === currentIntent.navigation ? threadJump : undefined}
                        onOpenDoc={(path) => navigateReading({ ...search, tab: "docs", doc: path, thread: undefined })}
                        phone={layout === "phone"}
                        onResume={resume}
                        htmlNavigation={htmlNavigation}
                        composingPath={resumed?.target?.kind === "html-span" ? resumed.target.path : undefined}
                        resumedBlockId={resumedBlockId}
                        onCurrentTopic={layout !== "phone" && hasDiff ? setCurrentTopic : undefined}
                      />
                    )}
                  </ReadingFoldContext>
                )}
                {resumed?.target && !isDiffTarget(resumed.target) && (
                  <Composer
                    surface="resumed"
                    placeholder={false}
                    reviewId={review.id}
                    revision={seq}
                    target={resumed.target}
                    topics={revision?.topics}
                    threadId={resumed.threadId}
                    storageKey={resumed.key}
                    onSaved={endResume}
                    onCancel={endResume}
                    wrap={(editor) => (
                      <section aria-label="Resumed comment" className="sticky bottom-0 px-4 pt-4 pb-8 md:pr-8 md:pl-14">
                        {editor}
                      </section>
                    )}
                  />
                )}
              </div>
            </div>
          }
          diff={
            <div
              {...(layout !== "phone" && paneMode === "tabs"
                ? {
                    role: "tabpanel",
                    id: `${readingId}-diff-panel`,
                    "aria-labelledby": `${readingId}-tab-diff`,
                  }
                : {})}
            >
              {revision ? (
                <LazyDiffPane
                  key={seq}
                  reviewId={review.id}
                  revision={revision}
                  resume={resumed?.target && isDiffTarget(resumed.target) ? resumed : undefined}
                  onResumeEnd={endResume}
                  onRendered={onDiffRendered}
                  onNavigator={onDiffNavigator}
                  currentTopic={currentTopic}
                  writeupVisible={readingTab === "writeup" && paneMode === "split"}
                  search={search}
                  onViewed={onViewed}
                />
              ) : (
                <p role={query.isError ? "alert" : "status"} className="p-5">
                  {query.isError ? "Could not load this revision." : "Loading revision…"}
                </p>
              )}
            </div>
          }
        />
      </div>
    </AppFrame>
  );
}
export function ReviewPage() {
  const { reviewId } = useParams({ from: "/r/$reviewId" });
  const query = useQuery(reviewQuery(reviewId));
  const published = usePublishedRevision(reviewId);
  const [collapsed, setCollapsed] = useInboxCollapsed();
  const previousReviewId = useRef(reviewId);
  const pendingFocus = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (previousReviewId.current !== reviewId) {
      previousReviewId.current = reviewId;
      pendingFocus.current = true;
    }
    if (query.isError && !query.data) pendingFocus.current = false;
    if (pendingFocus.current && query.data?.id === reviewId) {
      pendingFocus.current = false;
      titleRef.current?.focus();
    }
  }, [reviewId, query.data, query.isError]);
  if (query.data)
    return (
      <LoadedReview
        key={reviewId}
        review={query.data}
        published={published}
        titleRef={titleRef}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
      />
    );
  return (
    <AppFrame isReview>
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

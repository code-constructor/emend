import type { HtmlSpanTarget } from "@emend/contract";
import { ShieldCheck, TextSelect } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { claimDraft } from "../../lib/composer-owner.ts";
import { draftKey } from "../../lib/drafts.ts";
import { type DocNavigation, FrameToParent, type ParentToFrame } from "../../lib/frame-messages.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import type { ReaderProps } from "./BlockReader.tsx";

export type HtmlNavigation = { threadId: string; intent: unknown };
export function HtmlDocFrame({
  path,
  contentUrl,
  reviewId,
  revision,
  threads,
  topics,
  changedBlocks,
  navigation,
  docNavigation,
  onNavigate,
  composerOpen = false,
}: ReaderProps & {
  path: string;
  contentUrl: string;
  navigation?: HtmlNavigation;
  docNavigation?: DocNavigation;
  onNavigate?: (navigation: DocNavigation) => void;
  composerOpen?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const loads = useRef(0);
  const gone = useRef(false);
  const [away, setAway] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [src, setSrc] = useState(contentUrl);
  const [ready, setReady] = useState(0);
  const [target, setTarget] = useState<HtmlSpanTarget | null>(null);
  const [composing, setComposing] = useState(false);
  const [show, setShow] = useState<HtmlNavigation>();
  const lastScroll = useRef<HtmlNavigation | undefined>(undefined);
  // A parent-requested src change mounts a fresh window and starts its load baseline.
  const mountFrame = useCallback((element: HTMLIFrameElement | null) => {
    frame.current = element;
    if (element) {
      loads.current = 0;
      gone.current = false;
    }
  }, []);
  useEffect(() => {
    if (!docNavigation) return;
    setSrc(`${contentUrl}#${encodeURIComponent(docNavigation.fragment)}`);
    setReady(0);
    setAway(false);
    setShow(undefined);
    setGeneration((value) => value + 1);
  }, [contentUrl, docNavigation]);
  const placed = threads
    .filter(
      (thread) =>
        thread.placement.status === "placed" &&
        thread.placement.location.kind === "html-span" &&
        thread.placement.location.path === path,
    )
    .sort((a, b) => {
      const start = (thread: typeof a) =>
        thread.placement.status === "placed" && thread.placement.location.kind === "html-span"
          ? thread.placement.location.start
          : 0;
      return start(a) - start(b);
    });
  const anchors = JSON.stringify(
    placed.flatMap((thread) =>
      thread.target.kind === "html-span"
        ? [
            {
              threadId: thread.id,
              quote: thread.target.quote,
              prefix: thread.target.prefix,
              suffix: thread.target.suffix,
            },
          ]
        : [],
    ),
  );
  const post = (message: ParentToFrame) => {
    if (!gone.current) frame.current?.contentWindow?.postMessage(message, "*");
  };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (gone.current || !frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
      const parsed = FrameToParent.safeParse(event.data);
      if (!parsed.success) return;
      if (parsed.data.type === "emend:ready") setReady((value) => value + 1);
      else if (parsed.data.type === "emend:navigate") onNavigate?.(parsed.data);
      else if (!composing && !composerOpen) {
        const { quote, prefix, suffix } = parsed.data;
        setTarget({ kind: "html-span", path, quote, prefix, suffix });
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [path, composing, composerOpen, onNavigate]);
  useEffect(() => {
    if (ready && !gone.current)
      frame.current?.contentWindow?.postMessage({ type: "emend:highlight", anchors: JSON.parse(anchors) }, "*");
  }, [ready, anchors]);
  useEffect(() => {
    setShow(navigation);
  }, [navigation]);
  useEffect(() => {
    if (
      !ready ||
      gone.current ||
      !show ||
      lastScroll.current === show ||
      !placed.some((thread) => thread.id === show.threadId)
    )
      return;
    frame.current?.contentWindow?.postMessage({ type: "emend:scroll", threadId: show.threadId }, "*");
    lastScroll.current = show;
  }, [ready, show, placed]);
  const close = () => {
    setComposing(false);
    setTarget(null);
  };
  return (
    <div ref={root} tabIndex={-1} className="space-y-4" id={`html-doc-${path}`}>
      <div>
        <iframe
          ref={mountFrame}
          key={generation}
          sandbox="allow-scripts"
          src={src}
          title={path}
          referrerPolicy="no-referrer"
          className="w-full rounded-md border border-line-1 bg-[#fff]"
          style={{ height: "70vh", minHeight: "320px" }}
          onLoad={() => {
            if (++loads.current <= 1) return;
            gone.current = true;
            setAway(true);
            setReady(0);
            if (!composing) setTarget(null);
          }}
        />
        <p className="mt-2 flex items-center gap-1.5 text-fg-3 [font:var(--type-meta)]">
          <Icon icon={ShieldCheck} size={13} />
          Shown in a sandbox. Scripts in this doc never run.
        </p>
      </div>
      {away && (
        <div role="status" className="space-y-2">
          <p>This doc navigated away.</p>
          <Button
            onClick={() => {
              setSrc(contentUrl);
              setAway(false);
              setReady(0);
              lastScroll.current = undefined;
              setGeneration((value) => value + 1);
            }}
          >
            Reload {path}
          </Button>
        </div>
      )}
      {placed.map((thread) => (
        <div key={thread.id} className="space-y-2">
          <Button
            onClick={() => {
              root.current?.scrollIntoView?.({ block: "start" });
              if (ready) post({ type: "emend:scroll", threadId: thread.id });
              else if (!gone.current) setShow({ threadId: thread.id, intent: {} });
            }}
          >
            Show in doc
          </Button>
          <ThreadCard
            reviewId={reviewId}
            revision={revision}
            changedBlocks={changedBlocks}
            thread={thread}
            topics={topics}
          />
        </div>
      ))}
      {target && !composerOpen && (
        <div
          className={
            composing ? "pt-3" : "sticky bottom-0 space-y-3 rounded-lg border border-line-2 bg-raised p-3 shadow-2"
          }
          style={
            composing
              ? undefined
              : {
                  userSelect: "none",
                  WebkitUserSelect: "none",
                  WebkitTouchCallout: "none",
                  touchAction: "manipulation",
                }
          }
        >
          {composing ? (
            <Composer
              reviewId={reviewId}
              revision={revision}
              target={target}
              topics={topics}
              onSaved={close}
              onCancel={close}
              returnFocus={() =>
                opener.current?.isConnected
                  ? opener.current
                  : (root.current?.closest<HTMLElement>("[data-reading-scroll]") ?? root.current)
              }
            />
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={TextSelect}
              onClick={() => {
                opener.current =
                  document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)
                    ? document.activeElement
                    : null;
                claimDraft(draftKey(reviewId, target), "reading");
                setComposing(true);
              }}
            >
              Comment on selection
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

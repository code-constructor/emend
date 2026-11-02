import type { RevisionView } from "@emend/contract";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, FileCode, FileText } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DocNavigation } from "../../lib/frame-messages.ts";
import type { ReviewSearch } from "../../router.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { BlockReader, type ReaderGroup, type ReaderProps } from "./BlockReader.tsx";
import { HtmlDocFrame, type HtmlNavigation } from "./HtmlDocFrame.tsx";

export function DocView({
  docs,
  openDoc,
  search,
  targeted,
  onOpenDoc,
  navigation,
  composingPath,
  ...props
}: ReaderProps & {
  docs: RevisionView["docs"];
  openDoc?: RevisionView["docs"][number];
  search: ReviewSearch;
  targeted: boolean;
  onOpenDoc: (path: string) => void;
  navigation?: HtmlNavigation;
  composingPath?: string;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const rows = useRef(new Map<string, HTMLAnchorElement>());
  const previous = useRef<{ path?: string; doc?: string } | null>(null);
  const [destination, setDestination] = useState<DocNavigation>();
  const path = openDoc?.path;
  useEffect(() => {
    const last = previous.current;
    previous.current = { path, doc: search.doc };
    if (last && path === last.path) return;
    const focusNavigation = last && last.doc !== search.doc && !targeted;
    setDestination((current) => (current?.path === path ? current : undefined));
    if (path) {
      if (!targeted) {
        const pane = heading.current?.closest("[data-reading-scroll]");
        if (pane) pane.scrollTop = 0;
      }
      if (focusNavigation) heading.current?.focus({ preventScroll: true });
    } else if (last?.path && focusNavigation) {
      const row = rows.current.get(last.path);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView?.({ block: "nearest" });
    }
  }, [path, search.doc, targeted]);
  const follow = (next: DocNavigation) => {
    const doc = docs.find((doc) => doc.path === next.path);
    if (!doc || doc.path === path) return;
    setDestination(doc.kind === "html" && next.fragment ? next : undefined);
    onOpenDoc(doc.path);
  };
  const content =
    openDoc?.kind === "html" ? (
      <HtmlDocFrame
        key={openDoc.contentUrl}
        {...props}
        path={openDoc.path}
        contentUrl={openDoc.contentUrl}
        navigation={navigation}
        docNavigation={destination?.path === openDoc.path ? destination : undefined}
        onNavigate={follow}
        composerOpen={composingPath === openDoc.path}
      />
    ) : undefined;
  const groups = useMemo<ReaderGroup[]>(
    () =>
      openDoc
        ? [
            {
              key: openDoc.path,
              id: `doc-${openDoc.path}`,
              labelledBy: headingId,
              path: openDoc.path,
              blocks: openDoc.kind === "markdown" ? openDoc.blocks : [],
              content,
            },
          ]
        : [],
    [openDoc, headingId, content],
  );
  if (!openDoc)
    return (
      <>
        <h2 className="sr-only">Docs</h2>
        <ul className="flex flex-col gap-2 p-4">
          {docs.map((doc) => {
            const title =
              (doc.kind === "markdown" && doc.blocks.find((block) => block.kind === "heading")?.text) ||
              doc.path.split("/").at(-1);
            return (
              <li key={doc.path}>
                <Link
                  ref={(node) => {
                    if (node) rows.current.set(doc.path, node);
                    else rows.current.delete(doc.path);
                  }}
                  to="/r/$reviewId"
                  params={{ reviewId: props.reviewId }}
                  search={{ ...search, tab: "docs", doc: doc.path, thread: undefined }}
                  hash=""
                  className="em-doc-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-line-1 bg-surface px-3.5 py-3 text-fg-2 no-underline hover:border-line-2 hover:bg-sunken"
                >
                  <Icon icon={doc.kind === "html" ? FileCode : FileText} size={18} />
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <span className="truncate font-sans text-14 leading-[1.3] font-semibold text-fg-1">{title}</span>
                    <span className="em-doc-path truncate font-stretch-mono text-fg-3">{doc.path}</span>
                  </span>
                  <Icon icon={ChevronRight} size={16} />
                </Link>
              </li>
            );
          })}
        </ul>
      </>
    );
  return (
    <div className="em-doc-view" data-multiple-docs={docs.length > 1 ? "" : undefined}>
      <div className="em-doc-bar sticky z-(--z-sticky) flex items-center gap-2 border-b border-line-1 bg-surface px-3 py-1.5">
        {docs.length > 1 && (
          <Button asChild variant="ghost" size="sm" icon={ArrowLeft}>
            <Link
              to="/r/$reviewId"
              params={{ reviewId: props.reviewId }}
              search={{ ...search, tab: "docs", doc: undefined, thread: undefined }}
              hash=""
            >
              All docs
            </Link>
          </Button>
        )}
        <h2
          ref={heading}
          id={headingId}
          tabIndex={-1}
          title={openDoc.path}
          className="em-doc-path min-w-0 truncate font-stretch-mono text-fg-3"
        >
          {openDoc.path}
        </h2>
      </div>
      <BlockReader key={openDoc.path} {...props} groups={groups} />
    </div>
  );
}

import type { RenderedBlock, RevisionView, Target } from "@emend/contract";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { claimDraft } from "../../lib/composer-owner.ts";
import { draftKey } from "../../lib/drafts.ts";
import { blockAnchor, selectionToAnchor } from "../../lib/selection.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { Block } from "./Block.tsx";

export type ReaderProps = {
  reviewId: string;
  revision: number;
  changedBlocks: RevisionView["changedBlocks"];
  threads: RevisionView["threads"];
  resumedBlockId?: string;
};
export type ReaderGroup = {
  key: string;
  id?: string;
  heading: ReactNode;
  blocks: RenderedBlock[];
  path?: string;
  content?: ReactNode;
  topic?: boolean;
  action?: ReactNode;
  meta?: ReactNode;
  subsections?: { key: string; heading: string; blocks: RenderedBlock[] }[];
};
function groupBlocks(group: ReaderGroup) {
  return [...group.blocks, ...(group.subsections?.flatMap((section) => section.blocks) ?? [])];
}
export function BlockReader({
  reviewId,
  revision,
  changedBlocks,
  threads,
  groups,
  resumedBlockId,
}: ReaderProps & {
  groups: ReaderGroup[];
}) {
  const headingBase = useId();
  const root = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState("");
  const openComposer = (next: Target) => {
    claimDraft(draftKey(reviewId, next), "reading");
    setTarget(next);
    setComposing(true);
    setError("");
  };
  const changes = new Map(changedBlocks.map((block) => [block.blockId, block.revision]));
  const targets = useMemo(
    () => new Map(groups.flatMap((group) => groupBlocks(group).map((block) => [block.id, group.path] as const))),
    [groups],
  );
  const blockThreads = new Map<string, RevisionView["threads"]>();
  for (const thread of threads) {
    if (thread.placement.status !== "placed") continue;
    const location = thread.placement.location;
    if (!("blockId" in location) || !targets.has(location.blockId)) continue;
    const path = targets.get(location.blockId);
    if (path === undefined ? location.kind !== "writeup-span" : location.kind !== "doc-span" || location.path !== path)
      continue;
    const group = blockThreads.get(location.blockId) ?? [];
    group.push(thread);
    blockThreads.set(location.blockId, group);
  }
  useEffect(() => {
    const capture = () => {
      if (!root.current || composing) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const anchor = selectionToAnchor(selection, root.current);
      if ("error" in anchor) {
        setTarget(null);
        setError(
          anchor.error === "cross-block"
            ? "Select text within one paragraph"
            : anchor.error === "too-long"
              ? "Select at most 2000 characters."
              : "",
        );
        return;
      }
      const path = targets.get(anchor.blockId);
      setTarget(path === undefined ? { kind: "writeup-span", ...anchor } : { kind: "doc-span", path, ...anchor });
      setError("");
    };
    const element = root.current;
    element?.addEventListener("mouseup", capture);
    element?.addEventListener("keyup", capture);
    return () => {
      element?.removeEventListener("mouseup", capture);
      element?.removeEventListener("keyup", capture);
    };
  }, [composing, targets]);
  const renderBlocks = (blocks: RenderedBlock[], path?: string) =>
    blocks.map((block) => (
      <Block
        key={block.id}
        block={block}
        changedIn={changes.get(block.id)}
        commenting={
          resumedBlockId === block.id || (composing && !!target && "blockId" in target && target.blockId === block.id)
        }
        onComment={() => {
          const anchor = blockAnchor(block);
          if (!anchor.quote) return;
          openComposer(
            path === undefined ? { kind: "writeup-span", ...anchor } : { kind: "doc-span", path, ...anchor },
          );
        }}
      >
        {blockThreads.get(block.id)?.map((thread) => (
          <div key={thread.id} className="mt-2.5 mb-1.5">
            <ThreadCard reviewId={reviewId} revision={revision} thread={thread} changedBlocks={changedBlocks} />
          </div>
        ))}
      </Block>
    ));
  return (
    <div ref={root} className="px-4 pt-4 pb-8 md:pt-7 md:pr-8 md:pb-[72px] md:pl-14">
      <p className="mb-6 text-fg-3 [font:var(--type-meta)]">Select text to comment.</p>
      {groups.map((group, index) => (
        <section
          key={group.key}
          id={group.id}
          aria-labelledby={`${headingBase}-${index}`}
          className={group.topic ? "mt-9 mb-2 border-t border-line-1 pt-5" : "mb-2"}
        >
          <div className="mb-2.5 flex items-center gap-2.5">
            <h2
              id={`${headingBase}-${index}`}
              className="flex min-w-0 flex-1 items-center gap-2.5 wrap-anywhere text-fg-1 [font:var(--type-h2)]"
            >
              {group.heading}
            </h2>
            {group.action}
          </div>
          {group.meta}
          {group.content}
          {renderBlocks(group.blocks, group.path)}
          {group.subsections?.map((section) => (
            <div key={section.key} className="mt-6">
              <h3 className="mb-1.5 text-fg-1 [font:var(--type-h3)]">{section.heading}</h3>
              {renderBlocks(section.blocks, group.path)}
            </div>
          ))}
        </section>
      ))}
      {(error || target) && (
        <div className="sticky bottom-0 space-y-3 rounded-lg border border-line-2 bg-raised p-3 shadow-2">
          {error && <p role="status">{error}</p>}
          {target &&
            (composing ? (
              <>
                <blockquote className="max-h-24 overflow-auto border-l-2 pl-2 text-sm">
                  {"quote" in target && target.quote}
                </blockquote>
                <Composer
                  reviewId={reviewId}
                  revision={revision}
                  target={target}
                  onSaved={() => {
                    setComposing(false);
                    setTarget(null);
                  }}
                  onCancel={() => {
                    setComposing(false);
                    setTarget(null);
                  }}
                />
              </>
            ) : (
              <Button onClick={() => openComposer(target)}>Comment on selection</Button>
            ))}
        </div>
      )}
    </div>
  );
}

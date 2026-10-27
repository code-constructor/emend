import type { RenderedBlock, RevisionView, Target } from "@emend/contract";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { claimDraft } from "../../lib/composer-owner.ts";
import { draftKey } from "../../lib/drafts.ts";
import { diagramAnchor, selectionToAnchor } from "../../lib/selection.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { Button } from "../ui/Button.tsx";
import { BlockView } from "./BlockView.tsx";

export type ReaderProps = {
  reviewId: string;
  revision: number;
  changedBlocks: RevisionView["changedBlocks"];
  threads: RevisionView["threads"];
};
export function BlockReader({
  reviewId,
  revision,
  changedBlocks,
  threads,
  groups,
}: ReaderProps & {
  groups: {
    key: string;
    id?: string;
    heading: ReactNode;
    blocks: RenderedBlock[];
    path?: string;
    content?: ReactNode;
  }[];
}) {
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
    () => new Map(groups.flatMap((group) => group.blocks.map((block) => [block.id, group.path] as const))),
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
  return (
    <div ref={root} className="space-y-6 p-5">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">Select text to comment.</p>
      {groups.map((group) => (
        <section key={group.key} id={group.id} className="space-y-4">
          <h2 className="break-words border-b border-neutral-200 pb-2 font-semibold dark:border-neutral-800">
            {group.heading}
          </h2>
          {group.content}
          {group.blocks.map((block) => (
            <div key={block.id} className="space-y-3">
              <BlockView block={block} changedIn={changes.get(block.id)} />
              {block.kind === "diagram" && diagramAnchor(block).quote && (
                <Button
                  onClick={() => {
                    const anchor = diagramAnchor(block);
                    openComposer(
                      group.path === undefined
                        ? { kind: "writeup-span", ...anchor }
                        : { kind: "doc-span", path: group.path, ...anchor },
                    );
                  }}
                >
                  Comment on diagram
                </Button>
              )}
              {blockThreads.get(block.id)?.map((thread) => (
                <ThreadCard
                  key={thread.id}
                  reviewId={reviewId}
                  revision={revision}
                  thread={thread}
                  changedBlocks={changedBlocks}
                />
              ))}
            </div>
          ))}
        </section>
      ))}
      {(error || target) && (
        <div className="sticky bottom-0 space-y-3 rounded-lg border border-neutral-300 bg-white p-3 shadow-lg dark:border-neutral-700 dark:bg-neutral-950">
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

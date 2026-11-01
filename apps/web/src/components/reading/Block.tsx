import type { RenderedBlock } from "@emend/contract";
import { MessageSquarePlus } from "lucide-react";
import type { ReactNode } from "react";
import { blockAnchor } from "../../lib/selection.ts";
import { ChangedMarker } from "../status/ChangedMarker.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { BlockView } from "./BlockView.tsx";

export function Block({
  block,
  changedIn,
  commenting,
  onComment,
  children,
}: {
  block: RenderedBlock;
  changedIn?: number;
  commenting: boolean;
  onComment: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="em-reading-block relative rounded-sm py-0.5" data-commenting={commenting ? "" : undefined}>
      {changedIn !== undefined && (
        <>
          <span aria-hidden="true" className="absolute inset-y-1 -left-3.5 w-0.5 rounded-[1px] bg-changed-line" />
          <div className="mb-1.5">
            <ChangedMarker revision={changedIn} />
          </div>
        </>
      )}
      <BlockView block={block} />
      {block.kind !== "heading" && blockAnchor(block).quote !== "" && (
        <span className="em-reading-block__comment">
          <IconButton
            icon={MessageSquarePlus}
            label={block.kind === "diagram" ? "Comment on diagram" : "Comment on block"}
            size="sm"
            variant="secondary"
            onMouseUpCapture={(event) => event.stopPropagation()}
            onKeyUpCapture={(event) => event.stopPropagation()}
            onClick={onComment}
          />
        </span>
      )}
      {children}
    </div>
  );
}

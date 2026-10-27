import type { RenderedBlock } from "@emend/contract";
import { MermaidBlock } from "./MermaidBlock.tsx";

export function BlockView({ block, changedIn }: { block: RenderedBlock; changedIn?: number }) {
  const attributes = {
    id: `block-${block.id}`,
    "data-block-id": block.id,
    "data-block-kind": block.kind,
    "data-block-text": block.text,
  };
  return (
    <div className="space-y-2">
      {changedIn !== undefined && (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">Changed in revision {changedIn}</p>
      )}
      {block.kind === "diagram" ? (
        <div {...attributes}>
          <MermaidBlock source={block.source ?? block.text} />
        </div>
      ) : (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: RenderedBlock.html is sanitized by the server; this is the sole rendering boundary.
        <div {...attributes} className="rendered-block" dangerouslySetInnerHTML={{ __html: block.html }} />
      )}
    </div>
  );
}

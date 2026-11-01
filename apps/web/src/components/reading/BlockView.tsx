import type { RenderedBlock } from "@emend/contract";
import { MermaidBlock } from "./MermaidBlock.tsx";

export function BlockView({ block }: { block: RenderedBlock }) {
  const attributes = {
    id: `block-${block.id}`,
    "data-block-id": block.id,
    "data-block-kind": block.kind,
    "data-block-text": block.text,
  };
  return block.kind === "diagram" ? (
    <div {...attributes}>
      <MermaidBlock source={block.source ?? block.text} />
    </div>
  ) : (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: RenderedBlock.html is sanitized by the server; this is the sole rendering boundary.
    <div {...attributes} className="em-prose" dangerouslySetInnerHTML={{ __html: block.html }} />
  );
}

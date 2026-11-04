import type { RenderedBlock } from "@emend/contract";
import { MermaidBlock } from "./MermaidBlock.tsx";

/** A comment's server-rendered, sanitized Markdown. Like BlockView, the only other place that sets HTML. */
export function CommentHtml({ html }: { html: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: ThreadView.comments[].html comes from the server's sanitize pipeline, like RenderedBlock.html.
  return <div className="em-prose em-comment-html" dangerouslySetInnerHTML={{ __html: html }} />;
}

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

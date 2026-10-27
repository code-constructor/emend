import { LIMITS, type RenderedBlock } from "@emend/contract";
import { makeSpan } from "../../../../packages/core/src/place/span.ts";
import { normalizeText } from "../../../../packages/core/src/render/normalize.ts";

export function clipText(text: string, limit: number) {
  const clipped = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}
export function diagramAnchor(block: Pick<RenderedBlock, "id" | "text">) {
  return { blockId: block.id, quote: clipText(normalizeText(block.text), LIMITS.quoteChars), prefix: "", suffix: "" };
}
type Anchor = ReturnType<typeof makeSpan>;
export function selectionToAnchor(
  selection: Selection,
  root: HTMLElement,
): Anchor | { error: "empty" | "cross-block" | "diagram" | "too-long" } {
  if (selection.isCollapsed || selection.rangeCount !== 1) return { error: "empty" };
  const range = selection.getRangeAt(0);
  const blockAt = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-block-id]");
  const first = blockAt(range.startContainer);
  const last = blockAt(range.endContainer);
  if (!first || !last || !root.contains(first) || !root.contains(last)) return { error: "empty" };
  if (first !== last) return { error: "cross-block" };
  const id = first.dataset.blockId;
  const text = first.dataset.blockText;
  if (!id || text === undefined) return { error: "empty" };
  if (first.dataset.blockKind === "diagram")
    return normalizeText(text) ? diagramAnchor({ id, text }) : { error: "empty" };
  const quote = normalizeText(range.toString());
  if (quote.length > LIMITS.quoteChars) return { error: "too-long" };
  if (quote.length === 0 || !quote.isWellFormed()) return { error: "empty" };
  const through = range.cloneRange();
  through.selectNodeContents(first);
  through.setEnd(range.endContainer, range.endOffset);
  const end = normalizeText(through.toString()).length;
  const start = end - quote.length;
  if (start < 0 || normalizeText(text).slice(start, end) !== quote) return { error: "empty" };
  const anchor = makeSpan({ id, text, html: "", kind: "paragraph", section: "" }, start, end);
  if (/^[\uDC00-\uDFFF]/.test(anchor.prefix)) anchor.prefix = anchor.prefix.slice(1);
  anchor.suffix = clipText(anchor.suffix, LIMITS.prefixSuffixChars);
  return anchor;
}

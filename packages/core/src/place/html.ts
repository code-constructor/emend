import type { HtmlSpanTarget, Placement } from "@emend/contract";
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parse } from "parse5";
import { normalizeText } from "../render/normalize.ts";
import { spanCandidates } from "./span.ts";

const omitted = new Set(["script", "style", "template", "noscript"]);

// Bound parse5's actual open-element stack, including the document's html/head/body elements.
export const HTML_NESTING_LIMIT = 512;
class HtmlNestingLimitError extends Error {}

/** Static body textContent only; parse errors or excess nesting make the document unreadable. */
export function docText(html: string): string | null {
  try {
    let openElements = 0;
    const tree = parse(html, {
      scriptingEnabled: true,
      treeAdapter: {
        ...defaultTreeAdapter,
        onItemPush() {
          if (++openElements > HTML_NESTING_LIMIT) throw new HtmlNestingLimitError();
        },
        onItemPop() {
          openElements--;
        },
      },
    });
    const document = tree.childNodes.find((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === "html");
    const body =
      document && defaultTreeAdapter.isElementNode(document)
        ? document.childNodes.find((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === "body")
        : undefined;
    if (!body) return "";
    const parts: string[] = [];
    const pending: DefaultTreeAdapterTypes.Node[] = [body];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (defaultTreeAdapter.isTextNode(node)) parts.push(node.value);
      else if (defaultTreeAdapter.isElementNode(node) && !omitted.has(node.tagName)) {
        // Template content lives separately; only visit ordinary childNodes in document order.
        for (let index = node.childNodes.length - 1; index >= 0; index--) {
          const child = node.childNodes[index];
          if (child) pending.push(child);
        }
      }
    }
    return normalizeText(parts.join(""));
  } catch {
    return null;
  }
}

/** The caller supplies docText's normalized output, which also defines the offset space. */
export function placeHtmlSpan(text: string | null, target: HtmlSpanTarget): Placement {
  if (text === null) return { status: "unplaced", reason: "block-gone" };
  const candidates = spanCandidates(text, target);
  const match = candidates[0];
  if (candidates.length === 1 && match) {
    return { status: "placed", location: { kind: "html-span", path: target.path, ...match } };
  }
  return { status: "unplaced", reason: candidates.length > 1 ? "ambiguous" : "block-gone" };
}

import { fromHtml } from "hast-util-from-html";

const tags = new Set(["script", "link", "img", "source", "video", "audio"]);
/** Parse attributes as HTML so comments and raw-text elements cannot authorize file reads. */
export function htmlAssetReferences(html: string): string[] {
  const refs: string[] = [];
  const tree = fromHtml(html);
  const pending = [...tree.children];
  while (pending.length) {
    const node = pending.pop();
    if (node?.type !== "element") continue;
    if (tags.has(node.tagName))
      for (const key of ["src", "href"]) {
        const value = node.properties[key];
        if (typeof value === "string") refs.push(value);
      }
    for (const child of node.children.toReversed()) pending.push(child);
  }
  return refs;
}

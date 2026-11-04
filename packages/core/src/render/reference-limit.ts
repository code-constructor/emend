type Node = { type: string; identifier?: string; url?: string; title?: string | null; children?: Node[] };

/** The URL and title characters that one comment's link and image references may resolve to, in all. */
export const REFERENCE_URL_CHARS = 32768;

/**
 * Comments only. A short body can reference one long definition thousands of times, and remark-rehype
 * encodes the URL again for every reference, and writes the title again too, so the work grows with
 * references times URL and title length. This runs on the Markdown tree before conversion and throws when
 * the references resolve to too many URL and title characters; the comment then fails like any other render failure and stays plain text.
 */
export function limitReferences() {
  return (tree: Node) => {
    const definitions = new Map<string, number>();
    const references: string[] = [];
    const stack: Node[] = [tree];
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (node.type === "definition" && node.identifier !== undefined) {
        // The walk visits siblings in reverse, so the cost must not depend on order: the largest definition
        // of an identifier counts, whichever one mdast-util-to-hast keeps. The title is written once per
        // reference, like the URL. It keys on the upper-cased identifier, as mdast-util-to-hast does.
        const key = node.identifier.toUpperCase();
        const cost = (node.url?.length ?? 0) + (node.title?.length ?? 0);
        definitions.set(key, Math.max(definitions.get(key) ?? 0, cost));
      } else if ((node.type === "linkReference" || node.type === "imageReference") && node.identifier !== undefined) {
        references.push(node.identifier.toUpperCase());
      }
      if (node.children) stack.push(...node.children);
    }
    let total = 0;
    for (const identifier of references) {
      total += definitions.get(identifier) ?? 0;
      if (total > REFERENCE_URL_CHARS) throw new Error("Comment references too much URL text");
    }
  };
}

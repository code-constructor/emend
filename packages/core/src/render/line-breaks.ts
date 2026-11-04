type Node = { type: string; value?: string; children?: Node[] };

function splitLines(value: string): Node[] {
  const parts: Node[] = [];
  value.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (index > 0) parts.push({ type: "break" });
    if (line) parts.push({ type: "text", value: line });
  });
  return parts;
}

function breakText(node: Node) {
  if (!node.children) return;
  const next: Node[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value && /[\r\n]/.test(child.value)) {
      next.push(...splitLines(child.value));
    } else {
      // Inline code and raw HTML are `inlineCode` and `html` nodes, so they never reach the split.
      breakText(child);
      next.push(child);
    }
  }
  node.children = next;
}

const hasHtml = (node: Node): boolean => node.type === "html" || (node.children?.some(hasHtml) ?? false);

/**
 * Comments only: a single newline inside a paragraph is a line break, as in GitHub comments. A paragraph
 * with inline raw HTML keeps its newlines, and so do headings and table cells.
 *
 * This runs on the Markdown tree before conversion, so fences and inline code are untouched, and the
 * structural newlines rehype writes between list items never turn into breaks. Docs and writeups do not use it.
 */
export function commentLineBreaks() {
  return (tree: Node) => {
    const stack: Node[] = [tree];
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (node.type === "paragraph") {
        if (!hasHtml(node)) breakText(node);
      } else if (node.type !== "code" && node.children) stack.push(...node.children);
    }
  };
}

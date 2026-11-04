import { BlockId } from "@emend/contract";
import rehypeShiki from "@shikijs/rehype/core";
import { toString as hastText } from "hast-util-to-string";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { unified } from "unified";
import { type Block, blocksFromTree, type HtmlRoot, renderData, visitElements } from "./blocks.ts";
import { blockHash } from "./hash.ts";
import { HIGHLIGHT_LINE_CHARS, type HighlightBudget, limitHighlighting } from "./highlight.ts";
import { linkIssueRefs } from "./issue-refs.ts";
import {
  FOOTNOTE_NODE,
  hardenLinks,
  markFootnotes,
  namespaceClasses,
  restoreFootnotes,
  sanitizeSchema,
} from "./sanitize.ts";
import { limitTables, prepareTables } from "./tables.ts";

function isolateDiagrams() {
  return (tree: HtmlRoot) => {
    visitElements(tree, (element) => {
      if (element.tagName !== "pre") return;
      const code = element.children[0];
      if (
        code?.type !== "element" ||
        code.tagName !== "code" ||
        !Array.isArray(code.properties.className) ||
        !code.properties.className.includes("language-mermaid")
      )
        return;
      // remark-rehype adds one terminal newline to nonempty fences.
      const text = hastText(code);
      renderData(element).emendDiagram = text.endsWith("\n") ? text.slice(0, -1) : text;
      element.children = [];
    });
  };
}

async function createProcessor() {
  // Explicit imports keep the server bundle to these grammars and the JavaScript engine.
  const highlighter = await createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [
      import("shiki/langs/ts.mjs"),
      import("shiki/langs/tsx.mjs"),
      import("shiki/langs/js.mjs"),
      import("shiki/langs/jsx.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/css.mjs"),
      import("shiki/langs/html.mjs"),
      import("shiki/langs/md.mjs"),
      import("shiki/langs/yaml.mjs"),
      import("shiki/langs/sh.mjs"),
      import("shiki/langs/go.mjs"),
      import("shiki/langs/py.mjs"),
      import("shiki/langs/sql.mjs"),
      import("shiki/langs/diff.mjs"),
    ],
  });
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(limitTables)
    .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: "" })
    .use(markFootnotes)
    .use(rehypeRaw, { passThrough: [FOOTNOTE_NODE] })
    .use(restoreFootnotes)
    .use(namespaceClasses)
    .use(rehypeSanitize, sanitizeSchema)
    .use(linkIssueRefs)
    .use(hardenLinks)
    .use(isolateDiagrams)
    .use(limitHighlighting, highlighter.getLoadedLanguages())
    .use(rehypeShiki, highlighter, {
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
      stripEndNewline: false,
      tokenizeMaxLineLength: HIGHLIGHT_LINE_CHARS,
      // Unknown languages stay plain; lazy loading and metadata transformers are disabled.
      lazy: false,
    })
    .use(rehypeStringify);
}

let processorPromise: ReturnType<typeof createProcessor> | undefined;

/** Internal entry point for composing sections under one highlighting budget. */
export async function renderMarkdownWithBudget(
  markdown: string,
  section: string,
  highlightBudget: HighlightBudget,
  repoUrl?: string,
): Promise<Block[]> {
  // Check even an empty document: every emitted id must satisfy the contract.
  BlockId.parse(`${section}-00000000`);
  processorPromise ??= createProcessor().catch((error: unknown) => {
    processorPromise = undefined;
    throw error;
  });
  const processor = await processorPromise;
  const { source, tables } = prepareTables(markdown);
  const tree = await processor.run(processor.parse(source), {
    value: source,
    data: { highlightBudget, largeTables: tables, repoUrl },
  });
  return blocksFromTree(tree, section, (node) =>
    processor.stringify(node.type === "root" ? node : { type: "root", children: [node] }),
  );
}

export function renderMarkdown(markdown: string, section: string, repoUrl?: string): Promise<Block[]> {
  return renderMarkdownWithBudget(markdown, section, { highlightedBytes: 0 }, repoUrl);
}

export async function renderDoc(markdown: string, path: string, repoUrl?: string): Promise<Block[]> {
  return renderMarkdown(markdown, `doc-${await blockHash(path)}`, repoUrl);
}

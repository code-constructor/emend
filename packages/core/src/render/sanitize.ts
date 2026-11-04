import { toString as hastText } from "hast-util-to-string";
import { defaultSchema } from "rehype-sanitize";
import {
  type HtmlElement,
  type HtmlNode,
  type HtmlRoot,
  hasBlockChildren,
  renderData,
  visitElements,
} from "./blocks.ts";

const prefix = "user-content-";
const forbiddenTags = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "button",
  "svg",
  "math",
  "noscript",
  "template",
  "textarea",
  "title",
  "xmp",
  "plaintext",
  "noembed",
  "select",
  "base",
  "meta",
  "link",
];
const droppedAttributes = new Set([
  "style",
  "htmlFor",
  "list",
  "headers",
  "useMap",
  "ariaLabelledBy",
  "ariaDescribedBy",
  "ariaControls",
  "ariaOwns",
  "cite",
  "longDesc",
  "srcSet",
  "action",
  "itemType",
  "itemProp",
  "itemScope",
  "accessKey",
  "tabIndex",
]);

// Narrow the default allowlist. In particular, do not enable arbitrary author classes.
export const sanitizeSchema: typeof defaultSchema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter((tag) => !forbiddenTags.includes(tag)),
  clobberPrefix: prefix,
  attributes: Object.fromEntries(
    Object.entries(defaultSchema.attributes ?? {}).map(([tag, attributes]) => [
      tag,
      attributes.filter((attribute) => {
        const name = typeof attribute === "string" ? attribute : attribute[0];
        return !name.toLowerCase().startsWith("data") && !droppedAttributes.has(name);
      }),
    ]),
  ),
  protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto"], src: ["http", "https"] },
  strip: [...new Set([...(defaultSchema.strip ?? []), ...forbiddenTags])],
};

export const FOOTNOTE_NODE = "emendFootnoteMarker";
type FootnoteNode = { type: typeof FOOTNOTE_NODE; data: { element: HtmlElement } };

function isGfmMarker(element: HtmlElement): boolean {
  if (element.tagName === "a" && Object.hasOwn(element.properties, "dataFootnoteBackref")) {
    return /^↩(\d+)?$/.test(hastText(element));
  }
  const link = element.children[0];
  return (
    element.tagName === "sup" &&
    element.children.length === 1 &&
    link?.type === "element" &&
    link.tagName === "a" &&
    Object.hasOwn(link.properties, "dataFootnoteRef") &&
    /^\d+$/.test(hastText(element))
  );
}

/** Run before rehype-raw: author HTML is still raw text, so only generated GFM nodes can match. */
export function markFootnotes() {
  return (tree: HtmlRoot) => {
    const pending: HtmlNode[] = [tree];
    for (let parent = pending.pop(); parent; parent = pending.pop()) {
      if (!("children" in parent)) continue;
      for (const [index, child] of parent.children.entries()) {
        if (child.type === "element" && isGfmMarker(child)) {
          renderData(child).emendFootnoteMarker = true;
          const carrier: FootnoteNode = { type: FOOTNOTE_NODE, data: { element: child } };
          // rehype-raw's documented passThrough supports custom nodes, outside HAST's standard union.
          parent.children[index] = carrier as unknown as HtmlElement;
        } else pending.push(child);
      }
    }
  };
}

/** Restore the original generated nodes before sanitize; raw HTML cannot create a custom AST type. */
export function restoreFootnotes() {
  return (tree: HtmlRoot) => {
    const pending: HtmlNode[] = [tree];
    for (let parent = pending.pop(); parent; parent = pending.pop()) {
      if (!("children" in parent)) continue;
      for (const [index, child] of parent.children.entries()) {
        if ((child as { type: string }).type === FOOTNOTE_NODE) {
          parent.children[index] = (child as unknown as FootnoteNode).data.element;
        } else pending.push(child);
      }
    }
  };
}

/** Store only generated, namespaced class tokens in AST metadata, never HTML attributes. */
export function namespaceClasses() {
  return (tree: HtmlRoot) => {
    visitElements(tree, (element) => {
      const classes = element.properties.className;
      if (!Array.isArray(classes)) return;
      renderData(element).emendClasses = classes.flatMap((value) =>
        String(value)
          .split(/\s+/)
          .filter(Boolean)
          .map((value) => (element.tagName === "code" && /^language-./.test(value) ? value : `${prefix}${value}`)),
      );
    });
  };
}

function isAbsoluteUrl(value: unknown, allowMail: boolean): value is string {
  if (typeof value !== "string") return false;
  // `http:other.md` and `http:/path` can resolve against the app's own origin.
  if (!/^https?:\/\//i.test(value) && !(allowMail && /^mailto:/i.test(value))) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || (allowMail && url.protocol === "mailto:");
  } catch {
    return false;
  }
}

/** Runs only after sanitize. AST metadata cannot be supplied through raw HTML attributes. */
export function hardenLinks() {
  return (tree: HtmlRoot) => {
    visitElements(tree, (element) => {
      const classes = renderData(element).emendClasses;
      if (
        Array.isArray(classes) &&
        classes.every(
          (value) =>
            typeof value === "string" &&
            (value.startsWith(prefix) || (element.tagName === "code" && /^language-./.test(value))),
        )
      ) {
        element.properties.className = classes;
      }
      const { href, src } = element.properties;
      if (isAbsoluteUrl(href, true) && !(element.tagName === "a" && hasBlockChildren(element))) {
        element.properties.rel = ["noopener", "noreferrer", "nofollow"];
        // Only the server decides: an absolute web link opens in a new tab and never replaces the app.
        if (element.tagName === "a" && /^https?:/i.test(href)) element.properties.target = "_blank";
        else delete element.properties.target;
      } else {
        delete element.properties.href;
        delete element.properties.rel;
        delete element.properties.target;
      }
      if (!isAbsoluteUrl(src, false)) delete element.properties.src;
    });
  };
}

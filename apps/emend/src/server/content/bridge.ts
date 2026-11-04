export const BRIDGE_SOURCE = String.raw`(() => {
  "use strict";
  const omitted = new Set(["script", "style", "template", "noscript"]);
  const post = message => window.parent.postMessage(message, "*");
  const ranges = new Map();
  let highlightStyle = false;

  // Map normalized UTF-16 offsets back to body text nodes without modifying the DOM.
  function model() {
    const nodes = [];
    const parts = [];
    let length = 0;
    const pending = document.body ? [document.body] : [];
    while (pending.length) {
      const node = pending.pop();
      if (node.nodeType === 3) {
        nodes.push({ node, start: length, end: length + node.data.length });
        parts.push(node.data);
        length += node.data.length;
      } else if (node.nodeType === 1 && !omitted.has(node.localName.toLowerCase())) {
        for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]);
      }
    }
    const raw = parts.join("");
    const chunks = [];
    const texts = [];
    let size = 0;
    function add(value, start, end) {
      chunks.push({ start: size, end: size + value.length, rawStart: start, rawEnd: end,
        identity: raw.slice(start, end) === value });
      texts.push(value);
      size += value.length;
    }
    for (const match of raw.matchAll(/\p{White_Space}+|[^\p{White_Space}]+/gu)) {
      const value = match[0];
      if (/^\p{White_Space}/u.test(value)) add(" ", match.index, match.index + value.length);
      else if (value === value.normalize("NFC")) add(value, match.index, match.index + value.length);
      else {
        for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
          const start = match.index + part.index;
          add(part.segment.normalize("NFC"), start, start + part.segment.length);
        }
      }
    }
    const joined = texts.join("");
    const trim = joined.length - joined.trimStart().length;
    const text = joined.trim();
    function normalizedOffset(rawOffset, end) {
      for (const chunk of chunks) {
        if (rawOffset <= chunk.rawStart) return Math.max(0, Math.min(text.length, chunk.start - trim));
        if (rawOffset < chunk.rawEnd) {
          const offset = chunk.identity ? chunk.start + rawOffset - chunk.rawStart : end ? chunk.end : chunk.start;
          return Math.max(0, Math.min(text.length, offset - trim));
        }
      }
      return text.length;
    }
    function rawOffset(offset, end) {
      offset += trim;
      for (const chunk of chunks) {
        if (offset < chunk.end || (end && offset === chunk.end))
          return chunk.identity ? chunk.rawStart + offset - chunk.start : end ? chunk.rawEnd : chunk.rawStart;
      }
      return raw.length;
    }
    function point(offset, end) {
      for (const entry of nodes) {
        if (offset < entry.end || (end && offset === entry.end)) return [entry.node, Math.max(0, offset - entry.start)];
      }
      const last = nodes[nodes.length - 1];
      return last ? [last.node, last.node.data.length] : null;
    }
    function range(start, end) {
      const first = point(rawOffset(start, false), false);
      const last = point(rawOffset(end, true), true);
      if (!first || !last) return null;
      const result = document.createRange();
      result.setStart(...first); result.setEnd(...last);
      return result;
    }
    function boundary(container, offset, end) {
      const direct = nodes.find(entry => entry.node === container);
      if (direct) return normalizedOffset(direct.start + offset, end);
      const before = document.createRange();
      before.selectNodeContents(document.body);
      before.setEnd(container, offset);
      let position = 0;
      for (const entry of nodes) {
        if (before.comparePoint(entry.node, entry.node.data.length) > 0) break;
        position = entry.end;
      }
      return normalizedOffset(position, end);
    }
    return { text, range, boundary };
  }
  function capture() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !document.body) return;
    const range = selection.getRangeAt(0);
    if (!document.body.contains(range.startContainer) || !document.body.contains(range.endContainer)) return;
    const value = model();
    let start = value.boundary(range.startContainer, range.startOffset, false);
    let end = value.boundary(range.endContainer, range.endOffset, true);
    const selected = value.text.slice(start, end);
    start += selected.length - selected.trimStart().length;
    end -= selected.length - selected.trimEnd().length;
    const quote = value.text.slice(start, end);
    if (!quote || quote.length > 2000) return;
    post({ type: "emend:anchor", quote, prefix: value.text.slice(Math.max(0, start - 32), start), suffix: value.text.slice(end, end + 32) });
  }
  function highlight(anchors) {
    ranges.clear();
    const supported = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
    if (supported) CSS.highlights.delete("emend-quotes");
    const value = model();
    for (const anchor of anchors) {
      if (!anchor || typeof anchor.threadId !== "string" || typeof anchor.quote !== "string" || !anchor.quote || anchor.quote.length > 2000 ||
        typeof anchor.prefix !== "string" || anchor.prefix.length > 32 || typeof anchor.suffix !== "string" || anchor.suffix.length > 32) continue;
      const pattern = anchor.prefix + anchor.quote + anchor.suffix;
      const found = value.text.indexOf(pattern);
      if (found < 0 || value.text.indexOf(pattern, found + 1) >= 0) continue;
      const start = found + anchor.prefix.length;
      const range = value.range(start, start + anchor.quote.length);
      if (!range) continue;
      ranges.set(anchor.threadId, range);
    }
    if (supported && ranges.size) {
      if (!highlightStyle && typeof CSSStyleSheet !== "undefined" && "adoptedStyleSheets" in document) {
        try {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync("::highlight(emend-quotes) { background-color: #fde68a; color: #171717; }");
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          highlightStyle = true;
        } catch { /* Highlight support never requires a DOM fallback. */ }
      }
      CSS.highlights.set("emend-quotes", new Highlight(...ranges.values()));
    }
  }
  window.addEventListener("message", event => {
    if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
    if (event.data.type === "emend:highlight" && Array.isArray(event.data.anchors)) highlight(event.data.anchors);
    else if (event.data.type === "emend:scroll" && typeof event.data.threadId === "string") {
      const range = ranges.get(event.data.threadId);
      if (range) {
        const node = range.startContainer;
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (element) element.scrollIntoView({ block: "center" });
      }
    }
  });
  document.addEventListener("mouseup", capture);
  document.addEventListener("keyup", capture);
  // Touch selections fire no mouseup or keyup; selectionchange covers them and handle drags.
  let settle = 0;
  document.addEventListener("selectionchange", () => {
    window.clearTimeout(settle);
    settle = window.setTimeout(capture, 200);
  });
  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const element = event.target && (event.target.nodeType === 1 ? event.target : event.target.parentElement);
    const link = element && element.closest("a[href]");
    if (!link) return;
    try {
      const current = new window.URL(window.location.href);
      const entry = /^(\/content\/[A-Za-z0-9_-]{43}[0-9a-f]{32}\/)(.+)$/.exec(current.pathname);
      const url = new window.URL(link.getAttribute("href"), document.baseURI);
      if (!entry || url.origin !== current.origin || !url.pathname.startsWith(entry[1])) return;
      const path = decodeURIComponent(url.pathname.slice(entry[1].length));
      if (path === decodeURIComponent(entry[2])) return;
      // Docs use these formats; asset links retain their ordinary navigation behavior.
      if (!/\.(?:html?|md|markdown)$/i.test(path)) return;
      const fragment = decodeURIComponent(url.hash.slice(1));
      event.preventDefault();
      post({ type: "emend:navigate", path, fragment });
    } catch { /* Malformed URLs keep their normal link behavior. */ }
  }, true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => post({ type: "emend:ready" }), { once: true });
  else post({ type: "emend:ready" });
})();`;

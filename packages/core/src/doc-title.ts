import { LIMITS } from "@emend/contract";
import { fromHtml } from "hast-util-from-html";
import { toString as hastText } from "hast-util-to-string";

export const TITLE_PREFIX_BYTES = 64 * 1024;
const TITLE_CANDIDATE_CHARS = LIMITS.titleChars * 4;

export function cleanDocTitle(value: string): string {
  return value
    .replace(/[\s\u0085]/gu, " ")
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Titles intentionally discard terminal and bidi controls.
      /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u{e0000}-\u{e007f}]/gu,
      "",
    )
    .replace(/ +/g, " ")
    .trim()
    .toWellFormed()
    .slice(0, LIMITS.titleChars)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trim();
}

function htmlTitle(bytes: Uint8Array): string | undefined {
  const tree = fromHtml(new TextDecoder().decode(bytes.subarray(0, TITLE_PREFIX_BYTES)));
  const pending = [...tree.children].reverse();
  while (pending.length) {
    const node = pending.pop();
    if (node?.type !== "element") continue;
    if (node.tagName === "title") return cleanDocTitle(hastText(node)) || undefined;
    for (const child of node.children.toReversed()) pending.push(child);
  }
  return undefined;
}

const space = (char: string | undefined) => char === " " || char === "\t";

function fenceMarker(line: string) {
  let start = 0;
  while (start < 4 && line[start] === " ") start++;
  const char = line[start];
  if (start === 4 || (char !== "`" && char !== "~")) return undefined;
  let end = start;
  while (line[end] === char) end++;
  return end - start >= 3 ? { char, length: end - start, end } : undefined;
}

function markdownTitle(bytes: Uint8Array): string | undefined {
  let comment = false;
  let fence: { char: string; length: number } | undefined;
  for (const raw of new TextDecoder().decode(bytes).split(/\r\n|\r|\n/)) {
    // Fence info strings are code metadata, so their comment openers cannot change comment state.
    const marker = !comment ? fenceMarker(raw) : undefined;
    if (fence) {
      if (marker && marker.char === fence.char && marker.length >= fence.length) {
        let end = marker.end;
        while (space(raw[end])) end++;
        if (end === raw.length) fence = undefined;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    let line = raw;
    if (!fence) {
      const parts: string[] = [];
      let start = 0;
      while (start < raw.length) {
        const mark = raw.indexOf(comment ? "-->" : "<!--", start);
        if (!comment) parts.push(raw.slice(start, mark < 0 ? raw.length : mark));
        if (mark < 0) break;
        start = mark + (comment ? 3 : 4);
        comment = !comment;
      }
      line = parts.join("");
    }
    let start = 0;
    while (start < 4 && line[start] === " ") start++;
    if (start === 4) continue;
    const char = line[start];
    if (char !== "#" || !space(line[start + 1])) continue;
    start++;
    while (space(line[start])) start++;
    let end = line.length;
    while (space(line[end - 1])) end--;
    let closing = end;
    while (closing > start && line[closing - 1] === "#") closing--;
    if (closing < end && space(line[closing - 1])) end = closing;
    const title = cleanDocTitle(line.slice(start, Math.min(end, start + TITLE_CANDIDATE_CHARS)));
    if (title) return title;
  }
  return undefined;
}

/** Extract metadata only; HTML parsing never sees more than the bounded byte prefix. */
export function inferDocTitle(kind: "html" | "markdown", bytes: Uint8Array): string | undefined {
  return kind === "html" ? htmlTitle(bytes) : markdownTitle(bytes);
}

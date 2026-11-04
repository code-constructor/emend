import { LIMITS } from "@emend/contract";
import * as html from "hast-util-from-html";
import { afterEach, expect, test, vi } from "vitest";
import { cleanDocTitle, inferDocTitle, TITLE_PREFIX_BYTES } from "./doc-title.ts";

vi.mock("hast-util-from-html", async (original) => ({ ...(await original<typeof import("hast-util-from-html")>()) }));
afterEach(() => vi.restoreAllMocks());
const encode = (text: string) => new TextEncoder().encode(text);

test.each(["<!--".repeat(2 * 1024 * 1024), `<textarea>${"<title>fake</title>".repeat(100000)}</textarea>`])(
  "hostile HTML title parsing is a single bounded call",
  (source) => {
    const parse = vi.spyOn(html, "fromHtml");
    const start = Date.now();
    expect(inferDocTitle("html", encode(source))).toBeUndefined();
    expect(parse).toHaveBeenCalledOnce();
    expect(new TextEncoder().encode(String(parse.mock.calls[0]?.[0])).byteLength).toBeLessThanOrEqual(
      TITLE_PREFIX_BYTES,
    );
    expect(Date.now() - start).toBeLessThan(2000);
  },
  15000,
);

test("HTML inference recognizes real title elements and decodes their text", () => {
  expect(inferDocTitle("html", encode("<!-- <title>fake</title> --><title>Real &amp; safe</title>"))).toBe(
    "Real & safe",
  );
  expect(inferDocTitle("html", encode('<script>"<title>fake</title>"</script><title>Real</title>'))).toBe("Real");
  expect(inferDocTitle("html", encode(`${" ".repeat(TITLE_PREFIX_BYTES)}<title>Late</title>`))).toBeUndefined();
}, 15000);

test("a megabyte of heading whitespace and a long closing hash run stay linear", () => {
  const start = Date.now();
  expect(inferDocTitle("markdown", encode(`#${"\t".repeat(1024 * 1024)}x`))).toBe("x");
  expect(inferDocTitle("markdown", encode(`# Title ${"#".repeat(1024 * 1024)}`))).toBe("Title");
  expect(Date.now() - start).toBeLessThan(2000);
}, 15000);

test.each([
  ["<!--\n# Hidden\n-->\n# Visible ###", "Visible"],
  ["<!-- # Hidden -->\n# Visible", "Visible"],
  ["```md\n<!--\n# Hidden\n```\n# Visible", "Visible"],
  ["~~~\n# Hidden\n~~~\n# Visible", "Visible"],
  ["```html <!--\n# Hidden\n```\n# Visible", "Visible"],
  ["# Hashtags#", "Hashtags#"],
])("Markdown inference skips comments and fences", (source, title) => {
  expect(inferDocTitle("markdown", encode(source))).toBe(title);
});

test.each(["\t", "\n", "\r", "\v", "\f", "\u0085", "\u2028", "\u2029"])(
  "title whitespace separates words",
  (whitespace) => expect(cleanDocTitle(`Foo${whitespace}Bar`)).toBe("Foo Bar"),
);

test("multiline HTML titles and Markdown tabs keep word boundaries", () => {
  expect(inferDocTitle("html", encode("<title>Foo\nBar</title>"))).toBe("Foo Bar");
  expect(inferDocTitle("markdown", encode("# Foo\tBar"))).toBe("Foo Bar");
});

test("clipping a title does not leave trailing whitespace or invisible characters", () => {
  expect(cleanDocTitle(`${"a".repeat(LIMITS.titleChars - 1)} tail`)).toBe("a".repeat(LIMITS.titleChars - 1));
  const invisible =
    "\u200b\u200c\u200d\u200e\u200f\u2060\u2061\u2062\u2063\u2064\u206a\u206b\u206c\u206d\u206e\u206f\u{e0000}\u{e007f}";
  expect(cleanDocTitle(`Foo${invisible}Bar`)).toBe("FooBar");
});

const chars = (...codes: number[]) => codes.map((code) => String.fromCodePoint(code)).join("");

test("titles lose variation selectors but keep the emoji", () => {
  // U+2764 U+FE0F is the emoji presentation of the heart; only the selector goes.
  expect(cleanDocTitle(`${chars(0x2764, 0xfe0f)} Plan`)).toBe(`${chars(0x2764)} Plan`);
  expect(cleanDocTitle(`A${chars(0xe0100, 0xe01ef)}B`)).toBe("AB");
});

test("titles lose tag characters, the grapheme joiner and Hangul fillers", () => {
  expect(cleanDocTitle(`A${chars(0xe0041, 0xe0042, 0xe007f)}B`)).toBe("AB");
  expect(cleanDocTitle(`A${chars(0x34f)}B${chars(0x3164, 0x115f, 0x1160, 0xffa0)}C`)).toBe("ABC");
  expect(cleanDocTitle(`A${chars(0xfff9, 0xfffa, 0xfffb)}B`)).toBe("AB");
});

test("a title made only of removed characters is empty and falls back", () => {
  const removed = chars(0x34f, 0x3164, 0xfe0f, 0xe0041);
  expect(cleanDocTitle(removed)).toBe("");
  expect(inferDocTitle("html", encode(`<title>${removed}</title>`))).toBeUndefined();
});

test("all titles lose controls and bidi formatting and remain well-formed when clipped", () => {
  const controls = "\u0000\u001f\u007f\u0080\u009f\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
  expect(cleanDocTitle(`${controls} A   B ${controls}`)).toBe("A B");
  expect(cleanDocTitle(controls)).toBe("");
  const clipped = cleanDocTitle(`${"a".repeat(LIMITS.titleChars - 1)}😀`);
  expect(clipped).toHaveLength(LIMITS.titleChars - 1);
  expect(clipped.isWellFormed()).toBe(true);
  expect(cleanDocTitle("bad\ud800text").isWellFormed()).toBe(true);
  // HTML parsing replaces NUL with U+FFFD before the extracted title is cleaned.
  expect(inferDocTitle("html", encode(`<title>A${controls}B</title>`))).toBe("A\ufffdB");
  expect(inferDocTitle("markdown", encode(`# A${controls}B`))).toBe("AB");
});

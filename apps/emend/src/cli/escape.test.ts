import { FilePath } from "@emend/contract";
import { expect, test } from "vitest";
import { escapeJson, escapeReference } from "./escape.ts";

test.each([
  0, 10, 127, 128, 159, 0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060,
  0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
])("paths reject and stderr escapes U+%s", (code) => {
  const path = `a${String.fromCodePoint(code)}.txt`;
  expect(FilePath.safeParse(path).success).toBe(false);
  expect(escapeReference(path)).toBe(`a\\u{${code.toString(16)}}.txt`);
});

test.each([0x2028, 0x2029])("stderr escapes Unicode separator U+%s", (code) => {
  expect(escapeReference(`a${String.fromCodePoint(code)}.txt`)).toBe(`a\\u{${code.toString(16)}}.txt`);
});

test("terminal JSON uses Unicode escapes for every terminal control and preserves its value", () => {
  const codes = [
    ...Array.from({ length: 32 }, (_, i) => i),
    ...Array.from({ length: 33 }, (_, i) => 127 + i),
    0x61c,
    0x200b,
    0x200c,
    0x200d,
    0x200e,
    0x200f,
    0x2028,
    0x2029,
    0x202a,
    0x202b,
    0x202c,
    0x202d,
    0x202e,
    0x2060,
    0x2066,
    0x2067,
    0x2068,
    0x2069,
    0x206a,
    0x206b,
    0x206c,
    0x206d,
    0x206e,
    0x206f,
    0xfeff,
  ];
  for (const code of codes) {
    const char = String.fromCodePoint(code);
    const value = { docRoots: [`/synthetic/a${char}b`], openBrowser: false };
    const rendered = escapeJson(JSON.stringify(value));
    expect(rendered).toContain(`\\u${code.toString(16).padStart(4, "0")}`);
    expect(rendered).not.toContain(char);
    expect(JSON.parse(rendered)).toEqual(value);
  }
});

test("terminal JSON leaves literal escape spellings, quotes and ordinary Unicode intact", () => {
  const value = {
    docRoots: ["/synthetic/\\n", "/synthetic/\\u202e", '/synthetic/\\"', "/synthetic/🌱", "/synthetic/café"],
    openBrowser: true,
  };
  expect(escapeJson(JSON.stringify(value))).toBe(JSON.stringify(value));
  expect(JSON.parse(escapeJson(JSON.stringify({ path: "\\\n\\\t\\\b\\\r\\\f" })))).toEqual({
    path: "\\\n\\\t\\\b\\\r\\\f",
  });
});

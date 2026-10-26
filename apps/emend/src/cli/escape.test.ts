import { FilePath } from "@emend/contract";
import { expect, test } from "vitest";
import { escapeReference } from "./escape.ts";

test.each([
  0, 10, 127, 128, 159, 0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060,
  0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
])("paths reject and stderr escapes U+%s", (code) => {
  const path = `a${String.fromCodePoint(code)}.txt`;
  expect(FilePath.safeParse(path).success).toBe(false);
  expect(escapeReference(path)).toBe(`a\\u{${code.toString(16)}}.txt`);
});

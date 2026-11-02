import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FilePath } from "@emend/contract";
import { expect, test } from "vitest";
import { escapeJson, escapeReference, quoteShellArgument } from "./escape.ts";

const shellCases = [
  ["plain path", "/synthetic/docs with spaces", "'/synthetic/docs with spaces'"],
  ["apostrophe", "/synthetic/reviewer's", "'/synthetic/reviewer'\\''s'"],
  ["backslash", "/synthetic/a\\b", "'/synthetic/a\\b'"],
  ["literal escape", "/synthetic/a\\u{a}b", "'/synthetic/a\\u{a}b'"],
  ["newline", "/synthetic/a\nb", "$'/synthetic/a\\x0ab'"],
  ["ESC", "/synthetic/a\u001b[31m", "$'/synthetic/a\\x1b[31m'"],
  ["U+0085", "/synthetic/a\u0085b", "$'/synthetic/a\\xc2\\x85b'"],
  ["U+202E", "/synthetic/a\u202eb", "$'/synthetic/a\\xe2\\x80\\xaeb'"],
  ["U+FEFF", "/synthetic/a\ufeffb", "$'/synthetic/a\\xef\\xbb\\xbfb'"],
  ["mixed escapes", "/synthetic/a\\u{a}'\n🌱", "$'/synthetic/a\\\\u{a}\\'\\x0a🌱'"],
] as const;

test.each(shellCases)("shell argument quoting preserves %s on one terminal line", (_name, value, quoted) => {
  expect(quoteShellArgument(value)).toBe(quoted);
  expect(escapeReference(quoted)).toBe(quoted);
});

for (const [shell, flags] of [
  ["bash", ["--norc", "--noprofile"]],
  ["zsh", ["-f"]],
] as const) {
  for (const locale of ["C", process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"]) {
    for (const [name, value] of shellCases) {
      test(`${shell} decodes the quoted ${name} under LC_ALL=${locale}`, async ({ skip }) => {
        try {
          const result = await promisify(execFile)(shell, [...flags, "-c", `printf %s ${quoteShellArgument(value)}`], {
            env: { PATH: process.env.PATH, LC_ALL: locale },
          });
          expect(result.stdout).toBe(value);
          expect(result.stderr).toBe("");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") skip(`${shell} is not on PATH`);
          else throw error;
        }
      });
    }
  }
}

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

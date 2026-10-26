import { diffLines } from "diff";

// Allows 50 scattered replacements (100 edits), but caps adversarial Myers diff work.
export const LINE_MAP_MAX_EDIT_LENGTH = 256;

/** CRLF and LF delimit the same lines; a terminal delimiter does not add a phantom line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function lineMap(from: string, to: string): (line: number) => number | null {
  const mapped: (number | null)[] = [];
  let oldLine = 1;
  let newLine = 1;
  const changes = diffLines(from, to, {
    stripTrailingCr: true,
    ignoreNewlineAtEof: true,
    maxEditLength: LINE_MAP_MAX_EDIT_LENGTH,
  });
  // An aborted diff supplies no evidence; exact-context tier 2 can still recover the quote.
  if (changes === undefined) return () => null;
  for (const change of changes) {
    if (change.added) newLine += change.count;
    else {
      for (let index = 0; index < change.count; index++) {
        mapped[oldLine++] = change.removed ? null : newLine++;
      }
    }
  }
  return (line) => (Number.isInteger(line) && line > 0 ? (mapped[line] ?? null) : null);
}

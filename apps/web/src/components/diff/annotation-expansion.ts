import type { ParsedDiff } from "./FileDiff.tsx";

type Expansion = { index: number; direction: "up" | "down"; count: number };

// Pierre keys each gap by the following hunk; the tail uses hunks.length.
// "up" grows from the gap's start, "down" from its end (DiffHunksRenderer).
export function annotationExpansions(
  diff: ParsedDiff,
  annotations: { side: "deletions" | "additions"; lineNumber: number; startLine?: number }[],
): Map<string, Expansion> {
  const expansions = new Map<string, Expansion>();
  if (diff.isPartial || !diff.hunks.length) return expansions;
  for (const { side, lineNumber } of annotations.flatMap((annotation) =>
    annotation.startLine === undefined
      ? [annotation]
      : [annotation, { ...annotation, lineNumber: annotation.startLine }],
  )) {
    const length = (side === "deletions" ? diff.deletionLines : diff.additionLines).length;
    if (lineNumber < 1 || lineNumber > length) continue;
    let end = 1;
    for (let index = 0; index <= diff.hunks.length; index++) {
      const hunk = diff.hunks[index];
      const count = hunk ? (side === "deletions" ? hunk.deletionCount : hunk.additionCount) : 0;
      // A zero-count side names the line BEFORE its insertion point.
      const start = hunk
        ? (side === "deletions" ? hunk.deletionStart : hunk.additionStart) + (count === 0 ? 1 : 0)
        : length + 1;
      const size = hunk ? hunk.collapsedBefore : start - end;
      if (lineNumber < start) {
        // One-line gaps are already visible with Pierre's default threshold.
        if (size <= 1 || lineNumber < start - size) break;
        const fromStart = lineNumber - (start - size) + 1;
        const fromEnd = start - lineNumber;
        // Trailing context only supports fromStart, even near EOF.
        const direction = !hunk || fromStart <= fromEnd ? "up" : "down";
        const amount = Math.min(size, (direction === "up" ? fromStart : fromEnd) + 3);
        const key = `${index}:${direction}`;
        const previous = expansions.get(key);
        if (!previous || amount > previous.count) expansions.set(key, { index, direction, count: amount });
        break;
      }
      end = start + count;
      if (lineNumber < end) break;
    }
  }
  return expansions;
}

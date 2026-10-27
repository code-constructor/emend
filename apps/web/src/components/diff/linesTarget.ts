import { type FileView, LIMITS, LinesTarget } from "@emend/contract";
import { splitLines } from "../../../../../packages/core/src/place/linemap.ts";

export type LinesError = "too-many-lines" | "too-long" | "invalid-range";
export function linesTarget(
  file: FileView,
  side: "old" | "new",
  start: number,
  end: number,
  text: string,
): LinesTarget | { error: LinesError } {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
    return { error: "invalid-range" };
  if (end - start + 1 > LIMITS.targetLines) return { error: "too-many-lines" };
  const all = splitLines(text);
  if (end > all.length) return { error: "invalid-range" };
  const lines = all.slice(start - 1, end);
  let chars = lines.reduce((sum, line) => sum + line.length, 0);
  if (chars > LIMITS.targetTextChars) return { error: "too-long" };
  const before: string[] = [],
    after: string[] = [];
  let beforeStopped = false,
    afterStopped = false;
  // Alternate outward so the nearest context on both sides gets the budget first.
  for (let distance = 1; distance <= LIMITS.diffContextLines; distance++) {
    const left = all[start - 1 - distance],
      right = all[end - 1 + distance];
    if (!beforeStopped) {
      if (left === undefined || left.length > LIMITS.contextLineChars || chars + left.length > LIMITS.targetTextChars)
        beforeStopped = true;
      else {
        before.unshift(left);
        chars += left.length;
      }
    }
    if (!afterStopped) {
      if (
        right === undefined ||
        right.length > LIMITS.contextLineChars ||
        chars + right.length > LIMITS.targetTextChars
      )
        afterStopped = true;
      else {
        after.push(right);
        chars += right.length;
      }
    }
  }
  return LinesTarget.parse({
    kind: "lines",
    path: side === "old" ? (file.oldPath ?? file.path) : file.path,
    side,
    start,
    end,
    lines,
    before,
    after,
  });
}

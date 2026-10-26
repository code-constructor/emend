/** KMP over UTF-16 code units or exact lines: linear work, including overlapping matches. */
export function firstTwoMatches<T>(input: ArrayLike<T>, pattern: ArrayLike<T>): number[] {
  if (pattern.length === 0 || pattern.length > input.length) return [];
  const fallback = Array<number>(pattern.length).fill(0);
  let matched = 0;
  for (let index = 1; index < pattern.length; index++) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = fallback[matched - 1] ?? 0;
    if (pattern[index] === pattern[matched]) matched++;
    fallback[index] = matched;
  }
  const found: number[] = [];
  matched = 0;
  for (let index = 0; index < input.length; index++) {
    while (matched > 0 && input[index] !== pattern[matched]) matched = fallback[matched - 1] ?? 0;
    if (input[index] === pattern[matched]) matched++;
    if (matched !== pattern.length) continue;
    found.push(index - pattern.length + 1);
    if (found.length === 2) break;
    matched = fallback[matched - 1] ?? 0;
  }
  return found;
}

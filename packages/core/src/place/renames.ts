/** Compose simultaneous per-revision renames in order; null records deletion, even if a name is reused. */
export function composeRenames(steps: readonly ReadonlyMap<string, string | null>[]): Map<string, string | null> {
  const composed = new Map<string, string | null>();
  // Working backwards resolves each entry once instead of revisiting every earlier path per step.
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (!step) continue;
    const pending: [string, string | null][] = [];
    for (const [from, to] of step) {
      const next = to === null ? null : composed.get(to);
      pending.push([from, next === undefined ? to : next]);
    }
    // Read the whole step before writing: a↔b is a swap, not a chain within one revision.
    for (const [from, to] of pending) composed.set(from, to);
  }
  return composed;
}

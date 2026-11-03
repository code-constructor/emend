import { type RefObject, useLayoutEffect, useState } from "react";
import { layoutStore, useLayoutPreferences } from "../../lib/layout-store.ts";
import type { ParsedDiff } from "./FileDiff.tsx";

export type DiffStyle = "split" | "unified";
export type DiffCounts = { additions: number; deletions: number };

export function diffCounts(diff: ParsedDiff): DiffCounts {
  return diff.hunks.reduce(
    (total, hunk) => ({
      additions: total.additions + hunk.additionLines,
      deletions: total.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function useDiffStyle() {
  const { diffStyle } = useLayoutPreferences();
  return [diffStyle, (next: DiffStyle) => layoutStore.update({ diffStyle: next })] as const;
}

export function useDiffWrap() {
  const { wrap } = useLayoutPreferences();
  return [wrap, (next: boolean) => layoutStore.update({ wrap: next })] as const;
}

export function useNarrowDiffPane(root: RefObject<HTMLElement | null>) {
  const [narrow, setNarrow] = useState<boolean | undefined>(() =>
    typeof ResizeObserver === "undefined" ? false : undefined,
  );
  useLayoutEffect(() => {
    const pane = root.current;
    if (!pane) return;
    if (typeof ResizeObserver === "undefined") {
      setNarrow(false);
      return;
    }
    // Use the same border-box width initially and on every resize notification.
    const measure = () => {
      const width = pane.getBoundingClientRect().width;
      // Hidden Tabs panes retain their last presentation until shown and measured again.
      if (width > 0) setNarrow(width < 760);
    };
    measure();
    const observer = new ResizeObserver((entries) => {
      if (entries.some((entry) => entry.target === pane)) measure();
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [root]);
  return narrow;
}

export function scrollDiffTarget(target: HTMLElement) {
  const pane = target.closest<HTMLElement>("[data-diff-scroll]");
  if (!pane) return;
  const toolbar = pane.querySelector("[data-diff-toolbar]");
  const topic = target.closest("[data-topic]")?.querySelector("[data-topic-header]");
  // A header, its contents, and its section are destinations unobstructed by that header.
  const topicHeight =
    topic && !target.contains(topic) && !topic.contains(target) ? topic.getBoundingClientRect().height : 0;
  const stack = (toolbar?.getBoundingClientRect().height ?? 0) + topicHeight;
  const destination =
    pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientTop - stack - 8;
  const top = Math.max(0, Math.min(destination, Math.max(0, pane.scrollHeight - pane.clientHeight)));
  pane.scrollTo({ top, behavior: "instant" });
}

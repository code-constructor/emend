import { useLayoutEffect, useRef } from "react";
import {
  applyAnchor,
  findAnchor,
  loadReadingPosition,
  type ReadingAnchor,
  saveReadingPosition,
} from "./reading-position.ts";

export const restoreDelays = [0, 100, 300, 800, 1500] as const;
const saveInterval = 250;
const lastKeys = new WeakMap<Element, string>();
// Only keys that scroll the pane count as reader input, and not while typing in a text field.
const scrollKeys = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);
const textEntry = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** What the route knows about navigation intents that scroll (a link, a thread jump, a Resume). */
export type IntentState = {
  /** The current navigation created a scrolling intent. A hash left over from an earlier one does not count. */
  current: boolean;
  /** Counts scrolling intents ever created, so one that came and went while retries ran still stops them. */
  epoch: number;
};

/**
 * Remembers where the reader is in the reading scroller and puts them back after a mount.
 * The scroller is shared by every reading tab, so this lives in the tab content.
 *
 * Rules:
 * - Only the reader saves. A scroll event counts only after reader input (wheel, touch, pointer, key) since
 *   this hook started for its key. Clamping after a shorter tab replaces the content, scroll anchoring, the
 *   last retry and intent jumps are programmatic and neither save nor stop a restore.
 * - Reader input stops the retries at once.
 * - Navigation wins: no restore when the current navigation has a scrolling intent, and the retries stop for
 *   good when a new one appears. A stale hash or an intent that was never fulfilled does not block.
 * - The reader's last anchor is kept in memory and written when the key changes, the pane hides or the tab
 *   unmounts, so nothing depends on measuring the old content late.
 */
export function useReadingPosition({
  storageKey,
  selector,
  active,
  intentState,
}: {
  storageKey: string;
  selector: string;
  active: boolean;
  intentState: () => IntentState;
}) {
  const latestIntentState = useRef(intentState);
  latestIntentState.current = intentState;
  useLayoutEffect(() => {
    if (!active) return;
    const scroller = document.querySelector<HTMLElement>("[data-reading-scroll]");
    if (!scroller) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const startEpoch = latestIntentState.current().epoch;
    // The scroller outlives every tab and doc, so it remembers which content it last showed.
    const lastKey = lastKeys.get(scroller);
    const keyChanged = lastKey !== undefined && lastKey !== storageKey;
    lastKeys.set(scroller, storageKey);
    let restoring = false;
    let reader = false;
    let dirty = false;
    let latest: ReadingAnchor | null = null;
    let throttle: ReturnType<typeof setTimeout> | undefined;
    const stopRestore = () => {
      restoring = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const write = () => {
      if (!dirty) return;
      dirty = false;
      saveReadingPosition(storageKey, latest);
    };
    const onScroll = () => {
      if (!reader) return;
      latest = findAnchor(scroller, selector);
      dirty = true;
      if (throttle === undefined) {
        write();
        throttle = setTimeout(() => {
          throttle = undefined;
          write();
        }, saveInterval);
      }
    };
    const onInput = () => {
      reader = true;
      stopRestore();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") write();
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !scrollKeys.has(event.key)) return;
      const target = event.target;
      // Keys aimed at another pane, the inbox or a control elsewhere do not scroll this pane.
      if (!(target instanceof Node) || (target !== document.body && !scroller.contains(target))) return;
      if (target instanceof HTMLElement && target.closest(textEntry)) return;
      onInput();
    };
    scroller.addEventListener("wheel", onInput, { passive: true });
    scroller.addEventListener("touchstart", onInput, { passive: true });
    scroller.addEventListener("touchmove", onInput, { passive: true });
    scroller.addEventListener("pointerdown", onInput, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("pagehide", write);
    document.addEventListener("visibilitychange", onVisibility);

    const saved = loadReadingPosition(storageKey);
    restoring = true;
    const attempt = (first: boolean) => {
      if (!restoring) return;
      const state = latestIntentState.current();
      if (state.current || state.epoch !== startEpoch) {
        stopRestore();
        return;
      }
      const placed = saved ? applyAnchor(scroller, saved) : undefined;
      // Another doc in the same scroller must not inherit the previous doc's offset: take the anchor or the top.
      // Showing the same content again (a hidden pane, a remount) keeps whatever offset the scroller has.
      if (first && placed === undefined && keyChanged) scroller.scrollTop = 0;
    };
    restoreDelays.forEach((delay, index) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (saved || index === 0) attempt(index === 0);
        if (index === restoreDelays.length - 1) stopRestore();
      }, delay);
      timers.add(timer);
    });
    return () => {
      write();
      stopRestore();
      clearTimeout(throttle);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onInput);
      scroller.removeEventListener("touchstart", onInput);
      scroller.removeEventListener("touchmove", onInput);
      scroller.removeEventListener("pointerdown", onInput);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", write);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, storageKey, selector]);
}

import { z } from "@emend/contract/browser";

export const readingKey = "emend.reading.v1";
export const readingCap = 200;
export type ReadingAnchor = { id: string; fraction: number };
type Entry = ReadingAnchor & { at: number };

const entrySchema = z.object({
  id: z.string().min(1).max(600),
  fraction: z.number().min(0).max(1),
  at: z.number().finite(),
});
const storeSchema = z.record(z.string(), z.unknown());

export function readingPositionKey(reviewId: string, tab: string, doc = "") {
  return [reviewId, tab, doc].join("\n");
}

// Storage may be missing, full or hold anything; every failure leaves the reader at the top.
function readAll(): Record<string, Entry> {
  try {
    const parsed = storeSchema.safeParse(JSON.parse(localStorage.getItem(readingKey) ?? "{}"));
    if (!parsed.success) return {};
    const entries: Record<string, Entry> = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      const entry = entrySchema.safeParse(value);
      if (entry.success) entries[key] = entry.data;
    }
    return entries;
  } catch {
    return {};
  }
}

export function loadReadingPosition(key: string): ReadingAnchor | undefined {
  const entry = readAll()[key];
  return entry ? { id: entry.id, fraction: entry.fraction } : undefined;
}

/** Saves the anchor, or forgets the key when `anchor` is null (the reader is at the top). */
export function saveReadingPosition(key: string, anchor: ReadingAnchor | null, now = Date.now()) {
  try {
    const entries = readAll();
    if (anchor) entries[key] = { id: anchor.id, fraction: Math.min(1, Math.max(0, anchor.fraction)), at: now };
    else delete entries[key];
    const kept = Object.entries(entries)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, readingCap);
    localStorage.setItem(readingKey, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Reading still works without a remembered position.
  }
}

const hidden = (rect: DOMRect) => rect.width === 0 && rect.height === 0;

/**
 * The first anchorable element whose bottom is below the scroller's top edge. Anchors are in document order,
 * so a binary search reads O(log n) rects. An element with an all-zero rect (display: none, a collapsed fold)
 * is never an anchor. Anchors never nest: BlockView renders a leaf div (ids inside block HTML get the
 * user-content- prefix), thread cards are siblings of their block, and an HTML doc holds only its frame.
 */
export function findAnchor(scroller: HTMLElement, selector: string): ReadingAnchor | null {
  if (scroller.scrollTop <= 0) return null;
  const top = scroller.getBoundingClientRect().top;
  const list = Array.from(scroller.querySelectorAll<HTMLElement>(selector));
  const at = (index: number) => list[index] as HTMLElement;
  let found: { element: HTMLElement; rect: DOMRect } | undefined;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let index = mid;
    let rect = at(index).getBoundingClientRect();
    while (hidden(rect) && ++index < hi) rect = at(index).getBoundingClientRect();
    if (index >= hi) {
      hi = mid;
    } else if (rect.bottom > top) {
      found = { element: at(index), rect };
      hi = mid;
    } else {
      lo = index + 1;
    }
  }
  if (found) {
    const fraction = found.rect.height > 0 ? (top - found.rect.top) / found.rect.height : 0;
    return { id: found.element.id, fraction: Math.min(1, Math.max(0, fraction)) };
  }
  // Scrolled past every anchor: the last one that is shown.
  for (let index = list.length - 1; index >= 0; index--)
    if (!hidden(at(index).getBoundingClientRect())) return { id: at(index).id, fraction: 1 };
  return null;
}

/** Scrolls so the anchor sits at the scroller's top. Returns the new scrollTop, or undefined when the element is gone. */
export function applyAnchor(scroller: HTMLElement, anchor: ReadingAnchor): number | undefined {
  const element = document.getElementById(anchor.id);
  if (!element || !scroller.contains(element)) return undefined;
  const rect = element.getBoundingClientRect();
  const delta = rect.top + anchor.fraction * rect.height - scroller.getBoundingClientRect().top;
  if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
  return scroller.scrollTop;
}

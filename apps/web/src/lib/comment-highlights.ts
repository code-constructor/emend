type Reader = { blocks: Map<string, Range>[]; activeThreadId?: string };
type Card = { threadId: string; hovered: boolean };
const readers = new Set<Reader>();
const cards = new Map<HTMLElement, Card>();
let activeCardThreads = new Set<string>();
const normalName = "emend-comment";
const activeName = "emend-comment-active";

export function supportsCommentHighlights() {
  return (
    typeof CSS !== "undefined" &&
    !!CSS.highlights &&
    typeof Highlight !== "undefined" &&
    typeof Intl !== "undefined" &&
    typeof Intl?.Segmenter === "function"
  );
}

function reconcileCards() {
  const next = new Set<string>();
  for (const [card, state] of cards) {
    if (state.hovered || card.contains(card.ownerDocument.activeElement)) next.add(state.threadId);
  }
  activeCardThreads = next;
}

function activeThreadIds() {
  const ids = new Set(activeCardThreads);
  for (const reader of readers) if (reader.activeThreadId) ids.add(reader.activeThreadId);
  return ids;
}

function clearHighlights() {
  for (const name of [normalName, activeName]) {
    try {
      CSS.highlights.delete(name);
    } catch {
      // Highlight failures must not interrupt reading or comment controls.
    }
  }
}

function rebuild() {
  if (!supportsCommentHighlights()) return;
  // Removing a focused descendant need not dispatch focusout.
  reconcileCards();
  if (!readers.size) {
    clearHighlights();
    return;
  }
  const activeIds = activeThreadIds();
  try {
    const normal = new Highlight();
    const active = new Highlight();
    active.priority = 1;
    for (const reader of readers) {
      for (const block of reader.blocks) {
        try {
          for (const [threadId, range] of block) (activeIds.has(threadId) ? active : normal).add(range);
        } catch {
          // A block is atomic: never leave a partial set of its marks behind.
          for (const range of block.values()) {
            normal.delete(range);
            active.delete(range);
          }
        }
      }
    }
    CSS.highlights.set(normalName, normal);
    CSS.highlights.set(activeName, active);
  } catch {
    clearHighlights();
  }
}

export function registerCommentRanges(blocks: Map<string, Range>[]) {
  if (!supportsCommentHighlights()) return;
  const reader: Reader = { blocks };
  readers.add(reader);
  rebuild();
  return {
    setActiveThread(activeThreadId?: string) {
      if (reader.activeThreadId === activeThreadId) return;
      reader.activeThreadId = activeThreadId;
      rebuild();
    },
    unregister() {
      readers.delete(reader);
      rebuild();
    },
  };
}

function cardActivityChanged() {
  const before = activeThreadIds();
  reconcileCards();
  const after = activeThreadIds();
  if (before.size !== after.size || [...after].some((id) => !before.has(id))) rebuild();
}

/** Each card copy owns its hover/focus state; leaving one cannot clear another. */
export function trackCommentCard(card: HTMLElement, threadId: string) {
  if (!supportsCommentHighlights()) return;
  const state = { threadId, hovered: false };
  if (!cards.size) document.addEventListener("focusin", cardActivityChanged, true);
  cards.set(card, state);
  const enter = () => {
    state.hovered = true;
    cardActivityChanged();
  };
  const leave = () => {
    state.hovered = false;
    cardActivityChanged();
  };
  const focusOut = (event: FocusEvent) => {
    // A transfer within the card will be reconciled by document focusin.
    if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
    cardActivityChanged();
  };
  card.addEventListener("pointerenter", enter);
  card.addEventListener("pointerleave", leave);
  card.addEventListener("focusout", focusOut);
  cardActivityChanged();
  return () => {
    card.removeEventListener("pointerenter", enter);
    card.removeEventListener("pointerleave", leave);
    card.removeEventListener("focusout", focusOut);
    cards.delete(card);
    if (!cards.size) document.removeEventListener("focusin", cardActivityChanged, true);
    cardActivityChanged();
  };
}

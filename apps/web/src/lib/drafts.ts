import { Target } from "@emend/contract";

const prefix = "emend.draft.";
const texts = new Map<string, string>();
const listeners = new Set<() => void>();
export type SavedDraft = { key: string; target: Target | null; threadId?: string };

function notify() {
  for (const listener of listeners) listener();
}
// The store lives for this tab, including when no composer is mounted.
window.addEventListener("storage", (event) => {
  try {
    if (event.storageArea && event.storageArea !== localStorage) return;
  } catch {
    // A localStorage event still supplies its value when storage access is denied.
  }
  if (event.key === null) texts.clear();
  else if (event.key.startsWith(prefix)) texts.set(event.key, event.newValue ?? "");
  else return;
  notify();
});

export function draftKey(reviewId: string, target: Target, threadId?: string) {
  const stable = Object.fromEntries(Object.entries(target).sort(([left], [right]) => left.localeCompare(right)));
  return `emend.draft.${reviewId}.${JSON.stringify(stable)}${threadId ? `.reply.${threadId}` : ""}`;
}
export function listDrafts(reviewId: string): SavedDraft[] {
  const drafts: SavedDraft[] = [];
  const reviewPrefix = `${prefix}${reviewId}.`;
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(reviewPrefix)) loadDraft(key);
    }
  } catch {
    /* Storage is optional. */
  }
  for (const [key, body] of texts) {
    if (!key.startsWith(reviewPrefix) || !body) continue;
    const serialized = key.slice(reviewPrefix.length);
    const reply = /\.reply\.([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.exec(serialized);
    try {
      const target = Target.parse(JSON.parse(reply ? serialized.slice(0, reply.index) : serialized));
      drafts.push({ key, target, threadId: reply?.[1] });
    } catch {
      drafts.push({ key, target: null });
    }
  }
  return drafts;
}
export function subscribeDrafts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function loadDraft(key: string) {
  if (!texts.has(key)) {
    let body = "";
    try {
      body = localStorage.getItem(key) ?? "";
    } catch {
      /* The in-memory copy remains available without storage. */
    }
    texts.set(key, body);
  }
  return texts.get(key) ?? "";
}
export function saveDraft(key: string, body: string) {
  texts.set(key, body);
  try {
    if (body) localStorage.setItem(key, body);
    else localStorage.removeItem(key);
  } catch {
    /* Storage is optional. */
  }
  notify();
}
export function clearDraft(key: string) {
  saveDraft(key, "");
}

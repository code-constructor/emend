import { useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";

type Claim = { surface: string; id?: string };
type Entry = { members: Map<string, string>; claim?: Claim; handoff?: Claim };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
function notify() {
  version++;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const snapshot = () => version;
function entry(key: string) {
  let value = entries.get(key);
  if (!value) {
    value = { members: new Map() };
    entries.set(key, value);
  }
  return value;
}
function cancelHandoffs() {
  let changed = false;
  for (const [key, value] of entries) {
    if (!value.handoff) continue;
    if (value.claim === value.handoff) value.claim = undefined;
    value.handoff = undefined;
    if (!value.members.size && !value.claim) entries.delete(key);
    changed = true;
  }
  if (changed) notify();
}
/** An intent may arrive before its surface mounts (navigation or a lazy pane). */
export function claimDraft(key: string, surface: string) {
  cancelHandoffs();
  const value = entry(key);
  value.claim = { surface };
  notify();
}
export function useComposerOwner(key: string, surface: string) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const focused = useRef<Claim | undefined>(undefined);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  useLayoutEffect(() => {
    const value = entry(key);
    value.members.set(id, surface);
    if (value.handoff) {
      value.claim = { surface, id };
      value.handoff = undefined;
    }
    notify();
    return () => {
      value.members.delete(id);
      if (value.claim?.id === id) {
        if (input.current && document.activeElement === input.current) {
          // Keep a focused claim through the replacement's commit, then release it
          // if no editor mounted. Existing copies do not steal a pending move.
          const handoff = value.claim;
          value.handoff = handoff;
          setTimeout(() => {
            if (value.handoff !== handoff) return;
            value.handoff = undefined;
            if (value.claim === handoff) value.claim = undefined;
            if (!value.members.size && entries.get(key) === value) entries.delete(key);
            notify();
          }, 0);
        } else value.claim = undefined;
      }
      if (!value.handoff && !value.members.size && (!value.claim || value.claim.surface === surface))
        entries.delete(key);
      notify();
    };
  }, [key, surface, id]);
  const value = entries.get(key);
  const request = value?.claim;
  // An unclaimed sole copy can be edited. Multiple copies wait for an explicit act.
  const owns = request
    ? request.id
      ? request.id === id
      : request.surface === surface &&
        [...(value?.members.values() ?? [])].filter((member) => member === surface).length <= 1
    : (value?.members.size ?? 0) <= 1;
  const claim = () => {
    cancelHandoffs();
    if (value?.claim?.id === id || (owns && value?.claim?.surface === surface)) return;
    const next = entry(key);
    next.claim = { surface, id };
    notify();
  };
  useLayoutEffect(() => {
    if (!owns || !request || focused.current === request || !input.current) return;
    // A fulfilled surface intent belongs to this instance and ends when it unmounts.
    if (!request.id) {
      request.id = id;
      notify();
    }
    focused.current = request;
    input.current
      .closest<HTMLElement>("[data-thread-card], [data-diff-section]")
      ?.scrollIntoView?.({ block: "center" });
    input.current.focus({ preventScroll: true });
  });
  return { owns, claim, input };
}

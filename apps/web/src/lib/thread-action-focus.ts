import { useCallback, useLayoutEffect, useRef } from "react";

type Button = { node: HTMLButtonElement; mounted: number };
type Intent = { key: string; focused: HTMLButtonElement; mounted: number; timer: ReturnType<typeof setTimeout> };
const buttons = new Map<string, Button>();
let mounted = 0;
let pending: Intent | undefined;
let navigation = 0;

function clearIntent() {
  if (pending) clearTimeout(pending.timer);
  pending = undefined;
  document.removeEventListener("focusin", onFocus, true);
  document.removeEventListener("pointerdown", clearIntent, true);
  document.removeEventListener("keydown", clearIntent, true);
}
function onFocus(event: FocusEvent) {
  if (pending && event.target !== pending.focused) clearIntent();
}
export function cancelThreadActionFocus() {
  navigation++;
  clearIntent();
}
function restore(key: string) {
  const button = buttons.get(key);
  const intent = pending;
  if (!intent || intent.key !== key || !button?.node.isConnected || button.mounted <= intent.mounted) return;
  // Only recover focus lost when our previous button left the DOM. BODY alone
  // does not authorize moving focus, and a replacement consumes the handoff.
  if (intent.focused.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
  intent.focused = button.node;
  button.node.focus({ preventScroll: true });
  if (pending === intent && document.activeElement === button.node) clearIntent();
}

/** A phone sheet can close before its card is replaced by a refreshed group. */
export function useThreadActionFocus(
  reviewId: string,
  threadId: string,
  surface: string,
  action: string,
  editing: boolean,
) {
  const key = JSON.stringify([reviewId, threadId, surface, action]);
  const openedOn = useRef(navigation);
  useLayoutEffect(() => {
    if (editing) openedOn.current = navigation;
  }, [editing]);
  const ref = useCallback(
    (button: HTMLButtonElement | null) => {
      if (!button) return;
      const registration = { node: button, mounted: ++mounted };
      buttons.set(key, registration);
      // Wait until the replacement commit has attached the current card.
      queueMicrotask(() => restore(key));
      return () => {
        if (buttons.get(key) === registration) buttons.delete(key);
      };
    },
    [key],
  );
  const returnFocus = (saved = false) => {
    // A late Sheet close callback must not revive an intent after navigation.
    if (openedOn.current !== navigation) return null;
    clearIntent();
    const button = buttons.get(key);
    if (!button?.node.isConnected) return null;
    button.node.focus({ preventScroll: true });
    // Cancel, Escape and Sheet closing return focus once. Only a successful
    // Save can still be followed by a replacement from its query refresh.
    if (saved && document.activeElement === button.node) {
      pending = { key, focused: button.node, mounted, timer: setTimeout(clearIntent, 1000) };
      document.addEventListener("focusin", onFocus, true);
      document.addEventListener("pointerdown", clearIntent, true);
      document.addEventListener("keydown", clearIntent, true);
    }
    return button.node;
  };
  return { ref, returnFocus };
}

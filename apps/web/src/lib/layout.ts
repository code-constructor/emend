import { useCallback, useState, useSyncExternalStore } from "react";

function useMedia(query: string) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
export function useLayout() {
  const desktop = useMedia("(min-width: 1280px)");
  const tablet = useMedia("(min-width: 768px)");
  return desktop ? "desktop" : tablet ? "tablet" : "phone";
}
const key = "emend.inbox.collapsed";
export function useInboxCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === "true";
    } catch {
      return false;
    }
  });
  return [
    collapsed,
    (value: boolean) => {
      setCollapsed(value);
      try {
        localStorage.setItem(key, String(value));
      } catch {
        /* Storage may be disabled. */
      }
    },
  ] as const;
}

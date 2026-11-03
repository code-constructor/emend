import { useRouter } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";

export function useThreadJump(id: string) {
  const router = useRouter({ warn: false });
  const subscribe = useCallback(
    (notify: () => void) => router?.subscribe("onResolved", notify) ?? (() => {}),
    [router],
  );
  return useSyncExternalStore(subscribe, () => router?.state.location.hash === id);
}

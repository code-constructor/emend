import { createContext, useContext, useLayoutEffect } from "react";

/** Each open editor registers with its block, including editors displayed in a portal. */
export const ThreadComposerContext = createContext<(() => () => void) | null>(null);

export function useThreadComposer(open: boolean) {
  const register = useContext(ThreadComposerContext);
  useLayoutEffect(() => {
    if (open) return register?.();
  }, [register, open]);
}

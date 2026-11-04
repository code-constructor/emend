import { useEffect } from "react";

/**
 * On iOS Safari the keyboard overlays the layout viewport without resizing it, so an element fixed
 * to the layout bottom sits behind the keyboard. While `element` exists, publish the keyboard inset
 * and the visible height as CSS custom properties on it, and keep the focused field in view.
 * Without `window.visualViewport` nothing happens.
 */
export function useVisualViewportInset(element: HTMLElement | null) {
  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!element || !viewport) return;
    let frame = 0;
    let lastInset = 0;
    const names = ["--keyboard-inset", "--visual-height", "--sheet-safe-bottom"];
    const apply = () => {
      frame = 0;
      if (viewport.scale > 1.01) {
        // Pinch zoom shrinks the visual viewport without a keyboard: keep the CSS fallbacks.
        for (const name of names) element.style.removeProperty(name);
        lastInset = 0;
        return;
      }
      const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      element.style.setProperty("--keyboard-inset", `${inset}px`);
      element.style.setProperty("--visual-height", `${Math.round(viewport.height)}px`);
      if (inset > 0) element.style.setProperty("--sheet-safe-bottom", "0px");
      else element.style.removeProperty("--sheet-safe-bottom");
      if (inset === lastInset) return;
      lastInset = inset;
      if (inset === 0) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== element && element.contains(active)) {
        active.scrollIntoView({ block: "nearest" });
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    schedule();
    return () => {
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
      for (const name of names) element.style.removeProperty(name);
    };
  }, [element]);
}

import { type RefObject, useLayoutEffect } from "react";

/**
 * Publishes a sticky header's measured height as a CSS custom property on its host, so the
 * rules below it (a second sticky row, scroll margins) follow the real stack instead of a pixel
 * constant. A header that does not stick publishes 0px.
 */
export function useStickyHeight(
  header: RefObject<HTMLElement | null>,
  host: RefObject<HTMLElement | null>,
  name: string,
  sticky = true,
) {
  useLayoutEffect(() => {
    const element = header.current;
    const target = host.current;
    if (!element || !target) return;
    if (!sticky) {
      target.style.setProperty(name, "0px");
      return () => target.style.removeProperty(name);
    }
    const measure = () => target.style.setProperty(name, `${element.getBoundingClientRect().height}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return () => target.style.removeProperty(name);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      target.style.removeProperty(name);
    };
  }, [header, host, name, sticky]);
}

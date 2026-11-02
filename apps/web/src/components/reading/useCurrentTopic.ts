import type { RenderedWriteup } from "@emend/contract";
import { type RefObject, useEffect } from "react";

export function useCurrentTopic(
  root: RefObject<HTMLDivElement | null>,
  onTopic: ((slug: string | undefined) => void) | undefined,
  sections: RenderedWriteup["sections"],
) {
  useEffect(() => {
    const content = root.current;
    const scroll = content?.closest<HTMLElement>("[data-reading-scroll]");
    if (!content || !scroll || !onTopic) return;
    const slugs = new Set(sections.map((section) => section.topic).filter(Boolean));
    const topics = [...content.querySelectorAll<HTMLElement>('section[id^="topic-"]')].filter((section) =>
      slugs.has(section.id.slice(6)),
    );
    const report = () => {
      const tabs = scroll.querySelector('[role="tablist"]')?.getBoundingClientRect().height ?? 0;
      const top = scroll.getBoundingClientRect().top + tabs + 1;
      const current = topics.findLast((section) => section.getBoundingClientRect().top <= top);
      onTopic(current?.id.slice(6));
    };
    let observer: IntersectionObserver | undefined;
    const observe = () => {
      observer?.disconnect();
      const tabs = scroll.querySelector('[role="tablist"]')?.getBoundingClientRect().height ?? 0;
      // A one-pixel strip at the scroll area's top detects a section crossing it,
      // including sections taller than the viewport. Percentage margins use width.
      observer = new IntersectionObserver(report, {
        root: scroll,
        rootMargin: `-${tabs}px 0px -${Math.max(0, scroll.clientHeight - tabs - 1)}px 0px`,
        threshold: 0,
      });
      for (const topic of topics) observer.observe(topic);
    };
    observe();
    const resize = new ResizeObserver(observe);
    resize.observe(scroll);
    return () => {
      observer?.disconnect();
      resize.disconnect();
      onTopic(undefined);
    };
  }, [root, onTopic, sections]);
}

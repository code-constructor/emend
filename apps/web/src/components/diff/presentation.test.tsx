import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { scrollDiffTarget } from "./presentation.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function scene(height: number, contentHeight: number, targetTop: number, targetHeight: number) {
  const { container } = render(
    <section data-diff-scroll>
      <div data-diff-toolbar />
      <section data-topic="first">
        <header data-topic-header>
          <button type="button">Comment on topic</button>
        </header>
        <article data-thread-card />
      </section>
    </section>,
  );
  const pane = container.querySelector<HTMLElement>("[data-diff-scroll]") as HTMLElement;
  const toolbar = pane.querySelector<HTMLElement>("[data-diff-toolbar]") as HTMLElement;
  const topic = pane.querySelector<HTMLElement>("[data-topic]") as HTMLElement;
  const heading = pane.querySelector<HTMLElement>("[data-topic-header]") as HTMLElement;
  const card = pane.querySelector<HTMLElement>("article") as HTMLElement;
  Object.defineProperties(pane, { clientHeight: { value: height }, scrollHeight: { value: contentHeight } });
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, height));
  vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 41));
  vi.spyOn(heading, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 141, 500, 100));
  vi.spyOn(card, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 100 + targetTop - pane.scrollTop, 500, targetHeight),
  );
  vi.spyOn(topic, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 800, 500, 1000));
  const into = vi.spyOn(pane, "scrollIntoView");
  const by = vi.spyOn(pane, "scrollBy");
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation((options?: ScrollToOptions | number) => {
    if (options && typeof options === "object") pane.scrollTop = options.top ?? 0;
  });
  return { pane, card, topic, toolbar, scroll, into, by };
}

test("a short last file clamps once at the end of the pane and stays inside the viewport", () => {
  const { pane, card, scroll, into, by } = scene(600, 3000, 2900, 40);
  scrollDiffTarget(card);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 2400, behavior: "instant" });
  expect(card.getBoundingClientRect().top - pane.getBoundingClientRect().top).toBe(500);
  expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(pane.getBoundingClientRect().bottom);
  expect(into).not.toHaveBeenCalled();
  expect(by).not.toHaveBeenCalled();
});

test.each([320, 700])(
  "a %s px card keeps its top visible in a 500 px pane below a measured 141 px stack",
  (cardHeight) => {
    const { pane, card, scroll } = scene(500, 3000, 1300, cardHeight);
    pane.scrollTop = 500;
    scrollDiffTarget(card);
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 1151, behavior: "instant" });
    expect(card.getBoundingClientRect().top - pane.getBoundingClientRect().top).toBe(149);
  },
);

test("a topic destination counts only the toolbar above its own header", () => {
  const { topic, scroll } = scene(500, 3000, 1300, 320);
  scrollDiffTarget(topic);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 651, behavior: "instant" });
});

test("a button inside the topic header excludes its own header from the sticky stack", () => {
  const { pane, topic, scroll } = scene(500, 3000, 1300, 320);
  pane.scrollTop = 500;
  const button = topic.querySelector("button") as HTMLButtonElement;
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 155, 100, 30));
  scrollDiffTarget(button);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 506, behavior: "instant" });
});

test("phone scroll uses only its topic header and clamps negative destinations to zero", () => {
  const { toolbar, card, scroll } = scene(500, 3000, 30, 320);
  toolbar.remove();
  scrollDiffTarget(card);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "instant" });
});

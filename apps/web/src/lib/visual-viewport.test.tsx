import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Sheet } from "../components/ui/Sheet.tsx";

class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
  added = 0;
  removed = 0;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    this.added += 1;
    super.addEventListener(type, listener);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    this.removed += 1;
    super.removeEventListener(type, listener);
  }
}

let viewport: FakeViewport;
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  viewport = new FakeViewport();
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true, writable: true });
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "visualViewport");
});

function dialog() {
  return screen.getByRole("dialog");
}

function keyboard(height: number, offsetTop = 0) {
  act(() => {
    viewport.height = height;
    viewport.offsetTop = offsetTop;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    const due = frames;
    frames = [];
    for (const fn of due) fn(0);
  });
}

test("a bottom Sheet follows the visual viewport and returns when the keyboard closes", () => {
  render(
    <Sheet open side="bottom" title="Comment">
      <textarea aria-label="Body" />
    </Sheet>,
  );
  keyboard(500);
  expect(dialog().style.getPropertyValue("--keyboard-inset")).toBe("300px");
  expect(dialog().style.getPropertyValue("--visual-height")).toBe("500px");
  expect(dialog().style.getPropertyValue("--sheet-safe-bottom")).toBe("0px");
  keyboard(800);
  expect(dialog().style.getPropertyValue("--keyboard-inset")).toBe("0px");
  expect(dialog().style.getPropertyValue("--sheet-safe-bottom")).toBe("");
});

test("the inset subtracts the visual viewport offset and never goes negative", () => {
  render(<Sheet open side="bottom" title="Comment" />);
  keyboard(500, 100);
  expect(dialog().style.getPropertyValue("--keyboard-inset")).toBe("200px");
  keyboard(900);
  expect(dialog().style.getPropertyValue("--keyboard-inset")).toBe("0px");
});

test("a bottom Sheet keeps the focused field visible after the inset changes", () => {
  render(
    <Sheet open side="bottom" title="Comment">
      <textarea aria-label="Body" />
    </Sheet>,
  );
  const field = screen.getByLabelText("Body");
  const scroll = vi.fn();
  field.scrollIntoView = scroll;
  field.focus();
  keyboard(500);
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
});

test("listeners are removed when the bottom Sheet closes", () => {
  const view = render(<Sheet open side="bottom" title="Comment" />);
  expect(viewport.added).toBeGreaterThan(0);
  view.rerender(<Sheet open={false} side="bottom" title="Comment" />);
  expect(viewport.removed).toBe(viewport.added);
});

test("a right Sheet ignores the visual viewport", () => {
  render(<Sheet open side="right" title="Inbox" />);
  expect(viewport.added).toBe(0);
  keyboard(500);
  expect(dialog().style.getPropertyValue("--keyboard-inset")).toBe("");
});

test("a bottom Sheet opened while the keyboard is already open applies the inset without an event", () => {
  viewport.height = 500;
  render(<Sheet open side="bottom" title="Comment" />);
  expect(dialog().style.getPropertyValue("--keyboard-inset")).toBe("");
  act(() => {
    const due = frames;
    frames = [];
    for (const fn of due) fn(0);
  });
  expect(dialog().style.getPropertyValue("--keyboard-inset")).toBe("300px");
  expect(dialog().style.getPropertyValue("--visual-height")).toBe("500px");
});

test("pinch zoom is not treated as a keyboard", () => {
  viewport.scale = 2;
  viewport.height = 400;
  render(
    <Sheet open side="bottom" title="Comment">
      <textarea aria-label="Body" />
    </Sheet>,
  );
  const scroll = vi.fn();
  screen.getByLabelText("Body").scrollIntoView = scroll;
  keyboard(400);
  for (const name of ["--keyboard-inset", "--visual-height", "--sheet-safe-bottom"]) {
    expect(dialog().style.getPropertyValue(name)).toBe("");
  }
  expect(scroll).not.toHaveBeenCalled();
});

test("opening without a keyboard does not scroll; the keyboard appearing does", () => {
  render(
    <Sheet open side="bottom" title="Comment">
      <textarea aria-label="Body" />
    </Sheet>,
  );
  const field = screen.getByLabelText("Body");
  const scroll = vi.fn();
  field.scrollIntoView = scroll;
  field.focus();
  keyboard(800);
  expect(scroll).not.toHaveBeenCalled();
  keyboard(500);
  expect(scroll).toHaveBeenCalledTimes(1);
});

test("a bottom Sheet works without visualViewport", () => {
  Reflect.deleteProperty(window, "visualViewport");
  render(<Sheet open side="bottom" title="Comment" />);
  expect(dialog().style.getPropertyValue("--keyboard-inset")).toBe("");
});

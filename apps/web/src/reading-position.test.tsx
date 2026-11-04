// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import type { RenderedBlock, ReviewView, RevisionView, ThreadView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Window } from "happy-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { layoutStore } from "./lib/layout-store.ts";
import { loadReadingPosition, readingKey, readingPositionKey, saveReadingPosition } from "./lib/reading-position.ts";
import { restoreDelays } from "./lib/use-reading-position.ts";

vi.mock("./components/diff/LazyDiffPane.tsx", () => ({
  LazyDiffPane: () => <p>Diff stub</p>,
}));

const id = "11111111-1111-4111-8111-111111111111";
const review: ReviewView = {
  id,
  title: "Synthetic garden",
  origin: { id, name: "Workshop" },
  repo: null,
  branch: null,
  state: "open",
  newestRevision: 1,
  unsentCount: 0,
  openThreads: 0,
  agentWaiting: false,
  pendingSend: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  movedTo: null,
  list: "active",
  snoozed: false,
  snoozedUntil: null,
  releasedAt: null,
  pickedUpAt: null,
  importedAt: null,
  revisions: [
    { seq: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    { seq: 2, createdAt: "2026-01-02T00:00:00.000Z" },
  ],
};
const block = (name: string): RenderedBlock => ({
  id: `overview-${name.padEnd(8, "0")}`,
  section: "overview",
  kind: "paragraph",
  text: `Paragraph ${name}`,
  html: `<p>Paragraph ${name}</p>`,
});
const a = block("aaaa");
const b = block("bbbb");
const c = block("cccc");
const docBlock = (doc: string, name: string): RenderedBlock => ({
  id: `doc-${doc}-${name.padEnd(8, "0")}`,
  section: `doc-${doc}`,
  kind: "paragraph",
  text: `Doc ${doc} ${name}`,
  html: `<p>Doc ${doc} ${name}</p>`,
});
const docA = [docBlock("a1a1a1a1", "1111"), docBlock("a1a1a1a1", "2222"), docBlock("a1a1a1a1", "3333")];
const docB = [docBlock("b2b2b2b2", "1111"), docBlock("b2b2b2b2", "2222"), docBlock("b2b2b2b2", "3333")];
const docs: RevisionView["docs"] = [
  { kind: "markdown", path: "a.md", blocks: docA },
  { kind: "markdown", path: "b.md", blocks: docB },
];
const thread: ThreadView = {
  id: "22222222-2222-4222-8222-222222222222",
  createdOn: 1,
  state: "sent",
  target: { kind: "writeup-span", blockId: "overview-bbbb0000", quote: "Paragraph bbbb", prefix: "", suffix: "" },
  placement: {
    status: "placed",
    location: { kind: "writeup-span", blockId: "overview-bbbb0000", start: 0, end: 9 },
  },
  comments: [{ id, author: "user", body: "A synthetic question", sent: true, sentOn: 1 }],
};
const revisionWith = (seq: number, blocks: RenderedBlock[], threads: ThreadView[] = []): RevisionView => ({
  seq,
  base: null,
  head: null,
  main: "writeup",
  writeupEmpty: false,
  topics: [],
  files: [
    {
      id,
      path: "seed.txt",
      oldPath: null,
      role: "diff",
      topic: null,
      order: 0,
      status: "modified",
      mediaType: "text/plain",
      flag: "binary",
      hasOld: false,
      hasNew: false,
    },
  ],
  writeup: { sections: [{ key: "overview", label: "Body", topic: null, blocks }] },
  docs,
  threads,
  changedBlocks: [],
});
// Document offsets of each block inside the reading scroller; every block is 100px tall.
const offsets = new Map<string, number>();
let revisions: Record<number, RevisionView>;
let client: QueryClient;
let width = 390;
const originalBounds = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
const writeupKey = readingPositionKey(id, "writeup");

beforeEach(() => {
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      const pane = document.querySelector<HTMLElement>("[data-reading-scroll]");
      if (pane && this === pane) return new DOMRect(0, 0, 390, 600);
      const top = this.id.startsWith("block-") ? offsets.get(this.id.slice(6)) : undefined;
      if (top !== undefined) return new DOMRect(0, top - (pane?.scrollTop ?? 0), 390, 100);
      return bounds.call(this);
    },
  });
  width = 390;
  offsets.clear();
  offsets.set(a.id, 0).set(b.id, 100).set(c.id, 200);
  for (const [index, block] of docA.entries()) offsets.set(block.id, index * 100);
  for (const [index, block] of docB.entries()) offsets.set(block.id, index * 100);
  revisions = { 1: revisionWith(1, [a, b, c]), 2: revisionWith(2, [a, b, c]) };
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(query.match(/\d+/)?.[0] ?? Infinity),
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/api/v1/session") return new Response(null, { status: 204 });
      if (path === "/api/v1/reviews") return Response.json({ items: [review] });
      if (path === `/api/v1/reviews/${id}`) return Response.json(review);
      const match = path.match(/\/revisions\/(\d+)$/);
      if (match && path.startsWith(`/api/v1/reviews/${id}`)) return Response.json(revisions[Number(match[1])]);
      throw new Error(`Unexpected synthetic request: ${path}`);
    }),
  );
});
afterEach(async () => {
  cleanup();
  client.clear();
  await (window as unknown as Window).happyDOM.abort();
  vi.restoreAllMocks();
  if (originalBounds) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", originalBounds);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mount(search = "?tab=writeup&rev=1") {
  const history = createMemoryHistory({ initialEntries: [`/r/${id}${search}`] });
  return { ...render(<App queryClient={client} history={history} />), history };
}
const pane = () => screen.getByTestId("reading-pane");
// The reader moves the pane: input first, then the scroll it causes.
function readerScroll(top: number) {
  fireEvent.wheel(pane());
  pane().scrollTop = top;
  fireEvent.scroll(pane());
}
const stored = () => localStorage.getItem(readingKey);
async function readWriteup(search?: string) {
  const view = mount(search);
  await screen.findAllByText("Paragraph bbbb");
  readerScroll(150);
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${b.id}`, fraction: 0.5 });
  return view;
}
const go = (history: ReturnType<typeof mount>["history"], search: string, hash = "") =>
  act(async () => {
    history.push(`/r/${id}${search}${hash}`);
  });

test("Writeup, Diff, Writeup on the phone restores the anchor", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  expect(document.querySelector("[data-reading-scroll]")).toBeNull();
  await go(history, "?tab=writeup&rev=1");
  await screen.findByText("Paragraph bbbb");
  await waitFor(() => expect(pane().scrollTop).toBe(150));
});

test("a new revision with the same block restores; with the block gone it stays at the top", async () => {
  const { history } = await readWriteup();
  revisions[2] = revisionWith(2, [a, c, block("dddd")]);
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  await go(history, "?tab=writeup&rev=2");
  await screen.findByText("Paragraph cccc");
  offsets.set(c.id, 100);
  await new Promise((resolve) => setTimeout(resolve, restoreDelays[2] + 100));
  expect(pane().scrollTop).toBe(0);

  revisions[2] = revisionWith(2, [a, b, c]);
  client.clear();
  await go(history, "?tab=diff&rev=2");
  await go(history, "?tab=writeup&rev=1");
  await screen.findByText("Paragraph bbbb");
  await waitFor(() => expect(pane().scrollTop).toBe(150));
});

test("a link with a hash wins over the saved anchor", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  const scrollIntoView = vi.fn();
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scrollIntoView);
  await go(history, "?tab=writeup&rev=1", `#block-${c.id}`);
  await screen.findByText("Paragraph cccc");
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, restoreDelays[2] + 100));
  expect(pane().scrollTop).toBe(0);
});

test("a thread jump to a thread of the revision wins even when the jump does not move the pane", async () => {
  revisions[1] = revisionWith(1, [a, b, c], [thread]);
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  await go(history, "?tab=writeup&rev=1", `#thread-${thread.id}`);
  await screen.findAllByText("Paragraph bbbb");
  await new Promise((resolve) => setTimeout(resolve, restoreDelays[2] + 100));
  expect(pane().scrollTop).toBe(0);
});

test("a scroll by the reviewer during the retry window stops the retries", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await go(history, "?tab=writeup&rev=1");
  expect(pane().scrollTop).toBe(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(restoreDelays[1] - 1);
  });
  expect(pane().scrollTop).toBe(150);
  readerScroll(40);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(restoreDelays.at(-1) ?? 0);
  });
  expect(pane().scrollTop).toBe(40);
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${a.id}`, fraction: 0.4 });
});

test("touching the pane stops the retries", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await go(history, "?tab=writeup&rev=1");
  expect(pane().scrollTop).toBe(0);
  fireEvent.touchStart(pane());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(restoreDelays.at(-1) ?? 0);
  });
  expect(pane().scrollTop).toBe(0);
});

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
const keyOf = (tab: string, doc = "") => readingPositionKey(id, tab, doc);

test("single-pane Writeup, Docs, Writeup keeps and restores the Writeup entry through a clamp scroll", async () => {
  width = 1280;
  layoutStore.update({ pane: { desktop: "tabs", tablet: "tabs" } });
  const { history } = await readWriteup();
  const saved = stored();
  fakeTimers();
  await go(history, "?tab=docs&rev=1&doc=a.md");
  expect(screen.getByText("Doc a1a1a1a1 2222")).toBeTruthy();
  // The browser clamps the shared scroller when the shorter content arrives.
  pane().scrollTop = 0;
  fireEvent.scroll(pane());
  await tick(restoreDelays.at(-1) ?? 0);
  expect(stored()).toBe(saved);
  await go(history, "?tab=writeup&rev=1");
  await tick(1);
  expect(pane().scrollTop).toBe(150);
  expect(loadReadingPosition(keyOf("writeup"))).toEqual({ id: `block-${b.id}`, fraction: 0.5 });
});

test.each([true, false])("switching docs saves the old doc and restores the new one (saved entry: %s)", async (has) => {
  if (has) saveReadingPosition(keyOf("docs", "b.md"), { id: `block-${docB[2]?.id}`, fraction: 0.5 });
  const { history } = mount("?tab=docs&rev=1&doc=a.md");
  await screen.findByText("Doc a1a1a1a1 2222");
  readerScroll(150);
  fakeTimers();
  await go(history, "?tab=docs&rev=1&doc=b.md");
  await tick(1);
  expect(screen.getByText("Doc b2b2b2b2 2222")).toBeTruthy();
  expect(loadReadingPosition(keyOf("docs", "a.md"))).toEqual({ id: `block-${docA[1]?.id}`, fraction: 0.5 });
  // B never inherits A's offset: it gets its own anchor or the top.
  expect(pane().scrollTop).toBe(has ? 250 : 0);
});

test("two reader scrolls inside the throttle window, then an immediate tab switch, save the second", async () => {
  const { history } = mount();
  await screen.findByText("Paragraph bbbb");
  fakeTimers();
  readerScroll(150);
  readerScroll(250);
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${b.id}`, fraction: 0.5 });
  await go(history, "?tab=diff&rev=1");
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${c.id}`, fraction: 0.5 });
});

test("pagehide saves the latest reader position", async () => {
  mount();
  await screen.findByText("Paragraph bbbb");
  fakeTimers();
  readerScroll(150);
  readerScroll(250);
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${b.id}`, fraction: 0.5 });
  window.dispatchEvent(new Event("pagehide"));
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${c.id}`, fraction: 0.5 });
});

test("a hash that stays in the URL from an earlier navigation does not block the restore", async () => {
  const { history } = await readWriteup(`?tab=writeup&rev=1#block-${c.id}`);
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  await go(history, "?tab=diff&rev=1", `#block-${c.id}`);
  fakeTimers();
  await go(history, "?tab=writeup&rev=1", `#block-${c.id}`);
  await tick(1);
  expect(pane().scrollTop).toBe(150);
});

test("an intent that was never fulfilled does not block a later restore after a new revision", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  await screen.findByText("Diff stub");
  fakeTimers();
  // The target block does not exist: this navigation's own restore yields, and the intent stays unfulfilled.
  await go(history, "?tab=writeup&rev=1", "#block-overview-ffff0000");
  await tick(restoreDelays.at(-1) ?? 0);
  expect(pane().scrollTop).toBe(0);
  await go(history, "?tab=diff&rev=1");
  await go(history, "?tab=writeup&rev=2");
  await tick(1);
  expect(pane().scrollTop).toBe(150);
});

test("scrolls the reader did not make neither stop the restore nor save", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  fakeTimers();
  await go(history, "?tab=writeup&rev=1");
  await tick(1);
  expect(pane().scrollTop).toBe(150);
  // Scroll anchoring or a clamp lands mid-window: the next retry still restores.
  pane().scrollTop = 7;
  fireEvent.scroll(pane());
  await tick(restoreDelays[1]);
  expect(pane().scrollTop).toBe(150);
  await tick(restoreDelays.at(-1) ?? 0);
  // The last retry's scroll event arrives after the retries ended and saves nothing.
  const before = stored();
  pane().scrollTop = 40;
  fireEvent.scroll(pane());
  await tick(500);
  expect(stored()).toBe(before);
});

test("typing in a text field is not reader input, but a scroll key is", async () => {
  mount();
  await screen.findByText("Paragraph bbbb");
  const field = document.createElement("textarea");
  document.body.append(field);
  fireEvent.keyDown(field, { key: "a" });
  fireEvent.keyDown(field, { key: "ArrowDown" });
  fireEvent.keyDown(field, { key: " " });
  // A clamp scroll after typing is not the reader's.
  pane().scrollTop = 150;
  fireEvent.scroll(pane());
  expect(stored()).toBeNull();
  fireEvent.keyDown(document.body, { key: "a" });
  pane().scrollTop = 150;
  fireEvent.scroll(pane());
  expect(stored()).toBeNull();
  fireEvent.keyDown(document.body, { key: "PageDown" });
  fireEvent.scroll(pane());
  expect(loadReadingPosition(writeupKey)).toEqual({ id: `block-${b.id}`, fraction: 0.5 });
  field.remove();
});

test.each([390, 1280])(
  "a tab with no saved entry starts at the top, not at the old tab's offset (%s px)",
  async (px) => {
    width = px;
    if (px > 1000) layoutStore.update({ pane: { desktop: "tabs", tablet: "tabs" } });
    const { history } = mount();
    await screen.findByText("Paragraph bbbb");
    readerScroll(250);
    fakeTimers();
    await go(history, "?tab=comments&rev=1");
    await tick(1);
    expect(pane().scrollTop).toBe(0);
    expect(loadReadingPosition(keyOf("writeup"))).toEqual({ id: `block-${c.id}`, fraction: 0.5 });
  },
);

test("a fulfilled jump no longer blocks a later restore without a navigation", async () => {
  width = 1280;
  const { history } = mount(`?tab=diff&rev=1#block-${c.id}`);
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  await screen.findByText("Paragraph bbbb");
  fakeTimers();
  await tick(restoreDelays.at(-1) ?? 0);
  readerScroll(150);
  // The pane hides and shows again (pane mode change) under the same navigation.
  act(() => layoutStore.update({ pane: { desktop: "tabs", tablet: "tabs" } }));
  expect(history.location.search).toContain("tab=diff");
  pane().scrollTop = 0;
  act(() => layoutStore.update({ pane: { desktop: "split", tablet: "tabs" } }));
  await tick(1);
  expect(pane().scrollTop).toBe(150);
});

test("scroll keys from another pane do not stop the restore", async () => {
  const { history } = await readWriteup();
  await go(history, "?tab=diff&rev=1");
  fakeTimers();
  await go(history, "?tab=writeup&rev=1");
  await tick(1);
  expect(pane().scrollTop).toBe(150);
  pane().scrollTop = 7;
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  fireEvent.keyDown(elsewhere, { key: "ArrowDown" });
  await tick(restoreDelays[1]);
  expect(pane().scrollTop).toBe(150);
  fireEvent.keyDown(document.body, { key: "ArrowDown" });
  pane().scrollTop = 7;
  await tick(restoreDelays.at(-1) ?? 0);
  expect(pane().scrollTop).toBe(7);
  elsewhere.remove();
});

test("reading works when storage throws", async () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("denied");
  });
  mount();
  await screen.findByText("Paragraph bbbb");
  pane().scrollTop = 150;
  expect(() => fireEvent.scroll(pane())).not.toThrow();
  expect(pane().scrollTop).toBe(150);
});

// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RevisionView, ThreadView } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DocView } from "./components/reading/DocView.tsx";
import { draftKey } from "./lib/drafts.ts";
import { FrameToParent, ParentToFrame } from "./lib/frame-messages.ts";

const id = "11111111-1111-4111-8111-111111111111";
const path = "docs/seed.html";
const doc = { kind: "html" as const, path, contentUrl: `/content/${"a".repeat(75)}/${path}` };
const anchor = { quote: "seeds", prefix: "dry ", suffix: " grow" };
const thread: ThreadView = {
  id,
  target: { kind: "html-span", path, ...anchor },
  state: "open",
  createdOn: 1,
  placement: { status: "placed", location: { kind: "html-span", path, start: 4, end: 9 } },
  comments: [{ id, author: "user", body: "Private synthetic comment", sent: true, sentOn: 1 }],
};
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  fetchMock = vi.fn(async () => Response.json({ threadId: id, commentId: id }, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(
  threads: ThreadView[] = [],
  docs: RevisionView["docs"] = [doc],
  navigation?: { threadId: string; intent: unknown },
) {
  const ui = (values: ThreadView[]) => (
    <QueryClientProvider client={client}>
      <DocView reviewId={id} revision={2} changedBlocks={[]} docs={docs} threads={values} navigation={navigation} />
    </QueryClientProvider>
  );
  const view = render(ui(threads));
  const frame = view.container.querySelector("iframe");
  if (!frame) throw new Error("Missing frame");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  const message = (data: unknown, source = frame.contentWindow) =>
    fireEvent(window, new MessageEvent("message", { source, data }));
  return { ...view, frame, post, message, update: (values: ThreadView[]) => view.rerender(ui(values)) };
}
test("all production web frames use the exact sandbox without DOM string insertion", () => {
  for (const file of readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" }).filter(
    (file) => /\.[jt]sx?$/.test(file) && !file.includes(".test."),
  )) {
    const text = readFileSync(join(import.meta.dirname, file), "utf8");
    for (const forbidden of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms"])
      expect(text, file).not.toContain(forbidden);
  }
  const { frame } = mount();
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe(doc.contentUrl);
  expect(frame.getAttribute("title")).toBe(path);
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(frame.hasAttribute("allow")).toBe(false);
  expect(frame.style.height).toBe("70vh");
  expect(frame.style.minHeight).toBe("320px");
});
test("closed strict message schemas enforce every contract limit", () => {
  for (const data of [
    { type: "emend:ready", extra: true },
    { type: "size", height: 400 },
    { type: "emend:anchor", ...anchor, quote: "x".repeat(2001) },
    { type: "emend:anchor", ...anchor, prefix: "x".repeat(33) },
    { type: "emend:anchor", ...anchor, suffix: "x".repeat(33) },
    { type: "emend:anchor", ...anchor, quote: "" },
    { type: "emend:anchor", ...anchor, body: "extra" },
    { type: "emend:navigate", path: "other.html", fragment: "x".repeat(1025) },
    { type: "emend:navigate", path: "../other.html", fragment: "" },
    { type: "emend:navigate", path: "/other.html", fragment: "" },
    { type: "emend:navigate", path: "other.html", fragment: "", body: "extra" },
    { type: "emend:navigate", path: "other.html" },
    { type: "emend:navigate", path: "other.html", fragment: null },
    { type: "emend:navigate", path: "other.html", fragment: "\ud800" },
  ])
    expect(FrameToParent.safeParse(data).success).toBe(false);
  expect(FrameToParent.safeParse({ type: "emend:anchor", ...anchor, quote: "x".repeat(2000) }).success).toBe(true);
  expect(
    ParentToFrame.safeParse({ type: "emend:highlight", anchors: [{ threadId: id, ...anchor, state: "open" }] }).success,
  ).toBe(false);
  expect(ParentToFrame.safeParse({ type: "emend:scroll", threadId: id }).success).toBe(true);
  for (const fragment of ["", "x".repeat(1024)])
    expect(FrameToParent.safeParse({ type: "emend:navigate", path: "other.html", fragment }).success).toBe(true);
});

const otherDoc = {
  kind: "html" as const,
  path: "docs/other.html",
  contentUrl: `/content/${"b".repeat(75)}/docs/other.html`,
};
const markdownDoc = { kind: "markdown" as const, path: "docs/plan.md", blocks: [] };
test("doc navigation scrolls each target section and uses the HTML target's own URL and encoded fragment", () => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { message, frame } = mount([], [doc, otherDoc, markdownDoc]);
  fireEvent.load(frame);
  const otherFrame = screen.getByTitle(otherDoc.path);
  fireEvent.load(otherFrame);
  const fragment = "part é%#";
  message({ type: "emend:navigate", path: otherDoc.path, fragment });
  const target = screen.getByTitle(otherDoc.path) as HTMLIFrameElement;
  expect(target.getAttribute("src")).toBe(`${otherDoc.contentUrl}#${encodeURIComponent(fragment)}`);
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll.mock.instances[0]).toBe(screen.getByRole("heading", { name: otherDoc.path }).closest("section"));
  fireEvent.load(target);
  expect(screen.queryByText("This doc navigated away.")).toBeNull();
  message({ type: "emend:navigate", path: markdownDoc.path, fragment: "heading" });
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(scroll.mock.instances[1]).toBe(screen.getByRole("heading", { name: markdownDoc.path }).closest("section"));
  expect(frame.getAttribute("src")).toBe(doc.contentUrl);
  expect(fetchMock).not.toHaveBeenCalled();
});
test("navigation rejects foreign windows, invalid destinations, invalid fragments and frames that left their doc", () => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { message, frame } = mount([], [doc, otherDoc, markdownDoc]);
  fireEvent.load(frame);
  const target = screen.getByTitle(otherDoc.path);
  message({ type: "emend:navigate", path: otherDoc.path, fragment: "valid" }, window);
  for (const data of [
    { type: "emend:navigate", path, fragment: "self" },
    { type: "emend:navigate", path: "outside.html", fragment: "" },
    { type: "emend:navigate", path: "docs/asset.svg", fragment: "" },
    { type: "emend:navigate", path: otherDoc.path, fragment: "x".repeat(1025) },
    { type: "emend:navigate", path: otherDoc.path, fragment: "", extra: true },
    { type: "emend:navigate", path: otherDoc.path, fragment: "\ud800" },
  ])
    message(data);
  fireEvent.load(frame);
  message({ type: "emend:navigate", path: otherDoc.path, fragment: "valid" });
  message({ type: "emend:navigate", path: markdownDoc.path, fragment: "" });
  expect(scroll).not.toHaveBeenCalled();
  expect(target.getAttribute("src")).toBe(otherDoc.contentUrl);
  expect(screen.getByText("This doc navigated away.")).toBeTruthy();
});
test("parent fragment changes and Reload establish fresh baselines; unexpected loads still lock the frame", () => {
  const { message, frame } = mount([], [doc, otherDoc]);
  fireEvent.load(frame);
  const original = screen.getByTitle(otherDoc.path) as HTMLIFrameElement;
  const oldWindow = { postMessage: vi.fn() };
  Object.defineProperty(original, "contentWindow", { value: oldWindow });
  fireEvent.load(original);
  for (const fragment of ["first", "second", "second"]) {
    message({ type: "emend:navigate", path: otherDoc.path, fragment });
    const target = screen.getByTitle(otherDoc.path) as HTMLIFrameElement;
    const post = vi.fn();
    Object.defineProperty(target, "contentWindow", { value: { postMessage: post } });
    fireEvent.load(target);
    fireEvent(window, new MessageEvent("message", { source: target.contentWindow, data: { type: "emend:ready" } }));
    expect(post).toHaveBeenCalledWith({ type: "emend:highlight", anchors: [] }, "*");
    expect(screen.queryByText("This doc navigated away.")).toBeNull();
    expect(target.getAttribute("src")).toBe(`${otherDoc.contentUrl}#${fragment}`);
  }
  fireEvent(
    window,
    new MessageEvent("message", { source: original.contentWindow, data: { type: "emend:anchor", ...anchor } }),
  );
  expect(screen.queryByText("Comment on selection")).toBeNull();
  const target = screen.getByTitle(otherDoc.path) as HTMLIFrameElement;
  fireEvent.load(target);
  expect(screen.getByText("This doc navigated away.")).toBeTruthy();
  fireEvent.click(screen.getByText(`Reload ${otherDoc.path}`));
  const restored = screen.getByTitle(otherDoc.path);
  expect(restored.getAttribute("src")).toBe(otherDoc.contentUrl);
  fireEvent.load(restored);
  expect(screen.queryByText("This doc navigated away.")).toBeNull();
  fireEvent.load(restored);
  expect(screen.getByText("This doc navigated away.")).toBeTruthy();
});

test.each([false, true])("opening a doc fragment replaces an earlier thread scroll (ready=%s)", (ready) => {
  const { frame, message, post } = mount([thread], [doc, otherDoc], { threadId: id, intent: "initial" });
  fireEvent.load(frame);
  if (ready) {
    message({ type: "emend:ready" });
    expect(post).toHaveBeenCalledWith({ type: "emend:scroll", threadId: id }, "*");
  }
  const other = screen.getByTitle(otherDoc.path) as HTMLIFrameElement;
  Object.defineProperty(other, "contentWindow", { value: { postMessage: vi.fn() } });
  fireEvent.load(other);
  fireEvent(
    window,
    new MessageEvent("message", {
      source: other.contentWindow,
      data: { type: "emend:navigate", path, fragment: "new-heading" },
    }),
  );
  const target = screen.getByTitle(path) as HTMLIFrameElement;
  const nextPost = vi.fn();
  Object.defineProperty(target, "contentWindow", { value: { postMessage: nextPost } });
  fireEvent.load(target);
  fireEvent(window, new MessageEvent("message", { source: target.contentWindow, data: { type: "emend:ready" } }));
  expect(nextPost).toHaveBeenCalledWith({ type: "emend:highlight", anchors: [{ threadId: id, ...anchor }] }, "*");
  expect(nextPost.mock.calls.filter(([data]) => data.type === "emend:scroll")).toEqual([]);
  expect(target.getAttribute("src")).toBe(`${doc.contentUrl}#new-heading`);
});
test("only this frame proposes anchors; composer freezes the quote and only reviewer save creates a thread", async () => {
  const { frame, message } = mount();
  message({ type: "emend:anchor", ...anchor }, window);
  message({ type: "emend:anchor", ...anchor, quote: "x".repeat(2001) });
  expect(screen.queryByText("Comment on selection")).toBeNull();
  message({ type: "emend:anchor", ...anchor });
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Comment on selection"));
  expect(screen.getByText("seeds").tagName).toBe("BLOCKQUOTE");
  message({ type: "emend:anchor", ...anchor, quote: "replacement" });
  expect(screen.queryByText("replacement")).toBeNull();
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Please explain" } });
  expect(localStorage.getItem(draftKey(id, thread.target))).toBe("Please explain");
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Save comment"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/v1/reviews/${id}/threads`,
    expect.objectContaining({ body: JSON.stringify({ revision: 2, target: thread.target, body: "Please explain" }) }),
  );
  expect(frame.isConnected).toBe(true);
});
test("ready and changed threads post only placed anchors for this doc; Show in doc scrolls", () => {
  const other = {
    ...thread,
    id: "22222222-2222-4222-8222-222222222222",
    placement: {
      status: "placed" as const,
      location: { kind: "html-span" as const, path: "other.html", start: 0, end: 5 },
    },
  };
  const unplaced = {
    ...thread,
    id: "33333333-3333-4333-8333-333333333333",
    placement: { status: "unplaced" as const, reason: "block-gone" as const },
  };
  const { message, post, update } = mount([other, thread, unplaced]);
  expect(post).not.toHaveBeenCalled();
  message({ type: "emend:ready" });
  expect(post).toHaveBeenLastCalledWith({ type: "emend:highlight", anchors: [{ threadId: id, ...anchor }] }, "*");
  expect(JSON.stringify(post.mock.calls)).not.toContain("Private synthetic comment");
  expect(JSON.stringify(post.mock.calls)).not.toContain("state");
  fireEvent.click(screen.getByText("Show in doc"));
  expect(post).toHaveBeenLastCalledWith({ type: "emend:scroll", threadId: id }, "*");
  update([]);
  expect(post).toHaveBeenLastCalledWith({ type: "emend:highlight", anchors: [] }, "*");
  message({ type: "emend:ready" });
  expect(post.mock.calls.filter(([data]) => data.type === "emend:highlight")).toHaveLength(3);
});
test("a second load permanently stops messages and anchors until explicit Reload mounts a fresh frame", () => {
  const { frame, message, post, container, update } = mount([thread]);
  fireEvent.load(frame);
  message({ type: "emend:ready" });
  fireEvent.load(frame);
  post.mockClear();
  expect(screen.getByText("This doc navigated away.")).toBeTruthy();
  message({ type: "emend:anchor", ...anchor });
  message({ type: "emend:ready" });
  fireEvent.click(screen.getByText("Show in doc"));
  update([]);
  expect(post).not.toHaveBeenCalled();
  expect(screen.queryByText("Comment on selection")).toBeNull();
  fireEvent.click(screen.getByText(`Reload ${path}`));
  const next = container.querySelector("iframe");
  expect(next).not.toBe(frame);
  expect(next?.getAttribute("src")).toBe(doc.contentUrl);
  expect(screen.queryByText("This doc navigated away.")).toBeNull();
  message({ type: "emend:anchor", ...anchor });
  expect(screen.queryByText("Comment on selection")).toBeNull();
});
test("mixed docs retain manifest order and HTML cards use placement order", () => {
  const late = {
    ...thread,
    id: "22222222-2222-4222-8222-222222222222",
    placement: { status: "placed" as const, location: { kind: "html-span" as const, path, start: 50, end: 55 } },
  };
  const { container } = render(
    <QueryClientProvider client={client}>
      <DocView
        reviewId={id}
        revision={2}
        changedBlocks={[]}
        threads={[late, thread]}
        docs={[
          { kind: "markdown", path: "before.md", blocks: [] },
          doc,
          { kind: "markdown", path: "after.md", blocks: [] },
        ]}
      />
    </QueryClientProvider>,
  );
  expect([...container.querySelectorAll("h2")].map((node) => node.textContent)).toEqual([
    "before.md",
    path,
    "after.md",
  ]);
  expect([...container.querySelectorAll("[data-thread-card]")].map((node) => node.id)).toEqual([
    `thread-${id}`,
    `thread-${late.id}`,
  ]);
});

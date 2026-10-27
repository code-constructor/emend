// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import type { FileView, RenderedBlock, Target, ThreadView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Window } from "happy-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { draftKey, editDraftKey } from "./lib/drafts.ts";
import { rememberPairingSecret, takePairingSecret } from "./lib/pairing-secret.ts";

const id = "11111111-1111-4111-8111-111111111111";
const item = {
  id,
  title: "Synthetic review",
  origin: { id, name: "Workshop" },
  repo: "c".repeat(64),
  branch: "main",
  state: "open",
  newestRevision: 1,
  unsentCount: 2,
  openThreads: 1,
  agentWaiting: false,
  pendingSend: true,
  updatedAt: "2026-01-01T00:00:00.000Z",
  movedTo: null,
};
const revision = {
  seq: 1,
  base: null,
  head: null,
  topics: [],
  files: [],
  writeup: { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [] }] },
  docs: [{ path: "plan.md", kind: "markdown", blocks: [] }],
  threads: [],
  changedBlocks: [],
};
class Events extends EventTarget {
  static opened: Events[] = [];
  close = vi.fn();
  constructor(public url: string) {
    super();
    Events.opened.push(this);
  }
  emit(type: string, data: object) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}
let width = 1280;
const mediaQueries = new Set<{ media: string; matches: boolean; events: EventTarget }>();
function matchesWidth(query: string) {
  const constraints = [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
  if (!constraints.length) throw new Error(`Unsupported media query: ${query}`);
  return constraints.every(([, bound, pixels]) =>
    bound === "min" ? width >= Number(pixels) : width <= Number(pixels),
  );
}
function resize(widthPx: number) {
  width = widthPx;
  for (const media of mediaQueries) {
    const matches = matchesWidth(media.media);
    if (matches === media.matches) continue;
    media.matches = matches;
    media.events.dispatchEvent(Object.assign(new Event("change"), { matches, media: media.media }));
  }
}
let newest = 1;
let fetchMock: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
let client: QueryClient;
function mount(path = "/") {
  const history = createMemoryHistory({ initialEntries: [path] });
  const result = render(<App queryClient={client} history={history} />);
  return { ...result, history };
}
beforeEach(() => {
  width = 1280;
  mediaQueries.clear();
  newest = 1;
  Events.opened = [];
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("EventSource", Events);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const media = { matches: matchesWidth(query), media: query, events: new EventTarget() };
      mediaQueries.add(media);
      return Object.assign(media, {
        addEventListener: media.events.addEventListener.bind(media.events),
        removeEventListener: media.events.removeEventListener.bind(media.events),
      });
    }),
  );
  fetchMock = vi.fn(async (path: string) => {
    if (path === "/api/v1/session") return new Response(null, { status: 204 });
    if (path === "/api/v1/reviews") return Response.json({ items: [item] });
    if (path === `/api/v1/reviews/${id}`)
      return Response.json({
        ...item,
        newestRevision: newest,
        revisions: Array.from({ length: newest }, (_, i) => ({ seq: i + 1, createdAt: item.updatedAt })),
      });
    if (path.includes("/revisions/")) return Response.json({ ...revision, seq: Number(path.split("/").at(-1)) });
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetchMock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => {
  cleanup();
  takePairingSecret();
  client.clear();
  // Stop browser tasks before restoring mocks or closing Vitest's logging channel.
  await (window as unknown as Window).happyDOM.abort();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("pair consumes the startup secret once, clears it, and lands on the inbox", async () => {
  const secret = `emp_${"a".repeat(43)}`;
  rememberPairingSecret(secret);
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    expect(location.hash).toBe("");
    if (path === "/api/v1/session") {
      expect(JSON.parse(String(init?.body))).toEqual({ secret });
      return new Response(null, { status: 204 });
    }
    return Response.json({ items: [] });
  });
  const { history } = mount("/pair");
  await screen.findByRole("heading", { name: "Inbox" });
  expect(takePairingSecret()).toBeUndefined();
  expect(history.location.pathname).toBe("/");
  expect(fetchMock.mock.calls.filter(([path]) => path === "/api/v1/session")).toHaveLength(1);
});
test.each([
  [401, "That code did not work. Check it on the hub and try again."],
  [429, "Too many wrong codes. Wait 10 minutes, then try again."],
])("pair shows the exact error for status %s", async (status, message) => {
  fetchMock.mockResolvedValue(
    Response.json({ error: { code: status === 401 ? "unauthorized" : "rate_limited", message: "Failed" } }, { status }),
  );
  mount("/pair");
  fireEvent.change(await screen.findByLabelText("Pairing code"), { target: { value: "ABCD-EFGH" } });
  fireEvent.click(screen.getByRole("button", { name: "Pair" }));
  expect((await screen.findByRole("alert")).textContent).toBe(message);
});
test("inbox shows the origin and pending Send without a waiting agent", async () => {
  mount();
  expect(await screen.findByText("Workshop")).toBeTruthy();
  expect(screen.getByText("No agent waiting")).toBeTruthy();
  expect(screen.getByRole("link", { name: /Synthetic review/ }).getAttribute("href")).toContain(`/r/${id}`);
});
test("moved inbox rows show the destination host without a navigable link", async () => {
  fetchMock.mockResolvedValue(Response.json({ items: [{ ...item, movedTo: "https://hub.example/r/new" }] }));
  mount();
  expect(await screen.findByText("Moved to hub.example")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
});
test.each([767, 768, 1279, 1280, 390])("review mounts only visible panes at %s px", async (size) => {
  width = size;
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(screen.getAllByTestId(/-pane$/)).toHaveLength(size >= 1280 ? 3 : size >= 768 ? 2 : 1);
  if (size < 768) {
    const tabs = within(screen.getByRole("navigation", { name: "Review tabs" }));
    expect(tabs.getAllByRole("link").map((link) => link.textContent)).toEqual(["Writeup", "Diff", "Docs", "Comments2"]);
    fireEvent.click(tabs.getByRole("link", { name: "Diff" }));
    await waitFor(() => expect(screen.getByTestId("diff-pane")).toBeTruthy());
    expect(screen.queryByTestId("reading-pane")).toBeNull();
  }
  if (size >= 768 && size < 1280) {
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
    expect(await screen.findByRole("dialog", { name: "Inbox" })).toBeTruthy();
  }
});
test("resizing from desktop to phone replaces three panes with one and phone tabs", async () => {
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(screen.getAllByTestId(/-pane$/)).toHaveLength(3);
  expect(screen.queryByRole("navigation", { name: "Review tabs" })).toBeNull();
  act(() => resize(390));
  expect(screen.getAllByTestId(/-pane$/)).toHaveLength(1);
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  expect(screen.queryByTestId("diff-pane")).toBeNull();
  expect(screen.getByRole("navigation", { name: "Review tabs" })).toBeTruthy();
});
test("publish announces the next revision without switching or refetching the current revision", async () => {
  const { history, unmount } = mount(`/r/${id}`);
  await screen.findByText("Overview");
  newest = 2;
  const before = fetchMock.mock.calls.filter(([path]) => path.endsWith("/revisions/1")).length;
  act(() => {
    Events.opened[0]?.emit("publish", { reviewId: id, revision: 2 });
  });
  expect(await screen.findByText("Revision 2 is ready. Reload to see it.")).toBeTruthy();
  expect(screen.getByLabelText("Revision 1")).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith("/revisions/1"))).toHaveLength(before);
  expect(Events.opened).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(history.location.search).toContain("rev=2"));
  await screen.findByLabelText("Revision 2");
  unmount();
  expect(Events.opened[0]?.close).toHaveBeenCalledOnce();
});
test("inbox collapse survives reload and unavailable localStorage", async () => {
  const first = mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  expect(localStorage.getItem("emend.inbox.collapsed")).toBe("true");
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  first.unmount();
  const second = mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  second.unmount();
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Storage denied");
    },
    setItem: () => {
      throw new Error("Storage denied");
    },
  });
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
});

test("phone menu selects revisions, copies the complete link, and links to devices", async () => {
  width = 390;
  newest = 2;
  window.history.replaceState(null, "", `/r/${id}?rev=1&tab=comments`);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const { history } = mount(`/r/${id}?rev=1&tab=comments`);
  await screen.findByLabelText("Revision 1");
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  const menu = within(await screen.findByRole("dialog", { name: "More" }));
  expect(menu.getByRole("link", { name: "Inbox" }).getAttribute("href")).toBe("/");
  expect(menu.getByRole("link", { name: "Devices" }).getAttribute("href")).toBe("/devices");
  fireEvent.click(menu.getByRole("button", { name: "Copy link" }));
  expect(writeText).toHaveBeenCalledWith(location.origin + location.pathname + location.search);
  fireEvent.change(menu.getByLabelText("Revision"), { target: { value: "2" } });
  await waitFor(() => expect(history.location.search).toContain("rev=2"));
  expect(history.location.search).toContain("tab=comments");
});

test("phone inbox menu offers Devices and Pair a device", async () => {
  width = 390;
  mount();
  await screen.findByRole("heading", { name: "Inbox" });
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  const menu = within(await screen.findByRole("dialog", { name: "More" }));
  for (const name of ["Devices", "Pair a device"])
    expect(menu.getByRole("link", { name }).getAttribute("href")).toBe("/devices");
});

test("hides Docs without docs, defaults bad search values, and keeps diff visible on desktop", async () => {
  fetchMock.mockImplementation(async (path: string) => {
    if (path.endsWith("/revisions/1")) return Response.json({ ...revision, docs: [] });
    if (path === "/api/v1/reviews") return Response.json({ items: [item] });
    return Response.json({ ...item, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
  });
  const { history } = mount(`/r/${id}?rev=-1&tab=diff&thread=bad`);
  await screen.findByText("Overview");
  expect(screen.queryByRole("link", { name: "Docs" })).toBeNull();
  expect(screen.getByTestId("diff-pane")).toBeTruthy();
  const reading = within(screen.getByRole("navigation", { name: "Reading tabs" }));
  expect(reading.getByRole("link", { name: "Writeup" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(reading.getByRole("link", { name: /Comments/ }));
  await waitFor(() => expect(history.location.search).toContain("tab=comments"));
  expect(history.location.search).not.toContain("thread");
  expect(history.location.search).not.toContain("rev=-1");
});

test("thread and Send events refresh comments as well as metadata, ignore invalid messages and close on navigation", async () => {
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  const invalidate = vi.spyOn(client, "invalidateQueries");
  act(() => {
    Events.opened[0]?.emit("publish", { reviewId: "22222222-2222-4222-8222-222222222222", revision: 4 });
    Events.opened[0]?.emit("publish", { reviewId: id, revision: -1 });
    Events.opened[0]?.dispatchEvent(new MessageEvent("publish", { data: "not json" }));
  });
  expect(invalidate).not.toHaveBeenCalled();
  for (const type of ["send", "thread", "waiting"]) {
    act(() => Events.opened[0]?.emit(type, { reviewId: id, revision: 1, sendId: id, threadId: id }));
  }
  expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
    ["inbox"],
    ["review", id],
    ["revision", id],
    ["inbox"],
    ["review", id],
    ["revision", id],
    ["inbox"],
    ["review", id],
  ]);
  fireEvent.click(screen.getByRole("link", { name: "Devices" }));
  await screen.findByRole("heading", { name: "Devices" });
  expect(Events.opened[0]?.close).toHaveBeenCalledOnce();
});

test("review route saves a selected doc span, refreshes its thread, sends it, then enables approval", async () => {
  const block = {
    id: "doc-12345678-12345678",
    section: "doc-12345678",
    kind: "paragraph",
    html: "<p>Plant a seed.</p>",
    text: "Plant a seed.",
  };
  let saved: ThreadView | undefined;
  let sent = false;
  const posts: { path: string; body: unknown }[] = [];
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ path, body });
      if (path.endsWith("/threads"))
        saved = {
          id,
          target: body.target,
          createdOn: 1,
          state: "open",
          placement: {
            status: "placed",
            location: { kind: "doc-span", path: "plan.md", blockId: block.id, start: 8, end: 12 },
          },
          comments: [{ id, body: body.body, author: "user", sent: false, sentOn: null }],
        };
      if (path.endsWith("/sends") && saved) {
        sent = true;
        saved = {
          ...saved,
          state: "sent",
          comments: saved.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 })),
        };
      }
      return Response.json({ threadId: id, commentId: id, sendId: id }, { status: 201 });
    }
    const current = { ...item, unsentCount: saved && !sent ? 1 : 0 };
    if (path === "/api/v1/reviews") return Response.json({ items: [current] });
    if (path.endsWith("/revisions/1"))
      return Response.json({
        ...revision,
        docs: [{ path: "plan.md", kind: "markdown", blocks: [block] }],
        threads: saved ? [saved] : [],
      });
    return Response.json({ ...current, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
  });
  const { container } = mount(`/r/${id}?tab=docs`);
  const paragraph = await screen.findByText("Plant a seed.");
  const node = paragraph.firstChild;
  const selection = window.getSelection();
  if (!node || !selection) throw new Error("Missing selection fixture");
  const range = document.createRange();
  range.setStart(node, 8);
  range.setEnd(node, 12);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(paragraph);
  fireEvent.click(screen.getByRole("button", { name: "Comment on selection" }));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Explain the seed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await screen.findByText("Explain the seed");
  expect(posts[0]).toEqual({
    path: `/api/v1/reviews/${id}/threads`,
    body: {
      revision: 1,
      target: { kind: "doc-span", path: "plan.md", blockId: block.id, quote: "seed", prefix: "Plant a ", suffix: "." },
      body: "Explain the seed",
    },
  });
  await screen.findByText("1 unsent comment");
  expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Feedback sent.");
  expect(screen.getByText("Sent")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  expect(
    container
      .querySelector('[aria-label="Send feedback"]')
      ?.previousElementSibling?.contains(screen.getByTestId("diff-pane")),
  ).toBe(true);
});

const draftBlock: RenderedBlock = {
  id: "overview-12345678",
  section: "overview",
  kind: "paragraph",
  text: "Plant a seed.",
  html: "<p>Plant a seed.</p>",
};
const draftTarget: Target = {
  kind: "writeup-span",
  blockId: draftBlock.id,
  quote: "seed",
  prefix: "Plant a ",
  suffix: ".",
};
function withDraftBlock() {
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.includes("/revisions/"))
      return Response.json({
        ...revision,
        writeup: { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [draftBlock] }] },
      });
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
}
function selectSeed() {
  const paragraph = screen.getByText("Plant a seed.");
  const node = paragraph.firstChild;
  const selection = window.getSelection();
  if (!node || !selection) throw new Error("Missing selection fixture");
  const range = document.createRange();
  range.setStart(node, 8);
  range.setEnd(node, 12);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(paragraph);
  selection.removeAllRanges();
  fireEvent.click(screen.getByRole("button", { name: "Comment on selection" }));
}
test("reload discovers drafts without a supplied target; Resume restores text and scrolls, Discard removes", async () => {
  withDraftBlock();
  const first = mount(`/r/${id}`);
  await screen.findByText("Plant a seed.");
  selectSeed();
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Recover after reload" } });
  first.unmount();
  client.clear();
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const second = mount(`/r/${id}?tab=comments`);
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  expect(drafts.getByText("seed")).toBeTruthy();
  fireEvent.click(drafts.getByRole("button", { name: "Resume" }));
  expect(((await screen.findByLabelText("Comment")) as HTMLTextAreaElement).value).toBe("Recover after reload");
  await waitFor(() =>
    expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === `block-${draftBlock.id}`)).toBe(true),
  );
  second.unmount();
  client.clear();
  mount(`/r/${id}?tab=comments`);
  const restored = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  fireEvent.click(restored.getByRole("button", { name: "Discard" }));
  expect(localStorage.getItem(draftKey(id, draftTarget))).toBeNull();
  expect(restored.queryByRole("button", { name: "Resume" })).toBeNull();
});
test("unreadable draft targets offer only Discard and other reviews' drafts stay hidden", async () => {
  const key = `emend.draft.${id}.not-json`;
  localStorage.setItem(key, "Unreadable draft");
  localStorage.setItem(draftKey("22222222-2222-4222-8222-222222222222", draftTarget), "Other review");
  mount(`/r/${id}?tab=comments`);
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  expect(drafts.queryByRole("button", { name: "Resume" })).toBeNull();
  expect(drafts.getAllByRole("button", { name: "Discard" })).toHaveLength(1);
  fireEvent.click(drafts.getByRole("button", { name: "Discard" }));
  expect(localStorage.getItem(key)).toBeNull();
});
test("saved reply clears before delayed metadata while revision refresh regroups its composer", async () => {
  let saved = false;
  const metadata = Promise.withResolvers<Response>();
  const thread: ThreadView = {
    id,
    target: draftTarget,
    createdOn: 1,
    state: "sent",
    placement: { status: "placed", location: { kind: "writeup-span", blockId: draftBlock.id, start: 8, end: 12 } },
    comments: [{ id, author: "user", body: "Earlier comment", sent: true, sentOn: 1 }],
  };
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      saved = true;
      return Response.json({ commentId: id }, { status: 201 });
    }
    if (path === "/api/v1/reviews") return Response.json({ items: [item] });
    if (path.includes("/revisions/"))
      return Response.json({
        ...revision,
        threads: [
          {
            ...thread,
            state: saved ? "open" : "sent",
            comments: saved
              ? [
                  ...thread.comments,
                  {
                    id: "22222222-2222-4222-8222-222222222222",
                    author: "user",
                    body: "Saved reply",
                    sent: false,
                    sentOn: null,
                  },
                ]
              : thread.comments,
          },
        ],
      });
    if (saved) return metadata.promise;
    return Response.json({ ...item, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
  });
  mount(`/r/${id}?tab=comments`);
  const original = await screen.findByLabelText("Reply");
  fireEvent.change(original, { target: { value: "Saved reply" } });
  const key = `${draftKey(id, draftTarget)}.reply.${id}`;
  expect(localStorage.getItem(key)).toBe("Saved reply");
  fireEvent.click(screen.getByRole("button", { name: "Add reply" }));
  try {
    await screen.findByText("Saved reply", { selector: "p" });
    expect(original.isConnected).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
    expect((screen.getByLabelText("Reply") as HTMLTextAreaElement).value).toBe("");
  } finally {
    metadata.resolve(Response.json({ ...item, revisions: [{ seq: 1, createdAt: item.updatedAt }] }));
  }
});
test.each(["Send", "Approve"])(
  "%s waits for the delayed revision on screen and instructions survive",
  async (action) => {
    newest = 2;
    const delayed = Promise.withResolvers<Response>();
    const fallback = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/revisions/2")) return delayed.promise;
      if (init?.method === "POST") return Response.json({ sendId: id }, { status: 201 });
      if (path === `/api/v1/reviews/${id}`)
        return Response.json({
          ...item,
          unsentCount: 0,
          newestRevision: 2,
          revisions: [1, 2].map((seq) => ({ seq, createdAt: item.updatedAt })),
        });
      if (!fallback) throw new Error("Missing fetch fixture");
      return fallback(path, init);
    });
    mount(`/r/${id}?rev=1`);
    await screen.findByText("Overview");
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Keep these instructions" } });
    fireEvent.change(screen.getByLabelText("Revision 1"), { target: { value: "2" } });
    try {
      await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.endsWith("/revisions/2"))).toBe(true));
      const sendBar = within(screen.getByRole("region", { name: "Send feedback" }));
      for (const name of ["Send", "Approve"]) {
        const button = sendBar.getByRole("button", { name }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
      }
      expect(sendBar.getByText("Loading revision…")).toBeTruthy();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
      expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep these instructions");
    } finally {
      delayed.resolve(Response.json({ ...revision, seq: 2 }));
    }
    await waitFor(() => expect(screen.queryByText("Loading revision…")).toBeNull());
    expect(screen.getByText("Overview")).toBeTruthy();
    expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep these instructions");
    for (const name of ["Send", "Approve"])
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/reviews/${id}/sends`,
        expect.objectContaining({
          body: JSON.stringify(
            action === "Approve"
              ? { revision: 2, kind: "approve" }
              : { revision: 2, kind: "go", mode: "fix-clear", instruction: "Keep these instructions" },
          ),
        }),
      ),
    );
  },
);
test("failed revision disables Send and Approve with a reason, preserving instructions through retry", async () => {
  newest = 2;
  let failed = true;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/revisions/2") && failed)
      return Response.json({ error: { code: "internal", message: "Synthetic failure" } }, { status: 500 });
    if (path === `/api/v1/reviews/${id}`)
      return Response.json({
        ...item,
        unsentCount: 0,
        newestRevision: 2,
        revisions: [1, 2].map((seq) => ({ seq, createdAt: item.updatedAt })),
      });
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
  mount(`/r/${id}?rev=1`);
  await screen.findByText("Overview");
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Keep through failure" } });
  fireEvent.change(screen.getByLabelText("Revision 1"), { target: { value: "2" } });
  await screen.findByRole("button", { name: "Retry" });
  const sendBar = within(screen.getByRole("region", { name: "Send feedback" }));
  expect(sendBar.getByText("Could not load this revision.")).toBeTruthy();
  for (const name of ["Send", "Approve"])
    expect((sendBar.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep through failure");
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Overview");
  for (const name of ["Send", "Approve"])
    expect((sendBar.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep through failure");
});
test("unplaced thread navigates through the router to its original revision", async () => {
  newest = 2;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.includes("/revisions/"))
      return Response.json({
        ...revision,
        seq: Number(path.split("/").at(-1)),
        threads: [
          {
            id,
            target: draftTarget,
            createdOn: 1,
            state: "open",
            placement: { status: "unplaced", reason: "block-gone" },
            comments: [],
          },
        ],
      });
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
  const { history } = mount(`/r/${id}?rev=2&tab=comments`);
  fireEvent.click(await screen.findByRole("link", { name: "Revision 1" }));
  await waitFor(() => expect(history.location.search).toContain("rev=1"));
  expect(history.location.search).toContain(`thread=${id}`);
  expect(history.location.hash).toBe(`#thread-${id}`);
});

test("resuming a placed reply focuses its single thread composer and save clears Follow-up", async () => {
  let saved = false;
  const thread: ThreadView = {
    id,
    target: draftTarget,
    createdOn: 1,
    state: "open",
    placement: { status: "placed", location: { kind: "writeup-span", blockId: draftBlock.id, start: 8, end: 12 } },
    comments: [],
  };
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      saved = true;
      return Response.json({ commentId: id }, { status: 201 });
    }
    if (path.includes("/revisions/"))
      return Response.json({
        ...revision,
        writeup: { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [draftBlock] }] },
        threads: [
          { ...thread, comments: saved ? [{ id, author: "user", body: "Follow-up", sent: false, sentOn: null }] : [] },
        ],
      });
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
  localStorage.setItem(draftKey(id, draftTarget, id), "Follow-up");
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(screen.getAllByLabelText("Reply")).toHaveLength(1));
  const reply = screen.getByLabelText("Reply") as HTMLTextAreaElement;
  expect(reply.value).toBe("Follow-up");
  expect(screen.queryByRole("region", { name: "Resumed comment" })).toBeNull();
  await waitFor(() => expect(history.location.search).toContain(`thread=${id}`));
  expect(history.location.search).toContain("tab=comments");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === `thread-${id}`)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Add reply" }));
  await screen.findByText("Follow-up", { selector: "p" });
  expect(screen.getAllByLabelText("Reply").map((field) => (field as HTMLTextAreaElement).value)).toEqual([""]);
  expect(localStorage.getItem(draftKey(id, draftTarget, id))).toBeNull();
});

function navigationFixture({ cold = false, threads = true, unplaced = false } = {}) {
  let refresh = 0;
  const delayed = cold ? Promise.withResolvers<Response>() : undefined;
  const thread: ThreadView = {
    id,
    target: draftTarget,
    createdOn: 1,
    state: "open",
    placement: unplaced
      ? { status: "unplaced", reason: "block-gone" }
      : { status: "placed", location: { kind: "writeup-span", blockId: draftBlock.id, start: 8, end: 12 } },
    comments: [],
  };
  const current = () => ({
    ...revision,
    writeup: { sections: [{ key: "overview", label: `Overview ${refresh}`, topic: null, blocks: [draftBlock] }] },
    threads: threads
      ? [{ ...thread, comments: [{ id, author: "user", body: `Comment ${refresh}`, sent: false, sentOn: null }] }]
      : [],
  });
  const fallback = fetchMock.getMockImplementation();
  let requests = 0;
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/revisions/1")) {
      requests++;
      if (requests === 1 && delayed) return delayed.promise;
      return Response.json(current());
    }
    if (!fallback) throw new Error("Missing fetch fixture");
    return fallback(path, init);
  });
  return {
    resolve: () => delayed?.resolve(Response.json(current())),
    async update() {
      refresh++;
      const before = requests;
      await act(async () => {
        Events.opened[0]?.emit("thread", { reviewId: id, revision: 1, threadId: id });
        await vi.waitFor(() => expect(requests).toBeGreaterThan(before));
        await vi.waitFor(() => expect(client.isFetching()).toBe(0));
      });
      expect(
        client.getQueryData<{ writeup: { sections: { label: string }[] } }>(["revision", id, 1])?.writeup.sections[0]
          ?.label,
      ).toBe(`Overview ${refresh}`);
    },
  };
}

const htmlTarget: Target = { kind: "html-span", path: "seed.html", quote: "seed", prefix: "", suffix: "" };
function htmlReviewFixture(
  placement: ThreadView["placement"] = {
    status: "placed",
    location: { kind: "html-span", path: "seed.html", start: 0, end: 4 },
  },
  doc: "html" | "markdown" | "missing" = "html",
) {
  const thread: ThreadView = { id, target: htmlTarget, createdOn: 1, state: "open", comments: [], placement };
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path.includes("/revisions/")
      ? Response.json({
          ...revision,
          seq: Number(path.split("/").at(-1)),
          docs:
            doc === "missing"
              ? []
              : doc === "markdown"
                ? [{ kind: "markdown", path: "seed.html", blocks: [] }]
                : [{ kind: "html", path: "seed.html", contentUrl: "/content/synthetic/seed.html" }],
          threads: [thread],
        })
      : (fallback?.(path, init) ?? Response.error()),
  );
  return thread;
}

test.each(["resume", "thread", "hash-link"])(
  "an unplaced HTML %s opens Comments and its reply composer",
  async (kind) => {
    htmlReviewFixture({ status: "unplaced", reason: "block-gone" });
    localStorage.setItem(draftKey(id, htmlTarget, id), "Unplaced HTML reply");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history, container } = mount(
      `/r/${id}?${kind === "resume" ? "tab=comments" : kind === "thread" ? `thread=${id}` : `tab=docs#thread-${id}`}`,
    );
    if (kind === "resume") fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(history.location.search).toContain("tab=comments"));
    const reply = await screen.findByLabelText("Reply");
    await waitFor(() => expect(document.activeElement).toBe(reply));
    expect((reply as HTMLTextAreaElement).value).toBe("Unplaced HTML reply");
    expect(within(screen.getByRole("region", { name: "Unplaced" })).getByLabelText("Reply")).toBe(reply);
    expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === `thread-${id}`)).toBe(true);
    expect(container.querySelector("iframe")).toBeNull();
  },
);

test.each(["missing", "markdown"] as const)("HTML placement on a %s doc routes to Comments", async (doc) => {
  htmlReviewFixture(undefined, doc);
  const { history } = mount(`/r/${id}?thread=${id}`);
  await waitFor(() => expect(history.location.search).toContain("tab=comments"));
  expect(await screen.findByLabelText("Reply")).toBeTruthy();
});

test.each([
  [1280, "Comments"],
  [1280, "Writeup"],
  [390, "Comments"],
  [390, "Writeup"],
] as const)("an incoming HTML thread does not override a later tab choice at %s: %s", async (pixels, tab) => {
  width = pixels;
  htmlReviewFixture();
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history, container } = mount(`/r/${id}?thread=${id}`);
  await waitFor(() => expect(history.location.search).toContain("tab=docs"));
  await waitFor(() =>
    expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === `thread-${id}`)).toBe(true),
  );
  const link = screen.getByRole("link", { name: new RegExp(tab) });
  expect(new URL((link as HTMLAnchorElement).href).searchParams.has("thread")).toBe(false);
  fireEvent.click(link);
  await waitFor(() => expect(history.location.search).toContain(`tab=${tab.toLowerCase()}`));
  expect(history.location.search).not.toContain("thread=");
  expect(history.location.hash).toBe("");
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["revision", id, 1] });
  });
  expect(screen.getByRole("link", { name: new RegExp(tab) }).getAttribute("aria-current")).toBe("page");
  expect(container.querySelector("iframe")).toBeNull();
});

test.each([false, true])(
  "an HTML thread link waits for a missing cached thread unless the reviewer picks Comments (switch=%s)",
  async (switchTab) => {
    const thread = htmlReviewFixture();
    const cached = {
      ...revision,
      docs: [{ kind: "html", path: "seed.html", contentUrl: "/content/synthetic/seed.html" }],
    };
    client.setQueryData(["revision", id, 1], cached);
    await client.invalidateQueries({ queryKey: ["revision", id, 1], refetchType: "none" });
    const response = Promise.withResolvers<Response>();
    const fallback = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((path, init) =>
      path.endsWith("/revisions/1") ? response.promise : (fallback?.(path, init) ?? Promise.resolve(Response.error())),
    );
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history, container } = mount(`/r/${id}?thread=${id}`);
    await screen.findByRole("link", { name: "Writeup" });
    await waitFor(() => expect(client.isFetching({ queryKey: ["revision", id, 1] })).toBe(1));
    expect(container.querySelector("iframe")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    if (switchTab) {
      fireEvent.click(screen.getByRole("link", { name: /Comments/ }));
      await waitFor(() => expect(history.location.search).toContain("tab=comments"));
      expect(history.location.search).not.toContain("thread=");
    }
    await act(async () => {
      response.resolve(Response.json({ ...cached, threads: [thread] }));
      await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    });
    if (switchTab) {
      expect(history.location.search).toContain("tab=comments");
      expect(screen.getByRole("link", { name: /Comments/ }).getAttribute("aria-current")).toBe("page");
      expect(container.querySelector("iframe")).toBeNull();
      expect(scroll).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(history.location.search).toContain("tab=docs"));
      expect(container.querySelector('iframe[title="seed.html"]')).not.toBeNull();
      await waitFor(() =>
        expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === `thread-${id}`)).toBe(true),
      );
    }
    expect(document.getElementById(`thread-${id}`)).not.toBeNull();
  },
);

test("a consumed HTML navigation does not redirect or refocus when placement changes", async () => {
  const thread = htmlReviewFixture({ status: "unplaced", reason: "block-gone" });
  const { history, container } = mount(`/r/${id}?tab=comments&thread=${id}`);
  const reply = await screen.findByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  thread.placement = { status: "placed", location: { kind: "html-span", path: "seed.html", start: 0, end: 4 } };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["revision", id, 1] });
  });
  expect(history.location.search).toContain("tab=comments");
  expect(container.querySelector("iframe")).toBeNull();
  expect(document.activeElement).toBe(instructions);
});

test.each(["thread", "draft", "reply", "comment-link"])(
  "HTML %s navigation opens docs and waits for the frame before scrolling",
  async (kind) => {
    const target: Target = { kind: "html-span", path: "seed.html", quote: "seed", prefix: "", suffix: "" };
    const thread: ThreadView = {
      id,
      target,
      createdOn: 1,
      state: "open",
      comments: [],
      placement: { status: "placed", location: { kind: "html-span", path: "seed.html", start: 0, end: 4 } },
    };
    const fallback = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (path, init) =>
      path.endsWith("/revisions/1")
        ? Response.json({
            ...revision,
            docs: [{ kind: "html", path: "seed.html", contentUrl: "/content/synthetic/seed.html" }],
            threads: [thread],
          })
        : (fallback?.(path, init) ?? Response.error()),
    );
    if (kind === "draft" || kind === "reply")
      localStorage.setItem(draftKey(id, target, kind === "reply" ? id : undefined), "HTML draft");
    const { history, container } = mount(
      `/r/${id}?${kind === "thread" ? `thread=${id}` : kind === "comment-link" ? `tab=comments&thread=${id}` : "tab=comments"}`,
    );
    if (kind === "draft" || kind === "reply") fireEvent.click(await screen.findByText("Resume"));
    await waitFor(() => expect(container.querySelector('iframe[title="seed.html"]')).not.toBeNull());
    expect(history.location.search).toContain("tab=docs");
    const frame = container.querySelector('iframe[title="seed.html"]') as HTMLIFrameElement;
    const post = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
    expect(post).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "emend:ready" } }));
    });
    if (kind !== "draft") expect(post).toHaveBeenCalledWith({ type: "emend:scroll", threadId: id }, "*");
    if (kind === "draft" || kind === "reply")
      expect((screen.getByLabelText(kind === "reply" ? "Reply" : "Comment") as HTMLTextAreaElement).value).toBe(
        "HTML draft",
      );
  },
);

test("reply Resume focuses once; a thread SSE update leaves focus in Instructions", async () => {
  const fixture = navigationFixture();
  localStorage.setItem(draftKey(id, draftTarget, id), "Follow-up");
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(history.location.search).toContain(`thread=${id}`));
  const reply = screen.getByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(scroll).toHaveBeenCalledTimes(1);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  scroll.mockClear();
  await fixture.update();
  expect(document.activeElement).toBe(instructions);
  expect(focus).not.toHaveBeenCalled();
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(focus).toHaveBeenCalledTimes(1);
  expect(scroll).toHaveBeenCalledTimes(1);
});

test("a resumed span draft scrolls to its block once, including after thread SSE updates", async () => {
  const fixture = navigationFixture({ threads: false });
  localStorage.setItem(draftKey(id, draftTarget), "Span draft");
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await screen.findByText("Plant a seed.");
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  expect((scroll.mock.instances[0] as HTMLElement).id).toBe(`block-${draftBlock.id}`);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await fixture.update();
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(instructions);
});

test("a cold hash link scrolls once and a thread SSE update does not scroll it again", async () => {
  const fixture = navigationFixture({ cold: true, threads: false });
  const path = `/r/${id}?tab=writeup#block-${draftBlock.id}`;
  window.history.replaceState(null, "", path);
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount(path);
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.endsWith("/revisions/1"))).toBe(true));
  expect(scroll).not.toHaveBeenCalled();
  await act(async () => fixture.resolve());
  await screen.findByText("Plant a seed.");
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  expect((scroll.mock.instances[0] as HTMLElement).id).toBe(`block-${draftBlock.id}`);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await fixture.update();
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(focus).not.toHaveBeenCalled();
});

test("a cold thread link focuses its reply once after loading and never on an SSE refetch", async () => {
  const fixture = navigationFixture({ cold: true });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount(`/r/${id}?tab=comments&thread=${id}`);
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.endsWith("/revisions/1"))).toBe(true));
  expect(scroll).not.toHaveBeenCalled();
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await act(async () => fixture.resolve());
  const reply = await screen.findByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(focus).toHaveBeenCalledTimes(1);
  expect(scroll).toHaveBeenCalledTimes(1);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  focus.mockClear();
  await fixture.update();
  expect(document.activeElement).toBe(instructions);
  expect(focus).not.toHaveBeenCalled();
  expect(scroll).toHaveBeenCalledTimes(1);
});

test("changing the hash on a loaded revision creates one new intent, unaffected by SSE", async () => {
  const fixture = navigationFixture({ threads: false });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const windowScroll = vi.fn();
  vi.stubGlobal("scrollTo", windowScroll);
  const { history } = mount(`/r/${id}?tab=writeup`);
  await screen.findByText("Plant a seed.");
  expect(scroll).not.toHaveBeenCalled();
  expect(windowScroll).not.toHaveBeenCalled();
  await act(async () => history.push(`/r/${id}?tab=writeup#block-${draftBlock.id}`));
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  await fixture.update();
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(windowScroll).not.toHaveBeenCalled();
});

test("following a thread link again creates one new intent, unaffected by SSE", async () => {
  const fixture = navigationFixture({ unplaced: true });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("link", { name: "Revision 1" }));
  const reply = screen.getByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(scroll).toHaveBeenCalledTimes(1);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await fixture.update();
  expect(document.activeElement).toBe(instructions);
  expect(focus).not.toHaveBeenCalled();
  expect(scroll).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("link", { name: "Revision 1" }));
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect(focus).toHaveBeenCalledTimes(1);
  expect(scroll).toHaveBeenCalledTimes(2);
});

test("Inbox to Devices and Back keeps the router's default uncached scrolling", async () => {
  const scroll = vi.fn();
  vi.stubGlobal("scrollTo", scroll);
  vi.stubGlobal("scrollX", 0);
  vi.stubGlobal("scrollY", 0);
  const { history } = mount();
  await screen.findByRole("heading", { name: "Inbox" });
  await waitFor(() => expect(scroll).toHaveBeenCalledWith({ top: 0, left: 0, behavior: undefined }));
  vi.stubGlobal("scrollY", 240);
  fireEvent.scroll(document);
  scroll.mockClear();
  fireEvent.click(screen.getByRole("link", { name: "Devices" }));
  await screen.findByRole("heading", { name: "Devices" });
  await waitFor(() => expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 0, left: 0, behavior: undefined }));
  vi.stubGlobal("scrollY", 0);
  scroll.mockClear();
  await act(async () => history.back());
  await screen.findByRole("heading", { name: "Inbox" });
  await waitFor(() => expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 0, left: 0, behavior: undefined }));
});

const diffFile = {
  id: "33333333-3333-4333-8333-333333333333",
  path: "new.txt",
  oldPath: null,
  role: "diff",
  status: "modified",
  topic: "topic",
  order: 0,
  mediaType: "text/plain",
  flag: "binary",
  hasOld: false,
  hasNew: false,
};
const diffTarget: Target = { kind: "file", path: "new.txt" };
const diffThread: ThreadView = {
  id,
  target: diffTarget,
  createdOn: 1,
  state: "open",
  placement: { status: "placed", location: diffTarget },
  comments: [{ id, author: "user", body: "Diff thread", sent: false, sentOn: null }],
};
function withDiff(threads: ThreadView[] = [diffThread], file: Partial<FileView> = {}) {
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path.includes("/revisions/")
      ? Response.json({
          ...revision,
          files: [{ ...diffFile, ...file }],
          topics: [{ slug: "topic", title: "Topic", summary: "", importance: 1 }],
          threads,
        })
      : (fallback?.(path, init) as Promise<Response>),
  );
}
test("Resume claims the Comments reply from the diff, focuses it and keeps thread ids unique", async () => {
  withDiff();
  mount(`/r/${id}`);
  const diff = within(await screen.findByTestId("diff-pane"));
  const input = await diff.findByLabelText("Reply");
  input.focus();
  fireEvent.change(input, { target: { value: "Follow-up" } });
  fireEvent.click(screen.getByRole("link", { name: /Comments/ }));
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  fireEvent.click(drafts.getByRole("button", { name: "Resume" }));
  const reading = within(screen.getByTestId("reading-pane"));
  const reply = await reading.findByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reply));
  expect((reply as HTMLTextAreaElement).value).toBe("Follow-up");
  expect(diff.queryByLabelText("Reply")).toBeNull();
  expect(diff.getByRole("button", { name: "Reply" })).toBeTruthy();
  expect(document.getElementById(`thread-${id}`)).toBeTruthy();
  expect(document.getElementById(`diff-thread-${id}`)).toBeTruthy();
  const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);
  fireEvent.focus(diff.getByRole("button", { name: "Reply" }));
  const reclaimed = await diff.findByLabelText("Reply");
  await waitFor(() => expect(document.activeElement).toBe(reclaimed));
  expect((reclaimed as HTMLTextAreaElement).value).toBe("Follow-up");
  expect(reading.queryByLabelText("Reply")).toBeNull();
  expect(reading.getByRole("button", { name: "Reply" })).toBeTruthy();
});
test("Resume of a lines draft opens the phone Diff tab and focuses its file composer", async () => {
  width = 390;
  withDiff([], { flag: null, hasNew: true });
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path, init) =>
    path.startsWith("/api/v1/files/") ? new Promise<Response>(() => {}) : (fallback?.(path, init) as Promise<Response>),
  );
  const target: Target = {
    kind: "lines",
    path: "new.txt",
    side: "new",
    start: 10,
    end: 12,
    lines: ["a", "b", "c"],
    before: [],
    after: [],
  };
  localStorage.setItem(draftKey(id, target), "Line draft");
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history } = mount(`/r/${id}?tab=comments`);
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  fireEvent.click(drafts.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(history.location.search).toContain("tab=diff"));
  const section = await screen.findByRole("region", { name: "File new.txt" });
  const input = await within(section).findByLabelText("Comment");
  expect((input as HTMLTextAreaElement).value).toBe("Line draft");
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(scroll.mock.instances).toContain(section);
  expect(screen.queryByRole("region", { name: "Resumed comment" })).toBeNull();
});
test("a delayed diff reply save cannot clear newer text after Comments claims the key", async () => {
  withDiff();
  const fallback = fetchMock.getMockImplementation();
  let finish = () => {};
  const submitted: string[] = [];
  fetchMock.mockImplementation((path, init) => {
    if (path === `/api/v1/threads/${id}/comments` && init?.method === "POST") {
      submitted.push(String(init.body));
      if (submitted.length === 1)
        return new Promise<Response>((resolve) => {
          finish = () => resolve(Response.json({}));
        });
      return Promise.resolve(Response.json({}));
    }
    return fallback?.(path, init) as Promise<Response>;
  });
  mount(`/r/${id}`);
  const diff = within(await screen.findByTestId("diff-pane"));
  const input = await diff.findByLabelText("Reply");
  act(() => input.focus());
  fireEvent.change(input, { target: { value: "First reply" } });
  fireEvent.click(diff.getByRole("button", { name: "Add reply" }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  fireEvent.click(screen.getByRole("link", { name: /Comments/ }));
  fireEvent.click(
    within(await screen.findByRole("region", { name: "Unsaved comments" })).getByRole("button", { name: "Resume" }),
  );
  const reading = within(screen.getByTestId("reading-pane"));
  const editor = (await reading.findByLabelText("Reply")) as HTMLTextAreaElement;
  expect((reading.getByRole("button", { name: "Add reply" }) as HTMLButtonElement).disabled).toBe(true);
  expect(editor.disabled).toBe(false);
  fireEvent.change(editor, { target: { value: "Second unsent reply" } });
  await act(async () => finish());
  await waitFor(() =>
    expect((reading.getByRole("button", { name: "Add reply" }) as HTMLButtonElement).disabled).toBe(false),
  );
  expect(editor.value).toBe("Second unsent reply");
  expect(localStorage.getItem(draftKey(id, diffTarget, id))).toBe("Second unsent reply");
  fireEvent.click(reading.getByRole("button", { name: "Add reply" }));
  await waitFor(() =>
    expect(submitted).toEqual([
      JSON.stringify({ body: "First reply" }),
      JSON.stringify({ body: "Second unsent reply" }),
    ]),
  );
  await waitFor(() => expect(editor.value).toBe(""));
});
test("a pending edit resumes in Comments and a completed PATCH preserves newer edit text", async () => {
  withDiff();
  const fallback = fetchMock.getMockImplementation();
  let finish = () => {};
  const submitted: string[] = [];
  fetchMock.mockImplementation((path, init) => {
    if (path === `/api/v1/comments/${id}` && init?.method === "PATCH") {
      submitted.push(String(init.body));
      if (submitted.length === 1)
        return new Promise<Response>((resolve) => {
          finish = () => resolve(Response.json({}));
        });
      return Promise.resolve(Response.json({}));
    }
    return fallback?.(path, init) as Promise<Response>;
  });
  mount(`/r/${id}`);
  const diff = within(await screen.findByTestId("diff-pane"));
  fireEvent.click(await diff.findByRole("button", { name: "Edit" }));
  fireEvent.change(diff.getByLabelText("Edit comment"), { target: { value: "First edit" } });
  fireEvent.click(diff.getByRole("button", { name: "Save edit" }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  fireEvent.click(screen.getByRole("link", { name: /Comments/ }));
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  expect(drafts.getByText("Unsaved edit")).toBeTruthy();
  fireEvent.click(drafts.getByRole("button", { name: "Resume" }));
  const reading = within(screen.getByTestId("reading-pane"));
  const input = (await reading.findByLabelText("Edit comment")) as HTMLTextAreaElement;
  expect(document.activeElement).toBe(input);
  expect((reading.getByRole("button", { name: "Save edit" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "Second unsent edit" } });
  await act(async () => finish());
  await waitFor(() =>
    expect((reading.getByRole("button", { name: "Save edit" }) as HTMLButtonElement).disabled).toBe(false),
  );
  expect(input.value).toBe("Second unsent edit");
  expect(localStorage.getItem(editDraftKey(id, id))).toBe("Second unsent edit");
  fireEvent.click(reading.getByRole("button", { name: "Save edit" }));
  await waitFor(() => expect(localStorage.getItem(editDraftKey(id, id))).toBeNull());
  expect(submitted).toEqual([JSON.stringify({ body: "First edit" }), JSON.stringify({ body: "Second unsent edit" })]);
});

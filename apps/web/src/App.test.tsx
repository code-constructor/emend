import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
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
let fetchMock: ReturnType<typeof vi.fn>;
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
afterEach(() => {
  cleanup();
  takePairingSecret();
  client.clear();
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

test("events refresh metadata only, ignore foreign or malformed messages, and close on navigation", async () => {
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
    ["inbox"],
    ["review", id],
    ["inbox"],
    ["review", id],
  ]);
  fireEvent.click(screen.getByRole("link", { name: "Devices" }));
  await screen.findByRole("heading", { name: "Devices" });
  expect(Events.opened[0]?.close).toHaveBeenCalledOnce();
});

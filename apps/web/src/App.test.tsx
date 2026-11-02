// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import type { FileView, InboxItem, RenderedBlock, RevisionView, Target, ThreadView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Window } from "happy-dom";
import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from "vitest";
import { App } from "./App.tsx";
import { reviewQuery } from "./api/queries.ts";
import type { PhoneTabs } from "./components/layout/PhoneTabs.tsx";
import type { ReviewTabs, ReviewTabsProps } from "./components/layout/ReviewTabs.tsx";
import { draftKey, editDraftKey } from "./lib/drafts.ts";
import { rememberPairingSecret, takePairingSecret } from "./lib/pairing-secret.ts";
import { validateReviewSearch } from "./router.tsx";

const id = "11111111-1111-4111-8111-111111111111";
const item: InboxItem = {
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
const diffFile: FileView = {
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
const revision = {
  seq: 1,
  base: null,
  head: null,
  main: null,
  writeupEmpty: false,
  topics: [],
  files: [{ ...diffFile, topic: null }],
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
const initialUrl = window.location.href;
const signInInstructions =
  "Run emend in a terminal on the machine that runs emend. It opens this page signed in, or prints a one-time link you can open here.";
let fetchMock: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
let client: QueryClient;
function mount(path = "/") {
  const history = createMemoryHistory({ initialEntries: [path] });
  const result = render(<App queryClient={client} history={history} />);
  return { ...result, history };
}
beforeEach(() => {
  (window as unknown as Window).happyDOM.setURL(initialUrl);
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

async function chooseRevision(seq: number) {
  fireEvent.keyDown(screen.getByRole("button", { name: /^Revision \d+(?: of|,)/ }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: new RegExp(`^Revision ${seq}\\b`) }));
}

function openingRevision(change: Partial<RevisionView>, previous?: Partial<RevisionView>) {
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path.includes("/revisions/")
      ? Response.json({
          ...revision,
          writeupEmpty: true,
          files: [],
          docs: [],
          seq: Number(path.split("/").at(-1)),
          ...(path.endsWith("/1") && previous ? previous : change),
        })
      : (fallback?.(path, init) as Promise<Response>),
  );
}

test("review search leaves an absent tab unset", () => {
  expect(validateReviewSearch({}).tab).toBeUndefined();
  expect(validateReviewSearch({ tab: "writeup" }).tab).toBe("writeup");
});

test.each([
  {
    name: "diff-only",
    change: {
      files: [
        { ...diffFile, role: "diff" as const, status: "modified" as const, flag: "binary" as const, topic: null },
      ],
    },
    tab: "Diff",
  },
  { name: "one doc", change: { docs: [{ path: "plan.md", kind: "markdown" as const, blocks: [] }] }, tab: "Docs" },
  {
    name: "several docs",
    change: {
      docs: [
        { path: "z.md", kind: "markdown" as const, blocks: [] },
        { path: "a.md", kind: "markdown" as const, blocks: [] },
      ],
    },
    tab: "Docs",
  },
  { name: "writeup text", change: { writeupEmpty: false }, tab: "Writeup" },
])("review without tab opens $name on $tab", async ({ change, tab }) => {
  width = 390;
  openingRevision(change);
  mount(`/r/${id}`);
  await waitFor(() => expect(screen.getByRole("link", { name: tab }).getAttribute("aria-current")).toBe("page"));
  expect(screen.getByRole("link", { name: /Comments/ })).toBeTruthy();
  expect(screen.queryByTestId("diff-pane") !== null).toBe(tab === "Diff");
});

test.each([390, 1280])("empty Writeup and absent Diff tabs are hidden at %s px", async (size) => {
  width = size;
  openingRevision({ docs: [{ path: "plan.md", kind: "markdown", blocks: [] }] });
  mount(`/r/${id}?tab=writeup`);
  await screen.findByRole("heading", { name: "plan.md" });
  expect(screen.queryByRole(width < 768 ? "link" : "tab", { name: "Writeup" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Diff" })).toBeNull();
  expect(
    screen
      .getByRole(width < 768 ? "link" : "tab", { name: /^Docs(?: \d+)?$/ })
      .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
  ).toBe(width < 768 ? "page" : "true");
  expect(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ })).toBeTruthy();
  expect(screen.queryByTestId("diff-pane")).toBeNull();
  expect(screen.getByTestId("reading-pane").className).toContain("flex-1");
});

test("explicit Diff stays selected even with a main doc", async () => {
  width = 390;
  openingRevision({
    main: "plan.md",
    docs: [{ path: "plan.md", kind: "markdown", blocks: [] }],
    files: [{ ...diffFile, role: "diff", status: "modified", flag: "binary", topic: null }],
  });
  mount(`/r/${id}?tab=diff`);
  await screen.findByTestId("diff-pane");
  expect(screen.getByRole("link", { name: "Diff" }).getAttribute("aria-current")).toBe("page");
});

test("explicit empty main writeup remains visible", async () => {
  openingRevision({ main: "writeup" });
  mount(`/r/${id}`);
  await waitFor(() =>
    expect(
      screen
        .getByRole(width < 768 ? "link" : "tab", { name: "Writeup" })
        .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
    ).toBe(width < 768 ? "page" : "true"),
  );
});

test.each(["markdown", "html"] as const)(
  "opening main %s doc starts at the top without a synthetic scroll",
  async (kind) => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const path = kind === "html" ? "last.html" : "last.md";
    openingRevision({
      main: path,
      writeupEmpty: false,
      docs: [
        { path: "first.md", kind: "markdown", blocks: [] },
        ...(kind === "html" ? [{ path, kind, contentUrl: "/content/key/last.html" }] : [{ path, kind, blocks: [] }]),
      ],
    });
    mount(`/r/${id}`);
    await screen.findByRole("heading", { name: path });
    expect(screen.queryByRole("heading", { name: "first.md" })).toBeNull();
    expect(screen.getByTestId("reading-pane").scrollTop).toBe(0);
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["revision", id, 1] });
    });
    expect(scroll).not.toHaveBeenCalled();
  },
);

test.each(["writeup", "docs", "diff"] as const)("revision change falls back when %s becomes hidden", async (tab) => {
  width = 390;
  newest = 2;
  openingRevision(
    { docs: [{ path: "next.md", kind: "markdown", blocks: [] }] },
    {
      writeupEmpty: false,
      files: [{ ...diffFile, role: "diff", status: "modified", flag: "binary", topic: null }],
      docs: tab === "docs" ? [{ path: "old.md", kind: "markdown", blocks: [] }] : [],
    },
  );
  // The Docs case goes to a writeup-only revision instead.
  if (tab === "docs")
    openingRevision({ writeupEmpty: false }, { docs: [{ path: "old.md", kind: "markdown", blocks: [] }] });
  const { history } = mount(`/r/${id}?rev=1&tab=${tab}`);
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: tab.charAt(0).toUpperCase() + tab.slice(1) }).getAttribute("aria-current"),
    ).toBe("page"),
  );
  // The phone Diff tab hides the header, so navigate via a revision link.
  if (tab === "diff") act(() => history.push(`/r/${id}?rev=2&tab=diff`));
  else await chooseRevision(2);
  await waitFor(() =>
    expect(screen.getByRole("link", { name: tab === "docs" ? "Writeup" : "Docs" }).getAttribute("aria-current")).toBe(
      "page",
    ),
  );
});

test("revision picker keeps the visible opening tab even when no tab was in the URL", async () => {
  newest = 2;
  openingRevision(
    { writeupEmpty: false, docs: [{ path: "next.md", kind: "markdown", blocks: [] }] },
    { docs: [{ path: "old.md", kind: "markdown", blocks: [] }] },
  );
  mount(`/r/${id}?rev=1`);
  await screen.findByRole("heading", { name: "old.md" });
  await chooseRevision(2);
  await screen.findByRole("heading", { name: "next.md" });
  expect(
    screen
      .getByRole(width < 768 ? "link" : "tab", { name: /^Docs(?: \d+)?$/ })
      .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
  ).toBe(width < 768 ? "page" : "true");
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

test.each(["127.0.0.1", "localhost", "[::1]", "::1"])(
  "loopback %s shows sign-in instructions without a code form",
  async (host) => {
    (window as unknown as Window).happyDOM.setURL(`http://${host === "::1" ? "[::1]" : host}:3636/pair`);
    if (host === "::1") vi.spyOn(window.location, "hostname", "get").mockReturnValue(host);
    mount("/pair");
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    const instructions = screen.getByText(
      (_, element) => element?.tagName === "P" && element.textContent === signInInstructions,
    );
    expect(instructions.querySelector("code")?.textContent).toBe("emend");
    expect(screen.getByText("emend", { selector: "p" })).toBeTruthy();
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pair" })).toBeNull();
    expect(screen.queryByText(/The app on your home screen/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test.each(["100.64.0.1", "127.0.0.2", "localhost.example"])(
  "remote host %s keeps the pairing code form",
  async (host) => {
    (window as unknown as Window).happyDOM.setURL(`http://${host}:3636/pair`);
    mount("/pair");
    await screen.findByRole("heading", { level: 1, name: "Pair this device" });
    expect(screen.getByLabelText("Pairing code")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pair" })).toBeTruthy();
    expect(
      screen.getByText("The app on your home screen pairs once more with a code, even after Safari has paired."),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  },
);

test.each(["127.0.0.1", "localhost", "[::1]"])(
  "pair on %s consumes the startup secret once, clears it, and lands on the inbox",
  async (host) => {
    (window as unknown as Window).happyDOM.setURL(`http://${host}:3636/pair`);
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
  },
);
test.each([
  [401, "That code did not work. Check it on the hub and try again."],
  [429, "Too many wrong codes. Wait 10 minutes, then try again."],
  [500, "Could not pair. Check your connection and try again."],
])(
  "loopback redemption failure %s keeps the error and sign-in instructions without a code form",
  async (status, message) => {
    (window as unknown as Window).happyDOM.setURL("http://127.0.0.1:3636/pair");
    rememberPairingSecret(`emp_${"f".repeat(43)}`);
    fetchMock.mockResolvedValue(Response.json({ error: { code: "failed", message: "Failed" } }, { status }));
    mount("/pair");
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(
      screen.getByText((_, element) => element?.tagName === "P" && element.textContent === signInInstructions),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pair" })).toBeNull();
    expect(screen.queryByText(/The app on your home screen/)).toBeNull();
  },
);
test.each([
  [401, "That code did not work. Check it on the hub and try again."],
  [429, "Too many wrong codes. Wait 10 minutes, then try again."],
])("pair shows the exact error for status %s", async (status, message) => {
  (window as unknown as Window).happyDOM.setURL("http://100.64.0.1:3636/pair");
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
  expect(screen.getByRole("img", { name: "No agent waiting" })).toBeTruthy();
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
    expect(tabs.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Writeup",
      "Diff",
      "Docs",
      "Comments 2 unsent",
    ]);
    fireEvent.click(tabs.getByRole("link", { name: "Diff" }));
    await waitFor(() => expect(screen.getByTestId("diff-pane")).toBeTruthy());
    expect(screen.queryByTestId("reading-pane")).toBeNull();
  }
  if (size >= 768 && size < 1280) {
    fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
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
  expect(await screen.findByText("Revision 2 is ready.")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Revision 1(?: of|,)/ })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith("/revisions/1"))).toHaveLength(before);
  expect(Events.opened).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(history.location.search).toContain("rev=2"));
  await screen.findByRole("button", { name: "Revision 2 of 2" });
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

test("phone menu copies the complete link and links to devices; header selects revisions", async () => {
  width = 390;
  newest = 2;
  window.history.replaceState(null, "", `/r/${id}?rev=1&tab=comments`);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const { history } = mount(`/r/${id}?rev=1&tab=comments`);
  await screen.findByRole("button", { name: /^Revision 1(?: of|,)/ });
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu", { name: "More" }));
  expect(menu.getByRole("menuitem", { name: "Inbox" }).getAttribute("href")).toBe("/");
  expect(menu.getByRole("menuitem", { name: "Devices" }).getAttribute("href")).toBe("/devices");
  fireEvent.click(menu.getByRole("menuitem", { name: "Copy link" }));
  expect(writeText).toHaveBeenCalledWith(location.origin + location.pathname + location.search);
  expect(await screen.findByText("Link copied")).toBeTruthy();
  expect(screen.queryByRole("menu")).toBeNull();
  await chooseRevision(2);
  await waitFor(() => expect(history.location.search).toContain("rev=2"));
  expect(history.location.search).toContain("tab=comments");
});

test("phone inbox menu offers Devices and Pair a device", async () => {
  width = 390;
  mount();
  await screen.findByRole("heading", { name: "Inbox" });
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu", { name: "More" }));
  expect(menu.getByRole("menuitem", { name: "Devices" }).getAttribute("href")).toBe("/devices");
  expect(menu.getByRole("menuitem", { name: "Pair a device" }).getAttribute("href")).toBe("/devices/pair");
});

test("hides Docs without docs, defaults bad search values, and keeps diff visible on desktop", async () => {
  fetchMock.mockImplementation(async (path: string) => {
    if (path.endsWith("/revisions/1")) return Response.json({ ...revision, docs: [] });
    if (path === "/api/v1/reviews") return Response.json({ items: [item] });
    return Response.json({ ...item, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
  });
  const { history } = mount(`/r/${id}?rev=-1&tab=diff&thread=bad`);
  await screen.findByText("Overview");
  expect(screen.queryByRole(width < 768 ? "link" : "tab", { name: /^Docs(?: \d+)?$/ })).toBeNull();
  expect(screen.getByTestId("diff-pane")).toBeTruthy();
  const reading = within(screen.getByRole("tablist", { name: "Reading tabs" }));
  expect(
    reading
      .getByRole(width < 768 ? "link" : "tab", { name: "Writeup" })
      .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
  ).toBe(width < 768 ? "page" : "true");
  fireEvent.click(reading.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
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
  expect((screen.getByRole("button", { name: /^Approve/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /^Send(?: \d+)?$/ }));
  await screen.findByText("Sent 1 comment to the agent");
  expect(screen.getByText("Sent")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect((screen.getByRole("button", { name: /^Approve/ }) as HTMLButtonElement).disabled).toBe(false);
  expect(
    container
      .querySelector('[aria-label="Send and approve"]')
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
  expect(drafts.getByText("Recover after reload")).toBeTruthy();
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
  expect(screen.queryByRole("region", { name: "Unsaved comments" })).toBeNull();
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
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  const original = await screen.findByLabelText("Reply");
  fireEvent.change(original, { target: { value: "Saved reply" } });
  const key = `${draftKey(id, draftTarget)}.reply.${id}`;
  expect(localStorage.getItem(key)).toBe("Saved reply");
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  try {
    await screen.findByText("Saved reply", { selector: "p" });
    await waitFor(() => expect(original.isConnected).toBe(false));
    expect(localStorage.getItem(key)).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
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
    await chooseRevision(2);
    try {
      await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.endsWith("/revisions/2"))).toBe(true));
      const sendBar = within(screen.getByRole("region", { name: "Send and approve" }));
      for (const name of [/^Send/, /^Approve/]) {
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
    for (const name of [/^Send/, /^Approve/])
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${action}`) }));
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
  await chooseRevision(2);
  await screen.findByRole("button", { name: "Retry" });
  const sendBar = within(screen.getByRole("region", { name: "Send and approve" }));
  expect(sendBar.getByText("Could not load this revision.")).toBeTruthy();
  for (const name of [/^Send/, /^Approve/])
    expect((sendBar.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep through failure");
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Overview");
  for (const name of [/^Send/, /^Approve/])
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
  fireEvent.click(await screen.findByRole("link", { name: "revision 1" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await screen.findByText("Follow-up", { selector: "p" });
  expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
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
    expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === "html-doc-seed.html")).toBe(true),
  );
  const link = screen.getByRole(width < 768 ? "link" : "tab", { name: new RegExp(tab) });
  if (width < 768) expect(new URL((link as HTMLAnchorElement).href).searchParams.has("thread")).toBe(false);
  fireEvent.click(link);
  await waitFor(() => expect(history.location.search).toContain(`tab=${tab.toLowerCase()}`));
  expect(history.location.search).not.toContain("thread=");
  expect(history.location.hash).toBe("");
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["revision", id, 1] });
  });
  expect(
    screen
      .getByRole(width < 768 ? "link" : "tab", { name: new RegExp(tab) })
      .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
  ).toBe(width < 768 ? "page" : "true");
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
    await screen.findByRole(width < 768 ? "link" : "tab", { name: "Writeup" });
    await waitFor(() => expect(client.isFetching({ queryKey: ["revision", id, 1] })).toBe(1));
    expect(container.querySelector("iframe")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    if (switchTab) {
      fireEvent.click(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
      await waitFor(() => expect(history.location.search).toContain("tab=comments"));
      expect(history.location.search).not.toContain("thread=");
    }
    await act(async () => {
      response.resolve(Response.json({ ...cached, threads: [thread] }));
      await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    });
    if (switchTab) {
      expect(history.location.search).toContain("tab=comments");
      expect(
        screen
          .getByRole(width < 768 ? "link" : "tab", { name: /Comments/ })
          .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
      ).toBe(width < 768 ? "page" : "true");
      expect(container.querySelector("iframe")).toBeNull();
      expect(scroll).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(history.location.search).toContain("tab=docs"));
      expect(container.querySelector('iframe[title="seed.html"]')).not.toBeNull();
      await waitFor(() =>
        expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === "html-doc-seed.html")).toBe(true),
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
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
  const blockScroll = scroll.mock.instances.findIndex((node) => (node as HTMLElement).id === `block-${draftBlock.id}`);
  expect(blockScroll).toBeGreaterThanOrEqual(0);
  expect(scroll.mock.calls[blockScroll]).toEqual([{ block: "center" }]);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  expect(scroll.mock.calls).toContainEqual([{ block: "nearest" }]);
  await fixture.update();
  expect(scroll).toHaveBeenCalledTimes(2);
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
  expect(scroll.mock.calls[0]).toEqual([{ block: "center" }]);
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

test("resuming a thread again creates one new intent, unaffected by SSE", async () => {
  const fixture = navigationFixture({ unplaced: true });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  localStorage.setItem(draftKey(id, draftTarget, id), "Resume twice");
  mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
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
  withDiff([
    { ...diffThread, comments: diffThread.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 })) },
  ]);
  mount(`/r/${id}`);
  const diff = within(await screen.findByTestId("diff-pane"));
  fireEvent.click(await diff.findByRole("button", { name: "Reply" }));
  const input = await diff.findByLabelText("Reply");
  input.focus();
  fireEvent.change(input, { target: { value: "Follow-up" } });
  fireEvent.click(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
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

  const { history } = mount(`/r/${id}?tab=comments`);
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  fireEvent.click(drafts.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(history.location.search).toContain("tab=diff"));
  const section = await screen.findByRole("region", { name: "File new.txt", hidden: true });
  const input = await within(await screen.findByRole("dialog", { name: "New comment" })).findByLabelText("Comment");
  expect((input as HTMLTextAreaElement).value).toBe("Line draft");
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(section.contains(input)).toBe(false);
  expect(screen.queryByRole("region", { name: "Resumed comment" })).toBeNull();
});
test("a delayed diff reply save cannot clear newer text after Comments claims the key", async () => {
  withDiff([
    { ...diffThread, comments: diffThread.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 })) },
  ]);
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
  fireEvent.click(await diff.findByRole("button", { name: "Reply" }));
  const input = await diff.findByLabelText("Reply");
  act(() => input.focus());
  fireEvent.change(input, { target: { value: "First reply" } });
  fireEvent.click(diff.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  fireEvent.click(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
  fireEvent.click(
    within(await screen.findByRole("region", { name: "Unsaved comments" })).getByRole("button", { name: "Resume" }),
  );
  const reading = within(screen.getByTestId("reading-pane"));
  const editor = (await reading.findByLabelText("Reply")) as HTMLTextAreaElement;
  expect((reading.getByRole("button", { name: "Save comment" }) as HTMLButtonElement).disabled).toBe(true);
  expect(editor.disabled).toBe(false);
  fireEvent.change(editor, { target: { value: "Second unsent reply" } });
  await act(async () => finish());
  await waitFor(() =>
    expect((reading.getByRole("button", { name: "Save comment" }) as HTMLButtonElement).disabled).toBe(false),
  );
  expect(editor.value).toBe("Second unsent reply");
  expect(localStorage.getItem(draftKey(id, diffTarget, id))).toBe("Second unsent reply");
  fireEvent.click(reading.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(submitted).toEqual([
      JSON.stringify({ body: "First reply" }),
      JSON.stringify({ body: "Second unsent reply" }),
    ]),
  );
  await waitFor(() => expect(reading.queryByRole("textbox", { name: "Reply" })).toBeNull());
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
  fireEvent.click(diff.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  fireEvent.click(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
  const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
  expect(drafts.getByText("Unsaved edit")).toBeTruthy();
  fireEvent.click(drafts.getByRole("button", { name: "Resume" }));
  const reading = within(screen.getByTestId("reading-pane"));
  const input = (await reading.findByLabelText("Edit comment")) as HTMLTextAreaElement;
  expect(document.activeElement).toBe(input);
  expect((reading.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "Second unsent edit" } });
  await act(async () => finish());
  await waitFor(() =>
    expect((reading.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false),
  );
  expect(input.value).toBe("Second unsent edit");
  expect(localStorage.getItem(editDraftKey(id, id))).toBe("Second unsent edit");
  fireEvent.click(reading.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(localStorage.getItem(editDraftKey(id, id))).toBeNull());
  expect(submitted).toEqual([JSON.stringify({ body: "First edit" }), JSON.stringify({ body: "Second unsent edit" })]);
});

test.each(
  [390, 1280].flatMap((size) =>
    (["file", "topic"] as const).flatMap((kind) =>
      (["save", "cancel", "discard"] as const).map((end) => ({ size, kind, end })),
    ),
  ),
)("resumed $kind draft keeps empty Diff visible at $size px until $end", async ({ size, kind, end }) => {
  width = size;
  openingRevision({
    writeupEmpty: false,
    topics: [{ slug: "retained", title: "Retained", importance: 1, summary: "" }],
  });
  const target: Target = kind === "file" ? { kind, path: "removed.ts" } : { kind, slug: "retained" };
  const key = draftKey(id, target);
  localStorage.setItem(key, "Resume this draft");
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path, init) =>
    init?.method === "POST" ? Promise.resolve(Response.json({})) : (fallback?.(path, init) as Promise<Response>),
  );
  const { history } = mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  const pane = await screen.findByTestId("diff-pane");
  const composer = within(size === 390 ? await screen.findByRole("dialog", { name: "New comment" }) : pane);
  const editor = (await composer.findByLabelText("Comment")) as HTMLTextAreaElement;
  expect(editor.value).toBe("Resume this draft");
  await waitFor(() => expect(document.activeElement).toBe(editor));
  if (size === 390) expect(history.location.search).toContain("tab=diff");
  // Deleting the draft's text while editing does not mean Discard.
  fireEvent.change(editor, { target: { value: "" } });
  expect(screen.getByTestId("diff-pane")).toBe(pane);
  fireEvent.change(editor, { target: { value: "Resume this draft" } });
  if (end === "discard") {
    if (size === 390) fireEvent.click(composer.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole(width < 768 ? "link" : "tab", { name: /Comments/ }));
    const drafts = within(await screen.findByRole("region", { name: "Unsaved comments" }));
    fireEvent.click(drafts.getByRole("button", { name: "Discard" }));
  } else fireEvent.click(composer.getByRole("button", { name: end === "save" ? "Save comment" : "Cancel" }));
  await waitFor(() => expect(screen.queryByTestId("diff-pane")).toBeNull());
  expect(screen.queryByRole("link", { name: "Diff" })).toBeNull();
  expect(localStorage.getItem(key)).toBe(end === "cancel" ? "Resume this draft" : null);
  if (end === "save")
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) =>
          path === `/api/v1/reviews/${id}/threads` &&
          JSON.stringify(JSON.parse(String(init?.body))) ===
            JSON.stringify({ revision: 1, target, body: "Resume this draft" }),
      ),
    ).toBe(true);
});

test.each([390, 1280])("a removed HTML draft keeps Docs visible at %s px until cancelled", async (size) => {
  width = size;
  openingRevision({ writeupEmpty: false });
  const target: Target = { kind: "html-span", path: "removed.html", quote: "seed", prefix: "", suffix: "" };
  localStorage.setItem(draftKey(id, target), "HTML draft");
  const { history } = mount(`/r/${id}?tab=comments`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  const composer = within(
    await screen.findByRole(size === 390 ? "dialog" : "region", {
      name: size === 390 ? "New comment" : "Resumed comment",
    }),
  );
  expect((composer.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("HTML draft");
  await waitFor(() => expect(history.location.search).toContain("tab=docs"));
  fireEvent.click(composer.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole(width < 768 ? "link" : "tab", { name: /^Docs(?: \d+)?$/ })).toBeNull());
  expect(screen.queryByRole("region", { name: "Resumed comment" })).toBeNull();
  expect(
    screen
      .getByRole(width < 768 ? "link" : "tab", { name: "Writeup" })
      .getAttribute(width < 768 ? "aria-current" : "aria-selected"),
  ).toBe(width < 768 ? "page" : "true");
});

test.each(["writeup", "docs"] as const)(
  "an active %s draft keeps its tab across an empty revision until cancelled",
  async (tab) => {
    width = 390;
    newest = 2;
    const block: RenderedBlock =
      tab === "writeup" ? draftBlock : { ...draftBlock, id: "doc-12345678-12345678", section: "doc-12345678" };
    const target: Target =
      tab === "writeup" ? draftTarget : { ...draftTarget, kind: "doc-span", path: "old.md", blockId: block.id };
    openingRevision(
      tab === "writeup"
        ? { docs: [{ path: "next.md", kind: "markdown", blocks: [] }], writeup: { sections: [] } }
        : { writeupEmpty: false },
      tab === "writeup"
        ? {
            writeupEmpty: false,
            writeup: { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [block] }] },
          }
        : { docs: [{ path: "old.md", kind: "markdown", blocks: [block] }] },
    );
    localStorage.setItem(draftKey(id, target), "Keep editing");
    const { history } = mount(`/r/${id}?rev=1&tab=comments`);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    const name = tab === "writeup" ? "Writeup" : "Docs";
    await waitFor(() => expect(history.location.search).toContain(`tab=${tab}`));
    await act(async () => history.push(`/r/${id}?rev=2&tab=${tab}`));
    await waitFor(() => expect(screen.queryByText("Plant a seed.")).toBeNull());
    expect(history.location.search).toContain(`tab=${tab}`);
    const composer = within(screen.getByRole("dialog", { name: "New comment" }));
    expect((composer.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Keep editing");
    fireEvent.click(composer.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("link", { name })).toBeNull());
    expect(
      screen.getByRole("link", { name: tab === "writeup" ? "Docs" : "Writeup" }).getAttribute("aria-current"),
    ).toBe("page");
  },
);

test("an unplaced reading draft resumed beside Diff stays visible when resized to a phone", async () => {
  openingRevision({ files: [{ ...diffFile, topic: null }], writeup: { sections: [] } });
  localStorage.setItem(draftKey(id, draftTarget), "Unplaced writeup draft");
  const { history } = mount(`/r/${id}?tab=diff`);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  expect(((await screen.findByLabelText("Comment")) as HTMLTextAreaElement).value).toBe("Unplaced writeup draft");
  act(() => resize(390));
  expect(((await screen.findByLabelText("Comment")) as HTMLTextAreaElement).value).toBe("Unplaced writeup draft");
  expect(history.location.search).toContain("tab=comments");
  expect(screen.getByRole("dialog", { name: "New comment" })).toBeTruthy();
});

test.each([null, "2026-01-02T00:00:00.000Z"])("shows provenance only for copied reviews (%s)", async (importedAt) => {
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === `/api/v1/reviews/${id}`
      ? Response.json({ ...item, importedAt, revisions: [{ seq: 1, createdAt: item.updatedAt }] })
      : (fallback?.(path, init) as Promise<Response>),
  );
  mount(`/r/${id}`);
  await screen.findByRole("heading", { name: item.title });
  if (importedAt)
    expect(
      await screen.findByText(/Copied from Workshop on .*Comments, Sends and approvals before then were made there\./),
    ).toBeTruthy();
  else expect(screen.queryByText(/Copied from/)).toBeNull();
});

function withInbox(items: InboxItem[]) {
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === "/api/v1/reviews" ? Response.json({ items }) : (fallback?.(path, init) as Promise<Response>),
  );
}
const secondItem: InboxItem = {
  ...item,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Another proposal",
  branch: "feature/garden",
  origin: { id: "22222222-2222-4222-8222-222222222222", name: "Garden" },
  unsentCount: 0,
  openThreads: 0,
  agentWaiting: true,
};

test("inbox row shows machine, title, branch, local time, counts and attention without exposing the repo key", async () => {
  mount();
  const row = await screen.findByRole("link", { name: /Synthetic review/ });
  expect(within(row).getByText("Workshop")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /From Workshop/ })).toBeNull();
  expect(within(row).queryByRole("img", { name: "From Workshop" })).toBeNull();
  expect(within(row).getByText("main")).toBeTruthy();
  expect(row.textContent).not.toContain(item.repo);
  expect(row.textContent).not.toContain("Revision");
  expect(row.querySelector("time")?.dateTime).toBe(item.updatedAt);
  expect(row.querySelector("time")?.title).toBe(new Date(item.updatedAt).toLocaleString());
  expect(row.textContent).toContain("1 open thread");
  expect(row.textContent).toContain("2 unsent");
  expect(within(row).getByRole("img", { name: "No agent waiting" })).toBeTruthy();
  expect(within(row).getByText("Needs you.").className).toBe("sr-only");
  expect(row.querySelector('[aria-hidden="true"].bg-accent')).toBeTruthy();
});

test.each(["approved", "settled"] as const)(
  "%s row replaces time with state and has no attention mark",
  async (state) => {
    withInbox([{ ...item, state }]);
    mount();
    const row = await screen.findByRole("link", { name: /Synthetic review/ });
    expect(within(row).getByText(state === "approved" ? "Approved" : "Settled")).toBeTruthy();
    expect(row.querySelector("time")).toBeNull();
    expect(within(row).queryByText("Needs you.")).toBeNull();
  },
);

test("moved rows are disabled and omit attention, counts and agent glyphs", async () => {
  withInbox([{ ...item, movedTo: "https://hub.example/r/new" }]);
  mount();
  const moved = await screen.findByText("Moved to hub.example");
  const row = moved.closest('[aria-disabled="true"]');
  expect(row?.tagName).toBe("DIV");
  expect(row?.textContent).not.toMatch(/unsent|open thread|Needs you/);
  expect(screen.queryByRole("img", { name: "No agent waiting" })).toBeNull();
  expect(screen.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
});

test("quiet rows omit zero counts, attention and absent branch", async () => {
  withInbox([{ ...item, branch: null, unsentCount: 0, openThreads: 0, pendingSend: false }]);
  mount();
  const row = await screen.findByRole("link", { name: /Synthetic review/ });
  expect(row.textContent).not.toMatch(/unsent|open thread|Needs you|main/);
  expect(within(row).queryByRole("img", { name: /agent waiting/i })).toBeNull();
  expect(screen.getByText("Nothing needs you · 1 machine")).toBeTruthy();
});

test.each(["SYNTHETIC", "MaIn", "wORKsHOP"])("text filter matches title, branch and machine for %s", async (filter) => {
  withInbox([item, secondItem]);
  mount();
  await screen.findByRole("link", { name: /Another proposal/ });
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: filter } });
  expect(screen.getByRole("link", { name: /Synthetic review/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Another proposal/ })).toBeNull();
});

test("no matches can be cleared and filtering preserves server order without changing the URL", async () => {
  withInbox([secondItem, item]);
  const { history } = mount();
  await screen.findByRole("link", { name: /Another proposal/ });
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "not present" } });
  expect(screen.getByText("No reviews match this filter.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect((screen.getByRole("textbox", { name: "Filter reviews" }) as HTMLInputElement).value).toBe("");
  expect(
    within(screen.getByRole("list"))
      .getAllByRole("link")
      .map((row) => row.getAttribute("href")),
  ).toEqual([`/r/${secondItem.id}?rev=${secondItem.newestRevision}`, `/r/${id}?rev=${item.newestRevision}`]);
  expect(history.location.search).toBe("");
});

test("machine Select appears for multiple origins, sorts names and combines with the text filter", async () => {
  withInbox([item, secondItem]);
  mount();
  const machine = await screen.findByRole("combobox", { name: "Machine" });
  expect(machine.tagName).toBe("SELECT");
  expect(
    within(machine)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["All machines", "Garden", "Workshop"]);
  expect(screen.getByText("2 need you · 2 machines")).toBeTruthy();
  fireEvent.change(machine, { target: { value: secondItem.origin.id } });
  expect(screen.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
  expect(screen.getByRole("link", { name: /Another proposal/ })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "main" } });
  expect(screen.getByText("No reviews match this filter.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(screen.getByRole("link", { name: /Synthetic review/ })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Another proposal/ })).toBeTruthy();
});

test("single origin omits the machine filter; subtitle excludes moved and completed reviews", async () => {
  withInbox([
    item,
    { ...item, id: secondItem.id, state: "approved" },
    { ...item, id: "44444444-4444-4444-8444-444444444444", movedTo: "https://hub.example/r/new" },
  ]);
  mount();
  await screen.findByText("1 needs you · 1 machine");
  expect(screen.queryByRole("combobox", { name: "Machine" })).toBeNull();
});

test("compact inbox filters too, omits machine Select and keeps the current row active on another tab", async () => {
  withInbox([item, secondItem]);
  mount(`/r/${id}?tab=comments`);
  const inbox = within(await screen.findByRole("complementary", { name: "Inbox" }));
  await inbox.findByRole("link", { name: /Synthetic review/ });
  expect(inbox.getByRole("link", { name: /Synthetic review/ }).getAttribute("aria-current")).toBe("page");
  expect(inbox.queryByRole("combobox", { name: "Machine" })).toBeNull();
  fireEvent.change(inbox.getByRole("textbox", { name: "Filter reviews" }), { target: { value: "garden" } });
  expect(inbox.queryByRole("link", { name: /Synthetic review/ })).toBeNull();
  expect(inbox.getByRole("link", { name: /Another proposal/ })).toBeTruthy();
});

test("one list timer refreshes relative times and is cleared on unmount", async () => {
  let now = Date.parse(item.updatedAt) + 30_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const interval = vi.spyOn(window, "setInterval");
  const clear = vi.spyOn(window, "clearInterval");
  withInbox([item, secondItem]);
  const { unmount } = mount();
  const row = await screen.findByRole("link", { name: /Synthetic review/ });
  expect(row.querySelector("time")?.textContent).toBe("now");
  const ticks = interval.mock.calls.filter(([, delay]) => delay === 60_000);
  expect(ticks).toHaveLength(1);
  const callback = ticks[0]?.[0];
  expect(typeof callback).toBe("function");
  now += 60_000;
  act(() => {
    if (typeof callback === "function") callback();
  });
  expect(row.querySelector("time")?.textContent).toBe("1m");
  const index = interval.mock.calls.findIndex(([, delay]) => delay === 60_000);
  const timer = interval.mock.results[index]?.value;
  unmount();
  expect(clear).toHaveBeenCalledWith(timer);
});

test("desktop frame has wordmark and Devices links, expands its rail and persists both choices", async () => {
  withInbox([item, { ...secondItem, movedTo: "https://hub.example/r/new" }]);
  const first = mount(`/r/${id}?tab=docs`);
  await screen.findByText("plan.md");
  expect(screen.getByRole("link", { name: "emend" }).getAttribute("href")).toBe("/");
  expect(screen.getByRole("link", { name: "Devices" }).getAttribute("href")).toBe("/devices");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  const rail = within(screen.getByRole("complementary", { name: "Inbox" }));
  const link = await rail.findByRole("link", { name: "Needs you: Synthetic review" });
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(within(link).getByRole("img", { name: "From Workshop" })).toBeTruthy();
  expect(rail.queryByRole("link", { name: /Another proposal/ })).toBeNull();
  expect(localStorage.getItem("emend.inbox.collapsed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
  expect(screen.getByTestId("inbox-pane")).toBeTruthy();
  expect(localStorage.getItem("emend.inbox.collapsed")).toBe("false");
  first.unmount();
  mount(`/r/${id}`);
  expect(await screen.findByTestId("inbox-pane")).toBeTruthy();
});

test.each([768, 1279])("tablet %s has a rail and selecting a review closes the left sheet", async (size) => {
  width = size;
  withInbox([item, secondItem]);
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === `/api/v1/reviews/${secondItem.id}`
      ? Response.json({ ...secondItem, revisions: [{ seq: 1, createdAt: item.updatedAt }] })
      : (fallback?.(path, init) as Promise<Response>),
  );
  const { history } = mount(`/r/${id}`);
  await screen.findByText("Overview");
  const rail = within(screen.getByRole("complementary", { name: "Inbox" }));
  expect(await rail.findByRole("link", { name: "Needs you: Synthetic review" })).toBeTruthy();
  fireEvent.click(rail.getByRole("button", { name: "Show inbox" }));
  const sheet = within(await screen.findByRole("dialog", { name: "Inbox" }));
  expect(sheet.getAllByRole("heading", { name: "Inbox" })).toHaveLength(1);
  expect(sheet.queryByRole("button", { name: "Collapse inbox" })).toBeNull();
  const destination = await sheet.findByRole("link", { name: /Another proposal/ });
  destination.focus();
  fireEvent.click(destination, { button: 0 });
  await waitFor(() => expect(history.location.pathname).toBe(`/r/${secondItem.id}`));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull());
  const heading = await screen.findByRole("heading", { name: "Another proposal", level: 1 });
  await waitFor(() => expect(document.activeElement).toBe(heading));
});

test("phone review shows its title once, back link, and clipboard failure toast", async () => {
  width = 390;
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(screen.getAllByText("Synthetic review")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Inbox" }).getAttribute("href")).toBe("/");
  expect(screen.queryByText(item.repo ?? "")).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const menu = within(await screen.findByRole("menu", { name: "More" }));
  expect(menu.queryByRole("combobox")).toBeNull();
  fireEvent.click(menu.getByRole("menuitem", { name: "Copy link" }));
  expect(await screen.findByText("Could not copy the link. Copy it from the address bar.")).toBeTruthy();
});

for (const size of [390, 768, 1280])
  for (const [path, heading] of [
    ["/", "Inbox"],
    [`/r/${id}`, "Synthetic review"],
    ["/devices", "Devices"],
  ]) {
    test(`one main on ${path} at ${size}px`, async () => {
      width = size;
      const fallback = fetchMock.getMockImplementation();
      fetchMock.mockImplementation(async (url, init) =>
        url === "/api/v1/devices" ? Response.json({ items: [] }) : (fallback?.(url, init) as Promise<Response>),
      );
      mount(path);
      await screen.findByRole("heading", { level: 1, name: heading });
      expect(screen.getAllByRole("main")).toHaveLength(1);
    });
  }

test.each([0, 2])(
  "phone tabs show decorative icons, URL selection and only a positive unsent count (%s)",
  async (unsentCount) => {
    width = 390;
    const fallback = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (path, init) =>
      path === `/api/v1/reviews/${id}`
        ? Response.json({ ...item, unsentCount, revisions: [{ seq: 1, createdAt: item.updatedAt }] })
        : (fallback?.(path, init) as Promise<Response>),
    );
    const { history } = mount(`/r/${id}?tab=writeup`);
    await screen.findByText("Overview");
    const tabs = within(screen.getByRole("navigation", { name: "Review tabs" }));
    const links = tabs.getAllByRole("link");
    expect(links).toHaveLength(4);
    for (const label of ["Writeup", "Diff", "Docs", "Comments"])
      expect(tabs.getByRole("link", { name: new RegExp(label) })).toBeTruthy();
    for (const link of links) expect(link.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(tabs.queryByRole("img")).toBeNull();
    expect(tabs.getByRole("link", { name: "Writeup" }).getAttribute("aria-current")).toBe("page");
    const comments = tabs.getByRole("link", { name: unsentCount ? "Comments 2 unsent" : "Comments" });
    expect(comments.textContent).toBe(unsentCount ? "Comments 2 unsent" : "Comments");
    fireEvent.click(comments);
    await waitFor(() => expect(history.location.search).toContain("tab=comments"));
    expect(comments.getAttribute("aria-current")).toBe("page");
  },
);

test("task 1.13 at 390 × 844 keeps Send outside the reading scroll area and before bottom tabs", async () => {
  width = 390;
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(screen.getByRole("banner")).toBeTruthy();
  expect(screen.queryByRole("complementary", { name: "Inbox" })).toBeNull();
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  expect(screen.queryByTestId("diff-pane")).toBeNull();
  const reading = screen.getByRole("region", { name: "Reading" });
  expect(reading.className).toContain("overflow-y-auto");
  const send = screen.getByRole("button", { name: /^Send/ });
  const tabs = screen.getByRole("navigation", { name: "Review tabs" });
  expect(reading.contains(send)).toBe(false);
  expect(reading.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(send.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("an approved review at an older revision does not claim that revision was approved", async () => {
  width = 390;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === `/api/v1/reviews/${id}`
      ? Response.json({
          ...item,
          state: "approved",
          newestRevision: 2,
          revisions: [
            { seq: 1, createdAt: item.updatedAt },
            { seq: 2, createdAt: item.updatedAt },
          ],
        })
      : (fallback?.(path, init) as Promise<Response>),
  );
  mount(`/r/${id}?rev=1`);
  await screen.findByRole("button", { name: /^Revision 1(?: of|,)/ });
  const header = screen.getByRole("heading", { level: 1, name: item.title }).parentElement?.parentElement;
  if (!header) throw new Error("Missing review header");
  expect(within(header).getAllByText("Approved")).toHaveLength(1);
  expect(within(header).queryByText(/Approved.*rev/i)).toBeNull();
});

test.each(["pane", "rail"])(
  "desktop %s navigation focuses the new review heading once after loading",
  async (source) => {
    withInbox([item, secondItem]);
    let releaseReview: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const fallback = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (path, init) => {
      if (path === `/api/v1/reviews/${secondItem.id}`) {
        await ready;
        return Response.json({ ...secondItem, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
      }
      return fallback?.(path, init) as Promise<Response>;
    });
    mount(`/r/${id}`);
    await screen.findByText("Overview");
    if (source === "rail") fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
    const inbox = within(screen.getByRole("complementary", { name: "Inbox" }));
    const destination = await inbox.findByRole("link", { name: /Another proposal/ });
    destination.focus();
    fireEvent.click(destination, { button: 0 });
    await screen.findByText("Loading review…");
    await act(async () => {
      releaseReview();
    });
    const heading = await screen.findByRole("heading", { name: secondItem.title, level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.tabIndex).toBe(-1);
    const devices = screen.getByRole("link", { name: "Devices" });
    devices.focus();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["review", secondItem.id] });
    });
    expect(document.activeElement).toBe(devices);
  },
);

test.each([768, 1280])("first review load at %s px does not move focus", async (size) => {
  width = size;
  const { getByRole } = render(<button type="button">Keep focus</button>);
  const focused = getByRole("button", { name: "Keep focus" });
  focused.focus();
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  expect(document.activeElement).toBe(focused);
});

test("tablet Sheet stays closed after resizing 768 → 1280 → 768", async () => {
  width = 768;
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
  await screen.findByRole("dialog", { name: "Inbox" });
  act(() => resize(1280));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull());
  expect(screen.getByTestId("inbox-pane")).toBeTruthy();
  act(() => resize(768));
  expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull();
  expect(screen.getByRole("button", { name: "Show inbox" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
  expect(await screen.findByRole("dialog", { name: "Inbox" })).toBeTruthy();
});

test("in-memory collapsed preference survives the phone layout with unavailable localStorage", async () => {
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
  expect(screen.getByRole("button", { name: "Show inbox" })).toBeTruthy();
  act(() => resize(390));
  expect(screen.queryByRole("complementary", { name: "Inbox" })).toBeNull();
  act(() => resize(1280));
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  expect(screen.getByRole("button", { name: "Show inbox" })).toBeTruthy();
});

test("a row with an invalid cached timestamp has no time text", async () => {
  client.setQueryDefaults(["inbox"], { staleTime: Infinity });
  client.setQueryData(["inbox"], { items: [{ ...item, updatedAt: "invalid" }] });
  mount();
  const row = await screen.findByRole("link", { name: /Synthetic review/ });
  expect(row.querySelector("time")?.textContent).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("phone and desktop tabs retain the shared navigation props", () => {
  expectTypeOf<typeof PhoneTabs>().parameter(0).toEqualTypeOf<ReviewTabsProps>();
  expectTypeOf<typeof ReviewTabs>().parameter(0).toExtend<ReviewTabsProps>();
});

test.each([
  { name: "ctrl", click: { button: 0, ctrlKey: true } },
  { name: "cmd", click: { button: 0, metaKey: true } },
  { name: "shift", click: { button: 0, shiftKey: true } },
  { name: "alt", click: { button: 0, altKey: true } },
  { name: "middle", click: { button: 1 } },
])("$name-click on a tablet row leaves the Sheet open and its href intact", async ({ click }) => {
  width = 768;
  withInbox([item, secondItem]);
  const { history } = mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Show inbox" }));
  const dialog = await screen.findByRole("dialog", { name: "Inbox" });
  const destination = await within(dialog).findByRole("link", { name: /Another proposal/ });
  expect(destination.getAttribute("href")).toBe(`/r/${secondItem.id}?rev=${secondItem.newestRevision}`);
  destination.focus();
  let defaultPrevented = true;
  const onClick = (event: MouseEvent) => {
    defaultPrevented = event.defaultPrevented;
  };
  document.addEventListener("click", onClick, { once: true });
  fireEvent.click(destination, click);
  expect(defaultPrevented).toBe(false);
  expect(history.location.pathname).toBe(`/r/${id}`);
  expect(screen.getByRole("dialog", { name: "Inbox" })).toBe(dialog);
  expect(document.activeElement).toBe(destination);
});

test("in-memory collapsed preference survives rail navigation with unavailable localStorage", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Storage denied");
    },
    setItem: () => {
      throw new Error("Storage denied");
    },
  });
  withInbox([item, secondItem]);
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === `/api/v1/reviews/${secondItem.id}`
      ? Response.json({ ...secondItem, revisions: [{ seq: 1, createdAt: item.updatedAt }] })
      : (fallback?.(path, init) as Promise<Response>),
  );
  const { history } = mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  const rail = within(screen.getByRole("complementary", { name: "Inbox" }));
  const destination = await rail.findByRole("link", { name: "Needs you: Another proposal" });
  destination.focus();
  fireEvent.click(destination, { button: 0 });
  await screen.findByRole("heading", { name: secondItem.title, level: 1 });
  expect(history.location.pathname).toBe(`/r/${secondItem.id}`);
  expect(screen.queryByTestId("inbox-pane")).toBeNull();
  expect(screen.getByRole("button", { name: "Show inbox" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Needs you: Another proposal" }).getAttribute("aria-current")).toBe("page");
});

test.each([
  { status: 404, recovery: "retry" },
  { status: 500, recovery: "retry" },
  { status: 404, recovery: "refetch" },
  { status: 500, recovery: "refetch" },
])("a $status review load clears pending heading focus before a successful $recovery", async ({ status, recovery }) => {
  withInbox([item, secondItem]);
  let attempts = 0;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (path === `/api/v1/reviews/${secondItem.id}`) {
      attempts++;
      return attempts === 1
        ? Response.json({ error: { code: "failed", message: "Failed" } }, { status })
        : Response.json({ ...secondItem, revisions: [{ seq: 1, createdAt: item.updatedAt }] });
    }
    return fallback?.(path, init) as Promise<Response>;
  });
  const { getByRole } = render(<button type="button">Keep focus after failure</button>);
  const focused = getByRole("button", { name: "Keep focus after failure" });
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.click(screen.getByRole("button", { name: "Collapse inbox" }));
  fireEvent.click(await screen.findByRole("link", { name: "Needs you: Another proposal" }), { button: 0 });
  expect((await screen.findByRole("alert")).textContent).toBe("Could not load this review.");
  focused.focus();
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  if (recovery === "retry") fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  else
    await act(async () => {
      await client.refetchQueries({ queryKey: ["review", secondItem.id] });
    });
  const heading = await screen.findByRole("heading", { name: secondItem.title, level: 1 });
  await screen.findByText("Overview");
  expect(attempts).toBe(2);
  expect(document.activeElement).toBe(focused);
  expect(focus.mock.instances).not.toContain(heading);
});

test("a cached review with a failed refetch takes heading focus once while its next fetch is pending", async () => {
  withInbox([item, secondItem]);
  const cachedReview = { ...secondItem, importedAt: null, revisions: [{ seq: 1, createdAt: item.updatedAt }] };
  const query = reviewQuery(secondItem.id);
  client.setQueryData(query.queryKey, cachedReview);
  let attempts = 0;
  let releaseFetch: (response: Response) => void = () => {};
  const nextFetch = new Promise<Response>((resolve) => {
    releaseFetch = resolve;
  });
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) => {
    if (path === `/api/v1/reviews/${secondItem.id}`) {
      attempts++;
      return attempts === 1
        ? Response.json({ error: { code: "failed", message: "Failed" } }, { status: 500 })
        : nextFetch;
    }
    return fallback?.(path, init) as Promise<Response>;
  });
  await expect(client.fetchQuery(query)).rejects.toThrow();
  expect(client.getQueryState(query.queryKey)).toMatchObject({ status: "error", data: cachedReview });
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  const inbox = within(screen.getByRole("complementary", { name: "Inbox" }));
  const destination = await inbox.findByRole("link", { name: /Another proposal/ });
  destination.focus();
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  fireEvent.click(destination, { button: 0 });
  const heading = await screen.findByRole("heading", { name: secondItem.title, level: 1 });
  await waitFor(() => expect(attempts).toBe(2));
  expect(client.getQueryState(query.queryKey)).toMatchObject({
    status: "error",
    fetchStatus: "fetching",
    data: cachedReview,
  });
  expect(document.activeElement).toBe(heading);
  expect(focus.mock.instances.filter((element) => element === heading)).toHaveLength(1);
  const devices = screen.getByRole("link", { name: "Devices" });
  devices.focus();
  await act(async () => {
    releaseFetch(Response.json(cachedReview));
  });
  await waitFor(() => expect(client.getQueryState(query.queryKey)?.status).toBe("success"));
  expect(document.activeElement).toBe(devices);
  expect(focus.mock.instances.filter((element) => element === heading)).toHaveLength(1);
});

test("phone header is absent on Diff and returns with its revision picker on every reading tab", async () => {
  width = 390;
  mount(`/r/${id}?tab=writeup`);
  await screen.findByText("Overview");
  expect(screen.getByRole("heading", { level: 1, name: item.title })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Diff" }));
  await screen.findByTestId("diff-pane");
  expect(screen.queryByRole("heading", { level: 1, name: item.title })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Revision 1/ })).toBeNull();
  for (const tab of ["Docs", "Comments", "Writeup"]) {
    fireEvent.click(screen.getByRole("link", { name: new RegExp(`^${tab}`) }));
    await screen.findByRole("heading", { level: 1, name: item.title });
    expect(screen.getByRole("button", { name: "Revision 1 of 1" })).toBeTruthy();
    expect(screen.queryByTestId("diff-pane")).toBeNull();
  }
});

test("revision picker loads the chosen revision and its commit range", async () => {
  newest = 2;
  openingRevision(
    { writeupEmpty: false, base: `abcdef1${"0".repeat(33)}`, head: `1234567${"0".repeat(33)}` },
    { writeupEmpty: false, base: "0".repeat(40), head: "worktree" },
  );
  const { history } = mount(`/r/${id}`);
  await screen.findByText("abcdef1 → 1234567");
  await chooseRevision(1);
  await screen.findByText("0000000 → working tree");
  expect(history.location.search).toContain("rev=1");
  expect(screen.getByRole("button", { name: "Revision 1, 2 is newer" })).toBeTruthy();
  expect(screen.queryByText("abcdef1 → 1234567")).toBeNull();
});

test("a published revision blocks stale actions even before review metadata catches up", async () => {
  mount(`/r/${id}`);
  await screen.findByText("Overview");
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Keep this instruction" } });
  expect((screen.getByRole("button", { name: "Send 2" }) as HTMLButtonElement).disabled).toBe(false);
  // newest stays 1 in the metadata fixture; the event is the newest known revision.
  act(() => Events.opened[0]?.emit("publish", { reviewId: id, revision: 2 }));
  const reason = "Revision 2 is newer. Switch to it to send or approve.";
  await screen.findByText(reason);
  for (const name of ["Send 2", "Approve revision 1"]) {
    const button = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const descriptions = button
      .getAttribute("aria-describedby")
      ?.split(" ")
      .map((key) => document.getElementById(key)?.textContent);
    expect(descriptions).toContain(reason);
  }
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Send 2" }) as HTMLButtonElement).disabled).toBe(false),
  );
  expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe("Keep this instruction");
});

test("phone Diff navigation consumes pending heading focus before a later refetch", async () => {
  width = 390;
  let refreshed = false;
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (path, init) =>
    path === `/api/v1/reviews/${secondItem.id}`
      ? Response.json({
          ...secondItem,
          updatedAt: refreshed ? "2026-01-02T00:00:00.000Z" : item.updatedAt,
          revisions: [{ seq: 1, createdAt: item.updatedAt }],
        })
      : (fallback?.(path, init) as Promise<Response>),
  );
  // A cached Diff revision renders without an intermediate loading header.
  client.setQueryData(["revision", secondItem.id, 1], revision);
  const { history } = mount(`/r/${id}?tab=diff`);
  await screen.findByTestId("diff-pane");
  act(() => history.push(`/r/${secondItem.id}?tab=diff`));
  await waitFor(() =>
    expect(client.getQueryData(reviewQuery(secondItem.id).queryKey)).toMatchObject({ id: secondItem.id }),
  );
  await screen.findByTestId("diff-pane");
  expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Writeup" }));
  const heading = await screen.findByRole("heading", { level: 1, name: secondItem.title });
  const keepFocus = screen.getByRole("button", { name: "More" });
  act(() => keepFocus.focus());
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  refreshed = true;
  await act(async () => {
    await client.refetchQueries({ queryKey: ["review", secondItem.id] });
  });
  expect(document.activeElement).toBe(keepFocus);
  expect(focus.mock.instances).not.toContain(heading);
});

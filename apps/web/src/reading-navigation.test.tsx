// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import type { RenderedBlock, ReviewView, RevisionView, ThreadView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Window } from "happy-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import type { DiffPaneProps } from "./components/diff/DiffPane.tsx";
import { blockLink } from "./components/threads/ThreadCard.tsx";
import { draftKey } from "./lib/drafts.ts";
import { validateReviewSearch } from "./router.tsx";

const loading = vi.hoisted(() => ({ ready: undefined as Promise<void> | undefined }));
vi.mock("./components/diff/LazyDiffPane.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/diff/LazyDiffPane.tsx")>();
  return {
    ...actual,
    LazyDiffPane: (props: DiffPaneProps) => (
      <actual.LazyDiffPane
        {...props}
        load={async () => {
          await loading.ready;
          return import("./components/diff/DiffPane.tsx");
        }}
      />
    ),
  };
});
const id = "11111111-1111-4111-8111-111111111111";
const review: ReviewView = {
  id,
  title: "Synthetic garden",
  origin: { id, name: "Workshop" },
  repo: null,
  branch: null,
  state: "open",
  newestRevision: 1,
  unsentCount: 2,
  openThreads: 0,
  agentWaiting: false,
  pendingSend: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  movedTo: null,
  importedAt: null,
  revisions: [{ seq: 1, createdAt: "2026-01-01T00:00:00.000Z" }],
};
const revision: RevisionView = {
  seq: 1,
  base: null,
  head: null,
  main: "writeup",
  writeupEmpty: false,
  topics: [{ slug: "seed", title: "Plant a seed", summary: "A synthetic garden", importance: 1 }],
  files: [
    {
      id,
      path: "seed.txt",
      oldPath: null,
      role: "diff",
      topic: "seed",
      order: 0,
      status: "modified",
      mediaType: "text/plain",
      flag: "binary",
      hasOld: false,
      hasNew: false,
    },
  ],
  writeup: {
    sections: [
      {
        key: "t-seed-body",
        label: "Plant a seed — Details",
        topic: "seed",
        blocks: [
          {
            id: "t-seed-body-12345678",
            section: "t-seed-body",
            kind: "paragraph",
            text: "Keep growing",
            html: "<p>Keep growing</p>",
          },
        ],
      },
    ],
  },
  docs: [
    { kind: "markdown", path: "seed.md", blocks: [] },
    { kind: "markdown", path: "water.md", blocks: [] },
  ],
  threads: [],
  changedBlocks: [],
};
let currentRevision: RevisionView;
let currentReview: ReviewView;
let revisionReply: Promise<Response> | undefined;
let width = 1280;
let client: QueryClient;
let loaded: ReturnType<typeof Promise.withResolvers<void>>;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  width = 1280;
  currentRevision = structuredClone(revision);
  currentReview = structuredClone(review);
  revisionReply = undefined;
  loaded = Promise.withResolvers<void>();
  loading.ready = loaded.promise;
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      close() {}
    },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(query.match(/\d+/)?.[0] ?? Infinity),
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === `/api/v1/reviews/${id}/threads` && init?.method === "POST")
        return Response.json({ threadId: id, commentId: id }, { status: 201 });
      if (path === "/api/v1/session") return new Response(null, { status: 204 });
      if (path === "/api/v1/reviews") return Response.json({ items: [review] });
      if (path === `/api/v1/reviews/${id}`) return Response.json(currentReview);
      if (path === `/api/v1/reviews/${id}/revisions/1`) return revisionReply ?? Response.json(currentRevision);
      if (path === `/api/v1/reviews/${id}/revisions/2`) return Response.json({ ...currentRevision, seq: 2 });
      throw new Error(`Unexpected synthetic request: ${path}`);
    }),
  );
});
afterEach(async () => {
  cleanup();
  client.clear();
  await (window as unknown as Window).happyDOM.abort();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(search = "?tab=writeup&rev=1") {
  const history = createMemoryHistory({ initialEntries: [`/r/${id}${search}`] });
  return { ...render(<App queryClient={client} history={history} />), history };
}

test.each([1280, 768, 390])("Files in diff waits for lazy rendering and scrolls its topic at %s px", async (pixels) => {
  width = pixels;
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history, container } = mount();
  const link = await screen.findByRole("link", { name: "Files in diff: Plant a seed" });
  const href = new URL((link as HTMLAnchorElement).href);
  expect(href.searchParams.get("tab")).toBe(pixels < 768 ? "diff" : "writeup");
  expect(href.searchParams.get("rev")).toBe("1");
  expect(href.hash).toBe("#diff-topic-seed");
  const block = container.querySelector("[data-block-id]");
  const reading = screen.getByTestId("reading-pane");
  reading.scrollTop = 80;
  fireEvent.click(link);
  await waitFor(() => expect(history.location.hash).toBe("#diff-topic-seed"));
  expect(screen.getByText("Loading diff…")).toBeTruthy();
  expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === "diff-topic-seed")).toBe(false);
  await act(async () => {
    loaded.resolve();
  });
  await waitFor(() =>
    expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === "diff-topic-seed")).toBe(true),
  );
  if (pixels >= 768) {
    expect(container.querySelector("[data-block-id]")).toBe(block);
    expect(screen.getByTestId("reading-pane")).toBe(reading);
    expect(reading.scrollTop).toBe(80);
    // A second click is a fresh scroll intent even when the URL is unchanged.
    scroll.mockClear();
    fireEvent.click(link);
    await waitFor(() =>
      expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === "diff-topic-seed")).toBe(true),
    );
  } else {
    expect(screen.queryByTestId("reading-pane")).toBeNull();
    expect(screen.getByRole("link", { name: "Diff" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("tabpanel")).toBeNull();
  }
});

test.each([1280, 768])(
  "reading tabs have counts, keyboard navigation and a labelled panel at %s px",
  async (pixels) => {
    width = pixels;
    const { history } = mount(`?tab=writeup&thread=${id}#topic-seed`);
    const tabs = within(await screen.findByRole("tablist", { name: "Reading tabs" }));
    await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
    const writeup = tabs.getByRole("tab", { name: "Writeup" });
    const docs = tabs.getByRole("tab", { name: "Docs 2" });
    const comments = tabs.getByRole("tab", { name: "Comments 2" });
    expect(within(comments).getByText("2").className).toContain("bg-accent");
    expect(tabs.queryByRole("tab", { name: "Files" })).toBeNull();
    expect(writeup.getAttribute("aria-controls")).toBe(screen.getByRole("tabpanel", { name: "Writeup" }).id);
    fireEvent.keyDown(writeup, { key: "ArrowRight" });
    await waitFor(() => expect(history.location.search).toContain("tab=docs"));
    expect(history.location.search).not.toContain("thread");
    expect(history.location.hash).toBe("");
    expect(document.activeElement).toBe(docs);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(docs.id);
    expect(docs.getAttribute("aria-selected")).toBe("true");
    expect(writeup.tabIndex).toBe(-1);
    fireEvent.keyDown(docs, { key: "End" });
    await waitFor(() => expect(history.location.search).toContain("tab=comments"));
    expect(document.activeElement).toBe(comments);
    fireEvent.keyDown(comments, { key: "ArrowRight" });
    await waitFor(() => expect(history.location.search).toContain("tab=writeup"));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(writeup.id);
  },
);

test("a diff search still labels the panel with the first visible reading tab", async () => {
  mount("?tab=diff");
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  expect(screen.getByRole("tab", { name: "Writeup" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel", { name: "Writeup" })).toBeTruthy();
});

test.each(
  [1280, 390].flatMap((pixels) =>
    ["missing", "html"].flatMap((threadKind) =>
      ["files", "map", "map-diff"].map((destination) => ({ pixels, threadKind, destination })),
    ),
  ),
)(
  "$destination navigation discards a $threadKind thread at $pixels px",
  async ({ pixels, threadKind, destination }) => {
    width = pixels;
    const threadId = "22222222-2222-4222-8222-222222222222";
    const htmlThread: ThreadView = {
      id: threadId,
      target: { kind: "html-span", path: "seed.html", quote: "seed", prefix: "", suffix: "" },
      createdOn: 1,
      state: "open",
      comments: [],
      placement: { status: "placed", location: { kind: "html-span", path: "seed.html", start: 0, end: 4 } },
    };
    // Cache the writeup while the thread is loading, so its incoming navigation has not redirected yet.
    if (destination === "map-diff")
      currentRevision.writeup = { sections: [{ key: "overview", label: "Overview", topic: null, blocks: [] }] };
    client.setQueryData(["revision", id, 1], currentRevision);
    await client.invalidateQueries({ queryKey: ["revision", id, 1], refetchType: "none" });
    const reply = Promise.withResolvers<Response>();
    revisionReply = reply.promise;
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history } = mount(`?tab=writeup&rev=1&thread=${threadId}`);
    const link = await screen.findByRole("link", {
      name: destination === "files" ? "Files in diff: Plant a seed" : "Plant a seed",
    });
    const expectedTab = destination !== "map" && pixels < 768 ? "diff" : "writeup";
    const targetId = destination === "map" ? "topic-seed" : "diff-topic-seed";
    const href = new URL((link as HTMLAnchorElement).href);
    expect([...href.searchParams.keys()].sort()).toEqual(["rev", "tab"]);
    expect(href.searchParams.get("tab")).toBe(expectedTab);
    fireEvent.click(link);
    await waitFor(() => expect(history.location.search).not.toContain("thread"));
    await act(async () => {
      reply.resolve(
        Response.json({
          ...currentRevision,
          docs: [
            ...currentRevision.docs,
            { kind: "html", path: "seed.html", contentUrl: "/content/synthetic/seed.html" },
          ],
          threads: threadKind === "html" ? [htmlThread] : [],
        }),
      );
      loaded.resolve();
    });
    await waitFor(() => expect(client.isFetching({ queryKey: ["revision", id, 1] })).toBe(0));
    await waitFor(() => expect(scroll.mock.instances.some((node) => (node as HTMLElement).id === targetId)).toBe(true));
    expect(history.location.hash).toBe(`#${targetId}`);
    expect(history.location.search).toContain(`tab=${expectedTab}`);
    expect(history.location.search).not.toContain("thread");
    expect(client.getQueryData<RevisionView>(["revision", id, 1])?.threads).toHaveLength(threadKind === "html" ? 1 : 0);
  },
);

test.each(["writeup", "docs"].flatMap((tab) => ["Cancel", "Save comment"].map((close) => ({ tab, close }))))(
  "a resumed $tab block draft marks its placed block until $close",
  async ({ tab, close }) => {
    const block: RenderedBlock = {
      id: tab === "docs" ? "doc-12345678-12345678" : "t-seed-body-12345678",
      section: tab === "docs" ? "doc-12345678" : "t-seed-body",
      kind: "paragraph",
      text: "Keep growing",
      html: "<p>Keep growing</p>",
    };
    const otherBlock = {
      ...block,
      id: `${block.section}-23456789`,
      text: "Water regularly",
      html: "<p>Water regularly</p>",
    };
    if (tab === "docs") currentRevision.docs = [{ kind: "markdown", path: "seed.md", blocks: [block, otherBlock] }];
    else
      currentRevision.writeup.sections = [
        { key: "t-seed-body", label: "Details", topic: "seed", blocks: [block, otherBlock] },
      ];
    const { history, container } = mount(`?tab=${tab}`);
    const first = (await screen.findAllByRole("button", { name: "Comment on block" }))[0];
    if (!first) throw new Error("Missing block control");
    fireEvent.click(first);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "Comments 2" }));
    const resume = await screen.findByRole("button", { name: "Resume" });
    // The original id has gone; quote placement must supply the new block id to the reader.
    const placedBlock = { ...block, id: `${block.section}-34567890` };
    if (tab === "docs")
      currentRevision.docs = [{ kind: "markdown", path: "seed.md", blocks: [placedBlock, otherBlock] }];
    else
      currentRevision.writeup.sections = [
        { key: "t-seed-body", label: "Details", topic: "seed", blocks: [placedBlock, otherBlock] },
      ];
    await act(async () => {
      client.setQueryData(["revision", id, 1], structuredClone(currentRevision));
    });
    fireEvent.click(resume);
    const editor = await screen.findByRole("region", { name: "Resumed comment" });
    await waitFor(() => expect(history.location.search).toContain(`tab=${tab}`));
    expect((within(editor).getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(container.querySelectorAll("[data-commenting]")).toHaveLength(1);
    expect(container.querySelector("[data-commenting] [data-block-id]")?.getAttribute("data-block-id")).toBe(
      placedBlock.id,
    );
    fireEvent.click(within(editor).getByRole("button", { name: close }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Resumed comment" })).toBeNull());
    expect(container.querySelector("[data-commenting]")).toBeNull();
  },
);

const docBlock: RenderedBlock = {
  id: "doc-12345678-12345678",
  section: "doc-12345678",
  kind: "paragraph",
  text: "Water the seedlings",
  html: "<p>Water the seedlings</p>",
};
const gardenDoc = {
  kind: "markdown" as const,
  path: "docs/z garden.md",
  blocks: [
    docBlock,
    {
      ...docBlock,
      id: "doc-12345678-23456789",
      kind: "heading" as const,
      text: "Garden plan",
      html: "<h2>Garden plan</h2>",
    },
    {
      ...docBlock,
      id: "doc-12345678-34567890",
      kind: "heading" as const,
      text: "Later heading",
      html: "<h3>Later heading</h3>",
    },
  ],
};
const plainDoc = {
  kind: "markdown" as const,
  path: "docs/a plain.md",
  blocks: [{ ...docBlock, id: "doc-23456789-12345678", text: "Another doc", html: "<p>Another doc</p>" }],
};
const htmlDoc = { kind: "html" as const, path: "docs/seed.html", contentUrl: "/content/synthetic/seed.html" };
const otherHtmlDoc = {
  kind: "html" as const,
  path: "docs/water.html",
  contentUrl: "/content/other-synthetic/water.html",
};
function docsFixture() {
  currentRevision.docs = [gardenDoc, plainDoc, htmlDoc, otherHtmlDoc];
  currentRevision.files = [];
}
function searchParams(history: ReturnType<typeof createMemoryHistory>) {
  return new URLSearchParams(history.location.search);
}
function frameMessage(frame: HTMLIFrameElement, data: unknown, source = frame.contentWindow) {
  fireEvent(window, new MessageEvent("message", { source, data }));
}
function prepareFrame(path: string) {
  const frame = document.querySelector<HTMLIFrameElement>(`iframe[title="${path}"]`);
  if (!frame) throw new Error("Missing synthetic frame");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  fireEvent.load(frame);
  return { frame, post };
}

test("review search keeps contract-valid doc paths and explicitly clears rejected paths", () => {
  expect(validateReviewSearch({ doc: gardenDoc.path }).doc).toBe(gardenDoc.path);
  for (const doc of [undefined, "", 1, ["seed.md"], "../seed.md", "/seed.md", "a\\b.md", "a\0.md", "\ud800"])
    expect(validateReviewSearch({ doc })).toHaveProperty("doc", undefined);
});

test.each([1280, 768, 390])("doc list and open doc navigate, focus and reset scroll at %s px", async (pixels) => {
  width = pixels;
  docsFixture();
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const { history, container } = mount(`?tab=docs&rev=1&thread=${id}#missing-target`);
  await screen.findByRole("heading", { name: "Docs" });
  const panel = within(screen.getByTestId("reading-pane"));
  const list = panel.getByRole("list");
  const names = [
    "Garden plan docs/z garden.md",
    "a plain.md docs/a plain.md",
    "seed.html docs/seed.html",
    "water.html docs/water.html",
  ];
  const links = within(list).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual([
    "Garden plandocs/z garden.md",
    "a plain.mddocs/a plain.md",
    "seed.htmldocs/seed.html",
    "water.htmldocs/water.html",
  ]);
  for (const name of names) expect(within(list).getByRole("link", { name })).toBeTruthy();
  expect(container.querySelector("iframe, [data-block-id]")).toBeNull();
  const href = new URL((links[0] as HTMLAnchorElement).href);
  expect(href.searchParams.get("rev")).toBe("1");
  expect(href.searchParams.get("doc")).toBe(gardenDoc.path);
  expect(href.searchParams.has("thread")).toBe(false);
  expect(href.hash).toBe("");
  const pane = screen.getByTestId("reading-pane");
  pane.scrollTop = 300;
  fireEvent.click(within(list).getByRole("link", { name: names[0] }));
  const heading = await screen.findByRole("heading", { name: gardenDoc.path });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(heading.getAttribute("title")).toBe(gardenDoc.path);
  expect(pane.scrollTop).toBe(0);
  expect(searchParams(history).get("doc")).toBe(gardenDoc.path);
  expect(container.querySelectorAll("[data-block-id]")).toHaveLength(3);
  expect(container.querySelector("iframe")).toBeNull();
  expect(screen.queryByText("Another doc")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "All docs" }));
  const row = await screen.findByRole("link", { name: names[0] });
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(scroll.mock.instances).toContain(row);
  expect(searchParams(history).get("doc")).toBeNull();
  expect(searchParams(history).get("rev")).toBe("1");
  fireEvent.click(screen.getByRole("link", { name: names[2] }));
  await screen.findByRole("heading", { name: htmlDoc.path });
  expect(container.querySelectorAll("iframe")).toHaveLength(1);
  expect(container.querySelector("[data-block-id]")).toBeNull();
  expect(screen.getByText("Shown in a sandbox. Scripts in this doc never run.")).toBeTruthy();
  act(() => history.back());
  const htmlRow = await screen.findByRole("link", { name: names[2] });
  await waitFor(() => expect(document.activeElement).toBe(htmlRow));
  expect(scroll.mock.instances).toContain(htmlRow);
  act(() => history.forward());
  const returnedHeading = await screen.findByRole("heading", { name: htmlDoc.path });
  await waitFor(() => expect(document.activeElement).toBe(returnedHeading));
  fireEvent.click(screen.getByRole("link", { name: "All docs" }));
  await screen.findByRole("link", { name: names[2] });
  act(() => history.back());
  await screen.findByRole("heading", { name: htmlDoc.path });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: htmlDoc.path })));
});

test.each([gardenDoc, htmlDoc])("a sole $kind doc opens directly without All docs", async (doc) => {
  docsFixture();
  currentRevision.docs = [doc];
  const { history } = mount("?tab=docs");
  await screen.findByRole("heading", { name: doc.path });
  await waitFor(() => expect(searchParams(history).get("doc")).toBe(doc.path));
  expect(screen.queryByRole("heading", { name: "Docs" })).toBeNull();
  expect(screen.queryByRole("link", { name: "All docs" })).toBeNull();
});

test.each(["block", "heading", "doc", "html-doc", "doc-thread", "html-thread"])(
  "a %s target resolves and canonicalizes its doc",
  async (kind) => {
    docsFixture();
    const html = kind.startsWith("html");
    const path = html ? htmlDoc.path : gardenDoc.path;
    let elementId =
      kind === "block"
        ? `block-${docBlock.id}`
        : kind === "heading"
          ? `block-${gardenDoc.blocks[1]?.id}`
          : `${kind}-${path}`;
    if (kind.endsWith("thread")) {
      elementId = `thread-${id}`;
      currentRevision.threads = [
        {
          id,
          createdOn: 1,
          state: "open",
          comments: [],
          target: html
            ? { kind: "html-span", path, quote: "seed", prefix: "", suffix: "" }
            : { kind: "doc-span", path, blockId: docBlock.id, quote: docBlock.text, prefix: "", suffix: "" },
          placement: {
            status: "placed",
            location: html
              ? { kind: "html-span", path, start: 0, end: 4 }
              : { kind: "doc-span", path, blockId: docBlock.id, start: 0, end: docBlock.text.length },
          },
        },
      ];
    }
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history } = mount(`?tab=docs#${elementId}`);
    await screen.findByRole("heading", { name: path });
    await waitFor(() => expect(searchParams(history).get("doc")).toBe(path));
    await waitFor(() => expect(scroll.mock.instances).toContain(document.getElementById(elementId)));
    expect(history.length).toBe(1);
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: path }));
  },
);

test.each(["doc-span", "html-span"] as const)(
  "resuming a %s draft opens its doc and reaches the target",
  async (kind) => {
    docsFixture();
    const path = kind === "doc-span" ? gardenDoc.path : htmlDoc.path;
    const target =
      kind === "doc-span"
        ? { kind, path, blockId: docBlock.id, quote: docBlock.text, prefix: "", suffix: "" }
        : { kind, path, quote: "seed", prefix: "", suffix: "" };
    localStorage.setItem(draftKey(id, target), "Water carefully");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { history } = mount("?tab=comments&doc=docs%2Fa%20plain.md");
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await screen.findByRole("heading", { name: path });
    expect(searchParams(history).get("doc")).toBe(path);
    const elementId = kind === "doc-span" ? `block-${docBlock.id}` : `html-doc-${path}`;
    await waitFor(() => expect(scroll.mock.instances).toContain(document.getElementById(elementId)));
    const editor = within(screen.getByRole("region", { name: "Resumed comment" })).getByLabelText(
      "Comment",
    ) as HTMLTextAreaElement;
    expect(editor.value).toBe("Water carefully");
    expect(document.activeElement).toBe(editor);
  },
);

test("a resumed Markdown editor leaves All docs and row navigation free to move focus", async () => {
  docsFixture();
  localStorage.setItem(
    draftKey(id, {
      kind: "doc-span",
      path: gardenDoc.path,
      blockId: docBlock.id,
      quote: docBlock.text,
      prefix: "",
      suffix: "",
    }),
    "Keep this editor open",
  );
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mount("?tab=comments");
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  const region = await screen.findByRole("region", { name: "Resumed comment" });
  const editor = within(region).getByLabelText("Comment") as HTMLTextAreaElement;
  expect(editor.value).toBe("Keep this editor open");
  expect(document.activeElement).toBe(editor);

  fireEvent.click(screen.getByRole("link", { name: "All docs" }));
  const row = await screen.findByRole("link", { name: "Garden plan docs/z garden.md" });
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(scroll.mock.instances).toContain(row);
  expect(within(screen.getByRole("region", { name: "Resumed comment" })).getByLabelText("Comment")).toBe(editor);

  fireEvent.click(screen.getByRole("link", { name: "a plain.md docs/a plain.md" }));
  const heading = await screen.findByRole("heading", { name: plainDoc.path });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(within(screen.getByRole("region", { name: "Resumed comment" })).getByLabelText("Comment")).toBe(editor);
  expect(editor.value).toBe("Keep this editor open");
});

test("an unknown doc with no other target shows the list and drops the stale path", async () => {
  docsFixture();
  const { history, container } = mount("?tab=docs&doc=absent.md");
  await screen.findByRole("link", { name: "Garden plan docs/z garden.md" });
  await waitFor(() => expect(searchParams(history).has("doc")).toBe(false));
  expect(container.querySelector("iframe, [data-block-id]")).toBeNull();
  expect(history.length).toBe(1);
});

test("an unknown doc falls through to a block target and replaces the stale path", async () => {
  docsFixture();
  const { history } = mount(`?tab=docs&doc=absent.md#block-${docBlock.id}`);
  await screen.findByRole("heading", { name: gardenDoc.path });
  await waitFor(() => expect(searchParams(history).get("doc")).toBe(gardenDoc.path));
  expect(history.location.hash).toBe(`#block-${docBlock.id}`);
  expect(history.length).toBe(1);
});

test("an explicit doc takes precedence over a different doc's reading target", async () => {
  docsFixture();
  mount(`?tab=docs&doc=${encodeURIComponent(plainDoc.path)}#block-${docBlock.id}`);
  await screen.findByRole("heading", { name: plainDoc.path });
  expect(screen.queryByText("Water the seedlings")).toBeNull();
});

test("opening several docs with an empty writeup opens the first doc and writes its URL", async () => {
  docsFixture();
  currentRevision.main = null;
  currentRevision.writeupEmpty = true;
  currentRevision.writeup = { sections: [] };
  const { history } = mount("?doc=absent.md");
  await screen.findByRole("heading", { name: gardenDoc.path });
  await waitFor(() => expect(searchParams(history).get("doc")).toBe(gardenDoc.path));
  expect(searchParams(history).has("tab")).toBe(false);
  expect(history.length).toBe(1);
});

test("doc selection survives tabs and revision changes without moving focus on refetch", async () => {
  docsFixture();
  currentReview.revisions.push({ seq: 2, createdAt: "2026-01-02T00:00:00.000Z" });
  currentReview.newestRevision = 2;
  const { history } = mount(`?rev=1&tab=docs&doc=${encodeURIComponent(plainDoc.path)}`);
  await screen.findByRole("heading", { name: plainDoc.path });
  fireEvent.click(screen.getByRole("tab", { name: "Writeup" }));
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  expect(searchParams(history).get("doc")).toBe(plainDoc.path);
  fireEvent.click(screen.getByRole("tab", { name: "Docs 4" }));
  await screen.findByRole("heading", { name: plainDoc.path });
  fireEvent.keyDown(screen.getByRole("button", { name: /^Revision 1/ }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Revision 2/ }));
  await waitFor(() => expect(searchParams(history).get("rev")).toBe("2"));
  const heading = await screen.findByRole("heading", { name: plainDoc.path });
  expect(searchParams(history).get("doc")).toBe(plainDoc.path);
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  screen.getByTestId("reading-pane").scrollTop = 180;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["revision", id, 2] });
  });
  expect(document.activeElement).toBe(instructions);
  expect(screen.getByTestId("reading-pane").scrollTop).toBe(180);
  expect(screen.getByRole("heading", { name: plainDoc.path })).toBe(heading);
});

test("doc block links encode the path alongside the Docs tab", () => {
  const url = new URL(blockLink(id, 2, docBlock.id, gardenDoc.path), "http://localhost");
  expect(url.searchParams.get("doc")).toBe(gardenDoc.path);
  expect(url.searchParams.get("tab")).toBe("docs");
  expect(url.hash).toBe(`#block-${docBlock.id}`);
});

test("HTML doc messages navigate with history and fragment hand-off, and old windows lose authority", async () => {
  docsFixture();
  const { history, container } = mount(`?tab=docs&rev=1&doc=${encodeURIComponent(htmlDoc.path)}`);
  await screen.findByRole("heading", { name: htmlDoc.path });
  const { frame: first } = prepareFrame(htmlDoc.path);
  const fragment = "part é%#";
  frameMessage(first, { type: "emend:navigate", path: otherHtmlDoc.path, fragment });
  const nextHeading = await screen.findByRole("heading", { name: otherHtmlDoc.path });
  await waitFor(() => expect(document.activeElement).toBe(nextHeading));
  await waitFor(() =>
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      `${otherHtmlDoc.contentUrl}#${encodeURIComponent(fragment)}`,
    ),
  );
  expect(container.querySelectorAll("iframe")).toHaveLength(1);
  expect(first.isConnected).toBe(false);
  expect(searchParams(history).get("doc")).toBe(otherHtmlDoc.path);
  expect(searchParams(history).get("rev")).toBe("1");
  expect(history.length).toBe(2);
  const { frame: second } = prepareFrame(otherHtmlDoc.path);
  frameMessage(first, { type: "emend:navigate", path: gardenDoc.path, fragment: "" });
  frameMessage(first, { type: "emend:anchor", quote: "seed", prefix: "", suffix: "" });
  expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
  expect(searchParams(history).get("doc")).toBe(otherHtmlDoc.path);
  act(() => history.back());
  await screen.findByRole("heading", { name: htmlDoc.path });
  expect(container.querySelectorAll("iframe")).toHaveLength(1);
  expect(second.isConnected).toBe(false);
  const { frame: returned } = prepareFrame(htmlDoc.path);
  frameMessage(returned, { type: "emend:navigate", path: gardenDoc.path, fragment: "heading" });
  await screen.findByRole("heading", { name: gardenDoc.path });
  expect(container.querySelector("iframe")).toBeNull();
});

test("HTML navigation rejects foreign windows, other revisions, malformed messages and departed frames", async () => {
  docsFixture();
  const { history, container } = mount(`?tab=docs&doc=${encodeURIComponent(htmlDoc.path)}`);
  await screen.findByRole("heading", { name: htmlDoc.path });
  const { frame } = prepareFrame(htmlDoc.path);
  const valid = { type: "emend:navigate", path: otherHtmlDoc.path, fragment: "seed" };
  frameMessage(frame, valid, window);
  for (const data of [
    { ...valid, path: "previous-revision.html" },
    { ...valid, path: "docs/asset.svg" },
    { ...valid, path: htmlDoc.path },
    { ...valid, fragment: "x".repeat(1025) },
    { ...valid, fragment: "\ud800" },
    { ...valid, extra: true },
  ])
    frameMessage(frame, data);
  fireEvent.load(frame);
  frameMessage(frame, valid);
  expect(screen.getByText("This doc navigated away.")).toBeTruthy();
  expect(history.length).toBe(1);
  expect(searchParams(history).get("doc")).toBe(htmlDoc.path);
  expect(container.querySelectorAll("iframe")).toHaveLength(1);
});

test("hostile doc titles and paths stay text in the list and doc bar", async () => {
  docsFixture();
  const hostile = '<img onerror="evil()"><svg onload="evil()">';
  const path = `docs/${hostile}.md`;
  const heading = { ...docBlock, kind: "heading" as const, text: hostile, html: "<h2>Safe synthetic heading</h2>" };
  currentRevision.docs = [{ kind: "markdown", path, blocks: [heading] }, htmlDoc];
  const { container } = mount("?tab=docs");
  fireEvent.click(await screen.findByRole("link", { name: `${hostile} ${path}` }));
  const bar = await screen.findByRole("heading", { name: path });
  expect(bar.textContent).toBe(path);
  expect(bar.getAttribute("title")).toBe(path);
  expect(container.querySelector("script, [onerror], [onload], a[href^='javascript:']")).toBeNull();
});

test("an unknown doc falls through to an HTML thread target", async () => {
  docsFixture();
  currentRevision.threads = [
    {
      id,
      createdOn: 1,
      state: "open",
      comments: [],
      target: { kind: "html-span", path: htmlDoc.path, quote: "seed", prefix: "", suffix: "" },
      placement: { status: "placed", location: { kind: "html-span", path: htmlDoc.path, start: 0, end: 4 } },
    },
  ];
  const { history, container } = mount(`?tab=docs&doc=absent.html#thread-${id}`);
  await screen.findByRole("heading", { name: htmlDoc.path });
  await waitFor(() => expect(searchParams(history).get("doc")).toBe(htmlDoc.path));
  expect(container.querySelector("iframe")?.title).toBe(htmlDoc.path);
  expect(history.location.hash).toBe(`#thread-${id}`);
  expect(history.length).toBe(1);
});

test("an unplaced Markdown draft still opens its doc", async () => {
  docsFixture();
  localStorage.setItem(
    draftKey(id, {
      kind: "doc-span",
      path: gardenDoc.path,
      blockId: "doc-12345678-87654321",
      quote: "Removed sentence",
      prefix: "",
      suffix: "",
    }),
    "Keep my draft",
  );
  const { history } = mount("?tab=comments");
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await screen.findByRole("heading", { name: gardenDoc.path });
  expect(searchParams(history).get("doc")).toBe(gardenDoc.path);
  expect(screen.getByRole("region", { name: "Resumed comment" })).toBeTruthy();
});

test("a revision without the open doc drops its stale URL path", async () => {
  docsFixture();
  currentReview.revisions.push({ seq: 2, createdAt: "2026-01-02T00:00:00.000Z" });
  const { history } = mount(`?rev=1&tab=docs&doc=${encodeURIComponent(plainDoc.path)}`);
  await screen.findByRole("heading", { name: plainDoc.path });
  currentRevision.docs = [gardenDoc, htmlDoc];
  fireEvent.keyDown(screen.getByRole("button", { name: /^Revision 1/ }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Revision 2/ }));
  await screen.findByRole("link", { name: "Garden plan docs/z garden.md" });
  await waitFor(() => expect(searchParams(history).has("doc")).toBe(false));
  expect(searchParams(history).get("tab")).toBe("docs");
  expect(searchParams(history).get("rev")).toBe("2");
  expect(history.length).toBe(2);
});

test.each(["block", "doc-thread", "html-thread"])("a Comments URL with a %s hash stays on Comments", async (kind) => {
  docsFixture();
  const html = kind === "html-thread";
  const path = html ? htmlDoc.path : gardenDoc.path;
  currentRevision.threads = [
    {
      id,
      createdOn: 1,
      state: "open",
      comments: [],
      target: html
        ? { kind: "html-span", path, quote: "seed", prefix: "", suffix: "" }
        : { kind: "doc-span", path, blockId: docBlock.id, quote: docBlock.text, prefix: "", suffix: "" },
      placement: {
        status: "placed",
        location: html
          ? { kind: "html-span", path, start: 0, end: 4 }
          : { kind: "doc-span", path, blockId: docBlock.id, start: 0, end: docBlock.text.length },
      },
    },
  ];
  const hash = kind === "block" ? `block-${docBlock.id}` : `thread-${id}`;
  const { history, container } = mount(`?tab=comments#${hash}`);
  await screen.findByRole("tabpanel", { name: "Comments 2" });
  await screen.findByLabelText("Reply");
  expect(searchParams(history).get("tab")).toBe("comments");
  expect(searchParams(history).has("doc")).toBe(false);
  expect(history.location.hash).toBe(`#${hash}`);
  expect(container.querySelector("iframe, [data-block-id]")).toBeNull();
});

test.each([gardenDoc, htmlDoc])("a direct $kind doc load does not take heading focus", async (doc) => {
  docsFixture();
  const { history } = mount(`?tab=docs&doc=${encodeURIComponent(doc.path)}`);
  const heading = await screen.findByRole("heading", { name: doc.path });
  expect(document.activeElement).not.toBe(heading);
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(document.activeElement).not.toBe(heading);
  expect(searchParams(history).get("doc")).toBe(doc.path);
});

test("switching from Writeup to Docs keeps focus on the tab", async () => {
  docsFixture();
  mount(`?tab=writeup&doc=${encodeURIComponent(gardenDoc.path)}`);
  const writeup = await screen.findByRole("tab", { name: "Writeup" });
  await screen.findByRole("heading", { name: "Topic 1: Plant a seed" });
  fireEvent.keyDown(writeup, { key: "ArrowRight" });
  await screen.findByRole("heading", { name: gardenDoc.path });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Docs 4" }));
});

test("a target inside the shown Docs tab does not take heading focus", async () => {
  docsFixture();
  const { history } = mount("?tab=docs");
  await screen.findByRole("link", { name: "Garden plan docs/z garden.md" });
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  act(() => history.push(`/r/${id}?tab=docs#block-${docBlock.id}`));
  await screen.findByRole("heading", { name: gardenDoc.path });
  await waitFor(() => expect(searchParams(history).get("doc")).toBe(gardenDoc.path));
  expect(document.activeElement).toBe(instructions);
});

test("a data refresh that opens a sole doc does not take heading focus", async () => {
  docsFixture();
  mount("?tab=docs");
  await screen.findByRole("link", { name: "Garden plan docs/z garden.md" });
  const instructions = screen.getByLabelText("Instructions");
  act(() => instructions.focus());
  await act(async () => {
    client.setQueryData(["revision", id, 1], { ...currentRevision, docs: [plainDoc] });
  });
  await screen.findByRole("heading", { name: plainDoc.path });
  expect(document.activeElement).toBe(instructions);
});

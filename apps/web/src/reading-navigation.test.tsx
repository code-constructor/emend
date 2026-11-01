// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import type { RenderedBlock, ReviewView, RevisionView, ThreadView } from "@emend/contract";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import type { DiffPaneProps } from "./components/diff/DiffPane.tsx";

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
let revisionReply: Promise<Response> | undefined;
let width = 1280;
let client: QueryClient;
let loaded: ReturnType<typeof Promise.withResolvers<void>>;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  width = 1280;
  currentRevision = structuredClone(revision);
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
      if (path === `/api/v1/reviews/${id}`) return Response.json(review);
      if (path === `/api/v1/reviews/${id}/revisions/1`) return revisionReply ?? Response.json(currentRevision);
      throw new Error(`Unexpected synthetic request: ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
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

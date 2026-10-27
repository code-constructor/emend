import type { FileView, RevisionView } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { draftKey } from "../../lib/drafts.ts";
import { Panes } from "../layout/Panes.tsx";
import { DiffPane } from "./DiffPane.tsx";
import { parsePair } from "./parse.worker.ts";
import type { DiffParser } from "./parse-client.ts";

type Selection = { side?: "additions" | "deletions"; endSide?: "additions" | "deletions"; start: number; end: number };
type Annotation = { side: string; lineNumber: number; metadata: ReactNode };
type RenderProps = {
  options: { diffStyle: string; onLineSelectionEnd: (range: Selection | null) => void };
  lineAnnotations: Annotation[];
  renderAnnotation: (annotation: Annotation) => ReactNode;
};
const renderer = vi.hoisted(() => ({ props: [] as RenderProps[] }));
vi.mock("@pierre/diffs/react", () => ({
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => children,
  FileDiff: (props: RenderProps) => {
    renderer.props.push(props);
    return (
      <div data-testid="rendered-diff" data-style={props.options.diffStyle}>
        {props.lineAnnotations?.map((annotation) => (
          <div
            key={`${annotation.side}:${annotation.lineNumber}`}
            data-side={annotation.side}
            data-line={annotation.lineNumber}
          >
            {props.renderAnnotation(annotation)}
          </div>
        ))}
      </div>
    );
  },
}));
const reviewId = "11111111-1111-4111-8111-111111111111";
const file = (path = "source.ts", values: Partial<FileView> = {}): FileView => ({
  id: crypto.randomUUID(),
  path,
  oldPath: null,
  role: "diff",
  status: "modified",
  topic: "first",
  order: 0,
  mediaType: "text/plain",
  flag: null,
  hasOld: true,
  hasNew: true,
  ...values,
});
const revision = (files: FileView[], values: Partial<RevisionView> = {}): RevisionView => ({
  seq: 2,
  base: null,
  head: null,
  topics: [{ slug: "first", title: "First", importance: 10, summary: "Synthetic summary" }],
  files,
  threads: [],
  docs: [],
  writeup: { sections: [] },
  changedBlocks: [],
  ...values,
});
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let parser: ReturnType<typeof vi.fn<DiffParser>>;
let observers: {
  element: Element;
  options?: IntersectionObserverInit;
  callback: (entries: Partial<IntersectionObserverEntry>[]) => void;
}[];
function near(path: string, value = true) {
  const section = screen.getByRole("region", { name: `File ${path}` });
  const observer = observers.find((o) => o.element === section);
  expect(observer).toBeDefined();
  act(() => observer?.callback([{ isIntersecting: value, target: section }]));
}
async function mount(view: RevisionView) {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Panes
          inbox={null}
          header={null}
          reading={null}
          phoneTabs={null}
          collapsed
          tab="diff"
          diff={<DiffPane reviewId={reviewId} revision={view} parser={parser} />}
        />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const result = render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Diff" });
  return result;
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  observers = [];
  renderer.props = [];
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        private callback: (entries: Partial<IntersectionObserverEntry>[]) => void,
        private options?: IntersectionObserverInit,
      ) {}
      observe(element: Element) {
        observers.push({ element, options: this.options, callback: this.callback });
      }
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)",
    addEventListener() {},
    removeEventListener() {},
  }));
  fetchMock = vi.fn(async (_path: string, init?: RequestInit) =>
    init?.method === "POST" ? Response.json({}, { status: 201 }) : new Response("one\ntwo\nthree\n"),
  );
  vi.stubGlobal("fetch", fetchMock);
  parser = vi.fn<DiffParser>(parsePair);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("topics sort ascending stably, Other last, files by order, empty headers and metadata are text", async () => {
  const files = [
    file("later.ts", { order: 8 }),
    file("earlier.ts", { order: 1 }),
    file("unknown.ts", { topic: "missing" }),
    file("null.ts", { topic: null }),
    file("doc.md", { role: "doc" }),
    file("asset.png", { role: "asset" }),
  ];
  await mount(
    revision(files, {
      topics: [
        { slug: "low", title: "Low", importance: 1, summary: "" },
        { slug: "other", title: "Other changes", importance: 100, summary: "" },
        {
          slug: "first",
          title: "First",
          importance: 10,
          summary: "<img src=x onerror=alert(1)>",
          door: "one-way",
          blastRadius: { scope: "local", note: "A synthetic note" },
        },
        { slug: "tie", title: "Tie", importance: 10, summary: "", door: "two-way" },
      ],
    }),
  );
  expect(screen.getAllByRole("heading", { level: 3 }).map((e) => e.textContent)).toEqual([
    "Low",
    "First",
    "Tie",
    "Other changes",
  ]);
  expect(screen.getAllByRole("heading", { level: 4 }).map((e) => e.textContent)).toEqual([
    "earlier.ts",
    "later.ts",
    "unknown.ts",
    "null.ts",
  ]);
  for (const text of [
    "One-way door",
    "Two-way door",
    "Blast radius: local",
    "A synthetic note",
    "<img src=x onerror=alert(1)>",
  ])
    expect(screen.getByText(text)).toBeTruthy();
  expect(document.querySelector("img")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
test("flagged files never fetch and renamed paths and status stay visible", async () => {
  await mount(
    revision([
      file("binary", { flag: "binary" }),
      file("big", { flag: "oversized" }),
      file("new.ts", { oldPath: "old.ts", status: "renamed" }),
    ]),
  );
  near("binary");
  near("big");
  expect(screen.getByText("Not shown: binary file")).toBeTruthy();
  expect(screen.getByText("Not shown: larger than 1 MiB")).toBeTruthy();
  expect(screen.getByText("Renamed from old.ts")).toBeTruthy();
  expect(screen.getByText("renamed")).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(parser).not.toHaveBeenCalled();
});
test("near sections alone load, immutable sides cache across remount and absent sides are skipped", async () => {
  const added = file("added.ts", { hasOld: false, status: "added" });
  const view = revision([added, file("far.ts")]);
  const mounted = await mount(view);
  expect(parser).not.toHaveBeenCalled();
  near("added.ts");
  await screen.findByTestId("rendered-diff");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/files/${added.id}/new`);
  expect(client.getQueryData(["file", added.id, "new"])).toBe("one\ntwo\nthree\n");
  expect(parser.mock.calls[0]?.[0]).toMatchObject({ oldFile: null, newFile: { name: "added.ts" } });
  near("added.ts", false);
  expect(screen.queryByTestId("rendered-diff")).toBeNull();
  mounted.unmount();
  await mount(view);
  near("added.ts");
  await screen.findByTestId("rendered-diff");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
test.each([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "pubspec.lock",
  "mix.lock",
  "Podfile.lock",
])("lockfile %s waits for Show diff", async (name) => {
  await mount(revision([file(`nested/${name}`)]));
  near(`nested/${name}`);
  expect(await screen.findByText("Collapsed: lockfile")).toBeTruthy();
  expect(parser).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Comment on file" }));
  expect(screen.getByLabelText("Comment")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show diff" }));
  await screen.findByTestId("rendered-diff");
  expect(parser).toHaveBeenCalledTimes(1);
});
test("over 20000 combined lines collapses after fetch and before parse", async () => {
  fetchMock.mockResolvedValue(new Response("x\n".repeat(10001)));
  // Responses are consumed once, including when both sides share bytes.
  fetchMock.mockImplementation(async () => new Response("x\n".repeat(10001)));
  await mount(revision([file()]));
  near("source.ts");
  expect(await screen.findByText("Collapsed: 20002 lines")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(parser).not.toHaveBeenCalled();
  parser.mockImplementation(() => parsePair({ oldFile: null, newFile: { name: "source.ts", contents: "x\n" } }));
  fireEvent.click(screen.getByRole("button", { name: "Show diff" }));
  await screen.findByTestId("rendered-diff");
  expect(parser).toHaveBeenCalledTimes(1);
});
test("file and topic buttons save their targets and reopening preserves one draft", async () => {
  await mount(revision([file("source.ts", { flag: "binary" })]));
  for (const [name, target] of [
    ["Comment on topic", { kind: "topic", slug: "first" }],
    ["Comment on file", { kind: "file", path: "source.ts" }],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name }));
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getAllByLabelText("Comment")).toHaveLength(1);
    expect(localStorage.getItem(draftKey(reviewId, target))).toBe(name);
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/reviews/${reviewId}/threads`,
        expect.objectContaining({ body: JSON.stringify({ revision: 2, target, body: name }) }),
      ),
    );
    await waitFor(() => expect(screen.queryByLabelText("Comment")).toBeNull());
  }
});
test("selection maps deletions/additions, refuses mixed sides, and shows range errors", async () => {
  fetchMock.mockImplementation(async () => new Response("x\n".repeat(1100)));
  await mount(revision([file("source.ts", { oldPath: "old.ts" })]));
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  const select = (range: Selection | null) => act(() => renderer.props.at(-1)?.options.onLineSelectionEnd(range));
  select({ side: "additions", start: 10, end: 12 });
  expect(screen.getByText("Lines 10–12, new side")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "New selection" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => init?.body?.toString().includes('"side":"new"'))).toBe(true),
  );
  select({ side: "deletions", start: 12, end: 10 });
  expect(screen.getByText("Lines 10–12, old side")).toBeTruthy();
  select({ side: "deletions", endSide: "additions", start: 1, end: 2 });
  expect(screen.getByRole("alert").textContent).toBe("Select lines on one side.");
  expect(screen.queryByLabelText("Comment")).toBeNull();
  select({ side: "additions", start: 1, end: 1001 });
  expect(screen.getByRole("alert").textContent).toBe("Select at most 1000 lines.");
});
test.each([
  [false, "unified"],
  [true, "split"],
])("layout tablet=%s renders %s", async (tablet, style) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: tablet && query === "(min-width: 768px)",
    addEventListener() {},
    removeEventListener() {},
  }));
  await mount(revision([file()]));
  near("source.ts");
  expect((await screen.findByTestId("rendered-diff")).getAttribute("data-style")).toBe(style);
});

test("a failed side can retry without reloading the successful side", async () => {
  const source = file();
  let failed = true;
  fetchMock.mockImplementation(async (path: string) =>
    path.endsWith("/old") && failed
      ? Response.json({ error: { code: "not_found", message: "Missing" } }, { status: 404 })
      : new Response("one\ntwo\n"),
  );
  await mount(revision([source]));
  near("source.ts");
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(parser).not.toHaveBeenCalled();
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByTestId("rendered-diff");
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith("/new"))).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith("/old"))).toHaveLength(2);
});
test("long selected text shows the exact refusal and never opens a clipped draft", async () => {
  fetchMock.mockImplementation(async () => new Response("x".repeat(65537)));
  await mount(revision([file()]));
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  act(() => renderer.props.at(-1)?.options.onLineSelectionEnd({ side: "additions", start: 1, end: 1 }));
  expect(screen.getByRole("alert").textContent).toBe("This selection is too long. Select fewer lines.");
  expect(screen.queryByLabelText("Comment")).toBeNull();
});
test("leaving the viewport cancels parsing and re-entry can complete", async () => {
  let signal: AbortSignal | undefined;
  parser.mockImplementationOnce((_pair, abort?: AbortSignal) => {
    signal = abort;
    return new Promise((_resolve, reject) =>
      abort?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }),
    );
  });
  await mount(revision([file()]));
  near("source.ts");
  await waitFor(() => expect(parser).toHaveBeenCalledTimes(1));
  near("source.ts", false);
  expect(signal?.aborted).toBe(true);
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("an open line editor pins its file beyond the viewport margin", async () => {
  await mount(revision([file()]));
  near("source.ts");
  await screen.findByTestId("rendered-diff");
  act(() => renderer.props.at(-1)?.options.onLineSelectionEnd({ side: "additions", start: 1, end: 2 }));
  const input = screen.getByLabelText("Comment");
  input.focus();
  fireEvent.change(input, { target: { value: "Keep focus" } });
  near("source.ts", false);
  expect(screen.getByTestId("rendered-diff")).toBeTruthy();
  expect(screen.getByLabelText("Comment")).toBe(input);
  expect(document.activeElement).toBe(input);
});
test.each([false, true])("viewport margin is relative to the scrolling diff pane (split=%s)", async (split) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: split && query === "(min-width: 768px)",
    addEventListener() {},
    removeEventListener() {},
  }));
  await mount(revision([file("above.ts"), file("far.ts")]));
  const pane = screen.getByTestId("diff-pane");
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 400));
  for (const [name, top] of [
    ["above.ts", 32],
    ["far.ts", -1000],
  ] as const) {
    const section = screen.getByRole("region", { name: `File ${name}` });
    vi.spyOn(section, "getBoundingClientRect").mockReturnValue(new DOMRect(0, top, 500, 20));
    const observer = observers.find((entry) => entry.element === section);
    expect(observer?.options?.root).toBe(pane);
    expect(observer?.options?.rootMargin).toBe("800px");
    // Model intersection using the configured root and margin; Happy DOM has no layout engine.
    const root = observer?.options?.root;
    if (!(root instanceof Element)) throw new Error("Expected the pane as observer root");
    const bounds = root.getBoundingClientRect();
    const margin = Number.parseInt(observer?.options?.rootMargin ?? "0", 10);
    const rect = section.getBoundingClientRect();
    act(() =>
      observer?.callback([
        { target: section, isIntersecting: rect.bottom >= bounds.top - margin && rect.top <= bounds.bottom + margin },
      ]),
    );
  }
  await screen.findByTestId("rendered-diff");
  expect(parser).toHaveBeenCalledTimes(1);
  expect(parser.mock.calls[0]?.[0].newFile?.name).toBe("above.ts");
});

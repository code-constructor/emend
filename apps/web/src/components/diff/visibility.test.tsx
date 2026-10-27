import type { FileView, RevisionView, Target, ThreadView } from "@emend/contract";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DiffPane } from "./DiffPane.tsx";
import { parsePair } from "./parse.worker.ts";

// Keep the actual renderer. Worker transport is exercised separately against the built worker.
vi.mock("@pierre/diffs/react", async (original) => ({
  ...(await original<object>()),
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => children,
}));
const reviewId = "11111111-1111-4111-8111-111111111111";
const file = (values: Partial<FileView> = {}): FileView => ({
  id: crypto.randomUUID(),
  path: "new.txt",
  oldPath: "old.txt",
  role: "diff",
  status: "renamed",
  topic: "topic",
  order: 0,
  mediaType: "text/plain",
  flag: null,
  hasOld: true,
  hasNew: true,
  ...values,
});
const target: Target = {
  kind: "lines",
  path: "new.txt",
  side: "new",
  start: 2,
  end: 2,
  lines: ["two"],
  before: ["one"],
  after: [],
};
const thread = (body: string, value: Extract<Target, { kind: "lines" | "file" | "topic" }> = target): ThreadView => ({
  id: crypto.randomUUID(),
  target: value,
  placement: { status: "placed", location: value },
  state: "open",
  createdOn: 1,
  comments: [{ id: crypto.randomUUID(), author: "user", body, sent: false, sentOn: null }],
});
const revision = (files: FileView[], threads: ThreadView[], title = "Topic"): RevisionView => ({
  seq: 1,
  base: null,
  head: null,
  files,
  threads,
  topics: [{ slug: "topic", title, summary: "", importance: 1 }],
  writeup: { sections: [] },
  docs: [],
  changedBlocks: [],
});
let client: QueryClient;
let callbacks: Map<Element, (entries: Partial<IntersectionObserverEntry>[]) => void>;
let fetchMock: ReturnType<typeof vi.fn>;
function Pane() {
  const { data } = useQuery<RevisionView>({ queryKey: ["test-revision"], staleTime: Infinity });
  return data && <DiffPane reviewId={reviewId} revision={data} parser={parsePair} />;
}
async function mount(value: RevisionView) {
  client.setQueryData(["test-revision"], value);
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Pane />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Diff" });
}
function near(path: string, value = true) {
  const section = screen.getByRole("region", { name: `File ${path}` });
  act(() => callbacks.get(section)?.([{ isIntersecting: value, target: section }]));
}
beforeEach(() => {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  callbacks = new Map();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
      observe(element: Element) {
        callbacks.set(element, this.callback);
      }
      disconnect() {}
    },
  );
  fetchMock = vi.fn(async () => new Response("one\ntwo\n"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test.each([false, true])("identical rename preserves line thread under the header (split=%s)", async (split) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: split && query === "(min-width: 768px)",
    addEventListener() {},
    removeEventListener() {},
  }));
  await mount(revision([file()], [thread("Rename comment")]));
  near("new.txt");
  await waitFor(() => expect(document.querySelector("diffs-container")).toBeTruthy());
  const header = screen.getByText("Rename comment").closest("[data-file-header]");
  expect(header).toBeTruthy();
  expect(within(header as HTMLElement).getByText("Line 2, new side")).toBeTruthy();
  expect(screen.getAllByText("Rename comment")).toHaveLength(1);
});
test.each([{ path: "pnpm-lock.yaml" }, { path: "binary.txt", flag: "binary" as const }])(
  "collapsed/flagged $path preserves line comments",
  async (values) => {
    await mount(revision([file(values)], [thread("Hidden diff comment", { ...target, path: values.path })]));
    near(values.path);
    expect(screen.getByText("Hidden diff comment").closest("[data-file-header]")).toBeTruthy();
    expect(screen.getByText("Line 2, new side")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
test("placed threads with missing sections join the top list with target labels", async () => {
  const targets: Extract<Target, { kind: "lines" | "file" | "topic" }>[] = [
    { kind: "file", path: "gone.txt" },
    { kind: "topic", slug: "gone" },
    { ...target, path: "gone.txt" },
  ];
  await mount(
    revision(
      [],
      targets.map((target, i) => thread(`Missing ${i}`, target)),
    ),
  );
  const list = within(screen.getByRole("region", { name: "Unplaced comments" }));
  for (let i = 0; i < 3; i++) expect(list.getByText(`Missing ${i}`)).toBeTruthy();
  expect(list.getByText("File gone.txt")).toBeTruthy();
  expect(list.getByText("Topic gone")).toBeTruthy();
  expect(list.getByText("gone.txt: Line 2, new side")).toBeTruthy();
});
test("header threads and unplaced threads retain their visible locations", async () => {
  const unplaced = thread("Unplaced line comment");
  unplaced.placement = { status: "unplaced", reason: "lines-gone" };
  await mount(
    revision(
      [file()],
      [
        thread("File comment", { kind: "file", path: "new.txt" }),
        thread("Topic comment", { kind: "topic", slug: "topic" }),
        thread("Old range comment", { ...target, path: "old.txt", side: "old", start: 1 }),
        unplaced,
      ],
    ),
  );
  near("new.txt");
  await waitFor(() => expect(document.querySelector("diffs-container")).toBeTruthy());
  expect(screen.getByText("File comment").closest("[data-file-header]")).toBeTruthy();
  expect(screen.getByText("Topic comment").closest("[data-topic-header]")).toBeTruthy();
  const header = screen.getByText("Old range comment").closest("[data-file-header]");
  expect(within(header as HTMLElement).getByText("Lines 1–2, old side")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Unplaced comments" })).getByText("Unplaced line comment"),
  ).toBeTruthy();
});
test("real slots place line threads and adding a same-line thread keeps the existing editor", async () => {
  fetchMock.mockImplementation(
    async (path: string) => new Response(path.endsWith("/old") ? "one\nold\n" : "one\ntwo\n"),
  );
  const first = thread("First line comment");
  const value = revision([file()], [first]);
  await mount(value);
  near("new.txt");
  await waitFor(() =>
    expect(document.getElementById(`diff-thread-${first.id}`)?.closest("diffs-container")).toBeTruthy(),
  );
  const original = within(document.getElementById(`diff-thread-${first.id}`) as HTMLElement).getByLabelText("Reply");
  fireEvent.focus(original);
  fireEvent.change(original, { target: { value: "Follow-up" } });
  act(() => client.setQueryData(["test-revision"], { ...value, threads: [first, thread("Second line comment")] }));
  await screen.findByText("Second line comment");
  expect(within(document.getElementById(`diff-thread-${first.id}`) as HTMLElement).getByLabelText("Reply")).toBe(
    original,
  );
  expect((original as HTMLTextAreaElement).value).toBe("Follow-up");
});
test("hostile path and topic title remain exact header text", async () => {
  const path = "<img src=x onerror=alert(1)>.txt",
    title = "<script>alert(1)</script>";
  await mount(revision([file({ path, flag: "binary" })], [], title));
  expect(screen.getByRole("heading", { level: 4 }).textContent).toBe(path);
  expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(title);
  expect(document.querySelector("script,img,[onerror]")).toBeNull();
});

test.each([false, true])("rename plus reused path resolves each side once (split=%s)", async (split) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: split && query === "(min-width: 768px)",
    addEventListener() {},
    removeEventListener() {},
  }));
  const targets: Extract<Target, { kind: "lines" | "file" }>[] = [
    { ...target, path: "old.txt", side: "old" },
    { ...target, path: "old.txt", side: "new" },
    { kind: "file", path: "old.txt" },
  ];
  await mount(
    revision(
      [file(), file({ path: "old.txt", oldPath: null, status: "added", hasOld: false })],
      targets.map((value, index) => thread(`Side comment ${index}`, value)),
    ),
  );
  near("new.txt");
  near("old.txt");
  await waitFor(() => expect(document.querySelectorAll("diffs-container")).toHaveLength(2));
  for (const [index, path] of ["new.txt", "old.txt", "old.txt"].entries()) {
    expect(screen.getAllByText(`Side comment ${index}`)).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: `File ${path}` })).getByText(`Side comment ${index}`),
    ).toBeTruthy();
  }
  const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);
});
test.each(["file", "old", "new"] as const)("ambiguous %s target appears only in the top list", async (kind) => {
  const value: Target =
    kind === "file" ? { kind: "file", path: "same.txt" } : { ...target, path: "same.txt", side: kind };
  await mount(
    revision(
      [file({ path: "same.txt", oldPath: null }), file({ path: "same.txt", oldPath: null })],
      [thread("Ambiguous comment", value)],
    ),
  );
  expect(screen.getAllByText("Ambiguous comment")).toHaveLength(1);
  expect(within(screen.getByRole("region", { name: "Unplaced comments" })).getByText("Ambiguous comment")).toBeTruthy();
});
test.each(["Edit comment", "Reply"])("%s text and focus survive fallback moving inline", async (label) => {
  const pending: (() => void)[] = [];
  fetchMock.mockImplementation(
    (path: string) =>
      new Promise<Response>((resolve) => {
        pending.push(() => resolve(new Response(path.endsWith("/old") ? "one\nold\n" : "one\ntwo\n")));
      }),
  );
  const value = thread("Original comment");
  await mount(revision([file()], [value]));
  near("new.txt");
  await waitFor(() => expect(pending).toHaveLength(2));
  if (label === "Edit comment") fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const input = screen.getByLabelText(label);
  act(() => input.focus());
  fireEvent.change(input, { target: { value: "Unsaved replacement" } });
  await act(async () => {
    for (const resolve of pending) resolve();
  });
  await waitFor(() =>
    expect(document.getElementById(`diff-thread-${value.id}`)?.closest("diffs-container")).toBeTruthy(),
  );
  const moved = screen.getByLabelText(label) as HTMLTextAreaElement;
  expect(moved.value).toBe("Unsaved replacement");
  await waitFor(() => expect(document.activeElement).toBe(moved));
});

import type { FileView, RevisionView, Target, ThreadView } from "@emend/contract";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DiffPane } from "./DiffPane.tsx";
import { parsePair } from "./parse.worker.ts";
import type { DiffParser } from "./parse-client.ts";

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
  main: null,
  writeupEmpty: false,
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
function Pane({ parser = parsePair }: { parser?: DiffParser }) {
  const { data } = useQuery<RevisionView>({ queryKey: ["test-revision"], staleTime: Infinity });
  return data && <DiffPane reviewId={reviewId} revision={data} parser={parser} />;
}
async function mount(value: RevisionView, parser?: DiffParser) {
  client.setQueryData(["test-revision"], value);
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Pane parser={parser} />
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
  const header = screen.getByText("Rename comment").closest(".em-diff-discussion");
  expect(header).toBeTruthy();
  expect(header?.previousElementSibling?.hasAttribute("data-file-header")).toBe(true);
  expect(within(header as HTMLElement).getByText("new.txt · line 2")).toBeTruthy();
  expect(screen.getAllByText("Rename comment")).toHaveLength(1);
});
test.each([{ path: "pnpm-lock.yaml" }, { path: "binary.txt", flag: "binary" as const }])(
  "collapsed/flagged $path preserves line comments",
  async (values) => {
    await mount(revision([file(values)], [thread("Hidden diff comment", { ...target, path: values.path })]));
    near(values.path);
    expect(screen.getByText("Hidden diff comment").closest(".em-diff-discussion")).toBeTruthy();
    expect(screen.getByText(`${values.path} · line 2`)).toBeTruthy();
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
  expect(list.getByText("gone.txt")).toBeTruthy();
  expect(list.getByText("Topic · gone")).toBeTruthy();
  expect(list.getByText("gone.txt · line 2")).toBeTruthy();
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
  expect(screen.getByText("File comment").closest(".em-diff-discussion")).toBeTruthy();
  expect(screen.getByText("Topic comment").closest(".em-diff-discussion")).toBeTruthy();
  const header = screen.getByText("Old range comment").closest(".em-diff-discussion");
  expect(within(header as HTMLElement).getByText("old.txt · lines 1–2 (old)")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Unplaced comments" })).getByText("Unplaced line comment"),
  ).toBeTruthy();
});
test("real slots place line threads and adding a same-line thread keeps the existing editor", async () => {
  fetchMock.mockImplementation(
    async (path: string) => new Response(path.endsWith("/old") ? "one\nold\n" : "one\ntwo\n"),
  );
  const first = thread("First line comment");
  first.comments = first.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 }));
  const value = revision([file()], [first]);
  await mount(value);
  near("new.txt");
  await waitFor(() =>
    expect(document.getElementById(`diff-thread-${first.id}`)?.closest("diffs-container")).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
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
test("hostile topic, path and rename remain exact text in the headers and jump menu", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const path = "src/<script>evil()<img src=x onerror=evil()>.txt";
  const oldPath = "old/<img src=x onerror=evil()><script>old()</script>.txt";
  const title = "<script>evil()</script><img src=x onerror=evil()>";
  await mount(revision([file({ path, oldPath, flag: "binary" })], [], title));
  expect(screen.getByRole("heading", { level: 4 }).textContent).toBe(path);
  expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(title);
  expect(screen.getByTitle(`Renamed from ${oldPath}`).textContent).toBe(`Renamed from ${oldPath}`);
  fireEvent.keyDown(screen.getByRole("button", { name: "1 topic · 1 file" }), { key: "ArrowDown" });
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText(`01 ${title}`).textContent).toBe(`01 ${title}`);
  const item = within(menu).getByRole("menuitem", { name: path.slice(4) });
  expect(item.textContent).toBe(path.slice(4));
  expect(item.title).toBe(path);
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
test.each([
  { label: "Edit comment", text: "Unsaved replacement" },
  { label: "Reply", text: "Unsaved replacement" },
  { label: "Reply", text: "" },
])("$label with '$text' and focus survive fallback moving inline", async ({ label, text }) => {
  const pending: (() => void)[] = [];
  fetchMock.mockImplementation(
    (path: string) =>
      new Promise<Response>((resolve) => {
        pending.push(() => resolve(new Response(path.endsWith("/old") ? "one\nold\n" : "one\ntwo\n")));
      }),
  );
  const value = thread("Original comment");
  if (label === "Reply") value.comments = value.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 }));
  await mount(revision([file()], [value]));
  near("new.txt");
  await waitFor(() => expect(pending).toHaveLength(2));
  if (label === "Edit comment") fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  if (label === "Reply") fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const input = screen.getByLabelText(label);
  act(() => input.focus());
  if (text) fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    for (const resolve of pending) resolve();
  });
  await waitFor(() =>
    expect(document.getElementById(`diff-thread-${value.id}`)?.closest("diffs-container")).toBeTruthy(),
  );
  const moved = screen.getByLabelText(label) as HTMLTextAreaElement;
  expect(moved.value).toBe(text);
  await waitFor(() => expect(document.activeElement).toBe(moved));
});

test("R8 manual file collapse returns a real annotation to the fallback and reopening restores its slot once", async () => {
  fetchMock.mockImplementation(
    async (path: string) => new Response(path.endsWith("/old") ? "one\nold\n" : "one\ntwo\n"),
  );
  const value = thread("Collapsible annotation");
  await mount(revision([file()], [value]));
  near("new.txt");
  await waitFor(() =>
    expect(document.getElementById(`diff-thread-${value.id}`)?.closest("diffs-container")).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Collapse file" }));
  await waitFor(() => expect(document.querySelector("diffs-container")).toBeNull());
  const fallback = screen.getByText("Collapsible annotation").closest(".em-diff-discussion");
  expect(fallback?.previousElementSibling?.hasAttribute("data-file-header")).toBe(true);
  expect(screen.getAllByText("Collapsible annotation")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Expand file" }));
  await waitFor(() =>
    expect(document.getElementById(`diff-thread-${value.id}`)?.closest("diffs-container")).toBeTruthy(),
  );
  expect(screen.getAllByText("Collapsible annotation")).toHaveLength(1);
});

test("R8 fix4 returning to an inline replacement preserves focus and text outside the lazy range", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  fetchMock.mockImplementation(
    async (path: string) => new Response(path.endsWith("/old") ? "one\nold\n" : "one\ntwo\n"),
  );
  const pending = Promise.withResolvers<ReturnType<typeof parsePair>>();
  const parser = vi.fn<DiffParser>((pair) => (pair.newFile?.name === "new.txt" ? pending.promise : parsePair(pair)));
  const value = thread("Reply in file A");
  value.comments = value.comments.map((comment) => ({ ...comment, sent: true, sentOn: 1 }));
  await mount(
    revision([file(), file({ path: "other.txt", oldPath: null, status: "modified", order: 1 })], [value]),
    parser,
  );
  near("new.txt");
  await waitFor(() => expect(parser).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const fallback = document.getElementById(`diff-thread-${value.id}`) as HTMLElement;
  const original = within(fallback).getByRole("textbox", { name: "Reply" });
  expect(fallback.closest("[data-slot-pending]")).toBeTruthy();

  const otherFile = within(screen.getByRole("region", { name: "File other.txt" }));
  fireEvent.click(otherFile.getByRole("button", { name: "Comment on file" }));
  const newer = otherFile.getByRole("textbox", { name: "Comment" });
  expect(document.activeElement).toBe(newer);
  await act(async () =>
    pending.resolve(
      parsePair({
        oldFile: { name: "old.txt", contents: "one\nold\n" },
        newFile: { name: "new.txt", contents: "one\ntwo\n" },
      }),
    ),
  );
  await waitFor(() =>
    expect(document.getElementById(`diff-thread-${value.id}`)?.closest("diffs-container")).toBeTruthy(),
  );
  const replacement = screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
  expect(replacement).not.toBe(original);
  expect(original.isConnected).toBe(false);
  expect(document.activeElement).toBe(newer);

  act(() => replacement.focus());
  fireEvent.change(replacement, { target: { value: "Continue after the reply moved" } });
  expect(document.activeElement).toBe(replacement);
  near("new.txt", false);
  const outside = screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
  expect(outside.value).toBe("Continue after the reply moved");
  expect(document.activeElement).toBe(outside);
  near("new.txt");
  await waitFor(() =>
    expect(document.getElementById(`diff-thread-${value.id}`)?.closest("diffs-container")).toBeTruthy(),
  );
  const returned = screen.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement;
  expect(returned.value).toBe("Continue after the reply moved");
  expect(document.activeElement).toBe(returned);
});

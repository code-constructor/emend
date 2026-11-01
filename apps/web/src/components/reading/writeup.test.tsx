// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { type FileView, OTHER_TOPIC, type RenderedBlock, RenderedWriteup, type TopicMeta } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderWriteup } from "../../../../../packages/core/src/render/writeup.ts";
import { blockAnchor } from "../../lib/selection.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { DocView } from "./DocView.tsx";
import { HtmlDocFrame } from "./HtmlDocFrame.tsx";
import { Writeup } from "./Writeup.tsx";

const reviewId = "11111111-1111-4111-8111-111111111111";
const topic: TopicMeta = {
  slug: "seed",
  title: "Plant a seed",
  summary: "A synthetic garden",
  importance: 10,
  door: "one-way",
  blastRadius: { scope: "garden", note: "The seed bed" },
};
const second: TopicMeta = {
  slug: "water",
  title: "Water the garden",
  summary: "Keep it growing",
  importance: 5,
  door: "two-way",
};
const other: TopicMeta = { ...OTHER_TOPIC, summary: "", importance: 0 };
const block: RenderedBlock = {
  id: "overview-12345678",
  section: "overview",
  kind: "paragraph",
  text: "Plant  a\nseed.",
  html: "<p>Plant  a\nseed.</p>",
};
const file: FileView = {
  id: reviewId,
  path: "seed.txt",
  oldPath: null,
  role: "diff",
  topic: topic.slug,
  order: 0,
  status: "modified",
  mediaType: "text/plain",
  flag: "binary",
  hasOld: false,
  hasNew: false,
};
const plain = (
  key: "overview" | "tldr" | "decisions" | "glossary",
  label: string,
): RenderedWriteup["sections"][number] => ({
  key,
  label,
  topic: null,
  blocks: [],
});
const section = (slug: string, suffix: "why" | "example" | "body"): RenderedWriteup["sections"][number] => ({
  key: `t-${slug}-${suffix}`,
  label: "Do not parse this label",
  topic: slug,
  blocks: [],
});
const props = { reviewId, revision: 2, threads: [], changedBlocks: [] };
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
function mount(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  window.getSelection()?.removeAllRanges();
  fetchMock = vi.fn(async () => Response.json({ threadId: reviewId, commentId: reviewId }, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])("writeup order and grouped topics (overview=%s, tldr=%s)", (overview, tldr) => {
  const sections = [
    ...(overview ? [plain("overview", "Overview")] : []),
    ...(tldr ? [plain("tldr", "TL;DR")] : []),
    plain("decisions", "Decisions and drift"),
    plain("glossary", "Glossary"),
    section("seed", "why"),
    section("seed", "example"),
    section("seed", "body"),
    section("water", "body"),
    { ...section("missing", "why"), label: "Unknown topic — Why" },
  ];
  const { container } = mount(<Writeup {...props} topics={[other, topic, second]} writeup={{ sections }} />);
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    ...(overview ? ["Overview"] : []),
    ...(tldr ? ["TL;DR"] : []),
    "Topics",
    "Decisions and drift",
    "Glossary",
    "01Topic 1: Plant a seed",
    "02Topic 2: Water the garden",
    "Unknown topic — Why",
  ]);
  expect(container.querySelectorAll("section#topic-seed")).toHaveLength(1);
  const seed = screen.getByRole("region", { name: "Topic 1: Plant a seed" });
  expect(
    within(seed)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent),
  ).toEqual(["Why", "Example", "Details"]);
  expect(within(seed).getByText(/The seed bed/)).toBeTruthy();
  const unknown = screen.getByRole("region", { name: "Unknown topic — Why" });
  expect(within(unknown).queryByText(/Topic \d/)).toBeNull();
  expect(unknown.querySelector("[aria-hidden]")).toBeNull();
  expect(container.querySelector("#topic-missing")).toBeNull();
});

test.each([false, true])("topics map ranks, metadata and link destinations (phone=%s)", (phone) => {
  const plainTopic = { ...topic, slug: "rest", title: "Rest", door: undefined, blastRadius: undefined };
  mount(
    <Writeup
      {...props}
      phone={phone}
      search={{ tab: "writeup", rev: 2, thread: reviewId }}
      topics={[topic, other, second, plainTopic]}
      files={[
        file,
        { ...file, topic: "water" },
        { ...file, topic: "water", path: "rain.txt" },
        { ...file, role: "doc", topic: "rest" },
      ]}
      writeup={{ sections: [section("seed", "body")] }}
    />,
  );
  const map = within(screen.getByRole("region", { name: "Topics" }));
  const rows = map.getAllByRole("listitem");
  expect(rows.map((row) => row.querySelector("[aria-hidden]")?.textContent)).toEqual(["01", "02", "03"]);
  expect(map.getByText("One-way door").className).toContain("text-warning-fg");
  expect(map.getByText("Two-way door")).toBeTruthy();
  expect(map.getByText("garden")).toBeTruthy();
  expect(map.getByText("1 file")).toBeTruthy();
  expect(map.getByText("2 files")).toBeTruthy();
  expect(map.queryByText("0 files")).toBeNull();
  expect(map.getByRole("link", { name: topic.title }).getAttribute("href")).toBe(
    `/r/${reviewId}?tab=writeup&rev=2#topic-seed`,
  );
  expect(map.getByRole("link", { name: second.title }).getAttribute("href")).toBe(
    `/r/${reviewId}?tab=${phone ? "diff" : "writeup"}&rev=2#diff-topic-water`,
  );
  expect(map.queryByRole("link", { name: "Rest" })).toBeNull();
  expect(map.getByText("Rest")).toBeTruthy();
  expect(screen.getByRole("link", { name: `Files in diff: ${topic.title}` }).getAttribute("href")).toBe(
    `/r/${reviewId}?tab=${phone ? "diff" : "writeup"}&rev=2#diff-topic-seed`,
  );
});

test.each([{ topics: [] }, { topics: [other] }])("map is absent without ranked topics: %j", ({ topics }) => {
  mount(<Writeup {...props} topics={topics} writeup={{ sections: [] }} />);
  expect(screen.queryByRole("heading", { name: "Topics" })).toBeNull();
});

test("topics without metadata or diff files omit their meta line and jump link", () => {
  const bare = { ...second, door: undefined };
  mount(
    <Writeup
      {...props}
      topics={[bare]}
      files={[file, { ...file, role: "doc", topic: bare.slug }]}
      writeup={{ sections: [section(bare.slug, "body")] }}
    />,
  );
  const group = screen.getByRole("region", { name: `Topic 1: ${bare.title}` });
  expect(within(group).queryByRole("link")).toBeNull();
  expect(within(group).queryByText(/door|Blast radius/)).toBeNull();
});

test.each(["writeup", "doc"])(
  "gutter comments save a whole-block %s target and mark only the active block",
  async (kind) => {
    const heading: RenderedBlock = {
      ...block,
      id: "overview-23456789",
      kind: "heading",
      text: "Growing",
      html: "<h2>Growing</h2>",
    };
    const diagram: RenderedBlock = {
      ...block,
      id: "overview-34567890",
      kind: "diagram",
      text: "graph TD; A-->B",
      source: "graph TD; A-->B",
      html: "",
    };
    const blocks = [block, heading, diagram];
    const { container } = mount(
      kind === "writeup" ? (
        <Writeup
          {...props}
          writeup={{ sections: [{ ...plain("overview", "Overview"), blocks }] }}
          changedBlocks={[{ blockId: block.id, revision: 2 }]}
        />
      ) : (
        <DocView
          {...props}
          docs={[{ path: "garden.md", kind: "markdown", blocks }]}
          openDoc={{ path: "garden.md", kind: "markdown", blocks }}
          search={{ tab: "docs", doc: "garden.md" }}
          targeted={false}
          onOpenDoc={() => {}}
          changedBlocks={[{ blockId: block.id, revision: 2 }]}
        />
      ),
    );
    expect(screen.getAllByRole("button", { name: "Comment on block" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Comment on diagram" })).toHaveLength(1);
    expect(screen.getAllByText("Changed in revision 2")).toHaveLength(1);
    const changed = screen.getByText("Changed in revision 2").closest(".em-reading-block");
    expect(changed?.querySelector('[aria-hidden="true"].bg-changed-line')).toBeTruthy();
    expect(container.querySelectorAll(".bg-changed-line")).toHaveLength(1);
    const button = screen.getByRole("button", { name: "Comment on block" });
    // A remaining selection must not be captured when the gutter is pressed.
    const text = container.querySelector("[data-block-id] p")?.firstChild;
    if (!text) throw new Error("Missing block text");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(button);
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
    fireEvent.click(button);
    expect(container.querySelectorAll("[data-commenting]")).toHaveLength(1);
    expect(changed?.hasAttribute("data-commenting")).toBe(true);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep growing" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).target).toEqual({
      kind: kind === "writeup" ? "writeup-span" : "doc-span",
      ...(kind === "doc" ? { path: "garden.md" } : {}),
      ...blockAnchor(block),
    });
    await waitFor(() => expect(container.querySelector("[data-commenting]")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Comment on diagram" }));
    expect(container.querySelector("[data-commenting] [data-block-id]")?.getAttribute("data-block-id")).toBe(
      diagram.id,
    );
  },
);

test("an HTML doc keeps its sandbox note under the frame", () => {
  const { container } = mount(<HtmlDocFrame {...props} path="one.html" contentUrl="/content/synthetic/one.html" />);
  expect(screen.getAllByText("Shown in a sandbox. Scripts in this doc never run.")).toHaveLength(1);
  for (const frame of container.querySelectorAll("iframe")) {
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.className).toContain("bg-[#fff]");
    expect(frame.nextElementSibling?.textContent).toBe("Shown in a sandbox. Scripts in this doc never run.");
  }
});

test("hostile metadata stays React text and server-sanitized Markdown remains inert inside the new wrappers", async () => {
  const hostile = "<script>evil()</script><img src=x onerror=evil()><svg onload=evil()></svg>";
  const markdown = `${hostile}\n\n[bad](javascript:evil())\n\nRaw <b>HTML</b>`;
  const evilTopic = {
    ...topic,
    title: hostile,
    summary: hostile,
    blastRadius: { scope: "<img/onerror=evil()>", note: hostile },
  };
  const writeup = await renderWriteup(
    {
      overview: markdown,
      tldr: "",
      decisions: null,
      glossary: markdown,
      topics: { seed: { why: markdown, body: markdown } },
    },
    [evilTopic],
  );
  const { container } = mount(
    <>
      <Writeup {...props} topics={[evilTopic]} writeup={RenderedWriteup.parse(writeup)} />
      <DocView
        {...props}
        docs={[{ path: hostile, kind: "markdown", blocks: [] }]}
        openDoc={{ path: hostile, kind: "markdown", blocks: [] }}
        search={{ tab: "docs" }}
        targeted={false}
        onOpenDoc={() => {}}
      />
    </>,
  );
  expect(screen.getAllByText(hostile).length).toBeGreaterThanOrEqual(3);
  expect(container.querySelector("script, svg[onload], [onerror], [onclick]")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(container.querySelectorAll(".em-prose").length).toBeGreaterThan(0);
});

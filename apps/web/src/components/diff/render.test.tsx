import { DiffHunksRenderer } from "@pierre/diffs";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DiffView } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test.each(["split", "unified"] as const)(
  "real %s renderer preserves hostile text without creating elements",
  async (style) => {
    const text =
      '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\njavascript:alert(1)\n</span><b>\n<svg onload=alert(1)>\n<a href="javascript:alert(1)">link</a>\nclick node "javascript:alert(1)"\n';
    const parsed = parsePair({ oldFile: null, newFile: { name: "hostile.txt", contents: text } });
    const view = render(
      <DiffView fileDiff={parsed} diffStyle={style} annotations={[]} onSelect={() => {}} selected={null} />,
    );
    const host = view.container.querySelector("diffs-container");
    await waitFor(() => expect(host?.shadowRoot?.querySelector("[data-line]")).toBeTruthy());
    const shadow = host?.shadowRoot;
    expect(shadow?.querySelector("script, img, b, [onerror], [onload], [href^='javascript:']")).toBeNull();
    const lines = [...(shadow?.querySelectorAll("[data-line]") ?? [])].map((line) => line.textContent);
    expect(lines).toEqual(text.trimEnd().split("\n"));
  },
);

test("a line annotation in unchanged context has a visible slot under its end line", async () => {
  const old = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const parsed = parsePair({
    oldFile: { name: "context.txt", contents: old },
    newFile: { name: "context.txt", contents: `${old}\nadded` },
  });
  const view = render(
    <DiffView
      fileDiff={parsed}
      diffStyle="split"
      selected={null}
      onSelect={() => {}}
      annotations={[{ side: "additions", lineNumber: 10, metadata: <p>Context thread</p> }]}
    />,
  );
  await waitFor(() =>
    expect(
      view.container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector('slot[name="annotation-additions-10"]'),
    ).toBeTruthy(),
  );
});

const contextDiff = () => {
  const old = Array.from({ length: 180 }, (_, index) => `line ${index + 1}`);
  const next = [...old];
  next.splice(39, 1, "changed 40", "inserted line");
  next[120] = "changed 120";
  return parsePair({
    oldFile: { name: "context.txt", contents: old.join("\n") },
    newFile: { name: "context.txt", contents: next.join("\n") },
  });
};

test.each([
  { side: "deletions", line: 8, index: 0, direction: "up", hidden: 80 },
  { side: "additions", line: 30, index: 0, direction: "down", hidden: 80 },
  { side: "deletions", line: 55, index: 1, direction: "up", hidden: 8 },
  { side: "additions", line: 106, index: 1, direction: "down", hidden: 8 },
  { side: "deletions", line: 140, index: 2, direction: "up", hidden: 80 },
  { side: "additions", line: 141, index: 2, direction: "up", hidden: 80 },
] as const)(
  "$side line $line expands only region $index from $direction",
  async ({ side, line, index, direction, hidden }) => {
    const expand = vi.spyOn(DiffHunksRenderer.prototype, "expandHunk");
    const renders = vi.spyOn(DiffHunksRenderer.prototype, "renderDiff");
    const parsed = contextDiff();
    expect(parsed.hunks).toHaveLength(2);
    const annotations = [{ side, lineNumber: line, metadata: <p>Placed comment</p> }];
    const props = { fileDiff: parsed, annotations, onSelect: () => {}, selected: null };
    const view = render(<DiffView {...props} diffStyle="split" />);
    const shadow = () => view.container.querySelector("diffs-container")?.shadowRoot;
    await waitFor(() => expect(shadow()?.querySelector(`slot[name="annotation-${side}-${line}"]`)).toBeTruthy());
    expect(expand).toHaveBeenCalledTimes(1);
    const hunk = parsed.hunks[index];
    const previous = parsed.hunks[index - 1];
    const start = hunk ? (side === "deletions" ? hunk.deletionStart : hunk.additionStart) : 0;
    const tailStart = previous
      ? side === "deletions"
        ? previous.deletionStart + previous.deletionCount
        : previous.additionStart + previous.additionCount
      : 0;
    const count = hunk
      ? (direction === "up" ? line - (start - hunk.collapsedBefore) + 1 : start - line) + 3
      : line - tailStart + 4;
    expect(expand).toHaveBeenCalledWith(index, direction, count);
    expect(
      renders.mock.contexts.every(
        (renderer) => renderer instanceof DiffHunksRenderer && renderer.options.expandUnchanged === false,
      ),
    ).toBe(true);
    for (let number = line - 3; number <= line + 3; number++)
      expect(shadow()?.querySelector(`[data-${side}] [data-line="${number}"]`)).toBeTruthy();
    expect(shadow()?.querySelector(`[data-${side}] [data-line="${hidden}"]`)).toBeNull();
    view.rerender(<DiffView {...props} annotations={[...annotations]} diffStyle="unified" />);
    await waitFor(() => expect(shadow()?.querySelector("[data-unified]")).toBeTruthy());
    expect(expand).toHaveBeenCalledTimes(1);
    expect(shadow()?.querySelector(`slot[name="annotation-${side}-${line}"]`)).toBeTruthy();
  },
);

test("comments inside hunks do not expand context", async () => {
  const expand = vi.spyOn(DiffHunksRenderer.prototype, "expandHunk");
  const view = render(
    <DiffView
      fileDiff={contextDiff()}
      diffStyle="split"
      onSelect={() => {}}
      selected={null}
      annotations={[{ side: "deletions", lineNumber: 40, metadata: <p>Changed line</p> }]}
    />,
  );
  await waitFor(() =>
    expect(
      view.container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector('slot[name="annotation-deletions-40"]'),
    ).toBeTruthy(),
  );
  expect(expand).not.toHaveBeenCalled();
});

test("same-region threads share expansion, and a later comment extends it only as needed", async () => {
  const expand = vi.spyOn(DiffHunksRenderer.prototype, "expandHunk");
  const parsed = contextDiff();
  const annotations = [8, 10].map((lineNumber) => ({
    side: "additions" as const,
    lineNumber,
    metadata: <p>Comment {lineNumber}</p>,
  }));
  const props = { fileDiff: parsed, diffStyle: "split" as const, onSelect: () => {}, selected: null };
  const view = render(<DiffView {...props} annotations={annotations} />);
  const shadow = () => view.container.querySelector("diffs-container")?.shadowRoot;
  await waitFor(() => expect(shadow()?.querySelector('slot[name="annotation-additions-10"]')).toBeTruthy());
  expect(expand.mock.calls).toEqual([[0, "up", 13]]);
  const later = [...annotations, { side: "deletions" as const, lineNumber: 15, metadata: <p>Later comment</p> }];
  view.rerender(<DiffView {...props} annotations={later} />);
  await waitFor(() => expect(shadow()?.querySelector('slot[name="annotation-deletions-15"]')).toBeTruthy());
  expect(expand.mock.calls).toEqual([
    [0, "up", 13],
    [0, "up", 5],
  ]);
  view.rerender(<DiffView {...props} annotations={[...later]} />);
  expect(expand).toHaveBeenCalledTimes(2);
});

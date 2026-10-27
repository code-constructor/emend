import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { DiffView } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";

afterEach(cleanup);
test.each(["split", "unified"] as const)(
  "real %s renderer preserves hostile text without creating elements",
  async (style) => {
    const text = "<script>alert(1)</script>\n<img src=x onerror=alert(1)>\njavascript:alert(1)\n</span><b>\n";
    const parsed = parsePair({ oldFile: null, newFile: { name: "hostile.txt", contents: text } });
    const view = render(
      <DiffView fileDiff={parsed} diffStyle={style} annotations={[]} onSelect={() => {}} selected={null} />,
    );
    const host = view.container.querySelector("diffs-container");
    await waitFor(() => expect(host?.shadowRoot?.querySelector("[data-line]")).toBeTruthy());
    const shadow = host?.shadowRoot;
    expect(shadow?.querySelector("script, img, b, [onerror], [href^='javascript:']")).toBeNull();
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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { DiffView } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../../styles/diff.css"), "utf8");
const installed = readFileSync(
  resolve(import.meta.dirname, "../../../node_modules/@pierre/diffs/dist/style.js"),
  "utf8",
);
const overrides = {
  "--diffs-bg-addition-override": "--diff-add-bg",
  "--diffs-bg-addition-emphasis-override": "--diff-add-word",
  "--diffs-addition-color-override": "--diff-add-fg",
  "--diffs-bg-deletion-override": "--diff-del-bg",
  "--diffs-bg-deletion-emphasis-override": "--diff-del-word",
  "--diffs-deletion-color-override": "--diff-del-fg",
  "--diffs-bg-context-override": "--bg-surface",
  "--diffs-bg-context-gutter-override": "--diff-gutter",
  "--diffs-bg-separator-override": "--diff-hunk-bg",
  "--diffs-bg-selection-override": "--diff-select-bg",
  "--diffs-fg-number-override": "--fg-3",
};

afterEach(cleanup);
test("annotation content cannot size the split columns and its controls wrap", () => {
  const annotation = stylesheet.match(/\.em-diff-annotation\s*\{([^}]+)\}/)?.[1];
  expect(annotation).toMatch(/contain:\s*inline-size;/);
  expect(annotation).toMatch(/min-width:\s*0;/);
  expect(stylesheet).toMatch(/\.em-diff-annotation \.em-thread > footer,[\s\S]*?flex-wrap:\s*wrap;/);
  expect(stylesheet).toMatch(/\.em-diff-annotation \.em-composer__foot\s*\{\s*flex-wrap:\s*wrap;/);
  expect(stylesheet).toMatch(/\.em-diff-annotation \.em-composer__target > span\s*\{[^}]*text-overflow:\s*ellipsis;/);
});

test("script-focused headings suppress only their ring; keyboard buttons retain the global rule", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../../styles/base.css"), "utf8");
  const focus = css.match(/:focus-visible\s*\{([^}]+)\}/);
  const suppressed = css.match(/(\[tabindex="-1"\]):focus-visible\s*\{([^}]+)\}/);
  expect(focus?.[1]).toContain("box-shadow: var(--focus-ring)");
  expect(suppressed?.[2]).toContain("box-shadow: none");
  expect(suppressed?.index).toBeGreaterThan(focus?.index ?? 0);
  const view = render(
    <>
      <h1 tabIndex={-1}>Review</h1>
      <button type="button">Keyboard control</button>
    </>,
  );
  const selector = suppressed?.[1] ?? "missing";
  expect(view.getByRole("heading").matches(selector)).toBe(true);
  expect(view.getByRole("button").matches(selector)).toBe(false);
});

test.each(["light", "dark"])("real diff host uses the verified token overrides in %s scheme", async (theme) => {
  const style = document.createElement("style");
  const tokens = Object.fromEntries(
    Object.values(overrides).map((token, index) => [
      token,
      `#${theme === "dark" ? "1" : "e"}${String(index).padStart(5, "0")}`,
    ]),
  );
  // Happy DOM does not apply cascade layers; preserve the actual selectors/declarations.
  style.textContent = stylesheet.replace("@layer components {", "").replace(/}\s*$/, "");
  document.head.append(style);
  try {
    const value = parsePair({ oldFile: null, newFile: { name: "theme.ts", contents: "const value = true;\n" } });
    const { container } = render(
      <div
        data-theme={theme}
        style={{ ...tokens, "--font-mono": "monospace", colorScheme: theme } as React.CSSProperties}
      >
        <DiffView fileDiff={value} diffStyle="split" annotations={[]} onSelect={() => {}} selected={null} />
      </div>,
    );
    const host = container.querySelector<HTMLElement>("diffs-container");
    if (!host) throw new Error("Missing real renderer host");
    await waitFor(() => expect(host.shadowRoot?.querySelector("[data-line]")).toBeTruthy());
    const computed = getComputedStyle(host);
    for (const [name, token] of Object.entries(overrides)) {
      expect(installed).toContain(name);
      expect(computed.getPropertyValue(name).trim()).toBe(tokens[token]);
    }
    for (const name of ["--diffs-font-family", "--diffs-font-size", "--diffs-line-height"])
      expect(installed).toContain(name);
    expect(computed.getPropertyValue("--diffs-font-family").trim()).toBe("monospace");
    expect(computed.getPropertyValue("--diffs-font-size").trim()).toBe("1em");
    expect(computed.getPropertyValue("--diffs-line-height").trim()).toBe("1lh");
    expect(host.style.colorScheme).toBe("inherit");
    expect(stylesheet).toContain("font: var(--type-code)");
    // The real renderer provides both syntax palettes, selected by inherited color-scheme.
    expect(host.shadowRoot?.textContent).toContain("--diffs-light");
    expect(host.shadowRoot?.textContent).toContain("--diffs-dark");
  } finally {
    style.remove();
  }
});

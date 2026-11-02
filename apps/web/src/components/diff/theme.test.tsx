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

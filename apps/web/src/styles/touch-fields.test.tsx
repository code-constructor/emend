import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { PairingCodeInput } from "../components/ui/PairingCodeInput.tsx";

const entry = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");
const touch = readFileSync(resolve(import.meta.dirname, "touch-fields.css"), "utf8");

it("renders every text-entry field at 16px on touch screens so iOS Safari does not zoom on focus", () => {
  const media = touch.match(/@media \(hover: none\) and \(pointer: coarse\)\s*\{([\s\S]*)\}\s*$/)?.[1];
  expect(media).toBeDefined();
  const rule = media?.match(/([^{}]+)\{([^}]*)\}/);
  expect(rule?.[2]).toMatch(/font-size:\s*16px;/);
  for (const selector of [
    "input:not(",
    "textarea",
    "select",
    '[contenteditable]:not([contenteditable="false"], [data-own-size])',
  ]) {
    expect(rule?.[1]).toContain(selector);
  }
  for (const kind of ["checkbox", "radio", "button", "submit"]) {
    expect(rule?.[1]).toContain(`[type="${kind}"]`);
  }
});

it("keeps the touch rule unlayered, so it beats Tailwind utilities and the layered app CSS", () => {
  expect(touch).not.toMatch(/@layer/);
  expect(entry).toMatch(/@import "\.\/styles\/touch-fields\.css";\s*$/m);
  expect(entry).not.toMatch(/touch-fields\.css"\s+layer/);
});

it("excludes [data-own-size] in all four selector branches, so the rule only raises small fields", () => {
  const selectors = touch.match(/\{\s*([\s\S]*?)\{[^}]*font-size/)?.[1] ?? "";
  expect(selectors.split("[data-own-size]").length - 1).toBe(4);
});

it("marks the pairing code input, which is larger than 16px, with data-own-size", () => {
  const { container } = render(<PairingCodeInput />);
  expect(container.querySelector("input")?.hasAttribute("data-own-size")).toBe(true);
});

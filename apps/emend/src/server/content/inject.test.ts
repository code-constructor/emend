import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { BRIDGE_SOURCE } from "./bridge.ts";
import { injectBridge } from "./inject.ts";

test("injects one self-contained script before the last case-insensitive body close, otherwise appends", () => {
  const script = `<script>${BRIDGE_SOURCE}</script>`;
  expect(injectBridge("<body>seed</BODY>tail</bOdY>")).toBe(`<body>seed</BODY>tail${script}</bOdY>`);
  expect(injectBridge("<p>seed</p>")).toBe(`<p>seed</p>${script}`);
  expect(injectBridge("<body>İ</BoDy>")).toBe(`<body>İ${script}</BoDy>`);
  expect(BRIDGE_SOURCE).not.toMatch(/<\/script|\bimport\s/i);
});

test("body-close text in a script before the real body close preserves one bridge and its hash", () => {
  const html = '<body><p>Seed</p><script>const ending = "</body>";</script></body>';
  const injected = injectBridge(html);
  const at = html.lastIndexOf("</body>");
  expect(injected).toBe(`${html.slice(0, at)}<script>${BRIDGE_SOURCE}</script>${html.slice(at)}`);
  const texts = [...injected.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const bridges = texts.filter((text) => text === BRIDGE_SOURCE);
  expect(bridges).toHaveLength(1);
  expect(injected.split(BRIDGE_SOURCE)).toHaveLength(2);
  expect(
    createHash("sha256")
      .update(bridges[0] ?? "")
      .digest("base64"),
  ).toBe(createHash("sha256").update(BRIDGE_SOURCE).digest("base64"));
});

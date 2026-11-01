import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { sanitizeSvg, startFrame } from "../mermaid-frame.ts";
import { MermaidBlock } from "./components/reading/MermaidBlock.tsx";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  mermaidAPI: {
    defaultConfig: {
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges"],
    },
  },
}));
vi.mock("mermaid", () => ({ default: mermaid }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mermaid.render.mockReset();
  mermaid.initialize.mockReset();
});
test("web sources have one audited server HTML sink and no DOM string insertion", () => {
  const root = join(import.meta.dirname, "..");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (path) => /\.(tsx?|html)$/.test(path) && !/^(node_modules|dist|\.tsbuild)\//.test(path),
  );
  const forbidden = ["inner" + "HTML", "outer" + "HTML", "insertAdjacent" + "HTML"];
  const reactSink = "dangerouslySet" + "InnerHTML";
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const name of forbidden) expect(text, `${file}: ${name}`).not.toContain(name);
    if (text.includes(reactSink)) expect(file).toBe("src/components/reading/BlockView.tsx");
  }
  expect(readFileSync(join(root, "src/components/reading/BlockView.tsx"), "utf8")).toContain(reactSink);
});
test("SVG scrub drops executable elements, click handlers and non-fragment links", () => {
  const svg = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="evil()"><script>evil()</script><foreignObject><p>bad</p></foreignObject><a href="javascript:evil()" onclick="evil()"><text>click</text></a><a xlink:href="https://example.com">external</a><use href="#safe"/></svg>',
  );
  expect(svg.querySelector("script, foreignObject")).toBeNull();
  expect(svg.querySelector("a")?.hasAttribute("onclick")).toBe(false);
  expect(svg.hasAttribute("onload")).toBe(false);
  expect(
    [...svg.querySelectorAll("a")].every((node) => !node.hasAttribute("href") && !node.hasAttribute("xlink:href")),
  ).toBe(true);
  expect(svg.querySelector("use")?.getAttribute("href")).toBe("#safe");
});
test.each([
  'graph TD; A-->B; click A evil "click"',
  '%%{init: {"theme": "dark", "securityLevel": "loose"}}%%\ngraph TD; A-->B; click A evil "click"',
])("frame config is strict, ignores strangers and never binds a Mermaid click directive: %s", async (source) => {
  const root = document.createElement("div");
  document.body.append(root);
  const bindFunctions = vi.fn();
  mermaid.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><a onclick="evil()" href="javascript:evil()"><text>A</text></a></svg>',
    bindFunctions,
  });
  const stop = startFrame(root);
  try {
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, maxTextSize: 50000 }),
    );
    window.dispatchEvent(new MessageEvent("message", { source: null, data: { type: "render", source } }));
    expect(mermaid.render).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "render", source } }));
    await waitFor(() => expect(root.querySelector("svg")).not.toBeNull());
    expect(bindFunctions).not.toHaveBeenCalled();
    expect(root.querySelector("[onclick], [href]")).toBeNull();
    for (const node of root.querySelectorAll("svg, svg *"))
      expect([...node.attributes].some((attr) => attr.name.toLowerCase().startsWith("on"))).toBe(false);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "base",
        securityLevel: "strict",
        secure: expect.arrayContaining(["theme", "themeVariables", "securityLevel"]),
      }),
    );
  } finally {
    stop();
    root.remove();
  }
});
test("oversize source stays text and is never passed to Mermaid", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const stop = startFrame(root);
  try {
    const source = "x".repeat(50001);
    window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "render", source } }));
    await waitFor(() => expect(root.textContent).toContain("This diagram is too large to draw."));
    expect(root.querySelector("pre")?.textContent).toBe(source);
    expect(mermaid.render).not.toHaveBeenCalled();
  } finally {
    stop();
    root.remove();
  }
});
test("parent uses the minimal sandbox, posts only source after load, and validates the sending window and size", () => {
  const { container } = render(<MermaidBlock source="graph TD; A-->B" />);
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("Missing frame");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe("/mermaid-frame.html");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  fireEvent.load(frame);
  expect(post).toHaveBeenCalledWith({ type: "render", source: "graph TD; A-->B" }, "*");
  const initial = frame.style.height;
  const other = document.createElement("iframe");
  Object.defineProperty(other, "contentWindow", { value: { postMessage: vi.fn() } });
  fireEvent(window, new MessageEvent("message", { source: other.contentWindow, data: { type: "size", height: 500 } }));
  expect(frame.style.height).toBe(initial);
  for (const height of [NaN, Infinity, "500", -1, 10001]) {
    fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "size", height } }));
    expect(frame.style.height).toBe(initial);
  }
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "size", height: 500 } }));
  expect(frame.style.height).toBe("500px");
});

test.each([
  [Number.NaN, 1],
  [Infinity, 1],
  [-20, 1],
  [20000, 10000],
  [41.2, 42],
])("frame clamps measured height %s to %s", async (measured, height) => {
  const root = document.createElement("div");
  document.body.append(root);
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ height: measured } as DOMRect);
  const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  mermaid.render.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>' });
  const stop = startFrame(root);
  try {
    window.dispatchEvent(
      new MessageEvent("message", { source: window.parent, data: { type: "render", source: "graph TD; A-->B" } }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: "size", height }, "*"));
  } finally {
    stop();
    root.remove();
  }
});

test.each(["q", "xlink"])("SVG scrub removes %s:href in every namespace", (prefix) => {
  for (const url of ["https://example.com", "javascript:evil()"])
    for (const namespace of ["http://www.w3.org/1999/xlink", "urn:synthetic"]) {
      // Happy DOM's XML parser only resolves the literal xlink prefix. Construct
      // a namespaced Attr so this exercises the namespace-aware browser DOM.
      const parsed = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><a><text>link</text></a></svg>',
        "image/svg+xml",
      );
      parsed.querySelector("a")?.setAttributeNS(namespace, `${prefix}:href`, url);
      expect(parsed.querySelector("a")?.getAttributeNodeNS(namespace, "href")?.localName).toBe("href");
      vi.spyOn(DOMParser.prototype, "parseFromString").mockReturnValueOnce(parsed);
      const svg = sanitizeSvg("synthetic SVG");
      expect(svg.querySelector("a")?.hasAttribute(`${prefix}:href`)).toBe(false);
    }
});
test("mock secure defaults match the installed Mermaid library", async () => {
  const actual = await vi.importActual<typeof import("mermaid")>("mermaid");
  expect(mermaid.mermaidAPI.defaultConfig.secure).toEqual(actual.default.mermaidAPI.defaultConfig.secure);
});
test.each([
  { version: "installed", defaults: mermaid.mermaidAPI.defaultConfig.secure },
  { version: "future", defaults: ["futureSecureKey"] },
])("frame config names its protected keys and extends $version defaults", ({ defaults }) => {
  const original = mermaid.mermaidAPI.defaultConfig.secure;
  mermaid.mermaidAPI.defaultConfig.secure = defaults;
  const stop = startFrame(document.createElement("div"));
  try {
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        secure: expect.arrayContaining([
          ...defaults,
          "secure",
          "securityLevel",
          "startOnLoad",
          "maxTextSize",
          "suppressErrorRendering",
          "maxEdges",
          "htmlLabels",
          "flowchart",
          "theme",
          "themeCSS",
          "themeVariables",
          "dompurifyConfig",
          "fontFamily",
          "altFontFamily",
        ]),
      }),
    );
  } finally {
    stop();
    mermaid.mermaidAPI.defaultConfig.secure = original;
  }
});
test("lazy frames receive source only on first load, with a fresh frame for changed source", () => {
  const { container, rerender } = render(<MermaidBlock source="flowchart LR; A-->B" />);
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("Missing frame");
  expect(frame.getAttribute("loading")).toBe("lazy");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  fireEvent.load(frame);
  fireEvent.load(frame);
  expect(post).toHaveBeenCalledTimes(1);
  rerender(<MermaidBlock source="flowchart LR; B-->C" />);
  const next = container.querySelector("iframe");
  if (!next) throw new Error("Missing frame");
  expect(next).not.toBe(frame);
  const nextPost = vi.fn();
  Object.defineProperty(next, "contentWindow", { value: { postMessage: nextPost } });
  fireEvent.load(next);
  fireEvent.load(next);
  expect(nextPost).toHaveBeenCalledExactlyOnceWith({ type: "render", source: "flowchart LR; B-->C" }, "*");
});

test.each([false, true])("frame locks its base theme to the embedding colour scheme (dark=%s)", (dark) => {
  const media = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: dark } as MediaQueryList);
  const stop = startFrame(document.createElement("div"));
  try {
    expect(media).toHaveBeenCalledExactlyOnceWith("(prefers-color-scheme: dark)");
    const [sunken, surface, fg, fg2, fg3, border, topicBg, topic] = dark
      ? ["#060708", "#111213", "#f4f4f6", "#c4c6c8", "#9d9ea1", "#2a2b2d", "#043232", "#00a19d"]
      : ["#f4f4f6", "#fdfdfe", "#111213", "#444547", "#5f6063", "#c4c6c8", "#c2f3f0", "#00807e"];
    expect(mermaid.initialize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        theme: "base",
        fontFamily: "system-ui, sans-serif",
        startOnLoad: false,
        securityLevel: "strict",
        secure: expect.arrayContaining(["theme", "themeVariables", "themeCSS", "fontFamily"]),
        themeVariables: {
          darkMode: dark,
          fontSize: "13px",
          background: sunken,
          tertiaryColor: sunken,
          labelBoxBkgColor: sunken,
          primaryColor: surface,
          actorBkg: surface,
          primaryTextColor: fg,
          textColor: fg,
          noteTextColor: fg,
          actorTextColor: fg,
          signalColor: fg2,
          signalTextColor: fg2,
          labelTextColor: fg2,
          loopTextColor: fg2,
          lineColor: fg3,
          primaryBorderColor: border,
          actorBorder: border,
          actorLineColor: border,
          labelBoxBorderColor: border,
          secondaryColor: topicBg,
          noteBkgColor: topicBg,
          noteBorderColor: topicBg,
          activationBkgColor: topicBg,
          activationBorderColor: topic,
        },
        sequence: {
          mirrorActors: false,
          actorMargin: 48,
          messageMargin: 30,
          boxMargin: 8,
          useMaxWidth: true,
          actorFontWeight: 500,
        },
      }),
    );
  } finally {
    stop();
  }
});

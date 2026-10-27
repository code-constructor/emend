// @vitest-environment node
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { build } from "vite";
import { expect, test, vi } from "vitest";

test("built frame rejects diagram theme overrides without dynamic code generation", async () => {
  const result = await build({
    root: fileURLToPath(new URL("../", import.meta.url)),
    logLevel: "silent",
    build: { write: false },
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("Expected a single web build");
  const frame = result.output.find((file) => file.fileName === "mermaid-frame.html");
  if (frame?.type !== "asset") throw new Error("Missing frame HTML");
  const html = String(frame.source);
  expect(html).not.toContain('type="module"');
  expect(html).not.toContain("crossorigin");
  const script = /<script src="\/(assets\/mermaid-frame-[\w-]+\.js)"><\/script>/.exec(html)?.[1];
  expect(script).toBeDefined();
  const asset = result.output.find((file) => file.fileName === script);
  if (asset?.type !== "asset") throw new Error("Missing classic frame script");
  const code = String(asset.source);
  expect(code).toContain("This diagram is too large to draw.");
  expect(code).not.toMatch(/\bimport\s*\(/);
  for (const file of result.output) {
    if (file.type === "chunk") expect(file.code).not.toContain("maxTextSize");
  }
  const window = new Window();
  // Happy DOM's base Node getter returns an empty name. DOMPurify uses that
  // native getter directly; delegate to the concrete node's getter as browsers do.
  const nodeName = Object.getOwnPropertyDescriptor(window.Node.prototype, "nodeName")?.get;
  if (!nodeName) throw new Error("Missing nodeName getter");
  vi.spyOn(window.Node.prototype, "nodeName", "get").mockImplementation(function (
    this: InstanceType<typeof window.Node>,
  ) {
    for (
      let prototype = Object.getPrototypeOf(this);
      prototype && prototype !== window.Node.prototype;
      prototype = Object.getPrototypeOf(prototype)
    ) {
      const getter = Object.getOwnPropertyDescriptor(prototype, "nodeName")?.get;
      if (getter) return getter.call(this);
    }
    return nodeName.call(this);
  });
  // Happy DOM's HTML parser loses SVG children when they contain a style tag.
  // Parse Mermaid's SVG as XML and retain it in an HTML document for DOMPurify.
  const parse = window.DOMParser.prototype.parseFromString;
  vi.spyOn(window.DOMParser.prototype, "parseFromString").mockImplementation(function (
    this: InstanceType<typeof window.DOMParser>,
    source,
    type,
  ) {
    if (type === "text/html" && source.startsWith("<svg")) {
      const xml = parse.call(this, source, "image/svg+xml");
      const html = parse.call(this, "", "text/html");
      html.body.append(html.importNode(xml.documentElement, true));
      return html;
    }
    return parse.call(this, source, type);
  });
  const root = window.document.createElement("div");
  window.document.body.append(root);
  // Supply SVG layout measurements for the synthetic window.
  Object.defineProperty(window.SVGElement.prototype, "getBBox", {
    value: () => ({ x: 0, y: 0, width: 80, height: 20 }),
  });
  vi.spyOn(window.SVGGraphicsElement.prototype, "getBBox").mockImplementation(() => new window.DOMRect(0, 0, 80, 20));
  Object.defineProperty(window.SVGElement.prototype, "getComputedTextLength", { value: () => 80 });
  const sandbox: Record<string, unknown> = {};
  // Keep the VM Array constructor: ELK uses instanceof Array when
  // importing graph children. Happy DOM's foreign constructor drops those nodes.
  for (const name of Object.getOwnPropertyNames(window)) {
    if (!["Array", "Function", "eval", "globalThis"].includes(name)) sandbox[name] = Reflect.get(window, name);
  }
  sandbox.window = window;
  sandbox.self = window;
  let stop: (() => void) | undefined;
  try {
    runInNewContext(code, sandbox, { contextCodeGeneration: { strings: false, wasm: false } });
    const frame = Reflect.get(sandbox, "EmendMermaidFrame") as { startFrame: (root: unknown) => () => void };
    stop = frame.startFrame(root);
    for (const source of [
      'graph TD\n A\n click A evil "click"',
      '%%{init: {"themeCSS": ".probeThemeInit { fill: rgb(1, 2, 3); }"}}%%\nflowchart LR\nA',
      '---\nconfig:\n  themeCSS: ".probeThemeInit { fill: rgb(1, 2, 3); }"\n---\nflowchart LR\nA',
      '%%{initialize: {"themeCSS": ".probeThemeInitialize { fill: rgb(1, 2, 3); }"}}%%\nflowchart LR\nA',
      '%%{init: {"fontFamily": "x; .probeFontInit{fill:rgb(7,8,9)}"}}%%\nflowchart LR\n  F01a --> F01b',
      '---\nconfig:\n  fontFamily: "x; .probeFontFm{fill:rgb(7,8,9)}"\n---\nflowchart LR\n  F01a --> F01b',
      "flowchart LR\n C01a --> C01b\n classDef synthetic fill:#123456,stroke:#654321;\n class C01a synthetic;\n style C01b fill:#abcdef,stroke:#fedcba;",
      '%%{init: {"themeVariables": {"fontSize": ["16px;} text{fill:rgb(7,8,9) !important} .z{color:x"]}}}%%\nflowchart LR\n  B05a --> B05b',
      '%%{initialize: {"themeVariables": {"fontSize": ["16px;} text{fill:rgb(7,8,9) !important} .z{color:x"]}}}%%\nflowchart LR\n  B05a --> B05b',
      '---\nconfig:\n  themeVariables:\n    fontSize: ["16px;} text{fill:rgb(7,8,9) !important} .z{color:x"]\n---\nflowchart LR\n  B05a --> B05b',
    ]) {
      root.replaceChildren();
      window.dispatchEvent(
        new window.MessageEvent("message", { source: window.parent, data: { type: "render", source } }),
      );
      await vi.waitFor(() => expect(root.firstElementChild?.localName, root.textContent).toBe("svg"), {
        timeout: 3000,
      });
      expect(root.querySelector("script, foreignObject, [onclick], [href], [onload]")).toBeNull();
      const nodes = /([FBC]\d+a) --> ([FBC]\d+b)/.exec(source);
      if (nodes) {
        expect(root.textContent).toContain(nodes[1]);
        expect(root.textContent).toContain(nodes[2]);
        const edge = root.querySelector("path[data-edge]")?.getAttribute("d");
        expect(edge).toBeTruthy();
        expect(edge).not.toContain("NaN");
      }
      if (source.includes("classDef synthetic")) {
        expect(root.querySelector(".node.synthetic rect")?.getAttribute("style")).toMatch(/fill:\s*#123456/);
        const styled = [...root.querySelectorAll(".node")].find((node) => node.textContent.includes("C01b"));
        expect(styled?.querySelector("rect")?.getAttribute("style")).toMatch(/fill:\s*#abcdef/);
      }
      const styles = [...root.querySelectorAll("svg style")];
      expect(styles.length).toBeGreaterThan(0);
      for (const style of styles) {
        expect
          .soft(style.textContent.match(/\.probe(?:ThemeInit|ThemeInitialize|FontInit|FontFm)\b/g) ?? [], source)
          .toEqual([]);
        expect
          .soft(style.textContent.match(/text\s*\{\s*fill:\s*rgb\(7,\s*8,\s*9\)\s*!important\s*;?\s*\}/g) ?? [], source)
          .toEqual([]);
      }
    }
  } finally {
    stop?.();
    await window.happyDOM.close();
    vi.restoreAllMocks();
  }
}, 30000);

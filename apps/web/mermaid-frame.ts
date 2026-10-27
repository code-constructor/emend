import mermaid from "mermaid";

const MAX_SOURCE = 50000;
export function sanitizeSvg(source: string): SVGElement {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const svg = parsed.documentElement;
  if (
    parsed.querySelector("parsererror") ||
    svg.localName !== "svg" ||
    svg.namespaceURI !== "http://www.w3.org/2000/svg"
  )
    throw new Error("Invalid diagram");
  for (const node of [svg, ...svg.querySelectorAll("*")]) {
    if (
      node.namespaceURI !== "http://www.w3.org/2000/svg" ||
      ["script", "foreignobject", "animate", "animatemotion", "animatetransform", "set"].includes(
        node.localName.toLowerCase(),
      )
    ) {
      node.remove();
      continue;
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || (attribute.localName === "href" && !attribute.value.startsWith("#")))
        node.removeAttributeNode(attribute);
    }
  }
  return document.importNode(svg, true) as unknown as SVGElement;
}
export function startFrame(root: HTMLElement) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    maxTextSize: MAX_SOURCE,
    secure: [
      ...new Set([
        ...(mermaid.mermaidAPI.defaultConfig.secure ?? []),
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "htmlLabels",
        "flowchart",
        "themeCSS",
        "themeVariables",
        "dompurifyConfig",
        "fontFamily",
        "altFontFamily",
      ]),
    ],
  });
  let active = true;
  let pending: string | undefined;
  let rendering = false;
  let sequence = 0;
  const size = () => {
    const measured = root.getBoundingClientRect().height;
    const height = Number.isFinite(measured) ? Math.max(1, Math.min(10000, Math.ceil(measured))) : 1;
    window.parent.postMessage({ type: "size", height }, "*");
  };
  const fallback = (message: string, source: string) => {
    const label = document.createElement("p");
    label.textContent = message;
    const text = document.createElement("pre");
    text.textContent = source;
    root.replaceChildren(label, text);
  };
  const draw = async () => {
    if (rendering) return;
    rendering = true;
    try {
      while (active && pending !== undefined) {
        const source = pending;
        pending = undefined;
        if (source.length > MAX_SOURCE) {
          fallback("This diagram is too large to draw.", source);
          size();
          continue;
        }
        const staging = document.createElement("div");
        staging.style.visibility = "hidden";
        staging.style.position = "absolute";
        root.append(staging);
        try {
          const result = await mermaid.render(`diagram-${++sequence}`, source, staging);
          if (active && pending === undefined) root.replaceChildren(sanitizeSvg(result.svg));
        } catch {
          if (active && pending === undefined) fallback("This diagram could not be drawn.", source);
        } finally {
          staging.remove();
        }
        if (active) size();
      }
    } finally {
      rendering = false;
    }
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const data: unknown = event.data;
    if (
      !data ||
      typeof data !== "object" ||
      !("type" in data) ||
      data.type !== "render" ||
      !("source" in data) ||
      typeof data.source !== "string"
    )
      return;
    pending = data.source;
    void draw();
  };
  const observer = new ResizeObserver(size);
  observer.observe(root);
  window.addEventListener("message", receive);
  return () => {
    active = false;
    pending = undefined;
    observer.disconnect();
    window.removeEventListener("message", receive);
  };
}
const root = document.getElementById("diagram");
if (root) startFrame(root);

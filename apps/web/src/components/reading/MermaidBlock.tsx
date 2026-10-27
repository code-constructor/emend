import { useEffect, useRef, useState } from "react";

export function MermaidBlock({ source }: { source: string }) {
  return <DiagramFrame key={source} source={source} />;
}
function DiagramFrame({ source }: { source: string }) {
  const loaded = useRef(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
      const data: unknown = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("type" in data) ||
        data.type !== "size" ||
        !("height" in data) ||
        typeof data.height !== "number" ||
        !Number.isFinite(data.height) ||
        data.height < 1 ||
        data.height > 10000
      )
        return;
      setHeight(data.height);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return (
    <div className="space-y-2">
      <iframe
        ref={frame}
        title="Diagram"
        loading="lazy"
        src="/mermaid-frame.html"
        sandbox="allow-scripts"
        className="w-full border-0"
        style={{ height }}
        onLoad={() => {
          if (loaded.current) return;
          loaded.current = true;
          frame.current?.contentWindow?.postMessage({ type: "render", source }, "*");
        }}
      />
      <details>
        <summary className="cursor-pointer text-sm text-neutral-500 dark:text-neutral-400">Diagram source</summary>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">{source}</pre>
      </details>
    </div>
  );
}

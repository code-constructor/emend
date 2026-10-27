import { BRIDGE_SOURCE } from "./bridge.ts";

export function injectBridge(html: string): string {
  const script = `<script>${BRIDGE_SOURCE}</script>`;
  // A </body> after the real close in a script string, comment or attribute takes the bridge, so that doc has none.
  let at = -1;
  for (const match of html.matchAll(/<\/body>/gi)) at = match.index;
  return at < 0 ? html + script : html.slice(0, at) + script + html.slice(at);
}

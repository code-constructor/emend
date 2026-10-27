import { join } from "node:path";
import type { Plugin } from "vite";

const unused = join(import.meta.dirname, "build/unused-diff-backend.ts");
const registry = join(import.meta.dirname, "build/worker-registries.ts");

/** The pinned library sends resolved grammars/themes to its shiki-js workers. */
export function diffBuildPruning(worker = false): Plugin {
  return {
    name: "diff-js-backend",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "shiki/engine/oniguruma" || source === "shiki/wasm" || /^@pierre\/highlights(?:\/|$)/.test(source))
        return unused;
      if (importer?.includes("/@pierre/diffs/") && /^\.\/(?:backends\/highlights|highlights-[\w-]+)\.js$/.test(source))
        return unused;
      if (worker && (source === "shiki/langs" || source === "@pierre/theming/themes")) return registry;
    },
  };
}

import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await build({
  entryPoints: [fileURLToPath(new URL("./src/cli.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/emend.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["node:*"],
});

const webOutput = new URL("./dist/web", import.meta.url);
await rm(webOutput, { recursive: true, force: true });
await cp(new URL("../web/dist", import.meta.url), webOutput, { recursive: true });

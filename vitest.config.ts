import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const globalSetup = fileURLToPath(new URL("./test/global-setup.ts", import.meta.url));
const isolationTest = fileURLToPath(new URL("./test/state-isolation.test.ts", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      ...["packages/contract", "packages/core", "apps/emend"].map((root) => ({
        test: {
          name: root,
          root,
          environment: "node",
          globalSetup,
          include: ["src/**/*.test.ts", isolationTest],
        },
      })),
      {
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "apps/web",
          root: "apps/web",
          environment: "happy-dom",
          globalSetup,
          include: ["src/**/*.test.{ts,tsx}", isolationTest],
        },
      },
    ],
  },
});

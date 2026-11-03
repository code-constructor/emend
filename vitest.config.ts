import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const globalSetup = fileURLToPath(new URL("./test/global-setup.ts", import.meta.url));
const isolationTest = fileURLToPath(new URL("./test/state-isolation.test.ts", import.meta.url));
const launcherTest = fileURLToPath(new URL("./test/launcher.test.ts", import.meta.url));
const skillsTest = fileURLToPath(new URL("./test/skills.test.ts", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      ...["packages/contract", "packages/core", "apps/emend"].map((root) => ({
        test: {
          name: root,
          root,
          environment: "node",
          globalSetup,
          include: ["src/**/*.test.ts", isolationTest, ...(root === "apps/emend" ? [launcherTest, skillsTest] : [])],
        },
      })),
      {
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "apps/web",
          root: "apps/web",
          environment: "happy-dom",
          globalSetup,
          setupFiles: [fileURLToPath(new URL("./apps/web/src/test/setup.ts", import.meta.url))],
          include: ["src/**/*.test.{ts,tsx}", isolationTest],
        },
      },
    ],
  },
});

import mermaid from "mermaid";
import { afterEach, expect, test } from "vitest";
import { frameConfig } from "../mermaid-frame.ts";

afterEach(() => mermaid.mermaidAPI.globalReset());

test.each([
  '%%{init: {"theme": "dark", "securityLevel": "loose"}}%%\nflowchart TD; A-->B; click A evil "click"',
  '%%{init: {"sequence": {"theme": "dark"}}}%%\nsequenceDiagram\nAlice->>Bob: Synthetic message',
])("real Mermaid keeps the frame theme and security level after parsing %s", async (source) => {
  mermaid.initialize(frameConfig(false));
  const sequenceTheme = mermaid.mermaidAPI.getConfig().sequence?.theme;
  await expect(mermaid.parse(source)).resolves.toBeTruthy();
  expect(mermaid.mermaidAPI.getConfig()).toMatchObject({ theme: "base", securityLevel: "strict" });
  expect(mermaid.mermaidAPI.getConfig().sequence?.theme).toBe(sequenceTheme);
});

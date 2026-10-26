import { expect, test, vi } from "vitest";

test("a rejected processor initialization is retried and concurrent callers share the retry", async () => {
  vi.resetModules();
  const actual = await import("shiki/core");
  const initialize = vi
    .fn(actual.createHighlighterCore)
    .mockRejectedValueOnce(new Error("synthetic initialization failure"));
  vi.doMock("shiki/core", () => ({ ...actual, createHighlighterCore: initialize }));
  try {
    const { renderMarkdown } = await import("./markdown.ts");
    await expect(renderMarkdown("First", "overview")).rejects.toThrow("synthetic initialization failure");
    const [second, third] = await Promise.all([
      renderMarkdown("Second", "overview"),
      renderMarkdown("Third", "overview"),
    ]);
    expect(second[0]?.text).toBe("Second");
    expect(third[0]?.text).toBe("Third");
    expect(initialize).toHaveBeenCalledTimes(2);
  } finally {
    vi.doUnmock("shiki/core");
    vi.resetModules();
  }
});

import { expect, test } from "vitest";
import { APP_CSP, headersForPath } from "./headers.ts";

test("only the exact Mermaid frame path gets the frame CSP and SAMEORIGIN", () => {
  const shared = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  expect(headersForPath("/mermaid-frame.html")).toEqual({
    ...shared,
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:",
    "X-Frame-Options": "SAMEORIGIN",
  });
  for (const path of ["/", "/r/synthetic", "/assets/mermaid.js", "/mermaid-frame.html/", "/another/mermaid-frame.html"])
    expect(headersForPath(path)).toEqual({ ...shared, "Content-Security-Policy": APP_CSP, "X-Frame-Options": "DENY" });
  expect(headersForPath("/api/v1/reviews")).toEqual({
    ...shared,
    "Content-Security-Policy": APP_CSP,
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
  });
});

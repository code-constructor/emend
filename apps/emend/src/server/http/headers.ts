import type { Context } from "hono";

export const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const isApiPath = (path: string) => path === "/api/v1" || path.startsWith("/api/v1/");
export const MERMAID_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:";
export function headersForPath(path: string): Record<string, string> {
  if (path.startsWith("/content/")) return { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
  return {
    "Content-Security-Policy": path === "/mermaid-frame.html" ? MERMAID_CSP : APP_CSP,
    "X-Frame-Options": path === "/mermaid-frame.html" ? "SAMEORIGIN" : "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...(isApiPath(path) ? { "Cache-Control": "no-store" } : {}),
  };
}
export function responseHeaders(c: Context) {
  for (const [name, value] of Object.entries(headersForPath(c.req.path))) c.header(name, value);
}

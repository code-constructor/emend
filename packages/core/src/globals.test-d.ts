// These compile-time assertions fail if browser-only globals leak into core.
// @ts-expect-error Core cannot access the browser document.
export type BrowserDocumentIsUnavailable = typeof document;
// @ts-expect-error Core cannot access the browser window.
export type BrowserWindowIsUnavailable = typeof window;

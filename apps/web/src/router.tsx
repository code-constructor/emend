import { createRootRoute, createRoute, createRouter, Link, Outlet, type RouterHistory } from "@tanstack/react-router";
import { DevicesPage } from "./routes/devices.tsx";
import { InboxPage } from "./routes/inbox.tsx";
import { PairPage } from "./routes/pair.tsx";
import { ReviewPage } from "./routes/review.tsx";

export type ReviewSearch = { rev?: number; tab: "writeup" | "diff" | "docs" | "comments"; thread?: string };
export function validateReviewSearch(input: Record<string, unknown>): ReviewSearch {
  const rev = typeof input.rev === "string" || typeof input.rev === "number" ? Number(input.rev) : NaN;
  const tab = input.tab === "diff" || input.tab === "docs" || input.tab === "comments" ? input.tab : "writeup";
  return {
    tab,
    // Router merges validation over the raw search: explicitly clear rejected values.
    rev: Number.isSafeInteger(rev) && rev > 0 ? rev : undefined,
    thread:
      typeof input.thread === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.thread)
        ? input.thread
        : undefined,
  };
}
const root = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <main className="p-6">
      <h1>Page not found</h1>
      <Link to="/">Inbox</Link>
    </main>
  ),
});
const inbox = createRoute({ getParentRoute: () => root, path: "/", component: InboxPage });
const review = createRoute({
  getParentRoute: () => root,
  path: "/r/$reviewId",
  validateSearch: validateReviewSearch,
  component: ReviewPage,
});
const pair = createRoute({ getParentRoute: () => root, path: "/pair", component: PairPage });
const devices = createRoute({ getParentRoute: () => root, path: "/devices", component: DevicesPage });
export const createWebRouter = (history?: RouterHistory) =>
  createRouter({ routeTree: root.addChildren([inbox, review, pair, devices]), history, search: { strict: true } });
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createWebRouter>;
  }
}

import { LIMITS, type Scope } from "@emend/contract";
import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import type { Instance } from "../state/instance.ts";
import type { BlobStore } from "../store/blobs.ts";
import { type AppEnv, requireScope } from "./auth/principal.ts";
import { sessionCookie, verifySession, writeSessionCookie } from "./auth/sessions.ts";
import { verifyBearer } from "./auth/tokens.ts";
import { ReviewEvents } from "./events.ts";
import { checkContentLength, limitJsonBody } from "./http/body.ts";
import { clientVersion } from "./http/client-version.ts";
import { ApiError, errorResponse } from "./http/errors.ts";
import { isApiPath, responseHeaders } from "./http/headers.ts";
import { hostGuard } from "./http/host-guard.ts";
import { originGuard } from "./http/origin-guard.ts";
import { appPage } from "./http/pages.ts";
import type { Executor } from "./publish/work.ts";
import { blobRoutes } from "./routes/blobs.ts";
import { capabilitiesRoutes } from "./routes/capabilities.ts";
import { commentRoutes } from "./routes/comments.ts";
import { deliveryRoutes } from "./routes/deliveries.ts";
import { eventRoutes } from "./routes/events.ts";
import { pairingRoutes } from "./routes/pairings.ts";
import { publishRoutes } from "./routes/publish.ts";
import { sendRoutes } from "./routes/sends.ts";
import { sessionRoutes } from "./routes/session.ts";
import { threadRoutes } from "./routes/threads.ts";

export interface AppDeps {
  db: Db;
  blobs: BlobStore;
  instance: Instance;
  now: () => number;
  publishExecutor?: Executor;
  events?: ReviewEvents;
  config: {
    serverKey: string;
    allowedHosts: string[];
    appOrigins: string[];
    secureCookies: boolean;
    baseUrl: string;
    webRoot: string;
  };
}
export const ENDPOINTS = [
  { method: "GET", path: "/api/v1/capabilities", scope: "public" },
  { method: "POST", path: "/api/v1/session", scope: "public" },
  { method: "DELETE", path: "/api/v1/session", scope: "read" },
  { method: "POST", path: "/api/v1/pairings", scope: "pairings:create" },
  { method: "GET", path: "/api/v1/devices", scope: "devices:manage" },
  { method: "DELETE", path: "/api/v1/devices/:id", scope: "devices:manage" },
  { method: "POST", path: "/api/v1/machines", scope: "public" },
  { method: "DELETE", path: "/api/v1/machines/self", scope: "publish" },
  { method: "HEAD", path: "/api/v1/blobs/:sha256", scope: "publish" },
  { method: "PUT", path: "/api/v1/blobs/:sha256", scope: "publish" },
  { method: "POST", path: "/api/v1/publish", scope: "publish" },
  { method: "POST", path: "/api/v1/import", scope: "publish" },
  { method: "GET", path: "/api/v1/reviews", scope: "read" },
  { method: "GET", path: "/api/v1/reviews/:id", scope: "read" },
  { method: "GET", path: "/api/v1/reviews/:id/revisions/:seq", scope: "read" },
  { method: "GET", path: "/api/v1/files/:fileId/old", scope: "read" },
  { method: "GET", path: "/api/v1/files/:fileId/new", scope: "read" },
  { method: "GET", path: "/api/v1/reviews/:id/events", scope: "read" },
  { method: "POST", path: "/api/v1/reviews/:id/threads", scope: "comment" },
  { method: "POST", path: "/api/v1/threads/:id/comments", scope: "comment" },
  { method: "PATCH", path: "/api/v1/comments/:id", scope: "comment" },
  { method: "DELETE", path: "/api/v1/comments/:id", scope: "comment" },
  { method: "POST", path: "/api/v1/threads/:id/resolve", scope: "comment" },
  { method: "POST", path: "/api/v1/threads/:id/reopen", scope: "comment" },
  { method: "POST", path: "/api/v1/reviews/:id/sends", scope: "send" },
  { method: "POST", path: "/api/v1/reviews/:id/take", scope: "take" },
  { method: "POST", path: "/api/v1/deliveries/:id/confirm", scope: "take" },
  { method: "POST", path: "/api/v1/comments/:id/reply", scope: "reply" },
  { method: "GET", path: "/content/:contentKey/*", scope: "public" },
] as const satisfies readonly { method: string; path: string; scope: Scope | "public" }[];
const endpointMatchers = ENDPOINTS.map((entry) => ({
  ...entry,
  match: new RegExp(`^${entry.path.replace(/:[^/]+/g, "[^/]+").replace(/\*/g, ".*")}$`),
}));

export function createApp(deps: AppDeps) {
  deps.events ??= new ReviewEvents(deps.now);
  const app = new Hono<AppEnv>({ strict: true });
  app.onError((error, c) => {
    responseHeaders(c);
    if (error instanceof ApiError) return errorResponse(c, error.code, error.detail);
    console.error("emend: internal server error");
    return errorResponse(c, "internal");
  });
  app.notFound((c) => errorResponse(c, "not_found"));
  app.use("*", async (c, next) => {
    // Response decoration also covers guard refusals through onError.
    hostGuard(c, deps.config.allowedHosts);
    responseHeaders(c);
    clientVersion(c);
    originGuard(c, deps.config.appOrigins);
    if (!isApiPath(c.req.path)) return next();
    const endpoint =
      endpointMatchers.find((entry) => entry.method === c.req.method && entry.match.test(c.req.path)) ??
      (c.req.method === "HEAD"
        ? endpointMatchers.find((entry) => entry.method === "GET" && entry.match.test(c.req.path))
        : undefined);
    const json = endpoint && ["POST", "PATCH"].includes(c.req.method);
    const limit =
      c.req.path === "/api/v1/publish"
        ? LIMITS.publishJsonBytes
        : ["/api/v1/session", "/api/v1/machines"].includes(c.req.path)
          ? LIMITS.publicJsonBytes
          : LIMITS.requestJsonBytes;
    if (json) checkContentLength(c, limit);
    if (c.req.method === "PUT" && c.req.path.startsWith("/api/v1/blobs/")) checkContentLength(c, LIMITS.htmlDocBytes);
    if (endpoint?.scope !== "public") {
      const authorization = c.req.header("Authorization");
      let principal = authorization !== undefined ? await verifyBearer(deps.db, authorization, deps.now()) : null;
      if (authorization === undefined) {
        const secret = sessionCookie(c);
        const session = await verifySession(deps.db, secret, deps.now());
        if (session) {
          principal = session.principal;
          if (session.renew && secret) writeSessionCookie(c, secret, deps.config.secureCookies);
        }
      }
      if (!principal) throw new ApiError("unauthorized");
      c.set("principal", principal);
      if (endpoint) requireScope(c, endpoint.scope);
    }
    if (!endpoint) throw new ApiError("not_found");
    if (json) await limitJsonBody(c, limit);
    await next();
  });
  capabilitiesRoutes(app, deps.config.serverKey);
  pairingRoutes(app, deps);
  sessionRoutes(app, deps);
  blobRoutes(app, deps);
  publishRoutes(app, deps);
  threadRoutes(app, deps);
  commentRoutes(app, deps);
  sendRoutes(app, deps);
  deliveryRoutes(app, deps);
  eventRoutes(app, deps);
  app.get("*", (c) => {
    if (isApiPath(c.req.path) || c.req.path.startsWith("/content/")) throw new ApiError("not_found");
    return appPage(c, deps.config.webRoot);
  });
  return app;
}

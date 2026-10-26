import type { Context } from "hono";
import { sessionCookie } from "../auth/sessions.ts";
import { ApiError } from "./errors.ts";
export function originGuard(c: Context, appOrigins: readonly string[]) {
  if (c.req.method === "GET" || c.req.method === "HEAD") return;
  const origin = c.req.header("Origin");
  const hasSession = !c.req.path.startsWith("/content/") && sessionCookie(c) !== undefined;
  if ((origin !== undefined && !appOrigins.includes(origin)) || (hasSession && origin === undefined))
    throw new ApiError("bad_origin");
}

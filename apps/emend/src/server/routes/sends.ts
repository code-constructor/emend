import { SendRequest } from "@emend/contract";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";
import { createSend } from "../mailbox/sends.ts";

export function sendRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.post("/api/v1/reviews/:id/sends", async (c) => {
    const result = await createSend(
      c.get("principal").ownerId,
      deps.db,
      c.req.param("id"),
      parseBody(c, SendRequest),
      deps.now(),
    );
    deps.events?.emit({ type: "send", ...result });
    return c.json({ sendId: result.sendId }, 201);
  });
}

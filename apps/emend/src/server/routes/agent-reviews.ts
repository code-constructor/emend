import type { Hono } from "hono";
import { listAgentReviews } from "../../db/repo/agent-reviews.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";

export function agentReviewRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/agent/reviews", async (c) =>
    c.json(await listAgentReviews(deps.db, c.get("principal"), deps.config.baseUrl)),
  );
}

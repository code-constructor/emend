import { SessionRequest } from "@emend/contract";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import { codeLockout, redeemPairing } from "../auth/pairings.ts";
import type { AppEnv } from "../auth/principal.ts";
import { revokeSession, writeSessionCookie } from "../auth/sessions.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
export function sessionRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  const lock = codeLockout();
  // Serialize code checks with redemption so queued guesses cannot cross the lock boundary.
  let queue = Promise.resolve();
  app.post("/api/v1/session", async (c) => {
    const input = parseBody(c, SessionRequest);
    const redeem = async () => {
      const now = deps.now();
      if (input.code !== undefined) lock.check(now);
      try {
        return await redeemPairing(deps.db, input, now, c.req.header("User-Agent"));
      } catch (error) {
        if (input.code !== undefined && error instanceof ApiError && error.code === "unauthorized") lock.fail(now);
        throw error;
      }
    };
    let token: Awaited<ReturnType<typeof redeem>>;
    if (input.code !== undefined) {
      const pending = queue.then(redeem);
      queue = pending.then(
        () => {},
        () => {},
      );
      token = await pending;
    } else token = await redeem();
    writeSessionCookie(c, token.secret, deps.config.secureCookies);
    return c.body(null, 204);
  });
  app.delete("/api/v1/session", async (c) => {
    await revokeSession(deps.db, c.get("principal"), deps.now());
    writeSessionCookie(c, "", deps.config.secureCookies, true);
    return c.body(null, 204);
  });
}

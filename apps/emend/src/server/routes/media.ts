import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { files } from "../../db/schema.ts";
import type { AppDeps } from "../app.ts";
import type { AppEnv } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";

const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

/** Serves writeup images by content hash, to the owner only, with a locked-down response. */
export function mediaRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.get("/api/v1/media/:sha256", async (c) => {
    const ownerId = c.get("principal").ownerId;
    const hash = c.req.param("sha256");
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ApiError("not_found");
    const { type, bytes } = await deps.db.read(async (q) => {
      const file = await q
        .select({ mediaType: files.mediaType })
        .from(files)
        .where(
          and(
            eq(files.ownerId, ownerId),
            eq(files.role, "asset"),
            eq(files.newBlob, hash),
            // Only writeup media: an HTML doc's own assets load from its content path.
            isNull(files.parentDocId),
            inArray(files.mediaType, MEDIA_TYPES),
          ),
        )
        // The same bytes can sit under two image types; pick one type deterministically.
        .orderBy(files.mediaType)
        .limit(1)
        .get();
      if (!file) throw new ApiError("not_found");
      const bytes = await deps.blobs.get(ownerId, hash, q);
      if (!bytes) throw new ApiError("not_found");
      return { type: file.mediaType, bytes };
    });
    // The app-wide middleware set its defaults earlier; these replace them for this route only.
    c.header("Content-Type", type);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", "sandbox; default-src 'none'");
    c.header("Content-Disposition", "inline");
    return c.body(new Uint8Array(bytes));
  });
}

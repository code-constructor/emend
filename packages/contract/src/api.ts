import { z } from "zod";
import { LIMITS } from "./limits.ts";

export const API_PREFIX = "/api/v1";
export const MIN_CLIENT_VERSION = "0.1.0";

export const Capabilities = z.object({
  api: z.literal(1),
  version: z.string().min(1).max(LIMITS.versionChars),
  features: z.array(z.string().max(LIMITS.featureChars)).max(LIMITS.featuresCount),
});
export type Capabilities = z.infer<typeof Capabilities>;

import { z } from "zod";

/** Call before loading schemas: Zod captures the JIT setting when constructing objects. */
export function configureBrowserValidation() {
  z.config({ jitless: true });
}

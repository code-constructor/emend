import { z } from "zod";

// Share the Zod instance configured jitless here: the app CSP forbids eval.
export { z };

/** Call before loading schemas: Zod captures the JIT setting when constructing objects. */
export function configureBrowserValidation() {
  z.config({ jitless: true });
}

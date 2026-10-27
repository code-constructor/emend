import type { Io } from "../../main.ts";
import { CliUsageError } from "../http.ts";
import { resolveTarget } from "../target.ts";
import { deliverFeedback, ReviewId, takeFeedback } from "./wait.ts";

export async function feedbackCommand(stateDir: string, args: string[], io: Io) {
  const parsed = ReviewId.safeParse(args[0]);
  if (args.length !== 1 || !parsed.success) throw new CliUsageError("Usage: emend feedback <review>.");
  const target = await resolveTarget(stateDir);
  await deliverFeedback(stateDir, target, await takeFeedback(stateDir, target, parsed.data, 0), io);
}

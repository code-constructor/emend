import type { Io } from "../../main.ts";
import { checkSaveFolder } from "../save-feedback.ts";
import { resolveTarget } from "../target.ts";
import { deliverFeedback, parseFeedbackArgs, takeFeedback } from "./wait.ts";

export async function feedbackCommand(stateDir: string, args: string[], io: Io) {
  const { reviewId, saveFolder } = parseFeedbackArgs("feedback", args);
  const folder = saveFolder ? await checkSaveFolder(saveFolder, stateDir) : undefined;
  try {
    const target = await resolveTarget(stateDir);
    await deliverFeedback(stateDir, target, await takeFeedback(stateDir, target, reviewId, 0), io, undefined, folder);
  } finally {
    await folder?.handle.close().catch(() => {});
  }
}

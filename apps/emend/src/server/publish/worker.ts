import { parentPort } from "node:worker_threads";
import { executeWork, type Work } from "./work.ts";

parentPort?.on("message", async (work: Work) => {
  try {
    const result = await executeWork(work);
    parentPort?.postMessage(
      { ok: true, result },
      "ids" in result ? [result.bytes, result.ids] : "bytes" in result ? [result.bytes] : [],
    );
  } catch {
    parentPort?.postMessage({ ok: false });
  }
});

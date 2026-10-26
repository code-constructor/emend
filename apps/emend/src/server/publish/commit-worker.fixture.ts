import { parentPort } from "node:worker_threads";
import { LIMITS } from "@emend/contract";
import { type Block, blockHash } from "@emend/core";
import { executeWork, serializeRendered, type Work, type WorkResult } from "./work.ts";

// Synthetic cap-sized renderer input; production serialization, parsing and placement
// still run in a real worker, with the production executor and transfer protocol.
parentPort?.on("message", async (work: Work) => {
  try {
    let result: WorkResult;
    if (work.kind === "writeup" || work.kind === "doc") {
      const section = work.kind === "writeup" ? "overview" : `doc-${await blockHash(work.path)}`;
      const source = work.kind === "writeup" ? work.source.overview : new TextDecoder().decode(work.source);
      const offset = source === "second" ? LIMITS.blocksPerRevision : 0;
      const blocks: Block[] = Array.from(
        { length: LIMITS.blocksPerRevision / (work.kind === "writeup" ? 2 : 4) },
        (_, i) => ({
          id: `${section}-${(i + offset).toString(16).padStart(8, "0")}`,
          section,
          kind: "paragraph",
          html: "<p>needle</p>",
          text: "needle",
        }),
      );
      result = {
        kind: work.kind,
        ...serializeRendered(
          work.kind === "doc"
            ? blocks
            : {
                sections: [{ key: "overview", label: "Overview", topic: null, blocks }],
              },
        ),
      };
    } else result = await executeWork(work);
    parentPort?.postMessage(
      { ok: true, result },
      "ids" in result ? [result.bytes, result.ids] : "bytes" in result ? [result.bytes] : [],
    );
  } catch {
    parentPort?.postMessage({ ok: false });
  }
});

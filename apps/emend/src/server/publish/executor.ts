import { Worker } from "node:worker_threads";
import type { Executor } from "./work.ts";

export class WorkTimeout extends Error {}
export type WorkerExecutor = Executor & { close(): Promise<void> };
export function workerExecutor(timeouts = { render: 10000, place: 30000 }): WorkerExecutor {
  let worker: Worker | undefined;
  let busy = false;
  const close = async () => {
    const current = worker;
    worker = undefined;
    if (current) await current.terminate();
  };
  const execute: Executor = (work) =>
    new Promise((resolve, reject) => {
      if (busy) {
        reject(new Error("Worker already busy"));
        return;
      }
      busy = true;
      if (!worker) {
        worker = new Worker(
          new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./publish-worker.mjs", import.meta.url),
          { resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } },
        );
        const created = worker;
        // Exits while idle must also invalidate the cached worker without an unhandled error.
        created.on("error", () => {});
        created.once("exit", () => {
          if (worker === created) worker = undefined;
        });
      }
      const current = worker;
      const finish = () => {
        clearTimeout(timer);
        current.removeListener("message", message);
        current.removeListener("error", failed);
        current.removeListener("exit", failed);
        busy = false;
        current.unref();
      };
      const failed = () => {
        finish();
        void close();
        reject(new Error("Worker failed"));
      };
      const message = (value: { ok: boolean; result: Awaited<ReturnType<Executor>> }) => {
        if (!value?.ok) {
          failed();
          return;
        }
        finish();
        resolve(value.result);
      };
      const timer = setTimeout(
        () => {
          finish();
          void close();
          reject(new WorkTimeout());
        },
        work.kind === "place" || work.kind === "placement-doc" ? timeouts.place : timeouts.render,
      );
      current.once("message", message);
      current.once("error", failed);
      current.once("exit", failed);
      current.ref();
      try {
        const buffers =
          work.kind === "doc"
            ? [work.source]
            : work.kind === "resection" || work.kind === "placement-doc" || work.kind === "writeup-source"
              ? [work.bytes]
              : work.kind === "changed"
                ? [...work.previous.map((blob) => blob.bytes), ...work.next]
                : work.kind === "place"
                  ? [
                      ...work.texts.values(),
                      ...[...(work.parsedDocs?.values() ?? [])].map((doc) => doc.bytes),
                      ...(work.parsedWriteup ? [work.parsedWriteup.bytes] : []),
                    ]
                  : [];
        current.postMessage(work, [...new Set(buffers)]);
      } catch {
        failed();
      }
    });
  return Object.assign(execute, { close });
}

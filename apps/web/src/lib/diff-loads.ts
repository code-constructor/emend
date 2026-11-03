import type { QueryClient } from "@tanstack/react-query";

type Job = { run: () => Promise<void>; cancel: () => void; signal: AbortSignal };
const queues = new WeakMap<QueryClient, ReturnType<typeof createQueue>>();
function createQueue() {
  let foreground = 0,
    active = 0;
  const waiting: Job[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer !== undefined) return;
    // Let viewport observations and their foreground loads commit first.
    timer = setTimeout(() => {
      timer = undefined;
      while (!foreground && active < 3 && waiting.length) {
        const job = waiting.shift();
        if (!job) break;
        job.signal.removeEventListener("abort", job.cancel);
        if (job.signal.aborted) {
          job.cancel();
          continue;
        }
        active++;
        void job.run().finally(() => {
          active--;
          schedule();
        });
      }
    }, 0);
  };
  return {
    hold() {
      foreground++;
      return () => {
        foreground--;
        schedule();
      };
    },
    run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        const job: Job = {
          signal,
          run: async () => {
            try {
              resolve(await task());
            } catch (error) {
              reject(error);
            }
          },
          cancel: () => {
            const index = waiting.indexOf(job);
            if (index >= 0) waiting.splice(index, 1);
            reject(new DOMException("Aborted", "AbortError"));
          },
        };
        if (signal.aborted) {
          job.cancel();
          return;
        }
        waiting.push(job);
        signal.addEventListener("abort", job.cancel, { once: true });
        schedule();
      });
    },
  };
}
export function diffLoads(client: QueryClient) {
  let queue = queues.get(client);
  if (!queue) {
    queue = createQueue();
    queues.set(client, queue);
  }
  return queue;
}

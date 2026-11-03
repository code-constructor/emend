import { vi } from "vitest";

export class Events extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static opened: Events[] = [];
  readonly url: string;
  readyState = Events.CONNECTING;
  constructor(url: string) {
    super();
    this.url = url;
    Events.opened.push(this);
  }
  close = vi.fn(() => {
    this.readyState = Events.CLOSED;
  });
  open() {
    this.readyState = Events.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  fail(state = Events.CLOSED) {
    this.readyState = state;
    this.dispatchEvent(new Event("error"));
  }
  emit(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

export class Channel extends EventTarget {
  static opened: Channel[] = [];
  readonly name: string;
  closed = false;
  constructor(name: string) {
    super();
    this.name = name;
    Channel.opened.push(this);
  }
  postMessage(data: unknown) {
    for (const peer of Channel.opened) {
      if (peer === this || peer.name !== this.name || peer.closed) continue;
      const copy: unknown = structuredClone(data);
      queueMicrotask(() => {
        if (!peer.closed) peer.dispatchEvent(new MessageEvent("message", { data: copy }));
      });
    }
  }
  close() {
    this.closed = true;
  }
}

type Job = { start: () => void; reject: (reason: unknown) => void; signal?: AbortSignal; abort: () => void };
export class Locks {
  private held = new Set<string>();
  private queued = new Map<string, Job[]>();
  request(name: string, options: LockOptions, callback: (lock: Lock) => Promise<void> | void) {
    return new Promise<void>((resolve, reject) => {
      const queue = this.queued.get(name) ?? [];
      this.queued.set(name, queue);
      const job: Job = {
        signal: options.signal,
        reject,
        abort: () => {
          const index = queue.indexOf(job);
          if (index !== -1) queue.splice(index, 1);
          reject(new DOMException("Cancelled", "AbortError"));
        },
        start: () => {
          void Promise.resolve()
            .then(() => callback({ name, mode: "exclusive" }))
            .then(resolve, reject)
            .finally(() => {
              this.held.delete(name);
              this.drain(name);
            });
        },
      };
      if (options.signal?.aborted) {
        job.abort();
        return;
      }
      options.signal?.addEventListener("abort", job.abort, { once: true });
      queue.push(job);
      this.drain(name);
    });
  }
  private drain(name: string) {
    if (this.held.has(name)) return;
    const job = this.queued.get(name)?.shift();
    if (!job) return;
    this.held.add(name);
    job.signal?.removeEventListener("abort", job.abort);
    job.start();
  }
}

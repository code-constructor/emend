import { LIMITS, ReviewEvent } from "@emend/contract";
import { ApiError } from "./http/errors.ts";

type Listener = (event: ReviewEvent) => void;
type Waiting = { active: number; revision: number; until: number; timer?: ReturnType<typeof setTimeout> };

export class ReviewEvents {
  private listeners = new Map<string, Set<Listener>>();
  private waiting = new Map<string, Waiting>();
  private streams = new Map<string, number>();
  private waitingByOwner = new Map<string, number>();
  private now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }

  subscribe(reviewId: string, listener: Listener) {
    let listeners = this.listeners.get(reviewId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(reviewId, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(reviewId);
    };
  }
  emit(value: ReviewEvent) {
    // Strip any accidental content fields even when the caller isn't type checked.
    const event = ReviewEvent.parse(value);
    const waiting = this.waiting.get(event.reviewId);
    if (waiting) waiting.revision = Math.max(waiting.revision, event.revision);
    for (const listener of [...(this.listeners.get(event.reviewId) ?? [])]) listener(event);
  }
  agentWaiting(reviewId: string) {
    const state = this.waiting.get(reviewId);
    if (!state) return false;
    if (state.active || state.until > this.now()) return true;
    clearTimeout(state.timer);
    this.waiting.delete(reviewId);
    this.emit({ type: "waiting", reviewId, revision: state.revision });
    return false;
  }
  beginWaiting(ownerId: string, reviewId: string, revision: number) {
    const count = this.waitingByOwner.get(ownerId) ?? 0;
    if (count >= LIMITS.waitingTakesPerOwner) throw new ApiError("rate_limited", "waiting_takes");
    this.waitingByOwner.set(ownerId, count + 1);
    const wasWaiting = this.agentWaiting(reviewId);
    const state = this.waiting.get(reviewId) ?? { active: 0, revision, until: 0 };
    clearTimeout(state.timer);
    state.active++;
    state.revision = Math.max(state.revision, revision);
    this.waiting.set(reviewId, state);
    if (!wasWaiting) this.emit({ type: "waiting", reviewId, revision: state.revision });
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const remaining = (this.waitingByOwner.get(ownerId) ?? 1) - 1;
      if (remaining) this.waitingByOwner.set(ownerId, remaining);
      else this.waitingByOwner.delete(ownerId);
      state.active--;
      if (!state.active) {
        state.until = this.now() + 35000;
        const expire = () => {
          if (this.agentWaiting(reviewId) && !state.active) {
            state.timer = setTimeout(expire, Math.max(1, state.until - this.now()));
            state.timer.unref();
          }
        };
        state.timer = setTimeout(expire, 35000);
        state.timer.unref();
      }
    };
  }
  waitForSend(reviewId: string, seconds: number, signal?: AbortSignal) {
    let finish = () => {};
    const promise = new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe(reviewId, (event) => {
        if (event.type === "send") finish();
      });
      const timer = setTimeout(() => finish(), seconds * 1000);
      finish = () => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
    return { promise, cancel: () => finish() };
  }
  stream(
    ownerId: string,
    reviewId: string,
    signal?: AbortSignal,
    isLive: () => Promise<boolean> = async () => true,
  ): ReadableStream<Uint8Array> {
    const count = this.streams.get(ownerId) ?? 0;
    if (count >= 32) throw new ApiError("rate_limited", "event_streams");
    this.streams.set(ownerId, count + 1);
    const encoder = new TextEncoder();
    let cleanup = () => {};
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          let closed = false;
          const unsubscribe = this.subscribe(reviewId, (event) => {
            const { type, ...data } = event;
            enqueue(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
          });
          let checking = false;
          const keepalive = async () => {
            if (checking || closed) return;
            checking = true;
            try {
              if (await isLive()) enqueue(": keepalive\n\n");
              else stop();
            } catch {
              stop();
            } finally {
              checking = false;
            }
          };
          const interval = setInterval(() => {
            void keepalive();
          }, 25000);
          interval.unref();
          const stop = () => {
            if (!closed) {
              cleanup();
              controller.close();
            }
          };
          cleanup = () => {
            if (closed) return;
            closed = true;
            unsubscribe();
            clearInterval(interval);
            signal?.removeEventListener("abort", stop);
            const remaining = (this.streams.get(ownerId) ?? 1) - 1;
            if (remaining) this.streams.set(ownerId, remaining);
            else this.streams.delete(ownerId);
          };
          const enqueue = (text: string) => {
            if (closed) return;
            if ((controller.desiredSize ?? 0) <= 0) {
              cleanup();
              controller.error(new Error("Event stream is too slow"));
            } else controller.enqueue(encoder.encode(text));
          };
          signal?.addEventListener("abort", stop, { once: true });
          if (signal?.aborted) stop();
          else enqueue(": connected\n\n");
        },
        cancel: () => cleanup(),
      },
      { highWaterMark: 100, size: () => 1 },
    );
  }
}

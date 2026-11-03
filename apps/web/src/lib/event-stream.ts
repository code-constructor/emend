import { ReviewEvent, ReviewEventName } from "@emend/contract";
import { ApiError, head } from "../api/client.ts";

type Notice = { kind: "open" } | { kind: "event"; type: string; data: string };

function parseNotice(value: unknown): ReviewEvent | "open" | null {
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  if (value.kind === "open" && Object.keys(value).length === 1) return "open";
  if (value.kind !== "event" || !("type" in value) || !("data" in value) || typeof value.data !== "string") return null;
  try {
    return ReviewEvent.parse({ ...JSON.parse(value.data), type: value.type });
  } catch {
    return null;
  }
}

function openSource(post: (notice: Notice) => void) {
  let source: EventSource | undefined;
  let stopped = false;
  let delay = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let probe: AbortController | undefined;
  let resumeAfterProbe = false;
  const schedule = () => {
    if (stopped || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, delay);
    delay = Math.min(delay * 2, 60_000);
  };
  const checkClosed = async (current: EventSource) => {
    if (stopped || source !== current || probe || retry !== undefined) return;
    probe = new AbortController();
    try {
      // EventSource hides HTTP errors. HEAD checks authorization without allocating a stream.
      await head("/api/v1/events", probe.signal);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        stopped = true;
        current.close();
      }
    } finally {
      probe = undefined;
      if (!stopped && source === current) {
        if (resumeAfterProbe) {
          resumeAfterProbe = false;
          connect();
        } else schedule();
      }
    }
  };
  const connect = () => {
    if (stopped) return;
    source?.close();
    let current: EventSource;
    try {
      current = new EventSource("/api/v1/events");
    } catch {
      source = undefined;
      schedule();
      return;
    }
    source = current;
    current.addEventListener("error", () => {
      if (current.readyState === EventSource.CLOSED) void checkClosed(current);
    });
    current.addEventListener("open", () => {
      if (stopped || source !== current) return;
      clearTimeout(retry);
      retry = undefined;
      delay = 1000;
      post({ kind: "open" });
    });
    for (const type of ReviewEventName.options) {
      current.addEventListener(type, (event: MessageEvent<string>) => {
        if (!stopped && source === current) post({ kind: "event", type, data: event.data });
      });
    }
  };
  const resume = () => {
    if (stopped) return;
    if (source && source.readyState !== EventSource.CLOSED) return;
    if (probe) {
      resumeAfterProbe = true;
      return;
    }
    clearTimeout(retry);
    retry = undefined;
    connect();
  };
  const visible = () => {
    if (document.visibilityState === "visible") resume();
  };
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", visible);
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    probe?.abort();
    source?.close();
    window.removeEventListener("online", resume);
    document.removeEventListener("visibilitychange", visible);
  };
}

/** One connection per origin where Web Locks and BroadcastChannel are available. */
export function subscribeReviewEvents(onEvent: (event: ReviewEvent) => void, onOpen: () => void) {
  let stopped = false;
  const receive = (value: unknown) => {
    if (stopped) return;
    const notice = parseNotice(value);
    if (notice === "open") onOpen();
    else if (notice) onEvent(notice);
  };
  if (!navigator.locks?.request || typeof BroadcastChannel === "undefined") return openSource(receive);
  const channel = new BroadcastChannel("emend-events");
  channel.addEventListener("message", (event: MessageEvent<unknown>) => receive(event.data));
  const abort = new AbortController();
  let stopSource: (() => void) | undefined;
  let release = () => {};
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  void navigator.locks
    .request("emend-events", { signal: abort.signal }, async () => {
      if (stopped) return;
      stopSource = openSource((notice) => {
        receive(notice);
        channel.postMessage(notice);
      });
      await lifetime;
    })
    .catch(() => {
      // A denied lock must not leave an otherwise usable browser silently stale.
      if (!stopped) stopSource = openSource(receive);
    });
  return () => {
    stopped = true;
    stopSource?.();
    channel.close();
    abort.abort();
    release();
  };
}

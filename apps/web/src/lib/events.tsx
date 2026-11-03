import type { ReviewEvent } from "@emend/contract";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { subscribeReviewEvents } from "./event-stream.ts";
import { InboxArrivalsProvider } from "./inbox-arrivals.tsx";

const PublishedRevisions = createContext<ReadonlyMap<string, number>>(new Map());

export function ReviewEventsProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const client = useQueryClient();
  const [published, setPublished] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    if (!enabled) {
      setPublished(new Map());
      return;
    }
    const pending = new Set<string>();
    let openedAt: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (openedAt !== undefined) {
          const before = openedAt;
          const keys = new Set(pending);
          void client.invalidateQueries(
            {
              predicate: (query) =>
                query.state.dataUpdatedAt < before || keys.has(query.queryKey.slice(0, 2).join(":")),
            },
            { cancelRefetch: false },
          );
        } else for (const key of pending) void client.invalidateQueries({ queryKey: key.split(":") });
        pending.clear();
        openedAt = undefined;
      }, 200);
    };
    const receive = (event: ReviewEvent) => {
      const { reviewId } = event;
      if (event.type === "publish")
        setPublished((previous) =>
          event.revision > (previous.get(reviewId) ?? 0) ? new Map(previous).set(reviewId, event.revision) : previous,
        );
      pending.add("inbox");
      pending.add(`review:${reviewId}`);
      if (["thread", "send", "claimed", "confirmed"].includes(event.type)) pending.add(`revision:${reviewId}`);
      schedule();
    };
    const stop = subscribeReviewEvents(receive, () => {
      openedAt = Date.now();
      schedule();
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [client, enabled]);
  return (
    <PublishedRevisions.Provider value={published}>
      <InboxArrivalsProvider enabled={enabled}>{children}</InboxArrivalsProvider>
    </PublishedRevisions.Provider>
  );
}

export function usePublishedRevision(reviewId: string) {
  return useContext(PublishedRevisions).get(reviewId) ?? 0;
}

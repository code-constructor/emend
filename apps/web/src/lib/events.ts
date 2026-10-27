import { ReviewEvent, ReviewEventName } from "@emend/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export function useReviewEvents(reviewId: string) {
  const client = useQueryClient();
  const [published, setPublished] = useState({ reviewId, revision: 0 });
  useEffect(() => {
    const source = new EventSource(`/api/v1/reviews/${encodeURIComponent(reviewId)}/events`);
    for (const type of ReviewEventName.options) {
      source.addEventListener(type, (message: MessageEvent<string>) => {
        let event: ReviewEvent;
        try {
          event = ReviewEvent.parse({ ...JSON.parse(message.data), type });
        } catch {
          return;
        }
        if (event.reviewId !== reviewId) return;
        if (event.type === "publish")
          setPublished((previous) => ({
            reviewId,
            revision: Math.max(previous.reviewId === reviewId ? previous.revision : 0, event.revision),
          }));
        void client.invalidateQueries({ queryKey: ["inbox"] });
        void client.invalidateQueries({ queryKey: ["review", reviewId] });
      });
    }
    return () => source.close();
  }, [client, reviewId]);
  return published.reviewId === reviewId ? published.revision : 0;
}

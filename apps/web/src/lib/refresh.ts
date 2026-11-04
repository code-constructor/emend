import { type Query, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { reconnectReviewEvents } from "./event-stream.ts";
import { isSettledImmutableQuery } from "./query-refresh.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Replace the live stream and refresh the cached queries. It touches no page, draft or composer
 * state, and a failed refetch shows the way every other failed query does.
 *
 * One rule against double fetches: when the new stream opens, the open refresh (which refetches
 * every query older than the open, in every tab) does the work and Refresh only waits for it to
 * settle. When the stream does not open in time (offline, failing) or nothing reconnected, Refresh
 * refetches the active queries itself. Loaded immutable file queries are never refetched.
 */
export function useRefresh() {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const refreshed = (query: Query) => !isSettledImmutableQuery(query);
      if (await reconnectReviewEvents()) {
        await sleep(300); // the open refresh starts after its 200 ms batch window
        // Wait only for the queries a refresh touches, not for unrelated background loads.
        for (let waited = 0; client.isFetching({ predicate: refreshed }) > 0 && waited < 10_000; waited += 100)
          await sleep(100);
      } else await client.refetchQueries({ type: "active", predicate: refreshed });
    } catch {
      // Offline or failing: the queries keep their cached data and show their own errors.
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [client]);
  return { refresh, busy };
}

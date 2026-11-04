import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { type SetStateAction, useEffect, useState } from "react";

type Folds = { review: string; seq: number; topics: Set<string> };
/** In memory, per session: the phone unmounts the Diff tab, but folded topics outlive it. */
const kept = new WeakMap<QueryClient, Map<string, Folds>>();

export function useTopicFolds(reviewId: string, seq: number) {
  const client = useQueryClient();
  const fresh = (): Folds => ({ review: reviewId, seq, topics: new Set() });
  const [state, setState] = useState(() => kept.get(client)?.get(reviewId) ?? fresh());
  useEffect(() => {
    const reviews = kept.get(client) ?? new Map<string, Folds>();
    reviews.set(state.review, state);
    kept.set(client, reviews);
  }, [client, state]);
  // A different review or revision starts unfolded.
  if (state.seq !== seq || state.review !== reviewId) setState(fresh());
  const change = (action: SetStateAction<Set<string>>) =>
    setState((previous) => ({
      ...previous,
      topics: typeof action === "function" ? action(previous.topics) : action,
    }));
  return [state.topics, change] as const;
}

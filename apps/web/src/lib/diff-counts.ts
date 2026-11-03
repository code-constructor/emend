import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { DiffCounts } from "../components/diff/presentation.ts";

const key = ["diff-counts"] as const;
const emptyCounts = new Map<string, DiffCounts>();
/** File ids identify immutable revision contents; keep their small counts for this session. */
export function useDiffCounts() {
  const client = useQueryClient();
  const { data: counts } = useQuery({
    queryKey: key,
    queryFn: skipToken,
    initialData: () => new Map<string, DiffCounts>(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const onParsed = useCallback(
    (id: string, count: DiffCounts) => {
      client.setQueryData<Map<string, DiffCounts>>(key, (previous = new Map()) => {
        const old = previous.get(id);
        return old?.additions === count.additions && old.deletions === count.deletions
          ? previous
          : new Map(previous).set(id, count);
      });
    },
    [client],
  );
  return { counts: counts ?? emptyCounts, onParsed };
}

import type { QueryClient } from "@tanstack/react-query";

type Batch = { keys: Set<string>; openedAt?: number; settled: boolean; timer?: ReturnType<typeof setTimeout> };
const batches = new WeakMap<QueryClient, Batch>();

const immutableQueries = new Set(["file", "file-diff", "file-counts"]);
/**
 * File text, file diffs and file counts never change for a file id, so no refresh refetches them
 * once loaded. One that failed (for example during an offline blip) is still retried.
 */
export function isSettledImmutableQuery(query: {
  queryKey: readonly unknown[];
  state: { status: "pending" | "error" | "success" };
}) {
  return (
    typeof query.queryKey[0] === "string" && immutableQueries.has(query.queryKey[0]) && query.state.status === "success"
  );
}

/** Events and settled writes share one batch, even when the initiating page unmounts. */
export function refreshQueries(
  client: QueryClient,
  keys: string[][] = [],
  options: { opened?: boolean; settled?: boolean } = {},
) {
  let batch = batches.get(client);
  if (!batch) {
    batch = { keys: new Set(), settled: false };
    batches.set(client, batch);
  }
  for (const key of keys) batch.keys.add(key.join(":"));
  if (options.opened) batch.openedAt = Date.now();
  batch.settled ||= !!options.settled;
  if (batch.timer !== undefined) return;
  const pending = batch;
  pending.timer = setTimeout(() => {
    const keys = new Set(pending.keys),
      before = pending.openedAt,
      settled = pending.settled;
    pending.keys.clear();
    pending.openedAt = undefined;
    pending.settled = false;
    pending.timer = undefined;
    if (before !== undefined) {
      void client.invalidateQueries(
        {
          predicate: (query) =>
            !isSettledImmutableQuery(query) &&
            (query.state.dataUpdatedAt < before || keys.has(query.queryKey.slice(0, 2).join(":"))),
        },
        { cancelRefetch: settled },
      );
    } else for (const key of keys) void client.invalidateQueries({ queryKey: key.split(":") });
  }, 200);
}

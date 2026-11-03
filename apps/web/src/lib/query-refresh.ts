import type { QueryClient } from "@tanstack/react-query";

type Batch = { keys: Set<string>; openedAt?: number; settled: boolean; timer?: ReturnType<typeof setTimeout> };
const batches = new WeakMap<QueryClient, Batch>();

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
          predicate: (query) => query.state.dataUpdatedAt < before || keys.has(query.queryKey.slice(0, 2).join(":")),
        },
        { cancelRefetch: settled },
      );
    } else for (const key of keys) void client.invalidateQueries({ queryKey: key.split(":") });
  }, 200);
}

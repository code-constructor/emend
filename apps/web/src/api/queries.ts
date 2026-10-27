import { InboxList, ReviewView, RevisionView } from "@emend/contract";
import { queryOptions } from "@tanstack/react-query";
import { get } from "./client.ts";

export const inboxQuery = () =>
  queryOptions({ queryKey: ["inbox"], queryFn: ({ signal }) => get("/api/v1/reviews", InboxList, signal) });
export const reviewQuery = (id: string) =>
  queryOptions({
    queryKey: ["review", id],
    queryFn: ({ signal }) => get(`/api/v1/reviews/${encodeURIComponent(id)}`, ReviewView, signal),
  });
export const revisionQuery = (id: string, seq: number) =>
  queryOptions({
    queryKey: ["revision", id, seq],
    queryFn: ({ signal }) => get(`/api/v1/reviews/${encodeURIComponent(id)}/revisions/${seq}`, RevisionView, signal),
    staleTime: Infinity,
  });

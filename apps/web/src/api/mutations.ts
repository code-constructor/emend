import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clearDraft } from "../lib/drafts.ts";
import { ApiError, change } from "./client.ts";

export function mutationMessage(error: Error) {
  return error instanceof ApiError && error.code === "stale_revision"
    ? "This page is out of date. Reload to see the newest revision."
    : error instanceof ApiError
      ? error.message
      : "The request failed. Try again.";
}
export function useReviewMutation(reviewId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      path,
      method = "POST",
      body,
      draftKey,
    }: {
      path: string;
      method?: "POST" | "PATCH" | "DELETE";
      body?: unknown;
      draftKey?: string;
    }) => {
      const result = await change(path, method, body);
      if (draftKey) clearDraft(draftKey);
      return result;
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["revision", reviewId] }),
        client.invalidateQueries({ queryKey: ["review", reviewId] }),
        client.invalidateQueries({ queryKey: ["inbox"] }),
      ]);
    },
  });
}

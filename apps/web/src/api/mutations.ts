import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import {
  beginDraftSave,
  clearDraftIfUnchanged,
  finishDraftSave,
  isDraftSaving,
  subscribeDrafts,
} from "../lib/drafts.ts";
import { ApiError, change } from "./client.ts";

export function mutationMessage(error: Error) {
  return error instanceof ApiError && error.code === "stale_revision"
    ? "This page is out of date. Reload to see the newest revision."
    : error instanceof ApiError
      ? error.message
      : "The request failed. Try again.";
}
export function useReviewMutation(reviewId: string, key?: string) {
  const client = useQueryClient();
  const pending = useSyncExternalStore(subscribeDrafts, () => (key ? isDraftSaving(key) : false));
  const mutation = useMutation({
    mutationFn: async ({
      path,
      method = "POST",
      body,
      draft,
    }: {
      path: string;
      method?: "POST" | "PATCH" | "DELETE";
      body?: unknown;
      draft?: { key: string; text: string };
    }) => {
      if (draft && !beginDraftSave(draft.key)) throw new Error("This draft is already saving.");
      try {
        const result = await change(path, method, body);
        if (draft) clearDraftIfUnchanged(draft.key, draft.text);
        return result;
      } finally {
        if (draft) finishDraftSave(draft.key);
      }
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["revision", reviewId] }),
        client.invalidateQueries({ queryKey: ["review", reviewId] }),
        client.invalidateQueries({ queryKey: ["inbox"] }),
      ]);
    },
  });
  return { ...mutation, isPending: pending || mutation.isPending };
}

import type { RevisionView, ViewedRequest } from "@emend/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import {
  beginDraftSave,
  clearDraft,
  clearDraftIfUnchanged,
  finishDraftSave,
  isDraftSaving,
  subscribeDrafts,
  trackReviewDraftSave,
} from "../lib/drafts.ts";
import { refreshQueries } from "../lib/query-refresh.ts";
import { viewedState } from "../lib/viewed-state.ts";
import { ApiError, change } from "./client.ts";

function applyViewed(view: RevisionView, body: ViewedRequest): RevisionView {
  if (view.seq !== body.revision) return view;
  const paths = new Set(body.paths);
  return {
    ...view,
    files: view.files.map((file) => {
      if (file.role !== "diff" || !paths.has(file.path)) return file;
      const { viewed: _viewed, viewedOn: _viewedOn, ...rest } = file;
      return body.viewed ? { ...rest, viewed: "viewed", viewedOn: body.revision } : rest;
    }),
  };
}

// Session state outlives mounted mutation observers, including failures awaiting dismissal.
export function useViewedChanges(reviewId: string) {
  const store = viewedState(useQueryClient());
  const changes = useSyncExternalStore(store.subscribe, store.snapshot);
  return useMemo(() => changes.filter((change) => change.reviewId === reviewId), [changes, reviewId]);
}
export function useViewedErrors(reviewId: string) {
  const store = viewedState(useQueryClient());
  const changes = useViewedChanges(reviewId);
  return { errors: changes.filter((change) => change.status === "error"), dismiss: store.dismiss };
}
export function useViewedRevision(reviewId: string, view: RevisionView | undefined) {
  const changes = useViewedChanges(reviewId);
  return useMemo(
    () =>
      view &&
      changes.reduce(
        (current, change) => (change.status !== "error" ? applyViewed(current, change.body) : current),
        view,
      ),
    [view, changes],
  );
}
export function useViewedMutation(reviewId: string) {
  const client = useQueryClient();
  const store = viewedState(client);
  return useMutation({
    scope: { id: `viewed:${reviewId}` },
    mutationFn: (body: ViewedRequest) => change(`/api/v1/reviews/${encodeURIComponent(reviewId)}/viewed`, "PUT", body),
    onMutate: (body) => store.start(reviewId, body),
    onSettled: (_data, error, _body, id) => {
      if (id !== undefined) store.settle(id, error);
      refreshQueries(client, [["revision", reviewId]], { settled: true });
    },
  });
}

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
      deleteDraft,
    }: {
      path: string;
      method?: "POST" | "PATCH" | "DELETE";
      body?: unknown;
      draft?: { key: string; text: string };
      deleteDraft?: string;
    }) => {
      if (draft && !beginDraftSave(draft.key)) throw new Error("This draft is already saving.");
      const finishReviewSave = draft || deleteDraft ? trackReviewDraftSave(reviewId) : undefined;
      try {
        let result: unknown;
        try {
          result = await change(path, method, body);
          if (draft) clearDraftIfUnchanged(draft.key, draft.text);
          if (deleteDraft) clearDraft(deleteDraft);
        } finally {
          if (draft) finishDraftSave(draft.key);
        }
        await Promise.all([
          client.invalidateQueries({ queryKey: ["revision", reviewId] }),
          client.invalidateQueries({ queryKey: ["review", reviewId] }),
          client.invalidateQueries({ queryKey: ["inbox"] }),
        ]);
        return result;
      } finally {
        finishReviewSave?.();
      }
    },
  });
  return { ...mutation, isPending: pending || mutation.isPending };
}

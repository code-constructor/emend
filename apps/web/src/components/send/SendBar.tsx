import { DEFAULT_MODE, type GoMode, LIMITS } from "@emend/contract";
import { useId, useState } from "react";
import { mutationMessage, useReviewMutation } from "../../api/mutations.ts";
import { clipText } from "../../lib/selection.ts";
import { Button } from "../ui/Button.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { ModePicker } from "./ModePicker.tsx";

export function SendBar({
  reviewId,
  revision,
  revisionError = false,
  unsentCount,
  phone = false,
}: {
  reviewId: string;
  revision: number | undefined;
  revisionError?: boolean;
  unsentCount: number;
  phone?: boolean;
}) {
  const [mode, setMode] = useState<GoMode>(DEFAULT_MODE);
  const [instruction, setInstruction] = useState("");
  const [result, setResult] = useState("");
  const mutation = useReviewMutation(reviewId);
  const field = useId();
  const counter = useId();
  const blocked = useId();
  const revisionStatus = useId();
  const unavailable =
    revision === undefined ? (revisionError ? "Could not load this revision." : "Loading revision…") : undefined;
  const disabled = mutation.isPending || revision === undefined;
  const submit = (kind: "go" | "approve") => {
    if (disabled) return;
    setResult("");
    mutation.mutate(
      {
        path: `/api/v1/reviews/${encodeURIComponent(reviewId)}/sends`,
        body: kind === "approve" ? { revision, kind } : { revision, kind, mode, instruction },
      },
      {
        onSuccess: () => {
          setInstruction("");
          setResult(kind === "go" ? "Feedback sent." : "Revision approved.");
        },
      },
    );
  };
  const feedback = (
    <>
      {mutation.error && (
        <p role="alert" className="text-sm">
          {mutationMessage(mutation.error)}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm">
          {result}
        </p>
      )}
    </>
  );
  const form = (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit("go");
      }}
    >
      <ModePicker value={mode} onChange={setMode} disabled={mutation.isPending} />
      <label htmlFor={field} className="block space-y-1 text-sm">
        <span>Instructions</span>
        <textarea
          id={field}
          aria-describedby={counter}
          className="review-input min-h-16"
          disabled={mutation.isPending}
          maxLength={LIMITS.instructionChars}
          value={instruction}
          onChange={(event) => setInstruction(clipText(event.target.value, LIMITS.instructionChars))}
        />
      </label>
      <div className="flex items-center justify-between gap-3">
        <span id={counter} className="text-xs text-neutral-500 dark:text-neutral-400">
          {instruction.length} / {LIMITS.instructionChars}
        </span>
        <Button type="submit" disabled={disabled} aria-describedby={unavailable ? revisionStatus : undefined}>
          Send
        </Button>
      </div>
      {phone && feedback}
    </form>
  );
  return (
    <section
      aria-label="Send feedback"
      className="shrink-0 space-y-2 border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="mr-auto text-sm">
          {unsentCount} unsent {unsentCount === 1 ? "comment" : "comments"}
        </span>
        <Button
          disabled={unsentCount > 0 || disabled}
          aria-describedby={
            [unsentCount > 0 ? blocked : "", unavailable ? revisionStatus : ""].filter(Boolean).join(" ") || undefined
          }
          onClick={() => submit("approve")}
        >
          Approve
        </Button>
        {phone && (
          <Sheet
            title="Send feedback"
            trigger={
              <Button disabled={disabled} aria-describedby={unavailable ? revisionStatus : undefined}>
                Send
              </Button>
            }
          >
            {form}
          </Sheet>
        )}
      </div>
      {unavailable && (
        <p
          id={revisionStatus}
          role={revisionError ? "alert" : "status"}
          className="text-xs text-neutral-500 dark:text-neutral-400"
        >
          {unavailable}
        </p>
      )}
      {unsentCount > 0 && (
        <p id={blocked} className="text-xs text-neutral-500 dark:text-neutral-400">
          Send or delete your {unsentCount} unsent comments first.
        </p>
      )}
      {!phone && form}
      {feedback}
    </section>
  );
}

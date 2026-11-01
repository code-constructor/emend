import { DEFAULT_MODE, type GoMode, LIMITS, MODE_LABELS } from "@emend/contract";
import { Check, Pencil, Send } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { mutationMessage, useReviewMutation } from "../../api/mutations.ts";
import { Button } from "../ui/Button.tsx";
import { inputClass, inputSizes } from "../ui/field.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { useToast } from "../ui/Toast.tsx";
import { cn } from "../ui/utils.ts";
import { ModePicker } from "./ModePicker.tsx";

export function SendBar({
  reviewId,
  revision,
  newestRevision,
  revisionError = false,
  unsentCount,
  approved = false,
  phone = false,
}: {
  reviewId: string;
  revision: number | undefined;
  newestRevision: number;
  revisionError?: boolean;
  unsentCount: number;
  approved?: boolean;
  phone?: boolean;
}) {
  const [mode, setMode] = useState<GoMode>(DEFAULT_MODE);
  const [instruction, setInstruction] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submitting = useRef(false);
  const desktopInstructions = useRef<HTMLTextAreaElement>(null);
  const focusDesktop = useRef(false);
  const sheetFormRef = useCallback((node: HTMLFormElement | null) => {
    if (!node) return;
    const dialog = node.closest('[role="dialog"]');
    // Capture focus before removing the portal, when activeElement still names its control.
    return () => {
      focusDesktop.current = dialog?.contains(document.activeElement) ?? false;
    };
  }, []);
  const mutation = useReviewMutation(reviewId);
  useEffect(() => {
    if (phone) {
      focusDesktop.current = false;
      return;
    }
    if (sheetOpen) setSheetOpen(false);
    const field = desktopInstructions.current;
    if (focusDesktop.current && field && !mutation.isPending) {
      focusDesktop.current = false;
      if (document.activeElement === document.body) field.focus();
    }
  }, [phone, sheetOpen, mutation.isPending]);
  const toast = useToast();
  const formId = useId();
  const blocked = useId();
  const sendReasonId = useId();
  const revisionStatus = useId();
  const olderReasonId = useId();
  const unavailable =
    revision === undefined ? (revisionError ? "Could not load this revision." : "Loading revision…") : undefined;
  const olderReason =
    revision !== undefined && revision < newestRevision
      ? `Revision ${newestRevision} is newer. Switch to it to send or approve.`
      : undefined;
  const disabled = mutation.isPending || revision === undefined || !!olderReason;
  const approveBlocked = unsentCount > 0 && !approved;
  const sendReason =
    instruction.length > LIMITS.instructionChars
      ? `Shorten the instructions to ${LIMITS.instructionChars} characters.`
      : unsentCount === 0 && !instruction.trim()
        ? "Write a comment or an instruction first."
        : undefined;
  const commentCount = `${unsentCount} ${unsentCount === 1 ? "comment" : "comments"}`;
  const changeInstruction = (value: string) => {
    if (!submitting.current) mutation.reset();
    setInstruction(value);
  };
  const changeMode = (value: GoMode) => {
    if (!submitting.current) mutation.reset();
    setMode(value);
  };
  const submit = async (kind: "go" | "approve") => {
    if (submitting.current || disabled || (kind === "go" ? !!sendReason : unsentCount > 0 || approved)) return;
    submitting.current = true;
    try {
      await mutation.mutateAsync({
        path: `/api/v1/reviews/${encodeURIComponent(reviewId)}/sends`,
        body: kind === "approve" ? { revision, kind } : { revision, kind, mode, instruction },
      });
      if (!mounted.current) return;
      if (kind === "go") {
        setInstruction("");
        setSheetOpen(false);
        toast.show({
          tone: "success",
          title: unsentCount > 0 ? `Sent ${commentCount} to the agent` : "Sent your instructions to the agent",
          description: `Revision ${revision} · ${MODE_LABELS[mode]}`,
        });
      } else toast.show({ tone: "success", title: `Approved revision ${revision}` });
    } catch {
      // The mutation retains the error for the inline alert.
    } finally {
      submitting.current = false;
    }
  };
  const feedback = mutation.error && (
    <p role="alert" className="m-0 text-13 text-danger-fg">
      {mutationMessage(mutation.error)}
    </p>
  );
  const reason = sendReason && (
    <span id={sendReasonId} className="text-fg-3 [font:var(--type-meta)]">
      {sendReason}
    </span>
  );
  const olderMessage = olderReason && <span id={olderReasonId}>{olderReason}</span>;
  const describedBy =
    [unavailable && revisionStatus, sendReason && sendReasonId, olderReason && olderReasonId]
      .filter(Boolean)
      .join(" ") || undefined;
  const approvalReason = <span id={blocked}>Send or delete before approving</span>;
  const approveButton = (
    <Button
      variant="approve"
      size={phone ? "lg" : "md"}
      icon={Check}
      disabled={disabled || unsentCount > 0 || approved}
      aria-describedby={
        [approveBlocked && blocked, unavailable && revisionStatus, olderReason && olderReasonId]
          .filter(Boolean)
          .join(" ") || undefined
      }
      onClick={() => void submit("approve")}
    >
      {approved ? "Approved" : phone || revision === undefined ? "Approve" : `Approve revision ${revision}`}
    </Button>
  );
  const status = (
    <div className={cn("flex min-w-0 flex-col gap-0.5", phone && "flex-1")}>
      <span className="flex items-center gap-1.5 whitespace-nowrap text-13 font-semibold leading-[1.2] text-fg-1">
        {unsentCount > 0 && (
          <span
            aria-hidden={phone ? undefined : true}
            className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-[5px] text-[10.5px] font-semibold tabular-nums text-accent-fg"
          >
            {unsentCount}
          </span>
        )}
        {unsentCount > 0 && " "}
        {phone
          ? unsentCount > 0
            ? "unsent"
            : "Nothing to send"
          : unsentCount > 0
            ? `${unsentCount} unsent ${unsentCount === 1 ? "comment" : "comments"}`
            : "No unsent comments"}
      </span>
      <span className="text-fg-3 [font:var(--type-meta)]">
        {revision !== undefined && `Revision ${revision}`}
        {!phone && approveBlocked && <> · {approvalReason}</>}
        {!phone && sendReason && <> · {reason}</>}
        {!phone && olderReason && <> · {olderMessage}</>}
      </span>
    </div>
  );
  return (
    <section aria-label="Send and approve" className="shrink-0 border-t border-line-1 bg-surface">
      {phone ? (
        <div className="flex min-h-[52px] items-center gap-2.5 py-1.5 pr-2.5 pl-3.5">
          {status}
          <div className="flex shrink-0 gap-2">
            {approveButton}
            <Sheet
              side="bottom"
              title="Send feedback"
              open={sheetOpen}
              onOpenChange={(open) => {
                if (open && !submitting.current) mutation.reset();
                setSheetOpen(open);
              }}
              trigger={
                <Button
                  variant="primary"
                  size="lg"
                  icon={Send}
                  disabled={disabled}
                  loading={mutation.isPending}
                  aria-describedby={
                    [unavailable && revisionStatus, olderReason && olderReasonId].filter(Boolean).join(" ") || undefined
                  }
                >
                  Send
                </Button>
              }
              footer={
                <div className="flex w-full flex-col gap-2">
                  {reason}
                  {olderReason && <p className="m-0 text-fg-3 [font:var(--type-meta)]">{olderMessage}</p>}
                  {unavailable && (
                    <p
                      id={revisionStatus}
                      role={revisionError ? "alert" : "status"}
                      className="m-0 text-fg-3 [font:var(--type-meta)]"
                    >
                      {unavailable}
                    </p>
                  )}
                  {feedback}
                  <Button
                    type="submit"
                    form={formId}
                    variant="primary"
                    size="lg"
                    fullWidth
                    icon={Send}
                    disabled={disabled || !!sendReason}
                    loading={mutation.isPending}
                    aria-describedby={describedBy}
                  >
                    {unsentCount > 0
                      ? `Send ${commentCount} on revision ${revision ?? "…"}`
                      : `Send instructions on revision ${revision ?? "…"}`}
                  </Button>
                </div>
              }
            >
              <form
                ref={sheetFormRef}
                id={formId}
                className="space-y-4"
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    event.target instanceof HTMLInputElement &&
                    event.target.type === "radio"
                  )
                    event.preventDefault();
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit("go");
                }}
              >
                <ModePicker cards value={mode} onChange={changeMode} disabled={mutation.isPending} />
                <Textarea
                  label="Instructions"
                  placeholder="Optional. Applies to every comment in this Send."
                  rows={2}
                  maxLength={LIMITS.instructionChars}
                  disabled={mutation.isPending}
                  value={instruction}
                  onChange={(event) => changeInstruction(event.target.value)}
                />
              </form>
            </Sheet>
          </div>
        </div>
      ) : (
        <form
          className="flex min-h-(--sendbar-h) items-center gap-2.5 py-2 pr-3 pl-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("go");
          }}
        >
          {status}
          <div className="flex min-w-0 flex-1 justify-end gap-2">
            <div className="relative flex min-w-0 max-w-[520px] flex-1 items-center">
              <Icon icon={Pencil} size={14} className="pointer-events-none absolute left-[9px] text-fg-3" />
              <textarea
                ref={desktopInstructions}
                aria-label="Instructions"
                rows={1}
                enterKeyHint="send"
                placeholder="Instructions for the agent (optional)"
                className={cn(inputClass, inputSizes.sm, "resize-none overflow-y-auto py-[3px] pl-[30px] leading-5")}
                maxLength={LIMITS.instructionChars}
                disabled={mutation.isPending}
                value={instruction}
                onChange={(event) => changeInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229)
                    return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
              />
            </div>
            <ModePicker value={mode} onChange={changeMode} disabled={mutation.isPending} />
          </div>
          <div className="flex shrink-0 gap-2">
            {approveButton}
            <Button
              type="submit"
              variant="primary"
              icon={Send}
              disabled={disabled || !!sendReason}
              loading={mutation.isPending}
              aria-describedby={describedBy}
            >
              {unsentCount > 0 ? `Send ${unsentCount}` : "Send"}
            </Button>
          </div>
        </form>
      )}
      {(!phone || !sheetOpen) && (unavailable || (phone && (approveBlocked || olderReason)) || mutation.error) && (
        <div className="space-y-1 px-4 pb-2">
          {unavailable && (
            <p
              id={revisionStatus}
              role={revisionError ? "alert" : "status"}
              className="m-0 text-fg-3 [font:var(--type-meta)]"
            >
              {unavailable}
            </p>
          )}
          {phone && approveBlocked && <p className="m-0 text-fg-3 [font:var(--type-meta)]">{approvalReason}</p>}
          {phone && olderReason && <p className="m-0 text-fg-3 [font:var(--type-meta)]">{olderMessage}</p>}
          {feedback}
        </div>
      )}
    </section>
  );
}

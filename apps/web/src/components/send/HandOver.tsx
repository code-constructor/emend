import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { shortDate } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { ResumeCommand } from "./ResumeCommand.tsx";

/** What the Send bar knows about the agent, from the review on screen. */
export interface SendAgent {
  agentWaiting: boolean;
  pendingSend: boolean;
  pickedUpAt: string | null;
  releasedAt: string | null;
  /** The review's newest revision. */
  newestRevision: number;
}

/** What the review showed at the moment the reader pressed Send. */
export interface SendBaseline {
  waited: boolean;
  pickedUpAt: string | null;
  newestRevision: number;
}

/** How long the window waits for a pick-up before it asks the server again. */
export const HANDOFF_WAIT_MS = 15_000;
/** How long the window stays open after a pick-up. */
export const HANDOFF_CLOSE_MS = 3_000;

/** The text for a review nobody waits on, or "An agent is waiting" when one does. */
export function handOverText(agent: SendAgent, lifecycle?: { state: string; snoozed: boolean }): string {
  if (agent.agentWaiting) return "An agent is waiting. It gets this now.";
  const date = agent.releasedAt ? shortDate(agent.releasedAt) : "";
  if (!date) return "No agent is waiting. emend keeps this until an agent picks it up.";
  if (lifecycle?.state === "settled") return `The agent stopped waiting when you retired this on ${date}.`;
  if (lifecycle?.snoozed) return `The agent stopped waiting when you snoozed this on ${date}.`;
  return `The agent stopped waiting on ${date}.`;
}

/** The line in the Send bar (desktop) or the Send sheet (phone) that says what an agent gets. */
export function HandOverNote({
  reviewId,
  agent,
  lifecycle,
  className,
}: {
  reviewId: string;
  agent: SendAgent;
  lifecycle?: { state: string; snoozed: boolean };
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="m-0 text-fg-3 [font:var(--type-meta)]">{handOverText(agent, lifecycle)}</p>
      {!agent.agentWaiting && <ResumeCommand reviewId={reviewId} compact />}
    </div>
  );
}

/**
 * The window after a Send. "Picked up" means a review snapshot fetched after the Send shows a
 * `pickedUpAt` that is set and differs from the one at Send time, or a newer revision with no Send
 * pending (a Send is never set aside by a new revision, so nothing pending means its delivery was
 * confirmed, even when the agent's publish already cleared `pickedUpAt`). No clocks are compared.
 * Once shown, a pick-up stays shown.
 */
export function HandoffWindow({
  reviewId,
  baseline,
  agent,
  phone,
  onClose,
  returnFocus,
  returnFocusPhone,
}: {
  reviewId: string;
  baseline: SendBaseline;
  /** The review's agent data now. */
  agent: SendAgent;
  phone: boolean;
  onClose: () => void;
  /** Desktop: the element that gets focus back (the Send button is disabled after a Send). */
  returnFocus?: RefObject<HTMLElement | null>;
  /** Phone: the element that gets focus back. */
  returnFocusPhone?: () => HTMLElement | null;
}) {
  const client = useQueryClient();
  const { waited } = baseline;
  const pickedNow =
    (agent.pickedUpAt !== null && agent.pickedUpAt !== baseline.pickedUpAt) ||
    (agent.newestRevision > baseline.newestRevision && !agent.pendingSend);
  const [latched, setLatched] = useState(false);
  useEffect(() => {
    if (pickedNow) setLatched(true);
  }, [pickedNow]);
  const pickedUp = latched || pickedNow;
  const [fallback, setFallback] = useState(!waited);
  // Once the reader touches the window (pointer, key, selection) it stays until they close it.
  const [held, setHeld] = useState(false);
  const status = useRef<HTMLSpanElement>(null);
  // Never awaited: the fallback must not wait on the network.
  const refetch = useCallback(() => {
    void Promise.all([
      client.invalidateQueries({ queryKey: ["review", reviewId] }),
      client.invalidateQueries({ queryKey: ["inbox"] }),
    ]).catch(() => undefined);
  }, [client, reviewId]);
  useEffect(() => {
    if (pickedUp) return;
    // The stream may be dead after a suspend: ask once, and give the reader the way to hand over.
    if (!waited) {
      refetch();
      return;
    }
    const timer = window.setTimeout(() => {
      setFallback(true);
      refetch();
    }, HANDOFF_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [pickedUp, waited, refetch]);
  useEffect(() => {
    if (!pickedUp || held) return;
    const timer = window.setTimeout(onClose, HANDOFF_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [pickedUp, held, onClose]);
  useEffect(() => {
    const onSelection = () => {
      const selection = window.getSelection();
      const dialog = status.current?.closest('[role="alertdialog"], [role="dialog"]');
      if (selection && selection.toString() !== "" && selection.anchorNode && dialog?.contains(selection.anchorNode))
        setHeld(true);
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);
  const text = (
    <span role="status" ref={status}>
      {pickedUp
        ? "The agent picked up your feedback."
        : fallback
          ? "No agent has picked this up yet. emend keeps it until one does."
          : "Waiting for the agent to pick this up…"}
    </span>
  );
  const command = !pickedUp && fallback && <ResumeCommand reviewId={reviewId} />;
  const change = (open: boolean) => {
    if (!open) onClose();
  };
  const touched = () => setHeld(true);
  return (
    // The wrapper only listens: React bubbles events from the portaled window to it.
    <div className="contents" onPointerDownCapture={touched} onKeyDownCapture={touched}>
      {phone ? (
        <Sheet side="bottom" title="Sent" description={text} open onOpenChange={change} returnFocus={returnFocusPhone}>
          {command}
        </Sheet>
      ) : (
        <Dialog
          title="Sent"
          description={text}
          open
          onOpenChange={change}
          returnFocus={returnFocus}
          preferReturnFocus
          actions={
            <Button data-autofocus onClick={onClose}>
              Close
            </Button>
          }
        >
          {command ? <div className="mt-3">{command}</div> : null}
        </Dialog>
      )}
    </div>
  );
}

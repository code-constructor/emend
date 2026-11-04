import { createContext, type ReactNode, useContext, useState } from "react";
import { appUpdate } from "../../lib/app-update.ts";
import { type UnsavedWork, unsavedWork } from "../../lib/drafts.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";

export type UpdateAction = "update" | "reload";
type Request = (action: UpdateAction) => void;

/** AppFrame provides the one gate; pages inside it ask through `useRequestUpdate`. */
export const UpdateGateContext = createContext<Request | null>(null);
export function useRequestUpdate(): Request {
  const request = useContext(UpdateGateContext);
  if (!request) throw new Error("useRequestUpdate needs an AppFrame");
  return request;
}

function run(action: UpdateAction) {
  if (action === "update") appUpdate.installUpdate();
  else appUpdate.reloadNow();
}
function join(parts: string[]) {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
function atRisk(work: UnsavedWork) {
  return work.saving || work.sending || work.unstored;
}
export function lossText(work: UnsavedWork) {
  const parts = [
    work.saving ? "a comment that is still saving" : "",
    work.sending ? "a Send in progress" : "",
    work.unstored ? "text that could not be stored on this device" : "",
  ].filter(Boolean);
  return `Reloading now could lose ${join(parts)}.`;
}

/**
 * Update and Reload act at once, unless a reload could lose work. Then a dialog asks first, and
 * asks again if the work at risk changed while the dialog was open. Render `dialog` once.
 */
export function useUpdateGate(): { request: Request; dialog: ReactNode } {
  const [pending, setPending] = useState<{ action: UpdateAction; work: UnsavedWork } | null>(null);
  function request(action: UpdateAction) {
    const work = unsavedWork();
    if (atRisk(work)) setPending({ action, work });
    else run(action);
  }
  function confirm(shown: { action: UpdateAction; work: UnsavedWork }) {
    const now = unsavedWork();
    if (atRisk(now) && JSON.stringify(now) !== JSON.stringify(shown.work)) {
      setPending({ action: shown.action, work: now });
      return;
    }
    setPending(null);
    run(shown.action);
  }
  const reload = pending?.action === "reload";
  const dialog = pending && (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      title={reload ? "Reload now?" : "Update now?"}
      description={lossText(pending.work)}
      actions={
        <>
          <Button data-autofocus variant="ghost" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => confirm(pending)}>
            {reload ? "Reload anyway" : "Update anyway"}
          </Button>
        </>
      }
    />
  );
  return { request, dialog };
}

import type { ThreadState, ThreadView } from "@emend/contract";

export type ShownThreadState = ThreadState | "unsent";
export function shownThreadState(thread: ThreadView): ShownThreadState {
  return thread.comments.some((comment) => comment.author === "user" && comment.sent === false)
    ? "unsent"
    : thread.state;
}
const labels = { unsent: "Unsent", open: "Open", sent: "Sent", answered: "Answered", resolved: "Resolved" };
const dots = {
  unsent: "border-[1.5px] border-dashed border-thread-open",
  open: "bg-thread-open",
  sent: "bg-thread-sent",
  answered: "bg-thread-answered",
  resolved: "border-[1.5px] border-thread-resolved",
};
export function ThreadStateBadge({ state }: { state: ShownThreadState }) {
  return (
    <span
      className={`inline-flex items-center gap-[5px] whitespace-nowrap text-[11.5px] font-medium leading-none ${state === "resolved" ? "text-fg-3" : "text-fg-2"}`}
    >
      <span aria-hidden="true" className={`size-[7px] shrink-0 rounded-full ${dots[state]}`} />
      {labels[state]}
    </span>
  );
}

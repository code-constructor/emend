import type { InboxItem } from "@emend/contract";
import { Check } from "lucide-react";
import { Icon } from "../ui/Icon.tsx";
import { cn } from "../ui/utils.ts";

export function agentStatusOf(review: Pick<InboxItem, "state" | "agentWaiting" | "pendingSend">) {
  if (review.state === "approved") return "approved";
  if (review.agentWaiting) return "waiting";
  if (review.pendingSend) return "none";
  return null;
}

export const agentStatusLabels = { waiting: "Agent waiting", none: "No agent waiting", approved: "Approved" };
export const agentDotClasses = {
  waiting: "bg-agent-waiting text-agent-waiting animate-[em-pulse_var(--dur-pulse)_var(--ease-out)_infinite]",
  none: "border-[1.5px] border-agent-none",
};

export function AgentStatus({
  status,
  pill = false,
  className,
}: {
  status: ReturnType<typeof agentStatusOf>;
  pill?: boolean;
  className?: string;
}) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-12 font-medium leading-[1.2]",
        status === "approved" ? "text-success-fg" : status === "waiting" ? "text-fg-1" : "text-fg-2",
        pill && "h-6 rounded-full border border-line-1 bg-surface pr-[9px] pl-2",
        className,
      )}
    >
      {status === "approved" ? (
        <Icon icon={Check} size={13} strokeWidth={2.25} />
      ) : (
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", agentDotClasses[status])} />
      )}
      <span>{agentStatusLabels[status]}</span>
    </span>
  );
}

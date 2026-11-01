import type { ReviewState } from "@emend/contract";
import { CheckCheck, CircleCheck, CircleDot } from "lucide-react";
import { Icon } from "../ui/Icon.tsx";
import { cn } from "../ui/utils.ts";

const states = {
  open: { icon: CircleDot, label: "Open", pill: "bg-state-open-bg text-state-open-fg", inline: "text-state-open-fg" },
  approved: {
    icon: CircleCheck,
    label: "Approved",
    pill: "bg-state-approved-bg text-state-approved-fg",
    inline: "text-success-fg",
  },
  settled: {
    icon: CheckCheck,
    label: "Settled",
    pill: "bg-state-settled-bg text-state-settled-fg inset-ring-1 inset-ring-line-1",
    inline: "text-fg-3",
  },
};

export function StateBadge({
  state,
  revision,
  variant = "pill",
}: {
  state: ReviewState;
  revision?: number;
  variant?: "pill" | "inline";
}) {
  const entry = states[state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-11 leading-none",
        variant === "pill"
          ? ["h-5 rounded-full pr-[7px] pl-[5px] font-semibold tracking-[.01em]", entry.pill]
          : ["font-medium", entry.inline],
      )}
    >
      <Icon icon={entry.icon} size={variant === "pill" ? 12 : 11} strokeWidth={2} />
      {entry.label}
      {state === "approved" && revision != null ? ` · rev ${revision}` : ""}
    </span>
  );
}

import { CircleAlert, Info, RefreshCw, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Icon, type IconComponent } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import { cn } from "./utils.ts";

export interface BannerProps {
  tone?: "info" | "warning" | "danger" | "neutral";
  inline?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
  icon?: IconComponent;
  children: ReactNode;
}
const icons = { info: RefreshCw, warning: TriangleAlert, danger: CircleAlert, neutral: Info };
const tones = {
  info: "bg-info-bg text-info-fg border-[color-mix(in_oklch,var(--info-solid)_22%,transparent)]",
  warning: "bg-warning-bg text-warning-fg border-[color-mix(in_oklch,var(--warning-solid)_30%,transparent)]",
  danger: "bg-danger-bg text-danger-fg border-[color-mix(in_oklch,var(--danger-solid)_25%,transparent)]",
  neutral: "bg-sunken text-fg-2 border-line-1",
};

export function Banner({
  tone = "info",
  inline = false,
  actionLabel,
  onAction,
  onDismiss,
  icon,
  children,
}: BannerProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex min-h-10 items-center gap-2.5 border-b py-1.5 pr-2 pl-3.5 font-sans text-13 font-medium leading-(--lh-snug) font-[450]",
        inline && "rounded-md border",
        tones[tone],
      )}
    >
      <Icon icon={icon ?? icons[tone]} />
      <div className="min-w-0 flex-1 text-pretty">{children}</div>
      {actionLabel && (
        <Button size="sm" onClick={onAction} className="shrink-0 shadow-none">
          {actionLabel}
        </Button>
      )}
      {onDismiss && <IconButton label="Dismiss" icon={X} size="sm" onClick={onDismiss} />}
    </div>
  );
}

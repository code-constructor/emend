import type { LucideIcon, LucideProps } from "lucide-react";
import { cn } from "./utils.ts";

export type IconComponent = LucideIcon;
export interface IconProps extends LucideProps {
  icon: IconComponent;
  label?: string;
}

export function Icon({ icon: Component, size = 16, strokeWidth = 1.75, label, className, ...props }: IconProps) {
  return (
    <Component
      {...props}
      size={size}
      strokeWidth={strokeWidth}
      className={cn("shrink-0", className)}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    />
  );
}

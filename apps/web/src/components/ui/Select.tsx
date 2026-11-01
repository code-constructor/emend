import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { FieldMessage, fieldClass, inputClass, inputSizes, labelClass, useField } from "./field.tsx";
import { Icon } from "./Icon.tsx";
import { cn } from "./utils.ts";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export interface SelectProps extends Omit<ComponentProps<"select">, "size"> {
  label?: string;
  hint?: string;
  options: (SelectOption | string)[];
  size?: "sm" | "md" | "lg";
}

export function Select({ label, hint, options, size = "md", id, className, ...props }: SelectProps) {
  const field = useField(id, hint, undefined, props["aria-describedby"]);
  return (
    <div className={cn(fieldClass, className)}>
      {label && (
        <label htmlFor={field.id} className={labelClass}>
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        <select
          {...props}
          id={field.id}
          aria-describedby={field.describedBy}
          className={cn(
            inputClass,
            "appearance-none pr-[30px] font-sans text-13 font-medium font-[450]",
            inputSizes[size],
            "leading-(--lh-snug)",
          )}
        >
          {options.map((option) =>
            typeof option === "string" ? (
              <option key={option} value={option}>
                {option}
              </option>
            ) : (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ),
          )}
        </select>
        <Icon icon={ChevronDown} size={14} className="pointer-events-none absolute right-2 text-fg-3" />
      </div>
      <FieldMessage id={field.messageId} hint={hint} />
    </div>
  );
}

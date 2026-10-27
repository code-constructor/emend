import { GoMode, MODE_LABELS } from "@emend/contract";
import { useId } from "react";

export function ModePicker({
  value,
  onChange,
  disabled,
}: {
  value: GoMode;
  onChange: (mode: GoMode) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="block space-y-1 text-sm">
      <span>Mode</span>
      <select
        id={id}
        className="review-input"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(GoMode.parse(event.target.value))}
      >
        {GoMode.options.map((mode) => (
          <option key={mode} value={mode}>
            {MODE_LABELS[mode]}
          </option>
        ))}
      </select>
    </label>
  );
}

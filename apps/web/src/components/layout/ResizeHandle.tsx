import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from "react";
import { focusRing } from "../ui/utils.ts";

export const RESIZE_HANDLE_WIDTH = 8;

export function clampWidth(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function ResizeHandle({
  label,
  value,
  min,
  max,
  onPreview,
  onCommit,
  onReset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onPreview: (value: number | undefined) => void;
  onCommit: (value: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ id: number; x: number; width: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(
    () => () => {
      if (drag.current) onPreview(undefined);
    },
    [onPreview],
  );
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("em-resizing");
    return () => document.body.classList.remove("em-resizing");
  }, [dragging]);
  const finish = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    if (commit && current.value !== current.width) onCommit(clampWidth(current.value, min, max));
    onPreview(undefined);
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: An adjustable separator needs focus and range semantics, unlike hr.
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      className={`em-resize-handle ${focusRing}`}
      style={{ "--resize-handle-width": `${RESIZE_HANDLE_WIDTH}px` } as CSSProperties}
      data-active={dragging || undefined}
      title="Drag to resize · double-click or Enter to reset"
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        const next = { ArrowLeft: value - step, ArrowRight: value + step, Home: min, End: max }[event.key];
        if (next === undefined && event.key !== "Enter") return;
        event.preventDefault();
        if (event.key === "Enter") onReset();
        else if (next !== undefined) onCommit(clampWidth(next, min, max));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, width: value, value };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        current.value = clampWidth(current.width + event.clientX - current.x, min, max);
        onPreview(current.value);
      }}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onLostPointerCapture={(event) => finish(event, false)}
    />
  );
}

import type { LinesTarget } from "@emend/contract";
import { Composer } from "../threads/Composer.tsx";

export function LineComposer({
  target,
  ...props
}: {
  reviewId: string;
  revision: number;
  target: LinesTarget;
  onSaved: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="space-y-2 p-3" aria-label="Line comment">
      <p className="text-sm font-medium">
        Lines {target.start}–{target.end}, {target.side} side
      </p>
      <Composer surface="diff" {...props} target={target} />
    </section>
  );
}

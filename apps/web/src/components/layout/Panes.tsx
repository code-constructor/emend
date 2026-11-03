import type { ReactNode } from "react";
import { useLayout } from "../../lib/layout.ts";

export function Panes({
  inbox,
  header,
  reading,
  diff,
  phoneTabs,
  sendBar,
  tab,
  hasDiff,
}: {
  inbox: ReactNode;
  header: ReactNode;
  reading: ReactNode;
  diff: ReactNode;
  phoneTabs: ReactNode;
  sendBar?: ReactNode;
  tab: string;
  hasDiff: boolean;
}) {
  const layout = useLayout();
  return (
    <div className="flex min-h-0 flex-1">
      {layout !== "phone" && inbox}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {header}
        <div className="flex min-h-0 flex-1">
          {(layout !== "phone" || tab !== "diff") && (
            <section
              aria-label="Reading"
              data-testid="reading-pane"
              data-reading-scroll
              tabIndex={-1}
              className="relative min-w-0 flex-1 overflow-y-auto"
            >
              {reading}
            </section>
          )}
          {hasDiff && (layout !== "phone" || tab === "diff") && (
            <section
              aria-label="Diff"
              data-testid="diff-pane"
              data-diff-scroll
              className="relative min-w-0 flex-1 overflow-y-auto border-line-1 md:border-l"
            >
              {diff}
            </section>
          )}
        </div>
        {sendBar}
        {layout === "phone" && phoneTabs}
      </main>
    </div>
  );
}

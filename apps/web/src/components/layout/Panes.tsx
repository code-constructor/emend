import type { ReactNode } from "react";
import { useLayout } from "../../lib/layout.ts";

export function Panes({
  inbox,
  header,
  reading,
  diff,
  phoneTabs,
  collapsed,
  tab,
}: {
  inbox: ReactNode;
  header: ReactNode;
  reading: ReactNode;
  diff: ReactNode;
  phoneTabs: ReactNode;
  collapsed: boolean;
  tab: string;
}) {
  const layout = useLayout();
  return (
    <div className="flex min-h-0 flex-1">
      {layout === "desktop" && !collapsed && (
        <aside
          aria-label="Inbox"
          data-testid="inbox-pane"
          className="w-[280px] shrink-0 overflow-y-auto border-r border-neutral-200 dark:border-neutral-800"
        >
          {inbox}
        </aside>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {header}
        <div className="flex min-h-0 flex-1">
          {(layout !== "phone" || tab !== "diff") && (
            <section aria-label="Reading" data-testid="reading-pane" className="min-w-0 flex-1 overflow-y-auto">
              {reading}
            </section>
          )}
          {(layout !== "phone" || tab === "diff") && (
            <section
              aria-label="Diff"
              data-testid="diff-pane"
              className="min-w-0 flex-1 overflow-y-auto border-neutral-200 md:border-l dark:border-neutral-800"
            >
              {diff}
            </section>
          )}
        </div>
        {layout === "phone" && phoneTabs}
      </main>
    </div>
  );
}

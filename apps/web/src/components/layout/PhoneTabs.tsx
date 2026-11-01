import { Link } from "@tanstack/react-router";
import { FileDiff, Files, FileText, MessageSquare } from "lucide-react";
import { Icon } from "../ui/Icon.tsx";
import { cn } from "../ui/utils.ts";
import type { ReviewTabsProps } from "./ReviewTabs.tsx";

const tabs = [
  { id: "writeup", label: "Writeup", icon: FileText },
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "docs", label: "Docs", icon: Files },
  { id: "comments", label: "Comments", icon: MessageSquare },
] as const;

export function PhoneTabs({ id, search, hasDocs, hasWriteup, hasDiff, unsentCount }: ReviewTabsProps) {
  return (
    <nav
      aria-label="Review tabs"
      className="grid shrink-0 auto-cols-fr grid-flow-col border-t border-line-1 bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      {tabs
        .filter((tab) => ({ writeup: hasWriteup, diff: hasDiff, docs: hasDocs, comments: true })[tab.id])
        .map((tab) => (
          <Link
            key={tab.id}
            to="/r/$reviewId"
            params={{ reviewId: id }}
            search={{ ...search, tab: tab.id, thread: undefined }}
            hash=""
            aria-current={tab.id === search.tab ? "page" : undefined}
            className={cn(
              "relative flex h-(--tab-touch) items-center justify-center text-11 font-medium leading-none no-underline hover:text-fg-1",
              tab.id === search.tab
                ? "text-fg-1 before:absolute before:-top-px before:right-[28%] before:left-[28%] before:h-0.5 before:rounded-b-[2px] before:bg-accent before:content-['']"
                : "text-fg-3",
            )}
          >
            <span className="relative flex flex-col items-center gap-[3px]">
              <Icon icon={tab.icon} size={18} />
              <span>{tab.label}</span>
              {tab.id === "comments" && unsentCount > 0 && (
                <span className="absolute -top-1.5 left-[calc(50%+3px)] inline-grid h-[15px] min-w-[15px] place-items-center rounded-full bg-accent px-1 text-[9.5px] font-semibold leading-none text-accent-fg tabular-nums">
                  <span className="sr-only"> </span>
                  {unsentCount}
                  <span className="sr-only"> unsent</span>
                </span>
              )}
            </span>
          </Link>
        ))}
    </nav>
  );
}

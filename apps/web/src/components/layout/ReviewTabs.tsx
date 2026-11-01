import { Link } from "@tanstack/react-router";
import type { ReviewSearch } from "../../router.tsx";

export interface ReviewTabsProps {
  id: string;
  search: ReviewSearch;
  hasDocs: boolean;
  hasWriteup: boolean;
  hasDiff: boolean;
  unsentCount: number;
}

export function ReviewTabs({ id, search, hasDocs, hasWriteup, hasDiff, unsentCount }: ReviewTabsProps) {
  const tabs = ["writeup", "docs", "comments"] as const;
  const active = search.tab === "diff" ? (hasWriteup ? "writeup" : hasDocs ? "docs" : "comments") : search.tab;
  return (
    <nav aria-label="Reading tabs" className="sticky top-0 flex shrink-0 border-b border-line-1 bg-surface">
      {tabs
        .filter((tab) => ({ writeup: hasWriteup, diff: hasDiff, docs: hasDocs, comments: true })[tab])
        .map((tab) => (
          <Link
            key={tab}
            to="/r/$reviewId"
            params={{ reviewId: id }}
            search={{ ...search, tab, thread: undefined }}
            hash=""
            aria-current={tab === active ? "page" : undefined}
            className={`flex min-h-12 flex-1 items-center justify-center gap-1 px-2 text-sm ${tab === active ? "font-medium text-link" : "text-fg-2"}`}
          >
            {tab[0]?.toUpperCase()}
            {tab.slice(1)}
            {tab === "comments" && <span className="rounded-full bg-sunken px-1.5 text-xs">{unsentCount}</span>}
          </Link>
        ))}
    </nav>
  );
}

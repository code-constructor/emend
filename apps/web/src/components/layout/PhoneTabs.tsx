import { Link } from "@tanstack/react-router";
import type { ReviewSearch } from "../../router.tsx";

export function ReviewTabs({
  id,
  search,
  hasDocs,
  unsentCount,
  phone = false,
}: {
  id: string;
  search: ReviewSearch;
  hasDocs: boolean;
  unsentCount: number;
  phone?: boolean;
}) {
  const tabs = phone ? (["writeup", "diff", "docs", "comments"] as const) : (["writeup", "docs", "comments"] as const);
  const active = !phone && search.tab === "diff" ? "writeup" : search.tab;
  return (
    <nav
      aria-label={phone ? "Review tabs" : "Reading tabs"}
      className={`flex shrink-0 border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950 ${phone ? "border-t pb-[env(safe-area-inset-bottom)]" : "sticky top-0 border-b"}`}
    >
      {tabs
        .filter((tab) => tab !== "docs" || hasDocs)
        .map((tab) => (
          <Link
            key={tab}
            to="/r/$reviewId"
            params={{ reviewId: id }}
            search={{ ...search, tab }}
            aria-current={tab === active ? "page" : undefined}
            className={`flex min-h-12 flex-1 items-center justify-center gap-1 px-2 text-sm ${tab === active ? "font-medium text-blue-700 dark:text-blue-400" : "text-neutral-600 dark:text-neutral-400"}`}
          >
            {tab[0]?.toUpperCase()}
            {tab.slice(1)}
            {tab === "comments" && (
              <span className="rounded-full bg-neutral-100 px-1.5 text-xs dark:bg-neutral-800">{unsentCount}</span>
            )}
          </Link>
        ))}
    </nav>
  );
}
export function PhoneTabs(props: Omit<Parameters<typeof ReviewTabs>[0], "phone">) {
  return <ReviewTabs {...props} phone />;
}

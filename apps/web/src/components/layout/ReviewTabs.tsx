import { useNavigate } from "@tanstack/react-router";
import { usePaneMode } from "../../lib/layout.ts";
import type { ReviewSearch } from "../../router.tsx";
import { Tabs } from "../ui/Tabs.tsx";

export interface ReviewTabsProps {
  id: string;
  search: ReviewSearch;
  hasDocs: boolean;
  hasWriteup: boolean;
  hasDiff: boolean;
  unsentCount: number;
}

export function ReviewTabs({
  id,
  search,
  hasDocs,
  hasWriteup,
  hasDiff,
  unsentCount,
  docsCount,
  idBase,
}: ReviewTabsProps & { docsCount: number; idBase: string }) {
  const navigate = useNavigate();
  const showDiff = usePaneMode() === "tabs" && hasDiff;
  const active =
    search.tab === "diff" && !showDiff ? (hasWriteup ? "writeup" : hasDocs ? "docs" : "comments") : search.tab;
  return (
    <Tabs
      idBase={idBase}
      label="Reading tabs"
      className="sticky top-0 z-(--z-sticky) shrink-0 bg-surface"
      value={active ?? (hasWriteup ? "writeup" : hasDocs ? "docs" : "comments")}
      items={[
        { id: "writeup", label: "Writeup", hidden: !hasWriteup },
        { id: "docs", label: "Docs", hidden: !hasDocs, count: docsCount },
        { id: "comments", label: "Comments", count: unsentCount, accent: true },
        { id: "diff", label: "Diff", hidden: !showDiff },
      ].map((item) => ({ ...item, "aria-controls": `${idBase}-${item.id === "diff" ? "diff" : "reading"}-panel` }))}
      onChange={(tab) => {
        if (tab !== "writeup" && tab !== "docs" && tab !== "comments" && tab !== "diff") return;
        void navigate({
          to: "/r/$reviewId",
          params: { reviewId: id },
          search: { ...search, tab, thread: undefined },
          hash: "",
        });
      }}
    />
  );
}

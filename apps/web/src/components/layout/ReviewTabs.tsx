import { useNavigate } from "@tanstack/react-router";
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
  unsentCount,
  docsCount,
  idBase,
}: ReviewTabsProps & { docsCount: number; idBase: string }) {
  const navigate = useNavigate();
  const active = search.tab === "diff" ? (hasWriteup ? "writeup" : hasDocs ? "docs" : "comments") : search.tab;
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
      ].map((item) => ({ ...item, "aria-controls": `${idBase}-panel` }))}
      onChange={(tab) => {
        if (tab !== "writeup" && tab !== "docs" && tab !== "comments") return;
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

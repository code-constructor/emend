import { useNavigate } from "@tanstack/react-router";
import { useLayout, usePaneMode } from "../../lib/layout.ts";
import { layoutStore, useLayoutPreferences } from "../../lib/layout-store.ts";
import type { ReviewSearch } from "../../router.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
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
  const phone = useLayout() === "phone";
  const { reading } = useLayoutPreferences();
  const showDiff = usePaneMode() === "tabs" && hasDiff;
  const active =
    search.tab === "diff" && !showDiff ? (hasWriteup ? "writeup" : hasDocs ? "docs" : "comments") : search.tab;
  const value = active ?? (hasWriteup ? "writeup" : hasDocs ? "docs" : "comments");
  return (
    <div className="em-review-tabs sticky top-0 z-(--z-sticky) flex shrink-0 items-center border-b border-line-1 bg-surface">
      <Tabs
        idBase={idBase}
        label="Reading tabs"
        className="min-w-0 flex-1 border-b-0"
        value={value}
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
      {!phone && hasWriteup && value === "writeup" && (
        <SegmentedControl
          label="Reading mode"
          size="sm"
          className="mx-2 shrink-0"
          options={[
            { value: "standard", label: "Standard" },
            { value: "focus", label: "Focus" },
          ]}
          value={reading}
          onChange={(reading) => {
            if (reading === "standard" || reading === "focus") layoutStore.update({ reading });
          }}
        />
      )}
    </div>
  );
}

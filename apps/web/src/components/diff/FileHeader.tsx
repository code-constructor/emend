import type { FileView } from "@emend/contract";
import { ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react";
import { Fragment } from "react";
import { ViewedMark } from "../files/ViewedMark.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { FileStatusMark } from "./FileStatusMark.tsx";
import type { DiffCounts } from "./presentation.ts";
import { ThreadCount } from "./ThreadCount.tsx";

function Path({ path }: { path: string }) {
  const segments = path.split("/");
  return (
    <bdi>
      {segments.map((segment, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static path segments may repeat names.
        <Fragment key={index}>
          <span className={index === segments.length - 1 ? "font-medium text-fg-1" : "text-fg-3"}>
            {segment}
            {index < segments.length - 1 ? "/" : ""}
          </span>
          {index < segments.length - 1 && <wbr />}
        </Fragment>
      ))}
    </bdi>
  );
}

export function FileHeader({
  file,
  collapsed,
  counts,
  threads,
  onToggle,
  onComment,
  onViewed,
}: {
  file: FileView;
  collapsed: boolean;
  counts?: DiffCounts;
  threads: number;
  onToggle: () => void;
  onComment: () => void;
  onViewed?: (paths: string[], viewed: boolean) => void;
}) {
  return (
    <header id={`diff-file-${file.id}`} data-file-header className="em-file" data-collapsed={collapsed || undefined}>
      <IconButton
        size="sm"
        label={collapsed ? "Expand file" : "Collapse file"}
        icon={collapsed ? ChevronRight : ChevronDown}
        aria-expanded={!collapsed}
        onClick={onToggle}
      />
      <FileStatusMark status={file.status} />
      <div className="min-w-0 flex-1 font-stretch-mono [font:var(--type-path)]">
        <h4 className="em-file-path" title={file.path} aria-label={file.path}>
          <Path path={file.path} />
        </h4>
        {file.oldPath && (
          <p className="em-file-path text-fg-3" title={`Renamed from ${file.oldPath}`}>
            Renamed from <Path path={file.oldPath} />
          </p>
        )}
      </div>
      {counts && !file.flag && (
        <span className="flex shrink-0 gap-1.5 font-mono text-11 font-stretch-mono tabular-nums">
          <span className="text-diff-add-fg">+{counts.additions}</span>
          <span className="text-diff-del-fg">−{counts.deletions}</span>
        </span>
      )}
      <ThreadCount count={threads} />
      <IconButton label="Comment on file" icon={MessageSquarePlus} size="sm" onClick={onComment} />
      {onViewed && (
        <ViewedMark
          state={file.viewed}
          viewedOn={file.viewedOn}
          label={file.path}
          showLabel
          onToggle={() => onViewed([file.path], file.viewed !== "viewed")}
        />
      )}
    </header>
  );
}

import type { FileView, Target } from "@emend/contract";
export type DiffTarget = Extract<Target, { kind: "lines" | "file" | "topic" }>;
export function isDiffTarget(target: Target): target is DiffTarget {
  return target.kind === "lines" || target.kind === "file" || target.kind === "topic";
}
export type FileLocation = { kind: string; path?: string; side?: string };
export function resolveFile(files: FileView[], target: FileLocation) {
  const matches = files.filter((file) => {
    if (file.role !== "diff") return false;
    if (target.kind === "file") return target.path === file.path;
    if (target.kind !== "lines") return false;
    return target.side === "old"
      ? file.hasOld && file.status !== "added" && target.path === (file.oldPath ?? file.path)
      : target.side === "new" && file.hasNew && target.path === file.path;
  });
  return matches.length === 1 ? matches[0] : undefined;
}
export function lineLabel(target: { start: number; end: number; side: string }) {
  return `${target.start === target.end ? `Line ${target.end}` : `Lines ${target.start}–${target.end}`}, ${target.side} side`;
}
export function targetLabel(target: DiffTarget) {
  return target.kind === "topic"
    ? `Topic ${target.slug}`
    : target.kind === "file"
      ? `File ${target.path}`
      : `${target.path}: ${lineLabel(target)}`;
}

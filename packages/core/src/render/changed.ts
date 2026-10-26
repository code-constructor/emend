import type { Block } from "./blocks.ts";

export function changedBlockIds(prev: Block[] | null, next: Block[]): string[] {
  const previous = new Set(prev?.map((block) => block.id));
  return next.filter((block) => !previous.has(block.id)).map((block) => block.id);
}

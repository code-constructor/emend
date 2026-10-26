import type { Block } from "./blocks.ts";

export function changedBlockIds(prev: Pick<Block, "id">[] | null, next: Pick<Block, "id">[]): string[] {
  const previous = new Set(prev?.map((block) => block.id));
  return next.filter((block) => !previous.has(block.id)).map((block) => block.id);
}

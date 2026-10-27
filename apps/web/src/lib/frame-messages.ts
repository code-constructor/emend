import { FilePath, FileView, HtmlSpanTarget, ThreadView } from "@emend/contract";

// Reuse the contract's Zod schemas and limits without a second web dependency on Zod.
const span = HtmlSpanTarget.pick({ quote: true, prefix: true, suffix: true }).strict();
const empty = HtmlSpanTarget.pick({}).strict();
const literal = <T extends string>(value: T) =>
  HtmlSpanTarget.shape.quote.refine((text) => text === value).transform(() => value);
const threadId = ThreadView.shape.id;
export const FrameToParent = span
  .extend({ type: literal("emend:anchor") })
  .or(empty.extend({ type: literal("emend:ready") }))
  .or(
    empty.extend({
      type: literal("emend:navigate"),
      path: FilePath,
      fragment: FileView.shape.mediaType.max(1024).refine((fragment) => fragment.isWellFormed()),
    }),
  );
export type DocNavigation = Extract<typeof FrameToParent._output, { type: "emend:navigate" }>;
export const ParentToFrame = empty
  .extend({ type: literal("emend:highlight"), anchors: span.extend({ threadId }).array() })
  .or(empty.extend({ type: literal("emend:scroll"), threadId }));
export type ParentToFrame = typeof ParentToFrame._output;

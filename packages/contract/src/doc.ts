import { z } from "zod";
import { LIMITS } from "./limits.ts";
export const DocTitle = z
  .string()
  .min(1)
  .max(LIMITS.titleChars)
  .refine((title) => /\S/.test(title), "title must not be blank");
export const DocHeading = z.object({
  level: z.union([z.literal(2), z.literal(3)]),
  text: z.string().max(LIMITS.headingTextChars),
  id: z.string().min(1).max(LIMITS.headingIdChars).optional(),
});
export type DocHeading = z.infer<typeof DocHeading>;
export const DocHeadings = z.array(DocHeading).max(LIMITS.headingsPerDoc);

import { z } from "zod";
import { LIMITS } from "./limits.ts";

export const GoMode = z.enum(["fix-clear", "explain", "fix-all"]);
export type GoMode = z.infer<typeof GoMode>;

export const MODE_LABELS: Record<GoMode, string> = {
  "fix-clear": "Fix what's clear, ask about the rest",
  explain: "Explain only, change nothing",
  "fix-all": "Fix everything",
};
export const DEFAULT_MODE = "fix-clear" satisfies GoMode;

export const SendRequest = z.discriminatedUnion("kind", [
  z.object({
    revision: z.int().positive(),
    kind: z.literal("go"),
    mode: GoMode.optional(),
    instruction: z.string().max(LIMITS.instructionChars).optional(),
  }),
  z.object({
    revision: z.int().positive(),
    kind: z.literal("approve"),
    mode: z.never().optional(),
    instruction: z.never().optional(),
  }),
]);
export type SendRequest = z.infer<typeof SendRequest>;

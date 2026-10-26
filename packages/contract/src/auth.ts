import { z } from "zod";

export const TokenKind = z.enum(["admin", "agent", "reviewer"]);
export type TokenKind = z.infer<typeof TokenKind>;

export const Scope = z.enum([
  "pairings:create",
  "devices:manage",
  "publish",
  "take",
  "reply",
  "read",
  "comment",
  "send",
]);
export type Scope = z.infer<typeof Scope>;

export const SCOPES_BY_KIND = {
  admin: ["pairings:create", "devices:manage"],
  agent: ["publish", "take", "reply"],
  reviewer: ["read", "comment", "send", "pairings:create", "devices:manage"],
} as const satisfies Record<TokenKind, readonly Scope[]>;

import type { Repo } from "./repo.ts";

/** What main.ts hands to a subcommand. `args` excludes the subcommand name. */
export interface Ctx {
  repo: Repo;
  args: string[];
}

/** A subcommand returns an exit code, or nothing for 0. A WtError thrown from it sets the exit code. */
export type Command = (ctx: Ctx) => number | undefined | Promise<number | undefined>;

/** The shape a module exports as `commands` so main.ts can dispatch to it. */
export type CommandTable = Record<string, Command>;

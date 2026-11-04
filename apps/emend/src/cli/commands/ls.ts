import { AgentReviewList } from "@emend/contract";
import type { Io } from "../../main.ts";
import { listDirect } from "../direct/index.ts";
import { escapeReference } from "../escape.ts";
import { apiRequest, CliError, CliUsageError, printTerminalJson } from "../http.ts";
import { resolveTarget } from "../target.ts";

export async function lsCommand(stateDir: string, args: string[], io: Io) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
    throw new CliUsageError("Usage: emend ls [--json].");
  const target = await resolveTarget(stateDir);
  let list: AgentReviewList;
  if (target.via === "direct") list = await listDirect(stateDir);
  else {
    const result = AgentReviewList.safeParse(await apiRequest(stateDir, target, "/agent/reviews", { method: "GET" }));
    if (!result.success) throw new CliError("The emend server returned an invalid response.");
    list = result.data;
  }
  if (args.length) return printTerminalJson(io, list);
  for (const review of list.items)
    io.stdout(
      `${review.id}\t${review.state}\t${review.updatedAt}\t${escapeReference(review.title)}\t${escapeReference(review.url)}\n`,
    );
}

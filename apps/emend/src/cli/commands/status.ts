import { stat } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import type { Io } from "../../main.ts";
import { VERSION } from "../../version.ts";
import { escapeReference } from "../escape.ts";
import { CliUsageError, printTerminalJson, sandboxHint } from "../http.ts";
import { readRegular } from "../publish/read.ts";
import { discover } from "../server-client.ts";
import { hubCapabilities, readAttachment } from "../target.ts";

/** Read this machine's instance name. It creates nothing; a missing or unreadable file reads as none. */
async function instanceName(stateDir: string): Promise<string | null> {
  try {
    const bytes = await readRegular(join(stateDir, "instance.json"), LIMITS.publicJsonBytes);
    const value: unknown = JSON.parse(bytes.toString());
    return value && typeof value === "object" && "name" in value && typeof value.name === "string" ? value.name : null;
  } catch {
    return null;
  }
}

/** Where this machine's agent commands go. It only reads: no token, and no file or folder is created. */
export async function statusCommand(stateDir: string, args: string[], io: Io) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
    throw new CliUsageError("Usage: emend status [--json].");
  // A missing state folder is reported, never created: a sandbox may hide the real one.
  const missing = await stat(stateDir).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  if (missing)
    io.stderr(
      `emend: state folder ${escapeReference(stateDir)} not found: emend has not run on this machine yet, or an agent sandbox hides it. ${sandboxHint}\n`,
    );
  const attachment = await readAttachment(stateDir);
  const instance = await instanceName(stateDir);
  let address: string | null;
  let answering: boolean;
  if (attachment) {
    address = attachment.hubUrl;
    answering = await hubCapabilities(address, undefined, stateDir).then(
      () => true,
      () => false,
    );
  } else {
    const server = await discover(stateDir, 5000);
    address = server?.url ?? null;
    answering = server !== null;
  }
  const status = {
    mode: attachment ? "attached" : "local",
    address,
    hub: attachment?.hubName ?? null,
    instance,
    answering,
    version: VERSION,
  };
  if (args.length) return printTerminalJson(io, status);
  const lines = [
    `mode: ${status.mode}`,
    `address: ${address === null ? "none" : escapeReference(address)}`,
    ...(status.hub === null ? [] : [`hub: ${escapeReference(status.hub)}`]),
    `instance: ${instance === null ? "none" : escapeReference(instance)}`,
    `server: ${answering ? "answering" : "not answering"}`,
    `version: ${VERSION}`,
  ];
  io.stdout(`${lines.join("\n")}\n`);
}

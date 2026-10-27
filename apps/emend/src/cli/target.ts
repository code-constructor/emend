import { lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { Capabilities, LIMITS, ReplyCreated } from "@emend/contract";
import { readTokenFile } from "../state/token-file.ts";
import { VERSION } from "../version.ts";
import { CliError } from "./http.ts";
import { readRegular } from "./publish/read.ts";
import { ensureServer } from "./server-client.ts";

export type Target = { url: string; token: string; via: "local" | "hub" };

function attachmentUrl(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid");
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !ReplyCreated.shape.commentId.safeParse(record.hubId).success ||
    typeof record.hubName !== "string" ||
    record.hubName.length < 1 ||
    record.hubName.length > 200 ||
    typeof record.hubUrl !== "string"
  )
    throw new Error("invalid");
  const value = record.hubUrl;
  // Reject URL parser repairs (whitespace, backslashes, dot paths) as well as credentials.
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/.test(value)) throw new Error("invalid");
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (url.username || url.password || (url.protocol !== "https:" && !loopback)) throw new Error("invalid");
  return url.origin;
}

async function credential(stateDir: string, kind: "agent" | "admin" | "hub"): Promise<string> {
  let token: string | null;
  try {
    token = await readTokenFile(join(stateDir, `${kind}.token`));
  } catch {
    throw new CliError("Could not read the emend credential.");
  }
  if (!token || !/^em_[A-Za-z0-9_-]{43}$/.test(token)) throw new CliError("The emend credential is invalid.");
  return token;
}

/** Publish and pairing deliberately stay local, even when attached. */
export async function localTarget(stateDir: string, url: string, kind: "agent" | "admin" = "agent"): Promise<Target> {
  return { url, token: await credential(stateDir, kind), via: "local" };
}

export async function resolveTarget(stateDir: string): Promise<Target> {
  const path = join(stateDir, "attach.json");
  let attached = true;
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") attached = false;
    else throw new CliError("Could not read the emend attachment.");
  }
  if (!attached) {
    let url: string;
    try {
      ({ url } = await ensureServer(stateDir));
    } catch {
      throw new CliError("Could not start the emend server.");
    }
    return localTarget(stateDir, url);
  }
  let url: string;
  try {
    url = attachmentUrl(JSON.parse((await readRegular(path, LIMITS.publicJsonBytes)).toString()));
  } catch {
    throw new CliError("The emend attachment is invalid or unreadable.");
  }
  const token = await credential(stateDir, "hub");
  const failure = (reason: string) => new CliError(`cannot reach the hub at ${url}: ${reason}. Nothing was changed.`);
  const signal = AbortSignal.timeout(5000);
  let response: Response;
  try {
    response = await fetch(`${url}/api/v1/capabilities`, {
      redirect: "error",
      signal,
      headers: { "X-Emend-Client": `cli/${VERSION}` },
    });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "TimeoutError")) throw failure("timed out");
    const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
    throw failure(cause?.code === "ECONNREFUSED" ? "connection refused" : "connection failed");
  }
  if (!response.ok) throw failure("not an emend hub");
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("invalid");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > LIMITS.publicJsonBytes) {
          await reader.cancel();
          throw new Error("too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!Capabilities.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).success) throw new Error("invalid");
  } catch {
    throw failure(signal.aborted ? "timed out" : "not an emend hub");
  }
  return { url, token, via: "hub" };
}

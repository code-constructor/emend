import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  Capabilities,
  SERVER_CHALLENGE_HEADER,
  SERVER_PROOF_HEADER,
  ServerChallenge,
  ServerProof,
} from "@emend/contract";
import { serverProof } from "../server/auth/server-proof.ts";
import { ensureStateDir } from "../state/files.ts";

export async function discover(
  stateDir: string,
  timeoutMs: number,
  expectedUrl?: string,
): Promise<{ url: string } | null> {
  try {
    const record: unknown = JSON.parse(await readFile(join(stateDir, "server.json"), "utf8"));
    if (
      !record ||
      typeof record !== "object" ||
      !("pid" in record) ||
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      !("url" in record) ||
      typeof record.url !== "string" ||
      !("key" in record) ||
      !ServerChallenge.safeParse(record.key).success
    )
      return null;
    const url = new URL(record.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      (expectedUrl !== undefined && url.origin !== expectedUrl)
    )
      return null;
    process.kill(record.pid, 0);
    const challenge = randomBytes(32).toString("base64url");
    const response = await fetch(`${url.origin}/api/v1/capabilities`, {
      redirect: "error",
      headers: { [SERVER_CHALLENGE_HEADER]: challenge },
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    const proof = ServerProof.safeParse(response.headers.get(SERVER_PROOF_HEADER));
    if (
      !proof.success ||
      !timingSafeEqual(
        Buffer.from(proof.data, "base64url"),
        Buffer.from(serverProof(ServerChallenge.parse(record.key), challenge), "base64url"),
      )
    )
      return null;
    if (!response.ok || !Capabilities.safeParse(await response.json()).success) return null;
    return { url: url.origin };
  } catch {
    return null;
  }
}
export async function ensureServer(
  stateDir: string,
  opts: { entry?: string; timeoutMs?: number } = {},
): Promise<{ url: string }> {
  ensureStateDir(stateDir);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const existing = await discover(stateDir, Math.min(500, timeoutMs));
  if (existing) return existing;
  // In the bundle import.meta.url is the entry; source execution uses cli.ts.
  const entry =
    opts.entry ??
    (import.meta.url.endsWith(".ts")
      ? fileURLToPath(new URL("../cli.ts", import.meta.url))
      : fileURLToPath(import.meta.url));
  const failure = () => new Error("Could not start the emend server.");
  let spawnError = false;
  try {
    const child = spawn(process.execPath, [entry, "serve"], {
      detached: true,
      cwd: stateDir,
      stdio: "ignore",
      env: { ...process.env, EMEND_HOME: stateDir },
    });
    child.once("error", () => {
      spawnError = true;
    });
    child.unref();
  } catch {
    throw failure();
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !spawnError) {
    const found = await discover(stateDir, Math.min(300, deadline - Date.now()));
    if (found) return found;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw failure();
}

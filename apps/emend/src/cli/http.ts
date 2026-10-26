import { join } from "node:path";
import { ErrorBody, type ErrorCode } from "@emend/contract";
import { ApiError } from "../server/http/errors.ts";
import { readTokenFile } from "../state/token-file.ts";
import { VERSION } from "../version.ts";
import { discover } from "./server-client.ts";

export class CliError extends Error {}
export const publishAnswerIncomplete = "the server's answer was cut off; the revision may have been published";
export class CliApiError extends CliError {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(new ApiError(code).message);
    this.code = code;
  }
}
export async function apiRequest(
  stateDir: string,
  baseUrl: string,
  path: string,
  opts: {
    token: "admin" | "agent";
    method: string;
    body?: unknown;
    raw?: Buffer;
    missingOk?: boolean;
    timeoutMs?: number;
  },
): Promise<unknown> {
  if (!(await discover(stateDir, 5000, baseUrl))) throw new CliError("Could not authenticate the emend server.");
  let token: string | null;
  try {
    token = await readTokenFile(join(stateDir, `${opts.token}.token`));
  } catch {
    throw new CliError("Could not read the emend credential.");
  }
  if (!token || !/^em_[A-Za-z0-9_-]{43}$/.test(token)) throw new CliError("The emend credential is invalid.");
  let response: Response;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 5000);
  try {
    response = await fetch(new URL(`/api/v1${path}`, baseUrl), {
      method: opts.method,
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Emend-Client": `cli/${VERSION}`,
        "Content-Type": opts.raw === undefined ? "application/json" : "application/octet-stream",
        ...(opts.raw === undefined ? {} : { "Content-Length": String(opts.raw.length) }),
      },
      ...(opts.raw === undefined
        ? opts.body === undefined
          ? {}
          : { body: JSON.stringify(opts.body) }
        : { body: new Uint8Array(opts.raw) }),
    });
  } catch {
    if (path === "/publish" && signal.aborted)
      throw new CliError("the server did not answer in time; nothing was published");
    throw new CliError("Could not contact the emend server.");
  }
  if (opts.method === "HEAD") {
    if (response.ok) return true;
    if (response.status === 404 && opts.missingOk) return false;
    throw new CliError("The emend request failed.");
  }
  let body: unknown;
  try {
    body = response.status === 204 ? null : await response.json();
  } catch {
    if (path === "/publish" && response.status === 200)
      throw new CliError(
        signal.aborted
          ? "the server's answer timed out; the revision may have been published"
          : publishAnswerIncomplete,
      );
    throw new CliError("The emend server returned an invalid response.");
  }
  if (!response.ok) {
    const parsed = ErrorBody.safeParse(body);
    if (parsed.success) throw new CliApiError(parsed.data.error.code);
    throw new CliError("The emend request failed.");
  }
  return body;
}

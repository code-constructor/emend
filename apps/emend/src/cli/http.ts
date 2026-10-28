import { ErrorBody, type ErrorCode } from "@emend/contract";
import { NewerDatabaseError } from "../db/migrate.ts";
import type { Io } from "../main.ts";
import { ApiError } from "../server/http/errors.ts";
import { StateDirModeError, StateFolderWriteError } from "../state/files.ts";
import { VERSION } from "../version.ts";
import { discover } from "./server-client.ts";
import type { Target } from "./target.ts";

export class CliSignalExit extends Error {
  constructor(readonly exitCode: number) {
    super("Interrupted");
  }
}
export class CliError extends Error {}
export class CliUsageError extends CliError {}
export function errorLine(error: unknown): string {
  if (
    error instanceof NewerDatabaseError ||
    error instanceof StateDirModeError ||
    error instanceof StateFolderWriteError
  )
    return `${error.message}\n`;
  return `emend: ${error instanceof CliApiError ? error.code : error instanceof CliError ? error.message : "The emend request failed."}\n`;
}
export async function printJson(io: Io, value: unknown): Promise<void> {
  try {
    await (io.stdoutAsync ?? io.stdout)(`${JSON.stringify(value)}\n`);
  } catch {
    throw new CliError("Could not write to stdout.");
  }
}
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
  target: Target,
  path: string,
  opts: {
    method: string;
    body?: unknown;
    raw?: Buffer;
    missingOk?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  if (target.via === "direct") throw new CliError("The emend request requires a server.");
  opts.signal?.throwIfAborted();
  if (target.via === "local" && !(await discover(stateDir, 5000, target.url)))
    throw new CliError("Could not authenticate the emend server.");
  opts.signal?.throwIfAborted();
  let response: Response;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 5000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    response = await fetch(new URL(`/api/v1${path}`, target.url), {
      method: opts.method,
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${target.token}`,
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

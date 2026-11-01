import { ERROR_STATUS, ErrorBody, type ErrorCode } from "@emend/contract";
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
export class CliConnectionError extends CliError {}
function hubUnanswered(url: string): string {
  return `the hub at ${url} did not answer. The request may have reached it; check before trying again.`;
}
export function hubFailure(url: string, error?: unknown, signal?: AbortSignal): CliError {
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  const reason =
    signal?.aborted || (error instanceof Error && error.name === "TimeoutError")
      ? "timed out"
      : cause?.code === "ECONNREFUSED"
        ? "connection refused"
        : "connection failed";
  return new CliError(`cannot reach the hub at ${url}: ${reason}. Nothing was changed.`);
}

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
export class CliHttpError extends CliError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class CliUnansweredError extends CliHttpError {
  constructor(url: string, status = 0) {
    super(status, hubUnanswered(url));
  }
}
export class CliApiError extends CliHttpError {
  readonly code: ErrorCode;
  constructor(
    code: ErrorCode,
    readonly serverMessage = new ApiError(code).message,
    status: number = ERROR_STATUS[code],
  ) {
    super(status, new ApiError(code).message);
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
    json?: string;
    missingOk?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    onSend?: () => void;
    successStatuses?: readonly number[];
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
        ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
        "X-Emend-Client": `cli/${VERSION}`,
        "Content-Type": opts.raw === undefined ? "application/json" : "application/octet-stream",
        ...(opts.raw === undefined ? {} : { "Content-Length": String(opts.raw.length) }),
      },
      ...(opts.raw === undefined
        ? opts.body === undefined && opts.json === undefined
          ? {}
          : { body: opts.json ?? JSON.stringify(opts.body) }
        : { body: new Uint8Array(opts.raw) }),
    });
  } catch (error) {
    const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
    const unconnected = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(cause?.code ?? "");
    // Fetch has no connection callback. Once it settles, exclude only proven
    // pre-connection failures; cancellation and every other failure may have sent.
    if (!unconnected) opts.onSend?.();
    opts.signal?.throwIfAborted();
    if (target.via === "hub") {
      if (unconnected) throw new CliConnectionError(hubFailure(target.url, error, signal).message);
      if (!["GET", "HEAD"].includes(opts.method)) throw new CliUnansweredError(target.url);
      throw hubFailure(target.url, error, signal);
    }
    if (path === "/publish" && signal.aborted)
      throw new CliError("the server did not answer in time; nothing was published");
    throw new CliError("Could not contact the emend server.");
  }
  opts.onSend?.();
  // Import reconciliation must distinguish an emend refusal from a gateway's
  // bare 401. Other commands retain the credential recovery diagnostic.
  if (response.status === 401 && target.via === "hub" && target.token && path !== "/import")
    throw new CliHttpError(
      401,
      `the hub at ${target.url} rejected this machine's credential. Run emend detach, then attach again. Nothing was changed.`,
    );
  if (opts.method === "HEAD") {
    if (response.ok) return true;
    if (response.status === 404 && opts.missingOk) return false;
    throw new CliError("The emend request failed.");
  }
  let body: unknown;
  try {
    body = response.status === 204 ? null : await response.json();
  } catch (error) {
    opts.signal?.throwIfAborted();
    if (
      target.via === "hub" &&
      !["GET", "HEAD"].includes(opts.method) &&
      !(error instanceof SyntaxError) &&
      !(response.status >= 400 && response.status < 500)
    )
      throw new CliUnansweredError(target.url, response.status);
    if (path === "/publish" && response.status === 200)
      throw new CliError(
        signal.aborted
          ? "the server's answer timed out; the revision may have been published"
          : publishAnswerIncomplete,
      );
    throw new CliHttpError(response.status, "The emend server returned an invalid response.");
  }
  if (!response.ok) {
    const parsed = ErrorBody.safeParse(body);
    if (parsed.success) throw new CliApiError(parsed.data.error.code, parsed.data.error.message, response.status);
    throw new CliHttpError(response.status, "The emend request failed.");
  }
  if (opts.successStatuses && !opts.successStatuses.includes(response.status))
    throw new CliHttpError(response.status, "The emend server returned an invalid response.");
  return body;
}

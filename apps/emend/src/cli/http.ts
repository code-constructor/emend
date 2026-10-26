import { join } from "node:path";
import { ErrorBody } from "@emend/contract";
import { ApiError } from "../server/http/errors.ts";
import { readTokenFile } from "../state/token-file.ts";
import { VERSION } from "../version.ts";
import { discover } from "./server-client.ts";

export class CliError extends Error {}
export async function apiRequest(
  stateDir: string,
  baseUrl: string,
  path: string,
  opts: { token: "admin" | "agent"; method: string; body?: unknown },
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
  try {
    response = await fetch(new URL(`/api/v1${path}`, baseUrl), {
      method: opts.method,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Emend-Client": `cli/${VERSION}`,
        "Content-Type": "application/json",
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  } catch {
    throw new CliError("Could not contact the emend server.");
  }
  let body: unknown;
  try {
    body = response.status === 204 ? null : await response.json();
  } catch {
    throw new CliError("The emend server returned an invalid response.");
  }
  if (!response.ok) {
    const parsed = ErrorBody.safeParse(body);
    throw new CliError(parsed.success ? new ApiError(parsed.data.error.code).message : "The emend request failed.");
  }
  return body;
}

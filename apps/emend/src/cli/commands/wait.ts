import { MAX_TAKE_WAIT_SECONDS, WaitResult } from "@emend/contract";
import type { Io } from "../../main.ts";
import { apiRequest, CliError, CliUsageError, printJson } from "../http.ts";
import { resolveTarget, type Target } from "../target.ts";

export const ReviewId = WaitResult.options[2].shape.reviewId;
export const confirmWarning = "emend: Could not confirm receipt; the same feedback will be offered again.\n";

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, Math.ceil(milliseconds));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function takeFeedback(
  stateDir: string,
  target: Target,
  reviewId: string,
  timeoutSeconds: number,
  options: { signal?: AbortSignal; progress?: (seconds: number) => Promise<void>; maxBytes?: number } = {},
): Promise<WaitResult> {
  const start = performance.now();
  const deadline = start + timeoutSeconds * 1000;
  do {
    options.signal?.throwIfAborted();
    const roundStart = performance.now();
    const remaining = Math.max(0, (deadline - roundStart) / 1000);
    if (timeoutSeconds > 0 && remaining < 0.05) {
      await pause(remaining * 1000, options.signal);
      break;
    }
    const waitSeconds = Math.min(MAX_TAKE_WAIT_SECONDS, remaining);
    const parsed = WaitResult.safeParse(
      await apiRequest(stateDir, target, `/reviews/${reviewId}/take`, {
        method: "POST",
        body: { waitSeconds, ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) },
        timeoutMs: Math.ceil((waitSeconds + 10) * 1000),
        signal: options.signal,
      }),
    );
    if (!parsed.success || parsed.data.reviewId !== reviewId)
      throw new CliError("The emend server returned an invalid response.");
    options.signal?.throwIfAborted();
    if (parsed.data.kind !== "pending") return parsed.data;
    await pause(Math.min(deadline, roundStart + waitSeconds * 1000) - performance.now(), options.signal);
    if (waitSeconds === MAX_TAKE_WAIT_SECONDS) await options.progress?.(Math.floor((performance.now() - start) / 1000));
  } while (performance.now() < deadline);
  return {
    kind: "pending",
    reviewId,
    waitedSeconds: timeoutSeconds === 0 ? 0 : Math.floor((performance.now() - start) / 1000),
  };
}

export async function confirmFeedback(stateDir: string, target: Target, deliveryId: string, stderr: Io["stderr"]) {
  try {
    await apiRequest(stateDir, target, `/deliveries/${deliveryId}/confirm`, { method: "POST" });
  } catch {
    stderr(confirmWarning);
  }
}

export async function deliverFeedback(stateDir: string, target: Target, result: WaitResult, io: Io) {
  await printJson(io, result);
  if (result.kind !== "pending") await confirmFeedback(stateDir, target, result.deliveryId, io.stderr);
}

export async function waitCommand(stateDir: string, args: string[], io: Io) {
  const [id, flag, seconds] = args;
  if (
    !ReviewId.safeParse(id).success ||
    (args.length !== 1 && (args.length !== 3 || flag !== "--timeout" || !/^\d+$/.test(seconds ?? "")))
  )
    throw new CliUsageError("Usage: emend wait <review> [--timeout <seconds>].");
  const timeout = seconds === undefined ? 540 : Number(seconds);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400)
    throw new CliUsageError("Timeout must be an integer from 1 to 86400.");
  const reviewId = ReviewId.parse(id);
  const target = await resolveTarget(stateDir);
  await deliverFeedback(stateDir, target, await takeFeedback(stateDir, target, reviewId, timeout), io);
}

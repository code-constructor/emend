import { ERROR_STATUS, type ErrorCode } from "@emend/contract";
import type { Context } from "hono";

const MESSAGES: Record<ErrorCode, string> = {
  internal: "An internal server error occurred.",
  unauthorized: "Authentication is required.",
  forbidden: "This operation is not permitted.",
  bad_host: "The host is not allowed.",
  bad_origin: "The origin is not allowed.",
  not_found: "The resource was not found.",
  unknown_review: "The review was not found.",
  invalid_request: "The request is invalid.",
  invalid_target: "The target is invalid.",
  empty_send: "There is no feedback to send.",
  blob_mismatch: "The blob hash does not match.",
  blob_missing: "A required blob is missing.",
  wrong_origin: "The origin metadata is invalid.",
  stale_revision: "The revision is out of date.",
  comment_frozen: "The comment has already been sent.",
  unsent_comments: "Unsent comments remain.",
  instance_attached: "This machine is already attached. Revoke it in the hub's devices, or run emend detach on it.",
  review_moved: "The review has moved.",
  publish_conflict: "The review changed during publish. Try again.",
  too_large: "The request is too large.",
  client_outdated: "The client needs an update.",
  rate_limited: "Code entry is temporarily locked.",
};
const DETAILS = {
  import_aborted: { code: "invalid_request", message: "The import was cancelled." },
  import_busy: { code: "rate_limited", message: "The server is busy importing; try again." },
  waiting_takes: { code: "rate_limited", message: "Too many waiting takes." },
  event_streams: { code: "rate_limited", message: "Too many open event streams." },
  publish_busy: { code: "rate_limited", message: "The server is busy publishing; try again." },
  publish_aborted: { code: "invalid_request", message: "The publish was cancelled." },
  writeup_blocks: { code: "too_large", message: "The writeup has too many blocks." },
  writeup_failed: { code: "invalid_request", message: "The writeup could not be rendered." },
  writeup_timeout: { code: "too_large", message: "The writeup rendering timed out." },
  placement_timeout: { code: "too_large", message: "The placement timed out." },
  placement_failed: { code: "invalid_request", message: "The comments could not be placed." },
} as const;
type Detail = keyof typeof DETAILS;
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly detail?: Detail;
  constructor(code: ErrorCode, detail?: Detail) {
    super(detail && DETAILS[detail].code === code ? DETAILS[detail].message : MESSAGES[code]);
    this.code = code;
    this.detail = detail;
  }
}
export function errorBody(code: ErrorCode, detail?: Detail) {
  return {
    error: { code, message: detail && DETAILS[detail]?.code === code ? DETAILS[detail].message : MESSAGES[code] },
  };
}
export function errorResponse(c: Context, code: ErrorCode, detail?: Detail) {
  return c.json(errorBody(code, detail), ERROR_STATUS[code]);
}

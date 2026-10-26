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
  review_moved: "The review has moved.",
  too_large: "The request is too large.",
  client_outdated: "The client needs an update.",
  rate_limited: "Code entry is temporarily locked.",
};
export class ApiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}
export function errorBody(code: ErrorCode) {
  return { error: { code, message: MESSAGES[code] } };
}
export function errorResponse(c: Context, code: ErrorCode) {
  return c.json(errorBody(code), ERROR_STATUS[code]);
}

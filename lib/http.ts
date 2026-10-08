// The error envelope (spec §5.4) and the one helper that keeps A3 true.
//
// A3: another user's resource must be INDISTINGUISHABLE from a missing one.
// A 403 confirms the row exists, which is the enumeration oracle the whole
// isolation design exists to deny. There is therefore no 403 in this API at
// all, and `notFound()` is the single place both cases are answered, so they
// cannot drift apart as endpoints are added.
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "DEPENDENCY_CYCLE"
  | "PLAN_EXISTS"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  DEPENDENCY_CYCLE: 409,
  PLAN_EXISTS: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const unauthenticated = (): ApiError =>
  new ApiError("UNAUTHENTICATED", "Sign in to continue.");

/**
 * Missing OR owned by someone else. Both say the same thing, on purpose (A3).
 * Never add a 403 variant of this.
 */
export const notFound = (): ApiError =>
  new ApiError("NOT_FOUND", "Not found.");

export const invalid = (message: string, details?: unknown): ApiError =>
  new ApiError("VALIDATION_FAILED", message, details);

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json(
      { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
      { status: STATUS[err.code] },
    );
  }
  // Nothing internal reaches the client: a Postgres error text can name
  // tables, columns and constraints.
  console.error("unhandled API error", err);
  return Response.json(
    { error: { code: "INTERNAL", message: "Something went wrong." } },
    { status: 500 },
  );
}

/** Wraps a handler so every throw becomes the envelope above. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return errorResponse(err);
  }
}

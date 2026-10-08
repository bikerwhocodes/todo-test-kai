// The one error envelope (Technical Spec §5.4).
//
// There is deliberately NO 403 in this table. A 403 on another user's resource
// confirms that the resource exists, which is an enumeration oracle; A3
// requires 404 instead. Because `fail()` is the only way a handler produces an
// error and 403 is not a representable code, a handler cannot return one by
// accident. tests/auth.test.ts asserts that no source file contains a 403.
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return Response.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status: STATUS[code] },
  );
}

/**
 * "Missing" and "not yours" collapse onto one response here, in one place, so
 * that they cannot drift apart as routes are added.
 */
export const notFound = (what: string): Response =>
  fail("NOT_FOUND", `No such ${what}.`);

/** Trims and length-checks a required free-text field. */
export function requireText(
  value: unknown,
  field: string,
  max = 200,
): { ok: true; value: string } | { ok: false; response: Response } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      ok: false,
      response: fail("VALIDATION_FAILED", `${field} is required.`, { path: [field] }),
    };
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    return {
      ok: false,
      response: fail("VALIDATION_FAILED", `${field} must be at most ${max} characters.`, {
        path: [field],
      }),
    };
  }
  return { ok: true, value: trimmed };
}

/** Parses a JSON body, mapping malformed JSON onto the same envelope. */
export async function readJson(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  try {
    const body = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, response: fail("VALIDATION_FAILED", "Expected a JSON object.") };
    }
    return { ok: true, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, response: fail("VALIDATION_FAILED", "Malformed JSON body.") };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A syntactically invalid id is reported as 404, not 422. It is still "no such
 * resource", and distinguishing the two would tell an attacker which of their
 * guesses were well-formed.
 */
export const isUuid = (v: string): boolean => UUID_RE.test(v);

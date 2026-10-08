// Request identity. The single place a cookie becomes a user id.
import { auth } from "./auth.ts";
import { fail } from "./http.ts";

export type Authenticated = { userId: string };

/**
 * Resolves the caller from the session cookie, or returns the 401 response to
 * send instead.
 *
 * Returning a union rather than throwing is deliberate: a handler cannot
 * forget to deal with the unauthenticated case, because it has to destructure
 * the result before it can reach a `userId` at all. An expired session has no
 * row left to find, so expiry and absence are the same answer here.
 */
export async function requireUser(
  request: Request,
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, response: fail("UNAUTHENTICATED", "Sign in to continue.") };
  }
  return { ok: true, userId };
}

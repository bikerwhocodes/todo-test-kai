// The one place a request becomes an identity.
import { auth } from "./auth.ts";
import { unauthenticated } from "./http.ts";

export type Session = { userId: string; email: string };

/** Resolves the session cookie, or null when there is no valid session. */
export async function getSession(req: Request): Promise<Session | null> {
  // Better Auth validates the signed cookie AND checks the session row's
  // expiry, so an expired or server-side-revoked session returns null here
  // even though the cookie itself is still well-formed.
  const s = await auth.api.getSession({ headers: req.headers });
  if (!s?.user?.id) return null;
  return { userId: s.user.id, email: s.user.email };
}

/**
 * The identity every domain route starts from. Throws 401 rather than
 * returning a nullable id, so a handler cannot forget to check and end up
 * querying with `undefined` as the owner.
 */
export async function requireUser(req: Request): Promise<string> {
  const s = await getSession(req);
  if (!s) throw unauthenticated();
  return s.userId;
}

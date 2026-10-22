import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/server/auth";

/** The current session (validated against the DB), or null. Deduped per request. */
export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }));

/**
 * Use at the top of every app page, layout, server action and route handler that
 * needs a user. Redirects to /login when there is no valid session.
 */
export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session.user;
}

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";

export async function signOutAction() {
  // Deletes the DB session; nextCookies() clears the cookie on this response.
  await auth.api.signOut({ headers: await headers() }).catch(() => {
    // Already signed out (missing/expired session): still send the user to /login.
  });
  redirect("/login");
}

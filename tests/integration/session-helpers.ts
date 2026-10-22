import { auth } from "@/server/auth";
import { actAs } from "./next-mocks";

// Import only from test files that mock next/headers etc. with ./next-mocks (see there).

export const TEST_PASSWORD = "correct horse battery";

export type SignedUp = {
  id: string;
  email: string;
  /** `better-auth.session_token=…` pair to send as the Cookie header. */
  cookie: string;
};

/** Signs a real user up through Better Auth (user, account, session and user_settings rows). */
export async function signUp(email: string, { name = "Test User", timeZone }: { name?: string; timeZone?: string } = {}) {
  // The signup form sends the browser's zone too; Better Auth's body type doesn't know it.
  const body = { name, email, password: TEST_PASSWORD, timeZone };
  const res = await auth.api.signUpEmail({ body, asResponse: true });
  if (!res.ok) throw new Error(`sign-up failed for ${email}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().find((c) => c.includes("better-auth.session_token="));
  if (!cookie) throw new Error(`sign-up for ${email} set no session cookie`);
  const { user } = (await res.json()) as { user: { id: string } };
  return { id: user.id, email, cookie: cookie.split(";")[0]! } satisfies SignedUp;
}

/** Signs a user up and makes their session the current request's. Returns their id. */
export async function signIn(email: string): Promise<string> {
  const user = await signUp(email);
  actAs(user.cookie);
  return user.id;
}

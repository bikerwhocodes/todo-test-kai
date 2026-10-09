// Fixtures that go through the REAL auth path.
//
// These deliberately do not insert sessions by hand. A hand-made session row
// would prove nothing about Better Auth: the point of NEXT-2 is that signup,
// signin and signout work through the library, against the schema NEXT-1
// migrated, on the auth role's own connection. So every account here is
// created by calling the library and reading back the cookie it sets.
import { auth, closeAuthPool } from "../lib/auth.ts";
import { after } from "node:test";
import { randomUUID } from "node:crypto";
import { superPool } from "./helpers.ts";

after(async () => {
  await closeAuthPool();
});

export const ORIGIN = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3100";

export type Account = {
  userId: string;
  email: string;
  password: string;
  /** A ready-to-send Cookie header value for this account's session. */
  cookie: string;
};

/** Extracts the session cookie pair ("name=value") from a Set-Cookie header. */
export function sessionCookie(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  const all = raw.length > 0 ? raw : [res.headers.get("set-cookie") ?? ""];
  const token = all.map((c) => c.split(";")[0]!).filter((c) => c.includes("session_token"));
  if (token.length === 0) throw new Error(`no session cookie in response: ${all.join(" | ")}`);
  return token.join("; ");
}

/** Signs a brand-new account up through the library and returns its session. */
export async function signUp(): Promise<Account> {
  const email = `a-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const res = await auth.api.signUpEmail({
    body: { name: "Test Account", email, password },
    asResponse: true,
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const { user } = (await res.json()) as { user: { id: string } };
  return { userId: user.id, email, password, cookie: sessionCookie(res) };
}

export async function signIn(email: string, password: string): Promise<Response> {
  return auth.api.signInEmail({ body: { email, password }, asResponse: true });
}

/** Two independent signed-in accounts — the shape every isolation test needs. */
export async function signUpTwo(): Promise<[Account, Account]> {
  return [await signUp(), await signUp()];
}

/** A request carrying an account's session cookie. */
export function authed(
  url: string,
  account: Account,
  init: RequestInit = {},
): Request {
  return new Request(new URL(url, ORIGIN), {
    ...init,
    headers: {
      cookie: account.cookie,
      "content-type": "application/json",
      origin: ORIGIN,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** The same request with no session at all. */
export function anonymous(url: string, init: RequestInit = {}): Request {
  return new Request(new URL(url, ORIGIN), {
    ...init,
    headers: { "content-type": "application/json", origin: ORIGIN, ...(init.headers as Record<string, string> | undefined) },
  });
}

export const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Forces a session to look expired, without touching the cookie. */
export async function expireSession(account: Account): Promise<void> {
  const { rowCount } = await superPool.query(
    "UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE user_id = $1",
    [account.userId],
  );
  if (!rowCount) throw new Error("no session row to expire");
}

export type Envelope = { error?: { code?: string; message?: string; details?: unknown } };

export async function codeOf(res: Response): Promise<string | undefined> {
  if (res.status === 204) return undefined;
  const body = (await res.json().catch(() => ({}))) as Envelope;
  return body.error?.code;
}

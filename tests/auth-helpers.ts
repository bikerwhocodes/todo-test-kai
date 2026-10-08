// Helpers for driving real authentication in tests.
//
// These tests call `auth.handler()` and the route handlers directly, in
// process, rather than through a running Next.js server. That is the same
// entry point the route files use, so cookie issuing, CSRF checks, rate
// limiting, scrypt hashing and every database write are the real ones. What it
// does NOT cover is the browser: no Playwright, no real cross-origin request,
// no UI. See the Build Journal's "not executed" list.
import pg from "pg";
import { auth, BASE_URL } from "../lib/auth.ts";

const authUrl = (): string => {
  const v = process.env.AUTH_DATABASE_URL;
  if (!v) throw new Error("AUTH_DATABASE_URL is not set — run `npm run db:setup`");
  return v;
};

/** A pool on the auth role, used to assert what that role can and cannot do. */
export const authRolePool = new pg.Pool({ connectionString: authUrl(), max: 3 });
authRolePool.on("error", () => { /* idle client severed */ });

let ipCounter = 0;

/**
 * A distinct synthetic client IP per caller.
 *
 * Better Auth keys rate limits as `${ip}|${path}` and resolves the ip from a
 * single-value `x-forwarded-for`. Without a unique ip every test would share
 * one bucket and the 5-per-minute sign-in rule would start failing unrelated
 * tests. The rate-limit test deliberately reuses one fixed ip to trip it.
 */
export const nextIp = (): string =>
  `10.${(ipCounter / 250 | 0) % 250}.${++ipCounter % 250}.9`;

/**
 * Empties Better Auth's rate-limit counters.
 *
 * Required, not hygiene: `storage: "database"` persists counters for the whole
 * 60-second window, and a run starts its ip counter from zero. Two runs inside
 * one minute therefore reuse the same synthetic ips and the second one fails
 * at sign-up with 429 — which is exactly how this suite failed before the
 * reset was added, rather than a hypothetical.
 */
export async function resetRateLimits(): Promise<void> {
  await authRolePool.query("DELETE FROM rate_limits");
}

export type AuthCall = {
  path: string;
  body?: unknown;
  cookie?: string;
  origin?: string | null;
  ip?: string;
  method?: string;
};

/** Calls a Better Auth endpoint exactly as the route handler would. */
export async function authFetch(call: AuthCall): Promise<Response> {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (call.origin !== null) headers.set("origin", call.origin ?? BASE_URL);
  if (call.cookie) headers.set("cookie", call.cookie);
  headers.set("x-forwarded-for", call.ip ?? nextIp());

  const method = call.method ?? (call.body === undefined ? "GET" : "POST");
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${call.path}`, {
      method,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
    }),
  );
}

/** Collapses a response's Set-Cookie headers into a single Cookie header value. */
export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

export type Account = { id: string; email: string; password: string; cookie: string };

/** Signs up a real account through the real endpoint and returns its session cookie. */
export async function signUp(ip = nextIp()): Promise<Account> {
  const email = `u-${randomSuffix()}@example.test`;
  const password = `Pw-${randomSuffix()}-ok`;
  const res = await authFetch({
    path: "/sign-up/email",
    body: { name: "Test User", email, password },
    ip,
  });
  if (!res.ok) throw new Error(`sign-up failed (${res.status}): ${await res.text()}`);
  const cookie = cookieFrom(res);
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  const id = session?.user?.id;
  if (!id) throw new Error("sign-up produced no usable session");
  return { id, email, password, cookie };
}

export async function signIn(
  email: string,
  password: string,
  ip = nextIp(),
): Promise<Response> {
  return authFetch({ path: "/sign-in/email", body: { email, password }, ip });
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Builds the Request a Next.js route handler receives. */
export function appRequest(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json", origin: BASE_URL });
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** The `{ params }` shape a Next.js dynamic route handler is called with. */
export const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

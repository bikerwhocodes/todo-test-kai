// A9 / AT-33-37 — sessions, logout, expiry, CSRF, rate limiting and password
// handling, exercised through Better Auth against the real database.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { auth } from "../lib/auth.ts";
import { superPool } from "./helpers.ts";
import { ORIGIN, expireSession, signIn, sessionCookie, signUp } from "./auth-helpers.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rate-limit counters are PERSISTED (`storage: "database"`) over a 60-second
 * window, so they outlive the test process. Two suite runs inside one minute
 * share the same buckets and the second starts partway through the budget —
 * which made the same-origin control test below fail on the third consecutive
 * run. That is the worst kind of CI failure: intermittent, and dependent on
 * how recently the suite last ran rather than on the code.
 *
 * Reproduced before fixing: runs 1 and 2 passed 9/9, run 3 failed with
 * `no-trusted-ip|/sign-in/email` at the 5-per-minute cap.
 *
 * Two fixes, because either alone is insufficient:
 *   1. clear the store here, so a run never inherits a previous run's budget;
 *   2. give each handler-driven test its OWN synthetic client ip (below), so
 *      tests cannot starve each other within a single run either.
 *
 * General rule: any test touching a store the application persists across runs
 * needs an explicit reset, not an assumption that the window has passed.
 */
before(async () => {
  await superPool.query("DELETE FROM rate_limits");
});

/**
 * Better Auth keys rate limits as `${ip}|${path}` and reads the ip from
 * `x-forwarded-for`. Distinct ips per test keep the 5/minute credential rule
 * from making one test's traffic another test's failure.
 */
const ip = (addr: string): Record<string, string> => ({ "x-forwarded-for": addr });

test("A4: signup stores a UUID id, not the library's default base62 string", async () => {
  const a = await signUp();
  assert.match(a.userId, UUID, "advanced.database.generateId must emit UUIDs");
  const { rows } = await superPool.query<{ id: string; pg_typeof: string }>(
    "SELECT id::text AS id, pg_typeof(id)::text AS pg_typeof FROM users WHERE id = $1", [a.userId]);
  assert.equal(rows[0]?.pg_typeof, "uuid", "the column itself must be uuid, not text");
});

test("A9: the stored credential is a scrypt hash, never the password", async () => {
  const a = await signUp();
  const { rows } = await superPool.query<{ password: string; provider_id: string }>(
    "SELECT password, provider_id FROM accounts WHERE user_id = $1", [a.userId]);
  const stored = rows[0]?.password ?? "";
  assert.equal(rows[0]?.provider_id, "credential");
  assert.ok(stored.length > 0, "a credential row must exist");
  assert.ok(!stored.includes(a.password), "the plaintext password must not be stored");
  // Better Auth's built-in hasher is scrypt (node:crypto) and emits
  // "<salt>:<derived key>" as hex. This asserts WHICH algorithm is in use, so
  // the release note's claim is checked rather than assumed — PRD A9 proposed
  // Argon2id, and what actually runs is scrypt (recorded answer to Q-A).
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/,
    "expected Better Auth's scrypt salt:hash form");
});

test("A9: sign-in succeeds with the right password and fails with a wrong one", async () => {
  const a = await signUp();
  const ok = await signIn(a.email, a.password);
  assert.equal(ok.status, 200);
  const bad = await signIn(a.email, `${a.password}-wrong`);
  assert.ok(bad.status >= 400, `a wrong password must not sign in (got ${bad.status})`);
});

test("A9: the session cookie is HttpOnly and SameSite-scoped", async () => {
  const a = await signUp();
  const res = await signIn(a.email, a.password);
  const raw = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""]).join("; ");
  assert.match(raw, /HttpOnly/i, "a session cookie readable from JS is an XSS session theft");
  assert.match(raw, /SameSite=Lax/i);
  // `secure` is tied to NODE_ENV, so it is absent here (tests run outside
  // production) by design — a Secure cookie over plain HTTP is dropped by the
  // browser and would break the local dev server the README documents. That
  // it IS set in production was verified separately against `next start`,
  // which sets NODE_ENV=production: the Set-Cookie header carried
  // "HttpOnly; Secure; SameSite=Lax". Recorded in the Build Journal; this
  // assertion deliberately does not claim it.
  assert.ok(!/Secure/i.test(raw) || process.env.NODE_ENV === "production",
    "Secure must appear only in production, where it was verified over HTTP");
});

test("AT-34: a valid session resolves, and logout invalidates it SERVER-SIDE", async () => {
  const a = await signUp();
  const before = await auth.api.getSession({ headers: new Headers({ cookie: a.cookie }) });
  assert.equal(before?.user?.id, a.userId);

  await auth.api.signOut({ headers: new Headers({ cookie: a.cookie }) });

  const { rows } = await superPool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM sessions WHERE user_id = $1", [a.userId]);
  assert.equal(rows[0]?.n, "0", "logout must delete the session row, not just clear a cookie");

  // The cookie itself is still a well-formed signed token. Replaying it after
  // logout must fail anyway — that is the difference between invalidating a
  // session and merely asking the browser to forget it.
  const after = await auth.api.getSession({ headers: new Headers({ cookie: a.cookie }) });
  assert.equal(after, null, "a logged-out cookie must not resolve to a session");
});

test("AT-35: an expired session is rejected even with an intact cookie", async () => {
  const a = await signUp();
  await expireSession(a);
  const s = await auth.api.getSession({ headers: new Headers({ cookie: a.cookie }) });
  assert.equal(s, null, "expiry must be enforced server-side from the session row");
});

test("A9: CSRF — a sign-in POST from a foreign origin is rejected", async () => {
  const a = await signUp();
  const forged = new Request(new URL("/api/auth/sign-in/email", ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example", ...ip("203.0.113.11") },
    body: JSON.stringify({ email: a.email, password: a.password }),
  });
  const res = await auth.handler(forged);
  assert.ok(res.status >= 400,
    `a cross-origin credential POST must be refused (got ${res.status})`);
  const setCookie = (res.headers.getSetCookie?.() ?? []).join("; ");
  assert.ok(!setCookie.includes("session_token"),
    "a rejected cross-origin request must not hand out a session");
});

test("A9: a same-origin sign-in through the handler still works", async () => {
  // The control for the test above: proves the CSRF rejection is about the
  // origin, not about the handler path being broken for everyone.
  const a = await signUp();
  const res = await auth.handler(new Request(new URL("/api/auth/sign-in/email", ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...ip("203.0.113.12") },
    body: JSON.stringify({ email: a.email, password: a.password }),
  }));
  assert.equal(res.status, 200);
  assert.ok(sessionCookie(res).includes("session_token"));
});

test("A9: rate limiting throttles repeated sign-in attempts", async () => {
  const a = await signUp();
  // customRules allows 5 per minute on /sign-in/email. Deliberately uses a
  // WRONG password: this is the password-guessing shape the limit exists for,
  // and it also keeps the test from minting sessions.
  const attempt = () =>
    auth.handler(new Request(new URL("/api/auth/sign-in/email", ORIGIN), {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...ip("203.0.113.7") },
      body: JSON.stringify({ email: a.email, password: "definitely-wrong" }),
    }));

  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await attempt()).status);

  assert.ok(statuses.includes(429),
    `expected a 429 within 12 attempts, saw ${JSON.stringify(statuses)}`);

  // Rate-limit state must live in Postgres, not in process memory: in-memory
  // counters are per-instance, so behind two servers they are not a limit.
  const { rows } = await superPool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM rate_limits");
  assert.notEqual(rows[0]?.n, "0", "storage: \"database\" must persist counters to rate_limits");

  // And it must be a per-client limit, not a global kill switch: a DIFFERENT
  // ip is unaffected by the exhausted one. Without this, a limiter that simply
  // blocked everyone after 5 attempts would pass the assertion above.
  const other = await auth.handler(new Request(new URL("/api/auth/sign-in/email", ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...ip("203.0.113.8") },
    body: JSON.stringify({ email: a.email, password: a.password }),
  }));
  assert.equal(other.status, 200, "a different client must not inherit another's exhausted budget");
});

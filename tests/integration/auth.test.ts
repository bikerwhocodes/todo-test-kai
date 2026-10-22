import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { getUserSettings } from "@/server/repo/user-settings";

const BASE = process.env.BETTER_AUTH_URL!;
let ipCounter = 0;

/** Each call gets its own client IP unless one is given, so rate limits don't leak between tests. */
function call(path: string, init: { body?: unknown; cookie?: string; ip?: string; method?: string } = {}) {
  const headers = new Headers({
    origin: BASE,
    "x-forwarded-for": init.ip ?? `198.51.100.${++ipCounter % 250}`,
  });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

function sessionCookie(res: Response): string {
  const header = res.headers.getSetCookie().find((c) => c.includes("better-auth.session_token="));
  if (!header) throw new Error("no session cookie set");
  return header.split(";")[0]!;
}

async function signUp(email: string, timeZone?: unknown) {
  return call("/sign-up/email", {
    body: { name: "Test User", email, password: "correct horse battery", timeZone },
  });
}

beforeEach(async () => {
  await db.execute(sql`truncate users, rate_limits restart identity cascade`);
});

describe("signup", () => {
  it("creates the user, an httpOnly session cookie and settings with the browser time zone", async () => {
    const res = await signUp("ada@example.com", "America/Toronto");
    expect(res.status).toBe(200);

    const cookie = res.headers.getSetCookie().find((c) => c.includes("better-auth.session_token="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const { user } = (await res.json()) as { user: { id: string } };
    const settings = await getUserSettings(user.id);
    expect(settings.timeZone).toBe("America/Toronto");
    expect(settings.defaultEstimateMin).toBe(30);
  });

  it("falls back to UTC when the reported zone is invalid", async () => {
    const res = await signUp("bob@example.com", "Not/AZone");
    const { user } = (await res.json()) as { user: { id: string } };
    expect((await getUserSettings(user.id)).timeZone).toBe("UTC");
  });

  it("stores a password hash, never the password", async () => {
    await signUp("cy@example.com");
    const rows = await db.execute<{ password: string }>(
      sql`select a.password from accounts a join users u on u.id = a.user_id where u.email = 'cy@example.com'`,
    );
    const stored = rows[0]!.password;
    expect(stored).not.toContain("correct horse battery");
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/); // scrypt salt:key
  });

  it("rejects short passwords and duplicate emails", async () => {
    const short = await call("/sign-up/email", {
      body: { name: "X", email: "short@example.com", password: "1234567" },
    });
    expect(short.status).toBe(400);

    await signUp("dup@example.com");
    expect((await signUp("dup@example.com")).ok).toBe(false);
  });
});

describe("login and logout", () => {
  it("logs in with the right password, keeps a DB session, and logs out", async () => {
    await signUp("dee@example.com");

    const wrong = await call("/sign-in/email", { body: { email: "dee@example.com", password: "nope-nope" } });
    expect(wrong.status).toBe(401);

    const ok = await call("/sign-in/email", {
      body: { email: "dee@example.com", password: "correct horse battery" },
    });
    expect(ok.status).toBe(200);
    const cookie = sessionCookie(ok);

    const session = await call("/get-session", { cookie });
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe("dee@example.com");

    const out = await call("/sign-out", { body: {}, cookie });
    expect(out.status).toBe(200);

    const after = await call("/get-session", { cookie });
    expect(await after.json()).toBeNull();
  });
});

describe("rate limiting", () => {
  it("blocks the sixth sign-in attempt within a minute from one IP", async () => {
    const attempt = () =>
      call("/sign-in/email", { body: { email: "eve@example.com", password: "guessing" }, ip: "203.0.113.7" });

    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("X-Retry-After"))).toBeGreaterThan(0);

    // A different client is unaffected.
    const other = await call("/sign-in/email", {
      body: { email: "eve@example.com", password: "guessing" },
      ip: "203.0.113.8",
    });
    expect(other.status).toBe(401);
  });
});

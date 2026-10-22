import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
// React's cache() is a no-op outside a server render; keep it transparent.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T>(fn: T) => fn }));

const { auth } = await import("@/server/auth");
const { requireUser } = await import("@/server/session");
const { db } = await import("@/server/db");
const { sql } = await import("drizzle-orm");

beforeEach(async () => {
  await db.execute(sql`truncate users, rate_limits restart identity cascade`);
  state.headers = new Headers();
});

describe("requireUser", () => {
  it("redirects to /login without a session", async () => {
    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
  });

  it("redirects to /login with a forged session token", async () => {
    state.headers = new Headers({ cookie: "better-auth.session_token=forged.value" });
    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
  });

  it("returns the user for a valid session", async () => {
    const res = await auth.api.signUpEmail({
      body: { name: "Fay", email: "fay@example.com", password: "correct horse battery" },
      asResponse: true,
    });
    const cookie = res.headers.getSetCookie().find((c) => c.includes("better-auth.session_token="))!;
    state.headers = new Headers({ cookie: cookie.split(";")[0]! });

    const user = await requireUser();
    expect(user.email).toBe("fay@example.com");
  });
});

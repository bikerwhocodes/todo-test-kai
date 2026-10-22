import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports below; see ../next-mocks.
vi.mock("next/headers", async () => (await import("../next-mocks")).nextHeaders);
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  ...(await import("../next-mocks")).nextNavigation,
}));
vi.mock("next/cache", async () => (await import("../next-mocks")).nextCache);
vi.mock("react", async (orig) => ({ ...(await orig<object>()), ...(await import("../next-mocks")).reactCache }));

import * as authRoute from "@/app/api/auth/[...all]/route";
import { ROUTE_COVERAGE, type CoveredRoute, type FileCases } from "./registry";
import { expectNoneOf, seedWorld, snapshotOf, type Account, type World } from "./world";

// Route handlers, called through their exported GET/POST with B's session cookie.

const BASE = process.env.BETTER_AUTH_URL!;
let ip = 0;

type Handler = (req: Request) => Promise<Response>;

/** A request to `handler` as `as`; each gets its own client IP so rate limits don't interfere. */
function send(handler: Handler, as: Account, path: string, body?: unknown) {
  const headers = new Headers({ origin: BASE, cookie: as.cookie, "x-forwarded-for": `203.0.113.${++ip % 250}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  return handler(
    new Request(`${BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const auth = {
  get: (as: Account, path: string) => send(authRoute.GET, as, `/api/auth${path}`),
  post: (as: Account, path: string, body: unknown = {}) => send(authRoute.POST, as, `/api/auth${path}`, body),
};

async function expectStillSignedIn(account: Account) {
  const res = await auth.get(account, "/get-session");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { user?: { id: string } } | null)?.user?.id, `${account.email} was signed out`).toBe(
    account.id,
  );
}

const ROUTE_CASES: FileCases<CoveredRoute> = {
  "src/app/api/auth/[...all]/route.ts": [
    [
      "get-session returns B's session and user only",
      async ({ a, b }) => {
        const res = await auth.get(b, "/get-session");
        expect(res.status).toBe(200);
        const json: unknown = await res.json();
        expect(json).toMatchObject({ user: { id: b.id }, session: { userId: b.id } });
        expectNoneOf(a, json);
      },
    ],
    [
      "list-sessions lists only B's sessions",
      async ({ a, b }) => {
        const res = await auth.get(b, "/list-sessions");
        expect(res.status).toBe(200);
        const sessions = (await res.json()) as { userId: string }[];
        expect(sessions.length).toBeGreaterThan(0);
        expect(sessions.every((s) => s.userId === b.id)).toBe(true);
        expectNoneOf(a, sessions);
      },
    ],
    [
      "revoke-session with A's token leaves A signed in",
      async ({ a, b }) => {
        const res = await auth.post(b, "/revoke-session", { token: a.sessionToken });
        expect(res.status).toBeLessThan(500);
        await expectStillSignedIn(a);
      },
    ],
    [
      "revoke-sessions and revoke-other-sessions end only B's sessions",
      async ({ a, b }) => {
        await auth.post(b, "/revoke-other-sessions");
        await auth.post(b, "/revoke-sessions");
        expect((await snapshotOf(b.id)).sessions).toEqual([]);
        await expectStillSignedIn(a);
      },
    ],
    [
      "update-user with A's id in the body changes nothing of A's",
      async ({ a, b }) => {
        await auth.post(b, "/update-user", { name: "pwned", id: a.id, userId: a.id });
        await expectStillSignedIn(a);
      },
    ],
  ],
};

const cases = (Object.keys(ROUTE_COVERAGE) as (keyof typeof ROUTE_COVERAGE)[]).flatMap((file) => {
  const coverage = ROUTE_COVERAGE[file];
  return "cases" in coverage ? ROUTE_CASES[file as CoveredRoute].map(([name, run]) => [`${file}: ${name}`, run] as const) : [];
});

let w: World;

beforeEach(async () => {
  w = await seedWorld();
});

describe("route handlers called by B leave A's data alone", () => {
  it.each(cases)("%s", async (_label, run) => {
    // A's session is read back (get-session) in some cases, which may refresh its row only
    // when it is close to expiry; it was just created, so the full snapshot must hold.
    const aBefore = await snapshotOf(w.a.id);
    await run(w);
    expect(await snapshotOf(w.a.id)).toEqual(aBefore);
  });
});

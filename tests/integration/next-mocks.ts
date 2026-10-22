import { vi } from "vitest";

// Stand-ins for the Next.js request APIs, so server actions, pages and route handlers
// can be called directly from Vitest. This module must not import app code: test files
// wire it up from hoisted vi.mock factories, before any app module loads:
//
//   vi.mock("next/headers", async () => (await import("../next-mocks")).nextHeaders);
//   vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), ...(await import("../next-mocks")).nextNavigation }));
//   vi.mock("next/cache", async () => (await import("../next-mocks")).nextCache);
//   vi.mock("react", async (orig) => ({ ...(await orig<object>()), ...(await import("../next-mocks")).reactCache }));

/** The current "request". `actAs()` swaps the session cookie. */
export const request = { headers: new Headers() };

/** Makes `cookie` (a `name=value` pair, or null for signed out) the current request's. */
export function actAs(cookie: string | null) {
  request.headers = cookie ? new Headers({ cookie }) : new Headers();
}

export const revalidatePath = vi.fn();

/** Message of the error thrown by the mocked `notFound()`. */
export const NOT_FOUND = "NEXT_NOT_FOUND";

export const nextHeaders = {
  headers: async () => request.headers,
  // Better Auth's nextCookies() plugin mirrors Set-Cookie into next/headers; ignore it here.
  cookies: async () => ({
    get: () => undefined,
    getAll: () => [],
    has: () => false,
    set: () => {},
    delete: () => {},
  }),
};

export const nextNavigation = {
  redirect: (to: string): never => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: (): never => {
    throw new Error(NOT_FOUND);
  },
};

export const nextCache = { revalidatePath };

// React's cache() is a no-op outside a server render; keep it transparent.
export const reactCache = { cache: <T>(fn: T) => fn };

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

function request(path: string, cookie?: string) {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    headers: cookie ? { cookie } : {},
  });
}

describe("proxy", () => {
  it("redirects app routes to /login with the original path when there is no session cookie", () => {
    const res = proxy(request("/today?view=list"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/today?view=list");
  });

  it("redirects / to /login without a next param", () => {
    const location = new URL(proxy(request("/")).headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.has("next")).toBe(false);
  });

  it.each(["/login", "/signup", "/api/auth/sign-in/email"])("lets %s through", (path) => {
    expect(proxy(request(path)).headers.get("location")).toBeNull();
  });

  it.each(["better-auth.session_token=abc", "__Secure-better-auth.session_token=abc"])(
    "lets app routes through with cookie %s",
    (cookie) => {
      expect(proxy(request("/today", cookie)).headers.get("location")).toBeNull();
    },
  );

  it("does not treat look-alike paths as public", () => {
    expect(proxy(request("/login-help")).status).toBe(307);
    expect(proxy(request("/api/authx")).status).toBe(307);
  });
});

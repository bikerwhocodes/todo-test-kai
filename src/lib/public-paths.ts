/**
 * Routes reachable without a session. Everything else is an app route and is
 * redirected to /login, so new pages are protected by default.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/")
  );
}

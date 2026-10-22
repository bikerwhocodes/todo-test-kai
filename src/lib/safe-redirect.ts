export const DEFAULT_AFTER_LOGIN = "/today";

const AUTH_PAGES = new Set(["/login", "/signup"]);

function looksExternal(path: string): boolean {
  return path.startsWith("//") || path.startsWith("/\\");
}

/**
 * Turns an untrusted `?next=` value into a same-origin path. Anything that could
 * leave the site (absolute URLs, `//host`, `/\host`) or loop back to an auth
 * page falls back to the default.
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || looksExternal(next)) return DEFAULT_AFTER_LOGIN;
  // Control characters can be used to smuggle a scheme past naive checks.
  if (/[\u0000-\u001f\u007f]/.test(next)) return DEFAULT_AFTER_LOGIN;
  const url = new URL(next, "http://localhost");
  if (url.origin !== "http://localhost") return DEFAULT_AFTER_LOGIN;
  // Dot-segments can collapse "/a/..//evil.example" into "//evil.example", so check the result too.
  if (looksExternal(url.pathname) || AUTH_PAGES.has(url.pathname)) return DEFAULT_AFTER_LOGIN;
  return url.pathname + url.search + url.hash;
}

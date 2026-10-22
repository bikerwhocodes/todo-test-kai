export type AuthResult = { ok: true } | { ok: false; error: string };

/** POSTs to a Better Auth endpoint and turns failures into a message for the form. */
export async function postAuth(path: string, body: Record<string, unknown>): Promise<AuthResult> {
  let res: Response;
  try {
    res = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
  }
  if (res.ok) return { ok: true };
  if (res.status === 429) {
    const wait = Number(res.headers.get("X-Retry-After"));
    return {
      ok: false,
      error: `Too many attempts. Try again in ${Number.isFinite(wait) && wait > 0 ? `${wait} seconds` : "a minute"}.`,
    };
  }
  const data = (await res.json().catch(() => null)) as { message?: unknown } | null;
  return {
    ok: false,
    error: typeof data?.message === "string" && data.message ? data.message : "Something went wrong. Please try again.",
  };
}

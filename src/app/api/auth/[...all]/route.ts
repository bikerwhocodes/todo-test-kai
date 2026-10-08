// Better Auth's own endpoints: sign-up, sign-in, sign-out, session.
// Mounted as a catch-all so the library owns its whole surface, including the
// CSRF origin check and the rate limiter.
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "../../../../../lib/auth.ts";

export const { POST, GET } = toNextJsHandler(auth);

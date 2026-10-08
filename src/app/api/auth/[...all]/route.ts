// Better Auth's own endpoints: sign-up, sign-in, sign-out, get-session.
// CSRF checks, rate limiting and cookie handling all live inside this handler.
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "../../../../../lib/auth.ts";

export const { GET, POST } = toNextJsHandler(auth);

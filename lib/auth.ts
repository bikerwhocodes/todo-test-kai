// Better Auth, wired to the schema NEXT-1 migrated and to its OWN database
// role.
//
// Two things here are load-bearing and easy to get wrong:
//
//   1. THE CONNECTION. This module is the only place AUTH_DATABASE_URL is
//      used. That role can reach the four identity tables and nothing else —
//      not one task, not one project (004_auth_role.sql, asserted by
//      db/guard.ts). Domain code keeps using db/client.ts's runtime pool, so a
//      flaw in either layer reaches strictly less than the whole.
//
//   2. THE SCHEMA MAP. Better Auth's models are singular (`user`), the tables
//      here are plural (`users`). The adapter offers `usePlural`, which works
//      by appending "s" to model names; this maps the five models EXPLICITLY
//      instead, so nothing depends on that string munging and a renamed table
//      fails to typecheck rather than at the first sign-in.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { accounts, rateLimits, sessions, users, verifications } from "../db/schema.ts";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
};

let authPool: pg.Pool | undefined;

/** The auth library's own pool. Separate role, separate blast radius. */
export function getAuthPool(): pg.Pool {
  if (!authPool) authPool = new pg.Pool({ connectionString: required("AUTH_DATABASE_URL"), max: 5 });
  return authPool;
}

export async function closeAuthPool(): Promise<void> {
  await authPool?.end();
  authPool = undefined;
}

const isProduction = process.env.NODE_ENV === "production";

export const auth = betterAuth({
  appName: "nextup",
  secret: required("BETTER_AUTH_SECRET"),
  baseURL: required("BETTER_AUTH_URL"),

  database: drizzleAdapter(drizzle(getAuthPool()), {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
      rateLimit: rateLimits,
    },
  }),

  emailAndPassword: {
    enabled: true,
    // Password hashing is Better Auth's built-in scrypt (node:crypto), by
    // decision: the recorded answer to Q-A accepts the maintained default
    // rather than configuring Argon2id. `password.hash` is deliberately NOT
    // set — see the release note. PRD A9 proposed Argon2id; what actually runs
    // is scrypt, and that is stated rather than glossed.
    minPasswordLength: 12,
    // No reset flow in the MVP (recorded answer to Q-G). `sendResetPassword`
    // is therefore unset, which leaves the endpoint disabled rather than
    // silently emailing nothing.
  },

  user: {
    additionalFields: {
      // P5: an IANA zone identifier, never a fixed offset. The column is
      // NOT NULL DEFAULT 'UTC' with a CHECK and a trigger validating it
      // against the server's tz database, so a bad value is rejected by
      // Postgres even if it gets past the client.
      timezone: { type: "string", required: false, input: true, defaultValue: "UTC" },
    },
  },

  advanced: {
    database: {
      // A4: UUIDs everywhere externally visible. The library's default is a
      // random base62 string, which these uuid columns would reject.
      generateId: "uuid",
    },
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      // Secure cookies over plain HTTP are dropped by the browser, which
      // would break local development; in production it is not optional.
      secure: isProduction,
    },
  },

  // CSRF: Better Auth checks the request Origin against this list. It defaults
  // to baseURL; naming it explicitly means adding a deployment origin is a
  // visible edit rather than a forgotten one.
  trustedOrigins: [required("BETTER_AUTH_URL")],

  rateLimit: {
    // A9. Default-off in development is the trap here: left alone, the
    // rate-limit test would pass against no limiter at all. Enabled
    // unconditionally so what runs in tests is what runs in production.
    enabled: true,
    // In-memory state is per-instance, so behind two servers it is not a
    // limit. The store is the rate_limits table (004_auth_role.sql).
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      // Credential endpoints get a far tighter budget than ordinary traffic:
      // 100/minute is useless against password guessing.
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
    },
  },
});

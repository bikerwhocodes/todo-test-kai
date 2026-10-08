// Better Auth configuration.
//
// This is the ONLY module that connects as `nextup_auth`. That role holds DML
// on users/sessions/accounts/verifications/rate_limits and nothing at all on
// the six user-data tables, so even a total compromise of this file cannot
// read anyone's tasks. Conversely the application runtime role holds nothing
// on the session tables, so application query code cannot read a session
// token. See db/migrations/004_auth_role.sql for why a third role rather than
// widened grants on the runtime role.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  accounts, accountsRelations, rateLimits, sessions, sessionsRelations,
  users, usersRelations, verifications,
} from "../db/schema.ts";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
};

export const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3100";

let authPool: pg.Pool | undefined;

/** The auth library's own pool, on its own role. Separate from db/client.ts. */
export function getAuthPool(): pg.Pool {
  if (!authPool) {
    authPool = new pg.Pool({ connectionString: required("AUTH_DATABASE_URL"), max: 5 });
  }
  return authPool;
}

export async function closeAuthPool(): Promise<void> {
  await authPool?.end();
  authPool = undefined;
}

const schema = {
  users, sessions, accounts, verifications, rateLimits,
  usersRelations, sessionsRelations, accountsRelations,
};

export const auth = betterAuth({
  appName: "nextup",
  baseURL: BASE_URL,
  secret: required("BETTER_AUTH_SECRET"),

  database: drizzleAdapter(drizzle(getAuthPool(), { schema }), {
    provider: "pg",
    schema,
    // Our tables are plural (`users`), Better Auth's models are singular
    // (`user`). This is what maps one onto the other.
    usePlural: true,
    // Sign-up writes a `users` row and an `accounts` row. Without this they
    // are sequential, so a crash between them leaves a user with no
    // credential — an account that exists and can never be signed into.
    transaction: true,
  }),

  emailAndPassword: {
    enabled: true,
    // Password hashing is Better Auth's scrypt (node:crypto), NOT Argon2id.
    // This is the recorded answer to gate Q-A / PRD A9, which only *proposed*
    // Argon2id: the maintained default is native, needs no new dependency and
    // no custom hasher to keep correct. A9 is reported satisfied BY SCRYPT and
    // must not be read as an Argon2id claim. To switch, set
    // `emailAndPassword.password.{hash,verify}` and say so in the release note.
    minPasswordLength: 12,
    // No password reset and no email verification in the MVP — the recorded
    // answer to Q-F/Q-G is to ship without them, consciously. A forgotten
    // password therefore means a lost account.
    requireEmailVerification: false,
  },

  advanced: {
    database: {
      // Better Auth defaults to a random base62 string. The PRD requires uuid
      // ids (A4) and every id column in 001_schema.sql is `uuid`, which would
      // reject a base62 string outright.
      generateId: "uuid",
    },
    // Secure cookies in production are the library default; this makes the
    // flag explicit rather than environment-dependent guesswork. Left false
    // locally so the cookie is usable over plain http on localhost.
    useSecureCookies: process.env.NODE_ENV === "production",
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  // CSRF: Better Auth validates the Origin header against this list whenever
  // cookies are present. An explicit single origin is the point — the default
  // would also accept the inferred baseURL, and leaving it implicit is how a
  // deployment ends up trusting an origin nobody chose. `disableCSRFCheck` is
  // never set.
  trustedOrigins: [BASE_URL],

  rateLimit: {
    // Better Auth disables rate limiting in development by default. Enabling
    // it unconditionally is deliberate: a limiter that is off in every
    // environment where it is tested is not known to work.
    enabled: true,
    // The default store is in-memory, which resets on deploy and counts
    // per-instance. `rate_limits` is created by migration 004.
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
    },
  },
});

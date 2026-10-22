import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/server/db";
import * as schema from "@/server/db/schema";
import { env } from "@/server/env";
import { createUserSettings } from "@/server/repo/user-settings";

const DAY = 60 * 60 * 24;

function listFromEnv(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((s) => s.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      rateLimit: schema.rateLimit,
    },
  }),
  emailAndPassword: {
    enabled: true,
    // Passwords are hashed with scrypt by Better Auth before they reach the DB.
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: true,
  },
  // Sessions live in Postgres; the browser only holds an httpOnly cookie with the token.
  session: {
    expiresIn: 30 * DAY,
    updateAge: DAY,
  },
  rateLimit: {
    // Better Auth only enables this in production by default; we want it everywhere.
    enabled: true,
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 10 * 60, max: 5 },
    },
  },
  advanced: {
    useSecureCookies: env.BETTER_AUTH_URL.startsWith("https://"),
    ipAddress: {
      // Header(s) your host guarantees carry the real client IP, e.g. "x-real-ip" or
      // "cf-connecting-ip". Defaults to a single-hop X-Forwarded-For.
      ipAddressHeaders: listFromEnv(process.env.AUTH_IP_HEADERS),
      // Comma-separated proxy IPs/CIDRs in front of the app, so the real client IP
      // can be read from a multi-hop X-Forwarded-For chain.
      trustedProxies: listFromEnv(process.env.AUTH_TRUSTED_PROXIES),
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user, ctx) => {
          // The signup form sends the browser's zone alongside name/email/password.
          const body: unknown = ctx?.body;
          const timeZone =
            body && typeof body === "object" && "timeZone" in body ? body.timeZone : undefined;
          try {
            await createUserSettings(user.id, timeZone);
          } catch (error) {
            // The user, account and session already exist; failing here would 500 a
            // signup that actually succeeded. getUserSettings() recreates the row.
            console.error("Failed to create user_settings on signup", error);
          }
        },
      },
    },
  },
  // Must stay last: lets server actions (e.g. sign-out) set cookies via next/headers.
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;

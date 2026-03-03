/**
 * Better Auth server config: Drizzle (Neon Postgres) + email/password.
 * Env: BETTER_AUTH_SECRET, NEON_DATABASE_URL, BETTER_AUTH_API_KEY (for dash dashboard).
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { dash } from "@better-auth/infra";
import { db } from "./db";
import * as schema from "./db/schema";

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) {
  throw new Error("BETTER_AUTH_SECRET is required for Better Auth.");
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
  },
  secret,
  basePath: "/api/auth",
  baseURL:
    process.env.BETTER_AUTH_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined),
  trustedOrigins: process.env.BETTER_AUTH_URL
    ? [process.env.BETTER_AUTH_URL]
    : undefined,
  plugins: [
    dash({ apiKey: process.env.BETTER_AUTH_API_KEY }),
    nextCookies(), // keep last for server-action cookies
  ],
});

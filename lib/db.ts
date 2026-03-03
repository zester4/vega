/**
 * Drizzle + Neon serverless connection for Next.js (Better Auth, etc.)
 * Set NEON_DATABASE_URL in .env.local
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./db/schema";

const connectionString = process.env.NEON_DATABASE_URL;
if (!connectionString) {
  throw new Error("NEON_DATABASE_URL is required for the database connection.");
}

const sql = neon(connectionString);
export const db = drizzle(sql, { schema });
